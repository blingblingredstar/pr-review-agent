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

// diff --git 头行的 b 侧路径：引号包裹、八进制转义、rename 两侧引号需求不一致的四种组合都试
export function diffHeaderPath(line: string): string | null {
  const m =
    /^diff --git "a\/(?:[^"\\]|\\.)*" "(b\/(?:[^"\\]|\\.)*)"$/.exec(line) ??
    /^diff --git "a\/(?:[^"\\]|\\.)*" b\/(\S+)$/.exec(line) ??
    /^diff --git a\/\S+ "(b\/(?:[^"\\]|\\.)*)"$/.exec(line) ??
    /^diff --git a\/\S+ b\/(\S+)$/.exec(line);
  return m ? unquoteGitPath(m[1]).replace(/^b\//, "") : null;
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
      file = diffHeaderPath(raw) ?? "";
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

// diff 截断预算（字符）：超大 diff 全量进 prompt 浪费 token 甚至超模型上下文；默认 300_000 留足余量
export function diffMaxChars(): number {
  const raw = process.env.DIFF_MAX_CHARS;
  if (!raw) return 300_000;
  const parsed = Number(raw);
  // 小数（如 0.5）会得到所有块都装不下的预算、返回纯省略列表——与非法值一并回退
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.warn(`DIFF_MAX_CHARS="${raw}" 不是正整数，回退默认 300000`);
    return 300_000;
  }
  return parsed;
}

// 生成物识别名单（D020）：故意短而高精度——漏判只是让该文件回退 D018 的大小贪心（软失败），不比现状差。
// 直接清单（package.json / requirements.txt）不进名单：体积小贪心本来保留，且依赖版本变动正是要人审的内容
const NOISE_FILENAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb",
  "Cargo.lock", "poetry.lock", "uv.lock", "pdm.lock", "Pipfile.lock",
  "Gemfile.lock", "composer.lock", "go.sum", "mix.lock", "gradle.lockfile",
  "packages.lock.json", "Paket.lock", "conan.lock", "flake.lock",
]);
// 目录段按段整配：outbox/ 不撞 out/，dist-utils/ 不撞 dist/
const NOISE_SEGMENTS = new Set(["node_modules", "vendor", "dist", "build", "out", "target", "coverage", ".next"]);
const NOISE_SUFFIXES = [".min.js", ".min.css", ".map", ".snap"];

function isNoisePath(path: string): boolean {
  const segments = path.split("/");
  const base = segments[segments.length - 1]!;
  if (NOISE_FILENAMES.has(base)) return true;
  if (NOISE_SUFFIXES.some((s) => base.endsWith(s))) return true;
  return segments.slice(0, -1).some((s) => NOISE_SEGMENTS.has(s));
}

