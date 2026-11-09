// worker 阶段机（D026，spec 见 docs/plans/async-worker.md）：审查拆 prepare / review / publish 三阶段，
// 每阶段独立函数调用、独立 300s 预算，阶段间用 HMAC-SHA256 签名信封自调用 /api/worker 续链——
// 突破单函数 300s 墙钟，为工具循环（路线图 4 第二阶段）与决策模型路由（第 3 项）提供
// 「串行深度有界、预算按阶段拆分」的运行底座。与 Vercel 解耦同 handleWebhook：headers/body 进、{status, note} 出。
// 复用 webhook.ts 的验签与头解析（webhook.ts 反向导入本文件的 chainWorker / prepareEnvelope，成环——
// 双方都只在调用期使用对方绑定，ESM 语义安全；为「验签逻辑不动」避免抽出第三个文件）。
import { createHmac } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import type { Octokit } from "octokit";
import { verifySignature, header, type WebhookHeaders, type Dispatch } from "./webhook.ts";
import { fetchPr, getOctokit, postReview, postTimeoutNotice, setReviewStatus, type PrRef } from "./github.ts";
import { hasReviewed } from "./dedupe.ts";
import { decideIncrement, fetchDeltaDiff, latestValidReview, listBotReviews, listCommitShas } from "./incremental.ts";
import { buildPrevFindingsForPr, fetchDismissedFindings, prevFindingsMaxChars } from "./findings.ts";
import { buildRepoContext, fileReaderFromEntries, makeSnapshot, searcherFromEntries, snapshotTree } from "./context.ts";
import { buildTaskContextForPr } from "./task.ts";
import {
  buildReviewPrompt,
  fileToolEnabled,
  llmTimeoutMs,
  reviewDiff,
  TOOL_PROMPT_MAX_CHARS,
  type ReviewDiffOpts,
  type ReviewOutcome,
} from "./review.ts";
import { decisionModel, diffSkeleton, runReviewRouter, type ReviewPlan } from "./router.ts";
import { buildRunRecord, writeRunRecord, type RunRecord } from "./runs.ts";

export type WorkerStage = "prepare" | "review" | "publish";

// 信封（D026）：阶段产物 state 随请求直传，不在外部存中间态——单次审查中间态最大 ~400KB
// （DIFF_MAX_CHARS 300k + CONTEXT_MAX_CHARS 100k），远小于 Vercel 请求体 4.5MB 上限；
// 重派生（下阶段重拉 diff + 重下 zipball）多烧 API 配额且引入两次快照漂移风险，pass-state 更确定
export type WorkerEnvelope = {
  v: 1;
  stage: WorkerStage;
  hop: number; // 已执行的续链次数，MAX_HOPS 封顶
  ref: PrRef & { headSha: string; headRepo?: string };
  issuedAt: number; // Date.now()，新鲜度窗口校验
  state?: Record<string, unknown>; // prepare→review 带 diff/context；review→publish 累积带 result
};

// hop 封顶：固定三跳理论上到不了，防御后续阶段扩展期（review 阶段内扩展轮数）的失控循环
export const MAX_HOPS = 4;
// 新鲜度窗口：信封只能由内部铸造（需 WEBHOOK_SECRET），窗口限的是合法信封被截获后的重放面
const ENVELOPE_FRESH_MS = 10 * 60 * 1000;
// 未来时间戳容差：issuedAt 取未来值等效把重放窗拉成无限，60s 覆盖跨机钟差（自审 nit）
const CLOCK_SKEW_MS = 60 * 1000;
// 续链最多尝试次数、间隔与单次硬超时（D026）：终失败由当前调用 best-effort 落 failure status，不静默。
// 硬超时必须远小于本函数 300s 墙钟——自调用挂起会占满 waitUntil 直到平台强杀，重试与落灯都到不了，
// 恰是本机制要消灭的永久 pending 黄灯（PR #29 自审 major）。10s 内：自调用无公网往返，冷启动排队
// 超 10s 时第 2 次尝试命中的已是热函数（排队耗在首次上），重试即天然冷启动兜底
const CHAIN_TIMEOUT_MS = 10_000;
// review 阶段 LLM 上限（PR #29 自审 major 的墙钟算账）：最坏路径 = LLM 打满 + 续链 2×10s+2s + 落灯 ~2s，
// 260 + 22 + 2 ≈ 284s < 300s 平台强杀线（留 ~16s 平台开销余量）；现端点 20s 级，封顶只在慢端点场景生效；
// 慢端点的预算压力由阶段机天然可拆（review 可再分跳）吸收，不动 LLM_TIMEOUT_MS 语义（D011）
const REVIEW_STAGE_LLM_CAP_MS = 260_000;
// 阶段墙钟：比平台 300s 强杀线早 ~15s，给落灯的 GitHub API 调用留余量——阶段内任何无超时的挂起
// （octokit 分页/回帖等）到线即落 failure「审查中断」，不把 waitUntil 占满到强杀（永久 pending，自审 major）。
// 迟到的阶段工作若最终完成，success 覆盖 failure（status last-write-wins），语义自愈
const STAGE_DEADLINE_MS = 285_000;
// 终态 status 写入的限时：落灯路径（闸门拒绝/墙钟兜底）在 race 覆盖之外，GitHub API 挂起会绕过全部
// 兜底直通永久 pending——写入超过 10s 即放弃等待（调用悬空无害，status 平台侧要么成了要么没成）
const STATUS_WRITE_TIMEOUT_MS = 10_000;

