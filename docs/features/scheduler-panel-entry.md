# 调度面板入口与未读回复气泡

> 状态：实现说明（2026-11-08）：调度不再进入全局看板，也不再显示状态胶囊；入口由左栏工作区右侧的未读回复气泡承载。

## 功能职责

每个工作区都有独立的调度对话。左栏工作区行打开单窗。悬停或键盘聚焦工作区标题栏时，加号前的小按钮出现，打开所有工作区的并排对话。以触控为主的设备可直接点按该按钮。调度对话由工作区列表承载，全局看板展示 Worker 会话。

- 调度会话尾部出现真实 assistant 回复后，如果对应面板没有打开，工作区胶囊上的「对话」按钮改为需要用户的黄色；鼠标悬浮工作区行时才显示正文预览卡。预览卡只显示回复内容，不显示 Agent 名称、时间或状态文案。
- 预览卡的横向位置在工作区行右侧，底边始终对齐对应胶囊底边；卡片按正文自然撑高，正文超出视口时在卡片内滚动。工作区名由纵向位置表达，不重复写进卡片。
- 预览卡最大宽度 360px；卡片内容完整显示，靠近窗口底部时向上增长，但底边仍贴着当前工作区胶囊底边。
- 悬浮预览不会改变已读状态；点击预览卡或打开调度对话才写入已读水位。新消息使用稳定 message id 重新触发提醒；打开其他工作区不会清除它们的未读标记。
- 工作区列表折叠时，隐藏工作区的黄色对话按钮随行隐藏；展开后各工作区恢复自己的未读标记。
- 调度状态仍可供主进程唤醒、审批和运行逻辑使用，但不再参与左栏视觉入口或全局看板归列。

## 关键文件与入口

| 文件 | 内容 |
|---|---|
| `src/renderer/src/panels/AgentFloat.tsx` | 工作区栈、折叠状态、面板打开状态、未读水位接线和气泡层入口 |
| `src/renderer/src/panels/SchedulerOverview.tsx` | 工作面级并排视图、可见列已读水位、每列重置、尺寸偏好与整理过渡 |
| `src/renderer/src/panels/SchedulerOverviewResize.tsx` | 每列调整宽高的指针和键盘交互 |
| `src/renderer/src/panels/SchedulerOverviewStatus.tsx` | 面板状态圆点、状态筛选与类型编辑 |
| `src/renderer/src/panels/schedulerOverviewStatuses.ts` | 本机状态类型、工作区标记和筛选偏好 |
| `src/renderer/src/components/FilterCheckbox.tsx` | 调度筛选与全局看板共用的原生复选框行和颜色圆点 |
| `src/renderer/src/panels/SchedulerConversation.tsx` | 单窗和并排列共用的会话视图接线、工作区标识与本地命令 |
| `src/renderer/src/panels/SchedulerReplyBubble.tsx` | 调度历史尾部订阅、正文提取、纵向锚点测量、展开态/折叠态气泡渲染 |
| `src/renderer/src/panels/schedulerReplyRead.ts` | `workspaceId → assistant messageId` 已读水位，存储在 `localStorage` |
| `src/shared/boardReplyPreview.ts` | 提取最后一句正文和稳定 `messageId`，句末表情随正文保留 |
| `src/renderer/src/styles/float.css` | 黄色未读对话按钮、调度面板磨砂遮罩、悬浮正文卡和 reduced-motion/presence 视觉规则 |
| `src/renderer/src/panels/BoardPanel.tsx` | 只渲染 Worker 会话；不再创建调度卡 |
| `test/unit/agent-ws-scheduler-entry.spec.tsx` | 正文-only、纵向位置、折叠汇总和点击展开回归 |
| `test/unit/board-scheduler-entry.spec.tsx` | 看板不再生成调度卡和调度胶囊回归 |
| `test/unit/scheduler-overview.spec.tsx` / `test/e2e/scheduler-overview.spec.ts` | 开合反转、草稿恢复、状态标记与筛选、尺寸调整、整理中间帧和实际调度 IPC |

## 数据流

```
workspaces（store）
  └─ useSchedulerReplySnapshots
       ├─ getOrchestratorSurface(wsId) / ensureOrchestratorHistory(wsId)
       ├─ agent:history / agent:message / agent:token → 最新 assistant 正文 + messageId
       └─ schedulerReplyRead（localStorage 水位）→ unreadReplyIds

unreadReplyIds + WorkspaceStackItem（工作区行 DOM）
  └─ 未读时将工作区行右侧「对话」按钮改为需要用户的黄色
       └─ hover → SchedulerReplyPreviewCard（正文-only，mp-pop）

点击正文气泡 → openScheduler(wsId) → AgentFloat 面板打开 → markRead(wsId, messageId)
```

