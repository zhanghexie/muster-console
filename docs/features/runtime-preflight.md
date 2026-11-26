# Runtime 可用性预检与设置页状态徽标

## 职责

在拉起 Worker 会话（`sessions.create` / `sessions_create`）之前探测目标 runtime 是否满足本机静态预检，不可用就拒绝创建并把「差什么、怎么装/怎么配」写进报错；设置 → Worker 顶部 Harness 列表显示检测状态、安装指引和配置入口，下方配置列表与详情仍可手动检测。静态预检不代表登录、模型或实际回合已验证。另有一个配套守卫：GUI 引擎无任何输出即结束回合时，回合不再静默收口，而是把异常标在消息上。

背景（2026-09-25 全量自检 11 个 runtime 的实发现）：

- gemini CLI 未安装，`sessions_create` 照样成功但终端空屏；
- codex/gemini 的 runtime 脚本文件缺失（`runtimes_restoreBuiltins` 可修），同样静默空屏；
- cursor-gui/codex-gui/acp 注入后回合静默结束（assistant 空 text、gui-turn-end），错误被吞；
- opencode key 失效 / grok 鉴权失败属用户配置，但创建时无任何预警。

界面只展示检测已得到的事实（程序/配置已发现、缺少依赖等），不把文件存在推断为登录成功。Agent 详情按聊天与终端各自的检测结果显示安装入口：程序已发现时隐藏详情内的「重新检测本机」和「安装指南」，未发现或未知时保留；配置问题和修复指引仍显示。页面右上角「刷新」始终提供手动重新检测，任务创建页依据同一检测快照显示「已检测」或具体问题。

## 关键文件与入口

| 文件 | 职责 |
| --- | --- |
| `src/shared/runtimePreflight.ts` | 纯逻辑层：状态/问题类型、`findOnPath`（可注入 PATH 探测）、`extractCliToken`（剥 cmd.exe 包装）、`classifyPtyPreflight`、`describePreflightFailure`（创建拒绝文案）、`preflightBadgeOf`（徽标映射）、`RUNTIME_CLI_INSTALL`/`CHAT_RUNTIME_CLI_INSTALL` 安装命令目录 |
| `src/main/runtime/preflight.ts` | 主进程编排：`preflightRuntime(deps, id)`（pty：脚本存在 + 模块可加载 + CLI 在 PATH；chat：`AgentSessionHost.probeRuntime` → driver.probe）、`preflightAllRuntimes` |
| `src/main/tasks/delegateLaunch.ts` | 首次任务信保存后对 CLI 启动做最多 8 秒检查；进程已运行返回 started，仍在启动返回 starting，已退出则携带 launchError 抛错并保留会话与信件 |
| `src/main/runtime/availability.ts` + `src/shared/runtimeAvailability.ts` | 新建/关联使用的可用 Worker 快照，注册目录与本机预检交集；设置展示的结果也探测已停用的内置 GUI 引擎，ACP 逐预设探测，最多并发 2，每项最多等待 5 秒。停用项不会加入可选 runtime 或 ACP agent 列表 |
| `src/main/sessions/createTerminal.ts` | `createAgentTerminalSession` 内的创建闸门（`force: true` 逃生门）；`CreateTerminalFlowCtx.agentSessionsRef` 回接 chat 探测；`SessionsService.createTerminalCtx` 注入 |
| `src/main/agentSession/host/base.ts` + `host/agentSessionHost.ts` | `probeRuntime`：driver 注册与 probe 调用编排（未实现按 unknown；异常不打断批量预检） |
| `src/main/agentSession/types.ts` | `GuiRuntimeDriver.probe?()` driver 合同 |
| `drivers/{pi,cursor,claude,codex,acp}/driver.ts` | 各 driver 的 `probe()` 实现（不 spawn 引擎） |
| `src/main/capabilities/hosts/runtimes.ts` + catalog | `runtimes.preflight` 工具（只读）；`sessions.create` 新增 `force` 参数 |
| `src/main/ipc/workspaces.ts` + `src/preload/index.ts` | `runtimes:preflight` IPC 与 `window.api.runtimes.preflight(id?)` |
| `src/renderer/src/hooks/useRuntimeAvailability.ts` | 新建任务、手机入口、定时任务共用；从主进程读取已有快照，只有手动刷新执行全量检测 |
| `src/renderer/src/components/settings/WorkerPane.tsx` | 产品列表/详情中的发现状态、问题与指引；显式重新检测刷新快照，失败就近显示；高级设置仍可单项调用预检 |

