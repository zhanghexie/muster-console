# Harness 透明模式

Core 会话还可用 `/record-requests` 打开[模型请求窗口](model-request-viewer.md)，录制每次模型 HTTP 发送的正文。

GUI Worker 会话顶栏的「Harness 透明」开关默认关闭。开启后在用户气泡里展示实际发送的文本，并按引擎提供的数据展示注入详情、插话、模型调用计量和上下文压缩点。Pi 的原方案与决策记录见
plans/implemented/pi-trajectory-plan.md（v3，2026-09-24 实施；
2026-09-25 用户返修轮：注入卡显示策略重做 + 引擎真身捕获落地）；
视觉基准 [prototypes/pi-trajectory-demo/](../prototypes/pi-trajectory-demo/)。

> **历史**：v1/v2 的「轨迹账本 + 独立轨迹页签」（对标 dsh ui-trajectory）已于 v3 整体退役
> ——其内容与聊天转写重复，存储归一为转写（messages json）一份。旧会话盘上的
> `<id>.trace.json` 不再被读取，删除会话时一并清理。

## 顶栏开关

所有 GUI Harness 会话均提供「Harness 透明」。中栏会话通过顶栏 `…` 菜单切换，带独立顶栏的会话使用
设置页「已启用 | 禁用」同款分段胶囊（复用全局 `llm-status-capsule-group`/`llm-capsule-btn`，
`settings.css` 全局加载）：左侧「Harness 透明」标签 + 右侧 [开启 | 关闭] 胶囊，开 = 绿染
（`is-active-enabled`）、关 = 灰底（`is-active-disabled`），悬浮 title 说明。会话视图态
（内存，不持久化；重开默认关）。**默认关 = 现状零变化**——标注组件只在开启态挂载；
宿主静默插话（`steering:'host'`）关闭态整条滤除。

开启后，有发送记录的用户气泡以纯文本呈现 driver 实际提交给 Harness 的内容。发送时用 `<muster_host_context source="automatic">` 标出宿主说明和逐轮上下文，界面同步呈现这些标记。发送记录通过 `engine-input` 事件关联到本轮用户消息，独立保存在 `userData/agent-inputs/`。历史 IPC 只返回引用，打开开关后通过 `agentSession:engineInput` 按消息读取。重新发送同一条消息时以最新一次提交为准，清空或删除会话会清理记录。升级前的消息和分叉继承的消息保留原文。图片仍由附件视图展示。Harness 在收到消息后自行组装的系统提示、历史、原生技能和模型请求由各引擎管理。

## 标注一览（§6 视觉规范）

| 标注 | 位置与形态 | 数据源 |
|---|---|---|
| 注入卡 | 代际首次生效或变化时，无发送原文的消息可在行内展开注入卡。有发送原文的消息直接用气泡显示。快照详情含段落全文及引擎提供的系统提示词和工具目录 | 会话信封 `injections` 代际链（连接快照 + 逐轮 injection-update）；按回合时间解析生效代际（早于第一代的回合回落第一代） |
| 插话线 | 插话到达位置；紫缘线 + 「插话」徽标 + 文本 + 时间 | 转写里的 steering 消息（见下） |
| 计量 chips | assistant 回合 hoverbar 最前（`↑ 输入` `↓ 输出` `思 N` `总耗时`，tabular-nums 无语义彩色） | 消息 `harness.usage/durationMs`（turn-complete summary 盖章） |
| harness 详情抽屉 | assistant 回合之后兄弟节点；`⚙ harness 详情 · 本轮 N 次模型调用 · 插话 M 条`，展开 `#/模型/输入/输出/TTFT/耗时/重试` 表 | 消息 `harness.calls`（请求级明细） |
| 压缩分隔 | 回合之间；`⇡ 此处发生上下文压缩 · X → Y token`（未知规模省数字） | 压缩标记（compaction 推送 + 信封，见数据流） |

唯一语义色紫（插话/注入图标），压缩 ⇡ 黄，其余单色。动效只用 `--dur-*`/`--ease-*` token
（展开/收起为原生 `<details>`）。

关键实现细节：hoverbar 常显规则 `.agent-chat-view.harness-on .chat-msg.chat-quiet .chat-hoverbar`
（特异性 0,4,0，压过 chat.css 的 quiet 隐藏 0,3,0）；标注默认 `display:none`、开启态**按组件
逐个给 display**（flex 组件给 flex）；历史回合保持折叠（`turn-fold is-stale`），标注只插在
回合边界；插话线外层保 `data-mid` 锚点（历史跳转不失效）。

## Pi 模型请求的组装

