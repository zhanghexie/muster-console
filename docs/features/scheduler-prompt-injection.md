# 调度提示词与注入面

当前工具发现、提示词分段、注入登记、压缩和轮级可见性。设计历史见 zcode-adoption-plan；当前宿主工具契约见 [tool-discovery.md](tool-discovery.md)。

## 功能职责

调度提示词分为 stable 正文/用户规约/回复语言、dynamic 能力附录、workspace-context 目录快照。回复语言规则以英文给出，使用自定义正文时同样生效。用户指定回复语言时遵从指定，否则跟随用户最近用自己的话表达请求时所用的语言。R5 后调度常驻清单即全部可用面：工具原生注册带 schema 直调，九域经 X.run 单入口（executor 内按 action 展开真实目标），无发现层；回合裁剪共用当前范围。

注入成本和缓存 token 进入上下文快照；全部注入点登记于 injection-registry.ts。压缩、跨日提醒与上下文回读保持独立职责。

调度与 Worker 以 `waitFor` 武装一次性续接；`both.event-wake.resume-wait` 登记续接注入。自写 note 原文返回，外部触发内容标为不可信数据；重复投递按 `fireInstanceId` 识别。行为与回执边界见 [会话续接](resume-wait.md)。

`scheduler.event-wake.needs-you` 在宿主实际唤醒调度开回合时读取调度自己的相位。相位为 `needs_you` 时，将简短指引放在本次原始唤醒指令前。调度用 `host_ui_reminders` 记录仍需用户处理的待办，随后执行原始指令。宿主在新用户回合进入引擎前清除旧上报，结束时按生命周期判为空闲。本轮主动上报的 `needs_you` 和 `done` 保留，后台唤醒也保留已有上报。普通读信提醒在模型输入中增加前缀，隐藏宿主事件及 `waitFor` 续接在原生事件正文前增加前缀。

## 提示词装配与注入链路

```
buildMetaAgentAppendPrompt(baseUrl, {customBody, rules, mcp…, workspaceContext})
  → [stable, catalog, workspace-context]                         ← string[]，stable 恒第 0 位
      stable  = 正文（customBody 或内置默认）+ 启用的全局行为规约 + 回复语言规则
      catalog = buildCatalogAppendix() → catalogAppendixText() 按需发现短索引
      workspace-context = 本连接的 cwd / controlRoot / 全部源根 / 读写目录 / 隔离映射
piProvider（调度）: appendSystemPrompt: appendSegments           ← 数组直传，不再包一层 [append]
pi driver（GUI Worker）: appendSystemPromptOverride: () => [input.systemPromptAppend]
pi 落地（边界事实）: agent-session.js:754 把数组 \n\n join 成【单条】system 消息
```

交互会话的 catalog 段指导当前模型通过 `ui.suggestReplies` 提供建议草稿；无头定时任务按轮级隐藏集移除该工具和对应指导。建议仅绑定当前活动 assistant，不构成用户发言或授权，见 [建议胶囊与回复补全](suggestion-capsules.md)。

### Worker 选档与精确引用

本轮开放 `host.sessions.create` 时，`providers/workerRoutingExtension.ts` 在 Pi 的 `before_agent_start` 从绑定的工作区读取档位，通过 `context_with_system` 在模型请求中附上 `worker-routing` 段，包含档位 ID、类别、名称、适用说明和启用候选数。列表最多使用 2400 个 JSON 编码字符。摘要随本回合快照进入实际请求，自定义调度正文、会话续接和压缩后的下次回合都能得到当前档位。稳定正文与原生会话历史保留自身内容，旧档位摘要不累积。

调度根据任务难度选择 `target: {tierId}` 并调用 `host.sessions.create({task, isolation, target})`。用户通过 `/harness` 选定配置时，直接传 `target: {targetRef}`。宿主在真实发送边界校验引用和工作区、来源根及版本，展开简短用法。候选参数和详细目录通过 `host.workers.options` 按需查询，创建阶段执行可用性检查。档位读取、引用校验和故障切换使用已有宿主逻辑，无需增开模型回合。

`test/scheduler-worker-routing.mjs` 使用真实 Pi SDK 和离线模型流，验证自定义正文、档位编辑后的更新、工具隐藏和每次输入仅产生一次模型请求。

### stable/dynamic 段序纪律

- **边界事实**：pi 的 `appendSystemPrompt: string[]` 用 `\n\n` join 成**单条** system 消息
  （`@earendil-works/pi-coding-agent dist/core/agent-session.js:754`），没有 ZCode 式
  多 system 消息 + ephemeral 断点。分段的价值不在消息条数，而在**段序**：
  stable 字节恒在 join 结果最前，dynamic 变化只作废其后缀。
- **归档规则**：会话内会变的内容归后缀（Catalog 附录——可用家族/裁剪面
  变化才变；ext.* 动态装载/卸载不改附录，完整定义由按需目录返回）；用户编辑的正文/规约归 stable（编辑本身触发调度
  会话重建，代价可接受）。连接目录快照独立放在第三段；正文工具表的两段基面常量保持兼容，未传目录事实的纯正文调用仍返回两段。
- **收益口径**：OpenAI-compatible 端点无显式断点，靠「stable 在前」吃自动前缀缓存；
  Anthropic 端点同理以前缀稳定优先。跨回合、跨会话重建（dynamic 段更新后）均不再
  因 Catalog 演进作废身份/规约段。
- **不变量（有单测守卫）**：Catalog 增删一个工具时 `buildMetaAgentAppendPrompt()[0]`
  字节完全不变；stable 恒为数组第 0 位（`test/prompt-segments-injection.mjs`）。

## 多源根目录范围

`schedulerWorkspaceContext.ts` 在回合第一次 await 前同步捕获目录范围，`turnExecution.runTurn` 在读取记忆前登记全部引用根的占用。压缩和无头调用各自捕获并持有到操作结束；无头任务不覆盖交互调度的预览。回合失败（包括记忆读取失败）、压缩或初始化失败都会释放本次占用。源根移除或 Junction 换目标会使快照失效，不会改到另一个根。

