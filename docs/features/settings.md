# 设置页（整窗）

## 职责

顶栏工作区下拉菜单的「工作区设置…」打开当前工作区编辑弹窗（AgentFloat / CreateWorkspaceModal），不跳转本设置页；工作区主题色仍在本设置页「外观」管理。

全部应用设置共用一个页面实例：用户从工作台打开时整窗覆盖，内部面板桥可在中栏后台挂载，左侧分组导航、右侧内容页。负责加载 / 编辑 / 保存 `AppConfig`，并承载各子页（服务商、Worker、调度 Agent、通知、远程访问等）。

外观页「你的头像」提供 24 个内置抽象符号和上传图片；选择即时保存并更新聊天，内置符号只保存白名单 id，显示名独立。用户设置的 emoji 网格与自定义输入已移除，历史配置兼容显示。工作区在新建/编辑窗口选择独立的 [36 个软件/游戏图标](workspace-icons.md)，同样不再提供 emoji 控件。详见 [会话消息头像](chat-message-avatar.md)。

界面不额外标注「立即生效」「保存后生效」或同义保存时机说明；需要保存的设置由现有保存按钮、未保存条和离开确认提示。适用范围、实际结果、错误与必要的会话重载边界仍保留。

阅读层级：页标题为 h1、分区标题为 h2、设置行与字段标题为 h3。分区标题统一使用 title 字阶（标准 17px），设置项标题使用 control 字阶（14px），说明使用 ui 字阶（13px）；双栏资源详情的功能分组和快捷键两大分组保留 17px 分区字阶。行标题和 FieldRow 标签统一 control 字阶 / 500 / primary 前景；字段说明保留常规字重与二级前景，不继承标题强调。分区说明与 h2 放在同一 `.s-sec-heading` 内，4px 紧邻并用 `aria-describedby` 关联整个分区，右侧动作对齐标题顶部，标题组与设置项之间单独留距；`.s-row-d` 使用 ui 字阶（标准 13px）、二级文字色和 1.6 行高。表单控件与左侧导航继承用户选定字体（默认 OPPO Sans）；路径、代码等显式等宽样式继续生效。

当前统一布局：全部设置页内容列 `max-width:1120px`，常规两侧留白 44px，窄窗口 22px。`SettingsContent` 提供 48px 分区留白（`--settings-section-gap`），二级标题及动作在外，其下整组内容使用透明底、1px `--border-subtle` 圆角边框和 12px 内边距；一级和二级标题下都不画分隔线，一级标题随页面整体滚动；列表与详情独立滚动的页面保留各自的滚动范围；块内设置行上下各 8px、最低 44px，字段标签与输入间距 6px，窄布局标签到控件 8px。页头仅显示标题，不重复介绍。设置行统一 `SettingRow`、长字段 `FieldRow`、路径 `SettingsPathField`，普通动作 `btn tiny`。资源管理使用列表与详情，服务商、Agent、Skills/MCP/应用能力及文本功能统一接入 `SettingsResourceItem` 与 `settings-resource.css`：独立列表/详情整体使用 1px `--border-subtle` 圆角边框（`--radius-card`）与 16px 内边距；置于二级分区内容框内时复用外框，不重复描边；窗口高度不超过 600px 时压缩 Agent 底部入口间的空白，控件尺寸不变；背景透明；内部为 224px 列表栏、56px 最小行高、28px 图标槽、16px 列表右距、24px 详情内距，选中/悬停状态消费同一 canvas context。Harness 接入的页签可整体滚动，资源框有界，框内清单和详情各自滚动，到边界后可继续滚到下方的自动派活。能力管理的页签外层不滚动，列容器填满可用高度，清单和详情阻断边界滚动向外传播。两页的目录页签、搜索和底部入口都位于清单外，窄窗口保留详情切换与返回。Harness 左栏的目录范围使用有间距的下划线页签，底部默认与通用入口提供选中、悬停和键盘焦点态；模型操作复用 flex 工具栏，成员列表使用网格与原生复选框。相关样式与仍在使用的组件一并保留，浏览器场景覆盖目录切换与布局。资源页头使用 `SettingsDetailHeader`，按名称/图标、操作、元信息、说明排布；正文功能组使用 `SettingsDetailSection`，双栏详情采用 32px 分组间距，标题与圆角内容框间留 8px。长路径使用同款整行字段，短开关右对齐，各页保留自己的窄屏导航。范围选择留在资源工具栏；选择对象的行保留选中底色，普通设置分区没有灰底卡片。

> 节标题曾用 CSS 计数器渲染 `01/02/03` 序号，用户 2026-10-19 裁决「标号不好看」后整段移除；守卫用例改为反向断言：`.s-sec-h h2::before` 不得存在，组件场景断言 h2 的 `::before` 为 `none`。


点击普通设置页分区标题可打开当前滚动区域的纵向「快速跳转」索引，选择标题后定位对应分区并将焦点交给标题；双栏资源详情中的分组标题为普通标题，不提供跳转。索引支持键盘操作、Esc 和点击空白处关闭，关闭后恢复焦点；切换设置页也会关闭索引。

## 关键文件与入口

所有 `.settings-tabpane` 使用 `scrollbar-gutter: stable`，整页滚动和能力管理内部滚动都预留同一侧的滚动条空间，避免切页或窄列出现标题水平偏移。覆盖层滚动条平台由浏览器按同一规则处理，不硬编码平台滚动条宽度。

