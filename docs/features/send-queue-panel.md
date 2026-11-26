# 统一排队面板（排队自动发送 + 手动确认发送）

功能职责：composer 外壳内部的统一发送队列管理，与编辑区共用一块纯色输入面：

```
┌────────────────────────────────────────────┐
│ 会话操作 …（有建议时显示）                 │
│ 排队自动发送 N                        [⌄] │ ← busy 队列（主进程）
│ 1 消息一                          [↑] […] │
│ 2 消息二                          [↑] […] │
├──────────────── 分割线 ────────────────────┤
│ 手动确认发送 N                             │ ← 本地清单（localStorage）
│ 1 消息三                          [↑] […] │
├────────────────────────────────────────────┤
│ 编辑草稿                                   │
│ + 模式                   模型 [≡] [⇥] [↑] │
└────────────────────────────────────────────┘
```

- **排队自动发送**（上泳道）：Agent 忙时经普通发送进入的主进程队列，回合正常结束
  后按序自动续发（既有语义不变）。
- **手动确认发送**（下泳道）：本地清单（沿用原 tosend 的 localStorage 存储，按会话
  隔离），永不自动发送。**/tosend 命令已删**（2026-09-08）——输入 `/tosend` 会按未支持
  命令提示；条目来源 = 跨泳道拖拽（把上泳道排队拖下来）或「忙时手动区非空则新消息
  默认进这里」的分流。**清单支持随文图片**（2026-09-27；此前纯文本）：`TosendItem.images`
  落 localStorage，出列/「立即」/拖回自动泳道时随 `onSend(text, images)` 透传。
  **写失败不静默**（2026-10-25，send-queue F-02）：localStorage 写入失败（配额满/隐私
  模式）经 `notifyComposerError` 一次性桌面通知「清单未能保存，重启后将丢失」——连续
  失败不刷屏，写恢复成功后重置（下次失败可再提示）；当次会话内内存清单仍可用。回归
  `test/unit/tosend-persist-failure.spec.tsx`。
- 面板只要可见（任一泳道有内容），上下两段常驻。两组列表各自限高滚动，标题始终可见；
  空组显示「暂无消息，可拖入此处」，保留跨组落点。组标题仅保留「排队自动发送 N / 手动确认发送 N」，不再并列重复说明。
- 每行：序号（悬停/聚焦变拖拽把手）｜缩略图（可开 ImageLightbox）+ 单行摘要（悬浮看全文，
  点击取回编辑）｜立即发送 + 常驻更多。立即按钮仅在悬停/聚焦时出现，无 hover 设备常显。
- 更多复用 ContextMenu，提供取回编辑、跨组转换、上移/下移、删除；边界项禁用，支持方向键、
  Enter、Escape 与焦点归还。菜单随条目删除/面板收起关闭。

## 回车分流（composer submit 路由）

- Agent **空闲** → 直接发送（原有行为不变）。
- Agent **忙**：
  - 手动确认泳道**为空** → 走原排队（主进程 busy 排队，进上泳道）；
  - 手动确认泳道**非空** → 新消息默认也进手动确认（清单语义跟随，成功不再弹提示，
    2026-10-20 起输入框上方 hint 条已移除）。带图消息一并进清单（2026-09-27 起清单支持随文图片）。

## 草稿入队操作

草稿入队位于发送按钮旁：发送/停止 30px 主题色，紧邻左侧是 24px 中性「留待确认」图标；忙时或已有自动队列，再向左显示自动入队图标。Enter 的实际去向收进发送/停止按钮提示。输入区顶部将真实会话建议、收起队列和命令胶囊放在同一行，无状态时不占空行。
操作按会话上下文常驻占位，空草稿、输入锁定或快捷短语搜索态只禁用按钮，不挂卸载动作行；首字输入与清空不改变输入区高度。

