import type { EvalCase } from "../score.ts";

// 来源 fastify#6973（fix diff 反构，GHSA-gm8r-x7h4-fm5r）：Object.create 原型保活改回 Object.assign 浅快照，后续填充的 hook 丢失
export default {
  id: "real-04-fastify-404-context",
  kind: "bug",
  source: "real",
  description: "来源 fastify#6973（fix diff 反构，GHSA-gm8r-x7h4-fm5r）",
  diff: `diff --git a/lib/four-oh-four.js b/lib/four-oh-four.js
index b9f727f05a4..f71214c22fd 100644
--- a/lib/four-oh-four.js
+++ b/lib/four-oh-four.js
@@ -75,14 +75,7 @@ function fourOhFour (options) {
   }
 
   function setContext (instance, context) {
+    const _404Context = Object.assign({}, instance[kFourOhFourContext])
-    // Use the selected not-found context as the prototype rather than taking a
-    // detached shallow snapshot. The selected context's lifecycle hooks are
-    // populated during preReady (potentially after this snapshot is taken when
-    // the route is registered first), and prototype lookup keeps the
-    // route-specific 404 context linked to the live one so hooks like
-    // preHandler are not lost. The route's own onSend is preserved as an own
-    // property.
-    const _404Context = Object.create(instance[kFourOhFourContext])
     _404Context.onSend = context.onSend
     context[kFourOhFourContext] = _404Context
   }`,
  expect: [
    {
      "file": "lib/four-oh-four.js",
      "line": 78,
      "mustMention": [
        "assign",
        "create",
        "快照",
        "浅拷贝",
        "原型",
        "引用",
        "后续",
        "hook",
        "钩子",
        "丢失",
        "同步",
        "时序",
        "隔离"
      ]
    }
  ],
} satisfies EvalCase;
