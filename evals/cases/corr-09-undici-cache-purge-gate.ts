import type { EvalCase } from "../score.ts";

// 真实配对 undici#3739（引入 68107da「[http-cache] follow up」清理重构）→ 修复 3030506：拦截器 method 门槛从「用户 methods + UNSAFE_METHODS」收缩为仅用户 methods（默认 ['GET']），而缓存清删逻辑在 CacheHandler 里只有 unsafe method 进得去才触发——POST/PUT/DELETE 不再清缓存，脏缓存长存。为何 diff 单看无害：参数解构默认值化 + import 收敛都是标准清理，缺陷在 cache.js 门槛与同 diff 内 cache-handler.js 删掉 UNSAFE_METHODS 判定两处关联——「谁还负责清删」跨文件才可见。
export default {
  id: "corr-09-undici-cache-purge-gate",
  kind: "bug",
  source: "correlation",
  description: "真实配对 undici#3739（引入 68107da「[http-cache] follow up」清理重构）→ 修复 3030506：拦截器 method 门槛从「用户 methods + UNSAFE_METHODS」收缩为仅用户 methods（默认 ['GET']），而缓存清删逻辑在 CacheHandler 里只有 unsafe method 进得去才触发——POST/PUT/DELETE 不再清缓存，脏缓存长存",
  diff: `diff --git a/lib/interceptor/cache.js b/lib/interceptor/cache.js
index 770b2db5674..68107da3fdd 100644
--- a/lib/interceptor/cache.js
+++ b/lib/interceptor/cache.js
@@ -4,48 +4,40 @@ const util = require('../core/util')
 const CacheHandler = require('../handler/cache-handler')
 const MemoryCacheStore = require('../cache/memory-cache-store')
 const CacheRevalidationHandler = require('../handler/cache-revalidation-handler')
-const { UNSAFE_METHODS, assertCacheStoreType } = require('../util/cache.js')
+const { assertCacheStore, assertCacheMethods } = require('../util/cache.js')
 
 const AGE_HEADER = Buffer.from('age')
 
 /**
- * @param {import('../../types/cache-interceptor.d.ts').default.CacheOptions | undefined} globalOpts
+ * @param {import('../../types/cache-interceptor.d.ts').default.CacheOptions} [opts]
  * @returns {import('../../types/dispatcher.d.ts').default.DispatcherComposeInterceptor}
  */
-module.exports = globalOpts => {
-  if (!globalOpts) {
-    globalOpts = {}
+module.exports = (opts = {}) => {
+  const {
+    store = new MemoryCacheStore(),
+    methods = ['GET']
+  } = opts
+
+  if (typeof opts !== 'object' || opts === null) {
+    throw new TypeError(\`expected type of opts to be an Object, got \${opts === null ? 'null' : typeof opts}\`)
   }
 
-  if (globalOpts.store) {
-    assertCacheStoreType(globalOpts.store)
-  } else {
-    globalOpts.store = new MemoryCacheStore()
-  }
-
-  if (globalOpts.methods) {
-    if (!Array.isArray(globalOpts.methods)) {
-      throw new TypeError(\`methods needs to be an array, got \${typeof globalOpts.methods}\`)
-    }
+  assertCacheStore(store, 'opts.store')
+  assertCacheMethods(methods, 'opts.methods')
 
-    if (globalOpts.methods.length === 0) {
-      throw new Error('methods must have at least one method in it')
-    }
-  } else {
-    globalOpts.methods = ['GET']
+  const globalOpts = {
+    store,
+    methods
   }
 
-  // Safe methods the user wants and unsafe methods
-  const methods = [...globalOpts.methods, ...UNSAFE_METHODS]
-
   return dispatch => {
     return (opts, handler) => {
       if (!opts.origin || !methods.includes(opts.method)) {
         // Not a method we want to cache or we don't have the origin, skip
         return dispatch(opts, handler)
       }
 
-      const stream = globalOpts.store.createReadStream(opts)
+      const stream = store.createReadStream(opts)
       if (!stream) {
         // Request isn't cached
         return dispatch(opts, new CacheHandler(globalOpts, opts, handler))
@@ -169,7 +161,7 @@ module.exports = globalOpts => {
         respondWithCachedValue(stream, value)
       }
 
-      Promise.resolve(stream).then(handleStream).catch(err => handler.onError(err))
+      Promise.resolve(stream).then(handleStream).catch(handler.onError)
 
       return true
     }
diff --git a/lib/handler/cache-handler.js b/lib/handler/cache-handler.js
index 770b2db5674..68107da3fdd 100644
--- a/lib/handler/cache-handler.js
+++ b/lib/handler/cache-handler.js
@@ -2,54 +2,54 @@
 
 const util = require('../core/util')
 const DecoratorHandler = require('../handler/decorator-handler')
-const { parseCacheControlHeader, parseVaryHeader, UNSAFE_METHODS, assertCacheStoreType } = require('../util/cache')
+const {
+  parseCacheControlHeader,
+  parseVaryHeader
+} = require('../util/cache')
 
 /**
  * Writes a response to a CacheStore and then passes it on to the next handler
  */
 class CacheHandler extends DecoratorHandler {
   /**
-   * @type {import('../../types/cache-interceptor.d.ts').default.CacheOptions | null}
-  */
-  #opts = null
+   * @type {import('../../types/cache-interceptor.d.ts').default.CacheStore}
+   */
+  #store
+
+  /**
+   * @type {import('../../types/cache-interceptor.d.ts').default.CacheMethods}
+   */
+  #methods
+
   /**
-   * @type {import('../../types/dispatcher.d.ts').default.RequestOptions | null}
+   * @type {import('../../types/dispatcher.d.ts').default.RequestOptions}
    */
-  #req = null
+  #requestOptions
+
   /**
-   * @type {import('../../types/dispatcher.d.ts').default.DispatchHandlers | null}
+   * @type {import('../../types/dispatcher.d.ts').default.DispatchHandlers}
    */
-  #handler = null
+  #handler
+
   /**
    * @type {import('../../types/cache-interceptor.d.ts').default.CacheStoreWriteable | undefined}
    */
   #writeStream
 
   /**
    * @param {import('../../types/cache-interceptor.d.ts').default.CacheOptions} opts
-   * @param {import('../../types/dispatcher.d.ts').default.RequestOptions} req
+   * @param {import('../../types/dispatcher.d.ts').default.RequestOptions} requestOptions
    * @param {import('../../types/dispatcher.d.ts').default.DispatchHandlers} handler
    */
-  constructor (opts, req, handler) {
-    super(handler)
+  constructor (opts, requestOptions, handler) {
+    const { store, methods } = opts
 
-    if (typeof opts !== 'object') {
-      throw new TypeError(\`expected opts to be an object, got type \${typeof opts}\`)
-    }
-
-    assertCacheStoreType(opts.store)
-
-    if (typeof req !== 'object') {
-      throw new TypeError(\`expected req to be an object, got type \${typeof opts}\`)
-    }
-
-    if (typeof handler !== 'object') {
-      throw new TypeError(\`expected handler to be an object, got type \${typeof opts}\`)
-    }
+    super(handler)
 
-    this.#opts = opts
-    this.#req = req
+    this.#store = store
+    this.#requestOptions = requestOptions
     this.#handler = handler
+    this.#methods = methods
   }
 
   /**
@@ -75,14 +75,14 @@ class CacheHandler extends DecoratorHandler {
     )
 
     if (
-      UNSAFE_METHODS.includes(this.#req.method) &&
+      !this.#methods.includes(this.#requestOptions.method) &&
       statusCode >= 200 &&
       statusCode <= 399
     ) {
       // https://www.rfc-editor.org/rfc/rfc9111.html#name-invalidating-stored-respons
       // Try/catch for if it's synchronous
       try {
-        const result = this.#opts.store.deleteByOrigin(this.#req.origin)
+        const result = this.#store.deleteByOrigin(this.#requestOptions.origin)
         if (
           result &&
           typeof result.catch === 'function' &&
@@ -103,7 +103,7 @@ class CacheHandler extends DecoratorHandler {
     const cacheControlHeader = headers['cache-control']
     const contentLengthHeader = headers['content-length']
 
-    if (!cacheControlHeader || !contentLengthHeader || this.#opts.store.isFull) {
+    if (!cacheControlHeader || !contentLengthHeader || this.#store.isFull) {
       // Don't have the headers we need, can't cache
       return downstreamOnHeaders()
     }
@@ -122,7 +122,7 @@ class CacheHandler extends DecoratorHandler {
     const staleAt = determineStaleAt(now, headers, cacheControlDirectives)
     if (staleAt) {
       const varyDirectives = headers.vary
-        ? parseVaryHeader(headers.vary, this.#req.headers)
+        ? parseVaryHeader(headers.vary, this.#requestOptions.headers)
         : undefined
       const deleteAt = determineDeleteAt(now, cacheControlDirectives, staleAt)
 
@@ -132,7 +132,7 @@ class CacheHandler extends DecoratorHandler {
         cacheControlDirectives
       )
 
-      this.#writeStream = this.#opts.store.createWriteStream(this.#req, {
+      this.#writeStream = this.#store.createWriteStream(this.#requestOptions, {
         statusCode,
         statusMessage,
         rawHeaders: strippedHeaders,
diff --git a/lib/handler/cache-revalidation-handler.js b/lib/handler/cache-revalidation-handler.js
index 770b2db5674..68107da3fdd 100644
--- a/lib/handler/cache-revalidation-handler.js
+++ b/lib/handler/cache-revalidation-handler.js
@@ -32,12 +32,12 @@ class CacheRevalidationHandler extends DecoratorHandler {
    * @param {import('../../types/dispatcher.d.ts').default.DispatchHandlers} handler
    */
   constructor (successCallback, handler) {
-    super(handler)
-
     if (typeof successCallback !== 'function') {
       throw new TypeError('successCallback must be a function')
     }
 
+    super(handler)
+
     this.#successCallback = successCallback
     this.#handler = handler
   }
diff --git a/lib/util/cache.js b/lib/util/cache.js
index 770b2db5674..68107da3fdd 100644
--- a/lib/util/cache.js
+++ b/lib/util/cache.js
@@ -1,8 +1,8 @@
 'use strict'
 
-const UNSAFE_METHODS = /** @type {const} */ ([
-  'POST', 'PUT', 'PATCH', 'DELETE'
-])
+const {
+  safeHTTPMethods
+} = require('../core/util')
 
 /**
  * @see https://www.rfc-editor.org/rfc/rfc9111.html#name-cache-control
@@ -181,25 +181,44 @@ function parseVaryHeader (varyHeader, headers) {
  * @param {unknown} store
  * @returns {asserts store is import('../../types/cache-interceptor.d.ts').default.CacheStore}
  */
-function assertCacheStoreType (store) {
+function assertCacheStore (store, name = 'CacheStore') {
   if (typeof store !== 'object' || store === null) {
-    throw new TypeError(\`expected type to be an store, got \${typeof store}\`)
+    throw new TypeError(\`expected type of \${name} to be a CacheStore, got \${store === null ? 'null' : typeof store}\`)
   }
 
   for (const fn of ['createReadStream', 'createWriteStream', 'deleteByOrigin']) {
     if (typeof store[fn] !== 'function') {
-      throw new TypeError(\`CacheStore needs a \\\`\${fn}()\\\` function\`)
+      throw new TypeError(\`\${name} needs to have a \\\`\${fn}()\\\` function\`)
     }
   }
 
   if (typeof store.isFull !== 'boolean') {
-    throw new TypeError(\`CacheStore needs a isFull getter with type boolean, current type: \${typeof store.isFull}\`)
+    throw new TypeError(\`\${name} needs a isFull getter with type boolean, current type: \${typeof store.isFull}\`)
+  }
+}
+/**
+ * @param {unknown} methods
+ * @returns {asserts methods is import('../../types/cache-interceptor.d.ts').default.CacheMethods[]}
+ */
+function assertCacheMethods (methods, name = 'CacheMethods') {
+  if (!Array.isArray(methods)) {
+    throw new TypeError(\`expected type of \${name} needs to be an array, got \${methods === null ? 'null' : typeof methods}\`)
+  }
+
+  if (methods.length === 0) {
+    throw new TypeError(\`\${name} needs to have at least one method\`)
+  }
+
+  for (const method of methods) {
+    if (!safeHTTPMethods.includes(method)) {
+      throw new TypeError(\`element of \${name}-array needs to be one of following values: \${safeHTTPMethods.join(', ')}, got \${method}\`)
+    }
   }
 }
 
 module.exports = {
-  UNSAFE_METHODS,
   parseCacheControlHeader,
   parseVaryHeader,
-  assertCacheStoreType
+  assertCacheMethods,
+  assertCacheStore
 }
diff --git a/lib/core/util.js b/lib/core/util.js
index 770b2db5674..68107da3fdd 100644
--- a/lib/core/util.js
+++ b/lib/core/util.js
@@ -924,6 +924,6 @@ module.exports = {
   isHttpOrHttpsPrefixed,
   nodeMajor,
   nodeMinor,
-  safeHTTPMethods: ['GET', 'HEAD', 'OPTIONS', 'TRACE'],
+  safeHTTPMethods: Object.freeze(['GET', 'HEAD', 'OPTIONS', 'TRACE']),
   wrapRequestBody
 }`,
  expect: [
    {
      "file": "lib/interceptor/cache.js",
      "line": 35,
      "mustMention": [
        "清删", "失效", "脏", "缓存", "写操作", "增删改", "不再", "过期"
      ]
    }
  ],
} satisfies EvalCase;
