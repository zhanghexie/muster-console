# 宿主工具面：常驻直调 + 域级 run（发现层已退役）

> R5 终态（tool-exposure-resident-run-skill-plan）：**常驻清单 = 模型全部可用面**。`tools.search` / `tools.call` 发现层已删除，无兼容壳；工具原生注册直调，复杂与低频能力域收敛为 `X.run` 单入口。**2026-11-12 补充**（按披露层级分配工具面体积）：`desktop` / `panel` 两个低频域收成域壳——`params` 不再展开，参数细节在 `~/.muster/skills/{desktop,panel}/SKILL.md`，per-action 校验仍由宿主 `resolveRunToolCall` + `assertToolArguments` 执行。本文按终态重写（历史演进见 journal 2026-10-22）。

`host.*` 全域迁移正在实施：调度 Pi、GUI 会话与 PTY 入站 MCP 已切换到投影目录，保留内部来源以执行原权限与身份检查；模型公开面使用 `host.*`。`dynamicTools` 域与 `ext.*` 动态工具已退役（见 [dynamic-tools.md](dynamic-tools.md)）。`host.ask` 合并提问入口，`host.sessions.update` 合并会话字段更新，`host.llm.run` 在调度可用配置动作和 quota，在 Worker 只提供 quota。`host.desktop.run` 提供桌面元数据和应用发现。Windows、macOS、X11 与支持的原生 Wayland 共用 Cua 窗口截图、语义读取和点击。Windows 和 macOS 还提供显示器坐标输入、聚焦和应用启动。macOS 操作会报告系统授权或锁屏状态。[桌面控制现状](desktop-control.md)`host.panel.*` 五个动作已注册，网页仅支持右侧，整个方案仍未完成。仓内技能真源版本已提升，全局技能在合入后由宿主供给链更新。

统一提问路由在挂卡前验证归一化后的题目 ID 和各题选项标签唯一，防止不同题目或选项共享答案状态；生成的默认 ID 也参与冲突检查。

## 形态

