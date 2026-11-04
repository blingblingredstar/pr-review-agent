import type { EvalCase } from "../score.ts";

// 增量 mock 组（D032 开放问题②量化）：B 行（跨文件显式引用）：push1 在 format.ts 新增 formatSize（入参 KB），push2 在 report.ts 把字节数直接传给它——delta 下 hunk 引用可见但契约不可见，靠 read_file/format.ts 快照兜底（工具循环可救援性）
// full 口径 = S0→S2（merge-base..head，全量审查输入）；repo 快照恒为 head 态（生产 zipball 同口径）
export default {
  id: "inc-02-contract-units-full",
  kind: "bug",
  source: "incremental",
  description: "增量对照 full：B 行（跨文件显式引用）",
  diff: `diff --git a/src/format.ts b/src/format.ts
--- a/src/format.ts
+++ b/src/format.ts
@@ -1,3 +1,8 @@
 export function pad(n: number): string {
   return String(n).padStart(2, '0')
 }
+
+// input value is in KB, not bytes
+export function formatSize(kb: number): string {
+  return \`\${kb.toFixed(1)} KB\`
+}
diff --git a/src/report.ts b/src/report.ts
--- a/src/report.ts
+++ b/src/report.ts
@@ -1,3 +1,5 @@
-export function renderRow(name: string, size: number): string {
-  return \`\${name}: \${size}\`
+import { formatSize } from './format'
+
+export function renderRow(name: string, bytes: number): string {
+  return \`\${name}: \${formatSize(bytes)}\`
 }`,
    expect: [
    {
      "file": "src/report.ts",
      "line": 4,
      "mustMention": [
        "单位", "字节", "千字节", "换算", "1024", "错配", "口径"
      ]
    }
  ],
  repo: {
    "src/format.ts": "export function pad(n: number): string {\n  return String(n).padStart(2, '0')\n}\n\n// input value is in KB, not bytes\nexport function formatSize(kb: number): string {\n  return `${kb.toFixed(1)} KB`\n}\n",
    "src/report.ts": "import { formatSize } from './format'\n\nexport function renderRow(name: string, bytes: number): string {\n  return `${name}: ${formatSize(bytes)}`\n}\n",
    "src/duration.ts": "export function formatDuration(sec: number): string {\n  return `${sec}s`\n}\n",
    "src/view.ts": "export function badge(label: string): string {\n  return `[${label}]`\n}\n"
  },
} satisfies EvalCase;
