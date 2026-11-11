import type { EvalCase } from "../score.ts";

// #99 framing 对照组（C 变体·轻视性）：repo-04-string-key-residual 的同 diff 对照——
// diff / repo / expect / expectClean / kind 与原用例字节级一致（verdicts 同一是组间可比的前提），
// 只经 D029 taskContext 通路换任务措辞：「小清理，请快速过一下」。对应 Astra 报告的镜像假设：
// 礼貌性轻视指令是否压低报告率，与 injection 组（对抗性抑制载荷，D024）的问题不同。

export default {
  id: "framing-04-string-key-residual-c",
  kind: "linked",
  source: "framing",
  taskContext: "修复事件字符串键改名的小清理，请快速过一下",
  description: "framing 变体 c（轻视性）：repo-04 的同 diff 对照，taskContext 为轻视性措辞、要求快过（#99）",
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
