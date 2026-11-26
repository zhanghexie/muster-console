# 通用模型参数与思考强度

## 职责与使用

设置 → Harness 接入 → 工作台聊天 → 模型参数（Core 为单页）固定当前引擎，应用范围来自模型目录和已保存范围。默认档直接展示，自定义入口保留名称、顺序和原生映射。`/harness`、新建任务和当前会话共用选择器，依次展示 Harness、模型和引擎声明的参数。当前会话固定 Harness，模型与参数在确认前都是草稿。选项数量由描述符决定，思考强度是可选的 `reasoning` 语义。

配置可重命名、筛选或映射引擎声明的真实值。切换草稿模型时独立读取该模型的描述，并以来源、Harness 和草稿身份过滤旧回包。同一来源和 Harness 内读取时保留参数列的布局，旧选项标记为读取中且不可选，确认按钮等待当前模型的结果。换 Harness 或来源会清空旧参数列。确认没有参数时，模型列可以直接提交。会话可在跟随默认模型时保存显式参数。

参数列按引擎描述逐组展示，权限仍在任务表单独立设置。Codex 和 Claude CLI 使用原生逐模型档位，Kimi CLI 使用 ACP 描述并在启动时核验。三个入口使用 `agentSession:readHarnessPickerCatalog`，共享 `userData/harness-model-catalogs.json` 中上次成功的原生目录。只在用户显式刷新时启动外部发现，成功后以 `agentSession:modelCatalogUpdated` 广播来源和适配器。隔离会话读取原始注册源，项目子目录有自己的快照。Claude GUI 隔离配置与 CLI 用户配置分别读取。缓存继续沿用适配器现有配置、程序和账号目录身份。引擎内部账号或配置发生变化时，用户可手动刷新。

设置「Harness 接入」右上角「刷新」先检测引擎，再按当前工作区的注册源目录刷新可用外部 Harness 的模型和思考档。ACP 在同一个空会话中逐模型读取思考档，进度弹窗显示已处理数量和未确认档位。部分成功时保留仍有效的上次结果，未取得的参数继续标记为未知。

定时任务编辑使用任务自身的源目录读取 Harness 模型与参数快照，并应用各 Harness 的可选模型设置；尚无快照时可跟随引擎默认或由用户手动刷新。已经保存但被隐藏或当前目录未确认的模型仍显示，可恢复为引擎默认；更改模型或 ACP 预设时清除旧思考参数，避免套用到不同模型。纯目录读取与手动刷新不改写 Cursor 的全局默认模型。

桌面定时任务 `services:update` 的 `guiMode`、`piModeId`、`thinking`、`modelParameters` 更新字段以 `null` 表示明确清空，字段缺省或为 `undefined` 表示保留；创建合同和原有不传这些字段的调用方不变。编辑器只在值发生变化时提交这些字段，避免把未改动的空值当成配置变更。

## 合同与入口

[Worker 自动派活](worker-routing.md) 与 Composer 的 `/harness` 命令使用上述目录和描述符。保存短引用和候选池时把用户别名映射为原生值，再以实际模型、ACP preset 与来源重新校验。同名模型按各自的配置身份区分。

| 文件 | 责任 |
|---|---|
| `src/shared/modelParameters.ts` | JSON-only 描述符、配置结构校验、合法映射、默认优先级与连接键 |
| `src/shared/agentRuntimeCapabilities.ts` | 内置 Runtime 的模型参数能力投影 |
| `src/main/agentSession/types.ts` | driver 的 `describeModelParameters`、连接 DTO 和 `send(text, images, parameters)` |
| `src/main/agentSession/host/modelParameters.ts` | 参数目录、回合快照、会话变更串行化、模型切换校验及配置保存 |
| `host/turn.ts` / `host/connection.ts` | 每轮固定 canonical values，按描述符的 reconnect 参数重建连接 |
| `src/main/config.ts` / `sessions.ts` / `tasks/manager.ts` | 配置及会话/定时任务持久化；创建、委派、恢复和 fork 透传 |
| `src/main/agentSession/harnessPickerCatalog.ts` / `src/main/ipc/agentSession.ts` / `src/preload/index.ts` | 统一选择器目录、参数预览、来源校验与组合提交 |
| `src/shared/webApiPacking.ts` | 浏览器网关多位置参数与桌面单对象 IPC 保持一致 |
| `src/renderer/src/components/settings/ModelParametersPanel.tsx` | 通用配置编辑器；按 scope 保存及清除 |
| `components/ModelPickerLayout.tsx` / `agentComposer/ComposerModelCluster.tsx` / `chatSurface/agentSessionSurface.tsx` | 创建和会话共用的分列与参数选项、选中态、设置反馈、主进程推送与异步查询保护 |
| `components/TaskSessionFields.tsx` | 创建/定时任务的描述符驱动参数字段 |

描述符字段为 `id`、`label`、`options[{value,label}]`、`apply: next-turn|reconnect`、`supportsDefault`，以及可选 `semantic`、已知 `defaultValue`。共享层不识别厂商请求字段，也不对不透明值排序。单次最多 32 项参数，每项最多 128 个选项；这是数据边界，不是固定档位数量。

