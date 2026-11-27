# 会话栏折叠/展开（左上角开关 + 左缘划开工作面）

> 状态：实现说明 v2.0（2026-09-09：折叠/展开模型取代悬浮/固定二态）
> 代码主入口：`src/renderer/src/App.tsx`（状态/布局）、`src/renderer/src/components/SessionsHotZone.tsx`（热区）、`src/renderer/src/sessionsVisibility.ts`（偏好存取）、`src/renderer/src/components/ChromeBar.tsx`（左上角开关）、`src/renderer/src/styles/left.css`（左栏/热区样式）、`src/renderer/src/styles/base.css`（工作面位移）
> 关联：专注模式见 `focus-mode.md`（**完全解耦**：专注不改会话栏显隐）；窄屏见 `responsive.css`（抽屉机制不变）

左下工作区栈在公共底边留白基础上向上补偿 1px（`.left-ws-slot` 的正底外边距），与中栏会话卡底缘视觉对齐。

## 1. 功能职责

会话栏（最左列，含实用功能/工作会话/终端三段）是一个**可折叠面板**：

```text
展开（open，默认）：[会话栏 | 中栏……]   ← 文档流占位
折叠（closed）    ：[中栏…………满宽……]    ← 不占布局，速览时工作面整体右移露出左栏
```

- **展开**：会话栏占布局，拖宽手柄居中跨在会话栏与中央工作面的交界。静息透明，鼠标悬停和拖动时显示 3px 线。抓取手柄边缘时按指针移动量调宽。
- **左栏选中态**：实用功能磁贴和工作会话行共用 resolver 的 frame `--interaction-selected` 中性哑光表面（随明暗主题解析）；磁贴选中规则须高于静息磁贴底的 CSS 特异性。侧栏会话行与停靠工作区共享 38px 行高、2px 行距和中栏圆角。顶层会话的 14px 图标、标题起点和动作右侧留白是工作区行的对齐基准。状态槽、Harness 图标和名称／状态胶囊由 `SessionRowContent` 共用，全局看板复用同一内容组件并附加正文预览。实用功能、工作会话、终端和底部工作区行共用 `--left-pad-x` 的 6px 左右留白。工作区栈底缘由 `--frame-gap` 加上 1px 补偿定位。常驻/速览侧栏外层不再叠加左 padding，槽位不再叠加底 padding；底边由工作面外层统一提供。栈折叠时按实际露出的后排层数和 peek/step/scale 几何，以 transform 上移整栈，最下方可见轮廓对齐同一底距（最多三层，与 WS_STACK_PEEK_LAYERS 一致）。`test/sidebar-alignment-visual.mjs` 连同真实外层测量四种栏宽与常驻/速览两种形态，验证左右和底部总留白，防止只比列表彼此对齐却漏掉父层叠加。
- **分屏打开与焦点**：中央区绑定的多个会话、工具和扩展入口可同时保留 `is-pane-open` 选中背景；只有当前工作面焦点项带 `is-pane-focused`，不随键盘焦点或悬停移动。会话行、工具磁贴的 2×12px 竖条由常驻 `::after` 绘制，扩展树对应常驻 `::before`；失焦时围绕原位中心收短并淡出（`--dur-micro` / `--ease-exit`，默认 120ms），新焦点从短点原位展开（`--dur-menu` / `--ease-standard`，默认 160ms）。只过渡 transform/opacity，宽度、位置、行几何和原有 ARIA/点击/多项打开语义保持；快速反向从当前插值续走，减少动态沿用全局偏好。扩展树拖放插入线仍即时显示，不继承焦点竖条的缩放。`test/unit/center-split-sources.spec.tsx` 覆盖实际分屏来源的多项打开、焦点反向与 DOM 保活；`navigation-micro-motion.spec.tsx` 守常驻伪元素和拖放样式契约。生产 CSS 夹具 `test/fixtures/interaction-motion.tsx` 的侧栏行只是样式脚手架，实际中间帧、主题与几何需浏览器查看，不能替代应用导航验收。
- **折叠**：中栏吃满工作页宽（无回流抖动）；中栏在侧栏展开和折叠时共用同一套窗框圆角，见 [虚拟屏](virtual-screen.md)。左上角开关可持久展开，左缘热区可临时速览。速览时 `.ws-stage` 携内部虚拟屏、工作区胶片整体平移，露出常驻于其下的左栏。
- **与专注解耦（用户定稿）**：专注模式不改会话栏显隐——折叠态在专注中照常可速览，展开态在专注中保持占位（布局为 [会话栏 | 会话 | Git]）；进入/退出专注都不改写该状态。

## 2. 开关（左上角品牌 logo 位）

- 位置：顶栏最左——**品牌 logo 图标本体即开关**（`chrome-logo` 与 `chrome-sessions-toggle` 并用，无独立按钮）。
- 交互：**点击 = 展开⇄折叠**（落盘 localStorage）；**静息显示品牌图标，悬停原位切换为「面板 + 状态箭头」图标**（展开态显 ‹ 折叠、折叠态显 › 展开），移开恢复 logo。`is-open` 类 + `:hover` 双 glyph 切换（chrome.css）。
- 窄屏（≤820px）不显示：布局归抽屉系统管（顶栏已有抽屉唤出按钮）。

