# 调度 Agent 的记忆与机械态势

调度记忆已使用类型化知识系统与按需专用 Pi 记忆会话；机械 `SITUATION.md` 保持宿主独立生成。原调度 MEMORY.md 整文件写入与 `scheduler.memory.write/append` 已退休，不能再按双文件策展系统理解当前行为。完整知识、事务和历史边界见 [记忆系统](memory-system.md)，查看与删除见 [记忆中心](memory-panel.md)。

## 两类跨会话材料

| 材料 | 生产者与存储 | 消费 |
|---|---|---|
| 调度私有知识 | 调度 Agent 通过 memory.note/remember 提交，后台记忆会话判断；`controlRoot/.muster/knowledge/scheduler/` 类型化条目与账本 | 按1200字符核心预算和1600字符任务召回预算使用 |
| 全局用户偏好 | 宿主绑定用户原话，记忆会话整理；应用 userData 的知识库 | 生效、满足核心条件的偏好按800字符预算注入 |
| 机械态势 | 宿主 `situationWriter` 生成 `controlRoot/.muster/scheduler/SITUATION.md` | 新调度上下文首轮读取，模型只读 |

多根工作区始终按固定 controlRoot 定位记忆、队列、态势和转录；切默认源码根不切调度私有库。仓库/分支作为独立适用范围由宿主绑定；未知工作区不能回落当前活动目录。Worker 共享知识位于自己的 namespace，不能直接改调度私有范围。

## 按需提交与专用记忆会话

调度完成一轮、压缩或关闭时不自动运行记忆抽取，也不再用压缩前私有 memory flush 强制整理。发现有原始依据及未来用途的结论时，调度自行低频调用 `memory.note`；用户本轮明确要求记住才可 `memory.remember`。返回入队不等于保存，任务流水只留历史。来源、工具结果与目标范围由宿主绑定；候选工具证据从尾部按 120 条范围页定位最新助手消息，不复制整份调度历史；普通助手结论不能冒充实测或用户授权。

每个工作区的记忆 Pi 会话 purpose=memory，只有 candidates/search/evidence/commit/defer 五个专用工具，资源加载器不发现技能、AGENTS、扩展、Shell或任意文件工具。它负责判重、是否保留、条件/冲突处理，不做工程开发、派活或通信。用户无需审批；删除产生同义禁用，只能由用户明确要求恢复。

查看入口在现有 `AgentFloat` 调度面板侧拉栏。调度和记忆分别使用独立 ChatSurface 适配器与 workspace/purpose 草稿/状态/滚动桶；记忆清空带 generation 隔离。查看历史、切换角色不发模型请求，面板关闭也不停止已受理的后台候选。实际模型由记忆专用配置→工作区调度模型→全局默认选择，并显示在记忆视图。

## 调度读路径

`orchestrator/memoryInjection.ts` 在 `composeReadPathTurnText` 中构造回合前缀，不改 UI 中的用户原文：

1. 桶首次建立、clear 后首轮或 compact 后置 `memoryInjectionDue`；读取 `MemoryService.injectKnowledge(root,'scheduler')`。
2. 常驻核心1200字符与全局偏好800字符按生效状态/条件装箱，内容哈希 versionToken 不变时不重复注入。
3. due 时立即现采现写机械态势，再加入 `【态势快照】`；态势预算4000字符，独立于知识预算。
4. 用户回合按当前任务召回历史参考（1600字符总预算），加入独立 standing intents 消息扫描；host 自治回合不做这段额外查询。

相位翻转、合入受阻和 PR 合并的 standing intent 事件面经统一事件日志的工作区系统订阅消费，仍由记忆库执行谓词扫描与通知；消息关键词扫描保持用户回合内同步处理。事件处理在声明后中断时不盲目重试，需核对通知记录并由调度处理不确定状态。

召回有仓库、分支、namespace、期限与当前 revision 检查，异步向量响应之后和最终格式化前重检删除/失效，不能恢复旧知识。自动召回整体最多1500毫秒，空结果正常，失败不挡调度回合。核心注入失败记录诊断并继续原回合，不回落旧 MEMORY.md 写入/注入路径。

## SITUATION.md

机械态势包含各工作区需要你会话名单、排队 delegate 数、调度普通未读来信数、事件队列深度；缺少某数据源时省略该段。`scheduler unread mail` 只统计该工作区账本中寄给 `orchestrator:<workspaceId>`（兼容 `scheduler`）的普通未读信，排除寄出信、其他收件人和新旧宿主事件，与调度 `readMessages` 的收件口径一致；不是整个工作区持久队列的未读总数。

