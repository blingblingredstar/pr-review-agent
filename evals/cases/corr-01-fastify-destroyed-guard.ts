import type { EvalCase } from "../score.ts";

// 真实配对 fastify#4963（引入 commit c235d2dc，2023-08-09）→ #5008（修复 = revert + 回归测试，2023-08-31）。
// 缺陷：wrapThenable 的发送 guard 追加 request.raw.destroyed === false，把「请求体已消费完（destroyed）」的正常
// POST 误判为客户端断连——async handler 返回 undefined（空响应）时 reply.send 不执行，请求挂起（#5008 回归测试
// 名为 post empty body；#5008 标题：fix: post async regression with empty body）。
// 为何 diff 单看无害：条件只是「更严格地」跳过已断连的请求，新增注释还解释了 destroyed/aborted 的竞态，合情合理；
// 缺陷证据在关联位置——guard 把请求侧的消费状态与响应侧的发送决策耦合进同一个条件，payload undefined 的路径
// 恰好完全依赖该 guard 的后半段放行。
export default {
  id: "corr-01-fastify-destroyed-guard",
  kind: "bug",
  source: "correlation",
  description: "真实配对 fastify#4963（引入）→ #5008（revert 修复）：destroyed guard 误伤空响应 async handler",
  diff: `diff --git a/lib/wrapThenable.js b/lib/wrapThenable.js
index b746a62e920..0d4e7ba812f 100644
--- a/lib/wrapThenable.js
+++ b/lib/wrapThenable.js
@@ -18,7 +18,10 @@ function wrapThenable (thenable, reply) {
     // the request may be terminated during the reply. in this situation,
     // it require an extra checking of request.aborted to see whether
     // the request is killed by client.
-    if (payload !== undefined || (reply.sent === false && reply.raw.headersSent === false && reply.request.raw.aborted === false)) {
+    // Most of the times aborted will be true when destroyed is true,
+    // however there is a race condition where the request is not
+    // aborted but only destroyed.
+    if (payload !== undefined || (reply.sent === false && reply.raw.headersSent === false && reply.request.raw.aborted === false && reply.request.raw.destroyed === false)) {
       // we use a try-catch internally to avoid adding a catch to another
       // promise, increase promise perf by 10%
       try {`,
  expect: [
    {
      "file": "lib/wrapThenable.js",
      "line": 24,
      "mustMention": [
        "挂起",
        "hang",
        "空响应",
        "empty",
        "不发送",
        "无法响应",
        "无响应",
        "消费",
        "consumed",
        "误判"
      ]
    }
  ],
} satisfies EvalCase;