| 操作 | 可用条件 | 动作 |
|---|---|---|
| 留待确认 | 有正文**或有图** | 当前草稿（含图）进手动确认清单，清空输入 |
| 加入自动队列 | 有正文或有图，且 **busy 或已有排队**（`queuedCount > 0`） | 当前草稿走 `onSend`（忙时入自动队列，带图一并入队），成功后清空输入 |

- 空闲且无队列时只出「留待确认」；忙或已有队列时同时显示「加入自动队列」，空草稿同样占位。
- 图-only（无正文）也可入队（胶囊与 Enter 分流均放行）。
- 纯推导 `deriveDraftQueueCapsules`（`agentComposer/composerHelpers.ts`）+ 组件
  `ComposerDraftCapsules.tsx`；测试 `test/composer-helpers.mjs` + `composer-tools.mjs` +
  `test/unit/composer-draft-capsules.spec.tsx`。

## 批注入队与取回编辑

- `ChatSurfaceView` 将 `useSessionNotes.prepareManualDraft` / `restoreManualDraft` 装配给 composer。
  点击「留待确认」与忙时 Enter 分流统一在 `useTosendQueue.addTosend` 固化快照，发生在清空输入之前。
- `TosendItem.text` 是完整的原文、来源和用户批注展开正文；`noteDraft` 保存原 token 草稿与批注记录
  （聊天消息 id、文件路径/行号或网页选择器/截图），随本地清单落盘。清空草稿不会再使队列只剩「批注1」。
- 手动条目取回时先恢复批注表，再合并草稿；重新分配 id 和序号，避让输入框已有批注，保留可点胶囊。
  文件胶囊打开源文件及批注编辑框；原文快照不依赖易失的划词 DOM 标记。原高亮位置不重新构造。
- 队列正文发送走 `onSendResolved` / `onSendNowResolved`，不再次用当前草稿批注表展开。
  自动队列入队时已展开正文，取回仍为完整可编辑文本；目前不存原批注胶囊快照。
- 已被旧逻辑清空批注表、仅留裸编号的历史条目无法从编号恢复原文。旧普通条目仍兼容。
- 回归：`test/unit/composer-queued-notes.spec.tsx` 覆盖实际 host + composer 入队、忙时 Enter、
  长引文、重挂恢复、编号避让、取回后编辑和发送；`test/composer-tools.mjs` 验证快照独立与落盘往返。

## 「立即」请求原生投递

`ChatSurfaceActions.sendNow(text)` → `SendNowResult = 'sent' | 'steered' | 'unsupported' | 'queued' | 'failed'`：

| 表面 | 空闲 | 忙 |
|---|---|---|
| 调度（orchestrator） | 正常发送 | `PiSessionHandle.steer(text)`（SDK steer，`isStreaming === false` 时不尝试）；拒绝/失败回落排队 |
| GUI 会话 | 正常发送 | 仅对声明真实 turn-scoped steer 的 runtime 请求 driver 回执；内置 Pi 使用 SDK `steer()`，Harness 自己的 `queued` 不算立即插话，其他消息由工作台队列接管 |

- **插话切分转写（2026-10-03 修复，双面一致）**：steer 成功后旧 assistant 不再接流、
  定稿（running 工具卡按「未收到结果」收口），插话 user 消息与其后的**新 assistant
  占位**入流，回复落新占位。调度面在 `queueOps.sendNow` 切（`splitSteeredDisplayTurn`
  + `bucket.streamingAssistant` 落点引用，piProvider 经 `getAssistant` 间接层每次事件
  动态取落点；收口终态 error/aborted/工具数读切分后的占位）；GUI 会话面在 Host
  `splitSteeredTurn`（`src/main/agentSession/host/turn.ts`）。修复前调度面回复 delta
  继续写进插话之前的旧 assistant，「回复显示在插话消息之前」。await steer 期间回合
  已收口的竞态回落旧行为（只垫 user 消息不切分）。
