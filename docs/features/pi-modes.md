# Pi 创造模式（自定义模式）

## 功能职责

内置 MetaAgent Core（内部兼容 ID `pi`）的**自定义模式**体系——Pi SDK 侧模式能力，**全量覆盖 pi 的可定制挂载点**（persona/工具面/思考档/模型/守卫/回合注入/输入变换/上下文瘦身/自定义扩展/主题/模型循环/pi settings 透传等 22 个维度；背景与取舍见 docs/research/dsh-replace-pi-research.md 与 pi-hooks-inventory.md）：

- 发起对话**之前**可为 Pi 会话选一个模式；产生内容后锁定（与 DSH preset 同款空白期语义）。
- 内置 **创造模式**（id `creator`）：选中后会话带创作引导 persona 与 `modes.*` 宿主工具，agent 在对话里帮用户创作新模式；**落盘即可选**（模式菜单下次打开即见）。
- 内置 **探索模式**（id `explore`）：只读探索——`tools.native=["read","bash"]` + `guards.bashReadOnly`（与 ask/plan 同源只读白名单）；persona 结论导向，产出结论报告；默认权限档 `ask`。
- 内置 **验收判定**（id `judge`）：只读 ∪ 测试执行——同上 native 裁剪 + `bashReadOnly` ∪ `bashAllow`（npm test / typecheck / build 等）；persona 验收官逐项 PASS/FAIL 带证据，产出结构化判定（含 `visualGate=pending` 为后续视觉验收门预留接缝）。
- 模式库是**应用级**（`userData/agents/pi/modes/`），跨工作区共享。

## 模式可自定义的面（pi 会话全部挂载点，对照 pi 官方 extensions/sdk 文档盘点）

