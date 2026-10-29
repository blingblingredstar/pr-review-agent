import type { EvalCase } from "../score.ts";

// 来源 koa#2013（fix diff 反构）：类型分支删掉 boolean 后，布尔值落进空串分支被吞
export default {
  id: "real-06-koa-boolean-query",
  kind: "bug",
  source: "real",
  description: "来源 koa#2013（fix diff 反构）",
  diff: `diff --git a/lib/search-params.js b/lib/search-params.js
index cf824d7e0..4e437e909 100644
--- a/lib/search-params.js
+++ b/lib/search-params.js
@@ -4,7 +4,7 @@ module.exports = {
   stringify: (obj) => {
     const searchParams = new URLSearchParams()
     const addKey = (k, v, params) => {
+      const val = typeof v === 'string' || typeof v === 'number' ? v : ''
-      const val = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : ''
       params.append(k, val)
     }
 `,
  expect: [
    {
      "file": "lib/search-params.js",
      "line": 7,
      "mustMention": [
        "boolean",
        "布尔",
        "空串",
        "''"
      ]
    }
  ],
} satisfies EvalCase;
