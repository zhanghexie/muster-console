# 全局看板 · 自由视图（会话画布）

> 状态：实现说明 v1.7（2026-09-26：FreeCanvas.tsx 按画布职责拆进 `panels/freeCanvas/`，组件组合入口与对外 API 不变，行为不变）  
> 代码主入口：`src/renderer/src/panels/FreeCanvas.tsx`（组合入口）、`panels/freeCanvas/`（职责模块：类型 / 纯几何 / 节点卡 / 相机 / 编辑态 / 选集分组 / 建会话 / 同步 / 自动布局 / 键盘 / 指针手势 / 双击右键 / 视图推导 / 世界与控件层）、`freeViewGeom.ts`（纯逻辑）、`freeViewStore.ts`（持久化）  
> 关联：宿主与入口见 [global-board.md](global-board.md)（本视图是全局看板的第二视图，与状态看板 xfade 叠放互切）；拉线建会话见 [free-canvas-create.md](free-canvas-create.md)；样式在 `styles/board.css` 末段「自由视图」区；单测 `test/free-view.mjs`（几何纯逻辑）与 `test/unit/free-canvas-ops.spec.ts` / `free-canvas-card-heights.spec.ts`（画布手势纯函数与测高）

---

## 1. 功能与交互

分组重命名和连线标签输入在处理 Enter/Escape 前检查原生 `isComposing` 与 `keyCode === 229`，输入法确认或取消候选不会提交标签或结束编辑；失焦仍按原合同提交。`test/unit/frontend-ime-actions.spec.tsx` 以真实 CanvasWorld 组件覆盖两类输入及正常 Enter。

