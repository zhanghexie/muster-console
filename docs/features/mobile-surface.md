# 手机端表面（Mobile Surface）

## 功能职责

Web Access（[web-access.md](web-access.md)）在手机浏览器打开时的专属交互表面：
独立的三级页面栈（L1 工作区列表 → L2 工作区详情 → L3 对话页），替代桌面布局的
抽屉压缩版。设计意图与取舍见 plans/implemented/mobile-remote-interaction-plan.md。

核心能力（刻意收窄）：工作区/会话浏览、新建 GUI 会话、调度 Agent 与 GUI 会话对话、
清空会话、「需要你」徽标与深链、审批弹层、文件抽屉（工作区文件浏览 + 只读预览，
会话文件链接直达）、看板翻转服务端推送（toast + 深链，见「服务端推送」节）、
needs_you 一键处置（T5.6：回复框 → 邮箱存信；GUI 审批卡 → respondApproval；
pty 仅回复框）。派活/看板/终端/Git 面板不进手机端。

## 关键文件与入口

手机使用同一套已解析的表面、前景、输入、动作与状态角色：状态胶囊与桌面保持同一语义，危险动作和连接错误使用软底/前景配对；CLI 行、归档标签与文件行号使用显式文字层级，不淡化整行。HTML 和媒体内容保留自己的颜色，导航和触控行为不变。

| 文件 | 职责 |
|------|------|
| `src/renderer/src/mobile/useMobileSurface.ts` | 判定：移动 UA 或（触摸主指针 + ≤820px 视口）→ 手机表面；模块级缓存 + matchMedia 订阅 |
| `src/renderer/src/RootLayout.tsx` | 渲染根分流：手机 → MobileApp；桌面 → PanelHistory/Keybinding + App（互不挂载对方依赖） |
| `src/renderer/src/mobile/MobileApp.tsx` | 壳：页面栈状态 + History 集成（pushState/popstate=浏览器返回弹栈）、closing 退场队列、needs_you 抽屉与深链、toast（flashTip/调度气泡的手机出口）、visualViewport 软键盘适配、连接状态点、全局 ConfirmDialog/ExtensionUiDialog |
| `src/renderer/src/mobile/MobilePageFrame.tsx` | 单页框架：usePresence 转场（mp-panel 骨架 + .mpage 自右滑入/滑出），非顶层禁交互 |
| `src/renderer/src/mobile/nav.ts` | 页面栈类型（workspaces/workspace/chat + dispatch/session 目标）与 localStorage 持久化（`muster.mobile.nav.v1`） |
| `src/renderer/src/mobile/pages/WorkspaceListPage.tsx` | L1：工作区卡（状态徽标 N 工作中 / M 需要你、最近会话预览、needs_you 置顶描边） |
| `src/renderer/src/mobile/pages/WorkspaceDetailPage.tsx` | L2：置顶调度卡 + 会话行（needs_you 置顶、pty/GUI 均可进 L3、状态胶囊全覆盖）+ FAB 新建 GUI 会话 |
| `src/renderer/src/mobile/pages/ChatPage.tsx` | L3：调度/GUI 双表面共用 ChatSurfaceView；GUI 文本回复走 sendMessage 存信，带图保留原生 send；「⋯」菜单走 MobileSheet |
| `src/renderer/src/mobile/MobileFiles.tsx` | 文件抽屉：右侧 90% 宽侧栏（mp-panel 自右滑入）；源文件夹选择、listDirRef 懒加载、携 FileRef 的只读详情与 Markdown 内链、禁脚本 HTML 来源预览、媒体根身份 URL、严格区外只读闸口 |
| `src/renderer/src/mobile/MobileTurnReview.tsx` | 消费聊天文件卡的审阅请求，复用文件抽屉与生产 TurnReviewPanel，按需读取轮次 Diff、安全回退；切页面/会话/工作区关闭旧现场 |
| `src/renderer/src/mobile/MobileSheet.tsx` | 底部抽屉（mp-panel + .msheet 自底向上；新建/操作菜单/needs_you 共用） |
| `src/renderer/src/mobile/MobilePtyReply.tsx` | T5.6 pty 处置面：回复框 → `sessions.sendMessage`（存信，无终端、无审批卡） |
| `src/renderer/src/mobile/MobileToast.tsx` | toast 底座：纯提示 / 带动作尾巴可点（session-status 推送 needs_you 的深链出口） |
| `src/renderer/src/mobile/useSessionStatusPush.ts` | 订阅服务端 session-status 推送帧（无 shim 时 no-op）；isViewingSession 过滤正看的会话 |
| `src/renderer/src/mobile/useHashDeepLink.ts` | `#/session/<id>` 深链（飞书卡片「打开」/toast「查看」）：挂载即 apply + hashchange + 会话表到位后重试（`appliedHashRef` 去重） |
| `src/shared/sessionDeepLink.ts` | 深链形态契约（`#/session/<id>`）与解析纯函数 |
| `src/shared/webPush.ts` | session-status 推送帧类型与防御解析（服务端构造/shim 解析/手机端消费三方共用契约；零依赖便于离线测试） |
| `src/renderer/src/mobile/useDispatchDigest.ts` | 调度桶摘要 1.5s 轮询（busy + 末条预览）——列表页不订流式热区 |
| `src/renderer/src/mobile/sessionStatus.ts` | SessionMeta → 看板区/胶囊（shared/boardStatus 推导 + boardPresentation 同一套状态词）：liveStatus 优先、缺失按看板状态兜底——手机端任何会话都有胶囊（桌面左栏只在 liveStatus 在场时渲染）；L2 行/L3 顶栏共用 |
| `src/renderer/src/styles/mobile.css` | 全部手机样式（token-only；页面栈/卡片/抽屉/composer 紧凑化） |
| `src/shared/i18n/locales/fragments/mobile.ts` | 手机端词条 |
| `test/web-mobile.mjs` | 手机仿真 e2e：Chrome headless + CDP（iPhone UA + 390x844 + touch）全链路，27 项断言（手动跑，前置 npm run build） |