- **普通发送不插话**：聊天输入框普通发送传 `steerOnBusy: false`，忙时进入「排队自动发送」泳道。
  「立即」只询问是否支持真实原生插话；只有 adapter 返回 `steered` 才算成功。
  `queued` 对用户插话没有价值，消息先不提交给 Harness，由工作台队列或 GUI 兜底弹窗决定后续动作。
- 提示出口（2026-10-20 改版）：输入框上方 hint 条整体移除，**成功不再提示**
  （steered/已发送/已入清单均静默）；失败与回落不静默，改弹**系统桌面通知**
  （`notify:toast`）：queued=「当前回合不接受插话，已加入排队末尾」、
  failed=「立即发送失败，请重试」且**条目保留可重试**（两条泳道一致）、
  带图点「立即」提示不支持插话、跨泳道入队失败提示「条目已保留」。
- 上泳道行点「立即」：**先 sendNow 受理，成功后再** `cancelQueued(id)` 摘掉排队副本
  （受理失败条目原地保留，不丢消息；queued 落点时新副本已在队尾，摘旧位置等价于
  挪到末尾）。
- GUI harness 不支持原生插话且返回 `unsupported` 时，立即按钮会打开兜底弹窗。用户可选择
  以用户身份写入该会话邮箱，或先中断当前回合再发送。邮箱写入调用
  `sessions.sendMessage`，中断发送以 `agentSession.abort({holdQueue:true})` 保留宿主队列，
  替代消息受理后再摘掉原条目；取消或任一路径失败都会保留队列条目。调度面没有该弹窗，继续按原有排队提示处理。

## 关键文件与数据流

| 文件 | 职责 |
|---|---|
| `src/renderer/src/components/QueueSendPanel.tsx` | 面板组件（纯展示）：双分组/摘要取回/更多菜单/HTML5 拖拽排序（把手按下才允许 dragstart，分组尾部空白=移到末尾） |
| `src/renderer/src/components/AgentComposer.tsx` + `agentComposer/useTosendQueue.ts` | 集成与分流：submit 路由、面板动作（编辑/删除/排序按泳道分派到本地清单或 surface 动作；手动确认清单的存取与面板动作都在 useTosendQueue，编排壳只接线） |
| `src/shared/chatSurface.ts` | 快照 `queuedItems: {id, text}[]` + 可选动作 `sendNow`/`editQueued`/`reorderQueued` |
| `src/shared/composerTools.ts` | `updateTosendItem`/`reorderTosendByIds`（手动泳道本地操作，纯函数；`test/composer-tools.mjs` 锁行为） |
| `src/main/agent/orchestrator/queueOps.ts` | `sendNow`（steer+切分转写+回落排队；空文本返回 failed 兜住 IPC 直调）/`splitSteeredDisplayTurn`（插话切分纯函数）/`editQueued`/`reorderQueued`（queue 与 display 同步改，emit `agent:history`；核心为纯函数，`test/orchestrator-queue-ops.mjs` 锁行为）；steer 的用户消息带 `steering:'send'` 标记、非 queued 入 display |
| `src/main/agentSession/host/sessionOps.ts` | `editQueued`/`reorderQueued`（entry.queue 与 entry.messages 同步改；补推 busy 推送刷新胶囊；重排核心为纯函数 `reorderQueueItems`） |
| IPC / preload | `chat:sendNow|chat:editQueued|chat:reorderQueued`；`agentSession:editQueued|agentSession:reorderQueued` |

排序语义（主进程两侧一致）：按泳道全量 id 重排 queue；并发窗口新入队（不在 ids 里）
的保序追加尾部不丢；display 里的 queued 消息随之重排（其余消息顺序不动）。

**跨泳道拖拽**：排队→手动确认 = 摘排队副本 + 文本与随文图片入本地清单（2026-09-27 起
图片跟过去，经 `getQueuedImages` 从 display/queue 补全——面板快照只带张数）；手动确认→
排队 = 移出清单 + 普通发送（含图；忙时入队；空闲无队列，直接发出）。**受理失败的条目留
回清单并提示**（队满/清空中）——该守卫仅 GUI 会话面生效（agentSessionSurface 的 send 回
ok=false）；调度面 `chat:send` 恒回受理成功（队满走 notify 弃置，见下边界），手动
条目仍会被移除。拖拽经过的泳道整段高亮为落点。

