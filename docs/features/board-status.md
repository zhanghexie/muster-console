# 看板状态（两种主动上报与宿主空闲判定）

> 状态：实现说明（2026-10-05：执行事实与输出置信度分开；旧读屏结果失效；退出/归档/待处理统一）。
> 代码主入口：推导 `src/shared/boardStatus.ts`、写入 `src/main/sessions.ts`、协议 `src/main/protocol/statusBody.ts` + `shellApi.ts`、LLM 门控 `src/shared/screenClassify.ts`
> 关联：全局看板 `global-board.md`（分区展示侧）；hooks 安装 `src/main/runtime/builtins/scripts/*.mjs`；CLI Worker 的上报说明随首条简报投递

---

## 1. 两套通道，禁止再混

看板列只认三个**定死** phase：`idle`（空闲、不等人）/ `needs_you`（下一步在人，**含做完等验收**）/ `done`（已闭环、人不需要再看）。「工作中」由 GUI 实际回合、未结束 shell、近期 hook 或 pty 输出推出；仅有静默输出时显示 `quiet`（等待输出），不推断空闲，不让模型用自由文案驱动列。

| 通道 | 字段 | 谁写 | 作用 |
|------|------|------|------|
| 看板 phase | `SessionMeta.phase`（`value` + `source: model\|llm\|user` + `ts`） | 模型上报 `needs_you` / `done`、宿主 LLM 读屏兜底，或用户右键「标记完成」（source=user） | 推导「空闲 / 需要你 / 已完成」列 |
| 胶囊 | `liveStatus.label`（+ 可选 summary / kind 着色） | 模型经 `sessions.setStatus` 的 note 或 HTTP label/note 自由填写，最多10个Unicode字符；无预设词表 | 左栏胶囊文案，**不改列** |
| 通知 / 桌面气泡 | `ui.notify` | Worker / 调度 | 通知历史 + 桌面气泡 |
| hook activity | `SessionMeta.activity` | hooks 脚本 / GUI 宿主 | 第一档：`active` / `idle` / `waiting_input` / `blocked` |

模型上报的**工具面只有一个**：`sessions.setStatus`（GUI Worker 进程内 / 调度经 Catalog），`phase` 与 `note` 至少传一个——一次调用同时更新看板列和胶囊；省略 `note` 时宿主按 `phase` 补默认胶囊（needs_you→等验收/waiting、done→已完成/done），粘性规则拦下 phase 写入时不补默认（不冲掉用户语境）。CLI Worker 的 HTTP 上报同样要求`phase` / `label`（或别名 `note`）至少其一。`liveStatus.kind` **退出推导**（旧 `{kind:"done"}` 兼容期仍折成 `phase=done`；HOST 新文案不再教 `kind`）。`summary`（可选长说明）仅 HTTP body 可带——合并时工具面有意不带此参数（取舍记录：`note` 已承担 Worker 侧说明职责，host 内部写入路径不受影响）。

**调度自身的状态通道**（v2.5）：调度落盘会话不是 `SessionMeta`，没有 `statusToken`。`sessions.setStatus` 在调用链是调度、且未传 `sessionId` / `externalSessionId` / `statusToken` 时，解析为合成 id `orchestrator:<workspaceId>`，写入独立的 `scheduler-status.json`（按工作区）。显式传 Worker `sessionId` 仍改该 Worker（调度代报 Worker 的老路径不变）。防呆：

- **不建 SessionMeta，不进入全局看板**，不走 `setPhase` / 脏树回注 / `afterNeedsYouReported`；后台 `scheduler-status.json` 仍供调度决策、唤醒和审批读取；
- 左下角工作区列表**不再显示调度状态胶囊**。调度实际 assistant 回复由 [调度回复气泡](scheduler-panel-entry.md) 订阅：未读且面板未打开时把对应工作区的「对话」按钮改为需要用户的黄色，悬浮才显示正文卡；折叠时按钮随隐藏行隐藏；黄点数字 **只计 Worker**；
- 调度对话入口不再进入全局看板，左栏工作区栈和调度对话面板仍保留。
- 调度自身切到 `needs_you` **不弹系统桌面通知**（`decideNotify` reason=`scheduler`）；Worker 的 needs_you 通知照旧；
- 合成 id 即使被模型写进 `sessionId` 也走调度通道，避免误造 Worker 卡片。

