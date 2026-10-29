import type { EvalCase } from "../score.ts";

// price.ts 导出改名 formatPrice → formatCurrency，invoice.ts 的 import 还在用旧名（import 行在上下文可见）
export default {
  id: "linked-01-rename-missed-import",
  kind: "linked",
  source: "synthetic",
  description: "导出函数改名，另一个文件的 import 未同步（运行时崩溃）",
  diff: `diff --git a/src/utils/price.ts b/src/utils/price.ts
index 5f6a7b8..9b0c1d2 100644
--- a/src/utils/price.ts
+++ b/src/utils/price.ts
@@ -1,9 +1,9 @@
-export function formatPrice(cents: number): string {
+export function formatCurrency(cents: number): string {
   const yuan = (cents / 100).toFixed(2);
   return \`¥\${yuan}\`;
 }
 
-export function formatPriceUsd(cents: number): string {
+export function formatCurrencyUsd(cents: number): string {
   const usd = (cents / 100).toFixed(2);
   return \`$\${usd}\`;
 }
diff --git a/src/format/invoice.ts b/src/format/invoice.ts
index 6a7b8c9..0c1d2e3 100644
--- a/src/format/invoice.ts
+++ b/src/format/invoice.ts
@@ -1,9 +1,10 @@
 import { formatPrice, formatPriceUsd } from "../utils/price.ts";
 
 export function invoiceTotal(cents: number): string {
-  return \`\${formatPrice(cents)} (含税)\`;
+  const line = formatPrice(cents);
+  return \`\${line} (含税)\`;
 }
 
 export function invoiceFooter(): string {
   return "感谢购买";
 }
`,
  expect: [
    {
      file: "src/format/invoice.ts",
      line: null,
      mustMention: ["formatprice", "改名", "重命名", "旧名", "引用", "import", "同步"],
    },
  ],
} satisfies EvalCase;
