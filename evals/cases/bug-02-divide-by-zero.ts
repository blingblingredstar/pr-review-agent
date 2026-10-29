import type { EvalCase } from "../score.ts";

// 新函数对可能为空的数组求比值；隔壁函数有 length===0 守卫可对照
export default {
  id: "bug-02-divide-by-zero",
  kind: "bug",
  source: "synthetic",
  description: "games 为空数组时除零得 NaN，同文件既有函数有守卫可对照",
  diff: `diff --git a/src/stats.ts b/src/stats.ts
index 21c3d4e..6e7f8a9 100644
--- a/src/stats.ts
+++ b/src/stats.ts
@@ -8,5 +8,10 @@ export function averageOrderValue(totalCents: number, orders: string[]): number {
   if (orders.length === 0) {
     return 0;
   }
   return totalCents / orders.length;
 }
+
+export function winRate(games: { result: "win" | "loss" }[]): number {
+  const wins = games.filter((g) => g.result === "win").length;
+  return Math.round((wins / games.length) * 100);
+}
`,
  expect: [
    {
      file: "src/stats.ts",
      line: null,
      mustMention: ["除零", "除以 0", "除以零", "空数组", "NaN", "length", "为 0", "守卫"],
    },
  ],
} satisfies EvalCase;
