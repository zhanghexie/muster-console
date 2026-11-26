# UI 状态持久化（标记 / 操作会不会跨重启丢）

> 状态：盘点 v1 + 拍板落地（2026-09-20）  
> 代码主入口：渲染层 localStorage 小 store + 主进程 `userData` / `.muster/workspace.json`
> 关联：[全局看板](global-board.md)（需要你已读）、[看板自由视图](board-free-view.md)、[通知系统](notification-system.md)、[后台任务](background-tasks.md)、[会话模型](session-model.md)、[专注模式](focus-mode.md)、[会话栏折叠](sessions-dock.md)、[虚拟屏](virtual-screen.md)、[文件面板](files-panel.md)、[Git 仓库树](git-repo-tree.md)

用户在 UI 点过、拖过、标过的状态，重启后有三种下场：**该留下且已留下**、**语义上就是会话态该丢**、**该留却静默丢了（缺口）**。本文是全仓盘点，给「修 / 不修 / 先拍板」当索引。不写动画、不改交互，只谈序列化。

判定口径：

| 判定 | 含义 |
|------|------|
| **该持久化（已落地）** | 用户会当成长偏好或未完成工作；重启丢了会觉得「我标过的没了」。已经有落盘。 |
| **该持久化（本轮已修）** | 同上，本轮补上。 |
| **该持久化（待派）** | 同上，改动超出本轮「顺手」范围，列清单。 |
| **会话态该丢** | 导航史、浮层开合、进行中手势、一次性预览。丢掉符合心智（或产品已写明）。 |
| **拿不准** | 两边都说得通，先记现象，等人拍板。 |

落盘分层（不要混）：

| 层 | 典型键 / 文件 | 适用 |
|----|----------------|------|
| 渲染层 `localStorage` | `muster.*.v1`、`gboard.*` | 全局 UI 偏好、按工作区 ID 分桶的渲染偏好、与主进程无关的已读集合 |
| 工作区 `.muster/workspace.json` | `WorkspaceFileConfig` | 按工作区的布局 / Git / 文件树开关 |
| 主进程 `userData` | `sessions.json`、`bg-tasks.json`、`config.json` | 会话元数据、任务注册表、应用配置 |

---

## 1. 本轮修复：需要你已读

**缺口**：全局看板「需要你」跳进会话即已读；重启后卡片全回未读、列头「N 未读」复活。根因 `needsReadStore.ts` 纯内存（旧注释写明「不落盘、不跨重启」）。

**设计动机（保留）**：启动存量**不探出**——对齐 notify 门闩，避免一开机顶缘闪一条探出条。探出由 `GlobalBoard` 的 `suppressed` 初值 `true` 门控，**不是**靠「已读集合为空」。所以可以持久化已读，而不改变探出行为。

**做法**（对齐 `muster.quick-phrases.v1` / `muster.tosend.v1:*`）：

- 键：`muster.needs-read.v1`，值 JSON 字符串数组。
- `markNeedsRead` / `markNeedsUnread` / `retainNeedsRead` 集合变化时**同步** `setItem`（这三条都是低频，不节流）。
- 模块加载读入；坏数据 / 非数组回落空集合。
- `retain` 修剪语义不变：只留仍在需要你区的 id。
- 新边沿仍 `markNeedsUnread`：重新进入需要你区会清已读并写盘。

测试：`test/unit/needs-read-persist.spec.tsx`（标记→覆盖内存再 hydrate 仍已读；unread/retain 写盘后重启仍生效；BoardPanel 挂载即已读；启动未读不探出）。

---

## 1.1 本轮修复：拍板落地三小项

用户拍板后补上（各自带回归；解析/夹紧在 `src/shared/workspaceUiPersist.ts`）：

| 项 | 落盘 | 行为 |
|----|------|------|
| 虚拟屏当前页 `hDock` | `localStorage` `muster.virtualScreenPage.v1:<编码后的 workspaceId>`，值为 `left` 或 `right` | 普通切页只保存本机短值。工作区水合和过场骨架优先读本机页位，缺省兼容 `workspace.json` 的 `terminal` / `git`。VS 关或专注时以左页计算视觉位置；退出专注恢复记忆页位。写入受限时提示并在本次运行中记住最后一页。手机表面走 `MobileApp`。 |
| Git「显示已隐藏仓」`hiddenView` | `workspace.json` `git.hiddenView` | 三态 exclude / include / only。眼睛左键与右键菜单即时 patch。隐藏名单空了才回落 exclude（不用「列表未扫完时 count=0」当空，以免把刚 hydrate 的 only 写回）。 |
| Files / Git 内 `SplitPane` 拖宽 | `filesSplitRatio` / `git.repoListSplitRatio` | 只记文件树 vs 编辑器、仓列表 vs 详情。拖动跟手，**松手 / 键盘**才 `onRatioCommit` → patch。Changes↔Diff 等内部分栏仍会话态。 |