// 依赖注入（生产默认、测试传 mock）：schedule 调度后台任务；client 工厂延迟构造（缺 token 不炸 handler）；
// review / chain / fetchImpl 可替换——chain 默认即 chainWorker，测试传 spy 观察信封；
// route 为决策路由（D028），测试传 mock 观察「审什么」计划的注入
export type WorkerDeps = {
  schedule: (task: () => Promise<void>) => void;
  client: () => Octokit;
  review: (diff: string, context?: string, opts?: ReviewDiffOpts) => Promise<ReviewOutcome>;
  chain: (envelope: WorkerEnvelope) => Promise<void>;
  route: (args: { tree: string; skeleton: string }) => Promise<ReviewPlan | null>;
  // Run 写时持久化（#122 / D041）：默认 writeRunRecord（内部吞错 + 凭证门），测试传 spy 观察；
  // 写入点在 postReview + status 落定之后（P1-5 顺序约束），失败绝不影响已成功的审查
  writeRun: (record: RunRecord) => Promise<void>;
  fetchImpl: typeof fetch;
  chainRetryDelayMs: number;
  chainTimeoutMs: number;
  chainAttempts: number;
  // 阶段墙钟：阶段内任何挂起（octokit 调用无超时等）超线即落 failure，不等平台 300s 强杀
  stageDeadlineMs: number;
};

export function defaultWorkerDeps(): WorkerDeps {
  return {
    schedule: (task) => waitUntil(task()),
    client: getOctokit,
    review: reviewDiff,
    chain: chainWorker,
    route: runReviewRouter,
    writeRun: writeRunRecord,
    fetchImpl: fetch,
    chainRetryDelayMs: 2_000,
    chainTimeoutMs: CHAIN_TIMEOUT_MS,
    chainAttempts: 2,
    stageDeadlineMs: STAGE_DEADLINE_MS,
  };
}

// webhook 的调度对象（D026）：从「整个 runReview」改为「发 prepare 信封」——首个阶段也跑在新调用里，
// 所有阶段共用同一条代码路径，没有「第一阶段特殊」的分支
export function prepareEnvelope(ref: PrRef & { headSha: string; headRepo?: string }): WorkerEnvelope {
  return { v: 1, stage: "prepare", hop: 0, ref, issuedAt: Date.now() };
}

function stageKey(ref: PrRef & { headSha: string }): string {
  return `${ref.owner}/${ref.repo}#${ref.pullNumber}@${ref.headSha.slice(0, 7)}`;
}

// 信封结构校验：签名闸已保证铸造者，这里只挡「字段缺失/类型漂移」——从宽解析，深度语义由阶段内消费；
// 不合法抛错由调用方 400。hop/issuedAt 的类型必须在这里收紧（NaN 会绕过下方数值比较闸）
function parseEnvelope(raw: unknown): WorkerEnvelope {
  if (typeof raw !== "object" || raw === null) throw new Error("envelope is not an object");
  const e = raw as Record<string, unknown>;
  if (e.v !== 1) throw new Error(`unsupported envelope version: ${String(e.v)}`);
  if (e.stage !== "prepare" && e.stage !== "review" && e.stage !== "publish") {
    throw new Error(`unknown stage: ${String(e.stage)}`);
  }
  const ref = e.ref as Record<string, unknown> | undefined;
  if (
    typeof ref?.owner !== "string" ||
    typeof ref.repo !== "string" ||
    typeof ref.pullNumber !== "number" ||
    typeof ref.headSha !== "string"
  ) {
    throw new Error("envelope ref 字段缺失或类型漂移");
  }
  if (typeof e.hop !== "number" || !Number.isInteger(e.hop) || e.hop < 0) {
    throw new Error(`invalid hop: ${String(e.hop)}`);
  }
  return e as unknown as WorkerEnvelope;
}

