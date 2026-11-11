import type { EvalCase } from "../score.ts";

// 同一 PR 把 MAX_RETRIES 从 3 提到 5，新增的 ingestWithRetry 却硬编码 3
// #139（2026-11-11）diff 清理：重试耗尽改为 rethrow——旧版 catch 静默吞异常是 diff 里的第二个
// 真缺陷（模型 11-10 轮正确报出反记 FP），违反「写用例时保持 diff 干净」纪律；预期缺陷不变
export default {
  id: "linked-04-duplicated-constant",
  kind: "linked",
  source: "synthetic",
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
@@ -20,4 +20,12 @@ export async function ingest(events: string[]): Promise<void> {
   for (const event of events) {
     await queue.push(event);
   }
 }
+
+export async function ingestWithRetry(events: string[]): Promise<void> {
+  let lastError: unknown;
+  for (let attempt = 1; attempt <= 3; attempt++) {
+    try { await ingest(events); return; } catch (e) { lastError = e; }
+  }
+  throw lastError;
+}
`,
  expect: [
    {
      file: "src/ingest.ts",
      line: 27, // #143 首轮意见：lastError 行插入后硬编码 3 从新侧 26 移到 27，期望行号同步（不靠 ±3 容差吃偏移）
      mustMention: ["硬编码", "常量", "不一致", "同步", "magic"],
    },
  ],
} satisfies EvalCase;
