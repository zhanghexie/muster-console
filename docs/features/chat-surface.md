# ChatSurface 统一会话合同

> 调度 Agent、GUI Worker、记忆会话与安全审核会话共用
> **一份渲染层合同 + 各用途适配器 + 一个转写视图**。调度、Worker、记忆和审核都使用同一套 AgentComposer/ChatTranscript；用途差异只由 surface caps 和后端适配器控制。方案与决策记录见
> docs/plans/implemented/chat-surface-plan.md（2026-09-06 实施）。

## 架构

调度与 GUI 的输入框底栏挂共用的 `SessionReminders` 入口，专用记忆会话显式关闭；CLI 在 `CliSessionView` 的输入框底栏挂同组件。展开的面板可以覆盖输入区；作用域、状态同步和原消息定位边界见[用户待办提醒](session-reminders.md)。

代理间邮件的前台展示位于壳层：普通会话由 `CenterPanel` 按可见分屏格挂 `MailEnvelopeViewport`，调度单窗和并排视图的可见列挂同一组件。组件只订阅成功提交的 `messages:activity`，短暂展示信纸并双向播放信封轨道，不进入转写或增加回复输入。收发、前台过滤与读取状态边界见 [会话邮箱](session-mailbox.md#前台收发信展示)。

```
AgentFloat / SchedulerOverview（单窗与并排行）            AgentChatView（顶栏/Harness 透明开关/批注编排）
        └─ SchedulerConversation ─┬───────────────────┘
                       ▼
            ChatSurfaceView（唯一会话视图：转写 + 输入框 + 状态条接线）
            ├─ ChatTranscript（唯一会话容器，泛型 <T>，模型语义经 model 绑定注入）
            └─ AgentComposer（唯一输入框；用途只关闭不适用的能力位）
                       ▼
        ┌─────────────┴───────────────────────────┐
        ▼                            ▼
 orchestratorSurface            agentSessionSurface       memoryCuratorSurface
 （chat:* IPC + agent:* 事件流）  （agentSession:* 事件流 + getHistory）
 模块级单例 store               每会话实例 store
（含 delta 合批，共享 deltaBatcher）      safetySurface / memoryCuratorSurface
                                           （专用后端事件投影到 GuiChatMessage）
```

- **合同** `src/shared/chatSurface.ts`：`ChatSurface`（caps + subscribe/getSnapshot + actions）。
  必选动作 = 适配器共同语义（编译器约束实现）；caps 能力位 = 表面差异（数据不是分支）。
  快照 `queuedItems`（排队消息条目，引用稳定：空队列模块级单例、(id,text) 未变复用旧数组）
  与可选动作 `sendNow`/`editQueued`/`reorderQueued`
  支撑统一排队面板，见 [send-queue-panel.md](send-queue-panel.md)；回归
  `test/unit/chat-surface-queued-items-stability.spec.tsx`。
  **send 失败反馈两表面对齐（2026-10-25，chat-surface F-04）**：调度面 `send` 的
  IPC 异常不再静默 `return false`——catch 里 `tipFn('发送失败：{{message}}')` 后仍
  返回 false（Composer 保稿），与 GUI 面 `agentSessionSurface` 同口径；GUI 面排队三
  动作（cancelQueued/editQueued/reorderQueued）同步消费 `{ok,error?}` 合同、失败
  flashTip（见 [gui-worker-session.md](gui-worker-session.md)「排队三通道合同」）。
  回归 `test/unit/orchestrator-send-error.spec.tsx`、`test/unit/agent-session-queued-errors.spec.tsx`。
- **调度消息模型** = `ChatMessage` 原生（piProvider 产出 parts 交错模型），binding 透传
  + askQuestion 提问卡/等待态（链接化在渲染层）；**GUI 消息模型** = `GuiChatMessage`
  （`guiTranscriptBinding`：映射/深比较缓存/等待态/审批提问卡插槽，见 guiMessageView.tsx；
  调度注入的 `source:'scheduler'` 经 `toDisplayMessage` 带到 `ChatMessage`，头像见 [chat-message-avatar.md](chat-message-avatar.md)）。
  assistant 正文的路径链接化由 `ChatMarkdownBody` 在渲染层做：先渲染原文，候选路径批量
  stat 后只把真实存在的包成链接（语法像但磁盘没有的词不再出死链），见
  [text-entity-recognition.md](text-entity-recognition.md)。
- `orchestratorSurface` 负责 `agent:*` 事件订阅、消息分桶和 delta 合批，`store.tsx` 保留单窗选择、气泡和通知。并排视图按工作区挂同一适配器实例，用各自的草稿桶和阅读位置，默认划词插入由 store 定向到活动区。详见 [调度面板入口](scheduler-panel-entry.md)。

GUI 快照按消息源引用与 Harness 开关复用可见消息数组；busy/context/模型目录等元数据更新不重新过滤消息或重建排队摘要。GUI 壳只订阅空态边沿，批注角色在调用时读取最新快照；正文仍由 ChatSurfaceView 独立订阅。聊天适配器、壳与统一视图通过独立 UiActions Context 取得稳定动作，命令面板、文件打开等 UI 请求不再广播到这些消费者。头像 Context 仅依赖实际展示字段，后台会话状态不改变其引用。

GUI 原生会话重显可用已完整加载的消息版本做条件历史读取：主进程确认 live entry 代际及 revision 相同才省略 messages，其余元数据仍逐次返回并按原字段时钟应用。隐藏仍 dispose/退订；不保留额外后台 event hub。消息本地时钟改变、清空、显式 desync、版本/标记异常、LRU 真正卸载及 Web 网关均保守使用完整历史。版本归属、采集期边界与回归见 [GUI Worker 会话](gui-worker-session.md)。

Gui 消息工具映射在 `guiToolDisplay.ts` 按不可变源工具弱引用复用，正文 delta 不再串行化旧工具参数；id/name/input/status/output/patch 变化仍失效。工具卡保留 React.memo 边界。对应成本与更新契约由 snapshot-stability、shell-subscription、avatar-context-stability、gui-tool-display 与 chat-tool-card-memo 回归覆盖；真实性能见 [performance.md](performance.md)。

## 关键文件

调度模型菜单的思考档沿用工作区级 `chat:setThinking`，当前模型档位随上下文状态传入统一 Composer；`contextSeq` 防止迟到上下文覆盖较新的模型状态，切档响应同时校验工作区生命周期和模型身份。

回合折叠头由 `ChatMessageView.tsx` 的 `TurnFold` 渲染：优先使用 Harness 盖章时长或消息的开始/结束时间显示“工作了 X 分 Y 秒”，组件亲历流式时再用前端 `Date.now()` 差值兜底，同时保留工具调用数与思考段数；旧历史缺少时长字段时回退已有计数。工具调用与其后的思考在原始 parts 位置合并成可展开分组，外层摘要原位切换工具与实时思考，展开后按顺序显示工具项和已结束的思考摘要。正文、审批与提问卡保留原始顺序并切断分组。展示及历史过滤见 [chat-transcript.md](chat-transcript.md#当前思考展示与展示记录)。

| 文件 | 职责 |
|---|---|
| `src/shared/chatSurface.ts` | 合同类型（caps/快照/动作）；调度、Worker与记忆适配器共同实现 |
| `src/renderer/src/chatSurface/ChatSurfaceView.tsx` | 统一视图：按 caps 装配 Composer（chatStatus/preset/mode/chips）与转写；GUI 会话的 preset 只保留启动时的状态，不在输入条提供模式控制；`useChatSurfaceSnapshot` 供壳低频读快照。根节点 `.chat-surface-view`（agent-chat.css）承接壳的纵向 flex——转写铺满剩余高度，输入条绝对定位悬浮盖在会话流上（`--composer-overlay-h` 让转写 padding 与跳底按钮让位；左右与消息列同走 `--chat-col-inset` / `--chat-col-max` + `margin:auto`，不量视口坐标），两壳父容器（agent-panel-body / agent-chat-view）都靠它向下传弹性 |
| `src/renderer/src/chatSurface/ChatTranscript.tsx` | 唯一会话容器：映射缓存、贴底跟随（新 user 消息/等待态解除重新跟随；60px 底部容差；外层上翻解除跟随，内部滚动消费或阻断滚动链时不解除；`host` 注入不重挂；**重开/切 sessionId 有阅读记忆则恢复，否则贴底**，跟随态下 composer/容器/内容几何变化补钉，不跟随时保持阅读位并同步回底按钮，详见 [chat-transcript.md](chat-transcript.md)）、「滚动到底部」浮钮（mp-pop-up，点击重新贴底）、时间分隔、回合工作折叠（Cursor 式 Worked for：回合结束即折叠，**折叠=真卸载**——条目不挂载只留折叠头与末段正文，展开重挂、大栈由 ToolCallStack 分批渐进挂载，见 performance.md §10）、会话历史面板接入（右键用户气泡弹出；宿主通知头像与内容靠左且不进停靠点）、批注角标、retryIdx 容错（按钮调 Host `agentSession:retry`：复用原用户消息、替换失败 assistant，不追加副本）、`editAbortedIdx`（末轮被用户手动停止时，对应用户消息悬停操作条出「重新编辑」按钮，先经 `useInterruptedTurnGuard` 询问文件回退，再调 `surface.actions.recallAborted` 移除该轮用户消息与已终止回复，并把原文与随文图片填回底部输入框）、审批/提问卡插槽、消息头像（AI 回复无头像占位；用户靠右，调度注入/宿主/代理靠左，连续同来源省略，见 [chat-message-avatar.md](chat-message-avatar.md)） |
| `src/renderer/src/chatSurface/ChatHistoryPanel.tsx` | 会话历史面板：**右键**人工用户消息气泡弹出，与输入条共用列宽，无遮罩（点面板外空白/Escape/✕ 关闭）。打开时滚动到触发消息并短暂高亮。列表单行截断，书签按钮与气泡复制旁的书签同步，顶部「仅看收藏」可切换筛选。悬浮以只读 Markdown 预览提问及该轮 AI 回复的最后一个非空正文片段，点击条目经 ChatTranscript 跳转并保持面板打开。进出场 presence 由 ChatTranscript 驱动，收藏和历史回填见 [chat-transcript.md](chat-transcript.md)。 |
| `src/shared/orchestratorFork.ts` | 调度 fork 纯函数：切点种子 / 剥卡 / 新 Pi 文件绑定（test/orchestrator-fork.mjs） |
| `src/renderer/src/chatSurface/orchestratorSurface.tsx` | 调度适配器：chat:* 动作（含 fork / setThinking）+ agent:* 流（含本地回显 localNotes）；`status.thinking` 来自 `chat:context` / `agent:context`；`ensureOrchestratorHistory`/`setOrchestratorFallbackWs` 由面板壳调用。delta 守卫：text/thinking 增量命中 tool 卡/kind 失配/下标跳号时丢弃该批并拉 `chat.history` resync（不覆盖落盘，回归 `test/unit/orchestrator-delta-guard.spec.tsx`）；`workspaces:changed` 逐出已关闭工作区的全部缓存键（messages/snapCache/queuedCache/surfaceCache…，重进靠 ensureHistory 重拉，回归 `test/unit/orchestrator-workspace-evict.spec.tsx`）。**工作区生命周期代（2026-10-02 U3）**：每工作区 `wsGen`（全局单调计数）——ensureHistory 重拉换代、逐出删代，一切在途回调（history/getMode/context/resync/compact/clear/setThinking）按「代失配」丢弃，迟到响应不重建 dead key；重开同 id 新代只吃新请求；`handleHistory`/`handleContext`/`setBusy`/`setMode`/`setThinkingState`/`localEcho` 对未登记（dead）工作区不落键；隐藏面板 ≠ 关闭（工作区仍在存活列表则代保留、推送照常）。回归 `test/unit/orchestrator-ws-lifecycle-u3.spec.tsx` |
| `src/renderer/src/chatSurface/agentSessionSurface.tsx` | GUI 适配器：每会话 store（历史/模式/思考档/模型覆盖/轨迹）；attach/sync/resync 整表替换经 `reconcileById` 复用未变消息引用（回归 `test/unit/agent-session-reconcile.spec.tsx`）。**迟到 history 分域应用与模式串行队列（2026-10-02 U1/U2，r1-r3 修订）**：生命周期 epoch（dispose/重挂作废在途回调，单飞状态随换代重置）+ clearSeq（clear 作废在途快照）+ 消息域（syncSeq+msgClock+逐消息 touched 时钟：均未动整表替换 / 仅 msgClock 动过逐消息合并——领先消息保本地增量并补齐缺失尾 parts / syncSeq 动过保本地）+ busy/mode/usage/inj/compact/engine/preset/model 细分时钟（任一推送先到不殃及其余字段装载；setMode 成功确认与 setModel 主变更即时推各自时钟，await 窗口不被旧快照回退）。history 单飞（并发 resync 串行化）；setMode 乐观更新+串行队列（失败回滚 confirmedMode，生命周期入队绑定）；setModel 主变更即时应用；快照 params 权威采纳（缺失才保留本地，生产 getHistory 透传完整 override）、覆盖变化（含 params）重算 modelInfo；changePreset 同链路加固。**参数域按模型判代（泛化迁移，取代原思考域判代）**：`parameters` 推送携带 host 快照身份（providerId/modelId），与会话显式模型选择不一致的迟到推送丢弃不污染新模型参数面板（sessionModel 为空=跟随默认时不硬判，靠 loadModelParameters 补拉收敛）；getModelParameters 响应按请求时身份比对作纵深防御（常态被 parameterRequest 代覆盖）；模型覆盖变化时先清除旧参数快照，待新模型结果返回再展示。legacy 思考字段（thinkingLevel/thinkingConfigured）不再消费——思考档由参数面板 modelParameters 承载，`status.thinking` 恒 null。回归 `test/unit/chat-state-race-u1.spec.tsx`、`test/unit/chat-mode-mutation-u2.spec.tsx`、`test/chat-mode-setmode-tips.mjs` |
| `src/renderer/src/chatSurface/deltaBatcher.ts` | rAF+50ms 增量合批（两适配器同源节奏） |
| `src/renderer/src/chatSurface/guiMessageView.tsx` | GuiChatMessage 映射/等待态/卡插槽 + 两个 binding 构造器（调度 binding 另挂 askQuestion 卡） |
| `src/renderer/src/chatSurface/ChatMarkdownBody.tsx` | assistant 正文渲染：路径链接化 + stat 二次校验（微批 statPaths + 模块缓存；流式跳过）；CJK 强调兼容与数学公式渲染都挂在下游 `MarkdownBody`（见 [markdown-cjk-emphasis.md](markdown-cjk-emphasis.md)、[markdown-math.md](markdown-math.md)） |
| `src/renderer/src/chatSurface/guiApprovalCards.tsx` | 审批卡/提问卡（GUI 直连 agentSession IPC；调度 `DispatchUserQuestionCard` 走 `chat.respondUserQuestion`） |
| `src/renderer/src/chatSurface/useSessionNotes.ts` | 批注编排宿主逻辑（划词桥/文件批注/token 对账，原 AgentChatView 平移） |
| `src/renderer/src/chatSurface/onFileLink.ts` | 路径/localhost 链接 → 文件面板（两表面同款，含 localhost 映射） |
| `src/renderer/src/chatSurface/memoryCuratorSurface.ts` | 独立记忆适配器；workspace/purpose草稿与快照、generation转写身份；state只读加载，send/暂停/清空只调用专用IPC，丢弃旧代/旧时间戳与已删除工作区的迟到结果 |
| `src/renderer/src/components/MemoryCuratorView.tsx` | 专用壳与读取失败重试；直接复用标准 AgentComposer/ChatTranscript，关闭技能、附件、提醒和工程动作，模型状态/切换委托调度 surface |
| `src/renderer/src/components/SafetyChatView.tsx` / `src/renderer/src/components/SafetyPanel.tsx` | 审核专用壳直接复用标准 AgentComposer/ChatTranscript；审核事件的文本增量、工具开始/结果和错误投影为统一消息片段，面板只保留一条连续会话 |
| `src/renderer/src/chatSurface/safetySurface.ts` | 将安全快照的结构化 `GuiChatMessage.parts` 保持为统一转写片段，并把模型状态/切换委托到调度 workspace surface |
| `src/renderer/src/chatSurface/ChatFindBar.tsx` | 会话查找浮条（Ctrl+F；两表面经 ChatSurfaceView 接入，见 [chat-find.md](chat-find.md)） |
| `test/surface-parity.mjs` | 双表面等价护栏（进 npm test） |

## 加会话级功能 checklist（改一处、两表面生效）

轮末文件改动共用 `TurnChangesCard`，由两个 binding 的 `getInlineCards().changes` 提供，在唯一 `ChatTranscript` 中挂于 assistant 后、工具折叠之外。文件悬浮预览 Diff、点击在右侧审阅；`ChatSurfaceView` 的 `useInterruptedTurnGuard` 在中断后重新编辑或新发送前统一询问文件回退，选择取消保留草稿与历史。文件恢复走独立 `turnChanges` IPC；范围、快照与活动回合保护见 [turn-checkpoint.md](turn-checkpoint.md)。

1. **共同语义** → `ChatSurfaceActions` 加必选方法（或 `ChatSurfaceSnapshot` 加字段）：
   `tsc` 立刻报缺实现的适配器；补齐各用途实现，不能把通用工程动作隐式授予记忆会话。
2. **表面特有** → `ChatSurfaceCaps` 加能力位：各适配器按用途声明；
   视图（ChatSurfaceView/ChatTranscript/Composer）按 caps 一处渲染。
3. **渲染** → 只改 ChatSurfaceView / ChatTranscript / AgentComposer（叶子），
   不进壳（AgentFloat/AgentChatView）。
4. **护栏** → `test/surface-parity.mjs`：新必选动作加进 REQUIRED_ACTIONS；
   壳不得出现 `window.api.chat.*` / `window.api.agentSession.*`
   （豁免：会话文件管理 sessionsList/sessionOpen/sessionRename/sessionDelete 与交互卡）。
5. 同步本文档与 [gui-worker-session.md](gui-worker-session.md)。

## 能力位对照（当前）

下表为调度/Worker两个通用会话表面的功能对照；专用记忆和审核复用同一个 AgentComposer/ChatTranscript，但不继承工程能力。两者复用 `surfaceKind:'gui-session'` 的消息绑定，关闭 `images/plusMenu/bgTasks/fork/notes/presets/localCommands/manualCompact`，并关闭查找/提醒入口；模型按钮保留为调度 workspace 的共享选择器。没有第二套输入框或第二套转写组件。

| caps | 调度 | GUI | 视图效果 |
|---|---|---|---|
| images | ✅ | 按 runtime（caps.images） | 输入框图片 |
| plusMenu / bgTasks | ✅ | ✅ | 加号面板（bgTasks 含 cwd） |
| fork | ✅ | ✅ | 用户/助手气泡操作条的双箭头分叉按钮，调度走 `chat:fork`，GUI 走 `agentSession:fork` |
| notes | ✅（AgentFloat 注入 notesHost，按 workspaceId 挂调度会话） | ✅（AgentChatView 注入） | 划词批注 / 角标 / 气泡 / 输入框 token；发送经 expandForSend 展开进 send。手机壳不注入 notesHost，selArea 仍走 agent-chat |
| presets | ❌ | ✅ | GUI 会话在拉起任务时选择并随会话保存；输入条不显示模式胶囊（轨迹页签已随账本退役，见 trajectory-view.md） |
| localCommands | ✅ | ❌ | /status /help /bind 命令清单与本地回显 |
| manualCompact | ✅ | 仅 pi（能力表 `manualCompact`） | /compact 命令（见下节） |
| modeLockOnBusy | ❌ | cursor | busy 锁切档 |
| thinking | 数据驱动（status.thinking.available）；调度走 `chat:setThinking`（工作区级 v2 `agent-models.json`，兼容旧 `agent-thinking.json`） | GUI 会话思考档已由泛化参数面板承载（modelParameters/reasoning）；`status.thinking` 恒 null、无 setThinking 动作 | 思考档 chip（仅调度面） |

## 专用记忆角色与状态隔离

`AgentFloat` 以调度为主体，表头脑按钮打开正文内底部记忆子系统面板；调度表头不被覆盖，不把两种用途写入 orchestrator 的 workspaceId 桶。记忆 surface 缓存按 workspace 建立独立用途实例，草稿键 `memory:<workspaceId>`，转写身份 `memory:<workspaceId>:<generation>`；调度保持原身份。首次打开记忆子系统才 attach/state，打开或加载历史不 send、不恢复模型。

同工作区两个视图以 xfade/inert 保活，各自保留输入和阅读位置；隐藏视图停止交互与前台动画，后台是否运行由宿主决定。切工作区重新 attach 只读快照，工作区删除 dispose 并逐出；epoch、generation和updatedAt共同拒绝迟到结果。调度 busy 与记忆 running/paused/pending/failed 分离，读历史失败有独立重读动作。

真实 `GuiChatMessage` 文本和工具输入/结果复用现有转写，私有 thinking 被过滤。暂停调专用 setPaused，清空只清记忆转录并换代，不删除知识。输入框沿用 AgentComposer 的草稿、发送失败保稿、输入法回车和模型按钮行为；记忆/审核 surface 的模型动作都转发到当前 workspace 的 `chat.switchModel`。审核后端把模型文本增量、工具开始/结果和错误作为结构化 parts 推送，因而工具卡在流式期间可见。此处能力限制只是前端交互面；真实五工具白名单和空资源加载器在主进程 `memory/curator/`、`safety/` 强制执行。回归：`test/unit/memory-curator-panel.spec.tsx`、`test/unit/safety-panel.spec.tsx` 与 `test/safety-service.mjs`，后端范围见 [记忆系统](memory-system.md)。

## 调度会话 fork

从历史某条消息分叉出**新的调度对话**（原会话 Pi 文件不动）：

- 入口与中栏一致：`ChatTranscript` 悬停条 fork 按钮（`caps.fork` + `actions.fork`；busy 中隐藏）。
- `orchestratorSurface` → `chat:fork {messageId, workspaceId}` → `Orchestrator.forkSession`：
  1. 纯函数 `planOrchestratorFork` 截到切点（含该消息），剥 queued / 计划卡 / 提问卡；种子只保留 user/assistant 正文。
  2. 原会话若还没有 `piSessionFile`，先把**完整**当前历史落成一条 Pi 会话，避免切走后丢掉原对话。
  3. `createForkedPiSession`：`SessionManager.create` + `appendMessage` 回放前缀 + `appendSessionInfo('Fork · …')`，与 GUI Pi driver 同款种子（工具调用不进种子）。
  4. 当前桶切到新文件并 `agent:history` 推送前缀；下次 send 续该文件。新文件出现在 `chat.sessionsList`（与既有历史会话同一套注册/呈现）。
- 回合进行中、空会话、切点不存在会拒绝。回归 `test/orchestrator-fork.mjs` + `test/unit/orchestrator-fork.spec.tsx`。

## 调度 askQuestion（结构化提问卡）

调度 Catalog（1.28.0）注入 `askQuestion`，语义对齐 Worker 侧自定义问卷（`shared/cursorAskQuestion.ts`：title + questions / label / allow_multiple）。不在 Worker 白名单。

- **工具**：`uiHost.askQuestion` → `Orchestrator.requestUserQuestion`（映射入参、挂卡到当前 assistant、`setBubble('等你回答','confirm')`）→ 用户作答后返回 `{answers}`；取消则工具失败（与 Worker `formatCursorAskQuestionResult` 同文案）。
- **回注**：专用通道 `chat:respondUserQuestion`（继续原用户提问回合）。渲染层 `DispatchUserQuestionCard` 复用同一套 `UserQuestionCard` 样式。
- **等待态**：`ChatMessage.userQuestion` + `dispatchWaitState`（转写贴底）；`Orchestrator.getHumanWait` / `AppContext.onOrchestratorHumanWait` 预留给另一单的 needs_you 状态通道，本期不改看板相位。
- **卡片身份隔离**：`UserQuestionCard` 内部表单按 `[sessionId, questionId]` 重挂，调度/GUI 共用。新请求重置选中项、自定义文本、分页和提交中状态；同一请求刷新或分页仍保留草稿。`abortPendingAsk` 只结算主进程旧请求，不能代替 React 状态隔离。
- **文本输入**：GUI 提问卡可按请求呈现单行或多行文本框及默认值；用户显式提交的空字符串、首尾空格和换行经 IPC 原样保留，取消与提交空文本不同。Worker 的 `host.ask` 适配器使用此能力，但公开工具注册仍随工具面迁移统一切换。
- **呈现边界**：结构化 `askQuestion` / GUI 问卷始终映射到提问卡；系统提示要求需要用户决策的提问走卡片。普通模型正文仍是正文，不按问号等文本特征自动猜测、生成或提交问卷，不能保证任意模型永远遵守提示。
- **输入框路由**：仅单题、去首尾空白后为单行且精确等于唯一选项 label 的文本快捷作答；不猜编号/字母。自由文本、多行、引用、多题与带附件消息走普通 `chat.send`，自定义答案需在卡内提交。`noteAnnotations.NOTE_ANNOTATION_PREFIX` 是展开端和识别端共享的批注协议标识，含会话/文件/网页批注的文本即使与选项相同也不作答。
- **新消息取代**：主进程 `sendPipeline` 成功将用户原文入队后调用 `abortPendingAsk(..., 'superseded')`，提问 Promise 返回 `{kind:'aborted',reason:'superseded'}`，工具按既有取消格式返回；卡片保留 `status:'aborted'` 并带 `abortReason:'superseded'`，显示「已被新消息取代」。原文/附件留在正常队列，原回合退出工具等待后照常续发；队列满、图片校验拒绝或宿主通知不取消提问。GUI `agentSessionSurface` 直接走 `agentSession.send`，没有输入框文本转答案的同款分支。
- **生命周期**：第二张提问卡到达或 `stop`/回合收口/清空/切历史会话时取消旧卡；重启装载 `sanitizeRestoredAskQuestions` 把 pending 翻 aborted。
- **回归**：`test/orchestrator-ask-question.mjs`（注册/挂卡/回注/消毒）、`test/unit/dispatch-ask-question.spec.tsx`（卡渲染 + 点选走 chat IPC）、`test/unit/orchestrator-suggested-replies.spec.tsx`（真实输入框发送边界）、`test/unit/node-main/orchestrator-question-supersede.spec.ts`（受理后解除工具等待与拒收保护）、`test/e2e/question-supersede.spec.ts`（真 Electron + mock LLM 的取消与后续回合）。

## 手动上下文压缩（/compact）

调度与支持该能力的 GUI Worker 都能在通用输入框敲 `/compact`（可带摘要侧重，如 `/compact 保留 API 改动`）手动压缩
会话上下文，不进模型上下文。解析单源 `src/shared/compactCommand.ts`。

- **数据流（GUI 会话）**：Composer 拦截 → `surface.actions.compact` →
  `agentSession:compact` → Host `compactSession`（忙时拒绝；未连接提示先发消息）→
  driver 合同 `GuiRuntimeConnection.compact?` → pi `session.compact()`
  （SDK 手动压缩入口，会先 abort 在途回合，故 Host 忙时拒绝）。引擎的
  compaction 生命周期经 driver 事件 → host 标记推送；成功后 Host 立即
  推一次 context 用量（tokens 多半变 null=未知，下回合恢复）。
- **数据流（调度）**：Composer/orchestratorSurface 拦截 → `chat:compact` →
  `Orchestrator.compactSession`（`runAsAgentWorkspace` 作用域内）→
  piProvider `compactOrchestratorSession`：活会话直接压；无活会话但绑定会话文件在
  （重启后/切了历史会话）先按文件续聊建会话再压并留在桶里复用；模型与生效配置
  不一致先重建（与 runPiProvider 同判键）。飞书等直发 `send()` 路径也拦 `/compact`
  （结果走通知 toast），桌面渲染层拦截在前不双报。
- **结果呈现**：进行中 / 完成画在会话消息流（`CompactDivider`：通栏细线、中央嵌
  三条轻线聚拢动画 +「正在压缩上下文」/ 时钟图标 +「上下文已压缩」，两侧渐隐；
  两态切换 `usePresence` + token，禁止 keyframes 进出场）。快照字段
  `ChatSurfaceSnapshot.compactions`，GUI 吃 `compaction` 推送（driver compaction
  事件 → host 标记；自动压缩同样出线；透明模式下另渲染 §6.4 分隔样式）；失败摘线，
  错误仍走 Composer hint（忙/空会话/已压缩/会话太小/重叠）。
  调度不再 localEcho 成功文案；GUI 不再只靠 `flashTip`（那条写进调度气泡）。
- **状态生命周期**：`running` 是一次性活跃态，始终贴消息流末尾；`complete` 是结算
  事件（不是持久活跃态）——回落 running，并把标记 `createdAt` 归位到压缩发生时
  最后一条非排队消息（`compactionAnchorAt`）。之后分割线停在那一轮，新消息画在
  线下方，不再常驻底部。`interleaveCompactionMarkers` 对 complete 按时间插入、
  对 running 只追加在末尾。
- **空闲与单飞**：引擎 `session.compact()` 会先 `abort()`（含 abortCompaction）。
  `safeCompactSession` 看 SDK `isStreaming`/`isCompacting` 并按 session 单飞——
  Host/Orchestrator 的 busy 与 SDK 短暂失步、或 Enter 连发叠两次 compact 时，
  后一次会把前一次的摘要信号掐掉（`Turn prefix summarization failed: aborted`）。
- **斜杠菜单**：Tab=补全命令文本（不执行，才能继续写摘要侧重）；Enter/点选=执行。
  菜单激活忽略 `keydown.repeat`，避免连发叠调用。
- **能力门控**：能力表 `CHAT_RUNTIME_CAPABILITIES.manualCompact`（现仅 pi=true——
  只有 pi SDK 有空闲期手动压缩入口；Claude/Codex/ACP（含 Cursor）没有工作台接入的对应 API）→
  渲染层 caps.manualCompact 决定 Composer 列不列命令、拦不拦输入；未支持表面敲
  /compact 落「未支持的命令」桌面通知（2026-10-20 起输入框上方 hint 提示条整体移除：
  成功不再提示，失败/被拒统一走 `notify:toast` 桌面通知，见 `composerNotice.ts`）。
- **回归**：`test/compact-command.mjs`（能力位/解析/归一/文案/流式拒压/重叠单飞）、
  `test/chat-compaction.mjs`（事件归并/pending 认领/完成后状态回落与标记归位）、
  `test/unit/compact-divider.spec.tsx`（两态 + presence 切换）、
  `test/unit/chat-transcript-compact.spec.tsx`（分割线插在消息流）、
  `test/unit/agent-composer-compact.spec.tsx`（菜单列出/点选/带侧重提交/未支持表面/
  Tab 不执行/Enter 连发不叠/失败走桌面通知）、
  `test/unit/composer-notice-toast.spec.tsx`（提示条移除后成功不提示、失败/被拒弹
  notify.toast 不落 DOM）；
  `test/unit/agent-composer-hotpath.spec.tsx`（打字不重渲输入条 chrome；发送读 ref）、
  `test/unit/chat-surface-composer-isolation.spec.tsx`（打字不带动会话流行重渲）。
  接线约束：`ChatSurfaceView` 传给 Composer/Transcript 的回调与 `chatStatus`/`preset`
  必须按字段 memo——每渲染新箭头会让打字或轨迹事件重建整段交错行。compact 分割线
  推导（`interleaveCompactionMarkers`）在 Transcript `useMemo` 内，按键本身不重跑。

## 阈值自动压缩（第一步，仅 Pi 引擎直通）

回合空闲收口时，若 transcript 占用占比 ≥ 可配阈值，自动走与 `/compact` **同一条**
`session.compact` 链路（Host `compactSession` / 调度 `Orchestrator.compactSession` →
`safeCompactSession`）。不做宿主侧摘要重播降级（cursor 等后续单独立项）。

- **判定**：纯函数 `shared/autoCompact.ts` 的 `decideAutoCompact`——能力位
  `CHAT_RUNTIME_CAPABILITIES.autoCompact`（现仅 pi）+ `AppConfig.autoCompact`
  （`enabled` 缺省 true、`ratio` 缺省 0.8，夹紧到 [0.5, 0.99]）+
  `tokens/contextWindow`；tokens 未知（刚压完）不触发，避免紧循环。
- **触发点**：GUI `Host.finishTurn` 无排队时；调度回合 `finally` 无排队且无
  瞬态自动重试时。有审批卡/提问卡挂起时 GUI 不触发。
- **互斥**：复用 compact 窗的 `busy` + `safeCompactSession` 单飞——进行中不重复
  触发；与手动 `/compact` 互斥（后到的一方得「正忙/正在压缩」）。
- **表面**：引擎 `compaction_start/end` 仍映射轨迹分割线，与 SDK 内置自动压缩同款 UI。
- **回归**：`test/auto-compact.mjs`（能力位/配置归一/超阈触发/busy 不重触/手动自动互斥口径）。

## 调度回合瞬态失败自动重试（2026-09-16）

调度回合因**瞬态服务错误**失败时（判定：`main/agent/turnRetry.ts` 的
`isTransientProviderError`——流提前断/超时/socket 类文案，对齐 pi-ai retry.js 可重试类；
401/402/上下文超限等确定性错误不重试），自动延时重发该回合：

- **两层重试**：请求级在 pi 侧（`syncPiRetrySettings` 下发 settings.json：
  6 次 × 2s 指数退避 ≈ 累计 126s，用户手工配过 `retry.maxRetries` 则尊重）；
  回合级在 Orchestrator（30s/60s/120s 各一次，`TURN_AUTO_RETRY_MAX=3`，连续失败
  计数按工作区、任一回合成功即清零）——合计可跨约 5–10 分钟的本机重负载/服务抖动窗口
  （实测跑测试链会把 LLM 的 SSE 流整窗掐断，见 2026-09-16 journal）。
- **流程**：回合收口 `failed` → `scheduleTurnAutoRetry` 写 `retryHint`
  （消息上可见倒计时文案）→ 到点调 `retry()`，其内置守卫（忙/失败末条不再成立
  则 no-op）兜住等待期间用户发消息、手动重试、清空等状态漂移；新回合开始即作废
  待触发定时器。断流线级观测**默认关**（旁路 tee 会把成功流再解码一遍）：
  环境变量 `MUSTER_LLM_STREAM_TRACE=1` 才包装 fetch，失败行落
  `userData/logs/llm-stream.ndjson`；`=all` 连成功也记。失败行含 `closeReason`
  与 `bodyPreview`（响应体前 240 字，不记请求体/Authorization）。2026-09-16 真机：
  智谱 `/responses` 会在 ~50ms 内回 HTTP **200** + `application/json` + 正好 70 字节
  + `connection: close`（不是 `text/event-stream`）。2026-09-16 19:26 起抓到正文：
  `{"code":401,"msg":"令牌已过期或验证不正确","success":false}`。pi-ai 按 SSE 去读 →
  0 事件 → 报 stream ended；`isTransientProviderError` 把它当瞬态重试，UI 看不到
  真 401。同钥其它请求可以是正常 SSE，所以不是「整把 key 废了」这么简单。
- **边界**：仅调度表面（GUI 会话不走此路径，只吃请求级预算；headless 已退役）；
  到上限后仍失败则照常报错等人工。
- **回归**：`test/turn-retry.mjs`（瞬态判定含实测报错原文/节奏 30s→60s→120s 封顶/
  上限常量）、`test/flexible-llm.mjs`（retry 设置下发/尊重手工值/合并保留）。

## 调度面会话批注

与 GUI 共用 `useSessionNotes` + `ChatSurfaceView`：`caps.notes` 在 `orchestratorSurface` 开启，`AgentFloat` 按 `workspaceId`（= `surface.sessionId` / `caps.draftKey`）挂宿主。划词区 `selArea` 仅在 **caps.notes 且已注入 notesHost** 时走 `gui-chat`（否则仍 `agent-chat`，手机壳不注入故无划词批注）。发送 / `sendNow` 都经 `expandForSend` 把 `批注N` 展开再进 `chat:send`。草稿桶必须用调度 `draftKey`（工作区 id），不能用 GUI 缺省的 `agent-session:` 前缀。回归 `test/unit/orchestrator-notes.spec.tsx` + `test/surface-parity.mjs`。

## 调度思考档

左列调度与中栏 GUI 共用 Composer 思考 chip（`status.thinking.available` + `actions.setThinking`；未设显示「默认」）。

- **调度**是工作区级：`chat:setThinking` → `Orchestrator.setThinking` 更新 v2 `agent-models.json` envelope 中的 `thinking`；启动时兼容读取旧 `agent-thinking.json`，成功迁移后删除 sidecar。`getContextStatus` / `agent:context` 推 `thinking: { level, available }`。未写入=跟随默认（`resolveThinkingLevel`：reasoning 模型 medium，否则 off）。`available` 与 GUI 同源 `providerThinkingConfigured`。
- **热读**：`runPiProvider` / `createPiSession` / 每回合 `prompt` 前读 `getThinkingLevel` 再 `safeSetThinkingLevel`，切档无需重连。切到未配置映射的服务商时清档。
- **GUI** 会话思考档已由泛化参数面板承载（`modelParameters` 的 reasoning 档）：渲染层不消费 legacy `thinkingLevel`/`thinkingConfigured`（history 仍透传，`status.thinking` 恒 null）；切模型的旧档清理由 host `reconcileModelParameters` 完成（不兼容 override 过滤）。见 [gui-worker-session.md](gui-worker-session.md)。
- 回归 `test/agent-thinking.mjs` + `test/unit/orchestrator-thinking.spec.tsx` + `test/surface-parity.mjs`。

## 已知边界

- 中文加粗「**已经完成。**然后」不渲染：CommonMark flanking，兼容层在 `MarkdownBody`（两表面共用），见 [markdown-cjk-emphasis.md](markdown-cjk-emphasis.md)。
- 重开/切回位置：调度面板关开或 GUI 会话逐出后重挂，有阅读记忆则恢复锚点/阅读位置并显示回底按钮，无记忆默认贴底。`lastUserIdRef` 只作「新用户回合到了」的跟随门闩，不把视口对齐到最后一条用户消息。跟随态下 composer overlay / 容器/内容几何变化补钉，不跟随时仅更新按钮而不拉走读者。内部滚动与外层滚动意图区分，边界允许滚动链时可继续滚会话。回归 `test/unit/chat-jump-bottom.spec.tsx`、`chat-transcript-content-pin.spec.tsx` 与 `chat-transcript-scroll-memory.spec.tsx`。
- **当前输入草稿的批注表仍为内存态**（调度与 GUI 同一 hook）：重启丢表，未入队草稿的孤儿 `批注N` 会被摘掉。手动确认队列另存 `noteDraft`，取回时恢复批注和胶囊并重新编号；队列保存的是完整展开正文，发送不依赖当前批注表。其余草稿批注持久化仍见 [ui-state-persistence.md](ui-state-persistence.md) §5.1。
- 「滚动到底部」浮钮（调度面板与 GUI 会话共用 `.chat-jump-bottom`）hover 只提亮 `--focus-border`，底色保持 `--bg-overlay`；勿把 background 换成 `--hover-fill-strong`（半透明叠白会把浮钮抹没）。
- 调度面板 bgTasks 的 `cwd` 现取工作区根路径（此前不传）；GUI 会话传会话 cwd。
- 面板退出动画期间 `live=false` 冻结最后一份快照（不跟流），回实况自动续上。
- `agent:token/thinking/tool` 事件不带 workspaceId（piProvider 直发）：适配器以
  `setOrchestratorFallbackWs(chatWorkspaceId)` 兜底，与旧 store 行为一致。
- i18n「未引用」计数 +10（preset 标题/锁提示经 caps 数据面 t()，非字面量调用；
  缺失恒 0，不影响覆盖合同）。


## 辅助输入卡片

会话中的用户消息气泡、本轮改动卡片与问答卡片（待答及已回答/取消态）共用 `--radius-chat-card: 20px`，独立于页面、弹窗和输入框圆角；用户气泡右下角保留 4px 小角。三者均无阴影；用户本人气泡不带描边或高亮框，调度/宿主气泡保留原中性细描边，问答卡与文件卡使用单层实体边框。用户气泡保留原尺寸和内边距，开启工作区主题色时使用该accent，关闭时恢复原surface-raised中性底色，正文统一使用与界面其他正文一致的fg-primary，不自动反转深浅；链接保留resolver可读前景；调度注入与宿主左侧气泡仍保持中性底色；问答卡与文件卡共用44px紧凑raised表头和canvas内容区，问答卡的题目、选项、已答回显与状态分层见 [composer-rich-input.md](composer-rich-input.md)，文件卡分区见 [turn-checkpoint.md](turn-checkpoint.md)。输入框仍沿用原有主题阴影。

调度与 GUI 共用 `guiApprovalCards.UserQuestionCard` 的平铺中性问答选项、`NoteEditor` 多行批注卡和 `ComposerEditable` 内容摘要胶囊，材质与动作约定见 [composer-rich-input.md](composer-rich-input.md)。批注编辑卡不重复原文，portal 到 body 并按实际尺寸避让输入区，滚动/窗口变化时重定位；操作区保持可见。批注的显示摘要不改变编号序列化；手动队列取回仍恢复独立批注快照。新旧编号同时存在时按完整 token 单次展开。

输入壳 chat-input-shell 聚焦描边使用共享 input-focus-border，resolver 以 70% border-control 与 30% input-border-focus 混合，降低深色下高亮边的突兀感；不改全局焦点角色，看板当前/选中卡片也消费同一个 input-focus-border；其余控件沿用原有焦点颜色。

## 操作等待反馈

snapshot.historyLoading/historyError 表示历史 IPC 的等待与错误，独立于模型 busy；首次空转录等待显示一处品牌动效，已有正文的后台同步不增加动效。GUI 目录刷新动作返回 Promise，供对应操作按钮等待结束。 组件与场景清单见 [品牌加载动效](brand-loading.md)。

## 跨会话代理汇报身份

消息投递核将真实会话发出的跨会话消息标为 `source: agent`，并从发送者会话生成 `sourceAgent` 身份快照（会话 id、名字、职业角色）；GUI 注入、忙时排队、持久化与 `toDisplayMessage` 保留该身份，引擎仍使用 user 角色。渲染使用发送者的内置职业头像与中性气泡，悬浮展示发送时的名字和职业，不读取用户或调度头像；缺少角色的旧记录回落工程师，没有具体发送者 id 时不合并连续代理头像。创建选角与完整接线见 [子代理职业角色](subagent-characters.md)。代理消息与调度注入一样，不作为人工历史停靠点、撤销入口或记忆摄入的用户输入，也不清除网络来源污点。

`buildReportParentInjectText` 与自动通知用空行分段，避免紧跟正文的 `---` 被 Markdown 解析为 Setext 标题而放大正文。此处不压制代理正文中刻意编写的 Markdown 标题。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D06.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：调度面板、GUI Worker 会话、专用记忆整理三用途共用唯一会话视图（转写+输入+状态条）——「一份渲染层合同 + caps 能力位 + 各用途适配器」，新增会话级功能改一处两表面生效；记忆会话只给纯文本输入壳，信封展示不进转写。
- 为什么这样设计：必选动作=共同语义（tsc 报缺实现）、caps=表面差异（数据不是分支），surface-parity 护栏禁壳直调 IPC；性能合同是「打字与后台元数据更新不重渲会话流」（queuedItems 引用稳定、delta 合批、行缓存、头像 Context 稳定）；调度 fork 原文件不动回放前缀、/compact 与自动压缩同链路单飞、瞬态失败回合级重试只给调度面（30s/60s/120s×3）。
- 明确不做：记忆会话不继承工程能力（五工具白名单在主进程强制，非前端摆设）；GUI 会话不做回合级自动重试（只吃请求级预算）；提示条已退役（成功静默，失败走 notify:toast）；折叠头 Worked for 计时不持久化（已知边界，见歧义点）。
- 歧义点：TurnFold「工作了 X 分 Y 秒」用前端 Date.now() 差值、未亲历流式的历史回退为工具/思考计数、同会话两种文案并存且不读 harness.durationMs——A=接受为观感级计时（非计量仪表，准确性诉求归 trajectory-view 的 harness chips；review 不把不读 durationMs 当缺陷）／B=改读 durationMs 并持久化（历史回合也显示真实耗时）。推荐 A。
