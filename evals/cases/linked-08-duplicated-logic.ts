import type { EvalCase } from "../score.ts";

// yuan 与 yuanShort 原本逐字相同，本 PR 只给 yuan 去掉了 .00 后缀，yuanShort 未同步（在上下文可见）
export default {
  id: "linked-08-duplicated-logic",
  kind: "linked",
  source: "synthetic",
  description: "重复实现只修了一处，另一处未同步",
  diff: `diff --git a/src/format/money.ts b/src/format/money.ts
index 0d1e2f3..4f5a6b7 100644
--- a/src/format/money.ts
+++ b/src/format/money.ts
@@ -1,7 +1,7 @@
 export function yuan(cents: number): string {
-  return \`¥\${(cents / 100).toFixed(2)}\`;
+  return \`¥\${(cents / 100).toFixed(2).replace(/\\.00$/, "")}\`;
 }
 
 export function yuanShort(cents: number): string {
   return \`¥\${(cents / 100).toFixed(2)}\`;
 }
`,
  expect: [
    {
      file: "src/format/money.ts",
      line: null,
      mustMention: ["yuanshort", "另一", "同步", "不一致", "重复", "同样", "漏", "两处"],
    },
  ],
} satisfies EvalCase;
