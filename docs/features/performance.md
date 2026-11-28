# 性能架构与实测边界

> 状态：持续维护；各节实测数字只对应所注明的日期、场景与构建
> 覆盖：启动链路、Git 面板、主进程轮询/IO、会话与界面切换、渲染层重渲染
> 关联：[virtual-screen.md](virtual-screen.md)（Git 面板交互）、[board-status.md](board-status.md)（状态信号）

本文沉淀性能架构、历次优化与证据边界，写给下一个做性能优化的人。严格采集入口见 [.agents/skills/perf-trace/SKILL.md](../../.agents/skills/perf-trace/SKILL.md)。历史样本中的 60fps、零长任务或单次低延迟不代表全部场景验收，也不是停止优化的条件；需要检查真实输入、帧长尾、主进程阻塞、内容和状态一致性。

---

## 1. 启动两段化（消灭黑屏）

**结构**（`src/main/index.ts`）：

- **Phase 1（窗口前，只做廉价事）**：`Menu` + `ConfigManager`/`ThemeService`（applyChrome 需要）+ `ipcMain.handle('app:boot:wait')` + `createWindow()`。窗口 **@+36~50ms** 出现，期间渲染层显示 `index.html` 单色品牌环轨加载图形。
- **Phase 2（后台串行链）**：runtime 种子 → runtime overrides 迁移 → 全部服务构造（SessionsService/PromptTasks/Workspaces/Extensions）→ ctx → ShellApi → 全工作区 scaffold → extensions 挂载 → Orchestrator → Feishu → fsWatcher → `registerIpc`。完成后 resolve bootDone（**@+123ms** 实测，非沙箱真实 userData）。

**bootWait 协议**（渲染层水合门控）：

- preload：`window.api.app.bootWait()` → invoke `app:boot:wait`。
- `main.tsx`：`Promise.race([bootWait(), 15s 超时])` 后才 `createRoot().render()`——保证所有 `ipcMain.handle` 已注册、渲染层首批 IPC 不落空；主进程启动链挂死也不会永远骨架。
- 超时**降级半挂载**（X7-F01，2026-10-25 起）：超时不再当成功挂载了事——`markBootDegraded()` 置 `bootStatus`（`renderer/src/bootStatus.ts`），全量 UI 照挂但顶部 `BootStatusBanner` 常驻「仍在初始化，部分面板可能暂不可用」（`mp-panel-top` 骨架，纯提示不挡操作）；挂载期初始拉取失败 `console.error` 可见。主进程启动链收口后对账补齐：`settleBoot`（bootWait 迟到 resolve 或 `app:boot:ready` 事件，后者覆盖 web 网关 invoke 30s 超时的长尾）→ 广播 `BOOT_REHYDRATE_EVENT` → StoreProvider 重拉会话/工作区/配置/运行时四路快照、横幅退场；若收口为 `ok:false`，初始化横幅同样退场，失败通过窗口 tip 提示。
- 启动链全程 try/finally：任何构造异常只 log，finally 必然放行渲染层，并向主窗广播 `app:boot:ready`（`IPC_EVENT_CHANNELS` 白名单内，web 客户端同样可达）。

**顺序敏感（曾在此翻车）**：`runtimes.ensureSeeded()` 必须先于 `new SessionsService()`——loadSessions 按 runtime 注册表归一化会话，注册表未种子会抛 `runtime 未注册` 且中断 Phase 1（当时窗口创建在构造之后 → 无头进程）。教训：**挪动启动顺序时保持原有相对顺序**，窗口创建尽量早、任何东西都别挡在 createWindow 前面。

**渲染层配合**：

- `index.html` 单色品牌环轨固定在 `#root` 外的 `#boot-overlay`，React/Suspense 全程复用原 DOM 和动画计时；RootLayout 分包真实提交后由 `BootReady` 移除，启动失败或根 ErrorBoundary 也清理。根节点不再重复淡入，避免加载图形中断重播。
- vendor 五路分包（`electron.vite.config.ts` `rendererManualChunks`：codemirror / xterm / markdown / diff / react）。
- 懒加载：`SettingsModal`（App 内条件渲染）、`FilesPanel` + `GitPanel`（SideToolsPanel，经 `gitEverActive` 首用门控 + 常驻保活）、`FileEditor`（CodeMirror 随 FilesPanel）。
- xterm WebGL：**首次 `visible===true` 才 loadAddon**（启动恢复 N 个会话不再建 N 个 GPU 上下文；装一次不卸载）。

## 2. Git 链路（点击卡顿治理）

**主进程 `src/main/git/service.ts`**：

- `listRepos`：`summarizeRepo` 批量走自实现并发限流（6）——几十个嵌套仓不再同时 spawn git.exe 打满 CPU；
- single-flight：普通在途调用搭车；普通读取在途时的手动 force 请求合并为下一轮，并等待新结果，避免 UI 仍显示旧列表；
- simple-git client 统一 `timeout: { block: 10000 }`；
- **引用稳定缓存**：每仓缓存上次 summary 对象，porcelain/branch/probe mtime 都没变时返回旧对象；dirty 2s TTL 从查询完成时计时，缓存读取不滑动窗口。同仓摘要在途请求合并；手动目录刷新使旧请求不能回填缓存，同仓新状态读取等旧进程结束后重查，避免旧结果与重复进程；
- `status()`：按仓在途去重 + 1.5s TTL；git 写操作（stage/commit/checkout/fetch…）经 `invalidateSummary` 同步清缓存；
- `GitRepoDiscoveryCache`（discoveryCache.ts）：首次/手动刷新发现一次（深度 32、目录并发 16），多根/多区共用扫描队列，重叠/别名只发现一次。目录浏览不运行 Git 健康检查，也不按父仓 `.gitignore` 删除独立插件仓；隔离预检延迟过滤候选并验证 HEAD（并发 8），继续共用目录快照。摘要共用 6 个槽和同仓在途去重；fs/focus/切区/任务树增删不触发全树重扫。外部新增/修复仓库需手动刷新；快照不持久化、不作为授权。实际 D:\MetaApp 修复测量见 [git-repo-tree.md](git-repo-tree.md)。

**渲染层 `gitpanel/`（GitPanel 拆分，入口 `panels/GitPanel.tsx` 垫片）**：

- `RepoRow`/`FolderRow`/`CommitBar`/`RepoSearchInput` 拆成模块级 memo 组件——打字/点击不再整面板重渲；
- **乐观切换**：点击 → 立即 `setStatus(null)` + 顶部分支条用列表摘要垫上（同帧），status 到达校正；加载期间 Changes/Staged 显示骨架（复用 skel.css）；
- generation 计数（statusGen/listGen/diffGen）防过期响应覆盖新仓 state；
- Git 面板操作固定 workspaceId/根版本，切区/根变更释放旧交互状态与晚到请求。权限复核只检查当前登记/realpath；linked 身份核对用 Git 注册信息，不把源仓状态读取改成递归发现。SimpleGit 命令提交前重查，缓存命中返回前仍校验；本批未测真实多根写操作的端到端耗时。
- 发现失败作为部分结果保留，详细 IPC 最多传 100 项错误、界面显示前 4 项及总数；读取失败与快照复用，手动重试刷新，列表成员失效同时取消旧详情 generation。来源可用性检查只做 realpath/stat，不恢复每次全树扫描；相关范围不完整时隔离预检明确失败。
- `mergeRepoList`：列表返回逐项与现有 repos 比对，内容没变复用旧引用（配合主进程引用稳定缓存，整树 useMemo 命中）;
- `chainById` 独立 memo（`buildChainById`，只依赖 treeRoots）——不随 expanded 变化换引用，否则选中仓「自动展开祖先」effect 每次开合重跑，会把手动收起的祖先撑回（详见 [git-repo-tree.md](git-repo-tree.md)）；
- selectedRepo 持久化 patch debounce 500ms（点击路径纯 setState）；
- 已列出仓切换只查询该仓 status，选中路径不改变列表 effect 的依赖。Git 面板、隔离选仓与准备设置共用 `listRepoLocations`，初次/手动只等目录发布，状态随后更新；D:\MetaApp 热缓存下 115 仓首次纯拓扑 2.25 秒、手动发现 2.27 秒、缓存目录 69–72ms，发现阶段零 Git 子进程。选中仓先启动，其他仓按每批最多两个的 scoped repoSummaries 独立更新，慢选中仓不挡住队列；未知/失败状态保留目录、显示省略号。隐藏/失焦/切区/手动读取/卸载使旧队列失效，重复聚焦不叠加批次。完整状态耗时仍由 Git 命令决定，以上目录测量不代表全仓状态完成时间；
- fs 风暴治理：根仓库空信号不再命中 status 刷新、fs 触发的 refreshStatus 1.5s 节流、空信号列表刷新降级普通刷新 + 10s 冷却；
- `FileDiffView`：>1500 行按 hunk 截断 + 「展开剩余」；`useTreeKeyboardNav.getItemProps` 身份稳定 + FileRow 改传函数（memo 不再被新对象击穿）。

**实测**（非沙箱，MetaApp 真实工作区，CDP 真实点击）：高亮切换 **11–23ms**（骨架同帧出现）、内容就绪 208–620ms、点击期最大帧间隙 ≤48ms、连点 3 仓帧间隙 11ms。

## 3. 主进程常驻开销

调度事件日志按追加事件保存消息、流式片段和工具结果。实时状态回调可能在同一消息内容未变化时重复触发完整消息持久化；`SchedulerSessionAdapter.recordMessage` 会在写入前比较当前投影，跳过完全相同的快照，避免把大型工具结果重复写入日志。该优化不裁剪正文、不改变事件顺序或恢复投影；内容发生变化时仍保留新的消息事件。

| 热点 | 处理 | 位置 |
|---|---|---|
| 扩展扫描 | extension 正常状态不定时全量扫描；监听首次挂载、失败重试和受影响运行实例复核采用异步 IO；同步事务结束后合并补扫监听空窗，发现仍核对全部副本 | `extensions/extensionWatchService.ts` |
| 扩展后台与审核 | 桥接、后台消息、审核及副本预检异步读取完整字节；异步捕获的哈希按 4 MiB 分块让出事件循环，并发核验合并；首次打开实例、清单复核和启动期原生包仍有同步核验，见扩展功能文档 | `extensions/extensionBackgroundRuntime.ts` / `extensionPackageSnapshot.ts` |
| 会话 500ms 轮询 | 先判评估条件再取 buffer；只取尾部 16k（`getBufferTail`），不再全量 join 200KB | `sessions.ts` / `pty/manager.ts` |
| pty:data 每 chunk 一条 IPC | 按会话 8ms 合流为一条 send（scrollback 仍逐 chunk 追加；onExit/kill 前 flush） | `pty/manager.ts` |
| fs.watch 事件风暴 | 回调零分配预筛 skip 段 + 物理根前缀索引 + pending 上限 1000 超限合并 `''` | `workspaceFsWatcher.ts` |
| workspaceFile 全套 scaffold | 进程级 `ensuredRoots` once 化；读时内容未变不回写 | `metaAgent/scaffold.ts` / `workspaceFile.ts` |
| shell profiles 同步探测 | 进程级缓存 + 模块加载异步预热（wsl 改 execFile） | `shell/profiles.ts` |
| 停滞扫描 | 缺省 2 分钟（钳 1–5）；仅 in_progress 任务会话写 stalled（无任务跳过、不打 git）；会话活动新鲜跳过 git；过期才打隔离树 porcelain+log；单飞 + 单会话失败隔离 | `pipeline/stallScanner.ts` |

**实测**：稳态（空闲）4 个 electron 进程 30s 平均 CPU **0–0.7%**；pty 合流 200 行突发输出零丢失零乱序（E2E 验证）。

`SessionEventLog` 的待写队列默认上限为每会话 128 MiB，driver queue 的默认上限为 8 MiB。事件入队时只序列化一次，诊断记录 flush 延迟、待写字节数和降级原因。Git discovery 按物理根划分队列，同根请求共用一次扫描，不同根可并行。当前仓库只完成静态和离线回归，尚未用真实 1/4/8 流式会话及慢盘采集 event-loop delay、IPC p95/p99、renderer frame gap 等发布指标。

## 4. 渲染层全局重渲染