// worker 入口（D026）：验签 → 结构校验 → 三闸（签名 / 新鲜度 / hop 封顶）→ 调度阶段执行，当前函数立刻 200。
// 头名用独立的 x-worker-signature 与 GitHub 事件语义区分——x-hub-signature-256 只属于 GitHub 来信
export function handleWorker(headers: WebhookHeaders, rawBody: string, deps?: Partial<WorkerDeps>): Dispatch {
  // 注入的 deps 要随链传递：默认 chain 携带本次注入继续向前，否则本地直调/多跳扩展时 mock（或定制实现）会中途丢失。
  // 生产路径 deps 为空，等价于 chainWorker(next) 原样续链
  const d: WorkerDeps = {
    ...defaultWorkerDeps(),
    ...deps,
    chain: deps?.chain ?? ((next) => chainWorker(next, deps)),
  };
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) throw new Error("缺少环境变量 WEBHOOK_SECRET（scripts/setup-webhook.ts 首跑自动生成）");
  if (!verifySignature(secret, rawBody, header(headers, "x-worker-signature"))) {
    return { status: 403, note: "worker signature verification failed" };
  }
  let envelope: WorkerEnvelope;
  try {
    envelope = parseEnvelope(JSON.parse(rawBody));
  } catch {
    return { status: 400, note: "invalid worker envelope" };
  }
  const key = stageKey(envelope.ref);
  // 新鲜度闸：issuedAt 距今超 10 分钟 403（限重放窗口）；issuedAt 缺失/非数值按过期处理（fail-closed 同 D021 口味）。
  // 与 hop 闸同样要落 failure status：信封过期意味着链路断在这里（发送方可能已死）——pending 黄灯比红灯误导（D017）。
  // 落灯安全的前提是已过验签闸（签名合法才可能是内部铸造的合法链路）；上方签名/解析两闸在认证前，
  // 落灯会给伪造请求开出「用别人的 SHA 写 status」的面，故保持无副作用
  const skew = Date.now() - envelope.issuedAt;
  if (!Number.isFinite(envelope.issuedAt) || skew > ENVELOPE_FRESH_MS || skew < -CLOCK_SKEW_MS) {
    console.error(`[worker] ${key} 信封过期（issuedAt 超窗或明显超前 ${skew}ms），拒绝续链`);
    d.schedule(() => markTerminalAfterGate(d.client, key, envelope.ref));
    return { status: 403, note: "stale worker envelope" };
  }
  // hop 封顶闸：403 之外还要落 failure status——链路断在这里时 pending 黄灯比红灯更具误导性（D017）
  if (envelope.hop > MAX_HOPS) {
    console.error(`[worker] ${key} hop ${envelope.hop} 超过上限 ${MAX_HOPS}，拒绝续链`);
    d.schedule(() => markTerminalAfterGate(d.client, key, envelope.ref));
    return { status: 403, note: "worker hop limit exceeded" };
  }
  // 阶段执行调度在 waitUntil：当前函数立刻 200，阶段末尾的续链 POST 也在本任务内完成（D026）。
  // runStage 自吞错误，catch 只兜 deps 构造等意外逃逸，避免 unhandled rejection 砸掉 Vercel 函数
  d.schedule(() =>
    // 阶段墙钟 race（自审 major）：runStage 自吞已知失败，race 兜「阶段内挂起」与意外逃逸两个类，
    // 超线/逃逸都落 failure「审查中断」——catch 到不了的状态（进程被杀）不再是永久 pending。
    // 用带清理的 withDeadline：正常完成即 clearTimeout，不让 285s 定时器把 waitUntil 存续拉到墙钟上限（自审 minor）
    withDeadline(runStage(d, envelope), d.stageDeadlineMs, `阶段 ${envelope.stage}`).catch((err) => {
      console.error(`[worker] ${key} 阶段 ${envelope.stage} 异常逃逸/阶段墙钟超时`, err);
      return markFailed(d.client, key, envelope.ref, "审查中断");
    }),
  );
  return { status: 200, note: `worker ${envelope.stage} scheduled: ${key}` };
}

