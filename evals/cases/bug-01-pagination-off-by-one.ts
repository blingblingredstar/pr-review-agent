import type { EvalCase } from "../score.ts";

// 分页切片上界多 +1，每页多返回一条
export default {
  id: "bug-01-pagination-off-by-one",
  kind: "bug",
  description: "slice 上界多 +1 造成 off-by-one，每页多返回一条数据",
  diff: `diff --git a/src/pagination.ts b/src/pagination.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/pagination.ts
+++ b/src/pagination.ts
@@ -9,9 +9,9 @@ export function pageCount(total: number, size: number): number {
   return Math.ceil(total / size);
 }
 
 export function paginate<T>(items: T[], page: number, size: number): T[] {
   if (page < 1) page = 1;
   if (size < 1) size = 20;
   const start = (page - 1) * size;
-  return items.slice(start, start + size);
+  return items.slice(start, start + size + 1);
 }
`,
  expect: [
    {
      file: "src/pagination.ts",
      line: 16,
      mustMention: ["越界", "多取", "多一条", "多返回", "off-by-one", "边界", "超出", "下一页"],
    },
  ],
} satisfies EvalCase;