**全局代办节点**：与状态视图代办列使用同一份主进程持久化数据（`board-todos.json`），不是思路便签或会话备注。`BoardPanel` 把代办并入 `items`、`aliveIds`、工作区 `zones`；等待首次读取后再挂画布，过滤只影响可见集合。`CanvasNode` 通过 `todoTask` 渲染共用 `BoardTodoCard`；双击和键盘 Enter/Space 打开原新建任务面板，保存更新同一代办，删除由面板完成。位置、分组和相机仍走 `freeViewStore`；代办无 Fork/交接把手，不产生运行时状态。任务弹窗打开期间通过 `active=false` 暂停画布指针、双击、右键和键盘入口，避免指针捕获后的原生双击再次被识别为空白新建。详细保存与启动语义见 [global-board.md](global-board.md#todo只保存任务不创建会话)。

自由画布视口与看板外壳共用 `surface-board-column`，不画独立边框、投影或内层圆角；与状态视图保持一张连续工作面的观感。会话节点与状态列卡片分别渲染，共用 Harness 图标组件及会话身份解析，缺少身份时保留字母回退。自由视口左右无留白，内容平移、放大后直接在面板两侧内缘裁切；相机、分区与悬浮控件逻辑不变。

全局看板工具栏有分段切换器「状态｜自由」（参与 flex 布局，窄容器换行，不覆盖按钮），档位持久；**左右方向键**（无修饰键）也可在两视图间来回切换，输入态与看板外焦点不接管。右侧操作区是统一「过滤」菜单（工作区与面板均可多选，工作区提供「当前工作区」「全选工作区」，面板提供「全选面板」），以及「新建」（打开 NewTaskDialog，确认后若在自由视图则节点落当前取景点/双击点，见 [free-canvas-create.md](free-canvas-create.md)）。过滤只影响当前两视图的可见项，隐藏节点位置仍保留。需要你节点与列视图同口径：未读黄描边+未读点、已读弱化停呼吸；编排会话（`orchestrated`）同样在状态图标右上角出小蓝点。自由视图下面板整体是一块**可平移缩放的画布**（Obsidian canvas 式），非归档的顶层工作会话各为一个节点卡片（有 parentSessionId 的子孙代理不进入节点、aliveIds 或 zones，与状态视图/探出提醒同一口径）（宽 248、高度随内容：无备注紧凑约 70，有备注按折行抬高，复用 board-card 视觉：头像/名称/状态点/工作区徽标/胶囊/分支；有备注才显示备注行）。另有便利贴风格的**思路便签**（`layout.stickies`，与卡片备注 `notes` 分开）。

卡片**备注**只存 `layout.notes`（不进会话元数据）。空卡片不显示备注行；右键菜单「添加备注 / 编辑备注 / 清除备注」进入内联编辑（Esc 取消、失焦提交）。有内容才画在卡片底部并按折行抬高（最多 8 行）。

**工作区分区（hull）**：按会话 `workspaceId` 自动分组、实时重算凸包，不做手动编辑、不持久化几何。每个分区对成员卡片四角求凸包，顶点圆角化并外扩约 28px，呈圆滑气泡轮廓；极淡填充 + 工作区名标签（hull 左上，对齐 `.fc-group-label`）。纯背景层（`pointer-events: none`），垫在手动组框之下，不挡卡片/连线/组框/框选/平移缩放。无归属或工作区已不在列表中的会话归入灰色「未分区」hull。拖动卡片不改工作区归属，hull 跟随成员位置。与手动打组互不干涉。

| 手势 | 行为 |
|------|------|
| 滚轮（含触控板 pinch 的 ctrl+wheel） | 以光标为中心缩放（0.3–2.0） |
| 空格按住 + 左键拖动 / 右键拖动空白 | 平移画布（右键拖动后松开不弹菜单） |
| 空白左键拖动 | 框选（shift 累加到已有选集；框选矩形为屏幕系不随 zoom 缩放） |
| 左键拖动节点 | 移动（多选时整组跟手；单击已多选节点不拖动则收拢选集到该节点） |
| ctrl/⌘ + 单击节点 | 加选/减选 |
| 节点四缘悬浮圆点拖到另一节点 | 建连线：拖出圆点 = 起点锚、松手位置最近的目标圆点 = 终点锚（同对去重、禁自环）。旧边无 port 仍按两卡中心自动选边 |
| 节点四缘圆点拖到空白 | 弹出菜单：Fork / 交接 / 思路便签（`ContextMenu` mp-pop）。交接会立刻落一个置灰目标节点，完成后亮起。松手在节点上仍是纯连线；Esc / 点空白 / 拖回源节点取消。详见 [free-canvas-create.md](free-canvas-create.md) |
| 点选连线 | 高亮选中；Delete 删除整条（含标签） |
| 双击连线 | 内联编辑自定义文本（Esc/失焦保存，清空不显示）；fork/交接边另有不可编辑的类型徽标 |
| Ctrl+G / Ctrl+Shift+D | 选中 ≥2 节点打组 / 解散（选中组或含选中成员的组）。解散不用 Ctrl+Shift+G——那是 `globalBoard.toggle` 的 keybindings 目录默认键，KeybindingHost 在 window capture 阶段先吞事件切走看板、画布 bubble 监听收不到（2026-10 由 Ctrl+Shift+G 换键；画布自管键须避开目录默认键） |
| Ctrl+Shift+L / 工具栏「自动布局」 | 一键自动布局（见下节）：按工作区聚簇 + 连线层次重排全部节点与便签，toast 可一次性撤销 |
| Delete / Backspace | 删选中连线、解散选中组、删选中**便签**（**会话节点不参与 Delete**——会话的删除走归档后右键菜单，与列视图同口径） |
| 双击节点 | 跳转会话（sessions.select → reveal，收板语义与列视图一致）；点在备注上不跳。视口 `setPointerCapture` 会重定向原生 dblclick 的 target：跳转实际由两次 pointerup（450ms 内同一会话节点）识别；`onDoubleClick` 按 `elementFromPoint` 真实坐标重新命中分类（否则双击节点会落进空白分支误弹创建面板） |
| 双击便签 | 进入编辑；「发起任务」打开 NewTaskDialog 预填思路全文 |
| 双击空白 | 打开 NewTaskDialog（不预填）；按下后拖动超过位移阈值走框选，不触发新建 |
| 双击组名 | 内联重命名（Enter/失焦提交、Esc 取消） |
| 右键节点 | 会话菜单（重命名/置顶/标记完成/归档/重启/清理 worktree/删除）＋ 自由视图「添加/编辑/清除备注」 |

**对齐吸附（拖拽时）**：被拖 bbox 的左/中/右（上/中/下）对齐其他节点的对应参考线，阈值 6 屏幕像素（世界系 = 6/zoom，各缩放档手感一致），命中即出蓝色虚线参考线并修正落位；同差值并列取先遍历者；已完全对齐（差 0）也算命中并出线（拖拽保持对齐的反馈）。多选拖拽按整体 bbox 吸附。

**悬浮控件**（画布右下，`.fc-ui` 不受手势影响）：自动布局按钮 ＋ 打组/解散分组按钮（按选集使能）＋ 缩放条（− / 百分比点击重置 100% / ＋ / 适配）。左下常驻操作提示一行。首次从空到有（首次铺节点）自动「适配」取景。

## 2. 一键自动布局

工具栏「自动布局」或 **Ctrl+Shift+L**（画布 keydown 自管，未进 keybindings 注册表；目录无同和弦默认键故无冲突。同为自管键的解散组 Ctrl+Shift+D 见手势表注）。核心是 `freeViewGeom.ts` 的 `autoArrange` 纯函数，**必须确定性**（同样输入永远产出同样结果，输出与当前画布位置无关）：

1. **分簇**：会话按 `workspaceId`（BoardPanel 从全量 sessions 传 `zones`，含被过滤隐藏的）聚簇；无归属/工作区已关闭归「未分区」。便签挂连线对端会话所在簇（多数票，平票取第一条边，无连线归未分区）。**跨工作区连线不参与聚簇与分层**，布局后照常绘制。
2. **簇内层次布局**：同簇连线当有向边（左→右），longest-path 分层（DFS 破环：回边不计层，禁死循环）；便签视作图中节点（尺寸 FREE_STICKY_W/H）参与分层；同层**重心法** 4 轮上/下扫掠降交叉（tie-break id 字典序）；同层纵向堆叠（**每张卡自己的高度** + `AUTO_STACK_GAP=20`，相邻底→顶间隙固定，不等高也不会重叠或挤缝）；高度来自 `resolveArrangeHeights`（画布实测优先，过滤隐藏的回落 `nodeHeightOf` 备注+分支估算；**必须全员进表**，不得只遍历 notes）；卡片内部备注/分支行距用的是 FREE_NODE_GAP，两者无关；堆叠后做**纵向居中收敛**——节点朝邻层邻居的中心靠拢（上下各一轮、层内保持次序与间距不重叠、分层内容 min-y 归零），正对的单子节点（如会话→便签）中心对齐后连线水平拉直；层间横距 `AUTO_LAYER_GAP=64`；簇内无连线节点在**簇首（左侧）**按**单列竖排**补位（行距与同层堆叠一致），有层级的分层内容整体排在右侧。
3. **簇包围盒**：用 `workspaceHullOf` 的 bbox（已含 hull 外扩 28px；便签按节点宽 248 估只会更松——渲染出来的会话 hull 必在布局 bbox 之内，相邻气泡永不粘连）。
4. **簇间排布**：按侧栏工作区顺序（BoardPanel 传 `workspaces` 数组序）逐行排布，行宽预算 `AUTO_ARRANGE_ROW_W=3200` 超出换行，簇间距 `AUTO_CLUSTER_GAP=96`（含 hull 标签空间），「未分区」固定垫底。
5. 只改 `nodes`/`stickies` 位置，并按新位置重算每条边的出/入端口朝向（只动 `fromPort`/`toPort`，避免重排后连线打大弯；`from`/`to`/`label`/`kind` 与 groups/notes 一律不动），组框与 hull 布局后照常实时推导。

配套交互：

- **一次性撤销**：执行前快照 nodes+stickies 位置，底部居中 toast「已自动布局」带「撤销」按钮（`usePresence`+`mp-pop` 进出场）；6 秒自动消失，或任何画布按下时提前收起（`.fc-ui` 上的点击不触发）。点击恢复快照位置。画布无通用 undo 栈，此为自建最小实现。
- **过渡动画**：视口临时挂 `.is-arranging`，`.fc-node/.fc-sticky` 只 `transition: transform var(--dur-move) var(--ease-move)`；`MOTION.moveMs+80ms` 兜底摘除，画布 `pointerdown` 提前摘（拖拽绝不能带过渡）。
- **fit 视野**：布局完成后自动适配，口径与缩放条「适配」一致——工作区/面板过滤开启时只居中当前可见内容（+常驻渲染的便签），全选时即全部内容。

## 3. 关键文件

| 文件 | 职责 |
|------|------|
| `panels/FreeCanvas.tsx` + `panels/freeCanvas/` | 画布组件：`FreeCanvas.tsx` 只做 hook 接线与视口骨架；职责模块按画布分层——`types.ts`（对外类型与手势态契约）、`canvasOps.ts`（纯函数：框选命中 `marqueeHits`/`rectHits`、拖拽吸附位移 `dragMovePositions`、同对连线去重 `findDuplicateEdge`）、`cardHeights.ts`（DOM 测高）、`nodeCards.tsx`（会话卡/便签 memo 纯渲染）、`useCanvasMetrics.ts`（集合派生+实测高度+hOf/posOf/rectOf）、`useCanvasEdits.ts`（备注/便签/连线标签/组名编辑态）、`useCanvasSelection.ts`（选集三态+打组/解散/Delete）、`useCanvasCamera.ts`（相机+滚轮）、`useCanvasCreate.ts`（placeSession/拉线菜单/交接事件）、`useCanvasSync.ts`（会话集补位修剪）、`useCanvasArrange.ts`（自动布局+撤销 toast）、`useCanvasKeyboard.ts`（快捷键+Space）、`useCanvasPointer.ts`（视口统一指针手势）、`useCanvasInteractions.ts`（双击分类+右键）、`useCanvasViews.ts`（连线/组框/hull/拉线预览推导）、`CanvasWorld.tsx`/`CanvasControls.tsx`（世界层/屏幕层 JSX）。**事件统一由视口（.fc-viewport）onPointerDown 分类派发**（`closest('[data-fc-handle]')` → 连线（记下 `data-fc-handle` 为 fromPort，落入用 `nearestPort`）；`[data-cnode]` → 节点拖拽；`[data-fc-edge]` → 选中连线；`[data-fcgroup]` → 组拖拽；否则空白 = 平移/框选），节点纯渲染保 memo。备注入口走右键菜单（`FreeCanvasHandle.startNoteEdit`）。分区 hull 垫底（pointer-events 穿透，悬停卡片微高亮对应区）。指针捕获期间 target 失真，手势态（DragState）自带 primaryId/nodeStarts。滚轮是 native 监听（passive:false 才能 preventDefault）；键盘（Space/Delete/Ctrl+G/Ctrl+Shift+D 解散/Ctrl+A/Ctrl+Shift+L）挂 window，`active` 为假（切回状态视图）时全部停用。自动布局：`runAutoArrange`（快照→`autoArrange`→写盘→`.is-arranging` 过渡→fit→撤销 toast） |
| `panels/freeViewGeom.ts` | 纯逻辑：类型与常量、`snapDrag`（吸附）、`autoPlace`（网格贪心补位，行优先 5 列）、`autoArrange`（一键自动布局：聚簇/破环分层/重心法/簇排布，自包含确定性纯函数）、`resolveArrangeHeights`（全员高度表：实测优先、否则备注+分支估算）、`syncLayoutNodes`（补位+修剪，无变化返回 null 防写盘；便签 stickies 保留、会话↔便签边保留）、`fitToRect`（适配，zoom 上限 1）、`nodeHeightOf`/`estimateNoteLines`（备注抬高）、`portAnchor`/`nearestPort`/`edgeAnchors`/`bezierPath`/`bezierMidpoint`（连线几何）、`convexHull`/`offsetConvex`/`roundedHullPath`/`workspaceHullOf`（工作区分区气泡）、`parseFreeViewLayout`（v1 形状校验，`filterActiveWorkspace` / `notes` / `stickies` / 边 port / `label` / `kind` 缺省兼容）。**自包含零导入**——test/free-view.mjs 用 `typescript.transpileModule` 直接转译加载（与 test/board-status.mjs 同法） |
| `panels/freeViewStore.ts` | localStorage 持久化（key `gboard.freeview.v1`），模块级小 store + `useSyncExternalStore`（仿 needsReadStore）；BoardPanel 只订阅 view/filter 选项，画布继续订阅完整布局；写入 300ms 防抖；读取走 `parseFreeViewLayout`，坏数据整体回落空布局 |
| `panels/BoardPanel.tsx` | 接线：`useFreeViewLayout` 取档位与工作区/面板过滤、`freeItems`（过滤后的非归档工作会话）喂画布、`aliveIds`（全量未归档 id，供 sync 补位/修剪——过滤不丢位置）、`allFreeZones`（全量会话→分区归属）与 `workspaceOrder`（侧栏工作区序，自动布局聚簇/排布用）；切换器居中；过滤菜单；两视图 `.xfade-stack.board-view-stack` 常驻保活，以 board-slide 修饰左右平移切换（不淡化），隐藏层 inert/aria-hidden；自由视图下隐藏「归档」按钮、副标题换文案；StatusTicker 两视图共享（探出条语义不变） |
| `styles/board.css` | 末段「自由视图」区：切换器居中/画布视口（点阵底 = radial-gradient，background-position=pan、size=网格×zoom）/节点/把手/连线 SVG（non-scaling-stroke 保恒定屏宽，箭头按 1/zoom 反缩放）/参考线/分区 hull/组框/marquee/工具条/自动布局过渡（`.is-arranging` 只 transition transform）与撤销 toast。token 合规（圆角只用 token/2px，时长只用 --dur-*） |

## 4. 数据流 / 持久化

会话列表仍走全量 `sessions` 广播（hidden 临时会话不在其中，见 [session-model.md](session-model.md)）。画布布局（节点位/连线/分组/相机/视图档/工作区过滤开关/**卡片备注 notes** / **思路便签 stickies**）全在渲染层 localStorage。fork / 交接走新增 IPC，见 [free-canvas-create.md](free-canvas-create.md)。

```text
手势/会话变化 → updateFreeViewLayout（内存 store 即时，localStorage 300ms 防抖）
会话集变化   → syncLayoutNodes(aliveIds)：新会话网格补位、消失会话连带剪连线/分组成员/空组
               便签 stickies 保留；连线两端只要还是活会话或便签就保留
               aliveIds = 全部未归档工作会话（不受工作区/面板过滤影响）
过滤开关     → 只改渲染列表；nodes 位置原样保留，hull 按剩余卡片重算
自动布局     → 快照 nodes+stickies → autoArrange(全量 zones/edges/侧栏序) → 整体替换位置
               → .is-arranging 过渡（moveMs 摘除）→ fit 全部内容 → 撤销 toast（6s）
首次铺节点   → fitToRect 自动取景（一次性；取景框用当前可见卡片）
```

连线锚点：新建边写入 `fromPort`/`toPort`（四缘 `'n'|'e'|'s'|'w'`，对应拖出圆点与松手最近圆点）。旧边缺 port 时仍按两节点中心相对方向自动取相对侧。控制点沿法线伸出（距离自适应、夹在 40–160），`vector-effect: non-scaling-stroke` 使描边与箭头在任何 zoom 下恒定屏幕尺寸。

## 5. 已知边界

- **节点宽固定、高随内容**（宽 248；不再用估算值写死 inline height）。紧凑底约 70，分支/备注/胶囊文案都会把卡撑高；自动布局按画布实测高度堆叠，相邻间隙固定 `AUTO_STACK_GAP`。不支持手动调大小。
- **备注只在画布**：不进会话 IPC / 元数据；入口在右键菜单；会话消失时 `syncLayoutNodes` 一并修剪 notes。
- **会话节点不可 Delete**：删除会话走归档 + 右键（后端仅对已归档放行），画布上 Delete 作用于连线 / 分组 / 便签。
- **思路便签是画布数据**：只在 `stickies`，跨重启持久；与卡片备注 `notes` 不是同一集合。
- **组框不可手动框定大小**：始终由成员 bbox + 边距推导（成员移动即重排）；一个节点同一时刻只属于一个组（打组时先移出原组）。
- **分区 hull 不可编辑**：纯视觉投影，不进 localStorage；无归属/已关闭工作区共用灰色「未分区」。
- **空白右键**不弹菜单（顺手清选集）；右键拖动 = 平移。
- **画布无无限滚动条/小地图**；缩放夹在 0.3–2.0。
- **自动布局只动位置与边端口**：边的 `from/to/label/kind` 与 groups/notes 不动（端口朝向按新位置重算，撤销快照含端口）；手动组 v1 不保证组员相邻（组框照旧推导）；过渡只 transform（连线/hull/组框瞬时到位，不跟随滑移）；连按两次结果一致（确定性纯函数，输出与当前位置无关）；撤销只在 toast 存续期（6s）内有效，此后落盘不可回退。
- 隐藏侧（xfade 不可见）的画布键盘/滚轮手势由 `active` 守卫停用；两视图常驻保活（切换不丢滚动/选集）。
- CDP 自动化注意：合成事件驱动时**虚拟光标不要停在看板浮层上**（触发 `.g-board-peek-catcher:hover` 的动画暂停规则），且窗口被遮挡时合成器动画冻结会卡住 GlobalBoard 相位机——测试脚本需 bringToFront/截图逼帧（nudgeFrames 手法见本机未入库的开发脚本 `.dev-sandbox/free-view-run.mjs`，仓库内不含）。

## 画布容器外观

自由视图外层 board-free-body 与状态列共用 left-pad-x 左右留边（默认 9px），露出与上下栏相同的 surface-frame（与左侧面板同源）；中间整块 fc-viewport 使用与会话内容区同色的 surface-board-column、radius-card 圆角及无外圈的 shadow-tooltip 阴影。仅画布容器有阴影，内部卡片不额外加阴影；上下栏继续共用 64px/28px 高度。

框选矩形 fc-marquee 保留蓝色虚线边，填充使用 12% 蓝色与 transparent 混合，避免实色状态底遮住待选节点；不对整个元素设置 opacity。

操作说明收进左下角圆形问号按钮：默认隐藏，点击切换说明浮层；点击外部或 Escape 关闭，Escape 恢复按钮焦点。浮层使用 usePresence + mp-pop 与现有动画 token，保留原说明内容；fc-ui 隔离画布手势。组件回归位于 test/unit/canvas-help.spec.tsx。

自由画布外层容器共用 --shadow-paper 纸张高光与投影，与状态视图列容器和会话面板同步；内部会话卡、调度卡、便签和交接占位卡保持平面，不叠加纸张投影。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D04-D05.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：看板第二视图——Obsidian canvas 式可平移缩放画布，会话按工作区自动成簇（hull 气泡），手动连线/打组/卡片备注/思路便签表达协作关系；一键自动布局按工作区聚簇+连线层次整理。
- 为什么这样设计：布局/备注/便签/连线标签全是渲染层画布数据（localStorage `gboard.freeview.v1`，300ms 防抖），不进会话元数据——会话 IPC 面保持纯净；hull 是纯投影不持久不编辑；自动布局必须是确定性纯函数（连按两次结果一致、输出与当前画布位置无关）+画布实测高度表+6s 一次性撤销 toast；工作区过滤只改渲染列表不修剪节点位置（切换不丢布局）；两视图常驻保活 xfade 切换不重挂载。
- 明确不做：无通用 undo 栈（仅自动布局有 6s 一次性撤销）；无小地图/无限滚动条；缩放夹 0.3–2.0；会话节点不可 Delete（删除走归档+右键，与列视图同口径）；组框不可手动框定大小；备注不进会话元数据、会话消失连带修剪。
- 歧义点：①破坏性操作（Delete 删连线/便签/解散组）无撤销：A=终态接受（数据价值低、重建成本低；review 记 P3 不升级）／B=补最小 undo（Delete 后 toast 撤销，复用自动布局撤销 toast 的现成模式）。推荐 B——删除是静默持久落盘的不可见破坏，且撤销范式已在同一画布内存在、复制成本低。②画布数据（含用户键入的备注/便签/连线标签文本）只存 localStorage：A=终态（与 needsReadStore 同范式；会话本身才是资产，画布组织可重建；X3 review 检查风险面即可）／B=排期迁 userData 文件（键入内容丢失不可接受）。推荐 A——localStorage 常驻 userData 分区随重启保留，风险只剩损坏/清空类小概率；若用户视便签/备注为重要内容则选 B。