## 数据流 / 导航

- **判定**：`RootLayout` 消费 `useMobileSurface()`；`html.is-mobile` 根类供 CSS 壳级覆盖。
  桌面窄窗口（鼠标主指针）不进手机面，继续 responsive.css 抽屉。桌面中央分栏的工具面板按实际容器重排：共用工具栏动作换行但按钮文字不竖排，扩展管理 ≤640px 将卡片动作放到正文下方，记忆总览 ≤900px 将动态流放到脑图下方并保留原生滚动与阅读尺度；这些桌面窄容器规则不表示手机页面新增扩展管理或记忆工具入口。局部几何回归见 `test/utility-narrow-layout-visual.mjs`，手机触摸面与 DPI 仍需独立实机采证。
- **页面栈**：`pages: MobilePage[]`（≤3 层）。push 时 pushState 一条；`popstate`
  （浏览器边滑/返回键）弹一页；顶栏返回优先消耗本会话历史条目（histExtra 计数），
  没有则本地弹栈——刷新恢复后不把页面本身返回掉。pop 的页面进 closing 队列播完
  退场再卸载（MobilePageFrame/usePresence）。
- **进入 L3**：`switchWorkspace`（对齐桌面「会话属于它的工作区」）+ `sessions.select`
  （会话目标），页面即时入栈不等切区。
- **新建 GUI 会话**：L2 抽屉复用 `TaskSourceField`，显示源文件夹与完整路径，默认选当前查看工作区的 defaultRootId。打开后保持选择，创建携该 workspaceId/rootId/rootsRevision；另一客户端改活动区不会改变目标。默认/名称/排序变化保留选择，根移除须手选恢复。清单未加载禁用 FAB，创建中禁止重复提交/关闭；失败提示并保留抽屉，页面切换/卸载后忽略旧回调。回归 `test/unit/mobile-session-source.spec.tsx`，真实 Web/跨客户端链路 `test/e2e/worktree-storage.spec.ts`。
- **needs_you 深链**：抽屉条目 → 旧栈整栈退场 → 直落 [L1, L2, L3]。
- **文件抽屉**：两个入口汇到 MobileApp 同一状态——L3「⋯」菜单「文件列表」（浏览
  根目录）与会话消息里的文件链接（ChatSurfaceView → `handleChatFileLink` → UiStore
  `openWorkspaceFile` 一次性槽；桌面由 SideToolsPanel 消费，手机树没有它，MobileApp
  接住后优先按 FileRef.workspaceId 开抽屉；旧字符串仅使用活动工作区，无活动区不猜第一项。
  显式失效工作区/源根、歧义与 Junction 越界不会转为区外读取）。媒体字节走网关 `/media/ws|ext`
  路由（cookie 鉴权、支持 Range），Electron 壳回落 `muster-ws|ext://` 协议。
