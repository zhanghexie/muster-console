# 自由画布 · 连线建会话联动

> 状态：实现说明（2026-09-01；2026-09-26 FreeCanvas 按画布职责拆分，行为不变）  
> 代码主入口：`src/renderer/src/panels/FreeCanvas.tsx`、`src/renderer/src/panels/freeCanvas/`、`src/main/canvasLink.ts`（fork / 交接入口）、`src/main/handover/`（历史文档与生命周期）和 `src/shared/forkCapability.ts`
>
> 关联：画布几何与持久化 [board-free-view.md](board-free-view.md)；看板入口 [global-board.md](global-board.md)；hidden 会话 [session-model.md](session-model.md)；GUI fork [gui-worker-session.md](gui-worker-session.md)

---

## 1. 功能职责

自由视图二期：从会话节点四缘圆点拉线落到空白处，弹出菜单三选一——**Fork**、**交接**、**思路便签**。松手在已有节点上仍是纯连线。另有双击空白 / 状态视图「新建」打开 `NewTaskDialog` 落点建会话，以及连线双层标签（类型徽标 + 自定义文本）。

## 2. 关键文件

| 文件 | 职责 |
|------|------|
| `panels/FreeCanvas.tsx` + `panels/freeCanvas/` | 拉线菜单、节点落位；交接快照准备时显示可取消占位，完成后打开新建任务窗口；排队任务的落点由 `useQueuedHandoverPlacement.ts` 等会话出现后恢复 |
| `panels/freeViewGeom.ts` | `FreeEdge.label?` / `kind?`；`FreeSticky`；`stickies` 集合；`parseFreeViewLayout` / `syncLayoutNodes` 兼容与修剪 |
| `panels/BoardPanel.tsx` | 右侧「新建」；`NewTaskDialog`；`placeSession` 落点；`forkSupport` 喂画布 |
| `components/NewTaskDialog.tsx` | 便签任务预填；交接时预填名称，在「本次任务」输入框提示交接信息会自动补充，不展示背景正文 |
| `shared/forkCapability.ts` | 零导入能力矩阵：`gui` / `claude` / `none`；`claudeForkArgv` |
| `main/canvasLink.ts` / `main/handover/` | fork IPC；交接历史快照、文档授权与删除；取消未提交草稿 |
| `main/tasks/delegate.ts` / `main/sessions/createTerminal.ts` | 派活排队保留交接预留会话 ID；目标启动前校验文档并绑定同一 ID |
| `runtime/builtins/scripts/claude-code.mjs` | `mode==='fork'` → `claude --resume <源> --fork-session --session-id <新>` |
| `test/fork-capability.mjs` / `test/free-view.mjs` | 能力矩阵、stickies/label/kind 解析与修剪 |
| `test/canvas-fork-source-config.mjs` / `test/unit/node-main/canvas-fork.spec.ts` / `test/unit/canvas-fork.spec.tsx` | GUI fork 来源配置、画布 IPC 与节点/错误反馈回归 |
| `test/e2e/canvas-fork.spec.ts` | 隔离 Electron 和模拟 DeepSeek ACP：缺少模型目录缓存时 fork 并验证首轮上下文 |
| `test/unit/*handover*.spec.tsx` / `test/unit/node-main/handover-*.spec.ts` / `test/e2e/canvas-handover.spec.ts` | 固定交接信息、历史文档、任务绑定、目录授权、排队与删除 |

画布 fork 和交接 IPC 对可识别的宿主错误按界面语言展示；原始错误、交接文档内容及传给代理的协议不随语言变化。

## 3. 拉线到空白

视口 `onPointerUp`：`elementFromPoint` 命中 `[data-cnode]` → 纯连线（含便签）。未命中且源是**会话**且拖动超过位移阈值 → 在松手点弹菜单。拖回源节点 / Esc / 点空白取消，悬空线已在 pointerup 清掉。

| 项 | 行为 |
|----|------|
| Fork | 立即后台建可见新会话，继承源 runtime/workspace/cwd；节点落松手点；名 = 源名 +「 ·fork」；连线 `kind:'fork'`；**不发消息** |
| 交接 | 程序快照源聊天记录到新会话专属文档 → 打开新建任务窗口 → 用户可改名称、选择目标并填写本次任务 → 确认后派活并落画布节点；不再创建 hidden 会话或调用模型生成摘要 |
| 思路便签 | 松手点落 `stickies` 节点并进入编辑；便利贴风格，可拖/双击编辑/Delete |

入口沿用同一能力矩阵；交接只读取历史，不调用 fork：

