import type { EvalCase } from "../score.ts";

// 真实配对 undici#2863（引入 commit 2091dcfa，perf: reuse TextDecoder instance）→ #2999（修复 = revert，0ac82a06）。
// 缺陷：receiver.js / util.js 各自把 new TextDecoder('utf-8', { fatal: true }) 提到模块顶层——fatal 选项在
// 无 ICU（without-intl）的 Node 构建上构造即抛，require 阶段整个 websocket 模块炸掉
// （nodejs/node#52175 审查发现 breaking the withoutintl builds，触发 revert 解锁 Node 版本升级）。
// 为何 diff 单看无害：标准的「复用实例省分配」优化，参数原样照搬，只是从调用点提到模块作用域；
// 环境相关的加载期爆炸在 diff 里没有直接证据，需要知道 fatal 与 ICU 构建矩阵的交互。
export default {
  id: "corr-02-undici-textdecoder-module",
  kind: "bug",
  source: "correlation",
  description: "真实配对 undici#2863（引入）→ #2999（revert 修复）：顶层构造 fatal TextDecoder 炸 no-ICU 构建",
  diff: `diff --git a/lib/web/websocket/receiver.js b/lib/web/websocket/receiver.js
index 63035618968..18dc474f16e 100644
--- a/lib/web/websocket/receiver.js
+++ b/lib/web/websocket/receiver.js
@@ -12,6 +12,8 @@ const { WebsocketFrameSend } = require('./frame')
 // Copyright (c) 2013 Arnout Kazemier and contributors
 // Copyright (c) 2016 Luigi Pinca and contributors
 
+const textDecoder = new TextDecoder('utf-8', { fatal: true })
+
 class ByteParser extends Writable {
   #buffers = []
   #byteOffset = 0
@@ -322,8 +324,7 @@ class ByteParser extends Writable {
     }
 
     try {
-      // TODO: optimize this
-      reason = new TextDecoder('utf-8', { fatal: true }).decode(reason)
+      reason = textDecoder.decode(reason)
     } catch {
       return null
     }
diff --git a/lib/web/websocket/util.js b/lib/web/websocket/util.js
index abe91be734d..8abe73c83e3 100644
--- a/lib/web/websocket/util.js
+++ b/lib/web/websocket/util.js
@@ -55,6 +55,8 @@ function fireEvent (e, target, eventConstructor = Event, eventInitDict = {}) {
   target.dispatchEvent(event)
 }
 
+const textDecoder = new TextDecoder('utf-8', { fatal: true })
+
 /**
  * @see https://websockets.spec.whatwg.org/#feedback-from-the-protocol
  * @param {import('./websocket').WebSocket} ws
@@ -74,7 +76,7 @@ function websocketMessageReceived (ws, type, data) {
     // -> type indicates that the data is Text
     //      a new DOMString containing data
     try {
-      dataForEvent = new TextDecoder('utf-8', { fatal: true }).decode(data)
+      dataForEvent = textDecoder.decode(data)
     } catch {
       failWebsocketConnection(ws, 'Received invalid UTF-8 in text frame.')
       return`,
  expect: [
    {
      "file": ["lib/web/websocket/receiver.js", "lib/web/websocket/util.js"],
      "line": null,
      "mustMention": [
        "icu",
        "intl",
        "顶层",
        "模块",
        "加载"
      ]
    }
  ],
} satisfies EvalCase;
