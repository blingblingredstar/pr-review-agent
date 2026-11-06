// #100 意见置信度结构化：schema optional 兼容、eval 逐意见记录对齐、发布面不渲染（tripwire）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { reviewResultSchema } from "../src/review.ts";
import { scoreCase, type EvalCase } from "../evals/score.ts";

test("schema：带 confidence 字段可 parse（三档枚举）", () => {
  for (const confidence of ["high", "medium", "low"] as const) {
    const parsed = reviewResultSchema.parse({
      comments: [{ file: "src/cart.ts", line: 10, severity: "major", body: "越界访问", confidence }],
    });
    assert.equal(parsed.comments[0]?.confidence, confidence);
  }
});

test("schema：不含 confidence 字段也可 parse（optional——历史 run JSON 读入零破坏）", () => {
  const parsed = reviewResultSchema.parse({
    comments: [{ file: "src/cart.ts", line: 10, severity: "major", body: "越界访问" }],
  });
  assert.equal(parsed.comments[0]?.confidence, undefined);
});

test("schema：confidence 拒绝枚举外的值", () => {
  assert.throws(() =>
    reviewResultSchema.parse({
      comments: [{ file: "a.ts", line: 1, severity: "nit", body: "x", confidence: "certain" }],
    }),
  );
});

const aCase: EvalCase = {
  id: "t",
  kind: "bug",
  description: "",
  diff: "",
  expect: [{ file: "src/cart.ts", line: 10, mustMention: ["越界"] }],
};

const comment = (confidence?: "high" | "medium" | "low") => ({
  file: "src/cart.ts",
  line: 10,
  severity: "major" as const,
  body: "越界访问",
  ...(confidence ? { confidence } : {}),
});

test("scoreCase：commentConfidences 与意见索引一一对齐，缺失为 null", () => {
  const s = scoreCase(aCase, [comment("high"), comment(), comment("low")]);
  assert.deepEqual(s.commentConfidences, ["high", null, "low"]);
  assert.equal(s.commentConfidences.length, s.agentComments);
});

test("scoreCase：无意见时 commentConfidences 为空数组", () => {
  assert.deepEqual(scoreCase(aCase, []).commentConfidences, []);
});

// 发布面核对（#100 规格：confidence 不出现在任何 GitHub 输出里）。
// 人工核对结论：全部 GitHub 写入路径都收敛在 src/github.ts（worker.ts:367 与 scripts/review-pr.ts:36
// 均调 postReview），五处 body 组装全是显式模板串、只插值 file/line/severity/body，无对象展开、
// 无 comments 的 JSON.stringify，confidence 结构上进不了任何 GitHub 输出：
//   src/github.ts:183 行内评论 `**[${c.severity}]** ${c.body}`
//   src/github.ts:194 minor/nit 折叠段、:204 降级列表、:250 全量降级兜底（同款单行模板）
//   src/github.ts:120-131 summaryBody（severity 计数 + dedupe 标记）
// 下面一条断言做机械 tripwire：两个文件出现 confidence 字样即红，倒逼有意修改时同步核对本注释。
test("发布面：github.ts / worker.ts 不含 confidence（组装路径不渲染）", () => {
  for (const f of ["../src/github.ts", "../src/worker.ts"]) {
    const text = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(!text.includes("confidence"), `${f} 出现 confidence，发布面渲染可能变更，核对上方注释后再更新断言`);
  }
});