测试：`test/workspace-ui-persist.mjs`（解析/merge/接线守卫）+ `test/unit/split-pane-persist.spec.tsx` + `test/unit/git-hidden-view-persist.spec.tsx`。

工作区偏好写入返回 `ok/config` 和取消原因；主进程的 `ok: false, stale: true` 表示所属工作区已变化，实际写盘错误通过异常返回。中央分屏、右侧标签和 Git 偏好在有效工作区写入失败时提示，迟到的旧回执不向切换后的工作区误报；覆盖见 `test/unit/center-split-prefs.spec.tsx`、`test/unit/right-workspace-ui.spec.tsx` 和 `test/unit/git-hidden-view-persist.spec.tsx`。

---

## 2. 任务点名项

| 项 | 判定 | 落盘 | 说明 |
|----|------|------|------|
| 看板「需要你」已读 | **本轮已修** | `localStorage` `muster.needs-read.v1` | 见 §1 |
| 看板卡片排序 / 泳道调整 | **会话态该丢**（无此操作） | — | 列与泳道是读时推导（`boardStatus` / `boardZoneOf`），没有手动排序或拖泳道。无状态可丢。 |
| FreeCanvas 节点位 / 连线 / 分组 / 相机 / 视图档 / 过滤 | **已落地** | `localStorage` `gboard.freeview.v1`（`freeViewStore`） | 工作区凸包几何显式不持久（实时重算） |
| 画布卡片备注 / 思路便签 | **已落地** | 同上 `layout.notes` / `stickies` | 不进 `SessionMeta` |
| BgTasks 面板已读 | **已落地** | `userData/bg-tasks.json` 的 `unread`；关面板走 `bgTasks.markRead` | 任务记录 debounce 落盘；**消息流与 timer 不跨重启**（文档已写，见 background-tasks.md） |
| BgTasks 面板尺寸 | **已落地** | `localStorage` `bg-tasks-pop-size` | |
| 调度并排面板尺寸 | **已落地** | `localStorage` `muster.schedulerOverviewSizes.v1` | 按工作区保存调整过的宽度或高度，读取时随窗口尺寸裁切。「整理」清除尺寸偏好，恢复自适应布局。 |
| 调度并排状态与筛选 | **已落地** | `localStorage` `muster.schedulerOverviewStatuses.v1` | 保存状态类型的名称和颜色、工作区标记及筛选隐藏项。删除类型后清除对应标记和筛选项。 |
| 通知历史 | **会话态该丢** | 无（`NotifyStore` 纯内存） | 应用内通知面板已移除；系统 toast 是唯一出口。账本只供 800ms 去重 / `updateKey` / `notify:list` 调试。重启丢历史符合现产品。 |
| 面板开合：会话栏 | **已落地** | `localStorage` `muster.sessionsOpen.v1` | |
| 面板开合：专注 / 虚拟屏 / 当前页 / 分栏比 | **已落地** | `workspace.json` 保存开关和比例，当前页保存在本机 `localStorage` | 进入专注前的布局快照存在 `focusRestoreRef`，切区时丢弃。重启后退出专注时从工作区布局和本机页位恢复。见 §1.1 |
| 面板开合：侧栏 Files\|Git\|Browser | **已落地** | `workspace.json` `sideToolsTab` | |
| 面板开合：文件树开关 / Git 仓列表开关 / 拖宽 | **已落地** | `workspace.json` `filesTreeOpen` / `filesSplitRatio` / `git.repoListOpen` / `git.repoListSplitRatio` | SplitPane 松手再写，见 §1.1 |
| Git 显示已隐藏仓 | **本轮已修** | `workspace.json` `git.hiddenView` | 三态，见 §1.1 |
| 面板开合：全局看板浮层 / 调度对话 / 设置窗 / 证据页 | **会话态该丢** | 无 | 一次性浮层；重启不自动弹开符合心智 |
| 面板开合：中栏实用功能（`utilityPanel`） | **会话态该丢**（已拍板） | 无 | 一次性面板，重启弹开吵；与面板历史同属导航态 |
| 置顶 / 归档 | **已落地** | `sessions.json`（`SessionMeta.pinned` / `archived`） | Git 仓置顶/隐藏走 `workspace.json` `git.pinnedRepos` / `hiddenRepos` |
| 状态胶囊 | **已落地** | `sessions.json` 的 `liveStatus`；调度走 `scheduler-status.json` | 胶囊是会话投影字段，不是渲染层玩具 state |