调度只有一个 cwd。新对话采用 `defaultRootId`，已有会话通过 Pi JSONL 的 `metaagent-workspace-source` custom entry 保存 workspaceId、rootId、源根/管理根物理身份与 cwd；custom entry 不进入模型历史。冷启动在加载 SDK 前只读取首条 session header 来确定 cwd，打开 SDK 会话后重验 custom entry。旧会话从 header 推导来源后补 metadata，损坏或已移除的来源明确拒绝。修改默认根或排序不移动已有会话；目录快照或模型改变时重建连接，继续打开同一个会话文件。清空对话后才按新默认根开始。

`directoryExtension.ts` 接到 Pi 的原生文件工具 `tool_call`，共用 GUI 文件策略。检查读写目录、所有补丁/移动目标和用户规则改写后的目标，审批等待后重验快照。Pi 特有的 `~`、`@`、file URI、Windows shell 盘符路径及 read 的 Unicode 文件名回退由 `piToolPaths.ts` 解析，原生参数本身不改写；与安装的原生工具执行目标有回归对照。现有 ask/plan 扩展仍负责模式及 shell；bash、外部 MCP、可执行扩展不构成 OS 文件系统沙箱。

目录事实注册为 A3 `scheduler.system.workspace-context`，按第三段 `workspace-context` 独立计量。`chat:context` 和设置页 `capabilities:get` 共用装配器：忙时展示当前操作快照，空闲展示下一轮目录范围，保留历史 cwd；不可用来源显示错误段，执行则拒绝。设置页 MCP 信息也按目标工作区解析。目录事实不把宿主协议正文复制进提示词。

调度模型配置、资源加载器及 `createAgentSession.agentDir` 与 GUI Core 共用 `userData/muster-core`。技能目录经 `skillSources.ts` 共用快照内路径、物理去重和 SDK 同名恢复，原生目录使用限定名，详见 [skills.md](skills.md)。

分叉同样在加载 SDK 前捕获原会话来源并登记全根占用，不覆盖交互调度预览。`forkSessionFile.ts` 在内存中用 SDK 解析、验证原档案，不改写原文件；新档案的 header、metadata 和种子均由 SDK 生成，以独占创建方式立即写入 JSONL。即使截点只有用户消息，也能在下一次模型回合前冷启动重开，不依赖 Pi 等待助手消息的延迟写盘。新 header 的 parentSession 指向原档案，缺失、变更或失效的来源明确拒绝。

SDK 等待结束后，分叉重新校验目录和聊天桶状态；期间发生发送、清空、打开或另一次分叉时，旧操作返回失败并只清理自己尚未绑定的新文件。文件已经绑定后若落盘通知失败，返回错误与文件路径，保留档案供恢复；清理失败也返回路径和原因。所有路径均释放本次占用。

验证：`test/scheduler-workspace-context.mjs` 覆盖真实 SessionManager、原生文件工具路径、目录快照、占用、预览及审批后换根；`test/scheduler-turn-workspace.mjs` 运行实际回合状态机的记忆等待/失败收口；`test/scheduler-fork-source.mjs` 用真实 SDK 档案和实际分叉状态机验证来源继承、用户消息立即重开、原档案不变、占用、并发冲突与失败清理；`test/e2e/scheduler-workspace-context.spec.ts` 通过独立 Electron 与本地模型验证实际写盘、范围撤销、默认根切换、用户消息分叉冷启动续聊和真实压缩后的 cwd。恢复原路径解析、将记忆等待移出 try，或恢复分叉的默认目录/延迟写盘/无状态重验行为，临时夹具均会转红。

## 工具注册（R5：常驻直调）

pi Available tools 只列实际注册的入口（调度常驻清单 60 项），均带独立动作摘要；catalogSnippetFor 优先 summary，缺省取说明首句，最多40字。

catalogAppendixText 只讲常驻直调流程（run 入口动作词表与技能路径）并列当前可用家族；不再复制工作流白名单、组职责地图或完整 schema。外部 MCP（mcp.search/mcp.call 中转）、引擎原生工具和运行时原有交互入口独立装载。动态 ext 工具按当前目录装载，装载/卸载不重复向 system 附录写入定义。

发现层（tools.search/tools.call）已随 R5 退役：没有按需发现轮次，未注册能力即不可达。run 入口（browser.run 等）在 executor 内按 action 展开真实目标并经 runFactory 预检参数（可纠正英文错误），透传可信身份和取消；仅 Worker 可用的入口不对调度注册。旧目录、帮助、状态、直投、专用问答/汇报等重复模型入口及 handler 已删除；UI IPC 和扩展 SDK 原生接口保持独立。详见 [tool-discovery.md](tool-discovery.md)。

有命名参数的常驻入口注册真实 schema，无参数入口保留 arguments_json 兼容；resolveToolCallArgs 统一解析旧字符串或命名字段。run 入口的 params 经 runFactory per-action 预检；危险确认参数、模式/路径、deny/ask/rewrite、动态工具信任门继续由原权限层在真实目标上执行，注册不构成授权。

buildCatalogAppendix 的短指引用于调度提示词和设置页只读预览；hiddenTools 限制注册面。静态定义总数不等于向模型恒注入的 schema 数量。

## 注入度量（D1）

- **注入成本**：`src/main/agent/injectionMetrics.ts`（纯函数）把分段折算为
  `[{name, chars, bytes}]`（UTF-8 字节数对齐计费/缓存口径）。orchestrator
  `getContextStatus()` 每次快照挂 `injection` 字段（段名 `stable`/`catalog`，与
  `MUSTER_PROMPT_SEGMENTS` 同序），经 `agent:context` 事件与 `chat:context` IPC
  通到 renderer store（`chatSurface/orchestratorSurface.tsx` 全量保留快照字段）。
