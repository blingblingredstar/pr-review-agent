import { readFileSync } from "node:fs";
import { generateText, Output } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";

// 与 docs/architecture.md 的输出 schema、evals/run.ts 的打分逻辑共用，改这里要同步改评分
export const reviewResultSchema = z.object({
  comments: z.array(
    z.object({
      file: z.string().describe("相对仓库根的文件路径"),
      line: z.number().int().positive().describe("新文件中的行号"),
      severity: z.enum(["blocker", "major", "minor", "nit"]),
      body: z.string().describe("问题 + 理由 +（可选）修法"),
    }),
  ),
});

export type ReviewComment = z.infer<typeof reviewResultSchema>["comments"][number];
export type ReviewResult = z.infer<typeof reviewResultSchema>;

// 模型可能带 git 的 a/ b/ 前缀，返回可能的路径变体（原样、剥 a/、剥 b/）供对照
export function pathVariants(file: string): string[] {
  return [file, file.replace(/^a\//, ""), file.replace(/^b\//, "")];
}

// git quotePath 把非 ASCII 编成八进制转义（UTF-8 字节）；输入可能带引号包裹（已剥引号也要能解码），无转义时原样返回
export function unquoteGitPath(p: string): string {
  const body = p.startsWith('"') && p.endsWith('"') && p.length >= 2 ? p.slice(1, -1) : p;
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && /[0-7]/.test(body[i + 1] ?? "")) {
      let j = i + 1;
      let oct = "";
      while (j < body.length && oct.length < 3 && /[0-7]/.test(body[j])) oct += body[j++];
      bytes.push(parseInt(oct, 8));
      i = j - 1;
    } else if (ch === "\\") {
      const next = body[i + 1] ?? "";
      bytes.push(...Buffer.from(next === "n" ? "\n" : next === "t" ? "\t" : next, "utf8"));
      i++;
    } else {
      bytes.push(...Buffer.from(ch, "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// 解析 unified diff，返回每个文件被 hunk 覆盖的新侧行号集合。
// 用于行内评论的预定位：只有行号落在 diff 内的意见才能行内发（GitHub 对 hunk 外行号返回 422）。
export function diffCoveredLines(diff: string): Map<string, Set<number>> {
  const covered = new Map<string, Set<number>>();
  let file = "";
  let inHunk = false;
  let line = 0;
  // hunk 头声明的新侧行数计数：扫描用尽即结束当前 hunk——真实 diff 以换行结尾，split 出的
  // 尾部空字符串若被当上下文行会 mark 出「最后一行 +1」的幻影行号，行内发帖必然 422 回落全量降级
  let remain = 0;
  const mark = () => {
    if (!file) return;
    let set = covered.get(file);
    if (!set) covered.set(file, (set = new Set()));
    set.add(line);
  };
  for (const raw of diff.split("\n")) {
    // hunk 内容行（+/ /-）自带前缀，不会以下面的文件头形态开头；先处理文件头判定
    if (raw.startsWith("diff --git ")) {
      // 路径含空格时 git 用引号包裹（core.quotePath，非 ASCII 编成八进制转义）；无引号形式两侧都不含空格。
      // rename 场景两侧引号需求可能不一致（旧路径含空格新路径不含），四种组合都试。
      // (?:[^"\\]|\\.)* 不跨引号也不吃转义序列，路径本身含引号字符（git 转义为 \"）时不会切错侧
      const m =
        /^diff --git "a\/(?:[^"\\]|\\.)*" "(b\/(?:[^"\\]|\\.)*)"$/.exec(raw) ??
        /^diff --git "a\/(?:[^"\\]|\\.)*" b\/(\S+)$/.exec(raw) ??
        /^diff --git a\/\S+ "(b\/(?:[^"\\]|\\.)*)"$/.exec(raw) ??
        /^diff --git a\/\S+ b\/(\S+)$/.exec(raw);
      file = m ? unquoteGitPath(m[1]).replace(/^b\//, "") : "";
      inHunk = false;
      remain = 0;
      continue;
    }
    if (inHunk) {
      const nextHunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/.exec(raw);
      if (nextHunk) {
        // 声明行数未用尽就出现 @@：畸形 diff——直接按新 hunk 头接管（起始行号与新侧行数都取自该头）
        line = Number(nextHunk[1]);
        remain = Number(nextHunk[2] ?? 1);
        continue;
      }
      if (raw.startsWith("\\")) continue; // "\ No newline at end of file" 不是内容行，不占声明行数
      if (raw.startsWith("-")) continue; // 旧侧删除行不占新侧行数，不消耗 remain
      if (remain <= 0) {
        // 新侧声明行数已用尽：hunk 结束（尾部空字符串行等伪影在此被拒之门外）
        inHunk = false;
      } else {
        remain--;
        mark();
        line++;
      }
      continue;
    }
    if (raw.startsWith("+++ ") && raw.slice(4).trim() === "/dev/null") {
      // 纯删除文件新侧不存在，任何行内评论必然 422——跳过以免坏意见拖累同 review 的好意见。
      // 精确比较：仓库里真有路径含 "/dev/null" 字样的文件（如 fixture）时 includes 会误伤
      file = "";
      inHunk = false;
      remain = 0;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/.exec(raw);
    if (hunk) {
      inHunk = true;
      line = Number(hunk[1]);
      remain = Number(hunk[2] ?? 1);
    }
  }
  return covered;
}

export function loadPrompt(): string {
  return readFileSync(new URL("../prompts/review.md", import.meta.url), "utf8");
}

// 端点扩展点（D002 厂商中立）：LLM_EXTRA_BODY 为 JSON 对象，合并进每次请求体（显式配置优先）。
// GLM 等 thinking 模型用它传 {"thinking":{"type":"disabled"}} 控制延迟（D012）；其他端点可传各自扩展参数。
export function withExtraBody(fetchImpl: typeof fetch, extra: Record<string, unknown>): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body === "string" && init.body.startsWith("{")) {
      try {
        init = { ...init, body: JSON.stringify({ ...JSON.parse(init.body), ...extra }) };
      } catch {
        // 非 JSON 请求体按原样透传
      }
    }
    return fetchImpl(input, init);
  };
}

