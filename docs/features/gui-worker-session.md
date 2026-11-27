# GUI Worker 会话（chat surface：Pi / Cursor / Claude / Codex / ACP 聊天气泡 Worker）

## 职责

已有 GUI 会话可以作为本地假模型的素材，在工作台里重复播放文本增量和工具卡。[用真实会话回放聊天](session-replay.md)

流式正文与工具卡以独立事件先进入会话日志，再发布到窗口和订阅者；追加失败不发布对应事件。正文事件只携带增量，工具事件按 tool ID 更新单卡，回合元数据节流不再复制整条 assistant。结构变化显式保存变更消息后再同步尾部；新计划卡需同时记录旧 pending 卡的失效状态，确保事件恢复与 live 一致。写后队列仍有短暂未刷盘窗口，退出/关闭等待 flush，不承诺每个 token fsync。

GUI 清空会话并开始新对话时，宿主 ID 不变，但会清理旧对话的[待办提醒](session-reminders.md)并通知界面刷新；待办清理失败沿用清空未完成的阻断和重试行为。清空保留执行 entry，删除旧历史与 writer 后，在引擎句柄重置成功、解除清空保护前，为该 entry 重新 retain 已知为空的投影。随后范围读取和元数据时间线返回真实空状态，旧注入详情不可访问；下一次发送使用新 writer，不恢复旧元数据。

看板卡片从 `SessionMeta.boardReplyPreview` 读取有界摘要。`host/base.ts` 在真实消息持久化时更新；冷浏览读到最新消息页或执行物化时，也用已经加载的消息刷新旧摘要。看板正文按卡片宽度换行，最多显示两行。

完整历史恢复由 `GuiSessionStore.loadSnapshot` 承担，限于执行物化、显式全文读取与审计等调用。普通 `open` 不再保留完整投影；`materializeForExecution` 保留恢复消毒、计划卡重水合和 pending-fork 保护，关闭时 flush 后驱逐。正常冷历史页直接读消息范围索引；索引缺失/失效时仍按存储规则受控重建。

Core 的每次模型调用在 `harness.calls` 中保留 SDK 的 `stopReason`。最后一次调用以 `length` 结束时，回合收口后在气泡提示已达输出上限；早先工具步骤的正文仍保留。旧记录缺少停止原因时，仅在已结束、末段为推理且最后一次调用的输出 token 全为推理时说明未生成答复正文。

### 冷浏览与执行物化

浏览会话与执行会话分开管理：`openedSessionIds` 只表示聊天表面已打开；`entries` 只保存已物化的执行状态。`open` 只登记浏览生命周期和 idle 信号，不调用 `store.retain`、`loadSnapshot` 或 `loadPendingFork`，不创建空消息数组冒充完整历史。浏览正文继续走 `getHistoryRange`；消息总数、模式、用量和最后回复从持久元数据或范围页读取。正常索引路径只读取所需页；索引缺失或失效仍按存储恢复规则重建，不声称所有损坏恢复均为常数开销。 冷范围页使用保位置消毒：剥离过期权限、排队和重试状态并终态化工具，但不删零内容 assistant 壳，保留其 ID 与持久 ordinal；否则页中删行会让后续消息错入前一个绝对槽位。完整执行恢复仍可删除空壳，其新投影以执行同步重新发布。

GUI 全文历史 IPC/preload `agentSession:getHistory` 已删除；主进程 `Host.getHistory` 仅保留显式交接导出等完整读取边界。renderer 的首次挂载、隐藏后重显、丢事件恢复和失败重读统一调用 `agentSession.historyRange`，每次最多 120 条；保留阅读窗口时用 anchor 消息 ID 定位，而非强制跳回尾页。完整缓存 token、forceFull 与 range 失败转 `getHistory` 的兼容路径已删除；失败保留已读内容并显示错误，不自动循环重试。迟到页可按独立 clock 更新未变的元数据，但若较新的 sync 已替换消息域，不再登记旧 ID 或旧 cursor 到 page-map，避免把已删除消息复活。可见页仍按 ID 复用相同消息引用。

`materializeForExecution` 在真实发送、重试、召回、计划执行、修改历史消息前恢复完整执行 entry，沿用恢复消毒、计划控制器和 pending-fork 投递保护。当前恢复接口同步执行；物化前后核验浏览所有权和 shutdown 状态，失败不发布半成品 entry，writer 的释放登记到宿主退役屏障；释放尚未完成时同步再次物化明确拒绝，释放失败保留诊断阻断。关闭与退出等待同一清理 Promise，不重复释放，也不在清理未完成时报告成功。引擎自身恢复模型上下文，以及物化后的业务消息数组，仍可能处理完整历史；此阶段先保证单纯打开、切换和查看不会承担该成本，不用 lazy Array 隐藏全量读取。

前台 `agentSession:send` 在附件准备完成后再次读取当前会话，并在物化执行 entry 前调用一次 `Host.open`。因此可见但尚未建立执行投影的冷会话可以直接发送，发送入口负责补齐浏览生命周期。后台宿主发送仍沿用显式打开约束；归档、关闭和归档清理中的会话不会被前台发送重新打开。

模式、模型和思考档控制在只有浏览记录时只更新会话配置，已存在执行 entry 则沿原逻辑生效。旧审批、旧问题及迟到事件不得为了应答而物化或复活权限；无活动应答通道继续返回失败。`abort` 对纯浏览会话无事可停；`refresh` 是显式用户状态变更，纯浏览会话执行该操作时可以物化完整 entry 后重置用量；它不属于仅查看历史的有界保证。关闭、归档和退出同时处理浏览记录与执行 entry。归档 `release` 同时启动后台任务与 NodeREPL 清理，回收现有/迟到连接、刷新释放 writer 后等待全部退役；一个 owner 失败仍继续清理其他 owner，并聚合错误，失败屏障阻止再次物化绕过未确认的资源。冷视图的失败恢复与归档共享已有 writer 释放，不重复竞争；归档结束摘除并关闭执行 entry，持久历史和 SessionMeta 保留；归档后发送拒绝，重新打开后才恢复新 entry 与 writer 所有权。并发 close/closeAll 共享归档操作，资源结束前不报告 worktree 可删除。已关闭会话不能被迟到物化复活。冷观察与最近回复逐页查找，显式审计/retention 的完整读取边界单列。

本段实现的定向回归正在验证；引擎原生恢复、完整执行投影与显式审计的全量边界仍保留。

原生保活聊天重新显示时仍退订后重挂、请求最新 history；可附带已应用完整历史的 `messagesVersion`。`host/messagesVersion.ts` 以每个 live entry 的 UUID 与 revision 标识消息，中央 push（含无窗口）和 persist 写入前、clear 起始推进版本。匹配且安全的 entry 返回 `messagesUnchanged:true`，完全省去大消息载荷，其余元数据每次重新读取。旧无 token 调用、磁盘恢复、light、closed、clearing、共享文件采集 collecting 过渡态均全量；Web 客户端保守不带 token。renderer 仅真正完整应用后认证版本，消息时钟变化不可复用，resync/clear 强全量，旧 epoch/clear 响应不能认证；非法条件响应至多一次全量兜底，沿用独立领域时钟，不跳过模式/用量/注入等刷新。回归见 `agent-session-conditional-history.spec.tsx`、宿主生命周期与真实 Pi/preload E2E。

中栏 **GUI Worker** 以统一聊天界面展示内置 MetaAgent Core、Cursor、Claude、Codex、ACP、外部 Pi/Oh My Pi、Muse、ZCode 以及 ACP 下的原生 MiMo Code。各入口按各自协议连接；图片、审批、宿主工具和恢复能力不同，详见 [GUI Harness 目录与接入](gui-harness-integration.md)。内置引擎保留旧 `runtime=pi` 身份并迁入受管子进程；外部 Pi 使用独立身份。独立终端仍是 PTY，GUI 对应的 CLI 入口全新安装时默认关闭，可在设置中开启；旧注册状态保留。历史上移除的 DSH 独立 runtime 不自动恢复，新 DeepSeek 入口走 ACP。

GUI 原生文件工具的轮次采集由各 Driver 与 Host 对接：可等待钩子、事件观察和引擎报告分别标识；Codex 子代理只将当前回合文件事件并入父回合审阅。覆盖和回退条件见 [轮次文件改动](turn-checkpoint.md)。

宿主可识别的会话分叉、历史读取、投递错误及有界进程/协议请求的超时或取消，在对话错误卡、历史错误、模型目录、即时提示及画布分叉失败提示中按当前语言展示；仅转换已识别的宿主错误和嵌套提示，未知上游细节、原始会话状态及历史不因界面语言切换而改写。模型目录 IPC 在有界请求自身的超时或取消处使用带来源的错误区分上游同文错误，并在回传时按当前语言组装提示；有界请求对其他调用方保留原始错误消息。静态守卫核对有界请求的固定步骤标签和英文资源；动态协议方法仍保留原文。模式花名册在会话尚未挂载时仍按当前语言生成默认名称。

Muse 的 MSP 回合按 `commandId` 和原生 `turnId` 关联，不能仅凭 `sessionId` 把事件或审批归入当前回合。`turn/start` 提交后、回合身份确认前的帧，以及消息项建立前的增量，共用最多 256 条、8 MiB 的有界缓冲；确认后只处理属于该回合的 item 与交互请求，超限、身份缺失或回合结束时仍无法关联的增量明确报错。正文最终快照与已展示增量不一致时回合失败，避免把不完整内容标为成功。每回合使用独立外部进程；回收失败时保留 owner 供连接关闭重试，并发关闭共用同一操作。MCP 关闭失败会继续阻挡资源释放，不将其视为已清理。此行为仅经过静态审查，协议版本兼容和真实运行仍待用户验收。

内置 Pi 的用户停止先请求 SDK 中止，并隔离当前连接；无论 SDK 是否确认，都会回收受管进程树。Pi 与 Codex 共用 `process/owner.ts` 管理工作进程归属和回收，Pi 的会话租约、IPC 和回合 watchdog 仍由自己的适配层管理。只有确认进程与子进程组退出后才关闭事件流，让宿主按用户中止收口；不会合成 `turn-complete`。SDK 中止失败但强制回收成功时保留停止错误并说明已回收；回收无法确认时抛出错误、保留租约和事件流，后续写入不能复用旧连接。Windows 工作进程已取得 PID、但在 Job 分配确认前退出时，其后代归属无法确认，当前会保守阻止重连并提示检查残留进程、重启工作台。图片分块或本地准备阶段被中止时，若尚未发出发送请求则报告消息未提交；开始发送后、收到请求成功回执前出错则报告投递状态未知，不能据此自动重投。这个分类也应用于先于发送 Promise 出现的进程、IPC 和 SDK 错误；SDK 事件保留已有轨迹与计量。回合完成仍以事件流为准。Windows 使用 Job 回收，macOS/Linux 使用进程组；真实停止和跨平台进程回收仍待用户验收。

Windows 启动内置 Pi 时，守护程序打开目标进程后、分配 Job 前，通过工作台与 worker 的私有 IPC 执行一次随机身份挑战；worker 仅在创建 SDK 会话前回应。挑战失败、断线或超时会阻止引擎初始化，并保守处理未确认的进程资源；macOS/Linux 不使用该挑战。

架构原则（学自 Cherry、精简实现）：**Host 不知道具体引擎；渲染层主干不按 runtime id 分支**——例外是模式表/preset 菜单/模型目录三处既有分支（新 runtime 若带同类菜单需在渲染层加一处分支；纯对话 runtime 仍是零渲染改动）。内置 GUI runtime 通过共享描述符与主进程 Driver 包接入；新增引擎须在源码中实现并发布。


### 注入与压缩记录的范围读取

透明历史完整保留在会话检查点与事件日志中。普通消息事实只携带变更消息与 `lastUsage`，不再克隆整段 injections/compactions；注入变化单独追加 `gui-session.injection`，压缩完成及 token 补写以单记录 ordinal upsert 为 `gui-session.compaction`。主进程执行 entry 仍拥有完整模型上下文，但普通消息不会重访旧注入正文；内存摘要索引只在恢复或元数据变化时建立/更新。

`guiMetadataRangeIndex.ts` 把 `checkpoint.timeline` 作为可丢弃派生索引：小型来源戳、按时间排序的定宽记录、摘要 blob 和正文 byte span/hash。消息 `.ranges` envelope 只保留格式版本与最后用量，不再塞全部元数据数组。冷页按消息时间 seek 生效注入代际（含页边界基线）与压缩窗口，摘要没有段落全文、引擎提示词全文或工具描述；超密压缩窗口最多返回 120 条并显式报告 overflow，独立 timeline 仍可逐页查询每条事实，不截断持久历史。首次快照晚于首条 user timestamp 时沿用原注入卡的首代回落语义。同时间的多代际按原 ordinal 稳定排序。

`agentSession.injectionDetails(sessionId, {key})` 按会话 owner 和 canonical SHA256 单条读取全文；`metadataTimeline(sessionId, kind, before?, limit?)` 独立分页列举全部注入/压缩记录，每页最多 120 条。两条 IPC 通过既有 GUI 域的 `handle`、CapabilityRegistry、PermissionGate 和 scope 退出屏障注册，不另建旁路。正常索引中的合法 missing key 直接返回记录不存在，不能触发全量恢复；缺失、损坏或来源戳失效的索引才诊断并恢复一次。流式 fork 直接发布空 timeline，不为创建索引重读新分叉的完整正文。

历史范围只返回当前页需要的摘要和计数；live 注入推送单条摘要及权威计数。renderer 随 page-map 保留/淘汰摘要与压缩标记，不累计已读页的透明正文。旧消息的行内注入卡沿用 `AnimatedDetails`，展开才加载全文，关闭后释放正文；错误可重试，切换记录、关闭或卸载后的迟到响应不得写回。完整 `Host.getHistory` 仍服务显式交接导出，它不属于普通浏览的有界保证。

### GUI 分叉的有界准备

`host/sessionOps.ts` 的业务 fork 对只有浏览记录的源直接读取最多 120 条的范围页，不建立执行 entry。源会话锁阻止并发物化/第二次分叉；热源同时设置 `forking`。逐页、异步 flush 和注册前核验源消息版本、会话配置和浏览所有权，变化即失败，不发布过期副本。新会话注册由 `createTerminal.prepareGuiSession` 的异步准备完成后进行。

`runtimeKernel/guiForkPrefix.ts` 将截止点（含该消息）的独立日志、检查点和范围索引流式发布；正文每次只复制一条，去掉 queued、审批、计划、问题、重试建议和文件回退权限，附件按新 owner 重映射。索引构建每批最多 4096 个 ID，外部归并同时最多 32 个读取器，不借助全 JSON 或完整 ID 数组。新目标先用独占 preparing 标记占位，拒绝覆盖已有目标；失败只清理自己取得的目标，启动清扫覆盖遗留上下文和排序暂存。

`forkContextSpool.ts` 保存不可变 NDJSON seed/transcript 正文，pending 标记 v2 仅含 owner、数量和 SHA256 描述符（读取上限 64KB）。发送 transcript 时逐条验证完整正文，仅保留原有 80000 字符协议窗口；Pi 逐条写 SDK 原生格式并验证归档，单记录 scratch 不累计种子。恢复标识落入 delivered 标记后才移除 seed 正文，重启可补回会话表尚未写入的 token。原生截点采用 `nativeForkPoints.ts` 按消息读取小文件，不能依靠全量 Map。

有匹配的可靠原生截点且源无受管附件时，建立真实引擎连接仍会显式物化模型上下文；实际 SDK 恢复自身上下文的全文成本保留。无原生截点的 seed/transcript 分支保持冷源分页；已有热 entry 本身仍持有模型执行历史。旧版含数组的 pending 标记不猜测迁移，损坏或不支持格式按未知状态阻断执行。

### 内置 Driver 的当前边界

