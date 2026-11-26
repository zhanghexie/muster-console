# 脚本工作流（dynamic-workflow）

> 设计与裁决见 plans/implemented/dynamic-workflow-plan.md（用户拍板不分期，W1–W4 一次落地）。本文是落地后的现状。

## 功能职责

把「派活 → 等 → 读产物 → 判断 → 再派」这类重复编排固化成一个**类似 skill 的目录**（说明文档 + 脚本），由宿主按脚本执行机械步骤；脚本遇到需要判断的地方用 `wf.ask` 挂起，交还调度（或直接问用户）。脚本里不调模型。

`wf.delegate({task,isolate,...})` 的 `isolate` 必须显式为布尔值：true 隔离、false 共享；不支持 auto、字符串或缺省。旧脚本需明确选择后再执行。参数在 memo 占位、计数和派活前校验；队列固定选择，已有 creationKey 的会话恢复沿用已有隔离资源。dirty 仅为创作脚本时可参考的策略，见 [Worker 隔离决策指引](worker-inject.md#隔离决策指引)。

- **形态**：工作区 `.muster/workflows/<名字>/WORKFLOW.md`（扁平 frontmatter：`name` / `description` / `args` / `maxDelegates` / `maxHours`，可选触发 `schedule` / `on` / `cooldown`）+ `run.mjs`（`export default async function (wf, args)`）。目录进仓，人和调度都能写。
- **创作合同**：内置 `workflow` 技能统一提供 `host.workflow.run` 的参数参考、`wf` API 表、触发写法和重跑规则。调度指令和工具描述给安装路径 `~/.muster/skills/workflow/SKILL.md`（A5）。
- **两个命令**（调度对话框，GUI Worker 面不出现）：`/workflow-new <想自动化什么>`（别名 `/新建工作流`）让调度按技能编写和校验脚本，并向用户说明流程。`/workflow <名字> <参数>`（别名 `/工作流`）让调度解析参数后调用 `host.workflow.run` 的 `start` 动作。在调度输入框手动键入命令。斜杠菜单不显示这两条命令或工作流名称。
- **信任（TOFU）**：内容指纹 = sha256(WORKFLOW.md + `\0` + run.mjs) 前 16 位。AI 首次执行某指纹时以完整说明和脚本交独立安全审核，疑点才弹确认框，通过后写 `extensionTrust[ws]['workflow:<名字>']`；用户在面板点「信任」直接记录当前指纹，不运行也不送审，「撤销信任」删除该键。改了脚本或说明须重新信任。**`wf.run` 允许任意命令，只受这一道指纹信任审核约束，不逐条审批**。**执行前的统一信任门**：`workflow.start` 与 `workflow.validate` 的执行型冒烟经 `confirmExecutionTrust` 收口；自动触发、重启续跑与子工作流恢复只认已信任的当前指纹。审核和执行前后重读并校验指纹；内容变化则重新过门，稳定一致才使用绑定的脚本快照，定义错误或反复变化则拒绝执行。worker 线程不是沙箱，任何真实 import 模块代码的路径都必须先过这道门。
- **触发**：frontmatter 声明，宿主直接起 run（不经调度回合）；只对**已信任的当前指纹**生效。
- **工作流面板**：调度输入栏旁「工作流」胶囊 + 上弹面板，两个标签（复用全局看板的 `board-view-switch`，左右方向键切换；打开时有运行中的 run 落「运行」，否则落「列表」）——「运行」：run 卡片（阶段 / 在等什么 / 待答问题 / 日志 / 取消）+ 最近结束；「列表」：工作流清单（触发与信任状态；信任 / 撤销信任、停用 / 启用触发、删除）。问用户的问题在卡片上直接答。
- **停掉定时 / 删除**：「停用触发」只在触发状态里记 `disabled`，文件不动，定时与事件都不再触发；「启用触发」从此刻重立定时基准，不补跑停用期间。「删除」通过共用 AppConfirmDialog 显示目标及回收站说明，确认后把整个工作流目录移到系统回收站（`shell.trashItem`），同时清触发状态、撤销信任；有运行中的 run 时拒绝，须先取消。已在跑的那次 run 用卡片上的「取消运行」停。
- **清理运行历史**：「最近」区块「清空历史」（共用确认弹窗）删除全部已结束的顶层 run 记录，展开单条可「删除记录」；运行中的不删，子 run 随父删除（`runtime.clearRuns`）。胶囊在只剩历史时也显示，保证工作流删光后仍能清理。

## 关键文件与入口

| 文件 | 职责 |
|---|---|
| `src/shared/workflowCommand.ts` | 路径常量 + 两个命令的解析/展开（renderer-safe，零依赖；输入框与 runTurn 共用） |
| `src/shared/workflow.ts` | 纯函数：WORKFLOW.md / args / 触发（`parseWorkflowSchedule` / `parseWorkflowOn`）解析校验、run 记录解析与日志、memo 键（`stableStringify` + `fnv1a` + 出现序号）、预算（扣除等人时间）、`wf.waitFor` 匹配与任务/会话相位快照判定、确定性派活任务 id `workflowDelegateTaskId`、保留策略 `selectWorkflowRunsToPrune`、触发状态解析、面板视图 `workflowRunView` 与类型、上限常量 `WORKFLOW_LIMITS`、`wf.tool` 白名单 |
| `src/main/workflow/store.ts` | 工作流目录扫描、指纹、run 记录原子读写/删除（`.muster/scheduler/workflow-runs/<runId>.json`）、触发状态（`.muster/scheduler/workflow-triggers.json`），均已被 gitignore |
| `src/main/workflow/kernel.ts` | 每个 run 一个 `worker_threads`（同 node_repl 的 eval 源）：把已核对指纹的脚本字节写入同目录短期快照后 import（保留相对导入），结束时清理快照（崩溃/terminate 残留的 `.exec-*.mjs` 由 `.muster/.gitignore` 的 `workflows/**/.exec-*.mjs` 忽略，不污染 git status），`wf.*` 经 postMessage RPC 回主线程，每次调用携带 `wf.state` 快照；取消/超限直接 `terminate` |
| `src/main/workflow/runtime.ts` | `WorkflowRuntime`：run 生命周期、`wf.*` 实现、memo 续跑、派活防重复、护栏、子工作流、等待注册、人侧问题、定时/事件触发、保留清理、取消收尾、面板概览、重启恢复；外部依赖全部经 deps 注入（测试可替换） |
| `src/main/workflow/wiring.ts` | 装配：delegate 走 `delegateTask`（透传内部确定性 `creationKey`；排队时经 `delegateBridge` 等真正拉起并登记撤销回调）、`wf.tool` 走 executor（调度身份 + 工作区作用域）、会话创建记录/相位、信任确认框与不弹窗的 `trustState`、撤销信任、问用户桌面通知（`ctx.ui.notify`）、变更推送 `workflow:changed`（250ms 防抖）、泵 tap → `runtime.onEvent`、事件 → `enqueueWorkflow` |
| `src/main/workflow/delegateBridge.ts` | 排队派活等待桥：挂起等 `delegateQueue` 出队回调 + 取消撤销（`cancelQueuedDelegate`），从 wiring 抽出供真实队列联动测试复用 |
| `src/main/workflow/runtimeRef.ts` | 运行时单例引用（断开 executor ↔ wiring 循环 import；IPC 也经它取） |
| `src/main/capabilities/catalog/workflow.ts` + `hosts/workflow.ts` | 调度工具组 `workflow`（7 个，仅调度可用，不在 Worker 白名单） |
| `src/main/ipc/workflow.ts` | 面板 IPC：`workflow:overview` / `answer`（只答问用户的问题，核对 askId）/ `cancel` / `trust` / `revokeTrust` / `setTriggers`（停用·启用触发）/ `delete`（移到回收站）/ `clearRuns`（清理运行历史） |
| `src/main/tasks/delegate.ts` → `SessionMeta.meta.creationKey` | 创建时持久化内部标识，供重启防重复找回普通会话 |
| `src/main/agent/orchestrator/turnExecution.ts` | `runTurn` 在记忆前缀之前展开命令（仅非 host 回合；界面显示原文） |
| `src/renderer/src/agentChat/WorkflowArea.tsx` / `WorkflowPanel.tsx` / `useWorkflowOverview.ts` | 胶囊 + 面板（portal 进 `.chat-input-shell`，`mp-pop mp-pop-up` + `usePresence(open, MOTION.menuMs)`，同后台任务面板）；概览首帧拉取 + `workflow:changed` 同工作区重拉 |
| `src/renderer/src/components/AgentComposer.tsx` | 仅 `surfaceKind === 'dispatch'` 且有工作区时挂 `WorkflowArea`（与后台任务胶囊并列，窄宽容器查询下一起隐藏） |
| `src/renderer/src/components/agentComposer/composerHelpers.ts` + `useComposerSlashMenu.ts` | 斜杠菜单候选过滤与 `isUnsupportedSlash(..., workflowCommands)` 对手动命令的表面限制 |
| `src/renderer/src/styles/workflow.css` | 面板样式（token-only，布局与进出场复用 bgTasks.css） |
| `src/main/index.ts` | 创建期 scope 托管，`workflow-runtime` 域启动；3s 续跑定时器归该 scope，退出等待命令容器、内核线程、已受理宿主回调和启动确认 |

内核业务 `done` 与资源 `release()` 分离；终态不能丢掉未退出的 Worker 引用。停机先停止新启动与触发，取消 ask/waitFor 和源工具 signal，再等待资源；保存的 running/waiting 状态仍供下次信任校验后续跑。

## 调度工具

| 工具 | 说明 |
|---|---|
| `workflow.list` | 列出工作流（名字/说明/参数/上限/指纹/是否已信任/触发）与活跃 run |
| `workflow.validate` | 静态解析说明（不执行脚本）+ 执行型冒烟 import（检查默认导出；**模块顶层代码会真实运行**，先过当前指纹信任确认，拒绝则跳过 import 并在 `exec` 字段标明）；语法错误/缺 default/顶层 throw/超时在 errors 里可见 |
| `workflow.start` | 校验参数 → 信任确认 → 起 run；进度与待答问题以编排事件送来，不必轮询 |
| `workflow.get` | 查 run：状态、阶段、日志尾、待答问题、结果/错误、触发来源、派出的会话 |
| `workflow.reply` | 答复脚本的 `wf.ask`（仅问调度的那种；问用户的被拒） |
| `workflow.askHuman` | 用户在对话里提起时，把待答的问人问题弹成决策卡（`requestUserQuestion`），答案直接回写 run；默认路径是面板 |
| `workflow.cancel` | 取消 run 及其子 run；`closeSessions: true` 时先归档本 run 与子 run 派出的会话，确认成功后调用 `sessions.delete`；归档或删除失败逐个报出并保留未删会话；取消期间的在途派活先试撤销（`revokedDelegates`），撤不掉的登记为迟到补偿（`lateDelegates`，创建完成后按选项补关并写进 run 日志） |

触发任务（prompt-tasks）回合隐藏 `workflow.start / reply / askHuman / cancel`（`turnVisibility.ts`）。

## 数据流

1. **启动**：`workflow.start` / 面板外的 `/workflow` → `runtime.startRun(ws, name, args, {trigger})` → 校验 args / 嵌套深度、同步预占顶层运行名额 → 手动走 `ensureTrusted`（可弹窗），触发走 `trustState === 'trusted'`（不弹窗）→ 按最终确认的定义重验 args，核对父 run 仍存活、应用未关闭 → 成功写 run 记录 → kernel 起 worker → 事件 `started`（digest，文案区分 启动 / 定时触发 / 事件触发）。
2. **执行**：脚本调 `wf.*` → RPC → runtime。`delegate / ask / waitFor / call` 与带 `key` 的 `wf.run` 先查 memo（键 = `种类:fnv1a(参数)#第n次`），命中直接返回；未命中执行后写 memo 并落盘。不带 key 的 `run` 与 `tool / read / glob` 不记账。
3. **派活防重复**：派出前先写 memo 占位 `{__pending:true, taskId}`（`taskId = workflowDelegateTaskId(runId, memoKey)`），并把该 id 作为内部 creationKey 随会话创建落盘；`wf.delegate` 从该字段返回 `taskId`，只用于工作流步骤记账，不创建共享任务行。重跑遇到占位：存在匹配创建记录的会话 → 直接用，不再派；没有 → 用同一 id 补派，不重复计数。派活发出后登记 in-flight 归属（含可撤销回调与已请求取消标记），直到结果落地才移除；`delegateTask` 投递阶段失败会抛携带 `sessionId` 的结构化错误（会话已建出且保留），供取消迟到补偿识别已创建资源。
4. **等事件**：`wf.waitFor(match)` 注册等待；泵 `addTap` 在订阅策略判定**之前**把每条事件 view 喂给 `runtime.onEvent`，命中即返回事件字段。先查现状：等具体会话的相位查 `session.phase`，已满足立即返回（`snapshot: true`）。超时返回 `{timedOut:true}`。
5. **交还判断**：`wf.ask` 写 `pendingAsk`（同一时刻只有一个）。问调度 → 事件 `ask`（底线必唤醒，行内给 `workflow.reply` 参数）；问用户 → 事件 `ask_human`（只捎带）+ 桌面通知，面板卡片直接作答（`workflow:answer`），调度也可经 `workflow.askHuman` 代为弹卡。答案写入 memo，脚本继续。等人时间从预算中扣除。
6. **结束**：`return` → `completed`（唤醒）；抛错/超限 → `failed`（唤醒）。子 run 不单独发完成/失败事件，结果经父 run 的 `wf.call` 返回。顶层 run 结束后按保留策略清理旧记录。**终态收口（settle）统一收回本 run 自有资源**：waiters 定时器、在途派活标记、自有子进程（见 `wf.run`），取消/超限/内核意外退出/关机都走同一处。
7. **重启**：`resumeAll` 扫各工作区未结束的顶层 run——指纹一致**且当前指纹仍被信任**（重新查询信任表：撤销或改过未确认都不续跑）则从头重跑脚本（memo 让已完成步骤直接返回）；指纹变了或信任不在标 `interrupted` 并发事件（原因写明重新信任/手动启动入口），memo/日志保留在记录里——**待答问题随中断清除**（正常续跑沿用原 askId 的行为不变，中断的 run 需重新确认后重跑）。之后清理旧记录并巡检一次触发。子 run 经父 run 的 `wf.call` memo（`{__child: runId}`）续上，恢复前同样重查子工作流信任。
8. **面板**：run 记录/触发状态每次变化调 `deps.onChange` → wiring 防抖推 `workflow:changed {workspaceId}` → 渲染层重拉 `workflow:overview`（工作流清单 + 活跃 run + 最近 10 条结束的顶层 run）。

## 触发

frontmatter（解析失败或不满足约束时该项不生效并出警告，工作流本身仍可手动运行）：

| 字段 | 写法 | 约束 |
|---|---|---|
| `schedule` | `daily 02:00` / `weekly 1,3,5 09:30`（0=周日）/ `every 30m` / `every 2h` | 间隔 ≥ 5 分钟；不能有必填参数。复用定时任务的 `getNextRunAt` 算下一次 |
| `on` | 一行 JSON，语法同 `wf.waitFor` 的 match | `kind` 必填且不能是 `workflow`；必填参数只能是 `event`（事件 view 作为 `args.event` 传入） |
| `cooldown` | 分钟 | 事件触发冷却，默认 10，最小 1 |

- **巡检**：60s tick（与预算巡检同一个）调 `checkTriggers()`；事件触发在 `onEvent` 里同步判定（工作流定义缓存随 tick 刷新）。
- **信任门**：从未信任 → 不触发（面板显示「触发未生效」+ 信任按钮）；信任过旧版本、当前内容未确认 → 跳过并发 `trigger_blocked` 事件唤醒调度，每个指纹只报一次（`blockedFingerprint`）。
- **定时基准**：当前指纹首次被看到已信任时立基准（`anchorAt` / `anchorFingerprint`），不立即补跑；指纹变了重立。到点（`nextDue(max(lastFiredAt, anchorAt))`）触发；应用关着错过多次，启动后只补跑一次。
- **防连锁/防风暴**：`workflow` 事件不触发；事件来自工作流自己派出的会话/任务不触发（活跃 run 的 `sessions` / `tasks` + 12h 的 `owned` 表，run 结束后仍生效）；冷却期内不触发；同一工作流上一次触发起的 run 仍在跑时跳过；工作区活跃 run 已满时跳过。跳过原因记 `lastSkip`，面板可见。
- **停用**：面板「停用触发」置 `disabled`，定时巡检与事件判定都先跳过（不记 `lastSkip`）；概览与 `workflow.list` 带 `triggersDisabled`。
- **状态文件**：`.muster/scheduler/workflow-triggers.json`（按工作流名：`anchorAt` / `anchorFingerprint` / `lastFiredAt` / `lastEventAt` / `blockedFingerprint` / `lastSkip` / `disabled`）。

## 护栏

- 每工作区活跃顶层 run 与等待信任确认的顶层启动合计 ≤ 3；启动失败或拒绝确认释放名额。自动触发的同名流程在启动等待期间也防重。子工作流嵌套 ≤ 3 层。
- **异步启动生命周期**：每轮信任确认返回后重查父 run 和应用生命周期；父流程取消、失败或关机后，迟到的确认不能启动子流程，也不能把父记录写回 running。
- **保存失败**：首次记录、派活占位、问答、事件结果、终态等关键记录写入失败时立即停止内核与子流程，撤销在途派活，阻断下一步副作用并发失败事件。故障记录写入独立的 `.muster/scheduler/workflow-failures/<runId>.json`，读取优先于旧运行记录，重启不再续跑该失败实例；清理历史时先删旧运行记录再删故障记录。内存故障记录也参加面板概览，即使首次写入失败仍可见。巡检与关机重试故障记录。
- 每工作流 `maxDelegates` 默认 10 / 天花板 30，`maxHours` 默认 24 / 天花板 72（等人与停机不计）；60s 一次预算巡检，超限即失败。
- `wf.read` / `wf.glob` 限工作区内，拒绝 `.muster/local/`、`.muster/runtime.json`、`.git/`；读取超 256KB 截断。
- `wf.tool` 只放行 `WORKFLOW_TOOL_WHITELIST`（shared/workflow.ts）。
- `wf.run` 默认超时 10 分钟、最长 60 分钟；Windows 下整行命令走 `shell: true`。run 日志只记程序名与参数段数（`workflowRunCommandLog`）：日志持久化且经 `workflow.get` 回传调度模型，参数里可能有密钥。
- 问用户不接受空答：面板与调度代弹的问题卡都禁止空提交；卡片侧即便收到空选（含多选）也按未作答处理，问题保持挂起。
- **保留**：已结束的顶层 run 保留最近 50 条且结束不超过 30 天；子 run 跟随父 run（父仍活跃的不删）。在 `resumeAll` 与顶层 run 结束时清理。
- **取消收尾（W3）**：`workflow.cancel`（含面板取消）先把本 run 与子 run 的在途派活收回——仍在派活队列里的直接撤销（不创建会话，占位 memo 清理、计数回退，返回 `revokedDelegates`）；**取消发生在派活在途（回调未登记）时先记 `cancelRequested`，撤销回调晚登记立即消费撤销（r1 交接窗口）**；已开始创建的撤销不了，登记为迟到补偿（返回 `lateDelegates`）：`closeSessions:true` 时派活出口迟到返回后补关其会话并写进 run 日志（失败也逐条可见），`false` 时保留会话但迟到结果仍记入 run 的 `sessions/tasks`（审计可见）。**迟到失败同样结算（r1）**：生产派活在会话建出后投递失败会抛携带 `sessionId` 的结构化错误（`delegate.ts` 投递阶段统一打标，会话保留）——取消要求的补关照样执行并记账；无资源的迟到失败（如取消后创建失败）清 pending 占位/计数、`delegateQueue` 对已请求取消的在途项失败不再回插重试（dropped 结算，不会派出第二个会话）。取消时已记录的会话按原语义关闭；重复取消直接报「已不在运行」，不重复关闭任何资源。
- **`wf.run` 子进程收回（W4）**：普通管道命令与后台 PTY 复用受控 Node leader 协议。用户命令启动前完成 nonce 身份核验和 Windows Job / macOS、Linux 进程组归属；leader 在用户命令自然退出后继续存活，直至容器回收，避免根 shell 先退后按裸 PID 误判成功。Windows Job 覆盖 detached 后代；POSIX 归属范围为继承该进程组的后代，主动创建新 session/group 的第三方进程不在该组覆盖内。命令结果保留真实 code/stdout/stderr，清理失败显式拒绝并保留 owner 供退出重试。取消等待真实命令容器及 Worker 线程释放；无法撤销的业务派活继续以 lateDelegates 标明并由运行时持有回调。停止日志不写命令或参数。

## 编排事件

kind=`workflow`，trigger ∈ started / phase / ask / ask_human / completed / failed / interrupted / trigger_blocked，去重 key `workflow:<runId>:<trigger>`（`trigger_blocked` 的 runId 为 `trigger-<名字>`），不刷新活动。订阅策略内置 `builtin.workflow-wake`（ask/failed/interrupted/completed/trigger_blocked → wake）与 `builtin.workflow-progress`（started/phase/ask_human → digest）；ask/failed/interrupted 在底线层，静音规则挡不住。见 [subscription-policy.md](subscription-policy.md)、[orchestrator-events.md](orchestrator-events.md)。

## 已知边界

- **不带 key 的命令与读工具会重跑**：`wf.run`（无 key）/ `tool` / `read` / `glob` 重启后再执行一次，脚本须幂等或给 `wf.run` 带 `key`（README 有写）。
- **事件触发的定义缓存最长滞后一个 tick（60s）**：刚改的 `on` 声明可能下一分钟才生效；起 run 时会重新加载并再校验信任。
- **取消默认不收尾 Worker**：需显式 `closeSessions`（面板取消确认里有勾选项）；在途派活与子进程按上文 W3/W4 收回，迟到补关异步进行（结果写 run 日志）。
- **撤销信任后已运行的 run 不会立即停止**：撤销只阻断后续执行（触发/续跑/validate）；已运行实例按原合同继续到结束或手动取消。
- **信任被撤销后的 run 标记 interrupted 后重跑是新 run**：memo 不跨 run 复用，重新 start 会从头执行（与「停机期间改脚本」同一语义）；确定性任务 id 随新 runId 变化，若撤销前的派活任务仍在跑，重新 start 可能并行再派（避免这种用法）。
- **进程树收回的边界**：Windows 用 `taskkill /T /F` 按 PID 收树，PID 复用窗口内理论上可能误伤（判活后窗口极小）；POSIX 无进程组只杀直接子进程，孙进程可能存活。命令已发生的副作用不可回滚。
- 脚手架保留 `.muster/workflows/` 作为项目脚本目录。初始化时清理可确认与旧版模板一致的 README，保留项目自己的说明与工作流定义。
- **执行快照崩溃残留不自动清理**：worker.terminate/宿主崩溃会留下 `.exec-<指纹>-<runId>.mjs`（validate 为 `.exec-validate-*`）；功能无害且已被 `.muster/.gitignore` 忽略（不进 git status），残留会随历史 run 累积，可手动整批删除。
- **存储整体不可写**：主记录和独立故障记录都写不进磁盘时，本次进程仍立即停止并显示明确错误；在磁盘恢复并成功重试前，无法保证应用崩溃后的恢复状态。已执行的命令或派活不能通过记录失败回滚。

## 测试

- `test/workflow-wiring.mjs`：生产 `createWorkflowRuntime` 与真实内核，验证返回内部创建键、记账、取消前先归档、真实 `planCloseBatch` 的未归档拒绝、归档失败保留与迟到补偿。
- `test/workflow-lifecycle.mjs`：父流程取消/关机时迟到子流程确认、首次/派活/答复/等事件/结束写盘失败、独立故障记录阻止重启、双写失败可见与重试、并发名额与自动触发防重、恢复单条失败不阻塞其他流程。
- `test/e2e/workflow-lifecycle.spec.ts`：独立临时工作区启动真实 Electron，经 preload/IPC、人侧问题与真实信任确认框验证取消期间不能启动子流程，以及撤销信任后重启标记 interrupted。无需真实模型服务。

- `test/workflow.mjs`：说明/参数/触发解析、run 记录解析、memo 键稳定性、预算扣等人、waitFor 匹配与会话相位快照、确定性步骤 id、保留策略、触发状态解析、人侧问题映射、glob、订阅策略默认与底线、事件泵旁听点。
- `test/workflow-runtime.mjs`：真 worker 内核端到端——闭环（含问用户时桌面通知）、重启 memo 不重复派活、`wf.run` key 记账、派活崩溃按会话创建记录找回/补派、会话相位快照、取消关闭派出的会话、保留清理、定时触发（信任门/立基准/补跑一次/改后跳过并只报一次）、事件触发（匹配/冷却/防连锁/信任门）、停用/启用触发与删除工作流、手动清理运行历史、护栏、子工作流、排队派活等拉起；2026-10-02 修复新增：validate 信任门（拒绝不 import/确认后执行型/throw·语法·超时可见）、撤销/改过未确认阻断续跑（含子工作流）、取消收回在途派活（排队撤销/创建中迟到补关/closeSessions:false 保留语义/双取消，经真实 delegateQueue+delegateBridge 联动）、取消/超时停止自有进程树（真 Windows shell→Node→孙进程）、validate 真实能力入口（调度身份门+信任门）；r1 复审新增：确认等待期间改文件绑定执行版本（start/validate/反复变化）、迟到失败带已建会话（补关/记账/关闭失败可见）、taskkill 收树失败回退（宿主不死，MUSTER_TASKKILL_BIN 注入）、交接窗口晚登记立即撤销、取消后创建失败不重插重派、预算失败与关机收树。
- `test/unit/workflow-panel.spec.tsx`：胶囊显隐与待答高亮、推送重拉、问用户单选/多选作答、问调度只展示、取消二次确认与关闭会话失败报出、信任/撤销信任、两个标签的默认落点与切换、停用/启用触发、删除二次确认与失败报出、清空历史与单条删除、旧 preload 缺接口时行内提示重启。
- `test/unit/agent-composer-workflow.spec.tsx`：调度面菜单不列工作流命令或名称，手动键入 `/workflow 名字 参数` 回车原文发给调度。GUI Worker 面不列，手动输入时提示未支持。
- `test/composer-helpers.mjs`：`isUnsupportedSlash` 的 workflowCommands 开关、各面菜单项。
- `test/prompt-task-preflight-accounting.mjs`：runtime 禁用/注销的执行前置失败进统一记账（manual/interval/once/event 四入口 + 源目录失效不回归 + 恢复后可重试）。
- `test/subscription-policy.mjs`：workflow kind 的内置规则与底线。

信任适配器 `workflow/wiring.ts` 在审核前后读取说明与脚本并核对同一 workflowFingerprint，避免审核期间更换内容后保存授权。执行时的快照/生命周期复核继续由 runtime 负责。该接入未改变 wf.ask 的业务问答。离线回归与真实模型/UI 结果待根代理统一验收。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D01.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：调度把「派活→等→读产物→判断→再派」的重复编排固化成工作区 `.muster/workflows/<名>/`（WORKFLOW.md+run.mjs，人和调度都能写、进仓），宿主按脚本执行机械步骤、`wf.ask` 挂起交还判断；调度对话框 `/workflow-new` `/workflow` 两命令，面板看运行/答问题/管信任/停触发。
- 为什么这样设计：TOFU 指纹信任是唯一安全门（`wf.run` 允许任意命令、不逐条审批，用户拍板），确认与执行内容绑定（确认返回后重读校验指纹，变了重新过门有界循环）防 TOCTOU；memo 占位+确定性 taskId+creationKey 落盘实现重启续跑不重复派活；worker_threads 内核不是沙箱，任何真实 import 模块代码的路径必须先过信任门（start/validate/触发/续跑统一收口）；关键记录保存失败立即停内核、撤在途派活、写独立故障记录阻止重启续跑；取消收 W3（排队撤销/迟到补偿补关/迟到失败也结算）+W4（Windows taskkill 收整棵进程树、失败回退不死宿主）；并发 ≤3/嵌套 ≤3/maxDelegates/maxHours 预算护栏防风暴。
- 明确不做：不带 key 的 `wf.run`/tool/read/glob 重启后会重跑（脚本须幂等，README 写明）；取消默认不收 Worker（closeSessions 显式勾选）；撤销信任不停止已运行 run（只断后续触发/续跑/validate）；事件触发定义缓存滞后一个 60s tick；已发生的命令副作用不可回滚；托管 README.md 是受管文件。
- 歧义点：POSIX 进程树收回只杀直接子进程、孙进程可能存活（Windows taskkill /T /F 收全树）——A=接受为一期边界（已如实披露，真机泄漏案例再立项；review 记已知边界不升级）／B=排期补 POSIX 进程组方案（detached+进程组负 PID 杀树）。推荐 A；但若用户认为 mac/Linux 上跑长驻 wf.run（dev server 类）是真实使用场景，则选 B。

## 模型工具回执

`shared/resourceToolResult.ts` 在模型出口把 `start` 和 `list.active` 投影为运行摘要：保留 runId、status/phase/waiting、待答问题、已派会话、预算与错误；不回显任意 args、log、result 和刷新计时字段。模型用 runId 回复或取消；进度由事件送达。显式 `get` 保留诊断/产物读取语义，任意大产物尚无分段读取保证。程序调用者仍收到原始对象。回归见 `test/resource-tool-result.mjs`。
