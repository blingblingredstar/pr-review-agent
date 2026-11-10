// Run 写时持久化（#122 / D041，sec-auditor 2026-11-10 评审约束全落实）：worker publish 阶段把
// 「仅存在于发布瞬间」的数据落私有 Vercel Blob——repo/pr/sha、token 用量、findings 发布快照。
// 两层取数原则（D041）：resolve 状态 / reactions 等「会变的」不存、读时实时拉 GitHub（事实源原则，
// prod-runs-derived.ts 同款）；失败/中断 run 不落（无 result 可言，失败路径本身没有 findings），
// 仍由 prodlogs 台账 harvest 通道覆盖。保留期用 SDK 原生 ttlDays（平台每日自动过期，1-730 天），
// 不需要 prune 脚本（issue #122 原写 prune 脚本的前提「Blob 无 TTL」经 SDK 2.9.0 核实不成立）。
// 红线：纯函数 + 依赖注入（put/list/get 可替换），不进 reviewDiff 路径——eval promptHash 零接触。
import { get, list, put } from "@vercel/blob";

export type RunSeverity = "blocker" | "major" | "minor" | "nit";

// findings 快照（ReviewResult.comments 的存储形态，含 confidence #100；字段校验从严——
// 单条不合法即整条记录拒绝，schema 漂移在日志里可见，不带病入库）
export type RunFinding = {
  file: string;
  line: number;
  severity: RunSeverity;
  body: string;
  confidence?: "high" | "medium" | "low";
};

// RunRecord：observability 专用契约，与 LLM 输出 schema（ReviewResult）无关；v 用于将来演进时分支解析
export type RunRecord = {
  v: 1;
  repo: string; // "owner/name"——HMAC 验签后 payload 派生（与 stageKey 同级信任）+ 纵深校验（P2-1）
  pr: number;
  headSha: string;
  startedAt: number | null; // prepare 信封 issuedAt（state.startedAt 贯通）；缺省 null 不猜测
  finishedAt: number; // publish 落库时刻
  incrementalBase: string | null; // D032 增量 base（null = 全量）
  tokens: { input: number | null; output: number | null; total: number | null; cached: number | null }; // 主评审 usage（端点不返回的字段为 null；cached = 前缀缓存命中，#128）
  outcome: { inline: number; degraded: number; folded: number }; // postReview 真实落点计数（422 回落口径）
  findings: RunFinding[]; // 全 severity 全量快照（含折叠段 minor/nit——改进分析语料的主体）
};

