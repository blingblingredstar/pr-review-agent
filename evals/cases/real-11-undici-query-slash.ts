import type { EvalCase } from "../score.ts";

// 来源 undici#6031（fix commit f4e4e450 反构）：removeTrailingSlash 对含 query 的整串剥尾斜杠，吞掉最后一个 query 值的尾部字符
export default {
  id: "real-11-undici-query-slash",
  kind: "bug",
  source: "real",
  description: "来源 undici#6031（fix commit f4e4e450 反构）",
  diff: `diff --git a/lib/mock/mock-utils.js b/lib/mock/mock-utils.js
index 5020ba31c61..f4e4e4507a1 100644
--- a/lib/mock/mock-utils.js
+++ b/lib/mock/mock-utils.js
@@ -240,13 +240,6 @@ function removeTrailingSlash (path) {
     return path
   }
 
-  // Only strip slashes from the pathname, not from a query string after it
-  const queryIndex = path.indexOf('?')
-  const search = queryIndex === -1 ? '' : path.slice(queryIndex)
-  if (queryIndex !== -1) {
-    path = path.slice(0, queryIndex)
-  }
-
   while (path.endsWith('/')) {
     path = path.slice(0, -1)
   }
@@ -255,7 +248,7 @@ function removeTrailingSlash (path) {
     path = '/'
   }
 
+  return path
-  return path + search
 }
 
 function buildKey (opts) {`,
  expect: [
    {
      "file": "lib/mock/mock-utils.js",
      "line": 243,
      "mustMention": [
        "查询", "参数", "问号", "误删", "吞", "截断", "尾部", "值"
      ]
    }
  ],
} satisfies EvalCase;
