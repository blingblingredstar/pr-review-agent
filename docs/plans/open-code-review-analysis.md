# alibaba/open-code-review 源码分析：同构竞品的取舍与差异化

> 来源：上游 main @ `abd6416`（2026-11-14 快照：README / ROADMAP / ASSURANCE_CASE.md / action.yml + 源码目录树 + 关键 prompt 与规则文件抽读；Go CLI，Apache-2.0，50.7k⭐ / 3.7k forks，npm `@alibaba-group/open-code-review`，2026-05-18 建仓约半年）。
> 性质：外部系统分析归档（先例：`pr-agent-analysis.md`、`shadcn-improve-analysis.md`）。本文引用的路径均为上游仓库相对路径；「README 自述」指其仓库自我声明，未经独立核实。
>
> **勘误（2026-11-14 同日，会话 58 续）**：初版多处写「harness 不在仓库」——当日实测核查发现 AACR-Bench 的评测 harness 在独立仓库 [alibaba/aacr-bench](https://github.com/alibaba/aacr-bench)（Python，含 converters / hooks / metrics 文档，数据集与仓库快照在 HuggingFace）**全公开**。相关表述已按下文修正版为准；「基准是独立评估资产、非主仓库开发回路」的差异结论维持，但论据换为形态差异而非有无。

## 一、现状总览

阿里内部官方 AI 审查工具开源。README 自述：内部两年、服务数万开发者、识别数百万缺陷，验证后孵化开源。形态是 **Go CLI（`ocr`）**，不是服务：

- `ocr review`：workspace（暂存/未暂存/未跟踪）/ 分支区间 / 单 commit，带 session 断点续跑
- `ocr scan`：整文件扫描（无 diff 场景——审计陌生代码库）
- `ocr delegate`：委托模式——`ocr` 只解析审查范围、排除规则、规则匹配、注入上下文，评审本体交宿主 coding agent 用自己的订阅模型跑（`ocr` 侧零 API key）

分发面极宽：npm + GitHub Action（inline comments + sticky summary + 增量不重复发帖）+ GitLab CI / Gerrit + VSCode 扩展（JetBrains 在 H2 2026 路线图）+ coding-agent 插件（Claude Code / Codex / Cursor / Kimi / OpenCode / QCA）+ MCP server + ACP 适配器（实验）+ OpenTelemetry + session viewer（浏览器回放审查会话、标记已修/忽略）+ 五语种 README。

内置规则按文件类型模板匹配：`internal/config/rules/rule_docs/` 覆盖 60+ 文件类型（arkts 到 zig）；仓库自述规则集含 NPE / 线程安全 / XSS / SQL 注入。其中 `ts_js_tsx_jsx.md` 除通用清单外有**一整节 React best practices**（hooks 规则、useEffect 依赖与清理、memo/useMemo/useCallback、render 副作用、内联样式、组件内嵌组件）+ `var` 禁用、`===` 强制、`any` 规避、XSS / innerHTML / eval / document.write 检查。

## 二、架构同构：确定性管线 + Agent，独立演化到相同形状

对方 README 的动机论述与本项目出发点一致：通用 agent 审查的三个病灶——**覆盖不全**（大改动挑文件审）、**定位漂移**（意见行号对不上）、**质量不稳**（prompt 微调引起大幅波动）；根因是纯语言驱动缺少对审查过程的硬约束。解法：必须不出错的环节给工程逻辑，动态决策给 agent。

从 `internal/config/template/prompts/` 的阶段命名可直接读出其管线形状，与本仓库决策逐段对得上：

| 对方管线阶段 | 本仓库同构件 |
|---|---|
| `grouping_task`（关联文件智能打包，`message_en.properties` 与 `message_zh.properties` 同包；每包独立子代理、隔离上下文） | D018/D020 确定性截断（整文件块、生成物前置排除）管住「审什么」；分块审查在 #74 路线图（等生产实证） |
| `plan_task`（先出评审计划再评审） | D028 决策路由（`DECISION_MODEL` 便宜档先出计划） |
| `main_task` + 上下文工具（`code_access` / `code_search` / `file_read` / `file_find`） | D023 上下文注入 + D027/D031 read_file / search_file 工具循环 |
| `re_location_task`（独立定位模块，修行号漂移） | D016 发帖前行号预定位（逐条判定，对不上降级进 body） |
| `review_filter_task`（独立反思模块，**默认启用**） | D043 reflect——实测 precision +7.2pp / recall −2.9pp、TP:FP 交换比 1:1 后**不启用** |
| `memory_compression_task`（上下文压缩） | 各注入块独立预算（CONTEXT / TASK / PREV_FINDINGS / AGENTS_MD 逐块封顶） |
| `comment_args_repair`（工具参数修复） | 两段协议 best-effort 解析、失败降级无工具结果 |
| `code_comment` 工具带 severity（critical/high/medium/low）+ category | blocker/major/minor/nit 四级 + confidence 内部信号 |

阶段名能对到这个程度，说明两边对「LLM 审查该用工程约束包住什么」的判断独立收敛了。**差异化不在有没有这套管线，在两端的取舍与质量回路**（下两节）。

## 三、它的取舍：精度优先、成本优先

基准自述（README Benchmark 节）：真实世界基准（50 个流行开源仓库 / 200 个真实 PR / 10 语言，80+ 资深工程师交叉验证出 1,505 条标注 ground truth，数据集 [AACR-Bench](https://huggingface.co/datasets/Alibaba-Aone/aacr-bench) 发布在 HuggingFace）；同模型下对比 Claude Code——**precision 与 F1 显著更高、token 约 1/9、更快；recall 低于通用 agent 是刻意取舍**（原文 "a deliberate trade-off favoring precision over noise"）。

精度优先不是一句营销话术，在三处设计里有实体：

1. **`review_filter_task` 默认在管线里**——宁可漏报不可吵人。本仓库同型机制（reflect）实测过：precision +7.2pp 的代价是 recall −2.9pp、折后成本 ~3.5×，真阳性换假阳性 1:1，判定不启用（D043）。对方把这个交换默认吃下来了。
2. **规则模板收窄注意力**——每文件类型一张清单，从源头削信息噪声。代价是清单外的缺陷形态没有激励去报。
3. **bundle 范围硬约束**——`main_task_system.md` 明文 "comments must address code within `<review_files>`"，跨包关联只能在包内看。

成本优先同样贯穿：~1/9 token 的读数、上下文压缩阶段、委托模式（连 LLM 调用都可以省给宿主）。

ROADMAP 两个时间点值得记：

- **Ultra Mode（更高召回档）计划 H2 2026**——他们清楚召回缺口，用「花更多 token 换 recall」的档位补
- **Domain-Specific Long-Term Memory 计划 H1 2027**——跨轮审查记忆（复发模式、历史裁定、项目约定）还没进产品

## 四、对照：完整功能矩阵

| 维度 | open-code-review | 本项目 |
|---|---|---|
| 形态 | 本地 CLI + CI 触发（Action/GitLab/Gerrit）+ IDE 插件 + coding-agent 插件 + MCP | webhook 服务，PR 事件自动触发，无人值守 |
| 架构 | 确定性管线（文件选择/关联打包/模板规则/定位/反思模块）+ 精简工具集 agent | 同构（见 §二）：确定性截断/预算/预定位 + 结构化输出单遍 + 受限工具循环 |
| 触发与生命周期 | 人工或 CI 单次触发；CI 重跑 sticky 不重复发帖；session 断点续跑（针对中断，非 PR 多轮） | commit 幂等（D010）+ block 继承全量重审 + 上一轮意见逐字重报（D035，已在生产）+ 区间增量（D032） |
| 审查范围锚定 | bundle 内文件（`<review_files>` 硬约束） | PR diff 修改锚定 + search/read 扩大验证半径不扩大审查范围 |
| 上下文来源 | 上下文工具（access/search/read）+ 每语言内置规则清单 | 快照触及文件全文 + 文件树（D023）+ 任务上下文：PR 标题与关联 issue 正文（D029）+ 组织规范：仓库默认分支 AGENTS.md（D045） |
| 质量取舍 | 高精度低召回（自述刻意），token ~1/9 | recall 88.9% / precision 97.1% 双高（36 条能力期望，生产同款模型与提示词，2026-11-12 两轮微平均；基线五轮 recall 带 82.9–94.3）；假阳性过滤实测 1:1 不划算后不启用（D043），宁在生成侧规则防 |
| 评测 | AACR-Bench：50 仓 / 200 PR / 10 语言 / 1,505 条正例标注（另有 640 条负例），数据集 + 被测仓库快照 + 评测 harness 三件套全公开（HF + 独立基准仓库 alibaba/aacr-bench）；打分用 LLM-judge 文件级语义覆盖，行号不作硬过滤 | 92 用例在库：确定性打分（无 LLM 裁判）、promptHash 基线红线、改 prompt 必跑回归、注入拦截率独立口径、迭代曲线公开（evals/report.md）、金丝雀周巡检 |
| 注入抗性 | 威胁模型标注 git 仓库半可信（ASSURANCE_CASE.md，"diffs may contain adversarial content"）；无注入回归用例可见 | 10 例注入 canary 覆盖六个注入面（diff 注释/文件名/元数据/issue 正文/上一轮意见/AGENTS.md）持续回归 + 每个注入面威胁模型重申 + 无 approve 路径（最坏后果是多误报，不存在被注入放行合并） |
| 合并闸门 | 无——工具定位是给建议，合并决策在人 | REQUEST_CHANGES 原生禁合并（重审无意见自动解除）+ `pr-review` / `review-threads` 双 status 硬闸门（D017） |
| 严重度 | critical/high/medium/low + category | blocker/major/minor/nit + confidence 内部信号 |
| 语言面 | 60+ 文件类型规则，10 语言基准；TS/JS 规则含 React 专节 | 评测域聚焦：92 用例主 diff 文件 95% 为 .ts/.js，质量读数在前端主语言域校准 |
| 规模验证 | 阿里内部两年、数万开发者、数百万缺陷（README 自述） | 单仓 dogfood：122 次生产审查台账、284 单测、92 用例 |
| 可观测 | OpenTelemetry + session viewer（回放/标记） | 逐 run token 落盘 + 前缀缓存读数 + RunRecord 面板（D041）+ 生产台账 |

两处公允性声明，防止对照表吹过头：

1. **不能说对方「没有评测」**。AACR-Bench 的 ground truth 规模（1,505 条正例）是本仓库能力期望（36 条）的四十倍，且经 80+ 工程师交叉验证；评测资产（数据集 / 快照 / harness）齐备且公开。真实的差异是**评测的形态与位置**：对方的基准是独立仓库的评估资产（评的是发布物，打分靠 LLM-judge 语义覆盖），主仓库开发流程里看不到「改 prompt 必跑回归」这类回路纪律；本仓库的评测长在开发回路里（在库、确定性打分、promptHash 红线、迭代历史全公开）。「有评测」这一格对方有，且更大；「评测长在开发回路」这一格才是差异。
2. **不能说「前端专精」**。对方 `ts_js_tsx_jsx.md` 的 React best practices 一节比本仓库 prompt 里的前端规则更成体系。可辩护的表述是「评测域聚焦」：质量读数（88.9/97.1）是在 TS/JS 语料上校准的，对方 10 语言基准只给聚合读数、不区分单语言深度。

## 五、可借鉴项（映射既有 roadmap，D040 借标准不自建原则）

1. **AACR-Bench 作为 #107/#157 外部 golden 转译源**（2026-11-14 实测核查后定案，Apache-2.0 可用）。实测读数：全量 2,145 条评审意见 = 1,505 条专家确认正例 + 640 条负例；TS/JS 子集 563 行，其中正例 417 条（Code Defect 189 / Maintainability 185 / Performance 36 / Security 7；Diff Level 234 / File Level 131 / Repo Level 52）分布在 40 个真实 PR 上，行锚（side/from_line）零缺失、note 中位 263 字符是现成机制词素材；PR diff 中位 210 行、≤200 行的 20 个。转译手顺照 #107（锚点人工核 + 实例枚举 + 机制词中文转译剔除字面词），比自采省一半人工——锚点是成品且正例经专家预验证。#157 的调查（自标 100% vs 外部 45.5% 的 54.5pp 落差归因）可优先试转译一批 TS/JS 子集。
2. **两种用法**（互斥不冲突）：①转译进本仓库 eval（上文）；②直接用他们的 harness 跑本 bot——`evaluation/converters/` 是可插拔评审器适配层，跑通即得「本 bot vs ocr 在同一基准上的同尺读数」，是 README 对外最有说服力的对照数字；成本 = 40 个 TS/JS PR × 评审 + judge 调用，需先评估 judge 端点（他们 harness 的 judge 也是 LLM 调用）。**用法②已落地（2026-11-14）**：`scripts/aacr-bench.sh`（钉版本拉取 harness + `scripts/aacr/pipeline-prra.patch` 注册 `prra` reviewer + `scripts/aacr-review.ts` 桥接 CLI 裸调 `reviewDiff`；结果文件走 `--out` 文件不走 stdout——npm banner 会污染；失败实例兜底空意见防 evaluate 崩）；preview 模式零成本验机械、real 模式真 judge（GLM 端点）；judge/数据/harness 三钉，上游更新 = 显式改钉再跑。
3. **打分方法论是 #157 锚点伪影的第三种解法**：他们 `metric-migration.md` 从逐条行锚匹配迁移到 LLM-judge 文件级语义覆盖（行号只当上下文），动机与 #107「外部 golden 锚位≠机制行（0-6 行漂移）」同题。我们的选项谱系：±3 容差（现状）/ 人工核锚（#107 手顺）/ 语义判定（他们的路，代价是引入 LLM 裁判——与本仓库「确定性打分」立场相撞，若引入须独立口径不进能力分）。
4. **640 条负例的次要用向**：数据集自述设计目标是评「反思模型拦截低质意见」——负例正是 D043 reflect 重开条件里「rubric 校准」的现成语料（别人家的坏意见 + 专家否决标签），重开讨论时可作 rubric 对照集。
5. **Ultra Mode = 差异化窗口期**。对方召回补齐已上路线图（H2 2026）。本仓库的召回端机制（D029 任务上下文 / D045 组织规范 / D035 复报保真 / correlation 组）是当下实打实的差异；窗口关闭前把 #157 调查做完、缺口定性（推理深度 vs 语料）落定，比追加新机制更优先。
6. **sticky summary / 增量不重复发帖**——同 commit 重投 D010 幂等已覆盖、跨 commit 场景 D035 已覆盖，不需要。
7. **每语言内置规则清单**与 AGENTS.md 注入是正交轴（语言惯例 vs 组织约定）。对方维护 60+ 文件类型清单的成本可观；本仓库 D045 刚落地待生产回收，暂不引入内置清单。
8. **委托模式 / IDE / MCP**——形态差异（CLI vs 服务），多仓产品化（#76）时再评估。

## 六、结论：README 表述口径

- **定性**：同构竞品（确定性管线 + Agent 独立演化到相同形状）、大厂内部实战出身、精度优先成本低召回。对标它比对 pr-agent 更有说服力：架构相同，差异集中在取舍与质量回路，不会被「形态不同不可比」消解。
- **三条差异化主线**：①召回端补齐（对方刻意低召回 + Ultra Mode 未落地 + 其反思过滤正是本仓库实测 1:1 不划算的那个机制）；②评测长在开发回路（对方 bench 资产全公开且更大，但是独立基准仓库的评估资产 + LLM-judge 打分，不是主仓库「改 prompt 必跑回归」的日常回路）；③PR 全生命周期无人值守（webhook 自动触发 + 合并闸门 + 复审记忆——对方长期记忆在 2027 路线图）。
- **措辞红线**：说「评测域聚焦 TS/JS」，不说「前端专精」；说对方「评测不在开发回路 / 评测资产在独立基准仓库」，不说「没有评测」、不说「harness 不在仓库」（勘误：在 alibaba/aacr-bench 公开）；规模差距（内部两年数万开发者 vs 单仓 dogfood）如实写。
