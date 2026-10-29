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
GLM 审查：generateObject → { comments: [...] }      │
      ▼                                            │
GitHub API 回帖（逐条 PR review comment）◄──────────┘
```

## 组件

| 模块 | 职责 | 关键点 |
|---|---|---|
| `src/webhook.ts` | 接收事件、验签、事件分发、立即 200 + `waitUntil` | 只处理 `opened` / `synchronize`；其余事件直接 200 忽略 |
| `src/review.ts` | 拉 diff → 构造 prompt → GLM 审查 → 结构化输出 | prompt 从 `prompts/review.md` 读取；`generateObject` 强约束 schema |
| `src/github.ts` | GitHub API 封装：拉 PR diff、发 review comment | 只依赖 octokit；便于 eval 时 mock |
| `src/dedupe.ts` | 同一 commit SHA 只审一次 | 防止 webhook 重试 → 重复评论 |
| `prompts/review.md` | 审查提示词（迭代对象） | prompt 与代码分离，方便 diff 和 eval 对比 |
| `evals/` | 用例集 + 跑分脚本 + 报告 | `cases/` 20 个 (diff, 期望发现) 用例；`run.ts` 打分；`report.md` 前后对比 |

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

- **先 200 再异步**：GLM 审查可能几十秒，超过 GitHub webhook 超时会触发重试导致重复评论。用 `waitUntil` 后台执行，HTTP 层立刻返回 200。
- **幂等去重**：以 `(repo, commit SHA)` 为键去重，同一 commit 只审一次；重试到达时直接跳过。
- **diff 截断**：超大 PR 按文件分批调用，或只取变更行附近上下文，避免超出模型上下文窗口。

## 环境变量

| 变量 | 用途 | 备注 |
|---|---|---|
| `GLM_API_KEY` | 调用 GLM OpenAI 兼容端点 | 唯一实际成本 |
| `GLM_BASE_URL` | GLM 端点地址 | AI SDK 的 OpenAI provider 可自定义 base URL |
| `GITHUB_TOKEN` | 拉 diff、发评论 | GitHub App 还是 PAT 待定（见 decisions.md D008） |
| `WEBHOOK_SECRET` | webhook 签名校验 | HMAC-SHA256 |

## 待定问题

- GitHub App vs PAT：影响回帖身份与权限粒度（Day 2 决策）
- `synchronize` 事件是全量重审还是增量审查（增量在 PLAN §7 列为后续路线）
