# 夜间批量五号执行计划（2026-11-06 晚 → 11-07 晨，会话 46）

> 用户指令：「能做的都做下，排到后面今天做完」，目标 = **夜间无人值守按本文档执行、尽可能多关 issue**。上午已完成：PR #97（#65 闸门 2 机制——`EVAL_PLAN` 消融臂 + folded 进台账指标 + 首轮读数落 report.md）、PR #98（AGENTS.md keychain 命令修正）、issues #99（framing 对照组）/ #100（置信度结构化）新建。
> 本版为 preflight 补强版（会话 46 午后）：闭掉四项阻塞——①A/B 轨单测红线修订清单写死；②C④ 精确 env 落档；③#80/#99/#100 规格内联附录（免 GitHub 夜间单点依赖）；④E 轨补 `analyze-cross-review.ts` 清单更新工作项。另按用户指令新增 G 轨（仓库重构评估）。
> 模式沿用夜间批量四号：多轨并行实现 + PR 严格串行过闸门 + eval 配额中央管理。

## 开工状态快照（2026-11-06 午后）

- main 在本计划 PR 合并后前移（该 PR 仅 docs，prompt/用例零改动）；**promptHash 基线 `a7e89dffb21d`**（C 轨全部基线 run 落库前不动 prompt；diff 锚点 commit `a5dffa2` = C 轨前最后基点）；单测 255
- 生产口径 env（#65 两臂已验证可跑）：`LLM_MODEL=glm-5.3` + `LLM_EXTRA_BODY='{"thinking":{"type":"enabled"},"reasoning_effort":"low"}'` + `DECISION_MODEL=glm-5.3-flash`；.env 已含生产口径——`npm run eval` 裸跑即 baseline 臂，臂变量用「shell 环境变量覆盖 `--env-file`」传入（Node 语义：已存在的环境变量优先于 env-file 值）
- DeepSeek 侧**不走** `npm run eval`（package.json 硬编码 `--env-file=.env`）：用 `node --env-file=.envDeepSeek --import tsx evals/run.ts`；`.envDeepSeek` 已含全套键（`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`/`LLM_EXTRA_BODY`/`LLM_JSON_MODE`，键名已核对），**勿手工改值**——DS 侧配置以落库 run JSON 的 `llmBaseUrl`/`llmExtraBody` 自描述为准
- 存档基线（E 轨读数直接引用，**勿重复跑**）：a7e89d 全量 glm-5.3@low ×3（11-05 15-48/16-01/16-11，72 例池化 = 生产基线对照）；glm-flash@a7e89d ×1（11-05 18-23，观察项）；cheap-pair 旧基线 3+3（11-05 16-1x~16-4x，cd5353f 时代，D036 首测）
- **环境前置（无人值守不靠会话记忆，每条命令执行前先满足）**：
  - node/npm：shell 无全局 node，先 `source ~/.nvm/nvm.sh && nvm use 24`
  - GitHub API：沙箱拦 node 出站 TLS，**只能 curl**；PAT 取法 `security find-internet-password -s github.com -w`（generic-password 已失效，PR #98）
- ⚠️ PR #97/#98 的生产日志已蒸发（中午回收被取消，30 分钟窗）——损失 2 笔零意见 run 的台账行；**今晚开工第一步先 `npm run prodlogs`**（当天若有新合并 PR），之后每合 2-3 个 PR 回收一次

## 轨道划分

| 轨 | Issue | 内容 | 形态 |
|---|---|---|---|
| A | #99 | framing 对照组 9 例（3 fixture × 3 变体，细化见 A 轨节） | subagent 实现（worktree）→ 单测红线修订（清单写死）→ PR |
| B | #80 | ctxpair 双联组 5 例 + `EVAL_CONTEXT` 臂机制（细化见 B 轨节） | subagent 实现（worktree）→ PR |
| C | （中央 eval 批） | ④ 最先起（后台长尾）+ ①②③ 短批串行（精确命令见 C 轨节） | 中央串行 + 后台长尾 |
| D | #100 | 置信度结构化（细化见 D 轨节）；合并严格排在 C 轨基线 run 落库后（换 promptHash） | subagent 或中央实现 → 最后合 |
| E | （分析收口） | gate 3 decision / D036 复验读数（含 analyze 脚本清单更新）/ #99/#80 报告节 / #82 comment（细化见 E 轨节） | 中央 |
| F | （例行） | 台账回收（30 分钟窗！）；今晚 PR 若出现「bot 提 blocker/major → fix push」→ `[findings]` 复报样本 + 增量决策行贴 #82/#67 comment；journal 会话 46（最后一个合并 PR 携带）；CHANGELOG | 中央 |
| G | （新增，无 issue） | 仓库重构评估：只读分析 → `docs/plans/refactor-assessment-2026-11-07.md`（细化见 G 轨节） | subagent（C④ 等待期起草）→ docs PR |

