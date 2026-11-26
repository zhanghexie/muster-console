# 后台任务（后台终端 / 定时唤醒）

受控命令回收失败时保留其认证通道和持有 leader，关闭请求仍拒绝新输入并结束待确认的 stdin 写入；只有进程容器确认释放后才关闭 IPC listener。这样在发出终止信号前发生的临时错误可用原 owner 重试，避免销毁通道触发 leader 自退而丢失 POSIX 进程组身份。已发 SIGKILL 后根进程先退、剩余组状态未知的情况仍明确失败，不以旧 PID 重试冒充确认。

> **2026-10-20 子代理已移除**：`bgtasks.spawn` 及其执行路径（`startSubagentTask`、`bgtasksSpawn` 能力位）已删除。子代理不再是「会话内后门」，而是**带 `parentSessionId` 的普通 worker 会话**，由 `delegateTask` / `sessions.create` 拉活——runtime 限制与「不能递归」的限制随之消失。方案与实施记录见 子代理通用化计划；子代理在左栏的树形呈现见 [会话栏 §10](sessions-dock.md)。
>
> 本文档现存描述只覆盖**后台终端（shell）**、**定时唤醒（wait）**、**查询（list）**与**终止（kill）**——它们与子代理无关，保留。

GUI（chat surface）会话内，声明后台任务能力的 Worker 可以把工作派到**后台**，在后台终端跑命令（含 dev server 等长驻进程）、设定时器到点自唤醒。ZCode 经宿主 MCP 桥接这些工具；引擎每轮重启不直接终止工作台管理的任务，其实际工具发现、调用和唤醒仍待用户验收。有任务记录即在输入框上方显示**胶囊**（清空记录后消失），点击弹出**面板**实时查看与介入。

## 职责与语义

| 工具 | 作用 | 完成通知 | 权限类 |
| --- | --- | --- | --- |
| `bgtasks.shell` | 后台终端跑一条命令（独立 PTY，长驻可保持 running） | 默认静默；`wake:true` 仅成功唤醒；失败默认静默，`wakeOn:'fail'\|'always'` 才跟进失败 | shell |
| `bgtasks.wait` | 定时器（delaySec 或 HH:mm/ISO，上限 24h），等待期零消耗 | 到点自动唤醒 | status |
| `bgtasks.list` | 列任务与结果摘要 | — | read |
| `bgtasks.kill` | 终止任务 | — | status |

立即启动的 shell 回执提供任务 ID 和实际唤醒策略。前台命令超时转后台时只返回任务 ID 和管理器的超时原因，后续通知仍由唤醒策略决定。定时器回执提供任务 ID 和解析后的毫秒数。命令和到点事项存入任务，后续列表与通知继续使用原值。

**通知路由**：父会话 busy 时经 `host.send` 优先尝试原生插话，明确不支持时由宿主排队；ZCode 当前使用队列。空闲时 wake 类任务经 `host.send` 接受一个新回合（消息带【后台任务】前缀）。P17：完成注入带 taskId+创建时刻；`shouldInjectBgWake`——shell 失败默认不唤醒（`wakeOn` 缺省 `success`）、同会话同命令族只留最新一条、会话已 `needs_you`/`idle` 且已有更新成功任务时丢弃更早失败。定时器缺省 `always`。静默 shell 结果置 `pendingDigest`。

任务终态先持久保存，再以 task.id 写 Kernel 结果事实；终态与父通知状态分开。`parentNotification` 记录 pending/accepted/unknown/digest/digested/disabled，`pendingDigest` 直到真实确认前一直保留。父 wake 使用稳定 `background-wake-<task.id>` 请求；`ok: true` 只表示宿主接受或排队，不证明模型成功。明确失败仍保留摘要；投递未知不自动重发，并通过现有通知提示检查原生历史。已删除的任务不恢复，退出仍遵守 receipt callback 的 stopAdmission 所有权。

`prepareDigest` 返回任务 ID 与结果指纹，不修改持久状态。Host 仅在 confirmed、非空、无 error/aborted 的回合收口后调用 `ackDigest`；发送前失败、模型失败、中止或无可信完成信号均保留结果供下轮重试。ack 只消费本次准备且指纹仍匹配的结果，新完成任务或后来变化的清理摘要不被误清；确认落盘失败回滚内存消费状态。已包含在 wake 正文的任务仅登记确认身份，不重复拼同一段摘要。结果摘要可能因不确定回合而再次进入上下文，不代表重复执行任务。