内置 CLI 走同一管道：spawn 已注入 `MUSTER_STATUS_URL`；Worker 按首条简报中的方式上报。没有 hook 合法，退化为模型上报 → LLM 读屏。

**验收入口**：通过看板卡片及右键菜单处理，分别走 `sessions.markProcessed` / `sessions.review`（decision + note）；GUI 会话输入框不再显示 needs_you 操作栏。输入框中的模型建议只用于编辑回复，详见 [suggestion-capsules.md](suggestion-capsules.md)。

**交验前置门**（R-14，详见 [dimension-gates.md](dimension-gates.md)）：编排会话报 needs_you 时宿主先跑机械维度门（i18n/动画），**红灯的会话不进「需要你」列**（卡片留工作列带徽标，`sessions.review` passed 同步硬阻断）；逃生门=看板右键「强制验收（跳过维度门）」+ 验收账本 `dimension-gate-override` 留痕。手工会话不进门，人验即终局。

---

## 2. 推导优先级（读时，仍不落显示态）

`deriveBoardStatus` / `boardStatusOfSession`：

```text
未恢复 dormant → 保留 phase=done/needs_you，否则 idle
  → 进程 exited → done（已闭环）或 error（未闭环）
  → hook blocked / waiting_input（粘性等待）
  → phase=done
  → scheduled
  → GUI 在途回合 / 未结束 shell / 新鲜 active（<30s）→ working
  → phase=needs_you → waiting
  → phase=idle
  → lifecycle working / quiet / blocked
  → starting 超 90s 且无 firstSignalAt → no_signal
  → 默认 idle
```

要点：

- **phase=done 盖过进程 exited**：已合入/已闭环的会话不因 GUI 闲置退出或 pty 退出而灰化、不进归档列。左栏/看板图标走 `sessionDisplayStatus`（**只有 `archived=true` 才按 exited 灰化**）；列归属走 `sessionBoardColumn`（归档列只收 `archived`）。
- **未完成的退出进需要你列**（error），覆盖残留 blocked/waiting；提供查看会话入口，不给验收。只有 archived 才进归档列。
- **运行中的 hook 卡住态优先**：Claude `PermissionRequest` → `needs_you`。`UserPromptSubmit` / Cursor `beforeSubmitPrompt` → working，并清掉上一轮 `done`。
- **`done` 只属于模型（或 LLM 兜底），且盖过工具链 hook active**：Cursor 每条 shell / `preToolUse` 都会报 `active`；若 active 盖过 done，Worker 刚 `POST phase=done` 就会被 `afterShellExecution` 打回「工作中」。hook 的 idle **不覆盖** 已完成（否则 Claude Stop 会把看板「已完成」打回空闲）。新一轮用户提问（`user-prompt-submit` / `gui-turn-start`）或显式启动新的任务回合（`clearDonePhase`）才清掉 `done`。
- **用户手动标记（source=user）最高权威**：普通模型/LLM 状态信号不能覆盖用户完成标记。用户可右键取消；实际新回合会撤销完成标记并保留验收账本。
- 输出启发式保留：750ms 内恢复输出进入 working；无执行事实且 working 静默满 30s 降为 quiet。明确 idle/stop 才判空闲。GUI 宿主回合与 `shell-start/end` 在途工具不按 5 分钟过期；无 id 的旧 shell hook 使用配对计数，Stop 清空执行事实。重启清执行事实，并用 runtimeStartedAt 重新计算无信号宽限。
- 新回合清掉所有旧 `done`，以及非 `user` 来源的旧 `idle` / `needs_you`。工具噪声保留 `done`。activity、phase、lifecycle 一次性发布，连续同 lifecycle 的信号也广播。

---

## 3. 模型上报（第二档）

GUI、CLI、默认调度提示和 `sessions.setStatus` 工具说明共用同一句话。

> 能继续就继续。必须用户行动时，报「需要你」并说清等什么。明确任务已交付并核验、用户无需再操作时，报「完成」。普通对话自然结束即可。

普通对话结束时，GUI 的回合结束事件和 CLI 的 Stop 或原生回合信号让宿主将活动判为空闲，并清除该回合的临时进度文字。同一回合显式上报的 `needs_you` 或 `done` 及其文字会保留。没有可靠结束信号的终端只凭静默显示「等待输出」。

HTTP 上报示例

