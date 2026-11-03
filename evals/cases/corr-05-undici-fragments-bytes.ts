import type { EvalCase } from "../score.ts";

// 真实配对 undici#3284（引入 commit 13523fd7，perf: pre-calculated length）→ #3290（修复 = revert，fcfa4db6）。
// 缺陷：#fragmentsBytes 只在未压缩分支的 push 处累加，permessage-deflate 压缩消息的 fragments 由 decompress
// 回调 push（不经计数点，已对照引入 commit 的源码核实）——压缩消息用陈旧/零计数调 bufferConcat(fragments,
// fragmentsBytes)：计数为 0 短路返回 allocUnsafe(0)，计数偏小时按 length 写入余量 fill(0) 静默截断/零填充
// → 压缩 websocket 消息损坏（revert 说明：broke permessage-deflate support，issue #3289；测试没抓到是因为
// 用例没覆盖压缩帧，见 revert PR 描述）。
// 为何 diff 单看无害：预计算长度省一次求和、自写 concat 免 Buffer.concat 的重复遍历，helper 还带 undefined
// 兜底——每处单看都像严谨的优化；缺陷证据在关联位置——计数点与压缩分支的使用点分属两个 hunk，
// 「每个 push 点都同步计数」的不变式只在其中一个 hunk 内可见。
export default {
  id: "corr-05-undici-fragments-bytes",
  kind: "bug",
  source: "correlation",
  description: "真实配对 undici#3284（引入）→ #3290（revert 修复）：压缩消息不经计数点，concat 空毁",
  diff: `diff --git a/lib/web/websocket/receiver.js b/lib/web/websocket/receiver.js
index 3a8b2abb611..3b75a5d471d 100644
--- a/lib/web/websocket/receiver.js
+++ b/lib/web/websocket/receiver.js
@@ -11,6 +11,7 @@ const {
   failWebsocketConnection,
   websocketMessageReceived,
   utf8Decode,
+  bufferConcat,
   isControlFrame,
   isTextBinaryFrame,
   isContinuationFrame
@@ -33,6 +34,7 @@ class ByteParser extends Writable {
 
   #info = {}
   #fragments = []
+  #fragmentsBytes = 0
 
   /** @type {Map<string, PerMessageDeflate>} */
   #extensions
@@ -208,15 +210,17 @@ class ByteParser extends Writable {
         } else {
           if (!this.#info.compressed) {
             this.#fragments.push(body)
+            this.#fragmentsBytes += body.length
 
             // If the frame is not fragmented, a message has been received.
             // If the frame is fragmented, it will terminate with a fin bit set
             // and an opcode of 0 (continuation), therefore we handle that when
             // parsing continuation frames, not here.
             if (!this.#info.fragmented && this.#info.fin) {
-              const fullMessage = Buffer.concat(this.#fragments)
+              const fullMessage = bufferConcat(this.#fragments, this.#fragmentsBytes)
               websocketMessageReceived(this.ws, this.#info.binaryType, fullMessage)
               this.#fragments.length = 0
+              this.#fragmentsBytes = 0
             }
 
             this.#state = parserStates.INFO
@@ -236,12 +240,13 @@ class ByteParser extends Writable {
                 return
               }
 
-              websocketMessageReceived(this.ws, this.#info.binaryType, Buffer.concat(this.#fragments))
+              websocketMessageReceived(this.ws, this.#info.binaryType, bufferConcat(this.#fragments, this.#fragmentsBytes))
 
               this.#loop = true
               this.#state = parserStates.INFO
               this.run(callback)
               this.#fragments.length = 0
+              this.#fragmentsBytes = 0
             })
 
             this.#loop = false
diff --git a/lib/web/websocket/util.js b/lib/web/websocket/util.js
index e5ce7899752..35b670ee539 100644
--- a/lib/web/websocket/util.js
+++ b/lib/web/websocket/util.js
@@ -294,6 +294,29 @@ const utf8Decode = hasIntl
     throw new TypeError('Invalid utf-8 received.')
   }
 
+function bufferConcat (buffers, length) {
+  if (buffers.length === 0 || length === 0) {
+    return Buffer.allocUnsafe(0)
+  }
+  let offset = 0
+  if (length === undefined) {
+    length = 0
+    for (let i = 0; i < buffers.length; ++i) {
+      length += buffers[i].length
+    }
+  }
+  const output = Buffer.allocUnsafe(length)
+  for (let i = 0; i < buffers.length; ++i) {
+    const buffer = buffers[i]
+    output.set(buffer, offset)
+    offset += buffer.length
+  }
+  if (offset < length) {
+    output.fill(0, offset, length)
+  }
+  return output
+}
+
 module.exports = {
   isConnecting,
   isEstablished,
@@ -305,6 +328,7 @@ module.exports = {
   failWebsocketConnection,
   websocketMessageReceived,
   utf8Decode,
+  bufferConcat,
   isControlFrame,
   isContinuationFrame,
   isTextBinaryFrame,`,
  expect: [
    {
      "file": ["lib/web/websocket/receiver.js", "lib/web/websocket/util.js"],
      "line": null,
      "mustMention": [
        "压缩",
        "计数",
        "截断",
        "零填充",
        "truncat",
        "fragmentsbytes"
      ]
    }
  ],
} satisfies EvalCase;
