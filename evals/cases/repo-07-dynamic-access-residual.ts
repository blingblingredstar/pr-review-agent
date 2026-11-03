import type { EvalCase } from "../score.ts";

// D031 repo fixture：命令注册表键改名 build → compile（动态访问 handlers[cmd]），未触及文件
// src/cli/main.ts 的 DEFAULT_CMD = "build" 残留旧键——编译器与类型检查都抓不住。
// 搜索 "build" 会有正常噪音（无），期望意见锚在 diff 内改键行，mustMention 指向 diff 外的调用方。
// 诱饵：src/commands/builder.ts（路径像答案，内容无 "build" 子串）
export default {
  id: "repo-07-dynamic-access-residual",
  kind: "linked",
  source: "repo",
  description: "注册表字符串键改名，动态访问方残留旧键（tsc 抓不住型：动态访问）",
  diff: `diff --git a/src/commands/registry.ts b/src/commands/registry.ts
index aa0b0c0..bb1c2d3 100644
--- a/src/commands/registry.ts
+++ b/src/commands/registry.ts
@@ -1,5 +1,5 @@
 // 命令注册表：键是 CLI 子命令名
 export const handlers = {
-  build: () => import("./compile.ts"),
+  compile: () => import("./compile.ts"),
   test: () => import("./test-run.ts"),
 };
`,
  repo: {
    "README.md": "# demo-app\n\n报告生成与命令行工具。\n",
    "src/commands/registry.ts": `// 命令注册表：键是 CLI 子命令名
export const handlers = {
  compile: () => import("./compile.ts"),
  test: () => import("./test-run.ts"),
};
`,
    "src/commands/compile.ts": `export function run(): void {
  console.info("compiling project");
}
`,
    "src/commands/test-run.ts": `export function run(): void {
  console.info("running tests");
}
`,
    "src/commands/builder.ts": `// 组装发布产物的工具（manifest 校验），不是命令处理器
export function assembleManifest(files: string[]): string[] {
  return files.filter((f) => !f.endsWith(".map"));
}
`,
    "src/cli/main.ts": `import { handlers } from "../commands/registry.ts";

const DEFAULT_CMD = "build";

export function dispatch(argv: string[]): void {
  const cmd = argv[0] ?? DEFAULT_CMD;
  handlers[cmd]?.();
}
`,
  },
  expect: [
    {
      file: "src/commands/registry.ts",
      line: 3,
      mustMention: ["main.ts"],
    },
  ],
} satisfies EvalCase;