## 3. 折叠呈现（.sessions-float 下层左栏）

- 挂载点：**MainViewShell 根**（`.main-view` 内 absolute）——留在工作页内做 fixed 会被 `.h-strip` 的 transform 劫持（与窄屏抽屉同坑）。展开的文档流列与速览面板**二选一渲染，保证 LeftPanel 单实例**（切折叠/展开时 LeftPanel 重挂一次，数据全在 store）。
- 划开/收回：`.sessions-float` 常驻在 `.ws-stage` 下（z 0 / z 1），`.ws-stage` 按 `--sessions-col-w` 水平平移；进入用 `--dur-panel/--ease-standard`，收回用 `--dur-exit/--ease-exit`。内部 `.h-strip` 虚拟屏保持原有几何，工作区切换胶片在场时取消速览。
- 外观：宽屏左栏与顶栏共享框面，无独立卡片边框/光晕，也不加载颗粒贴图。闭合时，实色回退下 `.ws-stage` 以**框色实底**盖住下层左栏，Mica 模式保持框层透明并隐藏不再保留的侧栏；页内 `--frame-gap` 留白直接露出共同框面。速览时右端内容被窗口裁切。窄屏抽屉保持不透明阅读面。`.ws-stage` 底部留 `--frame-gap`（默认 6px），收起侧栏与临时速览时都不消失。材质见 [frame-backdrop.md](frame-backdrop.md)，留白回归见 `test/frame-gap-visual.mjs`。
- 宽度沿用全局 `muster.leftColumnWidth.v1`（`resolveLeftW` 同源）；折叠态隐藏右缘拖宽手柄；工作区切换胶片在场时整列暂隐（`.is-hidden`）。面板底部即工作区栈槽位（§6）。
- 工作面划开**无需浏览器让位**：内置浏览器已是渲染层 `<webview>`（2026-10-08 迁移，guest 参与渲染层合成栈，见 [内置浏览器](builtin-browser.md)），随 `.ws-stage` 的 CSS transform 平移；旧 WebContentsView 时代的让位机制（截帧垫底 + 暂隐原生视图）已整体移除。

## 4. 左缘热区（SessionsHotZone，仿虚拟屏把手两层）

| 层 | 几何 | 作用 |
|----|------|------|
| 外层检测带 | 左 48px × 垂直居中 40% | 指针进入 → 浮现幽灵把手胶囊（`usePresence` + `mp-pop` 入场） |
| 内层唤出区 | 左 24px × `min(160px, 30%)` | 幽灵把手的命中域，指针进入即速览会话栏 |

- 检测用 **window pointermove 距离判定**而非 DOM 悬停带——左缘常驻可命中检测带会挡住底下终端/网页内容的点击。
- **武装机制（持续跟踪）**：监听器常驻（不随 active 开关重置），指针须先离开检测带再进入才允许召唤——面板刚收起、指针仍压在热区上时不会立即重开。
- 面板在场 / 工作区切换胶片期间热区停用；**专注中照常可用**（与专注解耦）。

## 5. 收回时机

- 速览面板：指针离开「面板 ∪ 热区」**延迟 500ms** 自动收回（`SESSIONS_FLOAT_HIDE_MS`，防快速斜穿左缘误收）；**Escape** 在 window 捕获阶段收回（避免被全局快捷键层先拦截，输入框聚焦时仍让位给局部取消）；点击会话/功能行（`.session-item`，行内按钮、重命名输入与截断文字的展开操作除外）**立即收回**（选完即走）。悬停工作区胶囊栈（面板底部槽位）= 悬停面板本体，**不会触发收回**。**调度对话面板在场时不自动收回**（`armPeekClose` 豁免；Escape/开关/选完即走仍可收）。
- 开关点按后是**持久的展开/折叠**，不自动收回。

## 6. 工作区栈与调度层（portal 进左栏，用户定稿的底层结构）

