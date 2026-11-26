# ACP 通用 GUI driver（T5.2）

## 职责

chat surface runtime `acp`（注册表 **ACP**）。用 [Agent Client Protocol](https://agentclientprotocol.com/) 的 **JSON-RPC NDJSON over stdio** 子集接 OpenCode / Gemini 等 ACP agent，中栏仍是 `AgentChatView`，**不拉 pty**。

内置目录和 Runtime Manifest 提供 Cursor、OpenCode、Gemini、Kimi、Antigravity、Grok、DeepSeek、Command Code、Cline、Kilo、GitHub Copilot、Devin、Hermes、MiMo Code、Qwen Code 和 CodeBuddy Code 的启动预设。程序探测、协议兼容、登录和模型推理分别验证。大多数引擎使用自己的登录。Grok 自动认证只采用已声明的 `cached_token`，缺失时提示用户先登录 CLI。Windows `.cmd/.bat` 经 `cmd.exe` 包装，含 `%` 的命令或参数明确拒绝以避免环境变量展开。宿主 MCP shim 的 spawn 计划来自 `inboundMcp/launch.ts`。

聊天、模型发现和 Kimi 终端的 ACP 准备按 `initialize` 实际返回的字段继续发起请求。工作台发送自身支持的协议号，后续按原生会话标识、已声明能力和操作回执判断可用性。协议请求失败显示对应错误。

## 关键文件

```
src/shared/agentRuntimeCapabilities.ts   ChatRuntimeId += acp；transport acp-agent
src/shared/acpSlash.ts                   AvailableCommands → 斜杠菜单纯函数
src/main/agentSession/drivers/acp/
  driver.ts          AcpRuntimeDriver（initialize / session/new|load / prompt / cancel）
  jsonRpc.ts         NDJSON JSON-RPC
  streamMap.ts       session/update → GuiDriverStreamEvent（五事件合同）
  permission.ts      session/request_permission → 原生选项与审批卡往返
  mcpServers.ts      session/new.mcpServers（B2 起只装宿主 stdio MCP shim；用户 MCP 直注与 HTTP 能力协商已退役）
  hostToolGateway.ts 宿主工具 HTTP 回叫（MCP shim → GuiHostTool.execute）
  agents.ts          目录驱动的内置预设；PATH、常用安装目录与 Windows shim 解析
  cursor.ts          Cursor 模式协商、原生提问和计划请求映射
  models.ts          无推理的模型发现、认证和进程回收
  dshModelDiscovery.ts DeepSeek 探测临时存储覆盖、运行时校验与清理
  modelOptions.ts    解析会话声明的模型及设置选项
  launchPolicy.ts    OpenCode/Kilo/MiMo Code/DSH 的进程级模式配置及 DSH 恢复令牌
src/main/runtime/builtins/registry.json  id=acp surface=chat
test/acp-stream-map.mjs / acp-slash.mjs / acp-driver-replay.mjs
test/acp-driver-smoke.mjs                EXCLUDE；要本机 CLI
```

## 五事件合同（wmux AcpBrainAdapter）

| ACP | GuiDriverStreamEvent |
| --- | --- |
| `agent_message_chunk` | `text-delta` |
| `tool_call` | `tool-start` |
| `tool_call_update`（名称、类别、入参或位置更新） | `tool-update`，按调用 ID 更新同一条聊天记录 |
| `tool_call_update`（completed/failed） | `tool-result`，在同一张卡上结束调用 |
| `session/prompt` 响应 | `turn-complete`（driver 发；resume 用 sessionId）；标准 `stopReason=cancelled` 带 `cancelled:true`，不冒充成功回执 |
| 当前 prompt 的有效活动或成功 RPC 响应 | 按宿主输入 ID 发一次 `turn-started`，确认续接已经被引擎接受；stdin 写入不算回执 |
| 错误 / rpc 失败 | `error` |

驱动另处理思考、可用命令、原生会话设置与审批事件。优先显示 `configOptions`，包括空数组。缺失该字段时以旧 `modes` 为兼容来源。`config_option_update` 和 `session/set_config_option` 的配置数组为完整替换。布尔写入发送 `type: "boolean"` 和原始布尔值，旧模式通过 `session/set_mode` 和 `current_mode_update` 确认。

工具卡使用 ACP 的程序化名称，缺失时回退到标题或类别。适配器按调用 ID 保存最近一次上报的参数与位置。宿主通过既有 `part` 增量事件发布并持久化变化。有实际入参时，参数区使用 `rawInput`，非空 `locations` 继续给文件审阅使用。结果支持 ACP 包装的文本块，空 `rawOutput` 时从 `content` 取文本。Qwen 的名称扩展和读文件、搜索结果见 [Qwen Code 接入](qwen-code.md)。

## 产品形状

| 项 | 行为 |
| --- | --- |
| 回合 | 一条 stdio 连接；`send` = `session/prompt`；无 steer（`redirect` 恒 false → Host 入队） |
| 宿主续接 | 空闲时沿同一 `send` 开下一轮，无需能力声明；忙时等回合边界，不声明 `interject` 或快照抢占，详见 [会话续接](resume-wait.md) |
| 停止 | `session/cancel` |
| 续聊 | 原生 token 只用于引擎声明的 `session/resume` 或 `session/load`。不支持、恢复失败或 ID 不匹配时报错。旧 DeepSeek 包装令牌提取原始 session ID 后交给原生协议 |
| fork | OpenCode 在 ACP 回合提供原生消息 ID 时使用其 v1 HTTP 分叉接口并校验截点；ACP 通用 `session/fork` 无标准消息截点参数，其他 ACP 引擎及无可靠映射的消息继续用 Host transcript 前缀，详见 [GUI Harness 接入](gui-harness-integration.md) |
| 权限 | 「配置权限」默认关闭；优先选择目录中已核实的原生免审批值，收到 `session/request_permission` 时自动返回引擎提供的允许 optionId。开启后展示原生选择，包括持久允许或拒绝。取消返回 cancelled；过期回合不自动授权。实际宿主工具由独立网关校验身份、目录、用户规则和业务授权 |
| MCP | `session/new.mcpServers`：只注入宿主工具 stdio server `muster`（与 pty 共用 `inboundMcp/stdioEntry.mjs`；preset `acp-subset` + catalog JSON；短命 `MUSTER_HOST_TOOLS_TOKEN` 回打 `hostToolGateway`）。B2 起用户配置的 MCP 不再按 `acp:<presetId>` 过滤注入——第三方工具经宿主中转 `mcp.search`/`mcp.call`；initialize 的 `mcpCapabilities.http` 协商与「占用 muster 名」防护随注入面收窄一并退役（无用户 server 即无冲突面） |
| 引擎选择 | 创建对话框「ACP 引擎」写入 `piModeId`（内置预设 ID）；空=PATH 上第一个可用 |
| 模型与思考强度 | 用户手动刷新时探测目录，普通读取复用持久化快照。默认模型和已探测模型的档位分别保存，刷新一个模型保留仍在目录中的其他模型档位。预设 ID 存 `piModeId`、模型存独立 `modelOverride`，已绑定的 ACP 引擎不能在会话中切换。会话身份由主进程以不透明 HMAC 绑定实际 agent、可信预设及工作区、连接版本和模型快照，提交校验前后均复核。思考强度仅由所选模型协商返回的 `configOptions` 提供，选到尚未读取参数的模型后需再手动刷新；按连接快照经 `session/set_config_option` 设置并检查响应。部分 ACP 的空成功响应无法独立读回生效值，不支持原生恢复的引擎不能保证切档后续用 |
| 鉴权 | 永不代填 Key |

### CodeBuddy Code 的 MCP 审批

CodeBuddy 2.182.0 在 `toolCall._meta['codebuddy.ai/toolName']` 提供 MCP 工具标识。声明式适配器可登记同类字段。标准程序标识来自 `toolCall.name`，`title` 用于展示。已注册宿主工具根据实际工具 ID 执行网关规则。

`test/acp-permission.mjs` 回放 CodeBuddy 的请求，覆盖普通调用、规则要求确认或拒绝、引擎安全标记和取消。Windows 使用真实 CodeBuddy 2.182.0、隔离配置、模拟模型和本地 MCP 验证了 ACP 请求及单次放行。macOS 和 Linux 共用协议解析，尚无真机验证。

### Antigravity

内置 `antigravity` 预设以 `agy acp` 启动 [Google Antigravity CLI](https://antigravity.google/docs/ide/extensions/acp/)。先查 PATH，再查官方安装目录。macOS 和 Linux 为 `~/.local/bin/agy`，Windows 为 `%LOCALAPPDATA%\agy\bin\agy.exe`。新版 CLI 未发现时，按原有查找方式启动 `agy_acp_server` 或 `agy_acp_server.par`，不附加参数。

安装后可在「Harness 接入」刷新检测，在新建任务的 GUI Harness 选择器选择 Antigravity。会话和模型刷新沿用 CLI 登录。若 ACP 返回需要认证，界面提示在终端运行 `agy acp --login`。在 Google 页面完成授权后，需要把页面显示的授权码粘回终端，由 CLI 确认登录成功。模型、思考档和恢复能力读取原生 ACP 响应。

`test/acp-executable-discovery.mjs` 覆盖发现顺序、旧服务、缺失程序及 Windows 原生参数。`test/e2e/antigravity-acp.spec.ts` 通过真 Electron 和模拟 ACP 服务覆盖选择、创建、发送和渲染。已登录本机 CLI 后，可设 `MUSTER_E2E_LIVE_ANTIGRAVITY=1` 运行同一用例，验收官方 CLI 和实际推理。

### Cursor

Cursor 预设启动 `cursor-agent acp`，使用 CLI 登录或 `CURSOR_API_KEY`。模型、协作模式和配置从 ACP 发现；显示该版本声明的 `agent`、`ask`、`plan` 等选项，以原生回执或通知确认切换。Windows 的 PATH 未更新时补查官方安装目录，macOS/Linux 补查 `~/.local/bin`。额外目录通过 `--add-dir` 登记，实际访问由 Cursor 决定。

`cursor/ask_question` 映射到工作台提问卡并保留选项 ID；`cursor/create_plan` 显示完整计划并等待用户批准或拒绝。取消、超时和旧回合作答返回取消；其他未知请求返回协议错误。Cursor 的通知扩展当前没有专门可视化。需要重连时使用其声明的 `session/load`，失败明确提示并保留聊天历史，不以空会话冒充续聊。旧 SDK 会话不迁移或恢复。

Windows 本机 CLI 的 initialize、新会话、模型目录、三种模式协商及宿主 MCP 进程启动已探测；账号返回升级订阅提示，成功推理和原生会话恢复尚未验证。模拟回归见 `test/cursor-acp-integration.mjs`，macOS/Linux 尚无真机验证。

## 已知边界

- ACP 模型目录发现通过 `session/new` 建立空原生会话；进程回收与 `session/close` 均不等于删除会话记录。DeepSeek DSH 会主动持久化空会话，因此 `dshModelDiscovery.ts` 为每次手动探测创建独立临时目录，通过 CLI `--patch` 将会话 JSONL 和 JSON 存储（含会话投影）指向临时目录，并将会话查询设为内存、关闭该探测进程的 HMR。原来的 profile、登录与模型供应商配置继续使用，不复制或改写用户配置。临时校验插件检查运行中的两类存储根并经 stderr 返回本次随机回执；宿主收到回执后才允许 ACP 请求，覆盖目标失配、插件未加载或取消均不会退回正常存储创建会话。回收进程完成后移除临时覆盖文件、插件和数据；回收失败保留临时目录并报告 `cleanupFailed`，拒绝缓存成功。批量、单项、指定模型刷新都走相同路径，普通读取仍复用原缓存，真实聊天不加此覆盖。启动时的探测和目录初始化已移除。修复不删除已有原生记录。`test/dsh-model-discovery.mjs` 用真实受控进程和模拟 DSH 覆盖成功模型/思考档、批量/指定模型/缓存、覆盖失效、协议失败、取消、清理与三平台参数。Windows 本机桌面版 DSH 0.2.2-rc.1 的真实单项/批量探测与缓存读取返回模型及思考档，正常历史与投影目录条目不变、临时目录清理成功（本机记录：`.tmp/dsh-model-discovery/live.json`）；macOS/Linux 仅参数分支测试，尚未真机验证。
- `test/acp-resume-delivery.mjs` 以真实 driver/RPC 和续接状态机验证空闲发送、忙时边界等待，以及输出/零输出成功的单次输入关联回执。权限刷新等异步准备完成后再次核对连接及回合状态，并发 `send` 只能提交一个 prompt。拒绝、取消后通知、断线、会话级配置和错会话通知不确认投递。ACP 标准通知只带 session 身份，驱动按同一连接串行 prompt 关联；第三方引擎跨轮发送同一 session 的旧正文无法独立识别。真实 CodeBuddy 等引擎的续接、macOS/Linux 真机尚待验证。
- 聊天与模型发现共用 `NdjsonRpc`。入站 NDJSON 单帧和未收到换行的缓冲统一限制为 8 MiB，超限结束连接并报告传输错误。出站队列独立限制为 8 MiB 和 128 帧。`test/acp-driver-replay.mjs` 覆盖大帧后继续收到正文、入站超限及出站背压。
- ACP 模型目录发现通过 `agentSession/process/controlledChild.ts` 暴露 stdio，在用户程序启动前取得 Windows Job / POSIX held group 所有权；初始化只在 ready 后发送，成功、失败和取消均等待真实回收，再决定是否保存缓存。回收失败返回 `cleanupFailed` 并拒绝缓存，保留受控 owner 供退出清理重试。主动脱离 POSIX 进程组、远端及客体进程不在此容器保证内。ACP 常规聊天连接目前仍使用 `process/owner.ts` 的 Windows taskkill 边界，不能以目录发现修复宣称已统一为 Job。
- Hermes Agent 返回 `-32603` 时，目录发现优先展示 `error.data.details` 中经过脱敏的首行。原生错误报告文件访问受限时，界面提示检查 Hermes 配置和日志目录权限。macOS 使用 Hermes 0.11.0 验证真实目录返回 1 个模型，文件权限错误和脱敏由模拟协议回归覆盖。Windows、Linux 实机待验。
  回归 `test/acp-model-discovery-owner.mjs` 使用模拟 ACP 协议和真实进程容器验证发现/取消后子孙进程退出；`test/unit/node-main/acp-model-discovery-owner.spec.ts` 覆盖 ready、清理屏障和失败拒绝缓存。模拟引擎不证明 OpenCode 的账号、推理或第三方工具可用。
- 工作台配置的用户 MCP 经宿主中转（`mcp.search`/`mcp.call`），不依赖所选 agent 的 initialize HTTP 声明；连接测试的 SSE 回落不等于向 ACP 声明独立 SSE 服务器。Cursor CLI 还可能独立加载其用户或项目 `.cursor/mcp.json`，不经过工作台中转策略；Cursor 官方说明 ACP 不支持其团队级 MCP。
- 未实现 client `fs/*` / `terminal/*`（initialize 声明关闭）。
- 冒烟依赖本机 CLI；`test/acp-driver-smoke.mjs` 找不到可执行文件则 skip。
- 内置 OpenCode 优先查 PATH，未命中时补查终端 runtime 的安装目录（Windows：APPDATA/LOCALAPPDATA 下 npm 原生 exe；POSIX：系统 npm、`~/.opencode/bin`、`~/.local/bin`）。预检、默认引擎选择与 connect 共用解析。用户覆盖预设只执行其声明的命令，不回落内置安装目录；独立绝对路径不依赖 PATH 非空。
- 内置 DeepSeek 以 `dsh --profile acp` 启动：PATH 和通用目录未命中时，补查官方桌面版随包的 `resources/runtime/cli/bin/dsh`（Windows 为 `dsh.cmd`）；Windows 检查当前用户和 Program Files 安装位置，macOS 检查系统及用户 Applications，Linux 另查常见解包路径。自定义安装位置可在设置里指定内置预设的命令。单独名为 `deepseek` 的第三方程序不会当作 dsh。静态识别不代表 ACP profile 的登录凭据可用。
- 本机 DeepSeek DSH/DSH-ACP 0.2.2-rc.1 隔离无推理握手只返回 `model`、`reasoning_effort`，没有原生模式或权限目录。会话使用 DSH 配置。上游 ACP 预设边界见 [DeepSeek ACP 源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/src/index.ts)。
- ACP 关闭权限配置时，只在真实目录声明了已核实的免审批值时调用原生 setter；否则由宿主自动响应后续有效权限申请。开启后恢复被自动覆盖的原生值并使用人工审批；在线切换保持 ACP 连接，避免无 `load` 能力时丢失上下文。不会用统一 GUI 档或批量环境变量覆盖 DSH 沙箱、MiMo 权限、OpenCode 工具权限。
- `test/acp-executable-discovery.mjs` 覆盖旧 PATH 与安装目录兜底、带空格 `.cmd` 真执行；Windows spawn 仍使用 `windowsVerbatimArguments` 保留 cmd.exe 命令行。
- Gemini 官方 flag 以 `--acp` 探测；内置预设由代码目录维护，CLI 二进制由用户维护。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D03.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：经 Agent Client Protocol 将目录中登记的第三方 agent 接到聊天表面。
- JSON-RPC NDJSON over stdio 复用 GUI 消息管线；凭证、恢复、原生目录和审批以实际协议能力为准。
- 明确不做：client fs/*、terminal/* 能力（initialize 声明关闭）；无 steer（redirect 恒 false 入队）；不代填厂商凭证；工作台管理的 MCP 不逐个直注。CLI 自己的原生配置由 CLI 管理。
- 歧义点：fs/terminal client 能力是「刻意不实现」（宿主工具经 MCP shim 已覆盖同需求）还是「路线图待补」？A=刻意不实现，边界锁定（review 不把缺失当 finding）／B=路线图项（review 记待补能力）。推荐 A。