- **文件来源**：单根直接浏览，多根先列全部源文件夹，同名显示绝对路径；选择后列表、stat、文本与媒体都携稳定 rootId。Markdown 相对内链沿所在根解析；旧完整路径由主进程定位更具体的源根，仅确认在全部源根外的绝对文件可进入外部只读通道（判定走 `fs:resolveRef` 结果携带的结构化 `reason:'outside-workspace-roots'`（`shared/errors` 的 `isOutsideWorkspaceRootsResult`，英文原文兜底），不匹配错误文案——与桌面 FilesPanel 同一契约）。返回详情时回到该文件所在目录，多根的根目录可返回源文件夹选择。
- **文件异步生命周期**：关闭、卸载、切工作区、根版本变化或后续导航使旧结果失效；元数据晚到可补处理原目标，改名/排序保留来源。失效根保留错误并允许重新选根，不读取另一根同名文件。离线目录不自动循环重试；手动刷新仅恢复当前根并重读当前视图。手机尚不订阅文件外改自动刷新，返回目录或手动刷新补读。
- **HTML 来源资源**：复用 HtmlFilePreview 的来源 base 和可撤销 Web 只读地址，正文读取后才挂载；手机保持空 sandbox 白名单，禁止脚本，关闭即卸载/释放资源地址。相对图片与样式可加载，其他边界见 [文件预览](file-preview.md)。
- **L3 双表面**：调度= `useOrchestratorSurface(wsId)` + `ensureOrchestratorHistory` +
  `setOrchestratorFallbackWs`（与桌面 AgentFloat 同款接线）；GUI =
  `useAgentSessionSurface({sessionId, visible, runtimeId})`。退场动画期间 `live=false`
  冻结实况。
- **服务端推送**：见「服务端推送」节。连接层默认 `{terminal:false, stream:false}`
  （见 web-access.md 兴趣过滤）：不订 `pty:data` / `agent:token` / `agent:thinking`，
  保留 `agent:message`/`agent:history` 对账，弱网不被终端输出灌爆。
- **栈恢复**：pages 变化即写 localStorage；挂载时读回，workspaces/sessions 到位后
  校验并截断失效前缀。

## 服务端推送（T1.2）

看板翻转不再等手机端拉取：主进程 `NotifyBus`（决策矩阵见
[notification-system.md](notification-system.md)：仅 →needs_you/→done/→error 且写入源
可信，同会话同触发类 45s 账本去重，免打扰拦 done/error，needs_you 不可关）决策通过
时，`WebAccessServer.bindNotifyBus` 向全部已鉴权 WS 客户端广播推送帧：

```
{t:'push', type:'session-status', sessionId, phase: 'needs_you'|'done'|'error', label}
```

- **手机端消费**（`useSessionStatusPush`）：前台 toast（`MobileToast`，label 直用不
  二次本地化）；phase=needs_you 时 toast 带「查看」动作，点击走既有 needs_you 深链
  （旧栈整栈退场直落 L3）；用户正停在目标会话的 L3 时静默跳过（页面即呈现）。
  另：加载时与 `hashchange` 解析 `#/session/<id>`（`resolveSessionFromHash`），接飞书卡片「打开」同一深链。
- **看板角标不走推送帧**：phase 写入点先 broadcast（sessions:changed 全量事件，
  同一 WS 先后到达）再进总线，L1 工作区卡徽标/L2 会话行胶囊/顶栏计数胶囊随 store
  自动刷新；推送帧只负责「提示 + 入口」。