- 内置 Pi 运行在受管子进程；各 GUI 协议由对应内置 Driver 适配，宿主工具调用走统一网关。
- 所有 GUI Agent 的续接均复用普通 send，`waitFor` 不要求唤醒能力声明。Driver 只声明可选的忙时插话/快照抢占：内置 Pi 支持可信宿主事件原生隐藏插话，Codex GUI 使用快照后中断及同会话发送；没有抢占能力就等空闲。Host 按当前已发送输入关联的启动、正文/思考/工具活动或成功终态确认续接，排除准备期、旧连接、错误和取消；Pi 插话以隐藏消息进入原生上下文的回执确认。详见 [会话续接与抢占投递](resume-wait.md)。
- GUI 用户插话被接入接受后建立新桌面回合，沿用当前引擎回合的工作区快照；插话期间会话转移不能让旧引擎借新工作区签发续接来源。
- GUI Driver 由主进程静态注册；内置 CLI 与 ACP 入口由产品目录和种子维护。接入与预检路径见[内置 Runtime 与 Harness 接入](agent-runtime-registration.md)。

2026-09-05 的回归覆盖审批与提问卡锚定、回合收口、并发回收、发送失败恢复草稿、思考档和飞书 GUI 阻塞提醒。

2026-08-26 聊天体验 v2：消息模型改 **parts 交错数组**（思考/工具/文本按到达顺序流式）、工具卡可视化（git-diff / 文件超链接）、任意消息 **fork 新会话**、列宽上限 + 去噪观感（助手无气泡、悬浮操作条）、Composer 加号附件面板、Pi 图片附件。

Codex GUI 使用 `gui-full` 宿主工具集。ACP 使用 `acp-subset`，与其他 GUI 一样提供记忆工具，交互部件仍由 preset 区分。工具注册器与 Codex stdio MCP 的默认 preset 均保持这一边界，平台共用。已有连接需要重建后才获得修正后的工具目录。回归见 `test/codex-gui-toolset.mjs`。

## 关键文件与入口

GUI Worker 空会话的操作提示由 `AgentChatView` 提供，`agent-chat.css` 将含 `.chat-welcome` 的阅读列撑满输入条上方的可用空间。提示整体水平、垂直居中，最大宽度 560px，内部采用左侧 72px 图标（相对文字块垂直居中）、右侧左对齐文字；主提示与较小的操作说明分层排列。产生消息后恢复正常消息列布局。

GUI Worker 政策层以完成当前具体任务为职责，支持代码、调查、数据与内容处理；回复优先使用用户指定的语言，否则跟随用户最近的自然语言表述，忽略宿主说明、引文、代码和工具输出所用的语言，外部集成与技能以实际可用范围为准。创建其他会话、派活、自动任务管理归调度，跨会话协作遵守本会话工具授权。问卷只教规范字段 `question` / `multiSelect`（适配器继续接受旧别名）；宿主工具不可用、Pi 原生上下文已注入等条件分支保持独立。

调度工具 `sessions.interrupt` 对 GUI 调用 abort、对 CLI 发送 Ctrl+C；`sessions.restartConversation` 仅支持 CLI 清除外部会话标识后重新启动，GUI 返回明确不支持，不会暗中中止。原先混合两种语义的 `chat.refresh` 工具已删除。

```
src/shared/
  types.ts                      AgentRuntimeEntry.surface（'pty'|'chat'，缺省 pty）、ChatMessage.parts（ChatDisplayPart 交错片段）、ToolCallRecord.input/patch
  agentRuntimeCapabilities.ts   chat runtime 能力描述符（transport/images/forkSeed/bgtasks/modeSwitchReconnects，satisfies Record 锁死；process 引用须 typeof 守卫——renderer-safe-shared 测试锁）
  guiWorkerPrompt.ts            GUI Worker 首条输入说明物化器（纯函数；全局行为规约见 agent-rules.md）
  workerStatusGuard.ts          P5/P11 纯决策：早 needs_you warning、脏树回注文案、兜底提交标注
  guiWorkerPolicy.ts            权限决策表（三档 × permissionClass + 用户工具规则层，纯函数）
  guiWorker.ts                  消息视图（GuiChatMessage.parts + migrateGuiChatMessage v1→v2）/ 推送事件（delta 带 partIndex）/ IPC 载荷类型
  guiContextUsage.ts            会话 lastUsage 可否落盘 / fork 占位判定 / 陈旧快照（test/gui-context-usage.mjs）
  composerTools.ts              Composer 本地工具纯函数：手动确认发送清单（原 tosend 清单，/tosend 命令已删）、/quickInput 短语 CRUD/过滤/序列化（test/composer-tools.mjs）
  composerSkills.ts             斜杠菜单 skill 收录 + /skill:name 展开（与 Pi 同形态；test/composer-skills.mjs）
  mermaidFence.ts               ```mermaid 围栏 class 检测（MarkdownBody 分流渲染）
  chatTurnRail.ts               会话历史面板停靠点模型（buildTurnRailStops 纯函数：人工用户消息→条目+该轮最后一段 AI 正文）
  noteAnnotations.ts            会话批注纯函数：批注N token、发送展开（关于“原文”：批注）、位置查找、摘除
  linkifyWorkspacePaths.ts      Markdown 路径链接化（muster-file: 协议；识别复用 terminalSelectionText 实体检测，规则见 docs/features/text-entity-recognition.md）

src/main/agentSession/
  host.ts                       AgentSessionHost 入口垫片（re-export，import 路径不变）；每会话 turn/queue(≤8)/审批 registry/持久化/fork；board activity 映射；turnStartedAt + injectHostNudge（P5/P11）——实现拆分在 host/ 下
  host/
    internal.ts                 会话状态合同：SessionEntry/HostCore + migrateMode 纯函数（旧 permissionMode 迁移）
    base.ts                     横切底层：push/log/syncEntry/syncPart/persistEntry/applySignal/注入队列胶囊/流式落盘节流
    lifecycle.ts                生命周期：open（历史恢复+计划卡重水合）/close/closeAll/flushPersist/purgeEngine/sweepEngineOrphans
    sessionOps.ts               会话操作：release/clear/forkSession（forkTranscriptFromSeeds 纯函数）/队列撤回·改写·重排（reorderQueueItems 纯函数）
    messaging.ts                消息入口：send（忙时 steer/排队）/injectHostNudge/retry/abort/refresh/compactSession/maybeAutoCompact
    turn.ts                     回合编排：startTurn/splitSteeredTurn/finishTurn/handleTurnFailure 网络续作（resumeFailedTurn）
    connection.ts               连接建立：resolveConnectionModel 纯函数（生效模型判键）+ ensureConnection（工具集物化/记忆注入/事件泵挂载；B2 起 MCP 桥已退役）
    events.ts                   事件泵：consumeEvents/handleEvent/delta·工具事件/插话与压缩事件/stampCompactionTokens
    approvals.ts                工具执行人机门：respondApproval/getPolicyState/requestSubagentApproval 冒泡/respondUserQuestion
    settings.ts                 会话设置：setMode/setThinkingLevel/listPiModes/setPiMode/setSessionModel/planAction/getHistory
    usage.ts                    用量：pushContext/rememberUsage/historyUsage/多模态守卫 rejectImagesForSessionModel
    injection.ts                Harness 透明注入：recordInjectionSnapshot/handleInjectionUpdate/currentTurnUserTs
    plan.ts                     计划流：attachPlanCard/capturePlanSubmission/updatePlanAfterTurn
    agentSessionHost.ts         AgentSessionHost 组装壳（公开方法逐一委托上述模块；test/gui-host-lifecycle.mjs 锁行为）
  workerTreeGuard.ts            needs_you / requestIntegrate 脏树校验与回注（不碰事件管道）
  types.ts                      Driver/Connection/事件合同（send 带 images；tool-result 带 patch；connect 带 seedSource（私有流式上下文描述符）；supportsImages/supportsSeed 能力位）
  prompt.ts                     物化首条宿主说明（shared 模板 + 当前会话已注册工具和目录快照）
  persist.ts                    GUI 事件写入和可重建 JSON 检查点；热写只接收变更消息，关闭/冷维护才写完整检查点
  guiWorkerAdapter.ts           GuiWorkerAdapter/GuiWorkerAdapterRegistry 合同；校验 runtime 唯一性并把底层 driver 安装到 Host
  registerDrivers.ts            通过适配器 registry 注册 Pi/Claude/Codex-gui/ACP、Muse、ZCode 与外部 Pi/OMP driver（Cursor 使用 ACP）（勿写成无引用副作用模块）
  tools/
    registry.ts                 会话工具集（hostTools spec 投影 + MCP 代理 → 引擎注册 + 系统提示目录）
    policy.ts                   决策包装（用户工具规则 + shared 三档表 + 路径区内外判定，含 realpath symlink 逃逸）
    catalogHostTools.ts         状态四件套等 catalog 背书宿主工具：schema/描述取自 catalog（ID 来自 spec），执行走进程内 executeTool
  drivers/
    eventQueue.ts               回调事件 → AsyncIterable
    pi/driver.ts                Pi driver：隔离 home/sessions、模型注入、resume token 解析、fork 种子逐条写原生归档（单记录 SDK scratch）、edit details.patch 透传、prompt images、askQuestion 问卷
    pi/approvalExtension.ts     pi.on('tool_call') 审批扩展（fire-time 热读档位）
    pi/customTools.ts           Host 工具 → Pi 自定义 ToolDefinition（点号→下划线）+ askQuestion 问卷
    claude/driver.ts            Claude SDK 回合、原生 permissionMode 与 canUseTool
    codex/driver.ts             Codex app-server 原生线程、设置与审批
    win32/hide-console.cjs      Windows 预加载：无控制台时 AllocConsole+SW_HIDE（通用桥接件）
    win32/harnessEnv.ts         hide-console 预加载的 NODE_OPTIONS 拼装 + 双路径定位；asar 解包路径复用 main/asarPaths.ts

src/renderer/src/agentChat/
  AgentChatView.tsx             会话壳级 UI：批注编排、空态欢迎语；中栏使用 compactHeader 隐藏引擎顶栏，Pi Harness 通过 onPaneControl 放入顶部悬浮三点菜单（见 center-split.md）。其他调用默认保留引擎名/Harness 顶栏。协议适配在 agentSessionSurface，映射在 guiMessageView；文件链接路由在 chatSurface/onFileLink；消息列表/输入条/状态条委托 ChatSurfaceView，见 chat-surface.md；专注模式见 focus-mode.md。
    noteAnchors.ts                批注锚点 DOM 操作（wrap/unwrap/转正；待定锚点 id=__note_pending__）
  noteBridge.ts                 划词「批注」→ 会话路由（按 data-session-id 注册 handler，渲染层内存态）
  BgTasksArea.tsx / BgTasksPanel.tsx / useBgTasks.ts / bgTaskStateText.ts  后台任务区/面板与状态钩子：子代理详情复用 ChatTranscript（无输入条）。面板 portal 进 .chat-input-shell 渲染（工具栏 container-type 是包含块，原地锚不到壳）、与输入壳同宽对齐（radius-modal，与排队面板同族）；完成态任务可删除（列表行 🗑 / 头部「清除已完成」，`bgTasks:remove`/`clearFinished`，running 拒绝）；胶囊有任务记录即常驻（运行蓝/未读绿），清空后消失
src/renderer/src/components/
  ChatMessageView.tsx           消息视图：parts 交错渲染（连续工具合并栈 + 每段思考卡）+ 悬浮操作条（复制/fork，quiet 观感）
  ToolVisuals.tsx               工具卡可视化：classifyTool（动词+路径/命令）、buildReplaceDiffText（old/new→unified）、MiniDiffView（react-diff-view 无 tokenize）
  AgentComposer.tsx             Composer 编排壳（实现体在同目录 agentComposer/：左侧加号附件面板（图片/@文件/命令；plusMenu）+ 图片多模态）
  MarkdownBody.tsx              非 http(s) 链接一律走 onFileLink；```mermaid 围栏渲成图（懒加载 pele）；CJK 强调兼容见 markdown-cjk-emphasis.md
  MermaidBlock.tsx              mermaid 语法 SVG（pele 引擎：懒加载、同步 render、CSS 变量主题零重渲、流式失败回退源码）；点击弹出可缩放查看器
src/renderer/src/styles/agent-chat.css  会话壳 + 列宽上限（760px 居中）+ quiet/悬浮条样式
src/renderer/src/styles/chat.css        工具卡可视化（.tool-diff 红绿变量）+ 加号面板样式
```

接缝（改这里别改主干）：

| 点 | 行为 |
|---|---|
| `src/main/sessions.ts` `launchTerminal` | chat surface → `chatBridge.open(s)`，不 allocate/spawn/写 inject |
| `src/main/sessions/createTerminal.ts` `createAgentTerminalSession`（`sessions.ts` 委托） | chat 忽略 initialPrompt/injectHostIntro（空会话只物化系统提示） |
| `src/main/sessions.ts` `select` | chat 会话选中即幂等 `chatBridge.open`（重启后恢复入口；2026-08-26 修复） |
| `sessions.close` / `sessions.restartConversation` | chat → `close(purgeHistory)` 仅左栏删会话时清落盘（应用侧 json + 引擎侧数据，见「落盘生命周期」）；退出/切走只释放 driver；`refresh` 只中止当前回合 |
| `src/main/tasks/delegate.ts` | chat：建会话后 `agentSessions.send(派活契约 + 任务正文)`，mode `gui-prompt`，跳过 waitTerminalReady |
| `messages/assignment.ts` / `messages/wake.ts` | 旧版 GUI 首信和后续邮件的兼容投递 |
| `runtime/host.ts` | chat runtime 误走 allocate/resolveLaunch/scriptPath 明确抛错；migrateBuiltinHints 合并新 builtin 种子（老用户升级即见 Pi；旧 dsh 条目合并时清除） |
| `agent/systemPrompt.ts` | 调度知道 surface=chat 的 runtime 也可 sessions.create（task 仍极简） |
| 设置 WorkerPane | chat runtime 不展示脚本/extraArgs 编辑 |
| `src/main/index.ts` setWindowOpenHandler | 只 openExternal http(s)；其余 deny（路径链接不再误开浏览器） |

## 工作区目录范围

Pi 首次发送的连接冷启动会加载技能资源。GUI driver、调度 provider 与技能菜单共用 `createSkillSourceLoader`，只发现全局和当前项目各根的 `.agents/skills`（worktree 映射替代原检出）；SDK 默认、祖先、包与模式附加技能源均关闭，入口内链接仍可指向外部原文件。管理策略扫描在 SDK reload 前分段准备，不调用设置页完整清单；全局来源只扫描一次，策略判断的物理目录解析在单次调用内复用。原生 reload 也重新准备，配置变化时拒绝过期策略，同名选择与启停策略保留。详见 [能力管理](capability-management.md)。

消息受理前，`host/messaging.ts` 同步验证当前会话的目录与全组 worktree 身份，并检查任务合入/清理操作锁。目录失效、任意组已部分清理或任务正在操作时返回 `{ok:false,error}`，不增加历史、不排队/steer、不更新使用时间、不连接模型；实际派发仍由 `startTurn` 再校验。有效消息继续入历史后快速回执，连接冷启动在后台进行。

`test/gui-host-lifecycle.mjs` 验证目录撤走及空闲/忙时清理锁下的拒绝和无副作用。独立 Electron `test/e2e/task-worktree-gui-lifecycle.spec.ts` 使用真实 Pi SDK、本地流式模型夹具与两组同名嵌套仓：实际写入两个任务组，回合中归档真实调用 SDK `dispose` 并关闭模型流，释放时四个任务目录仍存在；干净组先清，脏组及父容器保留，拒绝不完整任务的新消息且历史/请求数不变。处理本次脏文件后重复归档清净全部树、注册与分支，源 HEAD、业务文件及初始化后的索引/状态保持不变。记录器从独立夹具入口加载，保留原 SDK 实现；不以模型服务或 app 的最终强制关闭替代释放断言。

GUI 每次开始回合同步捕获 `WorkspaceExecutionContext`：工作区 ID/根版本、单一 cwd、固定 controlRoot、全部源根、可读/可写目录的物理身份和隔离映射。`src/main/workspaceExecutionContext.ts` 负责解析，`host/workspaceContext.ts` 在第一次 await 前登记全部引用根的占用；回合收口释放，连接建立中关闭则等迟到连接回收后释放。运行中增加根不扩张本轮范围，下一轮重新捕获；默认根变化不移动已有 cwd。

`host/connection.ts` 同时比较模型与目录快照决定连接复用，变化时经 resume token 重建。管理规则和记忆读取 controlRoot。`src/shared/workspaceExecutionContext.ts` 只物化目录事实与能力说明，协议/规约仍按文件路径按需读取；A3 注册项为 `worker.system.workspace-context`，Harness 中单独记录「工作区目录范围」段。后台子代理继承父回合的同一快照，并独立保留根占用直到连接关闭。