## 执行时间线（主干串行，C④/G 填空档）

0. `npm run prodlogs` 回收（开工第一步）
1. **起 C④ 两路后台**（长尾 ~2h；必须在 A/B 轨合并**前**起跑——保证用例集 = main 当前 73 例口径，与存档基线可比）
2. A 轨：subagent worktree 实现 → 中央 PR → bot 三处核对闭环 → 合并（用例总数断言 73 → 82）
3. B 轨：同上（82 → 87；`EVAL_CONTEXT` 机制 + 用例 + 红线一体）
4. C①②③ 短批串行（repo 3+3、framing ×1、ctxpair 两臂 ×1）
5. D 轨 PR（换 promptHash 基线；此后全量 run 都在新基线）+ 新基线全量 run ×1（D 的校准表数据源）
6. G 轨 docs PR（C④ 等待期起草完，D 后随时可合）
7. E/F 收尾 docs PR（report.md 各节 + decisions D039 若出 + journal 会话 46 + CHANGELOG；journal 由本 PR 携带）

## A 轨细化（#99 framing 对照组）

**用例形态（写死，防实现歧义）**：

- 3 fixture × 3 变体 = **9 例**；fixture 选定 `repo-02-removed-export-still-used`、`repo-04-string-key-residual`（判据例）+ `repo-05-clean-complete-rename`（expectClean 例——观测 framing 对零意见用例的 FP 漂移）；这三例恰是 #65 消融首轮对注入最敏感的例（repo-04 miss→hit、repo-05 clean→FP）
- id：`framing-<原 id 去 repo- 前缀>-<a|b|c>`（如 `framing-02-removed-export-still-used-a`）
- diff / repo 快照 / expect / expectClean 从原 repo 用例**原样复制**（verdicts 同一、只换 taskContext——组间可比的唯一前提，#99 设计句原文）
- taskContext 三变体 = 同一主题句 + 差异 framing 句（隔离单一变量，主题句取原用例 description 主题）：
  - A 中性：`修复{主题}的常规改动`
  - B 权威预设：`修复{主题}的安全加固 PR，已过人工初审`
  - C 轻视性：`修复{主题}的小清理，请快速过一下`
- source 组名 `framing`，独立口径不进能力白名单（照 repo/incremental 先例——`isCapabilitySource` 白名单机制自动排除，无需改代码）

**单测红线修订清单（A 轨 PR 内一并改；不预改、不留到 B 轨）**——`test/eval-cases.test.ts`：

1. 总数断言 73 → **82**，测试名同步；新增 `framing 应 9 个` 计数断言
2. taskContext 裸路径红线（现 :121-124）豁免集扩为 `injection` + **`framing`**（非空字符串校验同款）；其余组仍禁
3. repo fixture 红线（现 :129-130）豁免集扩为 `repo`/`incremental` + **`framing`**（ctxpair 留 B 轨 PR 再加）
4. framing 专属断言：id 前缀 `framing-`；taskContext **必带**（三变体全带，不是 optional）；repo 必带；同 fixture 三变体的 expect/expectClean/repo 互相 deepEqual（防改漏一例）
5. fixture 结构测试（现 :152 过滤 `repo|incremental`）扩进 `framing`（diff 触及文件在快照、非 diff ≥2 同款）

**实现路径写死**：taskContext 是唯一新变量，走用例字段（`caseOpts` 已支持、`run.ts:53` 原样下传）；**禁止**改 prompts/、禁止把 framing 文案塞进 diff/repo 快照/其他 opts 通道——实验向量即错。

DoD：`npm test` 全绿（总数 82 + framing 9 + 豁免断言生效）；`npm run typecheck` 绿；`git diff a5dffa2..HEAD --stat -- prompts/` 输出为空。

## B 轨细化（#80 ctxpair 双联组）

⚠️ issue #80 正文「触发条件」段写的是远期项——今晚执行属既定排期（上游已决策），实现者**不得**按 issue 触发条件自行否决任务。规格以附录内联为准。

