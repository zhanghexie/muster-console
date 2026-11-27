# 全局看板（跨工作区会话与代办看板）

## 代办（TODO）：只保存任务，不创建会话

`NewTaskDialog` 的普通新建入口（左栏、看板、服务页、分屏入口）提供「添加代办」。名称和任务正文保留原文、换行及首尾空白，同时保存所选工作区/源目录、GUI 或 CLI、Harness、模型/权限选项与隔离范围。正文或附件至少有一项即可保存，不依赖 Worker 可用、目录预检或模型发现；交接与定时任务编辑不提供此入口。

代办（TODO）是独立数据，不进入 `SessionMeta`、`sessions:changed`、左栏会话树或会话计数，不拉起运行时、不产生提醒或「需要你」通知。状态视图最左侧常驻代办列，随后是进行中、需要你、已完成；归档由面板过滤控制。代办按工作区分组，遵循当前过滤菜单；仅附件的任务也可保存。自由视图把同一集合投影为代办节点，复用布局、拖动、选集、分组、缩放和自动布局，不提供 Fork/交接把手。任务全文保存在独立集合，状态与自由视图的代办卡片正文最多展示两行，溢出显示省略号。

双击状态列卡片或自由节点打开原 `NewTaskDialog`，恢复名称、正文、附件和设置；状态卡片与画布卡片也可聚焦后用 Enter/Space 编辑。「保存代办」更新原 ID；取消不写入；「删除代办」仅删除该代办。点击「开始任务」仍走原派活管线，成功创建会话或进入队列后才移除代办；启动失败保留。若启动已接受但代办清理失败，显示错误并禁用当前弹窗的重复启动，可再点删除代办重试清理。由画布打开后启动的会话沿用代办的落点。

关键文件与数据流：

- `shared/boardTodo.ts`：代办（TODO）与任务表单设置类型；代办不增加看板生命周期枚举。
- `main/boardTodoStore.ts`：`<userData>/board-todos.json`，每次事务先读现有数据，复用 `atomicJson` 原子替换。附件先写入独立的不可变版本文件，再更新代办索引。更新成功或删除后清理旧版本。单条表单元数据限制 256,000 个 JSON 字符。
- `main/ipc/boardTodos.ts` → preload `boardTodos.list/loadAttachments/save/delete` → `boardTodos:changed`：主进程保存成功后通知看板重新读取摘要；编辑代办时凭 ID 和版本取回附件。
- `panels/useBoardTodos.ts`：初次读取、变更订阅、取消过期请求与可见错误；初次读取完成后才挂载画布，避免把尚未读入的代办位置误修剪。
- `panels/BoardPanel.tsx` / `BoardTodoCard.tsx`：状态列、工作区/面板多选过滤、双击编辑与独立卡片；画布传入代办的 `items` / `aliveIds` / `zones`，过滤不会修剪隐藏节点的位置。任务弹窗打开期间暂停画布手势，避免捕获后的双击误触空白新建。
- `components/NewTaskDialog.tsx` / `useWorktreeSelection.ts`：保存/恢复表单、恢复隔离范围；范围失效必须重选才能启动。

自动化证据：`test/unit/new-task-todo.spec.tsx`、`board-todos.spec.tsx`、`node-main/board-todo-store.spec.ts`；真实主进程/预加载桥/渲染链路与进程重启验收为 `test/e2e/board-todos.spec.ts`。均不调用真实模型。历史代办流程在 Windows 上验证过；本次带附件保存及重启恢复已在 macOS Electron 验证。代办不跨机器同步；工作区关闭后保留代办，源目录不可用时可继续保存文本，但启动仍受现有目录校验约束。

> 状态：实现说明（2026-10-27：看板独立主题派生、连续底面与轻卡片间距）；（2026-10-25：已读重提边沿按代码宽口径改写——状态 capsule 任一变化（含仅时间戳）即清已读重提，替换原「重新进入需要你区才是新边沿」表述）；（2026-10-14：标题同行居中切换、卡片字段分层、深浅主题统一列容器与不占布局的滚动条）。
> 代码主入口：`src/renderer/src/panels/GlobalBoard.tsx`、`src/renderer/src/panels/BoardPanel.tsx`  
> 关联：状态推导 `src/shared/boardStatus.ts`（全链路见 `board-status.md`）；样式 `src/renderer/src/styles/board.css`；已读记录 `src/renderer/src/panels/needsReadStore.ts`；第二视图画布 `src/renderer/src/panels/FreeCanvas.tsx`（见 [board-free-view.md](board-free-view.md)）

---

## 1. 功能与入口

