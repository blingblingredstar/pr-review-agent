import type { EvalCase } from "../score.ts";

// 来源：alibaba/aacr-bench v1（Apache-2.0）外部 golden 人工核验转译（#157 续批）。
// 锚点定位到机制行；mustMention 逐词过「不在 diff 中出现」检查（#44 + PR #166 教训）。
export default {
  id: "aacr-09-cline-encoding-errorhandling",
  kind: "bug",
  source: "aacr",
  description: "来源 cline PR#2347（AACR-Bench v1 人工核验转译，AI golden 专家确认）：编码检测/解码与回写全程无错误处理（readFile/detect/decode/writeFile 失败路径）——golden 为泛化错误处理建议类，考口径",
  diff: `diff --git a/.changeset/shiny-dingos-float.md b/.changeset/shiny-dingos-float.md
new file mode 100644
index 00000000000..89c52a1eacf
--- /dev/null
+++ b/.changeset/shiny-dingos-float.md
@@ -0,0 +1,5 @@
+---
+"claude-dev": patch
+---
+
+Fix Non-UTF-8 File Handling: Improve Encoding Detection to Prevent Garbled Text and Binary Misclassification
diff --git a/package.json b/package.json
index 0d0f074a49e..c371e0f6cde 100644
--- a/package.json
+++ b/package.json
@@ -289,8 +289,10 @@
 		"firebase": "^11.2.0",
 		"get-folder-size": "^5.0.0",
 		"globby": "^14.0.2",
+		"iconv-lite": "^0.6.3",
 		"ignore": "^7.0.3",
 		"isbinaryfile": "^5.0.2",
+		"jschardet": "^3.1.4",
 		"mammoth": "^1.8.0",
 		"monaco-vscode-textmate-theme-converter": "^0.1.7",
 		"ollama": "^0.5.13",
diff --git a/src/integrations/editor/DiffViewProvider.ts b/src/integrations/editor/DiffViewProvider.ts
index e416f99de69..8d882c9f944 100644
--- a/src/integrations/editor/DiffViewProvider.ts
+++ b/src/integrations/editor/DiffViewProvider.ts
@@ -7,6 +7,8 @@ import { formatResponse } from "../../core/prompts/responses"
 import { DecorationController } from "./DecorationController"
 import * as diff from "diff"
 import { diagnosticsToProblemsString, getNewDiagnostics } from "../diagnostics"
+import * as iconv from "iconv-lite"
+import * as chardet from "jschardet"
 
 export const DIFF_VIEW_URI_SCHEME = "cline-diff"
 
@@ -23,6 +25,7 @@ export class DiffViewProvider {
 	private activeLineController?: DecorationController
 	private streamedLines: string[] = []
 	private preDiagnostics: [vscode.Uri, vscode.Diagnostic[]][] = []
+	private fileEncoding: string = "utf8"
 
 	constructor(private cwd: string) {}
 
@@ -43,9 +46,18 @@ export class DiffViewProvider {
 		this.preDiagnostics = vscode.languages.getDiagnostics()
 
 		if (fileExists) {
-			this.originalContent = await fs.readFile(absolutePath, "utf-8")
+			const fileBuffer = await fs.readFile(absolutePath)
+			const detected = chardet.detect(fileBuffer)
+			this.fileEncoding =
+				typeof detected === "string"
+					? detected
+					: detected && (detected as any).encoding
+						? (detected as any).encoding
+						: "utf8"
+			this.originalContent = iconv.decode(fileBuffer, this.fileEncoding)
 		} else {
 			this.originalContent = ""
+			this.fileEncoding = "utf8"
 		}
 		// for new files, create any necessary directories and keep track of new directories to delete if the user denies the operation
 		this.createdDirs = await createDirectoriesForFile(absolutePath)
@@ -222,6 +234,11 @@ export class DiffViewProvider {
 			)
 		}
 
+		if (this.fileEncoding.toLowerCase() !== "utf8") {
+			const encodedBuffer = iconv.encode(normalizedPostSaveContent, this.fileEncoding)
+			await fs.writeFile(absolutePath, encodedBuffer as unknown as Uint8Array)
+		}
+
 		return {
 			newProblemsMessage,
 			userEdits,
diff --git a/src/integrations/misc/extract-text.ts b/src/integrations/misc/extract-text.ts
index f413de44fa0..2b8efde08b6 100644
--- a/src/integrations/misc/extract-text.ts
+++ b/src/integrations/misc/extract-text.ts
@@ -5,6 +5,8 @@ import mammoth from "mammoth"
 import fs from "fs/promises"
 import { isBinaryFile } from "isbinaryfile"
 import { getFileSizeInKB } from "../../utils/fs"
+import * as chardet from "jschardet"
+import * as iconv from "iconv-lite"
 
 export async function extractTextFromFile(filePath: string): Promise<string> {
 	try {
@@ -21,17 +23,24 @@ export async function extractTextFromFile(filePath: string): Promise<string> {
 		case ".ipynb":
 			return extractTextFromIPYNB(filePath)
 		default:
-			const isBinary = await isBinaryFile(filePath).catch(() => false)
-			if (!isBinary) {
-				// If file is over 300KB, throw an error
-				const fileSizeInKB = await getFileSizeInKB(filePath)
-				if (fileSizeInKB > 300) {
-					throw new Error(\`File is too large to read into context.\`)
-				}
-				return await fs.readFile(filePath, "utf8")
+			const fileBuffer = await fs.readFile(filePath)
+			if (fileBuffer.byteLength > 300 * 1024) {
+				throw new Error(\`File is too large to read into context.\`)
+			}
+			const detected = chardet.detect(fileBuffer)
+			let encoding: string
+			if (typeof detected === "string") {
+				encoding = detected
+			} else if (detected && (detected as any).encoding) {
+				encoding = (detected as any).encoding
 			} else {
-				throw new Error(\`Cannot read text for file type: \${fileExtension}\`)
+				const isBinary = await isBinaryFile(fileBuffer).catch(() => false)
+				if (isBinary) {
+					throw new Error(\`Cannot read text for file type: \${fileExtension}\`)
+				}
+				encoding = "utf8"
 			}
+			return iconv.decode(fileBuffer, encoding)
 	}
 }
 
@@ -47,7 +56,11 @@ async function extractTextFromDOCX(filePath: string): Promise<string> {
 }
 
 async function extractTextFromIPYNB(filePath: string): Promise<string> {
-	const data = await fs.readFile(filePath, "utf8")
+	const fileBuffer = await fs.readFile(filePath)
+	const detected = chardet.detect(fileBuffer)
+	const encoding =
+		typeof detected === "string" ? detected : detected && (detected as any).encoding ? (detected as any).encoding : "utf8"
+	const data = iconv.decode(fileBuffer, encoding)
 	const notebook = JSON.parse(data)
 	let extractedText = ""
 
`,
  expect: [
    {
      file: "src/integrations/editor/DiffViewProvider.ts",
      line: 50,
      mustMention: ["无异常处理", "失败路径", "错误处理", "异常", "抛错", "失败时"],
    },
    {
      file: "src/integrations/editor/DiffViewProvider.ts",
      line: 240,
      mustMention: ["无异常处理", "失败路径", "错误处理", "异常", "抛错", "失败时"],
    },
  ],
} as EvalCase;
