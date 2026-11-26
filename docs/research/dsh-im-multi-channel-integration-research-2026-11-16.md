# dsh-im 多渠道接入方式与本仓移植可行性调研

调研日期为 2026-11-16。外部代码取自 `xmanrui/dsh-im` 的提交 `fc2ceab217309f8973afa03c58cdd8ff3e900130`，对应仓库版本 `5.10.0`。本次只做源码和本仓结构研究，没有修改业务代码，也没有使用真实机器人账号做连通性验收。

## 结论

可以直接搬的代码确实不少。需要区分“代码文件可以带走”和“插件可以原样运行”这两件事。前者可行范围较大，后者仍然受 DSH Host 合同限制。

`dsh-im` 的多渠道能力建立在 DeepSeek Harness 自己的 Host 服务上。插件通过 `sessionController`、`workspaceController`、`sessions`、`tools`、`systemPrompt` 和 `webServer` 等注入服务，把不同 IM 平台接到同一套 Harness 会话模型。我们当前只有飞书远程桥，业务逻辑直接绑定 `FeishuBridge`、`lark-cli`、编排事件、卡片和设置 IPC，没有等价的通用入站消息路由层。因此“复制模块并替换宿主接口”是可行路线，“不改接口直接运行”仍不可行。

源码快照中 `src/channels/shared/` 有 143 个文件。粗略静态检查显示只有少数文件直接依赖 `harness-client.mjs` 或 DSH Host 注入名，大量队列、状态、配置、去重、错误诊断、命令解析、消息切分和权限模块可以作为代码基线带走。需要注意的是，未直接 import Harness 的模块仍可能通过参数调用 DSH 会话方法，所以最终仍要经过接口适配和定向测试。

最值得采用的方向是新增宿主拥有的多渠道消息层。它负责长期运行、凭据引用、连接监督、消息去重、会话绑定和统一投递。每个平台只实现一个适配器。扩展系统可以承载设置页面和渠道展示，暂时不适合作为唯一的常驻 IM 运行时。

## 外部项目定位

DeepSeek Harness 官方页面将插件描述为扩展工具、技能和界面的机制。`dsh-im` 是社区维护的插件，不是本仓的官方依赖。插件 README 声明可接入飞书、微信、企业微信、钉钉、QQ、Slack、Telegram、Discord、WhatsApp、iMessage、Matrix 和邮箱等渠道，并明确表示新的 IM 平台可以沿用同一渠道适配器结构。

源码将插件拆成 Host 侧和 Client 侧。Host 侧负责真实连接、凭据、会话和消息投递，Client 侧负责设置页和浏览器交互。Host 插件在初始化时为所有渠道挂载管理 RPC，再并发启动各渠道。单个渠道失败不会阻断其他渠道，管理路由仍会返回初始化中或启动失败的结构化状态。

## dsh-im 的接入方法

### 1. 每个渠道都有相同的六层结构

| 层 | dsh-im 的职责 | 可借鉴点 |
|---|---|---|
| 渠道描述 | 提供渠道 key、名称、连接方式、反应符号和能力信息 | 用稳定的 `ChannelDescriptor` 让公共逻辑不判断平台名称 |
| 平台适配器 | 调用平台 API、长连接、轮询、扫码或本机协议 | 每个平台只处理自己的认证、收发和平台错误 |
| 入站归一化 | 将原始事件转换成统一消息 | 统一消息 ID、发送者、私聊或群聊、正文、附件、回复关系、是否被 @ |
| 出站客户端 | 文本、图片、文件、卡片、编辑、输入中状态和反应 | 公共桥只依赖能力接口，平台不支持时显式降级 |
| 会话桥 | 权限、命令、工作区、Session、审批、问题回答、流式回复 | `TextHarnessBridge` 是主要复用单元 |
| 状态与控制器 | 游标、去重、待投递消息、会话绑定、机器人增删改、重连和状态 | 将账号管理和消息处理从具体传输中分离 |

Telegram 是最清楚的示例。`telegram-runtime.mjs` 负责 Bot API 长轮询和生命周期，`telegram-bridge.mjs` 负责事件归一化、按钮回调和平台呈现，`TelegramHarnessBridge` 只补充渠道描述和卡片实现，实际文本处理复用 `TextHarnessBridge`。

