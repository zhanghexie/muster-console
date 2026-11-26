# 轮次文件改动与 checkpoint（turn-checkpoint）

> ZCode 借鉴 · 批次 D4（2026-09-26 落地）：checkpoint 元信息落账 + rewind 入口收敛到编辑历史。
> 文件改动卡片与文件回退独立于对话历史 rewind；文件回退不删除消息、不修改 Git index 或提交历史。

## 每轮文件改动

快照记录 `repository`（Git 根、分支、起止 commit、scopeStable）：开始和结束分别只读探测。开始身份须在 GUI 实际 send 或调度 provider 调用前完成才可认证；晚到身份只作诊断，不以“尚未收到 SDK 事件”追认为执行前身份。分支或仓库变化时不作为稳定版本依据。记忆证据通过 `TurnChangeService.evidence` 按 snapshotId + owner + turnId 精确读取保存的哈希与 Diff，并重新验证当前授权源根和原始仓库/分支。缺失、越界或范围变化明确返回不可用；不按相同用户原话合并轮次。隔离 Electron 验证真实 Git 捕获及删除快照后的失效提示。

聊天只显示当前会话最后一份可读取、且有文件的 ready 快照卡片；失效和更早轮次的卡片不再展示。准备、采集、保存、覆盖不足和快照失败不在聊天中反复展示过程或原始错误；快照列表查询自身失败时显示错误，用户主动打开右侧审阅时可查看真实状态和原因。并发修改静默记录，冲突详情仅在回退结果中显示。

首开已有 ready 文件快照的会话时，转写等待首次可用性检查，文件卡装入后在绘制前即时定位，避免迟到的卡片推动消息滚动；查询超过五秒则提示并显示转写，迟到响应丢弃，聚焦窗口可重试。已显示会话的后续轮次和刷新不重新隐藏转写。

快照中保存的宿主诊断保持原文；审阅、回退和中断确认界面显示时翻译已知原因、诊断前缀及可识别的嵌套宿主错误，路径和未知底层错误保留原文，语言切换不改写历史快照。

GUI 和调度在引擎执行前同步登记 tracker、绑定真实 snapshot ID、owner、消息和可写根；登记不预热、遍历目录或读取文件正文。可靠写前钩子只读取工具声明的路径，轮末只校验已捕获路径并异步保存；审阅不占用引擎 busy 或队列收尾。显式登记用于补充命令改动，无法认证来源的内容只供审阅。纯终端 PTY 不接文件卡。

仅 GUI Worker 的首条宿主说明提示显式登记。工具可用时，提示 Worker 在 shell、脚本等可能漏检的写入前后用 `host.turnChanges.trackFiles` 登记准确路径，具体用法见 `~/.muster/skills/turn-changes/SKILL.md`。

物理源根在登记、同步回退校验及证据授权解析时统一使用 `fs.realpathSync.native`，与路径采集的 `fs.promises.realpath` 保持原生规范拼写一致。避免 Windows 输入路径全小写、异步结果恢复磁盘大小写时误报「源目录身份已变化」。规范物理路径仍作精确比较，不统一转小写，以保留 macOS/Linux 及 Windows 大小写敏感目录的身份边界；真实目标变化、目录缺失和链接检查仍阻止不安全采集或回退。回归 `test/turn-changes-path-case.mjs` 覆盖同步/异步拼写差异下的启动、修改采集与回退、Windows 真实小写别名、规范目标变化和目录缺失；旧实现负对照只修改测试临时编译产物。

