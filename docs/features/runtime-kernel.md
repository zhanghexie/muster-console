# Runtime Kernel

## 职责与入口

Muster Runtime Kernel 管理可替换运行域的注册、权限、事件、持久化与资源所有权。主入口在构建业务服务前创建聚合根；业务权限、扩展审核和具体引擎协议仍由对应适配层负责，不宣称建立了新的多用户角色系统或OS沙箱。

| 入口 | 职责 |
|---|---|
| `src/main/runtimeKernel/kernelContracts.ts` | RuntimeKernel、PluginContext、RunContext、PermissionGate与插件装配 |
| `domainRegistry.ts` / `lifecycleScope.ts` | 依赖拓扑、启动失败回滚、创建期资源登记与逆序异步释放 |
| `capabilityRegistry.ts` / `internalCapabilities.ts` | IPC与进程内能力的注册、撤销、可信身份和有界审计 |
| `sessionManager.ts` | plugin/scheduler/gui共用的文件SessionFactory与writer所有权 |
| `sessionEventLog.ts` / `sessionEventOffsetIndex.ts` | NDJSON事实日志、seq范围读取、偏移索引、flush与固定边界fork |
| `schedulerSession.ts` / `guiSession.ts` | 调度与GUI事件投影、增量业务命令、检查点与恢复 |
| `messageRangeIndex.ts` / `guiForkPrefix.ts` | 消息字节范围/ID索引与有界GUI前缀写入 |
| `semanticOperations.ts` / `toolInvocation.ts` | 受理去重、结果未知与可信工具因果 |
| `storageRootResolver.ts` | 产品目录、业务purpose及旧产品路径拒绝 |

表中未写目录的文件均位于 `src/main/runtimeKernel/`。服务构造仍由 `src/main/index.ts` 持有，运行域装配集中在 `src/main/bootstrap/registerRuntimeDomains.ts`，宿主入口域装配位于 `src/main/bootstrap/registerHostEntrypointDomains.ts`；IPC域清单在 `src/main/ipc.ts`，调用执行在 `src/main/ipc/handle.ts`。

`messaging-channels` 持有 Channel 的释放屏障，`scheduler-sessions` 依赖该域。`messaging-admission` 依赖 `gui-sessions` 并启动平台控制器。退出或启动回滚先停止账号管理、配对和远端输入准入，再关闭 GUI、调度会话和手机服务，最后等待平台连接及在途回信释放。主进程的退出和启动失败入口同步停止准入，root scope 负责创建期清理。飞书与其他 IM 都通过 Channel 授权操作现有会话。旧手机飞书来源继续由 `phone-apps` 等待其 CLI 进程和事件流关闭，Office 使用独立任务会话。[多渠道消息接入](multi-channel-messaging.md)

## 注册、权限与退出

桌面和Web IPC通过共同dispatch构造RunContext，验证连接存活、传输规则与PermissionGate。桌面身份来自Electron sender，Web身份来自已鉴权服务端连接，参数不能自报授权。嵌套调用继承身份和correlationId。scope退出同时撤销handler、registry条目和权限；内存审计仅保留最近200条通道、身份、结果和耗时，不保存参数正文。

扩展command/tool/panel和broker的LLM、UI、文件、数据、宿主工具走typed InternalCapabilities，复用同一权限与scope，不伪造Electron事件。原有审核、指纹、source root和项目绑定仍执行。退出先同时撤销和取消兄弟能力，再等待真实任务，避免命令与其broker互等。实例卸载取消该实例的broker调用，迟到成功被拒绝。

LifecycleScope等待动态逆序队列，退出中新增的资源也加入当前屏障，单个失败不会跳过其它清理。完整退出后才报告的资源创建新的可观察dispose屏障；不回溯承诺未知资源已被前一次退出等待。DomainRegistry等待在途启动收口后回滚，启动失败与清理失败均报告。

主进程使用before-quit屏障等待RuntimeKernel；创建期root disposer覆盖尚未进入start域就失败的资源。Shell/Web/CLI先停止受理；关闭网络连接后仍等待已受理handler与真实listen关闭回调。startup Promise覆盖listen与stop竞争，停后不允许重新启动。host-entrypoints和phone-apps依赖保证会话先退休，再等待外部调用。浏览器IPC随scope撤销。

调度停止新任务、重试和排队，等待回合/压缩/迟到Pi资源后flush。GUI关闭等待driver、迟到连接、后台任务、REPL和writer；恢复失败的writer清理未完成前拒绝重新materialize，失败保留诊断。NodeREPL等待实际worker terminate，关闭后队列不再创建线程，失败保留可重试所有权。

后台 PTY 在用户命令执行前完成受控 leader 握手及 Windows Job 归属。Unix 使用 leader 持有的进程组。父命令自然退出后仍回收受控后代，业务退出码与清理结果分开，失败保留 owner。POSIX 发送终止信号且 leader 退出后，状态查询遇到 `EPERM` 会在原定期限内继续等待，只以 `ESRCH` 确认进程组消失。主动脱离进程组的后代不在 POSIX 容器的保证内。手动模型目录发现等待其受控进程回收，成功后才提交快照。