### 2. 入站消息先归一化，再进入统一桥

Telegram 的归一化结果包含以下类型的信息。

- `messageId`、`senderId`、是否机器人
- `kind`，区分私聊和群聊
- `conversationId`、回复目标和上下文来源
- `content`、`plainText`、图片、文件、语音
- 是否被 @、反应目标、连接测试目标

统一桥收到归一化消息后，再做访问策略、命令识别、群聊触发判断、重复消息检查、每会话排队、Session 选择、审批和问题回答。这样新增平台时，不需要重新实现工作区切换、`/new`、`/session`、审批和文件回传等业务逻辑。

### 3. 出站能力通过接口注入

`TextHarnessBridge` 不直接调用 Telegram 或 Slack API。它依赖渠道客户端提供的文本、卡片、文件、图片、编辑、输入中状态、反应和流式更新能力。平台能力不足时，桥会退回普通文本或最终答案。

这层还处理长消息切分、发送结果未知、附件大小、平台权限拒绝和重复发送风险。它把平台差异收口在客户端能力和错误映射里，没有把差异扩散到会话逻辑。

### 4. 凭据、配置和运行状态分开

`TokenBotConfigStore` 只保存版本化的机器人配置、平台身份和凭据引用。Token 本身交给凭据提供器保存。机器人 ID 和凭据引用由平台身份的哈希派生，避免把原始身份放入公开配置或 RPC 返回值。

每个渠道和每个机器人都有独立状态文件。会话状态包含已见消息、游标、聊天到 Session 的绑定、作者信息、待处理消息和延迟投递信息。配置写入使用临时文件加原子改名，并通过写入队列避免并发覆盖。

### 5. 控制器负责账号生命周期

`TokenBotController` 把绑定凭据、检查身份、连接、重连、修改机器人设置、发送测试消息、主动发消息和删除机器人统一成控制器动作。每个机器人有自己的状态和转移队列，避免重连、修改配置和删除操作同时作用于同一运行时。

管理 RPC 在初始化前就注册，公开错误会经过脱敏和统一映射。这样设置页即使某个平台启动失败，也能显示可操作的失败状态和重试入口。

### 6. 常驻连接由生产组装器和监督器托管

`installProductionChannel` 先注册管理 RPC，再创建配置存储、状态存储、Harness 客户端、控制器、运行时和投递适配器。运行时启动失败会报告诊断并清理已经创建的对象。

连接监督器负责重试、健康状态和关闭。所有渠道一起启动，但采用失败隔离。关闭时先停止平台流，再等待会话桥、消息队列和投递任务收口。

## 和本仓现状的对照

### 已有的可复用基础

本仓并非没有常驻服务能力。`agentApps` 已经有 Runtime Kernel 归属的 service worker、凭据代理、SQLite 状态、连接器和关闭等待机制。`registerRuntimeDomains.ts` 也已经把 `feishu-bridge` 作为有生命周期的运行时域启动和关闭。

现有飞书远程桥已经覆盖了很多可靠性问题，包括事件流重连、去重、卡片回调、消息发送链、编排事件转发、迟到回调、真实子进程关闭和失败重试。这些可以作为第一个渠道适配器的行为基线。

### 当前耦合点

现有 `FeishuBridge` 仍然是飞书专用的组装壳。它同时持有以下职责。

- `lark-cli` 子进程和 Feishu 事件流
- 飞书扫码、绑定码和凭据状态
- 飞书文本命令和卡片回调
- 当前工作区、绑定用户和会话映射
- 编排器事件、通知总线和 GUI 推送
- Feishu 卡片、CardKit、图片和文本降级
- Feishu 专用 IPC 与设置状态

因此目前没有一个可供 Telegram、Slack 或 Discord 直接复用的 `InboundMessage → ConversationRouter → OutboundDelivery` 合同。把 `FeishuBridge` 复制成 `TelegramBridge` 会复制会话逻辑和生命周期风险，不能达到 dsh-im 的复用效果。

### 扩展系统的边界

当前扩展清单支持 sidebar、toolbar、DomainRuntime、Agent 和受权限保护的宿主工具。DomainRuntime 和 toolbar command 在独立 Node worker 中运行，拥有本机 Node 能力，但它仍然绑定扩展实例和面板生命周期。清单没有常驻后台服务、消息接收订阅、凭据引用、连接监督或入站消息路由的一级契约。

