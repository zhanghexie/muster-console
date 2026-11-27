# Worker 创建与任务投递

统一模型入口 sessions.create。省略 task 创建空会话；GUI 任务作为首条聊天消息发送，CLI 任务随启动简报投递。asSubagent=true 从可信调用链绑定直接父。所有模型创建（包括空会话和 Shell）必须显式传 isolation=shared 或 isolated；Shell 仅支持 shared。GUI/PTY 共用来源校验、继承与并发队列。

调度派新任务时通过 `target: {tierId}` 选择工作区档位，或把用户通过 `/harness` 选定的 `target: {targetRef}` 原样转交宿主。Worker 为自己创建指定配置的子代理时同时传 `asSubagent: true`。档位可用成员由宿主按用户设置选择，精确引用校验完整配置与来源版本。已有会话可以继续通过邮箱接收任务。preflight 用于运行时诊断。完整目录通过只读 `host.workers.options` 获取。可在设置的 Agent / Harness 区添加候选。

## 管线

Shell HTTP 工具网关由 Runtime Kernel 的 `host-entrypoints` 域启动。退出时先停止新请求受理并取消活动请求的源 signal，再在会话退休后等待 HTTP close 与已受理 handler 完成；`ShellApiServer.stop()` 是完整异步屏障，不能以发出 `server.close()` 代替宿主工具执行结束。

sessionsHost / 桌面新建任务 → tasks/delegate.delegateTask → 来源/仓库与父子校验 → 统一并发队列 → sessions.createTerminal。GUI 通过 `AgentSessionHost.send` 发送派活契约及完整 `task`，走普通聊天的转写、排队和引擎提交路径，返回 `gui-prompt`、所发送文本的 `briefChars` 及聊天消息 ID。桌面提交显示为用户消息，调度或其他 Worker 委派保留相应来源。CLI 在创建时传入 `initialPrompt`。

### 调度权威与不可逆动作边界

`src/shared/workerBrief.ts` 的英文派活契约随 CLI 任务简报，以及 GUI 委派和 GUI 定时任务的首条聊天消息投递。由本工作区调度直接或经父 Worker 派出的任务，以调度为任务权威：调度可调整范围、验收口径和实现细节；任务疑问发 `host.mail.send to=scheduler`，有父会话时发 `to=parent`，不因这些调整向用户要求确认。合入、推送、发布、修改凭据、删除数据和对外发送仍需用户明确批准；已有用户明确指令和工具权限继续生效。隔离树的 `host.sessions.requestIntegrate` 仍须在用户明确批准之后调用，已有的明确批准不需要重复取得。

通用任务入口也接受桌面直接提交和定时任务，所以文本以“由调度派出时”为条件，不把所有首信都宣称为调度派活。CLI 无任务的 `buildHostIntro` 不含契约；旧版 GUI 首信及已受理消息的恢复沿用原正文和回执，不为追加契约重投。GUI 的契约是实际发送消息的前缀，会进入聊天转写；任务正文与附件处理沿用既有路径。

新派活传 task、isolation 和 target。isolated 省略 isolationGroups 时只隔离 cwd 所属 Git 仓库，无法确定仓库时明确报错；显式 isolationGroups 要求每组给出 rootId、relativePath 和 repoSet（[] 表示仅主仓）。shared 不接受 isolationGroups，dispatch.run 的 isolated delegate 要求显式隔离组。宿主入队时固定来源和隔离范围，出队重验版本与物理身份。并发超限返回队列身份。带路由的会话在注册表写入事务中完成最终校验，提交前失败会回滚本次隔离资源。提交后的投递失败保留原会话 ID 供查验。

兼容创建入口仍接受显式 runtime、模型、权限模式、Pi persona、ACP 产品预设和 CLI 启动选项。父子限同工作区，来源或 Harness 不兼容时清除继承的模型参数。Worker 可通过 `asSubagent: true, inherit: true` 继承当前父会话的兼容设置。「完全访问」的 Muster Core Worker 可以用 `asSubagent: true` 和精确引用在当前来源目录创建不同 Harness 的子会话。宿主提交前复核父会话和权限，目标适配器负责自己的启动权限。已有手工会话及 `creationKey` 恢复保留原 runtime，走原有生命周期。

宿主确认旧回合停止且在途工具已结算后，可给同一逻辑 Worker 切换候选。替换回合携带有界的已知任务进度。首条任务消息、后续回复和工具结果可用 `host.workers.context({})` 查看，沿 `nextBefore` 继续向前分页；单条正文用 `{messageId, bodyOffset}` 和 `nextOffset`。工具只读当前切换后的 Worker 自己的转写。旧版首信和补充信仍从同一邮箱读取。交接保持原目录和父子归属。切到不同 Harness 需要用户在设置中授权目标候选，并由宿主确认实际权限。当前可授权 Codex GUI 候选接替顶层任务。

