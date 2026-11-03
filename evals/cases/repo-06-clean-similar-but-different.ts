import type { EvalCase } from "../score.ts";

// D031 FP 对照（expectClean）：表面相似但语义不同——diff 新增的 parseCsvExport（分号分隔列，导出侧约定）
// 与未触及文件 src/import/csv.ts 的 parseCsvImport（逗号分隔列，RFC 4180）词法几乎相同
// （同款 split("\n") 行 + split(分隔符) 列 + 同款 replace 管道，搜索会同时命中两个文件），
// 但两者处理各自约定的格式、语义都正确，不构成 DRY 违规。期望零意见。诱饵：src/export/xlsx.ts
export default {
  id: "repo-06-clean-similar-but-different",
  kind: "linked",
  source: "repo",
  description: "FP 对照：词法相似但语义不同（导出/导入两侧各自约定的分隔符），不构成 DRY（期望零意见）",
  diff: `diff --git a/src/export/csv.ts b/src/export/csv.ts
index 8b8c8d8..9c9d9e9 100644
--- a/src/export/csv.ts
+++ b/src/export/csv.ts
@@ -4,3 +4,10 @@
   return cols.join(";");
 }
 
+export function parseCsvExport(text: string): string[][] {
+  const rows: string[][] = [];
+  for (const line of text.split("\\n")) {
+    rows.push(line.split(";").map((f) => f.trim().replace(/^"|"$/g, "")));
+  }
+  return rows;
+}
`,
  repo: {
    "README.md": "# demo-app\n\n报告生成与命令行工具。\n",
    "src/export/csv.ts": `// 导出模块公共小工具
export function csvHeader(cols: string[]): string {
  return cols.join(";");
}

export function parseCsvExport(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split("\\n")) {
    rows.push(line.split(";").map((f) => f.trim().replace(/^"|"$/g, "")));
  }
  return rows;
}
`,
    "src/import/csv.ts": `// 导入侧 CSV：逗号分隔（RFC 4180），引号包裹字段由上层预处理，此处只做规整
export function parseCsvImport(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split("\\n")) {
    rows.push(line.split(",").map((f) => f.trim().replace(/^"|"$/g, "")));
  }
  return rows;
}
`,
    "src/export/xlsx.ts": `// xlsx 导出走二进制模板，不经 CSV 拼接
export const XLSX_TEMPLATE_VERSION = 3;
`,
  },
  expect: [],
  expectClean: true,
} satisfies EvalCase;
