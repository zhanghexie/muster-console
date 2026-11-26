# 定时任务（Prompt Tasks）

定时任务在 once、daily、weekly、interval 指定的时间拉起可见 Worker。界面与 AI 的 `automations` 共用定时任务管理器，事件通知由独立的 `events.subscribe` 管理。应用升级后启动时删除旧 webhook、file、phase 事件任务及其任务订阅，保留原定时任务和历史运行记录。headless 模式已退役。

新建与服务编辑的运行类型来自共用的 [可用 Worker 清单](runtime-preflight.md)，只允许本机预检通过的已启用类型，ACP 预设单独核对。新建、开启或立即运行前强制刷新；检测未完成、失败或无可用类型时阻止执行，保留草稿。旧任务的不可用类型仍显示原值，编辑其它字段时不自动替换，但开启或运行须改选可用类型。跨工作区等待检测的旧请求不会向旧工作区写入新任务。

强制刷新完成时主进程会广播可用性变化；发起刷新的界面先消费本次结果，再读取广播快照，避免广播触发的并发读取将本次结果误判为过期，导致有可用 Worker 时仍无法新建或运行。

错过策略（T3.4）：任务级 skip（默认，跳过并记录）/ catch-up（补跑一次错过槽位）/ confirm（记录并等确认补跑）。启动与系统唤醒（`powerMonitor` `resume`）评估错过窗口。keep-awake：设置「阻止系统休眠」默认开，有在途运行或计划时刻进入 5 分钟提前量时用 `powerSaveBlocker`。

定时任务详情的「删除任务」打开共用 AppConfirmDialog，显示任务名；取消保留任务，确认后调用原 services.delete 并刷新列表，不使用详情区内嵌确认条。

## 关键文件与入口

主进程以 `startPaused` 创建管理器，Kernel 的 `prompt-tasks` 域实际重挂定时器，避免构造期间的 catch-up 在宿主装配前创建 Worker。退出先停止新触发，`shutdown()` 等已受理的会话创建回执；停机期间迟到创建的 GUI 会话不再注入任务正文，真实会话 id 留在失败记录供核对。keep-awake 或 resume listener 回收失败会保留句柄和错误供重试，不先清空后假成功。原同步 `stop()` 保留为停止计时器的请求接口。

| 文件 | 职责 |
|------|------|
| `src/shared/promptTasks.ts` | 错过窗口与 keep-awake 纯函数 |
| `src/main/tasks/manager.ts` | 定时任务 CRUD、定时器和 Worker 拉起 |
| `src/main/tasks/schedule.ts` | `getNextRunAt`：daily/weekly/interval 下一次运行时刻的纯计算（本地时区，DST 用 setDate 而非 +24h） |
| `src/main/agent/providers/piProvider.ts` | `runHeadlessPiTask`：无头单次执行——新建独立 Pi 会话（桶 `<wsId>:tasks`）、聚合输出、成功判定、超时中止（30 分钟） |
| `src/main/ipc/workspaces.ts` | `services:runNow` IPC |
| `src/main/capabilities/hosts/services.ts` | `automations.runNow` 宿主能力（Agent 面调用） |
| `src/renderer/src/components/ServiceView.tsx` | 调度面板：任务状态（lastResult 胶囊）、运行历史（成功/失败/错过/运行中）、立即执行 |

## 源文件夹与运行快照

`PromptTask.sourceRoot` 保存创建/显式选根时的 rootId、登记路径、源侧 cwd 与物理路径键。创建缺省固定当时的默认根；后续改默认、切活动区、普通编辑与重启均不重定向。管理器同步校验登记身份，真正拉起由 `sessions/targets.ts` 再校验目录与 await 后身份；移除、错配或 Junction 改指向会记录失败，不回落其他根。旧任务无目录证据时仅单根可迁移，多根歧义任务自动停用并显示原因，需在任务编辑弹窗明确选根后启用。

服务新建先捕获当前面板的工作区/默认根/版本，再等待配置和 IPC；切区后旧列表/创建结果不会进入新面板。`services:list(workspaceId?)` 支持显式列表范围。`ServiceView` 展示计划和状态，任务区域仅显示任务名称和「编辑任务」按钮；按钮打开复用 `NewTaskDialog` 的编辑模式，预填名称、提示词、运行类型、目录和 GUI 会话参数，不创建会话。弹窗保存只更新详情草稿，仍须在详情中保存或启用；取消保留原草稿。定时任务暂不支持隔离工作树和 CLI 启动参数，编辑模式不显示这些选项。无效来源拦截保存，可手动重新选择；保存携工作区/rootId/rootsRevision，失败保留草稿，切服务卸载旧表单。计划字段按容器宽度切换三列、两列或单列，不依赖整窗口宽度。

