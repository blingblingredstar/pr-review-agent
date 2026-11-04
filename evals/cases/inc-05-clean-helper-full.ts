import type { EvalCase } from "../score.ts";

// 增量 mock 组（D032 开放问题②量化）：FP 对照（expectClean）：push1 加 logInfo 助手、push2 正确使用，无任何缺陷——两口径都期望零意见（只进 precision 分母）
// full 口径 = S0→S2（merge-base..head，全量审查输入）；repo 快照恒为 head 态（生产 zipball 同口径）
export default {
  id: "inc-05-clean-helper-full",
  kind: "bug",
  source: "incremental",
  description: "增量对照 full：FP 对照（expectClean）",
  diff: `diff --git a/src/logger.ts b/src/logger.ts
--- a/src/logger.ts
+++ b/src/logger.ts
@@ -1 +1,5 @@
 export const PREFIX = '[app]'
+
+export function logInfo(msg: string): void {
+  console.log(\`\${PREFIX} \${msg}\`)
+}
diff --git a/src/api.ts b/src/api.ts
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,3 +1,6 @@
-export function healthPath(): string {
-  return '/healthz'
+import { logInfo } from './logger'
+
+export function handleHealth(): string {
+  logInfo('health check')
+  return 'ok'
 }`,
    expect: [],
  expectClean: true,
  repo: {
    "src/logger.ts": "export const PREFIX = '[app]'\n\nexport function logInfo(msg: string): void {\n  console.log(`${PREFIX} ${msg}`)\n}\n",
    "src/api.ts": "import { logInfo } from './logger'\n\nexport function handleHealth(): string {\n  logInfo('health check')\n  return 'ok'\n}\n",
    "src/metrics.ts": "export function counter(name: string): string {\n  return `${name}_total`\n}\n",
    "src/tracing.ts": "export const TRACE_HEADER = 'x-trace-id'\n"
  },
} satisfies EvalCase;
