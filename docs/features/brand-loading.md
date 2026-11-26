# 品牌加载动效

基于 design/icon-proposal/final.svg 的中心圆、环轨和三颗卫星，移除背景方砖与彩色卫星。SVG + CSS，全部 currentColor；运行按钮使用中性前景/交互背景，不跟工作区强调色染色。

## 文件与状态流

- components/BrandLoader.tsx：24px 控件；88px 启动标记的组件形态（BrandBootLoader）仅被测试夹具/单测消费，**生产启动遮罩实为 index.html 内联的等构 SVG 副本**——两份 88px 几何手工同步、无一致性守卫（boot-continuity 断言的是跨挂载 Animation 对象不变，不比对两份 SVG 相同），改任一份的几何/配色必须同步另一份。
- styles/brand-loading.css：环绕和呼吸，仅 transform/opacity；复用 --dur-breath、--ease-loop，用户/系统减少动态时静止。
- index.html：bootWait 前静态 SVG（88px 启动标记的生产实现，与 BrandLoader.tsx 的 orbit SVG **双副本等构维护**），读取已存前景色和减少动态偏好。启动节点 #boot-overlay 位于 #root 外，React 挂载与懒分包等待不替换节点。RootLayout 的 Suspense fallback 为 null，内部 BootReady 在真实树提交后移除遮罩；启动失败页和根 ErrorBoundary 同样清理。
- theme.ts：启动主题缓存包含 --fg-primary。
- ComposerSendButtons：useComposerSubmit.submitting 在 onSend 等待期间显示加载按钮；接口完成即结束，busy 回合恢复静态停止按钮；发送确认中阻止重复提交。不新增 IPC、不增加最短展示时间。

## 场景与边界

| 场景 | 入口与等待边界 | 反馈位置 |
|---|---|---|
| 冷启动 / 懒分包 | index.html / RootLayout / SideToolsPanel；真实主界面提交后结束 | 中央标记 |
| 消息发送 / 冷连接 | useComposerSubmit 的 onSend Promise；接收、拒绝、异常均结束，不等回合结束 | 发送按钮圆形核心 |
| 新建会话 / Worker 预检 | NewTaskDialog 的 busy / availability.loading，已排队不再转 | 创建操作区一处 |
| 文件树 | loadingDirs 非空；目录响应 finally 清理 | 每棵树刷新入口一处，目录行不旋转 |
| 文件读取 / 保存 | FileEditor 的 loading / saving | 位置栏 / 保存操作入口 |
| 文档解析 | FileDocPreview 的 loading | 当前解析内容区 |
| 图片 / 音视频 / PDF | FileMediaPreview；load / loadedmetadata / error / stat 失败 | 当前文件一处 |
| Diff / 采纳 Diff / 回合 Diff | FileDiffView / AdoptDiffView / TurnDiffView 的读取状态 | 一个中号标记，替换多行闪动骨架 |
| 聊天历史首次读取 | 两种 surface 的历史 IPC；成功或失败停止，已有正文的后台同步不转 | 转录上方一处，错误保留 |
| Git 列表 / 状态 / 历史 | RepoListPane / DetailPane / GitHistory | 刷新入口或区域顶部一处 |
| Git Fetch / Pull / Push | GitRemoteFeedback 的 snapshot.running | 共用同步反馈行，结果回执保留 |
| 分支切换 / worktree | GitBranchPopover 的 busy / wtBusy | 分支菜单内一处 |
| Git 提交 | CommitBar 的实际 onCommit Promise | 提交按钮；共享 busy 禁用不产生假动效 |
| 模型目录刷新 | ComposerModelCluster → surface → catalog IPC 的 Promise | 被点击的刷新按钮 |
| 模型连通性测试 | ModelProviderPane 的 provider.testing | 当前服务商测试按钮 |
| 设置保存 | SettingsModal 的 saving | 当前保存入口 |
| 本机存储扫描 | LocalStoragePane 用户手动扫描的请求；成功或失败结束 | 存储内容区一处 |
| 扩展安装/更新/回退/卸载 | ExtensionsManagerPanel 的 busyId；finally 结束 | 管理工具栏一处，不给每行旋转 |
| 扩展面板启动 | ExtensionPanel 的核验请求、iframe load/ready 或错误 | 当前面板一处；独立窗口/隐藏面板不加页面加载提示 |

`BrandLoading` 提供中性前景色和文字，`OperationButton` 对当前点击的 Promise 加锁并在 finally 收起；异常显式展示。不要以按钮 disabled 或模型 busy 推导加载。发送确认表示发送通道接受，不是远端模型已读；发送失败保留草稿，静态停止按钮保留。

密集会话行/看板保留业务状态图标；可测量上传/下载保留百分比/进度条。发送按钮加载态禁止继承背景 transition，避免刚发送的首帧带出强调色。所有循环遵守系统/用户减少动态偏好。

## 验证

定向组件用例覆盖请求完成/失败收口、重复点击防护、目录刷新、扩展核验与页面加载、历史请求、媒体读取、新建会话、Git 反馈、保存和发送。Chromium 生产组件夹具在 light/dark × 780/390 下检查发送确认、操作等待、Diff 与 reduced 状态；单独断言发送加载第一帧中性背景。IPC 使用 mock，尚未据此宣称真实 Electron 冷启动或真实模型/远端服务端到端验收。

启动连续性回归：boot-continuity.spec.tsx 使用真实 RootLayout 与延迟 App 验证同一节点保留，失败页/渲染错误解除遮罩；Chromium 夹具验证跨挂载 Animation 对象不变、currentTime 递增。真实 Electron 冷启动仍需重启验收。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D07.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：全应用统一的品牌加载动效（24px 控件/88px 启动标记）：冷启动 bootWait、发送等待、新建会话预检、文件/Git/扩展/模型/设置等约 18 类等待位各一处。
- 为什么这样设计：SVG+CSS 全 currentColor、仅 transform/opacity、复用 --dur-breath/--ease-loop、reduced-motion 静止；启动节点 #boot-overlay 在 #root 外跨 React 挂载保留（连续性有专门回归）；纪律=「不要以按钮 disabled 或模型 busy 推导加载」——每个场景绑定真实 Promise/请求态，异常显式展示；发送确认=通道受理不是模型已读，失败保留草稿。
- 明确不做：不增加最短展示时间；不给每行/每目录旋转（每区域一处）；密集会话行/看板保留业务状态图标；可测量上传/下载保留百分比进度条；不据此宣称真实 Electron 冷启动验收。
- 歧义点：无真决策（等待位语义与边界逐场景成表，均为纪律性约定）。