## 预检语义

预检通过不代表进程已启动。带任务的 `sessions.create` 先保存任务信，再对 CLI 做有界启动检查；启动阶段失败的错误带 `sessionId`，工作流和 CLI run 可据此记账、补偿或观察原会话。慢启动返回 `starting`，不重复创建。邮箱提醒仍按真实 idle 状态投递；此检查不承诺后续外部 CLI 回合执行成功。`test/delegate-launch.mjs` 通过生产 delegate 与真实邮箱覆盖该契约。创建界面使用结构化预检结果翻译宿主安装指引，设置页对已知指引做显示投影；模型工具收到的原始错误及外部诊断不改写。

状态：`available` / `not_installed` / `not_configured` / `script_missing` / `disabled` / `unknown`。

- **pty runtime**：`enabled=false` → disabled；userData 脚本文件缺失 → `script_missing`（指引：设置页「恢复开箱」）；脚本模块加载/`resolveLaunch` 失败 → `unknown`；从 `resolveLaunch(mode:'start', 占位 id)` 的结果剥出 CLI token（win 下剥 `cmd.exe /d /s /c "chcp…& …"` 包装），按 PATH（win 按 PATHEXT——按「名字是否带扩展名」判定，PATH 目录名含点不影响补齐探测，2026-10-01 修复）查找，未命中 → `not_installed`（附 `RUNTIME_CLI_INSTALL[id]` 安装命令，如 gemini → `npm install -g @google/gemini-cli`）。

  Codex 与 Cursor 内置终端的 probe、辅助命令和 PTY 启动由 `_native.mjs` 使用同一解析规则选定可执行文件：开发版 Electron 从自身 `node_modules/electron` 定位工作台的 `node_modules/.bin` 并跳过该目录，保留其余 PATH 顺序；打包版没有该目录。Windows 原生 `.exe` 直接启动，`.cmd` 经既有 cmd 包装；macOS/Linux 检查可执行权限。候选文件不存在是普通未命中，不以异常作为常规路径；每次查找仍读取当前文件状态，不缓存未命中结果，因此安装或删除后下次查找即可观察到。只找到工作台自己的依赖副本时视为未安装，不把 SDK 带入的旧 CLI 当作用户安装。Cursor 的 `create-chat` 只有返回 UUID 才建立会话；更新或状态文本不再被当作 chatId 去 `--resume`。已经运行的 TUI 若因 CLI 自更新退出，宿主仍将该会话标为退出，需在更新完成后显式重拉；不自动循环重试。