- GUI 会话模型目录视图按实际状态和条目引用复用，Composer 的权限派生数据与清除建议回调在输入未变时保持引用稳定；消息更新不再仅因这些属性重建而触发输入框重渲。模型选择、权限和目录状态变化仍更新。组件回归确认引用与重渲路径，未据此推断真实大会话帧率。
- **App 摘除 chat store**：`MainViewShell` 壳组件下沉消费（agent-expanded 类名），agent 每 token 不再全树重渲；`ChatAutoOpener` 同理下沉 confirm 边沿逻辑。
- **token 合批**（`store.tsx`）：`agent:token/thinking` 入 ref 队列，rAF + 50ms 兜底双触发 flush；history/message/tool/done 处理器先同步 flush 再处理（顺序保证）。
- **storeValue useMemo** + 9 个 action useCallback 化。
- **pty:data 单一分发器**（`terminalRegistry.ts`）：模块级 Map<sessionId, Set<cb>> + 惰性唯一 window 监听；TerminalView 按会话订阅（不再 N 会话 × 全量事件）。
- **MarkdownBody**：外层样式与内层 `MarkdownContent` 解析分开 memo；components/plugins 按依赖 memo，配合 `.md-body { contain: layout paint }`。UI 产物抑制路径按值保持引用稳定，正文/真实抑制路径/文件动作变化才进入解析层；文件预览的导航动作从当前 ref 读取，切屏不换解析层回调，见 §18。pele 真懒加载（单一 `pele-*.js` chunk ~965KB，2026-10-24 替换 mermaid.js——原 mermaid 分块群数 MB 且强制归块会接入口静态图，见 2026-09-06 journal；pele 同为动态 import，勿加 manualChunks 规则）
- `SplitExpandControl` 的 pointermove 只保留最后一个位置并通过单个 `requestAnimationFrame` 合并，结束、取消和卸载会取消待处理帧；拖动轴锁、落点判断和 resize 回调保持同一状态语义。组件回归覆盖了合帧后的落点更新。
- `WorkspaceFsWatcher` 按物理根建立前缀索引，事件沿文件路径向父目录查找候选逻辑根，避免每个 watcher 事件遍历全部 workspace binding；物理共享、嵌套根、Junction alias 和 skipped directory 的既有边界由 `workspace-fs-watch-roots.mjs` 回归覆盖。
- `WorkspaceQueries` 通过 `ConfigManager.onChanged` 的单一事件订阅监视 workspace `rootsRevision`；配置变化时只取消 token 已过期的查询，移除每个查询 100ms 轮询，避免多 workspace 查询空闲时持续读取配置。查询仍在根解析、结果汇总和返回前重验版本。
- `TerminalView` 的初始、重生和 ResizeObserver fit 共用单一 generation 调度，取消旧 generation 时只保留一个重试 timer，避免一次布局创建多组并行 fit/pty.resize；终端可见切换通过同一调度入口恢复焦点和尺寸。
- `ChatMarkdownBody` 将路径候选限制为每次渲染最多 256 个，stat 请求按绝对路径合并 pending/in-flight waiter，effect 清理通过 `AbortSignal` 取消未发出的查询并忽略已取消结果；超过候选上限的路径保留原文，不生成链接。
- **首屏分包**（2026-09-06）：RootLayout 双 `React.lazy`（桌面树 / 手机树分 chunk），入口静态依赖只剩 vendor-react；ExtensionUiDialog 经 `ExtensionUiDialogLazy` 首个弹窗到来才挂载（其树含 xterm）；BgTasksPanel 打开时才加载（xterm 出首屏）。手机首屏下载 **9.31MB → 1.91MB**（CDP 实测，无缓存）。
- **CSS**：`*:hover` 全局通配收敛为显式滚动容器登记制（`base.css`，新增滚动容器需登记）；`dot-pulse`/`board-dot-pulse` 改 `::after` scale+opacity 合成器动画（约定：**光效动画必须走 transform/opacity**；board-dot-pulse 已随状态点退役——2026-09-14 状态视觉改为状态图标，working 走 spinner 旋转、需要你轻呼吸，同为 transform 循环）。
- 其他：AgentFloat 智能滚底（距底 ≤40px 才跟随）、composerDrafts 300ms 防抖、BoardPanel Column 提升模块级、CenterPanel runtimesById memo、TerminalView pad 背景节点缓存、拖动期 `is-reshaping`/`is-left-resizing` 遮罩（pointer-events:none + opacity）。

## 5. 性能测试方法

- **CDP 自动化**：`MUSTER_DEVTOOLS_PORT=9333 npm run dev:no-sandbox` → `http://127.0.0.1:9333/json/list` 取 page target → ws 驱动（Runtime.evaluate 探 DOM / Input.dispatchMouseEvent 真实点击 / rAF 帧间隙测 jank / Page.captureScreenshot 视觉断言）。env 门控，正式使用零影响。
- **开发服端口 5188**：关窗口应带走 electron-vite；若仍占用，下次 `npm run dev` 会先清本仓库残留。不要用第二个终端再开一份（旧进程还在听）。
- **启动打点**：主进程 console `[boot] window shown @+Nms` / `[boot] background init done @+Nms`。
- 注意：非沙箱 dev 用**真实 userData**（真实工作区/会话），测试会话记得 `sessions.close` 清理。

## 6. 已知取舍 / 风险

- 搜索过滤延迟 150ms 生效；selectedRepo 持久化延迟 500ms；草稿落盘延迟 300ms（异常退出最多丢 300ms）。
- 大 diff「展开剩余」为一次性全量展开（用户主动触发）。
- 生命周期检测只看 buffer 尾部 16k——极端「设标题后输出超 16k 才收尾」的 OSC 标题规则理论上可丢（TUI 收尾重绘通常带标题）。
- scaffold once 化后，进程存活期间手删 `.muster` 需重启才重建。
- shell profiles 缓存进程级粘滞：预热期 wsl 探测超时会以「无 WSL」落缓存（极罕见）。
- 指纹缓存依赖 mtime 粒度（NTFS 100ns，可忽略）。

## 7. 安装版真机 CDP 实测（2026-09-14，v0.1.21）

**附加方法（免重启）**：安装版渲染进程自带 `--remote-debugging-port=0`（内置浏览器 CDP 默认开）；userData 的 `DevToolsActivePort` 文件可能是 dev 运行残留，真实端口以主进程 127.0.0.1 监听口探测 `/json/version` 为准。探针（longtask / event-timing / rAF 帧间隙 / 点击目标）经 `Runtime.evaluate` 注入、2s 轮询落 JSONL；CPU Profiler 10ms 采样，其时间轴为 QPCµs，须用渲染进程启动参数 `--time-ticks-at-unix-epoch` 的负值换算 epoch 才能与 performance.now 对齐。脚本一套存于 `%TEMP%\metaagent-perf`。

**实测（10min 自由操作 + 2min 定向复现，真实用户）**：交互延迟 p50=32ms / p90=96ms / p99=824ms；滚动聊天区持续 20-45fps（帧间隙 150-450ms）；点聊天内 `code` 元素稳定伴随 280-370ms 长任务，点 agent-notify / session-item / board-card-name 240-290ms；另捕获一次 4×~2.3s 连续冻结（未复现，疑大数据量路径，复发时复用同法抓 profile）。

**CPU 归因（29 个长任务窗口 7.1s 采样）**：React render/commit 自身 33%；原生 style/layout 22%（(program)）；GC 11%；micromark Markdown 重解析 9%（`visit2`/`splice`）；i18next 解析 ~8%（`looksLikeObjectPath` 全程 self 777ms——静态文案每渲染重新 resolve）。全程 GC 占 2.8%、`getBoundingClientRect` 累计 ~1s。

**修复候选（按预期收益）**：`onFileLink`/components 身份稳定化——`MarkdownBody` 已 memo 且 components 已 `useMemo([onFileLink])`，重解析疑为上游每渲染传 inline `onFileLink` 闭包击穿 memo 链；i18n 静态标签常量下沉或按语言缓存；长转录虚拟化；缩小点击路径（notify/session/board-card）的重渲染面。

### 修复实施（2026-09-14 同日，沙盒迭代验证）

沙盒定位（`MUSTER_DEVTOOLS_PORT=9333 npm run dev` + 临时渲染计数探针经 CDP 读取；造数走 `window.api.sessions.create({runtime:'pi'})` + `agentSession.send` 发 markdown 消息）修正了两个误判：点行内 code 本身 0 重渲（真机的 300ms 是并发 store 更新重渲整列表，点击只是撞车）；`MarkdownBody` memo 链完好。真凶是**行级 memo 被逐点击穿 + t() 无缓存**：一次会话点击转录重渲 13-22 次、每行每次 ~40 个 t() 调用（6.6µs/次解析成本）。

| 修复 | 位置 | 内容 |
|---|---|---|
| t() 结果缓存 | `shared/i18n/index.ts` | 实例级 t 包装：key-only 与带 options（键排序后并入缓存键）的调用都走 Map 缓存，options 含函数值透传不缓存，`languageChanged` 清空；单次 6.6µs → ~0.05µs（约 50-100×），主进程/渲染层共用 |
| onFileLink 身份稳定 | `ChatSurfaceView.tsx` | useCallback 依赖从整个 `store`（uiSlice 混 confirms/dialogs 状态值，UI 态一变即换引用）改为两个稳定方法 `requestOpenWorkspaceFile`/`flashTip` |
| 审批/提问卡缓存 | `ChatTranscript.tsx` | `cardsCacheRef`（同 displayCacheRef 口径）：`getInlineCards` 每次产出新 JSX 元素，消息等价时复用旧元素，带卡行不再破 memo；随消息删除剪枝 |
| 视口外消息跳过 | `chat.css` `.chat-turn-anchor` | `content-visibility: auto` + `contain-intrinsic-size: auto 88px`：长转录视口外免 layout/paint（滚动收益，沙盒短 DOM 未量化，真机待验） |

**沙盒复测**（42 条消息会话）：会话点击时列表重渲 12 次而行渲染 **10→0**；滚动/点 code 零重渲。回归测试 `test/unit/chat-transcript-memo.spec.tsx`（行级 memo 契约，红灯自检过：还原 cards 缓存即转红）+ `test/unit/i18n-t-cache.spec.ts`（缓存命中/语言切换清空/options 透传）。真机复测法：复用 `%TEMP%\metaagent-perf` 采集器对比 p90 与长任务。

### Composer 打字间歇卡顿（2026-09-17）

**定位**（按键路径，不是 compact 特判）：① `ComposerEditable.emit` 每击 serialize + caret，旧 `scrollFollow` 再走一遍（4 次 DOM walk → 2 次）；② `AgentComposer` 把 uncontrolled 输入核的每次 `onChange` `setValue`，整棵底栏/排队面板/菜单重渲；③ `ChatSurfaceView` 给 Composer/Transcript 的 `onCompact`/`onPlanAction`/`chatStatus`/`preset`/`bgTasks` 每渲染新身份——快照或轨迹一动，兄弟会话流 `rendered` useMemo 失守、输入条也跟着重渲。`interleaveCompactionMarkers` 已在 Transcript `useMemo` 内，按键本身不重算。

**修复**：按键只写 `valueRef` + 草稿；空↔非空才 `setHasText`；外部写入走 handle `setText`；Composer/Transcript `React.memo` + 接线回调/对象按字段 memo。回归：`test/unit/agent-composer-hotpath.spec.tsx`、`test/unit/chat-surface-composer-isolation.spec.tsx`。

### 工作区栈「对话收窄」动画 + 面板打开卡顿（2026-09-14 下午，安装版实测 + 沙盒验证）

**现象**：点头像弹出调度面板时，胶囊「右移缩小」（`is-chatting` 收窄）全程卡顿。安装版 CDP 实测（采集器 + cpuprofile 按点击窗切片）：每次点击当帧 83-119ms 长任务、帧间隙 100-133ms；点击窗口内 `(program)`（原生 style/layout/paint）300-455ms，是 JS（React ~150ms）的 2-3 倍。

**归因（三层叠加，隔离实验定责）**：①收窄动画动的是 `margin-left`（头像）+`width`（气泡）两个布局属性，且气泡带 24px 投影逐帧重画——单独跑该动画即 17/33ms 交替掉帧（49 帧 8 帧 >32ms）；对照实验同元素纯 transform 满帧（maxGap 17ms、0 超标），排除环境干扰；②点击帧同时挂载整个面板子树（React 大组件重渲 + 大块 DOM 首次 layout/paint）→ 100ms+ 冻结；③面板打开触发 orchestrator 历史 IPC，转写渲染落在动画窗口内继续抢主线程。

**修复**（`float.css`/`left.css`）：头像 `margin-left` 过渡 → `transform: translateX`（合成器）；气泡让位改 `margin-left` + flex 填充自动跟缩——槽位路径布局属性从两个（avatar margin + bubble width）减到一个（main margin，width 自动跟随）；浮层定宽路径（窄屏 stackInline）保留 `width` 过渡 + 新增 margin 让位，仍为两个布局属性（窄屏低频路径未单独验证）。

**顺带修的几何 bug**：槽位内收窄行原用浮层公式宽 `--ws-bubble-docked`（按栏宽-60 算），比槽位实际（栏宽-24 再减头像/gap）宽 5px；收窄行的内容最小宽把 grid rest-body 撑到溢出，**手风琴内其他行跟着变长、右缘参差**（实测：关面板全行右缘 308，开面板后手风琴内行 313、手风琴外行 308）。槽位覆盖 `width: auto` 后恒对齐（沙盒实测 4 行右缘全部 360）。

**复测**（沙盒 + screencast 强制出帧；遮挡窗口 rAF 会被节流，须先 bringToFront/恢复窗口）：收窄动画 maxGap 16.8ms、**0 帧 >32ms**（修复前同法 8/49 帧超标）；完整点击流 maxGap 33ms（面板挂载帧，仅 1 帧）、无 >66ms 帧（修复前每击必有 100-133ms 冻结）。面板挂载帧的进一步摊销（关闭后保挂载/延迟挂载）留待复发再上。

## 8. Cursor GUI 引擎存储：JSONL → SQLite（2026-09-14）

以下为已退役的 Cursor SDK 接入的历史测量；当前 Cursor GUI 已切至 ACP，不使用这套存储与 worker。

**现象**：Cursor（GUI）会话发送后久等才有回复，且随聊天变长越来越慢；新开空会话同样慢。

**根因**：`cursor-worker.mjs` 给 SDK 传的是 `JsonlLocalAgentStore`（SDK 自带注释即写明 "Listing rewrites whole files on delete/update … not optimized for huge catalogs"）。其每次 `get`/`create`/`update` 都是**整文件读 + 逐行 JSON.parse + 整文件 write-file-atomic 重写**，所有写还走模块级全局串行队列；`storeDir` 跨全部会话共享一份，所以新会话也被存量拖累。真机存量：`checkpoints.ndjson` **78MB / 8200 blob**、`run_events.ndjson` 12.7MB / 15731 行；单 agent 最多 4495 blob / 33 run（**≈136 checkpoint/回合**，blob 是当时整段上下文快照、旧 blob 不回收）→ 文件随聊天二次方增长，而单次 IO 代价与文件体量成正比。

**实测**（Electron 43 / Node 24.21，`ELECTRON_RUN_AS_NODE`）：

| 操作 | JSONL @78MB | JSONL @空 | SQLite（预置 2000 blob 后） |
|---|---|---|---|
| checkpoints.get | 87ms | 0.4ms | 0.12ms |
| checkpoints.create | 238ms | 7ms | 2.25ms |
| runEvents.append | 126ms | 4ms | 0.07ms |

