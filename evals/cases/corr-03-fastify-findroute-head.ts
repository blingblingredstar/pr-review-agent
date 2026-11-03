import type { EvalCase } from "../score.ts";

// 真实配对 fastify#5078（引入 commit 797f27d7，fix: HEAD route search）→ #5090（修复 commit 91c7b448，次日落地）。
// 缺陷：HEAD 自动路由探测从 router.find 换成 router.findRoute（find-my-way 7.7.0 新 API：按 pattern 树归一 +
// 已注册路由表 constraints 深相等匹配，与 find 的运行时约束策略匹配语义不同），带约束路由上探测失配 →
// hasHEADHandler 误判 → hunk 下方 router.off 清理/重注册分支失衡 → 用户再注册 HEAD 时 find-my-way 抛
// "Method 'HEAD' already declared"（issue #5089：4.24.0 回归，应用启动即炸）。
// 为何 diff 单看无害：API 升级式一行替换 + != null 收紧成 !== null，形似纯清理；缺陷证据在关联位置——
// hasHEADHandler 守卫着同 hunk 上下文可见的 off 清理与重注册逻辑，探测语义变化沿这条链连锁生效。
export default {
  id: "corr-03-fastify-findroute-head",
  kind: "bug",
  source: "correlation",
  description: "真实配对 fastify#5078（引入）→ #5090（修复）：findRoute 语义变化致 HEAD 重复声明崩溃",
  diff: `diff --git a/lib/route.js b/lib/route.js
index 4b8bab18040..7c097678a29 100644
--- a/lib/route.js
+++ b/lib/route.js
@@ -322,8 +322,8 @@ function buildRouting (options) {
         constraints.version = opts.version
       }
 
-      const headHandler = router.find('HEAD', opts.url, constraints)
-      const hasHEADHandler = headHandler != null
+      const headHandler = router.findRoute('HEAD', opts.url, constraints)
+      const hasHEADHandler = headHandler !== null
 
       // remove the head route created by fastify
       if (hasHEADHandler && !context[kRouteByFastify] && headHandler.store[kRouteByFastify]) {`,
  expect: [
    {
      "file": "lib/route.js",
      "line": 325,
      "mustMention": [
        "findroute",
        "find",
        "head",
        "already declared",
        "重复",
        "查找",
        "约束",
        "constraints",
        "清理"
      ]
    }
  ],
} satisfies EvalCase;