定时任务面板的表头、限宽列表和详情从左侧同一内容轴开始；表头保留新建任务操作，不显示返回终端按钮。从运行历史跳转会话仍会收起当前工具面板。窄容器将列表摘要及计划字段换行。每日和每周时间使用共用下拉菜单分别选择小时与分钟，保持键盘操作和主题一致；未选任务时不显示空详情标题。

`automations.create/update` 同样支持 rootId 与 rootsRevision；省略更新 rootId 保留原快照，显式改根时校验版本。terminal 启动在途禁止重定向来源；本轮 runtime/模型/提示词/来源用同一快照，GUI 首条发送不会混入等待期间的下一版定义。相对延迟只由管理器换算一次，保留 delayMinutes 的展示语义，禁止与 schedule 同传。

测试见 `test/prompt-task-source.mjs`（真实目录/Junction、实际管理器与 automation host）、`test/unit/service-source.spec.tsx`、`test/service-source-layout.mjs` 和独立 Electron/Web `test/e2e/worktree-storage.spec.ts`（真实服务编辑、PTY cwd 与重启）。这不代表根移除依赖检查、后台任务或多引擎目录授权已全部完成。

任务以 `configurePermissions` 保存「配置权限」开关；缺省关闭，触发时使用最高可用原生权限并自动响应有效 GUI 权限申请。开启后，Muster Core 使用 `guiMode`，外部 GUI 使用 `nativeConfig` 中的引擎、预设、来源和原生选项，并在触发时复核身份与目录；没有显式选项时沿用引擎原生状态。修改 Harness 或源目录时需要重新选择兼容设置，关闭时保留的手动配置不参与执行。

CLI 定时任务的模型、原生权限与沙箱等启动选项由 `cliLaunchOptions` 保存并经创建参数传递。编辑器开启配置后显示该 CLI 的原生权限字段；关闭后保留模型、思考设置，执行时使用公共免审批启动策略。切换引擎会清除不兼容的 CLI 草稿。

## 定时与事件的边界

`automations` 提供 list/create/update/setEnabled/delete/runNow；`schedule` 支持 once、daily、weekly、interval，`delayMinutes` 与 `schedule` 互斥。事件订阅和 Webhook 接收独立于定时任务，见 [runtime-status.md](runtime-status.md) 和 [web-access.md](web-access.md)。启动时清理旧事件任务与关联订阅，普通事件订阅保留；旧定时任务正常恢复。回归见 `test/event-task-retirement.mjs`、`test/automation-time-only.mjs`。

## 数据流

