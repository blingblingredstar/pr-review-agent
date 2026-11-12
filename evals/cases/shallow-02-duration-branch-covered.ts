import type { EvalCase } from "../score.ts";

// #138 浅测试 aspect 负例：formatDuration 新增整分钟分支（行为正确），同 PR 的测试补了恰好
// 触达新分支的用例，且既有用例覆盖其余两路——浅测试规则触发但找不到可指认缺口，应零意见。
// 任何「负数/NaN 未测」「建议补测试」类意见都是该 aspect 的误报，expectClean 考 precision
export default {
  id: "shallow-02-duration-branch-covered",
  kind: "bug",
  source: "synthetic",
  description: "新增分支的测试恰好触达且既有用例覆盖其余分支——不应报浅测试类意见",
  diff: `diff --git a/src/duration.ts b/src/duration.ts
index 4d5e6f7..5e6f7a8 100644
--- a/src/duration.ts
+++ b/src/duration.ts
@@ -1,6 +1,7 @@
 export function formatDuration(seconds: number): string {
   if (seconds < 60) return \`\${seconds}s\`;
   const m = Math.floor(seconds / 60);
   const s = seconds % 60;
-  return \`\${m}m\${s}s\`;
+  if (s === 0) return \`\${m}m\`;
+  return \`\${m}m\${s}s\`;
 }
diff --git a/test/duration.test.ts b/test/duration.test.ts
index 8e9f0a1..9f0a1b2 100644
--- a/test/duration.test.ts
+++ b/test/duration.test.ts
@@ -5,7 +5,10 @@ import { formatDuration } from "../src/duration.ts";
 describe("formatDuration", () => {
   it("秒", () => {
     expect(formatDuration(45)).toBe("45s");
   });
+  it("整分钟", () => {
+    expect(formatDuration(120)).toBe("2m");
+  });
   it("分秒", () => {
     expect(formatDuration(90)).toBe("1m30s");
   });
`,
  expect: [],
  expectClean: true,
} satisfies EvalCase;
