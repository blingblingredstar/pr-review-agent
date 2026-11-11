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
      // 严格模式 为 #139 补：模型用机制描述同一缺陷（「模块代码处于严格模式，函数体内的 this 是 undefined」），
      // 原表不覆盖。bot 自审把关：this/undefined 是评论文高频词（任一命中即 TP，误报也会被放进来），
      // 换机制措辞保留容忍不虚开（PR #143 首轮意见采纳）
      "mustMention": [
        "上下文",
        "绑定",
        "指向",
        "丢失",
        "不指向",
        "严格模式"
      ]
    }
  ],
} satisfies EvalCase;
