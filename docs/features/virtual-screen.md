# 分轴虚拟屏（交互与实现）

> 实现说明 v2.4（2026-11-28，修复收起和重开右侧栏后的虚拟屏恢复）
> 代码主入口：`src/renderer/src/App.tsx`、`src/renderer/src/styles.css`  
> 关联：终端适配见 `TerminalView.tsx`；调度 Agent 见 `AgentFloat.tsx`；Git 见 `panels/gitpanel/` / `main/git/`

本文描述主区**横向虚拟屏**（（会话+终端）↔ Git）与 **Agent 左侧悬浮**。

---

## 1. 产品布局

```text
┌────────────────────────────────────────────────┐
│  横向虚拟屏：（会话列表 + 终端） ↔ Git（可开关）   │
│                                                │
│  Agent 悬浮：收起左下 / 展开左侧聊天面板          │
└────────────────────────────────────────────────┘
```

演化要点：

- Agent **不再**嵌在左列纵向虚拟屏里，改为独立悬浮层。
- **会话列表与终端同属工作页**，切到 Git 时一起左滑；不再把会话列钉在视口左侧。
- 虚拟屏服务：**（会话+终端）↔ Git 面板**。

---

## 2. 用户可见行为

内部面板控制可请求切换工作页 / Git 页：`usePanelAxisFocus` 复用现有 `showTerminal`、`showGit` 与启用虚拟屏流程，活动编辑器有未保存内容时拒绝切页，状态真正到达目标后才回复；工作区变化或超时按结果未知处理。公共 `host.panel` 工具尚未注册。

### 2.1 横向虚拟屏

折叠左栏的临时速览移动外层 `.ws-stage`，内部 `.h-strip` 仍按原虚拟屏比例、切页位置和命中热区运行；右页随工作面一同右移并在窗口边界裁切（内置浏览器已 `<webview>` 化参与渲染层合成，随 DOM 一同移动，2026-10-08 起）。`.ws-stage` 底边内收 `--frame-gap`（默认 4px），因此分割线止于底部框色留白；JS `viewH` 直接读取工作面 `clientHeight`，同时观察工作面与主视图尺寸，边距变化无需同步像素常量。普通态只在激活侧露出横向框色留白：左页在左、Git 页在右；专注态两侧都留。实色回退下，左栏收起时 `.ws-stage` 以框色涂底遮住下层侧栏，不能涂 `--bg-panel`；Mica 模式沿用透明框层与隐藏侧栏规则。`test/frame-gap-visual.mjs` 在 Chromium 中同时验证 CSS 声明、实际高度测量与截图像素。

