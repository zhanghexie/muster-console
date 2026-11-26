# 证据归集器（Evidence Collector）

> 状态：实现说明（2026-09-15，T4.4 首版；同日 T4.5 补证据页 UI；2026-09-19 O10 并入留言投递）
> 代码：纯函数 `src/shared/evidence.ts`；主进程服务 `src/main/sessions/evidence.ts`（`EvidenceCollector`）；证据页 `src/renderer/src/components/EvidencePanel.tsx`
> 关联：[board-status.md](board-status.md)（phase 翻转来源）；[gui-worker-session.md](gui-worker-session.md)（bgTasks）；[session-mailbox.md](session-mailbox.md)（会话通信）；[animation-system.md](animation-system.md)（面板进出场/手风琴）

---

## 1. 职责

「为什么是 done」要有证据链：把 Worker 工作过程的关键侧影按会话归档到 `userData/evidence/<sessionId>/`，供事后回看（T4.5 证据页）与验收取证。证据是 **best-effort**：任何 IO 失败只 `console.warn`，绝不影响会话主流程。

O10 起证据链覆盖两条主线：**phase 翻转**（pty 切片）与**工作输出**（bgTasks 摘要/截图）。曾有的第四类留言投递账本（`message-ledger`，O10）已随子代理邮箱重构（2026-10-21）失去生产触发点，2026-11-09 起连同 kind、收集入口与证据页展示整体删除；旧索引里的遗留条目按未知 kind 通用展示。

三类证据（共享任务翻转已退出，旧未知 kind 使用通用展示）：

| kind | 触发 | 形态 | 默认 |
|------|------|------|------|
| `pty-slice` | 看板状态翻转（`setPhase` 推导出 BoardStatus 三档变化，即 `nextStatus !== prevStatus`） | 翻转时刻 pty buffer 尾部 **120 行**切片（已去 ANSI）落 `p-*.txt`，45s 后补抓 after 段追加同一文件 | 开 |
| `bgtask-summary` | GUI 会话后台终端任务终态（`BackgroundTaskManager.complete` → `onTaskFinished` 回调） | 命令/exitCode/输出摘要**内联**进索引（不落单独文件）；只收 `kind=shell`（构建/测试输出） | 开 |
| `browser-shot` | GUI 会话调用 `browser.screenshot`（工具包装层 `tools/catalogHostTools.ts`，按 `exec.sessionId` 归属）；或**回合结束自动截图**（任务 D，2026-10-08）：回合收口时对本回合实际用过的 tab 各截一帧（GUI=turn-complete 收口 / CLI=终端 Worker 活动信号 idle，见 `browser/turnShots.ts` 台账） | 截图 png **复制**进会话目录，索引记 `sourcePath`（browser-captures 原路径）；回合截图条目另带 `turnShot: {turnId?, url?}`（证据页标签显示 tab url） | **关**（`config.evidence.browserShots: true` 手动开启） |

## 2. 目录与索引

```
userData/evidence/<sessionId>/
  index.json        # EvidenceIndex（version 1）：entries[]（id/kind/ts/phase?/file?/bgTask?/sourcePath?/afterTs?/message?）
  p-<id>.txt        # pty 切片（[phase-flip] 头行 + --- before --- 段 + --- after +45s --- 段）
  s-<id>.png        # browser 截图副本
```

- 索引原子写（`writeJsonAtomicSync`）；单会话条目上限 500（FIFO 丢最旧，**不分 kind** 同池淘汰）。
- `sessionId` 做目录名前过 `sanitizeEvidenceSessionDir` 白名单校验（防路径穿越；应用生成的 UUID 天然合法）。
- 装配：`index.ts` 创建收集器 → `sessions.attachEvidence`（pty 翻转挂钩）+ `ctx.bindEvidence`（browser 工具经 `ctx.evidence` 访问）+ `bgTasks.onTaskFinished`（摘要挂钩）。

## 3. 7 天滚动清理

收集器由 Runtime Kernel 服务域启动并托管：`stop()` 取消首次 30 秒清理、24 小时周期清理及所有待补抓的 after 计时器，关闭后不再创建新证据或补抓任务。文件写入均同步完成，因此停机无需把尚未开始的计时器回调当作在途 IO 等待。

`cleanupExpired(now)`：启动后 30s 首跑 + 每 24h 一轮（timer 均 unref）。

- **条目级**：`ts` 距 now 超 7 天的条目剔除，其关联文件（`file`）删除；索引有变即重写。
- **目录级**：条目清空 → 删整个会话目录。
- **孤儿目录**（无 index.json 或损坏）：目录 mtime 超 7 天即删。
- 删目录前 `lstat` 防链接（Windows junction 教训：链接只 `unlinkSync`，禁 recursive rm 穿透）。