// 超预算时整文件块丢弃（D018）：切 hunk 破坏行号定位、分批多次调用翻倍延迟，都不取——
// 按块大小升序贪心保留，保留块按原顺序字节级重组，丢弃文件附省略行让模型知道看到的不是全量。
// 生成物前置过滤（D020）：名单/横幅/长行占优命中的块不进预算竞争、恒省略并标注，预算让给真实代码；
// 省略行标注「新建文件」——D018 把「大」当噪声信号，新建大源码文件是最值得审却被最先丢的内容。
export function truncateDiff(diff: string, budget: number = diffMaxChars()): string {
  if (diff.length <= budget) return diff;
  const blocks: {
    lines: string[]; path: string; adds: number; dels: number; size: number; binary: boolean; pseudo?: true;
    isNew: boolean; generated: boolean; contentChars: number; longChars: number; noise: boolean;
  }[] = [];
  let cur: (typeof blocks)[number] | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = {
        lines: [line], path: diffHeaderPath(line) ?? "(无法解析路径的文件)", adds: 0, dels: 0, size: 0, binary: false,
        isNew: false, generated: false, contentChars: 0, longChars: 0, noise: false,
      };
      blocks.push(cur);
    } else if (!cur) {
      // 畸形 diff 首个文件头之前的散落内容：不是文件，被丢弃时不产出省略行（伪路径会误导模型）
      cur = {
        lines: [line], path: "(diff 头之前的内容)", adds: 0, dels: 0, size: 0, binary: false, pseudo: true,
        isNew: false, generated: false, contentChars: 0, longChars: 0, noise: false,
      };
      blocks.push(cur);
    } else {
      cur.lines.push(line);
      cur.contentChars += line.length;
      if (line.length >= 500) cur.longChars += line.length;
      if (line.startsWith("new file mode ")) cur.isNew = true;
      // 二进制负载行（GIT binary patch 的 base64 / Binary files 摘要之后）可能以 +/- 开头，停止计数；
      // 标记置位后不重置——git 输出中二进制段后不再有文本 hunk，手工拼接的混合 diff 会漏记（输入来源仅 GitHub 标准 diff，接受）
      if (line === "GIT binary patch" || line.startsWith("Binary files ")) cur.binary = true;
      else if (!cur.binary) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          cur.adds++;
          // 生成物横幅只认文件头部（前 10 个新增行）：中后段的 do not edit 多是普通注释，全块扫会误伤
          if (cur.adds <= 10 && /@generated|do not edit/i.test(line)) cur.generated = true;
        } else if (line.startsWith("-") && !line.startsWith("---")) cur.dels++;
      }
    }
  }
  // 块大小为近似值：join 长度 + 1 个块间换行分隔符（末块无尾换行时多记 1 字符）；预算是软约束，不追求精确
  for (const b of blocks) b.size = b.lines.join("\n").length + 1;
  // 长行占优是压缩/混淆产物的跨生态结构信号，不依赖文件名；500/4000 阈值容忍源码里偶发的长字符串行
  for (const b of blocks) {
    b.noise = !b.pseudo && (isNoisePath(b.path) || b.generated || (b.longChars > 4000 && b.longChars * 2 > b.contentChars));
  }
  // 装不下就跳过继续试更小的（continue 而非 break），保留集按原顺序输出；生成物块不参与竞争
  const order = blocks.map((_, i) => i).filter((i) => !blocks[i].noise).sort((a, b) => blocks[a].size - blocks[b].size);
  const keep = new Set<number>();
  let used = 0;
  for (const i of order) {
    if (used + blocks[i].size > budget) continue;
    keep.add(i);
    used += blocks[i].size;
  }
  const kept = blocks.filter((_, i) => keep.has(i));
  // 非文件的 pseudo 块被丢弃时不产出省略行、不进汇总计数
  const omitTargets = blocks.filter((b, i) => !keep.has(i) && !b.pseudo);
  const out = kept.flatMap((b) => b.lines);
  const omitLines = omitTargets.map((b) => {
    // 标注让模型分清「预算丢的普通文件」「规则跳过的生成物」「没看到内容的新建文件」——最后者是审查盲区，最值得人工补看
    const tag = b.noise ? "生成物" : b.isNew ? "新建文件" : "";
    return `[diff 截断] 省略 ${b.path}${tag ? `（${tag}）` : ""} (+${b.adds}/-${b.dels})`;
  });
  // 省略行自身也占输出：丢弃文件极多时会反噬预算——超了就压缩成一行汇总（总量有界，无条件核对）
  if (used + omitLines.join("\n").length + 1 > budget) {
    const adds = omitTargets.reduce((s, b) => s + b.adds, 0);
    const dels = omitTargets.reduce((s, b) => s + b.dels, 0);
    out.push(`[diff 截断] 省略 ${omitTargets.length} 个文件（超出 ${budget} 字符预算，合计 +${adds}/-${dels}）`);
  } else {
    out.push(...omitLines);
  }
  const noiseCount = blocks.filter((b) => b.noise).length;
  console.log(
    `[truncateDiff] 预算 ${budget} 字符：${blocks.length} 个文件块保留 ${kept.length} 个、省略 ${blocks.length - kept.length} 个` +
      (noiseCount > 0 ? `，其中生成物按规则跳过 ${noiseCount} 个` : ""),
  );
  return out.join("\n");
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
    prompt: truncateDiff(diff),
    abortSignal: AbortSignal.timeout(llmTimeoutMs()),
  });
  return output;
}