- 会话、右侧工具和设置等阅读页统一使用 `--radius-page` 与 `--corner-shape-page`。Windows 11 Mica 使用 8px 半径和全局 `superellipse(1.5)`。普通窗口和最大化时，阅读页、侧栏会话行与工作区行共用该轮廓，外窗框由系统绘制。macOS Vibrancy 使用 `superellipse(1.2)`，半径为 17px 减去 `--frame-gap`，最小为 0。实色框和浏览器回退到 10px 和全局角型。内描边继承页面轮廓，工作区切换骨架使用同一套页圆角，侧栏展开、收起和速览均一致。窄窗右抽屉内的工具页及直接铺满屏幕的会话内容沿用直角裁切。
- VS 开启或专注并肩时，中央页缝使用 `--page-gap = --frame-gap`（默认 4px），与外缘/底部一致；`.terminal-page` 右侧取向下舍入的一半、`.git-page` 左侧取剩余整像素（默认 2px + 2px），避免半像素卡片边缘；关闭 VS、仅显示会话面板时，右侧改留完整 `--frame-gap` 外缘空隙，与底边一致（默认 4px）；不再贴住窗口右缘。间隔按两侧描边外侧之间的净距离计算，不含描边本身。阅读卡无外投影，保留圆角内容裁切；内容上方的无命中伪元素通过 inset 与 `--surface-rim` 绘制整圈 1px 原材质细边，细边位于卡片内部。间隔透出共同框底，Mica 模式沿用透明框层，不另涂底色。工作面的静态 clip margin 为 `--frame-gap`，胶片滑动期间归零以防相邻格漏入留白，结束恢复；详见 [窗口背景](frame-backdrop.md)。页面宽度、平移比例和分割条坐标保持原几何，分割条位于间隔中央。
- 分割条使用全高页缝作为悬停热区（`.pane-split-hit`，与 `--page-gap` 同宽）。双箭头把手贴在指针所在的纵向位置，两端留出把手所需空间。分割线静息透明，悬停或调宽时在页缝中心显示 3px 线。窄热区让两侧页面滚动条保持可拖动。右侧虚拟屏收起时，由顶栏右侧开关重新展开。双栏全屏仍显示这套把手。
- 长按把手约 400ms，在其位置展开一张调节菜单。鼠标点击切屏、鼠标悬浮切屏在把手上方，关闭虚拟屏在下方，当前模式用勾号标出。窗口顶底空间不足时，菜单各项会排到较空的一侧。按住后纵向拖到任意可见行并松手即可选择。鼠标短按提供按压反馈。键盘 Tab 到把手后可用 Enter 或空格打开，方向键选项、Esc 收起。选择关闭虚拟屏会进入双栏全屏。选择点击或悬浮切屏会保存全局偏好，并从双栏全屏直接切到开启的虚拟屏布局。
- 把手、悬停提示、加减号胶囊和菜单复用 `usePresence` 与 `mp-pop` 的进退场。菜单从胶囊大小展开并淡入，收起时沿同一位置缩回并立即解除交互。重新打开可从退场中继续。系统或应用启用减少动态效果时直接切换。Esc、指针取消、失去捕获或窗口失焦会终止手势，已开始的调宽回滚到原比例。
- 按住把手经过上下选项时预览候选项，松手才提交。从选项行回到加减号所在行，横向移动越过 8px 即可转入调宽。调宽开始后继续跟随横向位移，加减号胶囊留在接缝上，随分割线移动并点亮当前方向。终端主态调 `hTerminalRatio`，Git 主态调 `hGitRatio`，双栏全屏调 `focusRatio`。两侧内容实时重排，普通虚拟屏在调整的一侧显示磨砂比例指示卡。macOS Vibrancy 下，指示卡在拖动期间仅采样 `.work-area` 内的背景，防止会话栏文字和阅读卡边缘残留旧帧。松手保存最后一次拖动的比例。组件回归见 `test/unit/split-expand-trigger.spec.tsx`，Electron 交互和材质回归见 `test/e2e/virtual-screen-controls.spec.ts`、`test/e2e/window-material.spec.ts`。
- 切页（**点击在两种模式下都是显式切页意图**，`hSwitchMode` 只决定有没有「驻留即自动切」这条通道）：
  - `hover`：悬停某一页（含邻屏 peek）约 **280ms** → 平移到该页；切换后 **300ms** 冷却。点击非当前主屏的那一页（含 peek）同样**立即**平移。
    为什么悬停模式也要吃点击（2026-09-11 修）：程序化切页（点会话里的文件链接 → 自动 pan 到
    Git 页露文件预览）后，指针常仍停在露条上——露条里还是同一个工作页元素，浏览器**不会**重发
    `pointerenter`，悬停计时器永不武装，于是只能「移出露条再移回」才能切回会话区。
  - `click`（默认）：点击非当前主屏的那一页（含 peek）后平移到该页，鼠标停留时保持当前页。已保存的切屏偏好优先。
  - 程序化切页后 `suppressPageClickUntilRef`（700ms）拦住宿主 DOM 的跟随 click 和悬停。网页或扩展露条手势层收到一次新的 `pointerdown` 时立即切页，用户无需等静默期结束。
