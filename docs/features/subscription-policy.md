# 调度订阅策略

scheduler.policy.get/set 管理调度应如何处理事件。此能力在调度常驻清单直调（R5 后无发现层），仅调度调用链可以读取或修改；Worker 不投影同名工具。调度订阅事实与应用通知使用宿主原生通道，共用[邮箱持久队列与准入](session-mailbox.md)，但不作为普通来信返回；编排事件来源和归并见 [编排事件](orchestrator-events.md)。

## 规则与生效范围

策略文件位于工作区固定管理根的 .muster/scheduler/subscription-policy.json。用户规则按序首中，优先于内置规则；匹配字段为 kind、sessionId、trigger、factKind、orchestrated，字符串可用数组表示任一。runId 不属于匹配字段。已删除共享任务的 task_flip/to/from/actorRole/taskId 与 needs_review_stale 守卫不再接受。

| 动作 | 语义 |
|---|---|
| wake | 编排事件进入归并队列；订阅事实持久保存并允许唤醒或调度回合中插话，经 PI 隐藏消息交给模型 |
| digest | 保留信息但不单独唤醒。编排事件随下一次 wake 捎带；订阅事实/应用事件随下一实际回合进入隐藏上下文 |
| mute | 不向调度投递该通知 |

`digest` 不等于丢弃，也不等于关闭后续展示。旧版订阅事实以邮件保存，因此可能积累并被后续读信提醒合计；当前新旧宿主事件都排除在普通信件列表、读信提醒封数和调度普通未读数外，实际投递只显示一行事件活动提示。确实不需要的信息应使用 `mute`；不改变下述底线规则。

Worker 等人/出错、等人超时、回合网络失败、合入受阻、维度门红灯及工作流待答/失败/中断属于底线。即使用户规则写 mute，底线事件仍按 wake 处理。普通通信与用户提问不由订阅策略静音。

默认 pipeline.verdict 订阅可通知停滞；session.phase=needs_you 默认覆盖本工作区。编排会话相位事实由 phase 事件覆盖，内置规则静音重复事实；手工会话的相位事实默认仍通知，需静音可按 kind=fact、factKind=session.phase、orchestrated=false 写规则。

持久事件订阅使用独立 `kind=event.subscription`，`factKind` 为来源（例如 `gitlab`、`reminder`），`trigger` 为事件类型。无用户规则时以订阅的 instant/digest 为准；用户规则可按来源覆盖为 wake、digest 或 mute。调度的即时事件使用同一归并窗口（默认 25 秒，最长 45 秒）；Worker 不使用调度策略。提醒 app 的默认通知也经过该类别，未指定新规则时兼容原 `kind=fact` 的 app 规则与 app 自身 action。

调度的 instant 订阅事件在归并窗口到期后：空闲时按原准入唤醒；回合中通过 PI 原生隐藏自定义消息插话，收到上下文持久化回执后才记消费，账本 deliveryMethod 分别为 sent 和 steered。无原生能力或明确拒绝时记回落原因并等空闲，不反复插话；投递结果不确定时保留未消费记录并禁止盲目重放。等待人工期间不插话。Worker 仍仅在空闲时唤醒；digest 不单独唤醒。

`waitFor` 是调用方为自身武装的一次性续接，独立于上述持久订阅及归并策略；它复用事件日志和 Pi 底座插话能力，投递采用至少一次语义，详见 [会话续接与抢占投递](resume-wait.md)。

## 参数与存储

默认 mergeWindowMs=25000、maxWaitMs=45000；守卫 heartbeatMs=15分钟、needsYouMs=30分钟。解析读取时按条过滤错误并报告告警；工具写入要求 reason，有非法字段时整次拒写，不做半截生效。可命中底线的规则仍可保存，但会附底线提示。