- `src/main/turnChanges/service.ts`、`tracker.ts`、`pathCapture.ts`：路径级采集、工具意图校验、净 Diff、碰撞与逐文件安全回退；`files.ts` 负责文本、路径/链接/指纹检查；`storage.ts` 原子保存并有限重试；`runtime.ts` 提供主进程共享实例。旧审阅基线池、预热与监听已经退役。
- `src/shared/turnChanges.ts`：消息摘要与 IPC 返回类型。正文只带摘要，原文及 Diff 留在 `userData/turn-changes/<uuid>.json`，写入使用临时文件替换。
- GUI：`agentSession/host/fileChanges.ts` 同步登记 tracker 和真实 snapshot ID，工具起止观察者异常不打断事件泵，收口异步汇总；`turn.ts` 不等待基线，审阅错误不变成 assistant 引擎错误。自动网络续作保留同一 tracker，插话切分后文件卡仍属于发起该物理回合的 assistant。迟到结果须验证 entry、消息和快照身份，clear/retry/close 后不复活旧消息。
- 调度：`orchestrator/turnExecution.ts` 与 `providers/piProvider.ts` 在同一 provider 回合采集，成功、失败、中止均收口；tracker 在 provider 前同步登记。审阅保存脱离 busy、执行上下文释放和队列处理，迟到发布同时验证桶身份、原消息仍持有和 snapshot ID；插话后文件卡仍挂原始 assistant。
- `turnChanges/ipc.ts`：`turnChanges:list` / `turnChanges:diff` / `turnChanges:revert`。list 校验会话轮次与快照文件的身份，只返回最后一份可读取的 ready 记录，并保留采集中或失败的诊断摘要；Diff 与回退继续由宿主从当前消息解析快照 ID、身份与可写范围，renderer 不提交磁盘路径或恢复内容。
- `chatSurface/TurnChangesCard.tsx`：共用文件卡，经 GUI/调度 binding 的 `changes` 插槽装入唯一 `ChatTranscript`，不受工具工作折叠或流式状态影响；`TurnSnapshotVisibilityProvider` 按会话合并一次 list 请求，只显示宿主确认的最新可用轮次，消息变化、窗口重新聚焦或 Diff 读取失败时复查，隐藏会话不请求，不逐卡预取 Diff。卡片内部筛选可用的文件改动。`TurnDiffPreview` portal 到 body，停留后读取，鼠标可移入预览滚动或点「在右侧审阅」；键盘聚焦也可预览，Escape、外点、背景滚动或窗口改变关闭，进出场使用 `usePresenceValue` / `mp-pop`。浮层 Diff 保留原始行、不自动换行，长行在内容区横向滚动，溢出时原生滚动条常显并可拖动（单独覆盖全局透明滚动条规则），表头与外框不随之移动；该规则仅作用于悬浮预览。浮层宽度与所属 turn-changes-card 的实际宽度一致，左边缘对齐卡片（不是内缩的文件行）；ResizeObserver 观察卡片，分屏调整时跟随，超出视口时保留 12px 安全边距。浮层取触发行上下空间较大的一侧并限制高度，不能遮住触发行。首次定位前保持隐藏，layout 阶段确定宽度和边缘锚点；向下用 top、向上用 bottom，异步 Diff/字体加载只向远离触发行的一侧增长，不依赖未定宽面板高度或下一帧 ResizeObserver 修正位置。四周 1px 描边由覆盖内容的 `::after` 绘制（`pointer-events:none`），外阴影仍在容器。`TurnDiffView` 两处复用生产 `FileDiffView` 并丢弃过期响应。
- `panels/TurnReviewPanel.tsx`：右侧审阅视图，轮次选择、文件列表、完整 Diff 与独立回退结果。统一右侧标签的 `review` 身份按 owner kind/id 去重，选中轮次/文件可恢复，资源树跟随 Git，切会话隐藏保活；Git 工具条眼睛图标打开当前会话审阅。只保存身份与选择，不把文件正文写进 UI 偏好。聊天跳转请求校验工作区和发起时的右侧会话，切区/切会话后不把旧请求落到新作用域。
- `chatSurface/TurnRevertControl.tsx`：聊天卡与审阅共用单飞回退动作，结果逐文件显示成功/冲突，快照/读取错误明确展示。
- 文件卡分为摘要头、文件列表与紧凑底栏。摘要头用 `IconDiff`、文件数徽标和全部文件增删合计建立层级；右侧依次放「回退本轮」与「审阅改动」，两者与交互 UI 的展开/收起共用 28px 高细描边按钮、hover/focus/禁用样式。表头共用 `chat-card-header`：单行最小高 44px、内边距6px/12px、28px 图标底座；文件数与增删汇总同排显示，空间不足时换行，数值来自 base.css 的 `--chat-card-header-*`。列表使用 `surface-canvas` 及配对前景、hover/focus，每行显示路径、增删与原有来源/回退状态，以细分隔线区分；默认只展示前三个文件，左下角「再显示 N 个文件 / 收起文件」控制其余文件，展开采用 usePresence + acc，收起期间隐藏项 inert；新轮次恢复折叠，同轮摘要更新保留用户展开选择。展开后仍在 440px 内滚动与悬浮 Diff，头部数量包括仅记录变化的文件，仅在全部文件都有行数时显示增删合计。安全回退说明和快照警告收进右下角圆形信息按钮的全局 Tooltip（支持悬停与键盘聚焦）；无文件或非 ready 状态的详细警告留在主动审阅面板。400px 以下卡片内操作换行，表头可随内容增高，文件状态另占一行。
- 只有表头沿用 `surface-raised`，文件列表、底部说明与外壳均为会话同源的 `surface-canvas`，底栏控件配对 canvas 前景；外框使用单层 1px `border-subtle`，无阴影。通过分区底色、分隔与信息层级区分表面。外圆角保持 `--radius-chat-card: 20px`，与用户气泡、问答卡共用；Diff 悬浮预览沿用 `--radius-modal`（10px），预览描边继承容器圆角。

