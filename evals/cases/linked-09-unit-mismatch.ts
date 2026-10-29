import type { EvalCase } from "../score.ts";

// ttlSeconds 是秒，Date.now() 是毫秒；isExpired 的毫秒比较在上下文可见
export default {
  id: "linked-09-unit-mismatch",
  kind: "linked",
  source: "synthetic",
  description: "秒与毫秒单位混用，缓存提前过期约 1000 倍",
  diff: `diff --git a/src/cache.ts b/src/cache.ts
index 1e2f3a4..5a6b7c8 100644
--- a/src/cache.ts
+++ b/src/cache.ts
@@ -10,10 +10,11 @@ interface Entry {
 export function set(key: string, value: string, ttlSeconds: number): void {
   store.set(key, {
     value,
+    expiresAt: Date.now() + ttlSeconds,
     createdAt: Date.now(),
   });
 }
 
 export function isExpired(e: Entry): boolean {
   return Date.now() > e.expiresAt;
 }
`,
  expect: [
    {
      file: "src/cache.ts",
      line: 13,
      mustMention: ["毫秒", "秒", "单位", "1000", "ttl", "date.now", "不一致", "换算"],
    },
  ],
} satisfies EvalCase;