```json
{"phase":"needs_you"}
{"phase":"done"}
{"label":"等 API key"}
```

- 工具和 HTTP 都只接受模型主动上报 `needs_you` 和 `done`。`phase=idle` 会报错，已保存的旧 `idle` 仍可读取。宿主 hook 继续使用 `activity=idle`。
- 只带 `label`（或别名 `note`）时**只改胶囊**，不改列。
- 模型文案去除首尾空白后按Unicode码点计数，最多10个；工具schema标明maxLength=10，工具和HTTP入口共用normalizeModelStatusLabel，超长明确报错且不写phase、不消耗通知预算，不静默截断。emoji不按UTF-16拆成两个字符；组合字符按码点分别计数。
- 不再生成或消费statusVocabulary：sessions.create参数、工作区默认配置和任务简报均无建议词表；旧工作区JSON中的遗留字段不读取，也不为此改写用户文件。省略note时仍按phase补宿主默认胶囊，hooks只报activity，生命周期推导不变。
- 旧 body `{kind:"done"}` 兼容折成 `phase=done`。
- `activity` 留给 **hooks 脚本**；模型协议不再提这四个词。
- Catalog：`sessions.setStatus` 是模型上报唯一入口（`phase`+`note` 至少一项，见 §1）；内置脚本更新仍要求 `allocate`+`resolveLaunch`，可选 hook 必须用 `_helpers.mjs` 的 `agentHookCommand`，只报 `activity+event`。

例如，用户要求先审批再合入时，隔离分支准备好后报 `needs_you`。

---

## 4. Hook（第一档）

不学 AO 把 Cursor `beforeShellExecution` 映射成需要你。

- **Claude**（已有）：Submit→active，Stop→idle，PermissionRequest→needs_you（内部仍写 `activity`）。
- **Cursor**：`sessionStart` / `beforeSubmitPrompt` / `preToolUse` / shell 前后 → active；`stop` 继续装着但不指望。`builtinScriptVersion` 10。
- **OpenCode**：不支持外部 hooks；改由 runtime 脚本（宿主进程内）轮询其原生 session server 的 `/session/status` 权威回合状态，经 `MUSTER_STATUS_URL` 上报 `activity`（event=`opencode-turn`，与 hook 同通道同纪律）。首帧上报基线、翻转必报、busy 持续每 20s 心跳；新回合开始（active）与 user-prompt-submit 同语义地清掉旧 `done`。这消除了 pty 启发式把 TUI 重绘字节（底部状态动画、resize 全量重绘）当工作的误判——结构化 idle 高于输出字节，重绘不再能把空闲会话打回「工作中」。纯决策画在 `opencode.mjs` 导出（`openCodeSessionBusy` / `nextMonitorReport`），回归见 `test/opencode-status-monitor.mjs`。
- **Codex**：官方 app-server WS 的 `turn/started` / `turn/completed` 通知和绑定 thread 的 `thread/read` 快照共同提供权威 activity；宿主通过当次启动租约的 `onActivity` 直接接收，不依赖 Worker MCP 或 HTTP 状态上报。每 3 秒校准可补漏通知，仅认可匹配 thread 的 `active` / `idle`，较旧的异步快照不能覆盖新通知；active 每 20 秒心跳不清交付 phase，也不覆盖审批等待。回合开始 event=`codex-turn` 与 user-prompt-submit 同语义清旧 `done`；回合结束不代替模型交付。旧宿主未订阅时保留原 HTTP 回退。没有认证 remote 的旧 CLI 没有这条权威通道，静默只能是 quiet。回归见 `test/codex-status-fallback.mjs`、`test/cli-workspace-context.mjs` 和真实 Codex 夹具。
- Hook 脚本 POST `activity+event`，可带 `toolUseId` 用于配对 shell 执行，**不写 phase、不写 label**。

---

## 5. 无头 LLM 读屏（第三档，绝望兜底）

不跑 Worker CLI、不进调度对话。主进程用现有 OpenAI 兼容配置（`openaiClient.ts` / `config.openai`）做一次非流式短补全：输入终端尾部纯文本（截 ~12k），输出只能是 `idle|needs_you|done|unknown`。`unknown` 丢弃。

**何时才调**（`shouldScreenClassify`，全部满足）：

