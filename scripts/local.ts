// Day 1 冒烟脚本：hardcode 一个带明显 bug 的 diff，验证「diff 文本 → 结构化审查意见」核心链路。
import { reviewDiff } from "../src/review.ts";

const SAMPLE_DIFF = `diff --git a/src/cart.ts b/src/cart.ts
index 3f2a1bc..9d4e2fa 100644
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -1,8 +1,10 @@
 export interface CartItem {
   productId: string;
   price: number;
 }
 
-export function cartTotal(items: CartItem[]): number {
-  return items.reduce((sum, item) => sum + item.price, 0);
+export function cartTotal(items: CartItem[]): number {
+  let total = 0;
+  for (let i = 0; i <= items.length; i++) {
+    total += items[i].price;
+  }
+  return total;
 }
`;

const result = await reviewDiff(SAMPLE_DIFF);
console.log(JSON.stringify(result, null, 2));
