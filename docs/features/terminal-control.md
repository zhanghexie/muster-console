# 终端写入、截图与条件等待

`terminal.create` 创建普通 Shell 会话（不是 CLI Agent harness），参数为 shellProfileId、name、workspaceId/rootId/cwd/rootsRevision、select；无任务、子代理、模型或隔离参数。默认共享现有目录，不新建 worktree；GUI/CLI Agent 仍由 sessions.create 创建。Worker 与调度均可创建，保持原权限。Windows 的 PowerShell/pwsh/cmd/Git Bash/WSL、macOS/Linux 的 zsh/bash 由现有 Shell 适配层探测与启动，不支持或缺依赖明确报错；旧 sessions.create(shellProfileId) 只保留执行兼容。

普通 Shell 的宿主工具调用使用进程启动时冻结的工作区目录租约，PTY 实际退出或被新进程取代后旧租约失效；启动过程中被取代的旧请求不能迟到生成进程。租约约束宿主工具，不拦截 Shell 自身的原生命令。

调度通过常驻 `terminal.write` 和 `terminal.capture` 操作宿主托管的 PTY 会话；用 sessionId 或当前工作区内的显示名定位。GUI 聊天会话及宿主外的系统终端不属于此接口。角色、令牌、模式及确认规则沿用原执行链。

## 写入与读取

### 本地 TUI 键盘输入

`TerminalView.tsx` 将 xterm `onData` 原样交给 `window.api.pty.input(sessionId, data)`。`terminal/keyEvents.ts` 管理选区与输入的优先级：有选区时 Ctrl/Cmd+C 复制并清选区；Esc 和其他普通键清选区后继续交给 xterm，Esc 的 `\x1b` 必须在第一次按键就到达 TUI，用于 CLI 自己的打断/取消操作。扫描、爆炸遮罩期间仍阻止终端输入；全局弹层由 `KeybindingProvider` 优先处理，不同时打断下层 TUI。

每个终端不再安装全局 Esc 选区清理监听，避免隐藏/分屏终端残留选区时消费别处按键并抢回焦点。此路径是三个桌面平台共用的渲染层逻辑，没有新增系统按键模拟。

原生终端输入法使用 xterm 默认的候选窗口定位，不再按 CLI 提示符扫描终端画面或改写候选窗口位置；部分 TUI 在原生输入处仍可能出现候选错位或拼音裁切。终端的通用预编辑样式继续用于普通 Shell 和 CLI。CLI 的悬浮输入区使用共享 `ComposerEditable`，在输入法合成期间不会将回车当作发送。旧版注册文件中的 `uiHints` 保留但不再生效；`runtimes.update` 如果仍传入该参数会明确报错，要求从请求中删除。

终端右侧的滚动条由 xterm 而非 CLI 程序绘制。工作台通过 xterm 的 `scrollbar.showScrollbar=false` 隐藏它并取消滚动条占宽，普通 Shell、CLI 和使用 `TerminalView` 的后台终端共用此设置。正常终端保留 10000 行回滚历史与滚轮滚动；应用启用鼠标协议或使用备用屏幕时，滚轮继续由 xterm 按现有规则交给对应 TUI。隐藏后不能再拖动滚动条。`test/unit/terminal-scrollbar.spec.tsx` 覆盖工作台终端接入和回滚缓冲，`test/e2e/cli-workspace-context.spec.ts` 覆盖 PTY 输出后的滚轮与隐藏轨道；用例存在不表示已执行。

回归：`test/unit/terminal-escape.spec.tsx` 覆盖选区/无选区首次及连续 Esc、弹层优先、遮罩拦截与 Ctrl/Cmd+C；`test/unit/overlay-presence-escape.spec.tsx` 覆盖关闭弹窗不得占用 Esc。`node test/terminal-escape-visual.mjs` 用真实 `TerminalView`、xterm、后台关闭的 AppConfirmDialog 与 Chromium 键盘验证 Esc 到达模拟 PTY IPC、另一终端有选区时焦点不被抢回，覆盖深浅主题和窄布局。