- Diff 悬浮面板保持 8px/12px 内边距的紧凑表头，浅色用 `surface-raised`，深色用 `surface-overlay`。表头复用 `chat-card-header` 的 28px 按钮样式。「在右侧审阅」打开当前文件。工作台中的预览挂在虚拟屏条带上，位置先按视口范围计算再换算到条带内，切屏时随来源页移动并关闭。右侧「轮次审阅」保留在标签页内并跟随右屏平移。

### 中断后继续前的文件确认

`chatSurface/useInterruptedTurnGuard.tsx` 由唯一 `ChatSurfaceView` 接入 GUI 与调度。仅在末轮被手动终止、快照已 ready 且仍有 `revertible && !reverted` 文件时，点击「重新编辑」或发送新输入才询问「回退后继续 / 保留改动并继续 / 取消」。采集中、失败、空快照、只有来源未确认文件或已全部回退时，保留当前文件直接继续；不等待快照，不让审阅阻断输入。`interactionActive` 接 GUI 壳的 `visible` 和手机页面栈的顶层状态；隐藏保活时取消原确认，不冻结后台消息流。

确认先于 `recallAborted` 移除消息，因此回退 IPC 还能解析该条已就绪快照。仅可操作归属已确认的文件；请求进行中防重复与关闭。部分冲突/失败保留历史和草稿，显示原因后需再次明确选择保留或取消。取消不发送、不移除历史、不修改文件；切表面、关闭表面或出现新活动回合会使旧确认失效。确认框沿用 `mp-scrim` / `mp-panel`，初始聚焦取消并约束 Tab 焦点。

### 归属与回退策略

只有工具明确提供的 write/edit/删除或可解析 apply_patch，且其意图与最终内容完全匹配，才标为可回退。内置 Pi 的 `edit` 支持基于同一原文的多项 `edits[]` 精确替换，并保留 BOM 和原有换行；模糊匹配、重复或重叠目标无法独立核实意图，保留审阅但不自动回退。同文件多次修改合成基线到最终状态；改回原状不列入文件卡。工具失败、中止未收到结果、同文件工具重叠、其他活动 tracker 也修改该路径、轮中观测到额外内容，均保守视为归属未确认。

### 并行会话同文件记录与回退