端到端（instrument 包一层 store，真发一条「只回复 ok」的最小回合）：store 调用 **74 次**，累计阻塞 JSONL@78MB **16.3s** / JSONL@空 192ms / SQLite **33ms**（明细：checkpoints.create 11×828ms、get 12×327ms、runEvents.append 7×395ms）。JSON 解析是同步的，直接卡住 worker 事件循环、推迟 delta 转发——所以既是首字延迟也是输出断续。注意首字延迟里模型思考时间常占主导（同一条消息 grok-4.6 两次实测 8.0s / 8.1s），store 的收益体现在**回合全程不再被 IO 阻塞**与**不再随存量退化**。

**修复**：换 SDK 默认的 `SqliteLocalAgentStore`（node:sqlite 内置、无原生编译），**不留 JSONL 回退**——静默降级只会让这套慢病复发且更难查；打不开就带诊断信息失败。打开逻辑与 resume 降级收在 `worker/agent-store.mjs`，详见 [gui-worker-session.md](gui-worker-session.md) 的「存储后端」节。按用户裁决**不迁移**旧数据（老会话首轮 resume 失败降级新建、引擎上下文重开，界面历史不受影响），旧 ndjson 启动时归档到 `agents/cursor-legacy-jsonl/`。

**测量方法**（复用）：`ELECTRON_RUN_AS_NODE=1 <electron> script.mjs` 里 `new Proxy` 包 store 的四个子仓统计每方法调用数与耗时，再对同一条 prompt 跑不同后端对比；迁移/批量读旧 ndjson **不要用 store 的逐条 API**（8200 次全文件读要 45 分钟，直接解析文件是 2.1s）。

**已知边界**：SQLite 库仍是跨会话共享单库（`index.db`，WAL + busy_timeout 5000），`purgeDefersOnBusy` 因此保留错峰；checkpoint blob 仍不做 GC（SDK 侧行为，存量只在删会话时回收）。

## 9. 同源模式扫描与三项修复（2026-09-14 同日）

按 §8 的病症模式（**热路径 O(全量) 序列化 / 全量集合推送 / 只增不回收 / 上限维度错**）扫全仓，量化后确认四条真问题，修了三条。

### 9.1 trace 上限维度错 → 加字节预算 + 落盘节流（机制已随轨迹全链退役移除）

`TRACE_MAX_ENTRIES=5000` 限的是**条数**，成本却由**字节**决定（trace 存工具输出与请求头的 system prompt + 工具 schema）。真机最大 trace 文件 562 条已 2.97MB（上限的 11%），按此密度满额约 **26MB**、单次落盘 stringify **68ms**，而 `PersistQueue` 合并窗口只有 200ms → 回合期间约 34% 主进程时间在序列化；`open()` 同步 read+parse 满额约 127ms。满额并不难：一个 277 工具的回合产生约 554 条，**9 个回合就到**。

修复：`shared/trace.ts` 新增 `TRACE_MAX_BYTES = 4MB` 与 `TraceWindow`（`entries` + 并行 `sizes` + 累计 `bytes`，内存态不落盘），`pushTraceEntry` 按条数与字节双上限从头淘汰（单条就超预算时保留它自己，不产出空账本）；`buildTraceWindow` 在 `open()` 时一次性重建。落盘从「每条 trace 排一次全量写」改为 **2s 节流**（对齐 `scheduleStreamingPersist`），并在 close / finishTurn / flushPersist 三处结算尾款、clear 时撤销待写。回归 `test/trace-budget.mjs`。**2026-09-25 轨迹收窄 Pi 专属、TraceEvent 全链退役后，`shared/trace.ts` 与 `test/trace-budget.mjs` 已整体删除——本节机制成为历史，trace 负载不再产生（getHistory 首帧不再含 trace）。**

### 9.2 syncEntry 全量推送 → part 级增量

真机最大会话历史 2.93MB 是 **4 条消息 / 277 工具卡 / 工具输出 2.29MB** 撑出来的——**体量随工具输出字节增长，不是消息条数**。每次 sync 渲染层固定开销实测 3.39ms（`structuredClone` 2.94 + 全量 `guiChatMessageEqual` 0.46），主进程另有同量克隆；一个回合推 554 次（每工具 start/result 各一次）≈ 1.9s 渲染层主线程。

同一回合的工具卡都挂在同一条 assistant 消息上，按 `messageId` 推送仍要克隆其中所有工具卡。因此 host 的 tool-start / tool-result 走 `syncPart`，只推送 `{messageId, partIndex, part}`。计划卡、审批、提问、排队和错误会改变消息级状态，有时还会同时更新多条消息，例如挂出计划卡时取消上一张卡的激活状态。这些变化继续走 `sync`，让渲染层一次应用一致的消息快照。当前 `syncEntry` 最多推送尾部 120 条消息，并携带总数和分页位置。

渲染层用共享纯函数 `applyGuiMessagePart`（`shared/guiWorker.ts`，与 `applyGuiMessageDelta` 同族）：只换目标消息与目标 part 的引用，其余保持原引用（行级 memo 前提）；**消息不存在或 partIndex 跳号一律返回 null → surface `resync()` 回退全量拉取**，静默丢一个 part 就是工具卡永久缺块或永远停在「进行中」。回归 `test/gui-part-push.mjs`。

### 9.3 bgTasks 消息整包 → 面板订阅门控

`src/main/agentSession/background/manager.ts` 的 `task-messages` 与 syncEntry 同构（全量 `GuiChatMessage[]` 含工具输出），200ms 节流但无增量，且 `send()` **无面板门控**——而渲染层只有 `BgTasksPanel` 挂载时才消费它（胶囊只用 tasks 快照）。修复：按父会话订阅（`bgTasks:subscribeMessages` 通道），`BgTasksArea` 传 `presence.mounted` 给 `useBgTasks(sessionId, wantMessages)`，订阅时走 `bgTasks:list` 补齐关面板期间的轮次；任务列表 snapshot 保持无条件推。回归 `test/bgtask-message-gate.mjs`。

### 9.4 未修 / 已核实不是问题

- **未修**：GUI 会话消息无条数/字节上限（调度侧 `chat-history` 有 `MAX_CHAT_DISPLAY=400`，GUI 侧裸奔，单会话已 2.93MB）——用户暂缓。
- **`getHistory` 首帧** 当时 payload 5.91MB（messages 2.93 + trace 2.97；trace 部分已随 2026-09-25 轨迹全链退役消失，现仅剩 messages）但克隆往返实测仅约 14ms：切会话尖刺的主体是**首帧渲染 277 个工具卡的 React 成本**（与 §7 的 render/commit 33% + style/layout 22% 吻合），要治得靠转录虚拟化，改 IPC 无效。
- **不是问题**（实测推翻，勿重复怀疑）：`usage-stats.json` 12KB / 16 日桶 / 170 键、stringify 0.0ms，且「计数桶永久保留」在 `usageStats.ts` 有注释说明是刻意决策；`pty:getBuffer` 启动洪峰真机只 4 个终端会话 ≈ 0.8MB；`JSON.stringify(data,null,2)` 的缩进对 trace 只有 1.1x 耗时、1.0x 字节（大字段是长字符串）。
- **有缓解、暂不动**：扩展 `storage.json` 每次 set 同步整读整写（1MB 硬顶、无 debounce）；`fs:changed` → 多目录 `listDir` 全量 pull（200ms debounce + skip 预筛）；`sessions.broadcast()` 38 处调用无防抖（27 条元数据 payload 小，成本在渲染层列表重渲）。

## 10. 面板开合全局重渲治理（2026-09-15，真机 no-sandbox 普查）

**方法**：`MUSTER_DEVTOOLS_PORT=9333 npm run dev:no-sandbox` + 自写场景普查脚本（20 个开/关/切换场景，每场景分窗采集 longtask / rAF 帧间隙 / event-timing / 交互命中核验；工作目录 `%TEMP%/metaagent-perf`）→ CPU profile → TEMP-PERF 渲染计数（按 sessionId 分账）定位重渲链。**注意 dev 实例与安装版共用真实 userData**：窗口尺寸/会话栏折叠态可能被另一实例的持久化或用户操作改变，普查脚本须每场景前校准状态（用 `.chrome-sessions-toggle.is-open` 判折叠态，折叠态元素在屏外浮层、offsetParent 仍为 true 不可靠）。

**基线（修复前）**：几乎每个面板开/关都伴随 1 个 200-260ms 长任务；会话栏折叠 475-500ms（帧间隙同量级）；命令面板开+关累计 ~1.3s；设置弹窗 ~1.24s；工作区切换 1.9s。

**归因（两层叠加，渲染计数验证）**：

1. **转录 RO 逐帧风暴**：`ChatTranscript` 为批注角标重测量给自己的滚动容器挂了 `ResizeObserver`，任何面板开合动画让中央列宽度逐帧变化 → RO 每帧触发 `layoutTick`，测量 effect 再 `setNotePos`（rows useMemo 依赖 notePos）→ 每帧 2 次 setState × 全部常驻实例。一次会话栏折叠 = 转录重渲 ~100 次。
2. **App 级级联重渲**：App 根每次开合重渲 3-5 次，而六大面板（LeftPanel/CenterPanel/SideToolsPanel/AgentFloat/AgentChatView/ChromeBar）均未 memo，`CenterPanel` 常驻挂载全部会话的 ChatSurface（真机 26 个实例，含非活跃会话保活）全部跟着重渲；且 App 传参有 4 处内联闭包（`onCloseUtilityPanel`×3、`onToggleGlobalBoard` 等），memo 即使加了也守不住。

**修复**：

| 修复 | 位置 | 说明 |
|---|---|---|
| 角标重测量防抖 | `ChatTranscript.tsx` | RO/window resize 统一「尺寸静默 120ms 后补测一轮」；动画期间角标错位 ≤120ms（16px 圆点，可接受） |
| 六大面板 `React.memo` | `LeftPanel`/`CenterPanel`/`SideToolsPanel`/`AgentFloat`/`AgentChatView`/`ChromeBar` | App 级渲染不再级联进面板子树 |
| App 内联回调 useCallback 化 | `App.tsx` | `openSettings`/`closeUtilityPanel`/`toggleGlobalBoard`/`toggleLeftDrawer`/`toggleRightDrawer` |

**复测（同法同机，撤探针后干净代码复跑一致）**：

| 场景 | 前 | 后 |
|---|---|---|
| 会话栏折叠/展开 | 475-500ms | **0 长任务、0 帧>32ms** |
| 设置/看板/调度面板/通知/轨迹切换/使用统计 开合 | 200-250ms | **0 长任务** |
| 命令面板 Ctrl+P 开+关 | ~1300ms 累计 | ~170ms（-87%） |
| 工作区切换（往返） | 1927ms | ~170ms（-91%） |
| 切会话 | max 181ms / sum ~500 | max 57-102ms（重会话首开 212ms 见下） |
| 面板栈返回 | 235ms | 53-59ms |
| 点行内 code / 转录滚动（§7 已修项） | 绿 | 绿（无回归） |

**回归测试**：`test/unit/chat-transcript-ro-debounce.spec.tsx`（风暴不重渲 / 静默 120ms 补测恰好一轮；红灯自检过：还原防抖即转红）、`test/unit/app-panels-memo.spec.ts`（六面板 memo 契约，防重构回裸导出）。typecheck / vitest 49 / `npm test` 127 / e2e 16 全绿。

**剩余已知（收益递减未做）**：命令面板首开 ~90ms；工作区切换 ~100ms；后台任务面板首开 57ms。~~重会话切换首开 212ms~~ 已由折叠真卸载治理（见 §10.1）。

### 10.1 折叠真卸载 + 大栈渐进挂载（2026-09-15 同日，重会话切换首开）

**病症**：切到重会话首开 212ms 长任务。根因：旧实现的历史轮折叠是**视觉折叠**——条目 `display:none` 但全部挂载（刻意保卡内瞬态），真机当前会话 85 个折叠回合合计 **1760 个工具调用**在每次切换时全量挂载。与用户对齐的产品决策：折叠=真卸载（接受卡内瞬态复位）、展开分批渐进、暂不做 turn 级滚动虚拟化（滚动/跳转/选择/Ctrl+F 形态全保留）。

**修复**（`ChatMessageView.tsx`）：①PartsBody 与 legacy 扁平路径，折叠态条目**不渲染**（连 JSX 都不创建），只留折叠头（含条数摘要）与最后一段正文；②`ToolCallStack` 卡片级渐进挂载——首帧放行 40 张、每帧补 160（`TOOL_MOUNT_FIRST/STEP`），流式栈增长同走此节奏；展开重挂、再折叠回收。

**复测（真机 no-sandbox，同法）**：重会话首开长任务 212ms→**94ms**，其余会话切换 0 长任务；展开 27 卡回合即时全挂（≤首屏量）、再折叠卡片归零；当前会话挂载卡片数 0（1760 个工具全部折叠未挂载）。

**回归**：`test/unit/chat-fold-unmount.spec.tsx`（折叠不挂载/展开渐进补齐不丢卡/纯正文不折叠/legacy 同构；红灯自检过：还原旧实现 3 用例转红）。typecheck / vitest 53 / `npm test` 127 / e2e 16 全绿。行为语义变更同步至 [chat-surface.md](chat-surface.md) 与 [gui-worker-session.md](gui-worker-session.md)。

**附带**：perf-trace skill 的 `profiler.mjs` 补了 dev 实例 target fallback（原先只认安装版 `app.asar` URL，dev 的 `localhost:5188` 会报「未找到主窗口」）。

## 11. GitHub PR 页轮询

`PrPanel` 仅在 PR 页签激活且窗口可见时轮询。聚焦或重新可见时补查，上一轮仍在途时合并刷新请求。

列表每 45 秒请求一次，GraphQL 将本页的 CI 结论和讨论活动与 PR 一起返回。文件 Diff 和完整评审讨论按需分页。设备授权状态在有可见页时另行刷新，本机主进程服从 GitHub 给出的轮询间隔。 [PR 工作流](pr-loop.md)

## 12. 大数据路径现状登记（2026-09-26，extreme-review P1-3）

三条大数据路径的**现状基线**（改动登记，防后续无意识放大 payload；均为「不新增 IPC、不改协议」的现状口径）：

