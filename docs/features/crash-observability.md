# 崩溃观测（crash-observability）

> 2026-09-25 落地。起因：安装版「对话调度 agent 黑屏」——渲染进程死了、主进程活着，
> 但死因（reason）、minidump、主进程日志三层全部缺失，事后零痕迹可查。本功能把
> 「出事那一刻」的证据钉死在磁盘上，并给主窗口加自愈。
> 2026-10-10 补强：起因是 10-06 安装版一次真实崩溃只留下一行 reason/exitCode——
> exitCode 143 是 SIGTERM 语义的外部终止（不走 crashpad、无 minidump），且不知道崩溃时
> 渲染层在干什么。补上 exitCode 语义注解、崩溃现场快照、GPU/utility 子进程死亡落盘、
> 扩展面板死亡落盘四个盲区。

## 功能职责

六个互补的证据通道 + 一个自愈动作，全部**本地**（不上传任何服务器）：

1. **主进程文件日志**：接管 `console.log/info/warn/error`，全主进程日志（含
   `[fatal] uncaughtException` 兜底、`[agentSession:pi]` 调度日志、启动链）落
   `userData/logs/main.log`。安装版没有终端，此前这些输出全部蒸发。
2. **渲染进程死因 + 现场快照落盘**：`render-process-gone` 把 `reason`（oom/crashed/killed/…）
   + `exitCode`（带语义注解：143=SIGTERM 语义外部终止、0xC0000409=fail-fast OOM/CHECK、
   0xC0000005=access-violation、未收录的 NTSTATUS 给 hex）+ 自动恢复决策 + **现场快照**
   （崩溃时页面 URL、主进程 RSS、最近 20 条渲染层 console）写进 main.log。渲染进程一死
   renderer-errors 通道就断流，主进程侧这份快照是「崩时渲染层在干什么」的唯一现场。
3. **崩溃 minidump**：`crashReporter.start({ uploadToServer: false })` 让渲染进程的
   CHECK/V8 OOM 类崩溃留本地 dump（`userData/Crashpad/reports/*.dmp`）。此前渲染进程
   崩溃被 Chromium crashpad 拦截、本地又没配保留，Windows 侧连 WER 记录都没有。
4. **渲染层 JS 错误上报**（既有链路，未改动，登记于此备查）：
   `window.onerror` / `unhandledrejection` / `ErrorBoundary` → `app:report-renderer-error`
   → `userData/logs/renderer-errors.ndjson`（256KB 滚 .old）+ 面板 toast。
   `window.onerror` 入口先过 `isBenignRendererError`（同文件纯函数）：ResizeObserver
   自限提示与 Electron 43 webview 元素卸载必发的 `Invalid guestInstanceId: N` 上游噪音
   （探针实测：元素移除与主进程 close 两种销毁顺序下 guest 均已正确销毁，纯报错噪音）
   不进上报，否则每次关浏览器标签都弹「渲染层崩溃」toast。
5. **子进程死亡落盘**：`app.on('child-process-gone')` 把 GPU/utility/Pepper 等子进程死亡
   单行落盘（type / name / reason / exitCode 注解）。GPU 崩在界面上同样表现为黑屏/花屏，
   此前一行不留。Electron 31 下渲染进程死亡不触发该事件（由各宿主 webContents 事件落盘），
   天然不重复。
6. **主窗口自愈**：渲染进程死亡后滑动窗口限频自动 `reload()`（60s 窗口内最多 2 次）；
   超限停手（大概率稳定复现的崩溃，反复 reload 只是空转），改发**原生系统通知**
   （不依赖渲染层——此刻渲染层恰恰死了，`ui.notify` 的 toast 弹不出来），点击通知回应用。

## 关键文件与入口

| 文件 | 职责 |
|---|---|
| `src/main/index.ts` | 早期接线：`setupDevSandbox()` 之后 `crashReporter.start()` + `installMainConsoleCapture()` + `app.on('child-process-gone')`（顺序必须在其后，userData 已重定向，沙盒日志/dump 落沙盒）；`createWindow()` 里 console 环形缓冲 + `render-process-gone` handler |
| `src/shared/crashContext.ts` | 崩溃现场纯逻辑层：`describeExitCode`（exitCode→人话注解，NTSTATUS 有符号/无符号双形态 + hex 兜底）、`CrashConsoleRing`（容量淘汰 + 单条截断 + 空白折叠）、`buildRenderGoneEntry` / `formatChildGoneLine`（条目拼装） |
| `src/shared/mainLog.ts` | 纯格式化层：`formatMainLogLine`（ISO 时间戳 + 级别 + 文本）、`MAIN_LOG_MAX_BYTES`（1MB） |
| `src/main/logs/mainLog.ts` | `appendMainLog`（同步追加 + 轮转 + 自身失败静默）、`formatConsoleArgs`（`util.format` 语义）、`installMainConsoleCapture`（先落盘再走原 stdout，dev 终端不受影响） |
| `src/shared/renderGonePolicy.ts` | `decideRenderGoneReload` 纯函数：滑动窗口限频决策，调用方回存 `recent` 时间戳 |
| `src/main/logs/desktopNotify.ts` | `notifyDesktop`：Electron 原生通知（AUMID 已在 index.ts 设置），click 聚焦主窗口 |
| `src/shared/rendererErrorLog.ts` | `rotateIfNeeded`（可选 `maxBytes` 参数）；renderer-errors.ndjson 契约；`isBenignRendererError` 良性噪音签名（ResizeObserver 自限、webview 卸载 Invalid guestInstanceId） |
| `src/main/extensions/panelViews.ts` | 扩展面板 popup 的 `render-process-gone` → `[panel gone]` 落盘 + UI toast（toast 不持久，文件才是证据） |
| `src/main/browser/tabs.ts` | 浏览器 tab 死亡走 `console.error`（经 console 接管落盘），带 reason + exitCode + URL；tab 有自己的恢复 UI，不做全局自愈 |