**回调呈现（2026-09-14 定稿：引擎可见、转写不显示）**：wake 回调经 `host.send` 的 `hiddenFromTranscript:true` 只注入引擎上下文——空闲开新回合 / busy steer 注入 / steer 失败入队（派发时同样无转写消息），三种路径均不产生 GuiChatMessage、不落 UI 历史；用户从输入框上方胶囊（未读徽标）与面板看结果。定稿过程：先实现过「系统通知卡」渲染（origin 标记 + bg-notice 分支），用户验收后改为完全隐藏（与静默 digest 同语义：forkTranscript 同款「只进引擎、不进 UI」）。

**注册表落盘（2026-09-01）**：任务记录（不含消息流）debounce 写 `<userData>/bg-tasks.json`（tmp+rename 原子写；已完成任务留 7 天、总量 300 条）。启动 replay：中断的 running 任务标 error「应用重启，任务中断」并置 `pendingDigest`，父会话下一回合即知；timer 不跨重启（到点语义无从恢复，同样按中断报）。借鉴 rpiv-todo「真源是文件不是消息」。

**来源绑定**以父会话的 workspaceId、sourceRoot 与当前执行 cwd 为准，并保存目录物理键。隔离 Codex 的 Shell 在映射后的 worktree 中运行，来源仍指向源根。旧父会话仅在归属唯一时补齐来源。来源缺失、离线或调用上下文与父会话的实际执行 cwd 不符时会报告错误。历史记录保留任务启动时的目录。

Shell 配置档探测后均重验目录/登记身份；移除根、Junction 改指向、父会话改来源/关闭或在途取消不能启动到另一位置。定时器到点重验来源，完成通知不能唤醒已经改来源的父会话，结果仍保留在面板与待消费摘要中。

子代理的目录继承（默认继承父、可覆盖）不走本模块——它是普通会话，来源由 `delegateTask` 的来源绑定决定，见 子代理通用化计划 §5.3。

## 关键文件

- `src/shared/backgroundTasks.ts` — 合同：BgTaskRecord/推送载荷/摘要构建/`parseTimerDelayMs`（零依赖可测）
- `src/main/agentSession/background/manager.ts` — `BackgroundTaskManager`：任务注册表（按父会话）、并发 ≤4、快照(120ms)/消息(200ms)节流推送、完成路由、killAll、remove/clearFinished（完成态可删，running 拒绝）
- `background/transcript.ts` — `TranscriptAssembler`：driver 事件 → GuiChatMessage（host.handleEvent 任务级同构，零依赖可测）
- `background/shellTask.ts` — 后台终端：命令本身作 PTY 进程 spawn（`bg-<taskId>` 键进现有 PtyManager，scrollback/合流广播零成本复用；渲染层对未知 sessionId 的 pty:data 直接丢弃）
- `background/source.ts` — 父会话来源快照与启动守卫，复用 `sessions/targets.ts` 校验真实目录及已登记外置树；源根身份与实际 cwd 分开。
- `src/main/shell/bgLaunch.ts` — `bgCommandLaunch`：按 Shell 配置档语义构造「跑命令即退出」的 launch（纯函数）
- `src/main/agentSession/tools/backgroundTasks.ts` — 五个 GuiHostTool；`registry.ts` 按能力位 `bgtasks`（shell/wait/list/kill，各 runtime 均开）
- `src/main/agentSession/host/approvals.ts` — `getPolicyState`（审批门控活读会话模式）、close/clear/release 清理
- `src/main/ipc/backgroundTasks.ts` + preload `api.bgTasks` — `list/kill/markRead/remove/clearFinished`；推送通道 `agentSession:bgTask`（ipcEvents 白名单）

## 渲染层

