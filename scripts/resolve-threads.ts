// 解决 PR 上未 resolve 的 review 线程——意见闭环的收尾（AGENTS.md 工程约定、D013）。
// 推荐流程：每轮意见处理后即时闭环——处理过的线程用 --only <databaseId> --reply <databaseId>="回应文本"
// 回复并 resolve（回应留痕在 PR 线程里，bot 复审翻旧账时结论可见）；全部处理完用 --yes 全量收尾。
// 裁定落账（#140）：--verdict <databaseId>=fixed|wontfix|false-positive 与裁定动作同发，
// 同步 append 一行机器可读 JSONL（evals/prod-runs/rulings.jsonl）——人工裁定的免费标注不闲置。
// 回填：--backfill 只读列出已 resolve 线程与回复（人工读贴标）；对已 resolve 线程发 --verdict
// 即回填落账（不 resolve 不回复，理由引用线程内既有回复原文）。
// 用法：npm run resolve:threads -- owner/repo#N [--only id1,id2] [--reply id=文本 ...]
//        [--verdict id=fixed|wontfix|false-positive ...] [--backfill] [--yes]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getOctokit } from "../src/github.ts";

export type Verdict = "fixed" | "wontfix" | "false-positive";
export const VERDICTS: readonly Verdict[] = ["fixed", "wontfix", "false-positive"];

export type ParsedArgs = {
  ref: string;
  yes: boolean;
  only: Set<number>;
  replies: Map<number, string>;
  verdicts: Map<number, Verdict>;
  backfill: boolean;
};

// 参数解析（纯函数，便于单测）：带值 flag（--only/--reply/--verdict）消费掉自己的值位，
// 开关判断只看未被消费的位置——否则回复文本/值里恰好出现 "--yes"（shell 引号漏掉时的合法 argv）会被误当开关
export function parseArgs(argv: string[]): ParsedArgs {
  const [ref = "", ...args] = argv;
  const consumed = new Set<number>();
  const only = new Set<number>();
  // 循环处理所有 --only 出现位置（与 --reply/--verdict 一致）：第二个 --only 的值位不被消费的话，
  // 值恰为 "--yes" 时仍会被误判成开关
  for (let i = 0; i < args.length; i++) {
    if (consumed.has(i) || args[i] !== "--only") continue;
    consumed.add(i);
    consumed.add(i + 1);
    const v = args[i + 1] ?? "";
    if (!v.trim()) {
      // 传了 --only 没传值会静默退回列表模式，用户以为执行了闭环实际什么都没做
      throw new Error("--only 需要逗号分隔的线程 databaseId，如 --only 4414932445,4414932456");
    }
    const ids = v.split(",").filter(Boolean).map((s) => {
      const n = Number(s);
      // NaN/非正整数静默进集合会让 --only X --yes 表现为「解析成功但什么都没 resolve」——必须在这里报错
      if (!Number.isSafeInteger(n) || n <= 0) {
        throw new Error(`--only 的值 "${s}" 不是合法的线程 databaseId`);
      }
      return n;
    });
    if (ids.length === 0) {
      // "--only ," 这类只含分隔符的值会得到空集合，被当成未指定后可能反向触发全量 resolve
      throw new Error(`--only 的值 "${v}" 没有解析出任何线程 id`);
    }
    for (const id of ids) only.add(id);
  }
  // --reply <id=文本>，可多次；resolve 前先发回复，回应必须留痕后才关线程
  const replies = new Map<number, string>();
  for (let i = 0; i < args.length; i++) {
    if (consumed.has(i) || args[i] !== "--reply") continue;
    consumed.add(i);
    consumed.add(i + 1);
    const spec = args[i + 1] ?? "";
    const eq = spec.indexOf("=");
    if (eq <= 0 || !spec.slice(eq + 1).trim()) {
      // 空文本会被回复分支当 falsy 静默跳过，产生无留痕闭环
      throw new Error(`--reply 格式应为 非空id=非空文本，收到："${spec || "(缺参数)"}"`);
    }
    const id = Number(spec.slice(0, eq));
    // 与 --only 同一段校验：非法 id 静默生成 key 会让回复悄悄不发、流程照走
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`--reply 的 id "${spec.slice(0, eq)}" 不是合法的线程 databaseId`);
    }
    replies.set(id, spec.slice(eq + 1));
  }
  // --verdict <id=标签>，可多次；标签枚举固定（#140），拼错即报错不静默落账
  const verdicts = new Map<number, Verdict>();
  for (let i = 0; i < args.length; i++) {
    if (consumed.has(i) || args[i] !== "--verdict") continue;
    consumed.add(i);
    consumed.add(i + 1);
    const spec = args[i + 1] ?? "";
    const eq = spec.indexOf("=");
    const rawLabel = eq > 0 ? spec.slice(eq + 1) : "";
    const id = Number(spec.slice(0, eq > 0 ? eq : NaN));
    if (!(VERDICTS as readonly string[]).includes(rawLabel)) {
      throw new Error(`--verdict 格式应为 id=fixed|wontfix|false-positive，收到："${spec || "(缺参数)"}"`);
    }
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`--verdict 的 id "${spec.slice(0, eq > 0 ? eq : NaN)}" 不是合法的线程 databaseId`);
    }
    verdicts.set(id, rawLabel as Verdict);
  }
  const yes = args.some((a, i) => a === "--yes" && !consumed.has(i));
  const backfill = args.some((a, i) => a === "--backfill" && !consumed.has(i));
  if (backfill && (only.size > 0 || replies.size > 0 || verdicts.size > 0 || yes)) {
    // --backfill 是只读列表模式：混入写动作会让人以为回填已落账
    throw new Error("--backfill 是只读列表模式，不与 --only/--reply/--verdict/--yes 混用");
  }
  return { ref, yes, only, replies, verdicts, backfill };
}

