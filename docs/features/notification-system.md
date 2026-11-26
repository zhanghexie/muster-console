# 通知系统与气泡（系统桌面 toast + 调度实时气泡）

> 状态：实现说明 v5.6（2026-10-25：可靠性专项 P3 文档批——§2.5/通知矩阵修正调度 needs_you 机制口径为「结构性不进总线」（原「总线拦下」描述不可达），§5 补升级预算耗尽终态声明）；v5.5（2026-10-20：新增 `notify:toast` IPC——输入框上方 hint 提示条（`.agent-composer-hint`）整体移除，输入区成功确认不再提示，失败/被拒提示改弹桌面 toast）；v5.4（2026-09-20：`sessions.review` 确认门按本次 decision 展示动作/后果/按钮，其它值得参数化的危险工具接上 confirmSummary）；v5.3（2026-09-18：调度 needs_you 改走工作区列表固定条目胶囊，黄点数字只计 Worker）；v5.2（2026-09-18：调度 `orchestrator:<wsId>` 的 needs_you 豁免系统桌面 toast，Worker 照旧）；v5.1（2026-09-16：系统 toast/通知中心点击的已读与看板跳转收口到 `jumpToSession` + StoreProvider `subscribeRevealNeedsRead`）；v5（2026-09-15：**应用内通知面板整体移除，通知全走系统桌面 toast**——AgentFloat 通知中心/计数胶囊/ui:notify 推送链/workspace-notifies.json 落盘全部删除，原面板独占事件（扩展完成、更新进度类、.muster 初始化、退出摘要失败）改弹 toast，NotifyStore 收敛为纯内存去重账本；v4 2026-09-15：P13 危险确认框 cancelledBy + 禁用遮罩关闭，见 §6；extension 2026-09-15：看板翻转推送上总线——决策纯函数 shared/notifyDecision + NotifyBus，见 §2.5，含 T1.4 通知偏好设置页；v2 2026-08-29：会话事件退出通知面板、toast 只在人需要出手时弹）
> 代码主入口：`src/main/notify/store.ts`（NotifyStore 账本 + toast 出口）、`src/main/uiBridge.ts`（系统 toast + ui:bubble）、`src/renderer/src/panels/AgentFloat.tsx`（预览气泡）
> 关联：看板状态三通道见 `board-status.md`（phase/liveStatus/activity 的写入与推导，本文只讲它们如何触发通知）；合成会话 id 见 `src/shared/notifySession.ts`

---

## 1. 展示职责：每个信息一个「家」

| 展示入口 | 承载内容 |
|---|---|
| 会话胶囊（左栏 + 看板卡） | 会话自身状态：`liveStatus.label` 自由文案 + phase 列/圆点。左栏工作会话胶囊已读后隐藏，看板保留状态 |
| 全局面板 | 跨工作区谁在忙/等人/完成，读时推导 |
| 调度者气泡（调度对话内） | 调度回合实时态 `ui:bubble`（思考中/生成中/执行工具/待命） |
| 系统 toast（桌面通知） | **唯一通知出口**：人需要出手/知晓的时刻（见矩阵）；点击回跳工作区并选中会话 |

三个容易混的「气泡」：

| 名字 | 通道 | 内容 |
|------|------|------|
| 预览气泡 | 渲染层内部 props | 三模式见 `workspaceBubbleLabel.ts` `resolveBubbleLabel`（工作区名 / 对话中 docked / 调度 live）；右侧常驻 `.agent-notify-chat` 开合钮（收起=「对话」、对话中=「收起」）；调度未读回复另由 `SchedulerReplyBubble.tsx` 在工作区行右侧纵向对齐显示，正文-only；`.agent-notify-needs` 黄点数字只计该区 Worker「需要你」 |
| 调度实时气泡 | IPC `ui:bubble`（`BubbleState {text, status: AgentStatus}`） | piProvider 回合内 + orchestrator 收口 |
| 系统桌面气泡（toast） | Electron `Notification`（`uiBridge.notify`） | 点击聚焦主窗 + 切工作区 + 选中对应会话（`ipc.ts` 的 onNotifyClick） |

Worker 协议里的 `ui.setBubble` 已废弃（shellApi 返回 400 并指向 phase/label/ui.notify）。