`OrchestratorEventPump` 的调度状态、队列和 flush 信号，经 `noteSchedulerSituationChanged` 在进程内按每区30秒 trailing 节流写入。邮箱成功追加或已读回执落盘后，通过独立 `onAgentMessagesChanged` 信号刷新所有工作区的快照（每份都含全局概况）；回执不会冒充新信、唤醒模型或触发收信动画。重复回执/幂等寄信不发变化信号，解绑取消监听和待刷新定时器。写失败不阻断事件处理。

冷启动注入前强制采一次，避免拿到上次节流的陈旧文件。模型没有写该文件的工具，清空调度聊天不删机械态势或知识库。态势标明生成时间及 point-in-time snapshot：已注入上下文的数字是当时采样，文件后台刷新不会改写过去上下文；`readMessages.unread` 是本次打开正文并写回执后的剩余未读数，实时收信应以后者为准。记忆内容仍按下次回合的内容哈希变化刷新。

## 历史与边界

旧调度聊天 jsonl 仍保留；记忆中心的显式原始会话查询按 120 条范围页从尾部过滤，返回时间正序的最后 50 个匹配项，存在更早匹配项时标记截断；调度与 GUI 都不为查询读取整份历史，不重新抽取或批量回灌。`orchestrator.listSessions/openSession` 仍按既有定时桶目录门控，AgentFloat 不新增历史会话抽屉。新知识任务事实采用 ledger-only，已有历史投影迁移仅提供显式维护 API，此次没有对真实库运行迁移，也未物理合并多个库。

旧 MEMORY.md、整文件工具、6000字符策展预算及 `memory/flush.ts` 等历史辅助代码可能仍在兼容/测试文件中；正式读写链使用上述类型化知识与专用候选运行时。旧抽取/巩固模型不再从正常调度回合、压缩或释放路径调用，独立的提醒与 embedding 能力继续保留。

关键文件：`agent/orchestrator/{memoryInjection,buckets,compaction,sessions}.ts`、`orchestrator/situationWriter.ts`、`metaAgent/schedulerMemoryStore.ts`、`memory/{curatorBindings,knowledgeTools,service}.ts`、`memory/curator/`。对应逻辑/组件与真实 Pi SDK 夹具的结果由本轮统一验证记录；不能把本机代码测试写成真实任务长期收益、生产上线或三平台真机通过。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D01.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：调度跨会话记忆=调度私有知识（memory.note/remember 提交+后台记忆会话整理入 `controlRoot/.muster/knowledge/scheduler/`）+全局用户偏好+机械态势 SITUATION.md（宿主生成，模型只读）；新调度上下文首轮注入核心知识/偏好/态势快照，用户回合按当前任务召回历史参考。
- 为什么这样设计：按需低频提交取代自动抽取（完成/压缩/关闭都不跑抽取，返回入队不等于保存）；专用记忆 Pi 会话只给 candidates/search/evidence/commit/defer 五工具（判重/取舍/冲突处理，不做开发派活通信），无需审批但删除只能由用户明确要求恢复；预算分级（核心 1200/偏好 800/任务召回 1600/态势 4000 字符）+versionToken 内容哈希不重注入+召回整体 1500ms 超时不挡调度回合；召回前重检删除/失效不恢复旧知识；SITUATION.md 按 controlRoot 固定定位（切默认源码根不切库）+30s trailing 节流+冷启动注入前强制现采（point-in-time 快照语义，注入后后台刷新不改写过去上下文，实时未读以 readMessages 为准）。
- 明确不做：不自动运行记忆抽取；模型没有写 SITUATION.md 的工具；清空调度聊天不删机械态势或知识库；旧 MEMORY.md 双文件策展系统退休（memory.write/append 不能再用），历史 jsonl 只读不回灌；未对真实库运行迁移、未物理合并多库。
- 歧义点：「不自动抽取」是长期取向（记忆只由调度显式 memory.note+用户明示 remember 产生）还是未来会加自动候选采集？A=长期取向（自动抽取改变噪声/信任模型，也违背「宿主依据用户原话审查」边界；review 把任何隐式抽取路径当缺陷）／B=未来加自动候选（review 关注触发点/预算/去重设计）。推荐 A。
