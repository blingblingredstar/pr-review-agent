# Spec：增量审查 + 报告门槛细化（立项稿，D032）

> 状态：**已立项（D032），未实现——本 spec 只留档设计，不含任何已实现声明**。实现待触发条件（`docs/plans/roadmap-execution.md` Step 4/5 收尾后），执行序届时在 Step 6 细化。
> 来源：会话 36（2026-11-04 夜间批量，条件 A）。本 spec 兑现 roadmap-execution.md Step 6「spec 先行」，并**显式翻案 D019 第 4 条**（synchronize 维持全量）——翻案理由见 §二.3。

## 一、背景与定位

现状：每次 `synchronize`（新 push）与 `opened` 一样**全量重审整个 diff**——dedupe（D010）按 head SHA 精确匹配，新 SHA 必然未命中，整个 diff 重新走一遍 prompt。D019（2026-10-30）曾明确「增量审查无新证据前不动」，当时的判断依据是：超大 PR 场景由 D018 截断兜底，增量没有解决「审查失败」类刚需。

此后三件事改变了成本收益结构：

1. **单次全量审查的真实成本涨了 2-3 倍**：D028 router 多一次前置调用、D027/D031 工具循环把主评审拆成两段、D023 上下文注入撑大输入——每次 synchronize 全量重审，付的是全套价格，换的却常常是「对未变代码的重报意见」（重复噪音）。
2. **超大 PR 已有底线**：D018 截断 + D025 files 拼合兜底落地后，增量审查从「解决审查失败的刚需」降级为「降低常态成本的优化」——触发条件与收益形态都与 D019 记录时不同了。
3. **dogfood 多 commit 常态化**：本仓库自己的 PR 就是多 push 实验场，synchronize 是高频路径。

**定位一句话：增量审查是成本优化 + 噪音治理，不是新能力——审查质量的红线（能力组 eval 逐位一致）不允许被它扰动。**

与报告门槛细化的关系：两者同属路线图第 5 项。增量缩小审查区间后，报告的噪音预算也应同步收紧——只在增量区间里再逐条行内发 minor/nit，线程噪音与闭环负担不成比例。门槛细化做在发布层（§二.6），全量/增量统一生效。

## 二、决策（含备选否决）

### 1. base 选择：D010 标记的语义扩展，读取路径一次现查

「上次已审 SHA」不新存任何地方，从既有 review 列表现查推导：

- **读取路径**：`listReviews` 分页（dedupe 的 `hasReviewed` 已经在拉的同一份列表，复用同一查询不增 API）→ 正则抽取全部 `<!-- pr-review-agent sha:<SHA> -->` 标记 → 得到「已审 SHA 集合」；取 **`submitted_at` 最新的、且仍在本 PR commits 列表（`GET /pulls/N/commits`）中的 SHA** 为增量 base。
- **为什么用 PR commits 列表做交集**，而不是对候选 base 与 head 跑 compare 判祖先：commits 列表就是「这个 PR 的历史 head 集合」，语义精确、一次轻量调用；force-push 重写后旧 SHA 天然不在列表中，重写场景自动落到回退分支（见下），不需要额外的祖先关系推断。
- **多 bot / 手工 review 混杂**：标记自带 `pr-review-agent` 命名空间——人工 review 无标记、第三方 bot 的 review 也无此标记，天然不参与；若同一 PR 存在多个本 agent 部署实例（同标记格式），推导出的集合语义等价，合并处理即可。仅取「本 agent 的 review」这点使「作者自己 re-request / 他人手工 review」不污染 base。
- **回退全量的触发条件**（任一即回退，行为与现状逐字节一致）：已审集合为空（首审）；交集为空（历史标记全部被 force-push 重写清出 PR 历史）；最新已审 SHA 恰等于当前 head（这就是现状的 dedupe 命中，直接跳过）。

### 2. dedupe 键扩展：(PR, 已审 SHA 集合)，集合沉淀在标记里

- **键形态**：`hasReviewed` 的命中判定不变（当前 head SHA ∈ 已审集合 → 跳过，幂等语义与 D010 完全一致）；扩展的是未命中分支——集合非空且交集有效 → 增量区间审查（base..head），否则全量。即键从「head SHA 单键比对」扩展为「(PR, 已审 SHA 集合) 的区间推导」，**不是**引入第二个存储。
- **存储口径（零基建同款）**：不建外部存储、不用 KV、不在信封/环境变量里持久化——「已审 SHA 集合」每次事件从 review 列表现查现推导，**集合的沉淀载体就是 review body 内嵌标记本身**（GitHub review 列表即存储，D010 的既有取向原样延伸）。每发一条 review，其标记就把该 head SHA 沉淀进集合。
- **标记扩展**：`<!-- pr-review-agent sha:<head> -->` → 增量审查时写 `<!-- pr-review-agent sha:<head> base:<base> -->`。`sha:` 键语义不变（已审集合的推导只看 sha）；`base:` 是可观测元数据（记录该次审查覆盖区间的起点，审计时人可读、脚本可核）。**旧标记缺 `base:` 合法**，读取路径必须容忍——全量审查的标记维持旧形态不变（base 语义上等价「全量」）。
- **人工可读行**：增量审查的 body 摘要注明「增量区间 `<base 短 SHA>..<head 短 SHA>`（此前 SHA 已审）」，与隐藏标记互为印证。

