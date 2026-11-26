# 中央区分屏与 Windows 式 Snap

内部面板桥可按经过工作区及布局身份核对的槽位或内容关闭中央分屏视图，并等待状态回读；它不会结束对应会话。活动文件或设置草稿未保存时拒绝，取消在途请求会使待确认的主选中切换失效。只剩一个非空视图时拒绝关闭；超时、目标变化或无法确认结果时返回未知。公开 `host.panel.close` 使用该桥。

内部中央焦点入口先核对目标和草稿，再经现有轴切换等待中央页可见，最后更新分屏逻辑焦点并聚焦可见槽容器，回读 `document.activeElement` 后才应答。中央页仍不可见、右侧抽屉遮挡、目标可能停靠右侧、设置模态打开或切换会遮住未保存设置时明确拒绝；请求关闭或布局、工作区、目标变化会阻止迟到的 DOM 焦点。该焦点属于工作台文档，不承诺把操作系统窗口带到前台。公开 `host.panel.focus` 使用该桥。

中央工作面支持终端/GUI 会话、内置工具与本地扩展导航入口，最多三个 pane 同显。每格顶部是**默认隐藏的悬停工具栏**：鼠标进入顶部 10px 热区后显示 36px 不透明 `--surface-chrome`，使用 chrome 配对文字/交互色，无模糊。离开后隐藏；键盘 focus-visible、菜单、指针捕获及 Snap 操作期间保持显示。DOM 保留以支持 Tab，隐藏时不接收指针；通过 `usePresence` 和 `mp-scrim` 使用现有 token 淡入淡出，粗指针设备保留常显入口。贴住会话面板外角的工具栏共用 `--radius-page` 与 `--corner-shape-page`。左侧为名称、规范运行状态、运行时和最近进展，正中为横向三点（⋯）独立拖动把手，右侧为会话查找、分屏布局和关闭（×）。中央三点保留菜单和拖动；关闭直接收起所在分屏，不结束会话进程，单屏工具关闭回到背后会话，只剩一个会话时隐藏关闭按钮（包括一个会话加空选择器），不提供无效入口；可正常关闭的单屏工具仍保留关闭。把手保留点击菜单、按住 400ms 打开 Snap、移动 ≥6px 拖动的手势；名称/状态区域只聚焦所属面板，独立操作按钮不启动拖动。拖动进入顶缘 Snap 条区时工具栏内容仅做透明度淡出让位，**原位保留、不改 transform/pointer-events**，避免被捕获元素移位导致 Chromium 提前结束手势。拖起真实内容后，可在 Windows 式 Snap 顶部条选择布局和落点。分屏与拖动只重排当前窗口中的内容；会话和沙箱 iframe 保留原 DOM 父节点，不创建新的系统窗口。

子代理面包屑中的层级标签随界面语言切换，会话名称仍显示用户原文；层级和导航身份不随语言变化。

扩展底栏不再提供左右停靠快捷项；分屏统一通过本页描述的拖动入口。扩展改在独立窗口或右侧标签页显示时，来源工作面保持当前槽位完整尺寸，显示位置与召回按钮；单屏下不再出现小浮窗。

切换中央内容时保留扩展 iframe。明确关闭中栏扩展面板时，工具层沿用退场动画并在结束后卸载 iframe，触发宿主面板释放。同一视图在右侧标签或中栏后台仍有引用时继续保活。

> 宿主面板工具实现中：内部 `panel:split-request` 复用分屏状态机，限制同工作区内 2–3 个可用会话与合法预设；先等待主选择确认，再检查工作区与活动编辑器未保存状态并提交布局。异步选择的会话 reveal 暂不切换虚拟屏轴，布局确认后才显式显示工作页；取消或失联时回报未知，不重试。公开 `host.panel.split` 使用该入口。真实 Electron 验证使用两个本地终端会话，不代表 AI Worker 或跨平台真机验收。