// 单阶段执行：失败 status 落定集中在 catch，与原 runReview 逐字一致（「永久 pending 比红灯更具误导性」）。
// 阶段产物经 deps.chain 交给下一阶段；publish 为终态不续链。
// client 按阶段惰性构造：review 阶段零 GitHub 依赖（失败兜底才需要 client），prepare/publish 各自构造
export async function runStage(deps: WorkerDeps, envelope: WorkerEnvelope): Promise<void> {
  const { ref } = envelope;
  const key = stageKey(ref);
  let client: Octokit | undefined;
  // review 阶段实际生效的 LLM 超时：catch 里的降级通知/日志必须报同一个数，排查时口径一致（自审 minor）
  let effectiveLlmTimeoutMs = Math.min(llmTimeoutMs(), REVIEW_STAGE_LLM_CAP_MS);
  // 预算外消耗累计（快照 + router），在 deps.review 调用点一次性触底扣减
  let budgetUsedMs = 0;
  try {
    if (envelope.stage === "prepare") {
      client ??= deps.client();
      if (await hasReviewed(client, ref, ref.headSha)) {
        // 重派命中（webhook 重投/信封重试）：审查已存在——与 publish 二次 dedupe 同语义，补落 success 终态。
        // 静默跳过会把「上次 postReview 成功但 status 未落定」的重派永久留在 pending 黄灯（自审 minor，PR #29）
        console.log(`[worker] ${key} prepare dedupe：已有同 SHA 审查，补落 success status（幂等，D010）`);
        try {
          await setReviewStatus(client, { ...ref, sha: ref.headSha }, "success", "完成（重派路径补落终态）");
        } catch (statusErr) {
          console.error(`[worker] ${key} success status 写失败`, statusErr);
        }
        return;
      }
      // 审查生命周期 status（D017）：开始即 pending，补上「review 尚未发布」的合并窗口期；
      // 失败只记日志不连坐流程，status 由成功/失败路径分别落定
      try {
        await setReviewStatus(client, { ...ref, sha: ref.headSha }, "pending", "审查进行中");
      } catch (statusErr) {
        console.error(`[worker] ${key} pending status 写失败`, statusErr);
      }
      const { diff: fullDiff, title, body } = await fetchPr(client, ref);
      // 增量审查决策（D032，best-effort）：base 推导 + block 继承（listBotReviews/listCommitShas），
      // delta 命中则 compare 拉区间 diff 替换全量；任何一层失败 console.log + 保持全量——
      // 增量是优化不是依赖，绝不因增量路径失败导致 push 无审查。fetchPr 仍先拉全量：title/body 是
      // D029 任务块的输入，compare 路径不提供；全量 diff API 的成本相对 LLM 侧可忽略
      let diff = fullDiff;
      let incrementalBase: string | null = null;
      let previousFindings: string | null = null;
      try {
        const reviews = await listBotReviews(client, ref);
        const commitShas = await listCommitShas(client, ref);
        const decision = decideIncrement({ headSha: ref.headSha, reviews, commitShas });
        if (decision.mode === "delta") {
          const deltaDiff = await fetchDeltaDiff(client, ref, decision.base);
          diff = deltaDiff;
          incrementalBase = decision.base;
          console.log(`[worker] ${key} 增量审查：区间 ${decision.base.slice(0, 7)}..${ref.headSha.slice(0, 7)}（${deltaDiff.length} 字符，全量 ${fullDiff.length} 字符）`);
        } else {
          console.log(`[worker] ${key} 增量决策：${decision.mode}（${decision.reason}）`);
          // 上一轮意见复报保真（D035，best-effort）：只在 full 路径注入——block 继承全量重审是措辞漂移的
          // 主场景；delta 不注入（老意见锚点不在区间 diff 内，行内定位必 422，老意见留在旧线程）。
          // 与增量决策共用同一次 listBotReviews/listCommitShas（latestValidReview 同源推导），零额外列表调用
          if (decision.mode === "full") {
            const latest = latestValidReview(reviews, commitShas);
            if (latest) {
              // dismissed（D035 v2 #93，best-effort）：已 resolve 裁定不修复的线程随块注入（规则 4 不重报）。
              // 取数显式在编排层（不进 buildPrevFindingsForPr——测试好 mock），kill switch 下跳过（零 API 调用
              // 同口径）；fetchDismissedFindings 内部失败兜底 []，不连垮。delta 路径不取（同上述 delta 不注入口径）。
              // bot 身份 = latest review 的提交者（bot major 自审 #95：dismissed 判据只看 body 前缀会被
              // 作者伪造的假意见 + resolve 借规则 4 抑制任意位置发现——身份不符的线程一律不进）。
              // latest 即 parseBotReviews 输出、自带 user，无需按 id 反查
              const botLogin = latest.user;
              const dismissed = prevFindingsMaxChars() > 0 ? await fetchDismissedFindings(client, ref, botLogin) : [];
              previousFindings = await buildPrevFindingsForPr(client, ref, latest, fullDiff, dismissed);
            }
          }
        }
      } catch (err) {
        console.log(`[worker] ${key} 增量决策失败，回退全量（D032 best-effort）`, err);
      }
      // 仓库上下文（D023，best-effort）：失败返回 null、审查照旧，绝不连垮主流程
      const context = await buildRepoContext({ headRepo: ref.headRepo ?? `${ref.owner}/${ref.repo}`, headSha: ref.headSha, diff });
      // 任务上下文（D029，best-effort）：PR 标题 + 关联 issue 正文进任务块；无关联/拉取失败/预算关闭返回 null，
      // null 随信封传递（「无任务块」与「信封缺字段」同义），4k 字符预算封顶远小于 4.5MB 请求体上限
      const taskContext = await buildTaskContextForPr(client, ref, title, body);
      await deps.chain({
        v: 1,
        stage: "review",
        hop: envelope.hop + 1,
        ref,
        issuedAt: Date.now(),
        // startedAt：run 起点随信封贯通到 publish（RunRecord.startedAt 来源，#122）；state 累积传递自然到达
        state: { diff, context, taskContext, incrementalBase, previousFindings, startedAt: envelope.issuedAt },
      });
      return;
    }
    if (envelope.stage === "review") {
      const state = (envelope.state ?? {}) as {
        diff?: string;
        context?: string | null;
        taskContext?: string | null;
        previousFindings?: string | null;
      };
      if (typeof state.diff !== "string") throw new Error("review 信封缺 state.diff");
      // taskContext（D029）：null 传递按无任务块审查（与 context 的 `?? undefined` 同形）
      const taskContext = typeof state.taskContext === "string" ? state.taskContext : undefined;
      // previousFindings（D035）：同形——null 传递按无上一轮意见块审查
      const previousFindings = typeof state.previousFindings === "string" ? state.previousFindings : undefined;
      // read_file 工具循环（D027）+ 决策路由（D028）共用的快照预判与获取。快照预判（自审 minor）：
      // 与 reviewDiff 的 TOOL_PROMPT_MAX_CHARS 规模闸同一阈值——大 prompt 场景工具循环必被跳过，
      // 先取快照白吃最多 25MB/10s 预算，且这正是最易撞阶段墙钟的超大 PR 路径。
      // 用 buildReviewPrompt（与 reviewDiff 同一构造函数，自审三轮：曾用 diff+context 估算出现 +14 偏移
      // 与 >=/> 比较符的边界分叉）——预判与闸吃同一字符串、同一比较符，永不矛盾。
      // 注：预判时 plan 尚不存在（router 在其后才跑），计划块 ~1k 字符的边界漂移属既有软约束口径，不为它加 plumbing；
      // taskContext 已就绪（prepare 产物随信封到达），直接进预判不漂移；previousFindings（D035）同批就绪
      const promptEstimate = buildReviewPrompt(state.diff, {
        context: typeof state.context === "string" ? state.context : undefined,
        taskContext,
        previousFindings,
      }).length;
      const snapshotSkippedByGate = fileToolEnabled() && promptEstimate > TOOL_PROMPT_MAX_CHARS;
      // 需要快照的条件（D028 重构）：read_file 工具循环需要快照内容，决策路由需要快照文件树——
      // 任一需要即取，一次下载共用（router 拿树、reader 拿内容），不做第二次 zipball 请求
      const needReader = fileToolEnabled() && !snapshotSkippedByGate;
      const routerOn = decisionModel() !== undefined;
      const snapshotStart = Date.now();
      const entries =
        needReader || routerOn
          ? await makeSnapshot({ headRepo: ref.headRepo ?? `${ref.owner}/${ref.repo}`, headSha: ref.headSha }, deps.fetchImpl)
          : undefined;
      const fileReader = needReader && entries ? fileReaderFromEntries(entries) : undefined;
      // search_file（D031）与 read_file 共用同一份快照（一次下载两个消费方），同生同灭
      const searcher = needReader && entries ? searcherFromEntries(entries) : undefined;
      budgetUsedMs += Date.now() - snapshotStart;
      const fileReaderNote = fileReader
        ? "生效（D027/D031 工具循环）"
        : snapshotSkippedByGate
          ? "未注入（prompt 超规模闸，跳过工具循环）"
          : "未注入（关闭或快照失败降级）";
      console.log(`[worker] ${key} review 阶段 fileReader/searcher ${fileReaderNote}`);
      // 决策模型路由（D028，best-effort）：DECISION_MODEL 注入且快照就绪才跑；失败 console.error 一行 +
      // 无计划继续（绝不重试——多一次重试 = 预算翻倍风险，计划是增强不是依赖；绝不连垮主评审），
      // 耗时从主评审预算扣除（快照扣减同款写法）。eval 路径不经过这里（直调 reviewDiff 无 plan）
      let plan: ReviewPlan | undefined;
      if (routerOn) {
        if (!entries) {
          console.log(`[worker] ${key} router 跳过：快照不可用，无文件树（D028 best-effort）`);
        } else {
          const routerStart = Date.now();
          try {
            plan = (await deps.route({ tree: snapshotTree(entries), skeleton: diffSkeleton(state.diff) })) ?? undefined;
          } catch (err) {
            console.error(`[worker] ${key} router 失败，无计划继续（best-effort，D028）`, err);
          }
          budgetUsedMs += Date.now() - routerStart;
        }
      }
      // 触底只在最终给主评审预算时做一次：initial - 实际已耗（快照+router），下限 60s 兜底——
      // 阶段总时长仍由 285s 墙钟 race 兜底，预算承诺是 best-effort 而非硬保证
      effectiveLlmTimeoutMs = Math.max(deductBudget(effectiveLlmTimeoutMs, budgetUsedMs), 60_000);
      console.log(`[worker] ${key} 主评审预算 ${effectiveLlmTimeoutMs}ms（已耗 ${budgetUsedMs}ms：快照+router）`);
      if (plan) console.log(`[worker] ${key} 计划块 ${JSON.stringify(plan).length} 字符（promptEstimate 未含，边界漂移为已接受软约束）`);
      const result = await deps.review(state.diff, state.context ?? undefined, {
        timeoutMs: effectiveLlmTimeoutMs,
        fileReader,
        searcher,
        plan,
        taskContext,
        previousFindings,
      });
      // state 累积传递：publish 的 postReview 仍需 diff 做行内预定位（splitByLocatable）
      await deps.chain({ v: 1, stage: "publish", hop: envelope.hop + 1, ref, issuedAt: Date.now(), state: { ...state, result } });
      return;
    }
    // publish（终态）：二次 dedupe 防重派——续链重试/信封重放会把 publish 再投一次（D026「明确不做」幂等键，
    // 重放由这里 + status 幂等吸收）
    client ??= deps.client();
    if (await hasReviewed(client, ref, ref.headSha)) {
      // 重派命中的最常见场景：上次 postReview 已成功、success status 没落定（崩溃在两步之间 / 写失败被吞）——
      // 静默跳过会把 pr-review 永久留在 pending 黄灯，这里补落 success 终态（自审 minor；review 已存在，
      // 意见分布无从复得，description 用通用文案；status 重复写幂等无害）
      console.log(`[worker] ${key} publish 二次 dedupe：已有同 SHA 审查，补落 success status`);
      try {
        await setReviewStatus(client, { ...ref, sha: ref.headSha }, "success", "完成（重派路径补落终态）");
      } catch (statusErr) {
        console.error(`[worker] ${key} success status 写失败`, statusErr);
      }
      return;
    }
    const state = (envelope.state ?? {}) as {
      diff?: string;
      result?: ReviewOutcome;
      incrementalBase?: string | null;
      startedAt?: number;
    };
    if (typeof state.diff !== "string" || !Array.isArray(state.result?.comments)) {
      throw new Error("publish 信封缺 state.diff / state.result");
    }
    const posted = await postReview(
      client,
      { owner: ref.owner, repo: ref.repo, pullNumber: ref.pullNumber, commitId: ref.headSha },
      state.result,
      state.diff,
      { incrementalBase: state.incrementalBase ?? null },
    );
    console.log(
      `[worker] ${key} 完成：${posted.inline} 条行内（进线程可闭环），${posted.degraded} 条降级进 body` +
        `${posted.folded ? `，${posted.folded} 条 minor/nit 折叠（D032 门槛）` : ""}` +
        `${state.incrementalBase ? `（增量 ${state.incrementalBase.slice(0, 7)}..${ref.headSha.slice(0, 7)}）` : ""}`,
    );
    try {
      await setReviewStatus(
        client,
        { ...ref, sha: ref.headSha },
        "success",
        posted.degraded > 0
          ? `完成：${posted.inline} 条行内 / ${posted.degraded} 条降级进 body`
          : `完成：${posted.inline} 条意见${posted.folded ? ` + ${posted.folded} 条 minor/nit 折叠` : ""}`,
      );
    } catch (statusErr) {
      console.error(`[worker] ${key} success status 写失败`, statusErr);
    }
    // Run 写时持久化（#122 / D041，best-effort）：在 postReview + status 落定**之后**（P1-5 顺序约束），
    // 构造失败只跳过并落日志——已成功的审查绝不被观测写入连坐。deps.writeRun 内部吞错，
    // 这里 try/catch 只兜自定义注入抛出的意外；失败日志只打 err 对象（不含 record 内容）
    const built = buildRunRecord(
      ref,
      state.result,
      posted,
      state.incrementalBase ?? null,
      typeof state.startedAt === "number" ? state.startedAt : null,
      Date.now(),
    );
    if (built.ok) {
      try {
        await deps.writeRun(built.record);
      } catch (writeErr) {
        console.error(`[runs] ${key} 写入失败`, writeErr);
      }
    } else {
      console.error(`[runs] ${key} 记录构造失败，跳过写入：${built.reason}`);
    }
  } catch (err) {
    // failure status 落定独立于任何其他动作成败；isTimeoutError 随 runReview 迁入，超时语义不变（D011）
    if (isTimeoutError(err)) {
      console.error(`[worker] ${key} LLM 超时（${effectiveLlmTimeoutMs}ms），发降级通知（D011）`);
      try {
        await postTimeoutNotice(getFallbackClient(deps, client), ref, effectiveLlmTimeoutMs);
      } catch (postErr) {
        console.error(`[worker] ${key} 降级通知发送失败`, postErr);
      }
      await markFailed(() => getFallbackClient(deps, client), key, ref, "审查超时，重推 commit 可重试");
      return;
    }
    await markFailed(() => getFallbackClient(deps, client), key, ref, "审查失败，见 Vercel 日志");
    console.error(`[worker] ${key} 审查失败`, err);
  }
}

