# Worker 自动派活与候选池

「设置 → Harness 接入 → 自动派活」维护全局默认候选池及工作区覆盖。低、中、高、极高四档对应任务复杂度，模型思考强度由各候选单独配置。「特殊功能」按名称和用途维护自定义池。各池保存启用候选的顺序和显式故障后继。未配置的标准档只在界面显示，添加首个候选后随正常保存建立。模型和参数复用新建会话的 Harness 选择器与原生目录。

工作区有覆盖时使用该覆盖，包括显式保存的空池。其他工作区跟随已保存的全局默认。工作区范围第一次编辑继承配置即建立覆盖草稿，恢复跟随后保存会删除覆盖并重新使用全局值。已有工作区池保留为覆盖。设置写入核对带来源及代际的版本，配置选项、调度、队列、运行中后继都解析任务实际工作区的有效池。目录就绪和冷却仍按实际源目录校验。

保存的分类依次为 `low`、`medium`、`high`、`xhigh` 和 `special`，派活请求使用稳定 `tierId`。宿主读取旧池时仅将唯一的「轻量／Lightweight」归为低、「攻坚／Complex tasks」归为高，冲突和其他旧池留在特殊功能，包括原来叫「极高」的特殊池。读取不写盘，保留 ID、旧名称、候选和后继。每层最多 16 个池，可把特殊池显式分配到空标准档，保留原身份和内容。

调度在现有 Pi 回合里看到当前工作区的档位摘要，按任务要求调用 `host.sessions.create({task,isolation,target:{tierId}})`。用户指定精确型号时，调度直接传 `target:{targetRef}`。没有选择时，调度的普通新任务返回选档和设置入口。内部工作流、手工建空会话和旧会话恢复沿用原合同。模型工具通过档位或引用提交 Harness、runtime、ACP preset、模型及思考等模型参数，内联启动字段由 `additionalProperties:false` 拒绝。新建对话框走独立入口，可传用户选择的原生设置。

Worker 用 `asSubagent:true,inherit:true` 继承可信父会话的兼容启动设置。指定子代理的 Harness 或型号时，传 `asSubagent:true,target:{targetRef}`。处于「完全访问」的 Muster Core 父会话可以创建跨 Harness 子代理。宿主核对同一工作区和来源目录，在预检和会话持久化前复核父会话的生效权限。目标使用自己的常规启动权限，父子关系、隔离范围和首条任务沿用统一创建管线。受限 Core 和外部 Harness 的权限继承限兼容运行时及 ACP preset。改 preset 或模型后清除不兼容的旧参数，Pi persona 单独选择。

宿主分别解析精确引用和权限。调度用引用或档位创建顶层 Worker，以及获准的新建跨 Harness 子代理，按目标适配器采用常规自动权限策略。Core 取 `auto`，Claude 取 `bypassPermissions`，ACP 从原生目录选择已知免审批档并保留引擎的 `plan`。同 Harness 委派使用调用者的权限设置，外部原生设置须来自同源会话的可传递确认值。

`host.workers.options` 在调度、接入宿主工具的 GUI/ACP 和 PTY 可用。缺省读取含分类的档位，`mode:harnesses` 查看接入，`mode:models` 按 Harness、表面、搜索或精确模型查目录及参数。目录读取使用既有缓存，未知快照在 Harness 设置手动刷新。来源由可信调度工作区、Worker 会话或用户选择绑定。模型目录按 provider、runtime、ACP preset 和来源匹配。原生响应未确认的模型和参数只在回执中标作已解析。

在调度、GUI 及受管 CLI 输入区选择 `/harness`，打开与新建任务和会话模型共用的选择器。候选来自实际安装和支持的表面，模型及参数复用原始源目录快照。确认后以配置胶囊替换命令文本。宿主生成 37 字符短引用，配置与来源记录留在有界的应用存储。草稿、手动队列、取回和重载保留胶囊身份，实际提交前重验模型可见性、来源、参数与运行时配置。已知引擎默认解析为具体型号，未知默认等待目录刷新或显式选择。

