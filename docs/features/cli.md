# 外部 Agent CLI

本机其他 Agent 通过 `muster` 向运行中的工作台调度派活。调度可以直接答复或创建 GUI／终端 Worker；只有 `runs.deliver` 明确交付才算成功，不以首轮回复、会话空闲或终端静默推断完成。

模型 `host.dispatch.run` 的 progress/ask/deliver/fail 写回执只报告 runId/state/revision 及动作所需的问题句柄、不同于入参的真实正文/结果和失败资源；不重复任务文件与正常 Worker 快照。get 仍读完整 view，delegate 仍返回新 Worker/队列句柄。此投影不改变 store、HTTP 或外部 `muster run` 返回值；详见会话工具回执审计。

## 安装与使用

主进程 CLI 服务由 Runtime Kernel 的 `host-entrypoints` 域启动和回收。退出先关闭入站受理及调度 admission，再退休 GUI/调度会话，最后等待 HTTP 关闭、已受理命令与后台 dispatch。停机期间迟到的 `beforeStart` 不消费 pending 指令；发现文件清理失败也继续尝试所有资源回收，再聚合报告错误。启动失败会等待已创建服务释放后上报。

Windows 安装器在安装目录生成 `bin/muster.cmd` 并注册到当前用户 PATH。入口通过安装包自身 `MusterConsole.exe` 的 `ELECTRON_RUN_AS_NODE=1` 执行 CLI，不需要额外 Node.js。CLI 使用独立的 `MUSTER_CLI_HOME` / `.muster-console-cli` 发现目录，不与旧 Muster CLI 共用实例。旧终端／Agent 进程需重开以继承 PATH，也可使用入口完整路径。升级去重自身 PATH；卸载只清理注册归属与入口标记均匹配的项。发现第三方同名命令或陌生启动器时明确拒绝覆盖，安装器显示原因。PATH 不用 setx，保留无关条目及环境变量；不额外提权。

```powershell
muster --help
muster status
muster workspace list
muster run submit --workspace <id> --file task.md --idempotency-key task-001
muster run wait <runId> --timeout 120
muster run result <runId>
```

命令：`status / doctor / capabilities / schema / workspace list / run submit|list|get|wait|result|logs|reply|cancel / open`。每级有 `--help`；`capabilities --json`、`schema "run submit" --json` 离线可用，与解析和校验共用定义。正文从 `--text`、UTF-8 `--file`、`--stdin` 三选一。默认单个 JSON 信封 `{ok:true,result:...}` 或 `{ok:false,error:{code,message,hint?}}`；`--human` 为缩进形式。列表 limit/offset 分页；日志 after/limit 增量读取并返回 nextCursor/hasMore/truncated，Worker 日志明确标为尾部快照。

退出码：0 成功，1 连接／宿主错误，2 参数错误，3 需答复或结果未就绪，4 任务失败，5 已取消，6 中断，7 等待超时。wait 超时不取消任务。cancel 请求成功返回 0，逐 Worker 取消失败返回 1 并带 cancellationErrors。

配套 Skill：安装目录 `resources/cli/skill/SKILL.md`（源码同路径）。按目标 Agent 的技能安装方式复制 skill 目录，命名为 `muster-cli`；不会自动写其他 Agent 的配置。入口提示只需一句：**使用 muster 向工作台派活，先运行 muster --help。**

## 架构、状态与边界

`CLI → 用户私有发现文件 → loopback 随机端口／独立 Bearer → 固定命令面 → CliRunStore → 持久输入队列 → 调度自治闸 → runs.delegate → 普通 GUI/PTY 会话与邮箱 → runs.deliver → result`。

默认发现目录 `~/.muster-cli/`，可由 `MUSTER_CLI_HOME` 覆盖；沙箱独立使用 `<userData>/cli-discovery/`。多实例必须显式 `--instance ID`。不打印发现凭证，不接受远程地址，服务只绑定 127.0.0.1，拒绝 Origin 与无效鉴权；发现文件 POSIX 0600、目录 0700，Windows 使用私有用户目录 ACL。此本机凭证信任同一 OS 用户，可操作实例已登记的工作区；写入显式选区，不能传任意路径扩张权限，不提供同一用户恶意进程隔离。不开放原始 IPC、浏览器控制、配置写入或凭证读取命令。

