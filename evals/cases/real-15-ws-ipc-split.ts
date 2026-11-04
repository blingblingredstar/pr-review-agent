import type { EvalCase } from "../score.ts";

// 来源 ws#2344（fix commit b54ca101 反构）：IPC path 用 split(':') 取 parts[1]，无冒号时 undefined、多冒号时截断
export default {
  id: "real-15-ws-ipc-split",
  kind: "bug",
  source: "real",
  description: "来源 ws#2344（fix commit b54ca101 反构）",
  diff: `diff --git a/lib/websocket.js b/lib/websocket.js
index 85319a72973..b54ca101d1c 100644
--- a/lib/websocket.js
+++ b/lib/websocket.js
@@ -819,15 +819,10 @@ function initAsClient(websocket, address, protocols, options) {
   }
 
   if (isIpcUrl) {
+    const parts = opts.path.split(':');
-    const i = opts.path.indexOf(':');
 
+    opts.socketPath = parts[0];
+    opts.path = parts[1];
-    if (i === -1) {
-      opts.socketPath = opts.path;
-      opts.path = '';
-    } else {
-      opts.socketPath = opts.path.slice(0, i);
-      opts.path = opts.path.slice(i + 1);
-    }
   }
 
   let req;`,
  expect: [
    {
      "file": "lib/websocket.js",
      "line": 823,
      "mustMention": [
        "越界", "undefined", "存在性", "缺失", "冒号", "截断", "边界", "空值"
      ]
    }
  ],
} satisfies EvalCase;