| 引擎 | 额外目录接入 | 当前边界 |
| --- | --- | --- |
| Pi | 原生文件工具和宿主工具的政策回调 | shell、Node、外部 MCP 不形成 OS 文件系统沙箱 |
| Cursor ACP | CLI `--add-dir` 登记额外可写目录 | 宿主网关检查目录；原生工具与 shell 依赖 Cursor 自身行为 |
| Claude | `additionalDirectories` 与 `canUseTool` | 原生预授权和 shell 的实际限制取决于引擎配置 |
| Codex GUI | app-server 进程、线程创建或恢复、每轮提交均使用已校验的工作目录 | 实际可写范围由原生 permission profile 和沙箱决定 |
| ACP | 提示词提供额外根，权限请求/宿主工具使用快照 | 协议接入只登记 cwd；可靠修改其他根应在对应根创建会话 |

普通会话可读写全部在线源根；当前单仓组隔离会话可读源根，但文件策略只允许修改任务树。授予写权限的 SDK 参数不把源检出当作额外可写目录；交接目标的会话专属文档目录例外地传给支持额外目录的原生 SDK/CLI（原生参数可能允许写入该专属目录，宿主文件政策仍只授予读取）。宿主政策检查全部补丁文件和移动目标、最近存在祖先的 native realpath，并拒绝越界/失效/Junction 改指向；用户工具规则不能扩张捕获范围。目录表表示宿主政策范围，不能据此宣称所有引擎具有相同 OS 沙箱。

共用已有任务树、没有 worktree 清理所有权的 fork 也按同工作区会话登记关系捕获隔离范围；只允许写入任务树，不因缺少 worktreePath 而扩大到源检出。未登记的外置 cwd 仍拒绝。执行范围不修改清理所有权元数据。

回归：`test/workspace-execution-context.mjs`、`test/gui-host-lifecycle.mjs`、Claude/Codex replay、`test/cursor-acp-integration.mjs`（受控 ACP 进程与目录参数）、`test/bg-task-source.mjs`。`test/e2e/workspace-execution-context.spec.ts` 经真实 Electron/Pi 文件工具验证第二根写入、区外拒绝、忙时移除阻挡→空闲移除→下一轮撤销授权，以及 worktree 修改实际写盘。GUI 创建等待来源校验与 `host.open` 完成再返回，避免派活紧接发送时出现「GUI 会话未打开」。CLI 目录接入见 [Worker 注入](worker-inject.md)，调度与跨源根多组隔离仍见 实施计划。

## 多渠道远程工作台绑定

已配对的聊天默认操作工作台调度。`/bind` 可以把同一聊天的后续普通消息转给所选工作区已有的 GUI Worker。`WorkbenchMessagingHost` 按渠道、机器人、聊天、话题、发送者和桌面授权代际保留选择，通过 `AgentSessionHost.sendWorkbenchRemoteInput` 核验现有会话、工作区和空闲状态。绑定沿用会话当前的引擎、模型和权限配置。忙碌时远程入口先回执并等待空闲，实际派发前复查绑定和会话状态。

远程输入使用字面正文路径，跳过 GUI 宿主的技能展开、模型引用解析和逐回合记忆召回。`literalText` 随内置 Pi Worker 的发送请求传递，原生 SDK 以 `expandPromptTemplates: false` 提交。此入口不登记桌面操作授权或记忆直写的用户指令证据。远程来源使用稳定的用户消息和助手消息 ID，完成时仅把该助手的结果返回发起方。远程回合活动期间，工作台发送的普通输入保持自己的队列位置，桌面插话不合入远程回合。

绑定后的工作台浏览、手动审批、归档和分叉沿用原有入口。分叉生成自己的会话 ID，聊天绑定继续指向原会话，直到发送者主动换绑。命令、调度和终端回传见 [多渠道消息接入](multi-channel-messaging.md)。

## 数据流 / IPC

- 渲染层 → 主进程（invoke）：`agentSession:send / abort / retry / recallAborted / respondApproval / respondUserQuestion / setMode / planAction / getHistoryRange / clear / cancelQueued / fork`（preload `window.api.agentSession`）。send 带 images：先按 driver `supportsImages` 拦 runtime，再按会话生效模型（`modelOverride` > 全局）做多模态守卫；非多模态拒绝且不清草稿。**失败回合重试**走 `retry`（Host 丢掉失败 assistant、复用原用户消息重跑，不追加用户副本）；渲染层不得再 `send(原文)`。手动重试不登记新的桌面用户指令：桌面已停止时文本仍可重试，桌面操作须等待实际收到新用户消息。**终止回合重新编辑**走 `recallAborted`（调度面走 `chat:recallAborted`）：当末轮为手动停止（`assistant.aborted`）且空闲时，对应用户消息悬停操作条露出「重新编辑」按钮，点击后移除该轮用户消息与半截助手回复，并将原消息文本与随文图片填回底部 Composer 输入框。自由画布 Fork 通过 `sessions:canvasFork` 调用 `forkSession`；交接通过 `sessions:canvasHandover` 保存历史并打开任务窗口（见 [free-canvas-create.md](free-canvas-create.md)、[session-model.md](session-model.md)）。**排队三通道合同（2026-10-25，X4-F04）**：`cancelQueued / editQueued / reorderQueued` 返回 `{ok:boolean, error?}`——宿主未就绪带 error 文案（「GUI 会话宿主未就绪」），渲染层 flashTip 上浮；host 结果为 false（消息已不在队/顺序未变等良性场景）不带 error，渲染层静默靠 busy 推送收敛。合同回归 `test/agent-session-queued-ipc.mjs`，渲染层反馈回归 `test/unit/agent-session-queued-errors.spec.tsx`。
- **默认名会话首条指令自动命名（2026-10-28）**：`agentSession:send` 受理成功（含排队/插话受理）后调 `sessions.autoNameFromInstruction`，把仍是默认名（`SessionMeta.autoNamed: true`）的会话改名为用户原文折叠空白后的前 10 个码点；命名用附件处理改写**之前**的用户原文。只对用户聊天输入生效——邮箱/宿主注入等进程内 `host.send` 调用方不经过此通道，不触发改名。详见 [session-model.md](session-model.md) §3.1。
- 主进程 → 渲染层（push，`agentSession:event`）：`sync`（全量消息）、`delta`（text/thinking 流式增量，带 **partIndex** 定位）、`busy`、`error`、`context`。与调度 `agent:*` 频道完全分开。
- **主进程是唯一 writer**：审批、提问卡与消息状态都由 Host 落定；渲染层只展示 + `respondApproval` / `respondUserQuestion` 应答。
- **parts 消息模型（v2）**：`GuiChatMessage.parts: GuiMessagePart[]`，kind ∈ text/thinking/tool，按事件到达顺序 append（text-delta 尾部非 text part 就新开一段）。v1 扁平历史（text/thinking/tools 字段）在 persist.load 迁移（顺序 thinking→tools→text 保持旧渲染）。纯文本提取用 `guiMessageText()`（计划提取/重试/fork 种子）。**流式 delta**：Host 按 partIndex 推送；渲染层 `applyGuiMessageDelta` 合并——sync 后 assistant 常为 `parts:[]`，首条 delta 须新建片段；超前/kind 漂移的 delta 按「尾部新开一段」落地，绝不静默丢弃（顺序由下次 sync 校正）。
- **审批/提问卡锚定与终态化（2026-09-05）**：卡带 `anchorPartIndex`（请求到达时的 parts 长度），ChatMessageView 按 range 分段渲染、卡插进 parts 流的真实位置（提问/审批夹在两个工具之间时不再沉到消息底部）。终态化覆盖三条路径：回合 error/流中断收口时 finishTurn 结算悬挂审批（拒绝）与提问（aborted）；重启加载经 `sanitizeRestoredMessages` 消毒（剥离 queued 标记与挂起审批、pending 提问翻 aborted、空壳 assistant 丢弃、**Cursor task 摊进主对话的 token 级思考/正文 flicker 拼回一段正文**——执行物化与冷范围读取分别消毒，范围页保留绝对位置）；作答/解除等待后转写自动贴底重新挂上（回合原地继续流内容不再像「卡住」）。
- **工具卡收口兜底**：回合结束时把仍在运行的工具卡终态化为 cancelled；恢复历史时也把遗留 running 卡标为 cancelled。回归 `test/gui-tool-sweep.mjs`。
- **回合中续发**：Host 先按 `getChatCapabilities(runtimeId).steer` 判断当前 GUI 是否声明真实 turn-scoped steer；只有声明支持的用户「立即」才调用 driver 的 `receiveMessage`，并且必须返回 `steered` 才算成功。Harness 自己的 `queued` 不满足用户插话合同，普通后续消息统一进入工作台队列；宿主邮箱仍可按自己的 RuntimeMessage 合同使用原生队列。内置 Pi GUI 的用户插话经 Pi SDK `steer()` 进入当前回合；`idleOnly` 等待空闲后重新确认。外部 Pi、其他引擎按各自能力处理。聊天输入框普通发送传 `steerOnBusy: false`，忙时一律排队；显式「立即」在确认不支持原生插话时返回 `steerUnsupported`，消息尚未入队，由 GUI 兜底弹窗选择邮箱或中断后发送，详见 [send-queue-panel.md](send-queue-panel.md)。兜底选择中断后发送时保留宿主队列，替代消息受理后再摘掉原排队条目，避免中止收口自动派发造成重复。用户点停止是唯一用户 abort 源；连接建立期停止会补停并阻止迟到发送。关闭、释放或清空会等待会话级进程回收屏障；无法确认时明确报错并阻止新的写入者。
- **网络/传输中止自动续作（2026-09-17）**：Host 对在飞回合的 `error` / `send` reject 走 `planGuiTurnRetry`（`src/main/agent/turnRetry.ts`），按错误文案分类而不是按 runtime 特判。明确标记为投递状态未知的错误优先停止自动重发、保留排队并提示核对引擎历史；分叉上下文另有持久化状态保护。其余命中 `ECONNRESET` / `ECONNREFUSED` / `ETIMEDOUT` / `[aborted]` / `AbortError` 等网络类：符合续作条件时保持 busy、指数退避（缺省 3 次、2s 起步封顶 30s，`AppConfig.guiTurnRetry` 可配）。尚无进度时，只有适配器明确证明消息未提交才重发原文，否则暂停自动重发；已有思考/正文/工具则向引擎注入续作提示（不重放已执行工具）。用户点停止、401/额度等确定性错误不续作。续作等待期不推 `busy:false`，调度看不到假「回合结束」。用尽后 `outcome=network_error` → `onTurnFailed` → 编排事件 `turn_error`（仅 orchestrated 会话），且不 drain 排队。既有回归文件见 `test/turn-retry.mjs`、`test/gui-host-lifecycle.mjs` 和 `test/orchestrator-turn-end.mjs`；本轮未运行。
- **队列状态一致性**（2026-08-31 返修）：派发出队时清掉原消息的 `queued` 标记并透传 `images`；`cancelQueued` 除 sync 外补推 `busy`（队列深度）；渲染层排队胶囊**从消息派生**（`messages.filter(queued)`），主进程漏推/重挂载都不会滞留。
- **回合中拆连接兜底**：busy 中切模式/切模型会 close driver——事件源消失后 `turn-complete` 永远不来，`consumeEvents` 的 finally 对「连接已为 null 且 busy」强制收口（标错误 + finishTurn），否则 busy 永久卡死（后续消息只进队列、abort 变 no-op）。下轮 send 重连接力。
- `clear`（/new、/clear）：停回合 + 拆连接 + 清历史与续聊令牌 + 清 fork 种子，下轮新引擎会话；模式保留。旧引擎会话数据随之作废清理（见下）。
- **落盘生命周期**：`persistEntry` 同步从已有内存消息更新会话元数据的看板末句预览，正常加载旧会话时按需补齐，清空会话时移除；详见 [全局看板](global-board.md)。`persistEntry` 在回合结束等时机写入 `userData/agent-sessions/<id>.json`；`closeAll` / 应用退出 / 切走会话只 `persistEntry` + 释放 driver，**不**删 json；左栏删除会话 `close({ purgeHistory: true })` 才删文件；`getHistory` 在 entry 未 open 时仍可读 store（重启首屏竞态兜底）。
- **引擎侧数据清理**：Pi 的 `GuiRuntimeDriver.purge` 清理工作台管理的转录与 trim-cache，启动时按有效会话清理孤儿；启动延迟任务归Runtime scope，退出取消尚未执行的计时器和busy错峰等待，已经进入driver的清扫等待实际完成后才释放，不继续调用下一driver。渲染草稿按会话差集清理。Cursor ACP 的原生会话由 Cursor CLI 管理，删除工作台聊天不会清理 CLI 侧历史；旧 SDK 存储不再由工作台读取或清扫。
- 看板映射（无 pty 刮屏）：回合开始 → activity=active（Host 记 `turnStartedAt`）；等待审批 → blocked；回合结束 → idle（不自动 phase=done）。`setStatus` 写入 `needs_you` 时 Host 做 P5/P11 校验：回合开始 60s 内且无 `reason` → warning+回注；隔离树 dirty → 回注提醒（不撤销看板、不替 Worker 写 commit）。`requestIntegrate` 时若仍脏则兜底提交并标注 `[host] P11`。合入隔离 worktree 见 [isolate-worktree.md](isolate-worktree.md)。Worker→调度提问见 [session-mailbox.md](session-mailbox.md)。

## 消息渲染（v2：交错 + 去噪）

