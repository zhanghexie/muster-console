# 内置浏览器（原生 webview + 后台 DOM 工具）

`host.browser.run` 的 tabs 模型结果仅去掉每条标签的 favicon 图标资源，保留所有标签、id/title/url、归属、加载/崩溃和导航状态；原始 UI 快照不变。snapshot/evaluate/network body 等显式读取仍保留正文，不在修改动作后自动补整页快照。具体回执判据、图片交付边界和超过 12k 的放大回归见界面工具回执审计。

内置浏览器位于右侧统一内容标签中。普通网页标签持有真实 `<webview>`，用户直接浏览 Chromium 页面；新建标签页和交互 UI 标签由宿主 React 绘制。AI 通过固定 DOM 语义操作处理后台网页；不同页面的工具调用可以并行，同一页面的修改按调用排队。

桌面会话中的 HTTP(S) 链接默认在这里打开；右键可选择系统浏览器，文件链接的系统打开选项见 [聊天转写](chat-transcript.md)。

从 Worker 打开的标签归属该会话。访问 `localhost` 时，端口由同一台机器上的监听进程决定。两个会话访问同一个地址会连接到同一个服务。调试本地项目时，使用本次开发服务器启动成功后报告的实际 URL。

浏览器界面根节点 `.browser-page` 使用 `border-box` 和四周 2px 内边距，相对承载背景页向内缩进，工具栏与网页区域一起让出边缘；右侧工作区的网页容器保留底部两角圆角，半径为页面圆角减去 2px 内缩，通过网页容器的显式 clip-path 裁切原生 guest 合成内容，避免仅设 border-radius 时底角仍残留网页底色；不改变或重挂载 webview。

布局和标签作用域见 [右侧统一多标签](right-workspace-tabs.md)，方案来源与验证边界见 ZCode 复核 和 后台交互隔离记录。本轮已通过下文列出的生产 Electron 隔离验收，物理 OS 输入法和复杂外部站点仍保留专项边界。

