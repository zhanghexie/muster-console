# 用户待办提醒

## 职责与交互

调度对话、GUI Worker 和 CLI Agent 会话可由 AI 添加需要用户确认、选择或行动的简短事项。输入框底栏有「我的提醒」按钮；仅未完成数量大于零时显示数字，入口始终保留。展开显示待处理、已完成和完成者，用户与 AI 都能完成或重新打开；用户可通过每行的删除按钮删除提醒，AI 工具不提供删除动作。非 CLI 输入区的面板以底栏按钮为锚点向上展开，左边缘与提醒图标对齐，可以覆盖输入区域，不改变输入框尺寸；CLI 使用独立定位宿主，靠近终端边缘时会调整展开方向。CLI 输入区收起时需先展开输入框才能看到按钮。面板使用 `usePresence` / `mp-pop mp-pop-up` 和 `AnimatedDetails`，支持 Esc、外部点击、深浅主题及窄容器。专用记忆整理会话和普通 shell 不挂此入口。

提醒是会话待办，不是定时提醒，也不是审批或问卷。勾选不发送消息、不回答问卷、不授权后续操作，也不自动唤醒模型。AI 可通过工具读取最新状态；提示词要求事项真实解决后才标记完成。读取或写入失败通过窗口 tip 提示，面板提供重试，切会话后的迟到结果不会覆盖新会话。

模型收到的判断规则以回复时机为准。用户明确要求记一项会话待办，或回复后还需要用户选择版本、提供文件、实机验收等，AI 应在当轮回复前用 `add` 记下具体动作。比如只差用户上传签字版时，提醒应写「上传签字版文件」。同一事项继续讨论时复用未完成项，解决后用 `list` 找到对应条目再 `complete`。可选建议、AI 自己能做的步骤及定时通知都跳过。

## 关键文件与数据流

- `src/shared/sessionReminders.ts`：目标、快照和共用的简短模型指引。
- `src/main/sessionReminders/store.ts`：用户数据目录下 `session-reminders.sqlite`，持久化文本、完成者、时间和可用的消息锚点；同一会话内相同的未完成文本去重。作用域与条目标识共同限定更新和单条删除。
- `src/main/sessionReminders/service.ts`：按可信身份解析作用域。GUI/CLI 使用宿主会话 ID；调度使用工作区与当前 Pi 会话文件的散列，切换历史、清空后开始新对话均不会复用旧作用域。冷启动只读调度检查点索引的小型会话文件指针，不为读取提醒创建完整聊天桶或读取消息正文；索引缺失/失效时按调度恢复规则受控重建。无已绑定调度会话时返回空快照。界面更新与删除携带取得列表时的作用域，变更前重新核验，防止切会话期间误写。
- `src/main/sessions.ts` / `src/main/agent/orchestrator/sessions.ts` / `src/main/agentSession/host/sessionOps.ts`：永久删除 GUI/CLI 会话（含子会话）或调度会话时删除其提醒。GUI 清空会话开始新对话时虽然复用宿主会话 ID，也会清空旧提醒并推送刷新；清理失败保留清空标记，阻止继续旧连接。GUI/CLI 删除时清理失败会阻止移除会话；历史遗留记录按最近 200 条已删除会话墓碑在启动时重试清理，并排除仍在册会话。调度会话文件先删除；其待办清理失败时明确返回部分失败，再次调用相同删除操作可重试清理。
- `src/main/capabilities/catalog/sessionReminders.ts` / `hosts/sessionReminders.ts`：公开工具 `host.ui.reminders`（MCP 名 `host_ui_reminders`）映射到内部的 `ui.reminders`，支持 `list`（有界分页）、`add`、`complete`、`reopen`。GUI/CLI 身份来自宿主工具绑定，调度身份来自回合作用域。
- 调度附录与 GUI/CLI 首条宿主说明共用判断规则。GUI 只引用当前连接实际提供的工具名，含引擎所需的 MCP 前缀。CLI 的欢迎词和任务简报都提示在工具可用时调用。无头调度任务隐藏此工具及其指引。模型也能从常驻工具定义读到使用条件和参数；已有提醒的内容按需通过 `list` 读取。注入点登记在 `src/main/agent/injection-registry.ts`。
- `src/main/ipc/sessionReminders.ts` → `src/preload/index.ts`：用户读取、勾选与删除；`sessionReminders:changed` 只广播目标身份，界面重新获取权威快照。AI 工具和用户 IPC 共用持久化服务，但工具没有删除入口。
- `src/renderer/src/components/SessionReminders.tsx` / `styles/session-reminders.css`：输入底栏按钮、浮层面板、完成分组、错误及请求竞态处理。`ChatSurfaceView` 通过 `AgentComposer` 接调度与 GUI；`CliSessionView` 接 CLI，并用 `useCliComposerPlacement` 单独定位提醒面板，以覆盖输入区且不受输入框裁切。消息源可定位时复用转写 `chat-clip:reveal`；源消息不存在时显示不可用。

## 边界与验证

- CLI 原生终端可能重绘且没有可靠的消息 ID，因此 CLI 提醒不提供「查看原消息」。调度历史重新从 Pi 文件重建时消息 ID 可能变化，原消息不在当前转写中时也不能跳转。
- 遗留清理只能识别仍保留的会话墓碑；超出墓碑范围的旧 GUI/CLI 记录和此前已删除的调度会话记录无法从散列反查身份，不会盲目删除。
- 工具定义随连接注册，已启动的引擎可能需要重连才能取得新版定义。已投递的 GUI 首条宿主说明不会在续聊时重发；升级后用新会话验证完整指引。可用「我还没签字，签好后我来上传」检查模型是否主动记录，再用「签字版已经上传」检查原项是否完成。首条提示与工具投影的回归验证在 `test/gui-worker-prompt.mjs`、`test/worker-brief.mjs` 和 `test/unit/node-main/session-reminders.spec.ts`。
- 存储通过 Node SQLite 与 Electron 用户数据目录实现，三平台共用代码；各平台真实运行验证应分别报告。
- `test/unit/node-main/session-reminders.spec.ts` 覆盖持久化、去重、身份绑定、跨会话隔离、调度历史切换与工具投影；`session-reminders-gui-clear.spec.ts` 覆盖 GUI 清空及失败重试；`test/session-reminders-lifecycle.mjs` 覆盖会话级联删除、历史墓碑清理、失败及重试；`test/unit/session-reminders.spec.tsx`、`session-reminders-composer.spec.tsx` 和 `cli-session-view.spec.tsx` 覆盖交互、焦点、推送、异步切换及输入框接线。`test/session-reminders-composer-visual.mjs` 使用生产输入框、终端与浏览器绘制验证窄栏、草稿和 CLI 面板翻转。`test/e2e/session-reminders.spec.ts` 以隔离 Electron 数据目录连接生产工具、SQLite、preload、IPC 和组件；它使用引擎身份夹具，不代表真实云模型验收。