工作流Worker、memory curator、Channel 和手机连接器、事件路由/扫描器、evidence与prompt task均有自身停止准入和真实任务屏障；注册、执行与关闭的同步重入先登记owner。受控stdio进程复用held leader与Job/group，输入按64KiB分块并等待实际stdin写回执，关闭拒绝未完成输入；pending和cleanup失败进程保留到最终drain。普通交互PTY在用户shell启动前建立held leader所有权；Windows以系统PowerShell控制台bootstrap持有ConPTY，在私有握手和Job归属完成后才启动用户命令，避免Electron GUI可执行文件没有有效控制台而使shell输入提前结束；Unix以同SID内的受控guard固定各PGID后逐组回收，再关闭leader。异步spawn和停止按generation隔离，关闭等待原生PTY和输出线程真实退出；失败保留owner重试。全局stopAdmission及killAllAndWait接root scope，归档/重置等待释放后才清工作区。主动setsid和远程guest属于明确边界；最新整合验证仍以执行账本为准。

IPC域在注册资源前建立accepted-call owner，停止时撤销所有同域通道并等待真实handler结束；资源取消先于调用drain，防搜索等任务互等。应用退出入口先stopIpcAdmission阻断桌面新调用，再按域依赖清理服务。启动期三个app引导通道仍为进程级同步控制/boot barrier，服务能力必须有域归属。

插件apply也先登记受理Promise再运行插件代码；即使插件同步请求dispose，内核仍等待其初始化结束并回收scope。

工作区与reflog watcher保留所有原生句柄直到close事件，包括配置变更时已申请关闭的句柄；失败保留重试。事件泵先停止准入与计时，再等待已受理投递；sessions监视器取消LLM读屏并等待真实fetch/finally，停止后的结果不再更新会话。监视器关闭不等同PTY关闭，二者分别归生命周期域。启动孤儿清扫与实例心跳由ScheduledWork管理；关闭同步取消未触发timer、终止清扫busy等待，并排空已经受理的真实回调。

## 事实日志、投影与范围读取

FileSessionManager按resolver派生的namespace打开writer。create独占创建，旧handle释放后拒绝写入；flush失败不伪报释放完成。写入采用write-behind和显式flush，不声称每个token都fsync。每条会话日志的待写队列默认上限为 128 MiB，按序列化后的 UTF-8 字节计入事件及换行。异步提交期间pending仍保留到文件提交完成，范围查询合并磁盘前缀与待写事件，避免中途漏批次。

SessionEventLog支持按seq批读、固定seq边界fork、最终无换行有效JSON修复。带换行坏记录或seq间隙fail-closed。偏移sidecar和有限近期event ID带完整性校验，坏加速索引从事实日志重建；不能把sidecar当事实源。

调度message/delta/tool先受理事件再广播，常规persist只处理metadata与活动assistant收口，不再全历史diff/order。排队撤回/编辑/重排、计划卡、重试、recall、通知插入使用scheduler.edit，只保存改变的消息或ID，受理后更新执行期读模型。agent:history广播不再写入事实日志；完整替换仅限显式reset、原生会话导入及首次恢复消毒。旧chat-history JSON读写/迁移和saveChat已经删除。

recall的计划控制器仅在结构编辑持久受理后更新，拒写不让执行状态与转写分离。

插话被原生引擎接受后，旧assistant收尾、插话user、新assistant以一个edit原子受理。拒写不会留下半段转写或修改旧工具终态，明确报告已经投递但本地记录失败，不自动重发。初始assistant拒写则回滚占位并释放notification等待者，模型尚未启动。

GUI Host显式传递变更消息，文本/思考/tool独立增量事件先受理再发布；删除、重排和导入才显式替换。检查点包含seq、event ID和原始投影校验和，恢复仅批量重放suffix；自身检查点不按mtime误判为外部编辑。真实外部编辑仍明确诊断并受控重建。

正常浏览与实际执行分离：调度启动、切区、控制和观察不创建完整bucket；GUI open只登记视图身份，history/count/lastReply/observe走范围。实际发送等执行入口才恢复完整模型上下文。活动引擎的完整读模型是保留边界，不是浏览缓存。

有效消息索引按UTF-8字节范围读取目标页，ID定位使用磁盘二分。首次索引缺失或损坏时，checkpoint 修复只扫描根级 `messages` 对象提取 ID 和字节跨度，再按请求页读取正文，不把整段消息物化为完整对象图；检查点只落后一个有界的追加事件尾缀时，scheduler 冷读先校验 checkpoint seq，再只读取尾缀并把 message/delta/tool 增量合并到请求页；遇到结构编辑、快照替换或尾缀超限才回到完整恢复。不能声称所有异常冷开都O(page)。显式审计/retention及handover全文导出仍可能完整读取；GUI完整历史API尚用于这些显式用途，不能把API存在误报为所有浏览入口都已删除。会话观察反向尾页、跨会话search按字符预算惰性正向读页。全文搜索按120条页扫描，最多返回2000个snippet并支持取消，时间复杂度仍O(total)，不常驻或传输完整正文。

