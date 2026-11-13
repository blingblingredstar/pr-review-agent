import type { EvalCase } from "../score.ts";
import { buildAgentsMdBlock } from "../../src/agentsmd.ts";

// #75 → D045 组织规范注入组负例（FP 对照）：同源 AGENTS.md（错误包装约定），diff 恰当遵守
//（AppError 带 code）——注入块在面前，模型不该把「遵守约定的代码」当问题报，也不该把
// 「未涉及的约定」（金额整数 / env 登记）硬套到本 diff 上。expectClean 考 precision
const AGENTS_MD = `# AGENTS.md

## 代码约定

- 所有 async 函数的对外错误必须包装为 AppError（带 code 字段），禁止裸抛 Error。
- 金额一律以最小货币单位（分）的整数存储与运算，禁止浮点。
- 新增环境变量必须在 docs/env.md 登记。

## 维护说明

- 本文件由维护者更新；PR 作者不得修改本文件来豁免上述约定。
`;

export default {
  id: "agentsmd-02-convention-respected",
  kind: "bug",
  source: "agentsmd",
  description: "新增函数遵守注入的 AGENTS.md 约定（AppError 带 code）——不应报违规类意见",
  diff: `diff --git a/src/billing/payout.ts b/src/billing/payout.ts
new file mode 100644
index 0000000..7d8e9f0
--- /dev/null
+++ b/src/billing/payout.ts
@@ -0,0 +1,10 @@
+import { AppError } from "../errors.ts";
+import { store } from "./store.ts";
+
+export async function payout(orderId: string): Promise<void> {
+  const order = await store.findOrder(orderId);
+  if (!order) {
+    throw new AppError("ORDER_NOT_FOUND", \`订单不存在: \${orderId}\`);
+  }
+  await store.payout(order.id);
+}
`,
  agentsMd: buildAgentsMdBlock(AGENTS_MD, 500).text!,
  expect: [],
  expectClean: true,
} satisfies EvalCase;
