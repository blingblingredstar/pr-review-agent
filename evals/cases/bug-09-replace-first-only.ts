import type { EvalCase } from "../score.ts";

// replaceAll 改回单参 replace，只替换第一个空格
export default {
  id: "bug-09-replace-first-only",
  kind: "bug",
  description: "replaceAll 误改回 replace，只替换第一个匹配",
  diff: `diff --git a/src/sanitize.ts b/src/sanitize.ts
index 1b2c3d4..5c6d7e8 100644
--- a/src/sanitize.ts
+++ b/src/sanitize.ts
@@ -8,5 +8,5 @@ export function slugify(title: string): string {
   return title
     .toLowerCase()
     .trim()
-    .replaceAll(" ", "-");
+    .replace(" ", "-");
 }
`,
  expect: [
    {
      file: "src/sanitize.ts",
      line: 11,
      mustMention: ["第一个", "只替换", "仅替换", "replaceAll", "全局", "g 标志", "多次", "后续"],
    },
  ],
} satisfies EvalCase;