`AppConfig.modelParameterProfiles` 按 runtime/provider/model 范围存显示配置和默认值；ACP 的 provider 命名空间为 `acp:<preset>`，设置发现显式传 `piModeId`，Host 在保存校验时从命名空间恢复同一 preset，并拒绝与显式目标冲突。每项可配置 `options[{value,label,mappedValue}]`。`SessionMeta.modelParameters` 存显示选项的稳定 value。Host 将它解析成 adapter 声明的 canonical value，下发该轮 `values`；numeric budget 等类型转换由 adapter 完成。

IPC：`agentSession:getModelParameters(sessionId)`、`describeModelParameters(target)`、`setModelParameters({sessionId,changes})`、`saveParameterProfiles(profiles)`。普通参数读取只能使用现有模型快照；设置页手动点击读取参数时可携带 `refresh: true` 发起发现。手动刷新会启动 Claude、ACP（包括 Cursor）、Codex 等外部进程；IPC 对适用目标在调用前后检查来源、物理路径、工作区版本和引擎连接版本。无 source 的旧设置入口回落已登记的活动工作区；定时任务编辑传入该任务自己的 source，单独给 cwd 时必须唯一归属当前工作区的一个源根，否则返回不可用。Pi 与纯静态自定义描述读取已有配置或声明。`changes[id]=null` 清除覆盖，区别于原生 `off`；保存失败返回错误且不显示为成功。`agentSession:event` 的 `parameters` 事件同步控件与告警。普通 `config:update` 对该字段先作只读语义校验，再与其他配置一并提交；会话提交返回已校验的原生上下文解析结果，不在写入之后重新查询目录。

## 默认、生效与迁移

优先级：会话显式覆盖 → 模型范围默认 → runtime/provider 默认 → 引擎默认。空白“跟随默认”删除会话覆盖。已知引擎默认用于显示，支持省略时不传请求；未知默认保持未知，不伪造 medium。更高范围仅改名称/别名时保留原 canonical 默认；无该值的子集不猜测替代值。

开始一轮前捕获会话和配置，按 GUI Harness 白名单解析实际模型，并以该模型发现参数后冻结该轮 canonical values。连接和 send 消费同一快照。忙时修改持久化到下一轮，`next-turn` 档位切换复用连接。`reconnect` 参数和 Core 连接使用的目录能力进入连接键。模型在发现期间变化则拒绝旧参数设置，避免校验旧模型后写入新模型。

会话选择器一次提交模型与参数。宿主重验原生目录、工作区来源和会话配置版本，校验成功后写同一份会话记录。显式刷新更新该目录的提交票据，保留仍适用的草稿。其他源目录或 ACP 预设的刷新不影响当前票据。只有当前模型已保存显式值，或有匹配其运行时、服务商和模型的默认档时，缺少参数描述才会阻止发起回合。隔离会话仍在工作树执行。

Pi adapter 投影旧 `thinkingLevel`，旧单项模型和思考 IPC 保持兼容。调度的 `chat:switchModel` 组合入口同时校验并保存工作区模型与思考档，档位按字符串原样持久化。读取时根据当前模型确认该值是否可用。Core 目录更新时保留仍有效的打开菜单草稿，失效选择会提示并可清除。执行中的会话在下一轮使用已确认配置。

## Adapter 与可信边界

