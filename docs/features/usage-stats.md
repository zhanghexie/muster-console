# 使用统计（Usage Stats）

「实用功能 → 使用统计」按日期范围展示新建会话、活跃会话、能力调用和扩展 LLM。表头横跨面板，标题靠左、刷新靠右，不显示返回终端按钮。日期范围、统计卡片和下钻详情共用水平居中的正文列，列宽上限为 1180px，窄面板保留两侧内边距。日期范围统一控制概览和下钻；详情只由点击卡片或页签切换，默认展示新建会话，刷新不改变选择。快捷键 `utility.usage`（默认 Ctrl+Shift+U）。

## 功能职责

- 日期：今日 / 近 7 天 / 近 30 天（日历日）与双月自定义日历，最大 366 天、禁止未来日期。日桶永久保留；通常展示上一等长同期环比。
- 新建会话：发起创建即计数，含拉起失败。按工作面板/终端和 runtime 展示构成与趋势。
- 活跃会话：工作面板发送、终端提交含换行的输入、调度发起回合时记录。只打开会话不算活跃。日桶按会话 ID 去重，范围合计合并 ID（不是每日数量相加），取范围内最近一次交互的名称/runtime/工作区/时间作为详情。调度使用 `scheduler:<workspaceId>` 标识同一工作区的调度会话。每日趋势是每日去重数，超过14天按7天分段求和（会话日数量），不等于整段独立会话数。活跃卡不展示环比，避免尚无采集数据的历史段产生误导。
- 能力调用：Catalog 已知工具的调用次数与失败/取消数。详情含排行、Top-8 工具趋势（其他合并）和失败焦点；失败焦点同时展示失败次数/率及最近错误文本、时间、取消标记。失败详情每次显示50条，可加载更多。
- 扩展 LLM：保持 `ma.llm.chat` 次数、失败数、按扩展聚合、平均时长和按 ID 展开完整明细。
- 无头 Agent 已退役：面板不再展示卡片、运行列表或创建引导；统计 IPC 不再查询无头任务。旧日桶字段及 IPC 空字段保留兼容，不清除历史计数。

## 关键文件与入口

| 层 | 文件 | 职责 |
|----|------|------|
| shared | `src/shared/usageStats.ts` | 日桶/活跃会话/失败明细类型，归一、日历算法、范围聚合与跨日会话去重 |
| main | `src/main/usage/service.ts` | 日桶、扩展LLM明细、能力失败明细的采集与保留 |
| main | `src/main/store.ts` | userData 下 JSON 读写与排队落盘 |
| main | `src/main/ipc/usage.ts` | `usage:summary` 范围汇总、`usage:llm-call` 单条明细 |
| renderer | `src/renderer/src/components/UsageStatsPanel.tsx` | 日期范围、四卡、手动下钻与失败列表 |
| renderer | `src/renderer/src/components/UsageCalendar.tsx` | 双月日历，usePresence + mp-pop |
| renderer | `src/renderer/src/styles/usage.css` | 统计面板与列表布局 |

## 埋点与数据流

| 指标 | 埋点 |
|------|------|
| 新建会话 | `SessionsService.createTerminal` |
| 活跃工作面板会话 | `src/main/ipc/agentSession.ts` 的 `agentSession:send`，读取现存会话信息后发起发送 |
| 活跃终端 | `src/main/ipc/sessions.ts` 的 `pty:input`，只认包含回车/换行的输入；不保存输入文本 |
| 活跃调度 | `src/main/agent/orchestrator/turnExecution.ts` 发起回合（包括重试/自治回合） |
| 能力调用与失败 | `src/main/capabilities/executor.ts` 的 `executeTool` 统一收口，传递 error / cancelled，不传参数/返回正文 |
| 扩展LLM | `src/main/extensions/extensionLlm.ts` 的 `llmChat`（`extensionAppAdapter.ts` 接入扩展运行时），校验后无论成败都记 |