1. **`getHistory` 首帧全量**（§9.4：当时 5.91MB / 277 卡；其中 trace 2.97MB 已随 2026-09-25 轨迹退役移除，现基线为 messages ~2.93MB 口径）：渲染层 `attach/resync/sync` 已做 `reconcileById` 引用复用（P1-4，未变消息 === 命中）；**messages payload 本身未变**，tail 采样（B1-8）属 IPC 协议增量、待单独评审，未实施。
2. **`sessions:changed` 500ms 全量广播**：广播形状不变；渲染层 `applySessions` 已做逐会话结构等价 + 全表引用复用（store.tsx `reconcileSessions`），等价命中时零重渲。
3. **`agentSession:*` 推送链**（sync/part/delta）：sync 整表替换已走 `reconcileById`（P1-4）；delta 侧有 `STREAM_REMAP_THROTTLE_MS`（B1-7）+ tool/kind 失配守卫 resync（A2-5-2）。

另：渲染层已挂 `PerformanceObserver('longtask')` 诊断环（`longtaskDiag.ts`，>1s 入 20 条环形缓冲、连续/累计 >2s 走 `reportRendererError`），§7 的「4×~2.3s 未归因冻结」复发时即有现场。

## 13. 2026-09-26 极致优化轮（extreme-review 专项）

> **本轮无新采样数字**：本环境无法起 GUI/CDP，全部数字仍复用 §7 的 2026-09-14 真机基线（v0.1.21）与历史沙盒实测；
> 静态分析口径、四场景（S1–S4）复测清单与前后对比方法已沉淀在 docs/audits/perf-baseline-2026-09-26.md。
> 下文「预期」均为源码机理推断，**真机口径的前后对比待 CDP 复测补齐**（步骤见本节末）。

### 13.1 P0 手术（流式热路径 + 长转录渲染面）

| 项 | 位置 | 内容 |
|---|---|---|
| B1-1 contain 下放 | `styles/chat.css` / `styles/markdown.css` | `content-visibility: auto` 从 `.chat-turn-anchor` 锚点级下放到子块：`.turn-fold-item` / `.tool-call-block`（88→100px 估算高）与 `.md-body > *`（文件预览三变体豁免，虚拟屏发虚决策顺延）；登记表与回滚开关见 [chat-transcript.md](chat-transcript.md) |
| B1-2 无分配深比较 | `shared/guiWorker.ts` | `guiChatMessageEqual` 的工具入参比较由 `JSON.stringify` 整串改为首差异早退的 `jsonEqual`——MB 级工具卡不再为判等产出临时串 |
| B1-4 会话全表 reconcile | `store.tsx` | `sessions:changed`（500ms 心跳）逐会话全字段结构等价（`reconcileSessions`）：等价复用旧引用、全表等价连数组引用一起复用（React bail out 零重渲） |
| B1-5 harness 计量缓存 | `ChatTranscript.tsx` | `hSum`/`hMetrics` 走消息级缓存（同 cardsCache 口径）——带 usage 的 harness 行不再因 src 克隆换引用击穿行 memo |
| B1-6 行级元素缓存 | `ChatTranscript.tsx` | `renderedWindow` 整窗单 useMemo 改为**逐行元素缓存**（31 槽 deps 逐槽 `Object.is`）：未变行复用旧 element，React 跳过整棵子树调和——openBubbleId/notePos/findActive 等只失效受影响行 |
| B1-7 流式重映射限频 | `ChatTranscript.tsx` | `STREAM_REMAP_THROTTLE_MS=100`：仅流式行的 display 重映射限频 ≤10 次/秒（micromark 解析是毫秒级 CPU）；streaming 翻 false 同步终渲保证尾值落地 |
| 排队面板引用稳定 | `orchestratorSurface.tsx` / `agentSessionSurface.tsx` | 快照 `queuedItems` 摘要缓存 + 空队列模块级单例——流式期快照每批重建不再换排队面板 props 引用 |

### 13.2 P1 打磨

- **P1-1 角标量位节流**（`ChatTranscript.tsx`）：量位测量 effect deps 摘除 `messages`（流式期正文逐批增长不再每批强制量位），busy 翻 false 时补量一次作终帧校正。
- **P1-2 画布拖拽合帧**（`freeCanvas/useCanvasPointer.ts`）：拖拽/框选/pan 事件入 ref + rAF 每显示帧至多应用一次（几何+store+state 合并），收口/取消先同步 flush 尾值不丢末位。
- **P1-3 冻结观测 + 大数据路径登记**：`longtaskDiag.ts`（§12）+ §12 三条大数据路径现状登记。
- **P1-4 整表替换 reconcile**（`agentSessionSurface.tsx`）：attach/sync/resync 经 `reconcileById`——未变消息复用旧引用（下游缓存全走 === 命中），全表等价连数组引用复用。

### 13.3 P2 降分配与预热

- **P2-1**（`ChatTranscript.tsx`）：①displayCache 稳态批次零分配（out/streaming 未变不重建 wrapper）；②会话历史面板关闭时 `turnStops` 按签名门控重建（长度+末条 user id），打开时随消息引用更新回复末段预览；③`interleaveCompactionMarkers` 提独立 memo。
- **P2-2 t() options 缓存**（§7 表已更新）：带 options 调用也命中缓存（键排序序列化参与键；含函数值透传）。
- **P2-3**：①`QuickOpen` 的文件枚举（现为带根身份的 `fs.listFiles`，总上限 8000）按工作区/根版本共享在途请求，快速开合并发不再双份拉取，最后消费者退出才取消；②markdown 解析链空闲预热（`MarkdownBody.warmMarkdownParser`，boot 后 idle 渲染样本进游离节点，micromark/remark 首次初始化与 JIT 移出首帧）。

### 13.4 深潜手术（A2 批次，正确性与热点伴生修复）

| 项 | 内容 |
|---|---|
| A2-1-1 | 后台 shell 任务自然退出不再泄漏 pty exitListener（`src/main/agentSession/background/shellTask.ts`） |
| A2-1-2 | 后台子代理 persona 双拼修复（`subagentSystemPromptAppend` 第 5 参改 undefined，与 host 同款单次追加）（该函数已随子代理通用化重构移除） |
| A2-3-1 | 沙箱重置前先关记忆库 SQLite（WAL 句柄锁文件）+ 预清理 30s 看门狗（见 [testing.md](testing.md)「升级时顺手修掉的真 bug」§1） |
| A2-4-2 | 转录索引补 `ingestedSessionId`——索引状态「转录会话数」从恒 0 恢复真实计数 |
| A2-5-1 | 调度面已关闭工作区的消息/快照/排队缓存全部逐出（`workspaces:changed` → `evictDeadWorkspaces`），渲染内存从随工作区数单调增长变有界 |
| A2-5-2 | 调度面 delta 守卫：text/thinking 增量命中 tool 卡/kind 失配/下标跳号时丢弃该批并拉权威历史 resync（不再覆盖落盘，对齐 GUI 面 part 语义） |
| A2-6-1 | `useWorkspaceFile` 增 `cfgRef`，`useGitPrefs` 水合 deps 收窄——并发 patch 换新 cfg 引用不再把会话内已改的 Git 偏好成批回写 |
| A2-6-2 | `.worktrees` 隔离树判定单源化（`shared/worktreePath.ts` 目录边界正则），渲染层行标记与主进程 guard 共用，`my.worktrees-x` 子串误报消除 |
| A2-7-1 | web 网关入口页（`/`、`/index.html`，含 dev fallback）与 `/media` 同口径鉴权，未授权 401（fallback 页内嵌 token 明文）；`/assets/*` 维持放行（见 [web-access.md](web-access.md)） |
| A2-8-1 | `parseCssColor` 百分号通道按 CSS 语义折算（`rgb(100%,0%,0%)` 此前解析成 r=100） |

### 13.5 巨型文件拆分结果（8/8，行为保持，对外 import 路径不变）

| 原文件 | 拆后 |
|---|---|
| `agentSession/host.ts`（3062） | 6 行 re-export 垫片 + `host/` 15 文件（最大 messaging.ts 390） |
| `agent/orchestrator.ts`（2008） | 398 行门面 + `orchestrator/` 15 文件（最大 turnExecution.ts 331） |
| `capabilities/catalog.ts`（2591） | 24 行垫片 + `catalog/` 14 文件（最大 browser.ts 326；组数据按原行号切片搬移，金样 130 工具序列逐位比对） |
| `feishu/bridge.ts`（2445） | 7 行垫片 + `bridge/` 11 文件（最大 turnCard.ts 366） |
| `panels/GitPanel.tsx`（2512） | 8 行垫片 + `gitpanel/` 19 文件（最大 GitPanelCore.tsx 395；effect 保序、两处源码文本合同随迁址） |
| `components/AgentComposer.tsx`（2287） | 380 行编排壳 + `agentComposer/` 20 文件（状态钩子 8 + 纯展示 8 + 纯函数/类型） |
| `panels/FreeCanvas.tsx`（2041） | 274 行组合入口 + `freeCanvas/` 17 文件（纯函数抽出补单测；**useCanvasPointer.ts 435 行微超 400 硬约束**——拆分后 P1-2 合帧逻辑又落进该文件，后续批次收口） |
| `sessions.ts`（2854） | 2158 行（拆出 `sessions/createTerminal.ts` 376、`git/worktreeSessionOps.ts` 369、`git/worktreeIntegrate.ts` 307；主体仍为 ctx 委托门面，完整拆分留后续） |

拆分批每文件带 split-pure 回归锁（`test/{host,sessions,catalog,gitpanel,feishu-bridge-modules,composer-helpers,orchestrator-queue-ops}-*.mjs` 等），行数均为当日 `wc -l` 实测。

### 13.6 静态预期（未经采样验证的机理推断）

对照 §7 的 CPU 归因（React render 33% / style+layout 22% / GC 11% / micromark 9% / i18next 8%）：

- **流式期（token 风暴）**：micromark 重解析 ≤10 次/秒（B1-7）+ 未变行零调和（B1-6）+ 稳态零分配（P2-1）→ render 与 micromark 的流式份额应有可见下降；harness 行不再逐事件击穿 memo（B1-5）。
- **任意会话事件**：500ms 心跳全表等价时零重渲（B1-4）、sync 整表引用复用（P1-4）→ 常驻重渲面收窄到「真变化行」。
- **长转录滚动**：视口外 layout/paint 从锚点级收缩到子块级（B1-1）→ style/layout 份额与首滚后滚动成本应下降；判等不再产 MB 级临时串（B1-2）→ GC 份额应下降。
- **首帧/冷路径**：markdown 链首次初始化与 JIT 移出首帧（P2-3②）；命令面板大仓首开少一次 8000 路径重复 IPC（P2-3①）。
- **正确性伴生**：delta 守卫（A2-5-2）防工具卡被文本增量覆盖成永久错块；pty 监听泄漏（A2-1-1）与渲染内存无界（A2-5-1）收口。

### 13.7 后续 CDP 复测步骤（S1–S4）

方法总纲见 §5（dev 实例）与 §7（安装版附加）；场景级代码入口、风险点、探针口径与判定线见 perf-baseline-2026-09-26.md §2/§4。要点：

1. 启动：`MUSTER_DEVTOOLS_PORT=9333 npm run dev:no-sandbox` → `http://127.0.0.1:9333/json/list` 取 page target → ws 驱动（Runtime.evaluate 探 DOM / Input.dispatchMouseEvent 真实点击 / rAF 帧间隙 / longtask / event-timing）。dev 共享真实 userData：测前校准 UI 状态、测后 `sessions.close` 清理（§5）；每场景先 bringToFront（遮挡窗口 rAF 节流）。
2. **S1 长转录滚动**：造 ≥400 条 markdown 会话，**分「阈值下（400–499，无窗口裁剪）」与「阈值上（≥501，尾部 120 窗）」两个口径**，首滚（content-visibility 冷）与回滚（热）分段统计帧间隙 p95/p99；「加载更早」点击帧单独口径。
3. **S2 会话切换 + 点击**：连切含重会话首开（§10.1 锚点 94ms）；真实点击行内 `code` / `.ws-file-link` / `.tool-card` / `.session-item` / `.agent-notify-bubble`（§7 真机 240–370ms 对象），交互 p95≤50ms / p99≤150ms 判定。
4. **S3 Git**：切仓点击（§2 锚点 11–23ms）冷/热分离；>1500 行 diff 首屏与「展开剩余」单独口径。
5. **S4 看板/画布/命令面板**：board-card 点击、画布拖拽与连线（P1-2 合帧后的帧间隙）、命令面板首开/热开（§10 锚点 ~170ms/首开 ~90ms）。
6. **对照纪律**：同法同机同场景、探针脚本不变，「修复前=§7/§10 真机数字」vs「修复后」成表；§7 修复实施节的沙盒造数法（`window.api.sessions.create({runtime:'pi'})` + `agentSession.send`）可复用；全流程 skill 见 `.agents/skills/perf-trace/SKILL.md`。

## 14. 多源根文件监听注册（2026-10-01）

WorkspaceFsWatcher 按真实路径与目录身份共享物理范围：普通父子源根只订阅父根，跨工作区的 Junction 别名复用同一订阅；显式登记到父监听跳过目录内的根保留独立订阅。事件按逻辑根转换路径与版本，先过滤跳过目录，每根 200ms 合批、最多 1000 个路径，溢出为根级刷新。该上限限制队列和 IPC 体积；不能据此推导操作系统不产生被过滤的事件。

在 Windows 的 `D:\MetaApp` 仅建立/关闭原生监听，未递归枚举文件，也未写入工程。读取一级子目录构造两个配置场景，各采样三次：

| 登记场景 | 逻辑根数 | 原生句柄数 | 注册耗时（ms，三次） |
|---|---:|---:|---|
| 仅父目录 | 1 | 1 | 1.16 / 0.53 / 0.50 |
| 父目录与 26 个子目录 | 27 | 1 | 10.05 / 4.34 / 3.93 |

脚本及原始结果保存在本地忽略目录 `.tmp/watch-roots-perf.mjs`、`.tmp/watch-roots-perf.json`。数字只覆盖配置解析、realpath/stat 和原生监听注册；不覆盖搜索、Git 发现、派活或持续事件风暴的端到端延迟。未增加 `Content/` 等业务目录排除。