这意味着扩展可以很好地承载渠道设置页、机器人卡片、诊断视图和手动操作，也可以在未来承载经过宿主授权的渠道适配包。仅靠打开一个扩展面板来维持 IM 连接会使“关闭面板是否断线”“应用重启如何恢复”“凭据和状态归属谁”等问题变得不稳定。常驻连接应由宿主运行时或类似 `agentApps` 的服务 worker 托管，再通过 RPC 提供给扩展页面。

## 可移植范围判断

### 可以直接搬或小幅改名的部分

- 渠道描述和能力声明
- 原始平台事件到统一消息的纯归一化函数
- 统一出站客户端接口
- 每会话队列、去重、游标和待处理消息状态
- 凭据引用与公开配置分离
- 机器人控制器和重连监督器
- 先挂载管理 RPC、再异步初始化的错误模型
- 公共会话桥与平台专用卡片适配
- 按渠道隔离启动失败和关闭清理

其中最接近“原样搬运”的是 `conversation-queue.mjs`、`conversation-state-store.mjs`、`token-config-store.mjs`、`connection-error.mjs`、`diagnostic-details.mjs`、`inbound-access.mjs`、`markdown-chunks.mjs`、`session-ring.mjs`、`send-limit.mjs` 和一批纯函数命令模块。`conversation-queue`、`conversation-state-store` 和 `token-config-store` 可以先作为本仓公共底座评估，其他模块按我们已有的会话、凭据和错误类型替换边界。

`TextHarnessBridge` 也不是只能参考思路。它的队列、命令分派、重复消息处理、附件降级和交互等待逻辑有较高复用价值。真正需要替换的是它调用的 Harness 会话、工作区、审批和消息投递接口。

### 不适合直接复制的部分

- `TextHarnessBridge` 内部依赖 DSH 的 `sessionController`、`workspaceController`、Harness HTTP/RPC 和 DSH Session 数据模型
- dsh-im 的插件注入、Cordis 生命周期和管理 RPC 不是本仓的 IPC 或 Runtime Domain 合同
- dsh-im 的 `deliveryService`、主动投递和跨 Host 同步依赖 DSH 自己的 Session 事件模型
- 各平台 SDK、扫码协议和第三方库需要单独做许可证、更新频率、网络代理和平台政策评估
- WhatsApp、微信、iMessage 这类渠道的登录状态或本机应用依赖不能假设在 Windows、macOS、Linux 上一致

### 可行性分级

| 路线 | 判断 | 原因 |
|---|---|---|
| 直接把 dsh-im 作为本仓插件运行 | 低 | 运行时、会话服务、RPC 和配置生命周期都依赖 DSH Host |
| 只复制各平台 API 客户端 | 中 | 可复用部分网络和事件解析代码，但仍需重做凭据、状态、错误和生命周期接线 |
| 复制“归一化适配器 + 公共会话桥 + 控制器”设计 | 高 | 和本仓的 Runtime Kernel、FeishuBridge、agentApps service worker 方向兼容 |
| 把所有渠道都做成普通扩展 | 中低 | UI 适合扩展，常驻连接和凭据生命周期缺少宿主一级能力 |

## 建议的目标形态

这里的建议只描述实施顺序，不代表本次已经实施。

### 阶段一，先定义宿主级通用合同

先把以下对象作为内部设计合同，不急着做外部平台数量。

- `MessagingChannelDescriptor`
- `NormalizedInboundMessage`
- `ChannelDeliveryClient`
- `ConversationStateStore`
- `ChannelAccountController`
- `ConversationRouter`
- `ConnectionSupervisor`

合同需要明确消息幂等键、会话键、群聊触发规则、附件引用、发送结果未知、重连期间的消息处理、关闭等待和权限错误。

### 阶段二，把现有飞书桥变成第一个适配器

保留现有飞书行为，把 `lark-cli` 和卡片能力放进 Feishu 适配器，把会话绑定、命令、状态、投递和生命周期中与平台无关的部分移到公共层。这样可以用已有飞书单测和生命周期测试证明抽取没有改变现有行为。

