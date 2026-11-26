# 菜单与悬浮提示体系

功能职责：全应用所有「鼠标悬浮/右键/点击弹出的菜单与提示」的盘点与实现方式地图。用于评估哪些还在用原生控件、哪些内容/排版需要统一。

## 总体结论

- **应用菜单为空、窗口内右键全自绘**：`Menu.setApplicationMenu(null)`（src/main/index.ts:463），主进程无 `Menu.popup`。唯一原生菜单是系统托盘（`src/main/tray.ts`：`Menu.buildFromTemplate` + `Tray`，index.ts:538 挂载，2026-09-15 起，详见 [tray.md](tray.md)）。右键菜单、动作弹层、划词浮条、扩展 `ui.menu` 自绘；表单下拉采用主题化可定制原生 picker，详见下文 CustomSelect。
- **原生 title 提示已全局接管（2026-08-29）**：`components/Tooltip.tsx` 的 `TooltipHost` 在 App 根挂载一次，委托监听全窗口 mouseover/focusin——悬停时摘掉元素的 `title`（原生浏览器气泡不再触发）、350ms 后由主题化浮层展示，移出归还属性；支持 `\n` 多行（pre-line）、点击/滚动/右键即隐、键盘聚焦 80ms。Esc 隐藏已显示的提示或取消延时，继续抑制原生气泡直至离开触发器。焦点原地保留，Esc 继续传给上层快捷键或当前控件。样式 `.app-tooltip`（dialogs.css，L3 底 + `--z-tooltip: 250`），进出场走 mp-pop 骨架：`usePresenceValue` 保留最后一份提示，移出后原地淡出（`--dur-micro`）再卸载（2026-09-28 前退场阶段直接不渲染、退场从不播放）。**热身**：因指针移出而隐藏后 300ms（`WARM_WINDOW_MS`）内悬停到新目标，0 延迟出现并挂 `.is-instant`（无入场过渡、直接换位换字）——扫过工具栏一排按钮不必每个都等 350ms；点击/滚动/右键/拖拽/Esc 打断的隐藏不开热身。`test/unit/tooltip-presence.spec.tsx` 守。全渲染层约 200 处 `title=` 无需逐点改造即生效。
- **嵌套 title 双提示（2026-08-31 修净）**：外层容器（看板卡/轨迹泳道行）和内层子元素（快捷按钮/泳道段）都带 title 时有两处会双提示同屏，均已修——①同宿主内移动先取 `closest('[title]')`，内层存在即摘除接管切内层文案；②`track()` 切换目标时**不归还嵌套在旧宿主内时的外层 title**（指针仍在外层内，归还会让原生提示沿祖先链找到外层 title，与主题化内层提示同屏）。
- **title 内容准则（2026-08-29 精简定稿）**：只保留四类——①截断展开全文（路径/名称/提交信息）；②快捷键（含 chord 的按钮）；③教学与后果（冲突处理、中断「无响应再右键重启」、拖拽调大小、信任状态等多行说明）；④相对时间 hover 绝对时间。删除两类：按钮可见文字的复述（Stage All 上的「全部暂存」之类）、通用图标的自明标注（关闭 ✕/刷新/搜索/＋/缩放/铅笔/图钉/发送）。icon-only 按钮删 title 时文案转 `aria-label` 保无障碍。
- 右键菜单统一走 `ContextMenu` 组件（components/ContextMenu.tsx：portal 到 body、mp-pop 入场、键盘导航；条目支持 label/danger/disabled/**checked 勾选态**/**separator 分隔线**）。可选 `excludeCloseRef` 把触发器排除出点外关闭（避免 pointerdown 先关、click 再开），`onHoverEnter/Leave` + `hold` 供悬停预览。`.ctx-menu` 的 z-index 为 `calc(var(--z-menu) + 1)`，压过全局看板同档 overlay；灰置项用 `aria-disabled`（原生 `disabled` 会让点击穿透）。
- 子菜单悬停预览保留当前焦点，显式进入时焦点移到第一个可用子项，上下循环跳过灰置项，父项转为灰置时也禁止以右方向键进入。子菜单聚焦时，左方向键或 Esc 收起该层并将焦点还给父项，再按 Esc 关闭主菜单。键盘和鼠标回归见 `test/unit/context-menu-flyout.spec.tsx`。
- 扩展面板是沙箱 iframe，宿主通过 aria-label 提供面板名称，鼠标移入面板时不弹出名称提示。其内部右键/悬浮行为由扩展页面自己决定，宿主不管控（Tooltip 也不跨 iframe）。
- 自绘菜单、Tooltip 与弹窗统一使用 `surface-overlay` 及对应前景，不在各域再次混色。`aria-disabled` 与原生 disabled 都使用显式禁用文字；hover 与键盘 active 填充同时排除两种禁用态，danger 禁用项也回落到禁用前景。状态提示使用成对的共享 fg/bg/border；声明回归在 `test/color-surfaces-css.mjs`，事件与 z-index 契约不变。

