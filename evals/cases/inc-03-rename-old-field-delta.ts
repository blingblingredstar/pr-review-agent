import type { EvalCase } from "../score.ts";

// 增量 mock 组（D032 开放问题②量化）：C 行（语义组合无引用，盲区本体）：push1 把 User.id 改名 userId（旧读者全更新，干净），push2 在 summary.ts 新增读取旧字段 user.id 的格式化——delta 下 hunk 自身完全正常，只有快照搜索（旧字段无写入方）能救援
// delta 口径 = S1→S2（base..head，只含 push2，增量审查输入）；repo 快照恒为 head 态（生产 zipball 同口径）
export default {
  id: "inc-03-rename-old-field-delta",
  kind: "bug",
  source: "incremental",
  description: "增量对照 delta：C 行（语义组合无引用，盲区本体）",
  diff: `diff --git a/src/summary.ts b/src/summary.ts
--- a/src/summary.ts
+++ b/src/summary.ts
@@ -1,3 +1,3 @@
-export function lineCount(lines: string[]): number {
-  return lines.length
+export function userLine(user: { id: string; email: string }): string {
+  return \`#\${user.id} <\${user.email}>\`
 }`,
    expect: [
    {
      "file": "src/summary.ts",
      "line": 2,
      "mustMention": [
        "不存在", "已改", "旧字段", "改名", "重命名", "undefined", "残留"
      ]
    }
  ],
  repo: {
    "src/store.ts": "export interface User {\n  userId: string\n  email: string\n}\n\nexport function makeUser(raw: { id: string; email: string }): User {\n  return { userId: raw.id, email: raw.email }\n}\n\nexport function greeting(u: User): string {\n  return `hello ${u.userId}`\n}\n",
    "src/summary.ts": "export function userLine(user: { id: string; email: string }): string {\n  return `#${user.id} <${user.email}>`\n}\n",
    "src/export.ts": "import { makeUser } from './store'\n\nexport function toCsv(raw: { id: string; email: string }): string {\n  const u = makeUser(raw)\n  return `${u.userId},${u.email}`\n}\n",
    "src/format-draft.ts": "export function draftLine(seq: number, email: string): string {\n  return `${seq} ${email}`\n}\n"
  },
} satisfies EvalCase;
