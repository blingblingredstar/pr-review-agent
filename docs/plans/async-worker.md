# 真正异步化：worker 阶段机 + 签名续链（D026 spec）

> 状态：待实现（本文件与实现同 PR 提交）。
> 目标：把审查拆成可在独立函数调用中执行的阶段，每阶段独立 300s 预算，阶段间用 HMAC 签名信封自调用续链——突破单函数 300s 墙钟，为工具循环（路线图 4 第二阶段）与决策模型路由（第 3 项）提供「串行深度有界、预算按阶段拆分」的运行底座（路线图第 8 项）。

## 决策与取舍

- **不引外部队列**（QStash / Vercel Workflows / cron 轮询）：路线图原文列过这两个候选，但都引第三方服务或平台专属原语。本仓口味是「零基建」（幂等去重 D010 不建外部存储同款）；HMAC 签名信封 + 自调用续链零新依赖，同账号同部署内闭环。QStash 记为规模化时的备选（持久队列、可见性超时、重试策略都是它带来的，当前规模用不上）。
- **信封状态随请求携带**（diff / context / result 直接进 POST body），不在外部存储中间态：单次审查中间态最大 ~400KB（DIFF_MAX_CHARS 300k + CONTEXT_MAX_CHARS 100k），远小于 Vercel 请求体 4.5MB 上限；重派生（下阶段重拉 diff + 重下 zipball）多烧 API 配额且引入两次快照漂移风险，pass-state 更确定。
- **webhook 变纯分发器**：验签/白名单/事件过滤仍在 webhook（零 API 零 token 的判定不后移），调度对象从「整个 runReview」改为「发 prepare 信封」——首个阶段也跑在新调用里，所有阶段共用同一条代码路径，没有「第一阶段特殊」的分支。

## 设计

### 信封

```ts
type WorkerEnvelope = {
  v: 1;
  stage: "prepare" | "review" | "publish";
  hop: number;                       // 已执行的续链次数，MAX_HOPS 封顶
  ref: PrRef & { headSha: string; headRepo?: string };
  issuedAt: number;                  // Date.now()，新鲜度窗口校验
  state?: Record<string, unknown>;   // 阶段产物：prepare→review 带 diff/context；review→publish 带 result
};
```

- 签名复用 webhook 的 HMAC-SHA256（`verifySignature`，密钥同为 `WEBHOOK_SECRET`），头名用独立的 `x-worker-signature`（与 GitHub 事件语义区分，`x-hub-signature-256` 只属于 GitHub 来信）。
- 校验三闸：签名不过 → 403；`issuedAt` 距今超 10 分钟 → 403（限重放窗口）；`hop > MAX_HOPS`（=4）→ 403 + failure status（理论上到不了，防御性）。
- 安全面评估：信封只能由 webhook/worker 内部铸造（需 WEBHOOK_SECRET），陌生人打 /api/worker 等价于打 /api/webhook 的验签闸——烧 token 的面没有扩大（Webhook token 安全结论，2026-10-30）。

### 阶段机

| 阶段 | 动作 | 续链 |
|---|---|---|
| `prepare` | dedupe（hasReviewed，命中即静默结束）→ pending status → `fetchPr` → `buildRepoContext` | → `review`（state 带 diff + context） |
| `review` | `reviewDiff(diff, context)` | → `publish`（state 带 result） |
| `publish` | 二次 dedupe 防重派（重试路径）→ `postReview` → success status / 超时降级通知 + failure status | 终态 |

- `reviewDiff` 本阶段仍是单调用（20s 级）；PR-30/31 的多轮工具循环 / 路由+评审两段调用在 `review` 阶段内扩展轮数，逼近本阶段预算时以 `publish` 收口——阶段机是给它们用的底座，本 PR 不改 LLM 调用形态。
- 失败语义与现状对齐：`review` 阶段超时 → `postTimeoutNotice`（D011）+ failure status「审查超时，重推 commit 可重试」；其他异常 → failure status「审查失败，见 Vercel 日志」。`isTimeoutError` 随迁。
- **续链失败不静默**：`chainWorker`（POST 信封到自部署）单次 30s 硬超时 + 最多 2 次尝试（间隔 2s；仅网络异常/5xx/429 重试，确定性 4xx 直接终失败——重试必同败不白等），终失败由当前调用 best-effort 落 failure status「审查中断」——避免永久 pending 黄灯（D017 窗口期语义；PR #29 自审 major+minor 采纳）。续链 POST 用 `waitUntil` 调度，当前函数立刻 200。
- 失败 status 落定动作集中在各阶段 catch，与现状逐字一致（「永久 pending 比红灯更具误导性」）。

### 续链目标与本地回退

- 目标 URL：`https://${VERCEL_URL}/api/worker`（Vercel 对每个部署自动注入，preview 与 production 各自自洽；webhook 挂 production，链自然全在 production）。
- `VERCEL_URL` 未设置（本地 `scripts/local.ts` / 单测）→ 不走 HTTP，直接在本进程执行下一阶段（同 `schedule` 直调语义）——本地链路与生产行为一致、可单测。

### 组件落点

| 文件 | 改动 |
|---|---|
| `api/worker.ts`（新）| 薄壳照抄 api/webhook.ts 形状：raw body → `handleWorker` → 响应；`maxDuration: 300` |
| `vercel.json` | `api/worker.ts` 加 `maxDuration: 300` + `includeFiles: "prompts/**"`（reviewDiff 读 prompt 文件） |
| `src/worker.ts`（新）| 信封签名/校验（复用 verifySignature）+ 三阶段函数（自 webhook.ts 迁入 runReview 逻辑拆分）+ `chainWorker`（注入式 dispatch，测试传 spy） |
| `src/webhook.ts` | `runReview` 及超时处理迁出；调度目标改为「发 prepare 信封」（`schedule` 注入点保留）；验签/白名单/过滤逻辑不动 |
| `test/worker.test.ts`（新）| 信封 roundtrip / 新鲜度拒绝 / hop 封顶 / 三阶段编排（mock github 与 review）/ 二次 dedupe / 续链失败落 failure status / webhook 发 prepare 信封形状 / 本地直调回退 |
| `test/webhook.test.ts` | 调度断言从「执行审查」改为「发信封」 |

### 明确不做（本 PR 边界）

- 不改 LLM 调用形态（无工具循环、无路由）；不改 dedupe 键；不改 status context；不引新环境变量（信封密钥复用 `WEBHOOK_SECRET`，`VERCEL_URL` 为平台注入）；eval 路径零接触（evals 直调 `reviewDiff`，promptHash 不变，红线 = usage 与基线逐位一致）。
- 不做续链的幂等键去重（同信封重放由 publish 二次 dedupe + status 幂等吸收；10 分钟新鲜度窗口限重放面）。

## 验收

1. `npm test` 全绿（新增 worker 用例）。
2. `npm run eval`：promptHash 不变，usage 合计与 2026-11-01 基线逐位一致（输入路径字节级不变的硬证据）。
3. 真实 PR dogfood：合并后 webhook 触发的审查在 Vercel 日志出现 prepare → review → publish 三段日志行，评论与 status 行为与合并前一致（编排者夜间执行 bot 自审流程即覆盖）。
