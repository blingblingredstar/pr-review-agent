import type { EvalCase } from "../score.ts";

// 删掉空数组守卫后，events[-1].state 在空输入时抛 TypeError；firstStatus 的可选链写法可对照
export default {
  id: "bug-07-last-element-empty",
  kind: "bug",
  source: "synthetic",
  description: "删除空数组守卫后 events[-1] 为 undefined，访问 .state 抛错",
  diff: `diff --git a/src/status.ts b/src/status.ts
index 9f0a1b2..3a4b5c6 100644
--- a/src/status.ts
+++ b/src/status.ts
@@ -12,9 +12,6 @@ interface StatusEvent {
   return events[0]?.state ?? null;
 }
 
 export function latestStatus(events: StatusEvent[]): string | null {
-  if (events.length === 0) {
-    return null;
-  }
   return events[events.length - 1].state;
 }
`,
  expect: [
    {
      file: "src/status.ts",
      line: 16,
      mustMention: ["空数组", "-1", "undefined", "守卫", "判空", "length", "抛"],
    },
  ],
} satisfies EvalCase;