// catch 路径的 client 兜底：try 里 client 工厂可能没走到（缺 token 抛出）——与原 runReview 的 `client ?? getOctokit()` 同形
function getFallbackClient(deps: WorkerDeps, client: Octokit | undefined): Octokit {
  return client ?? deps.client();
}

// failure status 落定独立于任何其他动作成败——永久 pending（「审查在途」的黄灯）比红灯更具误导性（D017）。
// client 走工厂：构造本身可能失败（缺 token），一并吞进 best-effort 语义；写入限时见 STATUS_WRITE_TIMEOUT_MS
async function markFailed(client: () => Octokit, key: string, ref: PrRef & { headSha: string }, description: string): Promise<void> {
  try {
    await Promise.race([
      setReviewStatus(client(), { ...ref, sha: ref.headSha }, "failure", description),
      sleep(STATUS_WRITE_TIMEOUT_MS).then(() => {
        throw new Error(`status 写入超 ${STATUS_WRITE_TIMEOUT_MS}ms 未返回`);
      }),
    ]);
  } catch (statusErr) {
    console.error(`[worker] ${key} failure status 写失败`, statusErr);
  }
}

// 闸门拒绝路径的终态落定（PR #29 自审 minor）：合法信封迟到（冷启动排队超新鲜窗等）时，审查可能已由
// 另一条重试链完成——直接落 failure 会把已成功的 pr-review 翻成红灯。先查 dedupe：已审 → 补落 success
// （与 publish 二次 dedupe 同语义）；未审 → 链路确实断在这里 → failure「审查中断」。dedupe 查询失败按未审
// 处理：断链需要信号，误落的 failure 可由重推/复审翻正，反之永久 pending 无出口
async function markTerminalAfterGate(client: () => Octokit, key: string, ref: PrRef & { headSha: string }): Promise<void> {
  let reviewed = false;
  try {
    reviewed = await hasReviewed(client(), ref, ref.headSha);
  } catch (dedupeErr) {
    console.error(`[worker] ${key} 闸门路径 dedupe 查询失败，按未审落 failure`, dedupeErr);
  }
  const write = reviewed
    ? setReviewStatus(client(), { ...ref, sha: ref.headSha }, "success", "完成（重派路径补落终态）")
    : setReviewStatus(client(), { ...ref, sha: ref.headSha }, "failure", "审查中断");
  try {
    await Promise.race([
      write,
      sleep(STATUS_WRITE_TIMEOUT_MS).then(() => {
        throw new Error(`status 写入超 ${STATUS_WRITE_TIMEOUT_MS}ms 未返回`);
      }),
    ]);
  } catch (statusErr) {
    console.error(`[worker] ${key} 闸门终态 status 写失败`, statusErr);
  }
}

