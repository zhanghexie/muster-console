# 模型服务商配置（providers · 思考强度 · 思考方言 · agent 工具面）

## 功能职责

应用内所有 LLM 流量的服务商配置中心：多服务商（baseUrl / API Key / API 协议 / 模型列表）、
- 调度 Agent 侧的 `llm.*` / `web.fetch` 受控读写工具；`llm.quota` 只读近窗失败率（剩余额度本地未知）。

- Core 聊天与调度的模型「最大输出 Token」可留空。目录模型沿用输出规格，Pi 会根据本轮剩余上下文缩小可用预算。完全未知的模型在 Chat Completions、Responses（含 Azure）、Google 和 Mistral 聊天协议中省略输出长度字段，由端点选择默认值；Anthropic Messages 必填 `max_tokens`，无规格时使用 SDK 模型描述的估计值。用户显式上限及单次调用预算优先。
- 「上下文窗口」和图片输入默认跟随端点模型目录。窗口是本轮输入与输出共享的总预算。未查到对应字段时，Core 使用 1,000,000 token 和图片输入作为保底。设置、真实 SDK 模型和调度会话共用此规则。清空窗口或在图片输入旁恢复默认，可移除手动覆盖。
- 设置 UI：设置 → 模型与输入（`ModelProviderPane.tsx`），本地草稿 + 底部「保存」两段式。
  页面将“模型服务商”和“文件与输入”作为两个上下排列的二级分区，不再使用横向页签；两组同时挂载，设置搜索直接定位对应项目。
  文件输入在同一分区内按文件限制、文档预览、视频画面与转换工具分组；模型原生输入能力仍在单个模型编辑器。
  数字草稿允许暂时清空后重新输入，避免默认值回填拼接；转换工具路径复用共享路径控件。
  默认服务商与连通测试分开，测试及结果放在地址/Key 所属区域。
  服务商区域复用 `settings-split`：左侧列表展示名称、默认与启停状态，右侧配置当前项，
  列表栏统一 224px，共用资源行在名称下显示启停与默认状态，提供本地供应商搜索（不改变详情选中或草稿）；详情内距 24px，标题/状态复用 SettingsDetailHeader，基本信息/连接配置/模型列表使用 SettingsDetailSection，标题无下划线且整组内容共用圆角边框；两栏独立滚动，详情隐藏滚动条但保留滚轮及键盘滚动；默认选中全局默认服务商，点击当前项不会收起详情。
  切换不修改全局默认项、不丢弃草稿，新增后选中新项，删除后回到剩余项；右侧可编辑名称。删除先打开共用 AppConfirmDialog，取消不改草稿，确认才移除，不再在原按钮上二次点击确认。
  新建内置或自定义服务商时模型列表为空；目录中的模型只是候选，不会整批写入。用户通过「从目录添加」或「＋ 添加模型」显式选择后才进入服务商配置。
  内容宽度不超过 620px 时改为上方有界滚动列表、下方详情，避免字段横向溢出。
  详情使用 `usePresence` + `mp-panel` 入场，供应商之间即时切换；
  组件回归见 `test/unit/model-provider-catalog.spec.tsx`，详情隐藏滚动条及滚动操作的浏览器断言见 `test/model-provider-scrollbar.mjs`。
  文件处理仍使用全局字段，模型编辑只包含原生能力；设置搜索支持预览/抽帧预算和转换工具定位。
- 配置类型：`LlmConfig` / `LlmProviderConfig`（`src/shared/types.ts`，含 `thinking` 三字段）。
- 落盘：`app.getPath('userData')/config.json`（`ConfigManager`，原子写）。

## 数据流

### 服务商模型目录刷新

模型列表底部的「刷新目录」读取当前草稿的地址、协议和 API Key，向对应服务商发起只读模型列表请求；未保存的地址/Key 也可以测试，不先写配置。初次进入只读本机缓存，不联网。内置目录提供初始候选和已知模型的能力/价格；成功刷新后，候选 ID 完全以服务商本次完整结果为准，新模型出现、已移除模型不再作为候选，成功空列表也会替换旧目录。刷新不自动添加模型，不移除已配置模型，也不更改默认模型；从目录选择后仍走设置草稿与保存流程。