- **缓存字段**：pi-ai `Usage` 含 `cacheRead`/`cacheWrite`；pi AgentSession
  `getSessionStats()` 聚合全会话累计——**缓存命中率度量可行**。`snapshotPiContext`
  透传为 `cacheReadTokens`/`cacheWriteTokens`（字段现居 `shared/types.ts` /
  `shared/guiWorker.ts`；原命名对齐对象 `shared/trace.ts` 的 TraceUsage 约定已随
  轨迹全链退役，无现役继任位置），随同一快照上 renderer。
- **度量口径**：injection 按**当前配置**重算（非会话建立时快照）——用户改配置到调度
  会话重建之间的偏差可接受；A3 注入注册表落地时再按会话挂实测值。
- **MCP 口径（R2 已收敛）**：度量面从全局 `effectiveMcp()` 改为按工作区
  `resolveEffectiveMcpFromApp(cfg, workspaceId)`（`orchestrator.getContextStatus`），
  与注入链路（piProvider 同函数）同源，多工作区 MCP 配置下不再有全局/按区偏差。

## 注入 source 注册表（A3，批次 R2）

真源 `src/main/agent/injection-registry.ts`：本仓**全部现役注入点**集中登记
（对齐 ZCode `core/src/system-reminder/source.ts` 来源登记制），字段
`{ id, target: scheduler|worker|both, channel: system|turn-prefix|tool-result|event-wake|host-md|compact|tool-schema, mode: always|conditional, survivesCompact, note }`。
`tool-schema`（2026-09-28 补登）= 工具注册时随定义下发的 description + 参数 schema：调度 catalog
常驻入口（`scheduler.tool-schema.catalog`）与 Worker 宿主工具面
（`worker.tool-schema.host-tools`，GUI registry / 入站 MCP / ACP 三路同源 meta）。
`listInjections()` 挂 `capabilitiesView`（设置页「能力」→「注入清单」小节，纯文本只读）。
设置页展示时对完整 note 原文取英文词条；中文登记、快照及声明信任摘要不变。登记说明变化时需同步补全对应英文词条，覆盖检查枚举实际注册表；未知文本回退原文，不以旧译文冒充新说明。

- 仓库 `AGENTS.md` 要求新增注入先登记。测试校验 ID 唯一、枚举有效及代码出处，评审核对实际接线。
- **登记粒度**：调度 system 两段（stable 正文+规约 / catalog 地图）、回合前缀六类
  （memory 桶 / SITUATION / trigger+Lane2 / intents / date-change / R3 transcript
  指针）、无头定时任务原文、事件唤醒两类（聚合编排事件 / 即时通道）、askQuestion
  工具结果、压缩面三条（B1 微压缩定向指令 / B3 全量摘要模板 / B3 transcript 指针
  的注册表位）、Worker 注入（GUI 首条输入 / CLI 简报 / 工具 schema / modeHooks 记忆）+
  Worker askQuestion。

## 调度会话 microcompact（B1，批次 R2）

调度会话「对话不长、工具结果堆积如山」——旧轮询结果（sessions.observe / sessions.observe({includeGit:true})
等大 tool result）只有 0.8 阈值的整会话压缩可清，小毛病动大手术。B1 加两级触发
（真源 `src/shared/microcompactPolicy.ts`，判定纯函数、与 autoCompact.ts 同层同风格）：

1. **idle 触发（主路径，挂事件唤醒）**：`orchestrator.send` 非忙碌路径在进回合前调
   `maybeIdleMicrocompact`——上次 assistant 完成距今 ≥ 阈值（缺省 30 分钟，
   `autoCompact.micro.idleMinutes` 可配）先试清理再进回合。原理：调度长空闲时
   prompt cache 本就过期，清理零缓存代价（ZCode `compact/microcompact.ts`
   TimeBased 同思路，「清理挑缓存已死时动手」）。
2. **token 兜底**：`maybeAutoCompact` 走 `decideSchedulerCompactChain`——0.8 全量判定
   不变；低于 0.8 但达 0.8×0.9=0.72 档先试微压缩，估算节省不足最小节省
   （缺省 2000 tokens）才放行到 0.8 全量。busy/总开关/能力位与全量压缩同闸互斥
   （复用 `decideAutoCompact` 判定，与手动 /compact 一把闸）。

### 当前执行方式与 SDK 能力

调度器使用 `src/main/agent/piMicrocompact.ts` 从 `sessionManager.buildContextEntries()` 读取白名单工具结果以估算节省量。触发后执行 **`compactSession(wsId, 定向摘要指令)`**。`buildMicroCompactInstructions` 经 `safeCompactSession` 传入 Pi 的全会话压缩，要求旧轮询各留一行结论、每类最近 `micro.keepRecent` 条完整保留（缺省 5）、任务决策逐字保留。实际保留情况取决于摘要模型。

2026-09-23 的 spike 确立了当时采用定向摘要的实现。现装 Pi 1.4.0 仍采用追加式转录，并已支持通过回合边界草案追加 `context_edit`，按原条目 ID 改变当前分支的模型可见内容。调度 Pi 已接入同源的局部摘录与跨代折叠，轮询候选按最新投影估算。[Core 上下文压缩](core-context-compression.md)。SDK 1.4.0 投影、重开与分叉实验

### 白名单（读类轮询，逐个评估）

`sessions.observe` / `memory.list`（MICROCOMPACT_COMPACTABLE_TOOLS；R5 发现层退役后 tools.search 出名单，mcp.search 刻意保留 schema 页）。匹配时 pi 下划线名归一为点号，不能把写回执当作轮询丢弃。错误结果保留，每种可压缩工具保留最近5条；askQuestion 决策结果、短交互文本和写入回执不进名单。

### 与压缩链 / 记忆的协同

- 微压缩动作走 `compactSession` → 压后 `memoryInjectionDue=true` → 下回合重注入
  MEMORY+SITUATION（被摘要掉的编排态势自动重建）；