Windows 开发版于 2026-10-26 附加真实 Electron/OpenCode 1.19.3 验证：修复前无可见宿主弹窗但 overlayDepth=19，终端 Esc 在 window 捕获阶段即 defaultPrevented=true，OpenCode 命令菜单不关闭；修复后 overlayDepth=0，Esc 能关闭该菜单。另建独立 OpenCode 测试会话，以仅输出数字且不调用工具的提示触发真实模型生成：第一次 Esc 显示 `esc again to interrupt`，快速连续两次 Esc 后显示 `interrupted` 并停止输出。这是 OpenCode 自己的两次确认语义，宿主不应改写成 Ctrl+C 或额外注入 Esc。其他 CLI 的打断语义由各自决定；macOS/Linux 尚未真机验证。

普通交互终端由 `pty/interactiveOwner.ts` 在用户命令启动前取得进程容器所有权：Windows 用私有 nonce bootstrap 加入 Job 后才运行命令；macOS/Linux 保持 PTY session leader，启动前通过 Koffi 验证 SID/PGID 与终端前台组能力，再将前台交给独立 shell 组。输入、Ctrl+C 字节和 resize 仍走原 node-pty 对象，启动期间有界缓存输入。`PtyManager.spawn` 异步返回本代 generation；极速退出、取消或替换后，Sessions 不得再写 running 或绑定旧上下文。后台使用独立同步 `spawnRaw`，不改变后台容器协议。

普通 Shell 在启动尚未提交时收到 native exit，由当前 pending launch 的失败路径收口：保留 exited 会话、保存实际 launchError 并显示通知，不能先自动关闭而使 generation 失效并吞掉错误。成功提交 running 后的自然退出仍自动关闭；用户主动关闭或新启动代次替换后，旧失败不得回写。回归 `test/shell-startup-exit-diagnostics.mjs` 使用真实 SessionsService/PtyManager 与受控 owner 夹具覆盖上述次序。

关闭先停止准入，再等待 Job 或 POSIX session 内各组真实退出、PTY onExit 及 Windows 输出 worker 退出。POSIX 同一 SID 的多 PGID 逐个用新受控 guard 加入并核验；guard 固定组身份后同步发信号，重新枚举直到仅剩 held leader，再由通用 owner 回收 leader。外 SID 重用的组不得发信号，leader/guard 失效、权限或超时明确失败并保留 owner 以便重试。删除工作树、重置 sandbox 与应用退出均等待该屏障。Windows 释放已退出 ConPTY 句柄时不再查询旧 PID 的 console-list；不使用 800ms taskkill 兜底。node-pty 输出 worker 合同不匹配时明确要求重新构建/安装，不静默降级。

POSIX 主动 `setsid` 脱离、SSH 远端和 WSL/Docker 客体进程属于容器边界外；Windows Job 保证宿主树而不保证客体内核树。Darwin 用 libproc 枚举 PID，XNU getsid/getpgid 查询 SID/PGID；仅 ESRCH 视为已消失，其余错误保留诊断。Linux 用 /proc 枚举。回归为 `interactive-pty-posix.spec.ts`、`interactive-pty-manager.spec.ts`、`interactive-pty-bootstrap.spec.ts` 与 `node test/interactive-pty-owner.mjs`；Windows 真机已验证原始输入、resize、Ctrl+C 字节、逻辑退出码、子孙进程清理及 native/output-worker 关闭后脚本自然退出；macOS/Linux 当前仅代码与模拟分支覆盖，没有真机验收。