状态卡片的会话名内联编辑在 Enter/Escape 前检查原生 `isComposing` 与 `keyCode === 229`，输入法确认或取消候选不提前保存或退出重命名。失焦保存合同不变；组件回归见 `test/unit/frontend-ime-actions.spec.tsx`。

代理邮箱不参与人类待办判定：未答复或未读邮件不产生问题/风险，也不阻止验收与完成归档。`boardReview.ts`、看板与主进程验收守卫只依据真实会话状态、审批和结构化用户输入；通信提示由 [前台信纸动画](session-mailbox.md#前台收发信展示) 承担。

全局看板的会话集合仅展示没有 `parentSessionId` 的工作会话；独立代办集合不参与会话层级判定。子代理和孙代理保留在左栏父子树，不进入状态列（含归档列）、自由视图、布局存活集合与分区、数量统计或「需要你」探出。统一判定为 `shared/boardStatus.ts` 的 `isGlobalBoardSession`，`BoardPanel` 和 `GlobalBoard` 共用；调度 Agent 不进入看板，未读调度回复由左栏纵向对齐气泡承载。父代理的归档/删除由宿主级联覆盖后代，见 [会话树](sessions-dock.md#10-会话树子代理缩进挂父下子代理通用化)。

跨工作区的会话状态看板：**全部工作区**的顶层工作会话按四列（进行中〔工作中 / 等待输出 / 空闲〕 / 需要你 / 已完成 / 归档）展示，按状态列和工作区分组（卡片状态由状态图标表达，见 StatusIcon.tsx；工作中旋转弧与左栏/文本工具共用 IconSpinner + `--spinner-*`（相位由负 animation-delay 对齐），禁止再写第二套 spinner；卡片显示工作中、等待输出及待处理等有区分价值的状态；空闲与已完成胶囊不显示）。`SessionMeta.orchestrated === true` 的会话在状态图标右上角叠小蓝点（没有状态胶囊时改附在头像右上角）（`--blue`，绝对定位不占槽；hover title「由调度编排」）；状态列卡片与自由视图节点共用 `.board-card-orch-dot`。进行中列按工作区归组，通过状态标签突出工作中与等待输出；空闲不显示重复胶囊。归档列是否可见由面板过滤控制；列头可再收起。面板展开与通知探出时共用 28px 底缘状态条，直接透出面板底色，只显示待处理与未读数量；两态共用 `--board-ticker-h`，探出高度 `--peek-h` 引用该 token，不改变底缘留白。

工具栏集中为一行，标题居左，「状态｜自由」切换器几何居中，过滤和新建图标按钮居右。过滤弹层与调度并排视图共用复选框行和浮层材质。工作区行显示复选框和名称。面板行沿用各列的颜色圆点，区分代办、进行中、需要你、已完成和归档。两组可独立多选，分别提供「当前工作区」「全选工作区」和「全选面板」。弹层在可用空间内滚动，Esc 收起后焦点回到过滤图标。工作区范围由过滤按钮的状态表达。

[首次设置的工作台导览](first-run.md)先指向顶栏的「全局看板」，同时介绍鼠标中键和当前 `globalBoard.toggle` 快捷键。快捷键标签通过 `useChordLabel` 跟随用户改绑和平台格式；未绑定时保留中键提示，并引导到「设置 → 快捷键」配置。打开后将提示移至「状态｜自由」切换器，可操作真实视图。离开该导览步骤时收起看板。

切换器沿用控件小圆角和中性明暗反色。左右方向键可切换视图，输入态与看板外焦点由各自控件处理。顶部工具栏固定 60px，两视图共用，窄容器的管理动作横向滚动。「新建」打开 `NewTaskDialog`，可添加代办、派活或打开空会话。若当前在自由视图，新节点落在画布取景点，双击空白时沿用双击点。过滤选择持久在 `freeViewStore`，旧 localStorage 的 `filterActiveWorkspace` 仍兼容为当前工作区筛选。

**工作面与主题**：全局看板外壳、工具栏、列底和底栏共用 `surface-board-column`（直接复用会话区域 `surface-canvas`），外壳描边使用与会话区域同源的 `surface-edge`，不再绑定 App 的 `surface-frame`；状态列保持实底以遮住通知 Beam，但不画独立轮廓或投影，视觉上融入同一工作面。自由画布沿用此底色，不再绘制内层圆角或轮廓，与状态视图一样呈现连续工作面；自由视口取消左右留白，放大后在面板两侧内缘裁切，相机逻辑不变。主题解析器保留会话 canvas 作为看板底色，卡片独立派生：先从已经过工作区染色的 canvas 向主题 ink 轻混（深色 2.5%、浅色 4%），深色卡片再向 ink 混入 4%，浅色卡片向 canvas 回混 85%。`surface-board-card` 不再复用 input。卡片普通边框、轻量 hover/pressed、文字、状态、焦点均由 resolver 配对生成，支持自定义主题与工作区色开关，不新增可编辑主题字段。当前会话以卡片左侧短中性色标记，不改变卡片底色和边框；自由画布的节点选中仍使用 `board-card-border-focus`。未读用标题字重和圆点提示，不再叠黄色整圈边框。

**看板外壳裁切**：Beam 根容器 `.g-board-peek-beam[data-beam]` 使用 `overflow: clip` 覆盖库的 `overflow: hidden`。隐藏自由视图向右平移时会扩大 overflow 范围；允许程序化滚动的 hidden 容器可能被控件聚焦带到右侧，使整个状态页移出视口。clip 保持相同裁切且禁止此类滚动。真实 Electron 用例断言添加代办 后卡片仍在可视区域内。

**布局与列内滚动**：状态视图左右留边与列间距均为 20px，工作区组间距 10px、组内卡片间距 5px，状态列卡片内边距为 10px 11px；列头使用 control 字阶。面板本体不滚，`.board-grid` 行高锁 `minmax(0, 1fr)`，列头固定，工作区组标题随各列内容滚动，归档包装层继续以 flex/min-height:0 传递高度约束。每列按侧栏工作区顺序显示带文件夹标题的轻量分组，组底色与列背景一致，边框使用交互 UI 同源的 `border-subtle` 细描边、无阴影；表头沿用交互 UI 的 raised 底色与细分隔线，按看板密度压至 32px，收起时保留圆角；文件夹和表头统一使用普通圆角，表头半径按外框的 1px 边框内缩，避免顶部角不贴合及 Electron 43 将上圆下直的 superellipse 错绘成斜边；卡片区以 7px 内边距保持少量留白；会话按状态和时间排序。已关闭工作区和未归属会话保留各自分组兜底。分组按钮可折叠、键盘操作，收起时内容立即 inert/aria-hidden，使用 usePresence + acc 支持可打断过渡；各列独立，过滤切换后保留本次打开看板期间的折叠状态，关闭看板后重置。工作区多选过滤后仍显示文件夹，只展示选中工作区对应的组。`BoardColumnScroll.tsx` 隐藏原生滚动条，不再渲染浮动滑块；列内容继续支持滚轮、触控和原生键盘滚动。滚动区域可 Tab 聚焦并带有列名称。列宽不足时仍整排横向滚动。底部共用 28px 状态条。两视图仍使用常驻 xfade + board-slide，transform 过渡、inert/aria-hidden、可打断切换与挂卸逻辑不变；绘制缓冲和 clip-path 保留。

**卡片字段与动作区**：状态列和左侧会话列表共用 `SessionRowContent` 与 `SessionRailContent`：同一行显示状态图标、悬浮时替换为 Harness 图标、会话名及状态胶囊，右侧通过共用的 `SessionRowTools` 显示时间并在悬浮或聚焦时切换为归档按钮；空闲与已完成不重复出文字胶囊，隔离分支以和左侧一致的图标及提示展示。编排角标叠在状态图标位；需要你未读点、维度门红灯、验收说明及风险仍保留。行下方按需显示最近助手正文的最后一句（按句末标点或换行分隔，末尾单独的表情随前一句保留），合并空白，最多保留末尾 240 个 Unicode 字符。预览按卡片宽度换行，最多显示两行，溢出显示省略号，长路径等连续文本可在行内断开；不显示思考、工具日志、用户输入或宿主通知。GUI 会话在正常加载历史和持久化输出时，从已在内存中的消息提取并写入 `SessionMeta.boardReplyPreview`；流式输出沿用现有最多两秒的落盘节流，回合收口立即更新，值未变化时不广播。看板直接读取会话元数据，不读取历史、调用预览 IPC 或按卡片订阅正文事件；清空历史时同步清空字段。旧会话在正常打开并读取最新历史页时按当前规则补齐或刷新预览；翻看旧页不覆盖最新预览。调度会话不属于 SessionMeta，也不渲染到看板。CLI/PTY 没有可可靠分离的正文，本期不显示预览，不拿原始终端日志冒充。卡片不渲染更多按钮、验收或其他看板专属快捷操作；归档与左栏共用组件和确认分流，右键菜单仍可管理会话。

归档卡片显示 worktree 清理中、已清理或有保留项。可从详情打开目录和安全重试，悬浮垃圾桶和右键都先预览永久删除范围。失败时展示具体原因。未登记但仍存在的任务目录可从失败弹窗选择强制删除，经准确路径预览和单独确认后执行。仅从删除会话进入时，强制删除目录后才重新打开会话删除确认。安全检查与保留分支规则见 [隔离 worktree](isolate-worktree.md#4-创建删除与归档收尾)。

待验收卡片右键可选择「验收并合入」或「验收并归档」，提交前显示影响并由主进程重验资格。仅做任务收尾可选择「标记完成并归档」，归档仍按 Git 状态保护未合入成果。

开关途径（顶栏按钮 / 中键 / 快捷键三种触发 + 收起路径）：

- 顶栏设置按钮旁「全局看板」图标钮（`IconBoard`，toggle，`aria-pressed`；2026-10-07 报单①a 由工作区胶囊右侧文字钮改来）；快捷键写在按钮 `title` 悬浮提示里（默认 `Ctrl+Shift+G`，设置里可改）。
- **鼠标中键**：应用内任意位置按下即开 / 关（toggle 语义，看板内点中键也是关）。
- **快捷键** `globalBoard.toggle`（默认 Ctrl+Shift+G）：见 [keybindings.md](keybindings.md)。
- Esc（`overlay.close`，可改绑）、**点面板外空白**收起——点外时若仍有未压制的 needsYou 项则**收回到探出条**（通知还在，全部恢复才彻底消失），否则完全隐藏；探出态点外不响应（提醒不能被顺手点掉）。
- **「需要你」探出**：任一会话进入 needsYou 区后，面板从窗口顶缘探出与普通底栏同高的 28px 薄边，上下轻浮并叠加 Libraries.dev 的 `border-beam` 提醒。底栏与普通态完全共用数量摘要，不轮播具体会话、不直接跳转或标记已读；没有右侧下拉箭头。探出时 `.g-board-peek-trigger` 以透明的原生按钮覆盖整张 sheet，文字、两侧和中间留白等所有露出区域都统一请求展开，支持 Enter/Space；被覆盖的 `.g-board-content` 设 inert/aria-hidden，隐藏卡片与工具栏不可被键盘或指针激活，展开后恢复。顶栏图标、中键和快捷键仍可开关，悬停不会自动展开。面板文字 `user-select: none`，圆角沿用 `--radius-modal` 与全局超椭圆。

  Beam 直接包裹真实 BoardPanel 内容；首次 presence 实际挂载后保留唯一光效外壳与样式，不在应用启动预挂。完整退场后外壳 hidden/inert/aria-hidden，显式 display:none，strength=0 且无装饰循环；BoardPanel 仍按 presence.mounted 挂卸，退场中重开保留原业务状态，完整关闭后销毁业务内容、重开重新初始化。仅在通知探出且 presence 落定后通过 data-board-beam-active 启用装饰，参数集中在 `GlobalBoard.tsx` 的 `PEEK_BEAM_PROPS`：`size=line`、`colorVariant=colorful`、`strength=1`、`brightness=1.4`、`saturation=1.8`、`glowSize=1.5`，底边流动周期取 `MOTION.breathMs * 1.5`（默认 2.7 秒）。通过库的实例 `css` 扩展将光效层横向宽度放大 1.6 倍：根层保存动态 `--beam-w-{id}` 到 `--board-beam-base-width`，描边/内光/光晕继承计算值后乘 `--board-beam-width-scale`，保留原有宽窄变化与位置动画；这调的是光带本身，`glowSize` 仍控制模糊范围。显式固定库 line 默认内部 `borderRadius=16`，禁用 children 自动半径探测，避免卸掉 BoardPanel 后读取 bloom 并重写样式；真实根/伪层/bloom 圆角与裁剪继续由 CSS 继承 `--radius-modal`，不由该内部默认值决定。line 模式不启动库 pulse 专用 JS RAF。为避免 line 自带的白色光芯/中性内阴影被高亮放大后冲淡彩色，描边和柔光使用实例彩色渐变，移除中性内阴影，彩色层倍率为 stroke=3、inner=2.4、bloom=0.6；不靠整体增亮来提高显眼度。这是代码参数，设置页未新增控件。Beam 容器为完整面板内容高度（sheet 内缘），继承整张面板的圆角，光效随整张面板浮动；不再添加空 span 或单独的底栏光效块。只有装饰伪元素/光晕不命中指针，透明触发层在装饰之上；实际内容展开后照常交互。主题通过 `subscribeAppearance/getResolvedAppearance` 跟随应用实际外观，不跟随系统主题猜测。上下浮动采用 `--peek-bob=20px` 和 `--peek-breath=calc(var(--dur-breath) * 1.75)`（默认 3.15 秒），底栏自身高度不变，浮动时整个 sheet 多探出最多 20px（最大露出 48px）。展开、提醒消失或退场立即关闭装饰和全部循环，BoardPanel 保持挂载直到整体 presence 卸载，之后只保留隐藏外壳与样式；hover/focus-visible 同时暂停浮动与 Beam 的流动/边缘/呼吸/闪光与颜色动画，光效淡入仍完成。暂停浮动选择器必须覆盖 bob 动画 shorthand 的优先级；line 根有六条动画，暂停列表的前五项为 paused、最后的淡入为 running。不能用库的 `active=false` 实现暂停（该版本实际会淡出）。减少动态时关闭浮动和 Beam 动画，只隐藏伪元素/光晕，绝不隐藏包住实际内容的 Beam 容器；数量摘要、展开后的面板内容和入口保持可用。开合继续用原 `usePresence` 与 token transition。颜色绘制回归命令 `node test/global-board-beam-color-visual.mjs` 使用真实生产组件、mock IPC、深浅主题及两种宽度，比较三个动画相位与无光效基准的实际像素，断言明显彩色像素占比，并以灰度负控防止仅检查 colorful 配置；同一浏览器用例还验证各层真实圆角跟随 token、完整关闭无内容/焦点/运行动画、重新打开业务子树重建，以及 Beam/style 身份与样式文本全程不变。

  光效层级由低到高为 sheet 底板、Beam 装饰、看板纸面与卡片、透明点击入口。Beam 容器通过 `isolation: isolate` 建立局部层叠上下文，装饰层使用 z-index 0；其内部的 `.board-panel`、`.board-grid`、`.board-free-body` 仅在此容器下透出底板，列纸面、自由画布和会话卡片保留不透明背景，自然遮住经过的彩光，其他 BoardPanel 使用场景的底色不变。`board-beam-color` 视觉回归还对同一动画帧开关光效，逐像素确认露出的列纸面内部完全不变、底板仍有彩色光带。

共享时钟每 5 秒检查一次：无新广播、关闭看板时也能在 90 秒宽限后触发 no_signal 新边沿。

探出的**持续语义**：只要还有**未读**的 needsYou 项目就一直探出——展开、关闭看板都不打断提醒，关闭后若仍有未读项探条自动回来，全部已读才收回；Esc 显式收起后压到下一个新 needsYou 边沿再探出；启动存量不触发（对齐 notify 门闩）。独立磨砂层随展开状态淡入淡出，探条稳定后只显示面板露出的部分，工作台保持可交互。

**「需要你」已读（v1.39，`needsReadStore.ts`；v1.46 卡片观感；v1.49 跳转收口）**：跳转到会话页即视为已读。渲染层入口（左栏 / 看板卡片 / 命令面板 / 会话回放 / 通知历史）一律走 `jumpToSession`（切区成功后先 `markNeedsRead` 再 `sessions.select`，切区失败不算已读）。主进程来源（系统 toast / 通知中心历史点击、`sessions.select`）仍发 `sessions:reveal`，由 **StoreProvider** 的 `subscribeRevealNeedsRead` 兜底——不挂在 App 切页 effect 上（该 effect 依赖 showTerminal，切区重渲会拆监听，通知点击曾因此漏标）。已读影响提醒面（探出条 + 底栏未读数）以及看板列/画布上该卡片的观感（未读=黄描边+未读点+图标呼吸，已读=名称保持正常可读、停呼吸），**不改看板列归属**。列头在未读数 > 0 时另标「N 未读」。**已读重提边沿=宽口径**：处于需要你区的会话只要状态 capsule 刷新（liveStatus.ts/label、phase.value/ts、status、lifecycle、activity.kind **任一变化**，含模型重报同值 phase 带新时间戳）即 `markNeedsUnread` 清掉已读重新提醒——不必「重新进入」需要你区；活跃的 needs_you 会话在跳转看过后，下一拍状态刷新即重新变未读、重上探条/未读数（按代码现状接受，2026-10-25 批复按宽口径定稿；如需「同值新 ts 不算新边沿」须另立项收窄）。`markNeedsUnread` 顺带 `retainNeedsRead` 修剪已离开需要你区的残留 id。底栏在两态均显示数量摘要，未读数只计未读且未搁置项；探出条文案（`peekText`）同样只数未读。已读集合落 `localStorage`（`muster.needs-read.v1`），跨重启保留；**启动探出仍靠 `suppressed` 门闩**（启动存量不探出，与已读是否落盘无关）。详见 [ui-state-persistence.md](ui-state-persistence.md)。

呈现为顶栏下方的居中浮层，高 84vh、顶边 72px。宽度优先 75vw、最小 760px，受窗口两侧各 16px 约束。标题工具栏为 grid `minmax(0,1fr) auto minmax(0,1fr)`：标题居左、状态/自由切换器同行几何居中（两侧列严格等宽），过滤与管理动作统一右对齐，关闭按钮已移除；窄容器内动作横向滚动，固定工具栏高度不变；三列最小 220px，展开归档后在网格内部横向滚动，面板不向外溢出。面板用 `usePresence` + `mp-panel-fly` 保持实底滑动，后方 `mp-scrim` 独立跟随展开状态，两层过渡均可中途反向。探出态与展开态共用待处理/未读数量摘要，底栏高度与内容不随状态变化。

点外关闭用 document `pointerdown` 捕获 + 豁免（AgentFloat 同款）：只认左键；先问 `isInsideOverlay`（portal 浮层根，见 [keybindings.md](keybindings.md)），再豁免 `.g-board-sheet`（面板自身）与 `.modal-mask` / `.app-confirm-mask` / `.new-task-overlay` / `.ctx-menu` / `.quick-open-mask` / `.chrome-gboard-btn`（顶栏切换入口）。外壳和磨砂层透传指针，展开态顶栏仍可点击。点「全局看板」直接切换，点其余顶栏按钮会先关看板再执行。

---

卡片文字：验收摘要使用 caption 字阶（标准 12px）与二级文字色；延期摘要不再降低整行透明度，状态由已有标记表达。浅色语义色与淡底的对比度共用主题阅读守卫。

卡片显示共用会话行和可用的最新助手正文预览；状态列归属由文件夹标题或当前工作区过滤表达，不再重复显示工作区名。标题是可聚焦 button。验收摘要不常显短 ID、不重复标题和分支；summary 准确标为「说明」，label 不冒充测试证据，截断说明保留完整 title。相对时间与左侧会话列表一致，取 lastUsedAt（缺省 createdAt），由时间子组件刷新，不依赖 memo 卡片父级变化。

需要你卡片点击后进入会话处理审批、提问或异常；不在卡片上提供通过、打回、搁置等快捷按钮。批量仅选待验收集合，后端再次校验，已退出且未闭环的会话仍需要处理。

## 2. 关键文件

看板卡片、工具、提示与新建任务弹窗使用共享颜色角色；每个 board-card/raised/overlay 表面及选中态只在自身范围绑定对应前景。当前选择与业务状态分开，中性填充标识选择，状态用共享胶囊表达；自由画布的数据连线与笔记语义继续保留。字体、布局、卡片动作和 presence 流程不因配色迁移改变。

| 文件 | 职责 |
|------|------|
| `src/renderer/src/panels/GlobalBoard.tsx` | usePresence 浮层；needsYou 边沿、启动存量/Esc 压制；探出区域整条点击或键盘展开，隐藏内容 inert |
| `src/renderer/src/panels/globalBoardPeek.ts` | （已删）原探出态悬停唤出判定；随悬停展开一起下线（2026-10-07 报单①b） |
| `src/renderer/src/panels/BoardPanel.tsx` | 状态分桶、工作区筛选和列内折叠分组；只订阅自由视图选项；异步失败可见 |
| `src/renderer/src/panels/BoardColumnScroll.tsx` | 无可见滚动条的原生列内滚动；可聚焦且带列名称 |
| `src/renderer/src/panels/BoardStatusTicker.tsx` / `boardClock.ts` | 两态共用数量摘要，无轮播与会话跳转；单一 5 秒时钟驱动时间与无信号边沿，关闭时仍有效 |
| `src/renderer/src/panels/BoardCard.tsx` | memo 卡片；复用会话行及归档按钮；待验收摘要 `review*` 原始值 prop；`needsUnread` |
| `src/renderer/src/sessionJump.ts` | 跳转会话唯一入口 `jumpToSession` + `subscribeRevealNeedsRead`（主进程 reveal 已读兜底） |
| `src/renderer/src/panels/needsReadStore.ts` | 「需要你」已读记录（模块级小 store + `useSyncExternalStore`）：`markNeedsRead` / `markNeedsUnread`（新边沿）/ `retainNeedsRead`（修剪）；落 `muster.needs-read.v1`；订阅方 GlobalBoard（探出）与 BoardPanel（底栏未读数 + 卡片/列头已读观感） |
| `src/renderer/src/components/ChromeBar.tsx` | 顶栏入口按钮（props `globalBoardOpen` / `onToggleGlobalBoard`） |
| `src/renderer/src/App.tsx` | `globalBoardOpen` state；document 中键监听（挂一次）；`sessions:reveal` 只切页/收板（已读不在此）；渲染 `<GlobalBoard>` |
| `styles/board.css` | `.g-board-overlay` / `.g-board-sheet` + presence transition / `.board-card-ws` 徽标 / `.is-needs-unread` `.is-needs-read` 已读观感 |
| `styles/chrome.css` | `.chrome-gboard*` 入口按钮 |

---

## 3. 数据流 / IPC

Worker 会话复用原通道——store 的 `sessions` 本来就是全量（`sessions:changed` 全量广播，不按工作区过滤）。调度回复由左栏的 `SchedulerReplyBubble` 订阅调度历史；看板默认展示全量 Worker 会话；工作区与面板过滤只在渲染层筛选，不改 IPC、也不修剪自由视图 `nodes` 位置。

点卡片跳转会话（`BoardPanel.select` → `jumpToSession`）：

```text
跨工作区卡片 → switchWorkspace(s.workspaceId)（store，切活动工作区）
            → markNeedsRead(id)（切区成功后、select 前）
            → sessions.select(id)（IPC）
            → main 广播 + 发 sessions:reveal
            → StoreProvider：reveal 再标一次已读（幂等）
            → App：收回全局看板 + showTerminal()
```

同工作区卡片跳过第一步。渲染层跳转（左栏 / 看板卡片 / 命令面板 / 回放）都走 `jumpToSession`；系统通知点击走 main `sessions.select` → reveal → StoreProvider 兜底。验收动作走 `sessions:review` / `sessions:markProcessed`。右键另有「标记已处理」。右键菜单（标记完成〔或取消完成标记〕 / 归档 / 强制重启 / 放弃 worktree / 删除〔仅归档态〕）走 `sessions:setPhase`（source=user）/ `setArchived`（未完成的隔离会话先弹归档确认，见 isolate-worktree.md）/ `respawn` / `close` / `discardWorktree`，与左栏同一套分流逻辑（`useArchiveFlow`）；卡片与左栏共用的归档按钮通过 `archiveFromCard` 查会话后分流。

左上角热区已于 2026-09-25 移除（老是误触；旧实现是盖在窗口左上角的 no-drag L 形 + 驻留 280ms 自动展开，恢复参考 git 历史）。

中键监听：App 挂 `document mousedown`，`e.button === 1` → `preventDefault()`（顺带禁掉中键自动滚动）+ toggle。

**关闭工作区**：会话登记和历史保留，关闭的工作区及会话从看板隐藏。重开原管理目录恢复原工作区身份。启动清理仅移除没有任何已打开或已关闭工作区登记的孤儿。

---

## 4. 与左栏 / 实用功能的关系

项目看板（左栏「实用功能 → 项目看板」、`utility.board` / Ctrl+Shift+B、CenterPanel `'board'` 分支、`BoardPanel` workspace 变体）已移除。会话状态只通过本全局看板查看；当前工作区子集用工具栏过滤菜单（工作区与面板多选，并提供当前工作区、全选工作区、全选面板快捷入口），不要再做一个中栏 utility 面板。

---

## 5. 已知边界

- **扩展面板内中键无效**：扩展面板是沙箱 iframe（无 `allow-same-origin`），iframe 内部事件不冒泡到父文档，该区域内中键不触发开关（浏览器安全限制）。
- **探出入口层级**：`.g-board-peek-trigger` 使用 `--z-overlay`，高于 `board-utility-panel` 的 `--z-sticky`，覆盖浮动时的全部可见区域；内容层保持挂载但 inert，避免隐藏控件被激活。
- **已读语义的边界**：Esc 压制只是暂时不探出，未读项在展开时仍会计入未读摘要（点开看过才算已读）；跨工作区跳转失败（switchWorkspace 被拒）`jumpToSession` 不标已读、也不 select；仅打开看板浏览「需要你」列而不点进会话，探条收起后仍会回来。**搁置**（`reviewDeferred`）的需要你卡片仍在列内，但不进探出提醒与底栏未读计数。
- **层级**：浮层 `z-index: var(--z-menu)`（200，与 QuickOpen 同档）——高于 modal（100）、低于 confirm（300）；确认类弹窗与**新建任务对话框**（`.new-task-overlay` 用 `--z-confirm`）压在看板上。右键菜单 `.ctx-menu` 用 `calc(var(--z-menu) + 1)`，否则与看板同档时 Electron 命中测试会落到 `will-change:transform` 的 sheet 上，菜单看得见但点项等于点外关闭。展开态 overlay 让开顶栏后，点顶栏非「全局看板」按钮会关看板（点外关闭），再执行该按钮。点新建对话框或其通过 `data-overlay-root` 标记的选择器浮层不关看板。
- **原生标题栏命中**：`.g-board-sheet` 必须设置 `-webkit-app-region: no-drag`。通知条位于窗口顶部，覆盖 `.chrome-bar` 的拖动矩形；Electron 原生拖动命中独立于 DOM 层级，只增加透明按钮或提高 z-index 无法排除标题栏吞点击。2026-10-16 在生产组件与 mock IPC 的隔离 Electron 原生窗口中，使用 Windows 真实鼠标对照：移除该声明时中部点击后仍为 peek，加回后相同位置进入 open，未读数保持；`global-board-peek-bob-css.mjs` 守该原生排除规则，组件回归另守整条点击/键盘/已读语义。Chromium/CDP 点击单独通过不能替代这层验证。
- 浮层必须渲染在 **App 根层级**：`.h-strip` 的 `transform` 会劫持内部 fixed 定位的坐标系（同 ContextMenu 的 portal 理由）。

---

## 6. 列表布局

没有工作会话时，进行中列以 `.ui-empty.board-empty` 展示品牌图标与两段引导，按内容自然撑开高度，并保留列内原生滚动。不能复用左栏的 `.session-empty`：该类专用于固定 38px 高的单行占位，会把看板的 56px 图标与多行文字压缩裁切。组件回归见 `test/unit/board-workspace-groups.spec.tsx`，实际几何与裁切由真实 Electron 空看板场景验证。

状态列容器 board-column 不叠加额外内边距，列表内部留白取左侧工作会话列表的 left-pad-x（默认 9px），卡片间距也取相同的 left-pad-x（默认 9px），给内部列表留出呼吸空间。

滚动条横向位置由列表内边距、列容器内边距和 12px 点击轨道共同计算，使 4px 可见滑块位于卡片右缘与容器外缘之间的正中。

列表滚动视口 board-column-body 的留白走自身 padding（左右和下方共用 board-list-inset=left-pad-x）。留白必须在裁切区内：滚动容器沿 padding box 裁切墨迹，外侧 margin 会把卡片投影在 body 边缘切平（底部阴影两端直线截断、侧影消失），padding 方案滚动中位置不变。裁剪圆角为 radius-card 减列表留白。

board-grid 是横向滚动容器，上下与左右各留投影出墨槽（上 8px/下 16px/左右 divider 宽），并用等值负 margin 抵消，列位置不变、阴影有绘制空间；顶部不留槽时列投影会被 scrollport 整条切平。

## 外壳主题色边缘

.g-board-sheet 的边框使用 resolver 派生的 frame-edge，与 surface-frame 配对；启用工作区色时边缘轻染同色，关闭时回中性。列容器仍使用同源 material-rim，不影响焦点/状态边和通知 Beam。验证见 test/global-board-edge-visual.mjs。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D04-D05.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：用户跨工作区俯瞰全部**顶层**工作会话的四列状态板（进行中/需要你/已完成/归档）及独立代办列 +「需要你」探出提醒；点卡片跳会话处理；验收/审批/管理动作的「总览入口」（R-20；阅读现场入口在会话建议胶囊栏）。
- 为什么这样设计：只看顶层工作会话——`isGlobalBoardSession` 统一口径（BoardPanel/GlobalBoard/自由视图/探出/统计全链共用），父子代理走左栏树下钻（2026-10-20 子代理改造定稿）；列归属只认三值 phase+读时推导，不让模型自由文案驱动列；已读语义「跳转到会话页才算已读」（jumpToSession 唯一入口+主进程 reveal 经 StoreProvider 兜底——通知点击曾因挂错 effect 漏标的实证教训）；探出持续语义=还有未读 needsYou 就一直探（Esc 只压制到下一边沿；启动存量门闩对齐 notify）；项目看板 utility 面板已删，会话状态只此一处（用户指令：不要再做中栏 utility 面板）。
- 明确不做：代理邮箱不参与人类待办判定（未答复/未读邮件不产生问题、不阻止验收——D02 定稿）；探出条不轮播具体会话、不直接跳转、不标已读（要看细节必须展开）；子代理不进看板列/自由视图/布局存活集合/统计/探出；左上角热区已删（误触教训）不复活；扩展面板沙箱 iframe 内中键无效（浏览器安全限制）。
- 歧义点：子代理/孙代理不进看板是长期口径吗：A=长期（看板=顶层工作会话全景，层级细节走左栏树；review 不把「看板看不到子代理」当 finding）／B=未来加层级视图（卡片可展开子代理状态）。推荐 A——口径刚于 2026-10-20 统一并全链共用，改口径波及 isGlobalBoardSession 全部消费方。

主题与布局试看验证使用 `node test/board-surfaces-visual.mjs`。测试加载生产 GlobalBoard 与主题发布函数，模拟 IPC，覆盖深浅主题、1920/780 窗口下不同卡片宽度的两行正文、工作区染色、自定义 canvas 种子及切回原主题。截图在 `.tmp/ui-captures/board-surfaces/`。
