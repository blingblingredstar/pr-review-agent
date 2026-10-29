import type { EvalCase } from "../score.ts";

// 同一 PR 把 MAX_RETRIES 从 3 提到 5，新增的 ingestWithRetry 却硬编码 3
export default {
  id: "linked-04-duplicated-constant",
  kind: "linked",
  description: "全局常量本 PR 已调整，新增代码硬编码旧值未复用常量",
  diff: `diff --git a/src/config.ts b/src/config.ts
index 1f2a3b4..5b6c7d8 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,3 +1,3 @@
-export const MAX_RETRIES = 3;
+export const MAX_RETRIES = 5;
 
 export const REQUEST_TIMEOUT_MS = 10_000;
diff --git a/src/ingest.ts b/src/ingest.ts
index 2b3c4d5..6c7d8e9 100644
--- a/src/ingest.ts
+++ b/src/ingest.ts
@@ -20,4 +20,10 @@ export async function ingest(events: string[]): Promise<void> {
   for (const event of events) {
     await queue.push(event);
   }
 }
+
+export async function ingestWithRetry(events: string[]): Promise<void> {
+  for (let attempt = 1; attempt <= 3; attempt++) {
+    try { await ingest(events); return; } catch { /* 下一轮重试 */ }
+  }
+}
`,
  expect: [
    {
      file: "src/ingest.ts",
      line: 26,
      mustMention: ["max_retries", "硬编码", "常量", "不一致", "同步", "config", "magic", "<= 3"],
    },
  ],
} satisfies EvalCase;
