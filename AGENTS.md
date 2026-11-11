# AGENTS.md — 本仓库的 Agent 工作规则

> 借鉴 DeepSeek Harness 的思路：**Agent = Model + Harness**。模型负责推理，仓库内的 Markdown 文档体系就是 Harness 的一部分——新会话靠读文档恢复上下文，靠追加文档记录改动，不靠记忆。

## 会话开始（必做）

按顺序读，建立上下文：

1. `docs/plans/PLAN.md` — 项目定位、技术选型、执行步骤、验收标准
2. `docs/architecture.md` — 当前架构（组件、数据流、输出 schema）
3. `docs/decisions.md` — 已定决策（不要重新讨论已关闭的问题）
4. `docs/journal.md` 末尾条目 — 上次会话做到哪、遗留什么
5. GitHub Issues（label `roadmap`）— 活任务唯一源（D034）：待办 / 进行中 / 观察项 / 触发条件与验收闸门。一行命令（macOS 从钥匙串取 PAT，其他平台换成自己的 token 来源）：
   `curl -s -H "Authorization: Bearer $(security find-internet-password -s github.com -w)" "https://api.github.com/repos/blingblingredstar/pr-review-agent/issues?labels=roadmap&state=open"`

## 改动追踪（必做）

Harness 的核心纪律：**每一步都可回放**。文档只追加、少改写，禁止大段重写历史。

- 做出新的技术决策（选型、取舍、放弃的方案）→ 在 `docs/decisions.md` 追加条目
- 完成一批可提交的改动 → 在 `docs/CHANGELOG.md` 记录用户可见的变化
- 每次会话结束前 → 在 `docs/journal.md` 追加一条：日期、目标、完成、发现/坑、下一步
- 文档更新和对应代码改动放在**同一个 commit**

## 工程约定

**技术基线**

- TypeScript strict；运行时 Node 22；部署目标 Vercel
- 提示词只放 `prompts/*.md`，代码引用文件，不在代码里内联 prompt
- eval 相关改动必须保持 `npm run eval` 可回归（`evals/` 目录自包含）
- 遵循 lazy senior dev 原则（本仓库装有 ponytail skill，见 `.agents/skills/`）：最小完整改动，不加没人要的抽象
- 密钥只走环境变量，任何 key 不入库
- LLM 接入按 OpenAI 兼容端点抽象（`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`），代码与文档不绑定具体厂商

**项目级 skill**

- 存放位置统一 `.agents/skills/`（跨 harness 的约定位置）；**勿在 `.zcode/skills/` 放同名副本**
- 只装与现有体系互补的第三方 skill；升级方式 = 浅克隆上游后把文件覆盖复制进来；第三方来源与许可见 `.agents/skills/README.md`

**计划与任务追踪**

- 阶段性计划与规格（specs）归档 `docs/plans/`，后续新计划也放这个目录
- 活任务追踪走 GitHub Issues（label `roadmap`，D034 单源原则：不在文档里并行维护任务状态列）
- 任务完成随实现 PR 用 closing keywords（`Closes #N`）关闭
- issue 正文按事实性标准写。原因：PR 描述带 closing keywords 时，issue 正文会经任务上下文注入链路（D029）进入生产审查 prompt、成为模型的审查素材——夸张或祈使句会直接喂给模型

**对外表述**

- 对外表述按真实项目定位，不出现个人背景相关措辞

**PR 全流程**

- 开 PR 时按标题前缀打类型标签（feat/fix/docs/ci/chore/refactor/test）
- bot 回帖时自动打 `has-blocker` / `has-major` 标签（minor/nit 不打，避免噪音）
- 开 PR 后先看 agent 自审意见，逐条处理（修复 / 回应不修的理由 / 标记误报），处理一条闭环一条：

  ```bash
  # 处理单条：先回复再 resolve（--only 与 --reply 用同一个线程 id）
  npm run resolve:threads -- owner/repo#N --only <线程id> --reply <线程id>="回应文本"
  # 回应留痕在 PR 线程里——全量重审会注入上一轮意见，bot 复审时结论可见
  # 全部处理完收尾：
  npm run resolve:threads -- owner/repo#N --yes
  ```

- `review-threads` 状态变绿后才合并（D013；红灯走 commit status 而非 workflow 失败，避免失败邮件轰炸）
- 拉自审意见必须同时看**三处**，不只看线程：
  1. 行内线程（`GET /pulls/N/comments`，可 resolve）
  2. review body 的「行号不在 diff 内」降级列表（模型意见行号对不上 diff 时逐条列在正文）
  3. review body 里 minor/nit 折叠段（`<details>`，D032 发布门槛：minor/nit 不进线程，逐条一行、与降级列表同构、机器可解析）
- 降级与折叠意见没有线程，resolve 脚本对它们不可见，须同标准逐条核对留痕（PR #8 曾带着两条未处理降级意见合并）。行内定位已改为逐条判定，降级列表只剩真定位不了的意见，仍须人工核对处理

**合并闸门（D017）**

合并前逐项核对，任一未满足就不合并：

- `REQUEST_CHANGES` 已解除：bot 有意见时 review 为 REQUEST_CHANGES（合并按钮原生禁用）；处理完意见、bot 重审无意见后自动解除
- `pr-review` status 绿：审查进行中为 pending（黄），终态才变绿
- `review-threads` 绿：上面的三处意见全部闭环
- 三者已配为 branch protection required check（硬闸门，管理员同样受限；仓库已转 public 是 branch protection 可用的前提）

## 提交规范

Conventional Commits：`feat:` / `fix:` / `docs:` / `chore:` / `refactor:` / `test:`。改动追踪文档随对应代码一起提交。

## 分层排障

参考 Harness 的分层思路（见文件头），出问题先定位层，再动手修：

1. **模型层**：LLM 端点连通性（先 curl 单测，再查编排）
2. **编排层**：AI SDK 调用、`generateObject` schema 校验失败
3. **集成层**：GitHub API（diff 拉取、回帖）、webhook 签名校验
4. **平台层**：Vercel（waitUntil 生命周期、函数超时、环境变量）