左栏工作会话与工作区栈中的 Worker 状态继续共用 `components/StatusBadge.tsx` 的 22px 中性胶囊。
调度状态不再占用胶囊；未读 assistant 回复由 `SchedulerReplyBubble.tsx` 按消息水位和工作区行坐标显示正文。长 Worker 状态在单行内省略，完整内容与说明统一放在整行悬浮详情卡，见 sessions-dock.md §9。面板与栈行的「收起」共用透明 ghost 行为，hover/pressed/focus-visible
各有独立反馈，不以常驻填充或描边表达已打开。

工作区条目整行与头像右键共用 ContextMenu，提供编辑、删除、标记未读。编辑沿用 CreateWorkspaceModal；删除经 AppConfirmDialog 确认后调用现有 workspaces.close，只从已打开列表移除，保留磁盘文件，最后一个工作区禁用删除。调度回复已读由 `schedulerReplyRead.ts` 按工作区和 assistant messageId 记录，存于 localStorage 的 `muster.scheduler-reply-read.v1`；打开调度对话标记当前最新回复已读，新消息使用新 messageId 自动重新提醒，工作区之间互不影响。菜单和气泡层复用现有 presence/动效 token。

当前窗口的操作反馈另走 `tips.ts` / `AppTipHost`（详见 [menus-and-tooltips.md](menus-and-tooltips.md#全局操作轻提示)）：短暂显示、自动消失，不进入 NotifyStore，不改工作区实时气泡。权限设置失败与旧 `flashTip` 调用使用它；会话生命周期通知、通知中心跳转和 `composerNotice` 的系统桌面通知保持原渠道。

## 2. NotifyStore（去重账本 + toast 出口）

左栏工作会话的状态胶囊复用 `needsReadStore` 已读集合：点击会话（`jumpToSession`）或主进程 `sessions:reveal` 后隐藏；会话名称与状态图标保留。鼠标悬浮整个会话条目时临时显示已读胶囊，移开后隐藏，不改变已读记录。左栏、看板状态视图和自由视图的会话右键菜单对已读项提供「标记未读」，恢复胶囊和该会话已有的未读强调，不跳转或重新选中会话。普通 shell 终端不使用胶囊隐藏规则。已读记录沿用原 localStorage 键跨重启保留，`GlobalBoard` 仅修剪已删除会话；状态标签/时间戳、phase 或运行状态变化时清掉该项已读，重新展示胶囊，普通列表刷新与选中时间变化不重置。看板列归属和验收状态不变。

`src/main/notify/store.ts`：按工作区记最近 50 条（**纯内存，不落盘**——`workspace-notifies.json` 已随通知面板移除而废弃）；800ms 短窗去重；`update:true + updateKey` 同键原地替换。

`push()` 旗标：

- `toast`（默认 false）：弹桌面系统 toast。标题=`工区名 · 会话名`（构造时注入 workspace 查找回调，复用 `resolveDesktopNotifyPayload`，emoji 头像进标题、data: 头像进 icon）。**这是唯一的可见出口**——没带 `toast` 的 push 只记账（供去重与 `notify:list` 调试），用户看不到。
- `update` + `updateKey`：同键原地替换账本条目（状态翻转不堆历史），替换后照常按 `toast` 旗标弹。

`notify:list` IPC（preload `api.notify.list`）保留为只读调试口（e2e 用它验证去重/同键条目）；`notify:clear` 已随「清空」按钮移除。

`notify:toast` IPC（preload `api.notify.toast`，2026-10-20 起）：渲染层失败/被拒提示的入口——输入框上方 hint 条移除后，输入区（composer，`composerNotice.ts`）的错误/被拒/回落统一从这里弹 toast，成功确认不再提示。入参 `{ text, workspaceId?, label? }`；composer 侧**不传** workspaceId（其 `workspaceId` prop 可能是会话 id 兜底），主进程按 `activeWorkspaceId` 归组，合成 `sessionId=notify:composer:<workspaceId>`（`notify:` 前缀=点击只切工作区不选会话）。

### 2.5 推送决策与通知总线（T1.1）

`src/shared/notifyDecision.ts`（决策纯函数）+ `src/main/notify/bus.ts`（NotifyBus）：`SessionsService` 在权威写入点（`setPhase` / `applyActivitySignal`）上报推导态翻转前后（`boardStatusOfSession` 快照），总线用纯函数单点裁决，通过后分发桌面 toast + 事件订阅者（T1.2 手机表面 WS接 `NotifyBus.on`；T3.3 phase 触发源接 `NotifyBus.onFlip` 原始翻转流，见 prompt-tasks.md「事件源接线」）。

输入 `(transition{sessionId, prev, next, source}, ctx{lastSentAt, prefs, now})`，输出 `NotifyDecision{send, trigger, reason, channels{toast|mobile}, ledgerTs}`。规则顺序：

1. **触发类**：仅 `waiting`/`blocked`（needs_you 类）、`done`、`error`，且写入源可信（`model|llm|user|hook|system`；廉价 pty 输出不触发）；`no_signal` 属弱推断不推。`error` 为预留映射（当前 deriveBoardStatus 不产生 error），纯函数与偏好先行支持。
2. **同类不重入**：prev 与 next 同触发类不算翻转（hook blocked 后模型再报 needs_you 不重弹）；prev=null 首评允许触发。
3. **调度身份豁免**：`sessionId` 为 `orchestrator:<workspaceId>` 的 needs_you 不推（reason=`scheduler`，桌面 toast / 手机全关）；Worker 会话照旧。**调度 needs_you 结构性不经通知总线**——真实调度等人由 `setStatus` 走调度通道写 SchedulerStatusStore（`scheduler:status` IPC 广播），从不进入 `setPhase`/`applyActivitySignal` 的上报路径；调度 assistant 回复由桌面左栏未读气泡和调度面板承担。黄点数字只计 Worker。
4. **偏好**（`AppConfig.notify`，设置 → 通知页，T1.4 已接入）：needs_you 无开关（产品规则：不可关）；done/error 默认开、可关。
5. **免打扰**：DND 窗口（本地 HH:mm，支持跨零点，含 start 不含 end，start===end 或非法视为无效窗口）拦 done/error；Worker 的 needs_you 免疫。
6. **45s 账本**：同会话同触发类去重（信号账本，参考 wmux AgentDetector 的 per-cycle dedup 思路）；账本只记真实发送，被拦截不续窗。

分发：`send=true` → 桌面 toast（NotifyStore.push，同键 `phase:<id>` 原地更新）+ 事件发订阅者；隐藏会话（hidden 模板）一律拦下；会话删除时 `clearSession` 清账本。旧桥飞书自动推送已退役。订阅端现状：**T1.2 手机表面 WS 已接**（见 web-access.md）；**T3.3 phase 触发源已接**（走决策前的 `onFlip`，不受偏好/免打扰/45s 账本影响，见 prompt-tasks.md）。

写入点：phase → needs_you/done 走总线（`setPhase` 上报）；lifecycle → blocked 移交总线（`applyActivitySignal` 上报，`phase:<id>` 键），hook `waiting_input` 由总线按 needs_you 类推送；exited 的 toast 原地保留在 sessions.applyLifecycle（进程事实，不走总线）。

### 通知矩阵（谁弹系统 toast）

| 事件 | toast | 写入点 |
|---|---|---|
| phase → needs_you / done | ✅ Worker / ❌ 调度 needs_you | 通知总线（setPhase 上报，`phase:<id>`，决策见 §2.5）；调度 needs_you 不走 setPhase、结构性不进总线（见 §2.5 第 3 条），桌面 toast/手机均无；调度 assistant 回复由左栏未读气泡+调度面板可见 |
| lifecycle → exited（含启动失败） | ✅ | sessions.applyLifecycle（`lifecycle:<id>`；进程事实，不走总线） |
| hook blocked / waiting_input（needs_you 类翻转） | ✅ | 通知总线（applyActivitySignal 上报，`phase:<id>`） |
| lifecycle working/idle/waiting_input（无翻转） | ❌ | 不产生通知 |
| liveStatus 胶囊变化 | ❌ | setLiveStatus 只写胶囊，不 push |
| worktree 遗留 | ✅ | sessions.pushWorktreeNotify |
| 会话删除后数据清理失败 | ✅ | sessions.closeOne 后台清理；保留无法确认的分叉保护记录并提示失败原因 |
| GUI/调度并行修改同一文件 | ❌ | 冲突随轮次记录，详情在[回退结果](turn-checkpoint.md#并行会话同文件记录与回退)中显示 |
| 调度：出错/排队满/清空被拒/计划完成 | ✅ | orchestrator（`orch-*:<wsId>`） |
| 定时任务结束 | ✅ | tasks/manager（无 key，新条目） |
| 扩展动作完成 | ✅ | extensions service（key 每次唯一；面板移除后由静默改 toast） |
| ui.notify（Agent 主动） | ✅ | uiHost misc.ts（桌面弹由 emit 单路负责，**不二次直弹**） |
| sessions.integrate `approval=auto` 合入成功 | ✅ | executor 跳过确认后门（`integrate-auto:<sessionId>`）；验收账本另写 `approval=auto` |
| 手动合入失败（integrate required / review / requestIntegrate） | ✅ | `integrateWorktree` / requestIntegrate 宿主（`integrate-fail:<sessionId>`）；文案含失败原因。调度 `approval=auto` 失败不弹，只走编排事件 `merge_blocked` |
| 渲染层未捕获错误（P15） | ✅ | `app:report-renderer-error`（ErrorBoundary / window.onerror；落盘 `userData/logs/renderer-errors.ndjson`，文案带面板 label） |
| 自动更新：发现新版 | ✅ | updater（`updater:progress`） |
| 自动更新：下载进度 | ❌ | 不推通知——任务栏进度条/「关于」页承载细粒度进度（面板移除后进度条目无宿主，进度推送整体取消） |
| 自动更新：下载完成 | ✅ | updater（同键收口「已就绪」；窗口可见再叠确认弹窗） |
| 自动更新：下载失败 | ✅ | updater（同键收口「下载失败」；无开始条目的检查失败不推） |
| .muster 初始化成功/失败 | ✅ | metaAgent/ensureForApp（面板移除后由静默改 toast） |
| 会话退出摘要生成失败 | ✅ | metaAgent/journalExitSummary（面板移除后由静默改 toast） |
| 本机多实例提醒 | ✅ | index.ts（`app-instances` 同键） |

跨会话通信采用 [邮箱＋宿主唤醒](session-mailbox.md)：来信先保存，模型运行中不插话；空闲时合并为一条 host 收信提醒，不含正文、不标读，同批不重复唤醒。子代理不再自动生成首次回音、完成、失败、恢复或读取回执消息；原生状态由 observe 主动读取。桌面 toast 与既有显式事实订阅仍按原入口运行。

### updateKey 家族

`lifecycle:<sessionId>` / `phase:<sessionId>` / `worktree:<id>` / `worktree-close:<id>` / `integrate-auto:<sessionId>` / `integrate-fail:<sessionId>` / `orch-plan-done|orch-error|orch-clear-busy|orch-queue-full:<wsId>` 原地更新；`ext:<extId>:run:<uuid>` 每次唯一（有意）；task 无 key；`updater:progress` 全程同键（发现 → 已就绪/下载失败 一条通知走完），归属「发现更新那一刻」的活动工区（快照固定，切工区不分裂；`updater:install-fallback` 异键兜底提示）。

> v5 起条目只存在于内存账本（toast 去重/同键原地更新依赖），没有任何应用内 UI 消费；hook 卡住态（blocked/waiting_input）与 phase 翻转共用 `phase:<sessionId>`（同一会话的「需要你」一条）。

### 通知偏好设置页（T1.4）

设置 → 「通知」页（`src/renderer/src/components/settings/NotifyPane.tsx`，草稿随弹窗底部「保存」生效）：

| 控件 | 字段（`AppConfig.notify`） | 语义 |
|---|---|---|
| 需要你开关 | ——（无字段） | 锁定开不可关（产品规则），UI 上 disabled 展示 |
| 已完成 / 出错开关 | `done` / `error` | 缺省=开；false 时决策端以 `pref-off` 拦下 |
| 免打扰时段 | `dnd: {start, end} \| null` | 启用开关 + 起止时间（acc 手风琴展开）；时间草稿实时同步、起止相同（无效窗口）只留草稿不同步；关闭写 null |

落盘链路：NotifyPane → SettingsModal `cfg/set` 草稿 → `config.update` IPC → `ConfigManager.update`（`normalizeNotifyPrefs` 归一：非布尔/非法时段/未知字段剥除）→ `save()` 写 config.json 的 `notify` 字段。运行时 `NotifyBus` 构造时注入 `() => config.get().notify ?? {}`，保存后下一轮上报即生效（无需重启）。

## 3. 渲染层消费

- store.tsx 订阅 `ui:bubble`，状态 `bubblesByWs`；唯一消费组件 AgentFloat。
- **WorkspaceNotifyBubble**：主体按钮切工作区/关对话，chat 钮开关对话。live 模式显示调度回合态并呼吸动画（error 红）。
- 通知数据链（`ui:notify`/`ui:notifies`/`notifiesByWs`/计数胶囊/通知中心/`ui:openNotify` 回跳展开）已随面板移除整体删除；渲染层不再订阅任何通知历史。
- 系统 toast / 通知中心历史点击：主进程 `onNotifyClick`（ipc.ts）聚焦主窗 + 切工作区 + `sessions.select`（真实 sessionId 才选，见 `shouldSelectNotifySession`）。`select` 发 `sessions:reveal`，渲染层 **StoreProvider** 的 `subscribeRevealNeedsRead` 把该会话标为「需要你」已读（与看板/左栏的 `jumpToSession` 同一套语义）。App 的 reveal 监听只切页/收板，不再标已读——避免切区时重绑拆掉监听导致未读挂死。

## 4. Agent 主动通知（ui.notify 能力）

catalog `ui.notify`（dangerous:false，Worker 白名单内）→ `uiHost['ui.notify']`（misc.ts）→ NotifyStore.push（toast:true）。定位：`sessionId` 直达即可补全 workspace/名称；或缺参一次返回全部缺失项。Worker 走 shellApi `POST /v1/tool`（Bearer `MUSTER_SESSION_TOKEN` 自动补全）；调度 Agent 走 catalog 直接调。找不到会话时 sessionId 落合成 id `notify:<workspaceId>`。

## 5. 已知边界

- 升级预算（`escalateBudget`，「用户注意通知预算」，`sessions.ts`）耗尽后的 model needs_you 走 refused 分支：**对该 Worker 的 needs_you 全通道静默**——`setPhase` 不执行（无桌面 toast、无 `session.phase` 事实、调度订阅面无信、看板推导层拿不到 needs_you 相位，会话可显示为空闲），仅剩 **note 胶囊**（默认订阅不投递、`observe` 可查）与模型侧 **refused 回执** 两个可见面。此为预算降噪设计的已接受终态（2026-10-25 复核批复）。
- Windows toast 的应用身份（任务栏图标/名称、点击激活）按 AUMID 解析：Electron 发 toast 时若开始菜单无带该 AUMID 的快捷方式，会按进程名自动建一个并打上当前 AUMID；toast 点击激活同样按 AUMID 找快捷方式（HKCU\Software\Classes 无 COM 激活注册时）。AUMID 按打包态分流（`src/main/index.ts`）：安装版 `com.zhanghexie.muster.console`（= electron-builder.yml 的 appId，NSIS 快捷方式同值），dev 加 `.dev` 后缀——若共用，dev 自动建的 Electron.lnk（指向 node_modules electron.exe）会抢占安装版身份：任务栏变 Electron 默认图标、点通知弹出空 Electron 窗口（2026-09-06 / 09-10 两次实测，删除该 lnk 可立即恢复但不防复发）。
- 平台无系统通知能力（`Notification.isSupported()`=false，如无 libnotify 的 Linux、组策略禁用的 Windows）：桌面 toast 全量丢弃，主进程 log 一次性告警（logs/main.log 可查）；needs_you 兜底=左栏胶囊与看板列。设置页「通知」节顶部另有条件提示条（`notify:capability` IPC 只读探测，NotifyPane 挂载取一次，探测失败不误报）：本机无系统通知能力时提示改依赖左栏胶囊与看板列。
- 系统 toast 是唯一通知出口且阅后即焚：错过 toast 后回看靠看板列/胶囊（会话态）与「关于」页/托盘（更新态）；扩展完成、定时任务结束等一次性事件错过即错过（设计意图，无历史回看）。
- `board-status.md` 的推导逻辑不受本改造影响；`ui:bubble` 保留原语义。
- e2e `notify-bus.spec.ts` 的「桌面 toast 层收到」断言依赖 Electron `Notification` 可用；在无系统通知权限的机器上会环境性失败（node 侧 `test/notify-store.mjs` 守护同一条 push 链路）。

## 6. 危险确认框（ui.confirm / P13）

代码：`UiBridge.confirm` → IPC `ui:confirm` → `ConfirmDialog`；应答 `{confirmed, cancelledBy?}`。

| 行为 | 说明 |
|---|---|
| 遮罩点击 | **危险确认**（`dangerous:true`：Catalog dangerous 门 + 动态工具 TOFU）**点空白不关闭**。普通 `ui.confirm` / 扩展审查框未标 dangerous 时点遮罩仍取消，`cancelledBy=backdrop` |
| Esc | 走 `useOverlayDismiss` → `overlay.close`，**危险确认也会关**，`cancelledBy=esc`（视为显式否决，不建议重试） |
| × / 取消钮 | 显式否决：`close` / `button` |
| 超时 / 无窗口 | `cancelledBy=timeout`（可重试） |
| 重试建议 | 仅 `backdrop` 与 `timeout` 可重试；`button`/`close`/`esc` 不要重试 |
| 危险门文案 | 标题=工作区名 · 调度/Worker；副标题=角色 · 工具点号名；主区一句话意图 + `confirmSummary` 人话参数 + 可选 `confirmNote`/`reason`；模型向描述折进「详情」。参数含 `sessionId`/`worktreePath`/`ids` 时复用会话查询，摘要显示会话名、隔离树/cwd、隔离分支、phase/lifecycle（查不到才回落裸 id）；`sessions.delete` 列表化展示「会话名 + 最后活跃时间」；`sessions.review` 按本次 `decision` 写清动作与后果（通过→有树合入 main 并结任务 / 无树标记已处理；打回重做；搁置仍留需要你列；标记已处理仅归档），并附验收备注 `note` 摘要，禁止 catalog 枚举或 `decision: passed` 键值对 |
| 按钮 | 默认「确认执行」；`sessions.integrate` 为「确认合入」；`sessions.delete` 为「确认删除」；`sessions.review` 随 decision 为「确认通过并合入」/「确认通过并归档」/「确认打回重做」/「确认搁置」/「确认标记已处理」 |
| 其它危险工具 | `automations.*` 的 `serviceId` 显示定时任务名，并用人话写清创建/修改/启用/停用/删除/立即执行；`themes.remove` 的 `id` 显示主题名；`runtimes.*` / `dynamicTools.*` / `llm.upsertProvider` / `llm.setDefault` 展示本次动作+目标对象+后果（摘要省略 `apiKey`/`scriptSource`）。`extensions.run` 仍走兜底（只有 id、确认层无标题反查），不另参数化；`memory.remove` 已退役（治理归记忆中心面板） |

Catalog `ui.confirm` 与 extension 扩展面板 `ma.ui.confirm` 返回 `{confirmed}`，拒绝时附加 `cancelledBy`；调用方应检查 `confirmed`。内部 `ctx.ui.confirm` 返回 `ConfirmResult`，调用方用 `isConfirmed()`。缺省只传 title/detail 时确认框仍渲染原来的 `<pre class="confirm-detail">`，不强制结构化主区。

## 7. 通用对话框的宿主取消

扩展单行 prompt 的 Enter 提交先检查原生 `isComposing` 与 `keyCode === 229`，输入法确认候选不发送对话框回执；下一次独立 Enter 或确定按钮才提交。`test/unit/frontend-ime-actions.spec.tsx` 覆盖这两种事件形态与后续正常提交。

`UiBridge.prompt/select/multiSelect/menu` 的末尾可选 AbortSignal 只供主进程调用，不进入模型参数或 renderer payload。未显示的请求取消后立即从主进程队列移除；显示中的请求通过 `requestRendererOnce.signal` 清理计时器和回执监听，并发送 `ui:dialogClosed {requestId}`。renderer Store 只删除匹配的请求，旧请求的迟到关闭不会撤销下一条。

退出使用既有 `usePresenceValue` 动画，退场期停止 Esc 和表单提交响应；Body 不再额外注册绕过 presence 的 Esc。请求发送失败也会结算对应 Promise 并继续下一条队列，不遗留永久 pending 调用。主进程取消、超时及用户取消返回 null，底层发送异常沿错误合同上抛。该 dialog 独立将宽度限制为视口减去 32px，覆盖共享 modal 的 420px 最小宽度，390px 窄窗不会裁切；其它 modal 的尺寸合同保持不变。相关回归：`test/ui-dialog-cancellation.mjs`、`test/unit/extension-ui-dialog-cancel.spec.tsx` 及真实 Chromium 的 `test/extension-ui-dialog-cancel-visual.mjs`（含实际几何断言）。

## 设计初衷（2026-10-25 与用户确认）

- 为谁/什么场景：人需要知道「何时出手/何时知晓」的唯一提醒面；其余信息各归其家（会话状态→胶囊/看板，调度实时态→气泡）。
- 为什么这样设计：系统桌面 toast 是唯一通知出口（应用内面板已删），只在人需要出手/知晓时弹；needs_you 不可关是产品规则；防噪声=触发类白名单+同类不重入+DND+调度 needs_you 豁免（走工作区胶囊，黄点只计 Worker）；一次性事件错过即错过。
- 明确不做：不做通知历史回看面板、不做进度类细粒度通知（任务栏进度条承载）、不做应用内第二通知出口。
- 已确认取舍（2026-10-25 问答卡片）：**一次性事件无回看=终态取舍**——通知只管当下提醒，回看需求归看板/胶囊/关于页；托盘「最近 N 条」不做、也不分关键/装饰两档。