### 3. 与 D019 的衔接：显式翻案第 4 条

D019 第 4 条原文：「synchronize 维持全量重审：增量审查（PLAN §七 路线）无新证据（超大 PR 场景由 D018 截断兜底）前不动。」**本 spec 翻案的正是这条**——D019 当年点名延后的 v2 路线（PLAN §七「增量审查（只审新 commit）」）即本 spec。

翻案的理由是成本结构变化，不是 D019 判断错误：D019 的前提「无新证据」针对的是增量没有非解决不可的刚需（超大 PR 有 D018 兜底）——该前提至今成立，但①每次全量审查的成本从 1 次 LLM 调用涨到 2-3 次（D028 router + D027/D031 工具循环），增量的节省对象变成了最贵的部分；②D025 落地后超大场景有了完整底线，增量从「刚需补位」变为「常态优化」，立项的价值判据从「必须性」变为「性价比」；③dogfood 使 synchronize 成为高频路径，优化乘数变大。D019 其余三条（prompt v2 定稿、v3 负结果回退、上下文增强另设计用例集）不动。

**行为差异与重审一致性取舍**：synchronize 从「重审整个 diff」变为「只审 base..head」——

- 区间外的旧意见不再被机械重报（重复噪音消除），但也意味着**「旧意见是否仍成立」的重新确认随全量重审一起消失**。补位规则见下条。
- 区间内的行号锚点全部有效（增量 diff 的行号在 head 上），行内定位、D016 逐条预定位口径不变。

### 4. block 继承：有未消化的 blocker/major 就不享受增量

- **问题**：上条 review 有 blocker/major，作者新 push 只修了一部分且增量区间干净——增量审查看不见旧意见，「干净」结果会把 REQUEST_CHANGES 翻成 COMMENT，把未修复的旧 blocker 一并放行。D017 的「bot 重审无意见自动解除」闭环建立在全量重审「意见消失 = 已解决」的推断上，增量语义会破坏这个推断。
- **规则**：上条（`submitted_at` 最新一条）bot review 的意见分布含 blocker/major → 该次 synchronize **回退全量**（只有全量重审能给出「旧意见已解决」的解除依据）；上条干净或仅 minor/nit → 走增量。继承只看最新一条，不看历史累积（更早的 blocker/major 若已被后续全量重审消化过，不再翻出来）。
- **取舍**：blocker/major 重灾区的 PR 不享受增量节省——正确性优先，且这类 PR 恰恰需要全盘重新审视；增量节省集中在「一路干净的多 push PR」，那正是常态场景。
- **备选否决**：GraphQL 查 thread resolved 状态做精确继承——本仓 GitHub 交互是 REST 单面，扩 GraphQL 面为一个增强点不值；且「线程已 resolve」近似不了「意见内容是否仍成立」（作者可以 resolve 掉实际没修的线程，精确继承反而引入被resolve 操纵的放行路径）。否决。

### 5. 增量区间 diff 拉取：compare API，`fileToDiffBlock` 原样复用

