import type { EvalCase } from "../score.ts";

// address 改为可空后，新函数 cityOf 直接访问 .city；同文件既有函数有 if (!user.address) 守卫
export default {
  id: "bug-03-null-access",
  kind: "bug",
  source: "synthetic",
  description: "address 类型改为 Address | null 后新函数未判空直接访问",
  diff: `diff --git a/src/ship.ts b/src/ship.ts
index 3d4e5f6..7a8b9c0 100644
--- a/src/ship.ts
+++ b/src/ship.ts
@@ -15,7 +15,7 @@ interface Address {
 interface User {
   id: string;
   name: string;
-  address?: Address;
+  address: Address | null;
 }
 
 export function shippingLabel(user: User): string {
@@ -24,5 +24,9 @@ export function shippingLabel(user: User): string {
   if (!user.address) {
     return "地址缺失";
   }
   return \`\${user.name} — \${user.address.zip}\`;
 }
+
+export function cityOf(user: User): string {
+  return user.address.city;
+}
`,
  expect: [
    {
      file: "src/ship.ts",
      line: 31,
      mustMention: ["null", "判空", "空值", "undefined", "可能为", "缺失", "守卫", "可选"],
    },
  ],
} satisfies EvalCase;