- GUI（`surface=chat`，包括 MetaAgent Core 和 ACP Harness）→ fork 使用 `AgentSessionHost.forkSession`；原生截点不可用时按引擎能力回放种子或注入 transcript，见 [GUI Worker 会话](gui-worker-session.md#fork从任意消息分叉新会话)
- `claude-code` → fork 使用原生 `--resume --fork-session --session-id`（已核实可用；`CLAUDE_FORK_SESSION_SUPPORTED`）
- `cursor-cli` / `opencode` → 菜单灰置 + tooltip「该类型暂不支持」

空 GUI 会话（无消息）无法走 forkSession：退化为同 runtime 空会话（仍继承预设、权限、模型和参数，不发消息）。GUI fork 复制同源会话的配置时不要求模型目录缓存存在，也不自动启动模型发现；若首轮发送时参数描述不可用且存在参数覆盖或配置，仍需手动刷新。创建期间源配置变化会拒绝发布。

画布 fork 通过内部 sourceSessionId 继承来源根身份；交接草稿捕获源会话所属工作区与源根，任务窗口默认使用该工作区和根。共用树的 fork 保留原 cwd，不取得清理所有权；树/源目录失效拒绝创建或启动。

## 4. 交接

1. `sessions:canvasHandover` 读取 GUI 结构化聊天快照；Claude Code 终端读取其原生 JSONL。GUI 会话忙碌、无历史，或原生记录缺失/损坏时明确报错，不用终端尾部伪装完整历史。
2. 为未来目标预留 UUID，在 `userData/session-handovers/<目标会话ID>/history.md` 写入可得的聊天记录、图片及附件副本；文档头注明来源名称、原会话 ID 和快照时间。正文按原顺序以 `## [用户 #0001]` / `## [助手 #0001]` 标识消息和所属轮次；宿主、调度与代理消息分别标识，不算作用户发言。排队未发送的用户消息保留但不计轮次。原文行首若恰好与消息标题标记相同，使用 Markdown 转义，避免检索时误认成真实标题。
3. 每个工具在原对话位置只显示 `[工具 #0001]` 和名称，记录写入文末 `[工具详情 #0001]` 附录；审批与未匹配的工具结果也保存在附录。GUI 的工具输出和编辑补丁、Claude Code 的工具结果及 `toolUseResult`，在作为 JSON 字符串转义后超过 16 KiB 时截断，首尾各保留不超过 4 KiB 转义后内容，并标明原始大小与省略量（UTF-8 字节）；结构化结果被截断时先转为 JSON 文本。Claude Code 的工具结果不计作用户消息，原生 JSONL 副本另放附录，同样截断工具结果，避免重复保存超长内容。用户和助手消息、工具输入、源会话记录与已有交接快照不受影响。
4. 文档完全生成后计算正文与附录的实际行号，并将源会话 ID、各类消息/轮次/工具数量、文件路径、行号和搜索标记说明组成「交接背景」；有截断时文档头和交接背景也明确提示。准备完成打开 `NewTaskDialog`，默认名称为「源名 ·交接」、默认来源根为源会话的根；界面不展示背景正文，在「本次任务」输入框提示交接信息会自动补充。交接模式不提供「新建空白」，可选择 GUI/CLI、Harness、模型、权限和隔离选项。

准备进行中再次请求交接时显示当前语言的等待提示，不重复创建草稿；交接背景和历史标记仍作为发给接续 Agent 的稳定文本。
5. 用户确认后 `tasks:delegate` 使用主进程保管的交接背景重新组合本次任务，传入预留 ID；排队时保留文档与落点。目标是普通新任务，GUI 走任务邮箱，CLI 走现有首条简报。此步骤只保证宿主接受任务，不代表模型已读完文档。
6. 目标会话目录作为宿主文件工具的只读目录；原生 SDK/CLI 的额外目录参数可能授予该**会话专属目录**写入权限。仅注册 cwd 的 GUI Harness（Cursor 例外）和 CLI 可能受自身沙箱限制，窗口明确提示调整权限或更换引擎。删除目标会话后删除整个交接目录；取消未提交草稿即删除，崩溃/遗弃草稿在后续启动时按 24 小时期限清理，活会话文档不按年龄清理。删除失败向用户通知。

## 5. 思路便签与新建会话

普通 `NewTaskDialog` 也可点「添加 TODO」先保存输入，且不创建会话。画布双击空白或便签发起任务后保存的 TODO 落在指定世界坐标；从便签发起时保留「便签 → TODO」连线。TODO 在状态视图的独立列与自由视图中同源显示；双击重新编辑，后续开始任务成功后移除 TODO。交接模式不提供「添加 TODO」，避免把宿主保管的交接背景丢成普通文本草稿。持久化、错误处理与边界见 [全局看板](global-board.md#todo只保存任务不创建会话)。

便签存 `layout.stickies: { id, x, y, text }[]`，**不占用** `layout.notes`（那是会话卡片内备注）。`syncLayoutNodes` 保留便签与「会话↔便签」边；消失会话仍剪会话端。

「发起任务」打开 `NewTaskDialog` 并把便签文本预填进任务框 → `sessions:delegate`。新节点落便签附近，生成「便签→新会话」连线；便签保留可复用；原「源会话→便签」连线不动。

双击画布空白 → 同一对话框（不预填）。按下后拖动超过位移阈值走框选，不触发双击新建。状态视图头部右侧「新建」同口径（无落点则不调用 `placeSession`）。Esc/取消不落任何东西。

对话框打开时固定活动工作区及源根，任务与空会话均携 workspaceId/rootId/rootsRevision；默认变更不移动草稿。空会话等创建成功才关窗/落节点，失败显示原因并保留输入。派活排队只显示回执、不落尚不存在的会话；出队后的普通节点由会话列表同步，尚不追踪排队任务的便签落点关联。选根/预检与多根隔离边界见 [会话模型](session-model.md)。

## 6. 连线标签

| 层 | 数据 | 显示 |
|----|------|------|
| 类型徽标 | `FreeEdge.kind?: 'fork' \| 'handover'`（仅创建时写入；不存展示文案） | fork / 交接 chip，不可编辑删除 |
| 自定义文本 | `FreeEdge.label?: string` | 双击连线内联编辑（`.fc-group-input` 同款：Esc/失焦保存，清空不显示） |

纯连线与便签连线无类型徽标。选中连线 Delete 仍删整条边。编辑时 `input` 隔离画布快捷键（Delete/Backspace/单键不生效）。旧数据无 `label`/`kind`/`stickies` 缺省兼容。

## 7. 数据流

```text
拉线落空白 → ContextMenu
  Fork      → sessions:canvasFork → createTerminal / forkSession（activate:false）
            → placeSession(id, world, { kind:'fork' })
  交接      → sessions:canvasHandover（程序生成会话专属历史文档）
            → NewTaskDialog（名称 + 本次任务，交接背景自动补充）
            → tasks:delegate（主进程重组固定内容；预留会话 ID）→ placeSession
  便签      → layout.stickies += { x,y,text:'' } → 进入编辑
双击空白 / 新建 / 便签发起 → NewTaskDialog → delegate | sessions:create
            → placeSession（有 world 时）
```

## 8. 已知边界

- 交接快照不包含生成后新增的消息；GUI 仅能导出工作台已保存或当前持有的内容。Claude Code 原生记录不可读或损坏时拒绝；其他终端类型尚无完整历史读取入口。
- 模型可分段读取长文档，但实际读取结果仍受引擎的工具、上下文和沙箱限制；文档存在不等于模型已经读取。
- 用户/助手长消息、工具输入不会截断；特别长的单行内容仍可能超出某些引擎的单行读取限制。
- 便签集合字段名是 `stickies`，避免与卡片备注 `notes` 撞名。
- claude-code 脚本升级依赖 `builtinScriptVersion` bump（当前 6），否则 userData 旧脚本不会被覆盖。
- 看板浮层 `--z-menu`(200) 高于普通 modal(100)。`NewTaskDialog` 遮罩用 `--z-confirm`(300) 才压得住看板；Runtime 下拉 `.c-select-menu` 再 `calc(+1)`。拉线菜单 `.ctx-menu` 用 `calc(var(--z-menu) + 1)`：与看板同档时 Electron 会把点击打到 sheet 上，只关菜单不触发 Fork/交接。新任务的 Harness、隔离和通用选择器均在 portal 根标记 `data-overlay-root`，选择菜单项不会触发看板点外关闭。
- 灰置项（cursor-cli / opencode 的 Fork、交接）用 `aria-disabled` 而非原生 `disabled`，避免点击穿透到画布被当成点外关闭。
- 画布节点 `setPointerCapture` 会吃掉原生 `dblclick`，跳转会话改由两次 `pointerup`（450ms）识别。
- GUI 源会话回合进行中（busy）无法 fork 或交接，需要等待回合结束；Claude Code 的原生历史文件在读取过程中发生变化时，交接会报错并要求重试。
- 快照准备完成后等待用户确认；取消窗口不创建目标，并删除未提交草稿。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D04-D05.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：从画布中的会话派生分支、根据已有聊天历史交接给新任务，或从思路便签发起任务。
- 为什么这样设计：历史由程序保存，不依赖临时模型总结；用户确认目标和本次任务后才派发，固定交接背景由主进程重组；会话删除时同步清理其专属文档。
- 明确边界：GUI busy 源不能 fork/交接；空 GUI 会话可以 fork，但没有历史时不能交接；排队的便签任务仍不追踪落点，排队交接使用预留 ID 恢复落点。
- 歧义点：无（文档冲突已在文件头标注为 DOC 漂移，非待决问题）。