CLI Agent 会话使用悬浮输入区，展开、收起或拖动均不改变 xterm 尺寸；普通 Shell 保持原终端。新会话默认收起为胶囊，初始在右下角；胶囊最右侧的把手可拖至面板任意位置，松手吸附最近的四边，按会话记录边及相对位置，面板尺寸变化后重新定位；本地位置读写失败会提示，当前位置在当前视图仍可使用。点击展开图标从所在位置展开并聚焦输入框，输入区默认横向铺满面板，以胶囊纵向中心为锚点，靠近上下边缘时限制在面板内。展开后的右侧把手可拖动输入区：以当前可见位置为起点，不受边缘限制造成的拖动死区影响，收起后的胶囊继续使用该位置；面板调窄后也可以横向拖动。鼠标移到输入框左右侧边时出现横向调整光标，拖动边缘可调整宽度，另一侧保持原位；键盘聚焦边缘后可用左右方向键微调，Shift 加方向键加大步长。输入正文最小容纳两行，高度随内容自然增长，沿用 GUI 输入核的 240px 上限及滚动行为，并受终端面板可用空间限制；旧版保存的手动高度被忽略。宽度及相对位置按会话保留，收起再展开和重新打开会话仍使用所选宽度；小窗口只暂时限制显示宽度，位置与宽度读写失败分别提示。模型建议令展开图标呼吸，减少动态效果时停用呼吸动画。点击终端空白不会收起；可点击收缩图标或在输入框按 Esc 收起。发送成功后保持当前开合状态；发送期间手动收起或展开的选择不会被成功结果覆盖。发送失败或状态更新警告会展开并显示提示。收起不卸载输入区和正在编辑的批注；终端划词批注会展开输入区，已有未完成批注时提醒先保存或取消。每个会话独立保留折叠状态、位置、草稿和待发批注；终端选中文本、文件及网页批注进入该草稿，发送前展开原文与批注。建议来自模型调用 `ui.suggestReplies`，空草稿显示灰字，点击或 Shift+Tab 切换，Tab 填入。原生终端仍可直接输入。

收起的 CLI 输入胶囊使用放大的按钮和图标，底色略带透明以透出终端；窄面板内按钮可收缩，胶囊位置按实际尺寸重新计算。展开输入区无论焦点位置均使用不透明底色。识屏、收起和拖动按钮位于右下角，与发送按钮共用底栏；拖动把手位于发送按钮之前，不额外占据顶部行。普通动态效果下，面板外壳从胶囊所在位置连续缩放并过渡透明度，按钮及输入内容交接淡化；即使输入区调窄后胶囊在其外侧，缩放仍以胶囊所在位置为起点。胶囊与输入区仍保留各自的控件和输入区 DOM，以维持草稿及交互状态。轻微动态或减少动态设置分别缩小或关闭缩放。

输入端复用 GUI 的加号菜单、`@` 文件与技能候选、快捷短语、附件条和拖放/粘贴。技能选择按当前 CLI runtime 和会话工作目录发现，发送为技能名及 `SKILL.md` 路径；文件树路径保留完整路径，外部文件和图片提交时保存为当前会话受管快照，能提取的文字带范围标记，无法提取的内容提供路径与原因。原生 CLI 斜杠命令仍原样交给 CLI；仅附件可以发送。GUI/CLI 附件适配和剪贴板跨平台边界见 [多模态输入](multimodal-input.md)。待发附件在折叠和组件重挂后保留至应用退出，重启需重新添加。

