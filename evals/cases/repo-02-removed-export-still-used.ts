import type { EvalCase } from "../score.ts";

// D031 repo fixture：删除导出常量 MAX_QUEUE_DEPTH，未触及文件 src/queue/publisher.ts 仍 import 使用。
// 期望意见锚在 diff 内的删除位置，正文指向 diff 外的使用方。诱饵：src/config/retention.ts
// （同为配置文件，内容无该符号）
export default {
  id: "repo-02-removed-export-still-used",
  kind: "linked",
  source: "repo",
  description: "删除导出常量，未触及文件仍引用（第三层盲区：搜索已删符号）",
  diff: `diff --git a/src/config/limits.ts b/src/config/limits.ts
index 1111111..2222222 100644
--- a/src/config/limits.ts
+++ b/src/config/limits.ts
@@ -1,5 +1,4 @@
 // 共享限额配置
 export const MAX_BATCH = 100;
-export const MAX_QUEUE_DEPTH = 32;
 export const REQUEST_TIMEOUT_MS = 8_000;
 export const RETRY_LIMIT = 3;
`,
  repo: {
    "README.md": "# demo-app\n\n报告生成与命令行工具。\n",
    "src/config/limits.ts": `// 共享限额配置
export const MAX_BATCH = 100;
export const REQUEST_TIMEOUT_MS = 8_000;
export const RETRY_LIMIT = 3;
`,
    "src/config/retention.ts": `// 日志保留期配置（与队列无关）
export const LOG_RETENTION_DAYS = 30;
`,
    "src/queue/publisher.ts": `import { MAX_QUEUE_DEPTH } from "../config/limits.ts";

export function queueDepth(): number {
  return MAX_QUEUE_DEPTH;
}
`,
  },
  expect: [
    {
      file: "src/config/limits.ts",
      line: 3,
      mustMention: ["publisher.ts"],
    },
  ],
} satisfies EvalCase;
