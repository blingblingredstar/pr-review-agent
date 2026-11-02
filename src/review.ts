import { readFileSync } from "node:fs";
import { normalizeSnapshotPath } from "./paths.ts";
import { generateText, Output } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";

// 与 docs/architecture.md 的输出 schema、evals/run.ts 的打分逻辑共用，改这里要同步改评分
export const reviewResultSchema = z.object({
  comments: z.array(
    z.object({
      file: z.string().describe("相对仓库根的文件路径"),
      line: z.number().int().positive().describe("新文件中的行号"),
      severity: z.enum(["blocker", "major", "minor", "nit"]),
      body: z.string().describe("问题 + 理由 +（可选）修法"),
    }),
  ),
});

export type ReviewComment = z.infer<typeof reviewResultSchema>["comments"][number];
export type ReviewResult = z.infer<typeof reviewResultSchema>;

// 模型可能带 git 的 a/ b/ 前缀，返回可能的路径变体（原样、剥 a/、剥 b/）供对照
export function pathVariants(file: string): string[] {
  return [file, file.replace(/^a\//, ""), file.replace(/^b\//, "")];
}

// git quotePath 把非 ASCII 编成八进制转义（UTF-8 字节）；输入可能带引号包裹（已剥引号也要能解码），无转义时原样返回
export function unquoteGitPath(p: string): string {
  const body = p.startsWith('"') && p.endsWith('"') && p.length >= 2 ? p.slice(1, -1) : p;
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && /[0-7]/.test(body[i + 1] ?? "")) {
      let j = i + 1;
      let oct = "";
      while (j < body.length && oct.length < 3 && /[0-7]/.test(body[j])) oct += body[j++];
      bytes.push(parseInt(oct, 8));
      i = j - 1;
    } else if (ch === "\\") {
      const next = body[i + 1] ?? "";
      bytes.push(...Buffer.from(next === "n" ? "\n" : next === "t" ? "\t" : next, "utf8"));
      i++;
    } else {
      bytes.push(...Buffer.from(ch, "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// diff --git 头行的 b 侧路径：引号包裹、八进制转义、rename 两侧引号需求不一致的四种组合都试
export function diffHeaderPath(line: string): string | null {
  const m =
    /^diff --git "a\/(?:[^"\\]|\\.)*" "(b\/(?:[^"\\]|\\.)*)"$/.exec(line) ??
    /^diff --git "a\/(?:[^"\\]|\\.)*" b\/(\S+)$/.exec(line) ??
    /^diff --git a\/\S+ "(b\/(?:[^"\\]|\\.)*)"$/.exec(line) ??
    /^diff --git a\/\S+ b\/(\S+)$/.exec(line);
  return m ? unquoteGitPath(m[1]).replace(/^b\//, "") : null;
}

// diff 触及的文件路径（b 侧，出现顺序去重）：仓库上下文（D023）按它选快照里的全文。
// 吃完整原始 diff——被 truncateDiff 丢掉的文件也纳入，上下文正好补 D018/D020 的截断盲区
export function diffTouchedPaths(diff: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const raw of diff.split("\n")) {
    if (!raw.startsWith("diff --git ")) continue;
    const path = diffHeaderPath(raw);
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

// 解析 unified diff，返回每个文件被 hunk 覆盖的新侧行号集合。
// 用于行内评论的预定位：只有行号落在 diff 内的意见才能行内发（GitHub 对 hunk 外行号返回 422）。
export function diffCoveredLines(diff: string): Map<string, Set<number>> {
  const covered = new Map<string, Set<number>>();
  let file = "";
  let inHunk = false;
  let line = 0;
  // hunk 头声明的新侧行数计数：扫描用尽即结束当前 hunk——真实 diff 以换行结尾，split 出的
  // 尾部空字符串若被当上下文行会 mark 出「最后一行 +1」的幻影行号，行内发帖必然 422 回落全量降级
  let remain = 0;
  const mark = () => {
    if (!file) return;
    let set = covered.get(file);
    if (!set) covered.set(file, (set = new Set()));
    set.add(line);
  };
  for (const raw of diff.split("\n")) {
    // hunk 内容行（+/ /-）自带前缀，不会以下面的文件头形态开头；先处理文件头判定
    if (raw.startsWith("diff --git ")) {
      file = diffHeaderPath(raw) ?? "";
      inHunk = false;
      remain = 0;
      continue;
    }
    if (inHunk) {
      const nextHunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/.exec(raw);
      if (nextHunk) {
        // 声明行数未用尽就出现 @@：畸形 diff——直接按新 hunk 头接管（起始行号与新侧行数都取自该头）
        line = Number(nextHunk[1]);
        remain = Number(nextHunk[2] ?? 1);
        continue;
      }
      if (raw.startsWith("\\")) continue; // "\ No newline at end of file" 不是内容行，不占声明行数
      if (raw.startsWith("-")) continue; // 旧侧删除行不占新侧行数，不消耗 remain
      if (remain <= 0) {
        // 新侧声明行数已用尽：hunk 结束（尾部空字符串行等伪影在此被拒之门外）
        inHunk = false;
      } else {
        remain--;
        mark();
        line++;
      }
      continue;
    }
    if (raw.startsWith("+++ ") && raw.slice(4).trim() === "/dev/null") {
      // 纯删除文件新侧不存在，任何行内评论必然 422——跳过以免坏意见拖累同 review 的好意见。
      // 精确比较：仓库里真有路径含 "/dev/null" 字样的文件（如 fixture）时 includes 会误伤
      file = "";
      inHunk = false;
      remain = 0;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/.exec(raw);
    if (hunk) {
      inHunk = true;
      line = Number(hunk[1]);
      remain = Number(hunk[2] ?? 1);
    }
  }
  return covered;
}

// diff 截断预算（字符）：超大 diff 全量进 prompt 浪费 token 甚至超模型上下文；默认 300_000 留足余量
export function diffMaxChars(): number {
  const raw = process.env.DIFF_MAX_CHARS;
  if (!raw) return 300_000;
  const parsed = Number(raw);
  // 小数（如 0.5）会得到所有块都装不下的预算、返回纯省略列表——与非法值一并回退
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.warn(`DIFF_MAX_CHARS="${raw}" 不是正整数，回退默认 300000`);
    return 300_000;
  }
  return parsed;
}

// 生成物识别名单（D020）：故意短而高精度——漏判只是让该文件回退 D018 的大小贪心（软失败），不比现状差。
// 直接清单（package.json / requirements.txt）不进名单：体积小贪心本来保留，且依赖版本变动正是要人审的内容
const NOISE_FILENAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb",
  "Cargo.lock", "poetry.lock", "uv.lock", "pdm.lock", "Pipfile.lock",
  "Gemfile.lock", "composer.lock", "go.sum", "mix.lock", "gradle.lockfile",
  "packages.lock.json", "Paket.lock", "conan.lock", "flake.lock",
]);
// 目录段分两类（PR #18 自审意见）：通用名（dist/build/out/target）只认顶层首段——src/build/、
// infra/out/ 这类嵌套同名词多是真实源码，误标「生成物」是带误导标签的静默排除而非软失败；
// 约定成俗的（node_modules/vendor/coverage/.next）任意层级都认（monorepo 里 node_modules 必然嵌套）
const NOISE_TOP_SEGMENTS = new Set(["dist", "build", "out", "target"]);
const NOISE_SEGMENTS = new Set(["node_modules", "vendor", "coverage", ".next"]);
const NOISE_SUFFIXES = [".min.js", ".min.css", ".map", ".snap"];

function isNoisePath(path: string): boolean {
  const segments = path.split("/");
  const base = segments[segments.length - 1]!;
  if (NOISE_FILENAMES.has(base)) return true;
  if (NOISE_SUFFIXES.some((s) => base.endsWith(s))) return true;
  return segments.slice(0, -1).some((s) => NOISE_SEGMENTS.has(s)) || (segments.length > 1 && NOISE_TOP_SEGMENTS.has(segments[0]!));
}

// 超预算时整文件块丢弃（D018）：切 hunk 破坏行号定位、分批多次调用翻倍延迟，都不取——
// 按块大小升序贪心保留，保留块按原顺序字节级重组，丢弃文件附省略行让模型知道看到的不是全量。
// 生成物前置过滤（D020）：名单/横幅/长行占优命中的块不进预算竞争、恒省略并标注，预算让给真实代码；
// 省略行标注「新建文件」——D018 把「大」当噪声信号，新建大源码文件是最值得审却被最先丢的内容。
export function truncateDiff(diff: string, budget: number = diffMaxChars()): string {
  if (diff.length <= budget) return diff;
  const blocks: {
    lines: string[]; path: string; adds: number; dels: number; size: number; binary: boolean; pseudo?: true;
    isNew: boolean; generated: boolean; contentChars: number; longChars: number; noise: boolean;
  }[] = [];
  let cur: (typeof blocks)[number] | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = {
        lines: [line], path: diffHeaderPath(line) ?? "(无法解析路径的文件)", adds: 0, dels: 0, size: 0, binary: false,
        isNew: false, generated: false, contentChars: 0, longChars: 0, noise: false,
      };
      blocks.push(cur);
    } else if (!cur) {
      // 畸形 diff 首个文件头之前的散落内容：不是文件，被丢弃时不产出省略行（伪路径会误导模型）
      cur = {
        lines: [line], path: "(diff 头之前的内容)", adds: 0, dels: 0, size: 0, binary: false, pseudo: true,
        isNew: false, generated: false, contentChars: 0, longChars: 0, noise: false,
      };
      blocks.push(cur);
    } else {
      cur.lines.push(line);
      cur.contentChars += line.length;
      if (line.length >= 500) cur.longChars += line.length;
      if (line.startsWith("new file mode ")) cur.isNew = true;
      // 二进制负载行（GIT binary patch 的 base64 / Binary files 摘要之后）可能以 +/- 开头，停止计数；
      // 标记置位后不重置——git 输出中二进制段后不再有文本 hunk，手工拼接的混合 diff 会漏记（输入来源仅 GitHub 标准 diff，接受）
      if (line === "GIT binary patch" || line.startsWith("Binary files ")) cur.binary = true;
      else if (!cur.binary) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          cur.adds++;
          // 生成物横幅只认文件头部（前 10 个新增行）：中后段的 do not edit 多是普通注释，全块扫会误伤
          if (cur.adds <= 10 && /@generated|do not edit/i.test(line)) cur.generated = true;
        } else if (line.startsWith("-") && !line.startsWith("---")) cur.dels++;
      }
    }
  }
  // 块大小为近似值：join 长度 + 1 个块间换行分隔符（末块无尾换行时多记 1 字符）；预算是软约束，不追求精确
  for (const b of blocks) b.size = b.lines.join("\n").length + 1;
  // 长行占优是压缩/混淆产物的跨生态结构信号，不依赖文件名；500/4000 阈值容忍源码里偶发的长字符串行
  for (const b of blocks) {
    b.noise = !b.pseudo && (isNoisePath(b.path) || b.generated || (b.longChars > 4000 && b.longChars * 2 > b.contentChars));
  }
  // 装不下就跳过继续试更小的（continue 而非 break），保留集按原顺序输出；生成物块不参与竞争
  const order = blocks.map((_, i) => i).filter((i) => !blocks[i].noise).sort((a, b) => blocks[a].size - blocks[b].size);
  const keep = new Set<number>();
  let used = 0;
  for (const i of order) {
    if (used + blocks[i].size > budget) continue;
    keep.add(i);
    used += blocks[i].size;
  }
  const kept = blocks.filter((_, i) => keep.has(i));
  // 非文件的 pseudo 块被丢弃时不产出省略行、不进汇总计数
  const omitTargets = blocks.filter((b, i) => !keep.has(i) && !b.pseudo);
  const out = kept.flatMap((b) => b.lines);
  const omitLines = omitTargets.map((b) => {
    // 标注让模型分清「预算丢的普通文件」「规则跳过的生成物」「没看到内容的新建文件」——最后者是审查盲区，最值得人工补看
    const tag = b.noise ? "生成物" : b.isNew ? "新建文件" : "";
    return `[diff 截断] 省略 ${b.path}${tag ? `（${tag}）` : ""} (+${b.adds}/-${b.dels})`;
  });
  // 省略行自身也占输出：丢弃文件极多时会反噬预算——超了就压缩成一行汇总（总量有界，无条件核对）。
  // 压缩会让逐条标注消失，汇总行带各类计数把「生成物/新建文件」信号保留给模型（PR #18 自审意见）
  if (used + omitLines.join("\n").length + 1 > budget) {
    const adds = omitTargets.reduce((s, b) => s + b.adds, 0);
    const dels = omitTargets.reduce((s, b) => s + b.dels, 0);
    const noise = omitTargets.filter((b) => b.noise).length;
    const fresh = omitTargets.filter((b) => !b.noise && b.isNew).length;
    out.push(
      `[diff 截断] 省略 ${omitTargets.length} 个文件（超出 ${budget} 字符预算，合计 +${adds}/-${dels}` +
        (noise + fresh > 0 ? `，其中生成物 ${noise}、新建文件 ${fresh}` : "") +
        `）`,
    );
  } else {
    out.push(...omitLines);
  }
  const noiseCount = blocks.filter((b) => b.noise).length;
  console.log(
    `[truncateDiff] 预算 ${budget} 字符：${blocks.length} 个文件块保留 ${kept.length} 个、省略 ${blocks.length - kept.length} 个` +
      (noiseCount > 0 ? `，其中生成物按规则跳过 ${noiseCount} 个` : ""),
  );
  return out.join("\n");
}

