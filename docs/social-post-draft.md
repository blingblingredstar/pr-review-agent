# 社交平台总结帖（草稿）

> PLAN Day 7 交付物。发布动作由人工执行（选平台、配图、署名）；发布后在本文件头部注明链接与日期。

## 正文（通用版）

花一周做了个带 eval 的 GitHub PR 审查 Agent，分享下过程。

**它做什么**：仓库里开 PR（或推新 commit），webhook 触发 → 拉 diff → LLM 结构化审查 → 逐条行内回帖。有意见直接 REQUEST_CHANGES 原生锁合并按钮，意见全 resolve 后重审自动解锁——review 闭环不靠自觉靠机制。

**几个踩出来的工程决策**：

1. **先回 200 再异步**。LLM 耗时不可控，超过 GitHub webhook 超时就会重试、重复评论。HTTP 层秒回，审查放 waitUntil 后台跑，幂等靠 review body 里内嵌 commit SHA 标记去重——不引入任何外部存储。
2. **超预算的 diff 按整文件块丢弃**，小文件优先（大文件八成是 lock 噪音），绝不切 hunk——切了行号就废，行内评论必 422。
3. **行内评论逐条预定位**。模型偶尔报幻觉行号，GitHub 直接 422。提前按 diff 覆盖行号逐条判定，定位不了的老实列在 summary 里注明——意见闭环机制只认线程，落不进线程的意见等于没提。

**最想说的是 eval 这件事**。没有评测集，改 prompt 就是盲改。做法：29 个自包含 diff 用例（其中 7 个从真实开源仓库的 bug fix PR「反转」构造——把人类修复的 +/- 对调，agent 看到的就是"真实代码、真实 bug 被引入"，ground truth 独立于出题人）+ 确定性规则打分（不搞 LLM judge）。每个 prompt 版本跑三轮取微平均（单轮 precision 波动能到 ±10pp，单轮数字会骗人）。一轮针对性迭代：**recall 92.6% → 96.3%，precision 81.9% → 94.2%**，意见总量还降了 18%。有意思的是第二次迭代是负结果——放宽"需要看 diff 外代码确认的问题照报"后召回上去了，精确率掉 6 个点，两个目标在规则层面有真实张力，回退。

**自举闭环**：这个 Agent 的每个 PR 都由它自己审查（dogfood），全程 8 个 PR、几十条自审意见逐条处理闭环后才合并，bot 抓到过自己 GraphQL 字段漏写这种 tsc 查不出的运行时炸弹。eval 的 dogfood 组就是这些真实意见转的回归用例。

技术栈：TypeScript + Vercel AI SDK + OpenAI 兼容端点（模型可插拔）+ Vercel Hobby 免费部署。仓库结构、决策记录（ADR）、迭代报告都在 repo 里。

## 短版（即刻/微博风）

做了个 PR 审查 Agent：webhook 触发 → LLM 结构化审查 → 行内回帖 + REQUEST_CHANGES 锁合并。重点是带 eval：29 用例（含真实仓库 fix 反转构造），prompt 迭代一轮 recall 92.6→96.3、precision 81.9→94.2，第二轮负结果也记了档。它自己审自己仓库的每个 PR，意见不闭环不能合并。TS + AI SDK + Vercel，模型可插拔。