- **chat runtime**（driver probe，全部不 spawn 引擎、不发网络）：
  - `pi`：SDK 内置，但模型配置仍需有效。与 connect 共用 `resolveLlmConfigWithReload`（空 Key 先重载一次），检查服务商启用、API Key、Base URL 与模型；缺失返回 `not_configured`。创建时 `inheritMeta.modelOverride/piModeId` 透传到预检，优先级为会话模型 > 模式钉模型 > 全局默认；不联网验证凭证或余额；
  - `cursor`：查 `AppConfig.cursor.apiKey` 与默认模型 → 缺则 `not_configured`；
  - `claude` 复用设置页探测（`probeClaudeGuiStatus`）。探测、模型目录和聊天使用同一个 CLI 查找入口，依序检查 PATH 和常见安装目录。开发版可以使用 SDK 平台包作为回退，打包版缺少本机 CLI 时显示 `not_installed`。设置页显示程序与配置证据，实际鉴权和模型能力由原生 SDK 的后续操作确定。
  - `codex-gui`：probe 与 SDK 启动共用 `codexSdk.ts` 的 `resolveCodexExecutable()`。先找 PATH 中的原生 CLI，再找 `~/.local/bin`、Windows 官方安装器 `%LOCALAPPDATA%/Programs/OpenAI/Codex/bin` 与 `%LOCALAPPDATA%/OpenAI/Codex/bin`（`codex.exe` 与无扩展名变体），并支持用户 npm 前缀下旧 vendor 和新版平台包的原生文件；再兜底 `where`/`which`。Windows 不把 `.cmd`/shell shim 交给 SDK——where 命中 shim 时取同目录 `codex.exe`，否则跳过。开发版与打包版都必须明确找到本机原生 CLI；找到后向隔离 SDK worker 传 executable override，找不到返回 `not_installed`（`npm install -g @openai/codex`），不再回落 SDK 自带平台包；
  - `acp`：按默认 ACP agent（可被 piModeId 指定）`resolveAcpLaunch`。PATH 查找复用 `findOnPath`（PATHEXT），支持引号目录与独立绝对路径；内置 OpenCode 在 PATH 缺失时还查与终端 runtime 一致的 npm/官方安装目录，DeepSeek 另查桌面包随附的 dsh。仍未命中才返回 `not_installed`。
  - `pi-external`、`omp`、`muse-gui`、`zcode-gui`：检查用户配置或本机程序。前两者的手动路径存于 `externalPi`，后两者存于 `externalHarness`；非空路径必须为绝对路径且不回退自动发现。ZCode 也可指向符合包元数据的桌面内置 `zcode.cjs`，自动发现时检查同包 Electron 和 provider 资源；其他条目须为可执行文件。Windows 的 cmd/bat 路径含 `%` 时禁止启动；外部 Pi/OMP 对手动或自动发现的程序路径，以及会传给 cmd 的临时桥接路径，预检和启动共用校验并给出修复提示；Muse 的自动发现路径也复用启动校验，Muse/ZCode 的手动路径预检拒绝该情况。路径与模型目录、连接和已有会话的连接代次绑定。MiMo Code 作为 ACP 预设检测原生 `mimo acp` 程序，先查 PATH/常用 npm 目录，再查三平台官方 `~/.mimocode/bin` 安装目录；不读取原来的 Claude 套餐密钥。通过预检仅说明程序或配置被发现，不证明登录、余额或协议兼容。内置 `pi` 还要求受管 worker 构建产物存在。