- 工作区栈（折叠/新建钮 + 每区头像/通知气泡，AgentFloat 的 `.agent-ws-stack`）经 **React portal 挂进左栏底部槽位**（LeftPanel 的 `.left-ws-slot`：在列表滚动区 `.left-panel-scroll` 之外、恒贴左栏底部，不垫底色，`:empty` 时零高度）。槽位 `contain: inline-size` + `min-width: 0`，槽内切断浮层 `--sessions-col-w` / `--ws-bubble` 公式宽（改跟栏宽 100%）；幽灵占位钉在 `--sessions-col-w`，展开/折叠不得把宽度或 padding 泄漏进会话列表。`.left-panel-scroll` 锁 `overflow-x: hidden` 并登记悬停显条——展开栈挤高列表区出现滚动条时，不得看起来像右侧空白变大。宽屏左栏把头像、名称、状态和对话按钮收入同一个 38px 圆角矩形行。窄屏浮层以 32px 行高呈现独立头像。停靠行以框色作不透明底，伪元素表层分别使用实用功能同款 `--interaction-hover` / `--interaction-selected-hover` / `--interaction-selected`，普通、悬停、选中三态视觉配色一致；无灰黑独立卡底、主题色光环或投影；普通态无描边，正在对话条目复用输入框聚焦的高光描边，「对话 / 收起」均为透明紧凑 ghost 动作，不添加常驻描边。框色底保证折叠时不透出后排文字；实际行高 `--ws-bubble-h` 取折叠位移使用的 `--ws-row-h`。停靠布局从 `--sidebar-row-height` 取得该值。回归 `test/workspace-utility-material-visual.mjs` 验证四种主题下三态实际像素相同且重叠不透底。头像左键开合对话；整行与头像右键提供编辑、删除和标记未读，见 notification-system.md。**速览 keep-alive 必须用原生 DOM 指针监听**（`.sessions-float` 上 addEventListener pointerenter/leave）——React 合成 enter/leave 按 fiber 树算路径，portal 会把栈的 fiber 挂到 AgentFloat 子树，误判为离开左栏；原生事件按 DOM 树判定，悬停胶囊不收回。
- **左栏分区**。「实用工具」固定在顶部，超长时在 `max-height: 50%` 内纵向滚动。收起时保留展开网格的第一行，入口数量随栏宽变化，扩展树随分组关闭。「工作会话」「终端」的标题各自与 `.left-section-scroll` 列表分开，收起时保留当前项或第一项，其他项收拢为后排轮廓。标题右侧的独立箭头以 `aria-expanded` 表达各分组的开合。三个分组标题统一使用 12px、`fg-muted`、0.02em 字距与 `--left-pad-x` 横向留白。
- 调度对话面板（`.agent-float-panel`）仍挂 AgentFloat 根（MainViewShell 内 absolute），随 `sessions-hidden` 类 display:none（React 状态保留，侧边栏再现即恢复）；速览在场时保持高于左栏。高度上限不与顶栏重合：`agentFloatGeom.ts` 的 `maxPanelHeight`（视口 − 底锚 12 − 顶栏 36 − 顶隙 8）同时约束拖拽上限、持久尺寸套用与 CSS 默认 max-height（2026-10-06 报单④；不抬 z-index——遮挡根源是 `.main-view` overflow 裁剪，且顶栏拖拽区/全局入口不该被盖）。面板背景、边框保持中性，顶栏「重置」为中性弱按钮，右上角「收起」与栈行入口使用同一 ghost 状态，默认透明、无常驻边框。开合只走显式手段：工作区头像左键、气泡右侧常驻「对话 / 收起」钮、气泡主体在对话中再点也可关；另**点左栏会话/实用工具入口自动收起**（LeftPanel 的 `select`/`selectUtility` 置空 `chatWorkspaceId`，2026-10-07 报单⑤，与手动收起同语义——presence 退场、不销毁状态；组件回归 `test/unit/left-panel-collapse-agent-float.spec.tsx`）。工作区头像右键直接打开编辑弹窗（2026-10-10 顶栏工作区菜单整体撤出后，这是「编辑工作区」唯一显性入口；UI store 的 requestWorkspaceEdit(workspaceId) 请求通道与 AgentFloat 消费端保留，复用名称/头像保存、代码索引与删除路径，不跳转应用设置）。开合以 store 的 `chatWorkspaceId` 为唯一来源；`usePresenceValue` 冻结退场内容，stage 映射 `is-entering/is-open/is-exiting`，transition 可打断。工作区栈切区经 `useWorkspaceTransitSwitch` 走统一过场（见 animation-system.md「工作区切换过场」）。
- 背景模糊：会话页激活且调度对话可见时，`.agent-float-backdrop` 复用全窗磨砂遮罩，并跟随对话面板阶段淡入淡出。点遮罩空白收起，退场时释放命中，工作区胶囊栈保持可操作。折叠左栏隐藏对话或切到虚拟屏右页时释放遮罩。macOS Vibrancy 采用同一套临时合成层与框色衬底，见 [窗口背景](frame-backdrop.md) 和 `test/e2e/window-material.spec.ts`。
- 锚位：锚点行（`.agent-float-anchor`）内以**同几何幽灵占位**（`.agent-ws-stack-ghost`，visibility:hidden + pointer-events:none，含 is-chatting 同步收窄与折叠态同结构）撑住面板「贴着栈右侧、气泡收窄时左移」的位置；锚点本体 pointer-events:none——幽灵足迹的悬停不算「悬在浮层上」，也不会挡住底下的真栈。
- **栈折叠（iOS 堆叠通知意象，2026-09-14）**：栈头（`.agent-ws-stack-header`，新建 ＋ 旁）有折叠钮（`.agent-ws-collapse-btn`，工作区 ≥2 才渲染），点按在展开/折叠间切换、偏好落 localStorage。折叠态：当前工作区行置顶保持展开；其余行用负 margin 叠到当前行正后方（不占流内高度，容器高 = 栈头+当前行），再按 `--ws-depth` 缩小一圈、下移一点、垫在后面（`transform: translateY+scale`，露出的卡片边越靠后越窄越矮；头像隐藏只露边；深度 >`WS_STACK_PEEK_LAYERS`(3) 的加 `is-stack-buried` 完全隐藏）。幽灵栈同步同结构，面板锚位不漂移。
  - **z 层叠只在行重叠时存在**（2026-09-14 修「内阴影」）：行 z（激活 20/其余 10）限定在 `.is-collapsed` 与动画窗口内；展开静止态全部 z-auto 按 DOM 序绘制。旧版栈行有投影时，此约束防止后行被前行投影压出假内阴影；当前宽屏栈行已改无投影、无描边，层叠靠不透明框色底与中性叠层区分。`is-active-row` 按真实激活工作区标记，不按位置（展开态首行非激活行时不得冒领）。
  - **动画窗口 `is-stack-animating`**（2026-09-14 修「瞬时滚动条」）：点按切换时挂上，`panelMs+(n-2)*30ms`（级联行 transform 最深一层追平手风琴）后收窗、连点重置、reduced-motion 不开窗。窗口内保留 z 层叠，且 `.left-ws-slot:has(...)` 挂 `overflow: clip`——手风琴先缩、未起飞的行会被拖到卡片底缘以下；裁剪线=槽位 padding box（与卡片内缘齐平）视觉零损失，常挂会硬切投影故只在窗口内。
  - 切换时激活行与首行在「置顶槽」和手风琴间换容器重挂（key 跨容器），激活行瞬移置顶/回位不走动画——「折叠=当前行置顶」设计的固有代价。组件测试：`test/unit/ws-stack-collapse.spec.tsx`。
  - **窄栏状态胶囊**：已读状态在整行悬浮时临时重显。状态按钮及内部徽标允许收缩，最多占气泡内容宽度的 45%（上限 102px），长文案省略；常驻「对话 / 收起」按钮保持完整宽度与点击范围，不随状态重显越过右缘。生产组件浏览器回归 `test/agent-float-status-width-visual.mjs` 覆盖深浅主题、180/200/280px 槽位与开关两态；`agent-float-chat-toggle.spec.tsx` 覆盖已读隐藏、悬浮重显和开合按钮身份/点击。
  - **对话收窄（is-chatting）几何**：头像始终为胶囊内部的 23px 元素，不拆出、不独立放大；打开对话时整颗胶囊保持右缘不动、向右收窄，用形状明确标识当前对话对象，关闭后恢复整行。头像仍为同一 DOM，左键开合，右键显示工作区菜单。宽屏槽位复用已有 dock 过渡，`margin-left` 取 `clamp(0px, calc(100% - 144px), 56px)`，`.agent-ws-stack-main` 用 `width:auto` / flex 跟缩，窄栏至少留 144px 给头像、文案和收起钮。工作区栈折叠时后排轮廓同步收窄，不能从前排左侧露出后排文字。窄屏浮层保留原来的独立头像与让位几何。**槽位内勿用浮层公式宽**：`--ws-bubble-docked` 会撑爆 grid rest-body 令其他行右缘参差。回归 `test/workspace-chat-dock-visual.mjs` 覆盖三种栏宽、头像始终留在胶囊内、减弱动态及快速反向开合；组件用例 `test/unit/agent-float-chat-toggle.spec.tsx` 覆盖只标记当前对话对象、切换/关闭恢复与头像身份保持。性能与实测见 `performance.md` §7。
