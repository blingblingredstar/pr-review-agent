import type { EvalCase } from "../score.ts";

// "2026-10-29" 会被解析成 11 月 29 日；monthLabel 的语义展示 split 结果是 1-12
export default {
  id: "bug-08-date-month-off-by-one",
  kind: "bug",
  description: "Date 构造器月份 0 起始，解析 ISO 日期月份多 1",
  diff: `diff --git a/src/report.ts b/src/report.ts
index 0a1b2c3..4b5c6d7 100644
--- a/src/report.ts
+++ b/src/report.ts
@@ -22,3 +22,8 @@ export function monthLabel(iso: string): string {
   const [y, m] = iso.split("-").map(Number);
   return \`\${y} 年 \${m} 月\`;
 }
+
+export function parseDate(iso: string): Date {
+  const [year, month, day] = iso.split("-").map(Number);
+  return new Date(year, month, day);
+}
`,
  expect: [
    {
      file: "src/report.ts",
      line: 28,
      mustMention: ["0 起始", "0 基", "0-based", "从 0", "从零", "month", "月份", "getMonth", "偏移", "多 1", "+1"],
    },
  ],
} satisfies EvalCase;