[右侧内容分屏](right-workspace-tabs.md#内容分屏)复用 Snap 预设、槽位落点计算、布局选择器与 `SnapDividers`。右侧用标签 ID 绑定自己的布局与焦点，中央仍由 `centerSplitStore` 管理。

## 网页式整屏显示

全屏生命周期由 `hooks/usePaneFullscreen.ts` 统一管理，中央槽位经 `useCenterPaneFullscreen.ts` 适配；[右侧标签页](right-workspace-tabs.md#标签页整屏显示)复用同一机制并分别保留原布局。

进出全屏会清除旧几何位置留下的顶栏悬停状态，不依赖浏览器补发 `pointerleave`。移到顶部仍可唤出工具栏，离开、移动到正文或点击正文后恢复隐藏；真实鼠标操作解除遗留的键盘驻留，但不强制搬移 DOM 焦点。跨文档的 `pointerout` 以及点击 iframe 后的窗口失焦也清除驻留。键盘进入全屏时保留工具栏，菜单、Snap 和指针捕获期间继续按原规则驻留。状态仍通过现有 `usePresence` / `mp-scrim` 退场。

所有受支持的非空中央内容（终端、GUI 会话、内置工具、设置、导航/扩展和有效文件视图）共享「全屏显示」菜单项与顶部图标。单屏、双屏和三屏均可进入。`hooks/useCenterPaneFullscreen.ts` 使用标准 HTML Fullscreen API，让当前显示器进入真正全屏；全屏对象是 `document.documentElement`，以保留挂在 body 的菜单、弹窗和提示。`styles/split.css` 临时隐藏应用标题栏、两侧栏和其他槽，当前槽占满屏幕。原分屏 store、比例、顺序和引用不改写、不持久化全屏状态；所有内容保持原 DOM 父节点，工具层临时隐藏时保活。

退出按钮、菜单「退出全屏」及 Esc 恢复原窗口与分屏；浏览器原生退出也按 `fullscreenchange` 回读。扩展/HTML iframe 经 `panelRelay.ts` 中继 Esc，宿主只接受当前可见中央 iframe 的真实来源窗口，隐藏或陌生来源不能退出全屏。进入期间或全屏中工作区、引用或布局变化会退出，迟到的进入回执立即回退。API 不可用或切换被拒绝时显示错误提示，保留当前布局。若页面已处于 document 全屏，则只切换面板展示，退出面板时保留原先的 document 全屏。

Windows、macOS、Linux 共用 Chromium 的 Fullscreen API，不执行平台专属窗口命令；Linux X11/Wayland 的窗口管理由 Electron/Chromium 处理。`test/center-pane-fullscreen-visual.mjs` 使用独立 Electron profile、生产 CenterPanel/store/CSS 和模拟 IPC/内容叶子，验证原生窗口全屏、整屏几何、深浅主题、iframe 父节点/草稿、窄窗口往返及 Esc；不读取真实工作区存储。Windows 已实机验证。无系统窗口焦点的 macOS 测试会话验证 Electron HTML 全屏事件和界面往返，并记录系统全屏验收未执行。有焦点的 macOS 会话和 Linux X11/Wayland 仍断言原生窗口状态。窗口管理器拒绝时，产品走同一错误提示。组件用例位于 `test/unit/center-split-panel.spec.tsx`，iframe 中继用例位于 `test/unit/panel-relay.spec.ts`。

内部 `panel:focus-center-request` 仅接受当前已确认显示的会话或工具引用，调用现有分屏焦点状态；引用不可见、布局待提交或工作区变化时拒绝，不创建会话也不猜测目标。公开 `host.panel.focus` 和 `host.panel.split` 使用这些入口。

## 绑定模型与支持范围

内部焦点、分屏及按槽关闭桥允许 `nav:` 扩展/导航引用：主进程验证调用者对导航源根的读取范围，绑定源根、选择代次、导航版本和完整节点；渲染端在切焦点或布局提交前核对相同快照，异步布局期间及主进程回执后再次检查。扩展在右侧标签或独立窗口时，中栏焦点守卫拒绝将占位面板当成扩展内容；未指定位置沿用中栏默认行为。关闭时也核验布局中保留的导航节点，身份变更时拒绝或报告未知。快照包含调用方读取范围外的中央导航时整体拒绝，避免暴露节点身份或把占用槽误报为空。这不覆盖所有内容类型；Windows Electron 已验证当前节点焦点、分屏及保留导航时关闭、过期版本被拒，以及独立窗口打开时拒绝聚焦中栏占位；其他平台尚未实机验证。

设置页可作为中栏工具内容保活；内部设置打开请求默认在后台准备，需要聚焦时使用现有分屏选择入口。活动文件有未保存内容时拒绝切换；设置草稿本身由模态和中栏共享。内部关闭复用分屏关闭流程，等待设置引用离开布局，不终止会话。该内部请求不等于已发布公共工具。

中栏后台视图以紧凑标签显示，打开时不切换虚拟屏或键盘焦点；用户选择标签后沿现有分屏选择流程显示同一实例，关闭标签释放后台视图。设置、四个内置工具、终端/GUI 会话、本地扩展及内部文件视图接入同一标签组件；已在中栏槽位显示的内容不重复出现在标签区，内容已停靠右侧时提示用户先移回。设置在模态打开或已停靠右侧时也不显示重复条目，关闭前重新检查工作区、分屏、右侧标签、待处理操作和设置草稿，不能安全关闭时保留实例并提示。后台引用有独立宿主生成 ID，并纳入工作区快照，关闭仅撤销后台引用，不结束会话或关闭其他用户视图；会话被归档、删除或转出工作区后后台引用不再显示和披露。内部代理聚焦绑定该引用、工作区和取消守卫，等待分屏选中及 DOM 焦点确认后才回执，迟到的已取消选择恢复原视图，包括原本为空的中栏。扩展引用同时绑定导航源根、选择代次、版本和完整节点；身份变化后拒绝操作，停靠右侧或独立窗口的扩展需由用户先移回中栏。保留已有 iframe，不创建重复实例。浏览器等内容的中栏放置尚未实现。`test/e2e/panel-snapshot.spec.ts` 在 Windows Electron 验证后台打开不抢焦点、文件聚焦、工作区切换往返、窄窗口、关闭后台引用及右栏接回同一编辑器，检查了深浅主题的常规与窄窗口截图；组件测试核对工具实例保活和取消回退；扩展 surface 保活与草稿保留的组件级覆盖见 `test/unit/extension-surface.spec.tsx`（原 Windows Electron 级验收 `test/e2e/extension-iframe.spec.ts` 已随扩展系统迁移移除）。工作区关闭的有限实测与清理边界见右侧统一多标签工作面；根配置变化及其他平台尚未实机验证。


`src/shared/centerSplit.ts` 定义 `SplitPaneRef`（session / utility / empty）、最多三个逻辑槽、Snap 预设、引用判等、归一化几何和拖拽负载。`SplitNode` 的二叉树 API 保留给原有两侧入口；正式工作面使用固定槽与共享预设（选择条展示五个：「左宽右窄」已从选择条移除、模型保留供旧工作区还原），没有递归分屏 UI。

文件引用使用 `center-file:<id>`，只有调用方提供当前工作区、会话已验证的文件实例 ID 集合时，分屏支持判定才接受；失效 ID 均拒绝。`panelFilesCurrent` 对实例 ID、内容、Pin 和中栏归属做逐项身份核验，并拒绝缺失、重复或读取失败；渲染端焦点、分屏和关闭桥在执行前及异步执行期间检查该身份，变化后报告未知。主进程从经范围校验的快照提取文件身份随请求传递，并拒绝将用户固定的文件移出右栏。文件打开复用右侧文件实例，经受控宿主显示；关闭后台引用时若文件仍在槽内则保留宿主，离开槽后安全归还，失败时保留引用并提示。工作区关闭经预检和事务清理；未经预检的窗口生命周期仍需验证。

主进程快照校验中栏文件清单的工作区文件引用、真实路径及调用者读范围；缺少绑定、重复标识或路径逃逸使整个快照拒绝。焦点、分屏、关闭及后台引用动作在内部桥传递该身份；文件打开和渲染经公开 `host.panel` 入口使用。

`centerSplitStore.ts` 持有 `open`、`secondary`、可选 `tertiary`、`layoutId`、`order`、`dir`、`ratio`、三槽可选 `ratios`、`focused` 和可选 `pendingLayout`：

- **pane0 来自 App 当前选中**：工具层优先，其次 `displayActiveId` 会话；App 是主选中的唯一权威。
- **pane1/pane2 来自 store.secondary/tertiary**：会话被关/归档、导航被删或扩展失效后，`pruneCenterSplit` 把相应非主槽降为空选择器，保留布局。
- **逻辑引用与物理落点分离**：`order[logicalSlot]` 是该内容所在的物理格。`focused`、内部导航和关闭回调仍使用逻辑槽号 `0 | 1 | 2`。把主内容放到右侧或第三列只改几何映射，不把该物理格变成新的 App 主选中。
- App 通过 `attachCenterSplitBridge` 注入主选中/背后会话读取、选择、可分屏/可导航判定、工作区 scope 和偏好读写。会话选择调用 `jumpToSession` 并返回 Promise；失败在 App 提示，保留原工具主侧并撤销待提交几何。`getPrimary` 读取真实存在的当前引用，包含 scheduled；`supportsRef` 再判断它能否分屏，快捷键继续用受支持的主侧解析。

`centerSplitSupport.ts` 统一入口和显示的支持判定：`type === 'terminal'` 的终端/GUI 会话、四个内置工具、存在且非 web 的导航节点、已启用且有面板的扩展，以及空选择器。scheduled 的 ServiceView 不支持分屏，快捷键和 store 入口均过滤；外部主选中切到不支持内容时解散分屏，恢复正常主视图。

所有入口使用 `samePaneRef` 去重。单屏把自己再次分屏不产生副本；列表选择已经显示的任意内容只聚焦已有逻辑槽。外部导航或归档回退使主侧变成原非主槽时，App 在 `useLayoutEffect` 中调用 `centerSplitReconcilePrimary`，把重复的非主槽降为空选择器。文件夹内部导航和 Snap 空格填充调用 `centerSplitSelectInPane(slot, ref)`，目标绑定所属槽位。

### Snap 预设

`CENTER_SNAP_LAYOUTS` 是预设和小格命中的唯一来源，cell 使用 `x/y/width/height` 归一化矩形：

| ID | 布局 | 容量 |
|---|---|---|
| `halves` | 左右均分 | 2 |
| `wide` | 左宽右窄，2:1 | 2 |
| `stack` | 上下均分 | 2 |
| `focus` | 左侧一半，右侧上下两格 | 3 |
| `thirds` | 三列均分 | 3 |

Snap 重排保留所有已显示的非空引用。三个内容已占用时，两格预设全部禁用，侧边两格快捷落点也无候选；不会用较小布局丢弃另一项。空余格补 `empty`，落位后显示 Snap Assist 选择器。小格仅显示已有引用的类型图标与名称 tooltip，不复制会话正文；同预设尚未选落点时，源图标沿原物理顺序显示。

### 空分屏内容选择器

`components/SplitContentPicker.tsx` 承载搜索与创建。CenterPanel 只提供当前工作区未归档的会话/终端，排除已经显示在任一分屏中的引用；原有受支持工具入口保留。搜索按名称忽略大小写、去掉首尾空白实时过滤，顶部搜索及创建入口固定，列表独立滚动，空结果也可创建。新建会话/终端使用相同的普通按钮；终端按钮打开独立「选择 Shell」对话框，列出本机Shell档位，选择即创建。弹层复用现有对话框样式及usePresence，支持Esc/背景/取消关闭、Tab焦点循环和关闭后归还触发器焦点。

两个创建按钮均使用正文色与相同控件样式，禁用态跟随统一控件。列表固定保留8px滚动轨道并向右外置，卡片与搜索框左右边缘一致，过滤成短列表后不改变宽度。

「新建会话」复用 NewTaskDialog（任务/空白会话、运行方式、源目录和隔离配置）；「新建终端」选择本机 Shell 档位，在当前工作区默认源目录创建。会话创建 IPC 透传 `activate:false`，派活 IPC 透传 `select:false`，默认调用方行为保持原样。此行为要求主进程与渲染层一并更新：旧安装版IPC会丢弃这两个字段，导致新建抢占主侧；仅刷新渲染层无法生效。创建成功等待 sessions 推送进入 store 后，再用 `centerSplitSelectInPane` 填入所属空槽，不替换另一侧主会话。选择器以工作区及槽位作为 key，槽位填充/关闭或切区后忽略迟到创建回执；已创建会话保留在原工作区。排队任务尚无 session 时继续由原新建弹窗显示排队信息，不预占空槽。

### 候选布局与异步提交

`deriveCenterSplitSnapLayout(primary, state, sourceSlot, target)` 是正式 Snap 的纯候选函数，`target` 为 `{ layoutId, index }`。候选包含全部逻辑 `panes`、逻辑到物理 `order`、焦点、原引用 `original`、原布局 `originalState` 和工作区 `selectionScope`。源引用放到所选格，其余引用保留并尽量沿原位置排列。无落点、源为空、容量不足或重复引用时返回 null。

`centerSplitCommitSnapLayout` 同时校验原引用、开合/布局/比例/顺序与工作区 scope；拖动途中任何来源或布局已变时，旧候选不能提交。侧栏来源使用 `deriveCenterSplitIncomingSnapLayout` / `centerSplitCommitIncomingSnapLayout`：共享 Snap 几何与提交校验，新来源只加入一次，保留全部已显示非空引用；已有来源只重排，空余位置仍为选择器。容量不足的预设禁用，来源失效时拒绝提交。`deriveCenterSplitDockLayout` / `centerSplitCommitDockLayout` 仍为原有两侧方向入口保留，不能代替三槽 Snap 模型。

需要切换主选中时，store 先发布 `pendingLayout`，保留已确认的非主槽、方向和比例。CenterPanel 仅当候选有至少两个槽、当前非空引用与候选为同一组时，按引用身份映射现有节点的候选几何；空选择器逐个映射候选空位，避免与晋升的主内容重叠。涉及新引用的未确认选择继续呈现已提交几何。异步闭合发布 `panes: [target]` 的单屏 marker，保持确认前几何，同时取消旧拖动并锁定分隔条、提起和布局选择入口；比例与换向操作在已请求闭合时不落盘。App 在绘制前确认新主选中后，一次更新其余槽、布局、顺序、焦点并清除 pending，同时提交偏好。拒绝、关闭、失源或桥切换会清除 pending。它是待提交布局的呈现信息，不是第二份主选中状态。

IPC 选择不能取消，store 因此独立跟踪最新选择意图与已发出请求。关闭/解散、后一个布局、主侧列表导航或真实外部导航会覆盖旧意图。旧回执仅在桥及工作区 scope 仍一致、当前实际主侧仍是该旧请求目标时恢复最新意图；已在其他内容时不补偿，新请求尚在途时等其确认，旧布局偏好不落盘。`canSelectRef` 校验引用仍存在且未归档；scheduled 可恢复为用户最新选择，但保持单屏，不扩展其分屏能力。工具切换只允许原工具背后的已知会话或空视图作为临时帧，其他实际主选中视为外部抢占。

App 实际复用 `hooks/useCenterSplitSelection.ts` 的工具 setter、`selectRef` 和 `sessions:reveal` 监听；底层选择 guard 按请求序号、工具 revision 与工作区限制旧 reveal/Promise 的收板兜底，避免迟到会话选择清掉用户随后打开的工具。同步 setter 在 React 提交前就使旧请求失效，切离再返回同一工作区也不会重新启用它。主选中仍由 App 持有，控制器只发送受校验的纠正选择。

## 入口与焦点路由

连续关闭、交换、槽位选择、来源拖入和换向都基于最新请求的 `desiredLayout`。旧 DOM 的槽号先解析为内容引用，再映射到最新意图；已移除内容的重复关闭/旧回调不重新带回该内容。闭合等待时左栏新内容按单屏导航处理，已保留的内容只聚焦；新原生分屏从请求保留的内容建立布局。后续填充继承仍有效的布局偏好 patch，确认之前不落盘。最后一个内容已经请求为单屏时，旧分屏按钮再次关闭按单屏无收起动作处理，不能用 `empty` 假装清空 App 会话。

1. **内容来源原生拖入**：会话行、工具瓦片、导航树和常用里的非文件夹节点携带 `application/x-muster-pane`（JSON `SplitPaneRef`），提起后先露出顶部中央提示边，拖入提示区展开同一个 Snap 布局条，在具体小格松手提交。文件夹只参与目录移动，可通过点击或分屏空选择器进入中央工作面。
2. **来源菜单**：会话右键/⋯ 菜单的「分屏显示」四方向子菜单，导航树同类入口，均调用 `centerSplitIncoming`。
3. **Ctrl+\**（`center.split`）：从受支持的单屏内容打开分屏，副侧为空选择器；虚拟屏切页为 `Ctrl+Shift+\`。
4. **工作面顶部布局按钮**：单屏和多屏均可直接打开 Snap 条；中央三点把手打开更多菜单，单屏可直接打开左右/上下分屏。双屏菜单保留交换、换向和居中，多屏均可解散保留此侧或收起此侧。会话、内置工具与扩展入口的菜单另有「固定到右侧 / 移回中栏」（与左栏右键菜单同一入口，行为见 [右侧统一多标签工作面](right-workspace-tabs.md)「固定到右侧」）；固定后该格显示去向占位，内容实例移到右侧标签。

默认快捷键与真实 `KeyboardEvent.key` 共用 canonical 键名：反斜线 `\` 归一为 `backslash`，`ctrl+backslash` 经生产 `KeybindingProvider` 分派到分屏动作，避免默认配置和真实按键不匹配。保留 `notTyping` 约定，正文输入时不抢走按键。

Snap 重排和原生来源拖入保留全部已显示引用。来源方向菜单继续走 `centerSplitIncoming`：新引用进入单屏时组成两侧，进入已开布局时替换对应目标槽，保留其余槽；已有引用先去重，再停靠或聚焦。方向菜单保留兼容语义，原生拖入和工作面提起共用顶部布局条、候选预览和具体格落点。

分屏内的正文 `pointerdown` 按实际矩形路由焦点；`focusin` 根据内容根、工具层或工具条所属槽位路由，Tab 到另一槽后左栏选择也跟随该槽。已有内容优先聚焦；新内容在第二/第三逻辑槽聚焦时填该槽，在主槽聚焦时保持正常 App 导航。点已显示的主工具瓦片或其快捷键时，若当前焦点在第二/第三槽则先聚焦主槽；主槽聚焦后再次操作保持原关闭行为。工具菜单 portal 不作为新的正文槽位。

LeftPanel 订阅分屏 store，以工具优先的 App 主引用与已提交的非主槽派生全部打开引用。会话、内置工具、导航树和常用入口中，已打开项使用所在面的 `--interaction-selected`，当前聚焦项以 2×12px 中性短标记表示，不永久画焦点圈；`:focus-visible` 独立表达键盘焦点。选中/ARIA 语义及会话列表键盘锚点跟随实际焦点引用。物理重排不改变引用身份，关闭或解散后及时移除打开标记；空选择器不标记，单屏工具遮盖的背后会话不算打开。导航树与常用入口共享 `openedIds`，`selectedId` 表示聚焦；旧单选调用省略 `openedIds` 时兼容为仅选中项打开。待提交布局不提前成为另一份侧栏状态。

分隔条保持原指针命中区，只绘制 1px 线：静息、hover/拖拽、键盘焦点分别消费 `--divider-rest / active / focus`。不增加宽度或光晕。工具栏使用不透明 chrome；拖起 pane 的透明目标蒙版仍由 resolver 的 `--surface-drag-preview` 提供，保留原 presence、blur 和几何。

pending 期间 DOM 和回调仍绑定原槽位，候选物理顺序可能已变化。store 先把原槽位解析为内容引用，再映射到最终候选焦点；列表填充也按该引用判断目标，不能直接沿用候选槽号。沙箱 iframe 的 `panelFocus` relay 每次 pointerdown/focusin/window focus 都上报，重复点击不同 guest 也能改焦点；父端检查消息类型及 `event.source` 等于当前实际 iframe 的 contentWindow，拒绝外来 source、隐藏或 inert 层，不信任消息自报槽号。窗口 blur/focus 后读取 activeElement iframe 的单帧检查作补充。子文档不冒泡不再依赖普通 React focus 事件兜底。

## 几何与控件

CenterPanel 在布局 effect、`ResizeObserver` 和窗口 resize 中读取中央工作面的尺寸，用 `getCenterSplitPaneCells` 按预设或两侧方向/比例派生各逻辑槽的归一化矩形，再转换为像素，**没有持续 rAF 测量循环**。内容和控件使用同一份几何；`right/bottom: auto` 显式配合 `top/left/width/height`，避免 `inset: auto` 简写重置定位。

- **单屏**：没有活动拖动时 `insetFor` 返回 null，撤销分屏的全部 inline 定位与浮起变换，内容按原单屏样式铺满。菜单可重新分屏，受支持的非空内容也可拖动到 Snap 落点。
- **宽屏多槽**：两侧/三格矩形按预设互补，正文与输入区同处真实内容根内。透明骨架和 pane body 透传事件，只有 handle、divider、空选择器等控件接收命中。
- **窄屏**：中央宽度小于 `SPLIT_NARROW_PX`（560）时，焦点槽铺满，其余槽隐藏；右上轻量按钮可切换全部两/三个槽。布局、顺序、比例和绑定保留，拖宽恢复原布局。工具焦点槽保持 open，不因降级退场。窄屏禁用 handle 拖动，可用菜单和键盘选择 Snap 布局。

顶部工具栏覆盖在正文上方，不预留栏高，悬停前后正文矩形不变。`--center-pane-toolbar-height` 只控制浮层高度（普通指针 36px，粗指针 48px）；终端和 GUI 保留原 padding，工具层使用稳定的 `.center-utility-content` 子容器且不增加顶部 margin，空选择器与待答问题横幅仍从面板顶部布局。内容根、草稿和 iframe 父节点保持原契约。

状态图标与文案通过 `sessionDisplayStatus` 派生，与侧栏/看板的运行状态规则相同；进展显示 `liveStatus.label` 的最近上报原文，无上报则留空。运行时取 registry label（缺失回落 runtime ID；普通 Shell 标为终端）。查找只在 chat surface 会话显示，点击将共享查找的 `ownerId` 指向所属 session、范围设为当前会话、递增 `focusEpoch`，保留查询词；终端和工具无此入口。GUI `AgentChatView` 使用 `compactHeader`，Pi Harness 透明开关仍通过 `onPaneControl` 注册进更多菜单。

工具栏使用两侧等宽轨道与 32px 中央轨道，使把手精确位于该 pane 的物理中心，左右文字和按钮的宽度不会挤动把手。`data-top-left/right` 根据最终呈现的物理矩形（含 order/pending、窄屏与拖动状态）标出工作面的外侧顶角，只消费 `--radius-page`；内部接缝保持直角。上下分屏只有顶部面板保留两个外角，三列中间栏无外角，窄屏满幅恢复双外角；提起/独立窗口使用 `--radius-card` 双顶角，不按逻辑槽号硬编码。

响应式按 pane 容器宽度收敛：≤560px 隐藏进展，≤420px 隐藏运行时与状态文字，保留状态图标、名称及操作按钮。中央区整体窄屏降级时，1/2/3 槽切换按钮合并在可见工具栏内，不再单独覆盖正文；≤420px 且有槽号切换时收起独立布局按钮，布局仍可从中央把手或更多菜单打开，避免侵占中央把手。长名称与进展均省略并保留完整 tooltip。

宽屏两槽和三槽均提供可调 divider，为 1px 线、8px 命中区，使用 pointer capture。`getCenterSplitDividers` 统一派生方向、跨度和可调范围：三列有两条全高竖线；主辅和镜像布局各有一条全高竖线，以及仅覆盖堆叠侧的横线。三槽 `ratios` 保存物理边界坐标（三列为 x/x，主辅为 x/y），由 `getCenterSplitRatios` 归一化；每个相邻面板沿调整轴最小占 20%，不会越过邻线。键盘方向键每次调 2%，Home/End 到当前上下限；双击均分相邻区域，菜单重置恢复该预设默认比例。两槽手动调整回到原两侧比例布局。重新选择 Snap 预设会重置比例，旧候选校验也包含三槽比例。

Esc 或 pointercancel 恢复拖前的完整比例；Esc 在 window 捕获阶段处理，正文输入框和其他快捷键层不能先吞掉取消。捕获保存 element、工作区及布局/引用/order 身份，关闭、切区、换向或布局变更时释放，不回写到新 owner。窄屏、拖动 pane 或存在 `pendingLayout` 时不渲染 divider，并结束旧 capture。几何变更没有宽高过渡，内容 DOM 和草稿不重建。

## 拖动现有工作面

`useCenterPaneDrag` 从工具栏正中的独立把手捕获指针，移动达到 6px 后提起整块真实 pane；点击未越过阈值则打开菜单，拖后生成的 click 被消费。source 的正文、输入区和工具条仍留在原父节点，保持原尺寸，通过位移和 **0.78** 缩放清晰跟随指针。进入 Snap 条时缩为 **0.32**；两种缩放均按原抓取点锚定指针，不再把条区缩略图偏移到指针右下方，否则卡片永远无法碰到顶边。浮起卡片显示位置钳制在工作面内，内容仍保留原根节点。

拖起后，剩余一个非空内容临时铺满工作面；剩余两个按原相对方向临时均分。空选择器在携带过程中隐藏。候选落点只改变目标 frosted 预览，不把这些背景内容提前缩到候选位置，也不把 source 提前落位。已提交引用、布局、顺序和草稿在松手前保持不变。

接受 handle pointerdown 时就启用 `captureActive` 与全幅透明 `center-pane-capture-shield`（z-index 12），而不是等首个 move 或视觉提起之后再接管。Chromium 跨 iframe 的首个 move 可能在 `hasPointerCapture=true` 时仍交给 guest；提前盾层让首包留在父工作面。6px 之前不改变真实内容几何、不显示视觉提起或落点；up/cancel 关闭盾层，原 handle 与内容实例保持不动。这与 MIME 驱动的原生来源接收盾层是两条不同的事件路径。

拖动激活后，完整选择器本体先藏在工作面顶边外，仅露出底部18px（宽度与展开时一致）。指针进入中央提示区（中心左右280px，窄容器保留两侧10px、距顶部大于 8px 且不超过 40px）才展开 Snap 条。若从提示区内的把手开始拖动，须先离开再进入，避免刚提起就展开。继续向上进入顶部 8px 时收起选择器，按卡片触顶规则显示全屏预览。长按把手、菜单或键盘主动打开仍直接显示完整选择器。只有命中实际、未禁用的小格才产生目标候选。为避免条在移入时闪退，已展开时保留条横向范围和下缘各 **18px** 的缓冲。父手势按各小格真实 rect 和 `data-center-snap-layout/index` 命中，持续 pointer capture 时也不依赖 `event.target`。

边缘操作与顶部Snap选择器并行：左/右触边提供halves左右落点，顶边通过网页式全屏临时放大拖动项并保留原分屏，底边关闭拖动面板（分屏收起该槽；单屏会话禁用底边关闭预览与提交，工具走原关闭回调），不结束进程、不归档会话。命中不再看指针18px边缘带：centerPaneEdgeAt用当前缩放后的卡片边界与工作面边界相交判定，指针仍在工作面内时即可触发；多边同时触碰选择距指针最近的边。三个已占用引用仍不能用两格快捷落点丢弃其他内容，但支持明确的全屏/关闭操作。

选择器实际格子优先于边缘操作；禁用格及条内空隙不能因卡片同时碰边而变成另一动作。选择器顶部位于工作面内48px，中央提示区负责展开，最顶部8px留给全屏，条区保持缓冲不变；顶边全屏可在不命中选择器格子的区域触发。移离触边条件立即撤销候选；离开工作面、Esc、失去capture或窗口失焦均取消。

有效布局候选绘制所选cell对应的大面积frosted预览，增加2px聚焦色边框与选择色底；全屏预览覆盖工作面，关闭预览突出底部112px区域并用danger状态色。独立z-index 11的操作提示明确显示“松开后左/右侧分屏、全屏显示、关闭面板或应用布局”，不会被浮起源卡盖住；提示和目标继续复用presence与动画token。source 始终清晰浮在其上，背景保持携带时的临时布局。换格切换目标区域，离开有效区域清候选。`CenterSnapBar` 宽屏宽 560px、预设高 72px、图标 16px，受中央容器宽度约束，窄容器改三列。小格只呈现引用类型与 tooltip；鼠标 hover/点击可选，键盘单次 Tab 进入，方向/Home/End 跳格，Enter/Space 选择，Escape 清候选并恢复原把手焦点。三格占满时跳过全部两格预设。

松手按当前卡片几何重新派生候选；布局走原Snap事务，全屏/关闭先校验来源、原布局、顺序与工作区几何身份仍一致才执行。预览期间不改绑定或提前关闭。中央/工作面外松手、Escape、pointercancel、丢失 capture、窗口 blur 或来源/布局/工作区失效都取消，恢复已确认的真实几何；取消不更改内容顺序。窗口 pointerup 与无按键的 pointermove 兜底清理捕获；跨 sandbox iframe 收不到框外 up 的情形在重新进入宿主且 `buttons=0` 时取消，不通过跨源访问或定时猜测状态。该边界仍须真实 Chromium/Electron 验证。

Snap 条和目标装饰通过 `usePresenceValue` 冻结最后有效的内容/几何直到退场结束，真实 pane 几何在 finish 时立即交回已提交状态或有效 pending。提示边与完整条是同一份 `CenterSnapBar` DOM，由 `usePresenceValue` + `mp-pop` 保活，外层用motion token过渡transform，从顶边外滑到48px；全幅裁切容器限制在工作面内，探出阶段inert、按钮禁用且不参与格子命中。完整条使用 `mp-pop`，frost 元素使用 `mp-scrim`；时长和曲线来自现有 motion token，只过渡 opacity/transform。父 `center-drag-scrim` 不做 opacity 动画，避免动画祖先使子 `backdrop-filter` 在 Chromium 中不绘制。退出条 inert、控件 disabled，退出装饰不接收指针；快速取消再拖可反转 presence。原始 handle 持续 capture，预览不移动或替换其 DOM。

工具层继续使用 `mp-panel` 的 presence，但分屏或携带时把 transition-property 限制为 opacity，撤销原工具入场 transform 过渡。真实工具的浮起和背景临时 bounds 因此立即生效，不等待 transform 过渡终点。

## 原生来源拖拽

原生 DataTransfer 路径与上述现有工作面指针拖动分开：会话/工具来源允许 **copy**，导航来源允许 **move**，中央接收方据 `effectAllowed` 协商兼容的 `dropEffect`。导航 move 仍表示其原生来源协议；中央仅显示该内容，不在中央 drop 中改目录树。

window 的 `dragstart` 冒泡监听在侧栏生产者写入 MIME 后读取负载，保存来源、主引用和布局/scope 快照，先让同一Snap条本体从顶边探出18px并启用覆盖中央区的接收盾层；使用与面板拖动相同的提示区/保留区规则展开选择器，进入最顶部8px收起。左右触边快捷分屏无须先展开选择器。浏览器的 `dragover` 数据受保护，因此只按快照和小格真实矩形派生候选，不读取 payload；接收盾层位于布局条下、既有 iframe 上。命中可用小格或左右触边快捷落点时协商copy/move并绘制预览。dragstart同时记录真实draggable源卡宽度与水平抓取点，dragover/drop以卡片左右边界触碰中央工作面边缘派生halves左右目标；指针可以仍距边缘数十像素。源卡不可测时使用160px宽、居中抓取的兜底。选择器实际小格优先，禁用格/条内间隙不回退成边缘动作，普通正文仍不接受落位。两格容量不够时拒绝快捷落点，继续使用三格选择器，不挤掉原内容。侧栏拖入尚未显示内容只新增左右快速分屏，不提供关闭或全屏动作。drop 重读负载并校验与来源一致，再按释放坐标重新派生候选交给 `centerSplitCommitIncomingSnapLayout`；不沿用上次 dragover 缓存。dragend/drop/Escape/blur、布局或工作区变化清理盾层与预览。

原生来源预览是接收区域的视觉提示，未落地前不执行新内容、不创建另一份会话或扩展实例，也不冒充现有工作面拖动的真实内容候选。真实原生鼠标和跨 iframe 路由需浏览器/Electron 测试，合成 drop 不能证明协议兼容。

## 工具导航、挂载与偏好

左侧前进/后退按完整视图快照回放分屏内容、逻辑槽到物理格映射与布局；开关、切换某格内容、重排和关闭均可回放。仅切焦点或调比例不增加历史，离开时仍保存最新值。回放通过 `centerSplitRestoreHistory` 直接选择主引用并在确认后一次提交其余槽，绕过普通导航的“填入当前焦点格”，不复制已显示内容。失效主目标跳过，失源非主槽置空。右侧内部访问不参与此历史，虚拟屏进入右页只占一步。录制、异步确认与工作区边界见[面板与内容历史](panel-history.md)。

会话视图、工具层和扩展 iframe 都是 `center-panel` 的固定子节点；改变槽位只改样式。常驻会话继续遵守 `visible/is-shown` 契约，分屏工具存在时仅恢复已经显示的会话，不强制绘制其他隐藏会话。导航/扩展工具层保留原实例，退场隐藏并 inert，重新显示沿用 DOM；切工作区用 workspace key 隔离。

所有逻辑槽按所属 slot 注入内部关闭回调和 `centerOnly`：三槽收起一项后，剩余两项按原相对位置降为左右或上下两槽；再收起一项剩余内容铺满。若本来只有一项非空，直接回单屏。「解散分屏（保留此侧）」只保留指定引用。收起和解散均不结束会话进程。导航内部文件夹子卡继续通过 slot 回调进入子内容。分屏中的导航强制中央位置，不显示停靠/独立窗口选择器。

空槽的 Snap Assist 选择器列出未显示且受支持的未归档会话、内置工具、导航和扩展；点选只填所在逻辑槽，已有引用不复制。仍可从侧栏点选或原生拖入填空。

两槽方向和比例保存到工作区配置的 `centerSplitDir/centerSplitRatio`；三槽 `ratios` 仅保存在当前布局与左侧导航历史快照。开合、内容绑定、Snap `layoutId/order` 和三槽比例不跨重启恢复。`useCenterSplitPrefs` 的 400ms pending 携带原 workspaceId，只合并同一工作区的值；切区、重新加载、未 ready 或卸载会取消旧 pending。`useWorkspaceFile.patch` 再校验显式 owner，已发出的旧工作区响应也不会覆盖当前配置。写入被拒绝或抛错时，在中央工作面叠加可关闭的保存失败提示；未就绪或工作区切换导致的旧写入取消不向当前区误报。快速切区可能取消尚未落盘的最后一次调整，这是当前明确策略。

本地扩展使用 DOM 沙箱 iframe，分屏不创建 WebContentsView 或上报原生 dock 矩形。独立内置浏览器已迁入 renderer `<webview>` 合成栈（2026-10-08 迁移，旧 WebContentsView 让位体系与 `src/main/browser/viewAvoid.ts` 已删除，浮层/跟随/露条手势由 DOM 直接处理），不向扩展传播原生让位信息。

单屏导航入口已有 `placement: window` 时，提起的是宿主内既有的占位卡，不能据此宣称原生独立窗口里的正文也跟随指针。Snap 正式落位后按 `centerOnly` 强制回中央，恢复原 iframe；独立窗口内容跟随拖动不在本轮实测范围。

## 关键文件

| 文件 | 职责 |
|---|---|
| `src/shared/centerSplit.ts` | 三逻辑槽/五预设、物理顺序与可调几何、比例归一化和 divider、Snap 候选、旧二叉 API、去重与 MIME 编解码 |
| `src/renderer/src/centerSplitStore.ts` | secondary/tertiary/布局/顺序/焦点、App 桥、候选校验与异步主选中提交 |
| `src/renderer/src/centerSplitSupport.ts` | terminal/工具/导航/扩展支持判定与主侧解析 |
| `src/renderer/src/centerSplitSelectionGuard.ts` | App 会话选择的工具 revision/工作区/request 归属，限制迟到收板 |
| `src/renderer/src/hooks/useCenterSplitSelection.ts` | App 实际复用的工具 setter、会话 Promise 与 reveal 控制器 |
| `src/shared/panelRelay.ts` | 沙箱 guest 焦点/点击 relay；父端按 iframe source 路由所属槽位 |
| `src/renderer/src/panels/CenterPanel.tsx` | 尺寸/比例直接计算矩形、稳定挂载、控件、焦点、窄屏与原生接收盾层 |
| `src/renderer/src/hooks/useCenterPaneDrag.ts` | handle 捕获、6px 阈值、真实内容浮起、Snap 条和边缘命中、提交/取消 |
| `src/renderer/src/components/CenterSnapBar.tsx` | 五预设小格、引用图标/tooltip、容量禁用、键盘导航与退场 inert |
| `src/renderer/src/styles/split.css` | 透明骨架、隐藏 handle、divider、Snap 条/Assist、单目标 frost 与原生来源提示 |
| `src/renderer/src/App.tsx` | 主选中桥、绘制前 reconcile、失源/切区与快捷键 |
| `src/renderer/src/hooks/useCenterSplitPrefs.ts`、`useWorkspaceFile.ts` | 原工作区偏好 pending 与 owner 校验 |
| `src/renderer/src/panels/LeftPanel.tsx`、`components/ExtensionNavigationTree.tsx` | 原生来源、方向菜单与列表点击路由 |
| `src/renderer/src/agentChat/AgentChatView.tsx` | compactHeader 与 Harness 菜单控制注册 |
| `src/renderer/src/components/ContextMenu.tsx` | 菜单/子菜单与键盘交互 |
| `src/renderer/src/panels/LeftPanel.tsx`、`components/UtilityNavigationSection.tsx`、`components/ExtensionNavigationTree.tsx` | 全部打开引用与当前聚焦项的侧栏标识，导航树/常用入口共享状态 |
| `src/shared/keybindings.ts`、`src/renderer/src/keybindings/KeybindingHost.tsx` | 默认反斜线键名归一与生产快捷键分派 |

## 关闭可用性

canCloseCenterPane统一工具栏按钮和底边拖动的可用性：有两个或更多非空内容时可以收起所属分屏；只剩一个会话时不显示关闭按钮，也不预览或提交底边关闭。一个会话加空选择器同样不允许关闭该会话，但仍可收起空选择器。单屏工具保留已有关闭回调，回到背后会话。此规则不会归档、删除或停止会话；此前增加的sessions.deselect接口保留，但此工具栏不再调用它。

2026-10-17最终用户反馈：单个会话关闭无效，按要求隐藏该状态的关闭入口。已补组件回归覆盖初始单屏、关闭分屏后剩余单屏、空选择器、工具关闭及底边一致性；111项定向用例、三套类型及构建通过。隔离Electron单屏深浅主题关闭按钮不存在、真实PTY继续输出1项通过（10.6s），截图已查看；顶栏使用键盘聚焦展示，未扩展为悬停异常已修复。

## 边界与验收入口

- 最多三个逻辑槽、五个预设，无递归/四格 UI。Snap 与原生新来源不丢现有非空引用；三个内容已占用时，新来源无可用布局，已有来源仍可重排。来源方向菜单保留目标槽替换语义。
- 开合、内容绑定和 Snap 预设/顺序不持久化，重启不恢复；仅两槽方向/比例按工作区保存。
- 失源非主槽变为空选择器；scheduled 不支持分屏，但最新外部 scheduled 导航仍受迟到回执保护。
- 单屏和含空槽布局中的非空来源可 Snap；窄屏不接受 handle 拖动，但非空来源仍可从菜单选择布局。空来源和异步确认期间禁用布局选择入口。
- 当前窗口内重排，不新建系统窗口。iframe 子文档焦点通过 guest relay 和 host iframe 检查路由，跨文档输入/拖拽仍须真机核验。
- 常规窗口缩放可能受主布局最小宽度钳制；窄屏组件测试直接控制中央 clientWidth，浏览器测试验证真实矩形。

当前源码保留 2026-10-07 审查 的 R1–R12 修复，历史审查描述和原双槽验收事实保留其基点。2026-10-08 侧栏统一 Snap 和面板放大已复验五个相关组件/模型文件，侧栏打开/聚焦标识又复验四个组件文件；生产 Chromium 深浅主题已覆盖两次改动。其余测试及 Electron 结果是当天正式 Snap 初版的验收记录：

| 入口 | 覆盖及边界 | 本轮结果 |
|---|---|---|
| `test/unit/center-split-model.spec.ts`、`center-split-store.spec.ts` | 五预设/三槽/order、容量不丢引用、候选原布局/scope 校验、三槽收起/解散/失源；侧栏新来源加入/已有来源去重、空主晋升、失源与容量拒绝；held Promise 乱序、累积操作、偏好继承、闭合 marker、最新 scheduled 引用与 pending 焦点身份。纯逻辑不证明像素或原生协议 | 41 + 103 项通过 |
| `test/unit/center-snap-bar.spec.tsx` | 五预设归一化小格、引用图标/tooltip、逻辑到物理映射、容量禁用、hover/click、键盘导航与 Escape、presence 退场 inert/反转 | 10 项通过 |
| `test/unit/center-split-panel.spec.tsx` | 关闭/解散/切区几何、DOM/草稿、隐藏会话、三槽/窄屏/Assist、槽位焦点/guest 校验、divider owner/pending；真实 source 浮起、原物理顺序、后台终端尺寸、全局 Esc/退场冻结、空主槽晋升、闭合确认/拒绝；侧栏同一 Snap 条、protected dragover、释放坐标重算、容量/间隙/旧边缘/Esc/blur/dragend/失效取消 | 79 项通过 |
| `test/unit/center-split-support.spec.ts`、`center-split-sources.spec.tsx`、`center-split-prefs.spec.tsx` | 受支持引用、实际来源 copy/move、第二/第三槽点击与真实主工具快捷键先聚焦、三槽混合打开/聚焦标识、重排/关闭清理、单工具遮盖、导航常用与树同步、工作区 owner/取消/迟到响应；组件 mock 不代替真实持久化 | 4 + 12 + 6 项通过；sources 本轮复验 |
| `test/unit/extension-navigation.spec.tsx`、`left-session-rail.spec.tsx`、`left-panel-collapse-agent-float.spec.tsx` | 既有导航编辑/常用/折叠、会话列表与折叠浮层交互兼容 | 本轮 20 + 3 + 2 项通过 |
| `test/unit/center-split-selection.spec.tsx` | App 共用真实 Hook 的组件回归：reveal/Promise 兜底、工具覆盖、逆序回执、切区/返回、失败保留、外部 reveal 与卸载 | 10 项通过 |
| `test/unit/panel-relay.spec.ts`、`center-split-selection-guard.spec.ts`、`center-split-keybinding.spec.tsx` | guest 重复 pointer/focus 消息、收板纯 guard、真实反斜线 Provider 分派及 notTyping | 2 + 4 + 2 项通过 |
| `test/unit/harness-annotations.spec.tsx`、`center-utility-crossfade.spec.tsx` | compactHeader/Harness 控制注册、刷新与卸载；工具层退场/切回保留实例及导航草稿 | 9 + 5 项通过 |
| `test/session-pane-toolbar-visual.mjs` | 生产 CenterPanel/store/CSS 的默认隐藏、顶部悬停实底、正文不预留栏高、真实 Tab/菜单保活、布局按钮与 Esc、真实指针拖动取消、320px 窄栏切换；三列/主辅/镜像的两条分隔线实际拖动及 Esc 恢复；单屏/左右/交换/上下/三列/主侧三分屏/窄栏的把手精确居中与外侧圆角；IPC 与正文叶组件为替身 | 深浅主题通过；已查看隐藏/悬停及三种调整后布局截图，不替代 Electron 原生验收 |
| `test/center-split-production-visual.mjs` | 生产 CenterPanel/StoreProvider/来源/CSS 的真实 Chromium；双/三会话及会话+工具+导航的打开标识、真实正文/iframe 切焦、关闭清理与背景/轮廓；侧栏实际 copy/move 到统一 Snap 格、跨 iframe 保活、满容量及旧边缘拒绝、560px/72px 面板和窄屏三列；工作面 source 清晰浮起、精确落位、sandbox iframe 首包路由、DOM/草稿、同背景 Gaussian 像素对照。IPC 与叶内容为替身 | 本轮深浅主题全部通过，布局及侧栏状态截图已查看 |
| `test/e2e/center-pane-edges.spec.ts` | Snap 初版验收文件 `test/e2e/center-split-iframe.spec.ts`（iframe/PTY/GUI 三格并存、草稿/DOM、强制中央与逐侧关闭、xterm 尺寸恢复）已随扩展系统迁移移除，其「初版三个构建产物通过、最终 E2E 1 项通过 15.4s」为历史记录；现行分屏 E2E 为本文件：真实 App/IPC 双本地会话，卡片碰边派生左右分屏/上全屏/下关闭，与 Snap 选择器并行且可取消，草稿与会话不误归档 | 历史结果见上；现行文件随 2026-10 分屏交互改版引入 |

侧栏统一 Snap 改动定向回归 5 个文件、239 项通过（7.84s），最终 web/node/test 类型检查通过；类型收窄修正后 store 的 103 项再次通过。Chromium 验收沿用 55 秒预算，最终深浅主题通过，已查看 `dark-native-snap-picker.png`、`light-native-snap-picker.png` 和 `dark-narrow-snap-picker.png`。首次浏览器断言误用禁用按钮的 dragover 操作，已改为校验可信 dragend 为 none、无 drop 和完整状态保留；放大条后原拖离坐标落入保留缓冲，改到缓冲外重新通过。

侧栏打开/聚焦标识定向回归 4 个文件、37 项通过（6.62s），web/node/test 类型检查通过。旧折叠浮层测试缺少新增订阅的 mock，补为保留真实分屏订阅；两处新增测试元素类型标注已修正，原断言不变。真实 Chromium 深浅主题再次通过，已查看 `dark-sidebar-open-focused.png` 与 `light-sidebar-open-focused.png`；本轮未构建或重跑 Electron。

Snap 初版定向回归 13 个文件、262 项通过（7.86s），并有真实 Electron/PTY 验收：PTY 从左右 73×45、上下 149×22 恢复 149×45，xterm 恢复 1192×855，同进程继续输出（当时的 E2E 验收文件已随扩展系统迁移移除，现行 Electron 入口为 `npm run test:e2e -- test/e2e/center-pane-edges.spec.ts --retries=0`）。Chromium 与 Electron 截图分别位于 `.tmp/ui-captures/center-split-production/`、`.tmp/ui-captures/center-split-e2e/`；当前侧栏改动没有重新构建或重跑 Electron，不把初版结果作为本次完整 app 验收。

首轮 Electron 在最终 FULL 终端键入中意外关闭（13.1s）。trace 证明关闭先于测试 finally，不能归因为测试清理；缺少首轮退出码，原因未确定。同产物独立重跑通过（12.6s），最后代码重新构建后再次通过（15.4s）。夹具已记录 process exit/page close/crash 事件，后两轮没有意外生命周期事件；保留首次异常说明，不把它解释为已修复或确认无风险。

scheduled 与工作区偏好 owner 的覆盖来自 store/Hook 回归，未扩展为真实 scheduled 服务或偏好持久化验收；本轮未测 GPU 性能。未提交、推送、打包或更新安装版。

常驻顶栏首轮定向组件回归：`center-split-panel` 85 项，加工具层 5 项、Harness 9 项及查找浮条 6 项，共 105 项通过；查找既有 IME 用例有 act 警告。居中把手与圆角调整新增 3 项先转红，最终 `center-split-panel` 88 项、node/web/test 三套类型检查、顶栏专项与原有 production Chromium 分屏回归均通过；初轮 `inset-content-css` 也通过。原视觉脚本焦点条旧断言在 HEAD 的 CenterPanel/split.css 上同样失败：静态伪元素应通过 opacity 判断显隐，导航用 `::before`；脚本已更新为最终透明度带容差的断言。`glass-surfaces-css` 仍失败，HEAD 测试与 HEAD CSS 同样在页面阴影断言失败（要求 none，实际 shadow-page），未改动无关页面样式或该守卫。本轮未构建或重跑 Electron。


2026-10-17 最终悬停顶栏及三分屏调整验证：panel 95、store 104、model 44、left-navigation-history 10、motion-presence 8，共 261 项通过；node/web/test 类型检查通过。三分屏新增交互回归在未实现 divider 时转红；真实 Chromium 深浅主题完成顶部 hover/Tab、菜单保活、三种三槽比例调整、Esc 恢复、DOM/草稿保留，以及原 production 分屏/跨 iframe 回归。真实浏览器发现的 Esc 被上层拦截已改为 window 捕获阶段取消并补回归；分隔线交点可能命中另一方向，测试改在目标线 25% 位置开始且核对实际命中元素。截图及 review 位于 `.tmp/ui-captures/session-pane-toolbar/`。本轮没有构建或重跑 Electron，既有 glass-surfaces 页面阴影守卫的 HEAD 失败仍保留。


2026-10-17边缘拖拽调整验收：panel 105、center-pane-edge 6、store 104，共215项通过；node/web/test类型检查通过，当前源码构建通过。隔离Electron新增test/e2e/center-pane-edges.spec.ts在深浅主题分别用真实指针完成卡片提前碰左右边、顶部全屏、底部关闭、Esc取消和选择器格子优先，DOM与两会话草稿保留、会话不归档，1项通过（20.8s）；八张方向预览已查看，位置和提示文案一致。连续操作等待主选中确认，以唯一草稿识别会话而非假定DOM挂载顺序等于逻辑槽；截图等待文案和绘制稳定。提示文案字面量类型推断曾使类型检查失败，收窄联合类型后通过。

本轮原生测试观察到悬停顶栏偶发未展开（DOM命中热区但栏透明），没有把它解释为已修复；最终E2E先用产品已有键盘聚焦唤出把手，再进行真实鼠标拖拽。原生悬停仍需独立定位。当前用户客户端未被操作或重启，没有提交或推送；旁路工作区修改保留。

原生产Chromium深浅主题回归已通过：侧栏copy/move统一Snap、跨iframe首包捕获、容量拒绝、三槽/窄屏、DOM/草稿、精确落位及同背景blur像素。跨iframe检查坐标保留在选择器保留区之外。

2026-10-17侧栏快捷补充验收：选择器top从10px下移48px，nativeTargetAt增加按源卡宽度/抓取点触边的halves落点；107项组件与node/web/test类型通过。原生产Chromium深浅copy/move、跨iframe、容量及窄屏回归通过，并以真实侧栏卡片在指针距左边约60px、右边约100px时完成快速分屏。已查看深浅native-snap-picker/native-quick-left/native-quick-right六张截图；未构建或重启当前客户端。

### 外轮廓与内部分隔

分屏子面板不绘制右/下伪边框，避免贴外缘时与工作面轮廓重复。内部线仅由已有 center-split-divider 绘制并保留 divider-rest/active/focus 状态。会话页外轮廓与右侧页共用 surface-rim。相邻边缘像素回归见 test/frame-gap-visual.mjs 的 split-edges 场景。

2026-10-17 Windows式分阶段展开验收：选择器本体藏在顶边外，仅露出底部18px，进入中央提示区后同一DOM通过transform滑到48px；不是独立提示条替换面板。探出时inert并禁用按钮，裁切容器限制在当前工作面内，侧栏与面板拖动共用。126项组件/边缘/选择器测试通过，新增本体DOM身份、五个预设保留和探出禁用断言；旧起始点进入加宽后的提示区，用先离开再进入的真实路径更新。三套类型检查及构建通过。生产Chromium深浅主题copy/move、跨iframe、容量/窄屏、左右快捷落点回归通过，已查看本体探出/展开截图。隔离Electron深浅阶段往返、同一DOM、触顶全屏和四边/取消/草稿/DOM 1项通过（21.4s），四张本体探出/展开截图已查看。原生悬停既有问题仍保留，测试用键盘聚焦唤出把手后真实鼠标拖动；没有重启当前用户客户端。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D07.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：中栏工作面最多三 pane 同显（终端/GUI 会话、内置工具、扩展）：Windows 式 Snap 五预设、把手拖动、侧栏原生拖入、空槽选择器内搜内建；App 主选中是唯一权威，分屏只重排当前窗口不建系统窗口。
- 为什么这样设计：逻辑槽与物理落点分离（主内容放右格不改变 App 主选中）；Snap 重排保全部非空引用（容量不足禁用不丢弃）；异步提交全链校验（原引用/布局/scope 一致才提交，途中失效旧候选不落盘）；iframe 焦点经 guest relay+source 校验路由（不信任自报槽号）；pendingLayout 是待提交呈现不是第二份主选中。
- 明确不做：无递归/四格 UI（「左宽右窄」已从选择条移除仅供旧工作区还原）；scheduled ServiceView 不支持分屏；开合/内容绑定/Snap 预设与顺序不跨重启恢复（仅两槽方向/比例按工作区落盘）；单屏会话隐藏关闭入口、不归档不结束进程（2026-10-17 用户反馈）。
- 歧义点：三槽布局/绑定/顺序不跨重启恢复，与同域 focusMode/hDock「布局落盘」哲学不一致（代码证实只落两槽 dir/ratio）——A=长期边界（分屏组合=会话态，与面板历史同哲学，重启从单屏开始；review 不把不持久化当缺陷）／B=补持久化（三槽 ratios/layoutId/order 落 workspace.json 与 VS 同族）。推荐 A——组合状态跨会话恢复的语义复杂（引用失效/切区交织），一期按会话态；若用户高频用三分屏并期待重启恢复则升 B。
