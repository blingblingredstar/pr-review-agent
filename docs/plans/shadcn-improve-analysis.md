# shadcn/improve 源码分析：Vet 阶段假阳性过滤与差异化

> 来源：上游 main @ `cac56e1`（2026-11-12 shallow clone 精读，10k⭐ 量级的 agent skill 形态对标；仓库极小——README + SKILL.md + 三份 references + 一个产出示例，全部读完）。
> 性质：外部系统分析归档（先例：`pr-agent-analysis.md`、`ai-code-review-course.md`）。本文引用的路径均为上游仓库相对路径。

## 一、现状总览

不是服务，是 **agent skill**（一个 prompt 包，MIT，v1.0.0）：装进任意支持 Agent Skills 格式的 agent，`/improve` 命令触发。定位一句话——「最贵的模型做理解与判断，便宜模型做执行」（plans, not patches）。五个阶段：Recon（摸仓库）→ Audit（并行子代理、九类审计）→ **Vet（假阳性过滤，本文重点）** → Plan（给弱执行器写自包含实现计划）→ 闭环（`execute` 派发执行 + 技术负责人式复审 / `reconcile` 维护积压 / `--issues` 发布）。

| 维度 | 现状 |
|---|---|
| 形态 | 本地 skill，人工触发，对话式确认 findings（非交互场景取 top 3-5 默认值） |
| 审计面 | 九类：correctness / security / perf / tests / tech-debt / deps / DX / docs / direction（feature 建议） |
| 工程化 | 三档 effort（quick / standard / deep）；`branch` 变体只审分支变更并标注 introduced / pre-existing；计划盖 git SHA 戳防漂移 |
| 评测 | **无**——零标注用例、零质量指标（§四） |

值得记录的共同直觉（与本仓库同路，两处独立演化）：

- 意见必须带 `file:line` 证据——"No vibes-only findings"，证据格式含 impact / effort / risk / confidence；
- 仓库内容是数据不是指令（Hard Rule 6），且**逐字传播给子代理**——子代理不继承 skill 上下文，SKILL.md 明说「不传播就是活 token 被引用进 findings」；
- 密钥只引位置与类型、永不引用值，发现即建议轮换。

## 二、精读：Vet 阶段的假阳性过滤实现

动机写得很直白：**"subagents over-report"**——Audit 阶段并行子代理的产出被默认视为带噪，Vet 是过滤器。实现是三个动作（SKILL.md Phase 3 + audit-playbook §2）：

1. **主模型逐条重读复核**。能进 findings 表的每一条，advisor（贵模型）必须亲自打开引用的 `file:line` 确认——「子代理的行号和归因是 leads, not facts」。这条纪律延伸进 Phase 4 写计划：「摘录必须来自你自己的读取，绝不来自子代理报告」——错摘录 = 错计划 = 弱执行器在错误前提上开工。
2. **预期三类误报的处置规则**：① by-design 被报成 bug / 漏洞（`https_proxy` 被标 SSRF——标准代理惯例；ADR 记录过的取舍——已定案不是 finding）；② 证据错位（真 finding、错文件错行）；③ 跨子代理重复。对应处置：降级 / 改正 / 拒绝。
3. **拒绝台账**。被拒 findings 记进 `plans/README.md` 索引的 "considered and rejected" 段——防止下一轮 audit 把同一条假阳性再捞出来。

两个精巧设计值得单独记：

- **Recon 为 Vet 供弹药（前馈）**：Phase 1 特意摄入 ADR / 决策文档 / PRD，理由栏写明是给 Vet 用的——拿「已定案的取舍」当过滤参照。即：**意图文档是假阳性过滤器的参照数据**，不只是背景阅读。
- **「过期的 ADR 本身是 finding」**（audit-playbook §2）：文档不用于压制问题——代码已偏离决策记录时，报「决策漂移」（文档或代码必有一错）。这与 D029 任务上下文的威胁模型口径同构：矛盾不是放行依据，矛盾本身就是审查对象。

边界情况：`quick` 档子代理本就只报 HIGH-confidence top ~6，Vet 的过滤量变小，但「过表必复核」不变；宿主不能派子代理时自己直审，Vet 对「自己审自己核」——过滤效果进一步依赖单模型自检。

## 三、对照：本项目的假阳性治理走的是另一条路

improve 的 Vet = **验证侧过滤**（生成后由同会话的更强模型重读证据）。本项目同型机制是 reflect 二次评分（#73 → D043），且**实测过**：35 例 × 3 轮，precision +7.2pp / recall −2.9pp / 折后成本 ~3.5×，真阳性换假阳性 1:1——判定不启用。两点公允性说明：