来自原生选择器或任务输入框浮层的工具提示使用手动 popover，确保权限说明在对应菜单上方可见。

## 右键菜单（自绘 ContextMenu）

| # | 位置 | 条目（按显示顺序） | 备注 |
|---|------|--------------------|------|
| 1 | 左栏会话行（LeftPanel.tsx） | 重命名 / 置顶⇄取消置顶 / 标记完成⇄取消完成标记（条件：未归档 agent 会话且非 model 已判 done）/ 归档⇄取消归档 / 查看证据 / 重启 / 带上下文续作（条件：有 interruptSnapshot）/ 绑定飞书（条件）/ 清理 worktree（条件，3 种文案按 unmerged/dirty/其它）/ 删除（仅已归档，danger） | 会话操作最全入口。行右键是完整菜单的入口；行内悬浮钮仅归档（已归档项可取消归档）。续作等其他操作保留在右键菜单 |
| 2 | 看板卡片（BoardPanel.tsx） | 重命名 / 置顶⇄ / 挂接任务 / 标记完成（条件）/ 归档 / 标记已处理（需要你列）/ 查看证据 / 重启 / 清理 worktree（条件）/ 删除（条件）；自由视图额外「添加/编辑/清除备注」 | 与左栏同口径；卡片底部另有按状态的常显动作，不含「标记已处理」 |
| 2b | 自由画布拉线落空白（FreeCanvas.tsx） | Fork / 交接 / 思路便签 | 点击弹出（非右键）；cursor-cli/opencode 的 Fork/交接灰置，title「该类型暂不支持」 |
| 2c | 会话网页链接、文件链接与附件（ChatLinkBoundary.tsx） | 内置/系统浏览器；文件为工作台/系统默认应用/文件管理器 | 链接右键优先于消息历史；网页访问端保留设备浏览器行为 |
| 3 | 文件树（FileTree.tsx ~495） | 在资源管理器中打开 / 删除（danger；根目录无删除） | 仅 2 项 |
| 4 | Git 变更树文件/目录/多选（gitpanel/useGitActions.ts `changeCtxItems`，GitPanelOverlays.tsx 渲染） | Stage（未暂存区）或 Unstage（已暂存区）/ 在资源管理器中打开 / 丢弃（danger，走 AppConfirmDialog） | 中英混排 |
| 5 | Git 仓库列表·眼睛按钮（gitpanel/GitPanelOverlays.tsx，按钮在 RepoListPane.tsx） | 全部取消隐藏 / 只显示隐藏的（✓ 前缀表当前态） | 用字符 ✓ 表选中态 |
| 6 | 终端（TerminalView.tsx） | 右键由 CLI / 系统处理；识屏从工作台胶囊或普通终端识屏胶囊进入 | 识别规则见 [text-entity-recognition.md](text-entity-recognition.md)（localhost URL 映射本地文件、引号/空格路径、UNC、中文边界） |

## 悬浮 ghost 按钮（自绘图标 + 原生 title 提示）

