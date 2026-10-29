import type { EvalCase } from "../score.ts";

// sms.ts 本次把 send 改为返回 { ok, status }，notify.ts 新增的 sms 分支却没检查返回值；email 分支有对照
export default {
  id: "linked-07-error-handling-asymmetry",
  kind: "linked",
  source: "synthetic",
  description: "新分支未检查 send 返回的 ok，与 email 分支的错误处理不对称",
  diff: `diff --git a/src/sms.ts b/src/sms.ts
index 8b9c0d1..2d3e4f5 100644
--- a/src/sms.ts
+++ b/src/sms.ts
@@ -1,5 +1,6 @@
 export const smsClient = {
-  async send(userId: string, text: string): Promise<void> {
+  async send(userId: string, text: string): Promise<{ ok: boolean; status: number }> {
     const res = await post("/sms", { userId, text });
+    return { ok: res.status === 200, status: res.status };
   },
 };
diff --git a/src/notify.ts b/src/notify.ts
index 7a8b9c0..1c2d3e4 100644
--- a/src/notify.ts
+++ b/src/notify.ts
@@ -20,10 +20,11 @@ export async function notifyUser(userId: string, channel: string, message: string): Promise<void
   if (channel === "email") {
     const res = await mailer.send(userId, message);
     if (!res.ok) {
       throw new Error(\`mail failed: \${res.status}\`);
     }
   } else if (channel === "sms") {
+    await smsClient.send(userId, message);
   } else {
     throw new Error(\`unknown channel: \${channel}\`);
   }
 }
`,
  expect: [
    {
      file: "src/notify.ts",
      line: 26,
      mustMention: ["ok", "错误", "检查", "抛", "throw", "不对称", "失败", "吞"],
    },
  ],
} satisfies EvalCase;