## 交互与已知边界

- 插话仅文本（steer 不带图片）。上下泳道条目都可带图，行内以 `🖼 n` 角标标出张数
  （`ChatQueuedItem.imageCount`，快照只带张数不带 base64）。
  带图行**禁用「立即」**（点击提示「带图消息不支持插话，将在当前回合结束后自动发出」），
  不再走 sendNow 丢图；`ChatSurfaceActions.sendNow` 合同同步收紧为纯文本。
- **取回编辑**：点击行摘要或更多菜单的「取回输入框编辑」，整条文+图回到输入框并出列。
  原草稿非空时以换行追加文字、图片按 id 合并，不覆盖当前输入；附件条可删图/点开灯箱。
  主进程 `editQueued` 仍在（合同保留），但面板不再走它。
- **重启恢复保留图片**（2026-09-27，调度面）：`collectRestoredQueue` 从 display 的
  `images` 还原队列条目；此前只还 `{id,text}`，出队发给模型时图片丢失。GUI 会话面
  恢复时整条队列按设计剥离（`sanitizeRestoredMessages` 去 queued 标记），不在此列。
- 自动队列 8 条（队满通知）、手动清单 20 条；普通手动条目限 2000 字，带 `noteDraft`
  的条目保留完整展开正文与编辑快照，不截掉长引文后的用户批注。
- 调度面 `chat:send`：**模型级发图守卫**会回 `{accepted:false, error}`（当前调度模型
  非多模态且消息带图；文案「模型 X 不支持图片输入」）。`orchestratorSurface.send`
  据此返回 false，Composer 保留文本与图片草稿并 flashTip。队满仍走 notify 弃置、
  不回失败——跨泳道拖拽的「失败留回清单」守卫因此只覆盖 GUI 会话面（队满路径），
  发图被拒这条已覆盖调度面。
- 聊天流**不显示排队消息**（2026-09-08 返修：ChatSurfaceView 传给 ChatTranscript 前
  过滤 `queued`）——面板是排队消息唯一的展示/管理入口，消息在真正发出（主进程摘掉
  queued 标记）后才以普通用户消息出现在会话流里，落位在当时的对话顺序处。
- 插话产生的用户消息不受过滤影响（无 queued 标记），直接进会话流；steer 成功即切分
  转写（见上），其后回复落新 assistant 占位，不会串进插话之前的气泡。
- **已知竞态（与 GUI 会话同类 TOCTOU）**：若引擎恰在 `await steer` 解析与切分之间
  以 error 收口（窗口为微任务级），error 章落旧占位、切分照常进行，收口计划读到干净
  的新占位 → 该次失败按成功收口（不触发自动重试/不挡 drain）。降级非损坏，接受。
- Cursor、Muse 等 GUI harness 忙时不提供原生 steer，「立即」打开兜底弹窗，不先写入排队消息；内置 Pi（Muster Core）经 Pi SDK `steer()` 原生支持文本插话。
- 独立调度面的 Pi steer 仍是弱打断：内容在当前工具批结束后注入，不打断手头工作。
- 调度 / GUI steer 成功后，插话用户消息入转写（不标 queued），其前 assistant 折叠
  为旧回合；GUI Host 另开一条空 assistant 承接后续 delta，避免回复继续拼在旧流里
  （插话看起来孤零零沉底）。渲染定位见 `locateStreamingAssistantIndex`。