1. 会话仍在跑、未 exited。
2. **前两路失效**：超过宽限（90s）没有任何 hook activity，且没有 `source=model` 的 `done|needs_you`；或 hook/model 信号已过期（普通信号 5min，泛化 active 与生命周期/看板共用 30s）。已收到明确的 idle 信号时直接使用宿主判定，直到新活动到来。有在途执行事实、新鲜 hook active 或 model `done|needs_you` 则不准调。未恢复 PTY 不启动、不读屏。
3. **内容变了**：pty 尾部文本 hash ≠ 上次评估 hash；不变直接跳过。
4. **节流**：每会话最少间隔 45s、全局同时只 1 个 in-flight；失败冷却加倍且**不写 lastHash**（冷却后可对同一屏重试）。无 API key / baseUrl 则整档停用。

请求开始即节流；结果返回后重验会话对象、分类代次、activity/phase 引用、最近输出时刻和当前屏幕 hash。新输入、信号变化、重启、退出、移除、换屏会丢弃旧结果；旧失败也不污染新代次冷却。

500ms 轮询**没有 TOML 热路径**（`pollOutputLifecycle` 不再 `evaluateManifest`）。`cursor.toml` 等文件先留着不删，避免误以为还在扫屏；blocked 改由 Claude hook 或模型 `needs_you` 或 LLM 兜底。

---

## 6. 关键文件

| 文件 | 职责 |
|------|------|
| `src/shared/boardStatus.ts` | 读时推导；`kind` 不参与 |
| `src/shared/screenClassify.ts` | LLM 门控纯函数（hash / 宽限 / 失效） |
| `src/main/sessions.ts` | `applyActivitySignal` / `setPhase` / `setLiveStatus` / `clearDonePhase` / `markProcessed` / `recordAcceptance` / `integrateWorktree`（成功后 phase=done、延迟归档） / 廉价轮询 + LLM |
| `src/shared/boardReview.ts` | 需要你列过滤、待验收快照、打回简报、acceptanceLog 截断 |
| `src/main/capabilities/hosts/sessions.ts` | `sessions.completeAndArchive`（done+归档）· `sessions.review`（passed/rejected/deferred/processed） |
| `src/shared/confirmDialog.ts` | 危险确认门摘要：`sessions.review` 按本次 decision 写清动作/后果/按钮，查会话快照展示隔离树与备注 |
| `src/main/sessions/screenClassifyLlm.ts` | 非流式 chat/completions |
| `src/main/protocol/statusBody.ts` | `phase` / `label`（别名 `note`）/ `activity`；`kind=done` 兼容 |
| `src/main/protocol/shellApi.ts` | `POST /v1/s/<token>/status` |
| `src/shared/setStatus.ts` | `sessions.setStatus` 纯决策核（校验/默认胶囊/粘性不覆盖），单测 `test/set-status-plan.mjs` |
| `src/shared/schedulerStatus.ts` | 调度通道解析 + 黄点只计 Worker，单测 `test/scheduler-status.mjs` / `test/unit/workspace-needs-bubble.spec.tsx` |
| `src/main/schedulerStatusStore.ts` | 调度状态落盘 `scheduler-status.json` + `scheduler:status` 广播 |
| `src/shared/notifyDecision.ts` | 推送决策纯函数：翻转/45s 账本/免打扰/权限（needs_you 不可关），单测 `test/notify-decision.mjs` |
| `src/main/notify/bus.ts` | 通知总线：setPhase/applyActivitySignal 上报翻转 → 决策 → 桌面 toast + 订阅者（T1.2/T1.3），自测 `test/notify-bus.mjs` |
| `src/main/capabilities/catalog/sessionsOps.ts` + `catalog/runtimesTerminalChat.ts` + `catalog/api.ts` | `sessions.setStatus`、runtime 脚本合同、Worker 白名单（2026-09-26 catalog 按工具组拆分，`catalog.ts` 为再导出垫片） |
| `src/shared/workerBrief.ts` | CLI 首条简报和状态上报说明 |
| `src/main/runtime/builtins/scripts/cursor-cli.mjs` 等 | allocate 时装 hooks（claude-code/.claude/settings.local.json、cursor-cli/.cursor/hooks.json、codex/.codex/hooks.json、gemini/.gemini/settings.json 的 BeforeAgent/AfterAgent；Gemini 恢复旧会话也补装；OpenCode 无 hooks，改由脚本内 monitor 轮询 /session/status 上报，见 §4）；`_agent-hook.mjs` 上报 |