`getOrchestratorSurface` 只保留调度尾部所需的历史窗口；气泡不读取全量转写，也不把调度消息写入 `SessionMeta`。历史或 IPC 暂时不可用时，不显示伪造提醒，连接恢复后由 surface 更新触发重算。

## 调度面板与记忆子系统

单窗由 `AgentFloat` 管理，使用 `usePresenceValue(chatWorkspaceId)` 驱动可打断的开合。顶栏的记忆子系统与安全子系统覆盖当前对话正文，手机入口打开当前工作区的应用。记忆视图复用 `ChatSurface` 转写和纯文本输入，按 workspace/purpose/generation 隔离草稿与阅读位置。

重置继续使用 `ChatResetDialog`、`usePresenceValue`、`mp-panel/mp-scrim`；确认后才清空当前调度对话，记忆提示词只追加到草稿，不自动发送。

### 并排对话

- 每个已打开的工作区按左栏自定义顺序显示一列。整行能放下时居中，溢出时从首列起横向滚动。各列转写独立纵向滚动。初次展开把当前单窗或活动工作区带入视口。
- 每列默认宽度约为并排区域可用宽度的四分之一，常规窗口最低 448px，窄窗口内缩至能显示整列。默认高度占满可用高度，各列底边对齐。拖动一列右上角，或聚焦该处使用方向键，可独立调整宽高。拖动期间只更新该列槽位的布局，松手按 `workspaceId` 保存调整过的轴。顶栏的并排布局图标执行「整理」，各列平滑移动并恢复统一的自适应尺寸。会话与草稿保留，减少动态效果时立即复位。
- 每列标题栏的圆点标记工作区的手动状态，预置待处理、进行中、已完成、阻塞及未标记。悬浮、点击或键盘聚焦圆点展开一排可选颜色，各色悬浮提示其含义。右上角漏斗按状态多选筛列。筛选隐藏的列保留会话、草稿和尺寸，停止消耗该列的未读回复。
- 筛选弹层支持直接新增、改名、更换颜色和删除状态类型。删除类型会清除使用该类型的标记，相关面板回到未标记。类型、标记和筛选按本机偏好保存，与调度运行状态及发送 IPC 分开。
- 视图覆盖虚拟屏工作面并保留应用顶栏。遮罩与调度单窗、运行监视器共用磨砂材质和退场阶段，会话卡保有实底。macOS 的框色衬底随最后一层遮罩淡出，见 [窗口背景](frame-backdrop.md)。
- 每列使用 `mp-panel` 从左下工作区栏方向平移、缩放并淡入。缩放原点的高度对齐工作区行，折叠行取展开按钮的高度。入场按左栏顺序错峰，收起时各列沿同一路径退回。槽位独立于动画，供横向滚动和可见性测量。退场停止交互，中途重开保留列和当前位置。减少动态效果时即时开合。
- 点击遮罩空白、列间空白或标题栏空白即可收起。一次点按的起点和终点都须落在同一处空白，面板内操作、跨越面板边缘的拖动和取消的触控手势保持展开。右上角按钮与 Esc 也可收起。
- 每列使用对应 workspaceId 的原调度会话、草稿、发信和重置。省略目标的划词插入定向写入活动工作区调度草稿。并排视图使用现有 `chat:*` 与 `agent:*` 链路；打开视图只装配会话，不产生模型调用。
- 至少一半位于横向视口内的列会写入已完成回复的已读水位。收起回到此前显示的单窗或工作台。工作区行仍可打开对应单窗，进入手机、记忆和安全入口。

## 交互与边界

- 气泡只以 assistant 消息为来源，排除 `local`、`host`、用户输入、工具日志和思考片段。
- 单窗打开时仅消费当前工作区的未读。并排视图仅消费达到可见门槛的列的已完成回复。
- 单窗绑定左侧工作页并随虚拟屏胶片移动。可点磨砂遮罩空白关闭单窗，面板和工作区切换入口保持可交互。右侧 Git/文件页激活时，单窗随左页移出视口并移除磨砂遮罩。
- 工作区折叠时隐藏行的黄色「对话」按钮随行隐藏；展开后恢复各行标记。
- 多个悬浮卡不常驻，也不使用独立排序列；卡片只在当前鼠标行旁出现，纵向位置直接取工作区行坐标，窗口缩放、滚动和栈开合时重新测量，不因靠近底部而整卡上移。
- 全局看板仍用于 Worker 会话。调度回复气泡在看板展开时由既有面板层级覆盖策略处理，不生成额外看板卡片。
- `scheduler-status.json` 与 `scheduler:status` 仍服务后台状态语义；它们不再是调度入口的视觉来源。
