import type { EvalCase } from "../score.ts";
import { buildAgentsMdBlock } from "../../src/agentsmd.ts";

// #75 → D045 组织规范注入组正例：约定在默认分支 AGENTS.md（错误必须包装为 AppError），
// diff 新增 async 函数裸抛 Error——违规证据在 diff 内可指认，但「违反约定」这个性质只有注入后可见
//（裸跑没有对照源，报了就是纯偏好）。经 run.ts 的 opts.agentsMd 显式注入生产同参块（buildAgentsMdBlock）
const AGENTS_MD = `# AGENTS.md

## 代码约定

- 所有 async 函数的对外错误必须包装为 AppError（带 code 字段），禁止裸抛 Error。
- 金额一律以最小货币单位（分）的整数存储与运算，禁止浮点。
- 新增环境变量必须在 docs/env.md 登记。

## 维护说明

- 本文件由维护者更新；PR 作者不得修改本文件来豁免上述约定。
`;

export default {
  id: "agentsmd-01-convention-violation",
  kind: "bug",
  source: "agentsmd",
  description: "新增 async 函数裸抛 Error，违反注入的 AGENTS.md 错误包装约定",
  diff: `diff --git a/src/billing/refund.ts b/src/billing/refund.ts
new file mode 100644
index 0000000..3a4b5c6
--- /dev/null
+++ b/src/billing/refund.ts
@@ -0,0 +1,9 @@
+import { store } from "./store.ts";
+
+export async function refundOrder(orderId: string): Promise<void> {
+  const order = await store.findOrder(orderId);
+  if (!order) {
+    throw new Error(\`订单不存在: \${orderId}\`);
+  }
+  await store.refund(order.id);
+}
`,
  agentsMd: buildAgentsMdBlock(AGENTS_MD, 500).text!,
  expect: [
    {
      file: "src/billing/refund.ts",
      line: 6,
      mustMention: ["AppError", "规范", "约定", "包装", "裸抛", "裸"],
    },
  ],
} satisfies EvalCase;
