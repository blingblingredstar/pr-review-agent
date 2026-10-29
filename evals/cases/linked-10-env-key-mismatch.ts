import type { EvalCase } from "../score.ts";

// .env.example 本 PR 新增 RETRY_DELAY_MS，backoff.ts 读的键却是 RETRY_DELAY
export default {
  id: "linked-10-env-key-mismatch",
  kind: "linked",
  source: "synthetic",
  description: "环境变量键名不一致，代码读到的永远是 undefined",
  diff: `diff --git a/.env.example b/.env.example
index 2f3a4b5..6b7c8d9 100644
--- a/.env.example
+++ b/.env.example
@@ -1,4 +1,5 @@
 LLM_BASE_URL=
 LLM_API_KEY=
 LLM_MODEL=
 GITHUB_TOKEN=
+RETRY_DELAY_MS=
diff --git a/src/backoff.ts b/src/backoff.ts
index 3a4b5c6..7c8d9e0 100644
--- a/src/backoff.ts
+++ b/src/backoff.ts
@@ -1,3 +1,7 @@
+import { parseEnvNumber } from "./env.ts";
+
+const RETRY_DELAY = parseEnvNumber("RETRY_DELAY");
+
 export function delay(attempt: number): number {
   return RETRY_DELAY * 2 ** attempt;
 }
`,
  expect: [
    {
      file: ["src/backoff.ts", ".env.example"],
      line: null,
      mustMention: ["retry_delay", "env", "环境变量", "键名", "不一致", "拼写", ".env"],
    },
  ],
} satisfies EvalCase;