| 字段 | 作用 | 缺省 |
|---|---|---|
| `persona` | 行为指令：追加在会话系统提示末尾（角色/流程/口吻/边界） | 无 |
| `tools.native` | 引擎原生工具**白名单**（`read/write/edit/bash` 的**非空**子集；空数组在落盘校验时拒绝——消费端按 `.length` 判空会把「全禁」反转成「全放」） | 全量四件 |
| `tools.nativeDeny` | 引擎原生工具**黑名单**（白名单之后应用） | 不屏蔽 |
| `tools.hostDeny` | 宿主工具**黑名单**（点号名精确匹配：`sessions.*`/`ui.notify`/`bgtasks.*`/`mcp`/`modes.*`）。用黑名单是刻意的：未来新增宿主工具时旧模式自动带上 | 不屏蔽 |
| `thinkingLevel` | 思考档位：`off/minimal/low/medium/high/xhigh/max`（连接期与每回合发送都显式设定） | reasoning 模型 `medium`，非 reasoning `off` |
| `model` | 钉住模型 `{providerId?, modelId?}`（须已在设置里配置；缺一侧回落全局）。钉住期间全局切模**不拆连接** | 全局激活配置 |
| `defaultGuiMode` | 选中模式时的默认权限档（`default/ask/plan/auto`）；不设=保持当前档位。**auto 档的激活约定**：应用 `defaultGuiMode=auto` 时模式条目与会话元数据落盘记 `mode='auto'`，但 `modeController` 保持 `'default'`——auto 档须经 modeController **显式激活**（走其确认流），不从会话元数据的 `mode='auto'` 自动生效；消费方不应由元数据反推当前权限档已在 auto（两本账刻意不同步） | 不改档位 |
| `systemPrompt` | **整体替换** pi 原生基底系统提示（loader 的 `systemPrompt` 选项）；persona 随系统提示发送，宿主说明和全局行为规约随首条引擎输入发送 | 不替换 |
| `contextFiles` | 是否加载 AGENTS.md/CLAUDE.md 等上下文文件 | `true` |
| `skillsPaths` | 旧字段保留读写兼容，不再扩展发现范围；连接时有值会告警，技能需链接到全局或项目 `.agents/skills` | 仅 `.agents/skills` |
| `promptPaths` | 附加 prompt 模板根目录（提供即开启 pi 模板发现——GUI 会话缺省关闭模板） | 关闭 |
| `temperature` | 采样温度 0-2（经 `before_provider_request` 钩子注入 payload） | 不动 |
| `providerHeaders` | 额外/覆盖 provider 请求头（经 `before_provider_headers` 钩子） | 不动 |
| `guards` | **硬守卫**（`tool_call` 钩子引擎级拦截，先于审批扩展，拒绝不弹卡直接给模型理由）：`guards.bashReadOnly` bash 只读白名单（与 ask/plan 同源 `isReadOnlyShellCommand`）、`guards.bashAllow` 额外放行正则（与只读 OR，如 test/typecheck/build）、`guards.bashDeny` 命令黑名单正则（命中 bash 工具 command，**不区分大小写**——Windows 上 `RM -RF` 与 `rm -rf` 等价；白名单之后应用）、`guards.denyPaths` 写路径保护子串（write/edit 的 path 包含即拦，大小写与 `\`/`/` 分隔符都归一） | 无 |
| `turnInject` | 回合前动态注入（`before_agent_start` 钩子）：模板每轮渲染后追加到本轮系统提示，占位符 `{{now}}/{{date}}/{{time}}/{{cwd}}` | 无 |
| `turnInjectStable` | **stable snapshot 注入**（须配 `turnInject`）：同一天内逐字节复用同一份渲染结果（翻日才重渲染），保 provider prompt/KV 前缀缓存命中；代价是时间只到「天」粒度新鲜。借鉴 pi-memory 的缓存友好注入 | 每轮重渲染 |
| `inputTransforms` | 输入变换规则（Host 侧发送前按序正则替换，最多 20 条） | 无 |
| `contextTrim` | 上下文瘦身（`context` 钩子）：toolResult 文本块超过 `maxToolResultChars`（200-100000）即截断；**截断不丢数据**——全文按内容哈希落盘 `userData/trim-cache/<sessionId>/`，截断标记带回路径，模型可用 read 工具分页取回（借鉴 pi-web-access 的「落盘+句柄」；同内容只写一次，落盘失败静默降级纯截断） | 不裁剪 |
| `extensions` | ⚠️ **自定义扩展路径**（TS 模块，jiti 加载）——可注册工具/命令/provider/压缩钩子等**一切扩展能力**。扩展以受管引擎子进程的本机用户权限执行任意代码，只放可信来源的模块 | 不加载 |
| `themes` | 自定义主题路径（TUI 主题；宿主 GUI 下基本无效果，为完整性开放） | 不加载 |
| `scopedModels` | 可切换模型集 `{providerId, modelId, thinkingLevel?}[]`（模型循环；缺失条目跳过并告警） | 不限制 |
| `tools.exclude` | 任意工具名黑名单（`excludeTools`，含扩展/自定义工具，最后应用） | 不排除 |
| `piSettings` | **pi 原生 settings 透传**（`SettingsManager.inMemory` 首参）——模式级覆盖 pi 全部设置面：`compaction{enabled,reserveTokens,keepRecentTokens}`、`retry{enabled,maxRetries,baseDelayMs,…}`、`shellPath/shellCommandPrefix`、`steeringMode/followUpMode`、`images.autoResize`、`thinkingBudgets`、`enabledModels` 等。键值不校验语义，pi 自行忽略未知键。当前 GUI 适配不向进行中的回合提交原生 steer/follow-up，相关设置不能让工作台消息绕过队列 | pi 默认 |

**归属宿主、不做成模式字段的**（2026-08-31 决策：代码级扩展口子重开，此前排除的 PTC/任意扩展/主题/模型循环已全部纳入）：会话树导航/switchSession/会话生命周期（宿主自管）、TUI 交互组件（宿主有自己的 GUI）、registerProvider 直配（经 `extensions` 扩展代码即可实现）、compaction 自定义摘要（经扩展钩子实现）、基础政策层与行为规约（persona 只追加不删改）。

> ⚠️ **安全提示**：`extensions` 意味着模式可携带以引擎子进程用户权限执行的任意代码，子进程隔离不是 OS 沙箱。模式文件在 `userData/agents/pi/modes/`（本机用户数据），创造模式里的 agent 也有能力创建带扩展的模式——只加载可信来源的扩展模块；不信任的模式先检查其 `extensions` 字段。

## 子代理与模式（2026-10-20 起不适用）

子代理（`bgtasks.spawn`）已随子代理通用化移除，改为带 `parentSessionId` 的普通 worker 会话（见 子代理通用化计划）。因此：

- 子代理**不再**支持 `mode` 参数指定 Pi 模式；派活时传的 `piModeId` 按 D8 **不继承**（Pi 模式含「首条消息后锁死」语义，creator 还挂 `modes.*` 工具，子代理套用父的创作/验收模式容易产生意外）。父若要指定，派生后按常规会话流程设置。
- `explore` / `judge` 两个只读预设仍可用于**普通会话**（选中即只读探索 / 验收判定），语义不变。
- 模式定义里的 `tools.hostDeny` 仍可写 `bgtasks.*` 等宿主工具点号名——那指 shell/wait/list/kill，与已删的 spawn 无关。

## 关键文件与入口

```
src/main/agentSession/drivers/pi/modes.ts   模式库：内置 creator/explore/judge + 用户目录扫描/CRUD/校验（零工程内依赖，可测试）
src/main/agentSession/drivers/pi/guardExtension.ts      guards 硬守卫（bashReadOnly/bashAllow/bashDeny/denyPaths；tool_call 引擎级拦截，先于审批）
src/main/agentSession/drivers/pi/modeHooksExtension.ts  turnInject/contextTrim 钩子工厂 + 输入变换纯函数
src/main/agentSession/tools/piModes.ts      modes.list/create/update/delete 宿主工具（creator 会话才挂）
src/main/agentSession/host/settings.ts     listPiModes/setPiMode（空白期锁+默认权限档+拆连接）
src/main/agentSession/host/connection.ts    ensureConnection 物化与生效模型判键（resolveConnectionModel 纯函数）
src/main/agentSession/drivers/pi/driver.ts  listPresets()、模型解析与受管子进程入口
src/main/agentSession/drivers/pi/workerHost.ts / workerEngine.ts  跨进程模式、工具、记忆与附件桥接 / Pi SDK 消费
src/main/agentSession/tools/registry.ts     buildSessionToolset 的 extraHostTools / hostToolDeny 通道
src/main/agentSession/prompt.ts             materializeGuiWorkerPrompt 的 modePersona 追加段
src/main/sessions.ts                        updatePiMode 持久化（SessionMeta.piModeId）
src/main/ipc/agentSession.ts + preload      agentSession:listPiModes / setPiMode
src/renderer/src/chatSurface/ChatSurfaceView.tsx    GUI Pi 分支装配 preset 胶囊数据（含「标准」虚拟条目）
src/renderer/src/components/agentComposer/    GUI Core 自定义模式独立菜单（ComposerToolbarLeft.tsx；roster 由 useComposerMenus.ts 读取，见 composer-rich-input.md 底部栏节）
```

## 数据流

1. Core 会话的 Composer 底部栏分别显示权限和模式菜单。模式菜单列出内置 creator/explore/judge、自建模式和「标准」虚拟条目（无自定义模式）；已有内容后仍显示当前模式并锁定其他选项。
2. 选择 → `agentSession:setPiMode` → Host 校验（runtime=pi、messages 为空、模式在册未损坏）→ `sessions.updatePiMode` 落盘；模式带 `defaultGuiMode` 时同步会话权限档 → 拆现有连接。
3. 下轮 send → `ensureConnection`：读 `SessionMeta.piModeId` → `readPiMode` 取定义 → persona 并进 `systemPromptAppend`；creator 模式把 `buildPiModeTools` 经 `extraHostTools` 注入；`tools.hostDeny` 在工具集装配时过滤；`tools.native`/`nativeDeny`/`exclude` 由 driver 通过 `filterPiNativeTools` 裁剪实际注册的引擎工具。首条宿主输入按过滤后的宿主工具集提供简短用法提示；`thinkingLevel`/`model` 经 connect input 进 pi driver（模型解析与连接重建判键都用「生效模型」；覆盖的 provider/model 不存在时经 `resolveLlmConfigWithReload` 回落激活配置，与 DSH 同语义）。
4. 创造模式会话里 agent 调 `modes.create` 落盘 `<id>.json` → 模式菜单下次拉取即见；对新会话生效。

GUI 忙时的普通后续用户消息由宿主排队；显式「立即」文本经 Pi SDK 原生 `steer()` 进入当前回合，扩展返回 `handled` 时才回到兜底路径。`idleOnly` 消息等待空闲后重新判断。独立调度面的 Pi 行为不由此改变；真实 GUI 与各平台的运行验收仍待用户执行。

## 权限与边界

- `modes.list` 为 read 类（auto）；`create/update/delete` 为 **edit 类**——default 模式弹审批卡（与 DSH 自建 preset 写工作区外走审批对齐）、auto 全自动、ask/plan 探索态直接拒。
- 内置 `creator` / `explore` / `judge` 不可占用/修改/删除；用户模式 id 规约 `[a-z0-9][a-z0-9-]*`，persona 1–8000 字；可选字段类型/枚举在落盘前校验。
- 模式文件损坏（JSON 解析失败/persona 缺失，或手改出校验外的字段值——如枚举外的 `thinkingLevel`、空 `tools.native`）→ 花名册标 broken（含原因）禁选；已在用的模式 connect 时读取失败则**降级标准模式并告警**，不挡会话。
- **链式命令判定（2026-09-17 收紧）**：guards 白名单（`bashReadOnly` ∪ `bashAllow`）对 `&&`/`||`/`;`/`&`/`|`/换行的链式命令按**顶层切段后逐段全称**判定——每一段都需命中（只读判定 ∪ 放行正则），任一段不命中即拦。放行正则只锚定段首，不能整链放行（judge 下 `npm test && rm -rf dist` 被拒、`npm test && npm run typecheck` 放行）；切段失败（引号未闭合/命令替换/非 /dev/null 重定向）一律拒。与 `isReadOnlyShellCommand` 同一切分器（`splitTopLevelSegments`）。
- fork 新会话继承源会话的 `piModeId`/`guiMode`/`modelOverride`（`createTerminal` 的 `inheritMeta`），延续原配置而不是回落全局。
- 同名 id 内置遮蔽用户文件（与 DSH system 根遮蔽语义一致）；非法文件名直接跳过。
- 回归：`test/pi-modes.mjs`（roster/CRUD/校验含扩展字段/损坏标记/工具装配直调）。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D06.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：Pi 会话自定义模式全量覆盖 22 个挂载点（persona/工具面/守卫/回合注入/输入变换/上下文瘦身/自定义扩展/主题/模型循环/piSettings 透传等），应用级模式库跨工作区共享；内置 creator（帮用户造模式）/explore（只读探索）/judge（只读∪测试执行的验收判定）。
- 为什么这样设计：模式发起前选定、产生内容后锁定（DSH 同款空白期语义）；hostDeny 用黑名单（未来新增宿主工具旧模式自动带上）；guards 是引擎级硬拦截先于审批（链式命令顶层切段逐段全称判定，Windows 大小写等价、切段失败一律拒）；损坏模式标 broken 禁选、在用模式损坏降级标准+告警不挡会话；contextTrim 截断不丢数据（全文按哈希落盘 trim-cache 带回路径，模型可 read 分页取回）。
- 明确不做：子代理不再支持 mode 参数（spawn 已删，piModeId 派活不继承）；内置三模式不可占用/修改/删除；同名 id 内置遮蔽用户文件；fork 继承 piModeId/guiMode/modelOverride（延续原配置不回落全局）；空 tools.native 落盘拒绝（防「全禁」反转为「全放」）。
- 歧义点：`extensions` 字段=以宿主进程权限执行任意代码，且 creator 会话里的 agent 自己就能 modes.create 出带扩展的模式（文档仅标⚠️「只加载可信来源的扩展模块」，无技术守卫）——A=近期上守卫（禁止 agent 经 modes.create 写 extensions 字段，用户手动选择含扩展模式时醒目确认——与 D03 gui-worker-session tool-rules 自我提权同向处理）／B=接受现状（模式库是本机用户数据，用户自责；review 记 P2 不升级）。推荐 A——这是「模型可给自己加宿主进程代码执行权」的闭环提权路径，安全面且守卫成本低。
