# 会话续接与抢占投递

`waitFor` 让调度或受管 Worker 在当前回合武装一次性等待后继续工作。调用方身份与工作区由宿主绑定，只能为自己登记。续接就是向原会话发送消息，不存在独立的 `wake` 能力开关；缺少插话或快照能力不能拒绝登记或空闲发送。条件命中时，`normal` 等当前回合结束，`preempt` 尝试已有抢占通道，没有通道则同样等空闲；回合先结束则保留等待，命中后发送到原会话。它不创建新 Worker，也不把会话状态当成任务结果。

```js
waitFor({ condition: { kind: 'mail', from: 'child-id', replyTo: 'mail-id' },
  note: '等子会话答复；收到后核对测试并更新报告' });
waitFor({ condition: { kind: 'event', source: 'gitlab', types: ['issue'], scope: '6528' },
  note: '检查事件并继续当前任务', priority: 'preempt', deadlineMs: 60000 });
waitFor({ condition: { kind: 'session', sessionId: 'child-id', phase: 'needs_you' }, note: '查看阻塞原因' });
waitFor({ condition: { kind: 'time', at: '2026-11-03T18:00:00+08:00' }, note: '到时检查结果' });
```

`mail` 可按发送者和回复 ID 过滤；已保存且未读的匹配邮件也可命中。`event` 以武装时的事件日志尾游标为起点，按已注册来源、可选类型及精确 scope 匹配，自定义事实沿用事件注册审核；不匹配的位点持续前移。`session` 观察 `needs_you` 或实际空闲，`time` 接受 ISO 本地或带时区的日期时间。`deadlineMs` 是相对超时；超时同样产生一次续接。`note` 最多 2000 个 Unicode 字符，原文交回，不作为外部数据；事件信封和邮件摘要明确标为不可信数据。邮件仍须调用 `sessions.readMessages` 获取正文，读取本身不等待。

## 数据流与可靠性

`capabilities/hosts/resumeWait.ts` 校验可信身份、条件和来源 → `resumeWait/store.ts` 将等待及事件游标写进 userData 的 `event-log.sqlite` → `runtime.ts` 接收邮箱落盘、事件发布、会话生命周期/相位和定时扫描 → `service.ts` 原子选定第一项触发并交给 `agentSession/delivery.ts` → 通过既有 GUI send、调度通知或 CLI 邮箱传输发送。GUI 使用关联输入的原生活动回执，CLI 使用传输受理回执；确认后将等待记为 consumed，该状态不表示任务完成。同一会话同时就绪的普通等待合成一轮，每条保留自己的说明和标识。

调度自身的 `needs_you` 相位允许空闲续接。实际开启调度回合时，宿主把状态处理提示加在原始续接说明前，保留触发内容和 `fireInstanceId`。待答提问卡、自治并发以及忙时抢占仍使用各自的准入条件。

等待记录保存由宿主提供的武装时桌面任务 epoch 和会话代次，模型参数不能指定这些值；已有 epoch 但缺少代次的旧记录按身份未知处理。身份来源读取出错时，等待仍可投递，错误进入诊断日志并把该等待标为身份未知。`desktopEpochs` 在续接桌面校验中重读当前任务：等待有绑定时必须与当前 epoch 和代次一致；明确无绑定仍走桌面首次授权，来源未知则冻结桌面。Worker 归档会递增会话代次。

停止代次与桌面任务 epoch 是不同的来源。`resumeWait/desktopSources.ts` 用独立宿主 SQLite 来源账，将等待 ID、会话、工作区和不可变等待内容绑定到受信回合的停止代次；来源只能从 GUI 工具入站时捕获的回合或调度工具调用时捕获的回合签发。HTTP 请求在接收头时固定桌面回合，慢请求不能借后来收到的新指令。来源登记可等待在途停止清理及用户授权，但不阻塞等待或文本；登记失败、来源未知和旧记录均不具备桌面授权。