SubscriptionPolicyStore 按 mtime/size 缓存，外部修改下一次读取生效；写入采用原子替换，历史记录改前/改后全文和原因，并通知用户。文件使用固定管理根，不跟当前选中的源码根漂移。命中计数仅在内存，重启清零。旧共享任务字段不自动迁成会话规则，旧文件不删除。

## 接线和边界

编排泵 enqueue → decidePolicyAction → wake/digest/mute → flush → deliverAgentMessage。策略判定在链上共**三个判定点，时序口径各不相同**：

1. **编排事件泵**：入队时判定一次，flush 投递不再重验——归并窗（默认 25-45s）内修改的策略按旧策略投递（窗口短，已接受）。
2. **订阅事实**：存信时判定一次（awareness/dispatch 保存带 hostNotification 元数据的事件），hostNotifications 在提交前重验当前策略——存信+prepare 双验，mute 可即时退役；经 PI 隐藏 custom message 交付内容，人只看简短活动提示。
3. **普通信件**（人/CLI/工作流直发）：完全不参与策略（设计如此，普通通信与用户提问不可静音）。

提交前重验区分事实、事件订阅与应用：事实走完整策略链；事件订阅走 `event.subscription`，默认尊重订阅模式；提醒优先新类别，再兼容原 app 规则。其他 app 通知仍只按用户 `fact` 规则或应用 action 判定。Worker 通知走普通邮箱。忙时等待、决策门及自治回合准入保留，通知保存失败不记成功。

| 文件 | 职责 |
|---|---|
| src/shared/subscriptionPolicy.ts | 类型、默认规则、底线、解析、生效值 |
| src/main/orchestrator/subscriptionPolicyStore.ts | 缓存、原子保存、历史、计数 |
| src/main/orchestrator/events.ts | 编排归并与存信 |
| src/main/awareness/dispatch.ts | 订阅事实的策略与持久化投递 |
| src/main/messages/hostNotifications.ts | 调度事件的实时策略重验、原生载荷与消费回执 |
| src/main/capabilities/hosts/subscriptionPolicy.ts | 调度身份门、参数与原因校验 |

当前没有独立设置页，用户可编辑文件或让调度调用工具；策略文件不随 Git 同步。事件合并队列在内存，尚未 flush 的编排事件不保证跨重启恢复；已保存到邮箱的通知遵守邮箱持久化合同。

测试：subscription-policy.mjs 覆盖默认/用户规则、底线、解析、归并存信、守卫、存储和权限；facts-subscribe-workspace.mjs 与 orchestrator-default-subscribe.mjs 覆盖通知、去重、退订和回声边界。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D01.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：用户控制调度对事件的唤醒姿态（wake/digest/mute）；`scheduler.policy.get/set` 仅调度调用链可用，用户也可直接编辑工作区固定管理根的 `.muster/scheduler/subscription-policy.json`。
- 为什么这样设计：用户规则按序首中、优先于内置规则；底线事件（Worker 等人/出错/等人超时/回合网络失败/合入受阻/维度门红灯/工作流待答失败中断）即使用户写 mute 也按 wake——「静音不能吞掉必须响应的异常」；digest≠丢弃（排本次投递外的下一次）；默认集只播种一次、退订后不自动复活（用户主权）；写入原子替换+改前改后历史+原因+通知用户，有非法字段整次拒写不做半截生效；按 mtime/size 缓存、外部修改下次读取生效。
- 明确不做：无独立设置页（文件+调度工具是全部编辑面）；策略文件不随 Git 同步；旧共享任务字段（task_flip/to/from/actorRole/taskId、needs_review_stale）不接受也不自动迁移、旧文件不删；命中计数内存态重启清零；归并队列内存态不保证跨重启恢复。
- 歧义点：无设置 UI 是终态还是待补？A=终态（订阅是 AI 自治面，调度工具是主要编辑口，文件是用户兜底；review 不把缺 UI 当 finding）／B=排期补设置页（易用性向，与 agent-rules 的设置 UI 对齐）。推荐 A。
