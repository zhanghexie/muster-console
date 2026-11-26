# 编排事件与调度唤醒

编排事件泵把相位、停滞、并发空位、合入风险和工作流事件归并成通知信。普通状态与自定义事件订阅统一使用 events.subscribe/unsubscribe；调度订阅命中后通过持久投递账本进入 PI 隐藏事件上下文，会话只显示数量提示，Worker 订阅继续使用邮箱。即时状态读取使用 sessions.observe。共享任务表、任务翻转、任务悬挂守卫和简报注入排空事件已经删除。

## 事件与范围

按会话产生的编排事件只跟踪 SessionMeta.orchestrated=true 的普通会话；隐藏、已删除或已归档会话不报。phase=done 后不再产生心跳、needs_you 超时、回合结束或失败提醒；进入 done 的相位转换本身保留策略和工作流观测能力（默认静音）。调度经 sessions.create 派活会自动置位；UI、扩展和 Worker 创建不自动收编，父子关系也不等于编排关系。调度可用 sessions.setOrchestrated 显式修改。排队派活保留捕获的调度身份。

| 来源 | 入口 | 默认行为 |
|---|---|---|
| needs_you / error 相位 | NotifyBus.onFlip → onFlip | 唤醒 |
| done 相位、回合结束 | onFlip / onTurnEnd | 刷新或清理守卫状态，默认静音 |
| 网络续作用尽 | onTurnFailed → turn_error | 唤醒 |
| 隔离树提交 | onGitReflog / onFsChanged | 默认静音 |
| 空位释放且仍有排队 | onSlotFreed | 唤醒 |
| 合入受阻、维度门红灯 | enqueue | 唤醒 |
| Worker 任务仓检查重试耗尽或快照失败 | workerTreeGuard → merge_blocked（worker-tree-guard key） | 同一持续问题去重后交调度，不回注 Worker、不刷新心跳 |
| 心跳 / needs_you 超时 | tickGuards | 唤醒，去重状态持久化 |
| 部分采纳、PR 已合并待核对 | settleNotify / prMergedWatch → settle_warn | 唤醒 |
| 工作流进展 / 待答 / 结束 | enqueueWorkflow | 进展顺带；待答、失败、中断、完成唤醒 |

会话守卫只读实际生命周期、相位、最后活动和忙状态，不查共享任务。fired/lastActivity 的持久化及活动清键继续保留。工作区级的合入、并发与工作流信号不受会话编排标记过滤。

## 持久化与唤醒

会话信号在 enqueue 与 flush 两处检查当前状态，wake 与 digest 都过滤，避免告警入队后会话归档、旧告警仍延迟投递。终态扫描清除 needsYouSince 和两类 fired 键，取消归档或重新激活后可再次告警。已保存的邮件不追溯删除。merge_blocked、dim_gate_red、settle_warn、并发补位和工作流属于独立风险或工作区信号，不因附带会话归档而丢弃；普通 facts 订阅的历史事实不在这里改写。

digest 的 phase pending 只保存事件 envelope 和顺序，正文继续以 `events` 表为唯一来源。打开旧库时会把仍由 pending 保留的旧正文恢复回 `events`，再移除历史重复列；保留中的事件不会被 retention 提前删除。

2026-11-03 排查：evaluateOrchGuards 原已过滤 archived/hidden，heartbeat 共用资格函数也排除 done，needs_you 判定只接受该相位。setArchivedOne 设置 archived/exited、保留历史 phase 是预期存档行为。已证实缺口是 flush 未复核终态，以及 onFlip/onTurnEnd/onTurnFailed 接受终态迟到事件。test/orchestrator-terminal-state.mjs 用可控时钟复现“超时入队→调度忙 hold→归档/done→flush”，覆盖两类守卫恢复告警及 digest 清理；还原修复后断言失败。未读取历史现场私有存储，不能断言指定历史邮件必然来自这一时序。

泵在 enqueue 时执行订阅策略，wake 进入归并队列，digest 进入顺带段，mute 不入队。默认合并窗口25秒、最长45秒；同 key 后到覆盖，wake 最多40条，顺带最多20条。只有 digest 不唤醒。

flush 检查开关、是否有 wake 事件、目标调度是否忙及是否有待答提问卡。调度自身的 `needs_you` 相位允许存信和空闲唤醒。hold 保留队列并重试；可发送时把归并正文交 deliverAgentMessage 存入调度邮箱，保存失败恢复队列并报告错误。

邮箱统一发有界读信提醒；调度的自治回合准入继续在提醒发送处生效。收件人主动 sessions.readMessages 取正文，保存、提醒、已读和业务完成是不同状态。信件保存及已读回执不会变成新事件；防回声时间窗（原 noticeScope）已随邮箱与事件系统解耦整体废除，提醒引发的纯 lifecycle/activity 变化由 `dispatch.ts` 的事件面收敛过滤拦截（这两类事实不再向订阅方投递），避免循环唤醒；后续真实业务相位仍可发布。

## 统一事件订阅

心跳守卫与 pipeline 扫描共用当前执行资格及超时函数。已派过任务不再意味着当前仍在运行；dormant、idle、等待用户和明确在途执行不报停滞。每次 tick 读取会话自己的启动/输入/hook/输出时间，真实活动解除持久去重；告警入队不刷新活动。文件监听无法归属具体 Worker，因此不再将工作区文件变化广播为全体 Worker 心跳。needs_you 的待处理提醒仍独立保留。

