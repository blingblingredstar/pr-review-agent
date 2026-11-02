// 仓库上下文注入（路线图第 4 项第一阶段，D023）：head 快照的触及文件全文 + 仓库文件树，拼进 prompt 前段。
// 选型依据见 docs/plans/context-enhancement-phase1.md——zipball 单请求下载 + 纯 JS 内存解压，
// 不依赖 git 二进制（Vercel 运行时没有）、不落 /tmp。best-effort：任何失败返回 null、审查照旧，绝不连垮主流程。
import { unzipSync } from "fflate";
import { diffTouchedPaths } from "./review.ts";

// 上下文预算（字符）：与 DIFF_MAX_CHARS 独立，不参与 diff 截断竞争。
// 默认 100_000；"0" = 显式关闭（best-effort 新链路的配置级总闸，生产异常时可免 redeploy 关掉）；其余非法值告警回退默认
export function contextMaxChars(): number {
  const raw = process.env.CONTEXT_MAX_CHARS;
  if (raw === undefined || raw.trim() === "") return 100_000;
  if (raw.trim() === "0") return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.warn(`CONTEXT_MAX_CHARS="${raw}" 不是非负整数，回退默认 100000`);
    return 100_000;
  }
  return parsed;
}

// 下载+解压整体硬上限：失败即跳过，不挤占 LLM 的 270s 预算（D011 的 30s 余量由本步与回帖分摊）
const CONTEXT_TIMEOUT_MS = 10_000;
// zipball 压缩体积上限（流式累计与 content-length 双闸）：超大仓库直接跳过上下文，软失败不比现状差。
// 防的是「合法但过大」的仓库占内存；解压侧不设上限——归档由挂载即信任的仓库自身产生（D021 同一边界），
// GitHub 另有单 blob 100MB 推送硬限，对抗性 zip 炸弹不在威胁模型内
export const MAX_ZIP_BYTES = 25 * 1024 * 1024;

export type ZipballEntries = Map<string, Uint8Array>;

// 流式读取并累计封顶：超限立即中止（reader.cancel），超限响应不完整占内存——
// PR #25 自审意见的修复；无 body 流（异常响应）时退回整体读，字节检查仍兜底
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error(`zipball 下载超过 ${Math.round(max / 1024 / 1024)}MB 上限（流式中止）`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// 下载 head SHA 的 zipball（GET /repos/{repo}/zipball/{sha}）并内存解压，返回 仓库相对路径 → 内容。
// 手动跟进 302（codeload.github.com）：fetch 跨源重定向会剥 Authorization，私有仓库在 codeload 需要同一凭证
export async function fetchZipballEntries(
  repoFullName: string,
  sha: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ZipballEntries> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pr-review-agent",
  };
  const deadline = AbortSignal.timeout(CONTEXT_TIMEOUT_MS);
  let res = await fetchImpl(`https://api.github.com/repos/${repoFullName}/zipball/${sha}`, {
    headers,
    redirect: "manual",
    signal: deadline,
  });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) throw new Error(`zipball 重定向缺少 location（HTTP ${res.status}）`);
    res = await fetchImpl(location, { headers, redirect: "follow", signal: deadline });
  }
  if (!res.ok) {
    throw new Error(`zipball 下载失败：HTTP ${res.status}（${repoFullName}@${sha.slice(0, 7)}）`);
  }
  // content-length 前置拒绝（PR #25 自审意见）：声明超限的响应一个字节都不读
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ZIP_BYTES) {
    throw new Error(`zipball content-length ${Math.round(declared / 1024 / 1024)}MB 超过 ${MAX_ZIP_BYTES / 1024 / 1024}MB 上限`);
  }
  const body = await readCapped(res, MAX_ZIP_BYTES);
  const files = unzipSync(body);
  // GitHub 归档所有路径共享一个根目录段（命名跨 API 版本有差异，按共性剥离，不猜命名）
  const segments = new Set<string>();
  for (const path of Object.keys(files)) segments.add(path.split("/")[0]!);
  const strip = (p: string) => (segments.size === 1 ? p.slice(p.indexOf("/") + 1) : p);
  const entries: ZipballEntries = new Map();
  for (const [path, data] of Object.entries(files)) {
    if (path.endsWith("/")) continue; // 目录条目
    const rel = strip(path);
    if (rel) entries.set(rel, data);
  }
  return entries;
}

