import type { EvalCase } from "../score.ts";

// reduce 初始值 0 被删，空购物车时抛 TypeError
export default {
  id: "bug-10-reduce-no-initial",
  kind: "bug",
  description: "reduce 删掉初始值后空数组直接抛 TypeError",
  diff: `diff --git a/src/cart.ts b/src/cart.ts
index 2c3d4e5..6d7e8f9 100644
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -15,5 +15,5 @@ export interface CartItem {
 }
 
 export function totalCents(items: CartItem[]): number {
-  return items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
+  return items.reduce((sum, item) => sum + item.priceCents * item.quantity);
 }
`,
  expect: [
    {
      file: "src/cart.ts",
      line: 18,
      mustMention: ["初始值", "initialvalue", "空数组", "reduce", "typeerror", "抛"],
    },
  ],
} satisfies EvalCase;
