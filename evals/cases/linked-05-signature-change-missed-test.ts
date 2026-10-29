import type { EvalCase } from "../score.ts";

// shippingFee 加了第三个必填参数，test 里「长距离」用例还是两参调用（在上下文可见）
export default {
  id: "linked-05-signature-change-missed-test",
  kind: "linked",
  description: "函数签名加必填参数，同 PR 的测试文件有一个用例未同步",
  diff: `diff --git a/src/shipping.ts b/src/shipping.ts
index 3c4d5e6..7d8e9f0 100644
--- a/src/shipping.ts
+++ b/src/shipping.ts
@@ -7,6 +7,6 @@
 
 // 运费 = 基础 + 重量 + 距离，加急另计
-export function shippingFee(weightKg: number, distanceKm: number): number {
+export function shippingFee(weightKg: number, distanceKm: number, express: boolean): number {
   const base = 500;
   const weightPart = Math.ceil(weightKg) * 100;
   const distancePart = Math.ceil(distanceKm / 10) * 50;
diff --git a/test/shipping.test.ts b/test/shipping.test.ts
index 4d5e6f7..8e9f0a1 100644
--- a/test/shipping.test.ts
+++ b/test/shipping.test.ts
@@ -3,9 +3,13 @@ import { test } from "node:test";
 import { shippingFee } from "../src/shipping.ts";
 
 test("短途小额", () => {
-  assert.equal(shippingFee(1, 5), 650);
+  assert.equal(shippingFee(1, 5, false), 650);
 });
 
 test("长距离", () => {
   assert.equal(shippingFee(2, 30), 1000);
 });
+
+test("加急", () => {
+  assert.equal(shippingFee(1, 5, true), 1650);
+});
`,
  expect: [
    {
      file: ["test/shipping.test.ts", "src/shipping.ts"],
      line: null,
      mustMention: ["shippingfee", "签名", "参数", "express", "调用", "漏", "未同步", "没有更新"],
    },
  ],
} satisfies EvalCase;