```text
计数/活跃会话 → UsageStatsService.days → usage-stats.json（永久）
扩展LLM明细 → usage-llm-calls.json（30天 / 1000条）
能力失败明细 → usage-tool-failures.json（30天 / 1000条）
usage.summary({fromKey,toKey,llmLimit})
  → rangeDays / rangeTotal / prevTotal（活跃会话按ID合并）
  + toolFailures（按发生日本地日过滤，最新优先）
  + llmCalls / llmCallsTotal / llmByExt
usage.llmCall(id) → 扩展LLM完整记录
```

失败文本限2000字符，屏蔽常见 Bearer/API key 等凭据形式，不保存调用参数。启动、写入、查询时裁剪失败明细，并排队回写裁剪结果。面板固定每15秒刷新，无退役运行导致的高频轮询。

## 交互与已知边界

- 活跃会话与能力失败详情从新版启用后开始采集，不能回填历史。旧失败计数可能非零而详情为空，页面明确提示。终端回车仅表示交互提交，不能证明执行成功；工作面板发送和调度发起同样不表示 Agent 工作完成。
- 活跃会话元数据随日桶保留，包括关闭/删除过的会话；不依赖当前会话注册表反推历史活跃。仅当会话身份、runtime 和名称均匹配宿主调度默认值时，详情按界面语言翻译该名称，保存的统计和用户命名不变。终端无换行的交互按键不计入；其他程序直接写 PTY、绕过这些入口的发送不在此口径内。
- 调度回合、GUI发送和读屏的旧计数继续保留，页面不展示。模型Token/费用暂不纳入本次变更。
- 日桶按本机本地日分桶：能力/LLM调用按结束时刻计数，扩展LLM明细目前按 startedAt 过滤，跨午夜存在口径差异。会话创建/活跃按发起交互时间。
- 失败详情和扩展LLM明细各自受30天/1000条约束；计数永久保留，因此不能用明细条数代替历史总次数。扩展LLM分页上限100。
- 日期非法值回落今日、禁未来、366天封顶；`addUsageDays` 用本地历法处理夏令时。加载时丢弃未来日桶。
- 埋点持久化失败不影响业务执行。主进程改动需新构建并重启客户端才生效。
- **列表预览口径（明示）**：扩展 LLM 明细列表（`usage:summary` 载荷的 llmCalls 预览）把该调用**用户对话内容截 160 字**拼进条目，随 15s 面板轮询一并下发——预览文本使列表载荷超出「计数+元数据」面；接受理由：数据本就本地落盘、本产品为本地单用户形态，无跨用户暴露面；完整正文仍在 `usage:llmCall(id)` 展开层。

## 定向验证

- `node test/run.mjs usage-stats`：日桶归一、历法/范围、活跃去重/持久化、失败脱敏/保留/查询。
- `npm run test:unit -- usage-stats-panel`：退役入口消失、活跃下钻、超过旧轮播周期保持选中、错误/取消/历史无详情提示。
- `node test/utility-header-alignment-visual.mjs`：检查不同面板宽度下表头的对齐与统计正文的两侧留白。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：「实用功能→使用统计」按日期范围看新建会话/活跃会话/能力调用/扩展 LLM 四卡+下钻；快捷键 Ctrl+Shift+U。
- 为什么这样设计：埋点统一收口（executor/agentSession:send/pty 含换行输入/turnExecution），不存参数不存输入文本；日桶永久+失败明细 30 天/1000 条有界+脱敏；活跃会话范围按 ID 合并而非日数相加（防重复计数）；活跃卡不展示环比（防历史段误导）；计数持久化失败不影响业务执行。
- 明确不做：Token/费用暂不纳入；无头 Agent 已退役不回填；不能以明细条数代历史总次数；终端回车只证明交互提交不证明执行成功（口径明示）。
- 歧义点：Token/费用统计——A=暂不做（定位=活动与能力使用画像；costUsd 已在 callMetrics 透传，将来接是纯展示工作）／B=排期接入费用卡。推荐 A（先让日桶口径稳定），B 成本低、有预算感知需求即可升。
