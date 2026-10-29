# 决策记录（Decision Log）

> Append-only。每条决策一个编号，定稿后不改写——推翻旧决策时新增一条并标注取代关系。
> 格式参考 ADR（Architecture Decision Record）：背景 → 决策 → 备选 → 后果。

---

## D001 — 运行时选 TypeScript + Node 22

- **状态**：已接受（2026-10-29）
- **背景**：独立项目起步，需在有限时间内交付。
- **决策**：TypeScript（strict）+ Node 22。
- **备选**：Python——生态同样成熟，但与本人前端背景衔接成本更高。
- **后果**：与 Vercel AI SDK、Vercel 部署链路零摩擦。

## D002 — LLM 接入用 Vercel AI SDK + GLM OpenAI 兼容端点

- **状态**：已接受（2026-10-29）
- **背景**：Vercel AI SDK 是 TypeScript 生态最主流的 LLM 接入框架；手头有可用的 GLM API key。
- **决策**：AI SDK 的 OpenAI provider 指向 GLM 兼容端点（自定义 `baseURL`）。
- **备选**：
  - Cursor Agent SDK——绑定 Cursor 订阅，排除；
  - Claude Agent SDK——无 key，排除。
- **后果**：换模型只需换 provider 配置，为 eval 集将来跑多模型对比留了口子。

## D003 — 审查输出用 `generateObject` 结构化输出

- **状态**：已接受（2026-10-29）
- **背景**：下游要逐条回帖、逐条打分，自由文本不可执行。
- **决策**：AI SDK `generateObject` 强约束 `{ comments: [{file, line, severity, body}] }`。
- **后果**：eval 打分变成结构化字段比对，而不是文本猜测；「为什么结构化输出」这个设计问题有了具体答案：下游可执行、可打分。

## D004 — 先 200 再异步 + commit SHA 幂等去重

- **状态**：已接受（2026-10-29）
- **背景**：GLM 审查耗时可能超过 GitHub webhook 超时窗口，超时会触发 GitHub 重试，重试导致重复评论。
- **决策**：webhook handler 立即返回 200，实际审查放 `waitUntil` 后台执行；以 `(repo, commit SHA)` 为键去重，重试到达直接跳过。
- **备选**：同步处理 + 背景重试降级——超时语义仍不可控，且 Vercel 函数有硬超时。
- **后果**：`src/dedupe.ts` 成为独立模块；去重状态初始用 Vercel KV 或内存 Map（部署形态定稿时决策）。

## D005 — 部署 Vercel Hobby

- **状态**：已接受（2026-10-29）
- **背景**：无状态 webhook 服务，不想维护云服务器。
- **决策**：Vercel Hobby（免费、非商用，100 万次调用/月）。
- **后果**：`waitUntil` 生命周期受 Vercel 约束；去重不能依赖本地内存持久化（与 D004 联动）。

## D006 — 项目组织走 agent-as-code 范式

- **状态**：已接受（2026-10-29）
- **背景**：参考 Cursor Agent SDK 范式。
- **决策**：Markdown 放提示词（`prompts/*.md`）、TS 函数定义工具、独立 `evals/` 目录。
- **后果**：prompt 可 diff、可版本化、可在 eval 报告里引用具体版本。

## D007 — 开发过程采用 harness 式文档体系

- **状态**：已接受（2026-10-29）
- **背景**：借鉴 DeepSeek Harness「Agent = Model + Harness」思路——用仓库内文档而非记忆在会话间传递上下文；改动可回放。
- **决策**：建 `AGENTS.md`（工作规则）+ `docs/architecture.md`（架构）+ `docs/decisions.md`（决策，append-only）+ `docs/journal.md`（会话日志，append-only）+ `docs/CHANGELOG.md`（变更）；文档随代码同 commit 提交。
- **后果**：任何新会话读四个文件即可恢复上下文；代价是每次改动多写几行文档，换来完整可追溯的过程记录。

## D008 — GitHub 身份：App vs PAT（待定）

- **状态**：讨论中（2026-10-29 提出，Day 2 截止）
- **背景**：回帖身份与权限粒度取决于用 GitHub App 还是 PAT。
- **候选**：PAT（简单、快）；GitHub App（身份独立、权限收敛、更像产品）。
- **决策**：待 Day 2 实测后补记。

## D009 — 项目级安装 ponytail skill

- **状态**：已接受（2026-10-29）
- **背景**：ZCode 中插件本体只能装在用户级；项目内共享需走 workspace skills（`<repo>/.zcode/skills/`）。
- **决策**：将 [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) 的 6 个 skill 复制到 `.zcode/skills/`，随仓库版本化。
- **后果**：任何用 ZCode 打开本仓库的人自动获得同一套 lazy senior dev 规则；升级需手动重新复制。

## D010 — 计划与规格文档统一归档 docs/plans/

- **状态**：已接受（2026-10-29）
- **背景**：PLAN.md 原在仓库根，后续还会有阶段性计划与规格文档，根目录需要保持干净。
- **决策**：`PLAN.md` 迁移为 `docs/plans/PLAN.md`（git mv 保留历史）；之后的计划/ specs 一律放 `docs/plans/`。
- **后果**：根目录只留 `README.md` 与 `AGENTS.md`；AGENTS.md、README 中的路径引用已同步更新。

## D011 — LLM 接入按 OpenAI 兼容端点抽象，不绑定厂商

- **状态**：已接受（2026-10-29）
- **背景**：GLM 提供标准 OpenAI 兼容 API，AI SDK 的 OpenAI provider 通过自定义 `baseURL` 可接任何兼容端点。文档与代码写死 GLM 会缩小适用面，也与多模型对比路线（PLAN §七）冲突。
- **决策**：代码与文档统一用「OpenAI 兼容端点」表述，配置抽象为 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`；GLM 仅作为当前注入的实例出现在决策记录与配置备注里。
- **后果**：换模型 / 接第二家模型只改环境变量，同一 eval 集可直接做对比；D002 中的「GLM 端点」自本条起理解为「OpenAI 兼容端点，当前实例为 GLM」。
