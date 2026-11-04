import type { EvalCase } from "../score.ts";

// 来源 got#2162（fix commit 3cc40b54 反构）：在用户 AbortSignal 上挂 abort 监听从不移除，监听器与 Request 闭包泄漏
export default {
  id: "real-12-got-abort-listener",
  kind: "bug",
  source: "real",
  description: "来源 got#2162（fix commit 3cc40b54 反构）",
  diff: `diff --git a/source/core/index.ts b/source/core/index.ts
index 5f278d74125..3cc40b549c4 100644
--- a/source/core/index.ts
+++ b/source/core/index.ts
@@ -176,7 +176,6 @@ export default class Request extends Duplex implements RequestEvents<Request> {
 	private _triggerRead: boolean;
 	declare private _jobs: Array<() => void>;
 	private _cancelTimeouts: () => void;
-	private readonly _removeListeners: () => void;
 	private _nativeResponse?: IncomingMessageWithTimings;
 	private _flushed: boolean;
 	private _aborted: boolean;
@@ -200,7 +199,6 @@ export default class Request extends Duplex implements RequestEvents<Request> {
 		this._unproxyEvents = noop;
 		this._triggerRead = false;
 		this._cancelTimeouts = noop;
-		this._removeListeners = noop;
 		this._jobs = [];
 		this._flushed = false;
 		this._requestInitialized = false;
@@ -249,6 +247,14 @@ export default class Request extends Duplex implements RequestEvents<Request> {
 			return;
 		}
 
+		if (this.options.signal?.aborted) {
+			this.destroy(new AbortError(this));
+		}
+
+		this.options.signal?.addEventListener('abort', () => {
+			this.destroy(new AbortError(this));
+		});
+
 		// Important! If you replace \`body\` in a handler with another stream, make sure it's readable first.
 		// The below is run only once.
 		const {body} = this.options;
@@ -265,21 +271,6 @@ export default class Request extends Duplex implements RequestEvents<Request> {
 				}
 			});
 		}
-
-		if (this.options.signal) {
-			const abort = () => {
-				this.destroy(new AbortError(this));
-			};
-
-			if (this.options.signal.aborted) {
-				abort();
-			} else {
-				this.options.signal.addEventListener('abort', abort);
-				this._removeListeners = () => {
-					this.options.signal.removeEventListener('abort', abort);
-				};
-			}
-		}
 	}
 
 	async flush() {
@@ -517,7 +508,6 @@ export default class Request extends Duplex implements RequestEvents<Request> {
 		// Prevent further retries
 		this._stopRetry();
 		this._cancelTimeouts();
-		this._removeListeners();
 
 		if (this.options) {
 			const {body} = this.options;`,
  expect: [
    {
      "file": "source/core/index.ts",
      "line": 253,
      "mustMention": [
        "监听", "移除", "清理", "泄漏", "累积", "重复注册", "堆积", "警告"
      ]
    }
  ],
} satisfies EvalCase;