## 隔离决策指引

模型根据任务选择明确结果，宿主负责执行和安全校验。dirty 是可选策略的线索，不是执行层开关，也不保证冲突或隔离必要性：

可以主动采用原来的「仓库状态策略」：目标仓 dirty 时倾向 isolated，干净时可用 shared。但只读审查、并行写入、是否依赖未提交修改等任务条件优先；模型最终仍提交明确的 shared/isolated，API 不执行该策略。

| 场景 | 选择依据 |
|---|---|
| 只读检查当前检出或未提交修改 | 可选 shared；目录共享本身不强制只读 |
| 独立修改、分别提交验收、并行写入同仓 | 可选 isolated，即使源仓干净 |
| 希望避开他人的在途修改 | 可参考 Git dirty 决定隔离范围 |
| 必须依赖尚未提交的修改 | 先确定如何取得这些改动，新树不自动复制它们 |

不要求每次额外调用预检或填写长篇理由。已有 Git 查询和会话观察可用于判断，信息不足时先核查。桌面新建任务默认共享检出，用户可手动选择隔离，UI 提交最终布尔选择；每次打开默认 GUI 页签，显式切换 CLI 仍可创建 CLI 会话。runs.delegate 同样必须明确 isolation 和隔离范围；工作流 wf.delegate 使用显式 isolate:true/false，执行层不再接收 auto 或省略值。

新建传统 CLI 会话的第一条引擎消息使用 `buildHostIntro` 或任务简报，直接携带宿主身份、上报方式、必要工具指引和当前全局规约。工具参数从注册的 MCP 定义或带会话令牌的 GET MUSTER_TOOL_URL 获取。GUI 与 CLI 的目录快照均合并可读写目录并单列额外只读范围。启动参数或 TTY 回退传递临时文件的读取指令。原生 CLI 自行绘制终端，可能展示读取指令。普通 Shell 不触发 Worker 介绍。GUI 首条引擎输入附加宿主说明；任务首信的聊天转写包含契约前缀及完整任务正文。

工作区初始化仅迁移曾由工作台写入的 `muster` / `metaagent` 及其 `-memory` 成对标记。迁移保留块外原文，只含托管块的空壳文件会被移除。跳过符号链接、硬链接及未闭合的块。新工作区初始化和再次打开均不生成根指令文件。`HOST.md` 和 `HOST-EXT.md` 退出投递路径，升级时只清理匹配旧生成模板的文件。

GUI 首条引擎输入与 CLI 欢迎词和任务简报均附英文回复语言规则。用户指定语言时按要求回复，否则跟随用户最近的自然语言表述。宿主说明、粘贴的引文、代码与工具输出不参与判断。

