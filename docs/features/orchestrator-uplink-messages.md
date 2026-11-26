# 调度上行与唤醒通道

会话信件、订阅通知和编排事件采用各自明确的持久化及唤醒边界。普通信件通过邮箱读取；应用和调度事实订阅直接进入 PI 隐藏事件上下文，会话仅显示一行数量提示，处理指引和实际内容供 AI 使用。编排事件泵保留原有聚合信件路径；所有自动回合仍经过共享自治回合闸。隐藏输入、消费回执和信息预算见 [AI 应用通知](agent-apps.md#ai-上下文与人的活动提示)。

## 邮箱

sessions.message 是通用通信入口；to=parent 由宿主解析可信父身份，to=scheduler 用于询问调度。kind=ask/answer 与 replyTo 表达问答关联。requestIntegrate 继续校验 worktree 安全门，结果通知复用同一邮箱。

messages/deliver.ts 先保存完整信件，再返回 stored；GUI/PTY/调度统一。messages/wake.ts 在收件方空闲时合并提醒，只给数量及收信指引，不把正文塞进对话。读到正文才标已读；归档/删除不恢复；stored 和已读都不等于任务完成。失败保留信件与可重试错误。

父对子 interrupt:true 是唯一主动打断读信路径：先存信、中断当前回合、确认停止后再唤醒；保留会话和历史，重试不重复打断。普通寄信忙时不插话。详情见 [宿主邮箱](session-mailbox.md)。

## 订阅

events.subscribe/unsubscribe 合并内置事实与获准自定义事件。awareness/dispatch.ts 匹配后保存带结构化数据的事件邮件；相同事实对同一收件人合并去重，调度策略仍可 mute/digest，提醒不再回声为新事件。默认调度订阅仅 pipeline.verdict 和 needs_you 相位，Worker 默认无订阅。

这一链路不再经过专用调度事实接缝或把正文直投进 Worker。查询现态用 sessions.observe，默认不扫描 Git。订阅审核、作用域、限额和持久化见 [runtime-status.md](runtime-status.md)。

## 编排事件

OrchestratorEventPump（src/main/orchestrator/events.ts）按工作区归并事件，相同 key 后到覆盖。调度忙或有待答提问卡时保留队列，事件按订阅策略 wake/digest/mute 决策。当前种类由 shared/notifyQueue.ts 的 ORCH_EVENT_KINDS 定义。

| 种类 | 语义 |
| --- | --- |
| phase、turn_end、turn_error | 编排会话相位及回合事件 |
| commit、merge_blocked | Git 提交及主仓重叠阻塞 |
| heartbeat_stale、needs_you_stale | 长期无活动或待处理 |
| slot_free | 派活队列有待处理且出现空位 |
| settle_warn、dim_gate_red | 收口或维度门异常 |
| fact、workflow | 内部结构化事实/工作流通知；不作为订阅正文直投入口 |

共享任务状态翻转、旧正文注入排队/排空、专用通信审计副本入口均已移除。会话最终回复通过 sessions.observe 观察，不能由一次 turn_end 推断任务完成或代收件人标读。

人从 UI 创建普通任务时，delegateTask(notifyOrchestrator:true) 仍可通知调度会话已拉起；模型通过 sessions.create 自己派活时不再重复通知。排队尚未创建则不声称已拉起。此处普通任务指会话执行单元，没有共享任务池/依赖锁。

## 实现与验证

### 非运行中的调度如何进入下一回合

- 人工输入：桌面 `chat:send` / `sendNow`、飞书调度指令调用调度发送管线，不占自治回合闸。
- 外部 CLI：`cliRuns/wiring.ts` 的 dispatch 直接调用调度 send，要求空闲、没有 human wait 且取得自治槽；输入文件通过路径提供。
- 邮箱：跨会话消息、询问/答复、申请合入和 UI 派活通知均可存信，再由空闲提醒进入调度 send。约 120ms 合批，同批已提醒未读信不重复唤醒。
- 订阅：内置事实或获准自定义事件命中订阅，经过策略后进入持久投递账本；调度走原生隐藏上下文，Worker 保持邮箱。digest 随下一实际回合，不单独唤醒。
- 编排事件：相位、异常、补位、工作流和机械守卫先归并再存信。守卫每分钟检查，默认停滞阈值15分钟、等人阈值30分钟；没有命中条件不会调用模型。

编排 flush 和邮箱唤醒均会检查调度是否忙或有待答提问卡。调度自身的 `needs_you` 相位允许空闲唤醒，实际开回合时在原始唤醒指令前附上状态处理提示。邮箱传输通过 host/requireIdle 进入自治回合闸，全局默认 4 槽。队列重试、idle 边沿及启动扫邮箱用于恢复待投递输入。

触发任务定时/file/phase/webhook 先拉起 Worker；脚本工作流的定时/事件入口先执行脚本，待答或结束等通知才可经编排泵唤醒调度。`bgtasks.wait` 是 Worker 后台能力，不是调度自身的定时唤醒工具；前瞻意图事件当前发 UI 通知，不直接进入调度 send。

- src/main/messages/{deliver,wake,interrupt}.ts：邮箱、提醒与父对子中断。
- src/main/awareness/dispatch.ts：订阅转邮件。
- src/main/orchestrator/events.ts、src/shared/notifyQueue.ts：编排聚合和决策。
- src/shared/turnGate.ts、escalateBudget.ts：自治/熔断边界。
- test/mailbox*.mjs、sessions-message、facts-subscribe、events-register、orchestrator-guard-state、subscription-policy、escalate-budget：存信、幂等、防回声、隔离与准入回归。

跨平台共用既有 GUI/PTY 生命周期；真实外部模型、多引擎、macOS/Linux 和安装包需分别验收，不能由离线或受控模型测试推定。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D01.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：会话→调度的全部上行通道边界账：普通信箱（sessions.message，通用通信/问答/requestIntegrate）、订阅事实（PI 隐藏上下文+一行活动提示）、编排事件（归并信）；以及非运行中的调度如何进下一回合（人工输入/外部 CLI/邮箱/订阅/编排五路各自动态）。
- 为什么这样设计：deliver 先存完整信件再返回 stored（GUI/PTY/调度统一），失败保留信件与可重试错误；wake 只给数量+收信指引不塞正文，读到正文才标已读，stored/已读≠任务完成；父对子 interrupt:true 是唯一主动打断读信路径（先存信、中断当前回合、确认停止再唤醒、重试不重复打断），普通寄信忙时不插话；全局自治并发 4 槽统一兜底；队列重试/idle 边沿/启动扫邮箱只用于恢复待投递输入，不凭空产生新任务。
- 明确不做：不把订阅正文直投进 Worker；共享任务池/依赖锁不存在；turn_end 不代收件人标读、不推断完成；前瞻意图事件当前只发 UI 通知不直接进调度 send；`bgtasks.wait` 是 Worker 后台能力不是调度定时唤醒工具。
- 邮箱和编排事件可以给空闲调度带来解除卡点所需的新信息。调度自身的 `needs_you` 相位随唤醒指令提示处理，待答提问卡保留等待边界。
