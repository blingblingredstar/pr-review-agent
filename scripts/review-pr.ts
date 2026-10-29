// Day 2 冒烟脚本：对真实 PR 拉取 diff → LLM 审查 → 打印 / 回帖。
// 用法：npm run review:pr -- owner/repo#<PR编号> [--post]
import { fetchPr, getOctokit, postReview } from "../src/github.ts";
import { reviewDiff } from "../src/review.ts";

const argv = process.argv.slice(2);
const post = argv.includes("--post");
const ref = argv.find((a) => !a.startsWith("--"));
const m = ref?.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
if (!m) {
  console.error("用法：npm run review:pr -- owner/repo#<PR编号> [--post]");
  process.exit(1);
}
const [, owner, repo, pullNumber] = m;

const client = getOctokit();
const pr = { owner, repo, pullNumber: Number(pullNumber) };

console.log(`拉取 ${owner}/${repo}#${pr.pullNumber} 的 diff …`);
const { diff, headSha } = await fetchPr(client, pr);
console.log(`diff ${diff.length} 字节，head ${headSha.slice(0, 8)}，调用 LLM 审查 …`);

const result = await reviewDiff(diff);
if (result.comments.length === 0) {
  console.log("审查完成：没有值得提的意见。");
  process.exit(0);
}
for (const c of result.comments) {
  console.log(`\n[${c.severity}] ${c.file}:${c.line}\n${c.body}`);
}

if (!post) {
  console.log("\n（仅打印；加 --post 提交 review 到 GitHub）");
  process.exit(0);
}
await postReview(client, { ...pr, commitId: headSha }, result, diff);
console.log(`\n已把 ${result.comments.length} 条意见提交为 review → ${owner}/${repo}#${pr.pullNumber}`);
