# 会话模型（SessionMeta）

> 状态：实现说明（2026-10-21：sessions.observe 统一模型侧查询）
> 类型：`src/shared/types.ts` `SessionMeta`
> 主进程：`src/main/sessions.ts`（`SessionsService`）
> 关联：自由画布交接 [free-canvas-create.md](free-canvas-create.md)；GUI 会话 [gui-worker-session.md](gui-worker-session.md)；看板状态 [board-status.md](board-status.md)

---

## 1. 职责

`SessionMeta` 是左栏 / 看板 / 画布 / 调度工具共用的会话投影。字段只增不改语义；缺省兼容旧落盘。

[桌面首次设置](first-run.md) 通过左栏实际的「工作会话」新建按钮打开 `NewTaskDialog`。「新建空白」沿用普通会话创建与工作区源根绑定流程。渲染层收到首个可见工作会话的快照后进入工作台导览，用户在完成页点击「开始使用集序」回到会话。

模型工具结果在公开出口使用动作回执，不改变 `SessionMeta`、IPC 或扩展合同。create/select/recover 只返回定位、实际运行/隔离/队列及明确诊断；历史正文、配置、时间/排序账和候选计划不随写入重复，按需通过 observe/includeHistory、邮箱或 capture 读取。workerRouting 保留实际尝试/失败，去掉未尝试候选池。update 的 rename/pin 仅返回 id+实际修改字段，批量部分失败仍保留 completed/failed。Worker setStatus 返回 id、实际 label/kind，请求 phase 时附实际相位及来源，并保留拒绝、预算及脏树警告；PTY 模型调用仅返回实际变更的胶囊、所请求相位的实际值与来源，以及拒绝或工作树警告。直接 HTTP 上报继续提供匹配方式和原有回执。

`boardReplyPreview?: string` 保存 GUI 会话最近助手正文的最后一句（最多 240 个 Unicode 字符），由 GUI 历史正常加载及输出持久化时更新，清空会话时删除；缺字段的旧会话在下次正常打开时补齐。看板直接消费此字段，不为预览读取完整会话历史；CLI 不生成该字段。细节见 [全局看板](global-board.md)。

调度 Agent 落盘会话（Pi jsonl / 聊天桶）**不是** `SessionMeta`，没有 `statusToken`。它的 phase 走独立通道 `orchestrator:<workspaceId>`（`scheduler-status.json` + `scheduler:status`），不进原生会话列表 / 看板，模型侧 sessions.observe 额外生成调度快照；见 [board-status.md](board-status.md)「调度自身的状态通道」。其源根/cwd/管理根物理身份存于 Pi 的 `muster-workspace-source` custom entry，不进入模型历史。已有对话不随默认根或排序移动；目录快照变更时重建连接并续用同一会话文件，冷启动读 header 再重验 metadata，失效来源/缺失文件拒绝自动改根。分叉继承原档案来源，原文件只读，新文件即使只有用户消息也立即落盘；SDK 等待期间正文、选择资格、会话绑定或结构变化则拒绝覆盖并清理本次未绑定文件；分叉开始时捕获 `liveThinkingOnly`：仅实时显示时，复制的 UI 消息与持久化版本校验都剥离思考字段/片段；保留思考时，思考变化也使分叉失效。等待 SDK 或落盘期间改变该配置会拒绝分叉并清理未绑定文件。异步收口的撤回/审查回执本来就从分叉剥离，仍写入原事实日志但不推进分叉源版本，避免正常回合刚结束时被无关回执打断。回合记忆等待、模型执行、压缩与分叉期间保持全部引用根占用，具体装配和限制见 [调度提示词](scheduler-prompt-injection.md)。

## 2. hidden / 临时会话

`SessionMeta.hidden?: boolean`。仅 `createTerminal` 内部入口可设置，外部通道不开放；当前画布交接不再创建 hidden 会话。

- IPC `sessions:create` 解构时丢掉 `hidden` / `forkFromExternalSessionId` / `initialPrompt`
- Catalog `sessions.create` 同样不透传

行为：