- **常驻直调**：常驻清单与会话 preset、模式及适配器能力求交，在支持工具桥的引擎注册；ZCode 已注册宿主 MCP，但注册本身不证明真实工具调用成功，也不能据此声称所有引擎都可调用。模型直呼实际注册名，无发现轮次。
- **一次性等待**：`host.waitFor` 是调度与 Worker 的常驻直调工具，具体调用受可信会话身份和接入唤醒能力限制；`host.mail.read` 只读信。条件、持久化与投递边界见 [会话续接](resume-wait.md)。
- **用户提醒**：`host.ui.reminders` 是调度和已接入宿主工具的 GUI/ACP/PTY Worker 常驻直调工具，不是 `X.run` 能力域；身份绑定当前会话，无头定时任务隐藏。用法与边界见[用户待办提醒](session-reminders.md)。
- **域级 run 入口**：browser、workflow、runtimes、automations、themes、dispatch、llm、extensions、desktop、panel、GitHub 各提供一个 `X.run({action, params})` 入口。`action` 枚举即动作词表，参数细节在 `~/.muster/skills/<域>/SKILL.md`，模型按需读取。`desktop.act` 的输入类型是内层 `params.action`。
- **会话管理入口**：`host.sessions.select`、`host.sessions.recover`、`host.sessions.restart` 独立注册；字段更新由 `host.sessions.update` 汇总并按实际动作逐项预检。批量 `host.sessions.review` 的 processed 动作先整体预检，再逐个处理；执行阶段的异常可能返回部分结果。`host.sessions.observe` 列表省略为空的附加字段，详情保留完整字段，见 [会话观察](scheduler-observe.md)。
- **面板工具**：模型面只有 `host.panel.run`（action = list/open/split/focus/close）。`host.panel.open` 的 `kind` 判别仍保留在内部真源，`run` 的 `params` 按真实 action 用 `assertToolArguments` 校验完整分支；`split` 与 `close` 支持按右侧标签 ID 布局、按格位收起和解散分屏，`list` 返回右侧分屏快照。参数说明见 `~/.muster/skills/panel/SKILL.md`。
- **GitHub 工具**：`host.github.run` 在调度及 GUI、ACP、PTY preset 注册。动作按实际的读取或编辑档执行，使用调用方工作区与 GitHub App 授权，确认后才能开 PR 或发评审。见 [GitHub PR 创建与审查](pr-loop.md#agent-调用)。
- **MCP 中转**：第三方 MCP server 经常驻 `host.mcp.search` / `host.mcp.call` 两工具走宿主中转（McpHub 唯一出口）。搜索默认给摘要，按需请求参数 schema。调用可传 `resultPaths`，在进入模型上下文前筛选 JSON 结果字段。见 [MCP 设置](mcp-settings.md#连接与诊断)。
- **执行路由**：run 入口按 action 展开真实目标再执行——GUI 面在 `agentSession/tools/catalogHostTools.ts`、Shell API 在 `protocol/shellApi.ts`、调度面（piProvider 直调 `executeTool`）在 `capabilities/executor.ts` 内展开（同一 `runRouter`/`runFactory` 机制）。身份绑定、dangerous 独立安全审核门、取消信号、使用统计（按真实 action 记录）都落在真实目标上。
- **权限**：`agentSession/tools/policy.ts` 先展开 run 入口，再按真实目标校验。Core 与内置调度应用自己的权限档。外部 Harness 的原生审批由引擎协议提供，宿主保留工具身份、范围、显式规则和业务授权。未知 action 与无效参数返回可纠正的错误。
- **GUI 统一网关**：`tools/identity.ts` 和 `tools/gateway.ts` 将实际工具快照绑定到主进程的会话与目录，检查名称冲突、公开 schema、权限和审批后的状态/回合；catalog 结果按 `ok` 投影，不把失败标为成功。内置 Pi、Claude、Cursor、ACP/Codex MCP 和 Muse MCP 复用，原生工具是否经宿主审批仍由引擎能力决定。
- GUI网关将可信请求ID与宿主turn放入toolInvocation异步作用域，调度Pi传SDK原始tool ID。合并动作继承原调用因果，模型参数不能覆盖；后台脱离调用链时清除来源，语义日志保留来源且不把它混入邮件去重集合。
- GUI 网关提供单次使用的预检回执，合并调用在执行前逐项检查权限，并在执行时重新核对回合与策略。`tools/projectedGuiTools.ts` 将公开工具连接到原网关与可信会话身份。
- `tools/ptyHostQuestion.ts` 复用宿主单选、多选和文本框承接 PTY 提问，标题标明 Worker；取消不返回作答。当前对话框队列不能主动关闭已显示的对话框，调用中止后虽不接受回答，界面可能保留至用户关闭或超时；真实界面验收尚待完成。
- **schema 边界**：`capabilities/schemaValidation.ts` 用 JSON Schema draft-07 处理 GUI 公开参数和 `X.run` action 参数，`oneOf` 必须恰好命中一支，`not` 按标准执行；未知 schema 关键字明确失败。Claude 的 Zod 投影无法表示的约束仍由主进程网关校验。GUI 不因常驻清单整理而新增开放旧投影中未提供的 `terminal.create` 和 `intent`。

`catalog/hostProjection.ts`、`capabilities/projectedHostRoute.ts` 和 `projectedSessionUpdate.ts` 按原工具来源收窄合并 schema、检测 API 名冲突并保留原权限来源；合并会话更新先逐项预检权限，并在状态变化时返回部分执行结果。批量 `review(processed)` 先全量预检，再逐个清除维度门并归档，审批沿用原 review；执行阶段异常会报告部分结果。迁移要求见 实施计划。

`projectedExecution.ts`、`projectedScheduler.ts` 和 `projectedPty.ts` 分别连接 GUI、调度与 PTY；实际入口提供身份、审批和原动作执行函数。调度字段更新如遇提升为高风险的动作会在变更前拒绝，直到提供批量审批回执。PTY 合并更新校验自身及直接子会话。精确 API 名解析基于公开目录，避免把 `node_repl` 中的下划线误判为点号。

GUI、调度和 PTY 的合并更新共用 `projectedSessionTarget.ts` 固定目标：原始会话行只作为宿主内部生命周期令牌，再复核父子、工作区、Harness 和来源绑定，不比较 `SessionsService.get()` 每次生成的展示对象引用。名称、置顶、模型、思考等本次可修改字段不参与绑定，避免前一个字段成功后误拒后续字段；目标删除、同 ID 换代或归属变化则停止并保留已完成结果。令牌不进入工具输出，调用者回合和权限仍由原网关逐项重验。回归见 `host-projected-scheduler.mjs`、`host-projected-pty.mjs` 与 `gui-projected-host-tools.mjs`，夹具复用真实 get/project/peek 方法。

`catalog/projectedCatalog.ts` 从调度回合过滤后的常驻源、Worker 连接实际可用的工具快照或 PTY preset 生成公开目录；`catalog/projectedDescriptions.ts` 改写说明中的工具引用，保留 schema 参数结构。原始目录保留给内部执行与权限判断，不构成公开别名。提示和技能正文仍须随全部功能完成进行最终核对。

## 模型看到的返回值

调度 Pi 把解析后的公开名和参数交给 `serializeModelToolResult`。GUI catalog 在 `recordBrowserToolUse` 和截图证据采集后序列化，PTY 入站 MCP 对 `/v1/tool` 显式请求 `resultView: "model"`。普通 catalog 动作共用公开名与 action 投影，在业务字段精简后计算最终 JSON 长度。PTY 的状态专用 URL 也显式请求模型回执，返回实际相位及来源。提问和组合会话更新另有专门的传输分支。普通 Shell HTTP 客户端默认读取原回执；工作流和扩展的直接代码调用仍使用各自的服务契约。

浏览器 close/navigate、主题 remove 只返回成功标志时，模型只收到 `{"ok":true}`。带告警、失败或附加数据的回执保留详情。GUI 网关经校验的错误信封只编码一次，取消原因可直接读取。会话更新还可能部分完成，必须查看 completed 和 failed。第三方与扩展返回的业务 JSON 中即便出现同名字段，也按工具自身契约处理。

逐工具的字段用途、可按需补读的详情、兼容边界和测试见模型返回值审计。

## 设置中的暴露投影

能力管理 → 应用能力通过 `catalog:get` 显示定义目录。`catalog/api.ts` 从 residentHostToolIds、isSchedulerRegisterableTool、hostTools presets、RUN_TOOL_DOMAINS/actions 派生 `CatalogToolInfo.exposure`；不另维护renderer动作映射，也不增加模型入口。设置专用的 `catalogWithSettingsPaths` 在原始技能文档声明之外补充可信宿主技能根下的本机绝对路径，供界面通过系统文件管理器定位，不改变模型使用的声明路径。bgtasks.* / node_repl.js 从 HOST_TOOL_METAS 的schema/preset补入展示，不导入handler或创建运行时；引擎自带文件/Shell等工具不计入宿主目录。`schedulerVisible` / `workerVisible` 只表示原生直接注册，间接动作的可达条件位于 exposure.scheduler/workerPresets。

`host.automations.run` 只管理定时任务。事件通知使用独立的 `host.events.subscribe`；升级启动时清理旧事件任务和关联订阅。

设置页只展示公开 direct/domain 入口及其动作表；例如 `host.browser.run` 的 click 动作不再作为独立 `browser.click` 显示，`host.apps.run` 从自身 schema 列出动作并指向 apps 技能。`dynamicTools` 域与 `ext.*` 动态工具已退役，不再出现在目录。

搜索与使用方/暴露筛选同时生效，原生入口计数只统计当前过滤结果中的direct/domain。页面展示的是定义条件，当前会话、模式、preset、信任/确认与执行授权仍可能进一步限制；MCP第三方工具通过mcp.search/mcp.call中转，Skills正文按需读取，均不能用“目录可见”证明现有会话已加载。

扩展 `hostTools` 由 GUI、ACP 和 PTY 的 Worker 公开目录并集生成，与能力管理的「扩展」筛选同源。合并入口沿用 Worker 的参数和动作约束。工具以扩展绑定的项目和工作区运行，部分工具需要该扩展自己的侧栏 Agent 及真实回合。原有扩展入口一并保留，调用合同见 [扩展工作台](extensions.md#扩展宿主工具与终端边界)。

## 常驻清单（R4 扩容 − R5 发现层 2 项）

工具说明按「职责 + 调用关键边界」压缩；默认值、参数作用域及非显然约束放对应参数，避免顶层重复参数树。域入口保留职责、action 枚举与技能路径；params 为必填对象，无参数时传 `{}`。身份绑定、确认、取消、回执、隔离等语义不能因压缩丢失。**体积守卫已改为分域预算**（`test/catalog-summary-slim.mjs`）：单域默认 5,000 字符，超限必须登记「现值 + 理由」，登记值同时作为上限防回涨；全局 48,000 仅作目标值打印差额，不再硬断言。2026-11-12 实测四面：scheduler 70 工具/55,629 字符（距目标差 7,629）、gui-full 54/43,993、acp-subset 50/39,948、pty-allowlist 46/40,120。该口径不含模型 API 包装与历史消息，单位为字符。

- **Worker 常驻项**按 preset 求交：会话通信、状态、intent、观察与事件、记忆、智能界面、摘要共享、后台任务、持久执行、`host.browser.run` 和 MCP 中转。`host.ui.suggestReplies` 为 GUI/ACP 当前活动回合及存活的 PTY Agent 会话提供建议草稿，身份绑定可信调用者；ACP 提供宿主记忆工具，智能界面仍由各 preset 区分。可用提问通道由 `host.ask` 表达。
- **调度常驻项**包含核心协作、问卷/验收/合入/终端、会话编排与状态、观察与事件、记忆、智能界面、建议回复、策略、UI 问询、网关、应用、事件审核、intent、域级 run 入口及 MCP 中转。
- 常驻清单只改变披露，仍与当前角色、模式和回合允许范围取交集。**不变量（test/tool-discovery.mjs 守卫）：preset 可见面 ⊆ Worker 常驻清单；调度清单每一项都有 catalog 定义且非 schedulerHidden**——新增工具必须同时进清单，否则不可达。
- **调度应用**：`host.apps.run` 管理内置与自制 App 的登记、查询及命令调用，使用独立共享 App 合同，不经 runFactory 动作展开；用法位于 `~/.muster/skills/apps/SKILL.md`，该技能纳入宿主供给清单。见 [调度手机应用](agent-apps.md)。
- **轮次审阅登记**：`host.turnChanges.trackFiles` 对交互式调度和 GUI/ACP Worker 投递；调用者身份由宿主绑定，`begin`/`complete` 只采集当前回合的授权文件，不授予写权限。完整用法在 `~/.muster/skills/turn-changes/SKILL.md`；纯 PTY 无轮次 tracker，不投递。见 [轮次文件改动](turn-checkpoint.md)。
- **产品反馈**：`feedback.history`、`feedback.propose` 和 `feedback.assess` 对调度和 GUI/ACP/PTY Worker 暴露，AI 读取本地与远端历史并判断重复，仅收集共享草稿；用户在设置或顶栏逐条审核后才可创建 Issue。用法位于 `~/.muster/skills/feedback/SKILL.md`，查重和失败边界见[反馈收集与逐条审核](feedback.md)。
- **动态工具（已退役）**：`dynamicTools` 域与 `ext.*` 动态工具已整体移除，调度面不再注册 `ext.*`，`extensions.run` 也不再有 `tools`/`invokeTool`/`run` 动作。扩展能力统一经当前清单合同的 domain/commands 声明。详见 [dynamic-tools.md](dynamic-tools.md)。
- 调度 AI 通过 `runtimes.run` 的 `register` 动作提交 Runtime Manifest。工作台在用户确认后启用声明的终端或 ACP 聊天入口。见 [Runtime 声明注册](agent-runtime-registration.md)。

## 文件与边界

| 文件 | 职责 |
|---|---|
| src/shared/toolDiscovery.ts | 双角色常驻清单（唯一真源）；目录查询纯函数（R5 后为测试/诊断工具） |
| src/main/capabilities/catalog/runFactory.ts | run 域工厂：action 枚举投影、per-action 参数预检（可纠正英文错误） |
| src/main/agent/piToolPaths.ts | Pi 引擎侧工具文件路径解析：`resolvePiToolPath` 对 read 工具做文件名变体探测（NFD/弯引号等，**每次调用最多 4 次 `accessSync` 同步探测、无缓存**，未命中即 4 次失败系统调用——量级小但在主进程热路径）；directoryExtension/approvalExtension 供各文件类工具按调用解析 |
| src/main/capabilities/catalog/runTools.ts | 十域装配（含 desktop/panel 域壳） |
| src/main/capabilities/catalog/desktop.ts / hostPanel.ts | desktop/panel 动作真源；`presets` 置空后只作 run 展开目标与权限档来源 |
| resources/skills/desktop/SKILL.md / panel/SKILL.md | 两域壳的参数唯一真源（含 `act` 内层 action 的说明） |
| src/main/capabilities/executor.ts | 执行器；run 入口在内部展开真实目标；使用统计按真实 action |
| src/main/capabilities/runRouter.ts | GUI/Shell API 入口的 run 展开（解析+身份绑定，不执行） |
| src/shared/hostTools/meta.ts | Worker 权限档/身份绑定/GUI-PTY-ACP preset（R5 后无 discovery 组） |
| src/main/agentSession/tools/discovery.ts | GUI 面常驻过滤（无发现代理生成） |
| src/main/agentSession/tools/policy.ts | 先展开后决策（run 分支）；deny 理由英文 |
| src/main/agentSession/tools/catalogHostTools.ts | GUI Worker catalog 背书注册面（含 run 展开） |
| src/main/inboundMcp/toolList.ts | stdio/HTTP 入站 MCP 的 Worker 常驻投影（清单 ∩ preset） |
| src/main/agent/providers/piProvider.ts | 调度常驻注册（registerTools，行序随清单家族分组；门 = isSchedulerRegisterableTool） |
| src/main/agent/injection-registry.ts | 工具面/附录/注入登记（R5 终态描述） |

不依赖 SDK 在回合中热注册。配置变化仍服从原连接刷新边界。PTY 不获得 GUI 专属能力。已删除：发现层（tools.search/tools.call 及 hosts/discovery.ts、catalog/discovery.ts、discoveryScope.ts）、browser 直调名投影（25 名退为内部真源）、runs.* 直调名（dispatch.run 收敛）。技能文档与工具面的同步义务见 AGENTS.md feature-docs 段。

验证入口：test/tool-discovery.mjs（含 preset ⊆ 常驻不变量）、test/host-tools-simplification.mjs（静态 168 + 协议契约）、test/browser-run-tool.mjs、test/run-domains-wiring.mjs（调度直调 run 展开）、test/run-factory.mjs、test/worker-binding.mjs、test/host-protocol-tiering.mjs 和受控 Electron 的 subagent-role-avatar / cli-runs。平台共用目录/权限实现；真机证据须分别报告。


## 创建合同

`host.workers.options` 是调度及接入宿主工具的 GUI、ACP 和 PTY Worker 的只读选型入口。缺省给工作区档位，指定 Harness 和表面后从缓存查询模型与参数。`host.sessions.create` 接受档位或精确引用，创建自身执行预检。已交接的 Worker 可经 `host.workers.context` 分页读自身原始转写和已结算工具结果。调用面与边界见 [Worker 自动派活](worker-routing.md)。

**模型面的 `host.sessions.create` 已收窄为「任务 + 位置 + 路由」**：只接受 `task`、`isolation`、`target`（`tierId`/`targetRef`）、`inherit`、`name`、`asSubagent`、`select`、`force`、`workspaceId`、`rootId`、`cwd`、`rootsRevision`、`isolationGroups`，并以 `additionalProperties:false` 拒绝其余字段。`runtime`、`model`、`thinking`、`modelParameters`、`nativeConfig`、`cliLaunchOptions`、`guiMode`、`configurePermissions`、`acpPresetId`、`piModeId` 由档位或引用携带；新建对话框走 `sessions:create` IPC 直传，不经工具面，因此界面仍可指定这些值。普通 Shell 改用 terminal.create；Agent 仍须显式 shared/isolated。isolated 可省略隔离组并默认选 cwd 所属 Git 仓库，或用 isolationGroups/repoSet 显式指定范围；源目录与版本仍校验。空会话与带任务创建共用 resolveLaunchConfiguration：IPC 直传时显式 runtime 优先，省略时只继承父或配置的 GUI runtime，否则使用 `pi`；CLI 不推荐且只在明确指定时创建。选中 GUI 不可用时明确报错，不自动改用 CLI；恢复已有会话沿用原 runtime。同 runtime 继承模型，同 runtime/模型继承 modelParameters 或 thinking；切换目标不携带不兼容参数。modelParameters={} 清除继承的参数覆盖，thinking 与显式 modelParameters 互斥；piModeId 不继承。显式不支持的 GUI 模型、思考、模式或 CLI 参数在创建前拒绝；实际参数 ID/值经适配器的能力声明与模型配置校验，探测不可用明确报错。Core 沿用宿主权限继承；同源同 Harness 的外部 GUI 使用父会话最新已确认且可传递的原生设置，CLI 使用自身原生配置。两类创建复用跨平台宿主创建服务，无平台专属新分支。经引用或档位创建时权限一律走自动档，见 [Worker 自动派活](worker-routing.md)。

## 安全审核执行门

`executor.ts` 在 X.run 展开后把真实 action、完整参数和调用取消信号交给 `safety/bindings.ts`。普通能力沿用既有授权，高危动作先走独立审核，疑点/失败才调用原确认 UI。`approval=auto`、模型参数和历史 always 规则不能跳过本次审核；readonly、目录范围和账户权限检查仍由原执行面拒绝。

扩展创作首信任与 dangerous 调用共用一次审核。`extensions.create/write/submit` 的代码信任由 host 在写入与语法验证后审核准确包内容，审核通过才发布到源码布局。完整证据超预算时说明原因并转原有人审，返回后仍重新校验精确指纹。

定向回归：`test/capability-safety-gates.mjs`、`test/gui-worker-safety-gates.mjs`。本轮子代理只编写用例，统一执行结果由根代理提供；未宣称真实模型或任何平台真机通过。

调度 Pi 原生文件/Shell 的 `directoryExtension` 是独立于 Catalog 的可信入口，审核调用显式包 `runAsSchedulerTool`。安全绑定因此捕获调度桶、Pi 会话与 streamingAssistant；审核后再次检查同一生命周期和目录快照，stop/clear/换轮后的 allow 不可执行。`test/scheduler-native-safety-gates.mjs` 用真实安全服务与生命周期捕获验证正常通过、stop、clear、替换 assistant 四条路径，独立 reviewer 为离线 fixture，待根代理统一运行。

`memory.search` / `memory.list` 返回有界摘要，`memory.get`按ID与版本分段读取详情和证据；`memory.journal`记录工作、`memory.journalGet`读取原日志，`memory.correct`和`memory.correctionStatus`处理纠错。`memory.confirm`仅在可信交互轮次验证用户原话后确认现有版本。GUI与PTY按已有宿主身份调用读、note、日志及纠错工具，确认与显式记住只开放可信 GUI（含 ACP）及交互调度回合；不创建 memory.run。用法统一指向`~/.muster/skills/memory/SKILL.md`。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D04-D05.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：模型（Worker 与调度两角色）以公开的 `host.*` 常驻清单和原生 schema 了解可用能力；复杂域按需读取对应 `~/.muster/skills/<域>/SKILL.md`，第三方 MCP 经宿主中转。能力管理设置页使用同一公开投影。
- 为什么这样设计：常驻清单是模型可见工具面，发现层 tools.search/tools.call 已移除；域级 run 的用法下沉技能文档。权限、身份及危险审核仍按展开后的内部真实动作执行，公开命名不改变授权边界；preset 和投影测试防止工具遗漏。
- 明确边界：不依赖 SDK 回合中热注册；第三方 MCP 不 run 化；`dynamicTools` 域与 `ext.*` 动态工具已退役。`host.panel.*` 已公开注册，网页中栏明确不支持；桌面动作的平台覆盖见[桌面控制现状](desktop-control.md)。
- 歧义点：①「常驻清单=模型全部可用面、无发现层」是终态吗：A=终态（review 不把「模型无工具搜索/可能不知道某工具存在」当 finding；新增能力一律进清单+压文案）／B=未来可能回归按需发现。推荐 A——R5 刚收尾且不变量测试已立，回归属大方向变更。②48k 字符预算超限时的取舍序：A=文案优先（压描述/合并参数，清单与参数语义不减——清单收缩=能力不可达，代价高于上下文负担）／B=超限可考虑裁清单。推荐 A——预算目的是防文案回涨（72k 压到 45k 的教训），不是限制能力面；这决定 review 对「定义变长」与「定义消失」两类告警的定级。