- 入口：`ProviderModelCatalogPicker.tsx` → preload `config.providerModelCatalog(provider, refresh)` → `config:providerModelCatalog` → `agent/providerModelCatalog.ts`。`refresh` 缺省为 false，只读缓存；true 发起请求。目录供应商的原生协议来自 `piConfigSync` 提取的内置模型 `api`，自定义端点使用所选协议，不按厂商名称猜测。
- OpenAI Chat/Responses 与 Mistral 使用归一化地址的 `GET /models` 和 Bearer Key；DeepSeek 官方例外使用根路径 `GET https://api.deepseek.com/models`（[官方模型列表接口](https://api-docs.deepseek.com/api/list-models/)，推理请求仍使用 `/v1`），并读取 `context_window`、`max_output_tokens`、`input_modalities` 和 `effort.supported_levels`；Anthropic 使用 `GET /v1/models`、`x-api-key` 与 `anthropic-version`；Gemini 使用 `GET /v1beta/models` 和 `x-goog-api-key`，仅保留支持 `generateContent` 的模型并去掉 `models/` 前缀。分页消费 Anthropic `has_more/last_id` 和 Gemini `nextPageToken`，同一请求总计 12 秒、最多 100 页/20,000 个模型；循环游标、无效结果或任一页失败均不发布部分清单。
- 凭据只发给配置的端点，拒绝重定向，不自动改用其他厂商服务器。HTTP 401/403 等错误直接展示；404/405/501 提示服务商没有列表接口并允许手动添加。Azure deployment、Bedrock、Vertex 等不同模型发现协议暂不支持此刷新入口，明确提示手动添加，保持已有聊天协议支持范围。Token/Coding Plan 网关也必须实际提供模型列表接口，不能保证兼容聊天就支持列举。
- 按服务商 ID、端点、协议、凭据的 SHA-256 身份缓存至当前实例 `userData/provider-model-catalogs.json`，路径由 `userDataStorage(...).file('provider-model-catalogs')` 解析；保留最近 64 份完整快照。缓存不保存 Key 明文，刷新成功原子写入，重开设置及重启可复用。不同 Key 的权限结果不互用；相同身份的在途请求去重。缓存读写失败用窗口 tip 提示，目录保留上次快照。
- 目录开合使用 `usePresence` + `mp-panel`；关闭时立即 inert/aria-hidden。刷新期间禁用按钮、显示品牌加载；更改端点/Key/协议、切换服务商或卸载后，旧异步结果不进入当前页面。已知模型继续使用内置能力。远端候选可携带实际返回的名称、上下文、输出上限、输入类型及 `reasoning` 标记。刷新失败时，内置服务商回退到 Pi 内置目录；自定义服务商回退到该端点上次成功的远端目录。只有明确返回成功的空列表才会显示为空，已添加和默认模型照常保留。
- 列表接口的 `effort.supported_levels` 用于识别 `reasoning: true`。Core 按[端点思考档位目录](#core-官方端点思考档位目录)显示选项，供应商列表刷新负责查找可添加的模型。目录未覆盖的自定义供应商可以在模型编辑器声明「深度思考模型」，再用「高级 · 思考强度映射」配置档位。
- 回归：`test/provider-model-catalog.mjs`（当前 pi-ai 内置目录中全部可刷新协议的服务商逐一走本地 HTTP、原生目录协议提取、认证、分页/超时、失败保留、空列表替换、缓存隔离与重开）、`test/unit/provider-model-catalog.spec.tsx`（交互、内置目录失败回退、自定义目录失败保留、状态、旧请求隔离、开合及新增模型）、`test/unit/model-provider-catalog.spec.tsx`（父页原生协议接线）、`test/e2e/provider-model-catalog.spec.ts`（隔离 Electron + 真实 preload/IPC + 本地 HTTP）。生产组件夹具已检查深/浅主题、1000px/390px 的刷新与失败保留状态，长模型 ID 在窄容器换行。服务商官方协议参考：[OpenAI](https://developers.openai.com/api/reference/resources/models/methods/list)、[Anthropic](https://platform.claude.com/docs/en/api/models/list)、[Gemini](https://aistudio.google.com/api-reference/models/list-models)。当前验证在 Windows 完成，代码共用 Node fetch/存储解析，无平台专有分支；macOS/Linux 真机与用户实际服务商在线请求尚未验收。

```
UI updateLlm（本地草稿）
  → 保存 → IPC config:update（ipc/workspaces.ts）
  → ConfigManager.update → normalizeConfig（normalizeProvider 白名单重建，thinking 在列）
  → llm 变化时 syncPiConfigFromApp → userData/muster-core/models.json + auth.json
    + settings.json（shellPath；请求级重试预算 syncPiRetrySettings：
      enabled/maxRetries=6/baseDelayMs=2000 ≈ 累计 126s，用户手工配过 retry.maxRetries 则尊重）
  → 当前回合继续；下一轮按实际连接配置摘要判断是否重建
消费方：resolveLlmConfig（调度/GUI 会话/headless/文本工具等）
```

**注意（2026-09-05 修复的回归）**：`normalizeProvider` 曾按白名单重建 provider 而
`thinking` 不在名单里——load/update 都过 normalize，导致思考配置在保存/重启后静默丢失。
现 `thinking` 经 `normalizeThinking` 白名单校验后保留（levels 各档非空字符串、
`reasoningEffortField` 仅认 true、`thinkingFormat` 走 `LLM_THINKING_FORMATS` 枚举）。
回归测试：`test/llm-thinking-config.mjs`。

GUI Core、调度和设置保存共用 `userData/muster-core`，模型和凭据从工作台配置生成。旧 Pi 目录里的数据由各自的使用方管理，工作台不读取或迁入。测试使用临时 userData，验证配置重新生成到新路径，并校验外部 Pi 文件的哈希。

Pi GUI 与调度连接通过 `agent/llmConnectionIdentity.ts` 对选中服务商的协议、地址、凭据、思考映射、兼容能力以及选中模型配置生成摘要，再决定是否复用连接。显示名称、其他服务商或未选中模型的变化不会触发重建；密钥只参与摘要，不写入连接标识。设置保存和 `llm.upsertProvider` 都在下一轮使用新配置，进行中的回合不会因修改模型配置被主动中断，重建后沿原会话文件或 resume token 续聊。

连接准备与发送前分别校验配置；若异步准备期间选中配置变化，旧连接会被回收或拒绝发送，并提示重试。加载目录后同步最新全配置，避免覆盖期间对其他服务商的修改。入口为 `host/connection.ts`、`host/turn.ts`、Pi driver `connect` 与 `agent/providers/piProvider.ts`；回归见 `llm-connection-identity.mjs`、`pi-provider-connection-identity.mjs`、`gui-host-lifecycle.mjs` 和 `workspace-config-ipc.mjs`。

Pi GUI 的预检与 connect 共用 `resolveLlmConfigWithReload`（空 Key 重载后仍缺则提示填写），校验服务商启用、Base URL 与声明模型。创建前带入会话模型覆盖或模式钉模型，未配置全局默认不会误拦有效显式模型。运行期凭证/余额失败保留服务商原始错误（含 401/402），不静默切换服务商；`sessions.observe({includeHistory:true})` 同步导出错误状态。真实 SDK 本地服务商回归见 `test/pi-provider-errors.mjs`。

一次性维护脚本 `scripts/sync-pi-config-once.mjs` 默认从当前平台 Electron appData 下的 `muster-console/config.json` 读取配置（Windows Roaming、macOS Application Support、Linux XDG_CONFIG_HOME 或 ~/.config），同步到同一 userData 下的 `muster-core`。用 `--user-data-root PATH` 选择其他工作台数据根。读写路径均经过存储解析器检查。脚本只输出提供商、模型标识和目标目录，导入模块不会执行同步。

Pi 配置同步按协议处理 Base URL：`anthropic-messages` 保留网关前缀并合并末尾 `/v1`，
由 Anthropic SDK 追加 `/v1/messages`；例如 MiMo 的 `https://api.xiaomimimo.com/anthropic`
必须保留此前缀。其他协议保留现有的 `/vN` 检测及 `/v1` 补全（归一化真源
`normalizePiBaseUrl` 在 `shared/piCatalog.ts`，同步/探针/设置页目录判定三处共用）。
小米的默认 `thinkingFormat:'deepseek'`、`requiresReasoningContentOnAssistantMessages`
与 `off:null` 映射只用于 `openai-completions`；用户显式配置的五档映射仍跨协议透传。
同步回归见 `test/flexible-llm.mjs`。

pi 目录分支按「id 命中目录 **且** baseUrl 与目录官方端点一致（归一化比对）」判定
（model-providers F-03）：不一致的存量条目（目录化前用 deepseek/zhipu 等旧 preset id
建的企业网关/反代）按自定义 provider 处理——UI 侧 baseUrl 可编辑、协议/思考面板保留，
同步侧保留 `p.api` 与用户思考映射、模型写全量条目；目录 meta 缺端点信息时无从比对，
维持目录判定不回归。设置页 `isCatalog` 与 `piConfigSync` 目录分支共用该语义，
回归见 `test/model-provider-catalog-quirks.mjs` 与 `test/unit/model-provider-catalog.spec.tsx`。

模型编辑草稿保留上下文和图片开关的显式值。自动字段读取当前目录，目录刷新时保留已输入的修改。只打开再保存仍会跟随目录。最大输出及推理标记按打开时的预填差异保存。新写入的图片开关标记显式意图。旧版手动添加时保存的 `false` 若没有显式标记或其他模型覆盖，并且该端点经核验支持图片，会按自动值解析。

设置页、[首次设置](first-run.md)与 `llm.testConnection` 共用 `agent/openaiClient.ts` 的连通性探针。
`anthropic-messages` 请求 `{base}/v1/messages`，归一化时保留网关前缀并将尾部 `/v1` 合并成一段，发送 `x-api-key` 与
`anthropic-version:2023-06-01`，载荷为 `model/messages/max_tokens:1`；
`openai-responses` 请求 `{base}/responses`，其余 completions 系协议请求
`{base}/chat/completions`——非 anthropic 协议的 base 先经 `normalizePiBaseUrl`
补 `/vN`（model-providers F-01：探针结论须与运行时一致，网关不带 /vN 不再误报失败）。
HTTP 错误正文（含 3xx）、12 秒超时与延迟回报保持共用，凭据只发往填写的地址。协议路径/认证/载荷及错误回报的本地 HTTP
回归见 `test/llm-connection.mjs`（归一化差异回归 `test/model-provider-catalog-quirks.mjs`）。
思考差分探针仍只支持 completions/responses。

## Core 官方端点思考档位目录

Core 使用安装包内置的 Pi 目录及按供应商发布的 Pi 公开分片。分片经 `Last-Modified` 检查后覆盖内置条目。设置里的 40 个 Pi API Key 预设使用这一数据源。OpenCode、OpenCode Go 和 Radius 预填公共地址。Azure OpenAI、Bedrock、Vertex、Cloudflare Workers AI 与 AI Gateway 接受账号端点，匹配官方 URL 形态后沿用模型协议。对 Azure 自定义部署名仍需用实际部署对应的模型身份。 [Pi 公开目录示例](https://pi.dev/api/models/providers/deepseek)

`scripts/build-core-reasoning-catalog.mjs` 从 Pi、Models.dev v2 和目录仓库的 `data/model-capabilities.json` 生成 `reasoning-v2.json`。`models` 提供思考覆盖，`capabilities` 按实际端点、协议和精确模型 ID 提供 `contextWindow`、`input` 和来源。官方核验的字段覆盖同端点的上游数据，未知规格使用本机 SDK 的同端点条目或保底。`input` 可包含 text、image、audio、video、pdf。旧客户端沿用原字段，新客户端随已有请求读取规格；一次客户端升级后，模型数据可继续单独发布。 [线上目录 v2](https://muster-model-catalog.pages.dev/reasoning-v2.json) · [上游许可](https://muster-model-catalog.pages.dev/reasoning-v2-licenses.txt) · [Models.dev schema](https://github.com/anomalyco/models.dev/blob/dev/packages/core/src/schema-v2.ts)

`muster-model-catalog` 的 `main` 发布两个版本。`v1/reasoning.json` 存放需优先应用的逐模型核验规格。`reasoning-v2.json` 刷新 Pi 快照与 Models.dev 补充。对现有序列化形态增加模型、档位和默认值可独立发布。来源核查、生成、客户端校验和 Pages 发布流程见 [Muster 模型目录维护技能](../../.agents/skills/muster-model-catalog/SKILL.md)。 [目录仓库](https://github.com/zhanghexie/muster-model-catalog) · [线上核验条目](https://muster-model-catalog.pages.dev/v1/reasoning.json)

`coreReasoningCatalog.ts` 启动和每四小时条件刷新两个公开目录及配置过的 Pi 分片。Electron 请求只带公开目录所需的头。校验成功后原子保存，HTTP 304 沿用快照，超时、无效响应和网络失败保留上次有效目录。`agentSession:coreReasoningCatalogUpdated` 通知设置页重新读取 `config:piCatalog`，Core 会话用 `config:coreModelInput` 读取当前图片能力。选中模型的有效线上窗口或图片标记改变时，下一轮重建其 SDK 连接。Ollama 的已配置回环地址另外读取 `/api/show` 的 `thinking.values` 和 `thinking.default`，模型探测不发对话、不传凭据、不跟重定向。旧版 Ollama 缺少元数据时保持未确认。 [Ollama 能力发现](https://docs.ollama.com/capabilities/thinking#discover-a-models-thinking-controls)

`getConfiguredCoreReasoning` 用已配置端点、协议和模型 ID 查找能力。适用时依次使用 v1 核验条目、已有自定义映射、Ollama 实测、Models.dev 补充、Pi 公开分片和内置 Pi。模式保存的旧 `reasoning: false` 不会遮住匹配到的档位。SDK 同步与档位解析共用账号端点规则。Pi 快照提供原生序列化及 SDK 默认。补充条目选择枚举、布尔开关或范围内的三个透明预算值，使用对应的 `thinking.type`、`enable_thinking`、`reasoning_effort`、`reasoning.effort` 或 `thinking_budget`。不支持强度时沿用厂商默认行为。

## 目录未覆盖时的思考强度映射

OpenAI completions 的指令角色能力由 `LlmProviderConfig.compat.supportsDeveloperRole` 显式声明。`false` 使用 `system`，`true` 允许 SDK 对推理模型使用 `developer`，缺省沿用已确认官方端点的目录内模型能力。自定义端点、缺少官方端点元数据或目录外模型均默认 `system`；不按厂商名或域名片段猜测支持。其他协议不下发该兼容字段。设置中的自定义服务商高级项提供默认、明确不支持、明确支持三个选项；保存和重启保留 `false`，恢复默认删除覆盖。`llm.upsertProvider` 接受同名 `compat` 对象，字段缺省保留，`null` 清除；`llm.listProviders` 返回该非敏感声明。

`test/llm-role-compat.mjs` 通过隔离配置、真实 Pi ModelRuntime 和 SDK 请求构造器核对最终角色，覆盖未知端点、同名反代、目录能力继承、显式覆盖、非推理模型、其他协议及保存/重读/工具更新；请求在网络发送前截获。连接探针仍是极小连通性请求，不代表已验证完整聊天的工具、指令角色或推理参数；真实服务商接受情况须用对应会话验收。

目录未覆盖的自定义端点可以继续使用手工映射，配置入口沿用关闭、低、中、高、最高五档。清除覆盖后，Pi 根据模型能力选择默认档，推理模型从 medium 计算，其他模型使用 off。请求由以下配置生成。

1. **值映射** `thinking.levels`：五档 → 服务商载荷值字符串（留空=该档不可用，可重复映射），
   经 piConfigSync 落成 pi 模型定义的 `thinkingLevelMap`。空值下发为 `null`（请求时跳过）。
2. **effort 开关** `thinking.reasoningEffortField`：显式 true/false 时（且协议为 openai-completions）
   写入 pi compat `supportsReasoningEffort`；未指定时由 Pi 按端点和模型自动判断。
3. **方言** `thinking.thinkingFormat`：思考控制字段叫什么/长什么样由 pi-ai 的
   `compat.thinkingFormat` 决定（默认按 provider id/baseUrl 探测：deepseek/zai/openrouter/
   openai 等十种）。显式配置用于纠正探测误判（网关代理/自建服务常见，例：智谱被探测为
   不支持 effort），仅 openai-completions 协议生效。

优先级（piConfigSync compat 对象字面量后写覆盖先写）：**用户显式 thinkingFormat >
小米默认（deepseek）> pi-ai baseUrl 探测**。

`chat:context` 和 `chat:switchModel` 使用已有公开快照与本地 Pi 目录。工作区档位写入 `agent-models.json` v2 envelope 的 `thinking` 字段，启动时对仍存在的 pre-release `agent-thinking.json` 做一次性归并。目录未覆盖时，调度用当轮模型的 SDK 声明校验本地档位。

方言决定字段名、映射决定值（pi-ai `api/openai-completions.js`）：openai → `reasoning_effort`、
openrouter → `reasoning.effort`、zai/deepseek → `thinking:{type}`(+可选 effort)、
qwen → `enable_thinking`、string-thinking → `thinking:"值"`。

## Agent 工具面（capabilities）

| 工具 | 危险 | 说明 |
|---|---|---|
| `llm.listProviders` | 否 | 全量服务商列表 + 当前默认；**apiKey 恒为掩码 `***configured***`** |
| `llm.upsertProvider` | **是** | 按 id 新增/更新；未提供字段保留原值；apiKey 空/掩码=保留原密钥；**不改默认服务商** |
| `llm.setDefault` | **是** | 切默认服务商/模型（模型必须在该服务商列表内） |
| `llm.testConnection` | 否 | 复用 `testLlmConnection`；可测已存配置（密钥内部解析）或草稿配置 |
| `web.fetch` | 否 | 抓 URL → 正文文本（HTML 去标签；text/json 直通；截断上限 10K 字符） |

- 写走 `ctx.config.update`（自动 syncPiConfigFromApp，下一轮检查连接配置）；实现
  `capabilities/hosts/llm.ts`、`hosts/web.ts`；注册 `capabilities/executor.ts`。
- dangerous 工具经 executor 强制 `ui.confirm`（120s 超时即拒绝）——**headless/定时链路
  无人值守改不了配置**，这是刻意约束。

## 服务商实测速查（2026-09-05 官方文档 + 真实端点差分验证）

| 服务商 | 协议 | 强度参数 | 档位 | 关思考 |
|---|---|---|---|---|
| 智谱 GLM-5.3 / 5.3-Flash | responses 端点 `/api/v1/responses` 实测认 `reasoning: {effort}` | completions 用 `reasoning_effort` | 仅 `low`/`high`/`max`（默认 max；medium/high 官方映射 high） | **不可关**（`thinking.type:disabled` 报错），off 档映射留空 |
| DeepSeek V4（v4-flash/pro） | completions：`thinking:{type}` 开关 + `reasoning_effort` | 强度 low/high/max（默认 high；请求 medium 实际映射 high） | **可关**：`thinking.disableAtOff: true`（piConfigSync 自动打 off 哨兵，pi-ai 发 `thinking:{type:'disabled'}`） | |

差分验证方法：`llm.testConnection` 带 `thinkingProbe:{effort}` 分别以 low/max 调用，比对
`reasoningTokens`（智谱实测 31~81 vs 1996，参数真实生效而非被静默忽略）。两家的 thinking
配置来源为工作台的 `config.json`，生成的 SDK 目录为 `userData/muster-core/models.json`。

## 能力设计复盘（2026-09-05 四项已落地）

1. **`reasoning` 模型标志是总闸**：模型没标 `reasoning: true` 时任何思考参数都不会下发。
   ✅ `llm.upsertProvider` 结果带 `warnings`：配了 thinking 却无 reasoning 模型时告警。
2. **协议决定有效字段**：✅ `llm.listProviders`/upsert 结果带 `thinkingEffect`
   （`levels` 恒生效；`dialectFields`=thinkingFormat/reasoningEffortField/disableAtOff 是否生效；
   `offCanDisable`=off 档能否真关闭），agent 配置前先看再配。
3. **off 哨兵语义显式化**：✅ 新契约 `thinking.disableAtOff: boolean`——用户/agent 只声明
   「off=关闭思考」，piConfigSync 按协议/方言门控翻译为 off 哨兵（仅 completions+DeepSeek 系；
   GLM-5.3 系/OpenAI 禁止关闭，不翻译防误发垃圾字段）。UI 在 DeepSeek 系 completions 服务商
   显示对应勾选框。
4. **带参数的探针**：✅ `llm.testConnection` 新增 `thinkingProbe:{effort,thinking,prompt}`，
   按协议附带思考参数发极小请求并回传 `reasoningTokens`；差分用法写进工具描述。

## 已知边界

- **apiKey 安全面**：agent 永远读不到明文（读掩码、写保留原值）；改密钥只能用户在设置里改。
- **提示注入残余风险**：`web.fetch` 抓回的网页内容理论上可诱导 agent 改 baseUrl 等字段；
  兜底是 dangerous 确认卡（人工过目关键字段）。
- **SSRF 粗防**：`web.fetch` 拒绝回环/私网/链路本地（字面量 + DNS 解析后逐一校验），
  仅 http(s)；不做重定向逐跳复查。
- **HTML 提取为简化版**：去 script/style/head/标签 + 实体解码 + 空白规整，无 readability
  正文识别；charset 仅按 utf-8 解码。
- `thinking.thinkingFormat` / `reasoningEffortField` 仅 openai-completions 协议生效；
  anthropic-messages 等协议思考由 pi-ai 各协议原生逻辑处理（thinkingLevelMap 仍生效）。
- `llm.upsertProvider` 仅在「当前无任何激活服务商」时才自动置激活；其余情况切默认必须显式
  `llm.setDefault`（二次确认）。

## 操作等待反馈

连通性测试在当前服务商的测试按钮内显示单色品牌加载，接口成功/失败返回即结束。GUI 模型目录刷新通过 Promise 返回完成信号，刷新按钮只等待目录请求，不关联模型回合 busy。 组件与场景清单见 [品牌加载动效](brand-loading.md)。

## 附件与原生输入配置

模型高级选项仅配置原生音频/视频/文档能力、MIME 白名单、混合媒体限制与视频传输方式，保存为 LlmModelConfig.attachments；图片能力沿用 multimodal。AI 工具 llm.upsertProvider 提供显式 schema，并在后端严格校验，错误类型或全局预算/工具路径字段会拒绝保存。能力按字段合并，未提供的保留，false 可显式关闭；llm.listProviders 返回同一能力结构。预览页数、文件/图片/文字限制及抽帧策略属于 AppConfig.attachmentProcessing，在模型与输入设置编辑，所有模型与会话共用。

实际发送取当前会话覆盖/模式指定模型；预处理期间配置改变则拒绝本次受理并保留草稿。只有模型声明和适配器均支持的类型才原生发送。配置项不代表远端能力探测，协议矩阵和生命周期见 [多模态输入](multimodal-input.md)。

FFmpeg 与 LibreOffice 路径属于本机环境，在模型与输入设置的「本机文件转换工具」配置，存入 AppConfig.attachmentTools，所有模型与会话共用。旧模型路径在全局配置缺失时迁移，当前模型优先，再按服务商/模型顺序补齐；显式清空全局路径后使用系统 PATH，不重新回填旧值。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：全部 LLM 流量的服务商配置中心（多服务商/思考五档→载荷映射/方言/agent llm.* 受控读写工具）+ 设置页 pi 目录驱动添加（42 家 provider 填 Key 即用）。
- 为什么这样设计：apiKey 安全面（agent 恒读掩码、写保留原值，改密钥只能用户在设置）；写配置走 dangerous ui.confirm 门（headless/定时链路无人值守改不了配置）；normalizeProvider 白名单重建（thinking 曾静默丢失已修，回归守卫）；piConfigSync 同步 Core 私有配置并失效会话；目录模型只写差异字段防钉死目录；协议路径差异（anthropic-messages 保留 /anthropic 前缀等）按实测落配置。
- 明确不做：不代填/不外泄 apiKey；web.fetch 提示注入残余风险靠 dangerous 确认卡兜底；不做余额查询（quota 只读近窗失败率，剩余额度本地未知）；运行期凭证失败保留原始错误不静默切换服务商。
- 歧义点：目录供应商 Base URL 只读（「填 Key 即用」；企业网关/自建反代场景只能走自定义供应商重建条目）——A=保持只读（目录项保持目录真值，代理场景有自定义出口，thinkingFormat 显式纠正已覆盖探测误判）／B=允许对目录项覆盖 baseUrl（网关场景常见，但产生「目录 id+非目录 base」混合形态，兼容矩阵扩大）。推荐 A。注意：本功能 2026-10-24「Pi 1.4 目录化」改造未验收，此项确认宜在该改造验收后复核。

## 模型出口的配置写入回执

`llm.upsertProvider` 的模型回执保留服务商标识、端点/协议/启用、密钥配置标记、归一化 thinking/compat/thinkingEffect、modelCount 与 firstModelId、warnings 和默认服务商说明，不再回显整份 models 数组。firstModelId 支持新建时宿主回落到 default 模型后的下一步设默认/探测。`listProviders` 仍为读取完整有效模型声明的唯一入口；程序调用者继续收到完整 provider。回归见 `test/resource-tool-result.mjs`。
