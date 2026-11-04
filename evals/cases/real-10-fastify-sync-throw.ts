import type { EvalCase } from "../score.ts";

// 来源 fastify#7118（fix commit 37df44a4 反构）：自定义 content-type parser 同步 throw 未捕获，async 路径有 then 兜底而同步路径裸调用
export default {
  id: "real-10-fastify-sync-throw",
  kind: "bug",
  source: "real",
  description: "来源 fastify#7118（fix commit 37df44a4 反构）",
  diff: `diff --git a/lib/content-type-parser.js b/lib/content-type-parser.js
index 9e9f61a6bf0..37df44a4218 100644
--- a/lib/content-type-parser.js
+++ b/lib/content-type-parser.js
@@ -222,13 +222,7 @@ ContentTypeParser.prototype.run = function (contentType, handler, request, reply
     return
   }
 
+  const result = parser.fn(request, request[kRequestPayloadStream], done)
-  let result
-  try {
-    result = parser.fn(request, request[kRequestPayloadStream], done)
-  } catch (error) {
-    done(error, undefined)
-    return
-  }
   if (result && typeof result.then === 'function') {
     result.then(body => { done(null, body) }, done)
   }
@@ -323,13 +317,7 @@ function rawBody (request, reply, options, parser, done) {
       body = Buffer.concat(chunks, receivedLength)
     }
 
+    const result = parser.fn(request, body, done)
-    let result
-    try {
-      result = parser.fn(request, body, done)
-    } catch (error) {
-      done(error, undefined)
-      return
-    }
     if (result && typeof result.then === 'function') {
       result.then(body => { done(null, body) }, done)
     }`,
  expect: [
    {
      "file": "lib/content-type-parser.js",
      "line": 225,
      "mustMention": [
        "同步", "抛出", "异常", "崩溃", "未捕获", "crash", "进程"
      ]
    }
  ],
} satisfies EvalCase;
