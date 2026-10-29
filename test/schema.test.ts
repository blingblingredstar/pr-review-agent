import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewResultSchema } from "../src/review.ts";

test("schema 接受合法审查结果", () => {
  const parsed = reviewResultSchema.parse({
    comments: [
      { file: "src/cart.ts", line: 10, severity: "major", body: "越界访问" },
    ],
  });
  assert.equal(parsed.comments.length, 1);
});

test("schema 拒绝非法 severity 和非正数行号", () => {
  assert.throws(() =>
    reviewResultSchema.parse({
      comments: [{ file: "a.ts", line: 1, severity: "critical", body: "x" }],
    }),
  );
  assert.throws(() =>
    reviewResultSchema.parse({
      comments: [{ file: "a.ts", line: 0, severity: "nit", body: "x" }],
    }),
  );
});
