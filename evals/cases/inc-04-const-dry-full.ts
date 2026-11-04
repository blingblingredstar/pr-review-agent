import type { EvalCase } from "../score.ts";

// 增量 mock 组（D032 开放问题②量化）：C 行变体（跨文件常量 DRY）：push1 在 limits.ts 新增 MAX_PAGE_SIZE=100，push2 在 feed.ts 硬编码同值 PER_PAGE=100——full 下两常量同 diff 可见，delta 下靠 search（词法 DRY 行为指令）救援
// full 口径 = S0→S2（merge-base..head，全量审查输入）；repo 快照恒为 head 态（生产 zipball 同口径）
export default {
  id: "inc-04-const-dry-full",
  kind: "bug",
  source: "incremental",
  description: "增量对照 full：C 行变体（跨文件常量 DRY）",
  diff: `diff --git a/src/limits.ts b/src/limits.ts
--- a/src/limits.ts
+++ b/src/limits.ts
@@ -1 +1,2 @@
 export const DEFAULT_TIMEOUT_MS = 5_000
+export const MAX_PAGE_SIZE = 100
diff --git a/src/feed.ts b/src/feed.ts
--- a/src/feed.ts
+++ b/src/feed.ts
@@ -1,3 +1,5 @@
-export function firstItems<T>(items: T[]): T[] {
-  return items.slice(0, 10)
+const PER_PAGE = 100
+
+export function pageItems<T>(items: T[]): T[] {
+  return items.slice(0, PER_PAGE)
 }`,
    expect: [
    {
      "file": "src/feed.ts",
      "line": 1,
      "mustMention": [
        "重复", "既有", "常量", "同步", "两处", "硬编码", "已定义", "复用"
      ]
    }
  ],
  repo: {
    "src/limits.ts": "export const DEFAULT_TIMEOUT_MS = 5_000\nexport const MAX_PAGE_SIZE = 100\n",
    "src/feed.ts": "const PER_PAGE = 100\n\nexport function pageItems<T>(items: T[]): T[] {\n  return items.slice(0, PER_PAGE)\n}\n",
    "src/paging.ts": "export function totalPages(count: number, perPage: number): number {\n  return Math.ceil(count / perPage)\n}\n",
    "src/scroll.ts": "export function scrollStep(lines: number[]): number {\n  return lines.length\n}\n"
  },
} satisfies EvalCase;