CLI 终端画面中无文字的可见字符格支持鼠标左键长按：等待一个 panel 时长后预览相反的开合状态，面板完成进出后，原状态的图标以三分之一 breath 时长平滑放大；临近最大或最小时，整个输入框或收起的胶囊同时分八段缩放颤动，第一轮即提供可见提示，幅度逐渐增强；小胶囊的缩放差更大，避免缩小时颤动不明显。从颤动开始到提交约 600 毫秒（当前 breath token 的三分之一），窗口内松手都取消；从按下到提交约 1.16 秒。颤动各段依次计时，避免渲染卡顿后多个阶段一并跳过；卡顿会延长而不会缩短等待时间。继续按到阈值才保存新状态，图标切换并与输入框一起以 micro 时长快速回弹。提前松手从当前动画位置恢复原状态，展开与收起对称；预览不写入折叠偏好、不抢焦点，正式展开后松手才聚焦输入框。按住期间临时开合的层不截取终端鼠标事件。移出容差、出现选区、滚轮、Esc、窗口失焦、切会话或空白格出现文字时取消未提交预览。空白判定读取 xterm 可见缓冲，宽字符尾格不算空白；CLI 可能把空格或彩色空白格作为可交互区域，其语义无法从终端缓冲可靠判断，工作台不会拦截原鼠标事件但仍可能出现预览。减少动态效果关闭缩放动画，保留长按阈值以免误触。

