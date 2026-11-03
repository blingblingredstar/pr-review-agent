import { readFileSync } from "node:fs";
import { normalizeSnapshotPath } from "./paths.ts";
import { generateText, Output } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { truncateDiff } from "./diff.ts";
import { buildPlanBlock, type ReviewPlan } from "./router.ts";

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

// 导出（D030）：router.ts 的 runReviewRouter 与 reviewDiff 共用同一 extraBody 解析（成环 import，调用期绑定）
export function extraBody(): Record<string, unknown> {
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
// 两处各自拼接曾出现 +14 偏移与比较符分叉，边界上判定相反）。
// D028 扩展 opts.plan：计划块放 context 之后、`[diff 开始]` 之前（无 context 时在 diff 之前）——diff 仍最末尾
// （行号锚点原则）。无 plan → 字节级现状（eval 红线由构造保证，opts.plan 只有 worker 编排注入这一条路径）。
// D030：位置参数收敛为选项对象（D029 的 taskContext 届时落进同一 opts，不再加位置参数），输出字节级不变
export function buildReviewPrompt(diff: string, opts?: { context?: string; plan?: ReviewPlan }): string {
  const diffText = truncateDiff(diff);
  const planBlock = opts?.plan ? `${buildPlanBlock(opts.plan)}\n\n` : "";
  if (opts?.context) return `${opts.context}\n\n${planBlock}[diff 开始]\n${diffText}`;
  return `${planBlock}${diffText}`;
}

// reviewDiff 可选项（D027）：fileReader 注入即启用 read_file 工具循环（两段协议）；
// 不传 = 单次调用原路径，prompt/system 字节级不变——eval 红线由构造保证。
// D028：plan 由 worker 编排注入（router 产物），reviewDiff 自身不调 router——evals 直调永远无 plan
export type ReviewDiffOpts = {
  timeoutMs?: number;
  fileReader?: (path: string) => string | null;
  plan?: ReviewPlan;
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
  // eval 不传 context / 无 plan（router 只由 worker 编排注入）→ prompt 字节级不变（promptHash 稳定是回归对照的前提）
  const prompt = buildReviewPrompt(diff, { context, plan: opts?.plan });
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
