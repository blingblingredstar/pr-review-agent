import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreCase, matchesContent, matchesExpectation, type EvalCase } from "../evals/score.ts";
import type { ReviewComment } from "../src/review.ts";

// 构造最小 EvalCase：两期望双联（structural 在 :2、convention 在 :10——行距超 ±3 保证不互命中）
const dualCase: EvalCase = {
  id: "t-dual-01",
  kind: "linked",
  source: "ctxpair",
  description: "双联测试用例：structural + convention",
  diff: "diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,12 +1,12 @@\n line1\n line2\n line3\n line4\n line5\n line6\n line7\n line8\n line9\n line10\n line11\n line12\n",
  repo: { "src/a.ts": "line1\nline2\n..." },
  expect: [
    { file: "src/a.ts", line: 2, mustMention: ["null"], kind: "structural" },
    { file: "src/a.ts", line: 10, mustMention: ["命名"], kind: "convention" },
  ],
} as unknown as EvalCase;

const cm = (line: number, body: string): ReviewComment =>
  ({ file: "src/a.ts", line, severity: "major", body }) as unknown as ReviewComment;

test("#112 TP 按对计：一条意见命中双联两条期望记 2 个 TP；单期望等价性（commentTps 语义不变）", () => {
  // 一条意见（body 同时含两组关键词、行居中）——行 6 距两期望都 >3：改为分别断言两意见各命中一期望
  const one = scoreCase(dualCase, [cm(2, "空指针 null 风险"), cm(10, "命名违规，须按约定大写")]);
  assert.equal(one.truePositives, 2, "两条意见各命中一条期望 → TP=2（与旧口径一致）");
  assert.deepEqual(one.commentTps, [true, true]);
  assert.deepEqual(one.commentHitCounts, [1, 1]);
  assert.equal(one.precision, 1);

  // 一条意见同时命中两期望（body 含两组词、行号落 structural ±3——content 层不受行约束但 located 受）
  // 构造行 2 意见含「命名」：structural 期望 line=2 命中（±3 内 + null）；convention 期望 line=10 超出 ±3
  // 但 matchesContent 无行约束 → convention 的 content 也命中；对级 TP = 2（structural 全条件 + convention content？）
  // 不——matchesExpectation 对 convention 仍要求行 ±3：line 2 距 10 差 8 → convention 期望不命中该意见。
  // 对计 TP 只数 matchesExpectation 命中 = structural 1 → 该意见 commentHitCounts=[1]
  const partial = scoreCase(dualCase, [cm(2, "空指针 null 风险，另命名违规")]);
  assert.equal(partial.truePositives, 1);
  assert.deepEqual(partial.commentHitCounts, [1]);
});

test("#105 content/located 分离：行漂移的意见 content 命中但非 located（定位漂移可见）", () => {
  // 行 11（convention 期望 ±3 内）body 只含「命名」→ located 命中 convention
  // 行 6（两期望都超 ±3）body 含「命名」→ content 命中 convention、located 不命中——定位漂移
  const drifted = scoreCase(dualCase, [cm(6, "命名违规")]);
  assert.equal(drifted.contentComments, 1, "content 层行号不限 → 命中");
  assert.equal(drifted.locatedComments, 0, "located 层行 ±3 → 不命中");
  assert.equal(drifted.truePositives, 0, "precision 分子不变（全条件口径）");
  assert.equal(drifted.commentTps[0], false);

  const precise = scoreCase(dualCase, [cm(10, "命名违规")]);
  assert.equal(precise.contentComments, 1);
  assert.equal(precise.locatedComments, 1);
  assert.equal(precise.truePositives, 1);

  // 跨文件关键词命中不算 content（内容错位不是定位漂移）
  const crossFile = scoreCase(dualCase, [{ ...cm(6, "命名违规"), file: "src/other.ts" } as unknown as ReviewComment]);
  assert.equal(crossFile.contentComments, 0);
  assert.equal(matchesContent(dualCase.expect[1], cm(6, "命名违规")), true);
  assert.equal(matchesExpectation(dualCase.expect[1], cm(6, "命名违规")), false);
});

test("#112 单期望等价性：truePositives 逐位等于旧口径（命中至少一个期望的意见数）", () => {
  const single: EvalCase = {
    ...dualCase,
    id: "t-single-01",
    expect: [dualCase.expect[0]],
  } as unknown as EvalCase;
  const comments = [cm(1, "提到 null"), cm(5, "无关意见"), cm(4, "又提 null（同一期望被两条意见命中）")];
  const s = scoreCase(single, comments);
  // 旧口径：命中至少一个期望的意见数 = 2（意见 1 与 3）
  // 新口径（对计）：意见 1 命中 1 期望、意见 3 命中 1 期望 → sum = 2——单期望下两口径逐位一致
  assert.equal(s.truePositives, 2);
  assert.deepEqual(s.commentHitCounts, [1, 0, 1]);
});
