# 夜间执行计划归档（会话 36，2026-11-03 夜）

> 性质：**仅归档**——把 `roadmap-execution.md` 的可执行 Step 固化为本夜清单，不含新决策；一切按既有推荐方案执行，不需人工审批（用户睡前指令：尽可能多完成、限时免费 token 用尽、全程不打扰）。
> 编排模式：夜间批量二号（同会话 31）——编排者做计划归档与收尾，各 Step 派实现 subagent 串行执行，每个 PR 全流程闭环。

## 本夜范围（严格串行，一个 PR 闭环再开下一个）

| 序 | 内容 | PR | 依据 |
|---|---|---|---|
| 0 | 本计划归档 | docs（#39） | 总原则 2（spec 先行留档） |
| 1 | review.ts 机械拆分（D030：`src/diff.ts` + `src/router.ts` + `buildReviewPrompt` 选项对象，行为字节级不变） | `refactor:`（#40） | roadmap-execution.md Step 1 |
| 2 | 任务上下文注入（D029：parseLinkedIssues + fetchIssue + buildTaskContext + worker 编排 + inj-07） | `feat:`（#41） | Step 2 |
| 3 | search_files + repo fixture eval 组（D031：快照内存 grep + 两段协议扩展 + review-tools.md 行为指令） | `feat:`（#42） | Step 3 |
| A | 增量审查 spec 提前留档（`docs/plans/incremental-review.md`，只写 spec 不实现） | docs（#43，D032） | Step 6「spec 先行」；**实现仍等触发条件**，本夜不动代码 |
| B | 对抗性关联 fixture 扩充 5 例 | `test:`（#44） | Step 5；**条件执行**：仅当 1-3 全部干净收尾且时间充裕，由专注 fixture 的 subagent 按 D015 方法论（真实 fix 反转/配对，不手写想当然）执行；任何赶工感直接放弃并记录 |
| C | journal 会话条目 + 状态滚动收尾 | docs（#46） | AGENTS.md 改动追踪 |

不在本夜范围：Step 4（生产数据积累——等生产 run，无事可做）、Step 6 实现（触发条件 Step 4/5 收尾后，本夜只留 spec）、Step 7（缺第二家端点 key，用户侧动作）、Step 8（远期）。

## 每步红线与闸门（继承 roadmap-execution.md 总原则）

1. **eval 红线**：能力组 promptHash `d399f9d4ed17` + 逐用例输入 tokens（合计 23,376）与 2026-11-02 基线逐位一致，由参数路径构造保证；新组（inj-07 / repo 组）独立口径单独报告，不动能力基线。红线破裂 → 修复后才允许开下一步 PR。
2. **文档随行**：decisions / CHANGELOG / architecture / .env.example / README / roadmap-execution.md 状态行，与对应代码同一个 commit；`npm test` 全绿是每个 PR 的本地闸门，Step 1 另需 `npm run eval` 双确认，证据（测试计数 + promptHash + tokens 对照）贴进 PR 描述。
3. **PR 流程**：分支一律基于 origin/main，main 禁止直推；REST API 走 `.env` 的 `GITHUB_TOKEN`（无 gh CLI）；按标题前缀打类型标签。
4. **意见闭环**：行内线程逐条处置（修 / 回应不修 / 标误报），同时核对 review body 的「行号不在 diff 内」降级列表（无线程、resolve 脚本不可见，处置在 PR 评论留痕）；`--yes` 前必读最新 review；`review-threads` + `pr-review` 双 status 绿才合并。
5. **bot 链路故障回退**：开 PR 后 ~20 分钟无 review 无 status 视为生产死锁 → 按「夜间手动补审模式」（main 工作树等价管线 + 真实回帖 + status 如实手写标注 + PR 内披露），不沉默跳过。
6. **不打扰**：全程不提问、不等人工输入；歧义按 roadmap-execution.md 推荐方案自主裁定并在 journal 披露。

## 驱动条件（如实记录）

用户限时免费 token，本夜以「完成尽可能多的路线图功能」为途径自然消耗（eval 闸门、bot 审查、实现工作量都是真实开销）；不设无意义的空转任务，不伪造进度。

## 收尾结果（2026-11-04 凌晨）

全部按计划闭环：计划项 0-3 + A + B 共 6 个 PR（#39-#44），另有计划外附加 #45（Step 3 清单第 10 条收尾）与本收尾 #46，合计 8 个 PR（#39-#46），严格串行、每 PR bot 自审意见逐条闭环 + 双硬闸门绿后合并。红线总账：能力组 promptHash `d399f9d4ed17` 全夜 4 轮 eval 逐位不变，能力 29 例 + injection 7 例 inputTokens 与基线 0 mismatch；单测 138 → 174；eval 用例 35 → 48。附增收尾：Step 3 清单第 10 条（`[tools] probe tokens` 落日志）由 #45 补齐。剩余：Step 4（等生产数据门槛）、Step 6 实现（spec 已留档，等触发）、Step 7（等 key）、Step 8（远期）——均本夜范围外，见 journal 会话 36 收尾条目。
