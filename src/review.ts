import { readFileSync } from "node:fs";
import { normalizeSnapshotPath } from "./paths.ts";
import { generateText, Output } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { truncateDiff } from "./diff.ts";
import { buildPlanBlock, type ReviewPlan } from "./router.ts";
import type { SearchOutcome, Searcher } from "./context.ts";
import {
  applyReflection,
  hasBlockingFinding,
  REFLECT_FAILURE_SCORE,
  reflectMinScore,
  runReflection,
  type ReflectionInfo,
} from "./reflect.ts";

// 与 docs/architecture.md 的输出 schema、evals/run.ts 的打分逻辑共用，改这里要同步改评分
export const reviewResultSchema = z.object({
  comments: z.array(
    z.object({
      file: z.string().describe("相对仓库根的文件路径"),
      line: z.number().int().positive().describe("新文件中的行号"),
      severity: z.enum(["blocker", "major", "minor", "nit"]),
      body: z.string().describe("问题 + 理由 +（可选）修法"),
      // #100 意见置信度（行为级可观测性：自述不确定性 vs 实际命中校准）。optional：历史 run JSON 读入零破坏；
      // 内部信号，发布层不渲染（src/github.ts 组装只取 file/line/severity/body）
      confidence: z.enum(["high", "medium", "low"]).optional(),
    }),
  ),
});

export type ReviewComment = z.infer<typeof reviewResultSchema>["comments"][number];
export type ReviewResult = z.infer<typeof reviewResultSchema>;

export function loadPrompt(): string {
  return readFileSync(new URL("../prompts/review.md", import.meta.url), "utf8");
}

// JSON 模式（D002 厂商中立扩展点）：端点不支持 response_format json_schema（DeepSeek 全系，文档仅 text/json_object，
// 且 json_object 要求 prompt 自带 JSON 指示）时的结构化输出降级。LLM_JSON_MODE=1 时：
// system 追加 prompts/json-output.md（端点要求的 JSON 关键词 + 输出形状），extraBody() 自动注入 json_object；
// 未设置时所有路径字节级不变（GLM 生产走 json_schema，promptHash 不受影响）。
// 注意：只用于产出 ReviewResult 的调用段；工具循环 probe 段（产出工具请求）不追加，否则与 review-tools.md
// 的两段协议判据冲突（模型会直接输出审查结果而非工具请求）
export const jsonMode = (): boolean => process.env.LLM_JSON_MODE === "1";

function loadJsonOutputPrompt(): string {
  return readFileSync(new URL("../prompts/json-output.md", import.meta.url), "utf8");
}

// 导出给 evals/run.ts 的 promptHash：指纹跟随实际生效的 system（GLM 下字节不变 → hash 不变）
export function withJsonSuffix(base: string): string {
  return withJsonSuffixFor(base, loadJsonOutputPrompt());
}

// 通用形态（router.ts 用自己的形状文件 prompts/json-output-router.md——ReviewPlan 与 ReviewResult 契约不同）。
// enabled 可显式传入（决策端点 scoped 开关，#66 前置 plumbing）：缺省读全局 jsonMode()，现状语义不变
export function withJsonSuffixFor(base: string, suffix: string, enabled: boolean = jsonMode()): string {
  return enabled ? `${base}\n\n${suffix}` : base;
}

