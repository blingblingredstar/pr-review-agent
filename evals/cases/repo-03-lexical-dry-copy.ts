import type { EvalCase } from "../score.ts";

// D031 repo fixture：diff 新增的 formatBytes 与未触及文件 src/shared/format.ts 的 formatFileSize
// 词法级重复（复制粘贴级 DRY）。靠搜索新代码中的独特字面量（units 数组、1024 循环）才能找到既有实现。
// 期望意见锚在 diff 内新增代码行，mustMention 指向 diff 外的既有实现（路径或符号名）。
// 诱饵：src/shared/units.ts（shared 下像工具文件，内容与字号格式化无关）
export default {
  id: "repo-03-lexical-dry-copy",
  kind: "linked",
  source: "repo",
  description: "新增实现与 diff 外既有 util 词法重复（词法 DRY：搜既有词法相似）",
  diff: `diff --git a/src/api/size.ts b/src/api/size.ts
index 0a0b0c0..1b1c1d1 100644
--- a/src/api/size.ts
+++ b/src/api/size.ts
@@ -4,3 +4,11 @@
   return JSON.stringify(r).length;
 }
 
+export function formatBytes(n: number): string {
+  if (n < 1024) return \`\${n} B\`;
+  const units = ["KB", "MB", "GB", "TB"];
+  let value = n;
+  let unit = 0;
+  for (; value >= 1024 && unit < units.length - 1; unit++) value /= 1024;
+  return \`\${value.toFixed(1)} \${units[unit]}\`;
+}
`,
  repo: {
    "README.md": "# demo-app\n\n报告生成与命令行工具。\n",
    "src/api/types.ts": `export type ApiReply = { ok: boolean; body: string };
`,
    "src/api/size.ts": `import type { ApiReply } from "./types.ts";

export function replySize(r: ApiReply): number {
  return JSON.stringify(r).length;
}

export function formatBytes(n: number): string {
  if (n < 1024) return \`\${n} B\`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  for (; value >= 1024 && unit < units.length - 1; unit++) value /= 1024;
  return \`\${value.toFixed(1)} \${units[unit]}\`;
}
`,
    "src/shared/format.ts": `// 通用人类可读字号格式化（报表与日志共用）
export function formatFileSize(n: number): string {
  if (n < 1024) return \`\${n} B\`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  for (; value >= 1024 && unit < units.length - 1; unit++) value /= 1024;
  return \`\${value.toFixed(1)} \${units[unit]}\`;
}
`,
    "src/shared/units.ts": `// CSS 单位换算（rem/px），与文件字号格式化无关
export const REM_PX = 16;
`,
  },
  expect: [
    {
      file: "src/api/size.ts",
      line: 7,
      mustMention: ["format.ts", "formatFileSize"],
    },
  ],
} satisfies EvalCase;
