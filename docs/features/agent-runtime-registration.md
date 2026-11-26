# Runtime 声明注册与 Harness 接入

## 职责

Runtime Manifest 用一份 JSON 声明原生终端、ACP 聊天或两者。桌面用户可在「设置 → Harness 接入 → 默认与通用」提交 JSON。调度 AI 可调用 `host.runtimes.run({ action: "register", params: { manifest } })` 提交同一格式。确认框展示主进程解析后的绝对程序路径、启动参数及集成配置。有终端入口时标题标注「终端仅启动」。用户确认后立即可选，重启后继续可用。

内置目录也可随应用分发 Manifest。CodeBuddy Code 的产品、CLI `codebuddy`、聊天 `codebuddy --acp`、终端启动选项和 MCP / Skills 路径全部写在 `src/main/runtime/builtins/registry.json`。现有脚本和特殊协议仍使用各自的内置适配器。CodeBuddy 的程序和登录由本机 CLI 提供，工作台按已有安装发现流程查找程序。

ACP 引擎可用 `chat.mcpPermissionMetadata` 在标准程序标识 `toolCall.name` 缺失时声明 MCP 工具标识对应的 `_meta` 键。引擎给出原生审批选项，宿主仍校验实际宿主工具调用。见 [ACP 审批](acp-gui-driver.md#codebuddy-code-的-mcp-审批)。

## 关键文件与入口

| 文件 | 职责 |
| --- | --- |
| `src/shared/harnessCatalog.ts` | 产品身份、聊天与终端入口、内置 ACP 命令 |
| `src/shared/runtimeManifest.ts` | Manifest 字段、参数、集成声明校验 |
| `src/main/runtime/builtins/registry.json`、`scripts/*.mjs` | 内置 Runtime 种子与 CLI 启动脚本 |
| `src/main/runtime/host.ts`、`manifestLaunch.ts`、`manifestCatalog.ts` | 声明确认与持久化、种子升级、通用终端启动、发布已加载的 Manifest |
| `src/main/agentSession/guiWorkerAdapter.ts`、`registerDrivers.ts` | 通过 GUI Worker 适配器 registry 校验并安装内置 GUI Driver |
| `src/main/agentSession/drivers/acp/agents.ts` | 从内置目录和已加载的 Manifest 生成 ACP 预设及启动命令 |
| `src/main/runtime/preflight.ts`、`availability.ts` | 可用性预检和可选 Worker 快照 |
| `src/main/ipc/workspaces.ts`、`src/main/capabilities/hosts/runtimes.ts` | 桌面与调度调用共享的注册确认入口 |
| `src/renderer/src/components/settings/WorkerPane.tsx`、`workerCatalog.ts` | 产品目录、注册表单、入口开关、终端参数与恢复操作 |
| `resources/skills/runtimes/SKILL.md` | 调度工具动作、Manifest 示例与 MCP / Skills 字段 |

## 数据流

启动时 `RuntimeHost.ensureSeeded()` 将内置种子和脚本复制到 userData 并升级现有条目。`reload()` 装载种子和具有匹配确认指纹的 Manifest。工作台使用 `RuntimeHost.list()` 和可用性预检共同生成产品与新建会话选项。每个 Manifest 的聊天入口使用 `runtimeId=acp` 和 `piModeId=<manifest.id>`。原生终端使用 `<manifest.id>`。有两个入口的产品可以分别启用终端和聊天。MCP 文件与 Skills 路径进入现有 Harness 集成流程。

`runtimes.run` 支持 `list`、`get`、`register`、`update`、`remove`、`restoreBuiltins` 和 `preflight`。`update` 可以修改显示名与启用状态。带启动脚本的内置入口可另外修改启动参数和脚本。自定义 Manifest 的命令与参数由确认后的声明固定。删除内置入口后，应用下次启动会从种子补回。设置页仍可配置外部 Pi、OMP、Muse 和 ZCode 的可执行文件路径。

模型面的 `list` 对可通过 `get(id)` 完整读取的 Manifest / chat 条目返回目录摘要：保留标识、名称、启用/内置状态、更新时间、`surface` 和终端续接声明；`declaredSurfaces` 列出 Manifest 声明的入口，并不表示实际可用。旧脚本型 PTY 的 `get` 带任意长度脚本，可能超过结果预算，故 `list` 保留其完整元数据；如果 Manifest / chat 的完整详情本身过大，也保留原始条目。脚本、启动参数、Manifest 与集成配置可用 `get(id)` 查看；`preflight` 才检查可用性。列表和详情是两次独立读取，期间配置可能变化；完整列表或详情仍可能超过结果预算。宿主内部和设置页继续使用完整条目。

内置 `runtimeId=pi` 在产品目录和新种子中显示为 Muster Core。当前 Muster 注册表中的精确默认名 `Pi`、`MetaAgent Core` 在种子升级时规范为 Muster Core 并持久化；其它用户自定义显示名保留，重启不覆盖。该规范化只作用于当前产品注册表，不读取旧产品存储，也不改变会话的 runtime ID。

桌面新建任务的 CLI 与 GUI 使用相同的 Harness/模型选择布局和目录快照。按 `HARNESS_CATALOG` 将 CLI 映射到对应 GUI 引擎及 ACP 预设；读取和刷新共用原有缓存、来源校验及可选模型筛选。外部 Pi/OMP 的不透明目录身份在可无歧义表示时转换为 `provider/model`。CLI 与 GUI 可能使用不同账户、可执行文件或配置，因此目录中的候选仍以 CLI 实际权限和启动结果为准。无目录时可手动输入 CLI 模型 ID；未确认启动参数的引擎需在终端切换。关闭 GUI 入口不妨碍已启用的对应 CLI 读取目录，IPC 校验二者的目录身份和 CLI 启用状态。Codex 和 Claude Code 使用可确认的逐模型档位约束界面与主进程启动校验；切换模型后仅保留新模型支持的档位。CLI 启动权限与模式按 `src/shared/cliLaunchOptions.ts` 声明的原生值和参数。Codex 沙箱、Muse 审核人等独立维度分别选择。逐引擎证据与版本边界见 CLI 任务设置调研。

空白创建 `sessions:create` 与带任务 `tasks:delegate` 携带结构化 `cliLaunchOptions`，主进程在创建副作用之前按 runtime 校验字段、模型 ID 与枚举；入队复制选项，会话持久化，重拉、提示注入重拉、续作及受支持的 fork 沿用它们。启动前与全局 `extraArgs` 合并，显式会话选择替换对应冲突参数，未覆盖部分照常使用配置；不使用 shell 拼接自由文本。内置 Codex 的程序发现和 GUI 共用同一适配器。终端预检、能力探测、app-server 与 TUI 使用同一个解析出的 CLI 路径。Codex 原生远程 TUI 恢复/分叉沿用原线程权限，适配器移除相应覆盖参数，UI 提示这一边界。此设置是启动覆盖，终端内后续修改以 CLI 行为为准；旧版 CLI 对新旗标可能报错，不能以预检通过保证参数或登录有效。DeepSeek 的 `dsh` 未随附 TUI profile，目录只提供 ACP 聊天入口；ZCode 当前源码不接受 `--model`，不得伪装为支持该参数。

新建任务窗口按当前界面语言展示可识别的 CLI 启动校验错误；桌面会话创建和派活 IPC 对已知宿主错误单独翻译，保留同步/异步失败语义。参数值、未知错误及供代理消费的原始校验消息保持原样。回归见 `test/unit/new-task-cli-options.spec.tsx` 和 `test/unit/node-main/send-i18n.spec.ts`。

Kimi Code 的 `--model` 使用与 ACP 相同的模型别名；CLI 选择器使用所选模型在 ACP 中声明的思考选项。该版本没有强度启动旗标：指定强度时，`_kimi-acp.mjs` 在任务实际 cwd、CLI 的环境及同一可执行文件中先创建空 ACP 会话，依次设置模型、思考强度和计划模式并检查原生确认，关闭 ACP 后让 TUI 以 `--session` 接续；没有指定强度时仍走普通 CLI 启动。Kimi 的准备和接续分别触发原生会话生命周期，因此已配置的 MCP 和 SessionStart/SessionEnd 钩子会额外启动一次，UI 在选择强度后提示；隔离 Windows 真机使用本地模拟 MCP 和钩子验证过此行为。额外目录传给 ACP 会话与终端启动；与指定强度不兼容的既有会话或 agent 启动参数明确拒绝。探测或确认失败不启动伪成功终端，也不修改用户全局配置。选到参数尚未读取的模型时须刷新目录。其他 CLI 的思考值仍按各自已接入的启动参数设置，不假定 ACP 选项必然等同于终端参数。

## 边界与验证

注册只接受 JSON 和已安装的程序。Windows 的 `.cmd` / `.bat` 使用统一的命令适配层并拒绝会被解释器展开的参数。macOS 和 Linux 直接传递 argv。Manifest 终端按批准的命令与参数启动，选中已有会话时保留其休眠状态；用户可在菜单中显式选择「开启新对话」。已有会话的恢复由种子中声明 `terminalResume: "by-id"` 的专用适配器检查。ACP 聊天能力由引擎握手提供，加载能力缺席或请求失败时保留历史并报告错误。注册指纹覆盖规范化后的声明和解析出的路径。同一路径上的软件升级仍由本机安装器管理。移除 Manifest 后保留旧会话的 runtime ID，重新注册可恢复对应入口。旧的动态脚本与 Driver 注册条目在启动迁移时过滤。

`test/runtime-manifest.mjs` 覆盖确认、持久化、启动参数、ACP 预设和三平台命令构造。`test/unit/worker-product-settings.spec.tsx` 覆盖表单提交和双入口显示。`test/e2e/agent-settings.spec.ts` 覆盖真实 Electron 中的取消和确认。`test/runtime-registration-model-surface.mjs` 覆盖调度工具目录和技能说明，`test/runtime-host.mjs` 覆盖种子升级、脚本恢复与损坏注册表回退。见 [Runtime 可用性预检](runtime-preflight.md) 和 [GUI Worker 会话](gui-worker-session.md)。

CLI 逐任务配置回归：`test/cli-launch-options.mjs` 覆盖能力映射、输入校验、全局参数冲突与三平台命令构造；`test/cli-kimi-acp.mjs` 覆盖模型/思考/计划的 ACP 确认、会话交接及拒绝路径；`test/cli-workspace-context.mjs` 覆盖真实启动脚本/模拟 PTY 的首次拉起和重拉；`test/unit/new-task-cli-options.spec.tsx` 覆盖表单提交与 GUI→CLI 目录切换；`test/e2e/cli-task-options.spec.ts` 以隔离目录、模拟厂商 CLI 验证真实 Electron IPC 和 PTY。模拟不证明各平台厂商服务或真实推理。

## 模型写入回执

`runtimes.register/update/restoreBuiltins` 的模型回执保留实际条目的 id、label、enabled、builtin、surface、声明入口和审核信息，省略脚本、启动参数、集成配置和完整 Manifest。程序调用者继续收到完整条目。回归见 `test/resource-tool-result.mjs`。