- 任务与运行记录持久化在 userData：`prompt-tasks.json`、`task-runs.json`（及 `.bak.json` 备份）。`Store.savePromptTasks/saveTaskRuns` **同步原子写**（P9，不走 PersistQueue 200ms 防抖），避免崩溃/强退后 `automations.list` 变空。主文件 JSON 损坏时 `loadRegistryJson` 回退备份并写回主文件。
- 每个任务投影一个 `type: 'scheduled'` 会话（`sessions.createScheduledTaskSession`），启动时对账增删。`PromptTasksManager` 构造结束会再 persist 一次，把 `nextRunAt` 落盘；enabled 任务 `arm()` 重挂定时器。
- 回归：`test/prompt-tasks-persist.mjs`（写盘 → 新建 manager → 仍在且 enabled+armed；主文件损坏从 bak 恢复）。
- 定时器：`arm()` 按内存 `nextRunAt` 挂 `setTimeout`；触发 → `run()`；完成后（timer 回调 `finally`）重新 `arm()`。应用启动时构造函数逐任务 `arm()`，并对 `nextRunAt` 已过期的判定是否 missed。
- **决策门（O12，wmux hasPendingDecision 原型；headless 已退役，仅存留历史代码路径）**：time 定时触发若任务是 headless 模式（目标=调度会话——跑调度提示词 + 调度工具面，等于从旁开调度回合）且该工作区调度 `needs_you`（scheduler-status.json）：**本次跳过、`nextRunAt` 保持 due，30s 后再试**（重试定时器仍挂任务定时器表，disable/stop 照常可清）；不进错过策略（不是「错过」是「暂缓」，错过策略不动）。**暂缓 × 唤醒/重启**：暂缓中任务不进 keep-awake，系统睡眠唤醒（`evaluateMissedOnWake → arm`）或重挂时会看到 `nextRunAt` 已过期——arm 判错过前先识别暂缓链（内存暂缓标记 `decisionGateDeferred`，或 headless 任务此刻调度仍 `needs_you`，后者兜底重启后内存标记丢失）：暂缓中的 due 只重挂 30s 重试、`nextRunAt` 保持，不记 missed / 不绕门补跑 / 不弹确认；无暂缓的普通过期任务照旧进错过窗口。**后果须知**：应用停机期间真过期、重启时调度仍 needs_you 的 headless 任务也会被按暂缓处理（不记 missed、门开后补跑一次）——该场景下用户选的 skip/confirm 偏好不生效，属「宁可晚跑不静默丢」的有意取舍。标记在门放行（重试放行或 `run` 真正执行）或任务停用/删除/修改（update）时清。调度相位移出 needs_you 后自然放行；`runNow` 手动触发与 terminal 模式（拉独立 Worker 会话不碰调度）不受门限制；状态读失败当不挡（fail-open）。**2026-09-22 起新建/存量 headless 任务均已退役，本门不再有生产入口，整链代码暂留（历史 run 记录与离线测试仍引用）。**
- headless 串行链（已退役，代码暂留）：所有无头运行排在同一条 promise 链上（`headlessChain`），同任务在途（`headlessInFlight`）则跳过本轮。
- **terminal 模式命中 GUI（chat surface）runtime**（pi/cursor 聊天会话）：`createTerminal` 会忽略 `initialPrompt`（GUI 约定派活方经 `AgentSessionHost.send` 注入，与派活管线 `delegateTask` 同一分流），manager 在建会话后把任务原文经 `bindGuiHost` 绑进的宿主 `send()` 补发；`send` 派发即返回（回合异步推进），不阻塞定时器。`send` 返回 `ok:false` 或宿主未绑定都按本轮执行失败收尾（记 `lastError` + 失败通知）。
- 传统 CLI 首条输入携带任务原文和宿主简报，简报直接包含当前全局规约和工具入口。详见 [Worker 创建与任务投递](worker-inject.md)。
- 无头成功判定（`runHeadlessPiTask`）：`runPiTurn` 正常返回 且 未超时 且 最后一条 assistant 的 `stopReason` 不是 `error`/`aborted`。`agent_end` 是单次 LLM 调用级的信号（重试退避中也发），最终以 `agent_settled` 为准。

## 成功/失败与「错过」判定

- **执行前置失败也进统一记账（2026-10-02 W5 修复）**：runtime 禁用/注销、源目录失效等拉起前的失败与拉起失败同路——先建 TaskRun（running）再进 try，失败落 `lastError`/`lastResult='error'`、run 记录 status=error、按原策略推「执行失败」通知、`nextRunAt` 重排；不新建会话、不增加成功次数（runCount）、不消耗 once/maxRuns 槽位（once 按失败重试规则 5 分钟后再试）。manual（runNow）/interval/once 入口共用 `run()`，全部覆盖。不启用或回退其他 runtime 伪造成功。
- terminal 模式：`createTerminal` 成功返回即记 ok（Worker 拉起是 fire-and-forget，后续执行成败由会话自身状态表达）。
- 无头成功判定（已退役，代码暂留）：以 `runHeadlessPiTask` 返回的 `ok` 为准；失败把 `result.error` 落 `lastError`/run 记录并推「执行失败」通知。
- **错过（missed）**：`arm()` / 系统唤醒 `evaluateMissedOnWake()` 发现 `nextRunAt` 已过期且该槽位从未执行（早触发容差与无头在途除外）时，按任务 `missedPolicy`（缺省 `skip`）处理：
  - **skip**：记 missed + 「已跳过」通知，把 `nextRunAt` 推到下一次（防风暴默认）。
  - **catch-up**：不记 missed，立即补跑这一槽（只补一次，不回放关闭期间每一个间隔），再排下次。
  - **confirm**：记 missed + `missedPendingConfirm`，通知「等待确认补跑」；用户在详情点「确认补跑」（即 `runNow`）才执行。
- keep-awake：`config.tasksKeepAwake !== false` 时，有在途运行（`headlessInFlight`，历史路径）或任一 time 任务的 `nextRunAt` 落在提前 5 分钟窗口内则 `powerSaveBlocker.start('prevent-app-suspension')`；设置页可关。系统 `resume` 后重挂定时器并再评错过。

### 已修竞态：早触发导致「执行成功却报错过」（2026-08-31）

