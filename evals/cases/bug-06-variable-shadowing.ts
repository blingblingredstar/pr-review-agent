import type { EvalCase } from "../score.ts";

// 循环体内 const total 遮蔽外层 let total，返回值恒为 0
export default {
  id: "bug-06-variable-shadowing",
  kind: "bug",
  source: "synthetic",
  description: "内层 const total 遮蔽外层累加变量，函数返回 0",
  diff: `diff --git a/src/checkout.ts b/src/checkout.ts
index 8e9f0a1..2f3a4b5 100644
--- a/src/checkout.ts
+++ b/src/checkout.ts
@@ -25,9 +25,10 @@ export function cartTotal(items: CartItem[], receiptLines: string[]): number {
   let total = 0;
   for (const item of items) {
     if (!item.active) {
       continue;
     }
-    total += item.price * item.quantity;
+    const total = item.price * item.quantity;
+    receiptLines.push(\`\${item.sku}: \${total}\`);
   }
   return total;
 }
`,
  expect: [
    {
      file: "src/checkout.ts",
      line: 30,
      mustMention: ["遮蔽", "shadow", "覆盖", "外层", "同名", "重新声明", "内层", "累加"],
    },
  ],
} satisfies EvalCase;
