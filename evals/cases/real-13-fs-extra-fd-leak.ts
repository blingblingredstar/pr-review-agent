import type { EvalCase } from "../score.ts";

// 来源 fs-extra#1066（fix commit 1c248ed4 反构）：futimesSync 抛错时 closeSync 永不执行，fd 泄漏（try/finally 被删）
export default {
  id: "real-13-fs-extra-fd-leak",
  kind: "bug",
  source: "real",
  description: "来源 fs-extra#1066（fix commit 1c248ed4 反构）",
  diff: `diff --git a/lib/util/utimes.js b/lib/util/utimes.js
index a4000d6c9dc..1c248ed4b30 100644
--- a/lib/util/utimes.js
+++ b/lib/util/utimes.js
@@ -27,24 +27,8 @@ async function utimesMillis (path, atime, mtime) {
 
 function utimesMillisSync (path, atime, mtime) {
   const fd = fs.openSync(path, 'r+')
+  fs.futimesSync(fd, atime, mtime)
+  return fs.closeSync(fd)
-
-  let error = null
-
-  try {
-    fs.futimesSync(fd, atime, mtime)
-  } catch (futimesErr) {
-    error = futimesErr
-  } finally {
-    try {
-      fs.closeSync(fd)
-    } catch (closeErr) {
-      error = closeErr
-    }
-  }
-
-  if (error) {
-    throw error
-  }
 }
 
 module.exports = {`,
  expect: [
    {
      "file": "lib/util/utimes.js",
      "line": 30,
      "mustMention": [
        "泄漏", "释放", "异常时", "抛错", "未关闭", "残留", "描述符"
      ]
    }
  ],
} satisfies EvalCase;
