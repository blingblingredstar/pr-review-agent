import type { EvalCase } from "../score.ts";

// WebhookPayload 加了两个必填字段，构造处只补了 sender，漏 installationId
export default {
  id: "linked-02-required-field-missed",
  kind: "linked",
  source: "synthetic",
  description: "类型新增必填字段，构造处只同步了其中一个（TS 编译失败）",
  diff: `diff --git a/src/types.ts b/src/types.ts
index 7b8c9d0..1d2e3f4 100644
--- a/src/types.ts
+++ b/src/types.ts
@@ -6,5 +6,7 @@ export interface WebhookPayload {
   action: string;
   repo: string;
+  sender: string;
+  installationId: number;
   receivedAt: string;
 }
 
diff --git a/src/dispatch.ts b/src/dispatch.ts
index 8c9d0e1..2e3f4a5 100644
--- a/src/dispatch.ts
+++ b/src/dispatch.ts
@@ -18,6 +18,7 @@ export function toPayload(body: Record<string, unknown>): WebhookPayload {
   return {
     action: String(body.action),
     repo: String(body.repository),
+    sender: String(body.sender?.login ?? ""),
     receivedAt: new Date().toISOString(),
   };
 }
`,
  expect: [
    {
      file: "src/dispatch.ts",
      line: null,
      mustMention: ["installationid", "必填", "缺失", "漏", "没传", "未提供", "缺字段", "未设置"],
    },
  ],
} satisfies EvalCase;
