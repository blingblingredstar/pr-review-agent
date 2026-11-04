import type { EvalCase } from "../score.ts";

// 来源 express#4893（fix commit 18e5985b 反构）：res.send 无条件设 Content-Length，与已存在的 Transfer-Encoding 头共存违反 HTTP 协议
export default {
  id: "real-09-express-cl-conflict",
  kind: "bug",
  source: "real",
  description: "来源 express#4893（fix commit 18e5985b 反构）",
  diff: `diff --git a/lib/response.js b/lib/response.js
index 59e205a57a0..18e5985b8a9 100644
--- a/lib/response.js
+++ b/lib/response.js
@@ -162,10 +162,9 @@ res.send = function send(body) {
   var etagFn = app.get('etag fn')
   var generateETag = !this.get('ETag') && typeof etagFn === 'function'
 
+  // populate Content-Length
+  var len
+  if (chunk !== undefined) {
-  // Because Content-Length and Transfer-Encoding can't be present in the response headers together,
-  // Content-Length should be added only if there is no Transfer-Encoding header
-  var len;
-  if (chunk !== undefined && !this.get('Transfer-Encoding')) {
     if (Buffer.isBuffer(chunk)) {
       // get length of Buffer
       len = chunk.length`,
  expect: [
    {
      "file": "lib/response.js",
      "line": 167,
      "mustMention": [
        "共存", "同时", "互斥", "冲突", "违规", "协议", "非法", "spec", "rfc"
      ]
    }
  ],
} satisfies EvalCase;
