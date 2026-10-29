import type { EvalCase } from "../score.ts";

// 来源 fastify#7068（fix diff 反构）：删除 set-cookie 数组的拷贝分支后，外部数组引用会被后续 push 污染
export default {
  id: "real-01-fastify-setcookie",
  kind: "bug",
  source: "real",
  description: "来源 fastify#7068（fix diff 反构）",
  diff: `diff --git a/lib/reply.js b/lib/reply.js
index 412ffc081fc..32182f55eb6 100644
--- a/lib/reply.js
+++ b/lib/reply.js
@@ -284,10 +284,6 @@ Reply.prototype.header = function (key, value = '') {
     } else {
       this[kReplyHeaders][key].push(value)
     }
-  } else if (key === 'set-cookie' && Array.isArray(value)) {
-    // Copy the array: later calls push into the stored one, and the caller's
-    // array (often a module-level constant) must not grow across requests.
-    this[kReplyHeaders][key] = value.slice()
   } else {
     this[kReplyHeaders][key] = value
   }`,
  expect: [
    {
      "file": "lib/reply.js",
      "line": 286,
      "mustMention": [
        "引用",
        "拷贝",
        "slice",
        "污染",
        "可变",
        "外部",
        "跨请求",
        "push",
        "共享",
        "mutation"
      ]
    }
  ],
} satisfies EvalCase;