| 文件 | 作用 |
|------|------|
| `src/renderer/src/components/settings/SettingsSectionJump.tsx` / `settings-section-jump.css` | 分区标题触发、当前滚动区索引、定位与焦点管理 |
| `src/renderer/src/components/settings/SettingsModal.tsx` | 页面外壳：导航、页内搜索、各页叠放淡切、未保存条、离开确认；导出 `countFormChanges` |
| `src/renderer/src/components/settings/SettingsSurfacePortal.tsx` | 模态与中栏间迁移单实例的容器；优先使用浏览器支持的保状态移动，回退普通 DOM 移动 |
| `src/renderer/src/components/settings/shared.tsx` | 行式原语：`SettingsSection` / `SettingsRows` / `SettingRow` / `FieldRow` / `Switch`（支持 testId）/ `Segmented` / `AdvancedDetails`；`SettingsCard` 为存量化内容保留 |
| `src/renderer/src/components/settings/*Pane.tsx` | 各子页；`GeneralPane` + `ShellSettings`（通用）、`ThemePane`（外观）、`WorkerPane`（Agent）、`NotifyPane`、`RemoteAccessSettings` 等 |
| `src/renderer/src/components/settings/SettingsContent.tsx` / `settings-content.css` | 连续设置页模板：统一列宽、分区间距和窄容器布局；分组内容使用共用圆角边框 |
| `src/renderer/src/components/settings/WaitingTipsDialog.tsx` | 提示目录查看/搜索/重新读取与路径定位，窗口焦点及退出行为 |
| `src/renderer/src/components/settings/SettingsDetailHeader.tsx` | 资源详情共享标题、图标、元信息、说明与操作区 |
| `src/renderer/src/components/settings/SettingsResource.tsx` / `settings-resource.css` | 所有资源列表共用行、状态与详情分组；分栏几何、SearchBar 输入壳隔离、成员复选框及窄容器规则 |
| `src/renderer/src/components/settings/SettingsPathField.tsx` / `settings-path-field.css` | 共用路径字段：只读/编辑态、复制完整路径、打开文件管理器、局部错误及迟到回执隔离 |
| `src/renderer/src/components/settings/WorkerChatModels.tsx` / `ClaudeAccountSettings.tsx` | 聊天专属模型与参数范围、Claude 本机配置读取；不配置终端 |
| `src/renderer/src/components/settings/WorkerDetailViews.tsx` | Agent 任务视图：键盘页签、首访加载、保活与隐藏交互隔离；flat 行组模板在 settings.css opt-in |
| `src/renderer/src/interactionPreferences.ts` | 本机交互偏好：localStorage 读取与校验、即时更新、同源窗口 storage 同步、系统减少动态效果监听及 React 订阅 |
| `src/renderer/src/chatSurface/transcriptScrollController.ts` | 会话滚轮增强、主动跳转与贴底跟随的可打断控制器；消费交互偏好，不修改消息或原有跟随权限 |
| `src/shared/commandPalette.ts` | `SETTINGS_GROUPS`（常用 / AI / 连接 / 其他）、`SETTINGS_TABS`（id、group、label、desc、lead）、`SETTINGS_FIELDS` 搜索索引、`collectSettingsHits` |
| `src/renderer/src/styles/settings.css` | 外壳、`.s-*` 行式原语、开关、主题卡片、保存条 |
| `src/shared/i18n/locales/fragments/settings.ts` | 设置页新增文案英文 |

入口：`App.tsx` 打开设置（默认 `general` 页，`focusItem` 可直达某一项）；命令面板「设置」分组命中后也走同一入口。

内部 `panel:open-content-request` 的 `settings` 类型默认后台挂载，不改变现有焦点；显式聚焦时显示中栏并把焦点交给搜索框，先检查活动文件编辑器未保存状态，确认页面实际可见和聚焦后才答复。请求取消时移除待处理回执；工作区变化或结果超时按未知处理。`panel:snapshot-request` 报告设置页是否准备、可见和有未保存改动。关闭内部设置面板前拒绝未保存设置、未保存活动文件、用户当前打开的模态页及并发操作；分屏关闭等待设置引用退出并卸载后才答复，不终止会话进程。`SettingsModal` 在模态和嵌入之间共用组件实例与草稿；隐藏时不注册模态 Esc、不截获工作台快捷键；用户确认放弃并离开时显式还原草稿。常规模态页只管理直接父级的工作台遮罩；保活容器由可信调用方显式传入应用外壳，退出模态时释放遮罩。中栏窄容器按自身宽度收缩导航。公开 `host.panel` 尚未注册。

设置草稿的未保存数量以顶层字段比较，已共享同一引用的值直接视为未变化，其余值仍按原来的序列化结果比较；即时生效字段不计入。`test/unit/settings-form-changes.spec.ts` 覆盖共享引用和独立副本。

## 页签与分组

| 分组 | 页签 id → 显示名 |
|------|------------------|
| 常用 | `general` 通用 · `appearance` 外观 |
| AI | `worker` Harness 接入 · `agent` 模型与输入 · `capabilityManagement` 能力管理 · `capabilities` 调度 Agent · `memory` 记忆 · `textTools` 文本工具 |
| 连接 | `notify` 通知 · `channels` Channels · `remoteAccess` 远程访问 |
| 其他 | `keybindings` 快捷键 · `localStorage` 本机存储 · `about` 关于（含反馈令牌） |

页签 id 是外部契约（focusItem、命令面板、测试）。旧 `feedback` 页签经 `normalizeSettingsTab` 映射到 `about`，`feedback-credential` 搜索或跳转定位到关于页的反馈配置；反馈区始终提供审核入口，版本信息仍在加载时反馈配置也可使用。能力管理内保留 Skills / MCP / 应用能力 / 宿主接入四个分类，CLI 使用工作台工具的基础配置状态置于独立宿主接入页，失败数在分类栏常显，启动自动配置、失败警告与重试，不设集成页或高级设置。cap-catalog / inbound-mcp 锚点保留，旧 integrations 顶层 id 仍经 normalizeSettingsTab 映射到 capabilityManagement；inbound-mcp 定位自动切到宿主接入。

本机存储页使用同一资源列表和主题下拉，保留紧凑统计与占比条；扫描、可清理范围、确认和结果语义见 [本机存储](local-storage.md)。

