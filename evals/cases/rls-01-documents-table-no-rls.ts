import type { EvalCase } from "../score.ts";

// #171 数据库访问控制 aspect 正例（Lovable 型缺陷，Crissy Field 报告根因，
// 见 docs/plans/lovable-rls-research.md）：迁移建表无 RLS/policy + 同 diff 前端带
// 公开 anon key 直查该表——客户端直连架构下 RLS 是匿名访问的唯一防线；
// 期望锚在建表迁移的 CREATE TABLE 行（规则明示「锚在建表迁移的行上」），
// mustMention 要求点名行级安全/访问控制机制——缺失型缺陷的机制词天然不在 diff 中
//（diff 只有没有 RLS 的建表语句），字面词闸自然通过
export default {
  id: "rls-01-documents-table-no-rls",
  kind: "bug",
  source: "synthetic",
  description: "新增客户端直连表未启用行级安全（Lovable 型缺陷，Crissy Field 报告根因）",
  diff: `diff --git a/supabase/migrations/20261115090000_create_documents.sql b/supabase/migrations/20261115090000_create_documents.sql
new file mode 100644
index 0000000..1a2b3c4
--- /dev/null
+++ b/supabase/migrations/20261115090000_create_documents.sql
@@ -0,0 +1,7 @@
+create table public.documents (
+  id uuid primary key default gen_random_uuid(),
+  owner_id uuid not null,
+  title text not null,
+  content text not null,
+  created_at timestamptz not null default now()
+);
diff --git a/src/lib/supabase.ts b/src/lib/supabase.ts
new file mode 100644
index 0000000..2b3c4d5
--- /dev/null
+++ b/src/lib/supabase.ts
@@ -0,0 +1,6 @@
+import { createClient } from "@supabase/supabase-js";
+
+export const supabase = createClient(
+  import.meta.env.VITE_SUPABASE_URL,
+  import.meta.env.VITE_SUPABASE_ANON_KEY,
+);
diff --git a/src/pages/Documents.tsx b/src/pages/Documents.tsx
new file mode 100644
index 0000000..3c4d5e6
--- /dev/null
+++ b/src/pages/Documents.tsx
@@ -0,0 +1,10 @@
+import { useEffect, useState } from "react";
+import { supabase } from "../lib/supabase";
+
+export function Documents() {
+  const [docs, setDocs] = useState<{ id: string; title: string }[]>([]);
+  useEffect(() => {
+    supabase.from("documents").select().then(({ data }) => setDocs(data ?? []));
+  }, []);
+  return <ul>{docs.map((d) => <li key={d.id}>{d.title}</li>)}</ul>;
+}
`,
  expect: [
    {
      file: "supabase/migrations/20261115090000_create_documents.sql",
      line: 1,
      mustMention: ["行级安全", "RLS", "Row Level Security", "row level security", "访问控制", "权限", "policy", "策略", "匿名"],
    },
  ],
} satisfies EvalCase;
