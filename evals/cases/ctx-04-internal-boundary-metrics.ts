import type { EvalCase } from "../score.ts";

// ctxpair 双联组（#80，合成包 metrics-kit）：1 条 structural（diff 内可发现）+ 1 条 convention（约定在 diff 外非触及文件）
// structural：totalWeight 的 reduce 无初始值——rows 为空时直接抛 TypeError（bug-10 同族形态，新场景：报表权重聚合）
// convention：路由汇总模块直接 import ../internal/counters.ts——违反 docs/boundaries.md（非触及文件）的
//   「对外能力必须经 src/public-api.ts 转出」边界约定；diff 内无 public-api 线索，diff-only 结构性看不出违规
//   （ctx 臂可从文件树看到 public-api.ts 与 internal/ 的分层线索，正是被度量的增量）
// 防循环性核对（#80 闸门 3，逐条）：convention 条目 mustMention「边界 / 越界 / 封装 / 不该 / 对外暴露」
//   均不在 docs/boundaries.md 逐字出现（文档用「包私有实现」「转出」「不得直接引用」表述）；测试有机械弱断言同查
// 诱饵：src/report/format.ts（同为 report 面模块，与计数链路无关）；镜证：src/public-api.ts（转出层本体）
export default {
  id: "ctx-04-internal-boundary-metrics",
  kind: "linked",
  source: "ctxpair",
  description: "internal 模块边界约定被新导入绕过（public-api 转出，diff-only 不可见）+ reduce 无初始值空数组抛错",
  diff: `diff --git a/src/report/summary.ts b/src/report/summary.ts
index 6f7a8b9..0c1d2e3 100644
--- a/src/report/summary.ts
+++ b/src/report/summary.ts
@@ -1,3 +1,5 @@
+import { bump as rawBump, rawCounter } from "../internal/counters.ts";
+
 // 报表汇总
 export type SummaryRow = {
   label: string;
@@ -9,3 +11,12 @@
 export function renderRow(row: SummaryRow): string {
   return \`\${row.label}: \${row.weight}\`;
 }
+
+export function totalWeight(rows: SummaryRow[]): number {
+  const counter = rawCounter("report.weight");
+  for (const r of rows) {
+    rawBump(counter, r.weight);
+  }
+  const avg = rows.reduce((acc, r) => acc + r.weight) / Math.max(rows.length, 1);
+  return counter.value + avg;
+}
`,
  repo: {
    "docs/boundaries.md": `# metrics-kit 目录职责说明

src/internal/ 目录为包私有实现；对外能力必须经 src/public-api.ts 转出，其他目录不得直接引用 internal 下的文件。
`,
    "src/internal/counters.ts": `// 包私有计数器实现（仅供 public-api 转出）
export type Counter = {
  name: string;
  value: number;
};

export function rawCounter(name: string): Counter {
  return { name, value: 0 };
}

export function bump(c: Counter, by = 1): void {
  c.value += by;
}
`,
    "src/public-api.ts": `// 对外唯一出口：internal 能力经此转出
export { rawCounter, bump, type Counter } from "./internal/counters.ts";
`,
    "src/report/format.ts": `// 报表文本排版（与计数链路无关）
export function pad(label: string, width: number): string {
  return label.padEnd(width, " ");
}
`,
    "src/report/summary.ts": `import { bump as rawBump, rawCounter } from "../internal/counters.ts";

// 报表汇总
export type SummaryRow = {
  label: string;
  weight: number;
};

export function renderRow(row: SummaryRow): string {
  return \`\${row.label}: \${row.weight}\`;
}

export function totalWeight(rows: SummaryRow[]): number {
  const counter = rawCounter("report.weight");
  for (const r of rows) {
    rawBump(counter, r.weight);
  }
  const avg = rows.reduce((acc, r) => acc + r.weight) / Math.max(rows.length, 1);
  return counter.value + avg;
}
`,
  },
  expect: [
    {
      file: "src/report/summary.ts",
      line: 18,
      mustMention: ["初始值", "空数组", "reduce", "TypeError"],
      kind: "structural",
    },
    {
      file: "src/report/summary.ts",
      line: 1,
      mustMention: ["边界", "越界", "封装", "不该", "对外暴露"],
      kind: "convention",
    },
  ],
} satisfies EvalCase;
