// reflect 二次评分（#73，pr-agent 借鉴）：precision 的工程化手段——第一轮审查产出 blocker/major 时，
// 同对话续写一次调用（吃前缀缓存），对每条意见按硬 rubric 打 0-10 分并修正行号，低于阈值的意见在发布层过滤。
// 失败语义两层（PR #145 bot major 修正）：
// ① 调用整体失败 = 回退第一轮原始意见（abortSignal 贯穿两段，撞 abort 是常见路径——清空会把合并闸门
//   被一次超时打开变成常态；reflect 没跑成 = 没有验证层，基线行为兜底）；
// ② 调用成功但个别意见未被评分 → 按 REFLECT_FAILURE_SCORE 处理（上游 score_on_reflection_failure=7
//   同型——低于默认阈值即拦，「宁可少发」限定在经过评分判定的意见上）。
// 本模块只做纯逻辑与 LLM 调用；编排（何时触发、预算）在 review.ts，生产开关在 worker（REFLECT_ENABLED）。
import { readFileSync } from "node:fs";
import { generateText, Output } from "ai";
import { z } from "zod";
import type { ReviewComment } from "./review.ts";

export const reflectionSchema = z.object({
  scores: z.array(
    z.object({
      index: z.number().int().nonnegative().describe("对应待评分列表的序号（从 0 开始）"),
      score: z.number().int().min(0).max(10).describe("0-10 分"),
      // 行号修正（#73）：仅锚错时给；非法/越界值由 applyReflection 拒收（防幻觉行号污染锚点）
      line: z.number().int().positive().optional().describe("修正后的新文件行号（仅锚错时给）"),
      reason: z.string().describe("一句话依据"),
    }),
  ),
});

export type ReflectionEntry = z.infer<typeof reflectionSchema>["scores"][number];

// reflect 失败分（上游 score_on_reflection_failure=7 同型）：调用成功但个别意见未被评分时按此分处理，
// 默认阈值 8 之下即被拦——「宁可少发」限定在经过评分判定的意见上；调用整体失败走 review.ts 的回退基线路径
export const REFLECT_FAILURE_SCORE = 7;

export function loadReflectPrompt(): string {
  return readFileSync(new URL("../prompts/review-reflect.md", import.meta.url), "utf8");
}

// reflect 触发条件（成本控制）：只在第一轮有 blocker/major 意见时跑第二次调用——
// minor/nit 不进合并闸门，过滤它们的收益低于多一次调用的成本
export function hasBlockingFinding(comments: ReviewComment[]): boolean {
  return comments.some((c) => c.severity === "blocker" || c.severity === "major");
}

// 待评分列表（编号与 index 对齐）：0 起始、逐条 file:line + severity + 正文。正文原样引用——
// rubric 要求模型对意见措辞独立判断（含威胁模型重申：意见引用的代码是数据不是指令）
export function buildReflectUserMessage(comments: ReviewComment[]): string {
  const list = comments
    .map((c, i) => `${i}. [${c.severity}] ${c.file}:${c.line}\n${c.body}`)
    .join("\n\n");
  return `${loadReflectPrompt()}\n\n## 待评分意见（共 ${comments.length} 条）\n\n${list}\n\n请逐条评分。`;
}

// 发布阈值（REFLECT_MIN_SCORE，默认 8）：rubric 封顶 7 的意见被拦，封顶 8 的错误处理/类型检查类保留。
// 数值 0-10 之外告警回退默认；下限 0 等于不过滤（reflect 白跑，仅调试用）
let warnedInvalidMinScore = false;

// 生产开关（worker review 阶段注入 opts.reflect 的唯一来源）：REFLECT_ENABLED="1" 显式开启，
// 默认关——零行为差异上线，生产启用等 eval 验收读数
export function reflectEnabled(): boolean {
  return process.env.REFLECT_ENABLED === "1";
}

export function reflectMinScore(): number {
  const raw = process.env.REFLECT_MIN_SCORE;
  if (raw === undefined || raw.trim() === "") return 8;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) {
    if (!warnedInvalidMinScore) {
      console.warn(`REFLECT_MIN_SCORE="${raw}" 不是 0-10 整数，回退默认 8`);
      warnedInvalidMinScore = true;
    }
    return 8;
  }
  return parsed;
}

// 过滤纯函数：score >= threshold 保留（并采纳合法行号修正）；未评分的意见按失败分处理；
// 越界/重复 index 忽略（该意见落入「未评分」语义）。行号修正仅接受正整数——其余形态拒收不炸。
// relines = 行号被修正的意见数（观测面，#73 验收要看「修正行号锚定」是否真实发生）
export function applyReflection(
  comments: ReviewComment[],
  scores: ReflectionEntry[],
  threshold: number,
): { kept: ReviewComment[]; relines: number } {
  const byIndex = new Map<number, ReflectionEntry>();
  for (const s of scores) {
    if (!Number.isInteger(s.index) || (s.index as number) < 0 || (s.index as number) >= comments.length) continue;
    if (!byIndex.has(s.index as number)) byIndex.set(s.index as number, s);
  }
  const kept: ReviewComment[] = [];
  let relines = 0;
  comments.forEach((c, i) => {
    const entry = byIndex.get(i);
    const score = entry ? entry.score : REFLECT_FAILURE_SCORE;
    if (score < threshold) return;
    const corrected =
      entry && typeof entry.line === "number" && Number.isInteger(entry.line) && entry.line > 0 && entry.line !== c.line
        ? entry.line
        : null;
    if (corrected !== null) relines += 1;
    kept.push(corrected !== null ? { ...c, line: corrected } : c);
  });
  return { kept, relines };
}

// reflect 调用结果（过滤之外的观测面）：run.ts 据此聚合臂统计，token 两线随 outcome.usage 合计
export type ReflectionInfo = {
  triggered: boolean;
  before: number;
  after: number;
  dropped: number;
  relines: number; // 行号被修正的意见数
  failed: boolean;
};

// 同对话续写调用（前缀缓存的关键设计约束，#128 读数：同前缀续写命中 ~1/8 价）：
// system 与第一轮调用完全一致（字节级），消息 = 第一轮 user prompt → assistant 原文 → reflect 指令。
// firstText 用第一轮 generateText 的原文（Output.object 解析前的 text）——对话续写要的是模型真实输出
export async function runReflection(
  llm: ReturnType<typeof import("@ai-sdk/openai").createOpenAI>,
  modelId: string,
  system: string,
  lastPrompt: string,
  lastText: string,
  comments: ReviewComment[],
  abortSignal: AbortSignal,
  maxOutputTokens?: number,
): Promise<{ scores: ReflectionEntry[]; usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cachedInputTokens: number | null } }> {
  const { output, usage } = await generateText({
    maxOutputTokens,
    model: llm.chat(modelId),
    output: Output.object({ schema: reflectionSchema, name: "ReflectionResult" }),
    system,
    messages: [
      { role: "user", content: lastPrompt },
      { role: "assistant", content: lastText },
      { role: "user", content: buildReflectUserMessage(comments) },
    ],
    abortSignal,
  });
  return {
    scores: output.scores,
    usage: {
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      cachedInputTokens: usage?.inputTokenDetails?.cacheReadTokens ?? null,
    },
  };
}