## 运行与交接

入队固定源目录、有效池的来源和版本及档位快照，出队重验。创建预检失败仅在提交资源前选择下一候选。首先按本档优先级，耗尽后才沿显式配置的后继档继续。禁用、无效和仍处于冷却的候选不会启动。确定的账号级错误可以在同一 Core endpoint 和凭据的配置间共享冷却。429 缺少硬额度证据时归限流，网络提交结果未知、用户拒绝和测试失败不按硬额度重试。可确认的短暂限流可在短 `Retry-After` 后重试一次，计时取消、候选或来源变动均阻止迟到启动。

GUI 运行中切换要求原生终态、宿主与原生工具结果均结算，且旧连接已确认回收。替换保留逻辑会话、任务目录、工作树、父子关系、邮箱和等待，清除旧原生标识。宿主用有界转写、邮件与记录的产物路径组装交接，长文经 `host.workers.context` 和 `host.mail.read` 分页续读。同一 Harness 可在现有权限下切模型。配置与 attempt 先原子落盘，再打开新引擎；重启看到未决运行时等待人工核对。精确引用始终使用所选配置。

工作区覆盖中的 Codex GUI 候选可以在设置中显式授权接替其他 Harness 的顶层任务。用户选择内建权限方案、审批策略和审批者，默认关闭。保存通过不发送模型回合的临时 Codex 线程确认生效权限，并把授权绑定到具体工作区、候选、源目录和版本。全局候选禁止携带此授权。实际接替与之后的恢复回合在 `turn/start` 前重验目标目录、有效沙箱、工作区根和审批设置。目标只接受自身工作目录对应的写根，检测到额外目录、权限或配置变化就暂停。进入已授权的 Codex 后，后续更换候选也需要新候选自己的授权。设置中的授权由用户操作，模型只能读取能力摘要。由 Worker 发起的任务和显式选择启动权限的任务继续约束运行时交接。其他引擎目前缺少完整的目标权限确认，运行中跨 Harness 接替停在可检查状态。

Core 在同一次受管请求的 OpenAI Completions、Responses 和 Anthropic Messages 非成功 HTTP 响应中读取有界结构，ACP 保留明确 JSON-RPC 终态错误数据，Codex 保留终态结构化错误字段。只报告文本、未确认终态或工具结果不全的引擎保留阻塞事实。传统 CLI 支持启动前预检选择，执行中的终端输出缺少通用可验证的终态和工具结算证据；退出时保留原会话供用户检查。不同表面的权限不能确认相容时也停在原会话。在线账号配额与 macOS、Linux 真机待验收。

## 入口与数据

| 路径 | 职责 |
|---|---|
| `src/shared/workerRouting.ts`、`src/main/tasks/workerRouting.ts` | 目标身份、版本、目录范围、短引用、配置池快照及简洁回执 |
| `src/main/tasks/workerRoutingCatalog.ts` | 既有原生目录、模型白名单、描述符与 CLI 启动参数 |
| `src/main/tasks/{delegate,delegateQueue,workerRoutingPolicy}.ts` | 委派、并发、结构化错误分类、冷却及启动前选择 |
| `src/main/agentSession/host/workerRoute.ts`、`src/main/sessions.ts` | 同一会话的运行中切换、严格落盘和原生连接回收 |
| `src/main/capabilities/{catalog,hosts}/workerOptions.ts` | 调度及 Worker 的只读选型和自身交接查询 |
| `src/main/ipc/workerRouting.ts`、`src/renderer/src/components/workerRouting/` | 按层读取与 CAS 保存、恢复跟随、引用、冷却恢复、共用选择器 |
| `src/renderer/src/components/settings/{WorkerPane,WorkerRoutingPane}.tsx` | 引擎配置资源框、派活应用范围、两层草稿、标准档和特殊池编辑 |

相关功能见 [通用模型参数](model-parameters.md)、[Composer 富文本输入](composer-rich-input.md)、[Worker 创建与任务投递](worker-inject.md)、[宿主邮箱](session-mailbox.md)。