---

## 3. 已落地（未点名、一并登记）

避免下次盘点再扫一遍。

| 项 | 落盘 |
|----|------|
| 主题 / 语言缓存 | `localStorage` 先刷防闪 + 主进程 config 校正 |
| 会话历史收藏 | `localStorage` `muster.chat-history-favorites.v1:<转写 ID>` 保存收藏的消息 ID、时间和提问摘要。「仅看收藏」每次打开默认关闭。 |
| 快捷短语 | `muster.quick-phrases.v1` |
| 手动确认发送清单 | `muster.tosend.v1:<draftBucket>` |
| 调度输入草稿 | `muster.composer.drafts.v1`（按工作区） |
| 侧栏四组折叠（实用工具 / 工作会话 / 终端 / 工作区） | `muster.sidebarCollapsed.v1:<编码后的 workspaceId>:<section>`，按工作区隔离 |
| 左侧栏宽度 | `muster.leftColumnWidth.v1`，全局共享 |
| 调度面板拖拽尺寸 | AgentFloat `PANEL_SIZE_KEY` |
| 虚拟屏切页模式（悬停/点击） | `localStorage` `hSwitchMode` |
| 右栏收起后恢复专注 | `muster.rightPanelRestoreFocus.v1` |
| 新建任务上次 runtime | `NewTaskDialog` `LAST_RUNTIME_KEY` |
| PR 评论已读水位 | `muster.prSeen.v1:<repoPath>` |
| 手机表面导航栈 | `mobile/nav.ts` localStorage |
| Git 选中仓 / 排序 / 跟随会话仓 / 隐藏三态 / 仓列表拖宽 | `workspace.json` `git.*` |
| 浏览器标签 + 登录态 | `config.browser.tabs` + `persist:browser` partition |
| 右侧归档标签入口 | `workspace.json` `rightWorkspace` + `localStorage` `muster.right-workspace.archived-tabs.v1`；只留标签描述，不保留网页实例。详见 [右侧统一多标签](right-workspace-tabs.md) |
| 项目收藏夹 | 控制根的 `.muster/bookmarks.json`，含收藏树和默认收藏初始化版本。旧字段由主进程自动迁移。详见 [右侧统一多标签](right-workspace-tabs.md#状态与-ipc) |
| 调度对话模型选择 | `agent-models.json`（曾只写内存，已修） |
| GUI 上下文用量 | 转写 `lastUsage`（2026-09-20 已修） |
| 编排守卫 fired/lastActivity | `userData` guardStateStore |
| 使用统计日桶 | `usage-stats.json`（永久）；细节轮播选择**故意不记**（重进恢复轮播） |

---

## 4. 会话态该丢（有理由）

| 项 | 理由 |
|----|------|
| 面板历史（返回/前进栈） | 浏览器语义的内存栈。重启从「当前选中会话 + 默认中栏」开始。`hDock` 已改布局落盘，不再跟本栈绑在一起。 |
| 中栏上次打开的实用功能 | 已拍板：一次性面板，重启弹开吵。与 `utilityPanel` 同行。 |
| 设置弹窗上次页签 | 已拍板：弹窗默认首页更稳。 |
| 文件面板当前打开的文件 | 已拍板：有未保存时走 autosave；空编辑器更干净。跨工作区已经刻意清打开态。 |
| 命令面板上次查询 / 分类 | 已拍板：命令面板是瞬态搜索。 |
| `hStripBusyStore` | 切页忙碌脉冲，几秒就灭。 |
| 证据页打开目标（`evidenceViewStore`） | 一次性查看浮层。 |
| 设置页色盘**编辑稿** | 实时预览，点保存才落主题。 |
| 通知 45s 去重账本 / 800ms 短窗 | 信号账本，重启重评即可。 |
| `share.set` 公示栏 | 合同：会话关闭即删、不进 git。 |
| `events.subscribe` | 合同：会话关闭即删。 |
| PromptTasks `triggerStates` | T3.1 约定内存防抖；重启丢相位升级是已知边界（T3.4）。 |
| 后台任务消息流 / timer | 重启 running→error「应用重启，任务中断」；timer 到点语义无从恢复。 |
| 计划卡 `planExecuting` / ACP AvailableCommands | 执行态不恢复；持久化过的「执行中」卡降回待确认。 |
| 会话栏热区速览（`sessionsPeekOpen`） | 指针还在才有意义。 |
| 使用统计细节轮播选中卡 | 产品定调：点击即停，重进恢复轮播，不记忆。 |
| 看板归档列展开（`archiveOpen`） | 文档：归档列默认折叠、不占列宽。每次打开看板从收起开始是刻意的。 |
| 看板 Esc 探出压制 | 一次手势；重启走启动压制，不是「记住我按过 Esc」。 |

---

## 5. 该持久化 · 待派（本轮未改）

改动都要带测试；本轮只修了已读集合（小且根因明确）。下面按体量排。

### 5.1 会话批注（大）

`useSessionNotes` / `noteBridge`：批注是渲染层内存态；草稿桶却持久化。重启后草稿里的「批注 N」token 指向已不存在的批注——代码自己写了「先 flush 摘孤儿 token」。

用户在对话里划词批过的内容会静默消失。要修得同时持久化批注表（按会话、跟转写或独立 json），并定义与草稿 token 的对账。**不要只修一边。**

2026-09-20 调度面已接入同一 hook（按 workspaceId 挂调度会话）。**调度面批注同为内存态**，不单独立项；持久化仍按本条待派（localStorage 按会话键只是落表，还要对账草稿 + 重挂后的锚点/文件标记，体量超出「接线顺手」）。

### 5.2 文件树 / Git 变更树「哪些文件夹展开」（中）

`FileTree` `expanded` 默认只开根；`GitChangeTree` `collapsed` 默认全开。刷新或重启回到默认。VS Code 会记这个。要做的话按工作区落 `workspace.json`（或 localStorage 带 wsId），注意懒加载目录与 reveal 祖先链的竞态。

### 5.3 Files / Git 内 `SplitPane` 拖宽

**本轮已修**，见 §1.1。不再待派。

---

## 6. 拿不准 · 已拍板结论

2026-09-20 拍板（原「两边都说得通」表）：

| 项 | 结论 | 去向 |
|----|------|------|
| 虚拟屏当前页 `hDock` | **留** | §1.1 / §2 本轮已修 |
| Git `hiddenView` | **留** | §1.1 / §2 本轮已修 |
| Files/Git `SplitPane` 拖宽 | **留** | §1.1 / §5.3 已修 |
| 中栏上次打开的实用功能 | **丢** | §4 |
| 设置弹窗上次页签 | **丢** | §4 |
| 文件面板当前打开的文件 | **丢** | §4 |
| 命令面板上次查询 / 分类 | **丢** | §4 |

批注（大）与树展开（中）未拍板留/丢，维持 §5.1 / §5.2 待派。

---

## 6.1 侧栏偏好的作用域

`sidebarPreferences.ts` 统一读取四组折叠状态：工作区 ID 和 section 组成存储键，切换即同步读取对应快照；点击同步写入所属键，回到原工作区或重启可恢复。没有工作区时不落盘。工作区栈未保存独立偏好时，以旧全局键 `muster.wsStackCollapsed.v1` 作为兼容默认值；一次点击后只更新当前工作区，不再修改旧键。存储被拒时本次运行保留按工作区的内存状态。

宽度为独立全局键 `muster.leftColumnWidth.v1`。首次没有全局值时，仅在当前工作区配置就绪且归属匹配后迁移一次旧 `leftColumnWidth`；如果当前区没有旧宽度，继续按原比例自适应。之后切区不再水合旧宽度。拖动中只更新内存，松手保存全局值；启动期手动拖动优先于延迟配置。进入/退出专注不快照或回写宽度，因此不会恢复成旧工作区或旧专注宽度。旧工作区字段保留兼容，但新宽度不再写入它。

回归：`test/unit/sidebar-preferences.spec.tsx`、`left-panel-collapse-agent-float.spec.tsx`、`ws-stack-collapse.spec.tsx`，涵盖分组隔离、A→B→A、重挂载、旧值迁移、初始化竞态、存储不可写及 App 接线。

## 7. 关键文件

| 文件 | 职责 |
|------|------|
| `src/renderer/src/panels/needsReadStore.ts` | 需要你已读；本轮改为同步写 `muster.needs-read.v1` |
| `src/renderer/src/panels/freeViewStore.ts` | 自由视图布局 |
| `src/renderer/src/composerDrafts.ts` | 调度草稿 |
| `src/renderer/src/sessionsVisibility.ts` | 会话栏显隐 |
| `src/renderer/src/sidebarPreferences.ts` | 四组折叠按工作区保存；左栏宽度全局共享与一次性迁移 |
| `src/shared/metaAgent.ts` `WorkspaceFileConfig` | 工作区布局合同（旧 `hDock` 仅供兼容读取，布局开关、比例与 Git 偏好仍走配置） |
| `src/renderer/src/virtualScreenPagePreference.ts` | 本机页位读取、保存和失败回退 |
| `src/shared/workspaceUiPersist.ts` | hDock / hiddenView / 分割比解析与夹紧 |
| `src/renderer/src/components/SplitPane.tsx` | 松手 / 键盘 `onRatioCommit` |
| `src/main/store.ts` | `sessions.json` 等 userData |
| `src/main/notify/store.ts` | 通知账本（内存） |
| `src/main/agentSession/background/manager.ts` | 后台任务注册表 |
| `src/renderer/src/panelHistory.tsx` | 面板栈（内存） |
| `src/renderer/src/chatSurface/useSessionNotes.ts` | 会话批注（内存，§5.1） |
| `test/unit/needs-read-persist.spec.tsx` | 已读跨重启回归 |
| `test/workspace-ui-persist.mjs` | hDock/hiddenView/分割比解析、merge、接线守卫 |
| `test/unit/split-pane-persist.spec.tsx` | SplitPane 松手才 commit |
| `test/unit/git-hidden-view-persist.spec.tsx` | hiddenView hydrate + 点击/菜单 patch |

---

## 8. 已知边界

- localStorage 配额满 / 隐私模式：已读与多数渲染层偏好放弃本次写盘，重启视为未读或回默认；归档标签恢复记录读取或写入失败会明确提示。
- 已读集合只存会话 id。会话删掉后残留 id 靠 `retainNeedsRead` 在看板挂载时修剪；修剪前无害。
- 探出条启动压制与已读落盘解耦：盘上全是未读也不会在启动时探出；运行中新边沿才解除压制。
- GlobalBoard 在 `sessions` 仍是 store 初值 `[]` 时不建边沿快照、不 `retain([])`（否则会剪光落盘已读，并把随后的 list 到达误判成新边沿）。真的清空会话表（已有过快照）仍会修剪。
- 主进程内存态（通知账本、triggerStates、计划执行中）按各功能文档的既有边界，不在本盘点里改口径。
- 调度面批注与 GUI 共用 `useSessionNotes`，同为内存态（§5.1）；接线不改变持久化口径。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D07.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：全仓「用户点过/拖过/标过的状态」重启去留的判定索引与落盘分层（localStorage / workspace.json / userData）；需要你已读、hDock、hiddenView、分割比等缺口本轮已修落地。
- 为什么这样设计：三类下场分明（该留已留／会话态该丢／该留却丢=缺口）；持久化不改变启动探出行为（已读落盘与 GlobalBoard suppressed 初值解耦）；「该丢」逐条给理由（导航史=浏览器语义、通知历史=系统 toast 唯一出口）；侧栏偏好按工作区分桶+旧全局键作首次默认、宽度全局共享一次性迁移。
- 明确不做：多数既有 localStorage 偏好在配额满时仍静默放弃；归档标签恢复记录是需要提示的例外。通知账本/triggerStates/计划执行中按各功能既有边界不改口径；已修三项之外的改动都要带测试、不「顺手」。
- 歧义点：①会话批注持久化（§5.1 待派）——A=排期做（批注表落盘+与草稿 token 对账；草稿已持久化而批注表内存态，重启后「批注 N」指向已消失批注，是明确的用户数据丢失面）／B=接受丢（批注定性为会话内辅助）。推荐 A。②文件树/Git 变更树展开状态（§5.2 待派）——A=留（按工作区落盘，大仓库重开免逐层展开）／B=丢（刷新回默认）。推荐 A（成本低）；两项若均选 B，review 把 §5 条目降为「已接受边界」不再追踪。
