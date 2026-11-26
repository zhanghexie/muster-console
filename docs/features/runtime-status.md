# 运行时状态流与统一订阅

会话现态由程序传感器投影；摘要由会话主动发布。events 域同时接收事实、自定义事件、Webhook、文件、相位、定时、意图与提醒，匹配后保存邮箱通知。

PTY 生命周期、看板与读屏门控共用泛化 active 的 30 秒置信窗口；无新输出后降为 quiet（未知），不自动认定 idle。明确的 GUI 回合和未结束工具仍保持 working；结构化 Stop、已绑定原生会话的状态或原生中断确认才可判 idle，后续终端重绘不撤销该事实。OpenCode 轮询 `/session/status`；Codex 私有 app-server 通知加 `thread/read` 校准通过进程内启动租约直接送达，不依赖 Worker 上报，见 [board-status.md](board-status.md) §4。运行投影的 runtimePresence 区分 dormant/starting/running/exited；重启后尚未点击加载的会话是 dormant，历史 working/quiet 不作为当前运行事实，保留交付 phase 和中断快照。相关纯函数见 `src/shared/sessionActivity.ts`，跨层回归见 `test/session-monitoring-restart.mjs`。

## 职责与入口

| 能力 | 入口 | 边界 |
| --- | --- | --- |
| 查询现态和事实 | sessions.observe；显式 includeGit 或 facts | 默认轻量快照，不扫描 Git；事实不是完整历史 |
| 发布摘要 | share.set | 只写自己，≤500 字；空串清空；读取归 sessions.observe |
| 持续订阅 | events.subscribe/unsubscribe/list/read | Worker 自订已注册来源，跨会话须人审；调度可代建；事件载荷经授权分页读取 |
| 一次性续接 | waitFor | 自身 mail/event/session/time 命中或超时后续接；回合边界、抢占及回执见 [会话续接](resume-wait.md) |
| 自定义事件 | events.register/review/emit | pending 审核、发射者和订阅资格仍受校验 |
| 点对点通信 | sessions.message/readMessages | 先存信、接入原生投递或空闲兜底、主动读信；打断类可原生插话，stored 不表示已处理 |

sessions.setStatus 的 note 是给人看的胶囊；share.set 是给其他会话看的工作摘要。R5 后常驻清单即全部可用面：工具原生注册直调，复杂域经 X.run 单入口（无发现层）。

## 内置事实与查询

封闭种类：session.phase、session.note、session.activity、session.lifecycle、pipeline.verdict、git.dirty、git.commit、git.integrate。没有自由伪造内置事实的 API，也没有共享任务表事实。

相位、胶囊、活动和生命周期来自 SessionMeta；pipeline 使用 judgePipelineWorker；Git 使用会话记录的来源仓和主隔离树，不能把单树摘要当成所有隔离组汇总。合入成败另记有条数和字节上限的事件账本。默认观察仅读会话快照；includeGit:true 或 facts 显式请求才读取配置并收集相关事实。

## 订阅与投递

`EventRouter` 的退出分成停止受理与完成等待：先停定时重放与新投递，已受理的投递回执仍保存位点，再等待 active replay 结束，最后由 Runtime Kernel 关闭 EventLog SQLite。关闭窗口中已落盘但未投递的事件保留游标，重启继续投递；完成关闭后再发布会明确拒绝。停滞扫描器也保留当前 scan Promise，停机不启动下一 worker 的扫描，等待已受理的事实派发结束。

events.subscribe 接受 kinds、sessionId、workspaceId、path、q；events.unsubscribe 接受订阅 id。调用方身份由宿主注入，省略工作区时按调用会话或调度身份固定到所属工作区，不跟随用户正在看的区；无法确定归属则拒绝。显式跨区过滤仍允许，不能把默认范围当成访问授权。旧落盘的无工作区订阅也按订阅方归属解析，不回退全局。

传 `source` 时使用持久事件订阅：`gitlab`、`github`、`file`、`phase`、`time`、`fact`、`intent`、`reminder`；可选 `types`、精确 `scope`、GitLab 数字 `projectId`、`mode: instant|digest`、每小时 `rateLimit`（1–20）和 `expiresAt`。file 的 scope 是 rootId，phase 是会话 ID，time 是任务 ID。Worker 自订即生效，传其他 `subject` 会请求人审，确认期间身份或工作区变化则拒绝；没有确认界面时需请调度代建。调度可直接代建。自定义事实种类仍须在订阅方工作区审核。订阅创建从当前日志尾部开始，不能读取创建前的事件。