- 虚拟屏开关状态：当前工作区 `.muster/workspace.json` 的 `hVirtualScreen`（boolean；经 IPC 读写）。
- **切页入口唯一且只看真实 DOM**（2026-10-28 重构，`hooks/usePageActivation.ts`）：两页页根带 `data-h-page="terminal|git"`，`.h-strip` 上挂原生 `click` / `pointerover` / `pointerout` 监听，按事件目标所在页根判定点击了哪一屏、指针进出了哪一屏。不用 React 的 `onClick` / `onPointerEnter`：经 portal 渲染到另一屏的内容（固定到右侧的会话 / 工具、右侧扩展标签）在 React 树里仍属原屏，合成事件会冒泡、enter/leave 会计算到原屏，曾导致固定到右侧后点击 / 悬停右屏无法激活。当前屏上的点击与悬停本来就是空操作（alreadyThere），因此不再维护「控件排除」选择器清单；露条态整条都是切页热区（含按钮）。新面板无论是否 portal 都无需接线，**唯一的接法要求是 iframe / webview**：它们会吞掉宿主指针事件，露条态必须放透明手势层并调用 `dispatchPeekPointer(type, 覆盖层元素)`，目标屏按覆盖层自身所在 DOM 解析，覆盖层不需要知道自己在哪一屏；窄屏抽屉不响应该通道。回归 `test/unit/page-activation.spec.tsx`。
- 左右两侧的扩展 iframe 与内置浏览器 webview 均按上条在露条态使用宿主透明手势层。右侧只给可见的当前扩展标签启用；左侧由 App 的真实虚拟屏状态通过 `ExtensionHomePeekContext` 控制，不把工具面板的可见状态误当作屏幕激活状态。对应屏激活后撤去，首次点击不传给扩展控件；虚拟屏关闭、双栏并排和窄屏不走此通道。`test/unit/extension-surface.spec.tsx`、`right-workspace-ui.spec.tsx` 覆盖双向接线、显隐及真实内容区点击后仍能编辑和保留草稿（原 Electron 级验收 `test/e2e/extension-iframe.spec.ts` 已随扩展系统迁移移除）。
- 文件面板直接预览 HTML 时也使用透明手势层。页根 `data-h-peek` 标记当前露条，预览按 iframe 实际所在的屏决定手势层是否命中，文件在左右栏之间保活移动时沿用同一规则。切页后 iframe 恢复操作。详见 [文件预览](file-preview.md)。
- 页面临时浮层按触发器所在的真实 DOM 页确定归属，固定到右侧的会话也用同一规则。右键菜单及子菜单、入口操作菜单、划词浮条、模型面板、轮次 Diff 预览和消息批注挂在 `.h-strip` 上，按窗口范围避让后换算为胶片内坐标。切页时随胶片平移并退场，退场期间释放焦点和点击命中。批注保留编辑器，切回随页面重新出现并恢复草稿。原生及回退下拉和会话详情在来源页变为露条时关闭。详见 [菜单与悬浮提示](menus-and-tooltips.md)。
- 当前页以 `left` 或 `right` 写入本机 `localStorage` 的工作区键，重启和切回工作区都恢复上次页。没有有效本机值时读取旧配置的 `hDock`（`terminal` 对应左页，`git` 对应右页）。VS 关闭或专注时以左页计算视觉位置，专注保留进入前的页位。手机表面走 `MobileApp`。详见 [ui-state-persistence.md](ui-state-persistence.md) §1.1。
- 关闭时：工作页（会话+终端）吃满视口；Git 页宽 0，分割条贴右缘，仍可再打开。
- [专注模式](focus-mode.md)让会话和 Git 页并肩占满工作面，暂时隐藏虚拟屏的露条和切页效果。把手菜单的「关闭虚拟屏」进入双栏布局，右栏开关重新展开时可恢复该布局。选择点击或悬浮切屏会启用虚拟屏，优先恢复进入双栏布局前的页位和占比。`test/e2e/virtual-screen-controls.spec.ts` 覆盖折叠再展开右栏、调宽和重新加载后选择切屏方式。

### 2.2 Git 面板（`GitPanel`，`active={hDock === 'git'}`）

未选中的 Git 与轮次审阅标签保持挂载，但面板入口通过默认浅比较跳过未变化的父级切屏更新。`GitPanelCore` 仍转发原 ref，真实工作区/根版本 Context 更新会重建原作用域；审阅面板的激活和 owner/内容更新仍执行原加载流程，不冻结隐藏期间的新状态。

```text
Git = [仓库列表 | 分支条 + Changes | Diff + Commit]
```

