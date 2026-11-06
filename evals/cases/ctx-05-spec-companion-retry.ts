import type { EvalCase } from "../score.ts";

// ctxpair 双联组（#80，合成包 relay-svc）：1 条 structural（diff 内可发现）+ 1 条 convention（约定在 diff 外非触及文件）
// structural：describeAttempt 用 replace 替换模板占位——模板里有两处 %s 只换了第一处，total 保持字面量（bug-09 同族形态，新场景）
// convention：新增导出文件 src/retry/backoff.ts 没有同名 .spec.ts 伴随文件——违反 TESTING.md（非触及文件）的
//   「新增导出文件都要有同名 .spec.ts 伴随」交付约定；约定本身 diff-only 不可见，bare 臂连文件树都没有，
//   ctx 臂至少能从文件树看到 limiter/clock 的「模块+spec 成对」模式而本模块缺席（被度量的增量）
// 防循环性核对（#80 闸门 3，逐条）：convention 条目 mustMention「单测 / 用例 / 覆盖 / 配套」
//   均不在 TESTING.md 与诱饵 notes.md 逐字出现（文档用「.spec.ts 伴随文件」「交付规约」表述）；测试有机械弱断言同查
// 诱饵：src/retry/notes.md（模块内 md，路径像约定文档但无交付要求）；镜证：src/retry/limiter{,.spec}.ts、src/util/clock{,.spec}.ts（成对模式佐证）
export default {
  id: "ctx-05-spec-companion-retry",
  kind: "linked",
  source: "ctxpair",
  description: "新增导出文件缺同名 .spec.ts 伴随（交付约定，diff-only 不可见）+ 模板占位只替换第一处",
  diff: `diff --git a/src/retry/backoff.ts b/src/retry/backoff.ts
new file mode 100644
index 0000000..1d2e3f4
--- /dev/null
+++ b/src/retry/backoff.ts
@@ -0,0 +1,13 @@
+// 退避重试（本 PR 新增模块）
+export const BASE_DELAY_MS = 200;
+export const MAX_DELAY_MS = 8_000;
+
+export function nextDelay(attempt: number): number {
+  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
+}
+
+const ATTEMPT_TEMPLATE = "[relay] attempt %s of %s failed";
+
+export function describeAttempt(n: number, total: number): string {
+  return ATTEMPT_TEMPLATE.replace("%s", String(n));
+}
`,
  repo: {
    "TESTING.md": `# relay-svc 交付规约

src/ 下每个新增导出文件都要有同名 .spec.ts 伴随文件（同目录），缺伴随文件的改动不得合入。
`,
    "src/retry/notes.md": `# retry 模块笔记

退避参数的调优记录与历史讨论链接，与交付检查无关。
`,
    "src/retry/limiter.ts": `// 并发闸（既有模块：与 spec 同目录同名成对）
export class Limiter {
  constructor(private readonly max: number) {}

  admit(n: number): boolean {
    return n <= this.max;
  }
}
`,
    "src/retry/limiter.spec.ts": `// Limiter 的伴随 spec
import { Limiter } from "./limiter.ts";

new Limiter(2).admit(3) === false;
`,
    "src/util/clock.ts": `// 时钟（既有模块：与 spec 成对）
export function nowMs(): number {
  return Date.now();
}
`,
    "src/util/clock.spec.ts": `// Clock 的伴随 spec
import { nowMs } from "./clock.ts";

typeof nowMs() === "number";
`,
    "src/retry/backoff.ts": `// 退避重试（本 PR 新增模块）
export const BASE_DELAY_MS = 200;
export const MAX_DELAY_MS = 8_000;

export function nextDelay(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

const ATTEMPT_TEMPLATE = "[relay] attempt %s of %s failed";

export function describeAttempt(n: number, total: number): string {
  return ATTEMPT_TEMPLATE.replace("%s", String(n));
}
`,
  },
  expect: [
    {
      file: "src/retry/backoff.ts",
      line: 12,
      mustMention: ["只替换", "第一个", "replaceAll", "两处"],
      kind: "structural",
    },
    {
      file: "src/retry/backoff.ts",
      line: 1,
      mustMention: ["单测", "用例", "覆盖", "配套"],
      kind: "convention",
    },
  ],
} satisfies EvalCase;