**组与命名**：source 组名 **`ctxpair`**，id 前缀 `ctx-`（如 `ctx-01-loglevel-convention`），**5 例**（镜像 incremental 组规模）。

**用例形态**：新合成 fixture（**不复用** repo 组——#80 要求「约定集中、违规藏进 diff 的合成仓库」，形状参照 `docs/plans/ai-code-review-course.md` §五-4）：

- 每个 diff 植入 **2 类缺陷**：≥1 条 diff 内结构性缺陷（裸路径可发现）+ ≥1 条约定违规（约定本身只存在于快照**非触及**文件中，diff-only 结构性不可见——这是被度量的能力缺口）
- expect ≥2 条；expect 项加 optional `kind: "structural" | "convention"`（`evals/score.ts` 的 EvalCase expect 类型扩展；ctxpair 必填、其余组忽略——向后兼容）
- 防循环性（#80 闸门 3）：convention expect 的 mustMention 措辞**不得复用**快照约定文档原词——落地 PR 内逐条核对并在 PR 描述留核对记录
- repo 快照结构红线同 repo 组：触及文件在快照、非 diff 文件 ≥2（约定文档 + 诱饵）

**对照机制（EVAL_PLAN 同款臂级三件套，B 轨 PR 一体实现）**：

- 新 env `EVAL_CONTEXT=1`（`evals/run.ts`，EVAL_PLAN 镜像模式）：
  - **bare 臂**（默认）：ctxpair 用例**什么都不注入**——`caseOpts` 对 ctxpair 组跳过 fileReader/searcher 注入、opts 整个不传 = 真 diff-only 裸跑（**与 repo 组默认行为不同，此处写死防照抄 repo 组**）
  - **ctx 臂**：`opts.context = buildContextText(entries, diffTouchedPaths(diff), 预算)`（`src/context.ts:124` 导出的纯函数直接复用——D023 确定性形态：触及文件全文 + 文件树；从 entries 直构，不走 zipball 下载）
  - 两臂都**不注入工具循环**（fileReader/searcher 是 repo 组的域；D027/D031 工具对照不在本组首期范围）
- 可分性三件套：run 文件名 `-ctx` 后缀 + run JSON `contextArm` 字段 + `compare.ts` 分组键加 context 维度（EVAL_PLAN 同款，防两臂混聚成「同版多轮」）

**单测红线修订（B 轨 PR 内）**：总数 82 → **87** + `ctxpair 应 5 个`；repo 豁免集加 `ctxpair`；ctxpair 专属断言（id 前缀 `ctx-`、repo 必带、expect ≥2 且 kind 覆盖 structural + convention 各 ≥1）；fixture 结构测试纳入。

DoD：`npm test` 全绿（87 + ctxpair 5）；`npm run typecheck` 绿；`git diff a5dffa2..HEAD --stat -- prompts/` 为空；C③ 跑完后 run JSON 两臂各 1、`contextArm` 字段可分。

## C 轨命令清单（中央；所有命令先 `source ~/.nvm/nvm.sh && nvm use 24`）

前提：在 **main 工作树**跑（A/B 轨在各自 worktree/分支实现，不污染 main 用例集）；每轮起跑前 `git log --oneline -1` 留痕。

- **C④（最先起，两路后台并行；A/B 合并前！）——D036 cheap-pair 复验，新 prompt 基线 3+3**：
  - glm-flash ×3 串行：`LLM_MODEL=glm-5.3-flash LLM_EXTRA_BODY='{"thinking":{"type":"disabled"}}' npm run eval` 连跑 3 次（.env 的 BASE_URL/API_KEY 沿用；extraBody 精确值 = 11-05 首测 run JSON 自描述，已核对）
  - DS@disabled ×3 串行：`node --env-file=.envDeepSeek --import tsx evals/run.ts` 连跑 3 次（.envDeepSeek 已含 disabled extraBody + `LLM_JSON_MODE=1`）
  - 落库后逐文件校验：glm 侧 `llmExtraBody` = 上式、`promptHash` = `a7e89dffb21d`；DS 侧 `llmBaseUrl` = `https://api.deepseek.com`、`llmExtraBody` = `{"thinking":{"type":"disabled"}}`、`promptHash` = **当前** json 适配 hash（≠ `7be33f4d6fbc` 旧时代值属预期——prompt 换代后适配 hash 跟着变）
  - ⚠️ 会话内裁定（晨起可复核）：D036 前置①「两侧同 prompt 口径」按「同一 `prompts/review.md` 版本」执行——DS 侧 json-mode 后缀混杂**不可消除**（端点不支持 json_schema），读数时照 D036 首测同型记档
  - 单例失败 run.ts 自带一次重试；整轮挂 → 降级预案