- 清理发生写一行 console 日志（触发器 / 清理条数 / 估算节省 tokens）；
- 微压缩自身的产物（摘要）就是压缩后上下文，登记进 A3 注册表
  （`scheduler.compact.micro-instructions`，survivesCompact=true）。

## 跨日 date-change reminder（C1，批次 R2）

真源 `src/shared/dateChangeReminder.ts`（判定纯函数，给定时钟）。调度会话常活数天，
pi system prompt 无日期（spike：`dist/core/system-prompt.js` 无任何日期注入），模型
对「今天」感知过期影响时间推理。跨自然日（含年末 12-31→01-01、闰年 02-29→03-01）
在回合文本最前注入一行：

```
<系统提醒>今天是 YYYY-MM-DD（上次交互 M月D日）。涉及“今天/明天/本周”的时间推理以本日期为准。</系统提醒>
```

- 通道：复用现有回合前缀（`composeReadPathTurnText` → `applyDateChangeReminder`，
  host 与用户回合都带）；不改 system——保前缀缓存（ZCode
  `injectDateChangeReminderIntoMessageHistory` 同思路）。
- 状态：`lastTurnDateKey` 记在调度桶（纯内存，重启重新锚定一次，代价一行）；
  首次锚定/记录损坏（不可解析日期）退化为不带「上次交互」的纯锚定行。
- 登记进 A3 注册表（`scheduler.turn-prefix.date-change`，conditional、
  survivesCompact=false）。

## 双熔断状态机（B2，批次 R3）

真源 `src/shared/compactBreaker.ts`（纯函数状态机，与 autoCompact.ts/microcompactPolicy.ts
同层同风格）。自动压缩链（0.8 全量 / 0.72 微压缩 / idle 微压缩）防两类失控：

1. **rapid-refill**（ZCode `turn-loop-state.ts:21-22,154-191` 同款语义，回合粒度移植）：
   compact 成功后 `RAPID_REFILL_TURN_WINDOW=3` 个回合内自动压缩再次被触发 → 计 1 次
   refill；连续 `MAX_CONSECUTIVE_RAPID_REFILLS=3` 次 → 熔断。窗口已过（≥3 回合）才
   触发的压缩不算 refill 且 streak 归零重计（`evaluateRapidRefill` 同款）。
2. **连续失败**：自动压缩连续失败 `MAX_CONSECUTIVE_COMPACT_FAILURES=2` 次 → 熔断
   （成功清失败连击；手动压缩成败不计数——手动是恢复通道）。

- **熔断语义**：`tripped=true` 后整条自动压缩链停（`maybeAutoCompact` 开头
  `isAutoCompactBlocked` 短路 + 链动作过 `beginAutoCompactAttempt` 闸；idle 微压缩
  同 gate-only 不计 refill）；**手动 /compact 不受影响**，成功即全量重置
  （`recordManualCompactSuccess`）。另一恢复条件=会话重建（clearHistory/切换历史
  会话/分叉/删除当前会话均 `resetCompactBreaker()`）。状态记调度桶、纯内存（重启
  复位可接受，与 C1 同惯例——最坏多压缩一次，不会漏压缩）。
- **可见信号**：打闸当拍经现有通知通道（通知中心 + toast，`ctx.notify.push`
  kind=error）透传「自动压缩已熔断，请手动 /compact 或新开会话」（两种原因各一条
  文案，en/zh 词条齐）；不造新 UI 形态。
- **喂线（orchestrator）**：每个完成的回合 `feedBreakerTurnCompleted`（窗口老化）；
  链给出压缩动作后 `beginAutoCompactAttempt`（refill 计数/打闸）；执行成败
  `recordAutoCompactOutcome`（compactSession 内，按 `source: 'manual' | 'auto'`
  区分——0.8 全量与微压缩传 auto，send/chat:compact 的手动路径缺省 manual）。

### reactive compact 归属（spike 结论，2026-09-23）

**超窗错误面可结构化识别，且 pi 已内置 reactive——宿主不重复实现。**

- 错误面：pi-ai 导出 `isContextOverflow(message, contextWindow)`
  （`dist/utils/overflow.js:130-156`，包入口 `dist/index.js:17` re-export）：
  25 种 provider 消息模式（Anthropic「prompt is too long」、OpenAI-compatible
  「exceeds the context window」等，overflow.js:35-61）+ 非溢出排除（rate limit
  等，:71-75）+ silent-overflow（usage.input > window，z.ai）+ length-stop 零输出。
- pi 引擎内 reactive：`AgentSession._checkCompaction`
  （pi-coding-agent `dist/core/agent-session.js:1634-1731`）在 agent_end（:805）与
  pre-prompt（:895）运行——超窗错误（同模型）→ 摘除失败 assistant → compact →
  **重试该回合一次**（每回合一次闸 `_overflowRecoveryAttempted`，user message_start
  :364 与成功 assistant :406 复位）；成功响应超窗 → compact 不重试；阈值
  （`shouldCompact`：tokens > window − reserveTokens，缺省 reserve=16384）→ compact
  不重试。
- 宿主侧决策：在同一 `session.prompt()` 内 pi 已完成「压缩+重试一次」，宿主再实现
  会叠在 pi 的恢复上形成双重压缩重试——故宿主 **不做** 回合级 reactive 重试，只补
  pi 没有的**跨回合**振荡熔断（本节状态机）。**并发闸的真实机制（评审更正）**：pi
  的 `session.compact()` 本体无单飞闸（compact() 每次先 abort 再直接
  `new AbortController`，agent-session.js:1476-1478；`isCompacting` getter 由
  `_autoCompactionAbortController`/`_compactionAbortController`/`_branchSummaryAbortController`
  三个哨兵支撑 ：674-678，prompt 提交在压缩中被拒 ：836-838）——并发窗口真实有害；
  宿主侧互斥 = `compactSession` 的 busy **check-and-set 同步原子闸**（busy 检查与
  置位之间不得插 await，transcript 快照等 IO 一律放 busy 置位之后）+
  `safeCompactSession` 的 compactInFlight WeakMap（shared/piEvents.ts，同一 session
  重叠 compact 拒后一次）。超窗错误分类保留宿主侧纯函数
  `classifyContextOverflowMessage`（模式移植自 pi-ai OVERFLOW_PATTERNS 全 25 条 +
  1 条本仓泛化 `context[_ ]window[_ ]exceeded`，fixture 见
  `test/compact-breaker.mjs` §8），用于回合失败的结构化归因日志；计划风险节的
  「错误面不可靠则靠 0.72 预判兜底」出口无需启用（现实更好：错误面可靠且 reactive
  已在引擎内）。