// 续链（D026）：POST 信封到自部署的 /api/worker。目标 URL 用平台自动注入的 VERCEL_URL（preview 与 production
// 各自自洽；webhook 挂 production，链自然全在 production）。最多 2 次尝试（间隔 chainRetryDelayMs、
// 单次硬超时 chainTimeoutMs；仅网络异常/5xx/429 重试，确定性 4xx 直接终失败），
// 终失败由当前调用 best-effort 落 failure status「审查中断」——续链失败不静默，避免永久 pending 黄灯（D017）。
// 本函数不抛出：失败语义已闭环（落灯 + 日志），抛出只会变成上游 waitUntil 的 unhandled rejection
export async function chainWorker(envelope: WorkerEnvelope, deps?: Partial<WorkerDeps>): Promise<void> {
  // 同 handleWorker：默认 chain 携带本次注入向前传递，多跳串行（本地直调回退）中注入不丢失
  const d: WorkerDeps = {
    ...defaultWorkerDeps(),
    ...deps,
    chain: deps?.chain ?? ((next) => chainWorker(next, deps)),
  };
  const key = stageKey(envelope.ref);
  // 续链目标：WORKER_BASE_URL 显式配置 > VERCEL_URL 兜底。VERCEL_URL 是部署专属 URL，Vercel Standard
  // Protection 会挡它（生产实测 403 秒败，PR #30 dogfood 抓到）——alias 域名才公开可达。
  // 曾实现「webhook 从请求 Host 自发现 origin 随信封传递」，自审二轮否决：重放的 webhook payload 带合法
  // GitHub 签名、可伪造 Host 头，origin 即成「信封内 diff/context 送往攻击者服务器」的外泄通道——
  // 续链目标里不能有任何请求头派生的输入，显式环境变量是唯一可信源
  const base = chainBase();
  if (!base) {
    // 全部未设置（本地 scripts / 单测）→ 不走 HTTP，直接在本进程执行下一阶段（同 schedule 直调语义）——
    // 本地链路与生产行为一致、可单测
    await runStage(d, envelope);
    return;
  }
  const url = `${base}/api/worker`;
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    // 缺 secret 理论上到不了（webhook/worker 入口验签用的就是同一 secret），但本函数跑在 waitUntil 里，
    // 抛出即 unhandled rejection——并入终失败路径，保持「不抛出」注释为真（PR #29 自审 minor）
    console.error(`[worker] ${key} 续链失败：缺少 WEBHOOK_SECRET，无法签名信封`);
    await markFailed(d.client, key, envelope.ref, "审查中断");
    return;
  }
  const body = JSON.stringify(envelope);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= d.chainAttempts; attempt++) {
    try {
      const res = await d.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-signature": signature },
        body,
        // 单次硬超时：自调用挂起（网络黑洞 / 冷启动卡死）时及时进入重试与落灯路径
        signal: AbortSignal.timeout(d.chainTimeoutMs),
      });
      // 先消费/取消响应体再判 ok：undici 在 body 未读完前不归还底层连接，2 次重试即漏 2 个 socket（自审 minor）。
      // cancel 自身 reject（对端异常断流）不参与成败判定——链路可能已送达并在新调用里开跑，误判会落假 failure 灯
      await res.body?.cancel().catch(() => {});
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
      // 确定性 4xx（信封超限 413 / 结构非法 400 / 校验拒绝 403）重试必同败，不白等间隔直接终失败；
      // 仅网络异常（含上面的超时）与 5xx / 429 / 408 值得再试——408 与网络异常同属瞬态故障，冷启动/高负载时常见（自审 minor）。
      // 重试语义是 at-least-once：超时≠未送达，重试可能同一阶段双跑（review 双份 LLM，上界 1 次额外调用）——
      // 零基建约束下无 exactly-once（D026 备选否决外部存储），回帖副作用由 prepare/publish dedupe 吸收，
      // 成本上界可接受；省 token 的「review 跳过重试」会引入假 failure 灯，取舍维持可用性优先
      if (res.status < 500 && res.status !== 429 && res.status !== 408) break;
    } catch (err) {
      lastErr = err;
    }
    if (attempt < d.chainAttempts) await sleep(d.chainRetryDelayMs);
  }
  console.error(`[worker] ${key} 续链 ${url} 失败（${d.chainAttempts} 次），best-effort 落 failure status`, lastErr);
  await markFailed(d.client, key, envelope.ref, "审查中断");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// LLM 预算扣减（D028）：前置耗时（快照/router）从主评审预算中扣除，下限 60s 防御性兜底——主评审再挤也有 60s。