awareness/dispatch.ts 匹配内置事实和已批准的自定义事件。默认工作区取可信订阅方；旧无工作区订阅按订阅方归一，不扩大到全部工作区。同事件命中多个订阅，每个收件人只寄一封，邮件保留源事件 ID、类型、数据、发生时间与订阅 ID。先保存成功再提交限频账，失败允许以同一事件身份重试。

调度缺省订 pipeline.verdict 和 session.phase=needs_you；Worker 默认无订阅。默认集只播种一次，退订后不自动复活。调度事实订阅仍过 scheduler.policy：编排会话相位由 phase 事件覆盖，避免重复；手工会话相位可按用户规则静音。digest 通知存信但不单独唤醒，mute 不寄信。

模型面订阅写入回执只返回本次新增的 `subscription`（含 ID 和归一化条件）或退订的 `id`，不附带整份订阅清单；可用 `host.events.list` 查询当前获授权的订阅。列表是查询时的当前状态，不是写入时的快照。跨会话订阅即使获批也不授予 Worker 读取目标其他订阅的权限。宿主内部调用仍保留原始结果。

自定义来源的 events.register/review/emit 保留 pending 审核、合法发射者和订阅资格。发现目录只说明可用入口，不提供审核权。旧 schedulerFactSink/enqueueFact 第二投递路径已删除。

事实事件写入持久日志时，投递 ID 由事实字段 ID 和完整 payload 摘要共同组成。同一事实的完全重复写入保持幂等，字段值变化会产生新的事件记录，避免复用稳定字段 ID 触发 `Conflicting event delivery ID`。

## 关键文件与验证

| 文件 | 职责 |
|---|---|
| src/main/orchestrator/events.ts | 编排归并、守卫、策略、存信 |
| src/shared/notifyQueue.ts / orchestratorGuards.ts | 归并和纯判定 |
| src/main/awareness/dispatch.ts / store.ts | 统一匹配、去重、默认订阅 |
| src/main/messages/wake.ts | 空闲提醒、自治准入（防回声时间窗（原 noticeScope.ts）已随邮箱与事件系统解耦整体废除；回声防护单点在 `awareness/dispatch.ts` 的事件面收敛过滤） |
| src/shared/subscriptionPolicy.ts | 用户规则、默认、底线、阈值 |
| src/main/agent/injection-registry.ts | 邮件与读信提醒的注入登记 |

验证见 subscription-policy、orchestrator-default-subscribe、orchestrator-guard-state、facts-subscribe-workspace、events-register 和 mailbox 相关测试。工作流 tap 在策略判定之前取得原始事件，继续用于 wf.waitFor；不再支持任务表翻转条件。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D01.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：调度 Agent 的多 Agent 感知主通道——相位翻转、停滞守卫、并发空位、合入风险、维度门红灯、工作流进展/待答归并成通知信；wake 唤醒进回合、digest 随下次唤醒顺带、mute 不投递；Worker 订阅继续走邮箱。
- 订阅策略单点决策，归并窗口 25s、最长 45s，同 key 后到覆盖，wake 最多 40 条、顺带最多 20 条。flush 在调度忙或有待答提问卡时保留队列重试，保存失败恢复队列并报告错误。邮箱发有界读信提醒，收件人主动 readMessages 取正文。事件面过滤纯 lifecycle/activity，防止提醒回声。守卫按实际生命周期、相位和活动判定停滞，真实活动解除持久去重。
- 明确不做：共享任务表、任务翻转、任务悬挂守卫、简报注入排空事件已删除；工作区文件变化不广播为全体 Worker 心跳（无法归属具体 Worker）；done 相位/回合结束默认静音；一次 turn_end 不推断任务完成；手工会话相位事实默认仍通知（与编排会话由 phase 事件覆盖不同）。
- 歧义点：①归并队列纯内存、重启丢未 flush 事件——A=接受（相位/守卫条件持续存在会再产生事件，digest 丢失可容忍；review 不把不落盘当 finding）／B=队列落盘跨重启恢复。推荐 A。②done/回合结束默认静音是终态姿态吗（调度对「Worker 干完了」不即时感知，靠下次唤醒 digest 顺带或主动 observe）？A=终态（防唤醒风暴优先；用户可用规则把 done 设 wake，逃生门已在）／B=默认应唤醒（完成即派下一步的即时性优先）。推荐 A——改默认属产品姿态变更，应由用户明示。

## 退出所有权

事件泵`stopAdmission()`关闭新事件、tap和调度，`shutdown()`等待已经受理的邮箱投递结束；迟到投递完成不重挂定时器或通知态势写入器。Git reflog watcher 按物理 Git 目录去重并打开原生监听。启动时尚无 `worktrees` 目录会做一次延迟复查，覆盖原生监听注册期间漏掉的建目录事件。路径解析失败时记录诊断。监听用共享`WatcherLifetime`跟踪原生close，替换或停用后的句柄继续归属owner，`GitReflogWatches.shutdown()`等待其实际关闭。原同步stop/dispose仍可请求暂停，最终应用退出必须等待异步屏障。相关回归为`runtime-observers-shutdown.spec.ts`、`orchestrator-turn-end.mjs`和`workspace-fs-watch-roots.mjs`。