- 按显式工作区的全部登记源根发现 `.git`（含嵌套独立仓，如 `Plugins/*`），首次和手动刷新扫描，普通刷新复用拓扑；当前任务的全部登记 worktree 按需补充。主进程 `simple-git` 调本机 `git`（并发限流 6 + single-flight + 引用稳定缓存，详见 [performance.md](performance.md)、[Git 仓库树](git-repo-tree.md)）。
- **自动刷新**：Git 页可见时订阅主进程 `fs:changed`，命中当前仓则防抖并按 **1.5s 最小间隔节流**刷新 `status`；Git 目录和空路径信号只普通刷新列表，不触发拓扑重扫。切回 Git 页 / 窗口聚焦立即刷，当前外置任务仓在可见且有焦点时轮询状态；Stage/Commit/远程操作成功后立即刷。离开 Git 页或失焦暂停；新增或修复仓库用手动刷新发现。
- **切屏保活**：切去会话页时保留 Git 当前页签、选中内容和滚动容器，停掉后台刷新并放弃过期响应。切回时先展示已读画面。工作区 Diff 按工作区、仓库、文件和暂存区匹配已读结果，刷新在后台进行。历史提交详情和 PR 评审草稿随面板保活。首次读取仍显示加载反馈，切换仓库或失去工作区授权时立即隔离原数据。
- **点击切仓即时响应**：选中/分支条先用仓库列表已有摘要**乐观垫上**（同帧切换），`status` 加载期间 Changes 区显示 shimmer 骨架，结果到达后校正；快速切换由 generation 计数防过期覆盖。
- 远程 Fetch/Pull/Push 走系统凭据，无 App 内登录。

Git 页内可拖动的横线和竖线在鼠标悬停或拖动时共用 `--resize-divider-active-width`（3px），包括 Changes 与 Staged 之间、历史列表与提交详情之间的横线。历史页的分界静息显示 1px。仅用键盘聚焦时，粗细为 1px，颜色使用 divider focus token。

Git 提交说明输入框的聚焦描边复用会话输入框的 `--input-focus-border`，与工作区列表中正在对话条目的高光颜色一致。

Git 变更、提交历史和独立 Diff 共用 `FileDiffView`：统一 Diff 将旧/新行号合并成一列，删除行显示旧行号，上下文与新增行显示新行号。超过 1500 个变更行时按 hunk 截断，只有确实隐藏了 hunk 才显示「展开剩余」；短 Diff 已全量显示，不出现无效展开按钮。全量分支必须把已用行数记为总数，避免把已显示的行再次计入剩余。`test/unit/diff-comment.spec.tsx` 覆盖短 Diff 无按钮、单列行号取值以及大 Diff 展开后行数与按钮状态。

### 2.2.1 窄屏抽屉

窄屏（≤820px）通过顶栏「会话」「面板」分别打开左右抽屉。`responsive.css` 解除 `h-strip` 的 transform/will-change、`ws-rail` 的 will-change 和 `ws-stage`/`work-area` 的层叠上下文，使 fixed 抽屉位于共享遮罩上方；仅解除 transform 仍会被 will-change 建立的层叠上下文阻挡点击。Git 抽屉工具栏允许分行，避免固定 480px 抽屉把跟随按钮和采纳操作挤成竖排。`test/unit/chrome-text-actions.spec.tsx` 验证左右入口回调；独立 Electron Review 在实际 780px 窗口打开抽屉，核对点击命中和原生勾选/采纳，不用强制点击。

`SplitPane` 用布局阶段测量和 ResizeObserver 跟踪实际轴长，两栏比例先扣除手柄占用的实际间距（默认 6px，右侧资源栏 4px，网页接缝叠放时为 0px）。左右拖动以手柄中心和抓取点计算比例，再按当前容器限制显示比例，容器放不下两侧像素最小值时按比例压缩最小值，避免嵌套 Diff 被挤到抽屉之外。缩放不回写用户偏好，扩宽后恢复已保存比例；拖动/键盘仍只在提交时落盘。`test/unit/split-pane-persist.spec.tsx` 覆盖窄容器、恢复、观察器释放和原提交语义。

### 2.3 Agent 悬浮