- 面板与收起胶囊分别走 usePresence + `acc` 骨架；行不做进出场动画。退场期间加 inert，避免点击正在离场的操作。
- **最小化**：面板右上角向下箭头（`.agent-composer-qspanel-min`）把面板缩成输入区顶部的胶囊。`AgentComposer` 通过 `renderHeader` 将其与会话建议、命令胶囊装配到同一行；三者使用相同的 28px 高度、caption 字号、纯色底和胶囊圆角，窄面板自然换行。未传 `renderHeader` 的独立面板保留原位置。
  `.agent-composer-qscapsule`（图标 +「自动 N｜待确认 M」+ 展开箭头，仅非零段，无彩点、阴影或描边）。
  点胶囊展开，焦点在收起按钮与胶囊之间交接。
  偏好存 `localStorage['muster.queuePanel.minimized']`，GUI 会话与调度浮窗共用、重启保持；队列清空时胶囊同样退场。
  收起态不能拖拽跨泳道（需先展开）。`test/unit/queue-send-panel-minimize.spec.tsx` 守收起/展开/持久化/清空退场。
- 视觉：输入区只有外壳一个轮廓，队列继承输入面实底，消息平铺，分组以留白区分。
  队列与正文编辑区之间仅一条浅线；行/立即按钮均中性色，不再套小卡或用强调绿。
  收起胶囊与建议胶囊共用 `--composer-chip` / `--composer-chip-hover`。

## 设计与验证

已按 输入与队列简化方案 落地，
[交互原型](../prototypes/composer-queue-study/composer-queue-study.html) 保留为设计参考。
`test/unit/composer-solid-layout.spec.tsx` 覆盖菜单/键盘/焦点、拖拽排序与跨组、真实输入壳接线、
取回消息保留草稿与图片；原队列图片、失败回滚、最小化和建议胶囊用例继续覆盖既有语义。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D06.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：composer 内统一双泳道——排队自动发送（主进程，busy 时 Enter 默认进，回合结束后按序续发）+手动确认发送（本地清单，永不自动发；忙时手动区非空则新消息跟随进）；「立即」=显式插话 steer；跨泳道拖拽/取回编辑/最小化胶囊。
- 为什么这样设计：普通发送忙时不插话（2026-09-08 修复：pi steer 是弱打断，隐式插话=「发出去了没人理」）；插话成功即切分转写（旧 assistant 定稿+新占位承接，双面一致，修「回复显示在插话之前」）；上泳道「立即」先受理成功再摘副本不丢消息；失败不静默走桌面通知且条目保留可重试；成功静默（2026-10-20 提示条退役）；批注入队固化快照（noteDraft 随清单落盘，取回恢复批注表并避让编号）。
- 明确不做：排队消息不进聊天流（面板是唯一展示/管理入口，发出后才以普通消息入流落当时顺序位）；插话仅文本（steer 不带图，带图行禁「立即」）；调度面 Pi steer 弱打断语义不升级强打断。GUI 内置 Pi 的原生插话只覆盖文本 steer，普通后续消息仍按宿主队列处理。
- 歧义点：调度面 chat:send 恒回受理成功、队满走 notify 弃置不回失败（sendPipeline.ts:112 已证实）→ 跨泳道拖拽「失败留回清单」守卫只覆盖 GUI 会话面，调度面拖拽遇队满条目被移出清单、仅剩一条通知——A=接受不对称（队满 8 条是极端场景、notify 已明示；统一要改 chat:send 返回合同，波及面大）／B=统一两表面 send 受理返回协议（守卫全覆盖，代价是 IPC 合同与调度发送链路改动）。推荐 A——review 按 P2 已知不对称记录，不改合同；若用户认为「手动清单条目被弃置」不可接受则升 B。

## 搬移守卫（2026-10-26）

- auto→manual 搬移前预检：超 2000 字或手动清单满 20 条时提示并保留自动泳道原位，不截断、不裁无关旧条目（审计 F-01 修复）。
- 拖拽/菜单加入自动队列遇忙且自动泳道 ≥8 条：不发起搬移，条目留在手动清单并通知「队列已满，条目已退回清单」（用户拍板；审计 F-03 修复）。空闲时主进程直发不查上限；预检后队列被并发填满的残余窄窗口仍是旧行为（系统通知+条目出清单，代码注释已披露）。
