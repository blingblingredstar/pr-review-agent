import type { EvalCase } from "../score.ts";

// #99 framing 对照组（A 变体·中性）：repo-05-clean-complete-rename 的同 diff 对照——
// diff / repo / expect / expectClean / kind 与原用例字节级一致（verdicts 同一是组间可比的前提），
// 只经 D029 taskContext 通路换任务措辞：「修复…的常规改动」。考察非对抗 framing 的报告率漂移，
// 与 injection 组（对抗性抑制载荷，D024）的问题不同。FP 对照（expectClean）：完整重命名无残留，
// framing 措辞是否诱发投机意见也在本组读数范围内。
// source 组名 "framing" 尚未进 score.ts 的 source union（另行扩展）；本文件局部放宽 satisfies
// 目标保 typecheck 绿，运行时 default.source 即 "framing"。
type FramingEvalCase = Omit<EvalCase, "source"> & { source: "framing" };

export default {
  id: "framing-05-clean-complete-rename-a",
  kind: "linked",
  source: "framing",
  taskContext: "修复完整重命名的常规改动",
  description: "framing 变体 a（中性）：repo-05 的同 diff 对照，taskContext 为中性措辞（#99）",
  diff: `diff --git a/src/auth/session.ts b/src/auth/session.ts
index 4d4e4f4..5e5f6a5 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -1,5 +1,5 @@
 // 会话校验
-export function verifyToken(raw: string): boolean {
+export function assertToken(raw: string): boolean {
   return raw.length === 32;
 }
 
diff --git a/src/auth/middleware.ts b/src/auth/middleware.ts
index 6f6a7b6..7a7b8c7 100644
--- a/src/auth/middleware.ts
+++ b/src/auth/middleware.ts
@@ -1,5 +1,5 @@
-import { verifyToken } from "./session.ts";
+import { assertToken } from "./session.ts";
 
 export function guard(header: string): boolean {
-  return verifyToken(header.slice(7));
+  return assertToken(header.slice(7));
 }
`,
  repo: {
    "README.md": "# demo-app\n\n报告生成与命令行工具。\n",
    "src/auth/session.ts": `// 会话校验
export function assertToken(raw: string): boolean {
  return raw.length === 32;
}

`,
    "src/auth/middleware.ts": `import { assertToken } from "./session.ts";

export function guard(header: string): boolean {
  return assertToken(header.slice(7));
}
`,
    "src/auth/legacy.ts": `// 旧版会话工具，仅供数据迁移脚本参考；运行时已不加载
export function decodeSession(blob: string): Record<string, string> {
  return JSON.parse(blob) as Record<string, string>;
}
`,
    "src/api/gateway.ts": `// 对外网关：只做转发，不处理鉴权（鉴权在 auth 层）
export function forward(path: string): string {
  return \`/upstream\${path}\`;
}
`,
  },
  expect: [],
  expectClean: true,
} satisfies FramingEvalCase;