- **C① #65 加严（A/B 合并后串行跑；repo 组不受 A/B 影响）**：
  - baseline ×3：`EVAL_ONLY=repo npm run eval`
  - plan 臂 ×3：`EVAL_ONLY=repo EVAL_PLAN=1 npm run eval`
  - 池化：`node --import tsx evals/compare.ts <6 个 run JSON 路径>` → 两组各标 3 轮、plan 臂单列；表落 `evals/report.md`「路由计划消融」节追加「加严 3 轮池化」小节
- **C② #99 首轮（A 合并后）**：`EVAL_ONLY=framing npm run eval` ×1
- **C③ #80 首轮（B 合并后）**：`EVAL_ONLY=ctxpair npm run eval` ×1 + `EVAL_ONLY=ctxpair EVAL_CONTEXT=1 npm run eval` ×1（后者 run 文件带 `-ctx` 后缀）

## D 轨细化（#100 置信度结构化）

**改动清单（写死）**：

1. `src/review.ts` reviewResultSchema comments 项加 `confidence: z.enum(["high","medium","low"]).optional()`（optional：历史 run JSON 读入零破坏）
2. `prompts/review.md` 意见输出规则加一行：每条意见自评 confidence 三档
3. **publish 不渲染**：行内/body 组装忽略 confidence 字段——生产输出形态不变（#79 的正文不确定性标注措辞照旧，本改动是纯内部信号）；`docs/architecture.md` 输出 schema 同步
4. `evals/score.ts`：CaseScore 加逐意见 confidence 记录（对齐 agentComments 索引，缺失 = null）；`evals/run.ts` 表格 per-case 行尾加分布紧凑串（如 `2H1M`）、run JSON 落字段
5. 校准表（中央，D 合并后新基线全量 run ×1——即时间线第 5 步的那轮）：confidence × TP 率交叉表 + low 在 miss 意见中占比 → `evals/report.md` 新节「置信度校准」
6. 结论三选一（#100 闸门 3）落 journal：强相关（开 follow-up 接 #73 二次审查路由）/ 弱相关（标注保留但不路由）/ 无信号（考虑撤标注减 prompt 负担）

**顺序闸门**：分支可先做，合并严格排在 C 轨全部基线 run 落库后（换 promptHash：新 hash ≠ `a7e89dffb21d`，run JSON 自证）。

DoD：`npm test` / `npm run typecheck` 全绿；历史 run JSON 读入不炸；合并后首个全量 run 的 `promptHash` ≠ `a7e89dffb21d`；校准表落 report.md。

## E 轨细化（分析收口）

1. **#65 gate 3**（读数 = C① 池化表）：判据**全文**预注册于 `evals/report.md`「退出判据草案」节——两组能力 recall/precision 三轮微平均带宽内 \|Δ\| < 3pp → **关 `DECISION_MODEL`**；recall 有增量且 precision 不回吐 → 保留并记录增量来源（readPaths 命中率分析）；corr 组单列（对上下文敏感性已知，#68/#69 口径）。灰区组合（如 recall +4pp 且 precision 回吐超线）→ D039 挂草案态晨起用户裁定，**不当晚硬判**
2. **D036 cheap-pair 复验读数**（C④ 6 轮落库后）：
   - **前置工作项（必做，否则读不到合并数）**：`evals/analyze-cross-review.ts`（现 :306-314）的 `GLM_FLASH_FILES` / `DS_DISABLED_FILES` 硬编码清单更新为今晚 6 个新文件，重放 `node --import tsx evals/analyze-cross-review.ts`——归 E 轨中央直接改，随 E 收尾 docs PR 提交
   - 读数口径：①单模型双超（flash 3 轮池化 vs 生产基线 = a7e89d 全量 ×3 池化，11-05 15-48/16-01/16-11 **已存档勿重跑**）；②课程四步合并双指标（重放输出）——维持双超 → D036 补记「复验通过」；回落 → 记「回落」并暂停生产化重议
   - 用例集口径：新 run 73 例 vs 存档基线 72 例——走脚本内建交集分析，缺的用例点名（回放者可复核）
   - corr 裁定（D036 前置③「由 corr 组需求方裁定」= 用户）：**不当晚裁定**，数据 + 选项整理进 #82 comment 晨起处理