调度及 GUI 空闲续接把宿主私有校验对象传给桌面回合；使用时重读停止代次、恢复 owner、当前任务绑定及批次中每条等待，任一内容篡改、来源缺失或失效都冻结该回合桌面。原生抢占在提交文本前将来源与当前桌面回合取交集，无法核实时取消或冻结该回合桌面；文本继续。可见调度任务通过 `desktopEpochs.continuationBinding` 只读核验持久身份，使当前进程重启后仍可核对来源；它不恢复旧截图许可。旧版依赖内存 TTL 的确认回执不自动复活。等待来源在原队列记录删除后分批清理。终端 PTY 等未取得可信回合来源的路径不会签发桌面续接能力。SQLite 来源账和等待队列均属宿主信任边界，不能防御同一系统用户同时篡改全部宿主存储。宿主主入口尚未构造并注入 `desktopTurns`，也尚未提供 `continuationBinding`，故这些组件接线不等于产品桌面入口已启用；未提供该方法时使用当前内存绑定，非空的调度旧绑定在重启后保守冻结。

底座仅声明可选的 `interject`、`snapshot` 抢占能力：空闲时选择普通发送通道；忙碌且 preempt 时先尝试原生插话，明确不支持才使用「持久快照 → 确认停止 → 双简报发送」；均不可用时保留到回合边界并静默排队；preempt 因缺少抢占通道而排队时发送「抢占不可用，已排队到回合边界投递」通知，不把它描述成未完成或需要核对回执。普通等待在忙碌期间不会反复创建投递记录。CLI 没有原生消息通道时复用普通邮箱的 PTY 键入或 relaunch-resume 路径，不要求 nativeOnly。会话删除、归档、普通 shell 会把仍未投递的续接记录标为 `cancelled` 并保留原因，不再在重启后反复尝试；工作区删除也会收口对应调度等待。宿主未就绪或实际发送失败仍返回真实错误，不伪造发送成功。打断类邮箱兜底与 `sessions.interrupt` 也在受管停止前记录工作区状态快照；GUI 额外保存有界的原输入与部分工作上下文，并明确标为历史数据而非新授权。工作树不可读取时记录未知而非干净。

事件按来源和 deliveryId 去重，邮件按 messageId 识别；单个等待只会选中第一个触发。续接投递采用**至少一次**：简报包含稳定的 `resumeRecordId` 和 `fireInstanceId`，每次重投使用新的投递 ID。GUI 的宿主受理不等于引擎开始：精确的 `turn-started`、当前已发送回合的正文/思考/工具活动或成功终态可以确认输入；准备期活动、旧连接、错误和取消不能确认，ACP 远端取消经通用 `turn-complete.cancelled` 表达。CLI 的 `accepted`（包括 written、native queued）表示传输已接手，直接结束该次投递，避免因没有 GUI 回执重复键入或入队；不据此声称模型已执行。宿主自己的忙时队列仍保留 ready 等空闲，不提前确认。

需要原生回执但 30 秒未取得时标记 uncertain 并告警，再等待 90 秒仍无确认则重投。已知未提交的失败使用 500/1500/4000ms 退避，持续失败按可用能力升级抢占；任何尝试的迟到回执都可关闭该等待。账本 `resume_wait_delivery_history` 保存 attempted、queued/deferred、uncertain、retry-due、redelivered 和 confirmed/confirmed-late 等轨迹。

对于 `time` 与 deadline 同时到期的等待，扫描按计划时间较早者触发；时间相等时选 `time`。例如设定时间 T+2 秒、deadline T+5 秒，T+6 秒才扫描时仍选择 `time`；反过来则选择 timeout。邮件、事件和会话状态依旧按实际处理时首先写入的触发确定，不声称对不同来源的历史发生时间全局排序。重启后重新扫描时同样比较保存的时间。

重投可能使同一续接出现多次；模型应按 `fireInstanceId` 忽略已处理续接，外部副作用必须由其业务接口自身实现幂等，宿主不声称 exactly-once。重启时重新扫描未决条件；正在提交的记录改为 uncertain 并进入宽限与重投。事件日志自身只保留 72 小时，日志外的事件不能从本地重放。显式 deadline 已过七天仍未消费时先告警再清理；已消费记录保留七天，投递轨迹独立保存。

