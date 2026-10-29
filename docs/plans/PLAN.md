# PR Review Agent — 项目计划

> 一个带 eval 的 GitHub PR 审查 Agent。
> 本文件是项目总计划。新会话先读 `AGENTS.md`，按其指引再读本文档与 `docs/` 下的架构、决策、日志。

## 一、项目定位

**不是**"再写一个 code review 工具"，而是把三件最考验工程功底的事做扎实：

1. **Agent 工作流设计**：webhook 接收 PR 事件 → 拉 diff → 分层审查（结构化输出）→ 调 GitHub API 回帖
2. **评测意识**：一个 eval 集 + 回归脚本，改 prompt 后能拿出前后对比数据（改 prompt 不再盲改）
3. **真实工程集成**：GitHub webhook 签名校验、异步处理防超时重试、密钥管理

一句话项目描述（目标）：*"基于大模型的 PR 审查 Agent，webhook 架构部署在 Vercel，附 20 个标注用例的 eval 集与 prompt 迭代对比报告。"*

## 二、技术选型（已确认）

| 项 | 选择 | 理由 |
|---|---|---|
| 运行时 | TypeScript + Node 22 | 前端背景零摩擦 |
| LLM 接入 | Vercel AI SDK + OpenAI 兼容端点 | TS 生态最主流的 LLM 接入框架；端点可插拔，当前接 GLM（key 现成） |
| 结构化输出 | AI SDK 的 `generateText` + `Output` / `streamObject` | 审查意见需要稳定 schema（`generateObject` 已废弃，见 decisions.md D009） |
| 部署 | Vercel Hobby（免费，100 万次调用/月，非商用） | 无状态 webhook 服务的标准形态，无需云服务器 |
| 模型计费 | OpenAI 兼容端点按 token（唯一实际成本） | 不用 Cursor SDK（绑订阅）/ Claude Agent SDK（无 key） |
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
LLM 审查：generateText + Output → { comments: [{file, line, severity, body}] }
      ▼
GitHub API 回帖（逐条 PR review comment）
```

关键工程细节（写进 README）：
- **先 200 再异步**：LLM 审查可能几十秒，超过 GitHub webhook 超时会触发重试导致重复评论 → 用 `waitUntil` 后台执行 + 幂等去重（同一 commit SHA 只审一次）。
- **diff 截断策略**：超大 PR 只取变更行附近上下文 / 按 file 分批调用。
- 提示词放 `prompts/*.md`，代码里只引用，方便迭代和 diff。

## 四、目录结构（目标）

```
pr-review-agent/
├── PLAN.md               # 本文件
├── README.md             # 最后写：架构图 + eval 报告摘要
├── src/
│   ├── webhook.ts        # 签名校验 + 事件分发 + waitUntil
│   ├── review.ts         # 拉 diff → LLM 审查 → 结构化输出
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

- [x] **Day 1**：`npm init` + Vercel AI SDK 接 OpenAI 兼容端点，跑通"输入 diff 文本 → 输出结构化审查意见"（核心链路，先本地 hardcode 一个 diff）
- [x] **Day 2**：`github.ts`（octokit 拉真 PR diff + 回帖），本地对任意公开仓库 PR 试跑
- [ ] **Day 3**：webhook 路由 + 签名校验 + dedupe，部署 Vercel，在自己建的真实仓库上开 PR 全链路验证
- [ ] **Day 4-5**：攒 eval 集（20 个用例：一半有明确 bug 的 diff，一半是"应该主动发现的关联问题"——参考 Surge AI DAYJOB 的 rubric 思路：计算/证据/关联问题/交付物）
- [ ] **Day 6**：跑 eval → 改 2-3 轮 prompt → 出对比报告（准确率/召回率或逐条命中表）
- [ ] **Day 7**：README（含 eval 报告），发一条社交平台总结帖

## 六、验收标准

1. 真实仓库开 PR，机器人能在 1 分钟内留下结构化 review 评论
2. `npm run eval` 一条命令跑完 20 用例并输出打分表
3. eval 报告能展示至少一轮"prompt 改进 → 指标提升"
4. README 里讲清架构决策（异步/幂等/diff 截断）

## 七、核心设计问答（为什么这么做）

- 为什么 agent 需要 eval？（没有评测的 agent 迭代 = 盲改）
- webhook 为什么先回 200？（超时重试语义 + 幂等）
- 为什么结构化输出而不是自由文本？（下游可执行、可打分）
- 下一步路线：多模型对比（接第二家模型跑同一 eval 集）、增量审查（只审新 commit）、严重度分级与 suppress 规则
