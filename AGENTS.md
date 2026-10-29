# AGENTS.md — 本仓库的 Agent 工作规则

> 借鉴 DeepSeek Harness 的思路：**Agent = Model + Harness**。模型负责推理，仓库内的 Markdown 文档体系就是 Harness 的一部分——新会话靠读文档恢复上下文，靠追加文档记录改动，不靠记忆。

## 会话开始（必做）

按顺序读，建立上下文：

1. `docs/plans/PLAN.md` — 项目定位、技术选型、执行步骤、验收标准
2. `docs/architecture.md` — 当前架构（组件、数据流、输出 schema）
3. `docs/decisions.md` — 已定决策（不要重新讨论已关闭的问题）
4. `docs/journal.md` 末尾条目 — 上次会话做到哪、遗留什么

## 改动追踪（必做）

Harness 的核心纪律：**每一步都可回放**。文档只追加、少改写，禁止大段重写历史。

- 做出新的技术决策（选型、取舍、放弃的方案）→ 在 `docs/decisions.md` 追加条目
- 完成一批可提交的改动 → 在 `docs/CHANGELOG.md` 记录用户可见的变化
- 每次会话结束前 → 在 `docs/journal.md` 追加一条：日期、目标、完成、发现/坑、下一步
- 文档更新和对应代码改动放在**同一个 commit**

## 工程约定

- TypeScript strict；运行时 Node 22；部署目标 Vercel
- 提示词只放 `prompts/*.md`，代码引用文件，不在代码里内联 prompt
- eval 相关改动必须保持 `npm run eval` 可回归（`evals/` 目录自包含）
- 遵循 lazy senior dev 原则（本仓库装有 ponytail skill，见 `.agents/skills/`）：最小完整改动，不加没人要的抽象
- 项目级 skill 统一放 `.agents/skills/`（跨 harness 约定位，勿在 `.zcode/skills/` 放同名副本）；只装与现有体系互补的第三方 skill，升级用 shallow clone 覆盖复制
- 密钥只走环境变量，任何 key 不入库
- LLM 接入按 OpenAI 兼容端点抽象（`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`），代码与文档不绑定具体厂商
- 阶段性计划与规格（specs）统一归档 `docs/plans/`，后续新计划也放这个目录
- 对外表述按真实项目定位，不出现个人背景相关措辞

## 提交规范

Conventional Commits：`feat:` / `fix:` / `docs:` / `chore:` / `refactor:` / `test:`。改动追踪文档随对应代码一起提交。

## 分层排障

参考 Harness 的分层思路，出问题先定位层，再动手修：

1. **模型层**：LLM 端点连通性（先 curl 单测，再查编排）
2. **编排层**：AI SDK 调用、`generateObject` schema 校验失败
3. **集成层**：GitHub API（diff 拉取、回帖）、webhook 签名校验
4. **平台层**：Vercel（waitUntil 生命周期、函数超时、环境变量）