不强制创建 worktree，也不暂停模型或禁止写入。不同 GUI/调度 owner 的活动 tracker 触及同一物理路径时，`tracker.ts` 立即标记双方归属不可信，并向双方摘要追加 `concurrentEdits`。同一对活动会话的同一文件去重。已有路径按系统返回的物理规范拼写匹配；尚不存在的路径采用保守匹配。

`turnChanges/ipc.ts` 注册 `collisions.ts` 回调，记录对方会话名，经 GUI 的 sync/persist 或调度的 agent:message/persist 更新仍持有原快照的消息。碰撞随轮次摘要持久化，包括净改动为零的轮次。调度在记忆召回和 provider 执行前发布 collecting 摘要，确保轮中记录关联到原 assistant 消息。

用户执行「回退本轮」或「回退后继续」时，宿主跳过有碰撞记录的文件，保留当前内容，并在逐文件结果中列出冲突与已记录的会话名。同轮独立且安全的文件仍可回退。若可审阅快照中的文件全部发生碰撞，「回退本轮」仍可用于查看结果。

碰撞依据已观测的工具事件，纯 PTY、任意外部脚本和缺少可靠文件路径的 shell 写入可能漏报。内容、文件指纹与活动回合仍用于保护其他文件的回退。

Shell/脚本不触发轮末扫描。模型可在写入前调用 `host.turnChanges.trackFiles` 的 `begin`、写入后调用 `complete`，按精确路径生成仅审阅 Diff；单靠模型声明不会获得自动回退资格。未登记的命令、仅晚到通知、无路径或不支持的工具可能漏报，并在适用时保留覆盖警告。

工具向模型提供扁平参数表，`action` 只声明一次。Qwen4 Max Preview 在旧版顶层 `oneOf` 重复声明 `action` 时曾连续生成重复键，导致登记在参数解析阶段失败。宿主按动作校验专用字段：`rootId` 仅供 `begin` 选填，`captureId` 仅供 `complete` 必填。GUI 网关回归见 `test/unit/node-main/turn-changes-track-tool.spec.ts`。

保留源 cwd 的隔离任务仍按执行上下文中的真实源/任务目录采集；跨盘任务路径按绝对路径展示，不将源 cwd 当作所有改动的实际根。回退使用当前逐仓写入策略：即使共享父目录仍可写，新登记为参考的源仓也不能被旧快照回退；活动回合、后续内容与指纹校验保持。

回退按文件校验，不做模糊补丁或自动合并：

1. 当前会话仍持有该条消息；快照身份、会话和 messageId 必须匹配。
2. 文件仍在当前可写目录内，源目录 realpath 未变，路径不经过 symlink/junction，文件不是 hardlink。
3. 工具完成到轮末期间文件指纹未发生额外变化；该目录没有其他活动回合，文件内容与轮末文件指纹（inode/dev/size/mtime/ctime）完全一致。后续同内容重写也跳过。
4. 原有文件通过再次核对的打开句柄恢复；本轮新增文件移除；本轮删除文件使用 `wx` 独占创建恢复，目录消失则报冲突。检查与单文件操作之间没有异步边界，不使用 Git reset/checkout。
5. 部分冲突不影响独立安全文件回退；文件校验/恢复结束后才异步保存逐文件结果，Windows `EPERM/EACCES/EBUSY` 的 rename 最多重试五次、间隔 15ms，保留上一个有效 JSON，不删旧记录。保存中同一快照拒绝重复回退；持续失败仍返回已恢复清单及明确状态保存错误。保存等待期间的人工写入不会被再次触碰。无法保证外部进程配合文件锁，此保护是乐观并发校验，不是操作系统级的跨进程事务。

回退 IPC 在异步保存后再次检查原 entry/bucket 仍登记、原 message 仍存在、GUI 未关闭及快照 ID 未变；清空/关闭/切换历史后不发布或持久化旧消息，仍返回实际文件处理结果。界面同步失败也保留已恢复清单，不把它误报成未执行恢复。

### 路径级采集与覆盖边界