export function loadPrompt(): string {
  return readFileSync(new URL("../prompts/review.md", import.meta.url), "utf8");
}

// 端点扩展点（D002 厂商中立）：LLM_EXTRA_BODY 为 JSON 对象，合并进每次请求体（显式配置优先）。
// GLM 等 thinking 模型用它传 {"thinking":{"type":"disabled"}} 控制延迟（D012）；其他端点可传各自扩展参数。
export function withExtraBody(fetchImpl: typeof fetch, extra: Record<string, unknown>): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body === "string" && init.body.startsWith("{")) {
      try {
        init = { ...init, body: JSON.stringify({ ...JSON.parse(init.body), ...extra }) };
      } catch {
        // 非 JSON 请求体按原样透传
      }
    }
    return fetchImpl(input, init);
  };
}

function extraBody(): Record<string, unknown> {
  const raw = process.env.LLM_EXTRA_BODY;
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("LLM_EXTRA_BODY 必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

export function llmTimeoutMs(): number {
  const raw = process.env.LLM_TIMEOUT_MS;
  if (!raw) return 270_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`LLM_TIMEOUT_MS="${raw}" 不是正数，回退默认 270000ms`);
    return 270_000;
  }
  return parsed;
}

// token 用量（D021 盘点的待办）：部分端点不返回 usage，字段为 null——聚合时按非 null 求和，不虚构 0
export type TokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

