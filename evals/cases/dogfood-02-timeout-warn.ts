import type { EvalCase } from "../score.ts";

// 回归集：本仓库 PR #2 真实自审意见（LLM_TIMEOUT_MS 非法值静默回退默认，应告警）。agent 考过的原题，能力评估不计入，防 prompt 退化
export default {
  id: "dogfood-02-timeout-warn",
  kind: "bug",
  source: "dogfood",
  description: "回归集：本仓库 PR #2 真实自审意见（LLM_TIMEOUT_MS 非法值静默回退默认，应告警）。agent 考过的原题，能力评估不计入，防 prompt 退化",
  diff: `diff --git a/src/review.ts b/src/review.ts
index aa7720b..cf9dbc2 100644
--- a/src/review.ts
+++ b/src/review.ts
@@ -22,19 +22,50 @@ export function loadPrompt(): string {
   return readFileSync(new URL("../prompts/review.md", import.meta.url), "utf8");
 }
 
+// 端点扩展点（D002 厂商中立）：LLM_EXTRA_BODY 为 JSON 对象，合并进每次请求体（显式配置优先）。
+// GLM 等 thinking 模型用它传 {"thinking":{"type":"disabled"}} 控制延迟（D012）；其他端点可传各自扩展参数。
+export function withExtraBody(fetchImpl: typeof fetch, extra: Record<string, unknown>): typeof fetch {
+  return async (input, init) => {
+    if (typeof init?.body === "string" && init.body.startsWith("{")) {
+      try {
+        init = { ...init, body: JSON.stringify({ ...JSON.parse(init.body), ...extra }) };
+      } catch {
+        // 非 JSON 请求体按原样透传
+      }
+    }
+    return fetchImpl(input, init);
+  };
+}
+
+function extraBody(): Record<string, unknown> {
+  const raw = process.env.LLM_EXTRA_BODY;
+  if (!raw) return {};
+  const parsed: unknown = JSON.parse(raw);
+  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
+    throw new Error("LLM_EXTRA_BODY 必须是 JSON 对象");
+  }
+  return parsed as Record<string, unknown>;
+}
+
+export function llmTimeoutMs(): number {
+  return Number(process.env.LLM_TIMEOUT_MS) || 270_000;
+}
+
 export async function reviewDiff(diff: string): Promise<ReviewResult> {
   const { LLM_API_KEY, LLM_BASE_URL, LLM_MODEL } = process.env;
   if (!LLM_API_KEY || !LLM_BASE_URL || !LLM_MODEL) {
     throw new Error("缺少环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（参照 .env.example 配置 .env）");
   }
-  const llm = createOpenAI({ apiKey: LLM_API_KEY, baseURL: LLM_BASE_URL });
+  const llm = createOpenAI({ apiKey: LLM_API_KEY, baseURL: LLM_BASE_URL, fetch: withExtraBody(fetch, extraBody()) });
   // .chat() 强制走 /chat/completions：OpenAI 兼容端点（如 GLM）不实现 Responses API；
-  // ai v7 起 generateObject 已废弃，结构化输出走 generateText + Output
+  // ai v7 起 generateObject 已废弃，结构化输出走 generateText + Output；
+  // 超时预算见 docs/decisions.md D011（Vercel Hobby 函数上限 300s，留回帖余量）
   const { output } = await generateText({
     model: llm.chat(LLM_MODEL),
     output: Output.object({ schema: reviewResultSchema, name: "ReviewResult" }),
     system: loadPrompt(),
     prompt: diff,
+    abortSignal: AbortSignal.timeout(llmTimeoutMs()),
   });
   return output;
 }`,
  expect: [
    {
      "file": "src/review.ts",
      "line": null,
      "mustMention": [
        "非法",
        "nan",
        "静默",
        "回退",
        "警告",
        "告警",
        "配置",
        "校验"
      ]
    }
  ],
} satisfies EvalCase;