// 纵深校验（P2-1）：owner/repo/sha 进 blob pathname，断言字符集挡 GitHub schema 漂移的怪路径；
// 信任级别本身与 stageKey 相同（HMAC 验签后 payload），这里是防御性收紧不是信任边界
const NAME_SEG_RE = /^[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{7,64}$/i;

// 构造结果显式化（不用异常）：publish 阶段的 catch 会把任何抛出升级成「审查失败」红灯——
// 已成功回帖的 run 不能被观测写入连坐（P1-5），构造失败只返回原因
export type BuildRunRecordResult =
  | { ok: true; record: RunRecord }
  | { ok: false; reason: string };

type PostOutcome = { inline: number; degraded: number; folded: number };

// result 入参用结构化局部类型（不 import review.ts——runs.ts 会被 api/runs.ts 打包，不拖 AI SDK 依赖链）；
// ReviewOutcome 与它结构兼容
type ReviewOutcomeShape = {
  comments: unknown;
  usage?: { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null; cachedInputTokens?: number | null };
};

export function buildRunRecord(
  ref: { owner: string; repo: string; pullNumber: number; headSha: string },
  result: ReviewOutcomeShape | undefined,
  posted: PostOutcome,
  incrementalBase: string | null,
  startedAt: number | null,
  now: number,
): BuildRunRecordResult {
  if (NAME_SEG_RE.test(ref.owner) === false || NAME_SEG_RE.test(ref.repo) === false) {
    return { ok: false, reason: `repo 含非法字符：${JSON.stringify(ref.repo)}` };
  }
  if (!Number.isInteger(ref.pullNumber) || ref.pullNumber <= 0) {
    return { ok: false, reason: `pr 非正整数：${String(ref.pullNumber)}` };
  }
  if (SHA_RE.test(ref.headSha) === false) {
    return { ok: false, reason: `headSha 非十六进制：${JSON.stringify(ref.headSha)}` };
  }
  const findings = validateFindings(result?.comments);
  if (typeof findings === "string") return { ok: false, reason: findings };
  return {
    ok: true,
    record: {
      v: 1,
      repo: `${ref.owner}/${ref.repo}`,
      pr: ref.pullNumber,
      headSha: ref.headSha,
      startedAt,
      finishedAt: now,
      incrementalBase,
      tokens: {
        input: result?.usage?.inputTokens ?? null,
        output: result?.usage?.outputTokens ?? null,
        total: result?.usage?.totalTokens ?? null,
        cached: result?.usage?.cachedInputTokens ?? null,
      },
      outcome: { inline: posted.inline, degraded: posted.degraded, folded: posted.folded },
      findings,
    },
  };
}

function validateFindings(comments: unknown): RunFinding[] | string {
  if (!Array.isArray(comments)) return "result.comments 非数组";
  const findings: RunFinding[] = [];
  for (const c of comments) {
    const f = c as Record<string, unknown> | null;
    if (
      typeof f?.file !== "string" ||
      typeof f?.line !== "number" ||
      (f.severity !== "blocker" && f.severity !== "major" && f.severity !== "minor" && f.severity !== "nit") ||
      typeof f?.body !== "string"
    ) {
      return "result.comments 字段漂移（file/line/severity/body 类型不符）";
    }
    findings.push({
      file: f.file,
      line: f.line,
      severity: f.severity,
      body: f.body,
      ...(f.confidence === "high" || f.confidence === "medium" || f.confidence === "low" ? { confidence: f.confidence } : {}),
    });
  }
  return findings;
}

// blob pathname（P1-6）：runs/ 前缀 + 按仓分层（预留按仓删除/接入撤销）；确定性路径 +
// put allowOverwrite:false 表达 append-only——同 sha 重复审查上游 dedupe 已挡，重复 put 报
// BlobAlreadyExistsError 按幂等成功处理（记录已在）
export function runBlobPath(record: Pick<RunRecord, "repo" | "pr" | "headSha">): string {
  const [owner, repo] = record.repo.split("/");
  return `runs/${owner}/${repo}/${record.pr}-${record.headSha}.json`;
}

// 写入硬超时（P1-5）：Blob 挂起吃满 285s 阶段墙钟会让 race 兜底把已成功回帖的 run 误标
// 「审查中断」——观测写入的可用性上界就是这 5s，超了放弃（调用悬空无害）
const RUNS_WRITE_TIMEOUT_MS = 5_000;

// 保留期（P1-6 落地形态）：SDK 原生 ttlDays 平台每日自动过期，替代 prune 脚本（issue #122 原设想的
// prune 前提「Blob 无 TTL」与 SDK 2.9.0 现状不符）。默认 730（上限，2 年）——私有仓接入后 findings
// 是代码片段级敏感数据，自动过期是隐私兜底；0 显式关闭。非法值告警回退默认（DIFF_MAX_CHARS 同款）
export function runsTtlDays(): number | undefined {
  const raw = process.env.RUNS_TTL_DAYS?.trim();
  if (raw === undefined || raw === "") return 730;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 730) {
    console.error(`[runs] RUNS_TTL_DAYS="${raw}" 非法（需 0-730 整数），回退默认 730`);
    return 730;
  }
  return n === 0 ? undefined : n;
}

// 凭证门：OIDC（BLOB_STORE_ID + 平台注入的 VERCEL_OIDC_TOKEN，D041 选型——无只读静态 token，
// 短-lived OIDC 是最小权限形态）或静态 token（BLOB_READ_WRITE_TOKEN）任一存在才尝试写入；
// 都缺席（本地/单测/未接 Blob 的项目）= 写入面未开通，静默跳过
export function runsWriteEnabled(): boolean {
  return Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
}

export type RunsPut = (
  pathname: string,
  body: string,
  options: {
    access: "private";
    addRandomSuffix: false;
    allowOverwrite: false;
    contentType: string;
    ttlDays?: number;
    abortSignal: AbortSignal;
  },
) => Promise<unknown>;

