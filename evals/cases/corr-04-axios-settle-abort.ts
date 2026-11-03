import type { EvalCase } from "../score.ts";

// 真实配对 axios#7150（引入 commit d676df77，feat: HTTP2 support 大重构内的单行改动）→ #7193（修复 commit bcd5581d）。
// 缺陷：stream 分支 settle(resolve, reject, response) 被改成 settle(resolve, abort, response)——非 OK 状态码的
// 拒绝改道走 abort 机制：abort() 在 abortEmitter 上 emit('abort')，挂在其上的清理监听器对 responseStream
// emit error 并 destroy() → 错误响应的 data 流被销毁、body 读不到（issue #7192：1.13.0 回归，读 404 响应体
// 得 Unexpected end of JSON input）。
// 为何 diff 单看无害：reject 仍会经 once('abort', reject) 发生、promise 照样 reject，像等价的事件机制收敛；
// 缺陷证据在关联位置——同 diff 内另一 hunk 的 once('abort') 监听器会销毁流，三处（settle 调用、abort 定义、
// 流销毁监听）联系起来才可见。
export default {
  id: "corr-04-axios-settle-abort",
  kind: "bug",
  source: "correlation",
  description: "真实配对 axios#7150（引入）→ #7193（修复）：settle 改传 abort，错误响应流被销毁",
  diff: `diff --git a/lib/adapters/http.js b/lib/adapters/http.js
index a3489b21de..ea69ff2eba 100755
--- a/lib/adapters/http.js
+++ b/lib/adapters/http.js
@@ -1,5 +1,4 @@
-'use strict';
-
+import { connect, constants } from 'http2';
 import utils from './../utils.js';
 import settle from './../core/settle.js';
 import buildFullPath from '../core/buildFullPath.js';
@@ -37,6 +36,13 @@ const brotliOptions = {
   finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH
 }
 
+const {
+  HTTP2_HEADER_SCHEME,
+  HTTP2_HEADER_METHOD,
+  HTTP2_HEADER_PATH,
+  HTTP2_HEADER_STATUS
+} = constants;
+
 const isBrotliSupported = utils.isFunction(zlib.createBrotliDecompress);
 
 const {http: httpFollow, https: httpsFollow} = followRedirects;
@@ -56,6 +62,66 @@ const flushOnFinish = (stream, [throttled, flush]) => {
   return throttled;
 }
 
+class Http2Sessions {
+  constructor() {
+    this.sessions = Object.create(null);
+  }
+
+  getSession(authority, options) {
+    options = Object.assign({
+      sessionTimeout: 1000
+    }, options);
+
+    let authoritySessions;
+
+    if ((authoritySessions = this.sessions[authority])) {
+      let len = authoritySessions.length;
+
+      for (let i = 0; i < len; i++) {
+        const [sessionHandle, sessionOptions] = authoritySessions[i];
+        if (!sessionHandle.destroyed && !sessionHandle.closed && util.isDeepStrictEqual(sessionOptions, options)) {
+          return sessionHandle;
+        }
+      }
+    }
+
+    const session = connect(authority, options);
+
+    session.once('close', () => {
+      let entries = authoritySessions, len = entries.length, i = len;
+
+      while (i--) {
+        if (entries[i][0] === session) {
+          entries.splice(i, 1);
+          if (len === 1) {
+            delete this.sessions[authority];
+            return;
+          }
+        }
+      }
+    });
+
+    Http2Sessions.setTimeout(session, options.sessionTimeout);
+
+    let entries = this.sessions[authority], entry = [
+      session,
+      options
+    ];
+
+    entries ? this.sessions[authority].push(entry) : authoritySessions =  this.sessions[authority] = [entry];
+
+    return session;
+  }
+
+  static setTimeout(session, timeout = 1000) {
+    session && session.setTimeout(timeout, () => {
+      session.close();
+    });
+  }
+}
+
+const http2Sessions = new Http2Sessions();
+
 
 /**
  * If the proxy or config beforeRedirects functions are defined, call them with the options
@@ -168,16 +234,66 @@ const resolveFamily = ({address, family}) => {
 
 const buildAddressEntry = (address, family) => resolveFamily(utils.isObject(address) ? address : {address, family});
 
+const http2Transport = {
+  request(options, cb) {
+      const authority = options.protocol + '//' + options.hostname + ':' + (options.port || 80);
+
+      const {http2Options, headers} = options;
+
+      const session = http2Sessions.getSession(authority, http2Options);
+
+      const http2Headers = {
+        [HTTP2_HEADER_SCHEME]: options.protocol.replace(':', ''),
+        [HTTP2_HEADER_METHOD]: options.method,
+        [HTTP2_HEADER_PATH]: options.path,
+      }
+
+      utils.forEach(headers, (header, name) => {
+        name.charAt(0) !== ':' && (http2Headers[name] = header);
+      });
+
+      const req = session.request(http2Headers);
+
+      req.once('response', (responseHeaders) => {
+        const response = req; //duplex
+
+        responseHeaders = Object.assign({}, responseHeaders);
+
+        const status = responseHeaders[HTTP2_HEADER_STATUS];
+
+        delete responseHeaders[HTTP2_HEADER_STATUS];
+
+        response.headers = responseHeaders;
+
+        response.statusCode = +status;
+
+        cb(response);
+      })
+
+      return req;
+  }
+}
+
 /*eslint consistent-return:0*/
 export default isHttpAdapterSupported && function httpAdapter(config) {
   return wrapAsync(async function dispatchHttpRequest(resolve, reject, onDone) {
-    let {data, lookup, family} = config;
+    let {data, lookup, family, httpVersion = 1, http2Options} = config;
     const {responseType, responseEncoding} = config;
     const method = config.method.toUpperCase();
     let isDone;
     let rejected = false;
     let req;
 
+    httpVersion = Number(httpVersion);
+    if (Number.isNaN(httpVersion)) {
+      throw TypeError(\`Invalid protocol version: '\${config.httpVersion}' is not a number\`);
+    }
+    if (httpVersion !== 1 && httpVersion !== 2) {
+      throw TypeError(\`Unsupported protocol version '\${httpVersion}'\`);
+    }
+
+    const isHttp2 = httpVersion === 2;
+
     if (lookup) {
       const _lookup = callbackify(lookup, (value) => utils.isArray(value) ? value : [value]);
       // hotfix to support opt.all option which is required for node 20.x
@@ -194,8 +310,17 @@ export default isHttpAdapterSupported && function httpAdapter(config) {
       }
     }
 
-    // temporary internal emitter until the AxiosRequest class will be implemented
-    const emitter = new EventEmitter();
+    const abortEmitter = new EventEmitter();
+
+    function abort(reason) {
+      try {
+        abortEmitter.emit('abort', !reason || reason.type ? new CanceledError(null, config, req) : reason);
+      } catch(err) {
+        console.warn('emit error', err);
+      }
+    }
+
+    abortEmitter.once('abort', reject);
 
     const onFinished = () => {
       if (config.cancelToken) {
@@ -206,29 +331,40 @@ export default isHttpAdapterSupported && function httpAdapter(config) {
         config.signal.removeEventListener('abort', abort);
       }
 
-      emitter.removeAllListeners();
+      abortEmitter.removeAllListeners();
     }
 
-    onDone((value, isRejected) => {
+    if (config.cancelToken || config.signal) {
+      config.cancelToken && config.cancelToken.subscribe(abort);
+      if (config.signal) {
+        config.signal.aborted ? abort() : config.signal.addEventListener('abort', abort);
+      }
+    }
+
+    onDone((response, isRejected) => {
       isDone = true;
+
       if (isRejected) {
         rejected = true;
         onFinished();
+        return;
+      }
+
+      const {data} = response;
+
+      if (data instanceof stream.Readable || data instanceof stream.Duplex) {
+        const offListeners = stream.finished(data, () => {
+          offListeners();
+          onFinished();
+        });
+      } else {
+        onFinished();
       }
     });
 
-    function abort(reason) {
-      emitter.emit('abort', !reason || reason.type ? new CanceledError(null, config, req) : reason);
-    }
 
-    emitter.once('abort', reject);
 
-    if (config.cancelToken || config.signal) {
-      config.cancelToken && config.cancelToken.subscribe(abort);
-      if (config.signal) {
-        config.signal.aborted ? abort() : config.signal.addEventListener('abort', abort);
-      }
-    }
+
 
     // Parse url
     const fullPath = buildFullPath(config.baseURL, config.url, config.allowAbsoluteUrls);
@@ -436,7 +572,8 @@ export default isHttpAdapterSupported && function httpAdapter(config) {
       protocol,
       family,
       beforeRedirect: dispatchBeforeRedirect,
-      beforeRedirects: {}
+      beforeRedirects: {},
+      http2Options
     };
 
     // cacheable-lookup integration hotfix
@@ -453,18 +590,23 @@ export default isHttpAdapterSupported && function httpAdapter(config) {
     let transport;
     const isHttpsRequest = isHttps.test(options.protocol);
     options.agent = isHttpsRequest ? config.httpsAgent : config.httpAgent;
-    if (config.transport) {
-      transport = config.transport;
-    } else if (config.maxRedirects === 0) {
-      transport = isHttpsRequest ? https : http;
+
+    if (isHttp2) {
+       transport = http2Transport;
     } else {
-      if (config.maxRedirects) {
-        options.maxRedirects = config.maxRedirects;
-      }
-      if (config.beforeRedirect) {
-        options.beforeRedirects.config = config.beforeRedirect;
+      if (config.transport) {
+        transport = config.transport;
+      } else if (config.maxRedirects === 0) {
+        transport = isHttpsRequest ? https : http;
+      } else {
+        if (config.maxRedirects) {
+          options.maxRedirects = config.maxRedirects;
+        }
+        if (config.beforeRedirect) {
+          options.beforeRedirects.config = config.beforeRedirect;
+        }
+        transport = isHttpsRequest ? httpsFollow : httpFollow;
       }
-      transport = isHttpsRequest ? httpsFollow : httpFollow;
     }
 
     if (config.maxBodyLength > -1) {
@@ -484,7 +626,7 @@ export default isHttpAdapterSupported && function httpAdapter(config) {
 
       const streams = [res];
 
-      const responseLength = +res.headers['content-length'];
+      const responseLength = utils.toFiniteNumber(res.headers['content-length']);
 
       if (onDownloadProgress || maxDownloadRate) {
         const transformStream = new AxiosTransformStream({
@@ -547,10 +689,7 @@ export default isHttpAdapterSupported && function httpAdapter(config) {
 
       responseStream = streams.length > 1 ? stream.pipeline(streams, utils.noop) : streams[0];
 
-      const offListeners = stream.finished(responseStream, () => {
-        offListeners();
-        onFinished();
-      });
+
 
       const response = {
         status: res.statusCode,
@@ -562,7 +701,7 @@ export default isHttpAdapterSupported && function httpAdapter(config) {
 
       if (responseType === 'stream') {
         response.data = responseStream;
-        settle(resolve, reject, response);
+        settle(resolve, abort, response);
       } else {
         const responseBuffer = [];
         let totalResponseBytes = 0;
@@ -576,7 +715,7 @@ export default isHttpAdapterSupported && function httpAdapter(config) {
             // stream.destroy() emit aborted event before calling reject() on Node.js v16
             rejected = true;
             responseStream.destroy();
-            reject(new AxiosError('maxContentLength size of ' + config.maxContentLength + ' exceeded',
+            abort(new AxiosError('maxContentLength size of ' + config.maxContentLength + ' exceeded',
               AxiosError.ERR_BAD_RESPONSE, config, lastRequest));
           }
         });
@@ -618,7 +757,7 @@ export default isHttpAdapterSupported && function httpAdapter(config) {
         });
       }
 
-      emitter.once('abort', err => {
+      abortEmitter.once('abort', err => {
         if (!responseStream.destroyed) {
           responseStream.emit('error', err);
           responseStream.destroy();
@@ -626,9 +765,12 @@ export default isHttpAdapterSupported && function httpAdapter(config) {
       });
     });
 
-    emitter.once('abort', err => {
-      reject(err);
-      req.destroy(err);
+    abortEmitter.once('abort', err => {
+      if (req.close) {
+        req.close();
+      } else {
+        req.destroy(err);
+      }
     });
 
     // Handle errors
@@ -650,7 +792,7 @@ export default isHttpAdapterSupported && function httpAdapter(config) {
       const timeout = parseInt(config.timeout, 10);
 
       if (Number.isNaN(timeout)) {
-        reject(new AxiosError(
+        abort(new AxiosError(
           'error trying to parse \`config.timeout\` to int',
           AxiosError.ERR_BAD_OPTION_VALUE,
           config,
@@ -672,13 +814,12 @@ export default isHttpAdapterSupported && function httpAdapter(config) {
         if (config.timeoutErrorMessage) {
           timeoutErrorMessage = config.timeoutErrorMessage;
         }
-        reject(new AxiosError(
+        abort(new AxiosError(
           timeoutErrorMessage,
           transitional.clarifyTimeoutError ? AxiosError.ETIMEDOUT : AxiosError.ECONNABORTED,
           config,
           req
         ));
-        abort();
       });
     }
 
@@ -705,7 +846,8 @@ export default isHttpAdapterSupported && function httpAdapter(config) {
 
       data.pipe(req);
     } else {
-      req.end(data);
+      data && req.write(data);
+      req.end();
     }
   });
 }`,
  expect: [
    {
      "file": "lib/adapters/http.js",
      "line": 704,
      "mustMention": [
        "中断",
        "销毁",
        "读不到",
        "截断",
        "改道",
        "错误响应",
        "non-ok"
      ]
    }
  ],
} satisfies EvalCase;