// reviewDiff 的完整返回：LLM 结构化输出 + 本次调用用量（eval 聚合进 run 落盘，生产走 console 日志）
export type ReviewOutcome = ReviewResult & { usage: TokenUsage };

// 工具循环的 prompt 规模闸（本 PR 自身 dogfood 实测校准，见 reviewDiff 内注释）；
// worker 侧在重取快照前用同一阈值预判（自审 minor：大 prompt 快照取回不用，白吃预算）
export const TOOL_PROMPT_MAX_CHARS = 120_000;

// 审查 prompt 的唯一构造点（自审 minor：worker 预判与 reviewDiff 闸判定必须吃同一字符串——
// 两处各自拼接曾出现 +14 偏移与比较符分叉，边界上判定相反）
export function buildReviewPrompt(diff: string, context?: string): string {
  const diffText = truncateDiff(diff);
  return context ? `${context}\n\n[diff 开始]\n${diffText}` : diffText;
}

// reviewDiff 可选项（D027）：fileReader 注入即启用 read_file 工具循环（两段协议）；
// 不传 = 单次调用原路径，prompt/system 字节级不变——eval 红线由构造保证
export type ReviewDiffOpts = {
  timeoutMs?: number;
  fileReader?: (path: string) => string | null;
};

// 多次调用求和：字段独立判空——端点只回部分字段时不被其他 null 拖成全空
export function sumUsage(usages: TokenUsage[]): TokenUsage {
  const sum = (pick: (u: TokenUsage) => number | null): number | null => {
    const vals = usages.map(pick).filter((v): v is number => typeof v === "number");
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  return {
    inputTokens: sum((u) => u.inputTokens),
    outputTokens: sum((u) => u.outputTokens),
    totalTokens: sum((u) => u.totalTokens),
  };
}

export async function reviewDiff(diff: string, context?: string, opts?: ReviewDiffOpts): Promise<ReviewOutcome> {
  const { LLM_API_KEY, LLM_BASE_URL, LLM_MODEL } = process.env;
  if (!LLM_API_KEY || !LLM_BASE_URL || !LLM_MODEL) {
    throw new Error("缺少环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（参照 .env.example 配置 .env）");
  }
  const llm = createOpenAI({ apiKey: LLM_API_KEY, baseURL: LLM_BASE_URL, fetch: withExtraBody(fetch, extraBody()) });
  // 上下文（D023，best-effort）放 diff 之前：diff（含截断省略行）保持在生成前最近位置，行号锚点不受影响；
  // eval 不传 context → prompt 字节级不变（promptHash 稳定是回归对照的前提）
  const prompt = buildReviewPrompt(diff, context);
  // 一个 abortSignal 贯穿全部步（D027）：调用方 timeoutMs 封顶的是整个工具循环（两段），不只是单次调用；
  // 不传走 LLM_TIMEOUT_MS（D011）
  const abortSignal = AbortSignal.timeout(opts?.timeoutMs ?? llmTimeoutMs());
  // 大 prompt 跳过工具循环（本 PR 生产 dogfood 实测：~220KB prompt 第二段实测 ~240s，两段协议延迟 ≈ 2× 单段，
  // 叠加 zipball/续链会撞 285s 阶段墙钟，race 落「审查中断」）。120k 字符下第二段经验上界 ~130s，总预算留有余量；
  // 大 PR 本就靠 D018 截断 + D023 上下文覆盖，工具读取的边际价值最低，跳过不损失能力面
  if (opts?.fileReader) {
    // 工具循环启用闸单点合流（自审 nit：跳过日志与启用条件几乎相同，分写会漂移）：
    // maxSteps=0 = 生产 kill switch（直调同样成立）；prompt 超 120k 规模闸走单段（D027 后果）
    const maxSteps = fileToolMaxSteps();
    if (maxSteps <= 0) console.log("[tools] FILE_TOOL_MAX_STEPS=0，工具循环关闭，走单段");
    else if (prompt.length > TOOL_PROMPT_MAX_CHARS) {
      console.log(`[tools] prompt ${prompt.length} 字符超过 ${TOOL_PROMPT_MAX_CHARS}，跳过工具循环走单段（D027 后果）`);
    } else {
      // read_file 工具循环（D027）：端点实测 SDK tools + Output 组合不可行（response_format 抑制工具调用），
      // 走 spec 回退形态「两段协议」，见 reviewDiffWithFileReader
      return reviewDiffWithFileReader(llm, LLM_MODEL, prompt, opts.fileReader, abortSignal, maxSteps);
    }
  }
  // .chat() 强制走 /chat/completions：OpenAI 兼容端点（如 GLM）不实现 Responses API；
  // ai v7 起 generateObject 已废弃，结构化输出走 generateText + Output；
  // 超时预算见 docs/decisions.md D011（Vercel Hobby 函数上限 300s，留回帖余量）
  const { output, usage } = await generateText({
    model: llm.chat(LLM_MODEL),
    output: Output.object({ schema: reviewResultSchema, name: "ReviewResult" }),
    system: loadPrompt(),
    prompt,
    // 超时可被调用方覆写（worker 阶段机 D026：review 阶段按「300s 墙钟 - 续链/落灯预留」封顶，
    // 保证最坏路径「LLM 打满 + 续链失败 + 落灯」整体不超墙钟）；不传走 LLM_TIMEOUT_MS（D011）
    abortSignal,
  });
  const tokenUsage: TokenUsage = {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
  };
  console.log(
    `[reviewDiff] tokens: in ${tokenUsage.inputTokens ?? "?"} / out ${tokenUsage.outputTokens ?? "?"}` +
      ` / total ${tokenUsage.totalTokens ?? "?"}`,
  );
  return { ...output, usage: tokenUsage };
}

// 工具循环步预算（D027）：FILE_TOOL_MAX_STEPS，默认 2；数值 0 = 显式关闭（生产 kill switch，
// 与 CONTEXT_MAX_CHARS 同款「按数值判定关闭」语义）；其余非法值告警回退默认。
// 两段协议里「步」= 文件读取次数（readRequests 条数上限），与 AI SDK tools 形态每步一读的成本口径一致
let warnedInvalidMaxSteps = false;

export function fileToolMaxSteps(): number {
  const raw = process.env.FILE_TOOL_MAX_STEPS;
  if (raw === undefined || raw.trim() === "") return 2;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    // 一次审查 worker/review 两处各调一次、synchronize 重复刷——配置错误告警一次（同 chainBase 模式，自审 minor）
    if (!warnedInvalidMaxSteps) {
      console.warn(`FILE_TOOL_MAX_STEPS="${raw}" 不是非负整数，回退默认 2`);
      warnedInvalidMaxSteps = true;
    }
    return 2;
  }
  return parsed;
}