## 数据流 / 行为细节

- **console 接管**：替换 `console.*` 为「落盘 + 原实现」；`render-process-gone` 的死因条目
  只走 `appendMainLog`（不走 console），避免捕获链双写。
- **死因条目形态（多行）**：首行 `[renderer gone] reason=… exitCode=<注解> -> <决策>`
  （`[renderer gone] reason=` + `-> reload` 是 e2e 依赖的可 grep 契约，改格式须同步
  `test/e2e/renderer-crash-recovery.spec.ts`）；次行 `  ctx url=… mainRss=…MB`；随后最多
  20 行 `  console[e|w|i] …`（console-message 级别 0-3 映射 i/w，≥2 同时走 console.error）。
- **console 环形缓冲**：主窗口每条 console-message 进 `CrashConsoleRing`（容量 60、单条
  截断 500 字符），只在崩溃时取最近 20 条落盘，正常运行零 I/O。
- **轮转**：main.log ≥1MB 时滚为 `main.log.old`（同 renderer-errors.ndjson 的 256KB 策略，
  阈值参数化）；同一时刻最多保留两份。
- **限频语义**：`decideRenderGoneReload(recent, now)`——窗口内第 1、2 次死亡 reload（note
  形如 `reload 1/2 in 60s window`），第 3 次起 `reload: false` + 停手通知；窗口滑出后旧
  时间戳清理、计数重置。恰好等于 windowMs 的旧戳不算窗内。
- **通知文案**走主进程 i18n（`t()`，词条在 `shared/i18n/locales/fragments/main.ts`）。

## 已知边界

- **外部 TerminateProcess 型死亡没有 minidump**：exitCode 143（SIGTERM 语义）这类击杀
  不经 crashpad（Chromium 机制，非配置遗漏）——这类崩溃的证据就是死因条目里的现场快照。
- **minidump 无 Electron 符号时只能解析到异常码/fail-fast 类型与模块偏移**（2026-09-25
  手写 minidump 解析器验证过流程）；定位到函数需要对应版本的 pdb。
- **console 环形缓冲只覆盖主窗口**：浏览器 tab 与扩展面板只落死因单行（tab 有自己的
  恢复 UI 与退避恢复，面板崩溃面窄），崩溃前的 console 现场不保留。
- **多实例同 userData 并发写 main.log**：appendFileSync 走 O_APPEND 行级原子，行不会写花；
  但两实例同时跨过 1MB 轮转阈值时 rename 有竞态，极端情况丢一行，可接受（罕见场景）。
- **浏览器 tab 的渲染进程死亡**（`browser/tabs.ts`）有自己的退避恢复与可见错误态，不做
  全局 reload 自愈。
- playwright/e2e 的 Electron harness 在渲染进程崩溃后自身报废（`Target crashed`，时机
  不巧会把 runner 打穿）——`test/e2e/renderer-crash-recovery.spec.ts` 在 crash dispatch
  之后**不再调用任何 playwright API**，恢复断言全部走 main.log 文件系统证据。
- crashpad handler 会多一个几 MB 的小进程常驻；崩溃瞬间写几 MB dump，毫秒级。正常路径
  全部零产出，无可测量性能开销。

## 回归测试

- `test/crash-context.mjs`：exitCode 语义翻译（双形态/未收录 hex 兜底）、环形缓冲
  （容量淘汰/截断/折叠）、死因条目拼装（首行契约/快照字段/console 截取）、子进程单行
- `test/main-log.mjs`：格式 / 落盘 / 轮转（阈值注入）/ console 接管 / 失败静默
- `test/render-gone-policy.mjs`：限频决策（窗口内计数、第 3 次停手、滑出重置、边界）
- `test/e2e/renderer-crash-recovery.spec.ts`：真 app `forcefullyCrashRenderer` → main.log
  出现死因行 + `ctx url=` 现场行 + `reload 1/` + 随后 `did-finish-load`（跑法：
  `npm run build && npx playwright test renderer-crash-recovery`）

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：把「出事那一刻」的证据钉死在磁盘——六通道（主进程文件日志/渲染死因+现场快照/minidump/渲染层 JS 错误/子进程死亡/扩展面板死亡）+ 主窗口自愈；起因是安装版黑屏三层证据全缺失零痕迹。
- 为什么这样设计：死因条目=reason+exitCode 语义注解（143=SIGTERM、NTSTATUS hex）+现场快照（URL/主进程 RSS/最近 20 条 console 环形缓冲，正常零 IO）；minidump 本地保留不上传；自愈 60s 窗口限频 2 次，超限改发原生系统通知（渲染层已死 toast 无效）；e2e 崩溃后不再调 playwright API、断言全走 main.log 文件证据。
- 明确不做：不上传任何服务器；外部 SIGTERM 型死亡无 minidump（Chromium 机制限制，证据就是现场快照）；console 环形缓冲只覆盖主窗口（tab/面板只落死因单行）。
- 歧义点：无真决策（限频/兜底/边界均为既定工程取舍，X7 横切关联）。
