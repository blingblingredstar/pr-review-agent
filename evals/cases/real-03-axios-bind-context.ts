import type { EvalCase } from "../score.ts";

// 来源 axios#11216（fix diff 反构）：filter.call(this) 改回后 this 不指向 context 参数
export default {
  id: "real-03-axios-bind-context",
  kind: "bug",
  source: "real",
  description: "来源 axios#11216（fix diff 反构）",
  diff: `diff --git a/lib/core/AxiosHeaders.js b/lib/core/AxiosHeaders.js
index 49904b0f15..529ca6676c 100644
--- a/lib/core/AxiosHeaders.js
+++ b/lib/core/AxiosHeaders.js
@@ -165,7 +165,7 @@ const headerSlot = (name) => (name === '__proto__' ? PROTO_HEADER_SLOT : name);
 
 function matchHeaderValue(context, value, header, filter, isHeaderNameFilter) {
   if (utils.isFunction(filter)) {
+    return filter.call(this, value, header);
-    return filter.call(context, value, header);
   }
 
   if (isHeaderNameFilter) {`,
  expect: [
    {
      "file": "lib/core/AxiosHeaders.js",
      "line": 168,
      "mustMention": [
        "context",
        "上下文",
        "绑定",
        "指向",
        "丢失",
        "不指向"
      ]
    }
  ],
} satisfies EvalCase;
