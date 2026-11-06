import type { EvalCase } from "../score.ts";

// ctxpair 双联组（#80，合成包 token-broker）：1 条 structural（diff 内可发现）+ 1 条 convention（约定在 diff 外非触及文件）
// structural：checkRevocation 对 Map.get 的返回值直接访问 .revoked（jti 不在表内时 TypeError）
// convention：auditDump 裸用 console.log 输出——违反 docs/observability.md（非触及文件）的
//   「src/ 下日志一律经由 createLogger(module)」约定；无约定上下文时 diff-only 结构性看不出违规
// 防循环性核对（#80 闸门 3，逐条）：convention 条目 mustMention「门面 / 统一日志 / 裸调 / 绕过」
//   均不在 docs/observability.md 逐字出现（文档用「createLogger(module)」「console.*」「一律经由」表述）；测试有机械弱断言同查
// 诱饵：src/broker/introspect-cache.ts（路径像内省答案文件，纯缓存无输出逻辑）；镜证：src/broker/grant.ts 走 createLogger（既有代码佐证约定）
export default {
  id: "ctx-02-log-facade-token",
  kind: "linked",
  source: "ctxpair",
  description: "日志出口约定被新导出绕过（createLogger 门面，diff-only 不可见）+ Map.get 结果未判空",
  diff: `diff --git a/src/broker/introspect.ts b/src/broker/introspect.ts
index 4b5c6d7..8e9f0a1 100644
--- a/src/broker/introspect.ts
+++ b/src/broker/introspect.ts
@@ -11,3 +11,18 @@
 export function summarize(result: Introspection): string {
   return result.active ? \`active:\${result.scope ?? "-"}\` : "inactive";
 }
+
+const issued = new Map<string, { revoked: boolean }>();
+
+export function checkRevocation(jti: string): boolean {
+  const rec = issued.get(jti);
+  if (rec.revoked) {
+    log.info("revoked token seen", { jti });
+    return true;
+  }
+  return false;
+}
+
+export function auditDump(result: Introspection): void {
+  console.log("introspection", JSON.stringify(result));
+}
`,
  repo: {
    "docs/observability.md": `# token-broker 可观测性约定

src/ 下新增代码输出日志一律经由 createLogger(module)（实现见 src/log/facade.ts，字段结构以该模块为准）；
console.* 仅限 scripts/ 目录使用。
`,
    "src/log/facade.ts": `// 结构化日志出口：字段结构与输出通道集中在这里
export type Logger = {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
};

const sink: string[] = [];

export function createLogger(module: string): Logger {
  return {
    info: (msg, fields) => {
      sink.push(\`[\${module}] \${msg} \${JSON.stringify(fields ?? {})}\`);
    },
    warn: (msg, fields) => {
      sink.push(\`[\${module}] WARN \${msg} \${JSON.stringify(fields ?? {})}\`);
    },
  };
}
`,
    "src/broker/grant.ts": `// 授权签发（日志按约定走 facade）
import { createLogger } from "../log/facade.ts";

const log = createLogger("broker.grant");

export function grantQuota(subject: string): void {
  log.info("quota granted", { subject });
}
`,
    "src/broker/introspect-cache.ts": `// 内省结果的读缓存统计（不含任何输出逻辑）
const cache = new Map<string, number>();

export function recordLookup(key: string): void {
  cache.set(key, (cache.get(key) ?? 0) + 1);
}
`,
    "src/broker/introspect.ts": `// 令牌内省（业务侧封装）
import { createLogger } from "../log/facade.ts";

const log = createLogger("broker.introspect");

export type Introspection = {
  active: boolean;
  scope: string | null;
};

export function summarize(result: Introspection): string {
  return result.active ? \`active:\${result.scope ?? "-"}\` : "inactive";
}

const issued = new Map<string, { revoked: boolean }>();

export function checkRevocation(jti: string): boolean {
  const rec = issued.get(jti);
  if (rec.revoked) {
    log.info("revoked token seen", { jti });
    return true;
  }
  return false;
}

export function auditDump(result: Introspection): void {
  console.log("introspection", JSON.stringify(result));
}
`,
  },
  expect: [
    {
      file: "src/broker/introspect.ts",
      line: 19,
      mustMention: ["undefined", "判空", "空值", "不存在", "未找到"],
      kind: "structural",
    },
    {
      file: "src/broker/introspect.ts",
      line: 27,
      mustMention: ["门面", "统一日志", "裸调", "绕过"],
      kind: "convention",
    },
  ],
} satisfies EvalCase;
