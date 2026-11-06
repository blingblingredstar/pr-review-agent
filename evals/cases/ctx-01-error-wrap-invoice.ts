import type { EvalCase } from "../score.ts";

// ctxpair 双联组（#80，合成包 invoice-svc）：1 条 structural（diff 内可发现）+ 1 条 convention（约定在 diff 外非触及文件）
// structural：notifyOverdue 调用 async 的 pushNotice 未 await（callee 的 async 就在同块上方声明，diff 内自证）
// convention：dumpInvoiceForAudit 直接抛原生 Error、放任 JSON.parse 的 SyntaxError 越过模块边界——
//   违反 docs/conventions.md（非触及文件）的错误转译约定；无约定上下文时 diff-only 结构性看不出问题
// 防循环性核对（#80 闸门 3，逐条）：convention 条目 mustMention「包装 / 统一错误 / errors.ts / 原生 / 裸抛」
//   均不在 docs/conventions.md 逐字出现（文档用「转成 AppError」「携带 failedOperation」「异常对象」表述）；测试有机械弱断言同查
// 诱饵：src/lib/rate-limit.ts（同为 lib 工具文件，与错误处理无关）；镜证：src/lib/errors.ts 定义 AppError（既有代码佐证约定）
export default {
  id: "ctx-01-error-wrap-invoice",
  kind: "linked",
  source: "ctxpair",
  description: "错误转译约定被新导出绕过（AppError 包装，diff-only 不可见）+ async 通知未 await",
  diff: `diff --git a/src/invoice/audit-export.ts b/src/invoice/audit-export.ts
index 1a1b1c1..2a2b2c2 100644
--- a/src/invoice/audit-export.ts
+++ b/src/invoice/audit-export.ts
@@ -7,3 +7,12 @@
 export function toCsv(records: AuditRecord[]): string {
   return records.map((r) => r.lines.join(",")).join("\\n");
 }
+
+export async function dumpInvoiceForAudit(id: string): Promise<unknown> {
+  const res = await fetch(\`https://billing.internal/invoices/\${id}/audit\`);
+  if (!res.ok) {
+    throw new Error(\`audit fetch failed: HTTP \${res.status}\`);
+  }
+  const text = await res.text();
+  return JSON.parse(text);
+}
diff --git a/src/invoice/notify.ts b/src/invoice/notify.ts
index 3d4e5f6..7a8b9c0 100644
--- a/src/invoice/notify.ts
+++ b/src/invoice/notify.ts
@@ -4,3 +4,11 @@
 export function overdueCount(invoices: { due: boolean }[]): number {
   return invoices.filter((i) => i.due).length;
 }
+
+async function pushNotice(invoiceId: string): Promise<void> {
+  await deliver(\`invoice \${invoiceId} overdue\`);
+}
+
+export async function notifyOverdue(invoiceId: string): Promise<void> {
+  pushNotice(invoiceId);
+}
`,
  repo: {
    "docs/conventions.md": `# invoice-svc 仓库约定

## 错误处理
跨模块边界的失败必须先转成本仓库的 AppError 再向上抛（构造时携带 failedOperation 字段标明出处），
底层异常对象不得直接越过模块边界。
`,
    "src/lib/errors.ts": `// 仓库统一错误类型（约定文档的落地实现）
export class AppError extends Error {
  constructor(
    message: string,
    readonly failedOperation: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AppError";
  }
}
`,
    "src/lib/mailer.ts": `// 邮件投递底层（通道适配器在此实现）
export async function deliver(body: string): Promise<void> {
  // 演示实现：投递即成功
}
`,
    "src/lib/rate-limit.ts": `// 令牌桶限速（与错误处理路径无关的工具）
export class TokenBucket {
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {}

  tryTake(n = 1): boolean {
    return n <= this.capacity;
  }
}
`,
    "src/invoice/audit-export.ts": `// 审计导出（本模块只管拼装导出数据）
export type AuditRecord = {
  invoiceId: string;
  lines: string[];
};

export function toCsv(records: AuditRecord[]): string {
  return records.map((r) => r.lines.join(",")).join("\\n");
}

export async function dumpInvoiceForAudit(id: string): Promise<unknown> {
  const res = await fetch(\`https://billing.internal/invoices/\${id}/audit\`);
  if (!res.ok) {
    throw new Error(\`audit fetch failed: HTTP \${res.status}\`);
  }
  const text = await res.text();
  return JSON.parse(text);
}
`,
    "src/invoice/notify.ts": `// 逾期通知编排
import { deliver } from "../lib/mailer.ts";

export function overdueCount(invoices: { due: boolean }[]): number {
  return invoices.filter((i) => i.due).length;
}

async function pushNotice(invoiceId: string): Promise<void> {
  await deliver(\`invoice \${invoiceId} overdue\`);
}

export async function notifyOverdue(invoiceId: string): Promise<void> {
  pushNotice(invoiceId);
}
`,
  },
  expect: [
    {
      file: "src/invoice/notify.ts",
      line: 13,
      mustMention: ["await", "未等待", "异步", "竞态"],
      kind: "structural",
    },
    {
      file: "src/invoice/audit-export.ts",
      line: 14,
      mustMention: ["包装", "统一错误", "errors.ts", "原生", "裸抛"],
      kind: "convention",
    },
  ],
} satisfies EvalCase;