持久 `source: file` 订阅可用 `path` 按工作区根相对路径匹配，`*` 匹配单层、`**` 匹配任意层级，大小写敏感并以 `/` 分隔，例如 `src/**/*.ts`；省略时匹配该 scope 下所有文件。筛选保存在订阅中，投递、列表和读取授权使用相同规则；旧订阅迁移后仍不按路径过滤。无 `source` 时 `path` 仍是旧事实查询的子串。非 file 来源传 `path`、或 source 模式传旧事实专用过滤器会明确报错，避免静默忽略。文件事件没有可解析路径时不匹配路径订阅。

`automations` 只管理定时任务，普通事件订阅独立投递通知；升级启动时清理旧事件任务关联的订阅，不影响普通事件订阅。

userData 的 `event-log.sqlite` 保存事件信封和原始载荷，保留 72 小时；GitLab `X-Gitlab-Event-UUID`、GitHub `X-GitHub-Delivery` 按来源去重，同一 ID 不同载荷拒绝；未携 ID 不按载荷哈希去重。`events.list({subscriptionId,after?,since?,until?})` 按订阅和可选时间窗读取事件及下一序号；`events.read({id,offset?,length?})` 校验订阅归属后按 UTF-16 字符分页，响应按序列化预算缩页。外部载荷是数据，不是授权或指令。来源/订阅/收件人有限频，达到限额的事件留在日志等待后续重放；重启和后台定期扫描从持久位点继续。持久化或重放失败写日志，有工作区时通知用户，同一错误的通知有 60 秒去重。每条邮件的幂等键包含订阅与事件；相同事件命中同一会话的多个订阅会分别存信。