// 端点扩展点（D002 厂商中立）：LLM_EXTRA_BODY 为 JSON 对象，合并进每次请求体（显式配置优先）。
// GLM 等 thinking 模型用它传 {"thinking":{"type":"disabled"}} 控制延迟（D012）；其他端点可传各自扩展参数。
// JSON 模式（jsonMode()）下额外做 response_format 降级：SDK 发 json_schema 的调用段（= ReviewResult 产出段）
// 替换为 json_object（DeepSeek 全系不支持 json_schema，文档仅 text/json_object）；无 response_format 的
// 调用段（工具循环 probe 段，D027 实测 response_format 会抑制工具请求形态）保持原样不动
export function withExtraBody(fetchImpl: typeof fetch, extra: Record<string, unknown>, jsonModeEnabled: boolean = jsonMode()): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body === "string" && init.body.startsWith("{")) {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (jsonModeEnabled && extra.response_format === undefined && (body.response_format as { type?: string } | undefined)?.type === "json_schema") {
          body.response_format = { type: "json_object" };
        }
        init = { ...init, body: JSON.stringify({ ...body, ...extra }) };
      } catch {
        // 非 JSON 请求体按原样透传
      }
    }
    return fetchImpl(input, init);
  };
}

// 导出（D030）：router.ts 的 runReviewRouter 与 reviewDiff 共用同一 extraBody 解析（成环 import，调用期绑定）
export function extraBody(raw: string | undefined = process.env.LLM_EXTRA_BODY, label = "LLM_EXTRA_BODY"): Record<string, unknown> {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 对象`);
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

// 输出 token 护栏（D002 扩展点）：thinking 档位会把单例 output 推到数万 token（DeepSeek low 实测 21,786/例、
// thinking 模式默认输出上限 64K），护栏防单例烧穿。未设置 = 不传（请求字节级不变，「有数据再议」的数据
// 2026-11-05 到位后解锁）；非法值告警并按未设置处理
export function llmMaxOutputTokens(): number | undefined {
  const raw = process.env.LLM_MAX_OUTPUT_TOKENS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(`LLM_MAX_OUTPUT_TOKENS="${raw}" 不是正整数，按未设置处理（不加输出上限）`);
    return undefined;
  }
  return parsed;
}

// token 用量（D021 盘点的待办）：部分端点不返回 usage，字段为 null——聚合时按非 null 求和，不虚构 0
export type TokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  // 前缀缓存命中 tokens（#128）：端点 usage.prompt_tokens_details.cached_tokens，AI SDK v7 经
  // inputTokenDetails.cacheReadTokens 透传（provider 对未携带该块的端点回 0，usage 整体缺失才为 null）；
  // 台账/eval 靠它读「命中 / 未命中」两线，成本口径不再被命中折扣污染
  cachedInputTokens: number | null;
};

// reviewDiff 的完整返回：LLM 结构化输出 + 本次调用用量（eval 聚合进 run 落盘，生产走 console 日志）。
// reflection 为 #73 观测面（非 LLM 输出契约，schema 变更纪律不适用）：opts.reflect 注入时携带触发/过滤统计
export type ReviewOutcome = ReviewResult & { usage: TokenUsage; reflection?: ReflectionInfo };

// 工具循环的 prompt 规模闸（本 PR 自身 dogfood 实测校准，见 reviewDiff 内注释）；
// worker 侧在重取快照前用同一阈值预判（自审 minor：大 prompt 快照取回不用，白吃预算）
export const TOOL_PROMPT_MAX_CHARS = 120_000;

// 审查 prompt 的唯一构造点（自审 minor：worker 预判与 reviewDiff 闸判定必须吃同一字符串——
// 两处各自拼接曾出现 +14 偏移与比较符分叉，边界上判定相反）。
// D028 扩展 opts.plan：计划块放 context 之后、`[diff 开始]` 之前（无 context 时在 diff 之前）——diff 仍最末尾
// （行号锚点原则）。无 plan → 字节级现状（eval 红线由构造保证，opts.plan 只有 worker 编排注入这一条路径）。
// D030：位置参数收敛为选项对象，输出字节级不变。
// D029 扩展 opts.taskContext：任务块置顶（需求是最高层信号，在 context/计划块之前），diff 仍末尾；
// 无 taskContext → 字节级现状（evals 直调永无任务块，红线由构造保证，opts.taskContext 只有 worker 编排注入这一条路径）
// D035 扩展 opts.previousFindings：上一轮意见块放计划块之后、`[diff 开始]` 之前（紧邻 diff——意见引用
// 其行号，规则对照对象是 diff 本身）；无值 → 字节级现状（opts.previousFindings 只有 worker 编排注入这一条路径）
export function buildReviewPrompt(
  diff: string,
  opts?: { context?: string; plan?: ReviewPlan; taskContext?: string; previousFindings?: string },
): string {
  const diffText = truncateDiff(diff);
  const taskBlock = opts?.taskContext ? `${opts.taskContext}\n\n` : "";
  const planBlock = opts?.plan ? `${buildPlanBlock(opts.plan)}\n\n` : "";
  const findingsBlock = opts?.previousFindings ? `${opts.previousFindings}\n\n` : "";
  if (opts?.context) return `${taskBlock}${opts.context}\n\n${planBlock}${findingsBlock}[diff 开始]\n${diffText}`;
  return `${taskBlock}${planBlock}${findingsBlock}${diffText}`;
}

// reviewDiff 可选项（D027）：fileReader 注入即启用 read_file 工具循环（两段协议）；
// D031 扩展：searcher 注入即启用 search_file（与 read 并列的工具请求，共用同一两段协议与步预算）；
// 都不传 = 单次调用原路径，prompt/system 字节级不变——eval 红线由构造保证。
// D028：plan 由 worker 编排注入（router 产物），reviewDiff 自身不调 router——evals 直调永远无 plan。
// D029：taskContext 由 worker 编排注入（任务块），reviewDiff 自身不做关联解析/issue 拉取——evals 直调永远无任务块
// D035：previousFindings 由 worker 编排注入（上一轮意见块），reviewDiff 自身不拉 review 历史——同上红线
export type ReviewDiffOpts = {
  timeoutMs?: number;
  fileReader?: (path: string) => string | null;
  searcher?: Searcher;
  plan?: ReviewPlan;
  taskContext?: string;
  previousFindings?: string;
  // eval-only 变体（#127 按方面拆分消融 B 臂）：system 在 review.md 原文后追加段——worker 编排从不注入，
  // evals/run.ts 的 EVAL_PROMPT_SUFFIX 臂专用；不传时 system 字节级现状（基线红线由构造保证）
  promptSuffix?: string;
  // reflect 二次评分（#73）：true 且第一轮产出 blocker/major 时同对话续写一次调用，按硬 rubric 打分过滤 +
  // 修正行号；失败语义 = 未评分意见按失败分处理（默认阈值下全部丢弃，宁可少发）。生产由 worker 按
  // REFLECT_ENABLED 注入；evals 直调不传（红线：裸路径字节级不变），eval 臂经 EVAL_REFLECT 显式开
  reflect?: boolean;
};

// 第一段声明的工具请求（D031）：search 与 read 并列。searches 为查询词、reads 为快照路径，
// 共享 FILE_TOOL_MAX_STEPS 步预算（search 先分配、read 用剩余——search 命中是定位类 read 的前提）
export type ToolRequests = { searches: string[]; reads: string[] };

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
    cachedInputTokens: sum((u) => u.cachedInputTokens),
  };
}

export async function reviewDiff(diff: string, context?: string, opts?: ReviewDiffOpts): Promise<ReviewOutcome> {
  const { LLM_API_KEY, LLM_BASE_URL, LLM_MODEL } = process.env;
  if (!LLM_API_KEY || !LLM_BASE_URL || !LLM_MODEL) {
    throw new Error("缺少环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（参照 .env.example 配置 .env）");
  }
  const llm = createOpenAI({ apiKey: LLM_API_KEY, baseURL: LLM_BASE_URL, fetch: withExtraBody(fetch, extraBody()) });
  // 上下文（D023，best-effort）放 diff 之前：diff（含截断省略行）保持在生成前最近位置，行号锚点不受影响；
  // eval 不传 context / 无 plan / 无 taskContext / 无 previousFindings（router、任务块与上一轮意见块
  // 只由 worker 编排注入）→ prompt 字节级不变（promptHash 稳定是回归对照的前提）
  const prompt = buildReviewPrompt(diff, {
    context,
    plan: opts?.plan,
    taskContext: opts?.taskContext,
    previousFindings: opts?.previousFindings,
  });
  // 一个 abortSignal 贯穿全部步（D027）：调用方 timeoutMs 封顶的是整个工具循环（两段），不只是单次调用；
  // 不传走 LLM_TIMEOUT_MS（D011）
  const abortSignal = AbortSignal.timeout(opts?.timeoutMs ?? llmTimeoutMs());
  // 大 prompt 跳过工具循环（本 PR 生产 dogfood 实测：~220KB prompt 第二段实测 ~240s，两段协议延迟 ≈ 2× 单段，
  // 叠加 zipball/续链会撞 285s 阶段墙钟，race 落「审查中断」）。120k 字符下第二段经验上界 ~130s，总预算留有余量；
  // 大 PR 本就靠 D018 截断 + D023 上下文覆盖，工具读取的边际价值最低，跳过不损失能力面
  if (opts?.fileReader || opts?.searcher) {
    // 工具循环启用闸单点合流（自审 nit：跳过日志与启用条件几乎相同，分写会漂移）：
    // maxSteps=0 = 生产 kill switch（直调同样成立）；prompt 超 120k 规模闸走单段（D027 后果）
    const maxSteps = fileToolMaxSteps();
    if (maxSteps <= 0) console.log("[tools] FILE_TOOL_MAX_STEPS=0，工具循环关闭，走单段");
    else if (prompt.length > TOOL_PROMPT_MAX_CHARS) {
      console.log(`[tools] prompt ${prompt.length} 字符超过 ${TOOL_PROMPT_MAX_CHARS}，跳过工具循环走单段（D027 后果）`);
    } else {
      // 工具循环（D027 read_file + D031 search_file）：端点实测 SDK tools + Output 组合不可行（response_format 抑制工具调用），
      // 走 spec 回退形态「两段协议」，见 reviewDiffWithTools
      const run = await reviewDiffWithTools(llm, LLM_MODEL, prompt, opts.fileReader, opts.searcher, abortSignal, maxSteps, opts.promptSuffix);
      return reflectPass(llm, LLM_MODEL, run, abortSignal, opts.reflect === true);
    }
  }
  // .chat() 强制走 /chat/completions：OpenAI 兼容端点（如 GLM）不实现 Responses API；
  // ai v7 起 generateObject 已废弃，结构化输出走 generateText + Output；
  // 超时预算见 docs/decisions.md D011（Vercel Hobby 函数上限 300s，留回帖余量）
  // promptSuffix（#127 eval-only）注入时 review.md 原文在后追加段——不传时字符串逐字节相同
  const system = withJsonSuffix(opts?.promptSuffix ? `${loadPrompt()}\n\n${opts.promptSuffix}` : loadPrompt());
  const { output, usage, text } = await generateText({
    maxOutputTokens: llmMaxOutputTokens(),
    model: llm.chat(LLM_MODEL),
    output: Output.object({ schema: reviewResultSchema, name: "ReviewResult" }),
    system,
    prompt,
    // 超时可被调用方覆写（worker 阶段机 D026：review 阶段按「300s 墙钟 - 续链/落灯预留」封顶，
    // 保证最坏路径「LLM 打满 + 续链失败 + 落灯」整体不超墙钟）；不传走 LLM_TIMEOUT_MS（D011）
    abortSignal,
  });
  const tokenUsage: TokenUsage = {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
    cachedInputTokens: usage?.inputTokenDetails?.cacheReadTokens ?? null,
  };
  console.log(
    `[reviewDiff] tokens: in ${tokenUsage.inputTokens ?? "?"} / out ${tokenUsage.outputTokens ?? "?"}` +
      ` / total ${tokenUsage.totalTokens ?? "?"} / cached ${tokenUsage.cachedInputTokens ?? "?"}`,
  );
  return reflectPass(llm, LLM_MODEL, { outcome: { ...output, usage: tokenUsage }, system, lastPrompt: prompt, lastText: text ?? "" }, abortSignal, opts?.reflect === true);
}

// reflect 编排收口（#73）：单段/工具两路径的产出统一在这里过滤。触发条件 = opts.reflect 开 &&
// 第一轮有 blocker/major（成本控制）；同对话续写吃前缀缓存（#128）；失败 = 未评分意见按
// REFLECT_FAILURE_SCORE 处理（默认阈值下全部丢弃，「验证器挂了宁可少发」）
async function reflectPass(
  llm: ReturnType<typeof createOpenAI>,
  modelId: string,
  run: { outcome: ReviewOutcome; system: string; lastPrompt: string; lastText: string },
  abortSignal: AbortSignal,
  reflectOn: boolean,
): Promise<ReviewOutcome> {
  const outcome = run.outcome;
  if (!reflectOn) return outcome;
  if (!hasBlockingFinding(outcome.comments)) {
    console.log(`[reflect] 无 blocker/major 意见，跳过二次评分（成本控制）`);
    return { ...outcome, reflection: { triggered: false, before: outcome.comments.length, after: outcome.comments.length, dropped: 0, relines: 0, failed: false } };
  }
  const before = outcome.comments.length;
  try {
    const { scores, usage } = await runReflection(llm, modelId, run.system, run.lastPrompt, run.lastText, outcome.comments, abortSignal, llmMaxOutputTokens());
    const { kept, relines } = applyReflection(outcome.comments, scores, reflectMinScore());
    console.log(
      `[reflect] ${before} → ${kept.length} 条（阈值 ${reflectMinScore()}，失败分 ${REFLECT_FAILURE_SCORE}，行号修正 ${relines}）` +
        ` / tokens: in ${usage.inputTokens ?? "?"} / out ${usage.outputTokens ?? "?"} / cached ${usage.cachedInputTokens ?? "?"}`,
    );
    return {
      ...outcome,
      comments: kept,
      usage: sumUsage([outcome.usage, usage]),
      reflection: { triggered: true, before, after: kept.length, dropped: before - kept.length, relines, failed: false },
    };
  } catch (err) {
    console.error(`[reflect] 失败，${before} 条意见按失败分 ${REFLECT_FAILURE_SCORE} 处理（低于阈值全部丢弃——宁可少发）`, err);
    return {
      ...outcome,
      comments: [],
      reflection: { triggered: true, before, after: 0, dropped: before, relines: 0, failed: true },
    };
  }
}

// 工具循环步预算（D027，D031 语义扩展）：FILE_TOOL_MAX_STEPS，默认 2；数值 0 = 显式关闭（生产 kill switch，
// 与 CONTEXT_MAX_CHARS 同款「按数值判定关闭」语义）；其余非法值告警回退默认。
// 两段协议里「步」= 工具步：search 与 read 共享计步（extractToolRequests 内 search 先分配、read 用剩余），
// 与 AI SDK tools 形态每步一调的成本口径一致
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

// 单步注入的文件内容总量封顶（D027）：防止单段把上下文窗口吃穿；超出截断附说明行。
// search 结果有独立预算（SEARCH_MAX_TOTAL_CHARS，context.ts），在此之上整块仍受本值封顶
export const FILE_TOOL_BLOCK_MAX_CHARS = 80_000;

// 首段自由文本里提取工具请求（best-effort，D027 read / D031 search 并列）：容忍 ```json 围栏与前后闲话，
// 取第一个平衡 JSON 对象；解析失败 / 缺键 / 超预算条数截断——协议违规不炸审查，降级为无工具结果照常出结果。
// searchRequests 与 readRequests 元素各兼容两种形态：字符串 或 {query}/{path} 对象；
// 步预算共享：search 先分配（查询命中是定位类 read 的前提，且结果块小），read 用剩余预算。
// readRequests 去重键与 reader 的路径解析共用同一 normalizeSnapshotPath（PR #30 自审 minor：两份归一化会漂移），
// 覆盖同一文件的写法变体，最终合法性仍由 resolveSnapshotPath 把关
export function extractToolRequests(text: string, maxSteps: number): ToolRequests {
  if (maxSteps <= 0) return { searches: [], reads: [] };
  const parsed = extractBalancedJson(text);
  const root = parsed as { readRequests?: unknown; searchRequests?: unknown } | null;
  const rawSearches: string[] = [];
  if (Array.isArray(root?.searchRequests)) {
    for (const item of root.searchRequests) {
      if (typeof item === "string") {
        rawSearches.push(item);
      } else if (typeof item === "object" && item !== null && typeof (item as { query?: unknown }).query === "string") {
        rawSearches.push((item as { query: string }).query);
      }
    }
  }
  const rawPaths: string[] = [];
  if (Array.isArray(root?.readRequests)) {
    for (const item of root.readRequests) {
      if (typeof item === "string") {
        rawPaths.push(item);
      } else if (typeof item === "object" && item !== null && typeof (item as { path?: unknown }).path === "string") {
        rawPaths.push((item as { path: string }).path);
      }
    }
  }
  // 查询词去重：trim 后精确串（大小写敏感——查询本身大小写敏感，两词是两次不同搜索）；空词丢弃
  const seenQ = new Set<string>();
  const searches: string[] = [];
  for (const q of rawSearches) {
    const key = q.trim();
    if (!key || seenQ.has(key)) continue;
    seenQ.add(key);
    searches.push(key);
  }
  const reads: string[] = [];
  const seen = new Set<string>();
  for (const p of rawPaths) {
    const key = normalizeSnapshotPath(p);
    // 非法路径（含 ../反斜杠）保留原文进列表：由 buildToolBlock 落 not found 说明行给模型反馈，
    // 静默丢弃会让模型收不到任何纠正信号（自审 nit，与 review-tools.md 的「会被拒绝」承诺对齐）
    const dedupeKey = key ?? `illegal:${p.trim()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    reads.push(p.trim());
  }
  return {
    searches: searches.slice(0, maxSteps),
    reads: reads.slice(0, maxSteps - Math.min(searches.length, maxSteps)),
  };
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

// 第二段 prompt 的工具结果块（D027 read / D031 search）：工具结果在前、diff 保持生成前最近位置
// （行号锚点原则同 D023 上下文）。块头 [工具结果] 是两段判据（review-tools.md「按开头判断」）；
// search 段在前（命中行是定位信息）、read 段在后，共享同一字符记账（search 有独立查询预算，
// read 用剩余预算）。命中 → 结果/全文（超出截断附说明行）；未命中/非法 → 统一说明行（不抛错，模型自行纠正）
export function buildToolBlock(reqs: ToolRequests, reader: ((path: string) => string | null) | undefined, searcher: Searcher | undefined): string {
  const HEADER = "[工具结果]";
  const parts: string[] = [HEADER];
  // 记账含头部行与 join 分隔换行（自审 nit：此前系统性低估几十字符，多文件截断边界可能越顶）
  let used = HEADER.length;
  let step = 0;
  for (const query of reqs.searches) {
    step++;
    const outcome = searcher ? searcher(query) : null;
    if (!outcome) {
      // 防御位（worker 与 eval 都从同一快照成对注入 reader/searcher，此分支实际不可达）：
      // 显式「未能执行」而非伪「无匹配」——后者会让模型误信「无残留引用」压掉真发现
      parts.push(`=== search："${query}"（未能执行：搜索不可用）===`);
      continue;
    }
    const section: string[] = [];
    if (outcome.files.length === 0 && outcome.omittedFiles === 0) {
      section.push(`=== search："${query}"（无匹配）===`);
    } else {
      section.push(`=== search："${query}"（${outcome.totalFiles} 个文件 ${outcome.totalMatches} 处匹配）===`);
      for (const f of outcome.files) {
        section.push(...f.lines);
        if (f.omittedMatches > 0) section.push(`[search] ${f.path} 仅显示前 ${f.lines.length} 处匹配（共 ${f.lines.length + f.omittedMatches} 处）`);
      }
      if (outcome.omittedFiles > 0 || outcome.charTruncated) {
        section.push(`[search] 结果超出字符预算，仅显示部分匹配`);
      }
    }
    const text = section.join("\n");
    // 整块封顶对 search 段同样生效（PR #42 自审/bot minor）：查询结果自带 20k 独立预算，但
    // FILE_TOOL_MAX_STEPS 可配 ≥5，多查询累加可破 80k 整块契约——装不下的查询整段未纳入留说明，
    // 不做段内再截断（searchEntries 已按预算自截，中部再切会让命中行断在半句；模型可收窄查询重搜）
    if (used + text.length + 1 > FILE_TOOL_BLOCK_MAX_CHARS) {
      parts.push(`[search] "${query}" 结果超出整块字符预算，未纳入`);
      console.log(`[tools] step ${step}: search "${query}" (未纳入, 整块预算)`);
      continue;
    }
    parts.push(text);
    used += text.length + 1;
    console.log(`[tools] step ${step}: search "${query}" (${outcome.totalFiles} files / ${outcome.totalMatches} matches)`);
  }
  for (const path of reqs.reads) {
    step++;
    if (!reader) {
      // 防御位（PR #42 bot minor，与 search 侧同型对称）：启用闸是 fileReader || searcher，只注入 searcher
      // 而模型声明了 read 时，快照实际可用、只是 reader 未注入——伪报「file not found」会让模型误信
      // 文件不在快照里而放行本应核实的疑点，故显式「未能执行」（worker/eval 实际都成对注入，正常不可达）
      parts.push(`[read_file] ${path}: 未能执行（读取不可用）`);
      console.log(`[tools] step ${step}: read ${path} (未执行, reader 未注入)`);
      continue;
    }
    const content = reader(path);
    if (content === null) {
      parts.push(`[read_file] ${path}: file not found in head snapshot`);
      console.log(`[tools] step ${step}: read ${path} (not found)`);
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
      console.log(`[tools] step ${step}: read ${path} (${content.length} chars)`);
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
        console.log(`[tools] step ${step}: read ${path} (${cut}/${content.length} chars, 截断)`);
      } else {
        parts.push(`[read_file] ${path} 全文 ${content.length} 字符超出字符预算，未纳入`);
        console.log(`[tools] step ${step}: read ${path} (0/${content.length} chars, 未纳入)`);
      }
    } else {
      parts.push(`[read_file] ${path} 全文 ${content.length} 字符超出字符预算，未纳入`);
      console.log(`[tools] step ${step}: read ${path} (0/${content.length} chars, 未纳入)`);
    }
  }
  return parts.join("\n");
}

// 两段协议（D027 read_file + D031 search_file；spec 回退形态；SDK tools + Output 组合端点实测不可行，证据见 D027/PR body）：
// 第一段（无 response_format 的自由文本）输出工具请求 JSON（searchRequests + readRequests 并列声明，单轮执行，
// 不做 search→read 多轮链式——延迟/成本翻倍，搜索结果自带命中行上下文已可定位，生产 dogfood 观察后再议）→
// 解析 → 搜索命中行与文件内容拼进第二段 prompt → 复用同一 schema 出结果。
// abortSignal 贯穿两段；usage 为两段合计（ReviewOutcome 契约不变）；
// ReviewResult schema 与 prompts/review.md 都不动，fileReader/searcher 都不传时整段不生效（eval 字节级不变）
async function reviewDiffWithTools(
  llm: ReturnType<typeof createOpenAI>,
  modelId: string,
  prompt: string,
  fileReader: ((path: string) => string | null) | undefined,
  searcher: Searcher | undefined,
  abortSignal: AbortSignal,
  // 调用方已读过并据此放行（启用闸单点合流），作参数下传消除两处读 env 的理论分叉（自审降级 nit）
  maxSteps: number,
  // eval-only 变体（#127）：review.md 后追加段（工具指令仍在其后——工具协议优先级高于消融焦点）
  promptSuffix?: string,
): Promise<{ outcome: ReviewOutcome; system: string; lastPrompt: string; lastText: string }> {
  // system 追加指令来自 prompts/review-tools.md（仅 fileReader/searcher 注入时拼接）；review.md 一字不动
  const base = promptSuffix ? `${loadPrompt()}\n\n${promptSuffix}` : loadPrompt();
  const system = `${base}\n\n${loadToolsPrompt()}`;
  const probe = await generateText({ model: llm.chat(modelId), maxOutputTokens: llmMaxOutputTokens(), system, prompt, abortSignal });
  const requests = extractToolRequests(probe.text, maxSteps);
  const reqNote = (xs: string[], label: string) => (xs.length > 0 ? `${label} ×${xs.length}（${xs.join(" | ")}）` : `${label} 无`);
  console.log(`[tools] 第一段工具请求：${reqNote(requests.searches, "search")} / ${reqNote(requests.reads, "read")}（预算 ${maxSteps}）`);
  // 第一段 tokens 单独落行（消融数据出口与 [router] tokens 同型；覆盖 search+read 两类工具请求，故不叫 [search]）
  console.log(
    `[tools] probe tokens: in ${probe.usage?.inputTokens ?? "?"} / out ${probe.usage?.outputTokens ?? "?"}` +
      ` / total ${probe.usage?.totalTokens ?? "?"}`,
  );
  // 空工具请求也要注入占位块（自审 minor，dogfood 高频路径）：否则第二段 prompt/system 与第一段
  // 完全相同，模型按 review-tools.md 的「开头无块 = 第一段」判据会再输出工具请求而非审查意见，
  // Output 解析失败整审炸
  const hasRequests = requests.searches.length > 0 || requests.reads.length > 0;
  const toolBlock = `${hasRequests ? buildToolBlock(requests, fileReader, searcher) : "[工具结果]（本轮无工具请求，请直接给出审查意见）"}\n\n`;
  const { output, usage, text } = await generateText({
    maxOutputTokens: llmMaxOutputTokens(),
    model: llm.chat(modelId),
    output: Output.object({ schema: reviewResultSchema, name: "ReviewResult" }),
    system: withJsonSuffix(system),
    prompt: `${toolBlock}${prompt}`,
    abortSignal,
  });
  const tokenUsage = sumUsage([
    {
      inputTokens: probe.usage?.inputTokens ?? null,
      outputTokens: probe.usage?.outputTokens ?? null,
      totalTokens: probe.usage?.totalTokens ?? null,
      cachedInputTokens: probe.usage?.inputTokenDetails?.cacheReadTokens ?? null,
    },
    {
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      cachedInputTokens: usage?.inputTokenDetails?.cacheReadTokens ?? null,
    },
  ]);
  console.log(
    `[reviewDiff] tokens（两段合计）: in ${tokenUsage.inputTokens ?? "?"} / out ${tokenUsage.outputTokens ?? "?"}` +
      ` / total ${tokenUsage.totalTokens ?? "?"} / cached ${tokenUsage.cachedInputTokens ?? "?"}`,
  );
  return { outcome: { ...output, usage: tokenUsage }, system: withJsonSuffix(system), lastPrompt: `${toolBlock}${prompt}`, lastText: text ?? "" };
}