// 写入（best-effort，绝不抛出）：成功静默；失败只打 err 对象本身——不打 record 内容
// （findings 是将来私有仓的代码片段级数据，进 runtime log = 多开一条外泄面）、不打 put 返回值
// （含 store URL）（P1-5 日志卫生）
export async function writeRunRecord(record: RunRecord, deps?: { put?: RunsPut }): Promise<void> {
  if (!runsWriteEnabled()) return;
  // ttl 只求值一次（bot nit #123 复审）：非法值场景 runsTtlDays() 的告警日志打两份且两次读 env
  const ttl = runsTtlDays();
  try {
    await (deps?.put ?? put)(runBlobPath(record), JSON.stringify(record), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/json",
      ...(ttl !== undefined ? { ttlDays: ttl } : {}),
      abortSignal: AbortSignal.timeout(RUNS_WRITE_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`[runs] ${record.repo}#${record.pr}@${record.headSha.slice(0, 7)} 写入失败`, err);
  }
}

// 读侧（dashboard 项目 /api/runs 用；主项目被 fail-closed 门挡死）：list 锁 runs/ 前缀 + cap，
// 不接受任意 path 参数回显（P1-6）。get 返回 stream，手工聚为文本
export const RUNS_LIST_CAP = 1000;

// 读侧依赖注入用结构化最小类型（不用 SDK 的 typeof list/get——mock 只需提供消费面，不背完整元数据契约）；
// 默认值处对 SDK 函数做一次收窄断言
export type RunsListFn = (opts: { prefix: string; limit: number }) => Promise<{ blobs: { pathname: string }[] }>;
export type RunsGetFn = (
  pathname: string,
  options: { access: "private" },
) => Promise<{ statusCode: number; stream: ReadableStream<Uint8Array> } | null>;

export type RunsListGet = {
  list?: RunsListFn;
  get?: RunsGetFn;
};

function isRunRecord(v: unknown): v is RunRecord {
  const r = v as Record<string, unknown> | null;
  return (
    r?.v === 1 &&
    typeof r.repo === "string" &&
    typeof r.pr === "number" &&
    typeof r.headSha === "string" &&
    Array.isArray(r.findings) &&
    typeof r.tokens === "object" &&
    typeof r.outcome === "object"
  );
}

export async function listRunRecords(
  deps?: RunsListGet,
): Promise<{ runs: RunRecord[]; skipped: number }> {
  const page = await (deps?.list ?? (list as unknown as RunsListFn))({ prefix: "runs/", limit: RUNS_LIST_CAP });
  // 有限并发分批（bot major #123）：逐条串行 get 在几百条记录时会逼近 Hobby 300s 函数墙钟，
  // 面板会系统性超时——10 路一批 allSettled，单条失败/坏记录计 skipped 不炸整页
  const GET_CONCURRENCY = 10;
  const fetchOne = async (pathname: string): Promise<RunRecord | null> => {
    const res = await (deps?.get ?? (get as unknown as RunsGetFn))(pathname, { access: "private" });
    if (!res || res.statusCode !== 200) return null;
    const text = await new Response(res.stream).text();
    const parsed: unknown = JSON.parse(text);
    return isRunRecord(parsed) ? parsed : null;
  };
  const blobs = page.blobs;
  const runs: RunRecord[] = [];
  let skipped = 0;
  for (let i = 0; i < blobs.length; i += GET_CONCURRENCY) {
    const batch = blobs.slice(i, i + GET_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((b) => fetchOne(b.pathname)));
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) runs.push(s.value);
      else skipped += 1;
    }
  }
  return { runs, skipped };
}

// API 门（P0-1，阻塞级缓解的唯一代码防线）：RUNS_API_ENABLED 只在 dashboard 项目配置；
// 主项目同仓部署本 route 但无此变量——缺失/非 "1" 一律 404，且响应形态与「路由不存在」无区别
// （fail-closed + 面不可探测，D021「宁可误拒」同味）
export function runsApiEnabled(): boolean {
  return process.env.RUNS_API_ENABLED === "1";
}

export type RunsApiResponse = {
  status: number;
  contentType: "text/plain" | "application/json";
  body: string;
  noStore: boolean;
  headers?: Record<string, string>;
};

// /api/runs 逻辑（api/runs.ts 薄壳的委托目标）：门 → 方法 → 列表。list 失败上抛由薄壳 500
export async function handleRunsApi(method: string, deps?: RunsListGet): Promise<RunsApiResponse> {
  if (!runsApiEnabled()) return { status: 404, contentType: "text/plain", body: "not found", noStore: false };
  if (method !== "GET") {
    // 405 带 Allow: GET——与 api/webhook.ts 405 的同仓先例一致（bot nit #123）
    return { status: 405, contentType: "text/plain", body: "method not allowed", noStore: false, headers: { Allow: "GET" } };
  }
  const { runs, skipped } = await listRunRecords(deps);
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ runs, skipped }),
    noStore: true,
  };
}