每次 LLM 请求都完整携带三块：**系统提示词**（pi 原生基底 + 宿主物化追加段 + 模式 persona +
逐轮钩子追加）+ **工具定义**（连接期定死的全量 JSON schema：原生工具/宿主工具/MCP 桥）+
全部对话历史（未变前缀靠 provider prompt cache 近乎免费）。追加段连接级静态；逐轮段
（记忆/回合注入）按天+版本号 stable 快照，翻日或记忆变化才重渲染。

## 数据流（v3：账本退役，存储归一转写一份 + 引擎真身）

```
Pi driver / worker
  ├─ 既有聊天事件（text-delta/tool-start/tool-result/turn-complete）──► host 组装转写 parts
  ├─ compaction 事件（start/end）───────────────────────────────► host 推送压缩标记 + 落信封
  ├─ 连接期捕获 engineCapture（session.systemPrompt + getAllTools）► conn 字段 → host 记代际
  └─ 计量：driver 内 PiCallMetrics 状态机（不产出事件）
        turn-complete 携带 summary ─────────────────────────────► host 盖到 assistant.harness
注入代际：host 在 connect 后记连接快照（物化段 + 引擎真身 + 保留的逐轮段，冷启动回填
当前回合用户消息 ts）；modeHooks 逐轮注入经 injection-update 事件报到（首轮基线 /
stable 重渲染变化）→ host 以最后一代为基底换/加该段落新代际（at 同样回填当前回合 ts）
渲染层：容器级 .harness-on → resolveInjectionCards 按代际变化点出卡（随既有消息 IPC，无新 channel）
```