// PR #30 快照扣减的同一写法抽成单点，防快照/router 两处扣减漂移（router 上限 60s + 下限 60s 的组合
// 保证「router 打满 + 主评审打满」不突破 review 阶段 260s LLM 封顶）
// 纯扣减（不触底）：触底下限只在 deps.review 调用点统一做一次（自审 major：逐次触底的双重下限
// 会让预算承诺漂移，如 90s 配置下「快照 40s + router 60s」各触一次底）
export function deductBudget(effective: number, elapsed: number): number {
  return effective - elapsed;
}

// 续链 base 选择：WORKER_BASE_URL（无路径 http(s) URL，不合法 warn 后视为未配置）> VERCEL_URL；
// 不引任何请求头派生值（PR #30 自审二轮：origin 自发现是 diff 外泄通道，见 chainWorker 注释）
// 无路径 http(s) 绝对 URL 校验：正则会放过 `?`/`#`（拼出来 query 在前打到错误路径），用 URL 解析断言
// protocol 与空 pathname（自审 minor）
function isValidChainBase(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && (u.pathname === "" || u.pathname === "/") && !u.search && !u.hash;
  } catch {
    return false;
  }
}

let warnedInvalidWorkerBase = false;

export function chainBase(): string | undefined {
  const explicit = process.env.WORKER_BASE_URL?.trim();
  let explicitState: "ok" | "invalid" | "unset" = "unset";
  if (explicit) {
    if (!isValidChainBase(explicit)) {
      // 一次审查至少两跳、每跳最多 2 次重试——同一配置错误会重复走到，告警一次即可（自审 minor）
      if (!warnedInvalidWorkerBase) {
        console.error(`[worker] WORKER_BASE_URL="${explicit}" 不是无路径的 http(s) URL，忽略，按未配置处理`);
        warnedInvalidWorkerBase = true;
      }
      explicitState = "invalid";
    } else {
      return explicit.replace(/\/+$/, "");
    }
  }
  const vercel = process.env.VERCEL_URL?.trim();
  if (!vercel) return undefined;
  if (process.env.VERCEL_ENV === "production") {
    // 显式 warn：生产走 VERCEL_URL 兜底大概率是 WORKER_BASE_URL 缺席/非法（部署专属 URL 被 Standard
    // Protection 403），失败只体现在 PR 状态灯上不易归因（自审降级 minor；措辞区分两种成因，自审 nit）
    const reason = explicitState === "invalid" ? "WORKER_BASE_URL 非法被忽略" : "未配置 WORKER_BASE_URL";
    console.error(`[worker] 生产环境${reason}，续链回退 VERCEL_URL（部署专属 URL，Standard Protection 下会 403）——请在部署环境变量配置公开可达域名`);
  }
  return `https://${vercel}`;
}

// 带 deadline 的 Promise.race：胜负一定即清理定时器——正常完成不留悬空 timer 占着 waitUntil 的存续时长
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 墙钟`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

// AbortSignal.timeout 抛出的 TimeoutError 可能被 AI SDK 包一层，沿 cause 链找（随 runReview 自 webhook.ts 迁入）
function isTimeoutError(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = (e as { cause?: unknown }).cause as Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return true;
  }
  return false;
}
