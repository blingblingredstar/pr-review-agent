import type { EvalCase } from "../score.ts";

// D031 FP 对照（expectClean）：完整重命名——verifyToken → assertToken 的全部引用都在 diff 内同步更新，
// 仓库无残留。搜旧符号应「无匹配」，期望零意见。诱饵：src/auth/legacy.ts、src/api/gateway.ts
// （路径像潜在引用方，内容均无旧符号——考「搜完确认无残留就闭嘴」的 precision）
export default {
  id: "repo-05-clean-complete-rename",
  kind: "linked",
  source: "repo",
  description: "FP 对照：完整重命名，diff 内同步全部引用，仓库无残留（期望零意见）",
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
} satisfies EvalCase;
