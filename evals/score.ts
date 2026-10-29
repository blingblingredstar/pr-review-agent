// 打分规则（eval 的唯一判定契约，改这里要同步 docs/architecture.md 与单测）：
// 期望条目命中 = file 规范化后精确匹配 + line ±3 容差（null 为文件级）+ body 含 mustMention 任一关键词。
// 指标：recall = 命中期望 / 总期望；precision = 命中任一期望的意见 / 总意见（severity 不进判定，只做报告展示）。
import type { ReviewComment } from "../src/review.ts";

export type Expectation = {
  // 报在任一候选文件都算发现（「漏改」类问题可能报调用方，也可能报被删方）
  file: string | string[];
  // 期望问题所在的新文件行号；null 表示文件级（「漏改」类问题 agent 在文件任意行指出即可）
  line: number | null;
  // body 命中其一即算提到该问题（大小写不敏感），给同义候选以容忍措辞差异
  mustMention: string[];
};

export type EvalCase = {
  id: string;
  kind: "bug" | "linked";
  description: string;
  diff: string;
  expect: Expectation[];
  // synthetic=手写教学用例（缺省）；real=真实仓库 fix 反构/配对（能力评估的主依据）；dogfood=本仓库历史真实意见（回归集，防 prompt 退化，不计入能力评估）
  source?: "synthetic" | "real" | "dogfood";
};

export function sourceOf(c: EvalCase): "synthetic" | "real" | "dogfood" {
  return c.source ?? "synthetic";
}

// 模型可能带 git 的 a/ b/ 前缀，规范化后再比
export function normalizePath(file: string): string {
  return file.replace(/^a\//, "").replace(/^b\//, "");
}

export function matchesExpectation(exp: Expectation, comment: ReviewComment): boolean {
  const candidates = Array.isArray(exp.file) ? exp.file : [exp.file];
  if (!candidates.some((f) => normalizePath(f) === normalizePath(comment.file))) return false;
  if (exp.line !== null && Math.abs(comment.line - exp.line) > 3) return false;
  const body = comment.body.toLowerCase();
  return exp.mustMention.some((k) => body.includes(k.toLowerCase()));
}

export type ExpectationVerdict = { expect: Expectation; hit: boolean };

export type CaseScore = {
  caseId: string;
  kind: EvalCase["kind"];
  verdicts: ExpectationVerdict[];
  // 命中的期望数
  hits: number;
  recall: number;
  agentComments: number;
  // 命中任一期望的意见数（其余视为该用例的误报；agent 发现 diff 中未标注的其他真问题时会被误计，写用例时保持 diff 干净）
  truePositives: number;
  // 无意见时为 null（没有 FP 就谈不上精确率），报告层显示 —
  precision: number | null;
};

export function scoreCase(c: EvalCase, comments: ReviewComment[]): CaseScore {
  const verdicts = c.expect.map((expect) => ({ expect, hit: comments.some((cm) => matchesExpectation(expect, cm)) }));
  const hits = verdicts.filter((v) => v.hit).length;
  // 口径注意：recall 分子按期望条目计数，truePositives 按「命中至少一个期望」的意见数计数——
  // 一条意见同时命中两个期望时 recall 记 2、TP 只记 1，多期望用例的 precision 会被低估。
  // 当前 20 用例均为单期望不触发；扩多期望用例时需在报告里注明或统一口径。
  const truePositives = comments.filter((cm) => c.expect.some((e) => matchesExpectation(e, cm))).length;
  return {
    caseId: c.id,
    kind: c.kind,
    verdicts,
    hits,
    recall: c.expect.length ? hits / c.expect.length : 1,
    agentComments: comments.length,
    truePositives,
    precision: comments.length ? truePositives / comments.length : null,
  };
}
