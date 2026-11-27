---
doc_type: feature
---

# 扩展 Host 与面板实例

`ExtensionHost` 是 package catalog 到扩展面板与 DomainRuntime 的宿主入口。它按 package fingerprint 绑定工作区实例，调用 `ExtensionAgentService.openPanel`。声明 agent 时还会打开绑定到同一实例的 Pi Session。

运行时身份由 `src/main/extensions/extensionLiveBinding.ts` 的 `resolveLiveExtensionBinding` 统一解析。它同时核对当前 workspace/root、`rootsRevision`、catalog fingerprint/enabled、workspace activation、development trust 和 project manifest binding，并返回可在长调用前后复用的 `assertCurrent()`。open、reload、toolbar、host tool 与面板资源校验共享这份合同，避免各入口按不同顺序重复解释同一身份。

## 关键入口

- `src/main/extensions/extensionHost.ts`：catalog 校验、实例身份、打开、domain/SDK call、资源交付和释放。
- src/main/extensions/extensionHostPanelLifecycle.ts：面板父 AbortSignal、流式请求登记及关闭/reload 取消，保证 panel bridge 的请求生命周期只有一个来源。
- src/main/extensions/extensionHostDomainFactories.ts：按 extensionId:fingerprint 保存 DomainRuntime factory 的 unregister 句柄，负责扩展关闭和包替换时的回收。
- `src/main/extensions/extensionHostMedia.ts`：面板文件授权、媒体资产和导出/预览桥接；宿主通过上下文传入 owner、实例存活和 workspace 检查。
- `src/main/extensions/extensionHostTasks.ts`：`tasks.create`、`tasks.open`、`tasks.preview` 和 `tasks.thumbnail` 桥接；宿主通过上下文传入权限、工作区/面板活性、取消信号和当前性检查。
- `src/main/extensions/extensionPackageCatalog.ts`：源码扫描、fingerprint registry 和工作区实例绑定。
- `src/main/extensions/extensionAppSystem.ts`：通用宿主装配、样例安装与 catalog 同步；启动设置 package preparation 屏障，面板 open 等待复制完成，避免绑定半个包。
- `src/main/extensions/extensionAgentService.ts`：Pi Session 和 DomainRuntime 绑定，以及 worker 通用 broker。
- `src/main/ipc/extensions.ts`：`extensions:*` catalog/trust 和 `workbench:*` 面板通道。
- `src/shared/extensions.ts`：`EXTENSION_PANEL_METHODS` 是 preload、web SDK、IPC 和 Host 共用的 typed panel method registry。
- `src/renderer/src/panels/DomainExtensionPanel.tsx`：iframe 资源、SDK 握手及 Pi 会话表面。
- `test/extensions-domain-host.mjs`：包准备屏障、catalog → open → snapshot/query/command → agent release/open → close。

## 生命周期与交互

导航物化全局 sidebar 和当前项目 sidebar 包；toolbar 使用包内 commandEntry，不进入 AI 侧栏导航。底栏 AI 开关只隐藏/显示侧栏，Agent 会话可在后台继续。桌面和网页可以同时持有同一扩展实例的视图，每个视图有独立令牌、事件订阅和请求生命周期。打开、重载和关闭按实例顺序执行。最后一个视图关闭时释放共享 runtime、会话、媒体引用和实例绑定。点击重载会重新发现已安装目录的源码、绑定当前指纹并重建 iframe，即使入口路径和 manifest.version 未变也会重新执行面板脚本。包指纹变化时替换 DomainRuntime。继续声明 agent 的扩展沿用 Pi Session 历史，移除 agent 后释放旧会话并保留历史。

仅当清单声明 agent 时，面板打开才创建无显式模型的隐藏 Pi 会话，模型准入和参数校验延后到实际 AI 回合。默认服务商缺少 API Key 时，面板与不调用模型的 DomainRuntime 功能照常使用；调用模型时由执行入口提示配置问题。创建会话仍检查运行时启用状态、内置进程文件和工作区身份。未声明 agent 的面板可使用同样的领域查询、命令、事件和权限允许的数据与模型桥接，宿主拒绝其 Agent 会话调用。