| 位置 | 悬浮动作 | title |
|------|----------|-------|
| 左栏会话行（LeftPanel） | 归档（相对时间槽位上叠；已归档项为取消归档） | 悬浮行或键盘聚焦显示归档图标，点击复用 sessionArchiveFlow，不选中会话、不打开更多菜单。完整操作只通过行右键触发；回归 `test/unit/session-more-menu.spec.tsx` |
| Git 仓库行（gitpanel/GitRepoRows.tsx） | ×从列表移除 / 隐藏⇄显示 / 置顶⇄ | 图标用 IconEye/IconPin 组件 |
| 看板卡片（BoardCard ~83） | 重新拉起 | 「重新拉起（resume 该会话）」 |
| AgentFloat 历史会话行（~1405） | 重命名 / 删除；行点击跳转 | |
| 消息气泡（ChatMessageView ~351） | 复制内容 / 从这里分叉出新会话 | |

## 全局操作轻提示

`src/renderer/src/tips.ts` 提供 `showTip(text, { tone?: 'info' | 'error', durationMs? })` 和 `dismissTip(id?)`。`main.tsx` 在启动等待前挂载单个 `AppTipHost`，主界面、启动失败页和局部崩溃兜底共用同一窗口宿主。提示在顶部居中，默认 3.5 秒自动消失。原生模态对话框打开时，新提示在该对话框内播报和显示。最新提示重置计时，旧计时不会关闭新提示。错误用浮层表面的危险色文字与描边。提示不占业务布局、不抢焦点、不拦截点击。常驻 `role=status` 区域负责礼貌播报，进出场走 `usePresenceValue` / `mp-pop` 和动画 token。

事件处理器可调用 `showTip`。组件已持有失败状态时，用无 DOM 输出的 `ErrorTip` 发布已提交的错误，保活界面在隐藏和显示之间保留已播记录。错误清除后再次发生可以重报。Git、文件、会话、任务、设置、扩展和渠道的即时失败走此入口。历史记录用 `ErrorTipDetails` 显式点开旧错误。重试、阻塞条件、空态和结果摘要仍在各操作位置。Store 的 `flashTip` 转发到这里，无活动工作区也能显示。轻提示只保留最新一条，无持久化和排队。持续会话状态与系统通知走各自入口。

回归见 `test/unit/app-tip.spec.tsx`、`git-error-tip.spec.tsx`、`settings-save-feedback.spec.tsx`、`web-gateway-status-snapshot.spec.tsx` 及权限与原生设置相关组件用例。生产组件视觉夹具 `test/fixtures/permission-panel-visual.tsx` 和 `permission-panel-scenario.mjs` 覆盖 Core 与外部 Harness 的提示出现和消失。

## 点击展开的菜单/弹层（全部自绘）

| 位置 | 内容 |
|------|------|
| 顶栏扩展动作（ChromeBar） | 直接按钮 + 溢出 ⋯ 菜单 + 扩展子菜单（▸）；按钮 title 拼接「（首次运行需确认）（有子菜单）」 |
| 顶栏工作区下拉（ChromeBar） | 工作区列表（当前徽标）/ 打开工作区… / 工作区设置… / Dev 沙箱项 |
| 调度并排对话 | 圆点悬浮展开状态色条，顶栏漏斗打开可多选的状态筛选与类型编辑弹层。色条和弹层复用 mp-pop，Esc 先关闭当前层 |
| 全局看板 | 漏斗弹层分组多选工作区和面板，保留当前工作区与全选快捷动作。和调度并排筛选共用 `FilterCheckbox`、状态圆点及浮层材质 |
| Composer + 面板 | 添加图片 / 引用文件 / 命令（/技能）；/ 斜杠命令面板（本地命令 + skills） |
| GitPanel 排序菜单 | 名称 / 最近修改 / 未提交变动 |
| Git 分支弹层（GitBranchPopover） | 分支切换 / 在选中分支上新建 worktree / 刷新 |
| 划词浮条（SelectionBar） | 复制 / 搜索 / 发给 Agent / 爆炸 / 打开链接 / 资源管理器 / 在文件区预览 / 粘贴 / 动态文本工具；路径/链接判定与含空格路径的 stat 回退见 [text-entity-recognition.md](text-entity-recognition.md)。关闭=外点 mousedown / 非修饰键 / 右键；滚动与 selectionchange 保留菜单状态，DOM 源按视口及祖先 overflow 裁切后的可见选区重锚定，并通过浏览器命中排除输入框等覆盖层（忽略浮条自身）。没有可见片段时暂隐且禁交互，滚回后恢复，原选区与文本不清除；多行选区优先末个可见片段。暂隐接入 `usePresence` / `mp-pop`，几何不可见时立即设 visibility，避免退场阶段继续压住输入框。选区因刷新塌掉时保持此前状态（`syncSelectionMenuToLiveSelection`）。浮条根挂 `data-overlay-root`，看板等点外关闭走 `isInsideOverlay`（见 [keybindings.md](keybindings.md) 弹出层；调度面板已不点外关闭） |
| 扩展/调度 `ui.menu`（ExtensionUiDialog） | 调用方传入 items，自绘弹窗渲染 |
| CustomSelect / QuickOpen | 新增下拉统一复用 CustomSelect（可定制原生 picker + 主题回退）/ 快速打开 |

