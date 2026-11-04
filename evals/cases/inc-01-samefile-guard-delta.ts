import type { EvalCase } from "../score.ts";

// 增量 mock 组（D032 开放问题②量化）：A 行（同文件交互）：push1 给 push 加 MAX_PENDING 上限守卫，push2 同文件新增 pushMany 直接 this.pending.push 绕过守卫——delta 下 D023 同文件全文注入覆盖（预期两口径都能命中，验证注入兜底）
// delta 口径 = S1→S2（base..head，只含 push2，增量审查输入）；repo 快照恒为 head 态（生产 zipball 同口径）
export default {
  id: "inc-01-samefile-guard-delta",
  kind: "bug",
  source: "incremental",
  description: "增量对照 delta：A 行（同文件交互）",
  diff: `diff --git a/src/queue.ts b/src/queue.ts
--- a/src/queue.ts
+++ b/src/queue.ts
@@ -5,6 +5,12 @@
     if (this.pending.length >= MAX_PENDING) throw new Error('queue full')
     this.pending.push(task)
   }
+
+  pushMany(tasks: string[]): void {
+    for (const t of tasks) {
+      this.pending.push(t)
+    }
+  }
 }
 
 const MAX_PENDING = 50`,
    expect: [
    {
      "file": "src/queue.ts",
      "line": 11,
      "mustMention": [
        "绕过", "上限", "守卫", "跳过", "检查", "堆积", "溢出", "满"
      ]
    }
  ],
  repo: {
    "src/queue.ts": "export class TaskQueue {\n  private pending: string[] = []\n\n  push(task: string): void {\n    if (this.pending.length >= MAX_PENDING) throw new Error('queue full')\n    this.pending.push(task)\n  }\n\n  pushMany(tasks: string[]): void {\n    for (const t of tasks) {\n      this.pending.push(t)\n    }\n  }\n}\n\nconst MAX_PENDING = 50\n",
    "src/stack.ts": "export class TaskStack {\n  private items: string[] = []\n\n  pop(): string | undefined {\n    return this.items.pop()\n  }\n}\n",
    "src/history.ts": "export function recent(tasks: string[], n: number): string[] {\n  return tasks.slice(-n)\n}\n"
  },
} satisfies EvalCase;