| 面 | hidden 会话 |
|----|-------------|
| `list()` / `listByWorkspace` / `listForAgent` | 过滤掉，不进左栏、看板、命令面板搜索、会话切换 |
| `sessions:changed` 广播 | 不出现 |
| 落盘 | `SessionPersister` 写出前丢掉；启动 / `reloadFromDisk` 也丢 |
| `activeId` | 创建时强制不抢；`select(id)` 抛「临时会话不可选中」 |
| 生命周期 toast / 拉起失败 toast | 不弹 |
| 关闭 | 宿主走 `close(id, { allowUnarchived: true })`；外部 IPC `sessions:close` 仍要求已归档，UI 看不到这些会话故走不到 |

画布交接先生成目标会话专属历史文档，用户在新建任务窗口确认后才创建普通可见会话；不调用模型摘要，也不使用 hidden 会话。文档随目标会话删除，具体流程见 [自由画布](free-canvas-create.md#4-交接)。

## 3. 其它与画布相关的创建选项

`CreateTerminalOptions`（仅主进程，不进 IPC）：

- `activate?: boolean` — 缺省 true；hidden 时强制 false。Catalog `sessions.create` 的 `select` 映射到此字段（R8）
- `forkFromExternalSessionId?: string` — claude-code 原生 fork 的源 CLI session id
- `initialPrompt?: string` — pty 首条消息；chat surface 忽略，须走 `AgentSessionHost.send`
- `injectHostIntro?: boolean` — fork 路径关闭，避免重复发送宿主介绍；普通派活沿任务管线处理
- `reservedSessionId?: string` — 宿主预留的目标 UUID。交接用它绑定历史文档。带附件的 CLI 启动在准备首条输入时用目标 UUID 建立会话附件目录。外部新建会话 IPC 不接受此字段
- `rootId?: string` / `rootsRevision?: number` — 选择已登记源目录及拒绝过期创建请求；不指定根时取 `defaultRootId`
- `sourceSessionId?: string` / `capturedSource` — 内部 fork/续作与队列固定来源，外部创建 IPC 不接受这两个内部字段

## 3.1 默认名会话的首条指令自动命名（2026-10-28）

未显式命名的 agent 会话创建时名字是「工作面板 N」，并打 `SessionMeta.autoNamed: true`（`buildAgentTerminalSession`；显式命名的会话、shell 会话与旧落盘数据不打标）。用户经聊天输入框（`agentSession:send`，桌面与移动同通道）发出的第一条指令**受理成功**后，会话自动改名为指令原文折叠空白后的前 10 个码点（`shared/sessionAutoName.ts` 的 `deriveAutoSessionName`；纯图片消息派生不出名字则保留标记，等下一条文字指令）。改名即清除标记：之后任何指令都不再改名，手工 `rename` 也清标记（手工名优先）。只挂 IPC 用户输入层——会话邮箱（`sessions:sendMessage`）、宿主注入等 AI/系统发送不代表用户指令，不触发改名。纯函数与行为回归 `test/session-auto-name.mjs`；IPC 接线断言在 `test/gui-host-lifecycle.mjs`「GUI send IPC」组。

## 4. 调度侧枚举 / 反查

- sessions.observe 不带目标时返回所属工作区的轻量目录，支持 includeArchived、archivedOnly、includeShell、nameContains、shortId、worktreePath、lastUsedBefore 和有界分页。默认不读历史全文、不扫 Git。
- sessionId 支持完整 ID、唯一短前缀、worktree 路径；externalSessionId 支持运行时会话 ID。指定目标读取状态、摘要和最近完成回复；includeHistory 显式读取上下文，includeGit/facts 显式读取事实。歧义或目标/工作区冲突明确拒绝。
- sessions.search({path?,commit?,q?,workspaceId?}) 按路径/提交/关键词检索落盘转写；默认本区含归档，*=本机全部区。见 [session-search.md](session-search.md)。
- sessions.setArchived、completeAndArchive、delete 保留批量生命周期；`completeAndArchive` 任一目标无法解析或状态不符时整批拒绝。AI 删除经过业务审核，任一未归档目标仍整批拒绝。UI 点击删除由可信 IPC 标记为人工，直接删除已归档目标，不发起安全审核。
- `sessions.review` 的单次 `processed` 会清除维度门并归档，不合入。工具面迁移中的批量 `host.sessions.review(processed)` 尚未注册；其执行底座先校验全部目标，再逐个清门和归档，并沿用单次 review 的审批。执行中途异常会报告已处理目标与结果不确定的目标，调用方应先检查状态再重试。

## 5. 会话级模型 / 思考档（P10）

Catalog：`sessions.setModel({sessionId, providerId, modelId})`（两者都空=清覆盖回落全局）、`sessions.setThinking({sessionId, level})`（空=跟随默认）。

生效：idle 即时（reconnect 型拆连接）；运行中不打断、下回合 `ensureConnection` 重建。Driver 声明 `modelOverridePolicy` / `thinkingPolicy`（与 `CHAT_RUNTIME_CAPABILITIES` 同值）：pi/cursor 模型为 reconnect；claude/codex-gui/acp 模型为 unsupported（明确拒绝）；思考档仅 pi=hot。

## 6. 已知边界

- 冷启动不恢复执行实例。对外 `runtimePresence=dormant` 表示尚未按需加载，lifecycle 投影为 idle，activity/firstSignalAt/runtimeStartedAt 不暴露为当前事实；原始历史仍用于中断快照，phase=needs_you/done 保留。PTY 仅在显式 select/恢复入口启动；当前进程状态来自 PTY 池，输出时间 lastOutputAt 仅投影、不影响列表排序。GUI open 建立本次运行基线。状态查询、停滞扫描和守卫不得隐式启动会话。
- CLI 会话的宿主 ID 与原生 `externalSessionId` 分开。支持按 ID 恢复的入口在启动后保存原生句柄的 Harness 与 cwd（`terminalResumeScope`）。旧记录以原有 runtime 和 cwd 检查，已移除的 runtime 保留原身份。冷选中只尝试恢复声明支持且有保存 ID 的会话。仅启动的入口通过会话菜单「开启新对话」拉起。恢复失败保留原 ID 并显示原因，已有进程在恢复检查失败时仍可使用。Cursor 携带任务简报的重拉也使用同一恢复检查。显式新开沿用该工作台会话的启动设置，新启动提交后才替换原生句柄。

- hidden 会话仍在内存 `this.sessions` 里，`get(id)` 可取到；hidden 元数据不落盘。
- 交接草稿位于工作台用户数据目录，取消时清理；崩溃留下的无主草稿在后续启动按期限清理，活会话文档直到会话删除才清理。
- 未归档会话默认禁止 `close`。hidden 销毁和普通 Shell 退出自清使用宿主的 `allowUnarchived`。关闭工作区保留会话注册和历史。
- `close` 删除 GUI（chat）会话时清理工作台管理的 Pi 转录和 trim-cache，并传删除前 `meta` 快照给 `chatBridge.close`；Cursor ACP 与 CLI（pty）的外部引擎数据由相应程序管理，不随工作台会话删除。详见 [gui-worker-session.md](gui-worker-session.md)「引擎侧数据清理」。
- 装载期 runtime 容错（2026-09-13）：启动 / `reloadFromDisk` 的 `normalizeLoadedSession` 对未注册 runtime（如升级前残留的已移除 runtime）回落 `defaultRuntime` 并 console.warn，不硬抛——单个陈旧会话不得炸掉整个装载；回落值随启动回填落盘，原 runtime 值不保留。创建 / 启动会话时仍严格校验（`normalizeRuntimeKey` 抛错语义不变）。

## 7. 中断快照与带上下文续作（R12）

应用重启后，启动链对 in-flight 终端会话写 `SessionMeta.interruptSnapshot`（`SessionsService.captureInterruptSnapshots`）：中断时刻、最后活动、未提交清单、worktree 是否干净。判定（纯函数 `isInFlightForInterrupt`）：`lifecycle=working`、或 `phase=needs_you`、或隔离树脏且未 `done`。已有快照不覆盖。

**产品默认（保守）**：无按天 TTL（保留到续作消费或归档/删除）；启动**不**自动开续作会话；续作默认 `select=false` 不抢焦点。

入口：右键「带上下文续作」/ Catalog `sessions.recoverInterrupted`（左栏悬浮「续作」按钮已删除，悬停会话行不再出现续作入口）。等价于同 cwd 另开会话 + 续作简报；若源会话有隔离 worktree，归属移交到新会话（源字段清空，避免双会话抢同一树、归档误删）。回归：`test/interrupt-snapshot.mjs`；UI：`test/unit/left-session-no-resume-hover.spec.tsx`。

## 8. 切换工作区时的选中恢复（2026-09-16）

`workspaces:switch/open/close` 激活新工作区后，主进程 `SessionsService.adoptActiveForWorkspace(newWs)` 重定 `activeId`，决策抽成纯函数 `decideAdoptActive`（`src/shared/workspaceActiveSession.ts`）：

1. 当前 active 已属于目标区 → 保持不动；
2. 目标区有「上次离开时选中」的记忆且仍有效（在表、未隐藏、未归档、归属该区）→ **恢复它**；
3. 否则回落该区**左栏最上一行**（terminal、未归档；置顶优先，同组内 pinnedAt / lastUsedAt（缺省 createdAt）新的在上——与左栏排序一致，即用户看到的「第一个」）。排序比较器 `compareSessionsByRail` 与渲染层 `LeftPanel.sortSessions` 共用同一份（单一事实源，防两处漂移）。

记忆表 `SessionsService.lastActiveByWs`（`Map<workspaceId, sessionId>`，仅内存）：每次切区时把「当前 active 所属区 → 该会话」写进去；跨区 `select` / `create(activate)` 也会把目标会话写入该区待显示，切回时走同一恢复路径。记忆失效（会话被关/归档/隐藏）或重启后为空，自动走兜底（兜底选左栏顶行，不选数组第一个/列表末行）；关工作区时随 `removeByWorkspace` 清掉该区条目。回归：`test/workspace-active-restore.mjs`、`test/select-workspace-isolate.mjs`。

## 8.1 归档后的会话选择

归档当前选中会话时，选左栏顺序中的下一项；已经是末尾时选紧邻的上一项，没有其他候选则清空选中。归档父会话会连带归档子树，整棵子树都不会成为候选；已归档、隐藏和其他工作区的会话也不参与。工作会话树排在终端列表之前，两者各自沿用左栏的置顶与最近使用排序。归档未选中的会话不改变当前选中。

左栏和看板共用归档流程。会话或后代正在输出、执行工具或等待输入时提示「停止并归档」，默认聚焦取消。包含隔离工作树的归档提示实际清理规则，任务完成标记不影响确认。桌面 IPC 执行前重新读取受影响会话的执行状态，发现新增的运行项会再次请求确认。

选择归档项只打开历史。GUI 使用有界历史分页，CLI 展示归档时保存的最近 24,000 字符终端输出，旧 CLI 会话只有尚可读取的本机缓冲。显式「继续会话」先校验来源目录和隔离环境，再取消归档并选中。归档清理中及隔离环境不完整时继续执行受限。

工作会话标题栏的归档按钮切换到只显示已归档会话的列表，即使没有归档也能打开。归档清空时，列表显示「暂无归档会话」，清除保留项筛选和批量选择，并保留「返回工作会话」入口。会话行的归档和取消归档共用归档盒造型，归档时盖子水平闭合，取消归档时盖子斜放并露出盒口。已归档项可通过行内垃圾桶或右键发起永久删除，主进程预览子树、worktree 目录、分支和已接入的原生会话历史。执行前复核 Git 状态和原生历史范围。左栏可筛选保留项并勾选批量删除，结果逐项反馈。归档和继续会话按 [原生会话历史接口](gui-harness-integration.md#原生会话归档恢复和永久删除) 同步支持的 Harness。

关闭工作区把原登记移入持久化的关闭列表，左栏和看板隐藏该工作区会话。通过原管理目录重开时恢复工作区 ID、源根与原会话。启动清理会识别关闭的工作区登记。

左栏归档按钮与右键菜单按当前搜索和子树折叠结果提供相邻行提示，通过 `sessions:setArchived` 一并交给主进程。主进程只在提示对应当前选中、且候选仍属于同一工作区并可选时采用；提示过期或没有可见候选时，按未过滤、展开的左栏顺序回退。看板、模型工具及其他归档入口也走这一主进程兜底。选择在修改归档和置顶字段之前决定，避免顺序随归档变化。

归档或关闭前可注册同步的整批安全预检，失败时不改会话归档状态或当前选择；异步预检会被拒绝。桌面授权的代次失效可接入此门，相关组合目前尚未在应用启动时绑定，见[桌面控制基础设施](desktop-control.md)。

回归覆盖：`test/session-archive-selection.mjs` 使用真实 `SessionsService` 检查顺序、边界与无效提示；`test/unit/session-archive-selection.spec.tsx` 检查左栏点击、搜索和右键；`test/e2e/session-archive-selection.spec.ts` 覆盖 Electron 中从点击归档到选中下一行的链路。

## 9. 跨工作区 select 不抢中栏（2026-09-17）

`sessions.create` / `sessions.select` 的显示意图都走 `decideSelectDisplay`（`src/shared/workspaceActiveSession.ts`）+ `SessionsService.applySelectDisplay`：

1. 目标会话属于当前活动工作区 → 改 `activeId`，`select` 另发 `sessions:reveal` 露出中栏；
2. 目标会话属于另一工作区 → **不改** `activeId`、**不发** reveal（当前区中栏与虚拟屏不动），写入 `lastActiveByWs` 作该区待显示；会话仍后台 open / respawn；
3. `hidden` 或 `activate/select=false` → 跳过。

渲染层再加一道闸：`resolveCenterActiveId` 算出 `displayActiveId`，中栏 `visible` 只认当前区会话。即使用户正在看 B 区时调度在 A 区拉起 Worker，B 的中栏不会串台；切回 A 时待显示会话亮起。用户主动跳转（看板/命令面板）仍走 `jumpToSession`：先切区再 select，切完后已是同区，正常显示。回归：`test/select-workspace-isolate.mjs`、`test/unit/center-workspace-select.spec.tsx`。

## 10. 源目录身份与运行目录

`SessionMeta.sourceRoot = { rootId, path, cwd, physicalPath? }` 保存来源身份、源根路径、源侧任务 cwd 与捕获时的物理目录键。`SessionMeta.cwd` 是实际运行目录，隔离时可在应用管理目录内，不能由它推断当前 UI 工作区。`src/main/sessions/targets.ts` 统一创建、启动、重拉及旧数据回填；创建 IPC/preload、Catalog `sessions.create` 透传 `rootId`，预检 IPC 可选根。

显式 workspaceId 必须存在，不存在不回落活动区；只有旧数据缺 ID 才从全部源根或已记录 worktree 主仓反查，跨工作区有多个匹配保留历史记录但不猜归属、不启动。区内重叠根取最具体根，显式选中的父根也有效。真实目录需存在，根内越界 Junction 拒绝；同根别名转为登记路径。新记录保存物理目录键，Junction 被重新指向另一目录时拒绝复用旧来源。

会话创建及 CLI allocate/resolveLaunch 等 await 后复核来源；源移除/重定位/工作区关闭会拒绝创建或 spawn，启动失败通过现有 launchError/通知反馈。改名、排序、默认根变化不移动已有会话。GUI 创建等待来源校验与 host.open 完成再返回，派活随后发送不会抢在宿主注册前；CLI/Shell 仍沿原流程后台启动并报告 launchError。GUI 选中恢复也先校验。外置树只可引用同工作区已登记会话的树；fork 保留来源身份，共用原树的 fork 不获得清理所有权；交接默认选择来源工作区和源根，由用户在任务窗口确认或更改根；中断续作则沿原流程转移所有权。

CLI agent 在 launch/relaunch 第一次 await 前捕获全部目录快照并登记所有引用根；占用跟随实际 PTY，异步 kill/替换后的旧进程真正退出才释放。`getCliWorkspaceContext` 返回当前进程快照，普通简报回注复用，重拉重新捕获；回注/启动前校验所有捕获根及物理身份。引擎附加参数只登记可写范围，源检出不会因隔离而获得写权限；无能力声明的脚本明确 cwd-only 接入限制。共用已登记树的 fork 使用同一隔离范围，不改变清理所有权。延迟键入与 Enter 绑定实际进程，替换后拒绝提交。具体原生能力和边界见 [Worker 注入](worker-inject.md)。

派活队列在入队时克隆 rootId、源路径/物理键、cwd 和调用选项；显式 isolationGroups 还捕获全部选择根，入队与正在出队均登记所有来源依赖。出队重新校验此选择；默认目录/排序改变不会重定向，来源失效走既有有界重试/失败回调。配置和并发状态先校验再加入队列，读取失败不留下任务。公开 IPC 不接受内部 capturedSource/capturedIsolationSources 或跳过队列的字段。并发限额、简报词表/记忆和隔离 provision 取固定管理根；点名技能仍按源任务目录发现。建树后失效先拆嵌套树再清容器及主分支，回滚不完整明确通知保留资源，不产生会话行。

桌面 NewTaskDialog 与手机新建抽屉复用 `TaskSourceField` / `useTaskSource`，打开时固定工作区及默认源根；显示来源路径，改默认/排序/名称不移动草稿，根移除/重定位须重新选择，切工作区须关闭重开。任务与空会话创建携 workspaceId/rootId/rootsRevision；空会话等待成功才关闭，失败保留输入。手机按正在查看的工作区创建，不依赖另一客户端切换的全局活动区，清单未加载前禁用入口。

CLI/GUI 都按所选根预检。预检在根版本变化时重跑，错误可见并可重试，晚到或 A→B→A 的旧结果丢弃；手动隔离选择不被同根推荐覆盖。预检 IPC 接收 rootsRevision 并在 Git await 后再次校验来源。桌面隔离可勾选跨源根仓组，父仓包含嵌套仓；初次读取缓存，手动刷新才重扫。运行仓库限当前源根且必须在所选范围，失效的旧选中路径要求重选，未选来源保持共享参考。空会话和任务派活都传递同一组选择。共享 `TaskDelegateResult` 明确 session 可缺省，排队回执显示位置并禁止重复提交，不能当成会话已创建。

回归：`test/session-source-targets.mjs` 使用真实目录/Junction、实际会话创建与 launch 状态机、队列及预检 IPC；`test/unit/new-task-source.spec.tsx` / `mobile-session-source.spec.tsx` 覆盖表单来源、异步撤销、失效恢复与回执；`test/e2e/worktree-storage.spec.ts` 经过 Electron/Web 的真实任务窗口/手机入口验证第二根创建与跨客户端活动区切换，并保留隔离、续会话和重启恢复。定时服务及其 scheduled 会话投影现也持久化来源，真实运行和文件触发保持根身份，见 [触发任务](prompt-tasks.md)。后台子代理/Shell/定时器继承父会话来源与实际 cwd，启动等待重验、宿主工具作用域和真实 Pi/PTY 验收见 [后台任务](background-tasks.md)。GUI 回合与后台子代理已有全部引用根的目录快照、引擎参数/提示和运行占用，详见 [GUI Worker](gui-worker-session.md)。CLI 状态机与原生参数分发由 `test/cli-workspace-context.mjs` 验证，独立 Electron 的真实 Node PTY 占用/注入/归档解除关联见 `test/e2e/cli-workspace-context.spec.ts`。调度目录范围、默认根变化和冷启动续聊由 `test/scheduler-workspace-context.mjs`、`test/scheduler-turn-workspace.mjs` 与 `test/e2e/scheduler-workspace-context.spec.ts` 验证。技能清单/同名选择、GUI 回合和 CLI 简报来源现有实际 SDK/IPC/组件及 Electron 验证，见 [技能](skills.md)。完整索引、全部预览格式和跨源根多组隔离仍待后续阶段；此处不代表完整多根任务支持。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D03.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：左栏/看板/画布/调度工具共用的会话投影（SessionMeta）；画布交接使用源历史文档为新会话提供上下文；重启后中断的终端会话要能带上下文续作（interruptSnapshot）。
- 为什么这样设计：字段只增不改语义保证旧落盘兼容；hidden 只走 createTerminal 内部通道（IPC/Catalog 解构丢弃）防外部造「看不见的会话」；跨工作区 select 不抢中栏（decideSelectDisplay + 渲染层 resolveCenterActiveId 双闸），调度在 A 区拉 Worker 不打断 B 区阅读；activeId 恢复用与左栏同一份排序比较器（单一事实源防漂移）。
- 明确不做：调度会话不进 SessionMeta 列表（独立通道 scheduler:status）；冷启动不恢复执行实例（dormant），状态查询/停滞扫描/守卫不得隐式启动会话；启动不自动开续作会话、快照无 TTL 保留到消费或归档。
- 歧义点：dormant「永不隐式拉起」是长期产品取向还是阶段性取舍？A=长期取向（任何隐式启动路径都算 review 缺陷）／B=阶段性（未来可加停滞自动唤醒）。推荐 A——现守卫措辞是硬边界，改取向属大方向变更。

## 轮询与读屏退出

`SessionsService.stopMonitoring()`停止生命周期轮询并取消后台LLM读屏请求；`shutdownMonitoring()`继续等待真实fetch/响应体结束。即使适配器迟到返回分类，停止后的结果也不写phase或广播。该屏障只管理观察任务，交互PTY、GUI引擎和会话writer仍由各自owner关闭。`test/session-monitoring-restart.mjs`覆盖中止信号、在途响应等待和迟到结果丢弃。