- `PathCapture` 仅接收工具明确提供的文件路径或显式登记的相对路径，不遍历目录、枚举 Git 索引或创建审阅 watcher。每轮最多 200 个路径、512 个批次，批次采集的原文与终态正文合计最多 64 MiB；轮末会对已收录路径另做一次状态校验。普通文件写前和写后都在 1 MiB 以内（含边界）时，可为无损 UTF-8 文本生成完整 Diff。任一侧超限时，该侧只采集经过路径和打开句柄核验的文件元数据。按存在性判定新增或删除，两侧均存在时根据文件身份、大小和修改时间判定是否修改；无法据此发现保留这些属性的内容改写。列表显示路径和操作，预览解释省略原因，行数未知，不提供回退或正文哈希证据。读取失败、链接和硬链接仍不视为文件不存在。
- Git 仓库与分支身份异步读取，不阻塞引擎启动；只有启动前读到且轮末仍匹配才标为稳定。身份读得太晚时，文件 Diff 仍可展示，但不能作为已确认仓库范围的知识依据。
- 原生工具若提供可等待的可信写前与写后边界，首次 before 和最后 after 生成历史 Diff；连续工具之间若发生其他修改、重叠或碰撞则禁止回退。异步事件也按声明的路径观察前后内容，但其时机不受工具执行屏障保证，界面标为「事件观察」，只供审阅，可能漏掉变化。写后到汇总之间再次变化时仍展示工具结束时的 Diff，禁止回退并说明后续变化。
- 调度 Pi 直接订阅本进程 `agent-core` 的可等待事件；`AgentSession.subscribe` 自身不等待回调，只作观察。内置 GUI Pi 在独立 worker 的 `tool_call` / `tool_result` 钩子等待主进程采集。正文读取异步进行；两个入口仍需真实模型验证，模拟回放不代表所有工具时序已验证。
- Claude GUI SDK 为支持的文件工具注册可等待的 `PreToolUse` / `PostToolUse` / `PostToolUseFailure` 钩子。`agentSession/registerDrivers.ts` 提供共享服务的 tracker 查找函数，写前钩子按会话查找活动 tracker 并绑定回合身份。驱动也从消息流收集文件事件。钩子成功、意图与实际结果相符时才可能回退。真实 SDK 模型会话仍需验证。
- Codex app-server 自动观察 `fileChange` 的开始、路径更新和完成；引擎提供逐文件 patch 时优先以「引擎报告」展示。当前父回合登记的子代理只将当前子回合的文件和命令事件送入审阅，子代理正文不混入父会话。Codex SDK/JSONL、externalPi/OMP、ACP（包括 Cursor）、Muse 和 ZCode 的结构化文件工具事件也自动观察；路径在进行中出现时补采。externalPi 的编辑结果带 patch 或 ACP 的 diff 内容带前后全文时亦可展示引擎报告，即使完成事件省略该内容。只在完成时得到路径、但无引擎差异的事件不能重建原文；仅凭观察无法保证已在实际写入前读取。各 CLI 的实际事件差异仍需真机逐项验证。
- 引擎报告的差异不伪造旧文件或回退原文，也不作为文件哈希知识证据；同一文件的多个工具 patch 按片段展示并明确提示，不声称为净变化。单个引擎 patch 最多 1 MiB，本轮累计最多 2 MiB。收到成功报告但正文超限时保留路径与操作，标记仅记录变化。事件观察和引擎报告均不授予自动回退权限。
- `host.turnChanges.trackFiles` 的 `begin` 按当前执行目录或宿主提供的 `rootId` 读取指定文件，`complete` 只接受同批子集；批次绑定调用者与当前轮次。Shell 等显式登记默认只读审阅；若同一批次同时有可核实的可信原生写工具、内容与指纹连续匹配，才可能回退。用法真源为 `~/.muster/skills/turn-changes/SKILL.md`，仓库发布源在 `resources/skills/turn-changes/`。
- 消息里只有摘要，正文和 Diff 存在 `turn-changes/<uuid>.json`。可信采集与事件观察展示捕获到的净改动，引擎报告则保留引擎提供的工具片段。安全文件保存 before 与 after 的 hash/指纹；仅审阅文件不保存回退原文。旧快照仍按原格式读取。没有文件时不落盘；最新空轮的覆盖诊断可在主动审阅中查看，不隐藏上一份可用快照。
- 仅收录工作台托管会话中工具声明或显式登记的路径；没有路径、未登记的命令/脚本、纯 PTY 等仍可能漏报，空列表不代表没有修改。文件回退不修改 Git index、提交或历史。屏幕显示的历史警告仍按旧记录翻译。