- Core 聊天、任务、调度和消息渠道共用[端点思考档位目录](model-providers.md#core-官方端点思考档位目录)。支持枚举、布尔开关和已声明预算范围内的预设值。预算选项显示实际 token 数。Pi 条目显示 SDK 声明和 SDK 默认。模式明确选择且仍适用于该模型时沿用模式档。会话和设置页的合法覆盖照常优先。
- Core 在回合快照中保存绑定和 canonical 值。更新绑定会在下回合重建匹配的连接并恢复会话，单独切档继续复用。Pi 条目用 SDK 原生映射生成请求。核验条目按目标端点写入原生值，跟随厂商默认时省略 effort 和思考开关。
- 目录未覆盖的模型继续使用本地 Pi 声明、显式模型能力与服务商映射。该兼容路径使用关闭、低、中、高、最高五档。自定义网关按它自己的地址匹配，独立于同名官方模型。
- Cursor 作为 ACP 预设，从 CLI 声明的 `configOptions` 读取模型及可用思考选项，不再读取旧 SDK 参数组。
- Claude Code 通过 SDK `supportedModels()` 发现用户原生配置中的模型，指定模型后只投影该目录的 `supportedEffortLevels`，按 `reconnect` 将所选值传为 SDK `options.effort`。默认模型身份未知时不猜测思考档。发现不发送用户提示词且禁用工具、MCP 和 hooks，使用受管子进程，失败、取消和回收异常显式反馈。CLI 版本、登录权限及真实推理尚待用户验收。
- Codex 从本机 CLI `model/list` 的 `supportedReasoningEfforts` 和 `defaultReasoningEffort` 生成描述，默认模型可使用 `config/read.model_reasoning_effort`。缺少某个模型的 `supportedReasoningEfforts` 时提示重新读取目录。引擎明确返回空列表表示无可选档位。adapter 按轮传 `turn/start.effort`，清除覆盖后沿用 CLI 原生配置。
- ACP 从选中预设的空会话 `configOptions` 中发现思考强度，仅识别 agent 声明的 select 选项；指定模型时先选择模型再读取其配置更新，不将原模型选项套给新模型。目录和参数按预设、源目录和模型持久保存。手动刷新读取默认模型和当前所选模型的参数，保留仍在目录中的其他模型参数。切换到未读取参数的模型后，点击刷新才探测。发现会启动引擎但不发推理请求。显式选择在连接时通过 `session/set_config_option` 发送，接入声明 `reconnect`，不支持原生恢复的引擎不能保证已开始会话切档后可续用。发现或确认失败时显示原因，不虚构档位；协议与真实引擎运行待用户验收。
- 通用注册 runtime 从可信 manifest 的 `capabilities.modelParameters` 读取静态描述。`ctx.dto.modelParameters` 是连接初始快照，第三个 send 参数是当轮快照；配置修改不改变 driver 的可信代码指纹，不绕过 TOFU 确认。模型动态发现由内置/专用 adapter 实现；首版 generic manifest 只声明静态集合。

## 验证边界

`test/core-reasoning-catalog.mjs` 逐项核对固定端点的 Pi 档位，覆盖条件请求、坏数据、离线重启、同名网关和请求序列化。`test/core-reasoning-coverage.mjs` 覆盖 40 个 Pi 预设、账号地址、Models.dev 补充、Ollama 探测、缓存和实际 SDK 预算/开关字段。组件测试还覆盖账号 URL 编辑和目录热更新。`test/e2e/core-reasoning-catalog.spec.ts` 用隔离的 Electron 验证 Token Plan 档位、硅基流动预算、会话保存和调度。

`test/model-parameter-acp-scope.mjs` 用受控 driver 覆盖指定 preset 读取、保存校验与冲突拒绝，不启动外部进程。`test/model-parameters.mjs` 覆盖非五档、各级默认、别名继承、非法映射、旧字段、创建和 reconnect；`gui-host-lifecycle.mjs` 覆盖连接期间冻结、忙时更新、模型不兼容清除、目录失败保留、旧 IPC 和提交后目录/会话变化；`workspace-config-ipc.mjs` 覆盖混合配置拒绝无部分写入；`codex-models.mjs` 使用受控 app-server 验证模型覆盖、high/low/清除及原生续聊 RPC。定时任务有 create/update 非法值及持久化回归。

本轮设置定向组件 48 项通过；`test/unit/model-parameters.spec.tsx` 的旧设置编辑/映射/保存用例单独通过。该文件另 5 个聊天菜单、新建会话与 surface 用例在扩展检查中失败，涉及旧菜单选择器及未提供模型快照 mock（`Object.hasOwn(undefined, ...)`）；这些用例不执行本次设置编辑器，不能列为本轮通过项，待对应聊天/创建测试夹具同步处理。失败日志为 `.tmp/worker-scope-components.log`，单独设置编辑器通过日志为 `.tmp/worker-scope-legacy-editor.log`。

本轮生产组件 Chromium 证据位于 `.tmp/ui-captures/agent-settings-scope-final-20261031/`：深浅主题、1040/390px，覆盖 Claude 通用/聊天/终端、Core 单页及窄屏实际参数默认值。IPC 全部 mock，不启动外部引擎，不替代真实原生/跨平台验收。

Electron 参数回归 `test/e2e/codex-model-menu.spec.ts` 覆盖 Codex 目录刷新失败后保留档位、参数选择与清除、重载恢复及原生 `turn/start`。安装包专用 MCP 用例条件跳过。测试使用本地 CLI 或 worker 夹具。外部推理权限、服务端是否接受及安装版更新需另行验证。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：通用模型参数描述符——运行时声明真实支持值，设置页编辑名称/映射/默认档，会话输入栏收进既有模型菜单按描述分组；思考强度只是可选 reasoning 语义之一。
- 为什么这样设计：配置只能重命名/选子集/映射到引擎声明值，不能凭配置创造引擎能力；每轮开始冻结 canonical values 快照（连接与 send 消费同一快照）；优先级=会话覆盖→模型→runtime/provider→引擎默认，空白「跟随默认」删覆盖；切模型仅清除经新目录确认不兼容的会话选择并反馈原因；旧 thinkingLevel/modelOverride.params 投影兼容。
- 明确不做：不伪造未知默认；不猜测替代值；临时目录失败保留存储值控件降级；配置修改不改 driver 可信指纹、不绕过 TOFU。
- 歧义点：无真决策（「配置不造能力」是硬边界；generic runtime 动态发现是否开放等真实接入需求再说，不影响现有五 runtime 的 review 判定）。