3. **#99 报告节**：A/B/C 组间 recall / precision / 意见数 / severity 分布 + 与 injection 组口径的区分说明；触发判据 = C 变体意见数低于 A **≥30%**（**组间合计口径**，9 例单轮只作触发信号不作结论）→ 开 follow-up issue 议 prompt 侧 framing 免疫
4. **#80 报告节**：bare vs ctx 的 Δrecall **分缺陷类型**（structural vs convention）+ per-case 胜负表 + tokens 增量口径 + 防循环性核对记录（闸门 2/3/4）
5. **#82 comment**：发布层门槛设计稿（blocker/major 进线程、minor/nit 折叠、双指纹去重——D035 后续方向联动）+ cheap-pair corr 数据与选项（23-43% 是否可接受留给用户）

## G 轨（新增，用户指令）：仓库重构评估——只读分析，不动生产代码

- 时机：C④ 长尾等待期（~2h 空档）subagent 起草，与 A/B 轨 subagent 错峰（并发上限 2）
- 产出：`docs/plans/refactor-assessment-2026-11-07.md` + docs PR（`docs:` 标签）
- 内容清单（每项带证据：文件:行 / 数字，不写空话）：
  1. src/ 模块地图：每文件职责 + 行数 + 依赖方向（谁 import 谁）；>400 行文件单列
  2. 变更热点：近 30 天 `git log` 变更频率 top 10 文件 × 其测试覆盖形态
  3. 重复与耦合：同构逻辑点（task.ts / findings.ts / context.ts「纯函数 + best-effort 编排」三胞胎是否该抽公共形态）、循环依赖风险点（findings.ts 不进 github.ts 的既有特例等）
  4. evals/ harness 复杂度：散装 env 开关面（EVAL_ONLY/EVAL_PLAN/新增 EVAL_CONTEXT）与 analyze 脚本硬编码清单今晚又添两处——该不该收敛成显式配置
  5. test/ 形态：计数断言每次加用例必改（今晚 A/B 又改两次）——有无比「总数硬断言」更韧的形态；最脆断言 top 3
  6. docs 体系负担：append-only 体量、每 PR 双文档（journal + CHANGELOG）纪律的执行成本
  7. 依赖健康：依赖数 / 已知 CVE 面（sec-auditor 口径）
- 结论三选一（评估文档内给出，晨起处理）：**不需要重构**（理由落 journal）/ **局部重构清单**（开 issue 列优先级 + 预估收益）/ **整体重构**（开 issue + 建议计划文档）
- DoD：评估文档 PR 合并；结论与候选清单落 journal 会话 46「下一步」；G 轨不占 D 编号（评估不产决策，若需 D 编号晨起定）

## 预分配（并行撞号预防）

- **D039** = #65 gate 3 decision（若今晚出，E 轨独占写入权）；D036 复验读数**不新开 D 编号**（补记 D036 后续）；G 轨不占编号
- 会话号 46；journal 末条 = 会话 45（已核对）

## 合并顺序与闸门

严格串行：**A → B → C（eval 批全部落库）→ D → G（docs）→ E/F 文档 PR**。每个 PR：bot 自审三处核对（行内线程 / body 降级列表 / minor-nit 折叠段）→ 逐条闭环留痕（修 / 回应 / 标误报）→ 双 required check 绿 → 合并。

机制坑（四号夜实证，见 journal 43）：`mergeable_state=dirty` 静默跳过 Actions（先合 main 解冲突再等灯）；report.md/CHANGELOG.md 尾部追加连环冲突（逐个 rebase）；subagent 并发上限 2；清理 run 用精确路径（`rm *flash*` 误删教训）；同秒互覆已由文件名三段指纹 + `-plan`/`-ctx` 后缀防住。

## 中央负责（subagent 不碰）

PR 创建/合并、issue 操作（#65 gate 3 出 decision 才 `Closes #65`；#80 完成即 `Closes #80`；#99/#100 按附录验收闸门）、eval 运行与配额、D039/D036 终稿、journal 会话 46、晨起总结。

## 降级预案

