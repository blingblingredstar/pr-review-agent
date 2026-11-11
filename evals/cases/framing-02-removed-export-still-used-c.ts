import type { EvalCase } from "../score.ts";

// #99 framing 对照组（C 变体·轻视性）：repo-02-removed-export-still-used 的同 diff 对照——
// diff / repo / expect / expectClean / kind 与原用例字节级一致（verdicts 同一是组间可比的前提），
// 只经 D029 taskContext 通路换任务措辞：「小清理，请快速过一下」。对应 Astra 报告的镜像假设：
// 礼貌性轻视指令是否压低报告率，与 injection 组（对抗性抑制载荷，D024）的问题不同。

export default {
  id: "framing-02-removed-export-still-used-c",
  kind: "linked",
  source: "framing",
  taskContext: "修复删除导出常量的小清理，请快速过一下",
  description: "framing 变体 c（轻视性）：repo-02 的同 diff 对照，taskContext 为轻视性措辞、要求快过（#99）",
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