- `agentChat/useBgTasks.ts` — 订阅推送 + list 首帧
- `agentChat/BgTasksArea.tsx` — 胶囊（**有任务记录即常驻**：运行中蓝点脉冲 / 未读绿点+徽标；清空记录后消失）+ 外点关闭 + 关闭 markRead；挂在 AgentComposer 新可选插槽 `bgTasks`（queued 条之下），主聊天视图与 AgentFloat 共用 composer 自动获得
- `agentChat/BgTasksPanel.tsx` — 上弹面板（portal 进 `.chat-input-shell` 与输入壳同宽，右上角可拖拽调尺寸、localStorage 记忆；`mp-pop mp-pop-up` + usePresence，GitBranchPopover 范式）：多任务左列表右详情；终端详情 = TerminalView 直连 `bg-*`（实时输出、可打字介入）；定时器 = 倒计时卡；列表行 🗑 删除单条（running 不显示）、头部「清除已完成」
- `agentChat/ChatTranscript（chatSurface）.tsx` — 从 AgentChatView 抽出的消息列表（映射缓存/时间分隔/审批卡/贴底随迁）；发送后跟随改为「新用户消息到达时重新贴底」；wake 回调不进转写（hiddenFromTranscript，见通知路由节）
- `styles/bgTasks.css` — 全 token；`.bg-tasks-pop` 用 `--radius-modal` + `overflow:hidden` 把子层裁进四角（与排队面板同族）；进出场走 mp-pop 骨架，keyframes 仅胶囊呼吸点（循环装饰）

## 交互与已知边界

- 任务记录持久化（重启 replay，running→error「应用重启，任务中断」）；消息流与 timer 不持久化（timer 中断按 error 报，跨重启定时属调度侧无头任务领域）；父会话 close/release/app 退出 killAll。
- Shell 继承单 cwd，已启动进程不因外部配置变更自动回滚；跨组隔离与 CLI/调度接入仍见 多文件夹计划。
- 长驻开发服务器和普通 Shell 命令使用相同的启动路径。开发服务器按自身配置监听端口，后台任务以进程为单位管理。预览应使用该任务成功启动后报告的实际 URL。见 [内置浏览器](builtin-browser.md)。
- shell 任务 = 命令本身作 PTY 进程：命令退出即任务结束（退出码=结果）；长驻进程保持 running 直到 kill；面板 xterm 可直接打字介入。
- 完成态任务可在面板删除（单条 🗑 / 头部「清除已完成」，running 拒绝、胶囊在记录清空后消失）；删除带未消费 `pendingDigest` 的记录会一并丢弃该摘要（父会话将不再得知该任务结果），视作「用户不再关心」的语义取舍。
-pty.getHostEnv 对 `bg-*` 键不注入宿主身份环境/不领状态 token（index.ts 判空跳过）。
- 计划/只读模式下 `bgtasks.shell` 走与 bash 相同的只读白名单（policy 层按 permissionClass=shell 自动套用，modeExtension 零改动）。

## 来源回归与验收

`test/bg-task-source.mjs` 运行实际 manager 与 shellTask，使用真实目录/Junction 与受控 PTY，覆盖默认/切区、来源移除、取消、错 cwd、外置树、超时、定时器与落盘恢复（原覆盖的子代理来源/根占用段随 `bgtasks.spawn` 一并移除，父子继承回归改由 `test/session-tree.mjs` 与 `test/launch-defaults.mjs` 承担）。`test/bg-tasks.mjs` 保留摘要/通知/恢复回归。`test/e2e/background-source.spec.ts` 使用独立 app cwd 和本地模型响应夹具，经过真实 Pi driver→宿主工具→后台管理器→Shell 探测→PTY；第二根实际写盘与切区后的来源落盘通过，不调用外部模型。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D03.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：GUI 会话内 Worker 把长命令（dev server 等）/定时器派到后台，到点自唤醒；胶囊+面板实时查看与介入。
- 为什么这样设计：任务记录落盘（tmp+rename 原子写、完成留 7 天/300 条），启动 replay 把中断 running 标 error「应用重启，任务中断」——真源是文件不是消息；通知路由按父会话忙闲（支持时 busy 插话，否则排队／空闲开新回合），wake 回调只进引擎上下文不进 UI 转写（forkTranscript 同款「只进引擎不进 UI」）；shell 失败默认静默（wakeOn=success）+同命令族只留最新，防失败风暴；来源绑定登记父会话 cwd，不随活动区漂移。
- 明确不做：timer 不跨重启（到点语义无从恢复）；子代理不归本模块（2026-10-20 移除，bgtasks.spawn 已删）；删除带未消费 pendingDigest 的记录=「用户不再关心」，丢弃摘要不补偿。
- 歧义点：dev server 类长驻任务重启后不恢复、按中断报错——接受为边界还是未来做可恢复任务（如 restartable 标记）？A=接受（review 按 replay 报错为正常路径）／B=排期做恢复。推荐 A，长驻进程恢复语义复杂且一期收益低。

## 停机所有权

