---
doc_type: feature
---

# 扩展 实例运行时编排

`ExtensionRuntime` 管理 sidebar 扩展实例的 DomainRuntime。清单声明 agent 时，同一实例供面板与 Extension Agent 使用，并附带会话级资源挂载。`ExtensionHost` 调度 toolbar 命令，两类扩展共用隔离 worker 和宿主工具分派。

## 关键入口

- `src/main/extensions/extensionRuntime.ts` 负责实例打开、快照、查询、命令、事件订阅、Agent 提示词和关闭。
- `src/main/extensions/extensionHost.ts` 校验顶栏命令的项目绑定和清单，分派 worker 的宿主工具调用。
- `src/main/extensions/extensionIsolatedRuntime.ts` 和 `extensionRuntimeWorker.ts` 传递请求、上下文、取消和工具结果。
- `src/main/extensions/extensionDomainRegistry.ts` 按实例身份复用 DomainRuntime。
- `src/main/extensions/extensionAgentResources.ts` 校验并挂载系统提示词、Skill 和实例级 MCP 资源。
- `src/main/extensions/extensionMcpSession.ts` 把已信任的 MCP descriptor 绑定到单个 Pi Session，复用 `McpHub` 的 stdio/HTTP 生命周期并生成 `ext.<id>.mcp.*` 工具。
- `src/main/extensions/extensionAgentToolset.ts` 根据 manifest 的 query/command 定义、参数 Schema 和权限级别生成当前实例的命名空间工具。
- `test/extensions-domain-runtime.mjs` 覆盖共享 runtime、资源提示词、事件和释放。
- `test/extensions-toolbar-host.mjs` 通过独立 worker 覆盖项目上下文、包目录 cwd 和工具权限。

## 生命周期

`open()` 打开实例 DomainRuntime。存在 Agent Session 时，先挂载资源描述，DomainRuntime 打开失败则回收已挂载的资源。随后 `ExtensionAgentService.openExtension` 为会话打开独立 MCP hub。扩展包目录只作为资源根使用，Pi 会话的 `cwd` 和 `rootId` 始终取当前工作区已登记的源码根；因此全局扩展放在 userData 下也不会绕过工作区目录安全校验。`snapshot/query/execute` 都注入同一个扩展实例身份，并检查清单声明的操作名称和 JSON Schema，避免人类界面与 Agent 串用工作区、包指纹或表面。底栏 AI 开关控制侧栏可见性，会话可在后台运行。SDK 的 `agent.release` 归档并释放 Pi 连接，同时关闭该实例 MCP 客户端并保留历史、DomainRuntime 和资源挂载，之后调用 `agent.open` 会重新注册 MCP 工具。开发目录源码指纹变化后会替换 DomainRuntime。仍声明 agent 时更新同一 Pi Session 的资源与 MCP 挂载，保留历史。移除 agent 时归档旧会话，新 DomainRuntime 独立运行。应用关闭或面板彻底关闭时 `close()` 才释放资源挂载和 DomainRuntime。资源管理器不会修改全局 MCP 配置。

## 顶栏命令与宿主工具

`ExtensionWorkbench` 校验顶栏选择的项目后调用 `ExtensionHost.runToolbar()`。宿主解析当前项目、包指纹和[扩展激活状态](extension-development-trust.md)，按工作区、源根和包版本复用命令 worker。worker 以 `packageRoot` 为 cwd，在每次命令的 `context` 中提供宿主解析的项目绝对路径 `sourceRoot` 和可用的 `rootsRevision`。

安装包将共享 Worker 入口解包到 `app.asar.unpacked/out/main/extensions/sdk/extension-runtime-worker.mjs`。入口落盘失败时，Node 会在加载扩展前报 `MODULE_NOT_FOUND` 并以退出码 1 结束。打包冒烟使用实际应用可执行文件启动这份 Worker，核对启动握手和退出。[打包与安装包](packaging.md)

命令在执行期间用 `broker('tool', [name, args], context)` 调用宿主。宿主用活动请求关联最初的项目绑定，并在工具执行边界复查绑定。扩展身份和权限取自宿主持有的实例和清单。顶栏与 DomainRuntime 一起进入 `ExtensionHost.hostTool` 和 `executeExtensionHostTool`，共用 `hostTools` 声明、工具白名单及工作区、项目和会话检查。要求扩展自己的 Agent 身份的工具由 sidebar 实例调用。

## 当前边界

这是 当前宿主编排层。`daily-report` 通过 DomainRuntime adapter 复用真实日报数据和待办命令，面板恢复旧版日历、日志详情、日报生成、待办编辑和派活交互。SDK 现在也提供受 manifest 权限保护的 `data`、`journal`、`notify`、LLM 和派活兼容桥。`resources/extensions/` 已提供日报、五子棋和书架三个可被 catalog 发现的 sidebar 样例。五子棋面板恢复 Canvas 棋盘、难度、执棋方、悔棋、提示和战绩，并由 DomainRuntime 持有棋盘和内置对手状态。书架面板提供书籍选择、分类、归档、进度和摘要。三者的人类操作和 Agent 操作都回到同一个 DomainRuntime。DomainRuntime 事件只驱动扩展面板刷新；Pi Agent 通过扩展专属的 `state.snapshot`、查询和命令工具按需读取或修改状态，不会因为每次人类操作自动写入会话。DomainRuntime、MCP descriptor、Pi Session、current renderer、事件回流、项目作用域 discovery、开发态 trust 和宿主 appearance 热同步已接入主链路。

每个 DomainRuntime 实例的 mutation 进入独立 Promise 队列。`expectedVersion` 检查、执行、版本时钟和 requestId 缓存位于同一段，队列尾吞掉失败以便后续命令继续。snapshot/query 等待已入队 mutation 后读取。DomainRuntime 和 toolbar command 通过 `spawnOwnedProcess` 启动受 token 认证的 Node worker，包身份、清单、请求参数、取消和事件通过 IPC 传递。构建产物的 worker 路径为 `out/main/extensions/sdk/extension-runtime-worker.mjs`，`sdk` 相对目录兼容不同构建层级。关闭、重载、崩溃和取消超时经 Windows Job 或 macOS/Linux 进程组回收；同步死循环由宿主回收整个 worker。

日报的 DomainRuntime 在 worker 中加载，通过通用 broker 读写扩展数据和读取日志。包发现、catalog 扫描、样例安装和面板资源的 lstat/readFile 都使用异步 API。运行中实例使用 `currentRunningPackageVerifier` 缓存 fingerprint，`open/reload/trust` 总是 fresh discover，普通 call/resource 使用 fs.watch 失效提示并合并并发 discover；不支持递归 watcher 的平台回退到异步轮询。文件变化到 watcher/轮询失效之间存在开发态 TOCTOU 窗口，显式 reload 会重新 fresh discover，变化时 call 抛错、resource 返回 409。