右侧标签的网页式整屏显示保持同一 webview。当前前台 guest 的原生 Esc 通过 `browser:escape` 通知宿主退出标签全屏；后台、过期 guest 及 Agent 操作不能借此退出用户全屏。具体入口、布局恢复和验收边界见[标签页整屏显示](right-workspace-tabs.md#标签页整屏显示)。

## 功能职责

### 确定性动画渲染（扩展 Host）

具备 `hostTools` 权限的扩展可通过 `ma.tasks.render(request)` 使用宿主内置浏览器渲染 HTML 动画。`start` 或 `preview` 在指定 `tabId` 上复用页面；只给 `url` 时由宿主打开后台内置浏览器标签。宿主按固定 `width`/`height` 设置页面视口，依次在原生 webview target 中调用 `window.renderAt(t)`（页面收到的 `t` 为秒；请求的 `times`/`durationMs` 与状态 `currentTimeMs` 为毫秒），再用 `Page.captureScreenshot` 采集每个时间点的帧；帧经主窗口 WebCodecs VP8 和既有 WebM 复用器落盘。整个链路不启动外置 Chrome、Playwright 或 Python，后台页面也不需要切到前台。

渲染任务是异步的：返回 `renderId`（同时提供 `jobId` 别名）后用 `ma.tasks.render({action:'status', renderId})` 查询 `status`、`frameCount`、`totalFrames`、`currentTimeMs` 和 `error`，用 `action:'cancel'` 取消并丢弃未完成帧。`action:'validate'` 会检查目标页是否提供 `window.renderAt`，传入 `times` 时还会重复渲染并比较同一时间点的帧，发现不一致则返回失败；完成回执的 `artifact.path` 是宿主本地 WebM 文件。任务结束会恢复调用前的 Agent 视口 override；标签关闭或换代会取消任务。时间点必须递增，最多 1,500 帧、120 秒，未传 `times` 时可用 `durationMs` + `fps` 生成固定时间序列。

### 网页截图

`browser.screenshot` 按元素、当前视口或主文档采集 PNG。Chromium 对 webview 直接请求超视口光栅时可能用同一个合成画面填充后续区域。`fullPage:true` 按初始文档范围逐段滚动和采集视口，按实际滚动位置、显示缩放和滚动条范围拼接，最后恢复原文档的横纵滚动位置。分段采集可能触发页面的滚动监听，固定或粘性元素可能出现在多段。拼接限 30 秒、4,000 万输出像素且每边最多 32,767 像素。超限可改截可视区域或元素，手势缩放后需恢复原比例再截整页。

未激活标签的显式截图会短暂使目标 webview 可合成，继续保持 `inert`、`pointer-events:none` 和后台 presentation，结束后恢复隐藏样式。截图仍在同页工具队列中。失败保留原始错误并附 tabId、fullPage 和 CDP 代理未响应的命令与耗时。诊断不含参数、页面正文或 URL。代理按连接和 session/id 隔离记录，响应或断线即清除，单连接最多 256 项，错误最多展示 16 项。`test/browser-cdp-input-policy.mjs` 验证挂起命令及跨 session 同 id。`test/e2e/browser-background-tools.spec.ts` 通过公开工具两次采集多屏页面，检查文件中的首屏、中段和页底像素，以及滚动恢复、前台标签和地址栏焦点。

独立合成探针 `test/browser-screenshot-visual.mjs` 在 Electron WebGL 页执行隐藏和前台、视口和超视口的原始 Chromium 截图，并检查 PNG 格式和尺寸。它可选接收本地静态站点目录。PhySicsLab 的历史 30 秒超时仍待复现。见反馈核实报告。

- **用户浏览**：从右侧收藏栏等资源入口打开的网页在工作区内共享。从会话链接或 AI 打开的网页绑定来源会话，标签上显示「跟随会话」图标。网页中新开的标签继承父页面归属，固定状态由用户单独设置。收藏夹资源树、地址/搜索归一化、导航历史、刷新、DevTools、系统浏览器打开及新窗口转内置标签沿用现有入口。独立浏览器页的标签栏列表已抽为 `components/BrowserTabList.tsx`（2026-10-27），支持 Ctrl/⌘ 点选与 Shift+←→ 范围多选（共享 `useListSelection`），右键可「关闭选中的 N 个 / 关闭其他 / 关闭右侧」（逐个 `browser.close`，激活与 IPC 仍由 BrowserPage 持有）；修饰键点击不激活标签。独立浏览器页的调宽线居中落在网页与标签栏之间，悬停或拖动时显示 3px 线。回归：`test/unit/browser-tab-list.spec.tsx`。
- **新建标签页**：人工新建标签默认打开工作台风格的收藏与搜索页面，未恢复任何标签的首次启动也创建该页。收藏导航区域在鼠标点击后保留键盘焦点，焦点视觉只落在当前行，不会把整个内容区域填灰。搜索弹层中用空格选中的搜索引擎使用独立的选中底色和边框，与键盘当前项的高亮区分。收藏侧栏的主页按钮打开或复用当前工作区共享的主页。从主页打开的页面继承该主页的归属。侧栏的文件夹新建和重命名保留在右键菜单，并使用统一弹窗。收藏、文件夹和搜索引擎由工作台管理，不依赖 Chrome 扩展 API；收藏数据仍按项目隔离，侧栏与新标签页共用。背景与透明度由工作台实现，未引入 BrowseHome 的主题。
- **持久登录态**：所有标签共用 `persist:browser` partition，工作区之间共享登录态、Cookie 和同站点持久存储。UA 使用真实平台、Chromium 和 Electron 版本，移除工作台产品名；Google 等网站的具体登录结果仍需实测。
- **本机数据清理**：设置 → 本机存储可清除此共享分区的站点数据和缓存，也可清理有完成或中止记录且文件信息匹配的下载文件。旧版本文件或记录缺失时只读；信任假设、影响、确认和错误边界见 [本机存储](local-storage.md)。打开的网页可能重新写入站点数据。
后台文件选择通过 `host.browser.run` 的 `upload` 动作赋值，不打开原生文件选择器；人工在前台触发的原生选择器仍由真实用户手势保护。截图模型结果保留本地 `path`、提示和告警；`previewPath` 与 `path` 完全相同时在模型出口去重，宿主预览和证据仍从原始结果取路径。

文件赋值回执不证明服务端已接收，上传结果须单独读取页面或服务端证据。`test/e2e/browser-upload.spec.ts` 在 Windows 真实 Electron 中通过公开 `host.browser.run` 覆盖服务端拒绝和接受、收到的文件内容及授权范围；长工作区模式此前也通过，数据库目标路径超过 260 字符。SQLite 长路径、共享 WAL 与重开另有 Node 和 Electron 内置 Node 回归。测试显式禁用网页访问并在 Electron 退出后释放测试管道；这些结果不能证明所有环境的退出稳定，日志曾出现 webview 销毁时的 `Invalid guestInstanceId`。macOS 和 Linux 尚未真机验证。

- **后台自动化**：`browser.*` 使用显式 `tabId` 或可信调用身份的私有选择定位页面，观察沿用 Playwright `ariaSnapshot(ai)` 和 `[ref=eN]`（iframe 内或帧重建后为 `f{seq}e{N}` 帧前缀形式，定位时同样包成 `aria-ref=` 由选择器引擎跳帧解析）。支持 DOM 按钮和键盘事件、填写表单、滚动容器和 guest 内指针移动。
- **前台选择独立**：AI 的 open/activate 不选择用户内容标签、切换工作面或请求原生输入焦点。用户通过内容标签、地址栏或浏览器 IPC 显式选择前台页。
- `host.panel.open` 的浏览器面板桥接检查已分配且归属明确的标签；默认只返回已投影到当前工作区的现有标签。显式 `focus:true` 时，当前调用会话可以把自己拥有的 HTTP(S) 后台标签（包括扩展隐藏会话的标签）提升为工作区共享展示，再复用右侧工作面状态机露出。宿主和 Renderer 分别核对 workspace、session、browserId、URL 和唯一已有标签，不允许借此展示另一会话的隐藏页；`file:`、`muster-ext:` 仍默认脱敏。查询不触发恢复、默认页创建、guest 挂载或导航；工作区、标签归属或 URL 改变时拒绝或报告结果不确定。网页仅支持右侧，请求中栏会明确拒绝，也不实现关闭浏览器标签。网页中栏探索发现重建 webview 会丢失页面状态；将来可考虑固定父节点并用 CSS 锚定位置，但该方案尚未实施或验证。
- **状态与证据**：`browser:agentState` 展示工具活动；可选回合截图按实际使用标签归集。读取类动作无需审批，操作类按权限档可能触发审批，非空上传还需安全审核；不靠自动切前台展示动作。

## 架构

```text
renderer BrowserPage（跨工作区保留已挂载 guest）
  ├─ 稳定 tabId → BrowserTabView → 真实 <webview>
  ├─ 内部新标签页 → BrowserHome → 工作区收藏树（不创建 guest）
  │   前台：正常布局，用户直接使用 Chromium 指针/键盘/输入法
  │   后台：固定非零尺寸、隐藏、inert、tabIndex=-1、禁指针命中
  ├─ browser:mount-request → 仅增加 mounted 集合
  ├─ browser:focus-request → 拒绝旧的焦点借用请求
  ├─ .browser-gesture-layer → 露条驻留/切屏及人工滚轮
  └─ 地址栏、状态胶囊、元素备注和原生页面上的宿主浮层

main BrowserTabService
  ├─ 标签壳、导航 revision、恢复与崩溃策略
  ├─ BrowserGuestRegistry：tabId / webContentsId / generation 权威绑定
  ├─ ensureGuest → 请求 renderer 懒挂载 → attach → 接线 → 首次导航
  ├─ BrowserPageOperationQueue：每标签工具修改 FIFO
  └─ 弹窗桥、文件选择拦截、下载、console/网络、拾取、视口、录屏

Agent 调用
  可信 Worker 身份 → executor browser.* → BrowserAgentTools
    → 每页工具修改队列 → Playwright / CDP 类型代理
    → 固定 DOM 语义函数 → 指定 guest 的目标元素
    → 仅指针移动走目标 guest 的无按键 CDP 鼠标移动

工具 CDP 代理
  webview target → page；Runtime.evaluate/callFunctionOn 强制 userGesture:false
  拒绝原生 Input 派发、输入文本及 Page/Target 前台激活命令
```

### 原生页面与保活

前台网页由真实 webview 直接合成和接收用户输入，宿主没有连续截帧显示、输入接收器或人工键鼠转发链。浮层覆盖、虚拟屏 transform 与裁剪作用于原生 webview 的 DOM 布局。

网页位于右侧虚拟屏露条时，宿主手势层接住新的按下并激活右屏。面板历史等入口程序化切屏后的点击静默期只拦宿主 DOM 的跟随 click，网页露条上的新按下仍立即生效。切屏手势由宿主接收，右屏激活后网页恢复原生交互。

后台 webview 仍留在原 DOM 位置，当前停放为固定 1280×900 非零布局，并设置隐藏、`inert`、`tabIndex=-1` 和 `pointer-events:none`。后台工具以 guest 身份为作用域，人工键鼠命中仍由前台的 webview 接收。切标签、会话和工作区不会卸载已有 guest，页面内存、草稿、滚动和历史由同一实例保持，因而仍有资源开销。关闭标签或归档其所属会话时解绑并销毁会话网页的 guest。归档时保留工作区共享网页。恢复会话后只恢复入口，网页显示或被后台请求时重新创建，不恢复页面内存或未提交表单。

`BrowserPage` 在冷启动就订阅标签与挂载请求，不依赖用户先访问浏览器工作面。后台 mount 请求只创建目标 webview，不选中内容标签、不展开工作面，也不调用 `focus()`。 右侧分屏可同时呈现多个 guest，`BrowserPage` 按右侧槽位调整各 guest 的显示位置。用户在已显示的 guest 中点击时，`BrowserTabService` 从当前代且宿主窗口在前台的原生鼠标事件发出 `browser:guest-click`，渲染端按当前分屏与标签归属复核后更新工具栏焦点。StrictMode 的 effect 重放不应退役仍连接的 guest；实际节点断开后才上报 detach。

跨中右栏放置仍未接入。Windows 隔离 Electron 探针显示，即使使用 `moveBefore` 移动包含 `<webview>` 的 DOM 容器，guest 仍换代且未保存输入丢失，不能套用扩展 iframe 的移动方式。另一个最小夹具 `test/e2e/webview-anchor-probe.spec.ts` 保持 webview 父节点固定，通过 CSS 锚点变更位置和跟随平移，guest 身份、脚本状态与输入值保持；简单平移动画逐帧位置误差小于 1 像素。鼠标命中和 guest 输入事件通过，物理键盘路由未验证。锚定层不会自动继承目标的裁切，须另行同步裁切；夹具验证了显式裁切和遮挡命中。这只是方案探索，不代表已接入工作台或验证多标签、真实虚拟屏动画、全套弹层和 macOS/Linux 真机。

同一夹具中，固定定位的网页层放在固定的两层裁切容器内，可分别锚定目标和祖先，矩形交集、圆角与祖先平移期间仍保持 guest；把网页层改为绝对定位的试验未对齐目标。当前结论只覆盖夹具中的 CSS 形状，尚未证明工作台所有祖先样式、透明度、滚动和合成顺序。

原验收 `test/e2e/extension-iframe.spec.ts`（真实工作台不可见锚点标记在虚拟屏切换期间逐帧对齐）已随扩展系统迁移移除；其结论保持成立——标记不是 webview，该结果不证明网页迁移或裁切已经接线。

`browserSurfaceGeometry.ts` 预备 CSS 视口坐标下的矩形交集和向内取整；`browserSurfaceAncestors.ts` 在单个时点检查祖先隐藏状态、矩形 overflow 裁切和轴对齐二维变换，对圆角裁切、clip-path、遮罩、混合、滤镜及无法确认的变换返回 unsupported。该检查尚未处理所有 CSS 合成情况，三维矩阵也保守拒绝；它不会订阅布局、滚动或动画，没有接入网页渲染，不能单靠它保证实际裁切。最小 Electron 夹具验证过矩形 overflow 和圆角拒绝。

### 生命周期与身份

- **首次导航归主进程**：webview 初始 `src="about:blank"`；dom-ready 后上报 webContents id。主进程先验证并绑定身份、接好网络/console/弹窗/销毁事件，再加载保存 URL，避免首个主文档请求早于接线。
- **导航只发一次**：attach 与显式 navigate 复用当前 guest/revision/URL 的加载任务。挂载与主文档就绪共用有界等待；导航返回真实结果，旧 revision 或旧 guest 的迟到完成不能覆盖当前标签。
- **不按 URL 猜目标**：`tabId` 先解析权威 guest，再按该 guest 的 CDP targetId 查找 Playwright Page。同 URL 双标签、页面自行修改 marker、关闭/换代均不能触发 URL 兜底。
- **调用身份绑定**：CLI Bearer 和 GUI `exec.sessionId` 由宿主解析，模型不能覆盖内部 owner。AI 创建标签带 `openInBackground:true`；`browser.activate` 只更新该调用身份的私有目标并返回 `background:true`。允许省略目标的工具使用该私有选择，不回落用户当前前台。
- **崩溃限次恢复**：同 guest 原地 reload；连续崩溃按 0/1/3/8 秒退避，第 5 次停止自动恢复并展示错误卡。稳定超过 60 秒可清计数；显式导航、刷新或重试清零并取消旧定时器。关闭/换代/退出清理定时器，旧代次消息不能驱动新 guest。恢复是尽力保留历史，不保证 JS 内存、连接或未保存草稿。
- **工具连接恢复**：动作前只读 session 探测允许重连一次，已经开始的动作不自动重放；并发恢复共用新连接，重连后仍校验原 guest 身份。
- **用户操作失败可见（2026-10-25，X4-F03）**：工具栏/标签栏的用户操作——崩溃重试（`retryCrash`）、后退/前进/刷新（`nav`）、开发者工具（`devtools`）、标签页激活/关闭、标签栏宽度/收起（`setTabbar`）——IPC reject 一律 `flashTip(String(err))`，对齐同文件既有风格；「在系统浏览器中打开」消费 `shell.openExternal` 的 `{ok,error}` 合同，失败展示 error 原因（无 error 字段给通用文案）。回归 `test/unit/browser-page-action-errors.spec.tsx`。

### 右侧撤销和重做

右侧统一标签的网页打开、关闭和导航与文件操作共用一对按钮。网页导航按 Chromium 提交的位置入栈，涵盖网页链接、同文档导航和网页触发的前进后退。原地刷新同一个历史项时步数保持不变。回放通过 `browser:replay-panel-history` 移动活 guest 的历史索引。撤销关闭时，主进程在新 guest 首次导航前恢复 Chromium 导航栈。浏览器快照携带不透明的历史键和回放请求 ID，右侧按回执确认逻辑标签绑定。

Chromium 导航条目留在主进程内存，由 `browser:retain-panel-history` 保留撤销与重做仍引用的条目。正常会话切换复用活 guest，撤销关闭恢复导航位置。页面运行内存随关闭销毁，站点操作的结果由站点管理。启动水合和后台 Worker 操作不生成用户历史。详见[右侧统一多标签工作面](right-workspace-tabs.md)。

### 工具修改队列

click/fill/select/upload/scroll、指针移动、截图、导航、storage 修改及视口修改按 tabId 进入 `BrowserPageOperationQueue`。不同标签有各自队列；一次工具调用是一个队列单元，多次调用不自动组成事务。失败后后续调用继续；关闭或 guest 换代拒绝尚未开始的旧操作，不将已发出的动作重放到新页面。

snapshot、wait、console/network 读取和 JS 弹窗处理可在动作等待时独立运行。**人工原生指针、键盘和输入法不进入工具 FIFO**；人工与 AI 同时编辑同一个页面时，网页仍会收到交错事件。

### DOM 语义动作与协议边界

`semanticActions.ts` 的固定闭包在目标元素所属 frame 中执行，不调用元素或窗口 focus，不派发原生鼠标/键盘，不借用系统剪贴板，也不回退到 Playwright 原生输入。

- **click**：ref 或选择器使用 HTML 元素的 DOM click。坐标形式 `target:"x,y"` 用视口 CSS 像素命中页面元素，可向 Canvas 派发合成 pointerdown/up、mousedown/up 和 click。直接点击文件输入需改用受控上传或人工选择。跨源 iframe 内的元素操作使用帧 ref。
- **fill**：通过目标原生 input/textarea 的 value setter 替换文本，并发出合成编辑通知；不移动光标或切换焦点。只接受已支持的原生文本控件，contenteditable/专有编辑器及依赖可信输入的页面不能假设兼容。
- **selectOption**：选择原生 `<select>` 中匹配 value 或文本的可用 option，并发送合成 input/change。
- **scroll**：省略 `target` 时滚动主文档。传入容器的 CSS 选择器或快照 ref 可直接滚动该元素。
- **movePointer**：宿主对已绑定 guest 发送固定的 `Input.dispatchMouseEvent(mouseMoved)`，传入 `target:"x,y"` 使用视口 CSS 像素。按钮掩码固定为零，可触发 Chromium 指针事件和 CSS `:hover`，不授予用户激活。系统鼠标位置由人工输入决定。原有 `hover` 工具用于按 ref 或选择器派发合成 JS 事件。
- **upload**：按可信调用者的读取目录快照校验文件及 realpath，复制成临时快照后按内容摘要、目标主页面及实际 iframe 地址经安全审核；审核后重验目录、guest 与元素，再向该元素赋值。调用者会话一旦归档，旧范围立即失效，之后取消归档也不会复活旧范围。用字节载荷保证页面文件内容不依赖临时快照存续，当前 Playwright 传输限制文件总量小于 50 MiB；超限明确报错。空数组清空文件输入。赋值回执不证明服务端上传成功；派发结果未知时需先检查页面，不能自动重放。

DOM 动作响应为 `mode:'semantic', trusted:false`，`movePointer` 响应为 `mode:'pointer', trusted:true`。后者的信任标记表示 Chromium 生成了页面移动事件。HTML 控件默认激活也可能另发可信 input/change。用户激活仍取决于浏览器的手势判定。

Agent 专用 CDP 代理对 `Runtime.evaluate` 与 `Runtime.callFunctionOn` 强制 `userGesture:false`，并拒绝 `Input.dispatch*`、`Input.synthesize*`、`Input.insertText`、IME/触摸模拟，以及 `Page.bringToFront`、`Target.activateTarget` 等原生派发或激活通道。不支持的工具直接返回 `capability_unsupported`，不会先切前台、试原生输入或静默降级。人工原生网页输入和用户 DevTools 不经过这条工具代理。

工具不授予用户手势，因此需要 transient user activation 的生成式部件动作（例如 `maUi.openUrl`）不能由 AI 合成点击冒充人工触发；真实用户在网页中点击后仍走原来的宿主桥。`browser.evaluate` 通过 `buildProtectedEvaluateScript` 执行：同一主文档的所有调用与已包装的延迟回调复用一个控制器，共享焦点保护计数和原始方法记录；同步、Promise、定时回调及可达同源 iframe 的保护全部退出后才还原方法。控制器随页面文档销毁，空闲期间保留控制器但不保留方法补丁，避免旧回调与后续调用交错还原。它覆盖已拦截的调度路径，不是任意网页脚本的安全沙箱；未包装的事件回调、页面预先保存的原生方法和不可达跨源 frame 仍需专项验证。测试夹具的独立观察不属于开放给 AI 的产品能力。

## 工具面

| 分类 | 工具与行为 |
| --- | --- |
| 标签与导航 | tabs/open/close/activate/navigate；AI open/activate 默认保持后台，activate 传 `foreground:true` 时切到浏览器前台；主文档导航带 25s 超时与 `did-fail-load` 终态错误上报 |
| 页面观察 | snapshot（支持 `selector`/`interactiveOnly`/`offset`/`maxChars`，超长自动按 9000 字符分段避免 12KB 拒收；附 consoleErrors、pendingDialogs）、waitFor（纯 `timeMs` 等待不依赖页面就绪）、screenshot（同时返回 `path` 供多模态模型直接读图与 `previewPath` 供 UI 展示）、console、network、downloads |
| 后台修改与执行 | click（ref、选择器或小数坐标）、fill、selectOption、upload、scroll（支持容器）、hover、movePointer（坐标）、pressKey、drag（支持 ref、选择器或小数坐标）、evaluate（`userGesture:false` 及焦点保护）；等待中的动作可在检测到 JS 弹窗时返回 `pendingDialogs` |
| 视口 | setViewport（reset:true 重置）；Emulation override，尺寸按既有 320–3840×320–2160 范围处理；只清本工具的 override，guest 换代重应用 |
| 弹窗 | dialog list/accept/dismiss/policy；由 preload 同步桥处理 Electron JS 弹窗 |
| 存储 | cookies get/set/clear 与 localStorage/sessionStorage get/set/remove/clear；仍受共享登录态语义约束（set 时宿主归一化 playwright addCookies 契约：url 优先剔除多余 domain/path，domain 定位缺省 path=/） |
| 录屏 | recording start/stop/status/cancel；只对已可见网页启动，隐藏页返回 `capability_unsupported`，不自动显页；CDP JPEG 采集 → WebCodecs VP8 → WebM，关页/换代清理 |
| 用法文档 | 公开面使用 `host.browser.run` 单入口；参数细节在 `~/.muster/skills/browser/SKILL.md`，`browserHelp.ts` 保留作参考数据 |

工具仍由调度 executor、GUI Worker Catalog tools、CLI Shell API 三条既有通路开放。观测类沿用 read 档，动作类沿用 browser 档；非空文件赋值另走安全审核。GUI Worker 使用当前宿主回合范围，CLI Worker 使用其进程启动时冻结的目录租约，不用 GUI 备用路径重算；进程换代、退出或 GUI 回合换代时旧操作失效。权限不足或调用身份不明时拒绝上传。

## 保留能力与交互

- **工作台新标签页**：`muster-home://new/<UUID>` 是每个新标签的内部身份，地址栏隐藏该身份；通过地址栏导航到网页时复用标签并走正常 guest 生命周期。人工新建入口通过 `browser:open` 的 `newTab` 参数生成该身份；没有恢复标签时创建默认页。Agent 的无 URL 开页与显式 `about:blank` 仍保持原空白页语义。该内部页没有 webview，guest attach 和浏览器 DOM 工具对它明确返回不支持。实际网页的加载、用户输入和后台工具合同不变。
- **收藏与搜索**：新标签页以居中限宽搜索框和工作台风格面板组织内容，收藏在面板内按上级、当前目录、预览分栏，文件夹行显示子项数量；窄容器减少列数并将预览放在列表下方。搜索框右侧以文字显示默认搜索引擎，旁边的管理入口用于修改默认项；输入内容后仍可在搜索浮层临时选择多个引擎。搜索结果以搜索框下方的浮层覆盖收藏区，开合不改变收藏面板位置；内容超出时浮层内部滚动，键盘选中项保持可见。底部固定高度的操作栏提供可点击的上级、上/下项、进入文件夹、打开、多选和整理，图标附带快捷键与可访问名称；整理模式在同一栏显示编辑操作，不改变收藏列表几何。窄容器固定预留两行以容纳两组图标，切换模式不挤动内容。收藏和搜索引擎弹窗中的文本及描述字段共用工作台 `ui-input` 样式。键盘焦点用柔和填充提示而非明亮边框。支持方向键或 `hjkl`、`/` 搜索、Enter / `o` 打开、`O` 后台打开、Space / `v` 多选和 `e` 整理；整理模式可新建、改名、编辑描述、删除、剪切粘贴、移动及按名称或添加时间排序。搜索支持选择或自定义最多 12 个 HTTP(S) 搜索引擎；默认预设不含百度，读取旧配置时只移除未修改的百度内置项，失效的默认项回退至列表首项，用户自建或修改的引擎保留；在搜索框按向下键进入引擎行后，可用 Tab 切换引擎、Space 选择、Shift+Space 全选或清除。批量打开首项前台、其余后台，超过 10 个网页需确认。搜索引擎配置保存在渲染层 localStorage 的全局 `muster.browser.home.search.v1`，目录位置按工作区保存在 `muster.browser.home.navigation.v1:<workspaceId>`；项目收藏保存在控制根的 `.muster/bookmarks.json`。
- **壁纸与透明度**：收藏工具栏可选内置品牌壁纸、本地图片或无壁纸；默认壁纸随工作台主题的明暗自动切换，并可调 0–100% 的材质透明度。透明度滑杆使用平方曲线，让前段调节更细，显示和存储的百分比是实际透明度；旧设置原样保留。搜索框和收藏面板共用底色、透明度、边框与模糊强度，选中项和边框随面板逐步变淡并保留一定辨识度；文字、图标不改变透明度或模糊，搜索结果浮层保持实底。完全透明时文字对比度取决于壁纸。材质模糊滑杆为 0–40px（默认 0），通过背景滤镜仅模糊搜索框和收藏面板背后的画面，壁纸本身及控件内容保持清晰；页面滚动时壁纸仍覆盖可视区域。图片通过系统文件选择器选取，限制为可解码的 PNG/JPEG/WebP/GIF/AVIF/BMP、最大 20 MiB；图片内容保存在渲染层 IndexedDB，模式、图片 ID、透明度和模糊度保存在本机 localStorage 的 `muster.browser.home.appearance.v1`，所有工作区的新标签页共享并实时同步。更换或移除图片后清理旧副本；读取失败会提示，设置弹窗也展示失败原因，弹窗关闭后的异步保存或清理失败通过提示反馈；与窗口背景的壁纸文件和清理逻辑互不影响。
- **默认收藏**：每个工作区首次加载时合并一批国内外常用网站，分为工作、娱乐、阅读学习和实用工具；与已有收藏按网址去重并复用同名文件夹。初始化版本与收藏树一起保存，用户之后删除或移动默认网站不会在重启时复原；收藏容量不足时整批不写并提示。默认项的 ID、原始标签和网址均匹配时，侧栏及主页只在展示层按当前语言翻译标签；搜索同时匹配原始名称与显示名称。预设搜索引擎也只翻译未修改的默认名称。用户改名、网址或自行创建的收藏和搜索引擎仍显示并保存原文，语言切换不改数据。具体保存与边界见[右侧统一多标签](right-workspace-tabs.md#状态与-ipc)。
- **站点图标**：访问已收藏的网页时，工作台只对该页已发现的同源图标发起无凭据、禁止重定向的有界请求，最多读取 256 KiB，转成 32×32 PNG 后存入收藏；无法缓存时使用本地图标。新标签页展示缓存时不访问第三方图标服务。
- **CLI 交互 UI 页**：`ui.render` 为 CLI 会话自动复用一个 `muster-ui://session/<sid>` 内部标签，通过 `uiWidget:present` 露出当前会话的右侧页面。该页由宿主 React 直接绘制 GUI 同源交互卡片，不创建 webview；DOM 工具明确拒绝，公开参数走 `ui.inspect`。普通网页继续使用原生 webview，普通 AI 开页仍默认后台。详见[智能界面](intelligent-ui.md#cli-自动展示与会话聚合页)。

- **导航与标签**：URL/搜索词默认按必应归一化，支持后退/前进/刷新、detach DevTools、在系统浏览器打开。统一内容历史可跨文件/Git/网页回放，普通标签、Pin、收藏夹和资源栏宽度沿用右侧工作区合同。关标签卸载 `<webview>` 元素时 Electron 43 必发一次 `Invalid guestInstanceId` 上游噪音（guest 实际已正确销毁），已在渲染层错误分级里归良性不弹崩溃 toast，见 [crash-observability](crash-observability.md)。
- **新窗口分流**：`window.open`/`target=_blank` 默认转内置新标签并继承 owner；弹窗形态（disposition `new-window` 且特征串含宽高/top/left 等窗口 token——Electron 43 实测不产 `new-popup` 枚举）且源于 5 秒内真实用户手势的，放行 Electron 原生弹窗。弹窗式 OAuth（微信扫码等）依赖 `window.open` 返回值、`window.opener.postMessage` 与 `window.close()` 三条契约，一律 deny+转标签会把通道整个切断（页面拿 null 引用、弹窗无 opener，原页面永久卡「正在登录」）；原生弹窗继承 guest 的 `persist:browser` 会话。无手势的弹窗形态与 Agent 触发的开窗维持转标签，不引入新的静默拦截。策略纯函数在 `popupPolicy.ts`，手势时间戳按标签记录、随失效/关闭清理。
- **露条**：网页可见但工作面未激活时，手势层截获驻留和首击，用真实用户手势切屏；首击不能同时误点网页。人工滚轮通过 `browser:wheel-forward` 处理双轴和 deltaMode，不进入 Agent CDP 代理。这是人工工作面交互，不是后台 AI 的可信滚轮能力。
- **窄屏**：用户通过右侧抽屉查看真实网页；AI 动作不自动展开抽屉。切屏/抽屉动画结束后才可据最终布局判断原生命中。
- **外壳不可滚动**：工作面外壳采用 `overflow:clip`，实际滚动由内部标签、工具和内容区管理。修复前外壳 `scrollLeft=59` 使原生网页越过抽屉左界；回归同时检查 guest 左右边界与外壳零横向偏移，修复前明确失败，不能以中心命中通过代替完整显示验收。
- **JS 弹窗**：主文档的 webview preload 在网页脚本运行前替换 `alert/confirm/prompt`，经 `browser:js-dialog` 的同步 IPC 等待宿主答复。手动模式保持页面调用阻塞，`confirm` 接受返回 `true`、取消返回 `false`；`prompt` 接受返回输入字符串（包括空字符串），省略输入则用默认值，取消返回 `null`。120 秒超时或文档退出时清理弹窗。Electron 报告的子帧原生弹窗走 CDP 兜底，已由浏览器关闭的项从队列移除。
- **文件选择与下载**：AI 可经受控 upload 向文件输入赋值；直接点击 file input 和脚本触发的原生文件选择仍由 picker guard 拦截并提示人工操作。人工系统选择框仍需专项验收。session `will-download` 自动落盘至隔离 userData 下的 browser-downloads，并保存来源标签和状态。
- **元素备注**：⌖ 进入 DevTools 式拾取器，命中后打开宿主备注卡，保存为最近聚焦的 GUI 或 CLI Agent 输入框中的批注胶囊；二次编辑复用 NoteCardShell。拾取 tip/box 使用启动时宿主解析出的具体 overlay palette；取消和清理不改网页作者配色。生成式页面的宿主状态读写与版本更新仍保留。
- **证据与持久化**：config.browser.tabs 保存 URL、activeIdx 与 owner，启动只恢复标签壳；实际页面在前台访问或工具请求时懒挂载。可选回合截图通过 turnShots/turnShotCapture 按会话实际使用 tab 归集，见 [evidence](evidence.md)。

## 关键文件与通道

| 文件 | 职责 |
| --- | --- |
| `src/main/browser/tabs.ts` | 标签壳、guest 注册、首导航、懒挂载、代次、队列、崩溃、弹窗、下载、console/网络、拾取、视口 |
| `src/main/browser/popupPolicy.ts` | window.open 弹窗形态分流纯策略（原生弹窗 vs 内置标签）；手势门控判据 |
| `src/main/browser/guestRegistry.ts` | tabId/webContentsId/generation 的 fail-closed 绑定与 tombstone |
| `src/main/browser/pageOperationQueue.ts` | 每页 FIFO、失败后继续、待执行项取消和开始前身份校验 |
| `src/main/browser/agentTools.ts` | 可信目标解析、Playwright 会话、工具动作与明确能力拒绝 |
| `src/main/browser/semanticActions.ts` | 固定 DOM click/fill/select/scroll 与结构化失败；无原生输入 fallback |
| `src/main/browser/fullPageScreenshot.ts` | 整页截图的视口采集、像素拼接与原文档滚动恢复 |
| `src/main/browser/cdpTypeProxy.ts` | webview→page target 兼容、工具脚本 userGesture:false、原生派发与激活拒绝 |
| `src/main/browser/cdpBoot.ts` / `cdpEndpoint.ts` | 由 Chromium 绑定系统分配的空闲 CDP 端口、启动设置，以及连接前的主窗口 target 身份验证 |
| `src/main/browser/browserRecording.ts` / `webmMuxer.ts` | 有界帧采集、WebCodecs 编码与 WebM 封装 |
| `src/main/ipc/browser.ts` | 用户浏览器 IPC、guest attach/detach、人工露条滚轮、拾取、重试和 CDP 信息 |
| `src/main/capabilities/hosts/browser.ts` / catalog | executor 注册和工具能力描述 |
| `src/main/capabilities/workerBinding.ts` | Bearer/GUI 会话的可信调用归属和私有目标选择 |
| `src/renderer/src/components/BrowserPage.tsx` | 统一内容标签同步、稳定 webview 栈、后台 mount、原生人工交互、露条与备注 |
| `src/renderer/src/components/BrowserHome.tsx` / `BrowserHomeDialogs.tsx` / `BrowserHomeAppearance.tsx` | 新标签页收藏导航、搜索、多选、整理与外观弹窗 |
| `src/renderer/src/browserHomePreferences.ts` / `browserHomeAppearance.ts` / `styles/browser-home.css` | 搜索及外观偏好、壁纸存储与工作台深浅主题、响应式样式 |
| `src/renderer/src/assets/browser-home/brand-orbit-{light,dark}.png` | 随主题明暗切换的内置默认壁纸 |
| `src/shared/browserHome.ts` / `bookmarks.ts` | 内部页身份与共享收藏树修改 |
| `src/renderer/src/styles/browser.css` / `browserPointer.ts` | 网页布局、手势命中层和工作面切屏信号 |
| `src/shared/browser.ts` / `browserPicker.ts` | 共享类型与拾取脚本合同 |
| `src/main/browser/browserHelp.ts` | browser 用法参考目录（R5 后诊断/测试数据） |

主要推送为 `browser:tabs`、`browser:mount-request`、`browser:agentState`、`browser:picked`。渲染层通过 `browser:guest-attach`/`guest-detach` 绑定生命周期，用户 `browser:open` 支持 `newTab`、`background` 与展示归属。偏好水合后缺少原生壳的标签按需调用 `browser:open`，并使用回执绑定确切 ID。撤销关闭则通过 `browser:replay-panel-history` 恢复原生导航栈并绑定回执中的壳。关闭回执携带原生壳 ID 和最后提交的网页位置。内部 `browser:setOwner` 校准右侧标签归属，子页面附带 opener 身份并继承最新范围。`browser:bookmark-favicon` 缓存当前已访问页的图标。用户 open/activate/nav 与工具后台选择分开。旧 `browser:focus-request`/`focus-ack` 保留拒绝回执，不能解锁 Agent 原生输入或触发前台恢复。

## 已知边界

- 坐标点击和拖拽适用于接收合成事件的页面，真实按键、文件选择授权和依赖用户激活的操作仍需人工。CSS `:hover` 可通过 guest 内指针移动触发。
- 不同页面并行不隔离账号和持久存储。用户与 AI 同页编辑也不受工具 FIFO 的事务保护。
- 代理控制的是工具发出的协议命令和手势标志；网页处理器自身的 window.focus、元素 focus、延迟脚本及先前人工激活状态，必须由真实 Electron 前景输入回归验证，不能凭 DOM 单测推断安全。
- 后台保留 DOM 和 CSS 视口不保证 Chromium 一直合成。隐藏网页明确拒绝开始录屏；截图和可见页面录屏仍须验真实光栅与可播放产物，不能将返回 metrics 或存在 guest 当作成功。隐藏的生成部件可能已完成 DOM/状态更新，而渲染回执仍等待合成帧；显示后再确认实际渲染。
- 远程网页 ref 就绪延迟仍需具体样本；不能把无 ref 一律归为 AX 树构建慢。当前诊断保留 tabId、权威 targetId、已发现目标和会话探测错误，不对超时动作盲目重放。
- 应用原始 CDP 端口仅绑定 127.0.0.1，但没有鉴权。本机其它客户端可绕过工具代理，这是既有残余风险；未显式设置 `MUSTER_DEVTOOLS_PORT` 时可用 `browser.cdpEnabled=false` 关闭。默认由 Chromium 以端口 0 原子绑定系统分配的空闲非零端口；未显式启用自动化、headless 或调试管道时禁用 Blink 的 `AutomationControlled` 标志，以保持 `navigator.webdriver=false` 的登录兼容行为，不关闭浏览器自动化能力。浏览器工具从 `DevToolsActivePort` 发现端口并验证当前主窗口的原生 target，旧文件、不可用端点均不可信。环境变量可显式指定 1–65535 的固定端口并优先生效；固定端口被占用时明确报错，不静默切换以免外部客户端连错。代理拒绝策略不代表整个本机 CDP 接口成为安全沙箱。
- 移动端没有浏览器页，web 网关按 `browser:*` 前缀拒绝 invoke。Windows/系统缩放、真实 OS 输入法候选窗及人工系统文件选择仍需相应人工或专项验收。
- 新标签页和收藏文件夹已在 Windows 隔离 Electron 中验证；macOS、Linux 真机尚未验收。旧收藏没有添加时间，界面显示未知，按时间排序时排在有时间的条目之后。
- guest 刚创建即关闭时的 `Invalid guestInstanceId` 是已知 Electron 噪声；对应过滤不豁免其它 renderer 错误。

## 测试与当前验收状态

2026-11-23 在 macOS 27.2.1（26B131）和 Electron 43.7.0 的隔离工作台通过 `test/e2e/browser-background-tools.spec.ts`。覆盖主文档确认和输入弹窗、同源子帧原生确认、后台截图的首屏到页底及横向像素、容器滚动、Canvas 坐标点击、CSS 悬停和前台焦点保留。三个原始问题在修复前的同一夹具中均可复现。Windows 与 Linux（X11、Wayland）的这组场景待真机验证。

2026-11-01：`test/browser-cdp-startup.mjs` 和 `test/e2e/browser-cdp-startup.spec.ts` 覆盖系统分配端口、固定端口冲突、旧端口文件和三个实例并发，以及 Windows 隔离 Electron 与完整工作台中的浏览器工具连接；网页观察到的 `navigator.webdriver` 为 `false`。调整为系统分配端口后的 Google 账号登录和 macOS、Linux 真机尚未验证。

新标签页回归包括 `test/unit/bookmark-tree.spec.ts`、`test/unit/browser-home.spec.tsx`、`test/unit/right-workspace-ui.spec.tsx`、`test/browser-tab-lifecycle.mjs`、`test/browser-config-persistence.mjs` 和 `test/e2e/browser-home.spec.ts`；后者在隔离 Windows Electron 验证文件夹、收藏、图标、标签导航与重启恢复，并在 `output/browser-home/` 留存深浅与窄容器截图。

2026-10-21工具精简回归使用browser.setViewport({reset:true})，真实Windows Electron验证尺寸、草稿和guest身份保持，并完成原生输入/浮层/下载/可播放VP8。首轮录屏回放超时，保留原断言、补播放器状态诊断后复验通过；未修改录屏实现，不据此宣称录像稳定性或其他平台验收。日志：.tmp/host-tools-simplification/cleanup-browser-chat-final.log。

2026-10-14 验收使用 Electron 43.7.0 / Chromium 150.0.7871.250、生产构建、独立 userData、本地 HTTP 和随机端口，不附加用户 dev、不访问外部模型。结果：8 个离线文件通过（含 45 条生命周期与 25 条工具身份回归），4 个组件文件共 28 项通过；后台并行/原生交互两项、崩溃恢复 4 项、工作区/窄屏两项 Electron 场景通过。窄屏裁切修复后，后台并行/原生交互/窄屏三项另以最终样式在 31.8 秒内复核通过。原生交互另在浅色主题完整复测通过，深浅及窄屏截图已查看。node/web/test 类型检查及生产构建通过；未运行全量测试或更新安装版。

核心场景实证包括：实际 guest 类型全部为 webview、每页独立 BrowserWindow 数为 0；A/B 语义动作与宿主地址栏/前景 C 原生键入并发；网站同步/延迟 focus、先前人工激活及当前显示目标均保留前台输入；缺失元素占用 A 队列时 B 仍可执行；失败后队列继续。人工真实原生输入/Unicode 提交/Tab/拖拽/双轴滚轮、设置浮层防穿透、下载落盘通过；可见页面录制 10 帧并由 Chromium video 解码播放，隐藏页明确拒绝录制且保持焦点。证据归档于 `.tmp/native-browser-final/`，浅色场景位于 `.tmp/native-browser-light/`；临时截图与视频不提交。没有用恢复焦点、切前台或原生输入 fallback 掩盖后台动作副作用。

旧夹具的用户开页接口、会话标签作用域、Tooltip 摘 title、露条裁剪坐标和过渡中旧坐标均已按实际 UI 修正；隐藏部件 DOM 已更新与像素渲染回执分开检查。早期其它执行模型的通过记录不能替代上述本轮验收；下表保留对应回归入口。

| 测试 | 本轮覆盖目标 |
| --- | --- |
| `test/browser-cdp-input-policy.mjs` | 禁原生派发/激活、强制 userGesture:false，以及真实 WS 代理不会向上游转发拒绝命令 |
| `test/browser-page-operation-queue.mjs` | 每页 FIFO、跨页并行、失败后继续、关闭/换代待执行取消 |
| `test/browser-agent-tools-identity.mjs` | 权威 targetId、同 URL/伪 marker、可信私有选择、无前台借焦点和动作不重放 |
| `test/browser-tab-lifecycle.mjs` | webview 懒挂载、首导航、guest 绑定与代次、关闭/崩溃/停止生命周期 |
| `test/unit/browser-semantic-actions.spec.ts` | 固定 DOM 动作、合成事件、原生 setter、禁用/不支持目标、无原生 fallback |
| `test/unit/browser-webview-stack.spec.tsx` | 稳定 guest 栈、后台挂载不切选择、显隐与 detach、人工工作面滚轮 |
| `test/unit/browser-background-owner.spec.tsx` | 同会话/跨会话后台开页不改变当前内容、草稿与焦点 |
| `test/e2e/browser-background-parallel.spec.ts` | 真实 Worker token、冷挂载、AB 后台 DOM 动作与宿主/前景 C 原生键入、网站同步/延迟 focus、先人工激活后切走、同页 FIFO、跨页进展、失败恢复、maUi 状态与人工手势门 |
| `test/e2e/browser-execution-preview.spec.ts` | 文件名沿用历史；当前测真实 webview 像素和用户原生输入/Unicode 提交/Tab/拖拽/双轴滚轮、实际重叠浮层、防穿透、视口、下载与可播放录屏 |
| `test/e2e/browser-webview-regression.spec.ts` | 冷启动观察、原生工作面/露条、跨工作区 guest 与草稿/页面内存保留、明确能力拒绝 |
| `test/browser-crash-policy.mjs` / `test/unit/browser-crash-overlay.spec.tsx` / `test/e2e/browser-crash-recovery.spec.ts` | 崩溃退避、上限、错误卡/重试及真实 guest 生命周期与连接恢复 |
| `test/browser-guest-registry.mjs` / `test/browser-viewport-policy.mjs` | 身份注册表与视口边界 |
| `test/browser-recording-policy.mjs` / `test/browser-webm-muxer.mjs` / `test/browser-turn-shot-policy.mjs` | 录屏采集/封装与回合截图归属 |
| `test/unit/browser-picker-appearance.spec.tsx` | 拾取器 tip/box 外观和取消清理；不替代原生页面命中验收 |

旧的浏览器工具全量冒烟已退役并移除：它假定后台原生按键、hover、拖拽、上传和任意 evaluate 可用。现行覆盖由上表中的隔离 Electron E2E 提供；不要沿用旧脚本“所有 browser 工具通过”的结论。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：右侧统一内容标签中的真实 webview 浏览（用户直接用 Chromium）+ AI 经 browser.* 对后台页做固定 DOM 语义操作；AI 不抢前台、不切用户选择、不借用户手势。
- 为什么这样设计：工具 CDP 代理强制 userGesture:false 并拒绝原生 Input/激活命令（语义动作 trusted:false 明示非可信输入，maUi 等需 transient activation 的动作不能被 AI 合成冒充）；不按 URL 猜目标（tabId→guest→CDP targetId 权威绑定）；每页 FIFO 修改队列、崩溃限次退避恢复；persist:browser 共享登录态；人工原生输入不进工具 FIFO。
- 当时的限制包括 AI upload、坐标点击、Canvas 和拖拽；当前提供受控 upload、合成坐标点击和拖拽，以及 guest 内无按键指针移动。人工和 Agent 同页编辑时网页可收到交错事件。移动端暂未提供浏览器页。
- 歧义点：①AI 原生输入能力（坐标点击/上传/键盘）长期以 DOM 语义动作为终点，还是路线图待补受限原生通道？A=长期终点（原生输入与「不授 userGesture」安全模型冲突，缺了报不支持不算执行成功；review 不把 capability_unsupported 当待补）／B=路线图补通道（review 把缺原生输入当待补能力并盯其安全设计）。推荐 A。②工具 CDP 端口仅绑 127.0.0.1 但无鉴权，本机其它客户端可绕过工具代理直接派发原生输入（cdpEnabled=false 可关）——A=接受现状（本机单用户信任边界：能 spawn 进程的本地攻击者本已等同用户权限，review 记 P3 备案）／B=加本地鉴权或改默认关闭。推荐 A，产品若要覆盖不可信同机环境再升 B。


### 扩展导出的交互网页

扩展面板调用 `ma.exports.preview(exportId, name)` 时，主进程核对调用实例、导出 ID、文件名和当前工作区，在右侧浏览器新建工作区标签。浏览器分区专用的 `muster-export://<导出 ID>/<文件名>` 为每份导出提供独立来源，保留键盘、点击与网页本地存储。GET/HEAD 只读取该导出登记过的普通文件，页面没有工作台或扩展 SDK。导出记录随本次运行存在，重启后从扩展重新打开示例。项目 HTML 作品也使用右侧浏览器。作品卡片直接打开，文件编辑器的「浏览器预览」打开已保存版本。
