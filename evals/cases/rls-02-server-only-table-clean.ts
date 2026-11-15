import type { EvalCase } from "../score.ts";

// #171 数据库访问控制 aspect 负例（FP 对照）：迁移建表未启用 RLS，但访问方是服务端
// service role 连接（凭据不出服务端，行级安全不构成防线）——正是规则否定面
// 「客户端直连迹象不存在时不适用」的场景，期望零意见（expectClean）；
// 把它当 RLS 缺失报出来 = FP
export default {
  id: "rls-02-server-only-table-clean",
  kind: "bug",
  source: "synthetic",
  description: "服务端 service role 持连接的表未启用 RLS，不构成匿名暴露，不应报",
  diff: `diff --git a/supabase/migrations/20261115100000_create_audit_log.sql b/supabase/migrations/20261115100000_create_audit_log.sql
new file mode 100644
index 0000000..4d5e6f7
--- /dev/null
+++ b/supabase/migrations/20261115100000_create_audit_log.sql
@@ -0,0 +1,6 @@
+create table public.audit_log (
+  id bigint generated always as identity primary key,
+  actor text not null,
+  action text not null,
+  created_at timestamptz not null default now()
+);
diff --git a/server/audit.ts b/server/audit.ts
new file mode 100644
index 0000000..5e6f7a8
--- /dev/null
+++ b/server/audit.ts
@@ -0,0 +1,11 @@
+import { createClient } from "@supabase/supabase-js";
+
+const admin = createClient(
+  process.env.SUPABASE_URL!,
+  process.env.SUPABASE_SERVICE_ROLE_KEY!,
+);
+
+export async function recordAudit(actor: string, action: string): Promise<void> {
+  const { error } = await admin.from("audit_log").insert({ actor, action });
+  if (error) throw new Error(\`audit insert failed: \${error.message}\`);
+}
`,
  expect: [],
  expectClean: true,
} satisfies EvalCase;