- 窄屏：左栏是抽屉，栈保持左下浮层内联渲染（`stackInline`，无 portal），行为与旧版一致。
- 展开列与速览浮层二选一挂载（LeftPanel 单实例）：切换时槽位元素更换、portal 容器随之切换，栈重挂一次（无状态损失，通知数据全在 store）。

### 分组表头样式

实用工具、工作会话、终端和工作区标题左缘均使用一份 `--left-pad-x`；工作区槽位已提供内缩，栈头不重复加 padding。标题后的折叠箭头和标题行 `+` 操作统一为 28×28px、`--radius-control` 圆角与 `--interaction-hover` 悬浮底；栈头的折叠/新建按钮默认隐藏，**悬浮/键盘聚焦栈头自身才显形**（与工作会话/终端标题带同款作用域；不得放宽到整栈 `:hover`——悬浮工作区行不是操作栈头，带出按钮属误显，2026-10-31 报单）；三个标题文字均不响应折叠；仅独立箭头按钮切换，背景由按钮承载，只有内部 SVG 旋转。工作区标题和按钮间距同为 4px。CSS 浏览器回归 `test/sidebar-header-visual.mjs` 覆盖深浅主题、200/280px 栏宽、真实鼠标悬浮、折叠方向及标题左缘。

工作会话行默认显示左侧状态图标；悬浮或键盘聚焦时，Harness 图标替换同一状态位，提示和无障碍名称为引擎名称，不额外占宽也不移动时间槽。带子代理的行在指针移入该槽位时显示展开箭头并可点击；离开槽位但仍悬浮行时恢复 Harness 图标。`sessionHarness.ts` 按目录映射 GUI 和 CLI runtime，ACP 使用会话保存的预设 ID，旧 ACP 会话缺少预设时显示通用 ACP 标识。普通终端和缺少 runtime 的会话不推测品牌。图标使用 `HarnessIcon` 的本地资源；未知引擎以首字母回退。会话与终端行悬浮或键盘聚焦时，固定 32×24px 相对时间槽位以 opacity 交替显示时间和归档图标。仅归档图标在按下时微缩，按钮命中范围与槽位不移动，隐藏动作即时停止接收指针。点击调用原有 `useArchiveFlow`，已归档项可取消归档，不触发选中或更多菜单。重命名、置顶、中断、续作等完整操作只通过行右键打开 `ContextMenu`。图标反馈使用 `--dur-micro` / `--ease-hover`，Harness 映射与列表行为见 `test/unit/left-panel-harness-icon.spec.tsx`，真实组件悬浮、聚焦及归档回归见 `test/session-harness-visual.mjs`，其余组件与 CSS 契约见 `test/unit/navigation-micro-motion.spec.tsx`；归档按钮的按压和反向过渡仍需浏览器验收。

