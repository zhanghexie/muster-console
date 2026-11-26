# 会话邮箱与宿主唤醒

普通会话、子代理和调度共享宿主邮箱。通信只依赖会话身份、寄信和主动收信，不要求共享任务表、子任务结果状态机或 harness 专用协作协议。会话互感仍由 [sessions.observe](scheduler-observe.md) 提供。

人工发送或从交互部件发送时，已识别的宿主邮箱错误按界面语言展示；损坏索引、外部错误与路径细节保留，账本和模型工具的原始诊断不改写。

调度应用与订阅事实使用宿主事件通道：复用此处的持久队列、去重和空闲准入，按 hostNotification 元数据区分普通信件；实际材料直接写入 PI 隐藏 custom message，会话只显示一行计数。digest 顺带下一实际回合，事件进入上下文后才记消费。普通 `host.mail.read` 不再返回这类事件，历史信纸也不自动展开；跨 harness 普通信件及 Worker 事件仍保留原邮箱行为。事件信正文损坏时按失效退役（标读+日志），应用通知服务缺失时跳过该信留待后续重试，两者均不阻断同批投递。实现和信息预算见 [AI 应用通知](agent-apps.md#ai-上下文与人的活动提示)。

## 交互合同

| 动作 | 实际含义 |
|---|---|
| `host.mail.send({to,text,subject?,kind?,replyTo?,idempotencyKey?,interrupt?})` | 正文先完整持久保存，返回 `receipt=stored`、`messageId`、`mailboxWorkspaceId`、`read`；保存不等于已读或已处理 |
| `host.mail.read()` | 默认批量返回未读正文，预算外保留未读；返回稳定 cursor/nextCursor |
| `host.mail.read({includeBody:false})` | 只预览摘要、不标读，保留筛选与 offset |
| `host.mail.read({messageId,bodyOffset?,length?})` | 分页打开正文，跟随 nextOffset；只有收件 AI 打开才写 read/readAt，任一页打开即已读，不代表全文读完 |
| `host.mail.read({includeBody:true,unreadOnly:true,limit?,maxChars?})` | 主动一次取得若干封未读正文页；只有实际返回的正文页标读，预算以外的信件保持未读 |
| `host.mail.read({includeBody:true,cursor?})` | 立即读取当前邮件并返回稳定 cursor/nextCursor；等待邮件、事件或会话状态使用 `host.waitFor` |
| `host.mail.read({box:"sent"})` | 列寄件记录和收件 AI 的 read/readAt；寄件人读自己寄出的正文不改变回执 |
| 界面预览 | 宿主 UI 只看当前工作区的信件，不代替收件 AI 标读；调度工具调用则只看自身邮箱 |

### GUI 旧版首封任务

新版 GUI 委派通过[聊天发送首条任务](worker-inject.md)。此前保存的 `initial-assignment` 首信保留原正文、来源和回执，仍可继续投递或主动读取。

收到首信后，空闲 Worker 启动一次宿主回合。也可以由同时到达的第一条真实用户输入携带首信。发给引擎之前，宿主原子预留本次输入并附上来源、邮件 ID 和最多 3600 个 JSON 编码字符的任务正文。长信附 `host.mail.read({messageId,mailboxWorkspaceId,bodyOffset})`，后续使用 `nextOffset`。短任务的正文随第一次实际输入抵达。

引擎回执确认后写入 `initialAssignment.state=delivered`、`deliveredAt`、`turnMessageId` 与 `bodyEnd`。宿主受理、原生回执和主动打开正文分别记账。只有收件 AI 调用读信打开正文页时，`read/readAt` 才变化。投递与已读均不表示完成任务。

明确尚未提交的失败释放本次预留，可由宿主故障切换或显式重试。预留已写入但结果不明确时，邮件显示 `unconfirmed` 并保留正文供核查，重启也不自动重送。普通来信和打断仍使用原有提醒及主动读取。

接续同一逻辑 Worker 时，首信和用户补充信仍在原邮箱。更早的聊天与工具记录走 Worker 自己的只读 `host.workers.context` 分页，见 [Worker 创建与任务投递](worker-inject.md)。

Worker 邮件的回合约定：多里程碑任务持续做到全部完成或遇到需要用户决策的阻塞；中途进度使用 `notice`，发出后继续工作，不等回复或结束回合。`ask` 表示需要回信，可以结束回合等待；`handoff` 只用于全部任务完成后的最终交付，之后等待验收。类型是模型协作约定，邮件持久化和唤醒机制本身不强制这些回合行为。

预览默认列表 12 条、最多 50 条，总预览输出约 6000 字符预算；正文默认每页 4000、最多 5000 的 JSON 编码字符预算。完整正文上限 262144 字符，超限明确拒收，不静默截断。支持跨工作区寄信，目标工作区保存；双方按可信宿主身份可查询相关信件，其他会话私信不可见。`scheduler` 规范为当前工作区的 `orchestrator:<workspaceId>`。

### 打断与事件通知

message 的 to 支持直接会话、scheduler 和 parent（由可信父关系解析）。调度可对任意会话管理器中的可用会话使用 interrupt=true（调度的虚拟邮箱不是普通会话目标），其他会话仅可对自己的直接子会话使用；先存信，再向当前接入表达打断类投递意图。SDK/GUI、CLI/TUI 和运行时注册接入并存，具体机制由接入实现，公共层不按供应商分流。

- 原生路径：接入收到轻量读信提醒和稳定标识，自行插话或投递。Codex TUI 向同一 app-server 的活动 turn 发 turn/steer；Claude SDK 的原生输入队列逐 result 收口，优先消息先请求 Query.interrupt、等 result 后才送入下一轮。Cursor GUI 使用通用 ACP 路径，不支持原生 steer。通用 worker 转发可选 receiveMessage，并兼容已声明的原生 redirect。受理写 interruption=accepted 和 deliveryMethod，不伪造当前工具已停止。
- 只有明确 unsupported（保证没有提交输入）才进入兜底：GUI await abort 后重验 busy，PTY 按当前进程绑定的 interruptInput（缺省 Ctrl+C，Claude 为 Esc）请求中止后等待实际 idle/退出，再提醒读信。普通 deferred 不是改走停止的许可。并发兜底信件仍共用一次停止，每封记录 requested/stopped；已 stopped 的幂等重试不再中断新回合。
- 原生请求开始前写 delivering；失败/超时/无效回执后保留不确定阶段，不重复插话、不切键盘。确定 deferred 恢复 pending，后续状态变化或有界重试可再尝试原生路径。原生成功记录提醒时间、不标读，同一信重试不再唤醒。受管兜底停止及 `sessions.interrupt` 在停止前记录中断快照，邮箱兜底的下一条提醒附带工作简报。

内置变化和获准自定义事件共用 events.subscribe/unsubscribe，命中后通过 message 保存通知信；旧事实查询同一收件人多订阅合一封，新持久事件按订阅和事件分别幂等存信。失败不推进订阅位点。调度的持久订阅事件使用独立策略类别和合并窗口，digest 随后续实际通知捎带；Worker 走邮箱。邮件保存/已读不向订阅事件系统发布新事件；独立 Kernel 语义日志中的存信事实不触发订阅回声；session.activity/session.lifecycle 已不向订阅方投递，业务 phase/Git 继续发布。

### 主动收信与恢复

批量模式以稳定收件位置向前读，摘要列表仍按时间倒序与 offset 分页。默认批量返回未读正文；`includeBody=false` 只预览。`limit` 默认12、最多50；`maxChars` 为整个结果的 JSON 字符预算，默认8000、最多10000，含邮件头、正文和游标；单封批量页另受 `length`（默认/最多5000）限制。先规划完整响应再写回执，预算太小明确报错；只读摘要不标读。长信只在批次尾部留一个未完正文页，位置放进 nextCursor，续收不会因它已标读而跳到后面的信。

```js
// 第一次可只领未读；需要从头可指定 cursor: "start"。
const batch = await host.mail.read({
  includeBody: true, unreadOnly: true, limit: 8, maxChars: 8000
});
// 保留 batch.cursor 以便重放；处理接受本批后保存 batch.nextCursor。
await host.mail.read({ includeBody: true, cursor: batch.nextCursor });
// 等回信时先武装一次续接，再继续其他工作。
host.waitFor({ condition: { kind: 'mail', from: childId }, note: '收到回信后核对结果' });
```

- `reason=mail` 表示本次返回邮件，`empty` 表示当前无内容。等待条件、超时及会话状态不由收信接口处理。
- 游标绑定可信邮箱、box 和 mailboxWorkspaceId，带每个存储工作区的单调 sequence、可选正文偏移和 since。重启后无需会话内存即可续收；新邮件、已读变化或系统时钟倒退不会挤动已有位置。多个工作区按队首时间合并，始终保持各自 sequence 前缀，不因时间回退漏信。
- `cursor` 可重放已读正文；`nextCursor` 向前续收。指定游标后不再按 unreadOnly 过滤，避免已写回执但响应丢失的信无法重取；首次无游标才按 unreadOnly 筛选。`since` 只在首次设置，游标续收沿用；批量模式不用 offset。cursor=start 的请求可重试，首次无游标响应丢失时也可从 start 或单封 ID 恢复。
- 计数有各自时点：读信提醒是该次通知批次的新信数，不是持续变化的总未读数；正文结果 `unread` 已扣除本次打开的未读信。预览列表 `total`/`unread` 则统计筛选后的结果；默认 inbox 只看未读。28 封未读打开 8 封后返回 20，再打开 3 封返回 17；游标取到此前已读的信时，未读数不下降。机械态势的 `scheduler unread mail` 只数调度普通来信，收信/已读落盘后合并刷新，旧上下文里的快照不是实时计数。
- 取消或断线与宿主感知取消之间存在网络竞争，已完成的读取/回执不回滚，原游标仍能重放。已读不证明模型已接收或处理，只有调用方接受并保存 nextCursor 才推进自己的接收进度。
- `phase` 是独立的看板状态，`busy` 和 `lifecycle` 描述运行状态；同一快照出现 `phase=idle` 与 `busy=true` 表示仍在执行，不是冲突。`busy=null` 表示无法确定，不能当成已停止；即便运行结束也不能据此判定任务成功或邮件已交付。
- `waitMs` 和 `watchSessionIds` 已删除，旧参数直接报错；等待改用 [host.waitFor](resume-wait.md)，会话结果仍由 `host.sessions.observe` 读取。

父收件人通过 host.mail.send({to:"parent"}) 由宿主推导；向调度提问用 to="scheduler"、kind="ask"，答复用 kind="answer"、replyTo=原信 ID，并寄给提问方。askScheduler/reportParent/reply 的工具定义、handler 和闲置 reply IPC 已删除。requestIntegrate 仍承担 worktree 安全门和合入通知，通知复用同一邮箱；问答关联不成为通信准入门槛，已读和任务完成各自独立。

### 前台收发信展示

来信标题（发送者、来信标识及主题）放在气泡内部，外部不再显示标题行；左侧保留角色头像。来信标识与字符区间提示随界面语言切换，发送者、主题和正文保留原文。信件表面使用 `--radius-chat-card` 四角统一的大圆角，内部使用轻量信封图标及标题分隔线，不增加装饰动画。

来信卡嵌套在助手工具结果中；quiet 模式的助手正文重置样式必须排除 `[data-mail-read]` 内的气泡，避免清掉来信背景、圆角和内边距。浏览器回归夹具 `test/fixtures/mail-read.tsx` 使用生产 quiet 模式，并断言这些计算样式。

调度和 GUI 会话的实际读信结果在聊天左侧显示为来信气泡，带发送 Agent 的角色头像、名称、主题和本次读取的正文；工具折叠后仍可见。宿主在可信工具调用开始时绑定当前会话和助手消息，读取成功后将正文页作为仅展示记录写入该消息，不依赖 Harness 上报的工具名或结果格式；已取消的请求不附加。宿主执行成功不等于结果已送达模型，断线等不确定情况不能据此判断模型已收到。摘要预览、失败读取和提醒不生成正文气泡；同一消息内展示记录与工具结果按信件及偏移去重。旧历史继续从成功的 `sessions.readMessages` 工具结果解析，Codex 的 `mcp_tool_call` 从工具输入识别实际工具名，文本为空时驱动保留 MCP 结构化结果。长信标明已读取的字符区间，未读页不冒充完整内容。发送时把身份快照存入账本，随后读信与历史展示沿用该快照，旧信回退到现有会话身份。入口是 `capabilities/hosts/mailbox.ts`、`mailReadPresentation.ts`、`ReadMailCards.tsx` 与 `ChatMessageView.tsx`；回归见 `mail-display-source.spec.ts`、`display-item-anchor.spec.ts` 和 `mail-read-presentation.spec.tsx`。终端原生 TUI 暂不接入这条 GUI 展示记录。

界面用短暂的信纸/信封动画让用户知道代理正在通信，原 `SchedulerAsksBanner` 与 `messages:openAsks` 查询已移除。邮件的 ask 类型不产生待答卡片、回复输入框、看板风险或验收/归档阻拦；真实的人类审批和结构化提问仍沿用各自入口。

信纸保持纯白薄边，收发抬头与页脚用浅灰细线分区。信封正面的极淡折缝随袋面整体运动。聊天来信卡使用 `read-mail-letter-*`，动画信纸使用 `mail-letter-*`，避免完整样式表加载后的类名串扰。

- 可见且允许动效的寄件视图通过 `messages:departure` 展示待寄信纸。单封停留 1 秒，连续寄信按末封延长，最多再等 0.5 秒。最多叠四张纸，批次数量和实际邮件继续累计。折纸后到达上飞轨道起点时，`mailPresentation:depart` 释放真实存信；账本提交成功后信封继续上飞，失败时收起动画。幂等重试复用原存信操作。
- 正文和索引提交成功的新信发布 `messages:activity`。收件侧从此事件起先合并 0.5 秒，再反向飞入、开封和展开，展信停留约 2.2 秒。收件侧只观察存信事件。反放使用统一逻辑时钟，短轨道等到共同逻辑位置再展开。折纸、入袋、飞行、封盖沿用 [原型说明](../prototypes/envelope-send/README.md) 的重叠轨道和 `.9` 速度。
- 窗口后台、寄件视图不可见、动效已减弱为静态或视图正忙时，邮件直接存信。切会话、窗口失焦/隐藏/最小化、关闭面板和渲染进程失效会立即释放已接受的待寄信并取消展示。渲染迟迟未回应时，宿主在 2.5 秒内放行，后台动画事件不回放。待寄预览在内存中，只有落盘成功后工具才返回 `stored`。收件侧占用期间最多合并一个待播批次。
- IPC 预览最多带 1400 个 UTF-16 代码单元，完整正文在邮箱读取。动效关闭时可显示已存信件的静态信纸。动画层不拦截输入，查看预览不标已读。
- 普通会话的 GUI/PTY 共用 `CenterPanel` 会话格覆盖层；调度共用 `AgentFloat` 覆盖层。分屏中各可见会话独立展示，无 harness 专用收发动画协议。

## SQLite v1 存储边界

邮箱文件由 `StorageManifest` 和 `safeScopedKey` 解析为 `userData/agent-messages/<key>.sqlite`，完整正文保存在同一 purpose 下的 `<key>-bodies/<sha256(messageId)>.txt` 不可变文件。消息状态、回执、已读信息和发送状态按消息 ID 在 SQLite 行表中增量更新，行内只保存正文预览和正文文件名；WAL、`synchronous=FULL`、事务和进程级写链覆盖写入与恢复。进程内复用每个 mailbox 的 SQLite 连接，追加只读取 sequence、重复 ID 和 replyTo 索引，不重建完整 ledger。`test/unit/node-main/mailbox-storage.spec.ts` 覆盖正文文件、10,000 条消息追加与恢复。旧 `.muster/messages.json` 只由发布前 reset 清理，运行时不读取、不迁移、不双写。索引损坏或数据库无法打开时保留原文件并返回明确错误，旧的内嵌正文列式 schema 直接 fail-closed。

## 唤醒规则

### 持久受理与退出边界

`runtimeKernel/semanticOperations.ts` 用现有 mail/message/request ID 记录独立会话语义事实，不重复保存正文或只读 UI 事件。同 key 的进行中调用共享 Promise；提交前先持久保存 attempt，明确受理后保存 committed。明确未提交的拒绝或失败保存 retryable，同 ID 可以重试；提交结果未知及重启留下的未决 attempt 不自动重发，并通过 `wakeUncertain`、错误回执提示检查原生历史。`accepted`、`queued` 表示宿主受理，不能证明模型执行或任务成功，也不承诺 exactly-once execution。

存信先提交 immutable body 与 mailbox ledger，再保存 `mail.stored` 或真实 child→parent handoff/answer 的 `subagent.result` 事实。后一步失败仍返回 `receipt=stored`，附带 `semanticError`，不能报成未发；同 ID 幂等重试可修复语义索引。唤醒 committed 已保存而 mailbox `notifiedAt` 更新失败时，下次规划先恢复旧回执，再选择新信批次，新增信件不会带着旧信重复投递。

调度的 `beforeStart` 仅检查当前准入条件；只有 durable 消息追加、队列受理或实际新回合受理后才调用 host-only `onAccepted`。因此追加失败不会因为“邮件仍未读”而返回成功，也不需要等整个模型回合完成才报告宿主受理。通知的 `accepted(batch)` 由 Pi 原生历史核验完成后调用：`scheduler.notification-consumed` 明确记 `boundary=native-context-persisted`，不是模型已处理的证明；其 `receiptStatus` 另记宿主回执是否落盘。原回执写入抛错时保留原异常，并追加 `scheduler.notification-receipt-failed`，不能据 consumed 事实假装 mailbox/app 已确认。

`MailboxWakeOwner` 先停止新请求、监听和 timer，并取消未完成原生插话；scheduler、GUI、后台任务各自释放后再 drain 已受理回执，最后才释放 SessionFactory。停止后不能通过一次新 request 重新创建服务。Pi 插话取消会卸订阅，迟到的缓存回调不能再确认消费；已经开始的本地回执写入仍须排空，避免用外层 Promise race 伪造资源释放。


新建 CLI 且有任务时，首轮直接通过已有任务文件/`appendPrompt` 管线携带完整任务简报；任务文件以 UTF-8 写入，短指令明确要求使用 UTF-8 读取，不先运行“暂无任务”的认宿主回合，也不再额外寄一封相同任务等待 idle。GUI 和已有会话的恢复仍走持久邮箱。`cli-prompt` 只说明启动输入已附带，`starting`/启动错误仍如实返回，不代表模型已执行任务。

Worker 可用 `sessions.setArchived` 归档或恢复自己的直接子会话，调用方身份由公共绑定层覆盖；父、兄弟和无关会话逐项拒绝。删除能力没有开放。

Claude TUI 的用户中断不会触发厂商 Stop hook。兼容停止可由当前进程绑定的 `prepareInterrupt` 在 Esc 前截取原生转录边界，仅接受其后新增、同 sessionId 的结构化 `interruptedMessageId`；历史、模型正文、新回合或转录换代均不确认。确认后以 `native-interrupt-confirmed` 更新 idle。没有证据仍返回明确失败；超时后真实 idle 到达会恢复 requested 信件的投递，不重复停止。实现集中在 `_claude-interrupt.mjs` 与 `messages/interrupt.ts`，不按静默时间判成功。

1. 普通信件仅在收件 Agent 已停止执行且仍有未读信时提醒；运行中由 Agent 自主收信，宿主不把普通提醒放入原生后续队列。GUI 使用 requireIdle 准入，CLI 先查空闲状态，Codex 的宿主提醒另外用 idleOnly 跳过原生队列。公共邮箱不占宿主普通输入队列。打断类消息由获准接入原生处理，缺少能力才走停止后投递。
2. 可用会话空闲或停止后：宿主合并约 120ms 内的新信，以 `host:true` 发一条「宿主收信提醒」。提醒只含新信数量和收信入口，没有正文、发送者指令或交付结论。
3. 提醒成功受理后，仅本批信件记录 notifiedAt；不标读。同一批即使仍未读、模型未处理或用户停止，也不反复唤醒。真正的新信可以触发下一批。
4. communication.ts 传递意图，当前连接或运行时脚本的可选 receiveMessage 实现原生通信。GUI 空闲仍复用 send 回合合同。没有原生通道的 PTY 使用键入或 relaunch-resume 兜底。停止的 CLI 经通用 respawn 按原生 ID 恢复，确认 idle 后提醒。缺少恢复能力或原记录时保留信件与失败原因。携带简报的 relaunch-resume 也检查原生 ID 和 cwd。唤醒不改变选中会话或焦点，blocked/quiet 不发回车。ACP 等接入复用既有宿主，无厂商专用协作工具。
5. 调度提醒继续经过自治回合闸，调度有待答提问卡时暂缓。延迟准入保留通知身份与 idle 条件，实际发起前重查未读。调度自己的 `needs_you` 相位允许空闲唤醒，开回合时在原始读信指令前附上用户待办及状态更新提示。忙时插话仍遵守调度等待人工的准入条件。
6. 调度正忙、等待用户回答或接入明确要求稍后投递时，未读邮件返回 `wakeDeferred: { reason, retryWhileUnread: true }`。宿主先按 500/1500/4000ms 退避，之后每 30 秒检查一次，直到受理、信已读、目标关闭或工作区退出。新信和 idle 边沿可以提前触发，相同原因复用现有记录。`wakeError` 记录实际投递异常或明确无法投递的目标。原生回执不确定时保留 `wakeUncertain`，须核对收件会话，自动重试只覆盖确定尚未投递的尝试。归档、删除和关闭工作区按既有终态处理，已删除会话凭结束墓碑保留邮件。
7. 普通终端（`launchKind=shell`）不接收唤醒：投递扫描时对其信件写确定性 `wakeError`（「普通 shell 终端不接收唤醒」），不再静默滞留。

`deliveryMethod` 区分 `sent`（宿主回合受理）、`steered`（原生插话受理）、`queued`（原生队列受理）、`stopped-and-sent`（接入停止后投递）和 `written`（写入通道或终端）。`notifiedAt` 记录提醒受理。未读的摘要和正文查询可显示当前唤醒回执，首次存信可返回 `wake: pending`，寄件方可查询 sent 取得更新。邮件已读后，各查询仅呈现 `read/readAt` 作为当前收信状态。账本保留已有唤醒记录，已知的旧版暂缓文案会按暂缓解释。

原生最终回复保留在原会话，由 observe 读取。需要向别人交付时由模型显式寄信。宿主不再自动转寄首次回音、done、进度、失败、恢复或已读回执；这些状态仍能被观察，但不会凭空新增父会话通信。多个正常寄信会保留为多封信，宿主不猜测哪份结论覆盖另一份，回复链与时间由模型判断。

### 内置接入的实际路由

同一引擎的不同接入独立实现，不通过另起 SDK/ACP 进程冒充现有 TUI。空闲 GUI 均沿原 send 合同开回合；下表描述适配器底层能力，普通邮箱提醒不使用忙时队列，统一等真实 idle 并重查未读。

| 内置接入 | 普通消息 | 打断类消息 | 验证与边界 |
|---|---|---|---|
| Pi GUI | 等待空闲后重新检查未读并发送提醒 | 普通邮件沿原路径；host.waitFor 的宿主事件可经内置 Pi 隐藏 custom message 插话 | SDK 离线模型覆盖原生隐藏插话；外部 Pi 同样可用 host.waitFor 的普通发送，未声明抢占能力则等回合边界；完整 GUI Worker 链待真实验收 |
| Cursor GUI | 等 ACP `session/prompt` 收口后续发 | `session/cancel` → 原请求结束 → 同会话续发 | ACP 离线回放覆盖取消；当前账号无法验证成功推理和原生续聊 |
| Claude GUI | 适配器 FIFO，收到上一条 result 后再给 PromptFeed | Query.interrupt → result 确认 → 优先队列输入 | 多 result 回归，队列未清空不释放 Host busy；PromptFeed 不再冒充 steer |
| Codex GUI | 等回合结束，沿原 thread.runStreamed | 现用 exec SDK 不支持运行中输入：AbortSignal/执行容器释放确认后在同 thread 续发 | 官方 SDK/真实进程生命周期用例；不另起 app-server 写这个 SDK 的 thread |
| ACP GUI（OpenCode/Gemini 预设） | 等 session/prompt 响应后续发 | session/cancel → 原 prompt 响应结束 → 同 session/prompt | ACP v1 没有协商 queue/steer；NDJSON/权限/取消/关闭回放；未把 cancel 通知当停止确认 |
| Codex TUI | 同一私有 app-server 的 thread/queue/add 原生后续队列；不支持队列的旧 server 才在 idle 后 turn/start | 原生 turn/steer + expectedTurnId | 已安装 0.162.1 真 TUI、本地模型请求和同终端回答；后台 MCP 环境与子会话身份也经真进程验证；不支持认证 remote 的旧 CLI 才退回兼容输入 |
| OpenCode TUI | 当前 TUI 自带 HTTP server 的 prompt_async；忙时等待 | 原生 abort → session/status 确认 idle → prompt_async | 真 TUI + 本地模型、API/终端相同会话，确认未用键入递送正文 |
| Claude Code TUI | 默认确认 idle 后键入；厂商已开放且显式启用 Channels 时用原生 MCP 通知 | Channels 没有 cancel/steer：默认 Esc → 确认 idle，再经选定通道递送 | 真实 CLI 2.1.308 + 本地模型验证默认 Esc 停止和原终端续发；MCP 初始化成功仍可能显示 Channels are not currently available；不得默认当原生通道已启用。MCP stdio/鉴权/去重/资源回收已测 |
| Cursor CLI TUI | 同会话 resume + 原生 argv prompt | Ctrl+C → idle/退出确认 → 同会话 resume + prompt | 已安装 CLI 的 agent acp 是独立接入；未发现能附着当前交互 TUI 的入站 IPC。真实通用 PTY 与恢复/argv 回归，未调用在线 Cursor 模型 |
| Gemini CLI TUI | 首条 -i/--prompt-interactive；后续确认 AfterAgent idle 后键入 | Ctrl+C → idle/退出确认 → 键入 | BeforeAgent/AfterAgent hooks 安装、旧会话恢复补装、保留用户配置、去重、卸载和 argv 回归；本机无 Gemini CLI，未作供应商真机验收。OSC 通知是出站，ACP 是另一接入 |

原生队列受理不切开正在输出的 assistant。支持消费回执的适配器（如 Claude）在开始下一条输入时发 native-message-start，复用稳定消息 ID 在真正消费边界切开转写；先消费后收到受理回执的竞态也只保留一条消息。原生队列由适配器维护到真正 settled，不复制进 Host 的普通输入队列。Pi GUI 当前不提交原生队列消息。

Codex TUI 使用带随机 capability-token 的私有 loopback app-server，TUI 自己创建/resume/fork 会话；新会话保留配置的权限参数，远程 resume/fork 则沿用服务端线程已保存的权限，不把 TUI 权限覆盖参数再传给 Codex（0.166.0 会拒绝并退出）；宿主发现该 server 唯一的实际 thread 并回填临时句柄，不先制造无法被 TUI resume 的空 thread。普通消息用与官方 codex queue 相同的 thread/queue/add，稳定 clientUserMessageId 与队列回执匹配后才确认受理，空闲时由 server 自动启动。活动 turn ID 优先来自 turn/started；未收到通知时仅从 API 指定的原生 rollout 末尾最多 1 MiB 读取结构化 turn ID，再用 expectedTurnId 原子校验，不解析模型正文推测状态。thread/read 提供活动状态，不请求当前版本尚未支持的完整 turns；其绑定线程的快照也补偿遗漏的回合状态通知，直接经启动租约送宿主。后台继承该子会话的可信宿主环境，其 owned processIds 在 TUI 启动前登记入站 MCP 身份，随启动租约回收，避免消息已送达而读信工具归错会话。已有全局 daemon 不受管理；兼容启动在支持时使用 `--no-daemon` 防止复用共享后台，引擎会话由宿主句柄绑定，终端内手动另切 thread 不作为跨会话路由契约。

OpenCode 预分配与实际 TUI 的 server 都使用随机 Basic 密码，只绑定 127.0.0.1；请求固定 sessionId 与实际 directory。每次进程启动独立绑定 receiver/env/dispose；预检 probe 不开服务、占端口或落凭据。准备被取代、spawn 失败、PTY 退出/替换均回收；旧进程回调不能改新代句柄。PTY 自然退出也关闭 ConPTY 残留句柄，退出/显式关闭/替换按进程仅清理一次，已确认退出后不再按旧 PID taskkill。PTY 后端保持原配置。Windows 对已确认退出的 node-pty 1.1 进程，用能力探测跳过已失效的 AttachConsole 旧 PID 枚举，再经原 kill 关闭 PTY/conout worker；活进程保留原进程树清理。此兼容处理集中在 PTY 适配层，macOS/Linux 不进入该分支。Windows cmd 参数已转义时交给 node-pty 原始命令行，避免 URL/空格路径二次加引号；POSIX 保持 argv 数组。

Claude Channels 为厂商研究预览：仅在启动参数明确提供 `--dangerously-load-development-channels server:muster-mailbox` 时安装临时 MCP 配置与本地鉴权桥，保留 CLI 自己的预览确认、MCP 同意与组织策略。默认不自动申请预览资格。Bedrock/Vertex/Foundry 及不支持该参数的旧 CLI 明确走兜底。该协议没有消费 ACK，stdio 写完仅记 written，不能当作 channel 已被厂商启用、信已读或任务已执行；显式启用前应先在自己的账号确认通道可用，CLI 的拒绝提示必须处理。完整信件始终在公共邮箱，不另建第二套业务信箱。

### PTY 生命周期与兼容投递

2026-10-22 修复用户报告的 Stop 后尾随输出导致永久 quiet、任务信无法唤醒及中断无法确认的状态竞争：

- `sessions.ts` 的 PTY onData 与 `shared/sessionActivity.ts` 保留权威 idle/waiting_input，recap/ANSI 重绘不能撤销 Stop；真实用户按键或新的结构化执行信号撤销旧事实，启动/重启清理旧活动。
- 兼容键入前发布 host-prompt-submit 活动，避免下一回合仍继承 Stop；此活动保持宿主来源，不伪装真人使用。quiet 继续代表未知，静默工具不能被当作可输入或已停止。
- 既有 idle 边沿重试继续用于邮箱提醒；没有结构化完成事实的自定义终端仍可能需要接入提供原生通信或可靠状态，不能用延时凭空保证安全。

`board-execution.mjs` 提取真实 SessionsService 回调和方法，覆盖 Stop→重绘→长静默仍 idle、真实输入撤销；`session-activity.mjs` 覆盖纯函数，原有真实 Node PTY 中断专项保留。原生能力的外部依据见 CLI 子代理通信调研。Codex/OpenCode/Claude 真 TUI 与本地受控模型已逐项验证，各入口的实测边界见上表。

## 数据流与关键文件

```
各 harness 的共享工具桥
  → host.mail.send / 兼容入口 → messages/deliver.ts
  → 可播动效的寄件视图 → messages:departure → 折纸 → 上飞起点
  → messageStore（正文落盘 → 账本提交）→ stored 回执 / 寄件侧上飞
  → messages:activity → 前台收件视图合并、反向播放
  → messages/wake.ts（批次、idle、生命周期）
  → messages/communication.ts → 接入原生 receiveMessage / 既有 transport 兜底 → 轻量通知
  → 旧版 GUI initial-assignment → messages/assignment.ts → Native 回合正文预留与投递回执
  → 模型主动 host.mail.read → messages/read.ts → 正文页 / 收件人回执
```

- `shared/agentMessage.ts`：邮件头、稳定 sequence、旧格式解析和问答派生；新 ID 为 `mail-<UUID>`，旧 m-N 保留可读。无 sequence 的历史索引由原有 seq 与追加顺序稳定推导，新写入后持久化；不按消息时间戳定位。幂等键绑定可信寄件身份和收件地址，同一寄收双方、同键同内容返回原信，同键换内容或元数据明确冲突。
- `main/metaAgent/messageStore.ts`：`userData/agent-messages/<safeScopedKey>.sqlite` 保存邮箱行和可增量更新状态，同 purpose 下 `<safeScopedKey>-bodies/<sha256(messageId)>.txt` 保存不可变完整正文。每个 mailbox 进程内复用 SQLite 连接，正文文件先 fsync 再提交行事务，不按旧 200 条上限淘汰未读、已读或回复锚点。userData 目录由 `index.ts` 启动时注入；注入状态放 `globalThis` 进程级单例，不能退回模块级 `let`。旧 `.muster/messages.json` 只由显式 pre-release reset 清理，运行时不读取或迁移。
- `shared/runtimeCommunication.ts`、`main/messages/{communication,transport}.ts`：意图、回执校验、动态接入与兼容兜底；只有明确不支持才换路径，未知投递不重放。
- `main/messages/{deliver,read,receive,cursor,watch,wake}.ts`：统一寄信、权限过滤、正文批量/分页、游标、观察投影、批次调度。一次性等待与抢占投递分别位于 `main/resumeWait/`、`main/agentSession/delivery.ts`。GUI/PTY/ACP 的工具身份绑定继续复用 `shared/hostTools/meta.ts` 和现有能力鉴权。
- `main/messages/{departure,presentation}.ts`、`shared/mailActivity.ts`：寄件视图资格、等待上飞的待写入请求、超时和前后台回退、存信后的展示投影。`MailEnvelopeViewport.tsx`、`components/envelope/*`、`styles/mail-envelope.css`：前台注册、有界合并、阅读停留、原型共用纸封网格与双向轨道。
- `main/capabilities/executor.ts`：静态工具与动态工具均接收可信执行 AbortSignal。GUI/调度进程内桥直接传递；Shell API 和 ACP/Codex 共用 HTTP 网关将未完成响应断线转成取消；stdio MCP 按 requestId 处理普通 notifications/cancelled 并取消 HTTP。正常请求正文结束不视为取消，不依赖 API 原生 async 或 MCP Tasks 扩展。
- `main/agentSession/host/messaging.ts`：内部 host/messageId/requireIdle 选项，稳定通知 ID 防止重复回合；这些可信字段不从 renderer send 入参透传。
- `shared/guiWorker.ts`、`renderer/src/chatSurface/guiMessageView.tsx`：host 身份持久化和恢复，使用既有宿主方印及普通提醒字号；不使用用户头像。
- `main/agent/injection-registry.ts`：`worker.turn-prefix.initial-assignment`、`both.event-wake.mailbox`、`both.tool-result.mailbox`；工具目录与 GUI 提示说明保存、投递、已读和处理的区别。

新提醒在 GUI/调度历史带固定 ID，同时邮件头保存 notifiedAt，重绑监听或重启不会因同批未读再次提醒。旧 inline 正文、delivered/session_ended 回执保留原义，不自动重放旧通知。旧数据迁移先保存新位置再清理旧副本；坏索引或迁移失败明确报错，保留原文件，不能伪造空邮箱覆盖。

## 验证与边界

- `test/builtin-native-communication.mjs`：真实 HTTP/WS/MCP 子进程，覆盖原生路由、身份与鉴权、旧版本、未知结果和资源回收。
- `test/integration/builtin-tui-native.mjs codex codex-legacy opencode claude-code`：显式运行已安装的真 TUI + 生产 PTY + 本地受控模型；临时 HOME/XDG/配置与假 key，不调用供应商在线模型。Codex 的私有 server 与 `--no-daemon` 兼容路径分别验证 MCP 可信环境和 PID 祖先身份，私有 server 另验证 Worker HTTP 不可用时的宿主 activity；Claude 模式验终端兜底，Channels 预览需另行显式开启。
- `test/inbound-mcp-pid-scope.mjs`：后台进程身份、PID 复用/跨实例覆盖保护、准备失败回收、Windows WMIC 缺失转 CIM 与 macOS/Linux 祖先查询分支。
- `test/mailbox-runtime-communication.mjs`：真实 RuntimeHost 的内置 TUI 通道，普通原生队列、父对子原生插话、同信并发去重、Pi 消息接收、deferred 恢复、未知/无效/换代回执留信且不切键盘。`gui-host-lifecycle.mjs` 覆盖 Host 路由、可信身份与迟到受理不制造幽灵回合。

- `test/mailbox-scheduler.mjs` 运行真实调度 send/gate 管线，验证延迟准入、固定通知 ID、满输入队列不接提醒和已读取消；`test/mailbox.mjs`：12 封信不占队列、长正文分页还原、读信身份、寄件回执、跨区回复、幂等、同批去重、失败留信、200 条以上保留、坏索引、停止 CLI 与 blocked 守卫。
- `test/mailbox-receive.mjs`：立即取信、响应总预算、未返回信保留未读、长信游标还原、旧游标重放、跨区时钟倒退、旧索引序号稳定、超时/取消清理、回执写前取消、观察失败/启动/删除/调度收口和历史完成去重。
- `test/worker-initial-assignment.mjs`：空会话无唤醒、短信无需读正文工具、有界长信偏移、并发及换调用方重试复用首信、实际投递与已读分离、未知状态重启不重放、旧首信和普通来信兼容。
- `test/mailbox-interrupt.mjs`、`test/mailbox-interrupt-pty.mjs`：调度和父子权限、同信重试/不同信并发、先存信、GUI abort 失败；真实受控 Node PTY 的 Ctrl+C、idle/退出后读信和写入失败留信。真实外部 CLI 的状态上报差异须另验。
- `test/host-tool-cancellation.mjs`：真实 stdio 入口 + 官方 MCP 客户端 + HTTP 网关取消；请求 ID 隔离与清理、网关关闭中止、正常请求结束不误取消。`test/e2e/subagent-role-avatar.spec.ts`：真实 Windows Electron 经工具创建、寄信、读信与父对子打断；等待/取消边界另由离线真实网关测试覆盖。
- `test/sessions-message.mjs`：统一寄信、父子/调度问答路由、长问题、答复后待答收口、真实持久存储及旧格式迁移；`host-tools-simplification.mjs` 验证旧工具和处理器实际删除。
- `test/gui-host-lifecycle.mjs`：忙时不排队或插话、通知 ID 重复投递和历史恢复、不把 host 提醒当用户原话。
- `test/unit/chat-message-avatar.spec.tsx`、`chat-host-message.spec.tsx`：GUI 映射宿主方印，无用户头像或 Setext 大标题。
- `test/e2e/subagent-role-avatar.spec.ts`：隔离 Windows Electron + 本地受控模型，经真实工具创建子代理、寄完整长报告、主动分页读信、保存读回执、去重、兼容汇报和 host 历史。受控模型证明宿主链路，不证明外部模型能正确组织复杂任务。
- `test/fixtures/mailbox-notice*.{tsx,mjs}`：生产组件/CSS，深浅主题与 780/390px 字号、换行、身份验收。
- `test/mailbox-presentation.mjs`、`test/unit/mail-envelope.spec.tsx`：待寄阶段无账本条目、上飞起点提交、提交失败时取消飞行、后台绕过同一账本的待寄邮件、幂等重试、合并上限、反向时钟、减少动态效果与清理。`test/fixtures/mail-envelope*.{tsx,mjs}` 在真实浏览器校验待提交时垂直轨道停在原位、双向轨道、上下同步与 780/390px 深浅主题。`test/e2e/mail-envelope-departure.spec.ts` 覆盖实际工具在分屏的收发顺序、隐藏窗口立即存信和切回前台不重放。

信件在本机 userData，跨机器或多宿主共享邮箱不在本次范围。未新增平台系统 API；Windows Electron 验证与跨平台共用代码测试不能代替 macOS/Linux 真机验收。PTY 没有原生事务性消息 ID，进程在键入提交与写提醒回执之间崩溃时无法保证严格一次；正文与读取状态仍持久保留，失败不会假报已读。界面未新增独立邮箱面板，模型通过既有工具访问。


## 明确的分页参数

模型面以 listOffset 表示摘要列表行偏移（includeBody=false 或默认 sent），bodyOffset 表示 messageId 指定单信的正文字符偏移；均从 0 开始，nextOffset 回填对应字段。批量正文/等待统一使用 nextCursor→cursor，不与显式 offset 混用。旧 offset 仍由执行层按原语义接受，新旧偏移同时出现且不一致时报错；bodyOffset 缺 messageId、listOffset 用于正文/等待均明确拒绝。身份、读回执和取消规则不变。

## 设计初衷（2026-10-25 与用户确认）

- 为谁/什么场景：所有 Agent（调度、GUI/PTY Worker、子代理）跨会话、跨 harness 通信的唯一可靠底座。
- 为什么这样设计：一切先落盘（stored≠已读≠已处理，崩溃不丢信）；运行中的模型不被普通信打扰，空闲后一条合并提醒；打断类优先原生插话、兜底才停进程且绝不伪造结果；最终回复不自动转寄，交付必须显式寄信。
- 明确不做：共享任务表、无常驻待答卡、不自动转寄回复、不占对话队列、跨机器/多宿主共享邮箱。
- 已确认取舍（2026-10-25 问答卡片）：**wakeUncertain 保守优先**——不确定就不重投，正文始终可读，靠观察/人工兜底；不做有界升级重投，也不加可视化补课。

## 信件正文 Markdown 展示

`ReadMailCards` 与 `MailEnvelopeViewport` 共用 `MarkdownBody displayOnly`，复用 GFM、数学公式和 CJK 强调修正；支持加粗、行内代码、列表、引用、表格与普通代码围栏。静态正文沿用 MarkdownBody/MarkdownContent 的 memo，动画阶段变化不重新解析不变的正文。

信件仍是外部数据，不是授权。displayOnly 跳过 UI artifact 插件、链接路由、本地图片解析和 Mermaid；所有链接仅展示标签，图片仅展示 alt，原始 HTML 不渲染，Mermaid 围栏保留源码，代码块不挂复制按钮。不会执行文件 stat、加载图片或挂载 UI iframe；即使误传交互属性也保持展示模式。普通聊天和文件预览的默认行为不变。

历史来信按正文页独立解析：残缺表格按 CommonMark/GFM 容错，未闭合围栏只延续到本页结尾，不影响下一页或下一封信；页首若从围栏中间开始，不推测缺失上下文。读取区间标记保留。来信气泡占满可用列宽，长代码在自身 pre 中横向滚动，不撑开会话。

信封仍是不可交互的固定高度节选，正文超出时裁剪，保留页脚，不提供三份独立滚动区。三个 es-letter-slice 使用同样内容与布局，正文关闭 content-visibility 的估算高度，代码在信纸内折行；表格、引用与代码继承原白色信纸的文字色，避免深色主题文字落在白纸上不可读。不修改折叠轨道、计时、presence 或邮箱状态；完整正文仍通过读信历史查看。

回归：`test/unit/mail-markdown.spec.tsx` 覆盖两入口、中文加粗、列表/表格/代码、未闭合围栏及下一封隔离、展示能力限制；撤回两个入口改动时两项用例失败。`test/fixtures/mail-markdown.tsx` 与 `mail-markdown-scenario.mjs` 使用真实生产组件/CSS、mock 邮件事件，在 Chromium 深浅主题 780/390px 检查信纸高度/页脚/切片一致、气泡边界与长代码滚动。验证仅为组件和浏览器层，不代表完整 Electron 收信链或 macOS/Linux 真机验收。
