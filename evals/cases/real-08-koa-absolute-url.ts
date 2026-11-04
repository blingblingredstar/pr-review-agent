import type { EvalCase } from "../score.ts";

// 来源 koa#1999（fix commit 571938d1 反构）：absolute-form 的 originalUrl 被直接拼到 protocol://host 后，URL 双 scheme 畸形
export default {
  id: "real-08-koa-absolute-url",
  kind: "bug",
  source: "real",
  description: "来源 koa#1999（fix commit 571938d1 反构）",
  diff: `diff --git a/lib/request.js b/lib/request.js
index 10617764ac2..571938d1b42 100644
--- a/lib/request.js
+++ b/lib/request.js
@@ -298,9 +298,7 @@ module.exports = {
     if (!this.memoizedURL) {
       const originalUrl = this.originalUrl || '' // avoid undefined in template string
       try {
+        this.memoizedURL = new URL(\`\${this.protocol}://\${this.host}\${originalUrl}\`)
-        this.memoizedURL = /^https?:\/\//i.test(originalUrl)
-          ? new URL(originalUrl)
-          : new URL(\`\${this.protocol}://\${this.host}\${originalUrl}\`)
       } catch (err) {
         this.memoizedURL = Object.create(null)
       }`,
  expect: [
    {
      "file": "lib/request.js",
      "line": 301,
      "mustMention": [
        "绝对", "absolute", "scheme", "拼接", "畸形", "双重", "完整链接", "拼坏"
      ]
    }
  ],
} satisfies EvalCase;