- **首选**：`GET /repos/{owner}/{repo}/compare/{base}...{head}`——一次调用带回区间 commits + files（含 patch），files 条目（filename / status / patch / previous_filename）与 `pulls.listFiles` 同形，**D025 的 `fileToDiffBlock` 原样复用**拼出可解析 diff，`diffCoveredLines` / `truncateDiff` / `splitByLocatable` / `diffTouchedPaths` 下游管道零耦合（D025「合成 diff 与既有管道零耦合」同款）。
- **备选否决**：两份全量 diff 做集合差——base 时点的 diff 无处可取（本仓不存跨审查中间态，D026 信封 state 不出审查链；files API 只有当前态），要取只能把 base..head 之间每个 commit 的 diff 逐个拉取拼接（N 次调用、hunk 上下文交错还要去重）；文本级 diff-of-diff 则吃 hunk 上下文漂移的假差异。compare API 是这个问题的原生解。否决。
- **与 D025 的配合**：compare 的 files 数组是**单响应形态，不是 `pulls.listFiles` 的 per_page 分页**（官方口径约 300 文件/响应；超限行为与个别文件 patch 缺失的细节留实现期核实，本 spec 不预设）——超出上限的区间不硬拼，直接**回退全量**；compare 请求本身 406 / 任何失败 → **回退全量**（全量路径自有 D025 兜底）。增量是优化不是依赖，任何一层取不到数据都安全落回全量，绝不因增量路径失败导致 push 无审查。
- **与 D023 / D027 / D031 / D028 的配合**：快照恒为 head 全仓（zipball 不变），read_file / search_file / router 原样工作；`buildRepoContext` 吃增量 diff（触及清单 = 增量触及文件，上下文块成本随区间缩水）。已知盲区：增量 hunk 引用本 PR 先前 commit 改动的内容时，触及文件上下文不覆盖——由工具循环兜底（快照全仓可读），dogfood 若证明该盲区真实高频，再议上下文口径（开放问题②）。
- **D018 截断照常作为增量 diff 的最后防线**（区间本身也可能很大）。

### 6. 报告门槛细化：severity 分级发布，全量/增量统一

- **层位：发布层（postReview），不进 prompt**。模型 schema 照常全量输出全部 severity——改 prompt（如「不要报 minor」）会动 promptHash，直接违背红线；发布层的机械分级不碰生成。这也是 eval 与生产行为解耦的既有取向（D023 口径）。
- **分级形态**：
  - **blocker / major：行内必报**（可定位 → 行内线程；不可定位 → body 降级列表，现状语义不变）。
  - **minor / nit：不再逐条行内**，折叠进 review body 的 `<details><summary>minor/nit ×N</summary>` 汇总段。**这是立项即定死的取舍，不是留待观察的悬念**：折叠意见与降级意见同构地退出线程闭环（D016 / PR #8 修的正是 body 意见对 `resolve:threads` 与 `review-threads` check 不可见的盲区，本方案等于把 minor/nit 主动移进该盲区），两项补偿随立项同时承诺——①折叠段**逐条一行、格式与降级意见列表同构**（`` - `file:line` **[severity]** 全文 ``，机器可解析，不写自由摘要变体），实现期把「拉意见须同时核对折叠段」并进意见处置口径（AGENTS.md 既有「降级列表逐条核对留痕」的同型延伸）；②预登记回退分支：dogfood 若显示认领困难 → 恢复 minor/nit 行内线程（门槛只保留 COMMENT 判定收窄），不临场裁决。线程只留给需要人介入的信号——resolve 闭环负担不随噪音增长（AGENTS.md 的标签口径「minor/nit 不打标签防噪音」同型）。
- **D017 顺带细化**：REQUEST_CHANGES 判定从「有意见」收窄为「有 blocker/major」——与 `severityLabels` 打标签口径（has-blocker / has-major 才是介入信号）对齐；纯 minor/nit 的审查 → COMMENT 不 block。这是对 D017 「有意见 → REQUEST_CHANGES」的收窄，不是翻案（block 的本意就是「需要人介入」）。
- **统一生效**：门槛对全量与增量是同一套发布行为，不为增量单开一支（§一 已述：噪音预算与区间大小成比例，但分级规则本身不分形态）。

### 7. 备选总表（含否决理由）

| 备选 | 否决理由 |
|---|---|
| 已审 SHA 集合存外部存储（KV / Vercel KV） | D010 否决 KV 的理由原样成立：多一个外部服务与额度管理；标记沉淀零基建且天然跨实例持久 |
| dedupe 键含 PR 维度的新存储（(PR, SHA 集合) 落库） | 集合可从 review 列表现查推导，存储是伪需求；D026 阶段机外的持久化引入新失效模式 |
| base 用 compare API 判祖先关系 | commits 列表语义更精确（PR 历史 head 集合）、force-push 场景自动正确，无需祖先推断 |
| 两份全量 diff 集合差 | base 时点 diff 无处取、逐 commit 拼接 N 次调用、diff-of-diff 有假差异；见 §二.5 |
| GraphQL thread resolved 状态做 block 继承 | REST 单面不扩 GraphQL；resolved 可被作者操纵，「已 resolve ≠ 已修复」；见 §二.4 |
| 报告门槛进 prompt（让模型少报 minor/nit） | promptHash 红线直接破裂；且生成侧压缩不可逆——折叠进 body 的信息模型侧已丢失 |

## 三、测试与 eval 设计

### eval 红线（本 spec 的硬约束）

能力组用例不含增量形态 → **promptHash `d399f9d4ed17` 与逐用例输入 tokens（合计 23,376）仍须逐位不变**。兑现路径是构造保证而非回归测试祈求（D027/D028/D029 同型）：