**会话操作失败反馈（2026-10-25，X4-F02）**：左栏会话操作族——新建 shell（`sessions.create`）、重命名（`rename`）、标记/取消完成（`setPhase`）、重启（`respawn`）、带上下文续作（`resumeInterrupted`）、关闭（`close`）——IPC 失败统一经 BoardPanel 同款 `reportError`（err.message → `flashTip`）上浮，不再零反馈；经「新建任务」对话框新建的路径由对话框自身捕获并发布窗口 tip。回归 `test/unit/left-panel-session-errors.spec.tsx`。

### 实用工具与分组折叠栈

`UtilityNavigationSection.tsx` 展开和收起时共用同一磁贴网格。`CollapsibleRailStack.tsx` 根据实际网格位置保留首行，沿用展开时的入口、尺寸和间距，第二行起淡出并设为 inert。栏宽改变后按实际分行重新测量。扩展树经 `usePresence` + `acc` 退场，重新展开后恢复树的开合偏好。首行若包含「展开更多工具」按钮，可用它展开分组并打开扩展树。首行收藏的「在列表中显示」也可展开并定位扩展树。

工作会话与终端也使用 `CollapsibleRailStack.tsx`。收起优先保留中央区当前项，未匹配时保留列表第一项。

栈保留每项的原 DOM 与自然顺序。布局测量按实际 key 顺序、保留项索引、折叠态、保留首行选项和布局 `className` 失效。输入变化时在 `useLayoutEffect` 同步读取 offset，于提交前更新轨道高度和行位移。等价 JSX 或内容更新不触发同步测量，单项模式通过选中属性处理回退。几何结果按字段和各行偏移比较。

同一个 `ResizeObserver` 以 `border-box` 观察布局 body 与全部直系项。字体、宽度、动态行内容或多列重排导致单项尺寸变化时，即使 body 总高不变也会更新几何。key 顺序变化时重新绑定观察集合，卸载时断开。外层 `usePresence` + `acc` 过渡 `grid-template-rows`。实用工具以第一行的自然高度收拢。会话与终端的行通过 transform 向第一项位置收拢，淡出的条目由内容下方的两层中性轮廓提示。

隐藏行立即设为 inert/aria-hidden，不再响应完整列表的 ↑/↓ 导航；展开保留 DOM 身份并恢复交互。快速反向点击从当前过渡位置续走；主题或尺寸变化产生真实几何变化时由观察器补量，选中项移除则同步回退重测。无匹配或空列表保留原有空态，单项不画后排。减弱动态由全局 motion 规则压缩过渡。组件回归见 `test/unit/collapsible-rail-stack.spec.tsx` 与 `left-panel-collapse-agent-float.spec.tsx`，覆盖等价 JSX 零 offset 读取、选中/回退/重排、单项尺寸与多列位移更新、观察器释放及原 DOM 保活。真实生产组件场景见 `test/fixtures/sidebar-stack.tsx` 与 `test/fixtures/sidebar-stack-scenario.mjs`（IPC mock）。

## 7. 持久化

| 存储 | 键/字段 | 含义 |
|------|---------|------|
| localStorage `muster.sessionsOpen.v1` | `'1' \| '0'` | 展开/折叠偏好（全局，默认展开） |
| localStorage `muster.sidebarCollapsed.v1:<workspaceId>:workspaces` | `'1' \| '0'` | 工作区栈折叠偏好（按工作区独立保存；旧全局偏好作首次默认） |

实用工具、工作会话、终端使用同一工作区分桶键，section 分别为 utilities / sessions / terminals。布局宽度使用全局 localStorage `muster.leftColumnWidth.v1`（速览面板与展开态共用）；首次迁移当前工作区旧宽度，后续切区不改变。详见 ui-state-persistence.md §6.1。

## 8. 已知边界

- 归档确认与会话树：正在执行或带 worktree 的目标及后代会进入统一确认，运行中默认取消。已归档行提供独立的恢复和永久删除按钮。归档后的普通打开读取历史，继续执行走显式入口。