新建任务与会话模型选择器共用 `ModelPickerLayout` 分列和参数控件，搜索框聚焦只强调底部分隔线。会话弹层在工作台内 portal 到 `.h-strip`，用视口边缘做避让，坐标换算到胶片，随虚拟屏移动并沿用 `mp-pop` 退场。没有虚拟屏祖先的独立表面使用 body portal。窗口、输入条尺寸及滚动变化仍会触发重新定位，保活会话失去交互时隐藏并关闭。模型目录仅在用户手动刷新时重读（启动初始化除外）。

属于虚拟屏的临时浮层按触发器实际所在的 DOM 页观察 `data-h-peek`。会话、文件、Git、标签页、收藏、聊天链接等共用菜单及子菜单、扩展导航菜单、常用入口菜单和划词浮条在窗口内做边缘避让，然后使用条带内坐标。悬停切页和点击露条切页都让这些浮层随条带移动，退场完成后卸载。点同页空白或按 Esc 沿用菜单自身的关闭逻辑。划词浮条兼容 DOM、终端和 iframe 选区，切屏退场时保留选区。调度聊天中的触发器归左页。原生及回退 `CustomSelect` 和会话详情在来源页退到露条时关闭。全局看板使用窗口级菜单。Electron 回归验证菜单尚可见时的横向位移与条带一致，覆盖悬停和点击切页。

`CustomSelect` 保持原 props 接口，优先使用 `appearance: base-select` + `::picker(select)`；选项为原生 option/optgroup，禁用项由浏览器跳过，方向键/Home/End/文字查找、当前项滚入可见区、点外关闭与 Esc 由浏览器负责。收起态仍只显示标签/图标/徽章，展开态保留分组、说明、紧凑说明提示与禁用项。说明通过 aria-describedby 关联，不混入选项名称；徽章和装饰图标不参与命名。缺失 value 显示禁用的隐藏 placeholder，不静默选第一项；显式重选同值仍回调，支持根目录重定位后的确认路径。

可选 `onOpen` 在 picker 打开时启动按需读取。Git 工具栏的 Worktree 选择器借此获取仓库登记检出，等待读取时显示禁用的状态选项。可选 `triggerLabel` 固定按钮文案，菜单仍按所选值标记当前项。原生与主题回退共享两项行为。

现代 picker 在 top layer，使用浏览器 anchor 定位和翻转，路径菜单宽度取 anchor-size(width) 并换行，视口约束和 overflow:auto 保证长列表可达。它不再使用 body portal/手算几何/z-index。`menuClassName` 仍为公开接口，内部将该类附在 select，样式通过 `::picker(select)` 定义菜单尺寸，不能误把菜单宽度写到触发器。Tab/Shift+Tab 在浏览器关闭 picker 后继续原表单顺序；KeybindingHost 在原生 picker 打开时把 Esc 留给浏览器，避免顺带关闭父弹窗。menuEnabled/disabled 变为不可用时由 React 替换 select 节点关闭浏览器 picker；程序化 overlay.close 同样替换并恢复焦点，不依赖不存在的 hidePicker API。宿主确认弹窗显式取走焦点时也关闭旧 picker，但不抢回确认焦点；选项导航中的临时 body 焦点不能触发该关闭。

