// 解决 PR 上全部未 resolve 的 review 线程——合并仪式的最后一步（AGENTS.md 工程约定、D013）。
// 用法：npm run resolve:threads -- owner/repo#N
import { getOctokit } from "../src/github.ts";

const ref = process.argv[2] ?? "";
const m = ref.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
if (!m) {
  console.error("用法：npm run resolve:threads -- owner/repo#N");
  process.exit(1);
}
const [, owner, repo, num] = m;

const client = getOctokit();
type Threads = {
  repository: { pullRequest: { reviewThreads: { nodes: { id: string; isResolved: boolean }[] } } };
};
const data = await client.graphql<Threads>(
  `query($owner:String!,$name:String!,$number:Int!){
    repository(owner:$owner,name:$name){
      pullRequest(number:$number){
        reviewThreads(first:100){ nodes{ id isResolved } }
      }
    }
  }`,
  { owner, name: repo, number: Number(num) },
);
const open = data.repository.pullRequest.reviewThreads.nodes.filter((t) => !t.isResolved);
console.log(`未 resolve 线程：${open.length}`);
for (const t of open) {
  await client.graphql(`mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }`, {
    id: t.id,
  });
  console.log(`resolved: ${t.id.slice(0, 20)}…`);
}