左右停靠时，面板和 AI 共用一条居中分隔线，10px 热区跨在接缝上。静息线宽 1px，悬停与拖动使用全局的 3px 线宽。左右悬浮 AI 卡片的底边锚定在扩展内容区内，宽高受当前内容区限制，底部状态栏独立可点击。角部拖动只保存偏好宽高；恢复旧布局时忽略历史顶边偏移。

DomainRuntime 事件推给 iframe，事件 topic 等于领域事件 type，不自动写入 Pi 消息或触发模型回合。Agent 需要状态时按需调用 `state.snapshot` 或查询工具。主题、字体和语言通过 appearance 协议推送。

面板 SDK 和隔离 worker 共用权限与实例 owner。文字流式随取消、关闭和重载中断；媒体使用 owner 绑定的 asset ID，关闭撤销 URL，显式 retain 的资产可重新恢复。`ExtensionAgentService.close()` 返回 `Promise<void>`，停止时先停止新请求，再通过 `Promise.allSettled` 等待 MCP、runtime、Pi release、resource mount、DomainRegistry 和子进程回收，聚合关闭错误后返回。`ExtensionHost` 按 extension ID 与 package fingerprint 保存 factory 的 unregister 句柄，close、reload 和 package replacement 都撤销旧注册。详见 [模型与媒体](extension-model-media.md)。

面板资源请求的路径解码失败会以 400 返回，避免畸形 URI 在宿主边界产生未处理异常；解码后的路径仍须位于包根目录内的普通文件。

宿主仍以 `ExtensionHost` 作为唯一公共入口。面板生命周期、Domain factory registry、媒体/导出桥接和任务桥接已提取为无宿主状态的协作模块，桥接分支通过上下文复用权限、实例与 workspace 合同。模型/LLM bridge 继续由 Host 统一做校验，任务桥接的权限、面板活性、取消信号和当前性检查仍由 Host 在调用边界提供。

面板方法必须登记在 `EXTENSION_PANEL_METHODS`。两个 IPC 入口在进入 Host 前复用 `isExtensionPanelMethod` 做形状校验，未知方法会被拒绝。登记表和 Host 回归覆盖 `ui.confirm`、`agent.send`、已知方法和未知域命令。嵌入面板的 `ui.confirm` 由 Renderer 消息桥承载，独立窗口通过同一 Host 方法和父信号派生的请求完成确认。

具备 `hostTools` 权限的扩展还可调用 `ma.tasks.render`/`ma.tasks.validate`。宿主将目标 HTML 打开或复用在内置浏览器标签中，固定视口后按毫秒时间点调用页面的 `window.renderAt(timeMs / 1000)`，由原生 webview debugger 截帧并复用 WebCodecs/WebM 产物链。渲染任务返回 `renderId`/`jobId`，可轮询状态、进度、失败对象和 artifact path，或取消；该路径不启动外置 Chrome、Playwright 或 Python，并在完成或失败后恢复原视口。

面板可调用 `await ma.ui.confirm({ title, detail?, confirmLabel?, cancelLabel?, danger? })`，由 Renderer 消息桥显示宿主 `AppConfirmDialog`，返回布尔值；取消、关闭或重载返回 false。每个面板最多同时一个确认请求，空标题或并发请求报错。它仅供面板交互使用，不经过领域命令或 Worker，也不触发模型回合；沿用宿主焦点、Esc、presence 和主题行为，三平台共用组件。

开发环境启动刷新内置样例。重载时比对启动时的样例指纹：只改仓库样例就同步到安装目录，只改安装目录就直接加载；两处独立修改会报告冲突并保留两份源码。生产环境保留已存在的用户源码；管理页显式安装同样保留已有源码。所有样例走同一个 catalog/Host/DomainRuntime，不保留宿主版本分支。