- **协议契约**：帧类型/词表/防御解析在 `src/shared/webPush.ts`；phase 是触发类三词
  （不是 BoardStatus 全集——waiting/blocked 已被总线归并为 needs_you）；畸形帧/未知
  推送类型 shim 侧静默丢弃。
- **离线 Web Push 不做**（刻意）：浏览器不在前台/断线时收不到推送帧，重连后靠
  sessions:changed 与手动刷新对齐；网关侧仅在 `web-access.json` 预留 `pushSubscription`
  存储位（token 轮换不洗掉），将来接 Web Push 协议时从这里读。

## 一键处置（T5.6）

needs_you（以及任意已打开的 Worker）在手机 L3 可操作，不必回桌面：

| 会话面 | 回复 | 审批 |
|---|---|---|
| GUI（chat runtime） | 输入条 → `sessions.sendMessage`（文本存信；带图走 `agentSession.send`） | 消息流内 `ApprovalCard` → `agentSession.respondApproval`（网页 shim 同通道） |
| pty | `MobilePtyReply` → `sessions.sendMessage`（存信并等待空闲提醒） | 不提供；桌面 `ui:confirm` 仍可在手机以全局 ConfirmDialog 出现 |
| 调度 Agent | 原 ChatSurfaceView send，按原用户输入通道提交 | 提问卡走统一 `UserQuestionCard`（`chat.respondUserQuestion`）；无工具审批卡 |

L2 pty 行可点进 L3（不再 toast「请在电脑端操作」）。

## 交互与已知边界

- **表面判定在页面加载时锁定**：中途 resize 跨 820px 不切换（避免两棵树整卸整挂
  闪现另一表面）；换表面 = 刷新页面。判定见 `useMobileSurface`（移动 UA 或
  触摸主指针+窄视口；桌面鼠标窄窗口走 responsive.css 抽屉）。e2e 可写
  `sessionStorage.muster.mobile.force=1` 后刷新强制进手机面（仅当前会话，不污染下次启动）。
- **桌面壳也能进手机面**（触屏窄窗 / force 标志）：此时没装网页 shim，`getWebGatewayStatus()`
  走桌面分支，必须返回同一个冻结常量——useSyncExternalStore 要求快照引用稳定，
  曾因每次新建对象整页崩溃「Maximum update depth exceeded」（2026-09-28 修，
  `test/unit/web-gateway-status-snapshot.spec.tsx`）。
- **首屏体积**：RootLayout 双 `React.lazy` 分流——手机不下载桌面树（App+xterm+
  面板）；ExtensionUiDialog/后台任务面板按需加载。手机首屏 1.91MB（CDP 实测），
  带 hash 资产 immutable 长缓存，二次打开只重验证 index.html。

- 软键盘：`visualViewport` 的 height/offsetTop 同步到 `.ma-root`（iOS Safari 的
  window 不随键盘缩）；桌面壳无 visualViewport 概念，恒全屏。
- 断线时，连接状态点通过 `getWebGatewayStatus` / `subscribeWebGatewayStatus` 读取连接进度。桌面 Web 与移动 Web 共用 `AppTipHost`，缺少凭证、无网关地址或认证被拒时弹出错误 tip。正常连接和重连保留状态点。
  锁屏回前台 / 网络恢复会立即重连（visibility+online）；
  审批回执走可靠 send，断线期间发出的重连后重发（发送瞬间连接看似正常、随后半开
  死掉的极端窗口不补发，靠心跳半开检测重连兜底）。
  桌面壳未装 shim，恒视为已连接。
- toast：flashTip 与调度 ui:bubble 的手机侧出口（桌面是 ChromeBar 气泡）；
  只报「变化且非待命」。
- 不进手机端（刻意）：设置页、命令面板、划词菜单/文本工具/批注宿主、Tooltip 宿主
  （hover 体系）、轨迹页签、派活/看板/终端/Git。桌面调度面 2026-09-20 已接批注，
  手机 `ChatPage` 仍不注入 `notesHost`（`selArea` 保持 agent-chat）。
