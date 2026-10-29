// 解决 PR 上全部未 resolve 的 review 线程——合并仪式的最后一步（AGENTS.md 工程约定、D013）。
// 用法：npm run resolve:threads -- owner/repo#N
import { getOctokit } from "../src/github.ts";

async function main(): Promise<void> {
  const ref = process.argv[2] ?? "";
  const m = ref.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (!m) {
    console.error("用法：npm run resolve:threads -- owner/repo#N");
    process.exit(1);
  }
  const [, owner, repo, num] = m;

  const client = getOctokit();
  type Threads = {
    repository: {
      pullRequest: { reviewThreads: { nodes: { id: string; isResolved: boolean }[]; pageInfo: { hasNextPage: boolean } } };
    };
  };
  const data = await client.graphql<Threads>(
    `query($owner:String!,$name:String!,$number:Int!){
      repository(owner:$owner,name:$name){
        pullRequest(number:$number){
          reviewThreads(first:100){ nodes{ id isResolved } pageInfo{ hasNextPage } }
        }
      }
    }`,
    { owner, name: repo, number: Number(num) },
  );
  const threads = data.repository.pullRequest.reviewThreads;
  if (threads.pageInfo.hasNextPage) {
    // 静默漏 resolve 会让闭环形同虚设：超限直接报错交人工
    console.error("review 线程超过 100 条，分页未支持——请人工检查剩余线程");
    process.exit(1);
  }
  const open = threads.nodes.filter((t) => !t.isResolved);
  console.log(`未 resolve 线程：${open.length}`);
  const results = await Promise.allSettled(
    open.map((t) =>
      client.graphql(`mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }`, {
        id: t.id,
      }).then(() => console.log(`resolved: ${t.id.slice(0, 20)}…`)),
    ),
  );
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    // 逐条报告：部分成功时必须能看出哪些漏了
    console.error(`${failed.length} 条 resolve 失败：`, failed.map((r) => (r as PromiseRejectedResult).reason));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("resolve 失败", err);
  process.exit(1);
});