`test/workspace-fs-watch-roots.mjs` 同时验证共享句柄、重叠/别名事件、旧版本丢弃、失败/手动重试、目录同路径重建和真实 Windows 文件变化；Electron 文件页 E2E 验证第二根外改刷新编辑器及第一根同名文件隔离。文件页隐藏后补读和脏编辑保护由组件回归覆盖。详情见 [文件面板](files-panel.md)。

## 15. 多源根有界文件查询（2026-10-01）

WorkspaceQueries 聚合已选物理根；父根排除已选子根、别名去重，在线根分配固定份额并交错返回。所有请求共享最多 2 个 rg 子进程，排队计入整体时限。文件结果进行真实路径检查，根在查询前后进行 realpath/目录身份检查；这些成本包含在下表中。@ 保持隐藏/忽略文件枚举语义，总预算 2000、菜单最多 40 项；仅候选及状态通过 IPC 传到菜单。

在 `D:\MetaApp` 只读运行原生 rg 文件列表查询，沿用已有跳过目录，不增加 Content 等业务排除。父目录与 26 个一级子目录构成第二场景，各采样三次：

| 登记场景 | 逻辑根数 | 总预算 | 返回数 | 截断根数 | 耗时（ms，三次） |
|---|---:|---:|---:|---:|---|
| 仅父目录 | 1 | 2000 | 2000 | 1 | 340.76 / 351.24 / 419.75 |
| 父目录与 26 个子目录 | 27 | 2000 | 1257 | 13 | 1023.74 / 1010.85 / 995.45 |

两场景均无查询错误或取消。固定份额未使用的预算暂不回收，因此多根场景返回数小于 2000；数字不能代表全量扫描完成，也不包含渲染、Git 发现或隔离派活。当前文件查询未实现缓存，Git 发现快照缓存为独立功能。脚本与原始结果位于本地忽略目录 `.tmp/workspace-queries-perf.mjs`、`.tmp/workspace-queries-perf.json`。

`test/workspace-queries.mjs` 验证真实 rg 的总预算、公平输出、特殊字符子根排除、隐藏/忽略语义、越界 Junction、跨请求并发、取消与根版本/位置变化；`test/workspace-rg-cancel.mjs` 验证流式进程的提前取消、在途终止、超时、截断和监听释放。

## 16. 聊天转写真机矩阵：阈值两侧与流式（2026-10-04，状态竞态修复轮）

背景：聊天状态审查 提出的真机验收缺口，随 U1/U2/U3 修复一并采集（修复详情见 验收记录）。

环境：Electron dev（CDP），mock LLM 真实回合播种的 GUI pi 会话（Markdown/行内代码/代码块/表格轮换），**每会话一次冷启动**（中栏按会话 keep-alive 多挂载，跨会话连续采集会把隐藏转写计入全局 DOM 计数——首轮踩过，测量协议须冷启动分轮）。视口 1600×960@1（400 会话 1649×961@1）。数据文件：`docs/audits/evidence/clean-perf-*.json`。

**口径**：帧统计只记录 >16.7ms 的帧间隙（观察器过滤），本节不以帧分位数宣称达标，主口径为「>20/50/100ms 掉帧次数」与长任务；「事件到可见」实测为 MutationObserver 观察到用户标记节点插入（非 paint/上屏口径），非 assistant 首 token 到绘制；「上翻」为程序分档 scrollTop 赋值（模拟上翻节奏，非真实手动滚动）。

| 场景 | 观测 | 判定 |
| --- | --- | --- |
| 流式（真实回合） | 用户标记节点插入 144ms；无长任务；>20ms 间隙 5 次、>50ms 0 次 | 观测口径内未见异常 |
| 程序滚动至顶（12 档 scrollTop 赋值 ×4 会话） | >20ms 间隙 0 次，无长任务 | 观测口径内未见异常 |
| 初次显示·裁剪侧（502/2000 条，尾窗 120 行） | 1 个长任务 113/115ms；>100ms 间隙 1 次；heap 56/54MB | 长任务超 100ms 阈，一次挂载成本 |
| 初次显示·未裁剪侧（408/500 条全量挂载） | 1 个长任务 251/303ms；>100ms 间隙 1 次 | 随全量消息数增长；**无对照基线，无法归因是否本轮引入**，后续优化候选 |
| 「加载更早」回填 +240 行 | 133/134ms 长任务 ×1（用户主动，单列） | 单列不计入滚动口径 |
| 裁剪阈值行为 | 500 条无回填按钮、501 条起尾窗 120 + 回填 +240 | 与 `chat-transcript.md` 设计一致 |

结论（如实）：修复（渲染层零改动，仅事件路径 O(1) 时钟比较）后，流式/滚动在观测口径内未见掉帧异常；**不宣称满足 p95≤20ms/p99≤50ms 验收目标**（无全帧分位统计）；未裁剪会话初次挂载一次性长任务（500 条 ≈303ms）登记为后续优化候选（候选方向：初次挂载分批挂载/首屏窗口化，与二期虚拟化合并评估）。未实测：全帧分位、assistant 首 token 到绘制、手机 L3、Web 桌面、固定速率重放、真机多轮工作区开关 heap 曲线（清单见验收记录）。

## 17. 能力管理：后台扫描与长列表（2026-10-08）

用户反馈技能页滚动卡顿、列表底部选中后详情留在顶部。旧构建的隔离真实 Electron（220 项、默认硬件 GPU）确认底部点击后详情 top=-20421px，完全不在视口；主进程 3 秒扫描周期造成约 287–327ms 间隙，发生清单刷新时观察到最长 1075ms。同期 renderer rAF 最大 17.8ms、无 longtask，因此后台同步阻塞属实，但不能直接认定它就是用户的渲染卡顿原因。

热点在 `main/capabilityManagement/skills.ts`：项目观察重复全局扫描、单次多次 realpath、正文重复读取/解析、观察器递归枚举不参与指纹的附件。修复改为单轮共享物理解析、全局只观察一次、观察不枚举附件、正文按完整 stat 身份缓存；公开清单仍枚举最新附件。watch/手动刷新清缓存，保存前仍重新读取原文比较 hash、检查物理身份，没有把缓存作为写入守卫。隐藏设置页只累积失效，可见页按类别合并通知读取。

同机隔离文件对照：120 个全局技能，每根 30 个项目技能及一个脚本附件；编译并调用实际 production service，分别计量冷观察、两次未变化观察和公开清单，包装同步 FS 计数。四 scope 场景将四个源根同时提供给各 scope，是共享多根压力场景，不能表述为四个互不相交项目。数字为单次调用，非生产用户全盘扫描基准。

| 场景 | 未变化观察前→后（ms，两次） | realpath 次数前→后 | SKILL.md 读取前→后 | 未变化公开清单前→后（ms） |
|---|---|---|---|---|
| 单项目 | 285.5 / 325.7 → 61.6 / 61.4 | 1397 → 306 | 270 → 0 | 240.0 → 69.2 |
| 四 scope 共享四根 | 1167.4 / 1125.8 → 142.4 / 140.6 | 5750 → 498 | 1080 → 0 | 459.5 → 127.1 |

本机原始证据 `.tmp/capability-perf-evidence/{baseline,final}-backend.json`，脚本 `.tmp/capability-skills-scan-benchmark.mjs`。`test/capability-skills-management.mjs` 覆盖全局单次观察/资源不枚举/稳态零正文读取、资源新增仍可见、同长度恢复 mtime 的外改、Junction 换源和 stat 缓存命中时保存仍拒绝覆盖。

现场新 UI（热更新后、29 项）首次绘制 trace 中 Paint 最大 0.743ms、RasterTask 0.283ms、GPU 主任务 4.91ms；presentation 最大间隔49.229ms，不能只以 rAF 最大17ms宣称零掉帧。60 次大步输入仅14次实际位移，其余停在边界。连续小步补采集出现约1Hz调度、截图超时，且包含热更新、缺可见性数据，不能用于流畅验收或认定后台节流因果；诊断进程和探针已清理，保留 `.tmp/capability-perf-live/`、`.tmp/capability-perf-live-continuous/` 原始 trace及分析。

最终固定构建、默认硬件 GPU、220 项、前台 hidden=false/focus=true：两轮滚轮 rAF p95/p99为16.8/16.9ms，保留一次33.3ms间隙，没有>50ms间隙或 longtask；稳态主进程间隙153.2ms（旧287ms），发生变更的 skillsList116.8ms（旧754.7ms），不声称后台已经零阻塞。底部详情top192.8px且可见（旧-20421px）。

独立3.283秒小步连续呈现采集确认60次输入全部产生位移，Chromium scroll-jank均false；有效输入EventLatency中位24.920ms/p95 32.277ms/最大32.957ms，提交到presentation最大15.922ms。Paint最大2.383ms、RasterTask0.308ms、GPU进程任务1.275ms，无持续绘制长块，DroppedFrame与main-thread missed deadline均0。raw AnimationFrame::Presentation包含未绑定帧ID及近同时记录，其最大33.183ms间隔不能换算掉帧次数。本轮约1Hz异常在固定前台采集中未复现，仍不能倒推旧现场原因或保证任意场景零延迟。证据 `.tmp/capability-perf-evidence/{baseline,final}.json`、`final.trace.json`、`final-trace-analysis.json/md`；采集脚本 `.tmp/capability-performance-run.mjs`。真实Electron长列表/深浅窄屏/下拉与焦点验收见 [capability-management.md](capability-management.md)。

## 18. 当前会话滚动与虚拟屏切换（2026-10-13）

直接附加用户已打开的开发实例（v0.1.29 / Electron 43.7.0 / Chromium 150），当前长会话、内嵌部件与右侧表格网页，1920×1032。没有重启/造数/切工作区或发消息。52.4 秒主线程 CPU 与浏览器级渲染 trace、原始 rAF/longtask、分段标记保存于 `.tmp/perf-captures/current-1791895894463/`；trace 约 60.4MB、300,086 事件，CPU 12,121 样本，按实际 timeDeltas 分析。时间轴首标记误差约 0.054ms。完整方法、文件和边界见 专项报告。

| 原生输入场景 | 主窗口 rAF | p99 / 最大间隙 | 长任务 |
|---|---:|---:|---:|
| 单独聊天滚轮，8.0s | 59.9fps | 16.8 / 17.9ms | 0 |
| 控件上的滚轮，7.7s | 59.9fps | 16.8 / 16.9ms | 0 |
| 虚拟屏五次往返，12.0s | 45.5fps | 166.6 / 183.3ms | 20，最长 203ms、累计 3.136s |

切屏段 ReactMarkdown 调用约 2.100s，其中 Markdown 解析约 1.925s（包含关系）。主要可验证回归在 `ChatMessageView.tsx` 为每段正文创建新的 suppressedArtifacts 数组，包括末段空数组，再传给 UiArtifactSuppressionContext；`MarkdownBody.tsx` 消费 Context 并以其引用 memo 插件。Context 改变会穿过 React.memo，正文不变仍会重解析。真机往返观测到 37 个 Provider 的内容相同但引用改变。

因果对照使用同进程隐藏容器中的生产 MarkdownBody / Context，约 31.8K 字同一正文与稳定属性，十二次更新仅改变 Context 引用：每次新数组两轮 349.4/360.3ms、各十二次 Profiler 提交；复用数组 26.5/30.3ms、各一次提交（第一轮引用转变）。这是修复前的单组件因果证据，不能把比例宣称为整页收益。

已修复三条重复工作路径：消息级一次收集产物，空抑制值共享、非空路径按值保持引用；`MarkdownContent` 将解析与外层样式分开；`FileEditor.onMdLink` 复用现有 `jumpCtxRef`，点击读取最新路径/回调，避免两个长文件预览随切屏重新解析。侧栏 `SessionRailContent` 后续随整行悬浮详情改为纯静态布局，已移除全文测量、RO/MO 订阅和旧展开状态，不再在父级重渲时读取文字布局。这些优化减少更新传播、事件引用变化和同步布局读取，没有新增正文/AST 历史缓存。

修复阶段附加到已运行的新开发进程，原始目录 `.tmp/perf-captures/fix/`。热更新曾改变挂载规模并使文件预览为空；相关低耗时对照不作为正文优化收益证据，恢复完整预览后再验。最终 `restored-final/`：同一会话、71 个聊天视图、6,163 个 DOM、3 个 iframe；两份长 Markdown 原文仍为 12,498/6,751 字符，切屏前后叶属性一致。十次原生点击切屏 10.23s，rAF 59.8fps、p99 16.8ms、最大 18.3ms、>20ms 间隙 0、longtask 0；event timing p95 40ms/最大 48ms。CPU 未采到 Markdown 解析，React renderRoot 约 25.4ms，主线程 Layout 约 5.8ms。与原始 15,467 DOM 实例的数字不作百分比比较。

回归先红后绿：消息外观/克隆不重解析、真实抑制更新仍生效、样式隔离/新正文/最新链接动作、侧栏父更新零测量/徽标增删与缩放/卸载、文件预览可见性与导航回调更换不解析且点击使用新目录。10 个组件文件/72 用例、3 个定向纯逻辑文件、web/node/test 类型检查及生产构建通过。当前页面的原生切屏与截图有效，单独滚轮采集未见长任务；人工拖动、混合手势/流式输出及完整 GPU 呈现验收仍未覆盖。rAF 不等于最终呈现帧率，保活实例数量本身尚未独立定责。原始 trace、CPU 文件与自测截图仅保留在本地。

提交暂存快档存在已复核的基线失败：`frame-backdrop.mjs` 的旧 `--bg-frame` CSS 断言与 HEAD 的 `--surface-frame` 不符；该用例在 HEAD 同样失败，本次没有改动背景样式或守卫。快档类型/组件和其他 15 个离线文件通过，整体门禁未全绿，详情见专项报告。

## 19. 整机流畅度专项：三热点修复（2026-10-14）