- **计量**（`drivers/pi/callMetrics.ts`）：SDK `turn_start/turn_end` = 每次 LLM 调用一对；
  TTFT 取调用内首个流事件（text/thinking/**toolcall** 增量首现——纯工具调用响应靠
  toolcall 打点补盲）；retry = `session.agent.onResponse` 响应数 - 1（pi-ai 观测钩子，
  无钩子版本缺省）；`turn_end.message.usage` 归一累入 calls；收口组装 summary
  （usage 累计 / model 取末次 / 回合墙钟）。旁路纪律：状态机全吞异常。
- **注入代际**（信封 `injections`）：每代 = 当时的完整追加面（连接级段 + 逐轮段 +
  `enginePrompt` 真身 + `tools` 目录，后两者 FNV-1a/hash 指纹参与等值判代——重连同内容
  不换代）。host 保留 `injectionUpdates` Map（逐轮段已知文本），连接快照重建时合并，
  防重连产生「记忆段被移除又加回」的假变动代。pi 的记忆段**不在连接时预记**（连接时
  文本会过时说谎），由逐轮钩子报到真实渲染文本（含快照 caveat）。
- **插话历史**：渲染器继续展示旧转写里的 `steering:'send'` / `steering:'host'`；当前内置
  Pi GUI 的普通后续消息进入宿主队列；用户显式「立即」文本经原生 steer，因此会产生新的 Pi 插话线。
  流式定位/停靠点仍兼容历史中的 host 插话。
- **压缩**：driver compaction 事件 → host 推 `compaction` 标记（running/complete/error，
  markerId 认领乐观 pending）+ 信封 `compactions` 记录；手动/自动压缩结果
  （`compactSession`）补写 tokensBefore/After 进信封与推送（透明分隔线的规模数字）。

## 关键文件

| 文件 | 职责 |
|---|---|
| `src/shared/guiWorker.ts` | 转写 schema 扩展（`harness`/`steering`/`durationMs` optional + 宽松解析）；注入/压缩信封类型与解析；引擎真身类型（`GuiEngineCapture`/`GuiToolCatalogItem`）、参数摘要与指纹 |
| `src/main/agentSession/types.ts` | `injection-update` 流事件；`GuiRuntimeConnection.engineCapture` |
| `src/main/agentSession/drivers/pi/callMetrics.ts` | 计量状态机（纯逻辑，test/pi-call-metrics.mjs） |
| `src/main/agentSession/drivers/pi/modeHooksExtension.ts` | 逐轮注入 + `onInjectChange` 上报（stable 变化即报 / 非 stable 只报首轮基线） |
| `src/main/agentSession/drivers/pi/workerEngine.ts` / `workerHost.ts` | 事件接线：metrics/compaction/工具时长与 IPC；连接期引擎真身捕获 |
| `src/main/agentSession/host/injection.ts` | 注入代际记录（connect 后 + 引擎真身合并 + 逐轮段保留）、injection-update 落代际 |
| `src/main/agentSession/host/events.ts` | summary 盖章、插话落转写（steering 去重）、压缩标记/信封（stampCompactionTokens 补规模） |
| `src/main/agentSession/persist.ts` | messages json 信封（injections/compactions）读写 |
| `src/renderer/src/chatSurface/harnessAnnotations.tsx` | 标注组件（开关/注入卡/插话线/chips/抽屉/压缩分隔）+ `resolveInjectionCards` 代际卡片解析与缩写纯函数 |
| `src/renderer/src/styles/harness.css` | 标注样式（只用既有 token；design-lint 守卫）；开关本体样式复用 settings.css 的分段胶囊 |
| `src/renderer/src/chatSurface/agentSessionSurface.tsx` | harness 视图态 store（开关 + 信封）+ host 插话关闭态滤除 + 压缩标记归并 |
| `src/renderer/src/agentChat/AgentChatView.tsx` | 顶栏开关 + 容器状态类 + harness prop 注入 |

## 交互与已知边界

- 开关是会话视图态（内存，不持久化；重开默认关）。切换只影响标注显隐，无布局动画。
- 旧会话兼容：messages json 新字段全部 optional、宽松解析——存量会话照常加载（无标注）；
  旧 `<id>.trace.json` 不迁移（内容本就在转写），删除会话时顺带清理。旧信封快照（无
  引擎真身字段）解析不丢。
- 后台子代理用量累计（`src/shared/backgroundTasks.ts` 的 `addHarnessUsage`）读 turn-complete
  summary，不再依赖账本 request 行。
- 非 stable 回合注入（模式模板带时间占位符且未开 stable）只报首轮基线，逐轮时间变化
  不追踪（逐轮上报=每回合一条噪音；stable 模式才有变化追踪）。
- 引擎真身是连接期快照：连接后引擎侧工具面/系统提示词变化（如 MCP 桥晚建）要到下次
  重连才反映到代际。
- Pi GUI 会话首条普通输入携带完整宿主说明，续聊时由引擎保留相应历史。引擎系统提示词快照可以包含模式 persona、扩展说明和引擎原生上下文。
- §7 预留（未实施）：onPayload 字节级 wire 还原（真实请求体逐字段快照、retry 归因）。
  引擎视角增强（系统提示词真身/工具目录/逐轮注入追踪）已于 2026-09-25 落地。
- **注入代际信封只追加不回收**：每次提示词变化整代追加存档（政策层全文+记忆段全文+引擎
  系统提示词真身+全量工具目录），全部随 messages json 持久化——超长 Pi 会话中记忆段每变化
  一次就追加一整代（含与前代重复的工具目录/引擎真身副本），会话文件体积随代际数线性膨胀，
  渲染层 `resolveInjectionCards` 每次对全量 injections 线性扫描。已知边界（去重/按引用存储/
  保留最近 N 代等回收方案另案，未实施）；触碰注入持久化时注意此账。
- 回归：`test/pi-call-metrics.mjs`（状态机）、`test/pi-driver-replay.mjs`（假 SDK 回放：
  steering/计量/重试/工具时长/压缩事件/引擎真身捕获）、`test/gui-host-lifecycle.mjs`
  （host 落转写/信封/逐轮代际/压缩推送/旧会话兼容）、`test/mode-hooks.mjs`
  （onInjectChange 发射语义）、`test/unit/harness-annotations.spec.tsx`（开关/标注/抽屉
  交互/代际卡片解析/纯函数）、`test/chat-compaction.mjs`（信封重建与标记归并）。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D06.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：Pi 会话排障——顶栏「Harness 透明」开关在对话流内联展示：每轮实际注入卡（代际链）/历史插话线/计量 chips（token/耗时/TTFT/重试）/harness 详情抽屉/压缩分隔；v1/v2 轨迹账本+独立页签已整体退役（内容与转写重复），存储归一 messages json 一份。
- 为什么这样设计：默认关=现状零变化，标注组件只在开启态挂载；注入卡只在代际首次生效/内容变化回合出现（同代不重复防刷屏）；引擎真身（systemPrompt/工具目录）FNV 指纹判代防重连假变动；计量状态机全吞异常（旁路纪律：观测不影响回合）；宿主静默插话关闭态整条滤除。
- 明确不做：仅 Pi 引擎提供这套透明标注；GUI 内置 Pi 仅对显式文本 steer 产生插话线，普通新消息仍走队列，历史插话线仍保留；§7 onPayload 字节级 wire 还原预留未实施；引擎真身是连接期快照（连接后引擎侧变化到下次重连才反映）；旧 trace.json 不迁移、删除会话顺带清理。
- 歧义点：①开关是会话视图态、重开默认关不持久化——A=刻意（排障工具，常态不污染转写，「干净会话」是默认语义；review 不把不记忆当易用性缺陷）／B=记住用户偏好。推荐 A。②wire 还原（真实请求体逐字段快照/retry 归因）——A=预留不排期（计量+注入+插话+压缩已覆盖排障主需求，wire 面大且含敏感请求内容）／B=排期补。推荐 A。