- 切折叠/展开时 LeftPanel 重挂一次（内部瞬态如展开的搜索框会复位）；会话数据全在 store，无数据损失。
- 指针悬停在内置网页（`<webview>` guest）上时收不到 pointermove，热区在该区域不触发（与虚拟屏把手同类限制）。
- 工作面划开期间网页直接随工作面平移（渲染层 `<webview>` 参与合成；旧「划开期间冻结帧让位」机制已随 2026-10-08 webview 迁移移除）。
- 窄屏下折叠/热区不生效（布局归抽屉管）；专注与折叠完全解耦（见 §1）。
- 热区武装防抖：热区激活瞬间光标若已落在检测带内，需先离开再进入才会浮现幽灵把手（防面板刚收起立即重开）。
- 回归：`test/unit/sessions-slide-dock.spec.tsx` 覆盖热区武装与 Escape 捕获/输入焦点豁免；`test/sessions-slide-css.mjs` 守工作面与下层左栏的位移/层级。
- 展开工作区栈会挤高列表区：窗口高度/栏宽/会话数刚好跨过溢出线时会冒出滚动条（偶现）。槽位宽度隔离后会话行宽与右侧 `--frame-gap`（默认 6px）留白应保持不变；回归 `test/unit/ws-stack-session-layout.spec.tsx` + `test/ws-stack-session-layout-visual.mjs`。

## 9. 单行会话与整行悬浮详情

正常移出条目到其他元素（原生 `relatedTarget` 非空）必须启动关闭宽限；只有原生 `relatedTarget` 为 null 且条目仍命中 `:hover` 时才忽略该事件，避免正常离开被误判为列表重排。

- `LeftPanel.tsx` 读取原有 `SessionMeta`、状态推导、相对时间与标记；`SessionRailContent.tsx` 只负责静态名称与状态布局。会话保持 38px 单行、胶囊 22px；短状态自然收紧，长状态最多占轨道一半，名称与状态各自省略，不再展开、借位、滚动或设置独立交互焦点。移除全文测量层、ResizeObserver 与 MutationObserver。重命名时隐藏胶囊，输入占满轨道。
- 工作会话与调度状态共用 `StatusBadge` 的中性外观，表面和文字仍走实际 frame/canvas 的状态 token。已读胶囊默认隐藏，悬浮会话条目临时显示，原已读/未读数据逻辑不变。右侧 32px 时间/更多槽位、置顶、隔离、飞书与协作标记保持原行为。
- 整条会话鼠标停留 400ms 后显示 `SessionDetailsCard.tsx`（复用 `useHoverPinMenu` 的悬浮防抖），键盘聚焦整行同样可打开。详情卡 portal 到 body，在条目右侧显示；右侧不足则向左避让并钳制视口边缘，不被列表滚动区或速览裁切。卡片使用非模态 dialog，可悬浮停留并通过 ID 按钮复制；文字禁止框选，避免唤起被浮层遮挡的文字操作面板。进出场使用 `usePresenceValue`、`mp-pop` 和 motion token。定位在卡片真正挂载后重算（presence 阶段进 effect deps）：target 后到时首跑 cardRef 尚未挂载，不补跑会永久停在定位前状态（空闲会话无后续 store 更新补救，曾表现为卡片钉在视口左上角）；悬停捕获的 anchor 若在 400ms 延迟内被列表重挂重建（detached 节点 rect 全 0），按行上 `data-session-row` 回查当前行，查不到则不显示。定位成功前卡片保持隐藏，不在原点闪现。
- 详情头部将会话名称、推导状态/置顶标识与最近使用时间放在同一行，名称可换行，状态与时间不收缩（状态复用会话列表同款 StatusBadge 胶囊，使用 overlay 配对的中性背景与文字）；当前 liveStatus.label/summary 保留原有说明区背景、10px 12px 内边距及内容高度，仅将容器圆角改为公共 radius-pill 胶囊形状；长 summary 最多五行；字段网格展示非空工作区、运行时、模型覆盖、分支与目录。运行时字段显示对应 Harness 图标和具体名称，与左栏、看板共用解析；无法确定 runtime 时沿用已有文本。底部弱化显示会话 id 与运行时会话 id，两者各带复制按钮，复制成功或失败均有明确反馈。状态变化实时更新，不再把这些内容拼在状态图标的 title 中；名称与胶囊也不再拥有独立展开提示。
- 条目与详情卡共用悬浮状态，移出后有 120ms 宽限，进入另一方取消关闭；离开两者后收起；行收到 DOM 移动派发的假 mouseleave（其它会话更新引发行重排、原生 relatedTarget 为 null 且 `:hover` 仍命中）不算离开。卡内点击、复制和滚动保持显示；点击卡外、右键条目、拖动、Escape、滚动 anchor 所在的列表/速览、窗口失焦或切换工作区会关闭预览——其它面板的滚动（如会话流式更新时转写自动贴底）不关卡片（窗口级 scroll 捕获按事件目标是否包含 anchor 过滤；React 合成 relatedTarget 会把原生 null 归一化成 Window，判假离开必须读 nativeEvent）。useSessionsPeekHover.ts 以原生指针事件把属于折叠速览的 portal 详情卡纳入左栏保活范围，卡内移动不误触收回。折叠侧栏速览点击名称/胶囊恢复普通选中即收回；不再为旧文字展开保留首次 Escape 或点选例外。
- `LeftPanel` 在预览打开前也监听滚动以取消 400ms 等待；该监听与卡片使用相同的 anchor 容器边界，借 ref 保存鼠标/键盘触发的目标，行重建时按 `data-session-row` 回查。不能仅修卡片内监听而保留父组件的全局无条件关闭，否则聊天自动贴底仍会刷掉卡片。聊天区滚动、状态快照更新、卡片内部滚动均保持详情；会话列表滚动取消预览及尚未完成的打开等待。
- 组件回归：`test/unit/session-rail-content.spec.tsx`、`left-session-rail.spec.tsx`、`session-details-card.spec.tsx`、`sessions-peek-hover.spec.tsx`、`sessions-slide-dock.spec.tsx`、`sessions-float-surface.spec.tsx`。覆盖移除旧展开、整行触发、分组内容、退出/快速划过、边界定位与内容更新；`left-session-rail` 通过真实 LeftPanel 装配覆盖聊天刷新/自动滚动、卡片内部滚动以及打开等待期间的滚动过滤，避免只测独立卡片遗漏父级监听。实际外观由用户验收，未将此前展开版截图当作本版证据。