- **收起**（左下）：头像；仅当 `bubble.text` 非空时显示右侧汽泡。点击头像/汽泡展开。
- **展开**：左侧悬浮面板（默认约 520px 宽，聊天列上限 760px 居中；拖宽上限 900px），含完整聊天；点面板外空白收起。面板根挂在虚拟屏胶片层内，始终绑定左侧工作页并随其横向切页移动；切到右侧 Git/文件页时面板随左侧工作页移出视口，同时移除全屏磨砂遮罩，避免遮挡文件内容。展开态面板**出现在左栏右侧，左下角与中栏会话面板卡片完全重合**：锚点行距归零（左缘=左栏列右缘 leftW）、bottom=--frame-gap（与 ws-stage 底内收同值=卡片底缘），圆角与会话卡片共用 `--radius-page` 和 `--corner-shape-page`（2026-10-10 用户定稿，此前 12px/12px 各差一截）；默认高 520px，上限为视口高度的 2/3 与 100vh−48px 中较小者，空会话也使用该高度。用户拖拽保存的高度优先，并按当前视口限制。
- `busy` / 确认框 / 气泡 `confirm|error` → **自动展开**。
- 不占文档流；`z-index` 高于工作区条带。

---

## 3. 几何模型

视口 = `.main-view`（宽 `viewW`）。

| 区域 | 计算 |
|------|------|
| 会话列宽 | `clamp(viewW × 1/5, 200, 280)` |
| 工作页宽 | VS 开：`viewW × hTerminalRatio`（默认 7/8）；关：`viewW` |
| 工作页内终端 | `workspacePageW - leftW` |
| Git 页宽 | VS 开：`viewW × hGitRatio`（默认 2/3）；关：`0` |

```text
workspacePeekOnGit = viewW - gitPageW   // = viewW/3 when on git
hOffset = (hVs && hDock === 'git')
        ? -(workspacePageW - workspacePeekOnGit)
        : 0
```

终端主态时右侧 Git 露 `viewW × (1 - hTerminalRatio)`（默认 = `viewW/8`）；Git 主态时左侧工作页露 `viewW × (1 - hGitRatio)`（默认 = `viewW/3`）。

条带在 `.work-area`（宽 = `viewW`）内横向裁切，用 `translateX` 平移。

注意：`overflow: hidden` 仍可能被焦点 / `scrollIntoView` 改 `scrollLeft`，表现为**最左边被裁**而 transform 仍为 0。`.main-view` 和 `.work-area` 使用 `overflow-x: clip; overflow-y: visible`，保持非滚动容器，正常焦点与 `scrollIntoView` 不会卷走祖先。`virtualScreenScrollGuard.ts` 仅在祖先实际收到 scroll 事件时复位横向偏移；切页/尺寸变更后的 effect 只重新接线，不读取滚动几何，避免在刚提交布局时同步强制结算。内部会话/编辑器仍按自己的滚动规则工作。

---

## 4. DOM 架构

```text
.main-view
  ├─ .work-area
  │    └─ .h-strip  translateX(hOffset)
  │         ├─ .workspace-page → .sessions-column + .terminal-page
  │         ├─ .git-page → GitPanel
│         ├─ .pane-split-v
│         └─ .agent-float → AgentFloat（absolute，跟随当前虚拟屏）
```

原则：

1. 开/关 VS **不换**终端 DOM 树（保护 xterm WebGL）。
2. 会话列在工作页内，跟终端 / transform 一起动。
3. 分割条在 strip 内，跟 transform 一起动。
4. `.vs-axis` 用 `transform` 过渡，浏览器在过渡时提升合成层，静止时保留正文次像素抗锯齿。

