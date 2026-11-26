# 文档

本目录记录 Muster Console 的功能、设计与开发约定。

阅读路径：根 [README.md](../README.md)（定位 + 速览）→ 本文件**能力地图**（一眼看全功能）→ 对应 `features/*.md`（实现细节）。

## 能力地图（一眼版）

按能力域分组；功能名即链接，详细说明见下方 features 表。

- **演示与录屏**支持搭建独立场景，也可以用已有会话在可操作的工作台里重播回复和工具卡。[本地演示与回放](features/demo-mode.md) · [用真实会话回放聊天](features/session-replay.md)
- **工具入口**：[宿主工具面：常驻直调+域级 run](features/tool-discovery.md)（常驻清单与域级技能文档） · [GitHub Agent 工具](features/pr-loop.md#agent-调用) · [桌面控制基础设施（开发中）](features/desktop-control.md) · [反馈收集与逐条审核](features/feedback.md)
- **会话通信**：[邮箱与宿主唤醒](features/session-mailbox.md)（持久寄信、批量正文、游标续收、打断读信与已读回执） · [会话续接与抢占投递](features/resume-wait.md)（一次性条件、回合边界、抢占与至少一次重投）
- **子代理**：[职业角色与头像](features/subagent-characters.md)（24 个内置头像、宿主轮选、汇报身份）
- **首次使用与工作区**：[首次设置](features/first-run.md)（本机工具、模型、浏览器远程访问、首个工作区和会话） · [工作区管理](features/workspaces.md)（推荐目录、关闭到零工作区、多文件夹） · [分类图标](features/workspace-icons.md)（36 个软件/游戏透明预设）

- **布局与工作台**：[虚拟屏](features/virtual-screen.md) · [专注模式](features/focus-mode.md) · [中央区分屏](features/center-split.md)（Windows 式 Snap、最多三格、网页式整屏显示、扩展 iframe） · [会话栏折叠](features/sessions-dock.md) · [面板栈](features/panel-history.md) · [UI 状态持久化](features/ui-state-persistence.md) · [命令面板](features/command-palette.md) · [统一搜索条](features/search-bar.md) · [快捷键](features/keybindings.md) · [菜单与悬浮提示](features/menus-and-tooltips.md) · [系统托盘](features/tray.md)
- **会话与状态**：[会话模型](features/session-model.md) · [按线索找会话](features/session-search.md) · [通知系统](features/notification-system.md) · [全局看板](features/global-board.md) · [看板自由视图](features/board-free-view.md) · [连线建会话](features/free-canvas-create.md) · [看板状态](features/board-status.md) · [调度面板条目](features/scheduler-panel-entry.md) · [运行时状态流](features/runtime-status.md)（含自定义事件审核） · [证据归集器](features/evidence.md)
- **终端与 Worker**：[终端控制与条件等待](features/terminal-control.md) · [Worker 拉起与简报](features/worker-inject.md) · [隔离 worktree](features/isolate-worktree.md) · [交验前置门](features/dimension-gates.md) · [Shell 环境与 Git Bash 兑底](features/shell-env.md) · [Runtime 可用性预检](features/runtime-preflight.md) · [文本实体识别](features/text-entity-recognition.md) · [大爆炸选词](features/selection-bang.md) · [node-repl 持久代码执行](features/node-repl.md)
- **文件与 Git**：[右侧多标签、双顶栏与分屏](features/right-workspace-tabs.md) · [文件面板](features/files-panel.md) · [全格式预览](features/file-preview.md) · [Git 仓库树](features/git-repo-tree.md) · [Git 操作与同步反馈](features/git-operations.md) · [PR 验收闭环](features/pr-loop.md)
- **加载反馈**：[品牌加载动效](features/brand-loading.md)
- **运行诊断**：[运行监视器](features/process-monitor.md)（Electron/受管进程树、紧凑列表、CPU 条形图与手动 CPU/堆快照）
- **聊天与调度**：[Core 上下文压缩](features/core-context-compression.md) · [ChatSurface 统一合同](features/chat-surface.md) · [聊天转写渲染层](features/chat-transcript.md) · [调度会话存储](features/scheduler-session-storage.md) · [会话内查找](features/chat-find.md) · [会话消息头像](features/chat-message-avatar.md) · [Markdown CJK 强调](features/markdown-cjk-emphasis.md) · [Markdown 数学公式](features/markdown-math.md) · [智能界面（生成式交互 UI）](features/intelligent-ui.md) · [GUI Worker 会话](features/gui-worker-session.md) · [GUI Harness 目录与接入](features/gui-harness-integration.md) · [Runtime Kernel](features/runtime-kernel.md) · [内置 Runtime 与 Harness 接入](features/agent-runtime-registration.md) · [Qwen Code 接入](features/qwen-code.md) · [ACP 通用 driver](features/acp-gui-driver.md) · [Pi 创造模式](features/pi-modes.md) · [后台任务](features/background-tasks.md) · [模型请求窗口](features/model-request-viewer.md) · [Harness 透明模式](features/trajectory-view.md) · [轮次改动与回退](features/turn-checkpoint.md) · [Composer 富输入](features/composer-rich-input.md) · [建议胶囊](features/suggestion-capsules.md) · [排队面板](features/send-queue-panel.md) · [多模态输入](features/multimodal-input.md) · [全局行为规约](features/agent-rules.md) · [触发任务](features/prompt-tasks.md) · [调度事件与守卫](features/orchestrator-events.md) · [调度订阅策略](features/subscription-policy.md) · [脚本工作流](features/dynamic-workflow.md) · [宿主→调度上行消息面](features/orchestrator-uplink-messages.md) · [会话互感与调度观测](features/scheduler-observe.md) · [调度长期记忆](features/scheduler-memory.md) · [调度提示词与注入面](features/scheduler-prompt-injection.md)
- **调度手机应用**：[AI 应用平台](features/agent-apps.md)（待办、提醒、Channel 收件、RSS；兼容旧邮箱和飞书记录，工具与手机共用业务）
- **用户提醒**：[用户待办提醒](features/session-reminders.md)（调度/GUI/CLI 输入框底栏入口，AI 添加、双方完成，按会话持久隔离）
- **安全子系统**：[独立安全审核](features/safety-system.md)（低频业务审批、持续对话与用户规则，日常命令不逐条送审）
- **内置浏览器**：[原生 webview 与后台 DOM 工具](features/builtin-browser.md)（多 AI 分页并行、同页工具修改排队；用户直接使用原生网页）
- **扩展与记忆**：[代码动画扩展](features/code-animation.md) · [扩展工作台](features/extensions.md) · [扩展中心与工作区激活](features/extension-center.md) · [扩展内置图标](features/extension-icons.md) · [扩展创作接口](features/extension-authoring.md) · [扩展 Agent 资源](features/extension-agent-resources.md) · [扩展模型与媒体](features/extension-model-media.md) · [媒体创作台](features/dsh-media-desk.md) · [歸藏设计](features/guizang-design.md) · [中国象棋](features/xiangqi.md) · [五子棋](features/gomoku.md) · [魔方练习室](features/rubiks-cube.md) · [书房阅读器](features/library-reader.md) · [动态工具 ext.*（已退役）](features/dynamic-tools.md) · [Skills](features/skills.md) · [记忆系统](features/memory-system.md) · [记忆中心面板](features/memory-panel.md)
- **远程与互联**：[外部 Agent CLI](features/cli.md) · [网页访问网关](features/web-access.md) · [手机表面](features/mobile-surface.md) · [多渠道消息接入](features/multi-channel-messaging.md) · [飞书桥退役与 Channel 接入](features/feishu-remote-bridge.md) · [clientMode 契约与租约](features/client-mode-lease.md)
- **模型与设置**：[能力管理](features/capability-management.md) · [模型服务商](features/model-providers.md) · [通用模型参数](features/model-parameters.md) · [Worker 自动派活与候选池](features/worker-routing.md) · [MCP 设置](features/mcp-settings.md) · [CLI 入站 MCP](features/inbound-mcp.md) · [文本工具](features/text-tools.md) · [使用统计](features/usage-stats.md) · [设置页](features/settings.md) · [本机存储](features/local-storage.md) · [表面悬浮层级](features/surface-elevation.md) · [主题系统](features/theme-system.md) · [窗口背景](features/frame-backdrop.md) · [多语言中/英](features/i18n.md)
- **工程基建**：[动画系统](features/animation-system.md) · [产品身份与命名](features/product-identity.md)（身份名纯 ASCII、中文名只做界面展示的硬规矩） · [性能架构](features/performance.md) · [崩溃观测](features/crash-observability.md) · [测试体系](features/testing.md) · [本机产物生命周期](features/tmp-lifecycle.md) · [UI 截图采集](features/ui-capture.md) · [打包](features/packaging.md) · [自动更新](features/auto-update.md) · [IPC 通道与返回值合同](features/ipc-contract.md)

> 新功能落地时：写 `features/<名>.md` 并**在能力地图加一个链接**（规则见文末约定）。

## 功能实现说明（features/）

| 文件 | 说明 |
|------|------|
| [features/gui-harness-integration.md](features/gui-harness-integration.md) | **GUI Harness 目录与接入**：内置和外部 Pi、ACP/MiMo Code/MSP/ZCode、预检、模型、工具网关、进程回收及待验收边界 |
| [features/surface-elevation.md](features/surface-elevation.md) | 表面层级、统一轮廓与投影、裁剪边界及验证范围 |
| [features/first-run.md](features/first-run.md) | **首次设置**：桌面连接设置、跳过后直达入口、在真实工作台建工作区和会话、零工作区恢复 |
| [features/workspaces.md](features/workspaces.md) | **工作区管理**：源根模型/迁移、默认 cwd/固定管理根、路径身份/版本、创建/编辑/激活/关闭、推荐目录与零工作区恢复 |
| [features/demo-mode.md](features/demo-mode.md) | 本地演示场景的搭建、运行副本、序列化回放、删除和项目文件保护 |
| [features/session-replay.md](features/session-replay.md) | 用真实 GUI 会话或本地 JSON 在聊天面板重播流式文字与工具卡，同一素材可反复拍摄 |
| [features/workspace-icons.md](features/workspace-icons.md) | **工作区分类图标**：36 个透明软件/游戏预设，新建/编辑选择、稳定 ID、上传与旧数据兼容、各表面显示和头像取色 |
| [features/virtual-screen.md](features/virtual-screen.md) | **虚拟屏 v2.1**：终端↔Git 横向 VS + Agent 悬浮；Git 仓列表/变更/Diff/轮询刷新 |
| [features/focus-mode.md](features/focus-mode.md) | **专注模式**：分割条长按菜单「专注」落点开关（拖选式，顶栏按钮已删）——虚拟屏临时退出，会话+Git 页双栏并肩恒满全宽（混合手势：短按退出／长按弹菜单／长按拖调 `focusRatio`；快照恢复原布局，跨重启保持；**与侧边栏显隐解耦**） |
| [features/sessions-dock.md](features/sessions-dock.md) | **会话栏折叠/展开**：左上角品牌 logo 即开关（点击开合，悬停显面板折叠/展开箭头），与专注解耦；折叠不占布局、左缘两层热区（48px 检测带→幽灵把手→24px 唤出区）速览、移开 500ms/Escape/选完即走收回；显隐与调度悬浮层（.agent-float）绑定 |
| [features/panel-history.md](features/panel-history.md) | **面板历史**：左侧会话/面板/分屏快照与虚拟屏切页（右页只占一步，上限 20）；右侧撤销与重做（工作区/会话隔离，上限 60），按钮与快捷键各管各侧 |
| [features/ui-state-persistence.md](features/ui-state-persistence.md) | **UI 状态持久化盘点**：需要你已读 + hDock/hiddenView/SplitPane 已落地；批注/树展开待派；中栏实用功能/设置页签/打开文件/命令面板查询已拍板不记 |
| [features/command-palette.md](features/command-palette.md) | **命令面板**：Ctrl+P 分类万能搜（全部/会话/工作区/文件/内容/命令/设置）；默认全部不搜文件/正文；Ctrl+Shift+F 搜所有文件内容 |
| [features/search-bar.md](features/search-bar.md) | **统一搜索条**：胶囊形 SearchBar（图标/placeholder/计数/清空）接入左栏会话列表与 Git 仓库搜索；Esc 清空失焦 |
| [features/keybindings.md](features/keybindings.md) | **快捷键系统**：集中目录、设置页双线查找/改绑、加号菜单自定义跨平台系统快捷操作、弹出层 Esc 栈、实用功能右侧 hint |
| [features/menus-and-tooltips.md](features/menus-and-tooltips.md) | **菜单与悬浮提示**：右键/点击/划词菜单全景清单与条目内容、原生 title 提示密集区、ContextMenu 组件能力边界与待统一项 |
| [features/tray.md](features/tray.md) | **系统托盘与关闭行为**：关闭按钮只隐藏到托盘、退出唯一入口为托盘右键菜单、isQuitting 放行链路、更新就绪时动态「重启并安装更新」菜单项与已知边界 |
| [features/session-model.md](features/session-model.md) | **会话模型**：SessionMeta 投影；hidden 临时会话（不进左栏/看板/不抢 activeId，仅内部 createTerminal） |
| [features/session-search.md](features/session-search.md) | **按线索找会话**：`sessions.search` 按路径/提交/关键词只读 grep 落盘转写；默认当前区，`*`=本机全部区；再 `sessions.observe({sessionId,includeHistory:true})` 读上下文 |
| [features/notification-system.md](features/notification-system.md) | **通知系统与气泡**：系统桌面 toast 是唯一通知出口（应用内通知面板已移除）、通知矩阵与 updateKey 家族、看板翻转推送决策总线（notifyDecision + NotifyBus）、通知偏好设置页、ui:bubble 辨析 |
| [features/global-board.md](features/global-board.md) | **全局看板**：跨工作区会话看板，按工作区和面板多选筛选。筛选弹层与调度并排视图共用样式，需要你卡片区分已读和未读，自由视图见下。 |
| [features/board-free-view.md](features/board-free-view.md) | **全局看板 · 自由视图**：会话画布——平移缩放/节点拖拽对齐吸附/四缘圆点按拖放位置连线/框选打组/卡片按内容撑高；自动布局按实测高度堆叠、间距固定；工作区凸包分区（实时、不持久）；过滤不丢节点位置；拉线空白建会话见下 |
| [features/free-canvas-create.md](features/free-canvas-create.md) | **自由画布 · 连线建会话联动**：拉线空白菜单（fork / 交接 / 思路便签）、会话专属交接历史文档与任务确认、连线标签和新建任务 |
| [features/board-status.md](features/board-status.md) | **看板状态**：模型主动报「需要你」或「完成」，普通对话结束由宿主判空闲；列归属、进度胶囊与终端读屏兜底 |
| [features/scheduler-panel-entry.md](features/scheduler-panel-entry.md) | **调度入口与并排对话**：工作区行打开单窗，栈头展开全部工作区对话，同屏居中或横向滚动；未读回复按工作区显示正文预览；单窗接入手机、记忆与安全子系统 |
| [features/runtime-status.md](features/runtime-status.md) | **运行时状态流与事件订阅**：sessions.observe 查询现态，share.set 发布摘要；events 覆盖事实及注册来源，SQLite 保留 72 小时、按订阅位点重放与分页读取，支持邮箱通知和事件任务；自定义事件仍须审核 |
| [features/evidence.md](features/evidence.md) | **证据归集器**：phase 翻转 pty 切片 + bgTasks 构建/测试摘要 + browser 截图（默认关）按会话落 userData/evidence/；索引 json + 7 天滚动清理；会话详情「证据」页时间线回看（T4.5） |
| [features/worker-inject.md](features/worker-inject.md) | **Worker 拉起与简报**：首条引擎输入附加宿主说明；CLI 状态上报和工具发现；工作区旧宿主文档迁移 |
| [features/runtime-preflight.md](features/runtime-preflight.md) | **Runtime 可用性预检**：`sessions.create` 拉起前探测（pty=脚本+CLI 在 PATH；chat=driver 依赖 CLI/配置，不 spawn 引擎），不可用拒绝创建并附「差什么、怎么装」（`force:true` 强创逃生门）；`runtimes.preflight` 只读工具 + 设置页徽标/「检测」按钮；配套空转回合守卫（引擎无输出收口必标错误） |
| [features/isolate-worktree.md](features/isolate-worktree.md) | **隔离 worktree（含多仓隔离组 R-18b）**：Worker 在树里干活；人验收后 `sessions.requestIntegrate` 通知调度，调度合入前经业务审核，人工看板验收直接执行，`approval=auto` 留痕；主仓内有嵌套独立仓（UE 插件场景）时自动发现全部建「嵌套容器」（发现时校验 HEAD/对象健全性，残缺仓跳过告警、全残缺报错；`repoSet` 收窄 + 首次任务信提示），组级合入全或无预检 + 零改动仓过滤 + 逐仓对称 target |
| [features/pr-loop.md](features/pr-loop.md) | **GitHub PR 审查**：Git 页配置和授权 GitHub App，创建 PR、查看 CI、回传 Worker、起草及确认发布。`host.github.run` 提供 Agent 入口，支持签名 Webhook 与可选 Actions 草稿。 |
| [features/terminal-control.md](features/terminal-control.md) | **终端控制**：写入游标、PNG 路径与文本回执、有界文本/静默等待及取消/退出/重启边界 |
| [features/tool-discovery.md](features/tool-discovery.md) | **宿主工具面**：常驻直调、域级 run、技能文档与角色权限。 |
| [features/desktop-control.md](features/desktop-control.md) | **桌面控制基础设施（开发中）**：跨平台 Cua 窗口截图与点击，Windows 和 macOS 另有显示器输入、聚焦及启动 |
| [features/feedback.md](features/feedback.md) | **反馈收集与逐条审核**：调度/Worker 读取历史并由 AI 查重，逐条审核后打开 GitHub 提交，凭标记核对回执 |
| [features/session-mailbox.md](features/session-mailbox.md) | **会话邮箱**：所有 harness 共用寄信/批量收信、稳定游标与长信续页、收件 AI 已读回执、空闲宿主合并唤醒、前台信纸收发动画；等待由 waitFor 负责；无常驻待答卡、不占对话队列、不自动转寄最终回复 |
| [features/shared-agent-tasks.md](features/shared-agent-tasks.md) | **已删除**：共享任务池及存储/状态机/任务锁/强制互验退出；会话和独立运行系统继续保留，旧用户数据不删除 |
| [features/capability-auth.md](features/capability-auth.md) | **已删除**：唯一 collab-tasks scope 随任务系统退出；工具权限、可信身份和用户审批保留 |
| [features/dimension-gates.md](features/dimension-gates.md) | **交验前置门（R-14 一期）**：编排会话 needs_you 时宿主对本次交付改动跑机械维度门（i18n 词条对账 / 动画 token 静态检查），红灯不进「需要你」列 + `sessions.review` passed 硬阻断；逃生门=右键「强制验收（跳过维度门）」+ 验收账本 `dimension-gate-override` 留痕；红灯编排事件通知调度建议打回；手工会话不进门；常规维度靠调度教学 |
| [features/text-entity-recognition.md](features/text-entity-recognition.md) | **文本实体识别**：终端胶囊识屏/划词浮条/会话链接化/爆炸分词共用的 URL/路径/path:line 识别核心（terminalSelectionText 单源；边界模型、引号与空格路径、UNC、localhost→本地文件映射、域名护栏） |
| [features/selection-bang.md](features/selection-bang.md) | **大爆炸选词浮层**：分词点选（单击加选/滑动连选，累加式不互斥、再点移除）、选中态背景标识、拼回有序文本与拖出/复制/发给 Agent 等动作 |
| [features/shell-env.md](features/shell-env.md) | **Shell 环境与 Git Bash 兑底**：设置 → 通用 → 命令行环境显示后台任务选用的 Shell；Windows 支持 Git Bash 路径覆盖、PowerShell 选档及安装引导；GUI Pi 会话合并 shellPath，无 Git Bash 时使用 PowerShell 工具 |
| [features/right-workspace-tabs.md](features/right-workspace-tabs.md) | **右侧工作面**：文件 / 网页 / Git / Diff / 轮次审阅统一标签、双顶栏与最多三格分屏、工作区共享与会话归属、标签固定、预览复用、撤销重做与资源树 |
| [features/files-panel.md](features/files-panel.md) | **文件面板**：文件树（图标即开合指示）、定位当前文件、跨文件搜索、当前文件内查找（快捷键见 keybindings） |
| [features/file-preview.md](features/file-preview.md) | **文件预览（全格式）**：扩展名分类分流（文本/md/html/图片/音视频/PDF/docx/xlsx/csv/pptx/zip/tar/gz）+ 外部文件 muster-ext 只读协议 + 聊天链接类型图标；应用内实测驱动 preview-cdp.mjs |
| [features/code-analysis.md](features/code-analysis.md) | **已删除**：CodeGraph 全链路退出；普通文件编辑与文本搜索保留，旧索引不删除 |
| [features/git-repo-tree.md](features/git-repo-tree.md) | **Git 仓库树与 Worktree**：源目录与仓库共用路径层级，根仓可展开，Git 详情工具栏切换检出 |
| [features/git-operations.md](features/git-operations.md) | **Git 操作与同步反馈**：分区丢弃、错误/未知状态、Stash 恢复警告、紧凑推送回执与远端检查时间/自动检查 |
| [features/chat-surface.md](features/chat-surface.md) | **ChatSurface 统一合同**：调度、GUI Worker、记忆与安全各自适配，共用转写和 AgentComposer；记忆/安全通过 caps 禁用工程能力与额外页签 |
| [features/session-reminders.md](features/session-reminders.md) | **用户待办提醒**：调度/GUI/CLI 输入框底栏入口、身份绑定、按会话 SQLite 持久化与原消息定位边界 |
| [features/chat-transcript.md](features/chat-transcript.md) | **聊天转写渲染层（R-23 一期）**：时间衰减（24h 旧回合归档只读不可展开，缺 ts 回落近期）+ 长转录窗口裁剪（>500 条只挂尾部窗口 + 「加载更早」回填 + 停靠点 reveal 跳转；完整虚拟化留二期）+ contain 登记表（锚点 88px/子块 100px 与回滚开关）+ 流式弹簧揭示与滚动跟随（字符预算/工具整行排队/活目标弹簧贴底，2026-10-30） |
| [features/scheduler-session-storage.md](features/scheduler-session-storage.md) | **调度会话存储**：每 session 一份 SQLite 当前投影、消息/part/tool 分表、分页读取、fork active pointer、24h 完成回合工具载荷归档；Pi 原生会话文件不参与清理 |
| [features/chat-find.md](features/chat-find.md) | **会话内查找**：Ctrl+F 居中浮条搜当前/全部会话 text part；高亮+滚动；与 SearchBar 同视觉 |
| [features/markdown-cjk-emphasis.md](features/markdown-cjk-emphasis.md) | **Markdown CJK 强调兼容**：CommonMark flanking 导致「。**汉字」不加粗；MarkdownBody 解析前定点插 ZWSP、跳过代码、解析后剥净；斜体/删除线一并兼容 |
| [features/markdown-math.md](features/markdown-math.md) | **Markdown 数学公式**：$…$ / $$…$$ 经 remark-math + rehype-katex 渲染；货币误报守卫（首尾空白配对转义）、单行 $$ 按行内、KaTeX 字体随 vite 打包 |
| [features/intelligent-ui.md](features/intelligent-ui.md) | **智能界面（生成式交互 UI）**：统一 `ui.render` HTML 创作入口与 20 个公共组件；离线 D3/Three.js（含 OrbitControls）；声明式计算与定位诊断、分页/虚拟表、日期/级联/树/本地文件导入、步骤/清单、分段选择；GUI 自然高度/主动折叠、CLI 自动打开会话专属 UI 聚合页、共享状态与受控动作、模型公开选择、主题字体同步；旧九型模板已移除 |
| [features/chat-message-avatar.md](features/chat-message-avatar.md) | **会话消息头像**：用户设置 / 调度工作区图标 / 宿主方印 / 跨会话代理职业头像；普通 AI 回复无头像；连续省略、悬浮发送者名、即时偏好与历史身份 |
| [features/subagent-characters.md](features/subagent-characters.md) | **子代理职业角色**：24 张内置头像与名字、宿主轮选分配、创建命名、职业身份及旧汇报历史快照；新通信走宿主邮箱 |
| [features/gui-worker-session.md](features/gui-worker-session.md) | **GUI Worker 会话**：chat surface runtime（Pi/Claude/**Codex（GUI）**/**ACP**，Cursor 走 ACP；DSH 已移除）；AgentSessionHost + driver 合同、权限与审批、路径点击、打包及鉴权探测 |
| [features/agent-runtime-registration.md](features/agent-runtime-registration.md) | **内置 Runtime 与 Harness 接入**：产品目录、内置 CLI 脚本、GUI Driver、ACP 预设与预检 |
| [features/qwen-code.md](features/qwen-code.md) | **Qwen Code 接入**：Qwen CLI/ACP、模型与审批选项、Skills 目录和 `~/.qwen/settings.json` MCP 管理 |
| [features/runtime-kernel.md](features/runtime-kernel.md) | **Runtime Kernel**：域依赖、LifecycleScope、启动失败回收和调度事件泵的首个真实域接入 |
| [features/acp-gui-driver.md](features/acp-gui-driver.md) | **ACP 通用 GUI driver（T5.2）**：JSON-RPC NDJSON over stdio 子集；OpenCode/Gemini 预设；五事件合同；mcpServers 注入宿主工具 |
| [features/pi-modes.md](features/pi-modes.md) | **Pi 创造模式（自定义模式）**：pi 会话 22 个可定制维度全量开放（persona/工具面/思考档/钉模型/硬守卫/回合注入/输入变换/上下文瘦身/自定义扩展/模型循环/piSettings 透传）；内置 creator + modes.* 创作工具落盘即可选；空白期锁语义 |
| [features/agent-apps.md](features/agent-apps.md) | **调度手机应用**：Channel 收发及旧邮箱与飞书迁移、黄色 Lumia/WP UI、工具与人工共用业务、后台通知、应用 SDK 与自制页面 |
| [features/safety-system.md](features/safety-system.md) | **安全子系统**：按工作区持续审核 AI 发起的低频业务操作；审核面板直接复用 AgentComposer/ChatTranscript，文本和工具事件流式可见；可信界面人工操作和可核实的自带资源免审核，规则/记录由后端保留 |
| [features/background-tasks.md](features/background-tasks.md) | **后台任务**：pi 派后台子代理/后台终端/定时唤醒（bgtasks.* 工具）；输入框胶囊 + 上弹面板（子代理视图与主聊天同构无输入条、终端真 xterm 可介入）；完成通知路由（唤醒/引擎前缀摘要） |
| [features/node-repl.md](features/node-repl.md) | **node-repl 持久代码执行（S2.2/T2）**：每会话持久执行内核跑在独立 worker_threads Worker（跨调用 globalThis）；generation 单调防 ABA；超时/取消由主进程 terminate 硬杀并重建上下文（不静默，同步/异步死循环均可杀）；会话关闭/退出释放；工具面 node_repl.js（用户语言 title） |
| [features/core-context-compression.md](features/core-context-compression.md) | **Core 上下文压缩**：已消费结果的原位摘录、跨代检查点和当前分支证据取回 |
| [features/model-request-viewer.md](features/model-request-viewer.md) | **模型请求录制**：Core 会话、扩展 AI 侧栏与调度共用 `/record-requests` 和「录制中」入口，查看实际 HTTP 正文、对照 Core 压缩来源并导出原始请求 ZIP |
| [features/trajectory-view.md](features/trajectory-view.md) | **Harness 透明模式**：通过 GUI 会话顶栏菜单在用户气泡中查看实际发送的文本，按引擎支持显示注入快照、插话、模型调用计量和压缩点 |
| [features/turn-checkpoint.md](features/turn-checkpoint.md) | **轮次文件改动与 checkpoint**：GUI/调度轮末文件卡、悬浮 Diff 与右侧审阅；中断后编辑/发送前询问回退；并行会话同文件冲突静默记录并在回退时说明；可核实归属的文本修改支持回退，内容/文件指纹/活动回合/可写范围校验保留后续修改；shell 和仅有路径的 runtime 事件标明来源未确认。工具边界 checkpoint 元信息继续保留 |
| [features/composer-rich-input.md](features/composer-rich-input.md) | **Composer 富文本输入**：contenteditable 输入核替代 textarea+镜像层，批注/@文件//技能为原子胶囊（整删/跳光标/真 hover）；同步回路、序列化契约不变、粘贴净化与已知边界 |
| [features/suggestion-capsules.md](features/suggestion-capsules.md) | **建议胶囊与回复补全**：GUI、调度和 CLI 模型提供最多 3 条建议回复，空输入框灰字预览、胶囊切换、Tab 接受为草稿；调度提问卡选项不进入建议框 |
| [features/send-queue-panel.md](features/send-queue-panel.md) | **统一排队面板**：输入框上方合并「排队自动发送（busy 队列）」与「手动确认发送」双泳道+分割线；拖拽排序（跨泳道拖=转手动确认）/行内编辑/删除、回车按手动泳道空否分流、「立即」= steer 插话（两表面 sendNow 管道）；原 /tosend 命令已删（存储沿用） |
| [features/multimodal-input.md](features/multimodal-input.md) | **多模态输入（附件链路）**：任意文件粘贴/选择/拖入，原生输入→PDF/PPT 有界页面预览→文字/视频抽帧→路径回退；模型按页/文字/视频区间续读工具，源文件随会话管理、元信息与预算配置 |
| [features/agent-rules.md](features/agent-rules.md) | **全局行为规约**：设置里维护规则，调度提示、GUI 首条引擎输入和 CLI 首条简报 |
| [features/prompt-tasks.md](features/prompt-tasks.md) | **触发任务**：定时任务界面与 AI `automations` 仅管理时间触发任务；事件通知由 `events.subscribe` 管理，旧事件任务和关联订阅启动时清理；仅 terminal（headless 已退役，启动 purge）；会话态字段对齐新建任务弹窗；错过策略 skip/catch-up/confirm；启动与系统唤醒评估错过窗口；keep-awake（powerSaveBlocker，设置可关）；早触发时钟偏差竞态修复 |
| [features/orchestrator-events.md](features/orchestrator-events.md) | **调度事件队列与机械守卫（R1/R3）**：空闲聚合唤醒、无事件不唤醒；心跳/needs_you/补位/脏合入纯规则提醒 |
| [features/subscription-policy.md](features/subscription-policy.md) | **调度订阅策略（C1）**：「哪些事件唤醒调度」改为每工作区声明式规则（wake / digest 顺带 / mute + 不可静音的底线层），调度经 `scheduler.policy.get/set` 自调，合并窗口与守卫阈值可调；facts 与自定义事件统一由 events 订阅，命中存入邮箱，调度即时事件可在归并后原生插话，Worker 按空闲规则提醒 |
| [features/dynamic-workflow.md](features/dynamic-workflow.md) | **脚本工作流**：`.muster/workflows/<名字>/`（WORKFLOW.md + run.mjs）由宿主在 worker 线程执行机械步骤（派活 / 等事件 / 跑命令 / 读文件 / 子工作流），判断经 `wf.ask` 交还调度或直接问用户；自动记账可安全重跑、重启续跑、派活防重复；指纹首次运行需确认；frontmatter `schedule` / `on` 定时·事件触发（仅已信任版本，防连锁/冷却）；调度输入栏旁「工作流」面板（run 卡片答问用户的问题 / 取消可关会话 / 信任）；手动键入 `/workflow-new` 或 `/workflow`+ 调度工具组 `workflow.*`；进度以 kind=workflow 编排事件送达；自带三个示例（互审合入 / 竞品优化 / 夜间测试派修） |
| [features/scheduler-memory.md](features/scheduler-memory.md) | **调度记忆与机械态势**：按需note/remember→专用Pi整理，类型化scheduler知识与全局偏好按1200/800预算刷新，任务召回1600；SITUATION保持宿主30秒节流与冷启动现采；旧整文件写入和压缩自动抽取退休 |
| [features/orchestrator-uplink-messages.md](features/orchestrator-uplink-messages.md) | **宿主→调度上行消息面**：即时通道 + 编排事件 flush 全类型清单、是否 actionable、降噪建议；对照 t-15 审计/事件分级（已落地） |
| [features/scheduler-observe.md](features/scheduler-observe.md) | **会话互感与调度观测**：`sessions.observe` 只读快照；`sessions.observe` 的显式 Git/历史读取与 `llm.quota` 按需读取 Git 判定、上下文与配额观测（剩余额度本地未知） |
| [features/scheduler-prompt-injection.md](features/scheduler-prompt-injection.md) | **调度提示词与注入面（ZCode 移植 R1+R5）**：Catalog 摘要 122 行→组级地图→工具目录寄生（A6：组职责进 pi Available tools 行内标注，system prompt 只留工作流白名单全文+指引）、工具真实参数 schema 注册（A7：命名参数直传+arguments_json 双形态兼容）、stable/dynamic 分段（pi 单 system 消息边界下的段序纪律与 stable 字节不变量）、注入构成/缓存 token 度量字段（数据层，UI 列留待后续） |
| [features/builtin-browser.md](features/builtin-browser.md) | **内置浏览器**：稳定原生 webview、共享登录态、收藏夹和 DevTools；AI 后台语义快照、同步 JS 弹窗、整页截图、容器滚动、坐标点击、指针移动和受控文件赋值；多页并行、同页修改 FIFO；分平台验收见功能文档 |
| [features/code-animation.md](features/code-animation.md) | **代码动画扩展**：341 种高密度风格挑选、静帧参考、作品库与内置浏览器确定性 WebM 渲染 |
| [features/guizang-design.md](features/guizang-design.md) | 歸藏设计：扩展技能、工作流草稿、作品库和语气档案 |
| [features/xiangqi.md](features/xiangqi.md) | **中国象棋**：仿木棋桌、离线人机与同屏对弈、键盘走棋、工作区续局 |
| [features/extensions.md](features/extensions.md) | **扩展工作台**：单宿主源码布局、package catalog、统一创作审核安装、项目绑定、隔离数据、管理页及运行边界 |
| [features/extension-center.md](features/extension-center.md) | **扩展中心与工作区激活**：GitHub 独立索引与版本包、日报离线回退、profile 级安装、工作区独立启用、批量启用、安装校验、更新和安全卸载；发布审核、不可变版本目录与回滚仍按目标合同规划 |
| [features/extension-icons.md](features/extension-icons.md) | **扩展内置图标**：128 个跨平台系统风格预设、稳定 ID、静态资源解析和旧文本图标兼容 |
| [features/daily-report-extension.md](features/daily-report-extension.md) | **工作日报扩展**：日历、日志、日报、待办和派活；面板与 Pi AI 侧边栏共享日报 Domain 工具 |
| [features/extension-source-layout.md](features/extension-source-layout.md) | **扩展 源码布局**：全局扩展单一源码根、项目扩展管理根和作用域解析 |
| [features/extension-agent-resources.md](features/extension-agent-resources.md) | **扩展 Agent 资源**：实例级系统提示词、Skill 和 MCP 资源校验、信任门与释放边界 |
| [features/rubiks-cube.md](features/rubiks-cube.md) | **魔方练习室**：直接拖转、精细 WebGL、公式练习与 AI 仅观察当前局面 |
| [features/gomoku.md](features/gomoku.md) | **五子棋**：Canvas 棋盘、DomainRuntime 对局、三档 AI、提示和本地战绩 |
| [features/library-reader.md](features/library-reader.md) | **书房阅读器**：本地 EPUB/TXT/Markdown、目录、段落恢复、书签和排版 |
| [features/dsh-media-desk.md](features/dsh-media-desk.md) | **媒体创作台**：原版界面、成稿工作室、领域操作、宿主模型与媒体接入、视觉验收边界 |
| [features/extension-model-media.md](features/extension-model-media.md) | **扩展模型与媒体**：多模态模型网关、MediaStore、上传、预览、导出和 reveal |
| [features/extension-domain-runtime.md](features/extension-domain-runtime.md) | **扩展 DomainRuntime 注册层**：实例级 runtime 注册、查询、命令和事件订阅 |
| [features/extension-runtime.md](features/extension-runtime.md) | **扩展 实例运行时编排**：DomainRuntime 与 Agent 资源绑定、共享身份和实例关闭 |
| [features/extension-host.md](features/extension-host.md) | **扩展 Host 与面板实例**：package catalog 到 Pi Agent Session、DomainRuntime 和面板调用的主进程接线 |
| [features/extension-development-trust.md](features/extension-development-trust.md) | **扩展 开发态信任**：一次性/持久信任记录、目录与包指纹绑定和撤销 |
| [features/center-split.md](features/center-split.md) | **中央区分屏与 Snap**：默认隐藏 ⋯、真实内容浮起、Windows 式顶部五预设最多三格；所有分屏内容支持网页式整屏显示与恢复；逻辑引用与物理顺序分离、保留所有现有引用、单目标 frost 预览/松手提交、空格 Assist、窄屏槽位切换；原生来源与方向菜单兼容、异步主选中/iframe 保活及工作区比例偏好 |
| [features/extension-authoring.md](features/extension-authoring.md) | **扩展创作接口**：作用范围、源码与数据位置、草稿/审核、项目重绑定及 SDK |
| [features/dynamic-tools.md](features/dynamic-tools.md) | **动态工具 ext.*（已退役）**：dynamicTools 域与旧清单 tools 声明已移除，替代路径索引 |
| [features/skills.md](features/skills.md) | **Skills**：原文件与多来源发现、逐 CLI 管理链接、GUI/调度具体策略；SDK 菜单/点名/派活加载、同名限定选择、预算与审计 |
| [features/memory-panel.md](features/memory-panel.md) | **记忆中心与记忆对话**：五入口、无人工审批；来源/可选修订/删除与旧route兼容，真实自动事件及profile注入chars/800；调度内底部记忆子系统直接复用 AgentComposer/ChatTranscript，模型跟随 workspace 调度并从输入框切换 |
| [features/memory-system.md](features/memory-system.md) | **按需Pi记忆系统**：可信候选→空资源五工具会话→自动事务准入，冲突暂停/取代、删除同义禁用、800ms已有向量比较、异步召回版本重检；历史ledger-only；当前目录单源，已移除旧库迁移；用户修订直接生效、停用/恢复/撤销及版本保护 |
| [features/web-access.md](features/web-access.md) | **网页访问**：主进程 HTTP+WS 网关（静态页/`/media` 字节路由/token 鉴权）+ 渲染层 `window.api` web shim；浏览器远程会话（终端/GUI 聊天）。心跳半开重连、可靠 send 重发、caps 事件过滤、token 只认 query/Cookie；设置「远程访问」页展示网址/二维码/重新生成 |
| [features/mobile-surface.md](features/mobile-surface.md) | **手机端表面**：Web Access 手机版三级页面栈；needs_you 深链与推送；文本回复统一邮箱存信、GUI 审批卡、PTY 仅回复；文件抽屉 |
| [features/multi-channel-messaging.md](features/multi-channel-messaging.md) | **多渠道消息接入**：工作区 Channels、共享平台来源、手机收发、独立工作台远程授权及 Office 任务；真账号证据分列 |
| [features/feishu-remote-bridge.md](features/feishu-remote-bridge.md) | **旧飞书桥退役**：已移除独立桥、IPC、绑定与推送；飞书统一走 Channel，保留旧手机来源适配及重新接入说明 |
| [features/client-mode-lease.md](features/client-mode-lease.md) | **clientMode 契约与 task-run 租约**：hello 强校验（`desktop-continuous\|web-remote-replayable` × deliveryProfile 严格配对，六类拒绝码）；owner/lease 词表（acquire/release、stream_mirror_gap/owner_lost）与互斥纯函数（他主未过期拒绝、过期 reclaim）；先立契约不实现全链路 relay |
| [features/model-providers.md](features/model-providers.md) | **模型服务商配置**：多服务商、Core 官方端点思考档位自动更新、目录未覆盖时的思考映射与方言、调度 Agent `llm.*` 受控读写 |
| [features/model-parameters.md](features/model-parameters.md) | **通用模型参数**：运行时/模型声明任意档位；显示名称、顺序、合法映射与范围默认配置；会话独立覆盖、忙时冻结、next-turn/reconnect、Pi/Cursor/Codex 与注册 worker 同合同 |
| [features/worker-routing.md](features/worker-routing.md) | **Worker 自动派活与候选池**：全局默认与工作区覆盖、低／中／高／极高与特殊功能、候选顺序、冷却和受控交接、`/harness` 配置胶囊 |
| [features/capability-management.md](features/capability-management.md) | **能力管理（仅设置）**：Skills/MCP/应用能力/宿主接入四分类与 CLI 基础自动配置；技能发现/关联/同名比较、宿主公共技能只读、折叠诊断；MCP 宿主中转与独立握手；从运行真源投影直接工具/域入口/内部动作，角色与暴露筛选、统一设置控件及窄屏详情 |
| [features/mcp-settings.md](features/mcp-settings.md) | **MCP 设置**：全局/项目同名覆盖与宿主中转；Claude/Codex SDK、Cursor ACP 与 CLI 原生配置；连接预算、冷却、断线、stderr、结果截断与 SSE 回落 |
| [features/inbound-mcp.md](features/inbound-mcp.md) | **CLI 入站 stdio MCP**：pty Worker 白名单工具经 MCP 原生发现；启动幂等自动配置、OpenCode V1/V2/JSONC 适配、独立宿主接入页失败告警与重试；HTTP 鉴权查询工具和调用兜底 |
| [features/cli.md](features/cli.md) | **外部 Agent CLI**：安装器注册命令、本机身份／任务闭环、GUI 与终端派活、显式结果、帮助／Schema 与 Skill |
| [features/text-tools.md](features/text-tools.md) | **文本工具**：划词浮条的自定义 AI 功能（内置翻译 + 提示词自定义）；每功能选模型、功能组默认模型、AI 帮写提示词；`textTools:run` IPC |
| [features/usage-stats.md](features/usage-stats.md) | **使用统计**：全局日期范围；新建/活跃会话、能力调用与扩展 LLM 四卡手动下钻；活跃范围跨日去重；能力失败原因与取消详情；计数永久、失败及 LLM 明细各30天/1000条 |
| [features/settings.md](features/settings.md) | **设置页（整窗）**：框上分组导航（常用 / AI / 连接 / 其他）+ 内容页；行式原语（分区卡片 / 开关 / 分段 / 高级折叠）；页内搜索 Ctrl K 跳转闪烁；底部未保存条（撤销 / 保存 Ctrl S，即时生效键不计入）、离开前确认 |
| [features/local-storage.md](features/local-storage.md) | **本机存储**：有界统计、依赖清理和可选建议。其他数据支持按组确认并在启动时清理缓存、统计、采集和提醒等受管资源 |
| [features/theme-system.md](features/theme-system.md) | **主题系统 v2**：色彩主题（内置深/浅 + 自定义），色盘编辑实时预览（JSON 底座）+ 调度 Agent 主题工具 |
| [features/frame-backdrop.md](features/frame-backdrop.md) | **原生框 Mica/Vibrancy 与干净主题色**：Windows 11 22H2+ 整圈框呈现 Mica、macOS 呈现原生 Vibrancy 毛玻璃，关闭主题色时无覆盖、开启时单次叠加 28% 纯工作区色；阅读卡保持实底，所有正式表面无噪点贴图，其余平台回退均匀实色框，旧模板/壁纸保留兼容 |
| [features/i18n.md](features/i18n.md) | **多语言（中/英）**：i18next key=中文原文、跟随系统 + 设置「外观」页切换即时生效、覆盖率对账脚本、迁移规约与不翻边界 |
| [features/animation-system.md](features/animation-system.md) | **动画系统**：motion token（唯一曲线/时长来源，MOTION 同步守卫）、usePresence/usePresenceValue 可打断进出场、mp-panel/mp-pop/xfade（先出后入）/acc 骨架、工作区切换过场状态机、接入清单与克制决策 |
| [features/brand-loading.md](features/brand-loading.md) | 单色品牌环轨：启动占位、发送/停止与复用边界 |
| [features/performance.md](features/performance.md) | **性能架构**：启动两段化（bootWait 骨架）、Git 点击链路（限流/缓存/乐观切换）、主进程轮询降载、渲染层 token 合批、CDP 测试方法 |
| [features/testing.md](features/testing.md) | **测试体系**：日常一分钟目标（有界回归/冒烟）、默认并发 2 与同 checkout 互斥、显式全量一小时/专项三分钟预算、Git 测试钩子默认关闭；真实 Git / Chromium / 静态审计显式专项；三层测试、三套类型检查、覆盖率与回归约定 |
| [features/tmp-lifecycle.md](features/tmp-lifecycle.md) | **本机产物生命周期**。E2E 通过后自动清理，可显式保留验收产物。`npm run clean:tmp` 按时间和数量筛选旧产物，默认预览，`--apply` 移到可恢复的同盘隔离区。白名单保护 `desktop-driver` 与 `ui-captures`。 |
| [features/ui-capture.md](features/ui-capture.md) | **UI 截图采集**：非沙盒启动当前源码、遍历主要页面、生成截图索引与遗漏入口清单 |
| [features/product-identity.md](features/product-identity.md) | **产品身份与命名**：`PRODUCT_NAME`（纯 ASCII 身份名，进 UA/安装器/日志/CLI）与 `PRODUCT_NAME_ZH`（仅界面的「集序」）的分工、禁止中英混排名、中文名进 UA 曾让四类自定义协议全挂的事故、安装器改名代价与存储身份不变的边界 |
| [features/packaging.md](features/packaging.md) | **打包与安装包**：traversal 依赖收集器（packageManager 字段勿删）；依赖归类合同（renderer-only→devDependencies）；asarUnpack 整树解包（0.1.17 起）；0.1.23 死重裁剪（扩展名排除 / electronLanguages / beforePack 裁 @esbuild / claude·codex 平台 vendor）；体积基线与安装慢根因（NSIS+Defender 逐文件）；国内镜像内置（.npmrc registry + package.json config 段二进制镜像，覆盖口径与切源方法见文内） |
| [features/auto-update.md](features/auto-update.md) | **Windows 安装版自动更新**通过 `zhanghexie/muster-console` 的公开 GitHub Releases 提供静默检查、差量下载和重启安装。任务栏、系统通知、托盘及设置「关于」页显示进度和安装状态。 |
| [features/ipc-contract.md](features/ipc-contract.md) | **IPC 通道与返回值合同**：handle() 统一注册入口与通道注册表（web 网关复用、重复注册守卫、失败日志）；返回值合同规范——新通道一律 `{ok,error?}`/可判别联合、禁裸布尔当失败信号、裸布尔与 chat:switchModel 域错位属遗留登记触碰时对齐 |
| [features/crash-observability.md](features/crash-observability.md) | **崩溃观测**：主进程 console 落盘（logs/main.log，1MB 滚 .old）+ render-process-gone 死因落盘 + crashReporter 本地 minidump（不联网）+ 既有渲染层错误上报链路盘点；主窗口滑动窗口限频自动 reload 自愈、超限发原生系统通知；起因=2026-09-25 安装版黑屏排查零痕迹 |

## 方案与计划（plans/）

计划状态和生命周期见[计划索引](plans/README.md)：活跃方案留在 `plans/` 根目录；已有实现证据的方案移入 `plans/implemented/`；待验收、部分实施与待决策方案仍留在活跃区；被取代或取消的方案进入 `plans/archive/`。

## 外部项目与工具调研（research/）

`research/` 只保存外部项目、工具、模型或方案的调研；目录清单见[调研索引](research/README.md)。

- [开源工具的 GitHub PR 审查接入（2026-11-24）](research/github-pr-review-integrations-2026-11-24.md) — T3 Code、DeepSeek Harness、VS Code 和 PR Agent 的认证、PR 评审与事件触发。
- [DeepSeek Harness 插件发布与目录维护（2026-11-19）](research/deepseek-harness-plugin-distribution-2026-11-19.md) — npm/Git 发版、静态索引生成和社区市场的仓库链接投稿。
- [多模型 Harness 的思考选项与目录分发（2026-11-18）](research/model-reasoning-catalog-research-2026-11-18.md) — Pi、OpenCode、Crush 与 DeepSeek Harness 的模型目录和原生档位，以及独立维护与免费静态分发的选型。
- [Magpie 技能、MCP 与子代理研究（2026-11-11）](research/magpie-library-capabilities-2026-11-11.md)：Library 资源归属、Skill router、MCP router 按需工具、子代理原生投影与工作台借鉴边界。
- [dsh-im 多渠道接入方式与本仓移植可行性调研（2026-11-16）](research/dsh-im-multi-channel-integration-research-2026-11-16.md)：归一化渠道适配器、公共会话桥、凭据与状态隔离、连接监督，以及与本仓飞书桥、Agent Apps 和扩展运行时的差距。
- [开源 README 差距分析（2026-11-10）](research/open-source-readme-gap-analysis-2026-11-10.md)：对照 OpenHands、Cline、Open WebUI、Aider 的首屏定位、语言、安装、截图、代码入口、社区和发布信号，并记录本次 README/贡献流程落地项。
- [Computer Use / GUI Agent 当前方案校验（2026-11-03）](research/computer-use-landscape-2026-11-03.md)：39 个仓库数据快照、商业模型与原生驱动、Wayland/坐标/授权边界，以及 host.desktop 方案逐节修改建议。
- [跨 Harness Skills / MCP 管理实现深研（2026-11-06）](research/cross-harness-skills-mcp-implementation-2026-11-06.md)：12 个固定 commit，中央库/声明生成/运行时网关的源码路径，部署归属和清理语义，Vercel API 发布差距及函数级实验。
- [GitHub 反馈收件选型](research/github-feedback-intake.md)：公开发布后的匿名查重、网页提交和应用内提交取舍。

## 原型

- [交互原型与截图](prototypes/README.md)：每个原型独立一个文件夹，集中保存用于设计验证的 HTML、源码实验稿、说明和配套截图。

## 其它

| 文件 | 说明 |
|------|------|
| [../README.md](../README.md) | 快速上手：定位、布局、运行、配置概览 |
| [teaching/README.md](teaching/README.md) | **交互式教学页**：源码渐进式讲解（扩展 Agent 设计、Pi Agent Harness、prime-agent、dsh 设计概念），双击即开，带动手实验与行为断言测试 |

## 约定

- 新文档只加在本目录，不要写到宿主仓库（如 MetaApp `docs/`）的业务 vault
- 用户向说明放根 `README.md`
- 功能实现说明放 `features/<功能名>.md`（kebab-case）：探索实现前先查该目录有无对应文档、探索后沉淀、代码改动后同步更新——规则详见根目录 `AGENTS.md`「功能实现文档」；**新增功能文档必须同时在上方能力地图加链接**（并视需要在 features 表登记）
- `docs/` 分层：本仓功能现状与根因进 `features/`；内部审计进 `audits/`；外部项目/工具/方案调研进 `research/`；计划状态按 [`plans/README.md`](plans/README.md) 管理；原型与执行材料分别进 `prototypes/`、`compose/` 和 `superpowers/`
- 宿主记忆数据位于 `<controlRoot>/.muster/memory/`，仅通过 memory 技能及宿主工具使用，目录/格式见 [记忆系统](features/memory-system.md)。
- 应用内暂不内嵌帮助页；以本目录 Markdown 为准