手动「刷新模型目录」与上述静态预检是两条流程：ACP、外部 Pi/OMP、Muse 和 ZCode 会启动目标进程进行有界协议握手及目录读取，但不发送推理提示。当前启动不自动发现模型目录，普通读取复用持久化快照；设置页总「刷新」会遍历当前工作区所有源目录与可用外部引擎。ACP 发现会创建空原生会话，进程回收不会删除该会话记录；DeepSeek 目录刷新使用一次性存储覆盖，并在 ACP 请求前确认实际存储根已隔离，保留原模型与登录配置，进程回收后清理临时会话。详见 [ACP 已知边界](acp-gui-driver.md#已知边界)。外部 Pi 的目录进程不自动加载扩展；GUI 会话及分叉辅助进程另设置 `PI_OFFLINE=1`，请求支持该变量的版本停止启动期自动模型刷新。安装版的实际支持仍待验证。IPC 的 20 秒发现截止为进程回收留出传输时间；回收失败使用 `cleanupFailed` 单独标识，不当作普通取消。表单或会话已切换时，仍通过桌面通知提示已脱敏的回收错误；调用端窗口已断开时由主进程发通知。普通取消不触发错误通知，系统通知不可用时由现有通知服务记录错误。相关 IPC 捕获并重验工作区目标；普通读取只复用已有快照。外部 Pi/OMP 的模型身份由 provider/model 二元组编码，旧拼接值只有在已读取的完整目录中唯一匹配时才继续使用；连接时设置所选二元组并检查引擎确认，不重新获取模型目录。

设置目录还对五个已有终端入口对应的命令单独检查 PATH/PATHEXT，即使该入口关闭也可显示已发现、未发现或未知。此检查不执行 CLI，不验证启动脚本、认证和模型，也不代表其他安装位置一定不存在。预检问题和修复指引在主进程脱敏，带凭据或参数的链接不作为可点击目标交给界面。

## 可选 Worker 目录

`runtimes:availability` / `window.api.runtimes.availability(force?)` 的可选列表只包含检测时已注册、已启用且本地状态为 `available` 的 Worker 和 ACP 预设；逐 runtime / ACP 预设的展示状态另外包含已停用的内置 GUI 引擎的静态探测结果。返回值不带配置凭据。设置目录与新建会话使用同一快照；启动初始化一次，之后只有用户手动刷新才重新扫描。标签与当前启用状态仍与注册表交集，新增或重新启用的入口需要手动刷新后进入可选列表。ACP 逐预设检查；单个挂起/抛错的探测不把其它 Worker 一并卡住，5 秒截止仅限制等待，不承诺终止已加载的可信脚本代码。

内置 Core 的目录可选性与默认模型的单项预检分开：默认模型配置不通过时，对本地已启用服务商的显式模型逐项复用 Core driver 预检；至少一个通过才允许在目录中选择 Core，设置页提示默认模型不可用。创建会话仍按用户选择的模型、模式或全局默认做单项预检；显式指定的服务商或模型已删除时明确报错，不静默换成另一项。未覆盖的默认配置保留既有解析回退；模式只指定一侧时，未指定的一侧仍遵循原有回退。预检只检查本地配置和内置进程文件，不验证远端鉴权或推理；模型被用户在可选模型设置中隐藏时，须先调整该设置。

同一次并发读取共享检测，快照无时间过期；配置或注册表变化、窗口聚焦和可见性变化不触发重新扫描。检测期间配置改变时拒绝旧结果并提示手动重试，不在后台自动重扫。渲染层的变更通知只重读已完成快照；手动刷新成功向窗口广播更新。首次检测失败后也必须手动重试。快照是上次检查结果，不保证程序、登录或配置之后没有变化；设置中的刷新按钮可查看上次检测时间。

桌面新建任务（含看板）、手机创建和定时任务新建/执行使用上次快照核对所选 Worker 与 ACP 预设，不全量重扫；实际创建时仍对目标 runtime 做单项启动预检。已有任务配置显示原值及不可用状态，编辑其它内容时保留原运行类型，不自动迁移；开启或执行必须明确选可用类型。设置 Worker 上方保留完整目录与安装/配置指引，下方配置导航不列已确认未安装的入口。

能力管理使用同一后端快照，再交集已实现的 Skills/MCP 适配器。它保留不可用旧绑定、独立发现已有原生文件，具体语义见 [能力管理](capability-management.md)。

## 创建闸门与逃生门

`createTerminal` 在 runtime 启用检查之后执行预检；`ok=false` 时抛 `RuntimePreflightError`——报错逐条列问题 + 修复命令/指引，并提示 `force:true` 可跳过预检强创（用户/调度逃生门，别焊死）。注意：**结论为 `unknown` 也按不可用拒绝创建**——脚本加载/`resolveLaunch` 失败、driver probe 异常、GUI 宿主未绑定等都会带原因落到 `unknown`，报错同样附原因与 force 提示（偏严但可接受：探测不出结果的 runtime 与确认坏掉的 runtime 对调用方而言没有区别）；仅预检流程自身意外抛错（极端情况）才放行创建并 console.warn，预检不应把能跑的创建卡死。

覆盖入口：capability `sessions.create`（新增 `force` 参数）、IPC `sessions:create`（同）、`sessions_create`（delegateTask → createTerminal，无 force——派活默认受预检保护）。

## 空转回合守卫（宿主 bug 修复）

`AgentSessionHost` 的回合收口（`host/turn.ts` `finishTurn`）时：assistant 无 error、未 abort 且无任何产出（`guiTurnHasProgress` 为 false——无工具卡、无非空正文/思考）→ 在消息上标错误「引擎未产生任何输出即结束回合（runtime 可能未安装/未登录，或连接立即断开）…」。修复前：引擎进程秒退/断连时事件流静默结束，兜底 finish 留一条空 assistant（用户看到空回复 + gui-turn-end，不知差什么）。有产出的回合与用户主动停止不受影响。

## 测试

- `test/runtime-preflight.mjs`：findOnPath（win PATHEXT/posix/未命中）、extractCliToken（cmd 包装/引号路径）、classifyPtyPreflight 六态、describePreflightFailure（含安装命令与 force 提示）、preflightBadgeOf、cliInstallHint。
- `test/runtime-availability.mjs` 和 `test/unit/runtime-availability.spec.tsx` 仍含旧的短缓存、自动失效和轮询预期，与手动刷新规则不一致；本次依用户要求未修改或运行行为测试，后续自动回归需先按新规则更新。
- `test/e2e/worker-availability.spec.ts`：真实 RuntimeHost + 本机 Node 可执行检测，未安装类型隐藏、真实空会话创建、动态禁用/改名、无可用类型禁止提交与 CLI 来源保留；夹具独立 userData/home，不接触真实账号。
- `test/pi-driver-replay.mjs` / `test/pi-provider-errors.mjs`：未配/禁用/磁盘重载、创建预检的会话/模式模型透传；真实 Pi SDK 对本地服务商的默认响应、401/402 原始错误与下一轮恢复。
- `test/acp-executable-discovery.mjs`：GUI 旧 PATH 下 npm 两种安装前缀、绝对路径、目录排除、用户覆盖隔离与带空格 `.cmd` 真执行。
- `test/codex-executable-discovery.mjs`：官方安装目录（含无扩展名变体）、版本化 PATH、用户 npm 原生文件、`.cmd` 拒绝/解析同目录 exe、where/which 兜底；Windows/macOS/Linux 的开发版与打包版均验证找到 CLI 时携带路径、缺失时明确失败。
- `test/builtin-cli-resolution.mjs`：三平台开发版排除工作台自身 `.bin`、保留用户 CLI 顺序、仅有依赖副本时拒启，Cursor 更新文本不可成为 chatId，以及 Codex 远程 resume/fork 不携带权限覆盖参数；不调用在线服务。
- `test/delegation-fault-regression.mjs`：同上发现合同的回归子集，外加 GUI 投递拒绝必须返回错误与保留会话身份，不落任务行或返回 started。Electron 创建用例另保存本机真实预检结果。
- `test/unit/worker-pane-preflight.spec.tsx`：缓存读取、手动刷新、聊天与终端分别判断安装入口、安装后隐藏及配置问题保留；其他布局用例见 `test/unit/worker-pane-layout.spec.tsx`。
- `test/gui-host-lifecycle.mjs`「空转回合守卫」：空输出收口必须标错误（把守卫还原该用例即红）；对照组有产出不标错误。

## 已知边界

- 预检只做静态探测（文件/PATH/配置），不真实 spawn CLI 或发鉴权请求——「CLI 在但 key 失效」这类运行期故障仍会在首回合暴露（届时由空转守卫/错误横幅呈现）。
- `probe` 未实现的 driver 按未知处理；用户仍需单独确认安装、登录和实际运行。
- 外部安装、卸载或配置变更后，检测状态可能过期，需用户手动刷新；实际启动仍作单项检查。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D03.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：拉起 Worker 前（sessions.create／派活／新建表单／定时任务）静态探测 runtime 可用性，报错写清「差什么、怎么装/配」；设置页徽标+手动检测。源于 2026-09-25 全量自检的实发现：创建成功但终端空屏、回合静默结束。
- 为什么这样设计：只静态探测（文件/PATH/配置，不 spawn 引擎不联网）保快与零副作用；unknown 也按不可用拒绝（探测不出结果≈确认坏掉，报错附原因）；force:true 逃生门不焊死；派活通道 sessions_create 无 force（默认受保护）；配套空转回合守卫兜住静态探测不到的运行期故障（key 失效等）。
- 明确不做：不承诺预检通过=回合执行成功（CLI 慢启动返回 starting，不重复创建）；不联网验证凭证余额。
- 歧义点：unknown 态拒绝创建（偏严）长期保持，还是改「unknown 放行+警告」？A=保持拒绝（review 把放行当缺陷）／B=放行（可用性优先）。推荐 A——有 force 逃生门，偏严的代价可控。

ACP 产品的聊天开关独立保存于 `AppConfig.disabledAcpAgents`。静态安装检测通过 `inspectDisabledChat` 保留停用项的证据，可新建快照在每次读取（包括缓存）时按当前偏好过滤。带预设身份的创建预检与 driver 连接拒绝停用项；独立终端不受该字段影响。对应回归见 `test/acp-agent-settings.mjs`。
