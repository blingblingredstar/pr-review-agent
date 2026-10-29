import type { EvalCase } from "../score.ts";

// legacy.ts 删除了 legacySlug 导出，archive.ts 的 import 与调用还在（import 行在上下文可见）
export default {
  id: "linked-03-removed-export-still-used",
  kind: "linked",
  source: "synthetic",
  description: "删除导出函数，另一文件的 import 与调用未清理",
  diff: `diff --git a/src/legacy.ts b/src/legacy.ts
index 9d0e1f2..3f4a5b6 100644
--- a/src/legacy.ts
+++ b/src/legacy.ts
@@ -1,7 +1,3 @@
-export function legacySlug(text: string): string {
-  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
-}
-
 export function currentSlug(text: string): string {
   return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
 }
diff --git a/src/routes/archive.ts b/src/routes/archive.ts
index 0e1f2a3..4a5b6c7 100644
--- a/src/routes/archive.ts
+++ b/src/routes/archive.ts
@@ -1,9 +1,9 @@
 import { legacySlug } from "../legacy.ts";
 
 export function archivePath(title: string, year: number): string {
   return \`/archive/\${year}/\${legacySlug(title)}\`;
 }
 
 export function archiveYearly(title: string, year: number): string {
-  return \`/archive/yearly/\${legacySlug(title)}\`;
+  return \`/archive/\${year}/yearly/\${legacySlug(title)}\`;
 }
`,
  expect: [
    {
      file: ["src/routes/archive.ts", "src/legacy.ts"],
      line: null,
      mustMention: ["legacyslug", "删除", "删掉", "仍", "还在", "引用", "残留", "import", "不存在"],
    },
  ],
} satisfies EvalCase;