// —— 裁定台账（#140）：JSONL 一行一裁定，schema 见 evals/prod-runs/README.md ——

export type RulingRow = {
  ts: string; // 裁定落账时间（ISO）
  repo: string;
  pr: number;
  threadCommentId: number; // 线程首条（原意见）databaseId——稳定幂等键；CLI 参数 id 是列表展示的末条 id（--reply 回复目标），两者并存
  verdict: Verdict; // fixed=修复 / wontfix=回应不修 / false-positive=核实误报
  reason: string; // 一行理由：裁定时的 --reply 原文；回填时引用线程内既有回复原文（verbatim，无解析）
  severity: string | null; // 原意见 body 的 **[sev]** 前缀；非 bot 意见为 null
  confidence: null; // GitHub 评论不渲染 confidence（发布层不渲染），恒 null——消费时从 RunRecord findings join（schema 占位，见 evals/prod-runs/README.md）
  file: string | null; // 原意见定位（GitHub 评论自带 path/line）
  line: number | null;
  permalink: string; // 回复（或原意见）的 GitHub URL，可回放
  source: "ruling" | "backfill"; // 新裁 vs 历史回填
};

// severity 从 bot 意见 body 前缀提取（发布格式 `**[severity]** body`，github.ts 唯一写入点）
export function severityFromBody(body: string): string | null {
  const m = /^\s*\*\*\[(blocker|major|minor|nit)\]\*\*/.exec(body);
  return m ? (m[1] as string) : null;
}

export function buildRulingRow(input: {
  ts: string;
  repo: string;
  pr: number;
  threadCommentId: number;
  verdict: Verdict;
  reason: string;
  severity: string | null;
  confidence: null;
  file: string | null;
  line: number | null;
  permalink: string;
  source: "ruling" | "backfill";
}): RulingRow {
  return { ...input };
}

export function rulingKey(row: Pick<RulingRow, "repo" | "pr" | "threadCommentId">): string {
  return `${row.repo}#${row.pr}/${row.threadCommentId}`;
}

