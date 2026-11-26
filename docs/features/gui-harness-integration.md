# GUI Harness 目录与接入

## 职责与当前状态

设置中的 Agent 目录和选择器共用 [harnessCatalog.ts](../../src/shared/harnessCatalog.ts) 与 [Runtime Manifest](agent-runtime-registration.md) 注册表。设置保留安装管理。选择器隐藏没有安装证据的 Harness，对已安装但无法使用的入口展示预检原因。登录、所选模型和工具能力由原生引擎确认。

本功能正在按 GUI Harness 重构方案 实施。本文描述源码中的接线，不代表界面、引擎、平台或迁移已通过真实操作验收。内置 Driver 仍包含各自的协议和部分生命周期实现，尚不能把该方案的所有底层统一目标视为完成。

## 产品身份与运行时

| 入口 | GUI 身份和代码 | 关键边界 |
|---|---|---|
| Muster Core | 保留旧 `runtimeId=pi`，`drivers/pi/driver.ts` + `workerHost.ts` / `worker.ts` / `workerEngine.ts` | 工作台自己的 Pi SDK 深度定制和旧会话身份；Node/Electron-as-Node 受管进程；设置页致谢 Pi，安装资源包含其 MIT 许可证。GUI 活跃回合支持 Pi SDK 原生 steer；普通后续消息仍由宿主排队 |
| Pi、Oh My Pi | `pi-external` / `omp`，`drivers/externalPi/` | 用户安装的 RPC 程序、凭据、模型及配置，与内置 Pi 分开；支持手动绝对路径或自动发现；临时扩展桥接宿主工具。外部 Pi 的 GUI 会话和模型目录发现暂不自动加载扩展，保留显式宿主桥接；部分 Pi 版本的内置 MCP 等扩展也受影响。GUI 活跃回合消息使用宿主队列 |
| Claude Code | `claude`，Claude Agent SDK | 使用本机 Claude 登录和配置，不消费工作台全局模型；模型及思考强度依 SDK 实际目录选择，切换后经原生会话恢复；宿主工具走进程内 MCP，原生权限只覆盖 SDK 实际回调，真实运行待用户验收 |
| MiMo Code | `acp` + `mimo-code` 预设，原生 `mimo acp` | MiMo Desktop 的核心引擎，直接使用 MiMo Code 自己的配置和登录，不经 Claude Code。先运行 `mimo` 完成配置；不保证桌面账号与独立 CLI 自动共用 |
| Codex | `codex-gui`，受管 worker 与原生 app-server | 启动、原生设置和分叉使用 app-server 的 RPC，校验会话和权限回执。聊天和原生终端共用 [本机 Codex CLI 发现](gui-worker-session.md#打包)，可以从受支持的桌面安装找到随附 CLI。 |
| Cursor | `acp`，预设 `cursor`，启动 `cursor-agent acp` | 使用 Cursor CLI 登录与原生配置；协商模型和 agent/plan/ask 模式，权限和恢复取决于 CLI 实际实现 |
| Antigravity | `acp`，预设 `antigravity`，优先启动官方 `agy acp` | 使用 Antigravity CLI 登录与原生配置。安装后可从 GUI Harness 选择器使用。查找顺序、旧服务兼容和登录方法见 [ACP driver](acp-gui-driver.md#antigravity) |
| CodeBuddy Code | `acp` + `codebuddy-cli`，由 Manifest 声明 `codebuddy --acp` | 与原生终端共用产品。Windows 本机 2.182.0 通过 ACP v1 握手和空会话，返回 17 个模型。Windows 非沙盒已验真实读取、写入审批及关闭配置后继续；其他平台真机待验 |
| ACP 家族 | `acp` + 预设 ID；OpenCode、Kimi、Grok Build、DeepSeek、Command Code、Cline、Kilo、GitHub Copilot CLI、Devin、Hermes、MiMo Code，另含 Gemini | ACP 模型与预设分别保存；实际声明与用户授权见 [ACP driver](acp-gui-driver.md) |
| Muse Code | `muse-gui`，`drivers/muse/` | `muse serve` 的 MSP；每回合独立进程及 Streamable HTTP MCP 网关；支持原生提问；单次文本与图片帧上限 7 MiB；原生插话暂不支持，使用队列 |
| ZCode | `zcode-gui`，`drivers/zcode/` | `zcode app-server` 的 `session/*` 兼容协议；支持自身模型、会话、按回合确认归属后的流式输出、宿主 MCP 工具和普通原生问卷。扩展域投影、计划审批和 MCP elicitation 暂未接入；原生 MCP 列表不会自动继承，实际运行待验收 |

不支持安全恢复的适配器应保留工作台可见历史并报错，不把新空上下文伪装成原会话。用户可以基于历史另开会话，原生文件、工具状态和私有推理不会因此自动迁移。外部引擎的可用模型不等于工作台全局模型。

DeepSeek 的内置 ACP 预设除 PATH 外可找到桌面版内置 `dsh`；ZCode 除独立 CLI 外可发现桌面包的 `resources/glm/zcode.cjs`。后者须同时具有匹配的 `electron-node` 包元数据、同包 Electron 可执行文件及内置服务商目录；使用同包 Electron 和 `ELECTRON_RUN_AS_NODE` 启动，向子进程传入内置和个人服务商配置路径。Windows、macOS 和 Linux 按各自常见安装目录解析，自定义位置可在设置中指定脚本或可执行文件；任意解包位置和 AppImage 不保证自动发现。预检只判断文件及元数据，不能证明桌面账号、模型或协议可用；账户由 ZCode 自身管理，桌面专属的认证交互尚未由工作台接入。发现后的模型刷新仍需实际启动进程，运行结果需用户验收。

MiMo Code 的 `mimo-code` 预设使用独立 ACP 身份。先查 PATH 与常用 npm 目录，再查官方安装器的 `~/.mimocode/bin/mimo`。Windows shim 沿用统一包装，macOS/Linux 检查可执行权限。仅安装 Desktop 且找不到命令时，安装 CLI 或手动指定启动程序。MiMo 模型、权限配置和恢复由原生 ACP 协商；本机 0.1.16 无推理握手返回原生 `build`、`plan`。

官方源码快照、文档漂移与 Desktop 关系见 MiMo 原生接入研究。Windows 本机 `mimo 0.1.14` 的版本、`acp --help` 与真实无推理模型发现通过（78 个目录项，已完成进程回收）；没有发送任务提示词。实际推理、审批、宿主工具调用、恢复、桌面登录继承、macOS/Linux 真机和视觉验收未完成，不能据此声称完整端到端可用。

### 引擎依赖与安装来源

- Muster Core 使用仓库安装的 Pi SDK。该依赖也注册了 `node_modules/.bin/pi`。外部 Pi GUI 的自动发现顺序按 PATH，在 npm 把仓库的 bin 目录放到系统安装前面时会选中内置版本。已用隔离 PATH 复现，显式指定外部 Pi 路径可选中用户版本。内置原生终端启动器会排除工作台自己的 bin 目录。
- Claude GUI 调用 `@anthropic-ai/claude-agent-sdk` 开会话、读取模型目录、处理审批回调和注册进程内 MCP。预检、目录和聊天优先使用 PATH 上的本机 Claude，再查常见安装目录。开发版仅在本机未发现 CLI 时使用 npm 安装的 SDK 平台包。正式安装包保留 JS SDK，平台 CLI 由打包规则排除。原生终端依照自己的 PATH 找 Claude。见 [Claude CLI 发现](gui-worker-session.md#打包与-dev-差异)。
- Codex、Cursor、OpenCode、Gemini、Kimi、DeepSeek、Hermes、Qwen、Oh My Pi、Muse、ZCode 与其余 ACP 预设，通过各自本机程序或桌面应用随附的可执行文件接入。对照运行时目录的命令名与 npm 锁文件，Pi 是其中唯一注册 npm 启动器的引擎命令。MCP 和模型服务 API 客户端为共享协议及服务依赖。

## 设置与创建

自动派活和 Composer 的 `/harness` 命令共用 Harness 目录、逐模型参数及手动刷新路径。ACP 子代理同源同 preset 继承模型及参数，切换 ACP 产品时从该产品的模型目录解析。候选池执行中交接与原生失败证据见 [Worker 自动派活](worker-routing.md)。

- `/harness`、新建任务及当前会话使用 `HarnessModelPicker.tsx` 和 `ModelPickerLayout.tsx`。新建任务在底栏 Harness 按钮上方展开聊天模型选择浮层，右边缘与按钮对齐。原表单保留位置、正文和附件。浮层顶部选 GUI／CLI，再选 Harness、模型与参数。确认时写回草稿并校验启动选项；Esc 或取消保留原选择，焦点回到目标按钮。输入框底栏按能力显示启动模式：Core 有可用预设时可选，CLI 使用当前引擎声明的工作模式，沙箱及审批配置由权限开关管理。扩展创作的 CLI 页签显示为禁用。`/harness` 确认后插入精确配置胶囊。当前会话菜单固定 Harness，确认时一起保存模型与参数。上下移动当前列，左右切换列，最后一列 Enter 确认，`/` 聚焦搜索。窄容器按列切换。
- 三处目录都以注册源目录和适配器的原生身份读取主进程持久快照。隔离会话仍在自己的工作树执行。只有显式刷新才启动对应的原生目录发现。刷新事件带原始源和适配器身份，缓存读取继续区分尚未读取的目录与逐模型未知参数。创建时仍对目标运行时执行原有预检。详见 [通用模型参数](model-parameters.md)。
- Core 默认模型配置不可用、但其他显式模型通过本地预检时，Core 仍可在目录中选择；用户应选择通过配置的模型，或先修正默认模型。创建和重连时会核对会话或自定义模式中显式指定的服务商与模型，已删除则报错；模式只指定一侧时保留未指定项的原有回退，完全跟随默认也保留原有解析行为。本地预检不保证远端鉴权与推理可用，模型被设置隐藏时需先取消隐藏。
- 「配置权限」默认关闭，Core 使用完全访问，外部 Harness 优先选择原生免审批能力，仍收到的有效权限请求由宿主自动允许。开启后显示 Core 权限或外部 Harness 原生目录；Core persona 独立展示，运行时设置显示引擎实际生效值。
- 权限与协作设置由下文所列各自协议提供。未公开选择入口的引擎在菜单中显示对应状态；发现和目录读取不触发模型推理。
- 设置中的 `worker` 页签现在显示为「Agent」，采用一份产品列表和保活详情。左侧「我的 Agent」展示内置、已发现和用户配置的入口，「全部支持」保留未安装项及安装指引；同一产品的聊天和终端不再拆成两条记录。搜索与切换目录范围不会替换当前详情。窄容器改为列表/详情就地切换，返回与 Escape 恢复列表焦点和滚动位置。
- 外部引擎详情按「通用 / 工作台聊天 / 原生终端」作用域组织；通用页独立启用入口并说明账号关系，聊天页管理模型和参数，终端页管理原生启动配置。Core 使用单页。聊天和原生终端仅展示目录中内置的能力，各自开关即时保存。Agent 页保留「默认与通用」入口；全局命令行环境位于设置「通用」页。Cursor 使用 CLI 登录或环境变量，不再提供 SDK Key、模型或沙箱设置。
- ACP 产品使用 `AppConfig.disabledAcpAgents` 独立控制聊天入口，不修改其他产品或独立 CLI。偏好由配置层规范化并持久化，属于设置页的即时生效字段，普通表单保存不能回写旧值。可用性快照在返回缓存时按当前偏好过滤，安装探测结果仍保留用于设置；创建预检和 driver 连接均拒绝被停用的产品。重新启用旧版整体停用的 ACP runtime 时先保持其他预设停用，再启用目标，避免意外批量开放。开关管理新建/重连入口，不承诺终止已经进行中的原生回合。
- 各 ACP 产品拥有自己的保活编辑器与模型目录身份，切换不丢启动配置草稿。模型筛选直接展示搜索、复选框与批量操作；打开详情只读缓存，显式刷新才执行发现。任务视图使用 `usePresence` 和 `xfade`，各作用域首次访问后保活编辑器；隐藏时 inert，避免隐藏控件继续接收焦点。配置来源先选后读，只读配置不展示鉴权推断；程序与配置目录复用带文件管理器入口的路径字段，打开失败就地反馈。详情行组遵循设置页 flat 模板，去掉灰底卡片；模板规则见 [设置页](settings.md#可推广的设置页模板)。
- 各 GUI Harness 详情包含「可选模型」：目录读取使用当前工作区选定源目录的缓存，用户可搜索、勾选、全部取消或恢复全部；此面板只有刷新按钮会重新启动目录发现；此面板刷新 Cursor 目录不会顺带写入默认模型。默认展示全部模型；首次取消勾选会固定当前目录的其余选择，之后新增模型需手动勾选；已有选择但当前目录未返回的模型保留在设置里供移除，不在模型菜单中虚构目录项。OpenCode、Kimi 等 ACP 预设分别保存；Core 使用服务商与模型的组合身份，外部 Pi/OMP 和 ZCode 沿用引擎目录的不透明模型身份。MiMo Code 通过 ACP 读取模型目录；未暴露目录的自定义 GUI 驱动不能凭空列举模型。设置持久化在 `userData/harness-model-selections.json`，由 `HarnessModelSelectionStore` 进程内缓存、原子写入并广播 `agentSession:harnessModelSelectionsChanged`；损坏或保存失败会提示，不覆盖源文件。设置同时是 GUI Harness 主进程准入白名单：新建、会话切模、连接/重连及新回合发送前都校验实际模型；已取消勾选的显式模型（包括旧会话覆盖）拒绝并列出允许项。没有该 Harness 键表示不限制，空数组表示全部禁用，必须先在设置里至少选一个。跟随默认时保留已启用的引擎默认，否则按当前目录顺序选第一个已启用模型并显式传给引擎；无法确认默认身份的引擎也使用目录中首个已启用模型，目录没有匹配项则报错。存在白名单且校验所需目录快照缺失时，明确提示手动刷新。Core 以服务商和模型的组合身份校验，ACP 按预设隔离；回退模型的参数快照也按实际模型重新读取。设置变化不打断进行中的回合及该回合插话，下次回合发送前重新校验；已有会话历史保留。此策略不修改 Harness 自身配置，不保证账号鉴权、模型可用性或外部独立 CLI 的行为。
- 新建任务的对应 CLI 复用相同的目录和可选模型筛选，GUI/CLI 切换会重读内存快照；CLI 与 GUI 的账户、可执行文件和环境仍可能不同，候选可用性以 CLI 为准。Kimi CLI 的思考强度使用对应 ACP 模型描述及原生会话接续，启动和兼容性边界见 [Runtime 注册](agent-runtime-registration.md)。
- Harness 接入右上角「刷新」通过 `agentSession:refreshHarnessModelCatalogs` 重新检测本机引擎，再刷新当前工作区各注册源目录下已启用、可用且提供模型目录的外部 Harness。进度由 `agentSession:harnessCatalogRefreshProgress` 按引擎与源目录回传，包含完成、部分完成和失败原因。弹窗单源时只显示工作区名称，多源时每项加源目录名称。ACP 在空会话中逐模型读取思考档，未确认的结果单独提示。详情页仍提供单引擎刷新入口。
- 设置与新建共同使用 `runtimes:availability` 的逐 runtime / ACP 预设检测快照；设置显示结果也静态探测已停用的内置 GUI 引擎，以区分停用和未安装，但可启动列表仍只包含已启用且预检通过的入口。完整目录保留不可用项、官方安装链接和配置入口，也可手动刷新。若启动扫描尚未完成，手动刷新等其结束后再执行新一轮检测，并发手动请求合并；配置在扫描期间变化则报告失败，不返回旧结果冒充新检测。检测到程序或配置不代表登录与模型可用。预检修复指引在主进程脱敏；不含身份信息、查询参数和片段的 HTTP(S) 指引可点击，其余按文本显示。
- 外部 Pi 路径通过 `AppConfig.externalPi[pi-external|omp].executable` 保存；Muse/ZCode 路径通过 `AppConfig.externalHarness[muse-gui|zcode-gui].executable` 保存。均可留空自动发现；非空仅使用指定绝对路径，无效时明确报错，不修改引擎自身配置。Oh My Pi 保持 PATH 优先，并在未命中时检查官方 Windows 安装目录、Bun 全局目录及常见 Homebrew 目录；识别到 Bun 全局入口或 `env bun` 脚本时，所需的 Bun 目录只补到该引擎子进程 PATH，不修改工作台或系统环境。预检、模型目录和连接从同一配置读取，路径变化后下一次连接重建，已有会话仍保留自己的身份和历史。
- ZCode 设置和新建会话注明当前使用兼容协议、原生 MCP 不会自动合并且每轮重启引擎。会话参数提供的 MCP 列表取代该会话的用户和项目原生配置列表；第三方 MCP 需在工作台登记并通过工作台中转，不修改用户的 ZCode 原生配置文件。插件自带服务是否加载由 ZCode 自身机制决定。
- ZCode 手动刷新读取 `session/create` 返回的 `settings.model.available`。目录进程断开时，优先展示脱敏后的原生启动错误。若引擎没有输出错误，显示已取得的退出码或断开原因。创建本地通信端点失败时提示检查临时目录及权限。独立 app-server 的服务商注册表取决于它实际加载的账号和服务商配置。ZCode 桌面应用也可以通过自己的 Host 向 CLI 同步服务商注册表，桌面模型列表与独立进程的结果可能不同。工作台将空目录显示为刷新失败并保留上次成功快照，旧空快照也会提示检查 ZCode CLI 的账号和服务商配置。macOS 桌面版 3.18.2 自带 CLI 0.17.1 已验证可完成握手，本机现有配置返回空目录。带诊断和无诊断的退出路径由 `test/acp-model-discovery-owner.mjs` 覆盖。
- ZCode 桌面包以 Node 模式启动 CLI 时，凭据模块可能只存在于同包 `app.asar`。Muster 使用同包 Electron 的模块解析支持，在正常解析失败时加载包内 `@napi-rs/keyring`。Windows 已验证 CLI 能通过该模块使用系统凭据库完成浏览器授权。安装包内 CLI 0.17.1 的 `app-server` 仍由桌面 Host 同步账号服务商，单独执行 CLI 登录后也可能返回空目录。macOS 和 Linux 共用解析逻辑，尚无真机验证。
- GLM Coding Plan / MiMo Token Plan 的 Claude 服务预设、专用密钥设置及 IPC 已移除。Claude Code 使用用户自己的原生配置；ZCode 仍是独立引擎。升级移除旧 `glm` / `mimo` 注册条目，不删除用户历史或旧密钥文件，也不将旧会话改绑 ZCode 或原生 MiMo。旧会话身份保持原样：主进程历史加载和中栏只读身份映射仍按聊天处理，旧消息可以继续查看；这些历史身份不进入设置目录或新建列表，不声明 Claude 执行能力。再次发送任务时因缺少执行 driver 明确报错，用户可保留历史另开会话。
- 外部模型目录与参数仅通过手动刷新发现。主进程将成功结果按 Harness、预设、注册源目录和配置来源保存至 `userData/harness-model-catalogs.json`，配置来源用摘要索引。启动、打开菜单、切换模型和白名单校验只读快照，隔离会话与创建入口共用其记录的源目录。刷新成功后广播 `agentSession:modelCatalogUpdated`，失败保留上次成功结果。ACP 手动刷新可读取所选模型档位；尚未读取与已确认无档位分别表示。会话切模仍以主进程捕获的预设、连接和工作区身份校验。ZCode、外部 Pi/OMP 的模型保留带版本的 provider/model 二元身份，旧外部 Pi 模型标识只有在目录中唯一匹配时可使用。
- 全新安装中，工作台原有的 Claude、Codex、Cursor、OpenCode、Gemini 五种 CLI 会话入口默认关闭；可在设置中分别开启，旧用户 registry 的 `enabled` 不被新种子覆盖，历史记录无法区分用户主动开启与旧默认开启。目录检查这五个命令是否已安装，Codex 同时检查系统安装位置。入口关闭时继续显示程序已发现、未发现或未知；不验证启动脚本、登录或推理。其他新接入的 Harness 尚无预置的工作台 CLI 会话入口，本次没有新增这些终端 runtime。普通 Shell、已存在的终端会话与用户安装的 CLI 程序不因该开关而删除。
- 移动端新建入口目前仍按 runtime 显示一个 ACP 选项，并选择首个可用预设；逐个 ACP provider 选择是桌面入口的能力，移动端尚未对齐。

## 模型列表的显示与身份

模型选择器与设置中的可用模型列表共用 `shared/harnessModelPresentation.ts` 的分组、去重和重名区分规则。模型名称作为主信息；Core 的服务商独立作为分组标题，不再逐行拼进名称。外部 Pi/OMP、ZCode 和 ACP 标准选项组保留协议提供的分组信息；Claude、Codex、Muse 或未提供分组的 ACP 目录显示普通列表。`providerId` 在外部接入中可能只是运行时命名空间，界面不会据此推断服务商，也不会从名称的括号、前缀或不透明模型 ID 中猜测短名。

同一分组内重名的模型在行右侧显示原生选择 ID；当该 ID 本身也重名时，才加身份命名空间。相同名称、不同身份的条目不会合并。分组同名时标题补充分组 ID。长名称和区分信息可以换行；完整名称、来源、选择 ID 和已知原生启动 ID 保留在悬停详情中。设置不再为每个名称不同于 ID 的条目固定增加第二行。搜索仍匹配名称、来源和 ID；分组标题不进入键盘选择序列。

分组只改变展示顺序与布局，保存及切换仍使用原有 provider/model 组合或外部不透明 ID；参数目录、白名单与跟随默认语义不变。已有外部目录快照缺少分组时保留普通列表，手动刷新后可取得新元数据。没有结构化短名的外部条目保留引擎原名，例如 Qwen 的渠道前缀；本次没有添加单独 Harness 的名称清洗规则。

## 原生权限与会话设置

新建会话与会话内的「引擎设置」共用 `NativeSessionConfig.tsx`。权限模式、沙箱、多任务、工作流模式等已知字段标题跟随界面语言；未知标题和下拉选项名称保留引擎原文，不修改原生 ID、选项值或权限语义。不渲染目录附带的说明段落，目录仍保留原始描述；启动时生效、待确认和错误等状态继续按各自状态显示。刷新使用首个字段标题旁的图标按钮，提供悬停说明、键盘焦点与读取状态；目录未就绪或为空时仍保留刷新入口。新建会话中的原生设置共用表单两列等宽布局，与 Harness 选择框对齐；窄窗口同步切为单列，单个设置不会独自撑满宽表单。

新建任务复用聊天输入框的权限按钮、菜单与 `PermissionConfiguration`。Core 在菜单顶部切换「配置权限」，下方显示当前勾选、档位和说明。新建草稿还可选择「跟随默认」。外部 GUI 的原生设置和 CLI 声明的启动权限、沙箱或审核选项都在相同的浮层内配置。关闭开关时，菜单只显示开关。`configurePermissions` 只有显式 `true` 才启用手动配置，历史记录缺省也为关闭。关闭时不读取创建表单和会话面板的原生权限目录；Core 采用 `auto`，外部 GUI 在引擎实际允许的范围内选择已核实的原生免审批/完全访问选项，无法设置时由宿主自动响应有效权限申请。自动策略不根据名称或目录顺序猜测权限大小，不改模型、工作流和多任务设置。普通用户问题仍等待作答。

开启后 Muster Core 的模式、工作区权限和计划流程由 `guiPermissionOptions.ts` 与宿主策略负责；外部 GUI 使用自己的设置目录、选项 ID 和实际生效值，未选择覆盖时沿用原生状态。旧外部会话的 `guiMode` 和 `permissionMode` 仅供兼容读取。自动覆盖前保存可恢复的原生值，恢复记录的事务身份绑定注册表原始行，而不是每次读取产生的会话投影；重新开启时恢复这些值或显式报告引擎限制；手动模式中的「跟随引擎默认」不等于最高权限。

开启配置后，创建表单从 `agentSession:describeNativeConfig` 读取已登记来源的目录，手动刷新才启动引擎发现。显式意图 `nativeConfig = {identity,selections}` 绑定 runtime、ACP preset、源工作区/目录和版本指纹。定时任务、看板与派活保存开关及相同意图，只有开启配置时才将意图用于执行并校验来源与选项。同引擎、同预设、同来源的子代理和分叉继承权限配置开关；手动模式继承最新已确认且可原样传递的设置，状态待确认、缺字段或来源不匹配时明确失败。关闭配置的分支使用自动权限策略。

`sessions:setConfigurePermissions` 持久化开关，渲染层等待成功后更新；失败时保持原状态，并调用全局 `showTip` 短暂提示，不在输入栏常驻错误文字。会话设置的读取、刷新及修改失败也使用该轻提示；目录尚未读取、未公开可调目录和等待引擎确认等持续状态留在面板内。Core 从提交后的会话状态计算有效档位，并通过 `agentSession:event` 的 `permission-mode` 同步界面；关闭时保留手动选择，重新开启、切会话及刷新均恢复该选择。迟到历史或切换前的模式请求不会覆盖已确认档位。关闭时释放当前有效的待决权限申请，继续保留回合、连接和取消检查。支持在线策略的引擎保持连接；只能启动时设置的引擎在空闲时重建，运行中不能安全恢复人工配置时明确拒绝开启。已启动的 PTY 权限参数需要重启才能改变。

宿主工具 `host.workers.options({mode:"native-settings", harnessId, surface:"gui"})` 只读当前工作区已登记来源的原生设置目录；Worker 来源绑定其会话，调度来源绑定当前工作区。目录未读取时由用户在界面刷新，查询本身不启动引擎。创建接口接收返回身份下的显式 `nativeConfig` 意图并再次校验。

会话菜单通过 `agentSession:getNativeConfig`、`refreshNativeConfig`、`setNativeConfig` 与 `agentSession:event` 的 `native-config` 通知同步。普通读取使用已观察状态，刷新可能物化连接。修改携带当前身份和 revision；迟到结果不能替换其他会话或更新的快照。请求值逐项显示为待确认，引擎通知或实际回执才更新当前值。启动时生效的选项和只读事实各自标注。引擎报错、目录尚未读取、未公开可调目录是不同状态。

| Harness | 设置来源及修改边界 |
|---|---|
| ACP | `session/new`、`session/load`、`session/resume` 原生 `configOptions` 与更新通知。支持分组选择、布尔与未知 category；配置数组存在时包括空数组优先，只有缺失时读取旧 `modes`。通过 `session/set_config_option` 或 `session/set_mode` 提交。版本/登录/目录不同可返回不同设置。 |
| Claude Code | Claude Agent SDK 0.3.272 的 `PermissionMode` 声明目录，`system/init` 与 `system/status` 报告当前模式，`Query.setPermissionMode` 请求切换。`bypassPermissions` 的 SDK 许可在启动时显式选择；未获启动许可的现有连接将该选择标为不可用。 |
| Codex | 原生 app-server 的 `permissionProfile/list`、`configRequirements/read`、`collaborationMode/list`。权限 profile、审批策略、审核人和协作模式分别传入；复杂审批策略及实际沙箱作为只读事实。线程创建/恢复读取实际生效字段，设置通知确认变更。当前每回合启动独立进程，空闲修改在下回合提交给原生协议。已确认的普通会话选择不在下一回合重复覆盖。Worker 路由经用户单独授权的跨 Harness 交接有独立的原生权限快照验证。 |
| 外部 Pi | RPC 没有公开会话权限目录或 setter。由 Pi 配置和扩展决定权限；收到原生扩展确认或选择时按原始选择应答。 |
| Oh My Pi | 支持文档列出的 `--approval-mode` 启动选项。关闭配置时使用 `yolo`，开启时每次启动/恢复都重传保存的显式启动选项。当前 RPC 无权限目录、状态读回或在线切换，运行中显示仅启动生效及当前值未知。 |
| Muse Code | MSP 的 `approvalMode` 和 `session/setApprovalMode`。支持实验接口的版本还提供 `permissionProfile/list`、启动/恢复 profile 和 `session/setPermissionProfile`，原生会话报告权限事实及 limits。空闲修改在下回合提交；limits 在线修改要求独立 socket 连接，本适配器使用 stdio。 |
| ZCode | `ZCode Protocol` v1 的 `settings.mode.current`、`state.updated` 与 `session/setMode`。优先展示引擎返回的目录，缺失时使用核对过的 v1 枚举。 |

开启配置时，原生审批卡展示协议提供的名称、范围和说明，按原始 ID 或原生响应应答。关闭时自动选择协议实际提供的允许选项，不伪造选项 ID；没有允许选项时报告限制。审批与发起请求的连接及回合绑定，取消或过期请求不会自动批准。宿主工具依然校验调用身份、投影目录、入参、显式工具规则和低频业务授权。引擎自行执行的原生操作由引擎策略管理。

CLI 关闭配置时，公共启动参数边界选择已验证且由能力目录允许的原生命令参数，忽略隐藏的旧权限/沙箱限制。没有可靠免审批参数时，新建界面明确提示终端仍可能要求确认；PTY 无法通过 GUI 宿主接管任意终端问答。开启后「启动权限」和其他字段使用该命令的原生值和 argv。Codex 可分别设置审批策略和沙箱，组合快捷参数按命令自己的互斥关系处理。Muse 的 `--approval-mode` 和 `--approval-judge` 独立；旧 CLI ID 以等价 argv 兼容。自定义 CLI 使用 Manifest 的声明，未声明的选项由 CLI 自己管理。

Claude Code 原生禁止 root 使用免审批模式：macOS/Linux 的 root 用户启动 CLI 自动权限时返回明确错误，指引使用普通用户或开启权限配置；GUI 可以由宿主处理权限申请并记录原生绕过不可用的原因。Windows 没有 POSIX uid，使用正常原生参数路径。上述平台判断和 argv 有模拟回归，macOS/Linux 真机未验收。

## 宿主、工具和数据流

`AgentSessionHost` 建立会话、捕获工作区和回合身份、维护事件与历史，`registerDrivers.ts` 注册各协议适配器。内置 Pi、Codex 的受控 worker、Claude 的 GUI 会话与模型发现，以及 ACP 和 ZCode 的模型发现使用创建时进程容器。Windows 使用 Job，macOS/Linux 使用进程组，在确认归属后激活引擎。Claude 使用 `controlledChild.ts` 同步提供 SDK 所需的 stdio，关闭时先确认容器清空，再结束输入和 SDK。模型发现等待容器退出确认后才保存快照。其余外部会话仍通过各自的 owner 回收，使用 Windows `taskkill` 的路径存在 PID 竞态。POSIX 进程组无法覆盖自行逃逸的后代。`host/retirement.ts` 让新连接等待旧连接回收，失败时保留错误并阻止新写入者。

`controlledChild` 的显式回收与自然退出共用资源归属：显式回收开始后，由其 Promise 返回回收结果，退出监听不再重复发送失败事件或额外启动一轮回收。失败的 owner 保持可重试，避免新的关闭请求接到退出监听另行发起的旧失败。未确认容器清空前不得合成子进程退出事件或释放宿主屏障。

`tools/registry.ts` 从常驻清单、角色/preset 和模式条件装配工具；`tools/identity.ts` 绑定主进程确认的会话与 cwd，并检测点号转下划线的名字碰撞。`tools/gateway.ts` 集中执行名称映射、JSON Schema 校验、实际 action 权限判定、审批后状态与回合复核、取消检查及结构化结果投影。内置 Pi、Claude、ACP（含 Cursor）/Codex MCP、Muse 和 ZCode 按各自协议桥接该网关。

GUI 会话关闭权限配置时，网关权限请求、自愿 `requestApproval` 和 Core 计划权限申请自动允许；开启后进入原有人工路径。内置 Pi 的受管宿主工具由网关检查。Claude SDK 与其他外部引擎可以对宿主 MCP 发起原生审批，实际工具调用再经过网关的身份、目录、显式工具规则和业务授权。带取消信号的审批和问卷会在请求取消时结束；普通问卷不因关闭权限配置而自动回答。Worker 路由经单独授权的跨 Harness 交接仍执行其明确权限快照合同。

ZCode 在创建或恢复会话时提供只监听本机的 Streamable HTTP MCP 网关；每轮使用独立进程和随机授权，结束、停止或失败时撤销当前回合权限，下一轮回收进程后经原生 `session/resume` 恢复。原生历史未确认恢复或进程回收失败时明确报错。ZCode 复用 NDJSON 管道但按其严格协议不发送 `jsonrpc` 字段；会话与模型发现均答复 `session/requestRuntimePreferences`，启用原生搜索增强并关闭问题自动回答，其他未支持的反向请求明确拒绝。工作台为 ZCode 注册 `bgtasks.shell`、`wait`、`list`、`kill`；任务归工作台和父会话管理，忙时完成通知进入宿主队列，实际 MCP 工具发现、后台执行、恢复和唤醒需用户验收，通知回执的边界见 [后台任务](background-tasks.md)。事件与输入标识关联后实时投递，关联前暂存；终态仍无法确认归属时不猜测。工具事件按调用标识去重；普通 `AskUserQuestion` 转换为工作台问卷，原生问卷和审批按请求标识处理重发，并与宿主工具审批串行展示。计划审批及 MCP elicitation 不按普通问卷误处理。未观察到引擎读取宿主工具目录时记录告警；观察到目录请求也不能证明模型实际调用了工具。协议字段及 MCP 覆盖语义对照 [ZCode 官方源码版本 a60ba6a](https://github.com/zai-org/ZCode/tree/a60ba6a7e5a06742270ca605f5d2cc2766afa7e1)，与用户安装版本的兼容性需实际确认。

ZCode 的系统提示按 `mcp__muster__` 前缀列出会话桥接的宿主工具；Muse 和 ZCode 的内置 runtime 种子声明其会话级 MCP 接入。声明和提示描述的是适配器接线，不代表已验证工具调用：实际 MCP 发现、原生工具名与调用结果仍需在用户安装的引擎版本中验收。交互实操与截图见 PandaCode 对照。

Catalog 工具使用 `execute-result-json` 声明结果信封，网关依据其 `ok` 传达失败，而不是将业务失败包装成成功。后台任务和 node-repl 的启动/执行失败以错误返回。`X.run` 的 action 参数由 `capabilities/schemaValidation.ts` 使用 draft-07 校验，明确执行 `oneOf` 和 `not`；不支持的 schema 关键字产生错误而不静默忽略。GUI 保持既有的 `terminal.create` / `intent` 不开放边界，不因清单收敛扩大权限。

完整宿主说明随 GUI 会话的首条适用输入投递，以 `<muster_host_context source="automatic">` 块附在用户正文之后，空行分隔；Claude、Codex、ACP、Muse、ZCode、内置 Pi、外部 Pi 和 Oh My Pi 共用后置拼接规则。宿主同时看到以完整说明结尾的实际发送文本和引擎启动、活动或完成回执后，在应用的 `agent-inputs/<sessionId>/host-intro.json` 原子记录已投递状态。切模型、断线重连和应用重启恢复同一会话时跳过这段说明。明确在引擎接收前失败时可以重试；提交结果未知时保留待投递状态。升级前已有原生恢复标识和模型活动记录的会话按已投递恢复。新建、清空后重新开始、分叉出的新 GUI 会话及 Worker 改派到新引擎会话时分别投递一次。聊天转写保留原文。外部 Pi 和 Oh My Pi 的临时桥继续提供工具注册、审批和回合确认，提示词正文通过 RPC 输入送达。

消息在活动回合中的投递优先使用 `receiveMessage` 回执；只有明确 `unsupported` 才能回退。超时、换代或无效回执属于状态未知，不自动重投；带图片的消息保留在宿主队列，不经不支持图片的插话通道。工具网关的审批、提问和结果绑定原始回合。外部 Pi 的 RPC 事件不带宿主回合 ID，当前按活动状态归属。迟到事件在各版本下的隔离仍需迁移或实机确认，不能声称所有 Driver 都已覆盖。

分叉会话在用户数据目录的 `agent-fork-pending` 下保存待投递状态，在 `agent-fork-points` 下保存 GUI 消息与引擎原生条目的对应关系，不改变已有历史 JSON 格式。内置引擎、Codex、外部 Pi、Oh My Pi 和 OpenCode 对可确认的截点接入各自原生 fork。Codex 在 app-server 中查验截点是否为已完成的 assistant 回合。Claude、GLM 和 MiMo 暂时回退到首轮文本前缀：所用 Claude SDK 0.3.272 分叉时重映射消息 UUID，却未同步重映射压缩元数据中的消息引用；其公开历史读取接口也无法完整检查这些记录，故不能确认分叉上下文完整。无截点映射、引擎未提供所需能力、其他未接入精确截点的引擎，或源会话含受管附件时继续使用原有种子回放或首轮文本前缀；不能把这两种回退称作完整原生上下文。写入或投递状态不确定时保留历史并阻止自动重发，提示用户先检查引擎历史；已确认提交但记录清理失败时使用已送达状态避免重复注入。进程退出或失败回收的错误会显示在聊天界面，资源未确认释放时不会提前开放下一写入者。

首轮文本回退投递期间只接受一个原生会话标识，在确认回合完成且取得标识后，才把已投递标记写为可恢复状态；若完成时没有标识，停止后续发送和压缩，因为不能确认之后出现的标识指向已有上下文。受此保护的会话在后续回合连接或发送之前同步写入在途标记。完成回合时先整理消息与计划等终态，再等待同文件旧写入结束，同步写入包含消息、用量、注入及压缩记录的最新完整快照，随后在同一同步提交段发布已投递标记；期间保持忙碌，普通消息可排队但不走原生插话。压缩回执与事件目前没有共同操作 ID，受保护会话暂不支持手动及自动压缩，手动请求在启动引擎压缩前返回说明。操作内必须保持标识不变，检测到变化会立即撤销当前回合的宿主工具权限并回收连接，已被外部系统受理的动作不保证撤销。失败、中止或进程崩溃后阻止自动续作、派发排队消息和二次分叉，提示先检查原生历史。空闲时收到不同的新标识无法关联到已确认的操作，会尝试落在途标记并阻止续写，而不是覆盖注册表；重启时保护记录与会话注册表均有标识且不一致也会阻断。首轮明确未提交时仍保留可由用户重试的待投递记录。驱动自身若不能确认事件与回合归属，不能仅凭这些宿主标记证明引擎历史完整；若收到无法归属的新标识后本地磁盘拒绝写入保护记录，随后立即异常退出，也无法仅凭未变化的旧文件识别这次异常。

分叉回合的严格历史提交等待先前已发起的异步 rename；新提交、删除和清空会使等待中的旧严格提交失效，避免旧回合覆盖新状态。该顺序针对进程异常退出：当前写文件和目录未执行 fsync，不能声称断电后的持久性。

队列仍是现有通用的内存队列，工作台重启时不会重建；恢复消息会去掉 `queued` 标记，因此异常退出前尚未发送的排队消息可能以普通消息显示，不能仅凭消息显示认定引擎已经收到。严格历史提交不改变这一队列恢复边界。

清空会话先同步写入清空标记，再等待旧历史写入结束并删除应用侧数据，最后严格写入会话注册表中的空引擎标识，成功后才移除标记。不同会话的注册表严格写入会依次执行并各自校验，失败时重新安排写入最新完整注册表。失败或异常退出后保留标记并阻止续写，可检查历史后重新清空；与永久删除并发时也保留标记，等后续启动确认注册表无此会话后才由孤儿清扫回收。无法读取或解析的保护记录会保留，删除仍尝试其余历史、附件和引擎清理，并向用户提示错误；引擎进程未确认回收时不会强行清理或删除 worktree，已确认回收后若数据清理失败则仍尝试 worktree 收尾并合并报告。引擎侧 `purge` 仍是各驱动尽力清理，部分驱动不提供清理、部分内部错误只记日志，不能据此宣称原生历史已销毁。普通删除仍沿用注册表异步落盘：历史删除先于注册表完成时异常退出可能复现旧会话或标识。清空和删除均不提供断电持久性保证。

OpenCode 的 ACP 事件如带原生 assistant 消息 ID，回合结束记录首尾 ID 和发送内容哈希；用户发起分叉时才启动仅监听本机且有随机密码的短命 OpenCode HTTP 服务，校验源消息与用户输入，利用 v1 API 的排他 `messageID` 截点创建分支，再核对复制后的原生历史。ID 缺失、不能确认对应关系或接口格式不匹配时回退；请求已创建分支但校验失败时报告会话 ID，不自动重试。尚未接入不同结构的 OpenCode v2 原生 HTTP 路径。

外部 Pi 借宿主扩展在回合结束核对原始输入及原生条目，分叉时在临时副本运行扩展命令并校验包含选中条目的分支，再发布引擎生成的会话文件；不切换源连接。仅在安装版提供相应扩展能力时生效，旧版本、输入经扩展改写而无法核对或旧消息无映射时回退。Oh My Pi 使用扩展的 `session_stop` 记录对应条目；分叉在关闭扩展发现的独立进程中对临时副本执行，不向源连接发送 fork 或会话切换。副本使用独立原生会话 ID，随会话复制并核对引擎管理的 artifacts，再以 `get_entries` 核对父链与分支截点；引擎未提供所需命令时回退，源会话或产物在复制期间变化则报错。核验通过后才将产物和子会话发布到源会话目录，并修正父会话路径。链接、特殊文件或超限的产物不能安全复制时明确报错。两者的实际安装版行为均待用户验证。

Oh My Pi 支持扩展在流式输出后改写最终 assistant 消息。工作台按 RPC 消息 ID 比较流式正文和最终正文：最终正文仅补充尾部时补显缺失部分；已有正文被改写时标记回合错误且不保存原生分叉截点。无法按 ID 核对时也不保存原生截点，并在日志提示。当前事件合同只能追加文本，尚不能原位替换已经展示的正文。

外部 Pi 的第三方扩展可能在 `agent_settled` 后发起新回合，而当前 RPC 无法可靠归属这些后续事件。按用户选择，`pi-external` 的 GUI 会话与模型发现使用 `--no-extensions` 禁用自动发现和配置的扩展；会话仍以 `--extension` 显式加载工作台桥接。某些版本的 Pi 内置 MCP 等扩展也会因此关闭，依赖扩展注册的模型和工具可能不可用；Oh My Pi、独立 CLI 和内置 Core 不受此策略影响。Pi 的技能、提示模板及其包解析不等同扩展开关，仍由引擎自身处理。该参数在旧版 Pi 曾有发现路径缺陷，用户安装版本是否正确执行需实际验证，不把参数声明当作跨版本验收。

外部 Pi 的 GUI 会话和原生分叉辅助进程设置 `PI_OFFLINE=1`，让支持该变量的 Pi 版本跳过启动期自动网络操作与模型目录刷新；这不应阻止正常模型推理。用户手动刷新模型目录时按既定流程读取引擎目录；Pi 的目录查询返回当时快照，不保证其异步联网更新已经结束。不同安装版本对该变量和目录刷新的支持仍待实际验证。

旧版 Pi 的 `agent_settled` 可能没有中止字段；工作台同时参考最后一条 assistant 消息的停止原因，避免把已观察到的中止当作成功。没有正常最终消息时报告错误，单独的 `toolUse` 不视为已确认的最终回复；某些自定义引擎允许工具提前结束回合，这种情况当前也会保守报错。没有生成终态消息的旧版中止路径仍需实际验收。

原生截点核对有读取上限：OpenCode 单次历史响应 16 MiB，外部 Pi 和 Oh My Pi 会话文件 128 MiB，Oh My Pi 另受现有 RPC 单帧 8 MiB / 重组消息 16 MiB、artifacts 512 MiB / 2 万条目限制。超过上限时报告失败，不能当作已成功原生分叉；这些读取只核对会话历史，不刷新 Harness 或模型目录。

ACP 通用 `session/fork` 本身没有标准消息截点，不能用整会话 fork 代替任意消息分叉。Kimi 的旧版 Web 接口曾提供按回合分叉，但上游存在压缩/插话后界面历史与模型上下文可能错位的报告；新版 Kimi Code 文档中的 ACP fork 和 HTTP fork 仅明确整会话，新版按历史消息安全分叉尚未接入。GitHub Copilot SDK 提供按事件分叉、DeepSeek Harness 提供按序号分叉，但工作台目前通过 ACP 接入，尚未打通这些引擎侧事件与 GUI 消息的对应关系；它们仍走回退。其他未经确认的引擎也保持现有回退。

每次分叉会在主进程日志标注选用的 `native`、`seed`、`transcript` 或 `empty` 策略；当前界面不展示该策略。实际验证仍需检查引擎的分支上下文和恢复行为，日志只证明宿主选择了哪条路径。

## 入口与文件

| 文件 | 职责 |
|---|---|
| `src/shared/harnessCatalog.ts` | 产品身份、协议类别、内置预设、安装链接与 GUI/CLI 对照 |
| `src/shared/agentRuntimeCapabilities.ts` | GUI 能力、权限模式、模型切换、宿主工具和图片边界 |
| `src/shared/retiredServiceRuntimes.ts` / `src/main/runtime/host.ts` | 移除旧套餐注册，只为旧聊天历史保留停用身份分类；不提供执行或新建入口 |
| `src/main/agentSession/registerDrivers.ts` | 主进程 driver 注册 |
| `src/main/agentSession/host/{connection,retirement,messaging,events}.ts` | 会话连接、回收屏障、消息回执和事件 |
| `src/main/agentSession/process/owner.ts` / `processReclamation.ts` | GUI 进程所有权、受控 worker 容器、外部 CLI 回收与有界等待 |
| `src/main/agentSession/tools/{registry,identity,gateway}.ts` | 工具装配、可信身份、统一调用网关 |
| `src/main/agentSession/drivers/{pi,externalPi,acp,muse,zcode,claude}/` | 内置/外部引擎的各协议实现 |
| `src/main/runtime/availability.ts` / `src/main/ipc/{workspaces,agentSession}.ts` | 预检、设置与模型目录 IPC |
| `src/main/agentSession/harnessModelIdentity.ts` / `harnessModelAdmission.ts` / `src/renderer/src/chatSurface/agentSessionSurface.tsx` | 会话模型身份、主进程白名单与默认回退、缓存读取及界面模型显示 |
| `src/renderer/src/components/settings/WorkerPane.tsx` / `workerCatalog.ts` / `WorkerProductHeader.tsx` / `HarnessModelSelectionPanel.tsx` | 产品目录、独立使用方式和模型筛选 |
| `src/renderer/src/components/NewTaskDialog.tsx` / `HarnessModelPicker.tsx` / `NewTaskIsolationPicker.tsx` / `TaskSessionFields.tsx` | 新建会话的固定窗口、GUI/CLI 分流、共用模型参数选择页和隔离范围 |
| `src/renderer/src/components/HarnessIcon.tsx` / `resources/third-party/harness-brands.txt` | 本地品牌图标、未知产品回退及素材来源 |
| `resources/third-party/pi-LICENSE.txt` / `electron-builder.yml` | Pi 上游许可证和安装资源复制规则 |

## 验证与已知边界

MiMo 原生接入及套餐移除通过生产构建、专用纯逻辑回归（三平台安装路径、原生命令选择、权限环境与旧注册迁移）、目录组件点击配置回归，以及 Claude 回放、GUI registry、ACP 可执行发现和 runtime 声明回归。Windows 本机 MiMo 0.1.14 已完成不发推理的真实模型发现；主进程与渲染层类型检查通过，未执行全量测试。另跑的 `acp-driver-replay`、`gui-permission-wiring`、`gui-inherit-meta`、`runtime-availability` 等旧离线测试仍失败，均已在改动前的隔离 worktree 重现相同失败；未将它们计为通过。上述离线用例有权限/恢复/ACP 模型覆盖/缓存的旧期待与当前实现不符。旧 Worker 组件 fixture 与交互预期已随本次产品设置重构更新，7 个相关组件文件共 41 项通过；新增 ACP 独立启停回归覆盖真实配置保存/重载、缓存过滤、创建预检与连接拒绝。Windows 隔离 Electron 已验证真实 IPC 保存、其他 ACP 产品隔离与页面重载；生产组件在正式浅/深主题及 1040/390px 容器截图并人工查看。MiMo 原生推理与其他平台实机仍不在这次设置验收范围。 一次最终 Electron 复跑被应用启动确认遮罩挡住设置按钮；随后的同一构建重跑正常通过，未强制穿透或自动确认未知弹窗。弹窗原因未复现，不能据此声称启动流程没有偶发干扰。

Windows、macOS、Linux 的完整账号、权限、图片、历史、停止和跨平台进程树均待用户验收。Windows 外部引擎或 POSIX 根进程若已先退出，无法凭原进程号或进程组号确认孤儿后代已回收，适配器会报错并阻止误报成功；POSIX 检查根进程状态与向进程组发信号之间仍有竞态，进程组也无法覆盖自行逃逸的后代。旧连接回收失败后宿主会保留失败屏障，提示检查残留并重启工作台；底层重试能力不等于宿主会自动解除该屏障。

ZCode 手工验收时记录所用版本和平台：新建会话并观察长回复是否逐段出现；让引擎调用一个工作台工具并检查真实结果；触发普通问卷、原生权限允许及拒绝，观察多次请求不会重复挂卡；连续发送多轮并核对上下文恢复；中途停止后再发送，检查不会继续执行已停止回合的宿主工具。原生 MCP 配置不自动合并的提示需在设置和新建界面可见；测试工作台中转的第三方 MCP 时，以实际调用结果为准。无回合标识或不支持的交互应明确拒绝或报错。当前实现未验证 ZCode 的全部版本或 扩展域通道。

ACP/Muse/ZCode 的原生工具策略只覆盖它们实际上报的权限请求；提示词中的目录范围不等于 OS 沙箱。Muse 的 MCP 注册名称可从源码对照，但引擎最终是否追加服务名前缀需实机确认。桌面新建会话按 ACP 预设逐项选择；移动端目前只显示一个 ACP 入口，创建时使用首个通过预检的预设，暂不能逐项选择。没有新增会话设置的实时广播：同一窗口内的其他表面修改设置时，模型标签可能保留旧值；手动刷新会话设置或目录后重新同步，旧菜单提交由主进程身份校验拒绝。独立 CLI 的共享 HOST-EXT 中仍有旧的状态文案长度说明，涉及共享契约的修正须按仓库规则先说明影响并取得确认。