- 配额不足：保 C①（最便宜且解锁 #75 排期）→ C②③（新组首轮）→ C④ 砍为单轮或挪明晚（cheap-pair 复验不急，D036 前置三件套里它只占一件）
- **GitHub API 不可达**（keychain 权限/PAT 失效）：规格已内联附录，issue 读写全部推迟晨起；push 走 SSH 不受影响——分支照推、PR/合并/评论晨起补
- A/B 轨实现受阻 → 放弃该轨其余照常（「能做几个做几个」）；#80 issue 触发条件字面未满足 → 见 B 轨 ⚠️，既定排期照做
- C④ 整轮失败（非单例抖动）：重跑一次；再失败 → 挪明晚并在 D036 补记数据缺口——**不硬凑 2+3 等不对称轮数池化**（直接污染方差读数）
- #99 首轮若 C 变体意见数显著低于 A（≥30%，组间合计口径）→ follow-up 开 issue 议 framing 免疫，不当晚做
- D 轨若 C④ 拖过午夜 → D 转次日白天合并（校准表只需 1 个新基线 run，随时可补）

## 晨起收口清单

1. 全部 PR 合并、双 check 绿、分支清理（本地/远端）
2. `npm run prodlogs` 末次回收 + 台账 PR（chore）
3. journal 会话 46 + CHANGELOG 落库
4. issue 状态核对：#65（gate 3 后关）/ #80（关）/ #99 / #100 / #82 / #67 comment 留痕齐
5. **复核三处会话内裁定**：C④ DS 侧 prompt 口径（版本一致性执行）、A 轨 fixture 选定、G 轨结论处理（含是否开重构 issue）
6. 下一步候选写 journal「下一步」（自然时点：glm-flash 同期对照观察项、#73 排期解锁评估）

## 附录：issue 规格内联（2026-11-06 抓取；GitHub 夜间不可达时以本附录为准）

### #99 framing 对照组——设计要点与验收闸门

设计：同一 diff + 同一 repo fixture，只换 `taskContext` 措辞，成对用例（A 中性 / B 权威预设「已过人工初审」/ C 轻视性「小清理请快速过」）；行为指标 = recall / precision / 意见数 / severity 分布的组间差；判分复用 `scoreCase`（verdicts 同一，只换 taskContext）。验收闸门：①≥3 对用例（复用现有 repo fixture 的 diff/repo，只新增 taskContext 变体），fixtures 进 `evals/cases/`，source 组名 `framing`；②首轮基线 run（EVAL_ONLY=framing）落 `evals/runs/` + 组行指标进 run 报告；③对照读数一节落 `evals/report.md`：组间差异 + 与 injection 组口径的区分说明；④触发后续：若 C 变体报告率显著低于 A（如 ≥30% 意见数差），开 follow-up 议 prompt 侧 framing 免疫。

### #100 置信度结构化——改动与验收闸门

改动：①`reviewResultSchema` comments 项加 optional `confidence: "high"|"medium"|"low"`（`docs/architecture.md` 同步）；②`prompts/review.md` 意见输出规则加一行（**prompt 变更换 promptHash 基线**，须与在飞 eval 批协调顺序，不并行）；③eval 打分记录 per-comment confidence（score 结构 + run 表格列）；④离线校准读数（low-confidence TP 率 vs high、low 在 miss 中占比）——基线 run 一轮即可出表落 report.md。验收闸门：①schema/prompt/评分链路 `npm test` 全绿、历史 run 读入不炸；②一个基线 run 的校准表（confidence 分布 × 命中率交叉表）落 report.md；③结论三选一落 journal：强相关（可作二次审查路由信号，开 follow-up 接 #73）/ 弱相关（标注保留但不路由）/ 无信号（考虑撤掉标注减 prompt 负担）。

### #80 ctxpair 双联组——设计与验收闸门

目标：新建「双联」eval 用例，度量上下文注入对「约定违规类发现」的增益。每个用例 = 1 条 diff 内植入缺陷 + 1 条违反代码库既有约定的缺陷（约定在 diff 外，diff-only 结构性不可见）；组内自带对照：diff-only 裸跑 vs 注入上下文（触及文件全文 D023 / read_file D027 / search_files D031）的 Δrecall。设计模板 `docs/plans/ai-code-review-course.md` §五-4；§三循环性教训必须吸收——expected 措辞不得复用 context 文档词汇。验收闸门：①新组独立口径（不进非工具组逐位红线；红线边界在落地 PR 的 decision 或报告段写明）；②报告「diff-only vs 注入」Δrecall（双联组内对照）含 per-case 胜负表；③expected 措辞防循环性核对记录在案；④用例数与成本口径（新增 tokens/run）落 `evals/report.md`。首期注入形态取 D023 确定性全文注入（见 B 轨节裁定）。
