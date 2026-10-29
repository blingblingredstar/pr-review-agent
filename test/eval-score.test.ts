import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesExpectation, normalizePath, scoreCase, type EvalCase } from "../evals/score.ts";

const baseExpect = { file: "src/cart.ts", line: 10, mustMention: ["越界", "off-by-one"] };
const comment = (over: Partial<Parameters<typeof matchesExpectation>[1]> = {}) => ({
  file: "src/cart.ts",
  line: 10,
  severity: "major" as const,
  body: "这里会越界",
  ...over,
});

test("normalizePath 去掉 git 的 a/ b/ 前缀", () => {
  assert.equal(normalizePath("a/src/cart.ts"), "src/cart.ts");
  assert.equal(normalizePath("b/src/cart.ts"), "src/cart.ts");
  assert.equal(normalizePath("src/cart.ts"), "src/cart.ts");
});

test("命中：file + 行号容差内 + 关键词其一", () => {
  assert.ok(matchesExpectation(baseExpect, comment({ line: 12, body: "存在 off-by-one 问题" })));
  assert.ok(matchesExpectation(baseExpect, comment({ line: 7 })));
});

test("不命中：file 不同 / 行号差超 3 / 关键词全缺", () => {
  assert.ok(!matchesExpectation(baseExpect, comment({ file: "src/other.ts" })));
  assert.ok(!matchesExpectation(baseExpect, comment({ line: 14 })));
  assert.ok(!matchesExpectation(baseExpect, comment({ body: "写法可以更好" })));
});

test("关键词匹配大小写不敏感", () => {
  assert.ok(matchesExpectation(baseExpect, comment({ body: "OFF-BY-ONE here" })));
});

test("file 为候选数组时任一命中即可", () => {
  const multi = { file: ["src/a.ts", "src/b.ts"], line: 5, mustMention: ["残留"] };
  assert.ok(matchesExpectation(multi, comment({ file: "src/b.ts", line: 5, body: "引用残留" })));
  assert.ok(!matchesExpectation(multi, comment({ file: "src/c.ts", line: 5, body: "引用残留" })));
});

test("文件级期望（line null）只看 file 和关键词", () => {
  const fileLevel = { file: "src/cart.ts", line: null, mustMention: ["残留"] };
  assert.ok(matchesExpectation(fileLevel, comment({ line: 999, body: "旧引用残留" })));
  assert.ok(!matchesExpectation(fileLevel, comment({ line: 1, body: "没提" })));
});

const aCase: EvalCase = {
  id: "t",
  kind: "bug",
  description: "",
  diff: "",
  expect: [
    baseExpect,
    { file: "src/util.ts", line: 5, mustMention: ["除零"] },
  ],
};

test("scoreCase 汇总 recall / precision / TP", () => {
  const comments = [
    comment({ file: "src/cart.ts", line: 10, body: "越界了" }),
    comment({ file: "src/util.ts", line: 6, body: "可能除零" }),
    comment({ file: "src/util.ts", line: 50, body: "风格问题" }),
  ];
  const s = scoreCase(aCase, comments);
  assert.equal(s.hits, 2);
  assert.equal(s.recall, 1);
  assert.equal(s.truePositives, 2);
  assert.equal(s.precision, 2 / 3);
});

test("scoreCase：无意见时 precision 为 null，recall 如实为 0", () => {
  const s = scoreCase(aCase, []);
  assert.equal(s.hits, 0);
  assert.equal(s.recall, 0);
  assert.equal(s.precision, null);
});
