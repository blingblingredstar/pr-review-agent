import type { EvalCase } from "../score.ts";

// D031 repo fixture：事件名字符串字面量 "sync:done" → "sync:complete"，编译器查不出的漏改——
// 未触及文件 src/ui/progress.ts 仍监听旧字符串键。期望意见锚在 diff 内改动行，mustMention 指向
// diff 外的监听方。诱饵：src/ui/widgets.ts（同为 ui 文件，无该字符串）
export default {
  id: "repo-04-string-key-residual",
  kind: "linked",
  source: "repo",
  description: "事件字符串键改名，未触及文件的监听方残留旧键（tsc 抓不住型：字符串键）",
  diff: `diff --git a/src/events/bus.ts b/src/events/bus.ts
index 2b2c2d2..3c3d3e3 100644
--- a/src/events/bus.ts
+++ b/src/events/bus.ts
@@ -1,3 +1,3 @@
 // 事件名常量（广播同步结果）
-export const EVT_SYNC_DONE = "sync:done";
+export const EVT_SYNC_DONE = "sync:complete";
 export const EVT_TICK = "tick";
`,
  repo: {
    "README.md": "# demo-app\n\n报告生成与命令行工具。\n",
    "src/events/bus.ts": `// 事件名常量（广播同步结果）
export const EVT_SYNC_DONE = "sync:complete";
export const EVT_TICK = "tick";
`,
    "src/events/hub.ts": `type Handler = (payload: unknown) => void;
const handlers = new Map<string, Handler[]>();

export function getBus() {
  return {
    on(name: string, cb: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), cb]);
    },
  };
}
`,
    "src/ui/progress.ts": `import { getBus } from "../events/hub.ts";

// 进度条监听同步完成（事件名是字符串约定，编译器查不出来）
getBus().on("sync:done", () => {
  setDone(100);
});

function setDone(pct: number): void {
  console.info(\`progress \${pct}%\`);
}
`,
    "src/ui/widgets.ts": `// 面板小部件（与同步事件无关）
export function renderPanel(title: string): string {
  return \`[panel] \${title}\`;
}
`,
  },
  expect: [
    {
      file: "src/events/bus.ts",
      line: 2,
      mustMention: ["progress.ts"],
    },
  ],
} satisfies EvalCase;