## 当前能力与验证边界

| 接入 | 可选抢占能力 | 验证边界 |
|---|---|---|
| 调度 Pi | interject | 真实 Pi SDK + 离线模型验证隐藏消息、持久上下文和忙时插话；真实调度事件链待重启验收 |
| 内置 Pi GUI | interject、snapshot | SDK 离线模型及受管驱动夹具覆盖；完整 GUI Worker 链待真实验收 |
| Codex GUI | snapshot | 驱动回放验证关联的 `turn.started`；真实 Worker 唤醒待验收 |
| ACP GUI | 无 | 同一 `session/prompt` 连接空闲续发；忙时等回合边界。离线协议与状态机回归覆盖输入关联回执；各 ACP 引擎的真实唤醒待验收 |
| Codex CLI 原生 app-server | interject | 按实际启动绑定声明；兼容旧 CLI 无原生通道时复用普通终端输入 |
| 其他 GUI/CLI Agent | 可不声明 | GUI 沿 send 及通用事件回执，CLI 沿原生消息或 PTY/relaunch；没有原生插话只影响忙时策略 |
| 普通 shell | 不属于 Agent 会话 | 不把续接文本写成 shell 命令；不属于 waitFor 的受管 Agent 调用方 |

ACP 的空闲续接复用 GUI `send`，与普通邮箱的空闲提醒相同，不需要声明唤醒能力。每次 `session/prompt` 绑定本次宿主输入 ID；匹配活动会话的正文、思考、工具活动或权限请求证明引擎已开始处理时，驱动只发一次 `turn-started`。成功的对应 RPC 响应也能确认没有输出内容的回合。写入 stdin、会话配置通知、错会话/无会话 ID 的通知、拒绝、取消后的迟到内容及断线都不冒充开始回执。回执沿通用 GUI 事件处理器消费原等待，不为 ACP 另建等待队列。

ACP 的通知没有标准 prompt ID，因此驱动仅接纳当前串行 prompt 的会话内活动，并隔离已结束 prompt 的 RPC 回调；无法识别一个违背协议、在下一轮活动期间向同一 session 发送旧轮正文的第三方引擎。断连后能否恢复同一引擎会话，仍由该引擎的 `load/resume` 能力决定，不能用新会话冒充恢复。

`src/main/agentSession/piInterject.ts` 是 Pi 公共插话实现；Pi GUI 的可信宿主事件继续通过隐藏 custom message，不将宿主事件伪装成用户输入；用户显式插话则走 Pi SDK `steer()`，沿 Host 既有技能装配路径处理。`src/main/agent/injection-registry.ts` 登记续接注入；catalog、HOST 协议及调度/Worker 提示同步描述等待方式。事件订阅本身的策略与持久邮箱仍见 [运行时状态流](runtime-status.md) 和 [会话邮箱](session-mailbox.md)。

定向回归覆盖四条件、忙时/空闲、身份与回执、超时、崩溃重挂、重投与迟到回执、快照和 Pi 插话。`test/session-delivery.mjs` 与 `resume-wait-service.mjs` 验证不声明唤醒能力仍能登记和投递；`resume-wait-runtime.mjs` 运行真实续接、邮箱、PTY 提交链，覆盖没有能力声明的 GUI、无原生通道的 CLI、重拉恢复、忙时边界及传输受理后不重复发送。`gui-host-lifecycle.mjs` 验证各类规范化活动和静默成功的共用回执，以及准备期、旧连接、错误、取消与断流的排除。`test/acp-resume-delivery.mjs` 使用真实 ACP driver、NDJSON RPC 与续接状态机，覆盖活动/零输出成功、拒绝、取消、断线、错会话和旧 RPC 响应，以及忙时等待、空闲续发、回执消费后不重复投递。夹具和离线模型不代表真实账号、生产事件或所有平台验收；实际引擎的真实场景仍须单独验收。