// worker 侧开关：是否给 review 阶段注入 fileReader（"0" 显式关闭，默认 2 即开启）
export function fileToolEnabled(): boolean {
  return fileToolMaxSteps() > 0;
}

function loadToolsPrompt(): string {
  return readFileSync(new URL("../prompts/review-tools.md", import.meta.url), "utf8");
}

// 单步注入的文件内容总量封顶（D027）：防止单段把上下文窗口吃穿；超出截断附说明行
export const FILE_TOOL_BLOCK_MAX_CHARS = 80_000;

// 首段自由文本里提取 readRequests（best-effort，D027）：容忍 ```json 围栏与前后闲话，取第一个平衡 JSON 对象；
// 解析失败 / 缺 readRequests / 超预算条数截断——协议违规不炸审查，降级为不读文件照常出结果。
// readRequests 元素兼容两种形态：字符串路径 或 {path} 对象；去重键与 reader 的路径解析共用同一
// normalizeSnapshotPath（PR #30 自审 minor：两份归一化会漂移），覆盖同一文件的写法变体，
// 最终合法性仍由 resolveSnapshotPath 把关
export function extractReadRequests(text: string, maxSteps: number): string[] {
  if (maxSteps <= 0) return [];
  const parsed = extractBalancedJson(text);
  const requests = (parsed as { readRequests?: unknown } | null)?.readRequests;
  if (!Array.isArray(requests)) return [];
  const paths: string[] = [];
  for (const item of requests) {
    if (typeof item === "string") {
      paths.push(item);
    } else if (typeof item === "object" && item !== null && typeof (item as { path?: unknown }).path === "string") {
      paths.push((item as { path: string }).path);
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const key = normalizeSnapshotPath(p);
    // 非法路径（含 ../反斜杠）保留原文进列表：由 buildToolBlock 落 not found 说明行给模型反馈，
    // 静默丢弃会让模型收不到任何纠正信号（自审 nit，与 review-tools.md 的「会被拒绝」承诺对齐）
    const dedupeKey = key ?? `illegal:${p.trim()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(p.trim());
  }
  return out.slice(0, maxSteps);
}

// 从自由文本提取第一个平衡的 {...}（字符串感知，容忍 ```json 围栏 / 前后闲话）；没有或不可解析返回 null
function extractBalancedJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    // 整段不是纯 JSON：继续扫描第一个平衡对象
  }
  let start = text.indexOf("{");
  while (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            // 该平衡块不可解析（模型先写了伪 JSON 等）：不是终局，继续找下一个平衡块
            break;
          }
        }
      }
    }
    start = text.indexOf("{", start + 1);
  }
  return null;
}