普通切页仅更新本机页位键。启用或关闭虚拟屏、切换专注、修改占比等布局偏好仍由工作区配置 IPC 保存。原页位写盘导致的回读时序见 [性能架构 §28](performance.md#28-虚拟屏切换重读布局配置2026-11-12-现场诊断)。

---

## 5. 可调参数

| 常量 / 键 | 当前 | 作用 |
|-----------|------|------|
| `hTerminalRatio`（workspace.json） | `7/8`（夹紧 0.5~0.95） | 终端主态工作页宽；长按出钮左右拖跟手调 |
| `hGitRatio`（workspace.json） | `2/3`（夹紧 0.5~0.95） | 右侧主态页宽。拖动、读取旧工作区布局和工作区切换的过渡预览均使用此范围 |
| `muster.virtualScreenPage.v1:<workspaceId>`（localStorage） | `left` | 按工作区记忆 `left` / `right`；VS 关 / 专注时视觉位置取左页 |
| `STATIC_LEFT_W_RATIO` | `1/5` | 会话列目标比例 |
| `LEFT_W_MIN` / `LEFT_W_MAX` | 200 / 480 | 会话列夹紧（未拖过时自适应上限 `AUTO_LEFT_W_MAX`=280，手动拖宽可到 480） |
| `HOVER_SWITCH_MS` | 280 | 悬停切换延迟 |
| `HOVER_COOLDOWN_MS` | 300 | 切换冷却 |
| `muster.hSwitchMode` | `click` | 全局切屏方式，可从把手长按菜单改为 `hover` |
| 分割条检测带兼触发区 | 缝宽（`--page-gap`）× 全高；右栏收起时不显示 | 压线任意位置召出按钮（旧中段胶囊触发区已删） |
| CSS transition | 0.42s | 平移手感 |
| Agent 展开宽 | 520px（`min(520px, 100vw − 80px)`） | `.agent-float.is-expanded`（styles/float.css） |

改动画时长须同步 `TerminalView` 的 fit 重试节奏。

---

## 6. 设计原则

1. 邻屏 peek 可切回：悬停驻留（`hover` 模式）或点击，两者都算用户意图。  
2. 同树平移，不拆终端树。  
3. 会话与终端同页滑动。  
4. 调度需要注意时自动展开 Agent。  

---

## 7. 相关文件

| 文件 | 职责 |
|------|------|
| `App.tsx` | 几何、VS 开关、切页、`hDock` |
| `virtualScreenPagePreference.ts` | 本机页位存储、旧值兼容及存储失败时的内存页位 |
| `SplitExpandControl.tsx` | 把手显隐、长按和键盘菜单、纵向拖选与横向调宽 |
| `styles/base.css`（由 `styles.css` 导入） | `.h-strip` / `.workspace-page` / 两页间隔、圆角与分割条布局 |
| `styles/agent-chat.css` | 中栏会话聊天列 760px 上限居中 |
| `TerminalView.tsx` | xterm；VS 动画后 fit |
| `AgentFloat.tsx` | 调度悬浮层 |
| `gitpanel/`（GitPanel 拆分，入口 `panels/GitPanel.tsx` 垫片） | Git UI |
| `main/git/` | 扫描仓、`simple-git` 操作 |

## 工作面轮廓

会话与右侧页共用 elevation-sheet 投影，内容上方的伪元素用 surface-rim 绘制完整四边并继承圆角，避免上下亮线在角部中断。保留原框距与窄屏右抽屉豁免，见 [表面悬浮层级](surface-elevation.md)。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D07.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：主区横向虚拟屏服务「（会话+终端）↔ Git」两页 peek/平移——工作页常驻左、Git/浏览器/扩展页按需露条切页；Agent 调度对话是独立悬浮层，busy/确认自动展开。
- 为什么这样设计：条带沿同一 DOM 树平移，保留 xterm WebGL；点击表示显式切页，hover 启用驻留切页；把手提供长按菜单和拖动调宽；hDock/hTerminalRatio/hGitRatio 按工作区落盘，专注期间保留原值。
- 明确不做：不做递归/多格分屏（中栏内部归 center-split）；关闭 VS 不销毁 Git 页（宽 0 可再开）；窄屏不走此机制（抽屉系统接管）；扩展 iframe 吞指针区用透明手势层切屏、不做常驻拦截。
- 歧义点：VS（两页 peek/pan 轴）与中央分屏（三槽 Snap）双体系并存——A=长期分工锁定（VS 管工作页↔Git 轴、center-split 管中栏内部多格；review 不把两套布局交互/快捷键并存当缺陷）／B=路线图收敛为一套布局模型（review 要把 affordance 重复、快捷键分叉当审查重点并推动统一）。推荐 A——两者层级不同（工作面外轴 vs 中栏内格），center-split 文档已按分工引用 Ctrl+Shift+\；收敛属大改版，等真实痛点。