function extraBody(): Record<string, unknown> {
  const raw = process.env.LLM_EXTRA_BODY;
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("LLM_EXTRA_BODY 必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

export function llmTimeoutMs(): number {
  const raw = process.env.LLM_TIMEOUT_MS;
  if (!raw) return 270_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`LLM_TIMEOUT_MS="${raw}" 不是正数，回退默认 270000ms`);
    return 270_000;
  }
  return parsed;
}

export async function reviewDiff(diff: string): Promise<ReviewResult> {
  const { LLM_API_KEY, LLM_BASE_URL, LLM_MODEL } = process.env;
  if (!LLM_API_KEY || !LLM_BASE_URL || !LLM_MODEL) {
    throw new Error("缺少环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（参照 .env.example 配置 .env）");
  }
  const llm = createOpenAI({ apiKey: LLM_API_KEY, baseURL: LLM_BASE_URL, fetch: withExtraBody(fetch, extraBody()) });
  // .chat() 强制走 /chat/completions：OpenAI 兼容端点（如 GLM）不实现 Responses API；
  // ai v7 起 generateObject 已废弃，结构化输出走 generateText + Output；
  // 超时预算见 docs/decisions.md D011（Vercel Hobby 函数上限 300s，留回帖余量）
  const { output } = await generateText({
    model: llm.chat(LLM_MODEL),
    output: Output.object({ schema: reviewResultSchema, name: "ReviewResult" }),
    system: loadPrompt(),
    prompt: diff,
    abortSignal: AbortSignal.timeout(llmTimeoutMs()),
  });
  return output;
}
