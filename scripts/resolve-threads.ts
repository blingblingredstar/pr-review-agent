// 解决 PR 上未 resolve 的 review 线程——意见闭环的收尾（AGENTS.md 工程约定、D013）。
// 推荐流程：每轮意见处理后即时闭环——处理过的线程用 --only <databaseId> --reply <databaseId>="回应文本"
// 回复并 resolve（回应留痕在 PR 线程里，bot 复审翻旧账时结论可见）；全部处理完用 --yes 全量收尾。
// 不带参数：只列出线程摘要（含序号与 databaseId）。
// 用法：npm run resolve:threads -- owner/repo#N [--only id1,id2] [--reply id=文本 ...] [--yes]
import { getOctokit } from "../src/github.ts";

async function main(): Promise<void> {
  // 仓库名含 . - _ 之外字符极罕见，[\w.-]+ 已覆盖常规场景；不匹配时按用法错误退出
  const ref = process.argv[2] ?? "";
  const args = process.argv.slice(3);
  const yes = args.includes("--yes");
  const onlyIdx = args.indexOf("--only");
  let onlyArg: string | null = null;
  if (onlyIdx >= 0) {
    onlyArg = args[onlyIdx + 1] ?? "";
    if (!onlyArg.trim()) {
      // 传了 --only 没传值会静默退回列表模式，用户以为执行了闭环实际什么都没做
      console.error("--only 需要逗号分隔的线程 databaseId，如 --only 4414932445,4414932456");
      process.exit(1);
    }
  }
  const only = new Set<number>(onlyArg ? onlyArg.split(",").filter(Boolean).map(Number) : []);
  // --reply <databaseId>=<文本>，可多次；resolve 前先发回复，回应必须留痕后才关线程
  const replies = new Map<number, string>();
  for (const a of args) {
    if (a.startsWith("--reply ")) {
      const spec = a.slice("--reply ".length);
      const eq = spec.indexOf("=");
      if (eq <= 0) {
        console.error(`--reply 格式应为 id=文本：${a}`);
        process.exit(1);
      }
      replies.set(Number(spec.slice(0, eq)), spec.slice(eq + 1));
    }
  }
  const m = ref.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (!m) {
    console.error("用法：npm run resolve:threads -- owner/repo#N [--only id1,id2] [--reply id=文本 ...] [--yes]");
    process.exit(1);
  }
  const [, owner, repo, num] = m;
  const pullNumber = Number(num);

  const client = getOctokit();
  type Threads = {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: {
            id: string;
            isResolved: boolean;
            comments: { nodes: { databaseId: number | null; author: { login: string | null } | null; body: string }[] };
          }[];
          pageInfo: { hasNextPage: boolean };
        };
      };
    };
  };
  const data = await client.graphql<Threads>(
    `query($owner:String!,$name:String!,$number:Int!){
      repository(owner:$owner,name:$name){
        pullRequest(number:$number){
          reviewThreads(first:100){
            nodes{
              id
              isResolved
              comments(last:1){ nodes{ databaseId body author{ login } } }
            }
            pageInfo{ hasNextPage }
          }
        }
      }
    }`,
    { owner, name: repo, number: pullNumber },
  );
  const threads = data.repository.pullRequest.reviewThreads;
  if (threads.pageInfo.hasNextPage) {
    // 静默漏 resolve 会让闭环形同虚设：超限直接报错交人工
    console.error("review 线程超过 100 条，分页未支持——请人工检查剩余线程");
    process.exit(1);
  }
  const open = threads.nodes.filter((t) => !t.isResolved);
  console.log(`未 resolve 线程：${open.length}`);
  for (const [i, t] of open.entries()) {
    const last = t.comments.nodes[0];
    const text = (last?.body ?? "").split("\n")[0].slice(0, 80);
    console.log(`  #${i + 1} id=${last?.databaseId ?? "?"} [${last?.author?.login ?? "?"}] ${text}`);
  }
  if (!yes && only.size === 0) {
    if (replies.size > 0) {
      // 回复必须落在明确的闭环动作上，否则回应没留痕、线程也没关
      console.error("--reply 必须与 --only 或 --yes 搭配使用");
      process.exit(1);
    }
    // 防「一键清场」：每条意见都要走过 修复/回应 才该被 resolve（AGENTS.md 流程）
    console.log("逐条处理后：--only <id1,id2> 回复并 resolve 指定线程；全部处理完 --yes 全量收尾");
    return;
  }
  // --only 显式选择即为确认；校验 id 都存在，防打错静默漏掉
  const openIds = new Set(open.map((t) => t.comments.nodes[0]?.databaseId).filter((x): x is number => x !== null));
  const missing = [...only].filter((id) => !openIds.has(id));
  if (missing.length > 0) {
    console.error(`--only 里的 id 不在未 resolve 线程中（可能已 resolve 或打错）：${missing.join(",")}`);
    process.exit(1);
  }
  // --reply 同样校验：id 不存在时回应无处落，静默忽略违背「没有留痕的闭环不算闭环」
  const missingReply = [...replies.keys()].filter((id) => !openIds.has(id));
  if (missingReply.length > 0) {
    console.error(`--reply 里的 id 不在未 resolve 线程中（可能已 resolve、打错，或漏配 --only）：${missingReply.join(",")}`);
    process.exit(1);
  }
  const targets = only.size > 0 ? open.filter((t) => only.has(t.comments.nodes[0]!.databaseId!)) : open;

  type ResolveResult = { resolveReviewThread: { thread: { isResolved: boolean } } };
  type ThreadNode = (typeof threads.nodes)[number];
  const resolveOne = async (t: ThreadNode) => {
    const last = t.comments.nodes[0];
    const commentId = last?.databaseId;
    const reply = commentId !== null && commentId !== undefined ? replies.get(commentId) : undefined;
    if (commentId && reply) {
      // 回应先落 PR 线程；回复失败则不 resolve——没有留痕的闭环不算闭环
      await client.rest.pulls.createReplyForReviewComment({ owner, repo, pull_number: pullNumber, comment_id: commentId, body: reply });
      console.log(`replied: ${commentId}`);
    }
    const res = await client.graphql<ResolveResult>(
      `mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }`,
      { id: t.id },
    );
    // GraphQL 不抛错的边缘场景（如线程刚被删除）也要算失败
    if (!res.resolveReviewThread.thread.isResolved) {
      throw new Error(`线程 ${t.id} resolve 后仍为未解决`);
    }
    console.log(`resolved: ${commentId ?? t.id}`);
  };
  // 小批量并发，避免瞬时打满 API 点率
  const failures: string[] = [];
  for (let i = 0; i < targets.length; i += 5) {
    const results = await Promise.allSettled(targets.slice(i, i + 5).map(resolveOne));
    results.forEach((r, j) => {
      if (r.status === "rejected") {
        failures.push(`${targets[i + j].id}: ${r.reason?.message ?? String(r.reason)}`);
      }
    });
  }
  if (failures.length > 0) {
    console.error(`${failures.length} 条处理失败：\n${failures.join("\n")}`);
    process.exit(1);
  }
  // 部分 resolve（还有剩余 open 线程）时 check 仍应为红，不重跑
  const coveredAll = only.size === 0 || targets.length === open.length;
  if (!coveredAll) {
    console.log(`已处理 ${targets.length}/${open.length} 个线程，剩余未决，check 维持红灯`);
    return;
  }

  // resolve 动作不触发 pull_request / pull_request_review 事件，check 不会自动重跑——主动触发，闭合「绿了才合并」
  // 按 head_sha 匹配 run：fork PR 的分支在本仓库无对应 run，同分支多 PR 时 branch 过滤会张冠李戴
  const pr = await client.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  const runs = await client.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: "review-threads.yml",
    head_sha: pr.data.head.sha,
    per_page: 1,
  });
  const run = runs.data.workflow_runs[0];
  if (!run) {
    console.log("未找到该 head SHA 的 check run（可能尚未触发过），请人工确认线程已全部 resolve 再合并");
    return;
  }
  if (run.status !== "completed") {
    // reRunWorkflow 只能重跑已完成的 run；正在跑的 check 本就会反映 resolve 后的状态
    console.log(`check 正在运行（status=${run.status}），线程已全部 resolve，等它跑完即可`);
    return;
  }
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
}

main().catch((err) => {
  console.error("resolve 失败", err);
  process.exit(1);
});
