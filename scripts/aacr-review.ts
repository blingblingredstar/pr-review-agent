// AACR-Bench 桥接 CLI：在指定 git 仓库上取 base..head diff → reviewDiff 裸审查 →
// stdout 输出 aacr-bench 评测框架的 OCR 形状结果 JSON（evaluate.py 的默认解析器直接可读）。
// 用法：npm run aacr:review -- --repo <path> --from <sha> --to <sha>
// 配置同 eval：node --env-file=.env 加载 LLM_*；裸 reviewDiff（无上下文/任务/工具注入），
// 与 evals 直调同构——对照读数口径是「本仓库审查内核」，不带生产编排的上下文增强。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { reviewDiff } from "../src/review.ts";

const execFileAsync = promisify(execFile);

function arg(name: string): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : undefined;
  if (!v) {
    console.error(`缺少 --${name}`);
    process.exit(1);
  }
  return v;
}

const repo = arg("repo");
const from = arg("from");
const to = arg("to");
// 结果走文件不走 stdout：npm banner 与 src/review.ts 的 console.log 都会污染 stdout，
// 下游 json.loads 会被击穿（首跑 cline 实证）
const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const outPath = outIdx >= 0 ? argv[outIdx + 1] : undefined;

// 大 diff 会超 execFile 默认 1MB maxBuffer（cherry-studio 实证）；截断在 reviewDiff 内部做
const { stdout: diff } = await execFileAsync("git", ["-C", repo, "diff", from, to], {
  maxBuffer: 64 * 1024 * 1024,
});
console.error(`[aacr-review] diff ${from.slice(0, 8)}..${to.slice(0, 8)}：${diff.length} 字节`);

const outcome = await reviewDiff(diff);
console.error(
  `[aacr-review] ${outcome.comments.length} 条意见，tokens in ${outcome.usage.inputTokens ?? "?"} / out ${outcome.usage.outputTokens ?? "?"}`,
);

// OCR 形状：path/start_line/end_line/content + summary.input_tokens/output_tokens。
// content 不带 severity 前缀——语义匹配只看意见正文，severity 是我方 wire 格式不是审查内容。
const payload = {
  comments: outcome.comments.map((c) => ({
    path: c.file,
    start_line: c.line,
    end_line: c.line,
    content: c.body,
  })),
  summary: {
    input_tokens: outcome.usage.inputTokens ?? 0,
    output_tokens: outcome.usage.outputTokens ?? 0,
  },
};
if (outPath) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(outPath, JSON.stringify(payload));
  console.error(`[aacr-review] 结果已写入 ${outPath}`);
} else {
  process.stdout.write(JSON.stringify(payload));
}