// append 纯函数：同 (repo, pr, threadCommentId) 已落账则跳过（重复执行回填/重试安全），否则追加一行
export function appendRuling(existing: string, row: RulingRow): string {
  const key = rulingKey(row);
  const exists = existing
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      try {
        return rulingKey(JSON.parse(line) as RulingRow) === key;
      } catch {
        return false; // 坏行不阻断（人工排查），不把它当已有裁定
      }
    });
  if (exists) return existing;
  return existing + (existing && !existing.endsWith("\n") ? "\n" : "") + JSON.stringify(row) + "\n";
}

const RULINGS_PATH = fileURLToPath(new URL("../evals/prod-runs/rulings.jsonl", import.meta.url));

function writeRuling(row: RulingRow): void {
  const existing = existsSync(RULINGS_PATH) ? readFileSync(RULINGS_PATH, "utf8") : "";
  const next = appendRuling(existing, row);
  if (next !== existing) writeFileSync(RULINGS_PATH, next);
}

async function main(): Promise<void> {
  const { ref, yes, only, replies, verdicts, backfill } = parseArgs(process.argv.slice(2));
  const m = ref.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (!m) {
    console.error("用法：npm run resolve:threads -- owner/repo#N [--only id1,id2] [--reply id=文本 ...] [--verdict id=标签 ...] [--backfill] [--yes]");
    process.exit(1);
  }
  const [, owner, repo, num] = m;
  const pullNumber = Number(num);

  const client = getOctokit();
  type ThreadComment = {
    databaseId: number | null;
    body: string;
    path: string | null;
    line: number | null;
    url: string | null;
    author: { login: string | null } | null;
  };
  type Threads = {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: {
            id: string;
            isResolved: boolean;
            // original(first:1)：线程首条（原 review 意见）——幂等键与 severity/定位的唯一来源，
            // first:1 永不截断（bot major，PR #144：last:10 下首节点会退化为较早回复，键漂移 + 脏定位）
            original: { nodes: ThreadComment[] };
            // recent(last:10)：窗口内末条用于 reason/permalink；超 10 条的线程窗口截断，落账时显式告警
            recent: { nodes: ThreadComment[] };
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
              original: comments(first:1){ nodes{ databaseId body path line url author{ login } } }
              recent: comments(last:10){ nodes{ databaseId body url author{ login } } }
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
  // recent 末条（最新回复；窗口截断时是窗口内末条）；original 首条（原意见，first:1 永不截断）
  const lastOf = (t: (typeof threads.nodes)[number]): ThreadComment | undefined =>
    t.recent.nodes[t.recent.nodes.length - 1];
  const firstOf = (t: (typeof threads.nodes)[number]): ThreadComment | undefined => t.original.nodes[0];
  const open = threads.nodes.filter((t) => !t.isResolved);
  const resolved = threads.nodes.filter((t) => t.isResolved);

  // 裁定行构造（bot major，PR #144）：threadCommentId = 原意见（线程首条）databaseId——幂等键必须
  // 稳定，末条会随后续回复漂移；severity/file/line 同取原意见。reason = 本次 --reply 原文；
  // 无回复文本则引用窗口内末条回复（verbatim，窗口打满告警）。permalink 优先本次回复 URL
  const buildRow = (t: (typeof threads.nodes)[number], verdict: Verdict, replyText: string | null, replyUrl: string | null, source: "ruling" | "backfill"): RulingRow => {
    const first = firstOf(t);
    const last = lastOf(t);
    if (t.recent.nodes.length >= 10) console.warn(`  ⚠ 线程 ${first?.databaseId ?? t.id} 回复数 ≥10，reason/permalink 取的是 recent 窗口内末条（可能截断）`);
    const reason = replyText ?? (t.recent.nodes.length > 1 ? last!.body : "");
    return buildRulingRow({
      ts: new Date().toISOString(),
      repo: `${owner}/${repo}`,
      pr: pullNumber,
      threadCommentId: first!.databaseId!,
      verdict,
      reason,
      severity: severityFromBody(first?.body ?? ""),
      confidence: null,
      file: first?.path ?? null,
      line: first?.line ?? null,
      permalink: replyUrl ?? last!.url ?? first!.url ?? "",
      source,
    });
  };

  if (backfill) {
    // 回填列表模式（#140）：列出已 resolve 线程与全部回复——人工读贴标后对已 resolve 线程发 --verdict 落账
    console.log(`已 resolve 线程：${resolved.length}`);
    for (const t of resolved) {
      const first = firstOf(t);
      const last = lastOf(t);
      if (t.recent.nodes.length >= 10) console.log(`  ⚠ recent 窗口打满（≥10 条），reply 列表可能截断`);
      console.log(`id=${last?.databaseId ?? "?"} original=${first?.databaseId ?? "?"} [${severityFromBody(first?.body ?? "") ?? "?"}] ${first?.path ?? "?"}:${first?.line ?? "?"} ${(first?.body ?? "").split("\n")[0].slice(0, 80)}`);
      for (const c of t.recent.nodes.slice(1)) {
        console.log(`  reply [${c.author?.login ?? "?"}] ${c.url ?? ""} ${c.body.split("\n")[0].slice(0, 100)}`);
      }
    }
    return;
  }

  console.log(`未 resolve 线程：${open.length}`);
  for (const [i, t] of open.entries()) {
    const last = lastOf(t);
    const text = (last?.body ?? "").split("\n")[0].slice(0, 80);
    console.log(`  #${i + 1} id=${last?.databaseId ?? "?"} [${last?.author?.login ?? "?"}] ${text}`);
  }
  if (!yes && only.size === 0) {
    if (replies.size > 0) {
      // 回复必须落在明确的闭环动作上，否则回应没留痕、线程也没关
      console.error("--reply 必须与 --only 或 --yes 搭配使用");
      process.exit(1);
    }
    if (verdicts.size > 0) {
      // 未带 --only/--yes 时，--verdict 只允许全部指向已 resolve 线程（纯回填路径）；
      // 指向开着的线程 = 裁定未伴随 resolve，线程还开着却已记账
      const resolvedIds = new Set(resolved.map((t) => lastOf(t)?.databaseId).filter((x): x is number => x !== null && x !== undefined));
      const openVerdicts = [...verdicts.keys()].filter((id) => !resolvedIds.has(id));
      if (openVerdicts.length > 0) {
        console.error(`--verdict 指向未 resolve 线程时必须与 --only/--yes 搭配（伴随 resolve）：${openVerdicts.join(",")}`);
        process.exit(1);
      }
      for (const [id, verdict] of verdicts) {
        const t = resolved.find((x) => lastOf(x)?.databaseId === id);
        if (!t) continue;
        writeRuling(buildRow(t, verdict, null, null, "backfill"));
        console.log(`backfilled verdict: ${id}=${verdict}`);
      }
      return;
    }
    // 防「一键清场」：每条意见都要走过 修复/回应 才该被 resolve（AGENTS.md 流程）
    console.log("逐条处理后：--only <id1,id2> 回复并 resolve 指定线程；全部处理完 --yes 全量收尾");
    return;
  }
  // --only 显式选择即为确认；校验 id 都存在，防打错静默漏掉
  const openIds = new Set(open.map((t) => lastOf(t)?.databaseId).filter((x): x is number => x !== null && x !== undefined));
  const missing = [...only].filter((id) => !openIds.has(id));
  if (missing.length > 0) {
    console.error(`--only 里的 id 不在未 resolve 线程中（可能已 resolve 或打错）：${missing.join(",")}`);
    process.exit(1);
  }
  const targets = only.size > 0 ? open.filter((t) => only.has(lastOf(t)!.databaseId!)) : open;
  // --reply 必须落在本次要 resolve 的 targets 上：--only A --reply B 时 B 的回复永远不会被发送，不能静默丢弃
  const targetIds = new Set(targets.map((t) => lastOf(t)!.databaseId!));
  const missingReply = [...replies.keys()].filter((id) => !targetIds.has(id));
  if (missingReply.length > 0) {
    console.error(`--reply 里的 id 不在本次要 resolve 的线程中（未含在 --only 或线程已 resolve）：${missingReply.join(",")}`);
    process.exit(1);
  }
  // --verdict 的 id 必须真实存在（开着的要被 resolve、已 resolve 的走回填），其余报错。
  // original（首条）与末条 id 都接受——回填时两类引用形态都能定位到同一线程
  const allIds = new Set(
    threads.nodes
      .flatMap((t) => [lastOf(t)?.databaseId, firstOf(t)?.databaseId])
      .filter((x): x is number => x !== null && x !== undefined),
  );
  const missingVerdict = [...verdicts.keys()].filter((id) => !allIds.has(id));
  if (missingVerdict.length > 0) {
    console.error(`--verdict 里的 id 不在该 PR 的线程中（打错或已删）：${missingVerdict.join(",")}`);
    process.exit(1);
  }
  const openVerdictIds = [...verdicts.keys()].filter((id) => openIds.has(id));
  const untargeted = openVerdictIds.filter((id) => !targetIds.has(id));
  if (untargeted.length > 0) {
    console.error(`--verdict 的 id 在未 resolve 线程中但不在本次 resolve 范围：${untargeted.join(",")}（--only/--yes 带上，或线程已 resolve 才能单独回填）`);
    process.exit(1);
  }

  type ResolveResult = { resolveReviewThread: { thread: { isResolved: boolean } } };
  type ThreadNode = (typeof threads.nodes)[number];
  const resolveOne = async (t: ThreadNode) => {
    const last = lastOf(t);
    const commentId = last?.databaseId;
    const reply = commentId !== null && commentId !== undefined ? replies.get(commentId) : undefined;
    let replyUrl: string | null = null;
    if (commentId && reply) {
      // 回应先落 PR 线程；回复失败则不 resolve——没有留痕的闭环不算闭环
      const replyRes = await client.rest.pulls.createReplyForReviewComment({ owner, repo, pull_number: pullNumber, comment_id: commentId, body: reply });
      replyUrl = replyRes.data.html_url;
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
    const verdict = commentId !== null && commentId !== undefined ? verdicts.get(commentId) : undefined;
    if (verdict) {
      // 裁定与 resolve 同事务语义：resolve 成功才落账（追加失败算本次处理失败，重试安全——appendRuling 幂等）
      writeRuling(buildRow(t, verdict, reply ?? null, replyUrl, "ruling"));
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
  // 回填落账：--verdict 指向已 resolve 线程 → 不 resolve 不回复，理由引用线程内既有末条回复原文
  const backfilled = [...verdicts.entries()].filter(([id]) => !openIds.has(id));
  for (const [id, verdict] of backfilled) {
    const t = resolved.find((x) => lastOf(x)?.databaseId === id);
    if (!t) continue;
    writeRuling(buildRow(t, verdict, null, null, "backfill"));
    console.log(`backfilled verdict: ${id}=${verdict}`);
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
  // 竞态防护：bot 复审有延迟，全部线程 resolve ≠ 最新 commit 的复审已提交。
  // PR #9 的三条降级意见就是在合并瞬间才落地（无线程、闭环对它不可见），合并前无从核对。
  // 翻页遍历：长生命周期 PR 的 review 数可超单页（PR #9 已 17 条）；上限 5 页（500 条）已远超实际，超出按「复审在途」提示，方向安全
  let reviewed = false;
  for (let page = 1; page <= 5; page++) {
    const reviews = await client.rest.pulls.listReviews({ owner, repo, pull_number: pullNumber, per_page: 100, page });
    if (reviews.data.some((r) => r.commit_id === pr.data.head.sha)) {
      reviewed = true;
      break;
    }
    if (reviews.data.length < 100) break;
  }
  if (!reviewed) {
    // 假阳性提示：翻页上限耗尽或真在途都走这里——方向保守（多提示不漏合并）
    console.log("⚠ 最新 head SHA 还没有任何 review 提交——bot 复审可能在途（PR #9 教训）。建议等复审落地、核对无降级意见后再合并");
  }
}

// 只在作为脚本直接执行时跑 main；被测试 import 时不执行
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("resolve 失败", err);
    process.exit(1);
  });
}