> 分支 `perf/smoothness-sweep-2026-10-14`。方法：perf-trace 流程（CDP 9333 真实
> userData dev 实例 + 自写场景普查脚本 `.tmp/perf-captures/sweep-2026-10-14/sweep.mjs`
> ——13 类场景×原生输入、页内探针按标记窗口分账；CPU profile 按长任务窗口 QPC
> 对齐切片；style invalidation tracking 定肇因）。冷/负载双口径：冷=重启后首测，
> 负载=重会话挂载后（DOM 13–15k，模拟使用半天）。

**基线普查结论（修前）**：滚动（轻/重会话）、打字、VS 切屏、设置、右栏页签、
抽屉开合、会话切换/热开在当时已测的历史窗口中记录为 0 长任务、rAF 约 60Hz；该记录不覆盖其他会话、保活规模、主进程或实际合成呈现。那轮继续处理了以下三处热点：
①命令面板每次开 48–136ms 事件延迟（首开含主进程 rg 枚举）；②工作区切换
137–176ms 长任务（负载态）；③重会话（12MB/1000+ parts）首开 93–145ms 长任务 +
多帧 117–150ms 间隙。

### 19.1 重会话首开渐进挂载（ChatTranscript）

归因：一次性挂载全部行的原生 style/layout/paint（单帧压成 100ms+）+ 末段正文
micromark 解析。修复：按 part 预算首帧只挂尾部一屏、每帧 rAF 自尾部补 140 parts
（真机 ~200ms 走完），prepend 锚定还原防跳位；reveal/查找命中立即放行；parts ≤600
零行为差异（机制详见 [chat-transcript.md](chat-transcript.md)）。

实测（12MB/1845、1049、1870 parts 三会话）：首开长任务 **93/119/145ms →
62/87/88ms**，多帧间隙 **117–150ms → 67–117ms（多数 83 内）**；滚动/热开/查找/
停靠点跳转行为不变（所有行最终全量挂载，实测锚点数 = 消息数）。剩余 ~60ms 单任务
为 12MB getHistory 的 IPC 反序列化（原生 JSON parse，一次性；tail 采样属 B1-8
协议增量，未动）。

### 19.2 工作区切换：外观 no-op 发布跳过（theme.ts）

归因（invalidation tracking，单次切换 4254 个失效事件）：`setWorkspaceAppearance`
换 workspaceId 即无条件 `publishAppearance`——root CSS 变量重写 + 全部订阅方
（N 个保活 TerminalView/FileEditor）重配 xterm/CodeMirror 主题 → **动态样式表
变动（@keyframes/Style rule change 833+464 次）级联成近全文档 style recalc**
（单次 6902 节点）。未定制各区别色时（accent 全 null）这些发布是纯 no-op。

修复：`publishAppearance` 以外观签名（cssVars/terminal/nativeChrome/appearance/
材质，**不含 workspaceId**）判等，签名不变直接跳过——root 写入、订阅方通知、
revision 自增全免。真实配色变化（accent/材质/主题）照常发布。

实测（负载态 13k DOM，同法同机）：切换长任务 **176/137/143ms → 61/68/62ms**
（-60%）；冷态 69–89ms → 54–79ms。顺带消除 AgentFloat（useSyncExternalStore）
在 no-op 发布时的空转重渲。

### 19.3 命令面板：枚举缓存跨开合存活 + 空闲预热（useQuickOpenQueries）

归因：hook 实例缓存随 QuickOpen 卸载即丢，每次打开重新 `fs.listFiles`（主进程 rg
+ IPC 往返，首开 128ms）；渲染层在等 IPC 时 idle。

修复（感知层，stale-while-revalidate）：①模块级结果缓存（scope=workspaceId+
rootsRevision，容量 6，卸载后到达也入缓存）——再开立即出旧结果、后台照常拉新；
②`prewarmQuickOpenFiles`：App 在 boot 后/切工作区后的空闲档（requestIdleCallback，
12s 超时）后台枚举当前工作区垫缓存——首次 Ctrl+P 即命中。附 cancelQuery 防御
（`Promise.resolve` 包住，mock/异常桥不炸）。

实测：打开 keydown→首帧 rAF **8–15ms**（探针实测三连开）；无长任务。

### 19.4 回归与遗留

- 回归：`chat-transcript-progressive.spec.tsx`（5）、`resolved-appearance.spec.tsx`
  no-op 用例（1）、`quick-open-files-cache.spec.tsx`（3），全部红灯自检过（还原
  修复即转红）；typecheck 三套 / `npm test` 17 项全绿。附带修掉 §18 登记的既有红
  `frame-backdrop.mjs`（断言从 `--bg-frame` 迁到 `--surface-frame`）。
- **遗留（既有，非本轮引入）**：①保活累积税——**已落地**（用户当日拍板授权
  LRU 行为变更，实施与实测见下方 §19.5）；②重会话首开 ~60ms 底=
  getHistory 全量 IPC 反序列化（B1-8 tail 采样待立项）；③SessionRailContent 每
  行 3–4 次 getBoundingClientRect 的挂载测量（工作区切换剩余 60ms 的一半），
  延迟测量会引入一帧截断闪烁，暂不动。
- 证据目录：`.tmp/perf-captures/sweep-2026-10-14/`（sweep-*.json ×7、
  cpu-*.cpuprofile ×4、脚手架脚本）。

### 19.5 保活 LRU + 阅读位置记忆（同日落地，用户拍板授权）

§19.4 遗留①的产品决策当日到位：**LRU 上限被授权为可接受的行为变更**（远会话
切回重付首开 + 滚动位置/瞬态复位，按用户拍板执行 N=16 + 滚动位置记忆方案）。

**实现**：

- `sessionViewLru.ts`（新模块）：容量 `SESSION_VIEW_LRU_CAP = 16`；「访问」=
  成为中栏选中（displayActiveId）或分屏 pane 引用；显示中的会话在渲染过滤
  （`keptSessionViews` 纯函数）里恒保（不依赖 touch 时序，LRU 永不逐出正在
  显示的视图）；池内 touch 只移位不通知（切会话零额外重渲）；会话删除经
  `retainSessionViews` 清池位。
- `CenterPanel`：渲染从 `terminals.map` 改为 `keptTerminals.map`（LRU 池 ∪
  显示中）；`onFocusMain` 的 DOM 根序映射同步换用 keptTerminals。
- `ChatTranscript` 阅读位置记忆：模块级 Map（容量 64），滚动中持续记绝对
  scrollTop/clipExtra，**滚动停止 150ms 后节流补记锚定消息**（视口顶行
  mid + 相对偏移——不能在卸载时量：LRU 逐出前视图已 display:none 几何全
  0）。重挂（挂载期 effect）恢复回填窗口 clipExtra，渐进挂载走满后一拍
  恢复位置；**锚定行优先、绝对值兜底**——content-visibility 离屏块的估算
  高度随进入视口真实化，同一消息集的绝对 scrollHeight 跨挂载会漂移（实测
  5507→7346→9959 三态），绝对值恢复会落偏几行。reveal/查找显式跳转优先于
  位置恢复；回到底部即清记忆（贴底是重挂默认）。
- 渐进挂载补漏：重挂首拍转录未到（displayMessages 空）时不再提前定预算
  （否则渐进失效全量一挂），改为首个非空拍再定。

**真机实测**（CDP，同法）：

| 指标 | 修前（全量保活） | 修后（LRU=16） |
|---|---|---|
| boot 后 DOM / 视图壳 | 5692 / 71 | **1748 / 0**（-69%） |
| 访问 18-22 个会话后 | DOM 随访问数单调涨 | **views 恒 16，DOM 随池内会话重量 5-14k 有界** |
| 逐出重挂（12MB 重会话） | —（从不卸载） | rows=48 全量恢复，位置恢复视口顶行差 1 行 |
| 负载态设置冷开 | 3×67ms | **1×53ms** |
| 负载态归档展开 | 96ms | **0 长任务** |
| 负载态抽屉折叠 | 63-68ms | **55-60ms** |

**已知边界**：①恢复位置受 cv 估算高→真实化漂移影响，落点可能在记忆位置
±几行（与「加载更早」回填同类既有边界，chat-transcript.md 登记）；滚动后
150ms 内被逐出的极端情况退绝对值恢复。②终端视图一期不做滚动记忆：重挂由
主进程 pty buffer 重建 scrollback，视口回底。③分屏引用的会话恒保活（touch），
恶意构造 3 pane 最多 3 个「钉子」会话，不构成泄漏。④新建但从未显示的会话
不再预挂壳（原行为：全量壳常驻）——首次点击才挂载，多一帧壳挂载成本无感。

回归：`session-view-lru.spec.ts`（5，纯逻辑）、`chat-transcript-scroll-memory.spec.tsx`
（4）全绿且红灯自检过（去逐出/去恢复 effect 即红）；typecheck×3 + `npm test`
17 项全绿。验证脚本 `.tmp/perf-captures/sweep-2026-10-14/{lru-verify,evict-verify,
e2e-evict,restore-trace,touch-audit}.mjs`。

## 20. 浏览器恢复原生 webview（2026-10-14）

用户反馈网页滚动、动画和输入同时卡顿。此前浏览器使用独立 offscreen 页面，把每帧同步 PNG 编码后经 IPC 交给 renderer 展示，再把人工输入转发回执行页。1280×900 的隔离探针中，12fps 配置实际约 7fps，单帧 PNG 编码中位数约 140.7ms、p90 约 143.4ms；原始结果位于 `.tmp/browser-perf-2026-10-14/probe/results.json`。该数字是最小探针对编码成本的证据，不是整机或全部站点的性能验收。

按用户确认的方案移除上述执行窗口、连续帧编码/订阅/解码与人工输入转发。网页显示、滚动、动画、文本及 IME 回到 Chromium 原生 webview；切页只改变同一 guest 的显隐，后台页面固定非零布局保留 DOM 状态。AI 采用不授予 user gesture 的 DOM 语义动作，每页 FIFO、不同页面独立；原生按键/悬停/拖拽等明确拒绝，不通过切前台满足动作。职责与文件入口见 [内置浏览器](builtin-browser.md)。

显式截图、回合取证和用户请求的录屏仍允许产生图像文件，均不参与日常浏览呈现。`browser.screenshot` 在后台 guest 采集前会短暂让目标 surface 可合成，保持后台命中隔离和宿主焦点，完成后恢复隐藏样式；普通后台录屏仍不自动显页，因为持续 screencast 需要稳定的前台合成帧。原生人工输入与后台工具隔离以真实 Electron 用例验收，不把删除编码路径等同于所有网页都达到固定帧率；物理键盘、中文输入法候选窗及外部复杂站点仍需对应人工验收。

## 21. 真实大会话与界面切换专项（2026-10-16）

实测对象为生产 bundle、真实 userData 中 MetaApp 三个与 TestMetaAgent 两个大会话，保持原有折叠和内容语义。完整采样、异常与验收边界见 专项报告。不以 60fps 或零长任务作结束条件。

**先减少工作**：

- Skills 的目录发现仍共用同一生成器；显式清单完整同步读取，后台观察按约 4ms 或 32 步让出事件循环，同轮复用物理目录事实，保留所有逻辑来源与作用域。单飞加一个合并后续轮，epoch/store/拓扑校验防旧结果回填，普通 watch 不使正在进行的扫描饥饿。物理身份每轮重验，单次文件系统操作或 YAML 解析不承诺 4ms 上限。MCP 同轮复用解析、使用 native realpath；工作区精确根匹配避免重复 IO，但保留较早物理别名优先与共享源歧义。见 [能力管理](capability-management.md)。
- 大会话恢复与未打开会话的历史读取使用 `loadSnapshot` 一次读解析，原先四次全文解析合一；不引入跨调用磁盘历史缓存。原生保活视图重现仍请求最新历史，已完整应用且版本匹配的 live entry 可省去正文载荷，小元数据每次刷新；消息写入推进 UUID/revision，过渡态/失步/磁盘/Web 保守全量。会话消息/队列引用按源与实际可见字段复用，壳组件只订阅空态，UI 动作独立稳定 Context，头像依赖实际原始字段。见 [GUI Worker](gui-worker-session.md)、[聊天表面](chat-surface.md)。
- 已离开贴底态的连续向上 wheel 不重复遍历祖先样式；关闭或隐藏查找不扫整段文本和全部历史。工具显示对象按不可变工具内容缓存，卡片 memo；普通无产物消息跳过最终正文引用扫描，普通 Markdown 不复制整棵 AST。见 [转录](chat-transcript.md)、[查找](chat-find.md)。
- 会话栏折叠栈只有几何输入变化才同步读 offset，等价 JSX 不重新测量；同一个 ResizeObserver 观察容器与直接子项 border-box，覆盖总高度未变的项尺寸变化。见 [会话栏](sessions-dock.md)。

**界面与样式**：设置内容首次访问才挂载，访问后保留 DOM、草稿和滚动，父级保存/撤销流程不变。原生材质遮挡改由真实 SettingsModal DOM 生命周期持有 `has-settings-page`，退出动画期间保留，lazy 未落 DOM 前不隐藏工作台；去掉根级 `:has(> .settings-page)` 对任何内部插入/移除触发的整树样式失效。见 [设置](settings.md)、[框与纸面](frame-backdrop.md)。

看板首次实际展示后只保留唯一 BorderBeam 样式外壳，避免反复注册/注销全局 `<style>` 与 `@property`；完全关闭后业务子树照常销毁，外壳 display:none/inert/aria-hidden、strength=0、无运行装饰。显式固定库原默认内部半径，禁止 children 更换引发自动测半径和样式表重写，真实几何继续由共享圆角 token 覆盖。未把首次注册成本移到启动。见 [全局看板](global-board.md)。

**复测规则**：技能提供真实 wheel/导航、主进程 CPU/事件循环、trace/可选 invalidation、资源采样和严格比较脚本；采集失败非零并保留文件。滚动比较核对实际输入节奏、内容见证、几何和恢复位置，不同条件不输出收益百分比。rAF 回调、EventLatency、明确 ScrollJank 标记与合成呈现分别报告。原始 profile/截图仅放私有 `.tmp/`。