## 4. 关键文件

| 文件 | 职责 |
|------|------|
| `src/shared/evidence.ts` | 类型/常量/纯函数：`slicePtyTail`、`formatPhaseFlipHeader`、`appendEvidenceEntry`（FIFO）、`pruneEvidenceEntries`、`evidenceDirExpired`、`sanitizeEvidenceSessionDir` |
| `src/main/sessions/evidence.ts` | `EvidenceCollector`：归集入口（`recordPhaseFlip`/`recordBgTaskFinished`/`recordBrowserShot`）+ 索引读写 + 滚动清理；`now`/`afterMs` 可注入（测试） |
| `src/main/sessions.ts` | `setPhase` 翻转处调用 `recordPhaseFlip`（`attachEvidence` 注入，未注入零开销） |
| `src/main/agentSession/background/manager.ts` | `onTaskFinished` 回调（终态任务快照） |
| `src/main/agentSession/tools/catalogHostTools.ts` | GUI 宿主工具统一包装；`browser.screenshot` 执行后按 `exec.sessionId` 归集；browser.* 成功即记回合归属台账（`recordBrowserToolUse`） |
| `src/main/browser/turnShots.ts` | 回合截图归属台账纯逻辑（任务 D）：`TurnTabLedger`（按 sessionId 记/取走即清/封顶 8）/`shouldCapture`（开关+目标存活谓词）；`test/browser-turn-shot-policy.mjs` |
| `src/main/browser/turnShotCapture.ts` | 回合收口采集胶水：`recordBrowserToolUse`（工具成功记 tab）+ `captureTurnShots`（fire-and-forget，抓帧落 browser-captures → `recordBrowserShot` 带 turnShot 元数据；任何失败静默） |
| `src/main/agentSession/host/turn.ts` | GUI 回合收口 `finishTurn` 调 `captureTurnShots`（turnId=收口回合 assistant 消息 id）；`lifecycle.ts` close 时清台账 |
| `src/main/ipc/evidence.ts` | 证据页只读 IPC：`evidence:index` / `evidence:entryText` / `evidence:entryImage`（handle 统一入口；`ctx.evidence` 晚绑定闭包取值） |
| `src/renderer/src/components/EvidencePanel.tsx` | 证据页弹窗（时间线/懒加载/大图） |
| `src/renderer/src/panels/evidenceViewStore.ts` | 打开状态小 store（needsReadStore 范式）：左栏/看板右键 `openEvidenceView`，App 根层级唯一宿主 |
| `src/renderer/src/styles/evidence.css` | 证据页样式（token 专用，无字面量时长） |
| `src/shared/i18n/locales/fragments/evidence.ts` | 词条（en） |
| `test/unit/evidence-panel.spec.tsx` | 证据页组件测试（api-mock） |
| `src/shared/types.ts` | `AppConfig.evidence?: { browserShots?: boolean }`（config normalize 透传，同 `browser` 字段先例） |
| `test/evidence.mjs` | 纯函数 + 收集器集成（翻转切片/摘要/截图开关/清理/留言账本收集入口）+ 读取 API（磁盘回源/防穿越） |
| `test/sessions-message.mjs` | sessions.message 投递/账本（evidence stub 仅断言 stored 案例不记证据；生产触发点已随邮箱重构移除） |

## 5. 证据页 UI（T4.5）

会话详情「证据」弹窗：回看「为什么是 done」的证据链。

- **入口**：左栏会话右键 / 看板卡片右键「查看证据」→ `openEvidenceView({sessionId, sessionName})`；`EvidencePanel` 挂 App 根层级（唯一宿主，避 h-strip transform 劫持 fixed），`usePresence` 驱动 `mp-scrim`+`mp-panel` 进出场（Esc/点遮罩关闭，关闭期内容冻结快照）。
- **时间线**：条目按 `ts` 倒序（最新在上）；左竖线 + kind 色点（蓝=phase 翻转 / 紫=后台任务 / 绿=截图；旧索引里的未知 kind 用灰色通用展示）。
  - `pty-slice`：头行 `from → to` 两枚状态胶囊（`BOARD_STATUS_PRESENTATION` 文案 + session-capsule 色调；`from`/`to` 是 **BoardStatus**，非 phase kind）+ 上报来源（model/llm/user）+「含后续」徽标（`afterTs` 存在时）；点击 `acc` 手风琴展开正文（首次展开才调 `evidence:entryText`，之后缓存）。
  - `bgtask-summary`：命令等宽截断 + 状态胶囊（含 `exit N`）；展开看输出摘要全文。
  - `browser-shot`：缩略图（挂载即拉 `evidence:entryImage`），点击进 `ImageLightbox` 大图（Esc 只关大图不关面板）；回合截图条目标签带采集时刻 tab url（单行省略，全文走 title）。