任务记录／原始输入在 `userData/cli-runs/` 原子落盘，不读取 `.muster` 存储来发现实例。每项有 runId、修订号、独立日志序号和专属 Worker 关联。提交幂等键按工作区隔离，同键不同内容拒绝；reply 支持独立幂等键，回答时必须传当前 question.id。重启将所有未完成任务标为 interrupted，不自动重派；未被清理的已交付结果保留。调度泵每秒只遍历内存中的待处理索引，并保持原有任务顺序，不复制历史日志；没有待处理项时不扫描历史任务。

状态：queued／running／waiting／delivered／failed／cancelled／interrupted。调度通知只带 runId 和说明／任务文件路径，注册为 `scheduler.event-wake.external-cli-run`；带 host 标记，外部 Agent 输入不成为真人记忆写入证据。`runs.*` 必须有当前工作区的调度工具身份，不在 Worker／扩展白名单中。

调度通过 runs.get/delegate/progress/ask/deliver/fail 协调；交付前检查关联会话已 needs_you／done 且闲置、无执行中 Worker、无待答问题和未消化指令。结果带 summary/artifacts/verification，不自动合入／归档，不代替现有人工确认。没有明确交付、问题或执行者的调度回合明确失败；已有 Worker 则继续等待调度收口。

模型侧 `host.dispatch.run` 的 ask、deliver、fail 回执仅在实际保存值与本次输入完全一致时省去重复正文，保留 run 状态、关联 Worker、提问 ID 和其他返回字段；不一致或新增内容原样返回。`get` 与外部 CLI 的完整结果不受影响。`get` 返回原任务的 `taskPath`，不返回待处理追加输入正文或路径；每次追加输入的路径由调度通知提供。