React 18 尚未识别富内容 select 的 DOM 嵌套：公共组件只通过 DOM API 创建 button/span 内容宿主，再用 React portal 渲染内容，不拼接 HTML、不复制内容 ID。升级 React 后可移除这一兼容桥。桌面目标是随应用分发的 Chromium；实际特性检测同时检查 appearance 与 picker 选择器。不支持新能力的浏览器使用 `CustomSelectFallback.tsx`，保留原 usePresence、body portal、已选项/键盘项滚入视野、aria-controls、快速重开 inert 处理和多行实高定位，不降级到系统默认样式。

紧凑说明沿用 TooltipHost；只有来自原生 picker 的提示使用 manual popover 提升到 top layer，仍用既有主题、定位、presence 和 Escape 隐藏。普通提示继续走原 portal。

验证：`custom-select-native.spec.tsx` 检查现代分支接线、禁用/缺失值/重选/父层 Esc 和回退选择；`custom-select.spec.tsx` 继续检查旧浏览器分支。`custom-select-native.tsx` + `custom-select-native-scenario.mjs` 使用生产组件/CSS 做真实键鼠、分组、长列表、富内容、提示层级、底部长路径和减少动态效果验证；jsdom 的 change 仅证明 React 接线，不替代浏览器交互验收。

自绘回退层级：壳层确认 `.app-confirm-mask` 使用 `calc(var(--z-confirm) + 2)`，高于 body portal 的新建/编辑弹窗（`--z-confirm`）及 CustomSelect（`+1`）。同档时后插入 body 的新建任务会遮住 App 内的确认层，造成按钮看得见却不能点击；`test/e2e/worker-availability.spec.ts` 在新建表单保持打开时实际确认 Worker 修改，核对层级及真实鼠标命中，不用强制 click 或程序代答。

壳层 `ConfirmDialog` 每次接到新请求 ID 都将焦点移到取消或拒绝，若请求只提供批准选项则聚焦关闭按钮。队列替换会复用在场 DOM 和动画阶段。`test/unit/confirm-dialog.spec.tsx` 验证旧批准按钮聚焦时，下一请求仍以取消开场。

业务渲染目录不得直接创建原生 select；`test/capability-ui-controls.mjs` 用 TS AST 仅允许 `CustomSelect.tsx` 内的一个原生控件，并检查双端 base-select 样式与主题回退。独立 iframe 内容仍不在此检查范围。组件测试可模拟 native change 验证受控数据；浏览器/Electron 验收必须展开 picker 并真实点击或按键选择。原生路径触发器的可访问角色为 combobox，回退路径为 button/listbox，调用方浏览器测试应按实际语义定位。

## 原生 title 密集区（即「还在用原生」清单）

精简后约 200 处（2026-08-29 删 35 处冗余/自明标注，见总体结论「内容准则」）。存量集中在：GitPanel、LeftPanel、AgentFloat、ModelProviderPane、FileEditor、ExtensionReviewBody、AgentComposer。三类用途：
1. **动作提示**：icon 按钮说明（工具栏/面板头/编辑器/设置；通用图标已删，语义图与快捷键类保留）；
2. **信息提示**：时间戳、绝对路径、图表数值（UsageStatsPanel）、徽章解释（ExtensionsManagerPanel）、状态胶囊 summary；
3. **多行说明**：`\n` 拼接（如 AgentFloat 会话 title、ChromeBar 沙箱徽章）。

## 已知不合理点（2026-08-29 盘点）

