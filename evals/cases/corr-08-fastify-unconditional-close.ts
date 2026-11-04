import type { EvalCase } from "../score.ts";

// 真实配对 fastify#4876（引入 3a52ca6「Do not leak memory if .listen() is not called」）→ 修复 5814956：server.close(done) 从 listening 守卫中上提为无条件调用，serverFactory 场景（从未真正 listen）close 回调语义破坏，Platformatic 关闭流程大回归。为何 diff 单看无害：注释写着「不 close 会泄漏内存」且引用 node core issue，上提的 close 与下方残留的 listening 条件块并列可见——缺陷在「未 listen 的 server 上 close(done) 是否回调」的语义推演。
export default {
  id: "corr-08-fastify-unconditional-close",
  kind: "bug",
  source: "correlation",
  description: "真实配对 fastify#4876（引入 3a52ca6「Do not leak memory if .listen() is not called」）→ 修复 5814956：server.close(done) 从 listening 守卫中上提为无条件调用，serverFactory 场景（从未真正 listen）close 回调语义破坏，Platformatic 关闭流程大回归",
  diff: `diff --git a/fastify.js b/fastify.js
index 6c3e37cab2e..3a52ca662a8 100644
--- a/fastify.js
+++ b/fastify.js
@@ -426,10 +426,13 @@ function fastify (options) {
       router.closeRoutes()
 
       hookRunnerApplication('preClose', fastify[kAvvioBoot], fastify, function () {
-        if (fastify[kState].listening) {
-          // No new TCP connections are accepted
-          instance.server.close(done)
+        // No new TCP connections are accepted.
+        // We must call close on the server even if we are not listening
+        // otherwise memory will be leaked.
+        // https://github.com/nodejs/node/issues/48604
+        instance.server.close(done)
 
+        if (fastify[kState].listening) {
           /* istanbul ignore next: Cannot test this without Node.js core support */
           if (forceCloseConnections === 'idle') {
             // Not needed in Node 19`,
  expect: [
    {
      "file": "fastify.js",
      "line": 433,
      "mustMention": [
        "未监听", "回调", "语义", "serverfactory", "挂起", "不触发", "阻塞", "场景"
      ]
    }
  ],
} satisfies EvalCase;
