import type { EvalCase } from "../score.ts";

// cache.invalidate 本次改成 async，session.ts 新增的调用没有 await
export default {
  id: "bug-04-missing-await",
  kind: "bug",
  source: "synthetic",
  description: "invalidate 改为 async 后调用方未 await，缓存清理与后续日志竞态",
  diff: `diff --git a/src/cache.ts b/src/cache.ts
index 5b6c7d8..9c0d1e2 100644
--- a/src/cache.ts
+++ b/src/cache.ts
@@ -8,7 +8,8 @@ export const cache = {
   get(key: string): string | null {
     return store.get(key) ?? null;
   },
-  invalidate(key: string): void {
+  async invalidate(key: string): Promise<void> {
     store.delete(key);
+    await persist();
   },
 };
diff --git a/src/session.ts b/src/session.ts
index 6c7d8e9..0d1e2f3 100644
--- a/src/session.ts
+++ b/src/session.ts
@@ -30,5 +30,6 @@ export async function login(username: string, token: string): Promise<void> {
   const user = await verifyToken(token);
   await audit.log("login:start", user.id);
   await sessions.create(user.id);
+  cache.invalidate(user.id);
   await audit.log("login:done", user.id);
 }
`,
  expect: [
    {
      file: "src/session.ts",
      line: 33,
      mustMention: ["await", "异步", "Promise", "未等待", "不等待", "fire-and-forget", "竞态"],
    },
  ],
} satisfies EvalCase;