- 增量组装发生在 worker 编排层（compare → `fileToDiffBlock` 拼 diff → 喂给既有 `reviewDiff`）；`reviewDiff` 契约不变（吃拼好的 diff 字符串），evals 直调 `reviewDiff`、不经过 worker 编排、不经过增量推导，**prompt 侧零接触**。
- 报告门槛在发布层（postReview），eval 不经过 postReview，同样零接触。
- 新增测试全部是纯函数/编排层单测，不新增 eval 用例、不动 `evals/` 任何既有文件。

### 单测清单（实现期展开）

1. 标记解析：新形态 `sha:... base:...` / 旧形态 `sha:...` / 无标记 / 多条标记混杂——已审集合与 base 推导逐一断言。
2. base 推导：最新 submitted_at 优先、不在 PR commits 列表的 SHA 被剔除、交集为空回退全量、head ∈ 集合走 dedupe 命中。
3. block 继承：上条 review 分布含 blocker/major → 全量；仅 minor/nit 或干净 → 增量；只看最新一条。
4. compare → diff blocks：files 同形复用 `fileToDiffBlock` 的断言（与 D025 files 拼合共用块构造，字节级同型用例）；分页超限省略行。
5. 回退链完备性：compare 失败/406 → 全量；zipball 失败 → 降级审查照旧（现状语义）。
6. 报告门槛：blocker/major 行内、minor/nit 进折叠段、纯 minor/nit → COMMENT、混合 → REQUEST_CHANGES；折叠段文本字节级。
7. worker 编排：增量信封 state 携带（base/delta diff）与现有 state 累积不冲突。

### 验收闸门

`npm test` 全绿 + `npm run eval`：promptHash 不变、**能力组**（2026-11-02 基线的 35 例口径，输入合计 23,376）逐用例输入 tokens 逐位一致（两条输出贴 PR 描述留证，与 Step 1 同型）；repo 组 / injection 组**独立口径不受扰**（用例数按实现时点的实际集合对表，本 spec 写死的能力组口径不随组扩充漂移）。

## 四、后果与边界

- **收益**：synchronize 的 LLM 成本从「全套（router + 两段工具循环）× 全量 diff」降为「× 增量区间」——增量区间通常远小于全量；重复意见噪音（未变代码的重报）消除；minor/nit 线程噪音收敛，闭环负担集中在 blocker/major。
- **代价与风险**：base 推导多一次 `GET /pulls/N/commits`（轻量）；blocker/major 重灾区 PR 回退全量（有意为之）；区间外旧意见不再被重新确认（由 block 继承补位）；force-push 后全量（正确行为）；标记格式扩展需兼容旧 review（读取路径容忍缺 base）。
- **非目标（明确不做）**：
  - 意见级持久索引（「哪些意见已报过」的库）——区间语义即记忆，不建意见去重库；
  - force-push 重写历史的智能重审——回退全量即正确处理，不追认已重写的旧 SHA；
  - 跨 PR 的审查记忆——增量只在本 PR 区间内成立；
  - 多实例并发审查同一 PR 的 marker 竞态治理——同 D010 并发窗口口径（概率极低、副作用是重复意见），接受；
  - fork PR 的跨仓 compare 细节核实——同 fork 网络内 SHA 可经 base 仓解析，fork 场景的 compare 行为留实现期核实，失败即回退全量（安全网兜底）。
- **开放问题（留实现期裁决，不预设）**：
  1. **区间覆盖的 gap 检测**：并发/重试交错下 base 链可能不连续（如两次审查覆盖 base..mid 与 mid2..head），「最新已审 SHA」单点推导是否足够、要不要做区间并集完整性校验——先按单点推导上线，dogfood 发现漏审再加。
  2. **上下文口径**：`buildRepoContext` 吃增量 diff 的跨 commit 盲区（§二.5）若 dogfood 证明真实高频，改「全量 diff 触及清单 + 增量 diff 本体」的混合口径（多一次全量 diff API，不进 prompt）。
  3. **minor/nit 折叠段的认领路径**：立项取舍已在 §二.6 定死（机器可解析逐条格式 + 处置口径随实现扩展 + 回退分支预登记），留实现期的只剩 AGENTS.md 具体措辞与 dogfood 回退判据的触发观察。
  4. **`pr-review` status 文案**：增量审查的 description 是否标注「增量」——纯文案问题，实现期定。
- **实现边界声明**：本 spec 只留档设计；实现 + 测试 + eval 回归 + PR 全流程，等 `roadmap-execution.md` Step 4/5 收尾后的触发条件，届时按 Step 6 执行序走 `feat:` PR。**本条 spec 的合并不代表任何增量行为已上线。**