### 验证入口

`test/turn-changes.mjs` 与 `turn-changes-before-images.mjs` 覆盖已有个人内容、连续修改、新增/删除、CRLF、迟到通知、二进制/硬链接和回退冲突；`turn-changes-git.mjs` 覆盖真实 Git、忽略文件及嵌套根；`turn-changes-review.mjs` 覆盖快照保存重试、别名、碰撞、活动目录与 Git 子根。`turn-changes-path-capture.mjs`、`turn-changes-path-service.mjs` 和 `turn-changes-consistency.mjs` 覆盖显式登记、失败、重放及原文采集；`turn-changes-pi-hook.mjs` 用真实 Pi 编辑工具校验多处替换和回退，`turn-changes-pi-session.mjs` 用离线模型输出驱动真实 Pi SDK 会话、等待式钩子和文件工具。

`turn-changes-incremental.mjs` 在千文件目录统计文件正文读取、目录枚举、watcher 和 Git 调用，`--baseline-rescan` 负对照应失败；`turn-changes-limits.mjs` 校验容量与批次上限，以及异步批量读取时事件循环继续运行；`turn-changes-warmup.mjs` 守冷轮和预热入口退役。`turn-changes-pi-scheduler.mjs` 使用已安装的 Pi agent-core 事件分发器验证它会等待写前采集，避免误把不等待的 AgentSession 转发当成屏障。`turn-changes-host-resilience.mjs`、`turn-changes-scheduler-resilience.mjs` 和 `turn-changes-ipc-revert.mjs` 检查队列/保存分离及关闭、清空、换消息后的迟到结果。工具投递与调用者隔离由 `host-projected-catalog.mjs` 和 `test/unit/node-main/turn-changes-track-tool.spec.ts` 覆盖；组件回归含 GUI/手机审阅和空诊断。`test/e2e/turn-changes.spec.ts` 是隔离 Electron 的确定性写入夹具，并非真实模型验收。

`turn-changes-observed.mjs` 覆盖 Codex、ACP、Claude 消息流和真实 external Pi 编辑工具的报告；`turn-changes-claude-hook.mjs` 覆盖写前等待、跨轮次与失败；`turn-changes-harness-drivers.mjs` 用隔离协议进程驱动 Muse/ZCode；`codex-context-app-server.mjs` 覆盖子代理事件归属、迟到事件与正文隔离。

## 功能职责

- **轮内增量 checkpoint（契约保留、宿主未接线）**：`shared/turnCheckpoint.ts` 定义 assistant 行的
  `checkpointState` / `checkpointReason` 契约，供将来细粒度恢复使用。2026-10-27 起宿主不再落账：
  消费方 `listRewindEditEntries` / `resolveRewindEntry` 尚无调用方，逐工具写入（含读文件、grep）只增大
  每条消息与会话落盘体积；rewind UI 落地时再在 `host/events.ts` / `host/turn.ts` 接线。
  当前文件卡的恢复粒度是整轮内的独立文件。历史消息里已有的 checkpoints 原样保留。
  - `checkpointReason: tool_completed | part_boundary | periodic`
  - `checkpointState: partial`（轮内可回退点）→ `settled`（轮末收口）
- **rewind 入口收敛到编辑历史**：独立 `/rewind` 命令**已死**——rewind 只走编辑历史
  入口（编辑用户消息 = editUserQuery 的 UI 入口），不再提供 slash 命令通道。