GUI注入与压缩历史使用独立`.timeline`索引，普通消息页只携带对应时间的注入摘要和最多120条压缩记录，不再携带全部提示词与工具定义。详情按校验引用读取原检查点片段，独立时间线每次最多120条；有效索引中不存在的引用直接返回缺失，不触发全文恢复。活动执行仅在元数据改变时更新摘要索引，普通消息增量只保存usage；完整执行上下文和显式导出仍保留全部记录。流式分叉直接生成空元数据索引，首次浏览不为补索引重读完整正文。

## 分叉与语义事件

底层seq fork固定边界，以最多512条批次独占写入目标，失败仅清本次文件。调度业务fork按语义截点复制脱敏前缀，逐条Pi SDK归档并保留最多一个scratch条目；child完成后原子发布active指针，源可复制事实版本变化则拒绝；被分叉剥离的迟到撤回/审查回执继续持久化，不使fork误报冲突。

GUI普通冷源按120条范围页分叉，不先loadSnapshot/retain。child日志、JSON检查点和ID索引流式写入，索引采用4096条排序块及32路合并；pending v2只保存owner/count/hash描述符，正文在私有spool。Pi逐条恢复seed archive；不支持seed的driver在实际发送时构造有上限的transcript。可靠native point可以显式恢复引擎执行分叉；受管附件保持复制和引用改写。源版本、设置、视图及截点检查防止竞态，准备成功后才注册child；失败清理本次日志、sidecar和spool。未知投递状态不猜测重发。

SemanticOperations通过共享工厂的plugin日志保存dispatching/committed/retryable/unknown与因果。相同业务key并发合并，确定未提交可重试；受理后回执写失败或重启遗留dispatching明确报告未知，不自动重复副作用。宿主admitted、原生上下文consumed和回合执行成功是三个不同事实；原生回执写失败单列，不把已入上下文当回执持久成功。

BG digest采用prepare/版本匹配ack，只有成功、非空、未取消的父回合才确认，失败继续保留。mailbox退出先停止受理，再等待已开始的回执IO；原生插话取消移除监听，迟到回调不能复活投递。

GUI网关从可信协议请求ID/宿主turn捕获toolInvocation，调度Pi使用SDK工具ID；参数自报ID无效。合并动作继承原call并单列action，异步并发不串线，runOutsideAgentScope清除来源。语义日志单列invocation与原业务causes，避免污染邮件去重集合。转写工具事件以实际tool ID为cause、assistant为correlation；不伪造引擎原生工具的宿主执行审计。

## Renderer与交互边界

`src/renderer/src/chatSurface/pageMapCoordinator.ts`持有generation-scoped稀疏页；ChatTranscript使用绝对槽位、测量占位和双向补载，窗口外正文实际释放。clear/dispose/逐出使旧响应失效，导航等待React提交后定位，避免重复回填。挂起重开按阅读anchor刷新有界页并复用未变引用；错误或缓存变化不再退回完整历史，迟到sync前的页不能重填已删槽位。

调度/GUI的range入口分别为chat:historyRange和agentSession:getHistoryRange；目标消息一次请求定位，live序号缺口触发范围恢复并保留阅读页。history发布最多120条尾部，不再承担完整内部广播。

GUI摘要缓存按保留的消息ID绑定并随窗口逐出，重叠尾页不会累计多份元数据。展开才加载完整注入内容，收起释放；独立时间线换页替换当前页，切换、关闭及会话重置使迟到响应失效。详情与时间线经过原有IPC能力域和生命周期检查，Web位置参数的JSON空值在传输入口规范化，存储游标仍严格校验。

扩展LLM fetch和队列/已显示UI对话框都有取消源；renderer按请求ID关闭，关闭动画期间不响应陈旧Enter/Escape，窄窗口不会被旧420px最小宽裁切。Electron原生文件选择框没有统一跨平台取消API：保留真实Promise并提示用户关闭，不能用竞速假回收。

## 存储、验证与剩余边界

Muster使用独立产品userData、`.muster`工作区目录、MUSTER环境变量与Muster MCP/协议标识。旧产品目录只用于拒绝规则，既有Muster有效布局保留；外部Pi/Claude HOME和workspace控制根不伪装成app userData。resolver统一业务目录与受控根文件purpose；具体scope映射进度见账本，不声称所有文件命名都已重写。

唯一进度真源为重构方案与执行账本。其中区分提交快照、定向逻辑/组件测试、实际Electron、平台模拟和真机验收。Windows真实Electron已通过万条历史导航/搜索/重启、真实Pi SDK调度/后台与GUI fork/冷详情/clear链路，以及普通终端实际输入/cooked Ctrl+C/raw TUI resize/正常退出回收。最新构建与测试快照逐项记入账本，不将历史结果冒充新快照证明。未采性能基线，未运行macOS/Linux真机或将Windows结果冒充跨平台安装验收。账本列出的代码缺口和可复现异常收口后转needs_verification，仍列出未覆盖验收及一次未定因的测试worker异常。