## 结构化摘要模板 + transcript 回读（B3，批次 R3）

真源 `src/shared/compactSummary.ts`（LLM 面文案豁免 i18n，R2 先例）+ 
`src/main/agent/transcriptSnapshot.ts`（fs 执行层）。

1. **摘要指令接管**：pi 的 `compact(customInstructions)` 把自定义指令以
   「Additional focus:」追加在其内置摘要提示词后（pi-coding-agent
   `dist/core/compaction/compaction.js:492-493`）。宿主借此下发**调度场景六节结构**
   （ZCode compact/prompt.ts 9 节精神的中文版，`COMPACT_SUMMARY_CORE_SECTIONS`）：
   核心诉求与意图 / 关键事实与决策（工作区、会话名、任务状态）/**用户全局规约与
   安全约束逐字保留**（`COMPACT_SUMMARY_VERBATIM_CLAUSE`，ZCode「preserved
   verbatim」条款同款硬措辞）/ 派活与验收链路在途状态 / 压缩前正在做什么 /
   下一步建议。
   - **全量版** `buildFullCompactInstructions(extra?)`：六节 + 逐字保留条款 +
     标识符原样保留纪律；手动 /compact 未带说明、带说明（说明=「补充指令（用户
     指定，优先级最高）」追加）与 0.8 自动压缩都走它。
   - **微压缩版** `buildMicroCompactInstructions()`（B1）：保留轮询清理指令
     （白名单一行结论/最近 5 条）+ 引用同一套六节核心与逐字条款——**两版共用
     一套核心**。
2. **transcript 快照回读**：`compactSession` 执行前把当前 pi 会话 JSONL 复制为
   `<会话数据目录>/transcript-<sessionId>-<毫秒时间戳>.jsonl`（会话数据目录 =
   `store.getPiSessionDir(wsId)`；pi 会话文件名布局 `<时间戳>_<sessionId>.jsonl`，
   `session-manager.js:667`）。不 gzip——模型要用 Read 工具读原文；体积控制靠
   **每 sessionId 保留最近 2 份**（`TRANSCRIPT_SNAPSHOT_KEEP`，更旧的删，会话本体
   与其他 sessionId 的快照不误伤）。快照**失败 fail-open**（降级日志、不阻塞压缩，
   也不注入指针行）。快照成功则在**下一回合前缀**注入一行（复用 C1 回合前缀通道
   与 `<系统提醒>` 形态，host 与用户回合都带、注入即清）：
   `<系统提醒>完整历史快照已存 <路径>；摘要中丢失的细节可用文件工具按需读取。</系统提醒>`
3. **与 SITUATION/MEMORY 桶的分工**：桶=结论（压缩后态势重建，每回合前缀重注入）；
   transcript 快照=细节（完整历史在盘上，模型按需文件工具回读）。桶给态势、快照
   给证据，互不替代。

登记：`scheduler.compact.summary-template`（survivesCompact=true）、
`scheduler.turn-prefix.transcript-pointer`（conditional、survivesCompact=false）。

## 中止回合的已流出内容保全（C2 spike 结论，批次 R3）

**结论：②部分丢——盘面保全、模型面丢失。零实现关项不成立，修复超 30 行且非零风险，本批只记录。**

- **盘面已保全**：provider 流被中止时，已累积的部分内容随最终消息保留——
  pi-ai `anthropic-messages.js:620-630`（abort → `stopReason='aborted'`，content
  原样随 error 事件返回；`openai-completions.js:505-517` 同构）；agent-loop
  `streamAssistantResponse` 对 done/error 都取 `response.result()` 并 emit
  `message_end`（pi-agent-core `dist/agent-loop.js:236-254`）；AgentSession 对
  assistant `message_end` 一律 `sessionManager.appendMessage` 落盘
  （`agent-session.js` `_handleAgentEvent`）。执行中工具被中止会落
  「Operation aborted」错误 toolResult（agent-loop.js:354-360 等），无悬挂调用。
- **模型面丢失**：下一回合构建 LLM 上下文时，pi-ai `transform-messages.js:153-166`
  **显式跳过** `stopReason === 'error' | 'aborted'` 的 assistant 消息（注释写明：
  半截内容重放会打 API 错误，如 OpenAI「reasoning without following item」）——
  resume/下一回合的模型**看不到**自己被腰斩前的输出。盘上 JSONL 与 UI display 仍
  在；B3 transcript 快照会把它固化在快照里（模型可经文件工具回读）。
- **修复建议（未实现）**：宿主侧在下回合前缀注入「上回合被中止输出的尾部」
  （复用 turn-prefix 通道，约 20-30 行）或推动 pi 把 aborted 消息转成可回放的
  note 形态；直接去掉 transform 的 skip 会踩注释列明的 API 错误，不做。

## 轮级工具可见性裁剪（A4，批次 R4）

**spike 结论**：pi 工具面**可动态收缩**，走计划路径一（轮标签过滤）——
`CreateAgentSessionOptions.tools` 是初始 allowlist（sdk.d.ts:34-43「When provided,
only the listed tool names are enabled」），`excludeTools` 在其后做减法
（sdk.d.ts:44-45「Applies after tools」）；`session.setActiveToolsByName` 是会话级开关
（agent-session.d.ts:309-318，下一回合生效 + 重建 system prompt）；无
unregisterTool/removeTool（全 dist grep 证实），但注册面可由扩展工厂过滤。

**回合类型标签**（`src/shared/turnVisibility.ts` 纯函数，零导入）：
`SchedulerTurnKind = interactive | prompt-task | event-wake`；`schedulerTurnKindFromTurnScope`
把 runPiTurn 既有作用域（user/headless/host）对齐到该词表；`resolveTurnHiddenTools(kind)`
输出隐藏面 `{groups, tools}`，**未知/缺省类型一律空集（fail-open）**。

**prompt-task 隐藏面**：automations、dynamicTools、runtimes、llm、offPeak 整组，以及 sessions 的派生/切换/中断/合入/验收/归档/寄信写面、scheduler.policy.set 和 workflow 的启动/答复/问人/取消。sessions.observe/search/readMessages、自身 setStatus 及允许的其他工具仍可达；完整清单以 turnVisibility.ts 为准。

**九域 run 入口归组（run 化后的注册面口径）**：`X.run` 信封把域内全部动词复活为 action，注册面无法按 action 拆分——`catalogGroupOf` 把入口归入其域组（改名入口有本地映射：dispatch.run → runs），`isToolDefHidden` 对入口名追加规则：隐藏面裁到本域任一定点动词（workflow.start 等）或整组时，入口**整体隐藏**。因此 prompt-task 轮的 workflow.run 连同其读 action（list/get/validate）一并不可达（读入口按需另设）；automations/runtimes/llm/dynamicTools 四入口随域组隐藏；browser/themes/dispatch/extensions 入口不受影响。

**interactive / event-wake 恒空集**：用户交互和收信唤醒共享长会话；唤醒仍需正常协调能力，不逐轮翻动会话工具集合。无头定时轮每次建立独立会话，按限制生成注册面、短索引和可发现目录。裁剪不是操作系统沙箱，原生文件和 bash 能力仍按各自策略执行。

**接线**（`createPiSession`，无头定时任务每次运行新建独立会话，会话创建即回合发起）：
headless 会话按隐藏面 ① 过滤扩展工厂注册集（静态+动态 def）② 传
`excludeTools`（隐藏面展开成 pi api 名）收窄 active 面 ③ `buildMetaAgentAppendPrompt`
的 hiddenTools 让 Catalog 附录同步滤掉被裁条目（摘要不宣传没有的工具面；附录只保留当前可用家族与发现指引）。
交互会话三处均空集，字节级行为不变。**测试**：`test/turn-visibility.mjs`
（映射全分支/真实 catalog 对账/附录联动过滤/**还原转红锚**——摘掉 piProvider 任一
接线该文件 §6 即红，已实测）。

**执行面复核（双层第二层，`capabilities/executor.ts`）**：注册面之外，executeToolInner
在 run 入口展开出真实目标后（及一切按点名直调路径）以**生效名**再过一次当前回合隐藏面——
`currentSchedulerTurnHidden()` 仅在无头上下文（`isHeadlessTurn`）返回 prompt-task 隐藏面，
其余（交互/事件唤醒/GUI/PTY/扩展入口）为 null 零开销放行；命中即拒绝并回英文错误
（说明因当前轮隐藏、无副作用）。堵住绕过入口名检查的路径：入口未命中但 action 展开到
被裁动词（workflow.run→start）、直接点名退役动词、整组工具直调等。**测试**：
`test/scheduler-hidden-tools.mjs`（无头轮 run 展开/直调拒绝 + 正常轮不受影响，还原转红已实测：
撤掉 executor 复核块即红）。

## 已知边界（R1+R2 没做的）

- **UI 面板列**：注入构成与缓存 token 只到数据层（快照/事件/renderer store 可见），
  usage 面板/状态条不展示——留给后续批次（届时按 testing.md 规约补组件测试）。
- **缓存命中率**：字段已透传，但「命中率」比率与逐回合 cacheRead 曲线未算——pi 侧
  只有会话累计值，逐回合需订阅回合 usage 事件另行聚合。
- **A2 第三档**（规约挪首条 user 消息 system-reminder 附件）未做，见 plan P2 项。
- GUI Worker 在 `agentSession/host/connection.ts` 生成首条引擎输入的宿主说明，`host/injection.ts` 记录快照。
- 旧 `SUMMARY_GROUPED`（browser 整组折叠）与 `SUMMARY_MAX` 截断已删；A1 的组级地图
  与其 4000 字符硬预算三级降级（`catalogSummaryText/ForBudget`、`CATALOG_SUMMARY_BUDGET`）
  也在 A6（R5）随主消费方消失一并删除，被「Available tools 行内标注 + 瘦身附录」取代。
- **B1 层级一（真替换）未做**：依赖 pi 开放历史改写 API（spike 结论见上节）；当前
  层级二的动作是整会话摘要型压缩，比真替换有信息损失——定向指令只保证旧轮询结果
  压成一行结论。触发频率受「每工具留 5 条 + 最小节省 2000 tokens」双门约束。
- **B2 状态纯内存**：熔断计数/打闸态与 C1 日期键同惯例记调度桶内存，重启复位
  （最坏多压缩一次，不会漏压缩）；熔断的可见信号走通知中心 + toast，调度面板
  常驻黄条/胶囊位未新增（复用现有通道，不造新 UI 形态）。
- **B3 快照 fail-open**：快照失败（文件缺失/磁盘故障）只降级日志，该次压缩后无
  指针行注入；指针行是一次性前缀（注入即清），压缩后到下一回合之间切换会话即
  失效（按设计：指针只对产生快照的会话有意义）。
- **C1 日期状态纯内存**：重启后首轮重新锚定（多一行前缀），不落盘——桶持久化
  面保持最小侵入（只落 display/api/会话文件指针）。
- **A4 裁剪落在已退役链上是纵深防御**：headless 定时任务模式 2026-09-22 已退役
  （新建拒收 + 启动 purge，见 [prompt-tasks.md](prompt-tasks.md)），但执行链
  （runHeadlessPiTask 等）代码暂留待独立批次删除——只要链在，工具面就先收窄。
  terminal 模式定时任务拉起的是独立 Worker 会话，不经调度工具面，无需裁剪。
- **A4 交互/事件唤醒轮不裁**：共享长会话逐轮翻 `setActiveToolsByName` 会重建
  system prompt 打穿前缀缓存（见上节）；事件唤醒轮也确需完整派活面。
- **A4 是工具面裁剪不是沙箱**：pi 内建 bash 仍在 prompt-task 轮可用，直改
  userData 文件可绕过（与 ZCode 工具面裁剪同口径，防误用不防恶意）。

### 默认提示词的范围与更新边界（2026-09-30）

调度正文、GUI Worker 政策、Catalog 参数说明、MCP 代理参数与 scaffold 种子均使用通用任务表述，去除真实业务编号、私有技能和固定业务系统选择。集成能力按实际工具发现；MCP 关闭不注入启用指导，已开但无服务器说明待配置，已配置时只列实际名称。语言跟随用户偏好与本次对话。

保留 stable/catalog 两段、customBody 替换正文、全局规约恒注入、Worker 模式/授权条件与协议按路径读取。源码种子只更新新生成或受管内容，不扫描修改用户已保存的自定义正文；运行中会话需重建后取得新工具注册面。journal 标题/状态/问题/要点解析合同保持不变。

### 统一 Catalog 与执行入口

当前静态 Catalog 为128项（R5：发现层两条目出册）。registry 提供当前定义，调度/Worker 各自按常驻清单原生注册，执行统一走 executeTool（run 入口在 executor 内展开）；设置页展示完整目录，可见性不替代授权。

归档/删除、验收/合入、定时任务和动态工具继续使用各自入口。会话创建统一 sessions.create，原 tasks、workers、facts 和正文注入别名已删除；查询统一 sessions.observe。平台原生 IPC、PTY 与扩展 SDK 原有接口有实际消费者，仍由各自服务实现。历史设计见 Catalog 优化计划，本次实施见 精简计划。

## 关键文件与测试

- `src/main/capabilities/catalog/api.ts` — 独立动作 snippet（catalogSnippetFor）/
  瘦身附录（catalogAppendixText）/ 双形态判定（resolveToolCallArgs）/ 白名单
- `src/main/agent/systemPrompt.ts` — 分段构建（`string[]`）+ 单串形态（`…Text` 后缀）
- `src/main/agent/providers/piProvider.ts` — 数组直传；`src/main/agentSession/drivers/pi/driver.ts` — Worker 面注释
- `src/main/agent/injectionMetrics.ts`、`src/main/agent/piContext.ts`、`src/main/agent/orchestrator/contextStatus.ts` — 度量与快照
- `src/shared/types.ts` — `InjectionSegmentMetric`、`AgentContextStatus` 新字段
- 测试：`test/catalog-summary-slim.mjs`（家族发现/短附录结构/ext.* 无感）、
  `test/prompt-segments-injection.mjs`（段序不变量/单串一致/度量构成）；
  迁移：`test/agent-rules.mjs`、`test/capability-catalog-dynamic.mjs`、`test/terminal-capture.mjs`

R5 追加：

- `src/main/capabilities/catalog/api.ts` — `catalogSnippetFor`（Available tools 行内标注，
  独立动作摘要 + 40 字帽）/ `hasNamedParameters`（注册形态判定）/ `resolveToolCallArgs`
  （双形态纯函数）；`src/main/agent/providers/piProvider.ts` — registerOneIn 按形态
  注册真 schema 或泛型、promptSnippet 升级、execute 走双形态
- 测试：`test/catalog-tool-schema.mjs`（①全量 schema 结构扫描含「无 arguments_json
  混入」②双形态判定 ③snippet 首句/长度帽/隐藏过滤 ④源码锚 + 仓库真 pi-ai 校验器
  校验当前静态工具 schema；**还原转红**——parameters 折叠回泛型即红，已实测）；
  迁移：`test/catalog-summary-slim.mjs`（组行不回归/ext.* 无感）、
  `test/turn-visibility.mjs` §5（附录联动过滤）、
  `test/prompt-segments-injection.mjs`（ext.* 装载两段皆不动）、
  `test/capability-catalog-dynamic.mjs`、`test/terminal-capture.mjs`

R2 追加：

- `src/main/agent/injection-registry.ts` — A3 注册表（`listInjections`）；
  `src/main/agent/capabilitiesView.ts` + 设置页 CapabilitiesPane「注入清单」小节
- `src/shared/microcompactPolicy.ts` — B1 判定纯函数（触发/白名单/保留 N/最小节省/
  0.72→0.8 链 `decideSchedulerCompactChain`）；`src/main/agent/piMicrocompact.ts` —
  pi 会话候选只读采集；`src/main/agent/orchestrator/compaction.ts` — 链接线
  （maybeAutoCompact）+ 层级二执行（compactSession 定向指令）+ idle 微压缩
  （maybeIdleMicrocompact，钩子挂在 `orchestrator/sendPipeline.ts` 的 send）
- `src/shared/dateChangeReminder.ts` — C1 判定纯函数；`orchestrator/memoryInjection.ts applyDateChangeReminder`
- 测试：`test/microcompact-policy.mjs`（双触发器/白名单/保留 N/最小节省/busy 互斥/
  0.72→0.8 升级链/唤醒集成/**还原转红锚**——把 B1 从 orchestrator 的 autoCompact 链上
  摘掉（直调 decideAutoCompact 或摘 idle 钩子）该文件 §8 转红）、
  `test/injection-registry.mjs`（表完整性/结构兼容/C1 跨日·同日·闰年边界）

R3 追加：

- `src/shared/compactBreaker.ts` — B2 双熔断状态机纯函数（rapid-refill 窗口/连击/
  连续失败/手动恢复/重建重置/超窗错误分类 `classifyContextOverflowMessage`）；
  `orchestrator` 喂线（回合收口 `feedBreakerTurnCompleted`、链动作过
  `beginAutoCompactAttempt`、成败 `recordAutoCompactOutcome`、手动成功
  `recordManualCompactSuccess`、打闸 `signalCompactBreakerTripped` 通知信号）
- `src/shared/compactSummary.ts` — B3 六节核心/全量模板/逐字保留条款/transcript
  指针行；`src/main/agent/transcriptSnapshot.ts` — 快照（sessionId 解析/保留 2 份/
  fail-open）；`orchestrator.applyTranscriptPointerInjection` — 指针行回合前缀注入；
  `microcompactPolicy.buildMicroCompactInstructions` 改为引用共用核心
- 测试：`test/compact-breaker.mjs`（熔断全分支/窗口边界/失败连击/手动恢复/超窗
  分类 fixture/**还原转红锚**——摘掉 orchestrator 任一熔断喂线该文件 §8 转红，已实测）、
  `test/compact-summary.mjs`（六节齐全有序/逐字条款/两版共用核心/指针行格式/
  **还原转红锚**——摘掉模板合成或指针注入转红）、
  `test/transcript-snapshot.mjs`（sessionId 解析/删除计划/tmpdir 集成拷贝与保留
  2 份/fail-open/转红锚）、`test/injection-registry.mjs` 扩展两条新登记、
  `test/i18n-coverage.mjs` 白名单加 `shared/compactSummary.ts`（LLM 面文案豁免）

R4 追加：

- `src/shared/turnVisibility.ts` — A4 纯函数（SchedulerTurnKind 词表 / 回合类型映射 /
  resolveTurnHiddenTools 过滤映射 fail-open / isToolDefHidden（含九域 run 入口归组与
  整体隐藏规则、dispatch.run→runs 改名映射）/ hiddenToolNames 展开）
- 接线：`src/main/agent/providers/piProvider.ts`（createPiSession 打标签 + 注册集过滤 +
  excludeTools + hiddenTools 透传）、`src/main/agent/systemPrompt.ts`（buildCatalogAppendix
  收隐藏面）、`src/main/capabilities/catalog/api.ts`（附录按隐藏面过滤，无参向后兼容）、
  `src/main/capabilities/executor.ts`（run 展开/直调路径按当前回合隐藏面以生效名复核，
  无头上下文外零开销——run 化后补的第二层）
- 测试：`test/turn-visibility.mjs`（映射全分支 / 真实 catalog 隐藏-保留对账 / 附录
  联动过滤 / **还原转红锚**——摘掉 piProvider 任一接线 §6 即红，已实测）、
  `test/scheduler-hidden-tools.mjs`（无头轮 workflow.run action=start 与 automations 域
  run/直调拒绝、错误英文说明因当前轮隐藏、正常轮不受影响；撤 executor 复核块即红，已实测）

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D01.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：调度长会话的上下文经济性总账——提示词三段装配（stable 正文+规约 / catalog 附录 / 目录快照）、注入登记（A3 注册表）、微压缩（B1）、跨日提醒（C1）、双熔断（B2）、结构化摘要+transcript 快照（B3）、轮级工具裁剪（A4）。
- 为什么这样设计：pi 把 `appendSystemPrompt: string[]` \n\n join 成单条 system 消息——分段价值在段序（stable 恒最前吃自动前缀缓存，Catalog 演进只作废后缀；「Catalog 增删工具 stable 字节不变」有单测守卫）；微压缩走层级二（pi 无宿主可用的历史改写面——spike 实证 SessionManager append-only+活会话内存构建+外部改动被 _rewriteFile 覆盖），idle 触发挑缓存已死时动手+0.72 档先试微压缩+白名单每工具留 5 条+最小节省 2000 tokens 双门；双熔断防 rapid-refill/连续失败失控（手动 /compact 是恢复通道不受影响）；reactive compact 不重复实现（pi 引擎内已有超窗压缩+重试一次，宿主只补跨回合熔断，并发互斥靠 compactSession 同步 busy 原子闸）；摘要六节+用户规约逐字保留条款+transcript 快照每 sessionId 留 2 份 fail-open（桶给态势、快照给证据互不替代）；A4 裁剪只落无头轮（交互/事件唤醒轮不裁——逐轮翻工具面打穿前缀缓存且唤醒确需完整派活面），注册面过滤+executor 生效名复核双层防绕过。
- 明确不做：B1 层级一真替换等 pi 开放改写面（当前动作是整会话摘要型压缩，信息损失如实标注）；B2/C1 状态纯内存重启复位（最坏多压缩一次不会漏压缩）；B3 快照失败 fail-open 不阻塞压缩也不注入指针；A4 是工具面裁剪不是沙箱（pi bash 仍在、直改 userData 可绕过——防误用不防恶意）；GUI Worker 面不拆段保持单串；A2 第三档（规约挪首条 user 消息）未做。
- 歧义点：①C2 中止回合已流出内容模型面丢失（盘面/UI/B3 快照保全，resume 模型看不到被腰斩输出；transform 跳过 aborted 是防 API 错误，不能直接去掉）——A=接受现状（小概率路径，快照可人工回读；review 不列 finding）／B=纳入修复队列（下回合前缀注入中止输出尾部，约 20-30 行但非零风险）。推荐 B——可靠性专项对口，机制（turn-prefix 注入）已被 C1/B3 指针行验证；实施时须防半截输出被模型当完整指令。②微压缩层级二（整会话摘要替代真替换）接受为终态，还是推动 pi 改写面/自研改写升级层级一？A=接受层级二（双门约束损失，等 pi 上游）／B=主动推进层级一。推荐 A。