- **数据通道**：`window.api.evidence.getIndex/entryText/entryImage`；主进程 `readIndex` 活跃缓存优先、miss 落盘（历史/重启后会话）。正文/图片按条目懒加载，索引只在打开/重开/手动刷新时拉。
- **安全**：entryId 必须命中该会话索引条目才允许读其文件，且文件名二次白名单（`^[A-Za-z0-9._-]+\.(txt|png)$`）——渲染层任何入参构不成路径穿越（篡改索引的回归样本见 `test/evidence.mjs` §6）。
- **边界**：文件已被 7 天清理/读取失败时显示占位文案；索引拉取失败显示错误态 + 重试；会话无归档显示空态说明。

## 6. 已知边界

- **GUI（chat）会话无 pty-slice**：`getPtyTail` 返回 undefined 即跳过（不记空条目）；GUI 会话 transcript 切片属 T2.1（claude driver）后续范畴。
- pty 会话翻转时**尚无输出**（buffer 全空白）同样跳过——空切片无证据价值。
- after 段补抓 best-effort：45s 内会话退出/buffer 消亡/内容未变则不追加（文件只含 before 段）。
- `pty-slice` 的「前后」语义：before=翻转时刻尾部 120 行，after=45s 后再取尾部 120 行（PtyManager chunk buffer 无时间索引，无法精确按翻转点前后对半切）。
- subagent/timer 类后台任务不进证据链（条目语义是「构建/测试输出摘要」）；如需扩展改 `recordBgTaskFinished` 的 kind 过滤。
- **编排事件不单独落证据（O10 取舍）**：orchestrator 事件队列是调度视角的聚合通知，与证据语义重叠——phase 翻转已有 pty-slice、留言投递已有账本、guard 类告警属 `orchestrator-events.md` 自身链路；再落一份是纯冗余。
- 设置页的 browserShots 开关未做（当前仅 config 手改）；做了记得回填本表。
- **回合截图的「回合」边界**：宿主工具执行上下文只有 sessionId 没有 turnId，台账按 sessionId 键、收口取走即清界定回合；CLI 侧收口依赖 Worker 自报活动信号 `idle`（不报则该回合不截，多报则按上报点分段截）。隐藏 webview 的 `capturePage` 取当前帧 best-effort，抓不到即跳过。
- 清理只扫 `userData/evidence/`，不动 browser-captures 原图（browser-captures 有自己的 keep-20 策略）。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D04-D05.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：「为什么是 done」的证据链——按会话归集四类证据（phase 翻转 pty 切片、bgTasks 输出摘要、浏览器截图〔默认关〕、留言账本）到 `userData/evidence/<sessionId>/`，证据页时间线回看；验收取证的旁证。
- 为什么这样设计：best-effort 是硬纪律（任何 IO 失败只 console.warn 绝不影响会话主流程）；触发点全部挂在既有事实源（setPhase 翻转、任务终态回调、留言落账成功后）不新造采集路径；账本落账成功才记证据——账本都没有的留言不该出现在证据链；500 条 FIFO 同池淘汰+7 天滚动清理+目录级删除防膨胀；entryId 必须命中该会话索引+文件名二次白名单（渲染层任何入参构不成路径穿越）；编排事件不单独落证据（与 phase 翻转/留言账本语义重叠，纯冗余——O10 取舍）。
- 明确不做：GUI 会话无 pty-slice（GUI transcript 切片属 T2.1 后续范畴；buffer 全空白跳过不记空条目）；subagent/timer 后台任务不进证据链（语义=构建/测试输出摘要）；after 段补抓 best-effort（45s 窗口， PtyManager chunk buffer 无时间索引只能前后两段）；browser-captures 原图不受证据清理管辖（有自己的 keep-20）；设置页 browserShots 开关未做（文档挂了回填待办，已核代码未做）。
- 歧义点：①7 天滚动窗口是终态吗：A=终态（证据=过程侧影不是审计存档；争议通常在闭环后短期内；真源在会话记录/Git/验收账本）／B=延长或可配（验收纠纷可能超 7 天）。推荐 A。②browserShots 设置页开关：A=排期补设置页开关（config 手改几乎不可发现，回合截图能力形同不存在）／B=维持 config 手改（每回合每 tab 一张成本高、默认关是刻意保守，低频专家偏好不值得占设置页面）。推荐 B——若用户认为截图对验收取证有普遍价值则选 A，并回填文档待办。
