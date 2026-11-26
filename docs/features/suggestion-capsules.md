# 建议胶囊与回复补全

## 功能职责

会话输入区展示模型生成的建议回复，点击或 Shift+Tab 只切换灰字预览，Tab 才将选中内容写入草稿，仍由用户编辑和发送。`needs_you` 状态不再在输入区显示会话操作；标记已处理、验收和打回仍可从看板操作。

## 建议回复

- 当 GUI Worker 注册了 `ui.suggestReplies`，首条宿主说明要求在每次面向用户的最终答复前调用一次。可对照 Harness 记录观察压缩前后的工具调用。
- 当前交互式调度、GUI Worker 和 CLI Worker 的模型可通过 `ui.suggestReplies({replies:[...]})` 按需提供 1–3 条表达自然、意思完整的下一条用户消息，每条最多 300 个 UTF-16 单位。宿主按可信会话或工作区身份写入活动 assistant 的 `suggestedReplies` 或当前存活 CLI 会话，规整空白、去重、截至 3 条；无可接收的会话时返回错误。CLI 启动简报提示模型调用工具，已经运行的旧会话需重启或自行发现工具才能获得新提示。模型输出的建议不等于授权，也不触发发送或执行。
- 调度 `askQuestion` 的选项只显示在提问卡，不再写入建议框；待答期间也不显示旧版本随卡保存的建议。单题待答仅在输入单行文本精确命中唯一选项 label 时快捷作答；批注（共用展开协议标识）、自由文本、多行、引用、多题与附件消息均走普通发送，成功受理的用户消息将旧卡结算为「已被新消息取代」并解除工具等待。卡内自定义回答保持不变。待答结算、取消或重启恢复时清理遗留建议。
- 只有当前草稿文本和附件**完全为空**时，输入框显示当前建议的灰字，顶部胶囊显示各候选并允许切换。建议胶囊最多显示 10 个可见字符（按字素簇计数），超出时显示省略号，悬停提示和无障碍名称保留完整内容；窄容器下可能显示更少。灰字不属于编辑器 DOM、草稿、剪贴板或发送内容；点击候选只切换预览，Tab 将其作为可撤销的编辑写入草稿，不自动发送。草稿包括空格或附件时均不显示建议，也不会被覆盖。
- 胶囊显示文本按建议数组缓存，切换选中项不重复分割字素；建议改变后重新计算，完整的草稿和无障碍名称不受影响。
- 建议组右侧的关闭按钮清除该组的全部建议，灰字同步消失；清除不会发送消息、触发验收或回答待答问题，单题待答仍可在输入框精确输入选项作答，其余文字作为新消息发送（即使手动清单非空）。GUI、调度与 CLI 都走 `suggestions:clear`，主进程按目标身份、消息 ID 和建议内容核对当前快照后清理并推送；点击期间出现的新建议不会被旧请求删除。失败时恢复原建议并提示错误。CLI 没有建议后收起态的呼吸提示也随之停止。
- 建议、队列和命令胶囊的上方间距包含在各自的手风琴内容内，关闭时随胶囊一同收缩；窄窗口换行也不依赖卸载时才消失的外层行间距。
- GUI 和调度建议只来自最近一个对话回合，新的用户消息、普通流式生成、失败或中止的回复不复活旧建议。正常回合结束后展示。CLI 暂无统一转写和回合边界，以模型最近一次调用为准，工作台或终端提交新输入时清除旧建议；CLI 工具调用发生时即可显示，不能推断生成是否完成。输入框有多条建议时，Shift+Tab 依次循环切换；只有一条或没有建议时保留普通焦点导航。`/`、`@` 和快捷短语菜单现有 Tab 选择优先；IME 合成期及 Ctrl/Alt/Meta 修饰的 Tab 不触发建议操作。
- 该能力依赖会话模型实际调用工具，不保证模型每次都会给出建议，工具调用可能增加一次模型往返。无工具可用或模型未调用时不显示建议。无头定时任务不开放该工具。当前 GUI/调度链路按现有平台无关接口实现，真实模型与不同引擎仍需分别验证。
- Cursor 走 ACP 宿主 MCP 网关，Ask 模式由 Cursor 原生模式及工作台策略共同约束；建议工具是否被真实模型调用需单独验证。Cursor 自身的 MCP 配置由 CLI 管理。

## 关键文件与数据流

| 位置 | 职责 |
|---|---|
| `src/main/capabilities/catalog/uiAppExtensions.ts`、`hosts/suggestedReplies.ts` | 工具 schema、数量/长度检查及调用者身份绑定 |
| `src/main/agent/orchestrator.ts`、`agentSession/host/agentSessionHost.ts` | 当前工作区/GUI 会话的活动 assistant 写入、推送与持久化 |
| `src/main/agent/injection-registry.ts`、`agent/systemPrompt.ts`、`shared/guiWorkerPrompt.ts`、`shared/workerBrief.ts`、`shared/suggestedReplyGuidance.ts` | 登记并按可用工具面使用共享文案指导模型提供建议 |
| `src/shared/orchestratorAskQuestion.ts` | 调度提问卡挂载、结算与恢复清理 |
| `src/renderer/src/chatSurface/currentSuggestedReplies.ts`、`ChatSurfaceView.tsx` | 按消息和回合状态选择当前建议，投递输入区 |
| `src/renderer/src/components/AgentComposer.tsx`、`agentComposer/ComposerReplySuggestions.tsx`、`agentComposer/useReplySuggestions.ts`、`agentComposer/useComposerSubmit.ts` | 共享胶囊与清除按钮、预览、切换、Tab 接受及调度单题待答发送 |
| `src/renderer/src/components/CliSessionView.tsx`、`src/main/sessions.ts` | CLI 贴边悬浮胶囊与可调尺寸输入区、会话级建议和折叠/草稿状态；有建议时展开图标呼吸提示；发送经 `pty:submitComposer` |
| `src/shared/replySuggestions.ts`、`src/main/ipc/fs.ts`、`agentSession/host/suggestions.ts`、`agent/orchestrator/suggestions.ts` | 当前回合匹配、按身份清除和推送，保留新建议与待答问题 |
| `src/main/agentSession/drivers/acp/{driver,cursor}.ts` | Cursor ACP 模式协商、提问与宿主 MCP 桥接 |

相关回归用例：`test/unit/suggestion-capsules.spec.tsx`、`test/unit/orchestrator-suggested-replies.spec.tsx`、`test/unit/node-main/suggested-replies-host.spec.ts`、`test/unit/node-main/clear-reply-suggestions.spec.ts`、`test/reply-suggestions-visual.mjs`、`test/reply-suggestions-height-visual.mjs` 与 `test/e2e/cli-workspace-context.spec.ts`。高度回归在 Chromium 中逐帧检查胶囊与动作行同步收缩，并装配输入条高度弹簧。这些用例的存在不代表本次已执行；实际验证状态以交付说明为准。