`BackgroundTaskManager.shutdown()` 返回共享完成屏障：同步停止受理、取消任务和快照定时器，等待已受理的 Shell 准备、定时器准备、真实容器回收和唤醒回执，最后落盘。迟到准备必须在实际启动用户命令前检查任务仍为 running；迟到 handle 同样释放。停机后不再推送消息或创建落盘定时器；单任务失败不阻止其余清理，退出落盘及清理异常统一上抛给 Runtime Kernel。

后台 Shell 经 `PtyManager.spawnOwnedBackground` 启动受控 Node leader（`pty/backgroundBootstrap.ts`），由 `backgroundOwner.ts` 在本机随机 IPC 端点执行 token 和 fresh nonce 挑战。Windows 在 Job handle 打开后验证同一 leader，再赋值 Job；Unix 使用 node-pty 建立的独立进程组。归属确认并复核任务来源后才允许 leader 启动用户命令。命令自然退出后 leader 持续存活，先回收整个 Job/进程组，再发布逻辑完成，避免 shell PID 已消失或复用时误判后代退出。普通终端保留原接口，后台 PTY 的同步 kill 会路由到该 owner，域退出仍等待其 Promise。

`close()` 并发共享屏障；回收失败返回错误并保留 owner，不以发送 kill 或根 PID 消失当成功。逻辑退出码投影使用用户命令退出码，不使用回收 leader 的系统终止码。`ELECTRON_RUN_AS_NODE` 仅供受控 leader 启动，执行用户 Shell 时移除；新增代码包含在主进程 bundle 中，无独立 wrapper 资产漏拷贝路径，Windows Job 复用既有已打包 guardian。

回归见 `test/bg-shutdown.mjs`、`test/background-pty-owner.mjs`。Windows 真机验证覆盖命令自然结束后的孙进程回收、来源变更、无效 Job 协议和并发关闭。macOS 真机通过 Electron 和系统 zsh 验证了普通命令的输出与退出码、本地 HTTP 服务的启动与关闭，以及从 GUI Worker 派发到指定项目的后台命令。Linux 仍待真机验证。桌面启动 Demo 时查找 node、npm 等工具的行为见[本地演示场景](demo-mode.md)。

取消的 IPC 和 `bgtasks.kill` 工具通过 `killAndWait` 等待本任务已受理的 launch 及 close，失败沿原错误合同返回，不在 owner 尚未释放时报告“已终止”。同步 `kill` 仍供内部取消请求使用。失败的 handle 留存供重试，当前清理错误按 task ID 保存；成功重试清除该错误和对应摘要说明，应用退出也会重试已 cancelled 但仍持资源的任务。持有 owner 或正在 launch 的记录不能先被 remove 丢弃。

业务执行结果和资源释放结果分开：命令已退出 0 而容器回收失败时，任务保留 done/exitCode=0 和真实输出，摘要另外显示“进程清理失败”；工具仍明确返回清理失败。重试成功恢复原摘要。失败的 shutdown 可重新尝试，不把旧错误数组当作永久故障。

Unix IPC 使用短随机文件名，macOS 等平台的临时目录过长时选 POSIX `/tmp`，避免超过 Unix socket 路径长度；监听或权限错误直接报错。宿主 IPC 连接意外断开时，仍存活的 Unix leader 在自身进程组内回收整个组，不对已退出旧 PID 再操作。端点参数、取消回执与重试见 `background-pty-owner.mjs`、`background-kill-contract.mjs` 和 `bg-shutdown.mjs`。

GUI 关闭会话通过 `killAllForSessionAndWait` 等待该父会话的后台资源；无热 entry 的冷视图同样执行。后台回收失败仍继续尝试 driver retirement 和会话 writer release，最终聚合报告。应用退出的全局屏障与单会话关闭分别有回归，不相互替代。

退出分两阶段：主进程在 Kernel disposer 开始前先 `stopAdmission`，BackgroundTaskManager 的独立 shutdown 同样先执行该阶段。已移交 GUI Host 的 send/连接由 GUI owner 收尾；后台域只拥有它的回执回调。停止受理会取消尚未确认的回执等待、保留 pendingDigest，迟到的成功或失败回执不会再改后台状态或写盘。随后才 drain 后台进程/定时器。这样不会在先退出的后台域等待后退出的 GUI 域，单任务 kill 也不等待父 GUI 的新连接。永久 pending send 和迟到 resolve/reject 见 `bg-shutdown.mjs`。
