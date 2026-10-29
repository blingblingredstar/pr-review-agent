// 解决 PR 上全部未 resolve 的 review 线程——合并仪式的最后一步（AGENTS.md 工程约定、D013）。
// 用法：npm run resolve:threads -- owner/repo#N
import { getOctokit } from "../src/github.ts";

async function main(): Promise<void> {
  // 仓库名含 . - _ 之外字符极罕见，[\w.-]+ 已覆盖常规场景；不匹配时按用法错误退出
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
  type ResolveResult = { resolveReviewThread: { thread: { isResolved: boolean } } };
  const results = await Promise.allSettled(
    open.map((t) =>
      client
        .graphql<ResolveResult>(
          `mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }`,
          { id: t.id },
        )
        .then((res) => {
          // GraphQL 不抛错的边缘场景（如线程刚被删除）也要算失败
          if (!res.resolveReviewThread.thread.isResolved) {
            throw new Error(`线程 ${t.id} resolve 后仍为未解决`);
          }
          console.log(`resolved: ${t.id}`);
        }),
    ),
  );
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    // 逐条报告：部分成功时必须能看出哪些漏了
    console.error(
      `${failed.length} 条 resolve 失败：`,
      failed.map((r) => (r as PromiseRejectedResult).reason?.message ?? (r as PromiseRejectedResult).reason),
    );
    process.exit(1);
  }

  // resolve 动作不触发 pull_request / pull_request_review 事件，check 不会自动重跑——主动触发，闭合「绿了才合并」
  // 按 head_sha 匹配 run：fork PR 的分支在本仓库无对应 run，同分支多 PR 时 branch 过滤会张冠李戴
  const pr = await client.rest.pulls.get({ owner, repo, pull_number: Number(num) });
  const runs = await client.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: "review-threads.yml",
    per_page: 20,
  });
  const run = runs.data.workflow_runs.find((r) => r.head_sha === pr.data.head.sha);
  if (run) {
    try {
      await client.rest.actions.reRunWorkflow({ owner, repo, run_id: run.id });
      console.log(`已重跑 review-threads check（run ${run.id}），变绿后即可合并`);
    } catch (err) {
      console.error(
        `重跑 check 失败（reRunWorkflow 需带 repo/actions:write 权限的 PAT）：`,
        err instanceof Error ? err.message : err,
      );
      process.exit(1);
    }
  } else {
    console.log("未找到该 head SHA 的 check run（可能尚未触发过），请人工确认线程已全部 resolve 再合并");
  }
}

main().catch((err) => {
  console.error("resolve 失败", err);
  process.exit(1);
});