// 第二段 prompt 的工具结果块（D027）：工具结果在前、diff 保持生成前最近位置（行号锚点原则同 D023 上下文）。
// 命中 → 全文（超出剩余预算截断附说明行）；未命中/非法路径 → 统一 not found 说明行（不抛错，模型自行纠正）
export function buildToolBlock(requests: string[], reader: (path: string) => string | null): string {
  const HEADER = "[read_file 工具结果]";
  const parts: string[] = [HEADER];
  // 记账含头部行与 join 分隔换行（自审 nit：此前系统性低估几十字符，多文件截断边界可能越顶）
  let used = HEADER.length;
  for (const [i, path] of requests.entries()) {
    const content = reader(path);
    if (content === null) {
      parts.push(`[read_file] ${path}: file not found in head snapshot`);
      console.log(`[tools] step ${i + 1}: read ${path} (not found)`);
      continue;
    }
    // 包装头尾计入预算（自审 minor：只算内容则实际注入块可超 FILE_TOOL_BLOCK_MAX_CHARS）
    const wrapperHead = `=== read_file：${path}（截断）===\n`;
    const remaining = FILE_TOOL_BLOCK_MAX_CHARS - used;
    const fullPart = `=== read_file：${path}（全文 ${content.length} 字符）===\n${content}`;
    // 判定与记账同口径（含 join 分隔换行，自审 minor）
    if (fullPart.length + 1 <= remaining) {
      // 先拼再量（自审 minor：判定与记账统一含包装头，与截断分支同口径）
      parts.push(fullPart);
      used += fullPart.length + 1;
      console.log(`[tools] step ${i + 1}: read ${path} (${content.length} chars)`);
    } else if (remaining > wrapperHead.length + 20) {
      // 说明行长度随路径/位数变化，无法用常量余量精确预留——两轮收敛：拼一次量一次，超出 remaining
      // 就按超出量缩 cut 重拼（数字位数变化 ≤1，二轮必收敛），part.length ≤ remaining 保住封顶契约。
      // 收敛后 cut ≤ 0（说明行+包装吃掉全部余量）回退未纳入，杜绝负数 slice 从尾部切的反直觉行为
      const buildPart = (cut: number): string =>
        `${wrapperHead}${content.slice(0, cut)}` +
        `\n[read_file] ${path} 超出字符预算截断：仅注入前 ${cut}/${content.length} 字符`;
      // 码元安全截断（自审 minor）：slice 按 UTF-16 码元切，边界落在代理对中间会产生非法字符进 prompt，
      // 尾位是高位代理（且下一单位是低位代理）时回退一个码元
      const alignCodePoint = (cut: number): number =>
        0xd800 <= content.charCodeAt(cut - 1)! && content.charCodeAt(cut - 1)! <= 0xdbff ? cut - 1 : cut;
      let cut = alignCodePoint(remaining - wrapperHead.length - 20);
      let part = buildPart(cut);
      if (part.length > remaining) {
        cut = alignCodePoint(cut - (part.length - remaining));
        part = buildPart(cut);
      }
      if (cut > 0 && part.length <= remaining) {
        parts.push(part);
        used += part.length + 1;
        console.log(`[tools] step ${i + 1}: read ${path} (${cut}/${content.length} chars, 截断)`);
      } else {
        parts.push(`[read_file] ${path} 全文 ${content.length} 字符超出字符预算，未纳入`);
        console.log(`[tools] step ${i + 1}: read ${path} (0/${content.length} chars, 未纳入)`);
      }
    } else {
      parts.push(`[read_file] ${path} 全文 ${content.length} 字符超出字符预算，未纳入`);
      console.log(`[tools] step ${i + 1}: read ${path} (0/${content.length} chars, 未纳入)`);
    }
  }
  return parts.join("\n");
}

