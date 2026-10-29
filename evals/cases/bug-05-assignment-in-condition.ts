import type { EvalCase } from "../score.ts";

// 条件里的 = 是赋值不是比较，条件恒真
export default {
  id: "bug-05-assignment-in-condition",
  kind: "bug",
  source: "synthetic",
  description: "把 === 误写成 =，if 条件变成赋值恒真",
  diff: `diff --git a/src/feature-flags.ts b/src/feature-flags.ts
index 7d8e9f0..1e2f3a4 100644
--- a/src/feature-flags.ts
+++ b/src/feature-flags.ts
@@ -18,9 +18,9 @@ export function flags(user: User): Flags {
   const base = defaults(user.plan);
   if (user.betaOptIn) {
     base.newDashboard = true;
   }
-  if (user.isAdmin === true) {
+  if (user.isAdmin = true) {
     base.auditLog = true;
   }
   return base;
 }
`,
  expect: [
    {
      file: "src/feature-flags.ts",
      line: 22,
      mustMention: ["赋值", "恒真", "永真", "恒为", "误写", "比较运算", "==="],
    },
  ],
} satisfies EvalCase;
