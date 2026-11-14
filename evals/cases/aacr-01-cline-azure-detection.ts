import type { EvalCase } from "../score.ts";

// 来源：alibaba/aacr-bench v1（Apache-2.0，HF Alibaba-Aone/aacr-bench）外部 golden 人工核验转译（#157）。
// golden comment 人工核验：锚点定位到 diff 内机制行（AACR 参考行号与机制行逐条对位，无漂移），
// 机制词中文转译并尽量剔除 diff 字面词（#44 判分纪律）；provenance 随 description 必填。
export default {
  id: "aacr-01-cline-azure-detection",
  kind: "bug",
  source: "aacr",
  description: "来源 cline PR#1808（AACR-Bench v1 人工核验转译，human golden）：Azure 检测条件被改成按 URL 含 deepseek 判别 + 模型名子串误匹配",
  diff: `diff --git a/.changeset/hot-pens-own.md b/.changeset/hot-pens-own.md
new file mode 100644
index 00000000000..3932b1d33d7
--- /dev/null
+++ b/.changeset/hot-pens-own.md
@@ -0,0 +1,5 @@
+---
+"claude-dev": patch
+---
+
+Fixed to be able to use DeepSeek in Azure.
diff --git a/src/api/providers/deepseek.ts b/src/api/providers/deepseek.ts
index 9049e646db4..9eb25be3063 100644
--- a/src/api/providers/deepseek.ts
+++ b/src/api/providers/deepseek.ts
@@ -23,7 +23,7 @@ export class DeepSeekHandler implements ApiHandler {
 	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
 		const model = this.getModel()
 
-		const isDeepseekReasoner = model.id.includes("deepseek-reasoner")
+		const isDeepseekReasoner = model.id.includes("deepseek-reasoner") || model.id.includes("deepseek-r1")
 
 		let openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
 			{ role: "system", content: systemPrompt },
diff --git a/src/api/providers/openai.ts b/src/api/providers/openai.ts
index 7309d5bb988..dc7649228f7 100644
--- a/src/api/providers/openai.ts
+++ b/src/api/providers/openai.ts
@@ -14,7 +14,12 @@ export class OpenAiHandler implements ApiHandler {
 	constructor(options: ApiHandlerOptions) {
 		this.options = options
 		// Azure API shape slightly differs from the core API shape: https://github.com/openai/openai-node?tab=readme-ov-file#microsoft-azure-openai
-		if (this.options.openAiBaseUrl?.toLowerCase().includes("azure.com")) {
+		if (this.options.openAiBaseUrl?.toLowerCase().includes("deepseek")) {
+			this.client = new OpenAI({
+				baseURL: this.options.openAiBaseUrl,
+				apiKey: this.options.openAiApiKey,
+			})
+		} else if (this.options.openAiBaseUrl?.toLowerCase().includes("azure.com")) {
 			this.client = new AzureOpenAI({
 				baseURL: this.options.openAiBaseUrl,
 				apiKey: this.options.openAiApiKey,
@@ -31,7 +36,7 @@ export class OpenAiHandler implements ApiHandler {
 	@withRetry()
 	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
 		const modelId = this.options.openAiModelId ?? ""
-		const isDeepseekReasoner = modelId.includes("deepseek-reasoner")
+		const isDeepseekReasoner = modelId.includes("deepseek-reasoner") || modelId.includes("deepseek-r1")
 
 		let openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
 			{ role: "system", content: systemPrompt },
`,
  expect: [
    {
      file: "src/api/providers/openai.ts",
      line: 17,
      mustMention: ["误判", "判别", "检测", "识别", "顺序", "azure", "判定错", "走错"],
    },
    {
      file: "src/api/providers/openai.ts",
      line: 39,
      mustMention: ["子串", "误匹配", "精确匹配", "误报", "includes", "前缀"],
    },
  ],
} as EvalCase;
