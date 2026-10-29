import type { EvalCase } from "../score.ts";

// 来源 fastify#7124（fix diff 反构）：撤销「getter 求值一次」缓存，this[name] 被访问两次触发两次 getter
export default {
  id: "real-02-fastify-getter-once",
  kind: "bug",
  source: "real",
  description: "来源 fastify#7124（fix diff 反构）",
  diff: `diff --git a/lib/decorate.js b/lib/decorate.js
index 51782047efb..8d1ed4a120b 100644
--- a/lib/decorate.js
+++ b/lib/decorate.js
@@ -38,12 +38,11 @@ function getInstanceDecorator (name) {
     throw new FST_ERR_DEC_UNDECLARED(name, 'instance')
   }
 
+  if (typeof this[name] === 'function') {
+    return this[name].bind(this)
-  const decorator = this[name]
-  if (typeof decorator === 'function') {
-    return decorator.bind(this)
   }
 
+  return this[name]
-  return decorator
 }
 
 function decorateConstructor (konstructor, name, fn, dependencies) {`,
  expect: [
    {
      "file": "lib/decorate.js",
      "line": 42,
      "mustMention": [
        "getter",
        "两次",
        "求值",
        "访问",
        "缓存",
        "局部",
        "不一致",
        "副作用",
        "重复",
        "多次"
      ]
    }
  ],
} satisfies EvalCase;
