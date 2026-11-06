import type { EvalCase } from "../score.ts";

// ctxpair 双联组（#80，合成包 catalog-sync）：1 条 structural（diff 内可发现）+ 1 条 convention（约定在 diff 外非触及文件）
// structural：exportChunks 循环上界 i <= rows.length——行数为页宽整数倍（或 0）时最后一轮推入空块（off-by-one）
// convention：新增导出常量 defaultPageSize 用小驼峰——违反 CONTRIBUTING.md（非触及文件）的
//   「模块级导出常量一律 SCREAMING_SNAKE_CASE」约定；无约定上下文时 diff-only 结构性看不出违规
// 防循环性核对（#80 闸门 3，逐条）：convention 条目 mustMention「大写 / 全大写 / DEFAULT_PAGE_SIZE / 应改为 / 不符」
//   均不在 CONTRIBUTING.md 逐字出现（文档用「SCREAMING_SNAKE_CASE」「小驼峰」「参照 src/catalog/limits.ts」表述）；测试有机械弱断言同查
// 诱饵：src/catalog/importer.ts（同为 catalog 数据面模块，与命名违规无关）；镜证：src/catalog/limits.ts 全大写常量（既有代码佐证约定）
export default {
  id: "ctx-03-const-naming-catalog",
  kind: "linked",
  source: "ctxpair",
  description: "常量命名约定被新导出绕过（SCREAMING_SNAKE_CASE，diff-only 不可见）+ 分块循环多跑一轮产出空块",
  diff: `diff --git a/src/catalog/exporter.ts b/src/catalog/exporter.ts
index 5e6f7a8..9b0c1d2 100644
--- a/src/catalog/exporter.ts
+++ b/src/catalog/exporter.ts
@@ -7,3 +7,13 @@
 export function toTsv(rows: CatalogRow[]): string {
   return rows.map((r) => [r.sku, r.title].join("\\t")).join("\\n");
 }
+
+export const defaultPageSize = 50;
+
+export function exportChunks(rows: CatalogRow[]): CatalogRow[][] {
+  const chunks: CatalogRow[][] = [];
+  for (let i = 0; i <= rows.length; i += defaultPageSize) {
+    chunks.push(rows.slice(i, i + defaultPageSize));
+  }
+  return chunks;
+}
`,
  repo: {
    "CONTRIBUTING.md": `# catalog-sync 贡献须知

模块级导出常量一律 SCREAMING_SNAKE_CASE（参照 src/catalog/limits.ts），新代码不得再引入小驼峰形式的常量名。
`,
    "src/catalog/limits.ts": `// 数值上限集中管理（常量命名以此为准）
export const MAX_IMPORT_ROWS = 5_000;
export const EXPORT_HARD_CAP = 50_000;
`,
    "src/catalog/importer.ts": `// 行解析（与本 PR 无关）
export function parseRow(line: string): string[] {
  return line.split("\\t");
}
`,
    "src/catalog/exporter.ts": `// 目录导出（切分后交给下游）
export type CatalogRow = {
  sku: string;
  title: string;
};

export function toTsv(rows: CatalogRow[]): string {
  return rows.map((r) => [r.sku, r.title].join("\\t")).join("\\n");
}

export const defaultPageSize = 50;

export function exportChunks(rows: CatalogRow[]): CatalogRow[][] {
  const chunks: CatalogRow[][] = [];
  for (let i = 0; i <= rows.length; i += defaultPageSize) {
    chunks.push(rows.slice(i, i + defaultPageSize));
  }
  return chunks;
}
`,
  },
  expect: [
    {
      file: "src/catalog/exporter.ts",
      line: 15,
      mustMention: ["空", "多一", "末尾", "越界"],
      kind: "structural",
    },
    {
      file: "src/catalog/exporter.ts",
      line: 11,
      mustMention: ["大写", "全大写", "DEFAULT_PAGE_SIZE", "应改为", "不符"],
      kind: "convention",
    },
  ],
} satisfies EvalCase;
