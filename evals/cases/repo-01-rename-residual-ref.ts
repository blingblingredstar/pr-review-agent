import type { EvalCase } from "../score.ts";

// D031 repo fixture：导出函数改名 slugify → slugifyText，未触及文件 src/render/summary.ts 仍调旧名。
// 证据指向 diff 外（summary.ts），期望意见锚在 diff 内的改名行。诱饵：src/utils/slug-legacy.ts
// （路径像答案，内容无 slugify 符号，靠搜索才能定位真答案——防路径名泄底）。
// repo = head 快照：触及文件为改后内容，答案文件不在 diff 中
export default {
  id: "repo-01-rename-residual-ref",
  kind: "linked",
  source: "repo",
  description: "导出函数改名，未触及文件仍用旧名调用（第三层盲区：搜索残留引用）",
  diff: `diff --git a/src/utils/slug.ts b/src/utils/slug.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/utils/slug.ts
+++ b/src/utils/slug.ts
@@ -1,6 +1,6 @@
-export function slugify(text: string): string {
+export function slugifyText(text: string): string {
   return text
     .trim()
     .toLowerCase()
     .replace(/[^a-z0-9]+/g, "-");
 }
`,
  repo: {
    "README.md": "# demo-app\n\n报告生成与命令行工具。\n",
    "src/utils/slug.ts": `export function slugifyText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}
`,
    "src/utils/slug-legacy.ts": `// 旧版 slug 工具，仅保留 toKebab 供报表脚本使用；新代码请用 utils/slug.ts
export function toKebab(text: string): string {
  return text.toLowerCase().replace(/\\s+/g, "-");
}
`,
    "src/render/summary.ts": `import { slugify } from "../utils/slug.ts";

export function renderSummary(title: string): string {
  return \`## \${slugify(title)}\`;
}
`,
  },
  expect: [
    {
      file: "src/utils/slug.ts",
      line: 1,
      mustMention: ["summary.ts"],
    },
  ],
} satisfies EvalCase;