// D027 两段协议（spec 回退形态；SDK tools + Output 组合端点实测不可行，证据见 D027/PR body）：
// 第一段（无 response_format 的自由文本）输出 readRequests JSON → 解析 → 文件内容拼进第二段 prompt →
// 复用同一 schema 出结果。abortSignal 贯穿两段；usage 为两段合计（ReviewOutcome 契约不变）；
// ReviewResult schema 与 prompts/review.md 都不动，fileReader 不传时整段不生效（eval 字节级不变）
async function reviewDiffWithFileReader(
  llm: ReturnType<typeof createOpenAI>,
  modelId: string,
  prompt: string,
  fileReader: (path: string) => string | null,
  abortSignal: AbortSignal,
  // 调用方已读过并据此放行（启用闸单点合流），作参数下传消除两处读 env 的理论分叉（自审降级 nit）
  maxSteps: number,
): Promise<ReviewOutcome> {
  // system 追加指令来自 prompts/review-tools.md（仅 fileReader 注入时拼接）；review.md 一字不动
  const system = `${loadPrompt()}\n\n${loadToolsPrompt()}`;
  const probe = await generateText({ model: llm.chat(modelId), system, prompt, abortSignal });
  const requests = extractReadRequests(probe.text, maxSteps);
  console.log(`[tools] 第一段 readRequests：${requests.length > 0 ? requests.join(", ") : "无"}（预算 ${maxSteps}）`);
  // 空 readRequests 也要注入占位块（自审 minor，dogfood 高频路径）：否则第二段 prompt/system 与第一段
  // 完全相同，模型按 review-tools.md 的「末尾无块 = 第一段」判据会再输出 readRequests 而非审查意见，
  // Output 解析失败整审炸
  const toolBlock = `${requests.length > 0 ? buildToolBlock(requests, fileReader) : "[read_file 工具结果]（本轮无文件请求，请直接给出审查意见）"}\n\n`;
  const { output, usage } = await generateText({
    model: llm.chat(modelId),
    output: Output.object({ schema: reviewResultSchema, name: "ReviewResult" }),
    system,
    prompt: `${toolBlock}${prompt}`,
    abortSignal,
  });
  const tokenUsage = sumUsage([
    {
      inputTokens: probe.usage?.inputTokens ?? null,
      outputTokens: probe.usage?.outputTokens ?? null,
      totalTokens: probe.usage?.totalTokens ?? null,
    },
    { inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, totalTokens: usage?.totalTokens ?? null },
  ]);
  console.log(
    `[reviewDiff] tokens（两段合计）: in ${tokenUsage.inputTokens ?? "?"} / out ${tokenUsage.outputTokens ?? "?"}` +
      ` / total ${tokenUsage.totalTokens ?? "?"}`,
  );
  return { ...output, usage: tokenUsage };
}