- **成本结构不同**。improve 是人肉触发的一次性审计，「贵模型逐条重读」在它的经济模型里是本份（全流程本来就都是贵模型）；本项目每 PR 自动触发，二遍过滤的 3.5× 乘以审查频次。否决理由是本项目的频次语境，不是「重读复核」这个动作本身错。
- **Vet 的三类误报里，两类在本项目有确定性等价物**：行号错位 → D016 发帖前行号预定位（`diffCoveredLines` 机械校验、不可定位降级 body，不依赖模型自检）；重复 / 措辞漂移 → D035 上一轮意见逐字重报（跨轮指纹去重在 #82 观察中）。剩下的「by-design 误报」类靠生成侧规则压 precision（D019 三规则）。

真正的差距不在机制在**度量**：Vet 是否真的降了假阳性，improve 无法回答——没有评测集，改 SKILL.md 的 Vet 措辞后没有回归可跑；confidence 是模型自报的 HIGH/MED/LOW，无人校准。本项目能否决 reflect，恰恰因为它能被测量（D043「基础设施在库、生产默认关」的底气来自数据）。生产侧真实 FP 率另有一条独立度量：裁定台账（#140，fixed / wontfix / false-positive 逐条落账，≥30 样本出 FP 率表）——improve 的拒绝台账只防自家下轮重报，不出率。

## 四、质量评测缺口——核心差异化（第二次独立确证）

上游全文无任何评测构件：无标注用例、无 recall / precision、无 prompt 迭代回归、无注入测试。改 skill 的方法论 = 直接改 prompt 文本。

这与 pr-agent 精读（2026-11-05，§七：406 个 mock 单测 + 5 个冒烟 e2e，零质量评测）构成第二个独立数据点：**「审查质量评测」在头部同类工具里是结构性缺失**——一个 10k⭐ 的 skill 与一个 14.8k⭐ 的产品型工具，都以「让模型再检查一遍」（Vet / reflect prompt）替代「测量检查效果」。本项目的差异化因此加固：不是「我们也有二次过滤」，而是**把审查质量变成可回归指标的那条链路**（87 用例 → 确定性打分 → promptHash 基线 → 前后对比）——且二次过滤这条具体机制上，本项目是「测过、不划算、不启用、可重开」，对岸是「写了、信了」。

## 五、其他对照（简记）

- **经济模型倒置**：improve 贵模型在审计 + Vet（判断），便宜模型在执行；本项目可选便宜模型在 router 出计划（D028），贵模型在审查本体。方向相反，「按智力分层」的直觉相同。
- **门禁**：improve 无 PR 集成、无合并闸门（advisory，"merging stays your call"）；`branch` 变体最接近 PR 审查（审分支变更 + introduced / pre-existing 标注）但仍是本地交互式。本项目 D017 REQUEST_CHANGES 原生禁合并 + 双 required check。
- **闭环状态机**：improve 的 `reconcile`（DONE 复验 / BLOCKED 归因 / TODO 漂移检查，git SHA 戳）≈ 本项目 D010 SHA 标记 + D032 增量 + D035 复报保真的手动版。
- **注入**：Hard Rule 6 + 子代理逐字传播，规则层面与本仓库威胁模型同型；零测试锚定（本仓库 9 例 canary 组持续回归、拦截率独立口径）。
- **给弱执行器写计划**（self-contained + 逐条验证命令 + STOP 条件 + drift check）是 improve 最扎实的设计，但与本项目形态无关——我们的下游是 GitHub 线程与合并闸门，不是执行器。

## 六、借鉴清单

1. **AGENTS.md 组织标准注入（#75 已立项）获独立佐证**：improve 的 Recon 摄入意图文档喂 Vet，与 #75「读目标仓库 AGENTS.md 当评审标准」是同一思想的两处独立演化；#75 的 default-branch-only trust 边界更严（improve 读的是本地工作区，威胁面不同，不直接可比）。
2. 拒绝台账防重报 → 本项目已有等价物（#140 裁定台账），且多出「出率」维度（FP 率表），无需动作。
3. 「决策漂移本身是 finding」→ dogfood 本仓库时的有趣审查维度（AGENTS.md / architecture.md 与代码漂移），暂不立项，记档备查。
4. 无新增代码借鉴：机制面交集已被 D016 / D035 / #75 覆盖，差异面（plans-for-executor、worktree 派发执行）与本项目形态不相关。

结论：README 新增「同类工具对照」表（2026-11-12），以 Vet 假阳性过滤与质量评测缺口两行为轴。