setTimeout 计时与 `Date.now()` 存在毫秒级时钟偏差（Windows 可达一个计时器分辨率），定时器可能**早于计划时刻几毫秒触发**。此时 `run()` 里 `lastRunAt` 落在槽位前 1–2ms，若按 `getNextRunAt(schedule, lastRunAt)` 起算，daily/weekly 会把**刚刚触发过的这个槽位**又算成 `nextRunAt`；timer 回调 `finally(arm)` 时该值已 ≤ now，旧判定 `lastRunAt < missedAt` 成立 → 给刚成功的一轮记假 missed + 弹「错过运行」。实证：8-31 落盘数据里 `18:59:59.999 terminal ok` 与 `19:00:00.000 missed` 两条记录在同一毫秒（19:00:00.004）落盘。

修复（`manager.ts`）：

1. `run()` 成败两路计算 `nextRunAt` 一律走 `nextRunAtFrom(task, lastRunAt)`：基准取 `max(startedAt, Date.now())`，刚触发的槽位不可能再成为「下一次」（源头修复）。
2. `arm()` missed 判定加 `TIMER_EARLY_FIRE_TOLERANCE_MS`（5s）容差：`lastRunAt` 落在 `missedAt - 容差` 之后视为已执行过该槽位。
3. `arm()` 对 `headlessInFlight` 在途的任务不记 missed（串行链排队待跑不算错过）。

回归测试：`test/prompt-tasks-manager.mjs`（早触发不误判 / 容差外仍记 missed / 无头在途不记 / nextRunAtFrom 基准 / confirm 不自动跑 / catch-up 补跑 / 唤醒重评）；`test/prompt-tasks-trigger.mjs`（`evaluateMissedWindow` / `shouldKeepAwake`）。

## 已知边界与疑点

- 任务绑定的 providerId/modelId 已透传给 `runHeadlessPiTask`（无头任务跑任务绑定模型；未绑定的任务仍用全局当前模型）。
- catch-up 只补最近一个过期槽，不回放休眠期间每一个 interval 点。
- terminal 模式的 ok 只代表 Worker 拉起成功（GUI runtime 进一步到「任务原文已发出」粒度）；Worker 在终端里后续执行失败不会回写任务状态（设计如此，任务状态只到「拉起」粒度）。
- 无头模式已于 2026-09-22 退役（新建/更新拒收 + 启动 purge），原 30 分钟超时执行链不可达。主进程入口通过 `bindHeadless` 传入 Pi 执行器，离线测试可传入替身。历史 run 记录与离线测试仍引用这条链，整链删除待独立批次。
- 存量任务无 `mode` 字段视为 terminal；新建默认 **terminal**。`mode=headless` 创建/更新一律拒绝（`定时任务不再支持无头模式`）。启动构造期 purge 全部 headless 任务，purge 摘要打启动日志（`[tasks] purged …`，名称 + 提示词截断；`listPurgedHeadless()` 供测试与未来 UI 出口）。
- 编辑界面不再提供「调度 Agent（无头）」；chat runtime 平铺会话模式 / Pi·ACP 模式 / 会话模型 / 思考档（`TaskSessionFields`，与新建任务弹窗同口径）。
- 调度浮窗左侧「定时任务」历史抽屉已撤（原为回看无头会话）；顶栏改为左「重置」（`surface.actions.clear`）+ 右「收起」（`setChatWorkspaceId(null)`），气泡「对话/收起」常驻逻辑不变。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D01.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：用户/调度把重复提示词固化为定时任务，到点拉起可见 terminal Worker；左栏「服务」面板建管，运行历史、错过策略（skip/catch-up/confirm）、keep-awake 兜底长任务窗口。
- 明确不做：headless 无头模式已退役；time 错过策略仍只覆盖定时槽位，catch-up 只补最近一次；terminal ok 只到 Worker 拉起/GUI 原文已发出。
- 歧义点：①任务状态粒度——「拉起成功即 ok、Worker 后续执行成败由会话自身状态表达、不回写任务历史」是长期边界还是路线图要补回写？A=长期边界（任务=定时拉起器，成败表达已在会话相位/needs_you 链路，回写会双报；review 不把无回写当 finding）／B=排期补回写（任务历史能看到每轮真实成败）。推荐 A。②headless 退役链「暂留待独立批次删除」——本专项 review 把它当已知不可达代码不列 finding（A），还是授权随批删除（B）？推荐 A（先审后批纪律，删除属破坏性独立批次；review 只核对其不可达性）。

## 模型工具回执

`shared/resourceToolResult.ts` 只投影模型出口：`automations.create/update` 不再重复返回已提交的 prompt，保留 automation id、实际 schedule/nextRunAt、enabled、源根、权限与模型配置和错误。程序与界面继续收到原始 task。`list` 是当前唯一读取任务正文的入口，继续保留 prompt；大量长正文任务的列表尚无分页，仍受工具总预算限制。回归见 `test/resource-tool-result.mjs`。