## 10. 会话树：子代理缩进挂父下（子代理通用化）

带 `parentSessionId` 的普通会话在左栏挂在其父下方。有效父子链不设固定层数，创建统一受现有并发队列约束；`delegateTask` 仍拒绝成环或断链。工作区缺省跟父，显式跨区在建立资源前拒绝；异步启动前也重验父的工作区。任务表是可选投影，普通子会话默认不落表，不必走任务交验。创建、观察（sessions.observe）和通信对父子同等开放。

子代理**不是特殊会话类别**——它就是普通 worker 会话，因此父与子能力对等：父子都能拉子、都能被拉、都能分屏拖拽、都能收注入。子代理目录权限**与普通会话无差异**（派活时定的那个就是它的目录），不存在「子继承父的根占用」这类父子约束——那是从已删除的 `bgtasks.spawn` 时代遗留下来的旧设计，见 子代理通用化计划 §5.3 的结论修正。完整方案见该计划。

- **数据与纯函数**：`shared/sessionTree.ts` 提供 `sessionDepth` / `canSpawnChild` / `sessionDepthLabel` / `buildSessionTree` / `flattenSessionTree` / `countChildSessions` / `breakParentCycles` / `sessionSubtreePostOrder`，零依赖可单测。深度不在 `SessionMeta` 冗余存储——按 `parentSessionId` 回溯算，父改名/归档都不会让缓存深度漂移。
- **职业角色**：`sessions.create(asSubagent=true)` **不接受 `characterId`**（出现即拒）——角色由宿主按 24 个内置目录轮选分配，不按任务职责选择；显式角色仅剩内部可信路径（重试复用/队列重入直调 `delegateTask`）。`SessionMeta.subagentCharacterId` 固定头像身份，创建名为「角色名 · 任务短名」，左栏沿用会话名与原状态图标。汇报携带发送时的名字/角色快照；详见 [子代理职业角色](subagent-characters.md)。
- **渲染**：`LeftPanel` 的工作会话区按树序（深度优先，父在子前）渲染，每层缩进 12px 并带一条层级引导线（`.session-tree-indent`，宽度由组件内联给出——`attr()` 在 `width` 里不生效；负右边距吃掉 flex gap 的大部分，使每级实际位移 ≈ 12-15px，与文件树 `files.css` 同档）。
- **展开箭头**：复用工作会话分组折叠的 `IconChevronDown`（14px，同一个图标——不做第二套箭头），**叠在状态图标位上**（`.session-state-slot` 内绝对定位，与状态点中心重合）——默认透明不可点；带 Harness 标识的行悬浮时先显示引擎图标，指针移入状态位后才显示箭头并允许点击；缺少 Harness 的旧行仍在悬浮整行时显示箭头。朝向沿用折叠语义：展开态朝下（`IconChevronDown` 基础态）、收起态转 -90° 朝右（同 `.panel-header-chevron`）。不额外占布局宽度，故缩进只由层级决定。点它折叠**整枝子树**（含孙层），`aria-expanded` 同步。只有有子会话的行标 `data-has-children`，键盘导航序列与树序同源。
- **健壮性**：`buildSessionTree` 内部自愈「父不可见」与**成环**——父被归档/搜索过滤掉的子提升为顶层（不凭空消失），`parentSessionId` 成环时把环起点提升为顶层，否则 x→y→x 会互为 children 且都不在 roots、整对从列表消失。不要求调用方记得先断环。
- **全局看板边界**：子孙代理不作为独立卡片/自由节点进入全局看板，也不参与数量与探出提醒；左栏树仍可单独进入和管理它们。
- **归档/删除级联**：`SessionsService.setArchived(true)` 与 `close` 都处理该会话及全部后代，叶子先释放；操作子节点不影响其祖先或兄弟。归档前整枝检查操作锁，先将全枝标归档再触发退出通知，避免清理唤醒父；已单独归档的后代不重复释放。取消归档只恢复点名会话，不自动恢复孩子。子会话的准备开始与最终入表时检查父存在、未归档且同工作区，归档/删除期间尚未完成的派活不再落入活跃子会话。删除须先归档根节点，预检整枝；后代 worktree 清理尚未完成或被改动守卫保留时，父记录也保留，`onSessionRemoved` 在后代移除后继续关闭父。恢复父会话会取消其待删监听。已有资源释放、未提交/未合入保留守卫不变；工具批量同时点名父子只执行父的级联清理。
- **与分屏共存**：分屏按 `SplitPaneRef`（只含 sessionId）驱动、不看父子关系，子代理天然可拖拽分屏、进 Snap 布局、填充分屏空槽。唯一改动是从 twisty 起的拖拽被显式拒绝（点 twisty 只折叠，不是分屏拖拽）。
- **中栏层级路径面包屑**（D2）：子代理会话在中栏标题处显示祖先链 `会话 顶层A › 子代理 子代理A1`——每级带层级标签（会话/子代理/孙代理，`sessionDepthLabel`），分隔符 ›，末级（当前会话）高亮且不可点，祖先可点回跳（经 `jumpToSession`，跨工作区会先切区）。**顶层会话不显示面包屑**（链长 < 2 时回落原单标题形态，不给所有会话加噪）。实现在 `CenterPanel` 的 `PaneToolbar` 内（`.center-pane-crumbs`）。
- **结果与通知**：[宿主邮箱](session-mailbox.md) 统一通信，向父汇报使用 sessions.message({to:"parent",text})。原生最终回复由 sessions.observe 查看，不自动转寄首次回音、done、失败或恢复；新信持久保存，父忙时不插话，空闲后仅合并的宿主收信提醒。只有父主动打开正文才标读；归档/删除不恢复。
- **模型可见性**：R5 后常驻清单即全部可用面（Worker 34 项/preset 差分），所有会话共用；复杂域经 X.run 单入口，无发现层。父收件人由宿主推导，无父时明确拒绝，不保留专用汇报别名。
- 回归：`test/session-tree.mjs`（真实深度、损坏链拒绝、环自愈）、`test/subagent-role-delegation.mjs`（深层派活、可选任务表）、`test/unit/left-session-tree.spec.tsx`（树序、整枝折叠与既有图标契约）、`test/unit/center-pane-crumbs.spec.tsx`、`test/unit/center-split-subagent.spec.tsx`、`test/mailbox.mjs`、`test/subagent-tool-exposure.mjs`、`test/subagent-prompt.mjs`。真实 CSS 视觉脚本位于 `test/visual/session-tree-look.mjs` 与 `center-pane-crumbs-look.mjs`。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D07.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：最左会话栏折叠/展开——左上角 logo 位开关（持久）+左缘热区速览（临时）；工作区胶囊栈 portal 进左栏底部、调度对话面板随侧边栏显隐联动；子代理树缩进挂父下。
- 为什么这样设计：折叠不占布局、速览整面右移露出下层常驻左栏（挂 MainViewShell 根避 .h-strip transform 劫持）；热区用 window pointermove 距离判定+武装机制（不挡底下内容点击、防刚收起立即重开）；速览 keep-alive 用原生 DOM 指针监听（portal fiber 树会误判离开）；分组标题与列表统一滚动、折叠栈 iOS 堆叠意象（后排轮廓+动画窗口防瞬时滚动条）。
- 明确不做：专注不改会话栏显隐（完全解耦）；开关点按后不自动收回（持久语义）；原生网页（WebContentsView）上热区不触发（平台限制接受）；子孙代理不进全局看板（只左栏树管理）。
- 归档与永久删除的当前行为见 [会话模型](session-model.md#81-归档后的会话选择)。

## 分组紧凑布局

工作会话与终端共用 `.left-panel-scroll` 滚动视口，标题和列表按内容高度顺序排列，不分别滚动或按比例压缩。工作会话较多时，终端可排到可视区域之外，通过向下滚动访问。两组保留各自搜索、新建与折叠操作，组间距为 12px；工作区栈仍固定在滚动区域外。

两组没有会话时统一显示“当前空，点击+新建”，使用透明背景与虚线边框，空状态块高 38px，与会话行等高。

窄窗从左栏「工作会话」的「＋」打开新建任务后，表单确认创建了会话才通知工作台收起左栏抽屉，释放中栏的点击区域。创建失败保留表单，排队状态保留回执。

实用工具区域底部与工作区区域顶部不显示分割线，仅通过留白区分中间共用滚动的会话列表。

Visual spacing: the shared scroller has 8px top/bottom padding and no rounded clipping; group headings have 6px bottom padding. Utility tiles leave 8px bottom spacing; the workspace section has 10px top spacing.

Scroll-edge fading uses `useScrollEdges`: scroll, viewport resize and content resize update each edge independently. Only edges with hidden content fade over 4px; reaching an edge disables its fade.