1. ~~Git 变更右键 `Stage`/`Unstage` 英文~~ → 已改「暂存 / 取消暂存」。
2. ~~左栏 vs 看板的会话右键条目不对齐~~ → 看板已补「重命名 / 置顶」（重命名为卡片内联输入，同左栏交互）。
3. ~~中断 title 与重启菜单文案不同源~~ → 已统一为「无响应再右键重启」。
4. 文件树右键仅 2 项——**有意设计**：文件目录定位是只读视图，不做编辑能力。
5. ~~图标组件与文字字形混用~~ → 新增 IconRefresh/IconSort/IconMore，替换 ⇅ ↻ ⋯ ×（弹窗关闭 × 是另一套自洽体系，未动）。
6. ~~ContextMenu 不支持分隔线/勾选态~~ → 已支持 `separator` / `checked`（眼睛菜单改用勾选态）。
7. ~~原生 title 脱离主题控制~~ → TooltipHost 全局接管（见总体结论）。

## 边界

- 全局 Tooltip 测量锚点和实际提示尺寸，优先上方居中，上方空间不足则下方；上下都放不下才选左右侧（优先向窗口内部，必要时翻到另一侧），最后平移回视口 8px 安全边距。提示与锚点间距 6px；宽度最多 360px 且不超过视口宽度减 16px，窄窗口长文换行后再判方向。所有接管的 title 共用此规则，无需逐按钮指定坐标；`test/unit/tooltip-placement.spec.tsx` 守工具栏同排避让、键盘聚焦、四边与多行几何。此策略减少横向工具栏遮挡，不识别正文重要性，空间不足时仍可能覆盖内容。
- Electron 不弹默认右键菜单，未处理区域右键无任何反应（非 bug）。
- Tooltip 测量使用 `offsetWidth/offsetHeight`，不使用受 mp-pop scale 影响的提示 `getBoundingClientRect`；否则入场/退场反转结束后真实尺寸变大，会吞掉锚点间距和边缘留白。Chromium 定向夹具 `test/fixtures/tooltip-placement.tsx` 与 `tooltip-placement-scenario.mjs` 使用生产组件/样式、真实悬停，覆盖深浅主题、780/320px、上下翻转与长文边界；通过 ui-verification 的 `capture-component.mjs --fixture test/fixtures/tooltip-placement.tsx --scenario test/fixtures/tooltip-placement-scenario.mjs --target main --styles base,dialogs --out .tmp/tooltip-placement/captures --themes dark,light --widths 780,320 --height 600` 复验。
- `window.confirm/alert/prompt` 全仓未使用，确认统一走 AppConfirmDialog。
- 划词浮条 **xterm 源**没有 DOM Range，滚动时不重锚定（原位保留）；中间会话区自动滚动不再误关。终端自身滚走选区后浮条可能暂时错位，再划一次即可。
- DOM 划词可见性回归：`test/unit/selection-menu-host.spec.tsx` 覆盖视口四边、嵌套裁切、多行片段、输入框遮挡、恢复与明确关闭；`test/fixtures/selection-visibility.tsx` / `selection-visibility-scenario.mjs` 使用生产宿主与浮条、真实鼠标划选和滚轮，在 Chromium 深浅主题及宽窄布局验证。命中按每个裁切矩形的中线三个采样点判断，不作逐像素遮挡计算；xterm 不消费此 DOM 判定。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D07.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：全应用右键/悬浮/点击弹层的盘点地图：应用菜单为空、窗口内全自绘（ContextMenu/mp-pop/键盘导航/勾选分隔线），唯一原生菜单是托盘；原生 title 全局接管为主题化 Tooltip。
- 为什么这样设计：TooltipHost 根挂载委托全窗口 mouseover/focusin（约 200 处 title 零改造生效），摘属性防原生气泡、350ms+300ms 热身窗口（扫过工具栏不逐个等待）；title 内容四类准则（截断全文/快捷键/教学后果/相对时间）删自明标注；portal 浮层点外关闭统一 data-overlay-root + isInsideOverlay（不再逐面板 closest 清单）；灰置项 aria-disabled（原生 disabled 会点击穿透）。
- 明确不做：不跨 iframe（扩展沙箱内自管）；文件树右键仅 2 项是有意设计（只读定位不做编辑）；未处理区域右键无反应（Electron 不弹默认菜单，非 bug）；confirm/alert/prompt 全仓不用，确认统一 AppConfirmDialog。
- 歧义点：无真决策（2026-08-29 盘点的七项不合理点已六修一标注有意设计；排版/层级契约有回归守卫）。