- CLI/pty 会话可进 L3，但只有回复框（无终端画面）；工具审批仍在桌面。
- 文件抽屉只读：文本/md/html/图片/音视频/PDF 可预览（文本带行号与链接目标行
  高亮跳转、md 相对链接按当前文件目录解析后可继续下钻）；office/归档等重格式
  出「请在电脑端预览」提示卡；编辑、外部目录浏览仍归电脑端。抽屉内部导航
  （进目录/进详情）不接浏览器 History——系统返回手势关的是页面栈，抽屉用
  顶栏返回（详情→所在目录 / 子目录→上一级 / 多根根目录→源文件夹 / 单根根目录或源文件夹页→关闭）与 ✕/遮罩关闭。
- 输入框 placeholder 在窄屏可能截断——composer 是桌面共用组件，按「差异只在壳层」
  原则不改组件文案；后续如需处理应走 AgentComposer 的响应式能力位。
- 文件改动卡片点击在审阅抽屉中展示所选轮次的 Diff，支持切轮次/文件与安全回退，不依赖 hover 或桌面 Git 面板；生命周期与保护见 [turn-checkpoint.md](turn-checkpoint.md)。`test/unit/mobile-turn-review.spec.tsx` 覆盖真实卡片点击到手机壳的消费链路。常驻聊天页通过 `interactionActive` 关闭隐藏页的中断确认。
- 浏览器左缘滑动 = 系统级返回导航（Android Chrome/iOS Safari），已按 History
  集成顺势接住；自绘手势与之冲突，不采用（plan 实施记录第 1 条）。
- 验证：`test/surface-parity.mjs` 将 ChatPage 纳入「必须经 ChatSurfaceView +
  适配器 hook」与「禁直连会话协议」清单；`test/unit/mobile-one-tap.spec.tsx` 覆盖
  审批卡/pty 回复/pty 行可进；`test/e2e/mobile-approval.spec.ts` 桌面壳点允许走
  respondApproval（与手机 L3 同一张 ApprovalCard；切手机面会破坏 e2e 夹具的 `.app-shell`）；
  审批 GUI 会话；`test/web-mobile.mjs`（手动）覆盖判定/三级下钻/会话行胶囊全覆盖/
  菜单清空/文件抽屉/新建会话/浏览器返回/栈恢复/桌面 UA 反向验证。
- 多根文件回归：`test/unit/mobile-files-roots.spec.tsx` 与 `mobile-file-link-routing.spec.tsx` 共 15 项覆盖选根/同名文件、旧单根、FileRef 归属、元数据晚到、根删除与旧请求、内链、区外媒体、离线刷新及 HTML 禁脚本/关闭撤销。`test/e2e/workspace-file-roots.spec.ts` 在独立 Electron 网关连接真实手机浏览器，操作文件抽屉并验证第二根文本、图片、HTML 相对样式与关闭后 403；深浅主题 390/320px 的源选择和图片详情八图位于 `.tmp/ui-captures/workspace-mobile-roots/`，已逐张查看。这是 Chromium 手机仿真，未验证真实 iOS Safari 硬件。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：手机浏览器的三级页面栈专属表面（工作区列表→详情→对话）：浏览/新建 GUI 会话/对话/清空/needs_you 一键处置/审批卡/文件抽屉/看板翻转推送 toast。
- 为什么这样设计：表面判定页面加载时锁定（防两棵树整卸整挂闪切）；推送帧只做「提示+入口」、徽标随 store 刷新（推送不承担状态）；连接层默认丢 terminal/stream 保弱网；needs_you 深链整栈退场直落 L3；RootLayout 双 lazy 分流保首屏 1.91MB。
- 明确不做（刻意）：派活/看板/终端画面/Git/设置页/命令面板/划词工具/批注不进手机端；pty 会话只有回复框无审批卡（审批仍在桌面）；桌面窄窗口走抽屉不进手机面。
- 歧义点：手机端能力面长期收窄（手机=移动处置与观察面）还是逐步扩展（看板/终端搬上手机）？A=长期收窄、扩展按真实移动需求逐项立项（review 不把缺看板/终端当缺陷）／B=对齐桌面全能力是目标。推荐 A——「刻意」清单明确，且桌面树依赖（xterm/面板栈）与手机首屏体积目标矛盾。