左栏工作会话胶囊在未读时画 `liveStatus.label`，阅读后隐藏；右键标记未读或新状态到达后恢复（见 notification-system.md）。列/圆点只走 `deriveBoardStatus`。推导态翻转（→needs_you 类 / done / error 且源可信）会进推送决策与通知总线（见 notification-system.md §2.5）。

## 7. 需要你与验收资格

`boardReview.ts` 统一区分 approval / question / review / failure / no_signal。blocked 打开审批，waiting_input 与未回答的 decision/blocked ask 继续对话；phase=needs_you 且没有上述等待事实才走验收。notice 只作风险说明。红灯仅挡交付验收，不隐藏审批和异常。主进程 review 的 passed/rejected 重验资格，completeAndArchive 整批预检；显式手工标记/归档仍是独立操作。模型只报 needs_you 而不提供其他结构化事实时，仍按现有待验收约定处理，不根据自由文案猜原因。

## 8. 已知边界

- Cursor CLI 的 `stop` 在 print 模式不一定开火；收到原生回合结束信号时判为空闲，缺少信号时仍有读屏兜底。仅静默输出只能确认 quiet。
- codex（T5.3）有 hook 信任门：写入 `.codex/hooks.json` ≠ 生效，需用户在 codex TUI `/hooks` 里 trust 一次（且项目 `.codex/` 层需被 trust）；支持认证 remote 的 Codex 另有上述私有 app-server 权威状态通道，兼容旧启动仍依赖 hook、模型上报或 LLM 读屏。codex/gemini 均不接受外部指定 session id（allocate 返回 `codex-pending-`/`gemini-pending-` 占位），宿主 relaunch 降级新会话，真实 UUID 存在时（`canResume` 探测 `$CODEX_HOME/sessions` rollout / `~/.gemini/tmp/*/chats`）才走 `codex resume <id>` / `gemini --resume <id>`。
- hooks 是 best-effort：宿主未起/端口变化直接放行，不影响 agent 本体。
- 不再接 TOML 扫屏。
- `error` 表示未闭环退出，胶囊 kind 仍不驱动列。
- `sessions.setStatus` 的 phase 被 user 粘性拦下时只写显式 note、不补默认胶囊——用户手标语境优先于模型文案。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D04-D05.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：看板列归属与左栏状态的唯一事实推导链——hook activity（第一档）→模型上报 `sessions.setStatus`（第二档，工具面唯一入口）→LLM 读屏（第三档绝望兜底，不跑 Worker 不进对话）；「工作中/quiet」由执行事实推导，模型不得用自由文案驱动列。
- 为什么这样设计：phase 三值定死+胶囊自由文案（≤10 字码点计数，超长明确报错不静默截断）分离——列的严肃性与表达力分开；粘性规则全部来自真实噪声教训（Cursor preToolUse/shell 会打回 done、Claude Stop 会把已完成打回空闲→「done 只属于模型/LLM 兜底且盖过 hook active」；用户手标 source=user 最高权威）；LLM 读屏五重门控（仍在跑/前两档失效/内容变了/45s 节流+全局单飞/结果返回后重验代次）防扫描风暴；调度走 `orchestrator:<workspaceId>` 合成 id 独立通道不建 SessionMeta（防模型编造造卡、防呆已核）；无 hook 合法（无 hook 时退化为模型上报→读屏）。
- 明确不做：不学 AO 把 shell 执行映射 needs_you；无 TOML 热路径扫屏（cursor.toml 留着不删防误读，blocked 改由 hook/模型/LLM 兜底）；仅静默输出只显 quiet 不推断空闲；codex hooks 信任门是引擎侧行为宿主不代劳；hooks best-effort（宿主未起/端口变化直接放行）；调度 needs_you 不弹系统桌面通知（decideNotify reason=scheduler，Worker 照旧）。
- 歧义点：LLM 读屏第三档是长期保留还是过渡方案：A=长期保留（hooks 永远是 best-effort——codex 信任门、Cursor stop print 模式不开火、部分内置 CLI 无 hook，兜底有真实需求；review 把门控失效当缺陷、把兜底存在当正常路径）／B=过渡方案（hooks 覆盖改善后退役，review 关注收敛节奏）。推荐 A。