- `AgentChatView.toDisplayMessage` 把 GuiChatMessage 映射成 `ChatMessage.parts`（assistant 文本段做路径链接化）；`ChatMessageView` 有 parts 就交错渲染。调度面板（AgentFloat）也已切到 parts 模型：`piProvider.subscribePiTurn` 按 delta 到达顺序 append（`appendStreamPart`，尾部非同 kind 新开一段），`agent:token`/`agent:thinking` 带 `partIndex`，store 合批按 `(messageId, partIndex, kind)` 写回 parts；工具卡同步进 parts（同一 record 引用）；扁平 `content`/`thinking` 仍并行维护（会话标题/预览、旧数据兼容）。历史装载 `loadPiSessionDisplay` 经 `entryParts` 按 Pi 内容块顺序还原 thinking/text parts。
- **渲染缓存与自动贴底**（2026-08-31 返修）：IPC sync 每次结构化克隆全量消息，渲染层映射缓存改用 `guiChatMessageEqual` 深比较（shared 纯函数，test/gui-worker-parts.mjs 锁死）识别「内容没变」，未变化的消息复用旧映射（ChatMessageView memo 保持生效）；流式中的消息跳过 `linkifyWorkspacePaths`（每拍全文正则是 O(N²)，回合末 sync 以终稿重映射补链接）。自动贴底改判「新 user 消息 id 出现」——旧判据「末条恰为 user」会被 React 合批吃掉（用户消息 sync 与 assistant 占位 sync 合成一帧），上翻过一次后整个回合不再跟随（用户报的「新内容不显示，要手动滚动」）。onFork 回调引用稳定化（每消息闭包会打穿 memo）。（无「思考中…」动画头、无卡片壳）；后面一旦出现工具/文本等非思考内容，自动收成一行 `思考过程 · 持续了几秒`。摘要/正文用 `--font-control`（13px）+ `--text-2`，悬停/进行中升 `--text`。
- **工具块**：连续工具调用合并成一个可展开分组。流式执行时外层显示 `工具调用` 和最新调用，点击后进入缩进的调用列表；列表有最大高度并支持滚动，列表中的每项再单独展开 diff、结果和参数。正文和可见思考会切断分组，被“只显示当前思考”隐藏的思考不会留下看不见的断点，真实的审批/提问卡仍会切断分组。回合转写保留正文与 `调用了工具` 的原始顺序。动词包在 `.tool-lite-verb`（`flex-shrink:0` + `nowrap`）：CJK 的 min-content 只有一字宽，匿名文本节点当 flex 项会被压成竖排；挤压只让路径/详情省略。
- **历史轮折叠（2026-09-05）**：关闭「只显示当前思考」时思考参与折叠，历史思考摘要固定为「正在思考中」并可点击查看内容；默认开启时思考按 [展示设置](chat-transcript.md#当前思考展示与展示记录) 隐藏并过滤展示记录。会话容器（现 `chatSurface/ChatTranscript.tsx`）以「最后一条 user 消息」划分当前轮——之前的轮次里工具/思考聚成一个折叠头，优先显示回合运行时长，同时保留工具调用数与思考段数；**2026-09-15 起折叠=真卸载**（条目不挂载、只留折叠头与末段正文，重会话切换首开 212ms→94ms），展开重挂（卡内瞬态复位）、大栈先挂首屏量再帧批次补齐（ToolCallStack）；当前轮保持展开。后台任务面板不折叠。
- **会话历史面板**：右键人工用户消息气泡弹出 `chatSurface/ChatHistoryPanel.tsx`，调度 Agent / GUI Worker / 后台任务子代理共用 `ChatTranscript` 入口，列宽与输入框对齐。列表只列非 queued 且有正文或图片的人工用户消息；宿主通栏、调度/代理注入不建停靠点。气泡复制按钮旁和历史列表内的书签均可切换收藏，顶部「仅看收藏」筛选当前转写的收藏。悬浮预览已加载的提问和该轮 AI 回复的最后一个非空正文片段，点击条目跳到对应回合并保持面板打开。面板外点击、Escape 或 ✕ 关闭。停靠点由 `buildTurnRailStops`（`src/shared/chatTurnRail.ts`；`test/turn-rail.mjs`）派生，兼容调度消息仅有 `content`、没有 `parts` 的形状；气泡入口按当前行判断收藏资格，历史面板挂载时才提取停靠点和回复预览。收藏保存及历史回填见 [chat-transcript.md](chat-transcript.md)。
- **quiet 观感**（`ChatMessageView` 的 `quiet`，调度面板与 GUI 会话都开）：无角色行；助手正文直接落在面板底色（无气泡）；用户消息保留右侧气泡。操作条在**消息下方文档流内常驻占位**（时间 / 复制 / fork / 有批注时「批注N」），平时仅透明度隐藏、悬停/焦点显形。fork 由 `caps.fork` 门控：GUI 走 `agentSession:fork`，调度面板走 `chat:fork`（见 [chat-surface.md](chat-surface.md)「调度会话 fork」）。样式在 `chat.css` 的 `.chat-msg.chat-quiet`，不绑 `.agent-chat-view`。
- **小米 MiMo 思考流**：Pi `thinkingFormat: deepseek` 在无 reasoningEffort 时会发 `thinking:disabled`；配置侧对 MiMo 设 `thinkingLevelMap.off=null`，GUI/调度 createAgentSession 与每回合 send 显式 `thinkingLevel=medium`，避免误关默认开启的 `reasoning_content` 流。
- **列宽上限**：消息列 `.agent-chat-col` 与 Composer 内层宽 760px 居中（`.agent-chat-composer-wrap > .agent-composer`），超宽屏不满铺。输入条悬浮盖在会话流上（转写铺满高度，底沿渐隐）。调度悬浮面板同样包这两层；面板拖宽上限 900px（与阅读列对齐，不再铺满视口）。**用户气泡不得用百分比 `max-width`**（2026-09-08 修）：flex 收缩语境（`.chat-body` 的 `align-items:flex-end`）下 Chromium 把百分比 max-width 的基数解析成气泡自身 max-content，宽度被缩到 `max-content×0.92`——「你好」两字也逐字折行（数据与 DOM 均无换行，纯布局 bug）。现限宽 8% 空隙改做在 `.chat-msg.user .chat-body` 的 `padding-left` 上，气泡本体只留 `margin-left:auto` 右对齐。
- **mermaid（pele 引擎，2026-10-24 自 mermaid.js 11.17.2 替换）**：` ```mermaid ` 围栏（`language-mermaid`）走 `MermaidBlock` 渲 SVG；pele 懒加载、同步 render、无临时 DOM（原 mermaid 的串行队列/initialize 均不再需要）；流式半成品解析失败时显示源码虚线框；主题色走 SVG 内联 `var(--pele-*)` + 容器映射（markdown.css，对位原 themeVariables），切主题零重渲、仅字体就绪重渲一次。输出剥标签/滤 `javascript:` 链接/限额（50k 字符、5000 边、4MB SVG），安全回归见 `test/pele-security.mjs`；源码 classDef 的字面填充节点由 `contrastMermaidLabels` 按亮度配对比文字色（浅青开始节点白字不可读问题，深浅主题均成立）。`normalizeMermaidSvg` 继续管根标签尺寸：剥内联 max-width/height、写 viewBox 像素尺寸 + aspect-ratio（历史上 mermaid 百分比宽度致图瘪成一条的同一防线）。图按自然尺寸绘制：超容器宽只缩小、永不放大，容器内水平/垂直居中（2026-10-24 定案，旧的 is-sized 容器拉满列宽+SVG 绝对铺满模式已删——窄长图会被无谓放大）。点击预览弹出全屏查看器（滚轮缩放、拖动平移、Esc 关闭）。文件面板 `.md` 预览同一路径。

## 工具卡可视化

- `ToolVisuals.classifyTool(name, input)`：点号名（宿主 Catalog 工具）原样展示；引擎原生工具按名/入参归类出动词（读取/写入/编辑/执行命令/搜索/列目录），主显示取 `path/file_path/filePath/...`（或命令文本）。
- 文件路径渲染成 `ws-file-link` 超链接 → `onFileLink` → 右侧文件面板打开（stat 校验，不在工作区 toast）。
- **编辑类显示 git-diff**：优先 Pi edit 的 `details.patch`（unified，driver 从 tool_execution_end 透传）；无 patch 时由 old/new 文本对（Pi `edits[]` 等）合成 unified 再 `parseDiff` 渲染（`MiniDiffView`，无 tokenize 轻量版，红绿变量与 git 面板同套）。写入类显示内容预览（80 行截断）；读取类显示结果（200 行截断）。
- 有专门可视化时折叠体不再重复原始参数 JSON。

## 会话批注（对 AI 回复划词批注）

链路：划词浮条（`.chat-list` 打 `data-sel-area="gui-chat"`，区域注册表加「批注」项）→ `noteBridge.requestChatNote` 捕获活 Range/引文/消息 id，按 `data-session-id` 路由到所属会话 → 校验 `data-role=assistant`（用户消息/跨消息选区拒绝）→ `wrapNoteAnchor` 把选区包成 `.msg-note-anchor`（待定态，极淡底色+虚线下划线；跨块选区**逐文本节点**包成多个同 id 片段——绝不 `extractContents` 移动块级元素，否则 React 重渲时按 vdom 回收被搬走的节点、原文被删）→ **角标旁开录入气泡**。确认后：锚点转正（`promoteNoteAnchor` 按待定 id 全量回填）、`批注N`（顺序号）经 `appendDraft` 追加进输入框。

- **角标+气泡（内容坐标系）**：批注的常驻形态只有一枚 16px 数字圆点（`.msg-note-badge`，缀在选中文字右上，几乎不占地）；量位逻辑与旧卡片同（useLayoutEffect 量锚点 span 相对消息包装层偏移 + ResizeObserver/resize 重测），随文字滚动/回流。录入时角标（预显下一个序号）+ 输入气泡（placeholder + ✓，Enter 存/Esc/点外取消=撤销批注）；保存后气泡收起只留角标。点角标开查看/编辑气泡（引文一行 + 可编辑输入 + 🗑/取消/保存），点气泡外收起，删除走 `onNoteDelete`。历史轮折叠 / 消息重挂 / 会话隐藏把 `.msg-note-anchor` 卸掉或量成 0 矩形时，角标不消失，改挂消息底 `is-from-bar`（与操作行同一降级位）。
- **三入口同一打开态**：正文角标、消息底部操作行「批注N」、输入框药丸（`data-note-entry`）都改 `useSessionNotes.openNoteId`，展开同一 `NoteBubble`。药丸点击不再只找锚点——锚点在就闪一下并滚过去，卸掉了就滚到所属 `[data-mid]` 仍打开气泡。点外关气泡必须把三入口都当成「里面」（`isSessionNoteEntryTarget`），否则 document `mousedown` 会先把刚打开的气泡掐死。回归：`test/unit/chat-note-entries.spec.tsx`（锚点不在 DOM 时三入口仍指向正确批注）+ `test/unit/chat-hoverbar-note.spec.tsx`。
- **输入框 token / 汇总条**：contenteditable 原子药丸（`composer-token`，`data-note-id`）。`appendDraft` 会同步 rebuild，若此时 `noteTokens` 还是上一拍，最后一颗「批注N」会落成纯文本（点了没反应）——确认批注时 `flushSync` 先提交表，且 Composer 在 `noteTokens` 到齐后对账 rebuild。点击走 `onTokenClick` → 与角标/操作行同一 `reveal`；目标消息若是折叠历史轮，先展开该轮再开气泡。× 快删连着批注记录与锚点一起摘。回归：`test/unit/composer-note-tokens.spec.tsx`（汇总条每项均可点击）。
- **发送展开**：`expandNoteTokens` 把每个 `批注N` 换成 `[会话批注] 原文：“选中内容”；用户批注：批注内容`——原文与用户批注用标签明确分开，AI 不会把所选内容当成用户说的话（shared 纯函数，test/note-annotations.mjs）；发送后面板清空，输入框全文对账（`onValueChange → reconcileNotes`）自动摘锚点。相邻 token 间隔由系统规范到 **3 个空格**（药丸视觉外沿比字形宽，1-2 空格会贴死/重叠）。
- **双删同步**：气泡里 🗑 删除 → `stripNoteToken` 同步摘输入框里的 token；输入框里手动删 token → 对账自动摘锚点。锚点是手工 DOM，靠 memo 子树存活，React 重清不做后台重建（重批即可）。
- 调度面板（2026-09-20）：`caps.notes` 开启，`AgentFloat` 按 workspaceId 注入同一 `useSessionNotes`；划词区在已注入宿主时走 `gui-chat`。草稿桶用调度 `draftKey`（工作区 id）。发送经 `expandForSend` 进 `chat:send`。仍是内存态（与 GUI 相同，见 [ui-state-persistence.md](ui-state-persistence.md) §5.1）。手机壳不注入宿主。详见 [chat-surface.md](chat-surface.md)。终端划词区仍无批注动作；后台子代理转写也打了 gui-chat 标——批注会路由到父会话（token 进父会话输入框），属预期衍生行为。

### 文件批注（file-editor 区划词，2026-09-02）

把批注从会话转写扩展到**文件预览/编辑界面**（FilesPanel 的 FileEditor，`data-sel-area="file-editor"`，编辑态与 md/html 预览态都生效）。划词点「批注」→ 贴划词浮条**弹出批注录入框**（复用 `.msg-note-bubble` 观感、portal 到 body 视口 fixed 定位；来源 路径:行号、多行编辑批注文字；不重复所选原文，Enter 换行、Ctrl+Enter/保存 存、Esc/点外取消）→ 确认后按目标类型两路投递，**文件内同时留下批注标记**（与会话批注角标同款 `.msg-note-anchor` 观感，待定期 `is-pending` 更深底色）：

- **目标=GUI 或 CLI Agent 会话**：`批注N`（同一序列）**带批注文字**进对应工作台输入框，toast 报「批注N 已加入会话 X 输入框」；药丸点击 `requestOpenWorkspaceFile` **回跳文件面板对应行并打开批注编辑框**。发送展开成 `[文件批注 路径:起-止] 原文：“所选内容”；用户批注：批注内容`。CLI 待发批注按会话持久化，接收端未就绪时保留录入框并提示。
- **目标=普通 Shell**：展开文字经终端粘贴注册表（`terminalRegistry.registerTerminalPaste`）直接粘贴进终端输入，回车由用户决定。

- **目标会话解析**：`SelectionMenuHost` 用 sessions+runtimes 解析活动会话（`type==='terminal'` 再按 `runtimeSurface` 分 chat/terminal 两类）传入菜单构建参数；活动会话缺失/为定时任务时点「批注」只 toast 提示。
- **路径/行号捕获**：FileEditor 挂载时向 `noteBridge.registerFileNoteSource` 注册解析器——编辑态选区在 `.cm-content` 里，`EditorView.posAtDOM` 得起止偏移与起止行（1-based；选区止于行首按互斥端点归上一行），并落**待定标记**（`fileNoteMarks.placePendingFileNoteMarkCM`）；md/html 预览是渲染后 DOM，无行号映射只带路径，用 `wrapNoteAnchor` 包 span 落待定标记；媒体/文件夹概览直接拒绝。注册表是单例（FileEditor 全局一份）。
- **文件内标记**：`components/fileNoteMarks.ts` 单例注册表——编辑态走 CM `StateField`（add/resolve/remove 三 StateEffect，`tr.changes.mapPos` 随编辑映射位置，换文件整批摘除）+ **计数角标 widget**（`NoteBadgeWidget`，缀在标记末尾）；预览态走 DOM 包裹 span + **末片段内联角标**（`.msg-note-badge.is-inline`）。确认回填批注 id 与序号（GUI 流取会话批注 seq，与输入框药丸同号；终端流用编辑器内部计数），取消/会话侧删除批注（`deleteNote`/`reconcileNotes`）同步 `removeFileNoteMark` 摘标记与角标。**角标可点击**：经 `fileNoteEntry` 的批注记录表（`FileNoteRecord`，含正文与目标会话）打开**二次编辑气泡**（edit 模式，预填原批注）——保存回写记录并经 `registerFileNoteEditor` 路由更新会话批注，🗑 删除连带会话 token 与文件内标记一并摘除。
- **链路**：`selectionMenuAreas` 的 file-editor 区「批注」→ `fileNoteEntry.openFileNoteEntry`（立即捕获选区+解析器结果，控制器模块单例）→ App 根部常驻的 `FileNoteEntryHost` 弹录入框 → 确认按目标分两路（上）。录入框生成批注 id，GUI 路径下 id 随投递传给 AgentChatView（`registerFileNoteTarget` 接收端，建无锚点批注 + `appendDraft` 追加 token + 回传序号）。
- **发送展开**：`expandNoteTokens` 对带 `file` 的批注展开成 `[文件批注 路径:起-止] 原文：“所选内容”；用户批注：批注内容`（同行只标起始行；预览态无行号只带路径；原文与用户批注用标签分开，AI 不混淆）。共享模型 `NoteAnnotationCore.file?`（含 `endLine`），行为由 `test/note-annotations.mjs` 锁死；CLI 粘贴路径直接复用 `expandNoteToken` 单条展开。
- 录入框宿主独立挂载（浮条收起后录入框留存，同 TextToolResultCard 配方）；未确认收场（Esc/点外/换目标）自动撤销文件内待定标记；edit 卡片点其他角标可换目标。

## 提问卡

- 已回答卡片通过文字层级区分问答：题干使用次级文字色，答案使用正文色，字号一致、左缘对齐；问答间隔 6px、组间留白 16px，不加 Q/A 标识、缩进或分隔线。
- Host `requestUserQuestion` → 渲染层 `UserQuestionCard`（**按 anchorPartIndex 插进 parts 流**，2026-09-05 起不再沉在消息底部；作答后转写自动贴底跟随回合续流）。**Pi / Claude / Codex / ACP** 使用提问卡（Claude 进程内 MCP，Codex/ACP 经 stdio MCP + 网关；Cursor 另映射原生问卷和计划请求）。**调度 Agent** 另有 Catalog `askQuestion`（同映射、同卡面，回注走 `chat.respondUserQuestion`，见 [chat-surface.md](chat-surface.md)）。
- 多题一次只展示一题，底部「上一题 / 下一题」，最后一题才「提交回答」。题干用标题字号加粗，选项放在内凹底上，避免题和答案糊成一块。
- Pi 问卷按 `status` 类放行（Ask / Plan 也能弹卡）。Cursor ACP 的原生问卷同样显示提问卡。

## fork（从任意消息分叉新会话）

- 悬浮操作条 fork 按钮（busy 中隐藏）→ `agentSession:fork {sessionId, uptoMessageId}` → Host：
  1. 复制 UI 历史到新会话，截止到 fork 点并剥离待决审批、排队和计划状态。同源分支保留兼容的模型及思考设置，并继承「配置权限」开关；关闭时执行自动权限策略，开启时 Core 保留 Core 档位，外部使用兼容的原生确认值。
  2. 优先使用可确认的原生截点。Core 在独立内存副本分叉，Codex 记录完成回合 ID 并以 `thread/fork(lastTurnId)` 选择 assistant 回合。外部 Pi、Oh My Pi 和 OpenCode 见 [GUI Harness 目录](gui-harness-integration.md)。无法确认截点时按现有文本回放规则处理。
  3. 渲染层拿到新会话 id 后 `sessions.select` 切换过去。
- 原生分叉不向新引擎重复注入文字，新会话保存新原生 token。会话注册和广播之前先以 `agent-fork-pending` 记录准备状态、复制附件并同步落盘历史；中断而未登记的准备数据由启动孤儿清扫处理。Pi 和 Oh My Pi 经核对保留历史消息 ID 供后续再次分叉，Codex/OpenCode 原生分支的旧消息暂不继承截点映射。回退种子连接成功即清（Pi）；回退 transcript 在首轮完成后保留恢复保护记录，后续回合先标记在途，未确认时禁止续写和二次分叉；由于压缩事件缺乏可靠的操作关联，受保护会话暂不支持压缩，详见 [gui-harness-integration.md](gui-harness-integration.md)。源会话忙碌、清空或正在分叉时拒绝并发操作。原生路径的实际引擎和安装版行为待用户验收。
- GUI fork 和中断后的 GUI 续作由会话工厂从同 runtime、工作区与 cwd 的源会话复制全部 GUI 配置，创建期间源配置改变则拒绝；复制已有配置不要求模型目录缓存存在，也不自动启动模型发现。首轮仍按实际引擎与参数约束检查，参数描述缺失且有覆盖或配置时需要手动刷新目录。

## Composer（输入框）

- 外壳 `.chat-input-shell`：`--radius-modal`（24px）+ 全局 `--corner-shape: superellipse(1.5)`，与看板/弹窗同档。聚焦只换 `--focus-border` 细描边，表面底色不动。
- **命令激活态（cmd chip，2026-08-31 统一交互）**：斜杠触发 `/quickInput` 后进入命令态——命令以**染色 chip 留在输入框内**（quickInput=accent 蓝，chip 上 × 或 Esc 或空值退格取消），主输入框本身充当命令的搜索/录入框（placeholder 随态切换，命令态下不触发斜杠/@ 菜单），功能完成（插入短语）chip 才消失。规范：**命令 token 必须保留可见直到功能完成**，不许开完面板就清空输入框。（原并排的 `/tosend` 命令态随 /tosend 一并删除，2026-09-08。）
- **手动确认发送清单**（原 /tosend 待发送清单，2026-08-31 引入；**/tosend 命令 2026-09-08 删除**，存储沿用 `muster.tosend.v1:<bucket>`）：清单条挂在统一排队面板下泳道（见 [send-queue-panel.md](send-queue-panel.md)）。**永不自动发送**；条目来源 = 跨泳道拖拽（把排队条目拖下来）或「忙时手动区非空则新消息默认进这里」的分流；单条 2000 字、上限 20 裁最旧，按草稿桶持久化（GUI 会话=会话隔离，重启不丢）。纯渲染层，不进引擎上下文。
- **/quickInput 快捷短语**（2026-08-31，同上全局开）：命令态下输入框即搜索框——全文作为过滤词，key/value 大小写不敏感子串双匹配；↑↓ 选择 / Enter（或 Tab）插入到输入框（整段替换查询词，插 value、空 value 插 key）/ Esc 取消；面板只剩列表 + 行内悬浮 编辑/删除 + 「新增短语」内联表单（Enter 跳内容、Ctrl+Enter 存、名称与内容留一即可存）。全局存储 `muster.quick-phrases.v1`（跨会话/工作区共用）。点 composer 以外区域整体收起。
- 左侧 **+ 号附件面板**（`plusMenu`，CherryStudio 式；调度面板与 GUI 会话都开）：上传图片（allowImages 时）/ 引用文件（插 `@` 弹工作区文件面板）/ 命令（插 `/` 弹斜杠面板）。加号旋转 45° 表示开合。未开 `plusMenu` 时退回旧的内联图片按钮。
- **图片附件**：runtime `supportsImages` 决定引擎能不能收图；**当前生效模型**再做一层守卫（与 piConfigSync / `inferModelSupportsImages` 同源：显式 `multimodal` 或 id 正则）。`allowImages` = runtime 能力位 **且** `status.supportsImages !== false`，切 `modelOverride` 到非多模态模型后上传入口立刻收起。发送时 Host 拒绝（`{ok:false, error:「模型 X 不支持图片输入」}`），Composer 保留文本与图片草稿；已贴的图在入口收起后仍显示缩略图条，可手动移除。Pi driver 发送前仍校验 `model.input.includes('image')` 作兜底。用户消息带缩略图回放。
- 状态条：左侧模式 chip（四档循环）；右侧依次为上下文用量（环 + 数值文本）+ 模型按钮（切模菜单，运行中保存选择、下回合生效）+ 思考 chip（Pi 且生效服务商配置了思考映射时显示，紧跟模型按钮右侧；五档 + 跟随默认，每回合热生效不重连）。
- **思考强度体系（2026-09-05）**：产品固定五档（关闭/低/中/高/最高）；设置 → 模型服务商里为每个服务商配各档载荷值（`LlmProviderConfig.thinking.levels`，允许重复映射，留空=该档不可用）与「reasoning_effort 字段」开关——经 piConfigSync 落成 pi 模型 `thinkingLevelMap`（复用 MiMo 通道）。会话级档位存 `SessionMeta.thinkingLevel`（`agentSession:setThinking`），Pi driver 每回合热读 setThinkingLevel（会话级 > 模式覆盖 > 缺省 medium/off）。Cursor 用模型参数（推理档）。
- **调度面思考档（2026-09-20）**：左列 orchestratorSurface 与 GUI 共用 Composer 思考 chip（`status.thinking.available` + `actions.setThinking`）。工作区级（不是会话级）存入 `agent-models.json` v2 envelope 的 `thinking` 字段（`Orchestrator.setThinking` / `chat:setThinking`）；启动时对仍存在的 pre-release `agent-thinking.json` 做一次性归并并删除 sidecar；未写入=跟随默认（reasoning 模型 medium，否则 off）。`available` 走与 GUI 同源的 `providerThinkingConfigured`（生效服务商有思考映射）。建会话与每回合 `prompt` 前热读 `getThinkingLevel` → `safeSetThinkingLevel`，切档无需重连。切到未配置映射的服务商时清掉工作区档。回归 `test/agent-thinking.mjs` + `test/unit/orchestrator-thinking.spec.tsx`。
- **思考方言（2026-09-05 补充）**：`thinking.thinkingFormat` 可显式指定 pi-ai 思考控制字段格式（仅 openai-completions 协议生效），纠正 baseUrl 自动探测误判（如智谱被判不支持 effort）；缺省=自动探测。下发优先级：用户显式 > 小米默认（deepseek）> 探测。详见 [model-providers.md](model-providers.md)。
- **发送受理即回执（2026-09-08 改）**：Host `send` 在消息入历史后立即返回 `{ok:true}`，回合发起（含连接冷启动，可达数十秒）后台 `void startTurn` 执行（内部全路径自收口：连接失败标错误 + finishTurn，渲染层以失败回合 retry 重发）——此前 `await startTurn` 把回执拖到连接建立后，Composer 等 send 返回才清草稿，出现「消息已上屏、输入框几十秒不清空」。Composer 仍等 send 结果再清草稿（失败保留文本与图片：排队满/不支持图片/IPC 异常等快速失败不再丢稿）；消息一旦入历史就不回填（否则 retry 会重发两条）。
- **斜杠命令（GUI 会话语义）**：菜单不列 status/help/model/bind（调度专属）；**技能与调度同一 `agent.listSkills` 数据源**（`skillsToSlashItems`，不按表面滤掉）。手输 `/model` 直接开模型菜单；/new、/stop 描述按 GUI 会话语义。`/skill:name` 插入技能 token，发送时 Host 按 Pi 同款 `<skill>` 块展开进引擎（转写仍显示 token；`expandSkillText`）。Pi GUI 和调度经 `skillSources.ts` 共用快照内发现与同名恢复；菜单显示来源，选择后发送限定命令，GUI 首发/插话按当前源根做自动点名，以物理文件 ID 记账。模式 `skillsPaths` 仍属显式引擎配置。实际技能范围与回归见 [skills.md](skills.md)。`/compact`（2026-09-16）手动压缩上下文：解析单源 shared/compactCommand，能力表 `manualCompact` 门控（仅 pi SDK 有手动压缩入口；`GuiRuntimeConnection.compact?` → `session.compact()`，忙时 Host 拒绝）。进行中/完成画在会话消息流（`CompactDivider`，勿只靠 flashTip——那条写进调度工作区气泡）；失败走 Composer hint。压缩标记走 compaction 推送（透明模式下渲染 §6.4 分隔样式），自动压缩同样出分割线。调度面板同款命令（分割线 + 失败 hint，飞书直发路径走通知）。详见 [chat-surface.md](chat-surface.md)「手动上下文压缩」。
- **阈值自动压缩（2026-09-17，第一步仅 Pi）**：能力位 `autoCompact` + `AppConfig.autoCompact.ratio`（缺省 0.8）；回合空闲收口时占比超阈复用 Host `compactSession`（与手动同链路、同互斥）。详见 [chat-surface.md](chat-surface.md)「阈值自动压缩」。
- **自适应高度**：空值不写 inline height（交给 `min-height: calc(1.4em + 20px)`）；有字先按 scrollHeight 撑满 inline height，上限由 CSS `max-height: 240px` 裁（`chat.css`，JS 不重复一份常量），被裁时出滚动条。未布局（`offsetWidth===0`，含 `display:none` 的后台会话）不测量。壳层 ResizeObserver 在切回可见/改列宽时重算。空态 placeholder 单行省略，避免长文案折行把内容盒撑乱。滚动跟随：到上限后打字/粘贴在末尾时自动滚到底（光标行恒可见）；光标在中间编辑时保持原滚动视角（不强制归零）。

## Core 模式和外部 Harness 设置

GUI 会话的「配置权限」默认关闭（`configurePermissions !== true`），Core 有效模式为完全访问 `auto`，外部 GUI 优先启用原生免审批能力，宿主自动允许仍收到的有效权限申请。开启后 Core 使用保存的 `GuiWorkerMode`，外部读取原生目录、状态和审批选项，详细接口见 [GUI Harness 原生权限](gui-harness-integration.md#原生权限与会话设置)。旧外部会话的宿主档位不参与执行；内置调度的模式体系不受该 GUI 开关影响。会话开关通过 `sessions:setConfigurePermissions` 持久化，关闭可解除当前待决权限，普通用户提问仍等待回答。

### 用户工具规则（数据面，叠在三档表之前）

工作区文件 `.muster/tool-rules.json`（常量 `META_AGENT_TOOL_RULES`；**无配置 UI**，手写/外部编辑即可）。形状：

```json
{
  "version": 1,
  "rules": [
    { "id": "deny-rm-rf", "params": { "command": "rm -rf" }, "action": "deny", "reason": "禁止 rm -rf" },
    { "id": "deny-force-push", "params": { "command": "git push --force" }, "action": "deny" },
    { "id": "allow-npm-test", "params": { "command": "npm test" }, "action": "allow" },
    { "tool": "Bash", "params": { "command": "git push --force" }, "action": "rewrite", "rewrite": { "command": "git push" } }
  ]
}
```

| 字段 | 含义 |
|---|---|
| `tool` | 工具名（大小写不敏感；点号/下划线等价；`*` 或省略=任意） |
| `params` | 参数模式；shell 的 `command`/`shellCommand` 与 `isReadOnlyShellCommand` **同构**（quote 感知切段 + 未加引号 token 有序子序列——`grep 'rm -rf' f` 不误伤）。**action=allow 时为逐段全称**：每个顶层段都须命中模式，`npm test && rm -rf x` 不整链放行（2026-09-17 收紧，allow 是提权口；deny/ask/rewrite 保持段内子序列宽松语义防漏拦） |
| `action` | `allow` / `deny` / `ask` / `rewrite` |
| `rewrite` | `action=rewrite` 时合并进入参的字面量字段 |
| `enabled` | 缺省 true；false 跳过 |

**叠加顺序**（`decideWithUserToolRules` → `decideToolPermission`）：数组**首条命中**生效 → `deny` 任何模式确定性拦截（含 auto）→ `ask` 强制 prompt → `allow` 强制 auto（可越过 ask/plan 只读门；shell command 匹配为**逐段全称**——每个顶层段都须命中模式，链式命令不得借首段命中整链放行）→ `rewrite` 改写入参后**落入**下方三档表（不再继续匹配后续用户规则）→ 未命中走原三档表。缺文件/坏 JSON = 无规则（fail-open）。火时热读盘。纯函数与接线测：`test/gui-worker-tool-rules.mjs`。

> ⚠️ **已知风险（待产品决策）**：default 档下区内写文件是 auto，Worker 可自写 `.muster/tool-rules.json` 给自己加 allow 规则——存在自我提权面（allow 已收紧为链式逐段全称，但规则文件本身可被区内改写）。硬防护（守卫级 denyPaths、规则文件首次审批等）待产品决策后落地。

以下是 Core 工具决策表。外部 Harness 的宿主工具调用另校验目录、显式用户规则和业务授权。

| 模式 | 派生权限 | 宿主网关门控 |
|---|---|---|
| standard（标准，新 ID） | ask | 读/状态自动；编辑、命令、浏览器动作、MCP 和其他有状态工具需确认，MCP 不使用名称启发式作自动放行依据 |
| accept-edits（自动接受编辑，新 ID） | acceptEdits | 在标准档上自动接受工作区内文件编辑；命令及其他操作仍需确认 |
| default（默认） | acceptEdits | 区内 edit 与日常 shell 自动执行；区外 edit 与 MCP 写仍按权限审批，显式用户规则和引擎限制仍有效 |
| ask（只读） | ask | edit 与 MCP 写直接拒（理由回模型）；bash 仅只读白名单（唯一实现在 `src/shared/guiWorkerPolicy.ts` 的 `isReadOnlyShellCommand`：quote 感知切段逐段过前缀白名单，重定向仅放行 /dev/null，命令替换拒；专项拒 find -delete/-exec/-fprintf/-fls/-ok、sed w/e（s/// 内部掩码后判）、awk action 内 > | system、tree -o、git branch 删改、git diff --output、rg --pre；已知边界：here-doc 逐行切段、awk action 内数值比较被拒） |
| plan（计划） | ask（执行中恢复 acceptEdits） | 探索态同 ask；批准执行后门控解除 |
| auto（全自动，GUI 特有） | auto | 基础决策自动放行；用户规则、已配置的目录约束和引擎自身限制仍有效。宿主的文件路径检查本身不构成 shell 的操作系统沙箱 |

新 `standard` / `accept-edits` 档不沿用之前计划中批准的命令预授权，切档后命令重新确认；旧档位和显式用户规则的优先级不变。

- Pi：直接挂调度的 `createModeExtensionFactory`（每会话独立 ModeController）——禁 edit/write 工具、bash 白名单 block、`before_agent_start` 注入模式提示，全 fire-time。
- **审批入参关联（2026-09-05，DSH 时代引入的语义）**：ApprovalRequest 不带 arguments 时按 callId 回填已呈现 tool/call 的入参，**callId 未命中且无 args 时 fail-closed 拒绝**。DSH 移除后该语义仅存于历史；Cursor ACP 通过原生模式协商与 ACP 权限请求执行各自限制；未上报的原生操作不能视为已被宿主拦截。
- **busy 保护**：需要重建连接的引擎在 busy 中禁止切权限，提示等回合结束；Pi 系列切档由工具决策桥 fire-time 热读。
- 计划流（引擎无关，双捕获路径共用一张 PlanCard）：
  - **工具捕获**：Host 在 `tool-start` 即时识别计划类工具（`isPlanToolName`），从入参取计划 markdown 并挂卡，不等回合收口。Cursor ACP 的 `cursor/create_plan` 是独立请求，直接显示完整计划和批准/拒绝提问卡，不依赖工具事件捕获。
  - **正文提取**（pi 约定）：回合收口时 `extractPlan` 从回复提取「Plan:/计划/实施计划」标题起的计划块（编号/`### 1.`/复选框步骤，块止于下一个顶级标题/分隔线/最后一步之后的散文）；本回合已被工具捕获挂卡时跳过，防重复。
  - 挂卡统一走 `attachPlanCard`：新卡 `{steps, markdown, status:'pending', active:true}`，其余 pending 卡置 `active:false` 转「已更新」只读；`modeController.planSteps` 同步供执行/进度用。恢复会话时重水合：「执行中」卡一律降级回待确认，再取最后一张 pending 卡回填 planMessageId 与控制器步骤（planMessageId 不落盘），其余 pending 卡转只读。
  - 计划卡交互：**执行计划**（`planAction` execute，恢复工具并发起执行回合）/ **提出修改**（卡内反馈框，`planAction('revise', feedback)` 走发消息通道——模式保持 plan，修订回合结束自动挂新版卡）/ **放弃**；执行中扫 `[DONE:n]` 标进度，全完收卡；执行回合被中止/出错时在两面收口复位执行标志、卡退回待确认（保留已勾进度：GUI 在 host.finishTurn、调度在 runTurn finally），执行中切档同样落回待确认。卡片操作仅在 plan 档可用——非计划档（用户切走或恢复时档位不同）卡面只读并提示「切回计划档后可执行或提出修改」。Cursor 原生计划请求由其独立提问卡等待明确批准。
  - 纯函数沉淀在 `src/shared/planExtract.ts`（零依赖，test/plan-extract.mjs 覆盖）。
- 旧数据迁移：未开启「配置权限」的 GUI 会话有效模式为 `auto`，历史中的手动档位保留。开启后 Core 无 `guiMode` 时才按 `permissionMode` 迁移（acceptEdits→default、ask→ask、auto→auto；都没有→default）。冷历史与活跃回合使用相同的有效模式计算。

## Pi 默认模型与错误反馈

Muster Core connect 用工作台 `resolveLlmConfigWithReload` 解析服务商和模型，再同步到 GUI 和调度共用的 `userData/muster-core`；会话模型覆盖 > 模式钉模型 > 全局默认。预检沿用该优先级，未配置 Key、服务商禁用、Base URL 或模型缺失返回明确原因；预检不请求厂商网络。运行期 `agent_end` 的 provider 错误在 `agent_settled` 收口为 `error`，保留原始 401/402 等诊断；SDK 未附详情时补上模型标识与配置检查指引。

2026-10-03 的 test-pi 空正文实例实际是默认 DeepSeek 返回 402 Insufficient Balance，GUI 持久化消息已有 `assistant.error`。`sessions.observe({includeHistory:true})` 原来仅投影正文，终端检查因此看不到失败；现会附 `[error]` / `[aborted]` 文本并遵守原截断预算。余额不足仍需用户处理，宿主不自动换默认服务商。回归：`test/pi-driver-replay.mjs`、`test/pi-provider-errors.mjs`（真实 SDK + 本地成功/401/402 服务商 + 实际会话历史读取入口）。

## 切模型与上下文用量

- 切模型（2026-08-31 起**会话级**；P10 起 Catalog `sessions.setModel` / `setThinking`）：Composer 状态条的模型按钮 → `agentSession:setModel` 写 `SessionMeta.modelOverride`（**会话级覆盖，只影响本会话**，不动全局配置与其他会话）；Host 下回合 ensureConnection 按**生效模型**（Pi：会话覆盖 > 模式钉模型 > 全局默认；Codex：会话覆盖 > CLI 配置）比对快照，不一致即拆旧连接重建（历史经 resume token 续聊）；**idle 即时拆连，运行中不打断、下回合生效**。Claude 按 SDK 目录验证会话模型后重连；ACP、外部 Pi/OMP、Muse、ZCode 各按自身目录校验并重连。Pi 菜单提供「跟随全局」项，Cursor ACP 与 Codex 跟随各自引擎配置。Cursor/Codex 各读引擎目录，失败显示错误与刷新入口，不回落全局 LLM 列表。GUI Harness 已勾选模型同时是主进程准入白名单；默认模型不在白名单时使用目录顺序中的首个允许项，旧覆盖及下一回合也受校验，空白名单禁止启动。细节见 [GUI Harness 目录与接入](gui-harness-integration.md)。全局默认模型由设置页管理，只影响跟随它的会话；Codex 不消费该默认模型。调度面板切模型写本工作区 bucket 覆盖并**落盘 `agent-models.json`**（`orchestrator.switchModel` 不写全局；2026-09-16 起持久化——此前只存内存，重启静默回落全局默认，回归 `test/agent-model-selection.mjs`）。调度面板（AgentFloat）的消息也已接 `onFileLink`（模型自写路径可点，交文件面板闸口）。
- 上下文用量由各驱动报告。Codex 读取当前 thread/turn 的 `thread/tokenUsage/updated.last.totalTokens` 和 `modelContextWindow`。ACP 使用当前会话的 `usage_update`，Muse 使用 `session/contextUsage`。缺失字段显示未知。
- **重启恢复与模型切换**：Host 把最后已知的可靠用量写成转写 `lastUsage{tokens,contextWindow,ts}`，恢复时标 `stale`，详情展示最后更新时间；旧 Cursor 快照是回合用量，不再作为上下文恢复。驱动值统一校验为有界非负整数，未知窗口用 0；fork 种子 `ZERO_USAGE` 和种子回放期不持久化。在已打开会话切换模型时清除旧快照，并屏蔽旧连接迟到的用量，直到对应新模型连接就绪；`sessions.restartConversation` 也清掉快照。Grok 专有用量也过滤带子代理标记的更新，防止覆盖主会话统计。引擎运行期间的用量事件和外部 Pi 会话统计不属于 Harness / 模型目录探测，不触发自动刷新目录。

## 文件链接（五种形态 + urlTransform 根因）

**根因（2026-08-26 二次修复）**：react-markdown v10 的 `defaultUrlTransform` 只放行 http(s)/mailto 等白名单协议，`muster-file:`、`file://`、`E:\…` 盘符路径的 href 会被**清成空串**——渲染层拿到空 href 进不了文件链接分支，`target=_blank` 又把应用自身 URL 丢给 `setWindowOpenHandler` → `shell.openExternal` 在系统浏览器打开并报错（即「点了在网页打开」的原始 bug）。修复：`MarkdownBody` 传自定义 `urlTransform` 放行三类本地形态，其余走默认。

`AgentChatView.onFileLink` 接受四种形态：`muster-file:` href（linkify 产物）、`file://` URI、相对/绝对路径（模型自写的 markdown 链接 `[文件](src/foo.ts)`——MarkdownBody 对一切非 http(s) 非 mailto/tel 的 href 都交它处理）、**localhost 家族 http 链接**（2026-09-02：`http://localhost:5188/docs/a.md` 这类 dev/预览服务器 URL 由 `localFileFromUrl` 相对会话 cwd 映射为本地文件，磁盘级 stat 成功交给预览闸口、失败回退浏览器——解决「本地路径被当网络连接打开」）。文件形态不再各自预检存在性，统一交 SideToolsPanel 打开闸口：工作区内存在直接开；找不到时仅完整路径做磁盘级判断，存在即**外部只读预览**（见 [files-panel.md](files-panel.md)「打开闸口与外部只读预览」）。被清空的 href 渲染成纯文本（不留死链接）。主进程 `setWindowOpenHandler` 只放行 http(s) 兜底。

**链接类型图标（2026-09-04）**：三类文件链接分支统一走 `MarkdownBody` 的 `FileLink` 组件——从 href 解析基名（带扩展名才配图标），前置 `FileTypeIcon` 类型徽标（`shared/filePreview.fileIconKindForPath` 分类：代码/配置/Markdown/图片/音视频/PDF/Word/表格/幻灯片/压缩包/字体，固定类型色 `.fti-*` 见 markdown.css）；工具卡的可点击路径（`ToolVisuals.ToolTitleTarget`）同样前置图标。聊天与文件面板 md 预览共用同一组件，实测截图见 [file-preview.md](file-preview.md)。

会话区**划词**（划词浮条的路径/链接判定）与链接点击同源：`.chat-list` 容器带 `data-sel-cwd`（会话 cwd），SelectionMenuHost 划词时就近读取，其它 DOM 区域仍用工作区根。识别规则（含空格路径的 stat 回退、域名护栏）统一见 [text-entity-recognition.md](text-entity-recognition.md)。

**行内代码路径（2026-08-26 同批修复）**：linkify 原实现把链接包进反引号内（`` [`x`](href) `` 整体在 code span 里），react-markdown 不解析 code span 内的 markdown → 显示字面 `[README.md](muster-file:README.md)` 源码。修复：候选两侧成对反引号时把替换范围扩到含反引号，包成 `` [`README.md`](href) ``（链接标签内嵌 code span：保留代码观感且可点）；同时修幂等（href 内 `muster-file:` 前缀与 `[`x`](…)` 形态不再二次包装）。行为由 `test/linkify-paths.mjs` 锁死。

调度面板（AgentFloat，2026-09-05 起）也已接 `onFileLink`：模型自写的相对/绝对路径与 `muster-file:` href 交文件面板闸口打开（相对路径按当前工作区根解析）；调度消息不走 linkify，可点的是模型自己写的 markdown 链接。

**消息图片大图（2026-09-05）**：缩略图点击开 `ImageLightbox`（复用 mermaid 查看器的滚轮缩放/拖动平移/Esc/适应窗口骨架与数学）——此前 `window.open(data:)` 被主进程 setWindowOpenHandler 一律 deny，是死交互。

## 宿主说明随首条引擎输入投递

`materializeGuiWorkerPrompt` 先介绍 Muster 如何托管会话及 Harness 如何执行模型回合，再给出当前 Worker 或子代理身份、Muster 会话 ID 和目录范围。单根共享目录将源根、工作目录及读写范围合并一行。多根和隔离场景展示各源根、目录权限和映射。其后给出实际注册工具的协作提示和全局行为规约。Pi 加载项目指令时，逐字相同的规约沿用项目指令中的副本。Host 仅在完整说明待投递时给 GUI Harness 提供 `firstPromptPrefix`（沿用字段名），各 driver 用 `<muster_host_context source="automatic">` 与 `</muster_host_context>` 包住说明，再通过 `appendGuiHostContext` 以空行分隔附在用户消息之后，用户正文原样保留。宿主按发送文本末尾的完整说明及引擎回执确认投递，重连和冷启动续聊均跳过完整说明。Pi 系列将原生命令和模板的斜杠输入原样交给引擎，首条说明随下一条普通输入投递。分叉上下文、后台摘要、派活、交接、审批反馈、过期读取提示和交互选择按需沿用同一标记，逐轮记忆召回保持原有位置。回执与恢复规则见 [GUI Harness 接入](gui-harness-integration.md)。

从新建任务直接启动时，派活契约和完整任务文本走 `AgentSessionHost.send`，和打开空白会话后发送消息共用同一套聊天转写和引擎投递。GUI 定时任务同样在首条消息前加契约；空会话及旧首信恢复不追加。已注册轮次文件登记工具时，GUI 首条宿主说明提醒 Worker 在审阅可能漏检的文件改动前后登记准确路径，用法见 [轮次文件改动](turn-checkpoint.md)。

调度直接或经父 Worker 派活时，调度有权调整范围、验收口径及实现细节，任务疑问通过 `host.mail.send` 发给调度或父会话，无需向用户确认这些调整。合入、推送、发布、凭据修改、数据删除和对外发送仍需用户明确批准；现有用户指令和工具权限不因契约改变，隔离树 `requestIntegrate` 仍在用户明确批准后调用。契约以调度派活为条件，因为桌面用户也可直接创建任务；详情见 [Worker 创建与任务投递](worker-inject.md#调度权威与不可逆动作边界)。

已注册 `host.sessions.create` 时，首条宿主说明提示 Worker 可把独立子任务交给子代理，传 `asSubagent: true`、`task` 和显式 `isolation`。可用 `inherit: true` 沿用父会话启动设置，也可传 `target: {targetRef}` 选择具体 Harness 和模型。「完全访问」的 Muster Core 父会话可在当前来源使用精确引用启动跨 Harness 子代理。完整创建用法见 [Worker 创建与任务投递](worker-inject.md)。

宿主说明按实际注册的工具提供状态上报、邮件、隔离交付和记忆等调用提示。项目指令由各 Harness 自己加载，工具参数随注册定义提供。模式 persona 和扩展提示、记忆与模式钩子按各自入口运行。目录快照通过 `cwd` 和源根 ID 引用已列出的路径，可读写范围、额外只读范围及隔离映射各自列出。全局行为规约从设置读取并原样附加。默认聊天气泡显示发送的正文（任务首信包括派活契约前缀）。开启 [Harness 透明](trajectory-view.md) 后，用户气泡直接显示 driver 提交的完整文本，图片继续使用附件视图。

传统 CLI 随启动简报取得宿主说明，可从原生 MCP 或带会话令牌的本地接口取得工具定义。详见 [Worker 创建与任务投递](worker-inject.md)。

## DSH（已移除）

DSH（DeepSeek Harness）GUI runtime 于 **0.1.21（2026-09-11）整体移除**：打包链路对 @deepseek-ai 全家 peer-only 依赖的处理反复出现「dev 正常、打包版子进程 ERR_MODULE_NOT_FOUND」，0.1.5-rc.2 升级虽解决依赖分类问题，但引擎侧 API（bin 停发/流式通道重构/user-questions waterfall）与打包验证成本仍高，产品收敛到 Pi/Cursor 双 GUI runtime。移除内容：`drivers/dsh/**`（driver/composition/bridge fork/presets/traceMap/modelInjection/harnessEnv）、`listDshPresets`/`setDshPreset` IPC、`SessionMeta.dshPresetId`、composition 生成与 junction；`win32/hide-console.cjs`（Windows 隐藏控制台预加载）留用迁移到 `drivers/win32/`（Cursor worker 消费）。恢复可从 git 历史（0.1.20 tag 前后提交）找回。userData 里旧 dsh 会话数据保留但不可再发起；registry 合并时自动清除 dsh 条目。

## Cursor（GUI，ACP）

Cursor 使用 ACP 原生目录与模式确认。注册身份是 `runtime=acp`、`piModeId=cursor`；由本机 `cursor-agent acp` 管理账号和原生工具。宿主工具经 MCP 网关。

Cursor 原生问卷和计划批准使用工作台提问卡，取消与迟到应答不会通过。续聊依赖 CLI 的 `session/load`；失败保留历史并明确提示，不自动建立空会话。旧 SDK 会话只保留历史，不迁移原生上下文；旧 SDK 配置和存储不会由 ACP 使用或主动删除。协议详情和验证边界见 [ACP GUI driver](acp-gui-driver.md)。

## Claude（GUI，@anthropic-ai/claude-agent-sdk，T2.1 骨架）

`claude` 与 PTY 的 `claude-code` 是独立 runtime。主进程使用 Claude Agent SDK 并管理其子进程，鉴权和模型使用用户自己的 Claude 配置。静态预检只确认程序和配置文件线索，不以缺少文件断言未登录，也不以存在文件断言认证有效；原生 SDK 后续反馈实际错误。工作台不再提供 GLM/MiMo 的 Claude 服务预设；用户在 Claude Code 自行配置的模型服务仍跟随其原生配置。

GUI 会话和模型发现统一使用 `process/controlledChild.ts`：同步返回 SDK 所需的 stdio Child，实际 CLI 等 Windows Job 或 macOS/Linux 进程组建立后才启动。回收依赖创建时持有的容器，CLI 自然退出也不会丢失对后代的归属。关闭连接先等待容器清空，再关闭输入和 SDK；流结束与显式关闭共享回收操作，失败仍向宿主回收屏障传播。POSIX 主动脱离进程组的后代不在该容器边界内。

旧实现先结束 prompt 输入，再对活 PID 执行 `taskkill`；CLI 提前退出会让回收落入 PID 失效窗口。`waitFor` 到点后虽已写入续接消息，下一回合仍可能被旧连接回收失败挡住；这是引擎生命周期故障，不能把历史里出现续接消息视为模型已经开始执行。新路径不通过忽略 `taskkill` 非零退出或猜测 PID 状态释放屏障。

### 关键文件

```
src/main/agentSession/drivers/claude/
  driver.ts        ClaudeRuntimeDriver：流式 prompt 回合模型 + 生命周期
  models.ts        无推理提示的 SDK 模型发现、身份校验、进程回收和持久快照
  claudeSdk.ts     SDK 动态加载 + 可注入缝（ClaudeQueryFn/Handle）+ claude 可执行文件解析
  streamMap.ts     SDK 消息 → GuiDriverStreamEvent（纯函数）
  canUseTool.ts    SDK canUseTool → 决策表 + 审批卡 + 超时 Deny+interrupt
  hostTools.ts     宿主工具进程内 MCP 注册（createSdkMcpServer + tool()）+ 决策表门控
  env.ts           spawn env 清洗（剥 ANTHROPIC_/CLAUDE_ 前缀，保留 CLAUDE_CONFIG_DIR）
test/claude-driver-replay.mjs   事件回放（npm test）
test/claude-driver-owned-process.mjs  真实离线 CLI/后代：自然退出、并发关闭、取消、初始化和回收失败
test/claude-can-use-tool.mjs    决策表全档位×工具类 + 假审批/超时
test/claude-sdk-smoke.mjs       在线冒烟（EXCLUDE；T2.0 产物，覆盖 driver 依赖的 SDK 真实行为）
test/integration/claude-driver-owner-live.mjs  显式真实 SDK 握手/关闭验证，禁止提交推理提示
```

进程回归可用 `node test/claude-driver-owned-process.mjs --driver-ref=<旧提交>` 将旧 driver 只编译进临时测试目录，验证旧行为转红，不恢复共享工作区源码。真实 SDK 探针使用隔离 cwd/userData，禁用 hooks、工具和原生会话持久化，验证两个流式连接的握手、并发/重复关闭及 SDK 空闲闭流；它不代表真实模型回合、完整 GUI 或其他平台真机验收。

### 回合模型与产品形状（与 Pi/Cursor 的差异）

| 项 | 行为 |
| --- | --- |
| 回合模型 | 一条连接 = 一次 `query()`，**流式 prompt**（`AsyncIterable<SDKUserMessage>` 常驻 claude 子进程）：`send` 推一条用户消息、回合以 `result` 消息收口；子进程崩溃收口错误连接，下一条 send 经 resume token 自动重连 |
| 中途插话 | `redirect` 不宣称真 steer；普通消息由原生队列接收，优先消息请求中断并在回合收口后投递 |
| 停止 | `Query.interrupt()`；中止后的错误 result 静默收口（不弹错误横幅） |
| 鉴权 | spawn 前剥全部 `ANTHROPIC*`/`CLAUDE*` env（`CLAUDE_CODE_CHILD_SESSION` 会静默关 transcript 持久化——wmux 实证坑）；`CLAUDE_CONFIG_DIR` 保留（用户指定的配置根是共享语义的一部分）；缺省共享用户 `~/.claude`（T2.0 §2：settings.json 的 env/hooks 会穿透，这是「复用用户登录/中转」的特性面） |
| 宿主说明 | `firstPromptPrefix` 随会话首条适用输入投递，由宿主记录回执。引擎基底走 `claude_code` preset |
| 权限 | 关闭配置时，SDK 使用原生 `bypassPermissions` 及对应启动许可；开启后使用保存的原生模式或引擎默认。在线选项切换走 `Query.setPermissionMode`，`system/init` / `system/status` 更新生效值，需改变启动许可时空闲重连。收到 `canUseTool` 请求时，关闭配置自动允许，开启保留 SDK 授权建议与作用域供用户选择；实际宿主工具调用另过网关 |
| 宿主工具 | Worker 常驻清单（含 browser.run、bgtasks；R5 后无发现层）经 **SDK 官方进程内 MCP 通道**（`createSdkMcpServer`+`tool()`，server 名 `muster`，点号→下划线，引擎侧名 `mcp__muster__sessions_setStatus`）；工具 handler 内过与 Cursor customTools 同一套 `decideToolCallPermission`（default 的日常 shell 自动执行，ask/plan 探索按只读门限制，用户显式规则仍有效）；目录列引擎实际名（`hostToolNamePrefix`），与 `tools/registry.ts` 注册面同源。原生 `AskUserQuestion` 禁用（headless 下必自拒）；**`host.ask` 经同一 MCP 通道接入工作台提问交互**（与 Core/ACP 共用）。**pty CLI 入站 stdio MCP**（同一 server 名、白名单子集、写引擎配置前 TOFU）见 [inbound-mcp.md](inbound-mcp.md) |
| 用户 MCP | B2 起不注入：`options.mcpServers` 只装宿主 `muster` server（`strictMcpConfig: true` 保留，原生 CLI 配置不加载）；第三方工具经宿主中转 `mcp.search`/`mcp.call` |
| 模型菜单 | `supportedModels()` 无提示词读取用户 Claude 可用模型；选定模型经当下目录验证后写会话覆盖，切换按原生 resume token 重连。思考强度只展示该模型声明的 `supportedEffortLevels`，通过 `options.effort` 在重连时生效；默认模型身份未知时不猜档位。不提供 GLM/MiMo 专用服务配置 |
| fork | Claude、GLM 和 MiMo 使用 transcript 前缀创建分支。Claude SDK 0.3.272 复制会话时会重映射消息 UUID，压缩元数据保留原消息引用，公开历史接口无法完整核查这些记录。 |
| 图片 | 支持（Anthropic image 块） |
| 用量环 | 主代理最近一条消息的输入、缓存读写与输出用量；`result.modelUsage` 只提供匹配模型的窗口上限，累计 token 不作为当前占用 |
| 事件面 | 工具/思考/正文同其它 driver（cursor 暂无计量 summary/插话事件——透明模式 Pi 专属） |

### 打包（与 dev 差异）

- SDK 的 JS 包随应用分发。平台 CLI 排除规则位于 `electron-builder.yml`。设置预检、模型发现和 GUI 会话先按宿主的 PATH 找本机 Claude，再查 `~/.local/bin` 与各平台常见安装目录。macOS 检查 Homebrew，Linux 检查系统 bin，Windows 检查 WinGet 和用户 npm。Windows 的 npm shim 解析到该安装的原生 exe 或旧版 JS 入口。模型发现和会话用 `pathToClaudeCodeExecutable` 将绝对路径传给 SDK。找不到本机 CLI 时，开发版回退到 SDK 平台包，打包版显示安装指引。自定义安装目录可加入工作台启动环境的 PATH。
- `@anthropic-ai/sdk`（peer）显式进 dependencies：traversal 收集器只走 deps/optionalDeps，不显式则打包版动态 import 解析不到。

### 已知边界

- **计划档不再切 SDK `plan` 模式**：写工具由 canUseTool 按探索/执行态 deny 或放行；若模型仍调用 `ExitPlanMode`，Host 照常捕获。原生「只读+提交计划」工具面不再由 SDK 锁死。
- **引擎侧数据不清理**：purge/sweepOrphans 刻意不实现——共享用户配置目录下引擎落盘就是用户自己的 claude transcript，宿主无权删；会话级隔离目录（T2.4 设置档）落地后再补。
- 订阅鉴权形态（Pro/Max OAuth）本机无登录态无法实证（T2.0 §2）；`CLAUDE_CONFIG_DIR` 指空目录时确定性报 `Not logged in · Please run /login`，可作未配置鉴权检测信号。
- 无原生问卷工具：`AskUserQuestion` 禁用；选择题经 MCP `host_ask` 进入工作台的 `UserQuestionCard`。

### 冒烟

- 离线：`test/claude-driver-replay.mjs`（假 SDK 回放 + 状态四件套/bgtasks 注册面 + canUseTool 审批）；`test/claude-can-use-tool.mjs`（决策表全档位×工具类）；`test/gui-host-mcp-catalog.mjs`（注册面与系统提示目录一致性）
- 在线：`test/claude-sdk-smoke.mjs`（EXCLUDE）；`test/claude-driver-smoke.mjs`（EXCLUDE；含进程内 MCP 调 `sessions.setStatus`）

### ACP（T5.2）

JSON-RPC NDJSON over stdio 子集（[ACP 协议](https://agentclientprotocol.com/)）。一个 runtime `acp`，agent 用会话 `piModeId`（`opencode` / `gemini`）。详见 [acp-gui-driver.md](acp-gui-driver.md)。

| 项 | 行为 |
| --- | --- |
| 回合 | `session/prompt`；`redirect` 恒 false → Host 入队。握手 initialize / session/new / load 有 30s 超时；close 等在飞 prompt 收口上限 10s（agent 不响应 cancel 时强制清理，不再挂死会话关闭） |
| 停止 | `session/cancel` |
| 续聊 | ACP sessionId 作 resume token；支持 `session/load` 则先 load |
| fork | OpenCode 的 ACP 回合若提供可核对的原生消息 ID，使用 OpenCode HTTP 接口按所选消息分叉并回读校验；其他 ACP 引擎、旧消息或无法确认截点时使用 Host transcript 前缀，详见 [GUI Harness 接入](gui-harness-integration.md) |
| 权限 | ACP 的原生设置及审批按当前版本实际声明协商。审批卡显示原始选项，返回对应 optionId；无匹配安全答复时返回取消或协议错误。宿主改写无法经该通道传回引擎时拒绝该请求 |
| MCP | `session/new.mcpServers`：B2 起只注入宿主 stdio `muster` shim；用户 MCP 不再按 `acp:<presetId>` 过滤注入（经宿主中转 `mcp.search`/`mcp.call`），initialize 的 mcpCapabilities HTTP 协商随之退役 |
| 斜杠 / 模式 | `AvailableCommands` → 斜杠菜单；`CurrentMode` → 状态条 chip |
| 鉴权 | 不代填 Key；CLI 未 login 时引导跑厂商自己的 login |

斜杠菜单对 ACP 下发的描述和参数内容保留原文，只翻译宿主追加的参数提示外壳。

- 离线：`test/acp-stream-map.mjs`、`test/acp-slash.mjs`、`test/acp-driver-replay.mjs`
- 在线：`test/acp-driver-smoke.mjs`（EXCLUDE）

## Codex（GUI，隔离进程中的 app-server）

聊天 runtime `codex-gui` 使用受管 worker 与原生 app-server，每回合启动进程并恢复 Codex 线程。模型和登录由用户 Codex CLI 管理。PTY runtime `codex` 使用独立终端入口。

隔离任务保留源目录登记，由连接快照把执行 cwd 定位到对应 worktree。app-server 启动、`thread/start`、`thread/resume` 与 `turn/start` 都传入该目录。若 Codex 回报的有效 cwd 与登记任务目录不符，宿主在提交回合前报错。文件策略与后台命令的相对路径以执行 cwd 为基准。见 [隔离 worktree](isolate-worktree.md)。

每个 Codex 原生回合使用新的宿主 MCP 网关令牌；旧进程的迟到请求不能借用新回合。GUI 网关在收到请求时绑定执行回合，桌面调用还绑定桌面指令代次；回合变化时拒绝尚未完成的旧请求。令牌轮换仅约束宿主 MCP 网关，不能限制引擎自行使用的原生工具。

### 关键文件

```
src/main/agentSession/drivers/codex/
  driver.ts           CodexRuntimeDriver
  executable.ts       用户 Codex CLI 发现，处理 PATH 与 Windows npm shim
  protocol.ts         Muster 使用的回合、输入和事件类型
  workerProcess.ts    原生 worker 资产定位与子进程身份校验
  appServerTransport.ts + appServerEvents.ts  app-server 权限档的 JSON-RPC、请求归属、审批/提问和事件投影
  worker/native-worker.mjs  受管 Codex app-server 子进程桥
  processSupervisor.ts 回合结果与资源状态、独立停止与有界回收
  ../../process/windowsJob.ts + worker/windows-job.ps1 Windows Job Object 分配、清空确认
  models.ts           本机 app-server 模型目录 / config/read 兜底 / 缓存与超时
  hostToolsMcp.ts     宿主工具经 mcp_servers.muster（stdio MCP shim + 网关）
  streamMap.ts        CodexThreadEvent → GuiDriverStreamEvent
  nativeConfig.ts     原生 profile、审批策略、审核人、协作模式目录及生效状态
  env.ts              剥 CODEX_INTERNAL_ORIGINATOR_OVERRIDE；复用 utf8ChildEnv，补 Python UTF-8 默认环境并保留用户显式值
test/codex-driver-replay.mjs   事件回放（npm test）
test/codex-driver-lifecycle.mjs   原生 app-server 夹具，覆盖退出、排队、停止与跨连接互斥
test/codex-ask-question.mjs    问卷 mcp_servers 注册 + 网关回填
test/codex-approval.mjs        映射表 + 引擎工具分类/决策表
src/shared/codexModels.ts     模型目录归一化与配置模型抽取
test/codex-models.mjs         目录、建线程与回合 RPC 夹具
test/unit/codex-model-menu.spec.tsx   实际适配器与 Composer 交互
test/e2e/codex-model-menu.spec.ts     Electron/preload/IPC/app-server 全链路
```

### 回合模型与产品形状

| 项 | 行为 |
| --- | --- |
| 回合模型 | 每次 send 启动受管 app-server 并恢复线程。resumeToken 是原生 thread ID |
| 中途插话 | `redirect` 恒 false（stdin 已结束）→ Host 入队 |
| 停止 | 向独立 worker 发送取消，由公开 AbortSignal 取消 SDK；外层独立清空资源容器，不依赖事件流返回。Windows Job 与 worker 退出均确认后才能续发 |
| 政策层 | 会话首条适用输入前缀，恢复同一会话时沿用投递状态 |
| 权限与协作 | app-server 的原生 profile、approvalPolicy、approvalsReviewer、collaborationMode 分别保留。新建与恢复读取实际状态，空闲修改在下回合提交。审批请求及原生状态通知按线程、回合关联 |
| 宿主工具 | **Worker 常驻宿主入口经 `config.mcp_servers.muster` 注册**（B1b/T2.3：0.154 无 createSdkMcpServer，走 ACP 同款 stdio MCP shim + HTTP 网关；目录与政策层清单同源，不再虚列；R5 后即常驻清单 ∩ preset，无发现层）。工具执行在网关侧过三档决策表（default 的日常 shell 自动执行，只读门及用户规则仍生效）；`bgtasks.shell/wait/list/kill` 一并开通；`askQuestion` → UserQuestionCard、`requestApproval`（自愿审批档）→ 审批卡 |
| 用户 MCP | B2 起不注入：`config.mcp_servers` 只装宿主 `muster` 条目（stdio MCP shim + 网关）；用户 MCP 按 target 过滤注入与「托管 `enabled:false` 屏蔽原生继承」分支均已删除（原生 CLI 配置不由 GUI 侧托管）。第三方工具经宿主中转 `mcp.search`/`mcp.call` |
| 模型菜单 | 本机 CLI 目录。会话覆盖经 `thread/start` 或 `thread/resume` 及 `turn/start` 的 `model` 传入。清除后省略 model，跟随 CLI 默认 |
| fork | 完成回合记录原生 turn ID，使用 `thread/fork(lastTurnId)` 按 assistant 消息截取；无映射或不支持时使用文本回退 |
| 图片 | 支持：base64 落临时文件后走 SDK `local_image` path |
| 引擎侧数据 | 不 purge：`~/.codex/sessions` 是用户自己的 transcript |

回合终态在该轮 worker 及资源容器确认释放后发给 Host。`turn.completed` / `turn.failed` / `error` 只记录单轮结果，正文与工具结果仍实时投递。进程监督器确认 worker 退出及整轮资源容器清空后，driver 才清理资源、释放 writer 并允许 Host 派发下一条。每轮独立持有流去重状态、AbortController、结果与收尾 Promise，退出尾部错误只归属本轮。`abort()` 等待本次回收尝试结束（成功或明确失败），`close()` 仍等待资源实际释放，关闭期间拒绝新 send。跨连接 writer 由进程内 `Codex home + thread ID` 互斥表协调，覆盖 Host fire-and-forget 重建。等待者可单独停止，不同 home/线程保持独立。app-server 档只处理能绑定到当前会话和回合的审批及问卷，无法确认归属的子线程请求保守拒绝。外部应用占用线程时保留原生 ID 并返回实际错误。原始复现见 Codex 专项核查。

工作台直接启动选中的 Codex app-server 并执行 RPC，校验 `codexHome`、线程标识和实际权限。测试中的陌生版本与缺失 `userAgent` 响应都可继续发送，原生请求失败时显示其错误。此前在 Windows 使用实际 Codex `0.167.1`，经工作台受管传输完成了真实握手、权限生效确认和两轮发送。第二轮恢复原生线程并携带首轮上下文。测试使用隔离 Codex home、回环模型和 MCP 替身。远端模型、安装包及 macOS/Linux 真机待验。 [OpenAI Docs](https://learn.chatgpt.com/docs/app-server#message-schema)

app-server 档暂不支持 MCP elicitation 或密文原生问卷，这类请求返回取消或空答案。命令输出片段仅在对应工具开始事件之后投递，早到片段丢弃并记日志。确定未提交消息时保留首次政策前缀；`turn/start` 写出后失败标记为投递状态未知，不自动重发。

会话级思考强度已接入 [通用模型参数](model-parameters.md)：Codex adapter 从所选模型的原生目录保留支持档位和默认值，每轮在 `turn/start.effort` 传入 Host 冻结的 `reasoning`。清除覆盖不传 effort，沿用 CLI 配置。共享 Host/UI 不识别 Codex 原生字段，也不固定五档。旧 `thinkingPolicy=unsupported` 仅控制旧 Pi 思考 IPC，通用参数走独立描述合同。

容量错误 `Selected model is at capacity. Please try a different model.` 来自 Codex 引擎；原始 rollout 的 `event_msg/task_complete.error.codex_error_info=server_overloaded` 可确认模型服务过载。driver 保留原始错误，并在 exec 异常收口时追加「下一条消息会自动 resume 续聊」：这只说明下次发送恢复原线程，不自动重试、不自动换模型，也不保证服务恢复。用户可在本会话模型菜单换模型后发送继续，或稍后重试原模型。排查时对照 `userData/logs/main.log`、`sessions.json` 的 `runtimeResumeToken` 与 `~/.codex/sessions` 对应 rollout 的 `turn_context.model` / 回合错误；不要仅凭模型目录或当前 config.toml 推断失败回合的模型。参见 [官方模型过载说明](https://developers.openai.com/api/docs/guides/error-codes)。

### 模型目录与会话覆盖

目录读取调用本机 Codex CLI 的 `app-server`，按 initialize → initialized → config/read → model/list 读取并分页。选择器展示可见条目，使用原生 `model` slug。`codex:listModels` IPC 按会话 ID 找 cwd，仅返回模型名称/说明、支持的参数描述与默认值，不把配置凭证传到 renderer；不维护硬编码模型清单。协议依据：[官方 app-server 模型目录说明](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)。

普通读取使用注册源目录与 CODEX_HOME 对应的持久快照。手动刷新按 CLI、cwd、CODEX_HOME 与配置或鉴权身份合并并发查询，读取完关闭进程，无需发起推理回合。枚举不支持或目录为空时，优先保留该来源上次成功的原生快照，并提示本次仅取得本机配置。`config.toml` 顶层 `model` 和 `profiles.*.model` 中缺少原生条目的模型会以 ID 补入目录，思考档位标为待确认。连接、JSON、超时与分页错误会反馈给调用方。

选择落盘到 SessionMeta，重挂恢复；忙时不打断当前回合，下一回合按新模型重连并 resume 原线程。清除覆盖时省略 `model`，由引擎自身配置决定。目录刷新仍由用户显式触发；全局 LLM 切换不会拆 Codex 连接。目录可能来自 CLI 内置或缓存，**列出模型不保证账号拥有推理权限**，实际错误由原生回合反馈。

### 打包

- 原生 app-server 由独立的 `ELECTRON_RUN_AS_NODE` worker 启动，worker 脚本解包到真实目录。GUI 预检、模型目录、会话与内置原生终端共用 `drivers/codex/executable.ts` 的本机 CLI 发现。优先使用宿主启动环境里 PATH 上的 CLI，跳过工作台开发依赖目录。Windows 的 npm `.cmd` 路径能解析为原生 exe 时使用 exe。PATH 未命中时检查用户独立安装和系统安装位置。
- macOS 识别 `~/Applications`、`/Applications` 下 ChatGPT/Codex 应用内的 CLI，也检查常见 Homebrew 和系统 bin 目录。Windows 检查独立安装位置及 `%LOCALAPPDATA%\OpenAI\Codex\bin` 中桌面版已经解包的版本，优先使用可访问的较新目录。Microsoft Store 安装若尚未解包，先启动桌面版完成初始化，或安装独立 CLI。Linux 查本机独立 CLI，包括 `~/.local/bin` 和系统 bin。安装在其他位置时，把 CLI 所在目录加入 Muster 启动环境的 PATH。
- Codex 检测只验证本机程序可访问。账号和模型仍由 Codex app-server 返回。在设置中点击「重新检测本机」可更新安装状态，Codex 的「可用模型」可刷新原生目录。macOS 使用最小 PATH 实测识别了 ChatGPT 随附的 Codex 0.169.1，两款 GPT-6.2 均返回六个思考档。

### 冒烟

- `test/codex-driver-replay.mjs`、`test/codex-approval.mjs` 和 `test/codex-models.mjs` 使用离线夹具。组件与 Electron 目录用例覆盖刷新失败、选中、持久化、恢复默认和原生回合参数。离线子进程夹具核对 `thread/start`、`thread/resume` 和 `turn/start` 的模型与思考档字段。
- 本机 CLI：0.159.2 的只读模型枚举已验证；真实订阅/API 推理人工验证（装好并登录 `codex` 后创建 Codex（GUI）会话发一条消息）。

- **Cursor 连接生命周期（2026-08-31 加固 / 2026-09-05 补强）**：
  - **worker 崩溃自愈**：子进程 exit → driver 以 `queue.fail` 终止事件流 → Host 收口回合并丢弃连接，下轮 send 经 resume token + 本地存储重连（错误文案已带「下一条消息会自动重连恢复」指引）。
  - **connect 失败回收**：ready 超时（杀子进程）/create 报错时 `proc.close()`，不泄漏 Node 进程；`create` RPC 60s 超时兜底；worker 启动期 `event:'error'` 带～真实原因 reject。
  - **customTools 过权限决策表（2026-09-05）**：`bgtasks.shell` 等宿主工具与引擎原生工具同一套三值门控（此前完全绕过，default 档零审批、plan 探索态可跑任意命令）。
- **RPC 超时**：`abort` rpc 10s 超时后杀 worker（SDK 内部挂死时用户仍有逃生通道）；`send` 不设超时（长回合合法），迟到应答写入已断管道被丢弃（stdin error 兜底 + closed 检查，无 EPIPE 崩溃）。
- **env 透传**：worker 子进程继承代理与企业 CA 变量（`*_PROXY`/`NO_PROXY`/`NODE_EXTRA_CA_CERTS` 等）。

## 已知边界

- **空转回合守卫（2026-09-25）**：引擎无任何输出即收口的回合不再静默——assistant 会标错误并指引设置页「检测」（详见 [runtime-preflight.md](runtime-preflight.md)）。有产出/用户主动停止的回合不受影响。
- Pi 图片附件依赖模型 input 含 image（deepseek 文本模型发送即报「不支持图片输入」）。
- Pi 原生分叉保留截点之前的原生条目；回退种子只回放 user/assistant 正文，不包含工具调用。
- 合成 diff（无 patch 时）行号占位、无上下文行——只作可视化，非可应用补丁。
- Pi resume token 找不到会话文件时降级同 id 新建（Pi 懒落盘，勿 brick）。
- GUI 聊天 CDP 驱动：`test/gui-chat-cdp.mjs`（需 dev + `MUSTER_DEVTOOLS_PORT=9333`；已 EXCLUDE）。离线测试覆盖 prompt/策略/路径/registry/**parts 模型**五组（`test/gui-worker-*.mjs`）。

GUI会话外壳 `.agent-chat-view` 顶部保留4px内边距（agent-chat.css），正文与滚动区域从内侧开始，底部输入栏位置保持原布局。

## 操作等待反馈

新建会话在 NewTaskDialog 的操作区域显示一个品牌加载动效，失败/排队/创建完成后结束；冷连接包含在发送确认的等待期，不使用整个回合 busy 维持动画。 组件与场景清单见 [品牌加载动效](brand-loading.md)。

## Codex 回合结果与进程生命周期

`shared/executionLifecycle.ts` 分开描述模型结果（pending/completed/failed/aborted）与资源状态（starting/running/draining/stopping/reclaiming/reclaim_failed/released）。状态携带本轮 UUID、递增 revision、PID，以及终态、stdout 关闭、进程退出、停止请求的时间。每次状态变化写宿主日志，绑定宿主 sessionId；不记录 prompt、环境变量或密钥。

- `drivers/codex/workerProcess.ts` 处理 worker 资产定位与身份校验。`worker/native-worker.mjs` 启动本机 `codex app-server`，通过 stdio 转发有界 JSON-RPC 消息。
- `processSupervisor.ts` 分开等待 worker exit 与资源容器清空确认。模型终态或 worker EOF/exit 后有限收尾（10 秒）；正常生成、工具和审批静默时没有该期限。停止取消本轮等待并回收容器；每次回收有界，失败推 reclaim_failed、保留 writer，可重试。终态没有送达时仍能手动停止，不从正文或 transcript 猜测模型完成。
- Windows：worker 先等待 run 指令；`windowsJob.ts` 启动 `windows-job.ps1` 持有 Job Object，先设置 KILL_ON_JOB_CLOSE 并将 worker 加入，再允许 worker 启动 CLI，后代自动继承 Job。正常完成、停止或崩溃均用 TerminateJobObject 清理，并 QueryInformationJobObject 确认 ActiveProcesses=0，再等待 worker exit。仅 worker 消失、超时、管道关闭或回收命令返回都不能解除占用。分配失败时不运行 SDK；guardian 意外退出未确认清空时保留失败态，不能伪造成功。guardian 正常回收失败可在持有同一 Job 的情况下重试。
- POSIX 使用独立进程组，回收后探测进程组消失再释放；主动脱离进程组的外部服务不在该边界。Windows Job 不允许本轮子进程主动 breakaway；有意常驻的宿主服务须由外部宿主启动，不能依赖本轮 CLI 子进程存活。
- 回收保留已完成模型结果；回合结束前的进程错误会反馈给宿主。回合可复用的唯一条件是资源释放证据成立，无按进程名查杀或仅杀父进程的降级路径。
- Driver 推 execution 事件，Host 保存并通过 `agentSession:event` 与 getHistoryRange 传递；起新轮清掉旧状态。Host 拒绝在资源未 released 时 finishTurn，因此排队消息不能抢占旧 writer。跨连接互斥仍按 Codex home + thread ID，等待者取消不杀占用者。
- Renderer 的 execution 独立时钟防止迟到 history 覆盖实时状态；ChatSurfaceSnapshot 仅透传，**不做任何用户可见展示**（2026-10-19 用户裁决：执行生命周期不得被用户感知，收尾/停止/回收/失败只留在宿主日志，`ExecutionStatus` 组件与占位文案已移除）。Composer 的 busy 发送/排队安全门不受影响。取消回收已完成回答不把回答标成 aborted。

回归：`codex-driver-lifecycle.mjs` 覆盖受控原生 app-server 的终态、EOF、提前退出、回收失败重试、恢复续聊及跨连接互斥，以及 Windows 子孙进程清空、worker 退出后仍需回收确认；管道异常采用真实进程加受控管道。`gui-host-lifecycle.mjs` 验证状态历史、拒绝提前完成及队列释放。`chat-state-race-u1.spec.tsx` 验证历史竞态；`codex-execution-lifecycle.spec.ts` 用隔离 Electron 和受控 CLI 验证真实 IPC 链路。真实 Codex 服务端卡死现场仍不可重现，运行时状态不从旧 transcript 推断。

### 历史 SDK 生命周期接口核查（2026-10-18）

当时安装的 `@openai/codex-sdk` 为 0.163.0。其 `TurnOptions.signal` 是公开取消入口，`run` / `runStreamed` 均可传入 AbortSignal；`CodexOptions` 的 codexPathOverride、env、config、configOverrides 也是公开配置。公开 Thread 不提供 PID、ChildProcess、waitForExit、强制进程树回收或自定义 spawn 注入。`events.return()` 是异步生成器接口，不能抢占正在等待的 next。

本地源码 `node_modules/@openai/codex-sdk/dist/index.js` 将 signal 传给 spawn，先消费 readline，再等待 exit；finally 调用 child.kill，没有有界收尾和独立的退出确认 API。核对官方仓库 main 的 exec.ts / turnOptions.ts / codexOptions.ts，仍存在相同边界；main 不代表已发布版本。

本地受控 Node 进程探针 `.tmp/sdk-public-api-probe/probe.mjs` 使用真实 SDK 和公开 codexPathOverride/signal：收到 turn.completed 后 abort，普通场景约 3ms 返回 AbortError，进程已退出；pending next 时调用 return，350ms 后仍未完成且进程存活，约 2 秒夹具自然退出后才完成。不连接模型服务，不能据此确认所有后代进程或异常 OS 回收路径。

已据此接回官方 SDK 并删除自有 CLI 传输，采用上文的独立 worker 与 Windows Job 边界；协议与参数继续由 SDK 维护。

### 2026-10-18 旧版本现场取证

宿主会话 `8361ac80-6f5e-4772-99a7-36f4ae91eb9c`，运行时 `01a14ca9-8072-7461-8962-46b8439bc21b`：运行时记录在北京时间 09:41:08.622 写 final_answer、09:41:08.993 写 task_complete；只读 CDP getHistory 仍 busy=true，持久化 assistant 为 checkpointState=partial / checkpointReason=tool_completed。授权 CIM 查询确认 Codex PID 28180（09:38:59.098 启动）仍在，父宿主 PID 48800 未重启，后代仅观察到 conhost。进程线程处于等待，443 连接为 CLOSE_WAIT；这不是足以锁定具体 Rust/网络清理代码的调用栈证据。旧版本未记录 stdout terminal/EOF/exit 时间，不能从 transcript 推断 turn.completed 已送达 SDK。

用户确认未点停止或重启；取证未对目标进程做任何终止操作。一次受限 Get-Process 返回不存在，随后授权 CIM 确认同 PID/启动时间仍在，故不采信为自然退出。现场支持“模型完成但执行资源未释放”，不能归因于纯输入框渲染；新回归分别覆盖终态后超时和无终态时的主动停止。

### 受管附件只读范围

回合和连接捕获的目录快照经 GuiSessionStore.withAttachmentReadAccess 加入当前会话的附件目录，修复 userData 下源图片/转换页图被工作区范围守卫拒绝。宿主 read 类工具按 realpath 放行，edit 类及 SDK 额外可写目录不扩权。详见 [multimodal-input.md](multimodal-input.md)。

## 操作性 ask 与业务审批

`host/approvals.ts` 将外部原生交互与发起它的连接及回合绑定。Core 审批和工作区工具规则、宿主目录校验、真实业务动作审批按各自入口执行。

离线用例 `test/gui-worker-safety-gates.mjs`、`test/scheduler-native-safety-gates.mjs` 覆盖日常 Shell 模型调用零次、人审零次、只读拒绝与目录权限保留。第三方 CLI/SDK 和操作系统原生授权仍由原系统负责；不宣称外部 CLI 壳里的合入已被业务门覆盖。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D03.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：中栏聊天气泡 Worker（Pi/Cursor/Claude/Codex/ACP GUI）：结构化工具事件、审批/提问卡、计划卡、fork，替代「拉 pty 刮屏」；CLI runtime 行为完全不变。
- 为什么这样设计：Host 不知道具体引擎、渲染层主干不按 runtime id 分支（新增 runtime 近零渲染改动）；主进程是唯一 writer；parts 交错模型按到达顺序流式；新会话默认 auto 档（2026-09-05 用户裁决：default 档 bash 都要审批不适合 Worker）；close(purgeHistory) 连带清引擎侧落盘 + 启动孤儿清扫兜底，防数据残留。
- 明确不做：不清理 CLI 外部引擎目录（~/.claude/projects 不属应用边界）；不直注用户第三方 MCP（B2 起统一宿主中转）；restartConversation 对 GUI 明确拒绝不暗中中止；steer 失败回队不静默丢失。
- 歧义点：tool-rules.json 自我提权面（default 档区内写文件 auto，Worker 可自写规则文件给自己加 allow；文档标注「硬防护待产品决策」）——A=近期上守卫（规则文件入 denyPaths/首次修改审批）／B=接受现状，allow 逐段全称收紧即止（review 记 P2 不升级）／C=改由设置 UI 管理规则。推荐 A，安全面且成本低。