## 关键文件与入口

| 文件 | 职责 |
|------|------|
| `src/shared/turnCheckpoint.ts` | 纯函数契约：`stampCheckpoint`（reason 落账，seq 递增 + 行级摘要同步）、`settleCheckpoints`（轮末 settled，幂等）、`shouldPeriodicCheckpoint`（30s 间隔）、`listRewindEditEntries` / `resolveRewindEntry`（编辑历史入口提取）、`isStandaloneRewindCommand`（拒绝独立 /rewind）。零依赖 |
| `src/shared/guiWorker.ts` | `GuiChatMessage` 增可选 `checkpoints[]` / `checkpointState` / `checkpointReason`（type-only 引用，零运行时依赖） |
| `src/main/agentSession/host/events.ts` / `turn.ts` | 暂不落账、不 settle（无消费方）；rewind UI 落地时在此接线 |
| `test/turn-checkpoint.mjs` | 回归：三类 reason 落账 + 行级摘要、partial→settled 状态机（幂等）、周期判定、rewind 入口提取与 /rewind 拒绝；宿主未接线守卫 |

## 数据模型

```jsonc
// GuiChatMessage（assistant 行）上的 checkpoint 元信息
{
  "checkpoints": [
    { "state": "partial", "reason": "tool_completed", "at": 1727000000000, "seq": 1, "toolCallId": "tc-1" },
    { "state": "settled", "reason": "tool_completed", "at": 1727000001000, "seq": 2 }
  ],
  "checkpointState": "settled",   // 行级摘要 = 最近一条
  "checkpointReason": "tool_completed"
}
```

## 契约要点

1. **落账**（`stampCheckpoint`）：追加进 `checkpoints[]`（`seq` 1-based 递增），
   同步行级 `checkpointState`/`checkpointReason`——「Assistant 行带」的契约形状。
   轮内增量点恒 `partial`；`settled` 仅轮末 `settleCheckpoints`（无中间点时补一条轮末点，
   已 settled 则幂等不追加）。单条消息 checkpoint 上限 `CHECKPOINT_MAX_PER_MESSAGE = 200`，
   超限从头淘汰（2026-09-27 复审新增）。
2. **reason 归类**（`classifyCheckpointReason`）：
   `tool_completed` = 工具调用结束；`part_boundary` = 内容片段边界；`periodic` = 轮内
   周期兜底（`shouldPeriodicCheckpoint`：无历史即打，距上条 ≥ 30s 再打）。
3. **rewind 入口**（`listRewindEditEntries`）：人手用户消息（非 host 通栏、非 scheduler
   注入、非 queued）各成一条入口；checkpoint 目标取该消息之后到下一条用户消息前的最后
   一个 `tool_completed` 点。`resolveRewindEntry` 只认编辑历史条目 id，拒绝 `/rewind` 命令名
   （`HAS_STANDALONE_REWIND_COMMAND = false`）。

## 已知边界

- 三类 reason 都只有纯函数契约与测试，**宿主一类都未接线**（2026-10-27 撤下 tool_completed 落账）——
  待消费方（rewind UI）落地时一并挂。
  **接线陷阱（登记）**：`listRewindEditEntries` 现按每条消息的**最后一个** checkpoint
  （`marks[marks.length-1]`）取锚点——当前只落 tool_completed 时等价正确；一旦
  `part_boundary`/`periodic` 接线，若一条消息最后落账是 part_boundary/periodic 而更早
  存在 tool_completed，该工具边界锚点会被静默漏选。**part_boundary 接线批次必须同批**
  把扫描改为「取区间内最后一个 `reason==='tool_completed'` 条目」并补回归测试。
- 对话历史 fork / rewind 与这里的 checkpoint 元信息不直接关联；文件恢复由上面的独立文件快照层承担，不改写聊天历史。
- 调度会话 `ChatMessage` 暂未挂 checkpoint 字段（轮内工具边界只在 GUI Worker 链路产生）。
- `sanitizeRestoredMessages` 恢复消毒**不剥离** checkpoints（历史落账，非进行时状态）。

