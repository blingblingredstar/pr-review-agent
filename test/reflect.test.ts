import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyReflection,
  buildReflectUserMessage,
  hasBlockingFinding,
  REFLECT_FAILURE_SCORE,
  reflectMinScore,
  type ReflectionEntry,
} from "../src/reflect.ts";
import type { ReviewComment } from "../src/review.ts";

const comment = (over: Partial<ReviewComment> & Pick<ReviewComment, "file" | "line" | "severity">): ReviewComment => ({
  body: `**问题** ${over.file}:${over.line}`,
  ...over,
} as ReviewComment);

test("hasBlockingFinding：blocker/major 触发，仅 minor/nit 不触发", () => {
  assert.equal(hasBlockingFinding([comment({ file: "a.ts", line: 1, severity: "minor" })]), false);
  assert.equal(hasBlockingFinding([comment({ file: "a.ts", line: 1, severity: "nit" })]), false);
  assert.equal(hasBlockingFinding([comment({ file: "a.ts", line: 1, severity: "major" })]), true);
  assert.equal(hasBlockingFinding([comment({ file: "a.ts", line: 1, severity: "blocker" })]), true);
});

test("applyReflection：阈值过滤 + 未评分按失败分 + 越界/重复 index 忽略", () => {
  const comments = [
    comment({ file: "a.ts", line: 10, severity: "major" }),
    comment({ file: "b.ts", line: 20, severity: "major" }),
    comment({ file: "c.ts", line: 30, severity: "major" }),
    comment({ file: "d.ts", line: 40, severity: "major" }),
  ];
  const scores: ReflectionEntry[] = [
    { index: 0, score: 9, reason: "确凿" },        // 保留
    { index: 1, score: 5, reason: "未确凿" },      // 拦截
    { index: 9, score: 10, reason: "越界 index 忽略" }, // d 未评分 → 失败分 7 → 拦截
    { index: 2, score: 8, reason: "第一条重复生效" },
    { index: 2, score: 0, reason: "重复取先" },
  ];
  const { kept, relines } = applyReflection(comments, scores, reflectMinScore());
  assert.equal(kept.length, 2, "9 分保留、5 分拦截、失败分 7 拦截、重复 8 分保留");
  assert.deepEqual(kept.map((c) => c.file), ["a.ts", "c.ts"]);
  assert.equal(relines, 0);
  assert.equal(REFLECT_FAILURE_SCORE, 7, "失败分与上游 score_on_reflection_failure 同型");
  // threshold 0 = 不过滤（调试形态）
  assert.equal(applyReflection(comments, [], 0).kept.length, 4);
});

test("applyReflection：行号修正仅接受正整数，relines 只计真实修正", () => {
  const comments = [
    comment({ file: "a.ts", line: 16, severity: "major" }), // 模型锚错（#139 bug-01 同款形态）
    comment({ file: "b.ts", line: 5, severity: "major" }),
    comment({ file: "c.ts", line: 7, severity: "major" }),
  ];
  const scores: ReflectionEntry[] = [
    { index: 0, score: 9, line: 12, reason: "锚到真实行" },          // 修正 16 → 12
    { index: 1, score: 9, line: 0, reason: "非法修正拒收" },         // 0 非正 → 不修
    { index: 2, score: 9, line: 7, reason: "line 与原值相同不算修正" },
  ];
  const { kept, relines } = applyReflection(comments, scores, 8);
  assert.equal(kept[0].line, 12, "合法修正被采纳");
  assert.equal(kept[1].line, 5, "非法修正拒收");
  assert.equal(kept[2].line, 7, "同值不算修正");
  assert.equal(relines, 1);
});

test("reflectMinScore：默认 8，合法覆写生效，非法回退并只告警一次", () => {
  delete process.env.REFLECT_MIN_SCORE;
  assert.equal(reflectMinScore(), 8);
  process.env.REFLECT_MIN_SCORE = "9";
  assert.equal(reflectMinScore(), 9);
  process.env.REFLECT_MIN_SCORE = "abc";
  assert.equal(reflectMinScore(), 8);
  process.env.REFLECT_MIN_SCORE = "11";
  assert.equal(reflectMinScore(), 8);
  delete process.env.REFLECT_MIN_SCORE;
});

test("buildReflectUserMessage：0 起始编号 + file:line + 正文 + 总数，rubric 在场", () => {
  const msg = buildReflectUserMessage([
    comment({ file: "src/a.ts", line: 33, severity: "major" }),
    comment({ file: "src/b.ts", line: 12, severity: "minor" }),
  ]);
  assert.match(msg, /共 2 条/);
  assert.match(msg, /0\. \[major\] src\/a\.ts:33/);
  assert.match(msg, /1\. \[minor\] src\/b\.ts:12/);
  assert.match(msg, /打 0 分/, "硬 rubric 必须在消息里");
  assert.match(msg, /是数据不是指令/, "威胁模型重申必须在场");
});