通用页「会话展示 → 等待时显示功能提示」默认开启，表单保存后生效；完整提示列表由「查看全部提示」打开独立窗口，关闭显示开关后仍可查看。窗口支持搜索、重新读取和本机 JSON 文件定位；读取失败在设置行与窗口内可见。文件读取、轮换、失败提示和更新边界见 [聊天转写渲染层](chat-transcript.md#等待回复时的功能提示)。

通用页「会话展示 → 只显示当前思考」默认开启，属于表单配置，点击保存后生效；关闭后恢复展示与保存新的思考片段，历史思考摘要固定显示「正在思考中」。此开关只作用于工作台会话展示，不调整模型思考强度或运行时上下文。详情与历史数据边界见 [聊天转写渲染层](chat-transcript.md)。

通用页「任务与工作区 → worktree 存储目录」使用共用 SettingsPathField（可手输、复制、打开位置），「选择目录…」复用 `workspaces.pickDir`，取消不改动。通过「打开位置」访问应用默认根时，`shell:revealPath` 可在首个任务创建前建立该目录，创建失败会就地显示原因。自选路径遵循原有草稿、撤销和保存模型，新任务使用新根，已有任务按保存路径继续工作。路径必须绝对，建树时拒绝位于源仓内部的存储根。

通用页「滚动与动效」即时生效，支持恢复交互默认值：滚动手感为原生 `native`、利落 `crisp`、柔和 `soft`，默认原生；每格距离倍数默认 1、范围 0.5–2，仅对利落/柔和识别到的离散滚轮生效，原生档禁用该控件。原生档不接管滚轮或触控板。动效为跟随系统 `system`、轻微 `subtle`、减少 `reduced`，默认跟随系统；系统要求减少动态效果时始终优先。轻微缩小公共面板/菜单的位移和缩放，减少跳过过渡与循环动态。搜索锚点分别是 `interaction-scroll-feel`、`interaction-scroll-distance`、`interaction-motion`。

主题与服务商的删除确认使用 `AppConfirmDialog`（portal 到 body），不再使用行内按钮变字或限时武装；取消不改数据，确认才走原删除路径。定时任务、工作流删除/清空历史及关闭工作区也复用同一弹窗。MCP 删除与技能归并本来已在独立弹窗中，保留带作用域快照/预览的确认流程。

## 通用页布局

通用与 Agent 内容列统一 max-width 1120px。`SettingsContent.tsx` + `settings-content.css` 为连续设置页提供统一按钮/字段、主分组留白与圆角内容边框，以及真实容器窄布局（非开关行控件下移，长路径输入与动作分行）。不使用重复的生效徽标或孤立说明；操作语义在必要说明及原保存条中表达。

- 语言与文字：语言、字体、字号与实时样本；仍即时保存。
- 滚动与动效：本机偏好和恢复默认值；原生模式下距离控件禁用。
- 会话与记录：思考展示、等待提示和会话结束日志；写 AppConfig 草稿，原整页保存/撤销合同不变。日志从「电脑」移入此组，仍说明消息门槛与模型发送范围。
- 任务与工作区：隔离工作区路径和定时任务防休眠；目录选择/手输只改草稿，取消不变、失败就地反馈。

`WaitingTipsDialog.tsx` 使用 usePresence + mp-panel/mp-scrim，portal 避开整页变换；modal 最小宽度明确覆盖存量规则以适配窄窗口。打开时使主内容 inert、搜索获焦，Tab 在窗口内循环，Esc/关闭/遮罩退出后恢复触发按钮焦点；关闭不改草稿、不改变等待提示开关。提示路径与程序路径复用同一 SettingsPathField；窗口本身仅提供查看、搜索与定位文件，不伪装为 JSON 编辑器。

定向回归包含 general-settings、waiting-tips、worktree-storage-browse、interaction-preferences、font-settings、worker-keep-awake、thinking-display 与 settings-page。生产组件截图使用模拟 IPC，验证深浅主题、宽/窄布局、主分组与提示窗口，不打开真实目录选择器/文件管理器。

## Agent 产品设置

「自动派活」是 Harness 资源框下方的独立二级分区，设置搜索定位到标题。低、中、高、极高按任务复杂度固定展示，随内容宽度采用四列、两列或一列。空档在首次添加候选前只显示在界面上，候选的思考强度在模型选择器中单独设置。「特殊功能」按名称和用途维护自定义池，新增或展开编辑时才展示表单。每档可维护多个候选，以列表顺序决定替换优先级。图标操作支持键盘上移、下移、启停和移除。显式后继在「故障替换」中管理，保存时校验环路。

`WorkerRoutingPane` 与 Composer 的模型引用复用 `WorkerTargetDialog` 和统一的 `HarnessModelPicker`。GUI 和 CLI 目录按源文件夹及 Harness 身份读取缓存，点击「刷新模型目录」才触发探测。目录、运行时和模型可见设置变化时重新读取状态。候选显示 Harness 图标、模型、表面、参数和当前状态，冷却恢复时间可在状态提示中查看，也可清除冷却。

「应用范围」在「全局默认」和「仅当前工作区」间切换，当前工作区范围显示本次表单绑定的工作区名称。工作区默认使用已保存的全局配置，第一次编辑即可建立完整覆盖草稿。「仅此工作区留空」保存空覆盖。「恢复跟随全局」预览已保存的全局候选，确认保存时移除覆盖。两层草稿分别保留，更改纳入底部未保存栏、Ctrl/Cmd+S、放弃和离开确认。两层都改动时先保存工作区，再保存全局。版本冲突时保留失败层草稿，用户可以重新载入。

设置用 `workerRouting:read` 读取指定层，用带版本的 `workerRouting:save` 写入该层，恢复继承使用 `workerRouting:followGlobal`。存在未保存的跨 Harness 授权时，先保存或撤销再切换校验源文件夹。看板任务卡展示宿主所选配置和切换原因，展开可查看请求档位、各次尝试和引擎已确认的字段。

仅工作区覆盖中的 Codex GUI 候选可在「跨 Harness 权限」中授权执行中的任务切换到此候选。先逐项选择引擎提供的权限配置、审批方式和审批者，再勾选授权并保存。候选使用所选目标权限，审批方式和文件访问范围可能随之改变。授权绑定当前工作区和所选源文件夹。取消勾选可以撤销，修改候选配置或权限选择后需要重新授权。当前支持 Codex GUI 的内置权限配置，宿主保存时验证原生权限。

`worker` 页签显示名为「Harness 接入」，位于 AI 分组首位。「引擎配置」分区采用有界的产品列表 → 详情，高度在 360px 至 720px 间随窗口变化。标题右侧「刷新」手动重新检测本机，并刷新当前工作区各源目录下可用的外部 Harness 模型及思考档。进度弹窗按标题区定位，按引擎和源目录展示进度与错误，可在刷新过程中关闭和重新打开。内容列允许扩展到 1120px，列表与详情独立滚动，外层页面滚动可抵达下方同级的「自动派活」。宽度不超过 680px 时详情就地覆盖列表，返回或资源框聚焦时按 Escape 可回列表，保留草稿、列表滚动和触发焦点。

「我的 Agent」展示内置、发现和明确配置的入口；「全部支持」包含未安装项与安装指引。一个产品聚合聊天与原生终端，缺少能力则不显示对应入口。外部引擎以「通用 / 工作台聊天 / 原生终端」表达真实作用域，仅创建存在的页签；`WorkerDetailViews.tsx` 首访挂载、随后保活，隐藏内容 aria-hidden + inert，沿用 usePresence + xfade 和方向键/Home/End。Core 使用连续单页，不制造安装/启动维护页。Agent 页保留默认与通用入口；本机命令行环境放在设置「通用」页，搜索锚点指向该页；Claude 锚点打开聊天页。

### 设置项的归属

| 功能 | 通用与资源管理 | 工作台聊天 | 原生终端 |
|---|---|---|---|
| 启用入口 | 通用页独立启用两种入口；ACP 按 preset 保存 | 不影响另一入口 | 不影响另一入口 |
| 账号与配置 | 只说明真实共享关系；不因同名产品假定共用 | Claude 默认读取本机配置，独立目录仅作用于聊天；Cursor ACP 使用 CLI 登录或环境变量 | 使用原生配置与启动环境，不消费聊天隔离开关 |
| 程序与连接 | 不把 GUI 预检程序当成 CLI 安装证据 | 聊天程序/ACP 已确认启动命令 | 独立 CLI 命令及其检测结果 |
| 模型与参数 | Core 的服务商、密钥、全局默认模型在设置「模型与输入」管理 | 菜单成员、参数默认值及名称/映射；固定当前引擎，模型范围从真实目录或已保存范围选择 | 在原生配置/CLI 内设置；不展示 GUI 模型编辑器 |
| 技能与 MCP | 跳转能力管理设置资源和使用范围 | 由聊天适配器注入或原生注册 | 由终端适配器配置或原生读取 |
| 名称、脚本与删除 | 内置品牌名不作为启动设置重复编辑 | 内置适配器由应用维护 | 额外参数仅作用于终端；内置脚本由应用分发 |

相同技能目录路径不代表两种入口具有相同写入行为；Claude 聊天的会话内 MCP 注入与终端 `.claude.json` 文件配置是两条接入路径。内置适配器的目录、JSON 字段、注册方式等是只读实现声明，不在普通 Agent 设置中重复铺陈；其声明和实际写入仍由能力管理及宿主接入消费，未删除底层能力。

Core 只显示启用、模型菜单与参数设置；不显示「关联资源」区块，模型服务商和能力分别在设置「模型与输入」和「能力管理」中管理。Core 无外部安装检测、启动参数、脚本或删除按钮。内置运行时删除会在重新播种时恢复、内置脚本随源更新，因此这些操作不再作为普通产品设置展示。

模型参数编辑绑定当前 runtime；ACP 通过 `piModeId` 发现指定 preset，通过 `providerId=acp:<preset>` 保存独立范围。Host 在读取和保存校验时由该命名空间恢复 preset，并拒绝显式目标冲突，不能回落到默认 OpenCode。Core 的模型选项保留真实 provider/model 身份；已保存但暂不在目录中的范围仍可编辑。默认值直接展示，名称与原生选项映射置于明确的自定义编辑入口，保留原 API 和旧通用编辑器合同。

启用和模型成员即时保存；终端参数与模型参数配置保留显式保存。Claude 隔离开关在配置写入成功后才更新 UI，失败保留原值并报错；聊天页按配置目录变更读取本机文件，先选择独立目录，再在其下显示当前配置目录和默认模型。读取结果明确为只读，不展示文件存在推断出的鉴权状态；登录、服务地址与模型仍由 Claude Code 原生配置管理。路径字段和「打开位置」空间足够时同行，窄容器自动换行。Cursor ACP 使用 CLI 登录或环境变量，不再在设置页保存 SDK Key。模型目录默认读缓存，显式刷新或读取参数才发现；安装/配置问题也在通用页可见。完整适配边界见 [GUI Harness 接入](gui-harness-integration.md)。

### 可推广的设置页模板

此模板已推广到全部设置页：普通表单由设置壳统一包裹 `SettingsContent`；Agent 与能力管理保留自身主从布局，并采用同一内容宽度、行式字段与分段节奏。`SettingsViews` 承载任务分类或文本工具对象导航，首次访问后保活，隐藏视图 inert，支持设置搜索定位。

- **先按用户任务分内容，再选容器**：先区分共用项、各工作方式独有项与只读实现信息；真正可编辑的项留在对应作用域，资源策略跳转唯一管理入口。只有存在不同作用域才拆页，Core 等简单页面保持连续。
- **说明紧贴所属设置**：程序范围说明归入「程序与连接」，账号说明归入「账号与配置」；不在页签下放没有归属的提示段。改变配置来源的控件在结果前面，读取时清除旧结果，迟到回执不覆盖新来源；配置保存成功与失败在来源控件附近显示，不插入页头推动产品标题。
- **统一路径字段与动作**：目录和完整程序路径使用 `SettingsPathField`；已有名称的列表使用同一 `SettingsPathControl`，路径可选择复制，编辑态保留显式保存。可打开的目录与文件提供「打开位置」，复用 `shell.revealPath`，失败就地显示；已知不存在或不可访问的存储路径保留状态，相对路径、命令名和 URL 不作为本机绝对路径打开。主路径动作、重新检测、重新读取、模型目录刷新和安装指引统一使用 `btn tiny`。
- **页面 → 任务 → 设置项**：最多一层功能节标题，行标题只命名设置项，不复述父标题。列表用名称、图标、状态识别对象，不重复增加分类小标题。
- **一种分组语言**：二级标题和操作留在框外，整组内容共用透明底圆角边框；内部行组与已有资源布局不重复描边，功能之间保留 48px 留白。灰底留给输入框、选中与悬停。
- **控件表达真实含义**：能力启停用开关，集合选择用复选框；短控件在行右，路径和长输入占整行。常用列表直接展开，编辑脚本/读取参数等动作才打开实际编辑内容。
- **操作结果就在操作附近**：即时设置和显式保存保留各自真实合同；错误常显、不能因折叠而丢失。已发现程序不等于登录或推理成功，安装状态的边界在状态提示中说明。
- **隐藏不丢草稿**：任务视图首访再加载，切换保活、隐藏 inert；小容器返回对象列表并恢复滚动和焦点。消费现有主题、字体与动画 token，跨平台不引入平台专属样式分支。

本轮验收使用生产组件 + 模拟 IPC 的 Chromium 夹具（`.tmp/ui-captures/agent-settings-paths-final-20261031/`，12 张，本机/独立配置与路径打开失败），覆盖深浅主题与 1040/390px；未启动外部引擎或再次运行 Electron 安装扫描。该证据证明组件布局与接线，不证明外部引擎连接或三平台真机表现。

回归：`settings-path-field` 覆盖 Windows/macOS/Linux/UNC 路径、只读/编辑态、打开失败重试与迟到回执；`worker-product-settings`、`worker-pane-layout`、`worker-pane-claude`、`worker-pane-preflight`、`worker-pane-no-workspaces`、`settings-page` 的定向组件用例；`test/acp-agent-settings.mjs` 验证保存/重载和后端隔离，`test/e2e/agent-settings.spec.ts` 验证隔离 Electron 的真实 IPC 与重载链路。执行结果以本次验证记录为准，不等于所有外部引擎或跨平台真机验收。

## 其他页面的信息组织

- 模型与输入：“模型服务商”和“文件与输入”纵向排列，设置搜索直接定位相应项目。服务商详情头部集中展示名称、启用与默认状态；模型添加、目录与刷新入口位于「模型列表」标题动作区，目录候选通过按钮锚定的非模态 dialog 浮层选择，打开时聚焦模型搜索，单击候选添加后关闭；Esc 关闭恢复触发按钮焦点，点击外部关闭保留点击目标焦点。模型行直接显示默认状态，不另列星标图例。地址和 Key 所在区域承载连通性测试及结果。文件输入框内再分文件限制、文档预览、视频画面与转换工具，模型原生输入能力属于单个模型。数值字段允许暂时清空后输入，失焦空值回到默认显示，外部草稿撤销仍同步。
- 能力管理：Skills / MCP / 应用能力 / 宿主接入使用主分类导航，全局/项目范围只选择资源编辑对象；Skills 只展示并管理全局和项目 `.agents/skills` 两个通用根，使用共享只读路径控件，不再提供按 harness 的入口关联或自定义目录登记。编辑、删除、握手、继承只读与独立即时保存合同保留。
- 调度 Agent：提示词/全局规则与只读运行信息分开，注入清单、Worker 白名单和初始化信息直接展示在运行信息分类。切换不丢编辑草稿，设置搜索可打开对应分类。
- 外观保留主题对象、工作区主题色、配色编辑器与头像；颜色组属于专门编辑器，可按组展开。文本工具改为功能列表/编辑区，AI 创建入口与默认模型保留，切换不丢草稿。
- 快捷键区分系统快捷操作与工作台动作；系统操作名称和组合键使用带标签字段，动作表保留搜索与按键录制。通知保留提醒条件和免打扰；远程访问展示全局 Channel 远程输入、网页访问和 Webhook 配置，其他地址按需查看。旧版飞书连接区及其扫码、绑定、命令速查搜索项已移除，账号统一在 Channels 接入。旧 `feishu` 页签深链映射到 `remoteAccess`，不提供旧桥接口。记忆模型配置与关于页更新状态使用普通行式布局。

本轮统一检查使用 `test/settings-redesign-visual.mjs`：生产设置壳与真实子组件、全 IPC 模拟，深浅主题 1440px 窗口和 700px 窗口（保留 264px 导航，检查窄内容列）。覆盖模型连接、文件规则与工具路径、技能/MCP 详情，以及其余页面的首屏和相关页底。浏览器守卫检查一致宽度、横向溢出、数值同行与窄模型详情对齐。截图在 `.tmp/ui-captures/settings-redesign-20261031/`；应用能力目录与宿主接入也使用相同模板并纳入检查。视觉检查修正了短数字纵排、模型详情缩进、窄按钮换行与 Webhook 字段分组。该证据限于本机 Chromium 与模拟 IPC，不证明外部模型连接、原生文件管理器或 macOS/Linux 真机效果。

## 模型供应商（pi 目录驱动）

- 数据源为 pi-ai 内置目录（models.dev 同步，42 家 provider，含价格/窗口/思考档/多模态/compat）：主进程 `piConfigSync.primePiCatalogSnapshot`（会话建立时 prime，`providers/all` 生成目录）经 IPC `config:piCatalog` 供 UI；目录不可用时回落组件内静态 PRESET。
- 「＋ 添加供应商」目录驱动：按目录列 provider（authMethods 过滤 oauth-only、已添加置灰、模型数徽章），顶部搜索按名称/id/模型 id 过滤；「本地与其他」放目录没有的静态项（Ollama 等），自定义入口常驻（有搜索词时隐藏）。
- 目录供应商＝填 Key 即用：provider id 命中目录时 Base URL 只读展示、不出现 API 格式与思考强度映射（协议/思考档由目录决定），config 只存模型 id/name，价格窗口不落配置；`piConfigSync` 对目录内模型走 `modelOverrides` 字段级继承（只写用户差异字段，不写推断值防钉死目录），目录外模型仍写全量条目。
- 自定义供应商才开放调节（baseUrl / 六协议 / Key / 思考映射），模型按 id 跨 provider 抄目录默认值，未命中回落静态正则；compat 只透传用户显式项（reasoning_effort 开关三态：true/false 显式下发、缺省交 pi 按 URL 自动探测），小米镜像保留 DeepSeek 方言特判。
- 模型徽章（窗口/多模态/思考）优先目录真值、显式配置优先；「从目录添加（N）」按未添加目录模型增量补充。全新配置不预装服务商或默认模型，旧 OpenAI 连接字段同样留空；DeepSeek 仅作为可选目录候选。已保存的用户和旧版连接配置继续保留。成本链：pi-ai 各 API 自动按目录价实算 `usage.cost`，`callMetrics` 透传 `costUsd`（>0 才落，未知价≠免费）。
- 测试：`test/flexible-llm.mjs`（快照/modelOverrides/思考契约/compat 缺省）、`test/pi-provider-errors.mjs`（真 SDK 目录端到端）、`test/unit/model-provider-catalog.spec.tsx`（菜单/徽章/从目录添加/收缩/搜索）。

供应商区域采用左列表、右详情的主从分栏，默认选中全局默认服务商；重复点击不会收起，切换保留草稿。窄容器（≤620px）改为上列表、下详情，布局复用 `settings-split`，不参与普通行组/折叠列表样式。详见 [模型服务商](model-providers.md)。

## 数据流与保存模型

- 打开时 `config.get` 得到 `cfg` 与 `baseline`；`capabilities.get` 得到调度提示词正文基线。
- 表单项经 `set(patch)` 改 `cfg` 草稿；`countFormChanges(cfg, baseline)` 按顶层键 JSON 比较计数（加上提示词是否改过），大于 0 即出现底部「N 项更改未保存」条。
- **即时生效键**不进草稿计数、也不随保存写入：claude、cursor、mcp、mcpByWorkspace、runtimeOverrides、themeId、themeByWorkspace、workspaceAccentDefault、keybindings、locale、globalPanelGlow、frameEffects、frameBackdrop、frameBackdropByWorkspace、userAvatar（各自在控件里直接调 IPC）。工作区列表与 activeWorkspaceId 快照也剔除，避免表单保存把主题色或工作区切换回滚。远程访问、Worker 内置入口设置、Shell 手工路径等页内操作也都即时生效。
- **本机交互偏好**独立保存在渲染层 localStorage 的 `muster.interaction.v1`，结构为 `{scrollFeel, scrollDistance, motion}`，不扩展 `AppConfig`、不调 `config.update`，不参与未保存计数、保存或撤销。`main.tsx` 在 React 挂载前初始化；控件走 `setInteractionPreferences`，`useInteractionPreferences`/`subscribeInteractionPreferences` 订阅同窗更新，同源其他窗口通过 `storage` 同步。无效/损坏存储回默认，距离作有限数值校验并限幅；存储不可用时保持该窗口的即时偏好。
- **主题色入口**位于外观页，支持全局默认 / 仅当前工作区、启用开关、头像色/色板/自定义色与恢复跟随全局；命令面板和设置搜索共用 `appearance-accent` 定位。工作区编辑弹窗只管理名称、目录、头像与代码索引。
- 保存：`config.update`（剔除即时键、写 `dispatcherAppendPrompt`），成功后更新基线并闪「已保存 ✓」，**不关页**。Ctrl S 同效。保存入口只读取本次操作前保存条的实际 offset 宽高，成功提示及整条退场期间保留该尺寸，按钮移除不会使保存条骤缩；原 `max-width` 随容器尺寸同步钳制，不增加持续测量或布局尺寸动画。消息槽保持原位，普通提示通过 `usePresenceValue` 保留纯文字退场，成功文字与勾号由独立 `usePresence` 以 opacity / 2px 位移交替，使用 `--dur-menu` / `--dur-micro` 和共享曲线，减少动态沿用全局偏好。旧文字立即 `aria-hidden`，不复制按钮或延迟保存、确认、撤销和离开回调；再次编辑立即恢复真实草稿操作，失败仍走「知道了」确认，保存并离开成功后立即执行离开。`test/unit/settings-save-feedback.spec.tsx` 覆盖待保存、成功尺寸保留、快速再次编辑/保存、错误与离开确认，以及旧控件移除和可访问状态；中间帧、窄容器与深浅主题仍需真实浏览器验收，组件测试不代表视觉已通过。MCP 列表由资源专用 IPC 保存，设置草稿不写回。
- 撤销：`cfg` 回基线，并递增 `formEpoch` 让表单页重挂，丢弃页内派生草稿。
- 离开（Esc / 返回工作台）：有未保存更改时保存条切成「离开前要保存吗？」，再按 Esc = 放弃并离开；搜索框有字时 Esc 只清空搜索。

## 搜索与跳转

- Ctrl K 聚焦导航顶部搜索框；结果取 `collectSettingsHits(query, 主题色键)` 前 8 条，上下键选择、回车跳转。
- 切到目标页后查找 `[data-settings-item="<id>"]`，最多等 3 秒供异步内容挂载。展开所在 `<details>`，滚到分区标题或目标行。分区在标题旁短暂显示细线，单项使用细描边，保留原底色和文字色。编辑草稿时延续原定位的消退时间。
- 契约：`SETTINGS_FIELDS` 每个 id 都必须在设置组件源码里有同名 `data-settings-item` 或原语 `item=`，由 `test/command-palette.mjs` 守护。

## 视觉与交互约定

能力管理的“应用能力”通过现有 `catalog:get` 读取 `getCatalogInfo()` 的只读暴露投影；不经会构建提示词的 `capabilities.get`。原生直接工具、直接域入口、经域入口调用的动作和内部定义分开显示，按主进程 roster/preset/run domain 真源派生；可按暴露方式、使用方及名称/说明/路由搜索。详情列出入口、action、内部目标、用法文档和角色条件；只读目录不证明现有会话加载或执行授权，dangerous 也不等于每次必弹确认。计数只计当前过滤结果，内部动作不计原生入口。目录失败显示重试，顶部刷新读取当前目录，旧页/旧工作区响应丢弃。

能力管理复用 SettingsModal 的标准页头（只显示标题，标题下无细线）和共享设置列 1120px/左右44px及26px正文间距，不隐藏页头或在内部重复标题。四分类和范围选择复用 `Segmented`，刷新放在分类工具栏，搜索复用 `SearchBar`，MCP 中转开关使用设置行组。Skills 资源区保留列表/详情自滚；MCP 页在内容过高时整体可滚动，资源区保留最小可用高度，切分类恢复顶部；Skills 的数量诊断默认折叠且高度有界，不串入其它分类。应用能力窄屏详情沿用 presence/inert、Escape、返回焦点和列表位置保持。组件回归覆盖这些交互；Electron 专项另与调度 Agent 页头按深浅/宽窄对照位置和计算样式。实现上，资源列表/详情页壳由 `CapabilityManagementResourcePage` 承载，父面板保留清单加载、作用域、对话框和 Host/Catalog 生命周期，避免拆分改变 API 与动画合同。

- 整窗「框与页」：导航画在框色上（工作区强调色渗入），内容为 L1 页；顶部 36px 为拖拽带并避让 Windows 标题栏按钮。
- 分区使用节标题、圆角内容边框与 48px 留白；二级标题没有下划线，`SettingsSection` 的右侧槽承载框外动作，`SettingsRows` 不再附加灰底卡壳。开关右置，短数值用窄输入，路径、URL、提示词等长内容独占字段行。即时保存与底部草稿保存继续按实际配置合同区分。
- 开关仍是原生 checkbox 的 CSS 皮肤，键盘/可访问名不变；主动作前景与背景成对。`Segmented` 保留内容宽按钮、原生焦点与 `aria-pressed`，用常驻且不接指针的 `.s-seg-selection` 中性底片识别选中：宽度即时校准，仅 transform 平移过渡，文字与点击区域不移动。初次布局、容器尺寸/标签/字体变化及保活页重显时校准，隐藏或零宽不覆盖有效位置；观察器和字体监听在卸载时清理，不做逐帧测量。底片接管后按钮自身的选中填充立即变透明，避免半透明背景叠色，不叠暗阴影。禁用控件用显式 `fg-disabled`，菜单和分段按钮不对禁用项施加 hover；设置搜索与能力管理搜索各只有一层输入壳。原生选择框箭头直接使用主题前景，QR 黑白属于内容。
- 进出场：页面 `mp-scrim` + 内容页 `mp-panel`，搜索浮层与保存条 `mp-pop`，页签切换 `xfade`，免打扰时段 `acc` 手风琴。
- 原生 Mica/Vibrancy 下，设置根 DOM 的 layout effect 给直接父 `.app-shell` 添加 `has-settings-page`，真实卸载时移除；`out` 退场期间继续保留，Suspense 尚未提交设置 DOM 时不隐藏工作台。材质 CSS 只给两个直接兄弟容器 `.chrome-bar`、`.main-view` 设置即时 `opacity:0` 与 `pointer-events:none`，后代即使显式 `visibility:visible` 也不能透出，不向大会话后代逐项写隐藏样式。相同生命周期保存这两个容器原有的 `inert` 属性并启用 inert，禁用底层键盘、焦点和辅助技术访问；真实卸载或回退实底时恢复原值。只监听根 `data-native-material` 属性以跟随晚到的原生材质确认，不观察会话子树；其他挂载容器或非目标兄弟不受影响。不再用根级 `:has()`，焦点仍由原设置页挂载流程取得。
- 13 个轻量页壳与滚动容器常驻；页内容首次访问才挂载，之后切页保持原 DOM、草稿、选区与滚动位置。导航、搜索、初始深链及旧页签别名都经同一个 active/visited 状态更新，首次进入保留现有 `xfade`。未访问页的查询/订阅不会挤占首开；撤销仍通过 `formEpoch` 重置已访问页的本地表单。
- 能力管理页保活，隐藏时只标记 Skills/MCP 清单失效，激活后合并读取；详情、关联草稿与列表位置不因切页重建。其 tabpane 不滚动，页内列表与详情各自滚动，窄屏详情就地覆盖列表工作区。
- 本机存储页同样占满可用高度，统计条位于内容框外，统计和操作保留在视野中；分类和项目详情分别在内部滚动且不显示滚动条，窄内容区将分类与详情上下排列。项目支持搜索、按清理状态筛选、排序及跨分类批量选择，结果在操作栏汇总，失败原因按需展开。仅用户手动启动扫描，扫描期间显示品牌加载状态；清理后更新结果并保留未处理项目，无需立即重扫。具体清理边界见[本机存储](local-storage.md)。

## 测试

- `test/settings-section-frames.mjs`：在宽、窄布局中使用生产设置页核对一级标题无下划线，以及通用和模型页面滚动时标题随内容移动；同时核对各分区标题无下划线、整组内容圆角描边、标题操作在框外和横向溢出。`test/local-storage-section-frame.mjs` 以生产组件验证本机存储在窄窗口的独立滚动、清理进度和结果，均不截图。
- `test/unit/settings-page.spec.tsx`：导航分组与切页、搜索跳转高亮、保存条撤销 / 保存、离开确认、`countFormChanges`；未访问页不发初始化 IPC，访问后保活、草稿/选区/滚动保持，外部深链/别名与跨页保存离开。
- `test/unit/settings-material-presence.spec.tsx`：原生材质底层标记与直接兄弟 inert 在 paint 前随真实 DOM 挂载、退场结束清理并恢复原属性；配置/首次访问内容不重写标记，快速重开和 StrictMode 保持正确，晚到原生材质确认与实底回退同步，lazy chunk 等待期间不隐藏工作台，挂载焦点不变且底层草稿保留。
- `test/unit/interaction-preferences.spec.tsx`：本机默认/恢复、输入校验与限幅、storage/系统变化、订阅清理、存储不可用及通用页即时控件不写 AppConfig 草稿。
- `test/unit/settings-segmented-motion.spec.tsx`：共享底片身份、变量宽按钮与快速反向、原生键盘/禁用、字体与尺寸变化、隐藏重显及卸载清理；`test/fixtures/interaction-motion.tsx` 与对应 scenario 用生产组件/主题检验实际坐标、首次/重显填充及减少动态效果，截图仍需逐次查看，不能由组件测试推断视觉验收。
- `test/command-palette.mjs`：分组与页签数据、搜索项锚点契约。
- `test/settings-css.mjs`：滚动下放（页卡 `overflow:hidden`、tabpane 滚动）与折叠区 `display:block`；分区重构守卫（一级标题随页面滚动且无下划线，二级标题无下划线、整组内容共用圆角边框、节标题不得再带序号、折叠行三种列表共用 40 高/14-500 规格、`.s-row` 不得带回行线、导航 36px 组距）。
- `test/fixtures/settings-partition-scenario.mjs`（配 `settings-save-motion.tsx` 夹具，`--styles base,skel,float,settings,responsive`）：行为断言页头随页面滚动的几何（滚动 320px 后位移与滚动距离一致）、节标题无序号、行组块圆角与块内无行线、换页后块仍在，以及行内控件右侧留白 18px、页头与节标题左缘齐平、节与行组无横向溢出；产出通用页顶部/滚动后与通知页截图。`test/fixtures/settings-partition-audit.mjs` 是逐页盘点脚本（12 个页签各截一张，并输出节内容容器类名、对齐、留白与溢出），用于人工过页，不作为回归门禁。
- 夹具 `settings-save-motion.tsx` 为上面两个场景补了：`cloneSafe`（订阅类 IPC 会把回调当参数，直接 `structuredClone` 会抛错并中止整棵树，外观页曾因此打不开）、`on` 返回退订函数、`themes.list/get/activate` 桩、两条长规则（验证规约行省略号截断）。仍缺 `runtimes.*` / `webAccess.*` / `feishu.*` / `memoryCenter.*` 的桩，所以 Worker 列表、远程访问、记忆检索节在该夹具下只有空态。
- `test/color-surfaces-css.mjs`：共享颜色角色、分段选中、预检代码背景、能力管理动作/遮罩与禁用态的声明守卫；不替代真实设置页视觉验收。
- 各页用例：`worker-keep-awake.spec.tsx`（通用页开关）、`notify-pane.spec.tsx`、`shell-settings.spec.tsx`、`worker-pane-*.spec.tsx`、`remote-access-hook.spec.tsx`。

## 已知边界

- wheel 事件没有可靠的设备身份。增强模式按离散整数档位启发式识别鼠标滚轮，细碎、快速或衰减的像素输入、横向/修饰键滚动和被内部滚动区消费的输入交还浏览器；特殊鼠标和触控板可能产生相似事件，不能承诺识别所有硬件，可随时退回原生档。距离倍数不作用于这些原生回退输入，也不改变查找跳转距离或消息内容。合成 CDP wheel 不能单独证明真实触控板手感。
- 能力管理保留 cm-* 列表+详情双栏，其分类为 Skills/MCP/应用能力/宿主接入四项，「待处理差异」为作用域条右端的过滤胶囊（状态位，不占页签位）（`cm-review-pill`，无差异时隐藏），作用域切「全局」时项目选择器隐藏。模型服务商为左列表/右详情主从分栏（复用 `settings-split`，见「模型供应商」节），文本工具为功能列表/编辑区（`SettingsViews` 列表导航），均非手风琴；模型与输入页的分栏时代遗留（tabpane `overflow:hidden` + 列 `height:100%` + `.llm-section/.model-input-settings` 内滚）已于 2026-10-19 撤销：页内自滚会让页头不参与滚动，页头下方留出 26px 死区、内容再被自身滚动边缘硬切出半行。现在与其他长页面一致，整页在 tabpane 内滚动，页头随内容移动。
- 胶囊可见度（2026-10-19）：`.s-tag` / `.mcp-badge` 原来只有 `--interaction-hover` 底色（浅色下 4.5% 黑），在卡片和浮层里都几乎看不见。现改为 1px 描边取 `color-mix(in srgb, currentColor 26%, transparent)` + `--surface-input` 底 + 500 字重（原为 600，违反 design.md §5 字重规约——OPPO Sans 无 600 档，2026-10-26 连同其他 5 处 600 一并归 500；可见度主机制描边+底色不受影响）；描边跟着文字色走，不依赖作用域里 `--border-control` 的取值（浮层里那档会淡到 1.03:1）。`test/select-badge-visual.mjs` 断言描边与底面对比度 ≥1.25、文字对比度 ≥4.5（浅色 1.85/6.91，深色 1.34/6.24）。
- 桌面新建任务采用随视口收缩的固定尺寸：内容和状态区可滚动，选项通过弹出菜单选择，仓库隔离与范围也在菜单内操作，错误不会撑大窗口。顶部按 GUI / CLI 分流，只显示已启用且上次静态预检通过的入口。GUI 选择器以带图标的左右两栏浏览 Harness 与模型，支持搜索已读取的目录、最近选择及所选模型的思考强度；不可用入口不会出现在最近使用或搜索中。工作台启动时初始化安装状态；安装变动后可在 Harness 接入设置点击右上角「刷新」。模型菜单读取持久快照，点击「刷新模型目录」才运行引擎探测。权限菜单展示当前引擎实际可用的档位和原因。没有可用入口时可直达 Worker 设置。
- Agent 设置采用单一产品列表与保活详情，左侧在「我的 Agent / 全部支持」之间切换，未安装项仍能查看安装指引；每个产品独立显示聊天与原生终端能力。外部引擎按通用、聊天、终端作用域分开；Core 使用单页；模型目录按源目录显式刷新，筛选即时独立保存；路径、凭证、模型参数与内置技能/MCP 声明沿用现有 API。Agent 页只保留自身默认入口；本机命令行环境在设置「通用」页。布局与保存合同见上方「Agent 产品设置」；安装证据不代表登录、模型或实际推理通过。
- 免打扰时段手风琴的 `is-open` 绑在 presence 的 `mounted` 上，收起时没有收拢过渡，直接在退场结束后卸载。

## 操作等待反馈

保存与保存并离开的操作等待期显示单色品牌动效，沿用 saving 的成功/失败结束边界。 组件与场景清单见 [品牌加载动效](brand-loading.md)。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：全部应用设置唯一入口（整窗+左侧分组导航+草稿保存模型）；工作区编辑另走 AgentFloat/CreateWorkspaceModal 弹窗。
- 为什么这样设计：即时生效键（mcp/主题/语言/快捷键/框材质/头像等）不进草稿计数也不随保存写入（防旧草稿把主题色/工作区切换回滚）；撤销=formEpoch 重挂丢页内派生草稿；页签保活（首次访问才挂载、切页保持草稿/选区/滚动）；离开两段确认（Esc 放弃并离开）；分区 800px 单列+块内无行线+无序号为 2026-10-19 用户裁决。
- 明确不做：不做自动保存；MCP 列表走资源专用 IPC 不写回草稿；页签 id/搜索锚点是外部契约（focusItem/命令面板/测试共用）由测试守卫。
- 歧义点：无真决策（布局/序号/胶囊可见度均有用户裁决记录与守卫测试，无待决）。

设置共性回归：`settings-section-hierarchy.spec.tsx` 验证 h2/说明归属和字段/行 h3 对等；`settings-consistency-scenario.mjs` 使用真实生产组件与模拟 IPC，在深/浅 × 1440/700px 以真实键盘/点击验证标题几何、资源详情字阶与对齐、删除弹窗和按键录入。截图不能证明主进程系统发送或 macOS/Linux 真机效果。

资源浏览器左栏状态来自清单：技能优先显示来源异常/同名差异，其次宿主只读、已关联入口数、外部原生可见数或未关联；MCP 显示停用、中转未启用、已启用及最近握手结果，连接信息旁提供连接测试入口，应用能力显示暴露类型。关联/可见不等于会话已加载，启用也不等于握手已通过。服务商增加本地搜索，筛选不改变详情选中及草稿。SearchBar 内层 input 不套设置页通用输入壳，避免双边框。`settings-resource-scenario.mjs` 用真实组件、生产品牌资源和模拟 IPC 对深/浅 × 宽/窄验证列表/详情几何与状态，再查看截图。