本次卡片回归：`test/unit/turn-changes.spec.tsx` 覆盖默认三文件、展开/折叠/快速反转、隐藏项 inert、新轮次重置、历史警告及上下边缘定位；`test/turn-changes-card-visual.mjs` 使用生产组件验证深浅主题与宽窄布局、全局 Tooltip，以及异步 Diff 加载过程每个可见帧不覆盖触发行。`--baseline-preview` 在隔离夹具中加载 HEAD 的旧浮层实现作为负向对照；2026-10-18 实测旧版可见帧 bottom=1060 / top=560 / anchor=635，逐帧检查转红，修复版通过。浏览器模拟 IPC 不替代真实 Electron 或具体项目扫描耗时验收。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D06.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：每轮文件改动卡片、安全回退、并行会话同文件碰撞的静默记录与回退说明和中断后继续前的文件确认；checkpoint 元信息契约为将来细粒度恢复预留。2026-11-04 用户授权以工具路径采集替换全局基线。
- 为什么这样设计：审阅是辅助能力；采集与保存错误不阻断会话生命周期。回退按消息身份、可写范围、链接、实际内容和指纹逐文件校验，采用同步检查与操作，不做模糊补丁或自动合并。无法确认归属时不提供自动回退；rewind 入口收敛到编辑历史。
- 明确不做：不做文件锁/事务（乐观并发校验，外部进程不配合）；pty 无结构化回合不接文件卡；Codex 观察事件和引擎补丁不开放自动回退；Cursor 经 ACP 按实际报告路径观察，但不宣称覆盖全部原生行为；fork 不携带原会话快照。

## 快照清理

- 未删除的 GUI 会话（包括已归档会话）和当前调度会话，只保留最后一份可读取且有文件改动的快照；按会话消息顺序选择，不按可能被回退操作改写的文件修改时间选择。较新的记录缺失或损坏时，保留上一份可用记录。最后一份不受磁盘容量或保留时间限制；采集的文件范围与安全回退校验仍按原规则执行。
- 新快照和其会话消息引用都确认落盘、且仍是当前最新可用记录后，后台清理旧记录；正在采集或回退的快照暂不删除，回退结束后重新安排清理。调度的历史归属首次扫描后缓存在内存，后续由保存与回退更新，不在每轮重复读取全部会话快照；定期清扫后按需重建。历史尚未落盘、读取失败或会话在清理中变化时保守保留旧记录，并由后续清扫重试。启动 30 秒后及运行期间每 24 小时清扫遗留；GUI 会话删除（`closeOne` 整枝收口）后异步连带清除其快照。
- 旧调度快照只用工作区标识归属，不能区分同一工作区中不同历史调度会话。按用户选择，同一工作区只留一份调度快照，包括清理其他历史调度会话的记录；当前会话有可验证引用时按消息顺序选，否则按文件修改时间近似选择一份可读取记录。回退可能改写旧记录的修改时间，因此无法保证无引用的遗留记录按真实轮次先后排序。
- 快照被回收后，消息摘要可能仍在，但聊天和轮次审阅不再显示该 ready 快照；依赖它的 Diff、回退和证据不可用。删除快照不回退工作区文件。
- 历史 `baseline-cache/` 不再用于审阅采集；本次不自动删除已有磁盘缓存。
- `test/turn-changes-retention.mjs`、`turn-changes-cleanup.mjs` 和 `test/unit/node-main/turn-snapshot-persistence.spec.ts` 验证消息顺序、落盘后再清理、不可用记录回退、并发保护、会话删除及历史读取失败；`test/unit/turn-snapshot-visibility.spec.tsx`、`test/e2e/turn-snapshot-retention.spec.ts` 覆盖卡片筛选、过期响应和隔离 Electron 的真实 IPC 与清理。Chromium 生产组件截图脚本为 `test/turn-snapshot-visibility-visual.mjs`。