这些入口共用 `src/shared/workerGuidance.ts` 中的[看板状态判定](board-status.md#3-模型上报第二档)。GUI 在上报工具可用时提供该说明。进度用 notice，发出后继续工作。需要回信用 ask，最终交付用 handoff。挂起回信或事件等待后继续其他工作，参数见注册工具定义。目录范围用 `cwd` 和源根 ID 引用已出现的路径。

已有会话的补充任务、打回、恢复、审阅评论及移动端文本操作用同一邮箱。chat.injectBrief 及旧专用直投工具/handler/IPC 已删除；sessions.message 为常驻寄信入口。UI 的 sessions.sendMessage({sessionId,text}) 返回 stored/messageId，不冒称已执行。正常前台用户对话与附件仍使用原聊天输入入口。

## 宿主连接与身份

CLI Worker 的可信身份由进程启动投递：`MUSTER_HOST=1`、`MUSTER_SHELL_API`、会话绑定的 `MUSTER_STATUS_URL`、`MUSTER_TOOL_URL`、`MUSTER_SESSION_TOKEN`，以及同源 `MUSTER_SELF`。已接入 MCP 的引擎优先使用交付的宿主工具；HTTP 回退用会话 Bearer 对 `MUSTER_TOOL_URL` 发 GET，获取与 PTY 工具投影同源的名称、说明和参数 schema，再向同一 URL POST 调用。状态上报使用 `MUSTER_STATUS_URL`。MCP 子进程过滤环境时仍走既有受控 PID 身份表；hooks 的环境传递和 activity 上报保持原链路。

工作区 `.muster/runtime.json` 的生成/刷新辅助函数和 Shell API 工作区遍历已删除。`ensureWorkspaceMetaAgent` 初始化工作区配置及既有种子，不再依赖已启动的 Shell API；启动遍历和项目打开也不读写旧 runtime 文件。旧文件留盘不动并保持 gitignore/安全拒绝规则。userData `shell-api.json` 仍是宿主 HTTP 服务的诊断副本，不能用来替代会话身份。

回归 `test/metaagent-ensure-for-app.mjs` 在隔离 fixture 给旧文件设置文件系统访问陷阱，核对零读取/写入/删除、新项目零生成及无 Shell API 依赖；`test/metaagent-scaffold.mjs` 覆盖脚手架和旧文档迁移，`test/e2e/cli-workspace-context.spec.ts` 覆盖实际 PTY 首条简报及 HTTP 工具发现和调用。

## 归属与安全

共享任务表、trackTask/agentTaskId/任务 locks 已删除。workflow 与 CLI runs 的稳定创建标识保存在普通会话 meta.creationKey，由宿主提供，公开工具不能指定；重启可找回已创建会话。run 的显式交付仍核对会话归属和交付相位，不能以已存信代替 runs.deliver。

工作流 pending 恢复复用同一 creationKey 会话、原 sourceRoot/cwd/runtime 和已有隔离资源，保留首次隔离决定。已受理的 GUI 首条聊天消息复用原 ID 和回执。创建后尚未发消息的 GUI 会话可继续发送；受理结果不明确时不会自动重发。已完成/交验相位保留。[旧版 GUI 首信](session-mailbox.md#gui-旧版首封任务)沿用已有正文和回执。CLI 冷会话通过原 runtime 适配器重启。

## 验证

`test/session-isolation-choice.mjs` 覆盖模型 schema、缺参/旧 auto/错误范围在访问上下文前拒绝、明确选择不读 dirty、队列选择及范围快照；`catalog-tool-schema.mjs` 验证真实模型参数校验；`catalog-public-surface.mjs` 验证真实创建处理器；`delegate-launch.mjs` 覆盖真实派活/邮箱恢复及既有隔离资源复用；`cli-runs.mjs` 验证非法选择不留下预留 Worker 或日志。`workflow-wiring.mjs` / `workflow-runtime.mjs` 验证工作流执行和恢复。

`test/worker-brief.mjs` 和 `test/gui-worker-prompt.mjs` 检查契约内容与任务组合；`test/delegate-launch.mjs` 覆盖 GUI 实际发送、来源、附件、长度及幂等回执，`test/prompt-tasks-manager.mjs` 覆盖定时 GUI 首信。`test/e2e/acp-tool-display.spec.ts` 通过 Electron 和 Qwen ACP 夹具验证首条任务气泡与实际引擎输入。`test/e2e/codex-model-menu.spec.ts` 用本地模型和 Codex app-server 夹具验证 Core Worker 创建隔离子会话，并核对 Codex 原生回合的工作树、模型、思考档与任务正文。`test/worker-routing.mjs` 覆盖权限变化，`test/session-task-worktree-create.mjs` 使用真实 Git 验证注册前拒绝时的回滚。`test/worker-initial-assignment.mjs` 和 `test/gui-host-lifecycle.mjs` 覆盖旧首信的正文续页、原生输入和回执。

worktree 创建/所有权、多仓来源/版本校验、真实文件碰撞、用户验收与合入确认保留，见 [隔离 worktree](isolate-worktree.md)。父对子即时纠偏用 [邮箱 interrupt](session-mailbox.md)；其他低频管理从 [工具发现](tool-discovery.md) 查询。

主要实现：src/main/tasks/delegate.ts、tasks/delegateQueue.ts、capabilities/hosts/{sessions,creation}.ts、messages/{assignment,deliver,transport}.ts、sessions/createTerminal.ts。跨平台进程与提交动作继续由既有 runtime/PTY 适配器处理。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D03.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：统一模型入口 sessions.create（省略 task 创建空会话；提供 task 启动首轮；asSubagent 从可信调用链绑定直接父）；CLI Worker 可信身份经 MUSTER_* env 在进程启动投递。
- 为什么这样设计：所有模型创建必须显式 isolation=shared|isolated（无 auto/默认）——隔离决策交给模型/用户，执行层只做校验与固定（入队固定、出队重验版本与物理身份、不按 dirty 重选）；邮箱保存业务正文，协议长文按路径披露（A5 披露分级）；creationKey 由宿主提供，重启可找回已创建会话。
- 明确不做：dirty 不做执行层开关（isolationPolicy 只服务桌面 precheck/UI 建议）；.muster/runtime.json 生成与 Shell API 工作区遍历已删除（身份只认进程 env）；公开工具不能指定 parentSessionId/creationKey；chat.injectBrief 类旧直投通道已删、统一走 sessions.message。
- 歧义点：「isolation 必填无默认值」是长期 API 纪律，还是未来允许 auto 由执行层按 dirty 决定？A=长期纪律（review 把任何缺省回落当缺陷）／B=未来加 auto。推荐 A——2026-10 刚把 auto 从执行层删除，回退属大方向变更。
