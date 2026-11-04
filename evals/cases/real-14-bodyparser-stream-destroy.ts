import type { EvalCase } from "../score.ts";

// 来源 body-parser GHSA-27r3-jxmh-p828（fix commit f7075eae 反构，仅取 stream 销毁 hunk）：压缩 body 读完不销毁解压流，trailing bytes 触发无监听的 zlib error 致进程崩溃
export default {
  id: "real-14-bodyparser-stream-destroy",
  kind: "bug",
  source: "real",
  description: "来源 body-parser GHSA-27r3-jxmh-p828（fix commit f7075eae 反构，仅取 stream 销毁 hunk）",
  diff: `diff --git a/lib/read.js b/lib/read.js
index 185ff1d5559..f7075eae3a8 100644
--- a/lib/read.js
+++ b/lib/read.js
@@ -159,17 +158,6 @@ function read (req, res, next, parse, debug, options) {
       return
     }
 
-    // detach and destroy the decompression stream to
-    // avoid decompression errors on the finished stream
-    if (stream !== req) {
-      req.unpipe(stream)
-      stream.on('error', () => {})
-      stream.destroy()
-
-      // consume any remaining bytes so the HTTP request can finish
-      req.resume()
-    }
-
     // verify
     if (verify) {
       try {`,
  expect: [
    {
      "file": "lib/read.js",
      "line": 161,
      "mustMention": [
        "销毁", "解压", "残留", "尾部", "崩溃", "未清理", "悬空", "善后"
      ]
    }
  ],
} satisfies EvalCase;
