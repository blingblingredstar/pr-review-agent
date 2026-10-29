# 架构文档

> 随代码演进。改动架构（新增组件、改数据流、改输出 schema）必须同步更新本文件，并在 `docs/decisions.md` 记录决策。

## 系统上下文

```
GitHub PR 事件 (pull_request: opened/synchronize)
      │ webhook (HMAC-SHA256 签名校验, secret 校验失败丢弃)
      ▼
Vercel API route ──立即返回 200，waitUntil 异步处理──┐
      ▼                                            │
拉取 PR diff (GitHub API)                          │
      ▼                                            │
LLM 审查（OpenAI 兼容端点）：generateText + Output → { comments: [...] }     │
      ▼                                            │
GitHub API 回帖（逐条 PR review comment）◄──────────┘
```

## 组件

| 模块 | 职责 | 关键点 |
|---|---|---|
| `api/webhook.ts` | Vercel function 薄壳 | 读 raw body（不能碰 `req.body`，惰性解析会消费流破坏验签）+ 响应；`maxDuration: 300`（Hobby 上限） |
| `src/webhook.ts` | 验签、事件分发、后台审查编排 | HMAC-SHA256 + `timingSafeEqual`，失败 401；只处理 `opened` / `synchronize`（其余含 `ping` 200 忽略）；立即 200 + `waitUntil`（`@vercel/functions`）执行 `runReview`；后台任务失败只记日志不抛出 |
| `src/review.ts` | 拉 diff → 构造 prompt → LLM 审查 → 结构化输出 | prompt 从 `prompts/review.md` 读取；prompt 构造前 `truncateDiff()` 整文件块预算截断（D018）；`generateText` + `Output.object` 强约束 schema；`llm.chat()` 显式走 chat/completions（兼容端点无 Responses API）；`AbortSignal.timeout(LLM_TIMEOUT_MS)` 默认 270s（D011）；`LLM_EXTRA_BODY` 合并进请求体控制 thinking 等端点参数（D012） |
| `src/github.ts` | GitHub API 封装：拉 PR diff、发 review comment（有意见 REQUEST_CHANGES，D017）、审查生命周期 status、超时通知、打 severity 标签 | 只依赖 octokit；便于 eval 时 mock；review summary 内嵌 sha 标记（D010）；`postReview` 后自动打 `has-blocker`/`has-major` 标签（minor/nit 不打，Day 6 eval 可当按时间的质量数据） |
| `src/dedupe.ts` | 同一 commit SHA 只审一次 | 查 PR 已有 review 的 `<!-- pr-review-agent sha:<SHA> -->` 标记（D010） |
| `prompts/review.md` | 审查提示词（迭代对象） | prompt 与代码分离，方便 diff 和 eval 对比；`vercel.json` `includeFiles` 保证随函数打包 |
| `evals/` | eval 用例集 + 跑分脚本 | `cases/` 29 个自包含 diff 用例（D015 三级 source：synthetic 20 手写教学 / real 7 真实仓库 fix 反转与配对 / dogfood 2 回归集；格式见 D014）；`score.ts` 打分纯函数（命中 = file + 行 ±3 + mustMention 任一关键词）；`run.ts` 入口（`npm run eval`，串行 + 失败重试，按 source 分组统计，能力评估 = synthetic + real，结果落盘 `runs/`）；用例结构校验在 `test/eval-cases.test.ts` |

## 结构化输出 schema

`review.ts` 生成、`evals/run.ts` 打分共用的唯一契约：

```ts
type ReviewComment = {
  file: string;      // 相对仓库根的文件路径
  line: number;      // diff 中的行号
  severity: "blocker" | "major" | "minor" | "nit";
  body: string;      // 评论正文：指出问题 + 理由 +（可选）修法
};

type ReviewResult = { comments: ReviewComment[] };
```

schema 变更属于破坏性改动：必须同步改 `evals/run.ts` 的打分逻辑，并在 CHANGELOG 里标记。

## 关键工程机制

- **先 200 再异步**：LLM 审查可能几十秒到数分钟，超过 GitHub webhook 超时会触发重试导致重复评论。用 `waitUntil` 后台执行，HTTP 层立刻返回 200；Vercel Hobby 函数上限 300s（Fluid compute）。
- **幂等去重**：以 review body 内嵌的 `(repo, commit SHA)` 标记为键（D010），同 SHA 已审直接跳过；超时通知不带标记，同 SHA 重投可重试。
- **超时降级**（D011）：`AbortSignal.timeout(LLM_TIMEOUT_MS)`（默认 270s）硬超时；超时发 issue comment 告知并提示重推重试。
- **合并闸门双层强化**（D017）：bot 有意见以 REQUEST_CHANGES 提交 review（GitHub 原生禁合并按钮，重审无意见自动解除）；审查生命周期写 `pr-review` status（pending/success/failure，与线程状态的 review-threads 分离），补上「review 尚未发布」的窗口期；`resolve:threads --yes` 收尾后检测 head SHA 复审在途。
- **合并前意见闭环**（D013）：`.github/workflows/review-threads.yml` 查未 resolve 线程写 commit status（红灯走 status 而非 workflow 失败，避免设计内红灯触发失败邮件）；`scripts/resolve-threads.ts`（`npm run resolve:threads -- owner/repo#N --yes`）批量 resolve 后主动 rerun 闭合绿门。仓库工具，非运行时组件。
- **diff 截断**（D018）：总长超 `DIFF_MAX_CHARS`（默认 300_000 字符）时按整文件块丢弃——按块大小升序贪心保留（大文件多为 lock/生成物噪声），保留块原顺序字节级重组，被丢弃文件在 diff 末尾附省略行（路径 + 增删计数）告知模型非全量；不切 hunk（破坏行号定位）、不分子调用（成本延迟翻倍）。

## 环境变量

| 变量 | 用途 | 备注 |
|---|---|---|
| `LLM_API_KEY` | 调用 OpenAI 兼容端点 | 当前用 GLM 的 key；唯一实际成本 |
| `LLM_BASE_URL` | OpenAI 兼容端点地址 | AI SDK 的 OpenAI provider 自定义 `baseURL` |
| `LLM_MODEL` | 模型名 | 换模型 / 多模型对比只改配置 |
| `GITHUB_TOKEN` | 拉 diff、发评论 | GitHub PAT（D008 已定稿；App 留产品化） |
| `WEBHOOK_SECRET` | webhook 签名校验 | HMAC-SHA256；`scripts/setup-webhook.ts` 首跑自动生成写入 `.env` |
| `LLM_TIMEOUT_MS` | LLM 审查硬超时（毫秒） | 默认 270000；Vercel Hobby 函数上限 300s，留回帖余量（D011） |
| `LLM_EXTRA_BODY` | 端点扩展参数（JSON） | 合并进请求体；GLM 关 thinking `{"thinking":{"type":"disabled"}}` 控延迟（D012） |
| `DIFF_MAX_CHARS` | diff 截断预算（字符） | 默认 300000；超预算按整文件块丢弃、小文件优先（D018）；非法值告警回退默认 |

## 待定问题

- `synchronize` 事件是全量重审还是增量审查（增量在 PLAN §7 列为后续路线）
