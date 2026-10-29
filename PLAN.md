# PR Review Agent — 项目计划

> 求职作品集项目：一个带 eval 的 GitHub PR 审查 Agent。
> 本文件是新对话/新会话的交接文档——在新目录（本文件夹）开对话，让 Agent 先读本文件。

## 一、项目定位

**不是**"再写一个 code review 工具"，而是展示三件当前 AI 招聘市场最稀缺的能力：

1. **Agent 工作流设计**：webhook 接收 PR 事件 → 拉 diff → 分层审查（结构化输出）→ 调 GitHub API 回帖
2. **评测意识**：一个 eval 集 + 回归脚本，改 prompt 后能拿出前后对比数据（这是面试最硬的谈资）
3. **真实工程集成**：GitHub webhook 签名校验、异步处理防超时重试、密钥管理

一句话简历描述（目标）：*"基于 GLM 的 PR 审查 Agent，webhook 架构部署在 Vercel，附 20 个标注用例的 eval 集与 prompt 迭代对比报告。"*

## 二、技术选型（已确认）

| 项 | 选择 | 理由 |
|---|---|---|
| 运行时 | TypeScript + Node 22 | 前端背景零摩擦 |
| LLM 接入 | Vercel AI SDK + GLM OpenAI 兼容端点 | JD 出现频率最高的框架；用现有 GLM API key |
| 结构化输出 | AI SDK 的 `generateObject` / `streamObject` | 审查意见需要稳定 schema |
| 部署 | Vercel Hobby（免费，100 万次调用/月，非商用） | 无状态 webhook 服务的标准形态，无需云服务器 |
| 模型计费 | GLM key 按 token（唯一实际成本，可能被 coding plan 覆盖） | 不用 Cursor SDK（绑订阅）/ Claude Agent SDK（无 key） |
| 项目组织 | 参考 Cursor Agent SDK 范式 | Markdown 放提示词、TS 函数定义工具、独立 evals 目录（"agent-as-code"） |

## 三、架构

```
GitHub PR 事件 (pull_request: opened/synchronize)
      │ webhook (secret 签名校验)
      ▼
Vercel API route ──立即返回 200，waitUntil 异步处理──┐
      ▼                                            │
拉取 PR diff (GitHub API)                          │
      ▼                                            │
GLM 审查：generateObject → { comments: [{file, line, severity, body}] }
      ▼
GitHub API 回帖（逐条 PR review comment）
```

关键工程细节（写进 README，面试考点）：
- **先 200 再异步**：GLM 审查可能几十秒，超过 GitHub webhook 超时会触发重试导致重复评论 → 用 `waitUntil` 后台执行 + 幂等去重（同一 commit SHA 只审一次）。
- **diff 截断策略**：超大 PR 只取变更行附近上下文 / 按 file 分批调用。
- 提示词放 `prompts/*.md`，代码里只引用，方便迭代和 diff。

## 四、目录结构（目标）

```
pr-review-agent/
├── PLAN.md               # 本文件
├── README.md             # 最后写：架构图 + eval 报告摘要
├── src/
│   ├── webhook.ts        # 签名校验 + 事件分发 + waitUntil
│   ├── review.ts         # 拉 diff → GLM 审查 → 结构化输出
│   ├── github.ts         # GitHub API（diff/回帖）
│   └── dedupe.ts         # commit SHA 幂等
├── prompts/
│   └── review.md         # 审查提示词（迭代对象）
├── evals/
│   ├── cases/            # 20 个 (diff, 期望发现) 用例
│   ├── run.ts            # 跑评测、打分
│   └── report.md         # 前后对比报告
└── vercel.json
```

## 五、执行步骤（约一周）

- [ ] **Day 1**：`npm init` + Vercel AI SDK 接 GLM 端点，跑通"输入 diff 文本 → 输出结构化审查意见"（核心链路，先本地 hardcode 一个 diff）
- [ ] **Day 2**：`github.ts`（octokit 拉真 PR diff + 回帖），本地对任意公开仓库 PR 试跑
- [ ] **Day 3**：webhook 路由 + 签名校验 + dedupe，部署 Vercel，在自己建的真实仓库上开 PR 全链路验证
- [ ] **Day 4-5**：攒 eval 集（20 个用例：一半有明确 bug 的 diff，一半是"应该主动发现的关联问题"——参考 Surge AI DAYJOB 的 rubric 思路：计算/证据/关联问题/交付物）
- [ ] **Day 6**：跑 eval → 改 2-3 轮 prompt → 出对比报告（准确率/召回率或逐条命中表）
- [ ] **Day 7**：README（含 eval 报告），发一条社交平台总结帖

## 六、验收标准

1. 真实仓库开 PR，机器人能在 1 分钟内留下结构化 review 评论
2. `npm run eval` 一条命令跑完 20 用例并输出打分表
3. eval 报告能展示至少一轮"prompt 改进 → 指标提升"
4. README 里讲清架构决策（异步/幂等/diff 截断）

## 七、面试叙事要点（背下来）

- 为什么 agent 需要 eval？（没有评测的 agent 迭代 = 盲改）
- webhook 为什么先回 200？（超时重试语义 + 幂等）
- 为什么结构化输出而不是自由文本？（下游可执行、可打分）
- 下一步路线：多模型对比（接第二家模型跑同一 eval 集）、增量审查（只审新 commit）、严重度分级与 suppress 规则
