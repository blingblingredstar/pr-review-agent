import type { EvalCase } from "../score.ts";

// 真实配对 express#4913（引入 708ac4c「Fix handling very large stacks of sync middleware」）→ 修复 7ec5dd2：guard 插在 stack[idx++] 弹层之后、sync=0 又只在成功处理路径执行——guard 触发 setImmediate 重入时已弹出的 layer 被静默跳过，单 route 中间件序列丢层（app.all 组合 404）。为何 diff 单看无害：防栈溢出的计数守卫每处单看都严谨，缺陷在「弹层先于守卫」与「重置位置」两个关联点的组合，route.js 与 index.js 同款结构并列可对照。
export default {
  id: "corr-06-express-sync-guard",
  kind: "bug",
  source: "correlation",
  description: "真实配对 express#4913（引入 708ac4c「Fix handling very large stacks of sync middleware」）→ 修复 7ec5dd2：guard 插在 stack[idx++] 弹层之后、sync=0 又只在成功处理路径执行——guard 触发 setImmediate 重入时已弹出的 layer 被静默跳过，单 route 中间件序列丢层（app.all 组合 404）",
  diff: `diff --git a/lib/router/route.js b/lib/router/route.js
index 92c5ce59f51..708ac4cdf5c 100644
--- a/lib/router/route.js
+++ b/lib/router/route.js
@@ -98,6 +98,8 @@ Route.prototype._options = function _options() {
 Route.prototype.dispatch = function dispatch(req, res, done) {
   var idx = 0;
   var stack = this.stack;
+  var sync = 0
+
   if (stack.length === 0) {
     return done();
   }
@@ -127,6 +129,11 @@ Route.prototype.dispatch = function dispatch(req, res, done) {
       return done(err);
     }
 
+    // max sync stack
+    if (++sync > 100) {
+      return setImmediate(next, err)
+    }
+
     if (layer.method && layer.method !== method) {
       return next(err);
     }
@@ -136,6 +143,8 @@ Route.prototype.dispatch = function dispatch(req, res, done) {
     } else {
       layer.handle_request(req, res, next);
     }
+
+    sync = 0
   }
 };
 
diff --git a/lib/router/index.js b/lib/router/index.js
index 92c5ce59f51..708ac4cdf5c 100644
--- a/lib/router/index.js
+++ b/lib/router/index.js
@@ -142,6 +142,7 @@ proto.handle = function handle(req, res, out) {
   var protohost = getProtohost(req.url) || ''
   var removed = '';
   var slashAdded = false;
+  var sync = 0
   var paramcalled = {};
 
   // store options for OPTIONS request
@@ -203,6 +204,11 @@ proto.handle = function handle(req, res, out) {
       return;
     }
 
+    // max sync stack
+    if (++sync > 100) {
+      return setImmediate(next, err)
+    }
+
     // get pathname of request
     var path = getPathname(req);
 
@@ -321,6 +327,8 @@ proto.handle = function handle(req, res, out) {
     } else {
       layer.handle_request(req, res, next);
     }
+
+    sync = 0
   }
 };
 `,
  expect: [
    {
      "file": "lib/router/route.js",
      "line": 133,
      "mustMention": [
        "跳过", "丢失", "漏掉", "静默", "中间件", "顺序", "重置", "计数", "丢层"
      ]
    }
  ],
} satisfies EvalCase;