最终同场景 12 次热切换估计累计分配约 249→88MB，其中 V8 API 根约 158→2.5MB；80 次正式循环堆峰约 125MB（历史传输优化前约 678MB），无强制 GC。这是本机分配压力证据，不是长期无泄漏验收。设置整页仍约 63–76ms、看板首次约 78ms，滚动/工作区尚有 83–96ms 尖刺；两次 CDP 超时未定位，失败证据与后续正式 80 次通过均记录在报告，不能归并成全绿保证。

### 21.1 工作区切换过场收紧与测量避让（2026-11-10）

用户反馈工作区胶片略显拖沓。本轮为工作区单独增加 `--dur-workspace=360ms` 与 `--dur-workspacefade=160ms`，不改变虚拟屏和其他大位移动效；`workspaceTransit.ts` 仍保持「滑到骨架后才发切区 IPC」和 pending 防重入。切换窗口内，左栏会话/工具栈暂停 `CollapsibleRailStack` 的同步几何读取，`useListKeyboardNav` 和右侧标签栏也暂停非关键 `scrollIntoView`，过场结束后再补测量或以 0ms 任务恢复标签 reveal。

真实 Electron dev target（1920×1032、DPR 1、可见空闲 rAF 约 59.9Hz）固定同一工作区栈往返 3 轮、共 6 次切换；基线与 after 使用同一 manifest，保留原始报告于 `.tmp/perf-workspace-switch-2026-11-10/`。可比结果：ready 时间从 **1,111–1,352ms** 降到 **863–926ms**，每步 Long Task 总时长从 **242–253ms** 降到 **122–138ms**，renderer TaskDuration 从 **683–750ms** 降到 **465–549ms**；帧间隙 p95 从 **64–91ms** 降到 **47–76ms**，p99 从 **172–188ms** 降到 **131–148ms**。这是同机同场景的 renderer 调度证据，仍不等于 GPU/合成呈现验收；heap 是未强制 GC 的单次快照，不能据此判断长期泄漏。一次 after 采集因目标当时已是当前工作区而形成无动画步骤，real-bench 报样本无效并保留；随后校正起点后正式 after 与基线可比。

## 22. 滚动触感与局部反馈（2026-10-17）


本机交互偏好默认保留native；显式利落/柔和对粗粒度滚轮做有界缓动，精细/高频/衰减及嵌套消费保持原生。距离倍率只作用增强分支。原生与增强的位移/时长有意不同，不能跨档把少走距离或更早ready当作性能收益。系统或用户减少动态会同步到CSS及JS取消路径。入口见 [设置](settings.md)、[动画系统](animation-system.md)。

`transcriptScrollController` 对wheel使用相对剩余位移与单个可见正文witness，分离离屏内容高度结算；不保存跨结算失效的绝对终点，不逐帧全树布局。自动跟随更新不重启原截止时刻，隐藏/卸载无持续任务；主动远跳只播放末屏、用户随时接管，历史恢复不播放长途滑行。查找身份按消息/序号primitive复用，普通帧复用已连接目标节点，仅断连才重解。有限阅读锚点修正及已知边界见 [转录](chat-transcript.md)。

当前pane竖条只动画transform/opacity；分段控件在选择、字体、容器/页面显隐变化时校准一次，不创建rAF循环；按钮、复制与保存反馈保持点击区域和布局稳定。已有预取/presence继续复用，没有为了视觉延迟导航或新增隐藏页面持续渲染。实现、失败记录与证据口径见 触感验收。

设置开关的追加归因确认原生材质遮底仍有整树visibility结算：现仅对直接顶栏/主区父容器即时opacity遮挡，并在真实设置DOM生命周期持有inert，保存并恢复原值；单属性观察跟随晚到的材质确认，退场期间不提前恢复。组件、生产CSS像素及真实Mica焦点/Tab分别验证。两轮同口径CPU采样场景中打开长帧约102–111→53–55ms、关闭约89–90→51–61ms；仍有约50ms级开销，不以跨过60fps阈值宣称完成所有性能优化。

## 23. Pi 空会话首次发送：技能策略阻塞（2026-10-25）

触发链为 `host/turn.ensureConnection` → `PiRuntimeDriver.connect` → SDK 资源加载 → 技能管理过滤；首轮的技能展开还可能重新加载清单。原 `filterRuntimeSkills` 为每个作用域调用设置页 `list`，扫描附带资源、构造展示关联，并在每个候选的 `discoveryDisabled` 中重建来源目录、重复真实路径解析。函数运行在 Electron 主进程，异步连接外壳不会让这些同步操作自动异步化。

修复沿用现有扫描生成器，运行时不枚举附带文件、不构造设置页展示结构；全局扫描一次、同轮共享物理事实；`prepareRuntimeSkillFilter` 分段执行元数据扫描。同步准入对目录和候选身份只在单次调用内解析一次。`createSkillSourceLoader` 覆盖 GUI、调度、技能菜单及 SDK 原生 reload，重载串行且每次重新准备，配置/拓扑变化或服务关闭拒绝陈旧策略。设置页原文与资源清单保持原行为。

本机只读默认技能来源 + 当前项目、隔离管理存储的受控测量：57 个 SDK 候选，修复前单次完整同步过滤 2.58–4.25 秒、477 次 readdir；移除资源遍历后 46 次 readdir，但仍有每技能重复目录解析。分段扫描后单独测出该同步准入循环仍达 2.52–4.16 秒。去除重复解析后，三轮准入约 53/56/69ms，5ms 诊断心跳的最大间隔约 53/56/70ms；总策略准备约 0.90–1.71 秒，期间心跳持续运行，输出仍为同一组 57 个候选。机器负载不同，这些数字用于定位阻塞机制，不作为等负载的整 app 性能收益百分比。私有复现脚本与编译快照位于 `.tmp/pi-first-send/`。

回归在 `capability-skills-runtime.mjs` 用真实 Pi SDK 验证分段扫描期间事件循环可运行、附件不被枚举、准入的物理解析次数不随重复候选数量增长、重载更新策略与旧策略拒绝，已有同名来源/worktree/启停回归继续覆盖。

2026-10-26 按用户要求进一步收敛：Pi GUI、调度与对应菜单只发现全局和项目 `.agents/skills`，策略准备也不再扫描其它 CLI 或额外库。`piSkillRoots` 统一路径，目录内链接保留，原生 reload 重取入口，沙箱使用管理服务的隔离 home。SDK 的 `noSkills` 原本仍会扫描默认目录，因此安装阶段的可选兼容补丁在读取前跳过默认、祖先、配置、包与扩展追加技能源；其它资源和未启用补丁的 SDK 调用保留原行为。补丁有完整锚点校验、幂等检查和运行期安装提示，详见 [技能发现](skills.md)。`test/pi-skill-discovery.mjs` 通过真实 fs 调用见证排除目录零读取，并用原 SDK noSkills 控制组证明旧路径会读取；同时覆盖 symlink、reload、新目录、沙箱 home 和 Windows/macOS/Linux 路径构造。上述 57 候选计时属于收窄前样本，不与候选集合改变后的计时作等价比较。

收窄后的实测脚本为 `.tmp/pi-first-send/measure-canonical.mjs`，生产源码转译后调用真实 SDK，读取本机全局与本项目入口，管理策略使用隔离空存储，关闭扩展、提示模板、主题和上下文文件；不含模型请求或窗口渲染。每轮新建管理服务与加载器，首轮仅表示进程首次调用，未清 OS 缓存。四轮均得到 59 个技能：总耗时 2388/2163/2400/2857ms，策略准备 1067/877/991/1220ms，SDK reload（含最终准入）1276/1238/1353/1595ms，准入 60/44/69/69ms；5ms 心跳最大间隔 1289/1247/1368/1613ms。结果在 `.tmp/pi-first-send/canonical-JFG6sY/result.json`，证明同步长阻塞仍未消除。另一次带文件调用计数的诊断轮总耗时 1202ms、SDK 655ms、最大间隔 665ms（负载波动明显，不能混为等负载收益）：SDK 阶段 433 次 exists、66 次 realpath、102 次 readdir、64 次 readFile，文件操作仍全部同步；诊断结果在 `canonical-Pz1zgN/result.json`。本次运行实例未发现 CDP 调试端点，未重启应用；完整首发和 macOS/Linux 真机仍未验收，不能把目录收窄或回归通过当成卡顿修复完成。

继续优化保留上述策略扫描/准入去重，将 SDK 原有扫描与去重循环共享为生成器，宿主 reload 分段消费，普通 SDK 同步 API 消费同一生成器并保留结果语义。只拆 SDK 扫描时，来源整理仍出现 106–189ms 停顿；最终连同宿主来源标记、同名候选恢复一起分段，完成后重验策略，避免加载期间策略改变仍发布旧清单。未清缓存、未重启真实实例，也没有截断技能。

最终对照 `.tmp/pi-first-send/canonical-59TYcy/result.json`：同进程交替关闭/开启分段（控制项只用于诊断），每轮新建 loader 和隔离空策略服务，均加载 59 项，名称+文件路径+顺序的 SHA-256 全部一致。同步 SDK 对照三轮总耗时 860/1008/937ms，心跳最大间隔 547/483/645ms；分段路径三轮总耗时 975/632/568ms，最大间隔 29/21/25ms，心跳 p95 约 11ms。策略扫描与同步准入在两边都保留；对照不是把全部扫描回退后的旧版，也不是整 app/冷磁盘基准。总时长受机器负载影响，不据此宣称确定的总耗时收益；本轮证明相同完整清单的连续主线程占用显著缩短。SDK 单文件读取及准入仍同步，不能承诺每帧都小于 16ms；运行实例无 CDP、完整首发和跨平台真机边界仍如上。

## 24. 开发实例技能后台扫描（2026-10-27）

附加用户正在运行的 `npm run dev` 实例，主进程 PID 53732、CDP 54360、1920×1032 / DPR 1；未重启、刷新、造数或发送消息。原始证据仅保存在 `.tmp/perf-20261027-live/`，包含 manifest、三轮无 trace 基线、OS 进程树采样、呈现 trace 和独立 8 秒空闲 V8 采样。当前工作区包含未提交样式改动，数字仅代表该现场。

三轮会话上下滚动 rAF p99 为 22.0–33.9ms，切屏为 30.0–35.8ms，步骤均无 ≥50ms renderer longtask。独立诊断 trace 在同步观察窗口内的 EventLatency p95 为 91.3ms，并记录 166 条有明确标志的 ScrollJankV4 中 3 条 janky；该桶包含准备/还原等阶段，不等同于正式动作延迟，也不能与无 trace 数字直接比较。

OS 采样显示主进程持续约占用一个逻辑核心；撤除采样后的独立 4 秒空闲检查仍为单核 100.8%。主线程 TID 83468 的独立 3 秒 CPU 增量约 3047ms；不是用整机百分比冒充单核占用。机器为 Ryzen 9 7900X / 24 逻辑核，约 63GiB 内存、约 28GiB 可用；这些信息不排除其他系统干扰。

调用栈确认主进程热点来自能力管理技能后台观察：`runObservations → drainObservation → observationSteps → scanSteps → walk → assertAllowedPath/assertPrivatePath/identityFor`，大量进入同步 `readlink`、`existsSync`、`realpath`、`stat`、`readdir`。呈现 trace 中主进程 6760 次 `node_bindings.cc:WakeupMainThread` 累计约 29.64 秒（约 30.35 秒同步观察跨度，任务时长不是 CPU 时间）；OS CPU 与独立 V8 栈共同支持后台扫描持续消耗主线程的判断。分片让出事件循环能避免单次长任务，却不保证总工作量小。

已将后台发现改成事件驱动的增量缓存，健康全量核对降为完成后至少 5 分钟一次；按逻辑路径和物理别名失效局部事实，祖先监听过滤无关事件，监听失败显式报告并退避恢复，工作区/runtime 拓扑事件立即重查。真实耗尽片段预算时休息，廉价缓存遍历只让出事件循环。显式读取、运行时准入与写入仍使用新上下文和原路径/hash 守卫。具体数据流与边界见 [能力管理](capability-management.md)。

隔离生产服务、真实文件系统及监听的 280 技能/4 项目/5 目录别名对照：3.2 秒空闲期旧版触发一轮观察、2065 次文件系统调用，新版零轮、零调用；编辑一个技能从 2345 次降至 20 次。回归还验证未变化兄弟目录零读取。首轮建立监听仍有成本；初稿重复挂普通文件的物理目录监听已移除，但带后台休息的新首轮完成时间仍比旧版长，不宣称启动扫描提速。相关产物为 `.tmp/perf-20261027-live/backend-*.json`；一次旧版脚本错误假设 canonical watcher、未完成的样本单独保留，不计入对照。

获用户同意后按原 `dev:no-sandbox` 模式重启了现场实例，并恢复同一会话及窗口。`.tmp/perf-20261027-opt/` 的各 25 秒 OS 采样中，主进程单核占用均值为旧版 100.55%、新版 4.38%，中位为 100.39%、2.70%；独立新主进程 profile 已不再显示技能扫描热点。三轮新滚动/切屏均无 ≥50ms renderer longtask，但保留最大约 42.3ms 帧间隔。重启后的主题、右侧 Diff 恢复状态和首轮部件高度与旧现场不同，compare 返回 partially-incomparable；不把这些帧数据换算为整体流畅度收益。

验证：扫描观察、技能管理、真实 Pi 资源加载桥接、能力 IPC 四个定向文件通过；新增兄弟目录零读取回归用 HEAD 扫描实现复跑时按预期转红。主进程类型检查通过。日常抽样为 12/31 项失败，包含翻译覆盖、样式/产物守卫等，不能报告全仓通过；渲染层与测试层类型检查也存在未修改文件的接口不匹配。另一个 IPC scope 旧用例假设项目私有技能，当前实现和 HEAD 都在 canonical 全局技能断言处失败，本轮未放宽该断言。仅 Windows 真机验证；目录 Junction 使用真实文件系统，文件软链接因本机 EPERM 使用模拟覆盖，macOS/Linux 真机未测。用户随后明确要求不再追加性能量化，余下验收聚焦必要回归与功能风险。