人因依据与边界：[Woods 等人的简单视觉反应研究](https://pmc.ncbi.nlm.nih.gov/articles/PMC4374455/)报告实验平均约 231–238ms；[20 位 20–29 岁参与者的手机提示研究](https://arxiv.org/abs/2305.17180)中弱视觉提示平均约 528ms。两者均不是本功能的“注意颤动、决定取消并松开鼠标”实测，不能推出适合所有人的固定时长。600 毫秒按用户要求作为试用值，仍需覆盖不同用户、注意力状态和设备的实测；当前没有单独的时间偏好设置。

输入区 Enter 调用 `pty:submitComposer`，以当前 PTY 代次发送内容后只提交一次；单会话并发提交被拒，已识别的终端确认状态要求先在终端处理。声明支持 bracketed paste 的 runtime 使用粘贴，其他 runtime 的单行文本直接输入；遇多行或控制字符不能可靠粘贴时，把完整 UTF-8 原文写入系统临时目录并提交读取文件的短指令。文件约 24 小时后清理，也由启动时的过期清理兜底；接收方必须能读取该路径。写入或提交失败保留工作台草稿；正文已进入终端而回车失败时需先检查终端，避免重复。PTY 写入成功不代表 CLI 已接受消息。不同 CLI 的 busy 状态、输入焦点和确认交互没有通用可靠识别，需分别实机验收。

覆盖工作台输入区的用例位于 `test/unit/cli-session-view.spec.tsx`、`test/unit/cli-composer-placement.spec.ts`、`test/unit/node-main/cli-composer-submit.spec.ts` 和 `test/e2e/cli-workspace-context.spec.ts`；用例存在不表示已执行，实际验证结果见交付说明。

终端识屏从 CLI 工作台胶囊的识屏按钮或展开输入区的同款按钮触发，再次点击关闭；普通 Shell 和后台终端提供带独立拖动把手的识屏胶囊，松手贴边并按会话保存位置。胶囊在终端父容器引用就绪后测量尺寸并观察变化，避免首次挂载时拖动范围为零。宿主不再拦截终端右键启动识屏，右键是否粘贴取决于 CLI、终端鼠标模式和系统处理。CLI 的输入区、胶囊与批注位于识屏遮罩上方；识屏不自动抢占输入焦点，输入区有焦点时 Esc 优先收起输入区，点选识屏命中后键盘可操作识屏层。截图前短暂排除悬浮层以免重影，取消、失败、超时或组件卸载会恢复；截图失败/超时提示并退回简化遮罩。

`terminal.write` 支持 raw 粘贴、typed 键入并提交、enter 补提交与 ctrl-c。保留 submit 的显式覆盖和 enterCount。回执中的 outputCursor 取自写入前，便于下一次 capture 等待这次输入产生的输出。写入成功不代表 CLI 接受指令或任务完成。

`terminal.capture` 不切前台，从 xterm 缓冲栅格生成 PNG。回执包含 textTail、imageCaptured、成功时的 previewPath 和 outputCursor。executor 同时设置 UI display.imagePath，并在模型结果中保留本地路径。PNG 保存在应用用户数据目录的 `terminal-captures`，最多保留二十张。已保存的 PNG 可在 [本机存储](local-storage.md) 中逐项清理。

截图或落盘失败但有文本时，返回 `imageCaptured=false`、`captureError` 和文本。图片与文本均不可用时，工具失败。工具只保存本机截图，旧 `delivery` 和 `caption` 参数会被拒绝。通过已配对 Channel 触发终端请求时，远程输入的会话路由将截图回复给原对话。[消息接入](multi-channel-messaging.md)

## 等待

capture 可选 waitFor，text 与 quietMs 二选一：

```js
const sent = await terminal.write({sessionId, text: 'query', mode: 'typed', enterCount: 1});
await terminal.capture({sessionId, after: sent.outputCursor,
  waitFor: {text: 'Expected output', timeoutMs: 15000}});
await terminal.capture({sessionId, waitFor: {quietMs: 500, timeoutMs: 10000}});
```

text 是去 ANSI 后的字面包含匹配，支持跨 PTY chunk。默认仅观察调用后的新输出；after 指向上次 write/capture 游标时，先检查从该游标到现在的保留输出，再接实时输出，涵盖两次工具调用间的输出。不会隐式匹配整段旧 scrollback。进程重启、游标越界或对应内容已被缓冲淘汰时明确拒绝，要求重新 capture。

quietMs 为 50–5000ms，每次新输出重新计时。timeoutMs 默认 15000、最多 30000ms。回执 wait.reason 区分 text、quiet、timeout、exited、stopped、replaced、not_running；自然退出保留 exitCode。超时仍读取当前文本/画面；显式关闭终端返回 stopped，同一会话拉起新终端返回 replaced。两者都立即结束原等待，随后返回当前会话画面；replaced 时画面可能属于新进程，不能作为旧指令完成的证据。取消信号释放定时器和监听并终止工具，保持原取消语义。

静默只说明一段时间无输出。CLI 可能仍在计算、等网络或等人；命中文本也可能只是回显。任务成功仍须依据实际结果。

## 交互进程所有权

CLI 菜单按入口显示「恢复原对话」与「开启新对话」。恢复通过原 Harness、cwd 和原生 ID 查验，查验失败时展示原因并保留原句柄。内置适配器会拒绝与这两种操作冲突的已知原生会话和目录选择参数。仅启动的终端可显式新开。宿主对 PTY 的启动回执表示进程已启动，原生对话加载结果由引擎负责。见 [会话模型](session-model.md#6-已知边界)。

普通终端通过 `interactiveOwner.ts` 在启动用户 shell 前建立容器。Windows 使用系统 Windows PowerShell 控制台进程承载 ConPTY，通过私有管道的 PID/nonce 握手完成 Job 归属后才启动用户命令；Electron 的 GUI 可执行文件不能充当此控制台锚点。适配集中在 `interactiveWindows.ts`，用户命令与参数作为数据传输，默认按 Windows argv 规则转义，显式 verbatim 参数保留调用方合同。缺少系统 PowerShell 或控制处理器所需能力时报告启动错误。空闲时等待管道输入或子进程句柄，不用常驻高频轮询。

macOS/Linux 保留独立 SID 和受控进程组适配，关闭前固定同会话进程组身份再回收。Linux 此处仅使用 PTY/进程能力，不依赖 X11/Wayland。主动脱离会话的进程及 SSH/WSL guest 内的任务属于明确边界，不能宣称与 Windows Job 等价。

macOS 上打开交互或后台终端前，宿主会检查当前 `node-pty` 原生模块使用的 `spawn-helper`。npm 预编译包可能将它安装为 `0644`，缺少执行权限曾导致 Demo 搭建时 `PtyFork` 抛出原生异常，整个 Electron 主进程退出。源码启动时会自动补齐缺失的执行位。安装版遇到辅助程序异常时会向当前终端请求返回修复提示，录屏和其他会话可以继续。实现见 `src/main/pty/spawnHelper.ts`，回归用例见 `test/pty-spawn-helper.mjs`。

`spawn` 返回可等待的代次；启动途中停止或被替换时，迟到结果不能重新发布会话。`killAndWait`/`killAllAndWait` 等待容器、原生 PTY 与 Windows 输出线程真实结束，失败保留 owner 以便诊断和重试。归档、工作区重置及应用退出等待这道屏障。Ctrl+C 只中断前台命令，持有容器的根进程继续存在；用户 shell 是否保留由其自身交互语义决定。

## 实现与验证

| 文件 | 职责 |
|---|---|
| src/main/capabilities/hosts/terminal.ts | 定位、写入、等待后截图/文本与分享回执 |
| src/main/pty/manager.ts | 进程代次游标、保留后缀与实时输出/退出/替换通知 |
| src/main/pty/composerSubmit.ts、injectFile.ts | CLI 工作台提交、运行时粘贴能力、文件回退与错误反馈 |
| src/renderer/src/components/CliSessionView.tsx、FloatingCapsuleDragHandle.tsx、useCliComposerPlacement.ts、cliComposerPlacement.ts、useCliTerminalHold.ts、terminal/blankCell.ts、chatSurface/useSessionNotes.ts | 悬浮输入区、把手拖动贴边、终端空白长按预览与提交、终端划词和文件/网页批注草稿 |
| src/main/pty/outputWait.ts | 有界匹配、静默计时、取消与监听释放 |
| src/shared/terminalCapture.ts | 文本尾部、写入意图与 UI 路径投影 |
| src/main/capabilities/catalog/runtimesTerminalChat.ts | 模型参数与返回语义 |
| src/main/capabilities/executor.ts | 原执行链、序列化与 UI 元数据 |

test/terminal-capture.mjs 走真实 handler→executor→serializeResult（R5 后直调），覆盖 PNG 路径、文本兜底、保存/分享失败。terminal-output-wait.mjs 走真实 manager 与模拟 PTY，覆盖游标、旧文本、ANSI/chunk、静默重置、取消、退出、停止、替换和淘汰。terminal-output-pty.mjs 使用真实 node-pty，验证 write→capture 间输出、静默与退出码；测试进程独立收口，避免 ConPTY 对已退出控制台再次枚举。`interactive-powershell-owner.mjs` 在 Windows 默认分别用系统 Node 与 Electron Node 模式运行真实 PowerShell，覆盖 cooked Ctrl+C 后继续执行、参数保真及原生退出；`interactive-pty-owner.mjs` 覆盖进程树与输出线程关闭。`test/e2e/interactive-pty-lifecycle.spec.ts` 经真实界面输入、改变窗口尺寸并正常退出应用，验证完整生命周期。Windows/macOS/Linux 真机证据分别记录，具体运行状态见重构账本。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D03.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：调度/Worker 操作宿主托管的 PTY 终端（terminal.write 键入／capture 截图／waitFor 条件等待）；terminal.create 建普通 Shell 会话（非 Agent harness、无任务无隔离参数）。
- 为什么这样设计：outputCursor 游标界定「本次输入之后的新输出」，防旧 scrollback 误匹配；wait.reason 区分 text/quiet/timeout/exited/stopped/replaced（replaced 明示画面可能属新进程，不作完成证据）；截图 PNG 有界保留 20 张、非长期存档；显式声明「写入成功≠CLI 接受指令、静默≠任务成功」防模型误判。
- 明确不做：不操作 GUI 聊天会话与宿主外系统终端；不把图片 base64 塞进上下文；不承诺等待命中=任务完成。
- 歧义点：terminal.create 的 Shell 会话永远 shared（不支持隔离）是长期边界（Shell 是用户交互终端，隔离语义只属派活）还是未来开放？A=长期边界（review 不把「Shell 无隔离」当 finding）／B=未来开放。推荐 A。