// 上下文块自描述（不改 prompts/review.md 的前提）：模型从这里知道材料的来源与行号锚点口径
const CONTEXT_HEADER =
  "[仓库上下文] 以下来自 PR head 快照（zipball），供理解 diff 中代码的完整语义与仓库结构；" +
  "审查意见的 file/line 仍以下方 diff 为锚点。";

// 确定性拼装（纯函数，可单测）：触及文件全文按 diff 顺序、逐文件全有或全无，文件树字母序殿后；
// 超预算整段跳过并留一行说明——与 D018 截断同一「告知模型非全量」的取向。预算/触及为空返回 null
export function buildContextText(entries: ZipballEntries, touchedPaths: string[], budget: number): string | null {
  if (budget <= 0 || touchedPaths.length === 0) return null;
  const out: string[] = [];
  let used = 0;
  // 各段以换行分隔：代价 = 文本长 + 1；装不下就不装（false），由调用方决定是否降级为说明行
  const append = (text: string): boolean => {
    const cost = text.length + 1;
    if (used + cost > budget) return false;
    used += cost;
    out.push(text);
    return true;
  };
  if (!append(CONTEXT_HEADER)) return null;
  const decoder = new TextDecoder("utf-8");
  for (const path of touchedPaths) {
    const data = entries.get(path);
    if (!data) {
      append(`[上下文] ${path} 不在 head 快照中（已删除或重命名离开）`);
      continue;
    }
    if (data.includes(0)) {
      // 二进制判定取最便宜的信号：NUL 字节。误判率可忽略，省掉扩展名枚举
      append(`[上下文] ${path} 为二进制文件，跳过`);
      continue;
    }
    const content = decoder.decode(data);
    if (!append(`=== 文件全文（diff 触及）：${path} ===\n${content}`)) {
      // 说明行远小于内容行，几乎总能装下；连说明都装不下时静默放弃（模型本就看不到 budget 之外的内容）
      append(`[上下文] ${path} 全文 ${content.length} 字符超出剩余预算，未纳入`);
    }
  }
  const paths = [...entries.keys()].sort();
  if (append(`=== 仓库文件树（${paths.length} 个文件）===`)) {
    // 整棵装得下就整棵输出；装不下先落说明行再贪婪装前缀——说明先占位，永不被后续行挤掉
    const total = paths.reduce((s, p) => s + p.length + 1, 0);
    if (used + total <= budget) {
      out.push(...paths);
      used += total;
    } else {
      append(`[上下文] 文件树超预算，仅显示装得下的前缀（共 ${paths.length} 个文件）`);
      for (const p of paths) {
        if (!append(p)) break;
      }
    }
  }
  return out.length > 0 ? out.join("\n") : null;
}

export type RepoContextInput = { headRepo: string; headSha: string; diff: string };

// 生产编排入口：预算关闭（省掉 zipball 请求）/ 任何失败都返回 null——webhook 侧不需要 try/catch
export async function buildRepoContext(
  { headRepo, headSha, diff }: RepoContextInput,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const budget = contextMaxChars();
  if (budget <= 0) return null;
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("缺少环境变量 GITHUB_TOKEN");
    const entries = await fetchZipballEntries(headRepo, headSha, token, fetchImpl);
    const touched = diffTouchedPaths(diff);
    if (touched.length === 0) return null;
    const text = buildContextText(entries, touched, budget);
    if (text) {
      console.log(
        `[context] 上下文注入：触及 ${touched.length} 个文件 / 快照 ${entries.size} 个文件 / ${text.length} 字符（预算 ${budget}）`,
      );
    }
    return text;
  } catch (err) {
    console.warn("[context] 上下文获取失败，本次审查不带上下文（best-effort，D023）", err);
    return null;
  }
}