飞书 App 机器人和 `agentApps` 手机机器人仍需保持不同的凭据、事件流和数据边界。它们都可以使用同一套平台适配器底层，但不能共用一个消费流实例或默认绑定。

### 阶段三，加入一个简单的 Token Bot 渠道

Telegram 的 Bot API 长轮询适合作为第一条新渠道验证公共合同。它不要求桌面端扫码或本机应用登录，入站事件、按钮回调、文件和长消息边界也足够覆盖公共层的主要能力。Slack 和 Discord 可以作为第二批，分别验证双 Token、Socket Mode、Gateway、线程和平台权限。

钉钉、企业微信、QQ、微信应在公共合同稳定后接入。它们的扫码、应用审核、事件签名、回调地址、企业权限或第三方协议会增加接入状态和部署差异。

### 阶段四，最后补充渠道特性

先保证文本私聊、群聊触发、Session 绑定、重连和错误诊断，再逐项加入卡片、流式编辑、反应、语音、图片、文件、审批和主动投递。公共层只声明能力，渠道适配器负责呈现和降级。

## 跨平台边界

- Telegram、Slack、Discord 等 HTTPS、WebSocket 或长轮询连接本身可以共用 Windows、macOS、Linux 的 Node 实现，但代理、证书、系统凭据存储和防火墙仍要分别验证。
- 飞书当前使用 `lark-cli` 子进程，迁移时必须保留三个平台的进程关闭、路径、环境变量和代理行为，不能把 Windows 子进程表现当成完整验收。
- iMessage 依赖 macOS Messages.app，不应作为跨平台渠道的基线。
- 微信和 WhatsApp 的扫码或本机会话可能依赖特定客户端、浏览器或第三方协议，需单独标明平台和账号风险。
- Linux 桌面输入和窗口自动化不是多渠道消息层的通用依赖，不能把 X11 或 Wayland 的差异隐藏在渠道适配器里。

## 风险和待决策问题

- 渠道连接是全局级、工作区级，还是每个工作区各自拥有机器人和会话映射
- 一个机器人是否允许切换多个工作区，切换时是否只清理会话映射
- 消息来源如何绑定到本仓的 Agent Session 和当前用户权限
- 审批、问题回答和工具确认是否允许在 IM 侧完成
- 是否需要双向同步本地 UI 回合，以及如何避免回环和重复投递
- 原始平台身份、群成员、附件和群历史需要保留到什么粒度
- 第三方 SDK 的许可证、供应链更新和平台政策是否接受
- 凭据是否统一进入本仓安全存储，还是保留平台 CLI 的 profile 管理

这些问题会影响公共合同，应该在开始接入第二个平台前确定。

## 证据边界

本次结论基于 `dsh-im` 源码静态阅读、其 README 和本仓现有实现文档。没有用真实 DSH Host 启动插件，没有绑定 Telegram、Slack 或其他外部机器人，也没有进行 macOS、Linux 真机验证。外部项目会继续变化，后续实施前应重新核对兼容版本、平台 SDK 和许可证。

## 参考资料

- [DeepSeek Harness 官方页面](https://deepseek.com/en/harness/)
- [xmanrui/dsh-im GitHub 仓库](https://github.com/xmanrui/dsh-im)
- [dsh-im Host 插件入口](https://github.com/xmanrui/dsh-im/blob/fc2ceab217309f8973afa03c58cdd8ff3e900130/plugin-src/host/index.mjs)
- [dsh-im 公共文本会话桥](https://github.com/xmanrui/dsh-im/blob/fc2ceab217309f8973afa03c58cdd8ff3e900130/src/channels/shared/text-harness-bridge.mjs)
- [dsh-im TokenBot 配置存储](https://github.com/xmanrui/dsh-im/blob/fc2ceab217309f8973afa03c58cdd8ff3e900130/src/channels/shared/token-config-store.mjs)
- [dsh-im Telegram 渠道适配](https://github.com/xmanrui/dsh-im/tree/fc2ceab217309f8973afa03c58cdd8ff3e900130/src/channels/telegram)
- [本仓飞书远程桥](../features/feishu-remote-bridge.md)
- [本仓 Agent Apps](../features/agent-apps.md)
- [本仓扩展系统](../features/extensions.md)