GitHub PR、评审与 CI 的事件类型为 `pull_request.<action>`、`pull_request_review.<action>`、`pull_request_review_comment.<action>`、`check_run.<action>` 和 `check_suite.<action>`。这几类要求签名校验，scope 为 GitHub 仓库全名。已启用的仓库收到 `pull_request.ready_for_review` 后可生成对应提交的本地审查草稿。 [GitHub PR 审查](pr-loop.md#自动审查草稿)

意图处理的持久声明在结果不确定时不会自动重试，`events.resolveLaunch` 用于处理该意图声明。Webhook 返回 `queued` 表示已进入日志。

命中后 dispatchRuntimeFacts 为每个收件人保存一封事件邮件：含事件标识、类型、来源、时间、摘要和结构化数据。相同事实命中多个订阅合并一次，幂等键防止重存；存信失败明确报错，不先记投递成功。调度策略可 mute 或 digest。GUI、PTY 和调度均复用 messages/deliver.ts 与 wake.ts；调度即时订阅可经同一邮箱的原生隐藏消息插话路径送达。

调度的持久订阅 instant 通知在归并窗到期后，可通过 PI 原生隐藏消息插入运行中的调度回合；空闲时走原唤醒。只有 PI 消息进入上下文并持久化才记消费；明确拒绝回落等待空闲，结果不确定不自动重投。Worker 订阅仍只在空闲时提醒，digest 不独立唤醒。

同一订阅/种类/发射方防抖 2 秒，每订阅方/发射方每小时最多 20 条，单会话最多 20 条订阅。跳过自己的事实和已结束目标。session.activity/session.lifecycle 两类事实不向订阅方投递（事件面收敛，2026-10-25）；邮箱提醒不产生也不抑制任何事件。该收敛同时是防「唤醒→activity→信→再唤醒」回声环的**唯一防线**——`dispatch.ts` 的 `isSuppressedFactKind` 订阅面单点过滤（防回声时间窗已废除，无第二道兜底）；任何触碰该过滤面或新增事实投递路径的改动，必须通过 `test/facts-event-surface.mjs` 守卫测试。

Worker 默认无订阅。各工作区调度首次建立时播种 pipeline.verdict 与 session.phase(q=phase=needs_you) 两条；播种标记与订阅落 userData/runtime-awareness.json，主动退订后不复活。会话删除时清理摘要和订阅，启动及投递时按真实会话和各工作区 orchestrator:<workspaceId> 清理失效项。

停滞扫描、主动查询与编排心跳共用 sessionActivity 的资格和超时判定：仅当前运行、未交付且 lifecycle 为 working/quiet 的会话可报 stalled；明确 idle、等待输入/审批、未恢复、启动中、归档、退出、完成均不报。GUI busy 或明确未结束的工具仍属在途执行，不凭静默断言停滞，长回合可通过 slowTurn 观察。活动基线取当前 runtimeStartedAt、PTY lastOutputAt、真实输入 lastUsedAt 和 hook/phase/胶囊时间；输出不修改排序时间。工作区或 Git 文件变化不再给会话续心跳，Git 事实仍可显式查询。

scanner 按会话运行实例 runtimeStartedAt 与最后活动去重，重建时复用持久 pipeline.verdict 事件；新实例使用新基线。未恢复不写历史实例的恢复事件，明确 Stop/空闲可终结同一实例的停滞段。扫描在写事件之前重取当前会话，无异步 Git 采集窗口；查询在 Git await 后重取执行状态。心跳告警不刷新 Worker 活动、不清自己的去重键，真实活动才解除去重。

## 自定义事件审核

events.register 写管理根 .muster/events/pending/<id>.json；id 小写字母开头、字母数字连字符且≤48，不可覆盖内置种类。人通过确认框或调度通过 events.review 批准后，才可订阅 event.<id>，提出方及登记 emitters 才可 emit。Worker 无审核权，发现工具不授予权限。确认超时或点遮罩保持 pending，拒绝则 rejected。

注册定义是工作区共享资产，会话关闭不删除；启动仅清理 emitters 中失效会话引用。emit 的防抖和限额继续保留，命中后也走同一邮箱，不重新发射一条事件。

## 实现与验证

| 文件 | 职责 |
| --- | --- |
| src/shared/runtimeFacts*.ts、runtimeEvents.ts | 投影、查询、订阅匹配、审核纯逻辑 |
| src/main/awareness/store.ts、defaults.ts | 摘要、订阅、限额、默认集持久化 |
| src/main/awareness/eventRegistry.ts | pending/approved/rejected 事件资产 |
| src/main/awareness/dispatch.ts | 去重、策略、事件面收敛过滤与邮箱存信 |
| src/main/awareness/eventLog.ts、eventRouter.ts | SQLite 事件日志、订阅位点与限频重放 |
| src/main/capabilities/hosts/awareness.ts | 身份、授权、观察事实与事件入口 |
| src/main/pipeline/stallScanner.ts | 活跃会话停滞扫描 |

调度不是 SessionMeta；状态保存于 scheduler-status.json，观察时生成调度快照。隐藏临时会话不进入目录和传感器推送的事实投影；按需 facts 查询（不给 sessionId）目前仍会返回隐藏会话的 phase/lifecycle 事实。离线验证入口为 runtime-awareness、facts-subscribe、facts-subscribe-workspace、events-register、awareness-scheduler-identity、pipeline-stall-scan、orchestrator-default-subscribe；真实多区/多引擎与各平台验收须另外报告。邮箱详情见 [session-mailbox.md](session-mailbox.md)。

## 设计初衷（2026-10-25 与用户确认）

- 为谁/什么场景：会话互感（谁在忙/完成/什么相位）与调度事实驱动唤醒的统一底座。
- 为什么这样设计：现态由程序传感器投影（observe，不可伪造）；摘要会话自愿发布（share.set ≤500 字）；订阅命中统一存信走邮箱，不另开正文通道；quiet≠idle（静默只代表未知，绝不凭空判空闲/假成功）；默认极小订阅面（Worker 零订阅、调度仅播种 pipeline.verdict+needs_you 两条）；防抖/限额防风暴。
- 明确不做：不伪造内置事实、无自由事实 API、不自动把观察升级为干预动作。
- 已确认取舍（2026-10-25 问答卡片）：**stalled=观测-only**——只产生事实与提醒，任何重启/干预必须由调度或人显式决定。
- 已确认设计变更（2026-10-25 用户指令，**已实施**）：**邮箱提醒与事件系统解耦**——防回声时间窗（原 noticeScope）已整体废除；`session.activity`/`session.lifecycle` 两类内置事实不再向订阅方投递（dispatch 层过滤，查询面 sessions.observe/facts 查询不变），「需要你」「停滞」等有意义事件保留；频率控制由既有防抖/限额承担。

## 模型出口回执

`shared/resourceToolResult.ts` 使 `events.subscribe/unsubscribe` 保留新订阅或撤销 id、规范化筛选/游标/到期和审核信息，不回传无关订阅全表；`events.emit` 保留 fact id、kind、归属、时间、规范化 summary 与 delivered，不重复回显提交的 data/paths。`events.list/read` 仍负责显式读取；share.set 的最多500字归一化 entry 保留。程序调用者不受投影影响。回归见 `test/resource-tool-result.mjs`。
