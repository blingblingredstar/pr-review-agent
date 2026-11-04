import type { EvalCase } from "../score.ts";

// 真实配对 fastify#6810（引入 8b9c07b「clear socket._meta to prevent keep-alive leaks」）→ 修复 7f6d3198：onResFinished 把 socket._meta 置 null 释放引用，但注册了 onTimeout 的连接上 handleTimeout 稍后的 timeout 事件仍会解构 this._meta → Cannot destructure property 'context' of null 进程崩溃。为何 diff 单看无害：带所有权守卫的释放是教科书防泄漏写法；缺陷消费方（handleTimeout）不在 diff 内，「置 null 后还有谁在读」需推断——本例是有意保留的 diff × 既有代码关联形态（组内多样性）。
export default {
  id: "corr-10-fastify-meta-null",
  kind: "bug",
  source: "correlation",
  description: "真实配对 fastify#6810（引入 8b9c07b「clear socket._meta to prevent keep-alive leaks」）→ 修复 7f6d3198：onResFinished 把 socket._meta 置 null 释放引用，但注册了 onTimeout 的连接上 handleTimeout 稍后的 timeout 事件仍会解构 this._meta → Cannot destructure property 'context' of null 进程崩溃",
  diff: `diff --git a/lib/reply.js b/lib/reply.js
index 9d291485790..8b9c07b645a 100644
--- a/lib/reply.js
+++ b/lib/reply.js
@@ -961,6 +961,13 @@ function setupResponseListeners (reply) {
       }
     }
 
+    // Fix: release socket._meta so request/reply objects are not retained
+    // past the response on keep-alive connections.
+    const socket = reply.request.raw.socket
+    if (socket && socket._meta && socket._meta.request === reply.request) {
+      socket._meta = null
+    }
+
     if (ctx && ctx.onResponse !== null) {
       onResponseHookRunner(
         ctx.onResponse,`,
  expect: [
    {
      "file": "lib/reply.js",
      "line": 968,
      "mustMention": [
        "置空", "清空", "后续", "读取", "崩溃", "解构", "超时", "悬空", "仍"
      ]
    }
  ],
} satisfies EvalCase;
