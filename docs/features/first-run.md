# 桌面首次设置

## 界面与流程

桌面首次收到空工作区快照时进入独立设置页，配置本机工具、模型和远程访问。页底使用 canvas，带描边的 raised 卡片包住左侧五步进度和右侧当前操作。窄窗口把进度移到内容上方，页面可滚动。连接步骤之间回退保留当前页面的草稿，换步将焦点移到新标题，退出中的内容立即变为 `inert`。最后两步进入真实工作台，中栏说明下一步并高亮对应的常用入口。动效沿用公共 `usePresence`、`mp-panel`、`xfade` 和减少动态效果偏好。

1. **本机工具**。用户主动触发检测，内置 Muster Core 始终可见。检测使用 `runtimes:availability(true)` 刷新现有 PATH 与引擎预检，随后由 `agentSession:listHarnessPickerChoices` 给出产品名称和可选状态。按工具合并对话与终端结果；实际登录由各工具管理。可跳过或重新检测。
2. **连接模型**。从本机模型目录选供应商与模型，也可输入自定义地址、协议、模型 ID 和 API Key。快捷表单支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。先用 `config:testLlm` 探活，成功后通过 `config:update` 把该配置存为 Core 默认模型。失败保留草稿并显示原因，错误回显中的当前 Key 会被遮去。已有配置可直接继续，使用外部工具时可跳过；完整选项在「设置 → 模型与输入」。
3. **远程访问**。按需从 `webAccess:status` 读取推荐地址及二维码，使用现有浏览器网关。扫码或复制地址即可在同网设备打开，网关不可用时显示原因。可稍后前往「设置 → 远程访问」。此步骤只读取连接信息，网关开关、令牌轮换和 Channel 配对各沿用原入口。
4. **工作区**。引导将焦点移到左下角「工作区」标题旁原有的「＋」，以同一套描边标出入口。按钮打开常用的 `CreateWorkspaceModal`，桌面建第一个工作区时预选推荐目录，也可用原生文件夹选择器选已有项目。用户可改名称并点击「创建」。创建沿用 `workspaces:open` 和 Store 激活流程，仅在确认时按需创建推荐目录。回退或重启时可继续使用已建好的工作区。
5. **第一条会话**。引导用描边指向左栏「工作会话」标题原有的「＋」，保留按钮文字、尺寸和常用的 `NewTaskDialog` 表单。窄窗可从中栏提示打开实际左栏，打开后焦点落到「＋」。用户可以在同一个表单发起任务，也可点「新建空白」。创建成功后收起窄窗抽屉，用户可立即在中栏输入。工作台收到可见工作会话快照后结束引导。选择「稍后创建会话」后，中栏显示带继续入口的「继续设置」卡片。第 5 步和这张卡片都可用右上角关闭按钮退出，也可在卡片内按 Esc，关闭后焦点回到工作台。

跳过本机工具、模型或远程访问时，下一步显示可继续操作的位置。工具对应「设置 → Harness 接入 → 引擎配置 → 刷新」，模型对应「设置 → 模型与输入 → 模型服务商」，远程对应「设置 → 远程访问 → 用网址打开」。这些位置清单跟随到工作台的新手卡片，点击直接打开相应设置。主动关闭引导后显示工作台的正常空状态，重启沿用这个选择。需要继续时可使用相同的设置入口和左栏「工作会话」的「＋」。

## 状态与实现

| 入口 | 职责 |
|---|---|
| `src/renderer/src/RootLayout.tsx` | 等待工作区快照，桌面按进度路由到引导、空区恢复或工作台。浏览器、手机和独立扩展窗沿用各自入口。 |
| `src/renderer/src/onboarding/setupProgress.ts` | Electron profile 的 `muster.firstRun.v1` 保存当前步骤、已跳过的步骤和主动关闭状态，兼容旧版单步骤字符串及未记录关闭状态的引导。临时 API Key、二维码及文件夹草稿留在对应页面。写失败即时提示，当前窗口仍可继续。 |
| `src/renderer/src/onboarding/FirstRun.tsx`、`ConnectModel.tsx`、`ConnectRemote.tsx` | 设置页导航、工具检测、模型配置、远程访问，经已有 preload/IPC 提交。 |
| `WorkbenchSetupGuide.tsx`、`ResumeSetupLinks.tsx`、`styles/workbench-setup.css` | 工作台引导卡片、跳过位置和真实按钮高亮。`App` 把状态传给 `AgentFloat` 和 `LeftPanel`，通过日常设置路由跳转。 |
| `WorkspaceSetup.tsx` | 已完成首次设置的桌面用户关闭最后一个工作区时，用于重新建区。 |

已有工作区的旧 profile 直接进工作台并记为完成。完成后关闭最后一个工作区，根布局保留工作台直到主进程的文件视图清理事务收到应答，再进入单独的建区页。再建后直接回工作台。引导沿用现有跨平台引擎预检、Electron 目录选择器和网页网关。浏览器远程连接取决于网关状态和设备的网络可达性。

## 验证入口

`test/unit/first-run.spec.tsx` 覆盖扫描合并、步骤焦点、安全回显、跳过位置、设置跳转和关闭引导。`test/unit/workspace-onboarding.spec.tsx` 与 `test/unit/new-task-source.spec.tsx` 覆盖工作台的两种新建表单。`test/e2e/zero-workspace-onboarding.spec.ts` 从隔离的零工作区产品配置启动真实 Electron，使用本地测试模型和网页网关检查验证请求、设置跳转、宽窄窗的实际新建按钮、重启续办、关闭引导后重启进入正常工作台、窄窗建会话后直接点击输入框收发消息及关闭最后一个工作区后的入口。验收首装时使用正式数据路径的临时重定向，开发沙盒自带演示工作区。

相关实现：[工作区管理](workspaces.md) · [模型服务商](model-providers.md) · [运行时注册](agent-runtime-registration.md) · [网页访问](web-access.md) · [会话模型](session-model.md)
