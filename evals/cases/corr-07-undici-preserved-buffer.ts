import type { EvalCase } from "../score.ts";

// 真实配对 undici#5611（引入 74a2299「properly decode multi-byte UTF-8 in setEncoding」）→ 修复 f59b0f2：setEncoding 时一次性快照原始 chunk，consumeStart 用 else-if 把快照与 state.buffer 互斥——setEncoding 之后到达的 chunk（已解码字符串）被整体丢弃，.text()/.json() 静默截断。为何 diff 单看无害：修 UTF-8 截字的快照与「优先用原始字节」的 else-if 分支各自合理，缺陷在两个 hunk 的组合：快照只覆盖调用时刻、互斥分支丢弃此后到达的一切。
export default {
  id: "corr-07-undici-preserved-buffer",
  kind: "bug",
  source: "correlation",
  description: "真实配对 undici#5611（引入 74a2299「properly decode multi-byte UTF-8 in setEncoding」）→ 修复 f59b0f2：setEncoding 时一次性快照原始 chunk，consumeStart 用 else-if 把快照与 state.buffer 互斥——setEncoding 之后到达的 chunk（已解码字符串）被整体丢弃，.text()/.json() 静默截断",
  diff: `diff --git a/lib/api/readable.js b/lib/api/readable.js
index e71624ebdd3..74a2299eb44 100644
--- a/lib/api/readable.js
+++ b/lib/api/readable.js
@@ -15,6 +15,7 @@ const kContentType = Symbol('kContentType')
 const kContentLength = Symbol('kContentLength')
 const kUsed = Symbol('kUsed')
 const kBytesRead = Symbol('kBytesRead')
+const kPreservedBuffer = Symbol('kPreservedBuffer')
 
 const noop = () => {}
 
@@ -325,7 +326,37 @@ class BodyReadable extends Readable {
    */
   setEncoding (encoding) {
     if (Buffer.isEncoding(encoding)) {
-      this._readableState.encoding = encoding
+      // Preserve raw Buffer chunks for the consume path (body.text(),
+      // body.json(), etc.) before super.setEncoding() replaces them
+      // with decoded strings. Without this, the consume path would
+      // lose access to the original bytes — some of which may be held
+      // by the decoder for incomplete multi-byte sequences, and the
+      // rest converted to strings that can't be safely concatenated
+      // byte-wise.
+      const state = this._readableState
+      const buffer = state.buffer
+      if (buffer && state.length > 0) {
+        const bufferIndex = state.bufferIndex ?? 0
+        const preserved = []
+        const source = typeof buffer.slice === 'function'
+          ? buffer.slice(bufferIndex)
+          : buffer
+        for (const data of source) {
+          if (Buffer.isBuffer(data)) {
+            preserved.push(data)
+          }
+        }
+        if (preserved.length > 0) {
+          this[kPreservedBuffer] = (this[kPreservedBuffer] || []).concat(preserved)
+        }
+      }
+
+      // Delegate to Node.js Readable.setEncoding() which initializes a
+      // StringDecoder and re-encodes already-buffered chunks. This properly
+      // handles multi-byte sequences split at chunk boundaries for the
+      // for-await / on('data') paths. Without this, Node.js uses
+      // buf.toString(encoding) on each chunk, producing U+FFFD for split chars.
+      super.setEncoding(encoding)
     }
     return this
   }
@@ -433,7 +464,17 @@ function consumeStart (consume) {
 
   const { _readableState: state } = consume.stream
 
-  if (state.bufferIndex) {
+  // If setEncoding() was called, state.buffer may contain decoded strings
+  // (which would break Buffer.concat in chunksDecode). Use the preserved
+  // raw Buffers (saved before super.setEncoding() in setEncoding()) for
+  // byte-level accurate consumption. Otherwise read from state.buffer.
+  const preserved = consume.stream[kPreservedBuffer]
+  if (preserved && preserved.length > 0) {
+    for (const chunk of preserved) {
+      consumePush(consume, chunk)
+    }
+    consume.stream[kPreservedBuffer] = null
+  } else if (state.bufferIndex) {
     const start = state.bufferIndex
     const end = state.buffer.length
     for (let n = start; n < end; n++) {`,
  expect: [
    {
      "file": "lib/api/readable.js",
      "line": 477,
      "mustMention": [
        "互斥", "丢弃", "截断", "静默", "后续", "之后", "丢失", "不完整", "二选一"
      ]
    }
  ],
} satisfies EvalCase;
