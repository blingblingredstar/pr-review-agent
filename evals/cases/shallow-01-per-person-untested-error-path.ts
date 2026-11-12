import type { EvalCase } from "../score.ts";

// #138 浅测试 aspect 正例：perPerson 带 people<=0 抛错分支（错误路径，行为正确无可挑剔），
// 同 PR 的新测试只覆盖 happy path——期望锚在新增测试行上、点名未触达分支；
// 「覆盖率低」类无锚定措辞不算命中（mustMention 全部要求具体分支/未测语义）
export default {
  id: "shallow-01-per-person-untested-error-path",
  kind: "bug",
  source: "synthetic",
  description: "新增函数带抛错分支，同 PR 的新测试只覆盖 happy path，错误分支零触达",
  diff: `diff --git a/src/billing.ts b/src/billing.ts
new file mode 100644
index 0000000..3a4b5c6
--- /dev/null
+++ b/src/billing.ts
@@ -0,0 +1,4 @@
+export function perPerson(total: number, people: number): number {
+  if (people <= 0) throw new RangeError("人数必须大于 0");
+  return total / people;
+}
diff --git a/test/billing.test.ts b/test/billing.test.ts
new file mode 100644
index 0000000..7d8e9f0
--- /dev/null
+++ b/test/billing.test.ts
@@ -0,0 +1,8 @@
+import { describe, it, expect } from "vitest";
+import { perPerson } from "../src/billing.ts";
+
+describe("perPerson", () => {
+  it("按人数均摊", () => {
+    expect(perPerson(120, 4)).toBe(30);
+  });
+});
`,
  expect: [
    {
      file: "test/billing.test.ts",
      line: 5,
      mustMention: ["除零", "抛", "异常", "RangeError", "分支", "边界", "未覆盖", "未测", "没有覆盖", "没有用例", "缺用例"],
    },
  ],
} satisfies EvalCase;