runs.delegate 与 sessions.create 一样要求显式 isolation=shared 或 isolated，无 auto 或默认值；runs.delegate 的 isolated 必须给出 isolationGroups，每组明确 rootId、relativePath、repoSet（[] 仅所选主仓），shared 不接受隔离组。sessions.create 则可省略隔离组并默认隔离 cwd 所属仓库。模型可参考 dirty，但执行层不代选；具体判断见 [Worker 隔离决策指引](worker-inject.md#隔离决策指引)。非法参数在预留 Worker、写日志或进入队列前拒绝，重试应修正参数。

cancel 先持久封闭 run，再撤回排队项；核对工作区、会话关联、内部 meta.creationKey 后才中断专属 Worker。创建中的迟到 Worker 补偿中断；逐项错误写日志并回传。终端 Ctrl+C 只表示请求已发送，不承诺进程退出。不停止共享调度回合，后续 runs 写动作拒绝已取消任务。

派活在创建资源前失败时删除空占位，允许调度纠正参数后重试；若整个回合没有交付、问题或执行者则明确失败。创建后任务邮件保存或启动失败时保留宿主返回的新建会话证据，标记 run 失败并中断会话；即使尚未挂接，清理也必须核对同工作区、创建时落盘的 meta.creationKey 和其他 run 的占用。CLI 排队项首次启动失败即停止该项重试，保留其他调用方的队列策略；所有调用方对已创建会话都不再自动重建。中断失败仍保留关联记录，支持再次 cancel。

Worker 通过会话相位与明确寄信通知调度；不再依赖共享任务翻转。Worker 的独立执行 id 由 CLI run 持有，会话创建时保存内部 meta.creationKey 以核对归属，调度从 runs.delegate 上下文恢复 runId；当前不保证清空或丢失该段上下文后的自动反查恢复，调用方仍可用持久 runId 查询与显式补充输入。

`open` 显式聚焦窗口，经 `cli:openRun` 复用 AgentFloat 的 requestAgentPanel 和现有动画，打开该区调度对话；其他命令不切换前台。

## 实现与验证

- `src/shared/cli.ts`：命令、参数、帮助、Schema 唯一来源。
- `src/main/cliRuns/`：存储、排队／取消、发现、HTTP、CLI 入口、调度与真实 Worker 装配；`capabilities/catalog/cliRuns.ts`、`hosts/cliRuns.ts` 提供调度工具。
- `resources/cli/`、`build/installer.nsh`、构建配置：安装注册、捆绑运行时入口、Skill 和调度说明。

回归：`test/cli-runs.mjs`（真实 CLI 子进程与 HTTP，Worker 回调为替身）、`test/cli-run-host-tools.mjs`（调度身份／跨区隔离／交付归属／本机打开）、`test/cli-install.mjs`（PowerShell 解析、PATH／归属函数及真实 cmd 启动器，不修改真实环境）、`test/unit/cli-run-navigation.spec.tsx`、`test/e2e/cli-runs.spec.ts`（隔离 Electron、mock 模型、真实 GUI／Node PTY）。正式安装／升级／卸载以及厂商模型需另行验收，不能从离线测试推断通过。

v1 日志每项保留最近 2000 条并报告截断。启动时会按最后修改时间清理超过七天的任务记录及输入目录，损坏记录的 `.bad` 隔离档保留；这项清理不是本次性能优化新增的行为。产物路径是引用，不提供任意文件下载；`runs.deliver` 的验证说明由调度明确填写，不能代替真实运行证据。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D09.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：本机其他 Agent CLI 经 `muster` 命令向运行中的工作台调度派活：run submit/wait/result/reply/cancel 全生命周期 + status/doctor/capabilities/schema/open；配套 skill（复制安装、不自动写其他 Agent 配置）与安装器 PATH 注册。
- 为什么这样设计：成功判定唯一锚点=runs.deliver 明确交付——「不以首轮回复、会话空闲或终端静默推断完成」（与 observe「busy≠成功」同一纪律族），交付前检查关联会话 needs_you/done 且闲置、无执行中 Worker、无待答问题；本机信任边界：loopback 随机端口+独立 Bearer+发现文件（POSIX 0600/目录 0700、Windows 私有 ACL），信任同一 OS 用户并明示不提供同用户恶意进程隔离，拒绝远程地址与 Origin、不打印发现凭证；幂等与恢复：提交幂等键按工作区隔离、同键不同内容拒绝，重启未完成任务标 interrupted 不自动重派、已交付结果保留，cancel 先持久封闭再撤回、终端 Ctrl+C 只表示请求已发送；隔离决策显式：runs.delegate 与 sessions.create 一样必须显式 isolation=shared|isolated（无 auto/默认），非法参数在预留 Worker/写日志/入队前拒绝；退出码与七态状态机稳定（wait 超时不取消任务；日志增量游标+尾部快照标注）。
- 明确不做：不开放原始 IPC/浏览器控制/配置写入/凭证读取命令；interrupted 不自动重派；产物只给路径引用不提供任意文件下载；外部 Agent 输入带 host 标记、不成为真人记忆写入证据；runs.* 不进 Worker/扩展白名单；`open` 之外的命令不切前台。
- 歧义点：①「重启后 interrupted 不自动重派」是长期姿态（与 dormant「不隐式拉起」同族）还是未来加显式 resubmit 通道？A=长期（重派=重新执行有副作用的任务，须调用方显式决定；持 runId 可查、可显式补充输入，重新 submit 已覆盖；review 不把缺 resubmit 当 finding）／B=加 resubmit 糖。推荐 A。②「同一 OS 用户信任、不做恶意进程隔离」接受为长期边界吗？A=长期（与 agent-runtime-registration「模块完整性≠沙箱」、extensions「非 OS 沙箱」一致的现实立场，文档已明示；review 不把 Bearer 对同用户进程可读当缺陷）／B=未来加凭证加密/调用方身份。推荐 A。