## 25. 会话滚动与切屏继续优化（2026-10-27）

在技能扫描修复后继续附加用户开发实例，聚焦 60Hz 的 16.7ms 帧预算。一次有 CPU profile 的诊断轮确认隐藏 Git 标签里的品牌 SVG 加载动画仍运行，且切屏时 `App` 的 `pin` 同步读取祖先滚动偏移约占 3ms。前者已在未选中 `.xfade` 下暂停并保留恢复相位；后者改为只在真实 scroll 事件上修复，正常路径由已有 clip/visible CSS 保证不形成滚动容器。未修改字体、动效档位、滚轮距离、消息内容或可访问性开关。

修改范围：`styles/brand-loading.css`、`App.tsx`、`virtualScreenScrollGuard.ts`。两个组件文件共 6 个用例通过；隔离真实 Chromium 的深浅主题验证了嵌套隐藏暂停、可见动画继续前进、减少动态效果，以及焦点/scrollIntoView 不卷走祖先，截图已查看。测试夹具位于 `test/fixtures/virtual-screen-perf/`，原始诊断与截图仅在 `.tmp/perf-20261027-60fps/`。

固定当前活动会话后完成三轮真实细粒度 wheel/键盘切屏，主帧回调间隔约 16.7ms、无 ≥50ms renderer longtask，仍保留最大约 27.7ms 间隙；rAF 不是硬件呈现帧，不能称全程稳定满 60。诊断轮最慢帧的原生无障碍更新约 16.6ms，未通过禁用可访问性掩盖该成本。诊断轮带 profile，不与无 profile 数字直接相减；另一次受 HMR/场景变化影响的就绪超时结果保留为 incomplete，没有覆盖。Windows 实例和 Chromium 夹具验证有效，macOS/Linux 真机未测。

后续依据同份切屏 CPU profile 继续移除未变化隐藏标签的 React 工作：`GitPanelCore` 入口保留 forwardRef 并接 React.memo，`TurnReviewPanel` 同样使用默认浅比较；不自定义忽略字段的 comparator，不阻断组件内部状态、Context 或工作区根版本更新。相同内容/激活状态下的父级切屏不再进入隐藏面板；激活、owner/内容更新和真实 store 变化仍进入原加载/作用域流程。`right-panel-render-isolation.spec.tsx` 使用真实面板边界统计其后代渲染，和 Git 作用域、审阅及移动审阅四文件共 19 用例通过，覆盖草稿/Diff 保留、迟到响应及作用域隔离；不据此声称已消除全部帧尖刺。

真实短检查遇到并行文件树开发中的两个挂载崩溃：`selection` 在初始化前被回调依赖读取，以及关闭删除框时读取 null 的 `pendingDelete.items`。保留其他文件树改动，只调整声明顺序并补空值保护；新增初始化/多选拖拽回归及既有多根文件树用例通过。通过错误页的重试恢复原会话后，六次真实切屏和内容保持检查完成，并恢复原右屏；失败样本单独保留在 `.tmp/perf-20261027-panel-memo/`。本轮没有重新量化帧收益，也未声称已达到全程 60fps。

## 26. 中文输入现场诊断（2026-10-29，尚未完成归因）

用户在已运行的 `npm run dev` 中亲自输入中文并报告多次明显卡顿。附加主进程 PID 58380、页面 CDP 63024；没有重启、刷新或模拟输入。证据在 gitignored `.tmp/perf-ime-20261029/`：`input-events.json`（仅事件元数据，无按键或正文）、`renderer.cpuprofile`、`timeline.trace.json`、`timeline.analysis.json` 与采集完整性 `summary.json`。临时输入监听、rAF/PerformanceObserver 和 CPU/trace 采集均已停止。此次诊断同时启用 CPU profiler 与 trace，有额外开销，不是无探针基准或修复验收。

输入探针覆盖约 108.5 秒，实际首末输入事件相距 61.46 秒，记录 25 轮 composition、267 次 input。25 次 compositionstart 在 DOM 探针和 trace 一一对应，可校准两条单调时钟；主进程在实际输入区间内有 68 次 ≥50ms 的独立 RunTask，累计墙钟 13069ms、最大 304.361ms。整个 trace 有 112 次、最大 335.673ms，主要呈约 10 秒一批的连续长任务。内层任务来源为 `electron/shell/common/node_bindings.cc:WakeupMainThread`，只能确认 Node 任务入口，不能识别具体 JS 栈。`RunTask` 与 `ThreadControllerImpl::RunTask` 嵌套记录同一段工作，通用分析器的 224 条主进程记录不能当作 224 次独立阻塞，墙钟时长也不是 CPU 使用量。

实际输入区间内页面 Long Task 为零；采集全过程的 7 次页面 Long Task 均在最后一次输入之后。输入事件收到后到下一 rAF 最长 17.9ms，trace 中 input 事件处理最长约 4.2ms、compositionend 约 4.4ms；这些指标从 renderer 收到事件后开始，不能排除此前主进程/系统输入法等待，也不等于实际呈现延迟。全程 rAF 最大间隔 279ms 不应被当作本次输入期间的尖刺。

源码候选为当时 `extensions/extensionWatchService.ts` 的 10 秒轮询，沿 `extensionCoordinator.scanNow → captureExtensionPackage/validateExtensionPackage` 同步遍历、读取和校验包；周期相符仅是线索，尚未由该次主进程调用栈确认。现有实例未暴露 Node Inspector；63025 是返回 401 的业务接口，不是 Inspector，没有绕过鉴权。用户随后要求移除正常状态的定时全量扫描，现改为文件监听驱动；监听失败时仅尝试重新挂载，恢复后扫描，扫描本身失败时再重试。未重启用户实例，也未进行修复后的真实场景性能采样，不能据此断定该轮询是全部卡顿的原因或卡顿已完全消失；macOS/Linux 未真机验证。

后续静态审查的工作放大及优化见 扩展 性能审查。可识别的文件事件限定工作区和扩展；发现、扫描后的复核及面板准入的包读取改用异步 IO，面板资源每次交付前完整验包一次。已知失效状态立即撤销，重复后台复核请求合并；全局登记同轮合并落盘且不写未变化状态，Git 预检异步执行，普通任务进度批量写盘。CLI 调度泵只遍历待处理索引。审核、完整字节指纹、Git 暂存冲突和状态撤销仍保留；部分原生及后台同步入口、指纹计算和事务落盘仍在主进程执行。本轮没有重新采集真实性能数据，不能据此声称输入卡顿已经消失；Windows 离线回归不代表 macOS/Linux 真机验证。

定向验证：21 个扩展、CLI 和 Web 网关离线测试文件通过，含相同大小与时间戳下的源码篡改、异步验证期间实例关闭、Git 等待期间工作区撤销、同步途中的 Git 暂存冲突与恢复；另有隔离的隐藏 Electron 面板协议回归通过。四个组件／主进程测试文件共 9 项通过，主进程及主进程测试 TypeScript 检查通过。此次没有主动重启或附加用户的运行实例，未做修复后真实性能采样。

## 27. 内置扩展冲突时的重复准备（2026-11-02）

一次 Windows 开发实例在本机存储页面未挂载时出现持续活动：15 秒进程采样中主进程约占单核 86%，5 秒内扩展和工作台状态各刷新 79 次；8 秒主进程 trace 的 `spawn → checkExtensionPackageSyntax → ExtensionReviewCoordinator.submit` 路径反复出现。内置日报准备冲突后，准备过程自身触发的扫描可能产生短暂审核状态，旧重试判断把该进度当作再次准备的理由。修复为同指纹的审核过渡状态使用上一次稳定状态，准备期间只按结束前后的状态差异重试，显式刷新和真实状态变化仍可重试；相关单元回归验证冲突、过程过渡、原因变化及并发刷新。

随后用户删除日报扩展并重启了开发实例，新构建包含停止重复准备的主体修复；5 秒内两类状态通知均为 0，15 秒采样的主进程约占单核 14%，用户确认鼠标已恢复。两次采样间同时发生了删除和重启，工作负载也可能变化，不能将差异单独归因于补丁。之后补充的无已知副本或指纹的边界保护在下次启动加载；当前管理页仍报告存在不同的全局日报更新候选，冲突数据未被自动修改。原始诊断位于 `.tmp/perf-20261102-pointer/` 和 `.tmp/perf-20261102-pointer-0930-baseline.jsonl`；macOS、Linux 真机未测。

## 28. 虚拟屏切换重读布局配置（2026-11-12 现场诊断）

在用户已打开的 Windows Electron 开发实例上，用右侧图片预览露条与左侧会话露条往返。1920×1032、DPR 1，空闲 rAF 中位数 16.7 ms。无 CPU profile 和 Chromium trace 的六轮点击往返中，12 次过场中段均有超过 20 ms 的 rAF 间隔，最长 26.7 ms，页面 Long Task 为零。另一次同时开启 trace 和 CPU profiler 的 8 次切换中，Chromium 在 3 次切换起步时各记录一个影响流畅度的 `STATE_DROPPED`，该计数仅适用于带采样的诊断轮。

每次切屏由 `App.persistHDock` 调用 `workspaceFile:patch` 保存当前页。现场有一个未选中的文件标签打开了同一份 `.muster/workspace.json`。文件监听的 200 ms 防抖让通知恰好落到滑动中段。独立的 8 次切换均在点击后 209–215 ms 收到该路径的 `fs:changed`，随后 6–23 ms 内，`FileEditor.refreshFromDisk` 因文本变化将整个文档提交给 CodeMirror。每次都从 `.cm-content` 移除约 308 个元素并插入约 308 个元素。临时隐藏编辑器宿主和暂停隐藏编辑器的 `measure` 都保留了这次重建，CPU 调用栈落在磁盘刷新发起的 `dispatchProgrammatic`。因此只调整隐藏标签布局或平移动画无法消除这条回读链路。

浏览器主线程在部分过场中也有独立的 Node 唤醒任务，现场未取得这些任务的 JS 调用栈。起步时偶发的呈现丢帧早于文件变更通知，原因仍待定位。证据保存在本地 `.tmp/perf-2026-11-12-virtual-screen-131759/`，无采样点击基线见 `click-baseline.json`，文件通知与 DOM 时间对照见 `layout-save-witness.json`。诊断结束后恢复原会话页并清除探针。此次为 Windows 现场诊断，macOS/Linux 未实测。

修复将磁盘回读改为 CodeMirror 的单区间更新，保留共同前后缀。回归先复现全文事务，再验证 `hDock` 变更只替换字段值，换行格式差异不会触发重复事务，后续选区保持且程序化回读不触发自动保存。三个组件测试文件共 58 项及 Web 类型检查通过。

同一运行实例随后以右侧文本预览和后台配置标签为固定场景，修复前后各点击往返六轮。两轮均收到 12 次布局文件变更通知，空闲 rAF 中位数均为 16.7 ms。过场中段超过 20 ms 的 rAF 间隔由 13 次降到 4 次，最大间隔由 38.2 ms 降到 23.8 ms。CodeMirror 的单批最大移除量由 308 个元素降到 0，最大添加量由 308 降到 70。两轮采用相同的轻量 DOM 探针，rAF 数据代表渲染回调节奏。原始记录见 `text-refresh-before.json` 与 `text-refresh-after.json`，两轮结束均恢复到会话页。

页位现按工作区保存为本机 `localStorage` 短值 `left` / `right`，普通切屏从工作区配置 IPC 路径移除。旧 `hDock` 供本机键缺省时读取。Windows 隔离 Electron 验证了真实快捷键、两工作区页位隔离、专注钳制和应用重启恢复。现场窗口报告为隐藏，`local-page-current-window.json` 记录采样准备失败，本次没有新增可比较的帧数据。

## 29. macOS 虚拟屏调宽残影（2026-11-26）

在右侧最小占比仍为 40% 的构建中，激活 macOS Vibrancy 窗口的右侧浏览器，长按分割把手并将右侧由约 54% 拖到 40%。原生窗口截图能看到左侧会话栏文字和圆角边框在旧位置叠加。Chromium 页面截图漏掉这些旧像素。关掉比例卡片的 `backdrop-filter` 后残影消失，给 `.work-area` 建立限定在拖动期间的采样边界后，保留模糊也能消除残影。

在 macOS Electron 43.7.0、1600×940、DPR 1 的隔离窗口检查深浅主题各三轮。按同一轨迹拖动并在松手前取原生窗口截图，左栏的无文字采样条带中，禁用修复时检测到 18–20 处旧边缘像素变化，启用时为 0。比例卡片继续实时模糊背景，松手或取消后释放 `.work-area` 的 `will-change: opacity`。`test/e2e/window-material.spec.ts` 守卫长按预览、实际调宽和两种释放路径。Windows 与 Linux 的分支通过材质能力模拟及样式守卫核对，真机未测。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：性能架构与实测边界的持续账本（启动两段化/Git 链路/主进程常驻开销/渲染重渲/流式热路径/保活 LRU），写给下一个做性能优化的人。
- 为什么这样设计：方法纪律=CDP 真实输入+CPU profile 按窗切片归因+渲染计数验证+红灯自检回归；「先减少工作」再治渲染（§21）；隔离实验定责（§18 消除误判）；大数据路径现状登记（§12）防后续无意识放大 payload；历史数字只对应所注日期场景与构建。
- 明确不做：不以 60fps/零长任务为结束条件；长转录虚拟化、B1-8 tail 采样、跨调用磁盘历史缓存均未立项（登记待评审）；沙盒短 DOM 数字不作整 app 收益宣称。
- 歧义点：GUI 会话消息无条数/字节上限（调度侧 chat-history 有 MAX_CHAT_DISPLAY=400，GUI 侧裸奔、单会话已实测 2.93MB 且体量随工具输出字节增长；文档 §9.4 登记「用户暂缓」）——A=维持暂缓（reconcileById/渐进挂载/content-visibility 已兜住渲染面，接受内存慢增长）／B=补上限或滚动裁剪（review 把无限增长记 P1 待修）。推荐 B 至少补「条数软上限+触顶提示」，纯内存防御成本低；若维持 A 则 review 固定记「已接受边界」不再追踪。
