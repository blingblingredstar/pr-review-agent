import type { EvalCase } from "../score.ts";

// 来源 koa#1961（fix diff 反构）：~~ 按 32 位截断 Content-Length，>2GB 溢出为负数
export default {
  id: "real-05-koa-content-length",
  kind: "bug",
  source: "real",
  description: "来源 koa#1961（fix diff 反构）",
  diff: `diff --git a/lib/request.js b/lib/request.js
index 7860c40bc..23045012a 100644
--- a/lib/request.js
+++ b/lib/request.js
@@ -392,8 +392,7 @@ module.exports = {
   get length () {
     const len = this.get('Content-Length')
     if (len === '') return
+    return ~~len
-    const parsed = Number.parseInt(len, 10)
-    return Number.isNaN(parsed) ? undefined : parsed
   },
 
   /**`,
  expect: [
    {
      "file": "lib/request.js",
      "line": 395,
      "mustMention": [
        "~~",
        "32",
        "位",
        "溢出",
        "2147483648",
        "2gb",
        "负数",
        "截断",
        "parseint",
        "nan"
      ]
    }
  ],
} satisfies EvalCase;
