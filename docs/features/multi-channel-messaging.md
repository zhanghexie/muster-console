# 多渠道消息接入

设置、手机与远程输入共用主进程的 Channel 服务。

## 职责和范围

「设置 → Channels」全局管理 Channel、账号和来源。一个 Channel 可以组合不同账号、平台、对话或线程，每个来源可设为只读或可回复，并覆盖汇总、立即或静默通知。连接账号入口管理飞书、微信、钉钉、企业微信智能机器人、企业微信自建应用、QQ、Slack、Telegram、Discord、WhatsApp、iMessage、邮箱和 Matrix。同一已连接来源可加入多个 Channel。各工作区在调度 Agent 的手机 Channel 应用选择「绑定 Channel」，再读取、处理、回复和单来源发送。设置里的「远程输入」为指定来源启用全局接入，操作者从该对话配对后在聊天内选择工作区与工作台会话。[手机应用](agent-apps.md) [旧飞书桥退役](feishu-remote-bridge.md)

AI Office 单列为独立任务连接器。邮箱支持普通收发，远程输入要求平台能证明操作者身份。渠道连接由主进程持有，关闭设置页后继续工作。

平台协议、认证和消息桥一次性引入自 dsh-im 5.10.0 的固定提交。Muster 在 Channels 源码目录维护这份副本，并提供真实会话、凭据、管理 IPC、生命周期及界面外壳。来源和本地补丁见 [dsh-im 来源与补丁](../../src/main/messaging/dsh-im/PATCHES.md)。可配置、代码路径通过、真实账号通过是不同状态，不以空账号启动测试代替收发验收。

## 关键文件

| 文件 | 职责 |
| --- | --- |
| `src/main/messaging/messagingHost.ts` | 装配 13 个渠道与 Office，注册进程内账号管理处理器，跟踪连接和在途请求 |
| `src/main/messaging/logicalChannelService.ts` / `state/logicalChannelStore.ts` | 全局目录、发现来源、工作区绑定和独立消息状态、发送回执、远程来源授权、阶段诊断与 SQLite 生命周期 |
| `src/main/feishu/consumerArbiter.ts` / `src/main/messaging/imapConsumerArbiter.ts` | 以平台登录身份仲裁宿主管理的飞书和标准邮箱消费者 |
| `src/main/messaging/dsh-im/channel-runtime.mjs` / `logical-delivery.mjs` | 复用已连接的平台运行时，归一化入站事件，发送到已发现来源或原线程，Office 使用独立任务 Harness |
| `src/main/messaging/dsh-im/src/channels/` | 平台客户端、运行时、账号控制器、消息桥、访问控制和持久状态 |
| `src/main/messaging/remoteBindingService.ts` | 桌面六位码授权、账号/发送者/聊天/线程隔离、原子持久化、解绑取消与首次消息指引 |
| `src/main/messaging/workbenchBridge.ts` | 飞书命令语义、工作区/调度会话/工作会话选择、精确远端回合回传 |
| `src/main/messaging/sessionHost.ts` | 仅 AI Office 独立任务使用的专属 Pi Session 适配；普通 IM 不使用 |
| `src/main/messaging/sessionAuthority.ts` | 宿主持有的账号所有权与稳定消息/回合身份 |
| `src/main/agentSession/host/messagingInput.ts` | 已绑定现有 GUI 会话的字面输入，以及 Office 专属输入的持久回执和精确回合身份 |
| `src/main/messaging/sessionAttachments.ts` | 平台文件/图片的有界读取、检查与会话附件准备 |
| `src/main/messaging/sessionArtifacts.ts` | 只回传本回合实际改写且最终回答明确链接的结果文件 |
| `src/main/messaging/credentialStore.ts` | safeStorage 密文引用、原子写入与损坏/版本保护 |
| `src/main/ipc/messaging.ts` / `src/preload/index.ts` | 桌面管理桥与实际请求取消 |
| `src/renderer/src/components/settings/ChannelsSettingsPanel.tsx` / `ChannelAccountsPanel.tsx` / `ChannelRemoteInput.tsx` | 全局 Channel、账号连接、来源授权、远程配对和阶段诊断 |
| `src/main/messaging/dsh-im/adapters/client/channel-account-settings.js` | 各平台的账号连接、修改、测试与移除界面 |
| `scripts/build-messaging.mjs` / `electron.vite.config.ts` | 独立 ESM bundle、动态渠道 chunks、SDK 兼容与许可产物 |

## 数据流

1. 平台适配器将普通 IM 的认证事件经 `receiveChannelMessage` 和账号代际校验交给 `LogicalChannelService.receive`。先在目标直接对话发一条消息，或在群聊 @ 机器人，回到 Channels 即可选择发现的来源。尚未加入 Channel 的来源只保存发现元数据。已授权的来源按各平台事件能力收件，同时保留平台、账号、对话、线程和真实消息引用。群内遥控仍须明确 @ 机器人；平台确认是机器人的输入不会被接收。
2. 在「远程输入」为所选来源启用接入并生成六位绑定码。授权人须在 10 分钟内到该聊天发送数字或「接入 123456」，群聊须 @ 机器人。来源和操作者身份使用平台认证数据，并以实际发送者绑定。其他对话、线程和群成员需要另外授权。新码替换旧码，使用一次后删除；十次错误尝试后须重新生成。工作区在手机绑定 Channel 的收件和通知权限独立于远程授权。
3. 授权文字进入 `WorkbenchMessagingHost`。首次路由使用桌面当前工作区，之后可用 `/ws` 切换工作区、`/s` 列出和切换该区的调度会话、`/ts` 查看工作会话、`/bind` 选择已有 GUI 或 PTY、`/unbind` 返回调度。工作区和工作会话选择按来源、发送者和授权代际隔离，重启后重新从桌面当前工作区开始。`/s` 使用工作区共享的调度会话，显式选择后来被更改时提示重选。选中的工作区或会话失效时也提示重选。`/status` 查询状态，`/stop` 停止当前授权持有的远程请求。
4. 调度使用 `orchestrator.sendWorkbenchRemote`，GUI 使用 `sendWorkbenchRemoteInput`，均保留字面输入和精确请求/assistant 身份，不展开本地 slash 模板、不授予桌面或记忆直写权限。模型、思考强度和目录沿用目标会话。PTY 经现有跨平台 `terminal.write` 输入，再从本次输出游标取得本地截图/文本。
5. 手机回复从已存消息回查原来源与线程，主动发送使用明确选择的一个来源。微信要求该联系人的有效上下文令牌。原线程证据缺失或发送条件失效时，返回原因供核查；外部网络提交中断标记为结果未知，同一发送请求不会自动重投。远程结果返回触发该请求的对话，诊断记录收到、授权、路由、回复及错误阶段。暂停、解绑和移除会终止该授权尚未提交的操作，已提交给平台或 PTY 的动作保留其实际状态。

来源、全局 Channel、工作区绑定、消息和外发收据保存在 `logical-channels.sqlite`。同一工作区的多个 Channel 引用同一来源时，共享入站的已读和处理状态。各工作区分别维护已读、处理和通知。数据库 v1 → v2 把原工作区 Channel 加入全局目录并保留原所属区绑定、消息状态及回执。v3 增加绑定时间、来源加入时间及旧来源通知引用。原来源的远程授权继续识别原操作者，聊天内可选择工作台目标。移除传输账号会退役来源和远程授权，保留历史。远程绑定另存 `remote-bindings.json`，临时码只在内存。执行前保存消息身份哈希，该远程回执保留 30 天，最多 20,000 条。存储损坏、版本未知或回执写入失败会拒绝新操作并保留原件。

本轮工作台路径以文字遥控与 PTY 截图为验收范围；上游富媒体、互动卡片、远端审批/提问和 Office 专属附件能力不能据此视为新工作台路径已完成。`sessionAttachments`/`sessionArtifacts` 仍服务 Office 独立任务：结果文件只允许本回合真实改写且回答明确链接的文件，按路径、文件身份和大小检查后发送。不能把旧专属 Session 测试当作普通 IM 遥控的验收证据。

## 配置、凭据和管理 IPC

生产数据根为 `StorageRootResolver.resolve('app', 'messaging')`；各渠道在其下 `integrations/dsh-<channel>` 保存账号与状态，宿主显式指定 `storageRoot`。现有账号目录与 `DSH_*_TOKEN_*` 等凭据引用继续按原格式读取。旧飞书凭据由原有连接器持有。

`credentials.json` 保存版本化密文映射，配置仅保存引用。Electron safeStorage 根据系统提供 Windows 用户保护、macOS 钥匙串或 Linux secret service。Linux 的 `basic_text`/未知后端拒绝存密钥；密钥环不可用或密文解密失败有操作提示，不回退明文。坏文件、未知版本、写入失败保留原件和已提交值。

- `messaging:status` 返回渠道目录、平台支持及初始化状态。
- `messaging:call(channel, method, payload, requestId)` 调用进程内管理路由。`channels` 下 `list/get/create/update/remove`、`sources.*`、`diagnostics` 和 `remote.*` 是全局设置。`bindings.list/add/remove` 指定工作区。平台名处理该平台账号。
- `messaging:cancel(requestId)` 仅取消当前桌面调用者拥有的请求，AbortSignal 传到实际管理操作。

管理只接受桌面主 Frame，网页访问策略拒绝整个 `messaging:` 前缀。请求限制 2 Mi 字符及 64 个在途操作，取消或失败返回脱敏错误。账号表单只在显式登录流程接收凭据或二维码。`remote.status/begin/revoke` 核对 Channel、来源和当前远程授权，生成码前还检查来源是否在线。账号在线及操作者获授权分别呈现。

账号页由 `ChannelsSettingsPanel` 按需挂载，复用 `CustomSelect` 选择服务。账号管理经 `messaging:call` 直接调用平台处理器。普通 IM 使用同进程的 Channel 收件入口，平台重连直接检查各自的连接。远程配对在 Channel 来源下办理，模型、目录和预设由工作台会话承担。已落盘的远程授权继续按原账号与来源读取。撤销账号会使旧入站和回复的账号代际失效。

## 生命周期

主进程在 Session 服务完成创建后构造 MessagingHost、RemoteBindingService、WorkbenchMessagingHost 和仅 Office 使用的 SessionHost。`messaging-channels` 域持有释放屏障，`messaging-admission` 依赖 `gui-sessions` 并启动连接。退出和回滚先停止新消息、管理请求与重连准入，再关闭 Session，最后释放渠道句柄。root scope 提供构造期失败和关闭失败重试兜底。

平台初始化异步执行，单渠道失败不会回滚整个应用。连接和恢复重试由平台 Runtime 管理；不叠加第二套重连。关闭等待包括已接受的远端处理、进度回信与最终回信，不能靠界面关闭假定结束。各原生 SDK 的真实网络关闭仍须逐平台账号验证。结果未知的请求不自动重投有副作用的任务，用户需在工作台核对。

## 平台和兼容边界

- iMessage 仅 macOS，使用信息 App、消息数据库及 AppleScript，需要完整磁盘访问和自动化权限。发送带 `🤖 Muster` 标记，接收同时过滤新标记与此前发送的 `🤖 DSH`，避免自聊回声。Windows 和 Linux 显示平台限制。
- QQ 手动 AppID/Secret 使用正式 SDK。扫码组件 `@tencent-connect/qqbot-connector@1.2.0` 的元数据为 UNLICENSED，不随产品分发；缺失时显示自行安装官方组件的指引。
- WhatsApp 使用上游 Baileys 的 linked-device 接入。Matrix E2EE 保留上游实验边界，Olm WASM 随运行依赖加载。邮箱按上游条件使用 IMAP/SMTP 或外部 Agently。普通 `From` 和 `Authentication-Results` 头不能用于授权远程输入。
- 独立 `FeishuBridge` 已删除，飞书遥控统一使用 Channel 授权和 `WorkbenchMessagingHost`。旧手机飞书或邮箱连接可作为 Channel 来源，由原消费者继续收取。原手机飞书的远程输入限已验证的普通聊天，线程继续走原收件路径。飞书 CLI 与 SDK 按实际 AppID 仲裁收件，标准 IMAP 按主机、端口、登录名和文件夹仲裁，确认原连接退出后释放所有权。IMAP 判定仅规范化主机大小写、末尾点和 `INBOX` 大小写，登录名与其他文件夹逐字比较。邮箱别名、域名别名及其他平台账户无跨连接身份合并。
- 在全局设置新接入的平台账号由主进程持有，独立于工作区。旧手机来源在全局目录中仍指向原工作区的连接器、凭据、游标和历史。原工作区未打开时，桌面来源会提示重开原工作区，或连接新账号后替换来源。可在「设置 → Channels → 连接账号 → 已有连接」检查原连接。访问原历史仍依赖原工作区。
- 已有原生 `ConversationRouter`、SQLite 受理账本和 `ConnectionSupervisor` 保留用于合同验证；当前生产渠道桥使用自己的状态与队列。它们独立测试通过不能证明所有生产渠道已有 SQLite inbox/outbox、消费游标事务或跨重启恰好一次。

## 验证证据和未验收范围

### 全局 Channel 与工作区绑定

设置、手机、左栏会话和账号管理组件共 27 项通过，包含旧来源宿主工作区未打开的恢复提示。定向逻辑校验涵盖全局授权切换、v1 到 v3 数据升级、各工作区独立状态、权限撤销后的外发闸门和旧来源跨区通知。统一账本

全局 Channel 改造验收时，最终构建和四套 TypeScript 检查通过。隔离真实 Electron 的 `agent-apps`、`logical-channels`、`phone-feishu-setup` 共 3 项通过。生产模型工具验证目录和当前工作区绑定，桌面 IPC 验证两区解除收件绑定后远程授权仍独立，手机验证旧来源跨工作区的已读状态和解除再绑。测试使用隔离数据与替代传输，已查看全局设置、远程配对与手机绑定页的深浅主题截图。

### 统一 Channel 的工作区版本（全局改造前）

- 设置组件 9 项、主进程 IPC 3 项及远程输入 4 项定向用例通过。用浅色与深色主题分别查看 1000px、390px 渲染，记录在 `.tmp/ui-captures/logical-channels/review.md`。
- 最终构建后，隔离真实 Electron 的 `agent-apps`、`logical-channels` 和 `phone-feishu-setup` 三个场景通过，覆盖生产工具读取 Channel 目录、桌面与手机收发及配对、旧飞书私聊和群消息投影。账号管理 `messaging-settings` 在前一次构建通过。测试使用隔离数据和替代传输。旧手机页面截图记录在 `.tmp/ui-captures/phone-feishu-setup/review.md`。
- 旧 SQLite、通知 outbox 和发送回执使用 `agent-app-channels` 隔离夹具。平台路由、微信持久上下文、邮箱身份边界与运行时退出走 `messaging-logical-delivery` 等定向回归。统一账本

### 既有工作台遥控路径（2026-11-16/17）

- `messaging-remote-binding`：真实绑定服务的首消息提示、六码有效期、精确身份、持久重启、拒重放、解绑取消、重新配对代际、出站授权生命周期和坏文件保护。
- `messaging-remote-ingress`：真实微信 Runtime/iLink 合成事件与绑定服务，回复目标/context token、图片、旧空白名单不吞消息；Slack 私聊与真实线程区分；邮箱声明身份不能越权；管理 IPC 的旧 Agent 配置拒绝、删账号先撤授权和发送关闭屏障。
- `workbench-messaging`：现有调度、工作区选择、既有 GUI/PTY 绑定、精确回合返回、群成员隔离、处理反馈与目标/授权变更。
- `gui-host-lifecycle` 的 `workbench remote` 定向组：实际 GUI 宿主绑定既有会话的字面受理及稳定 assistant 回执，模型驱动和 Electron 为测试替身。
- 设置组件与 `messaging-ipc`：在线微信卡展开后生成/复制/兑换/撤销用户绑定，旧 Agent 配置不在 DOM；主 Frame 身份、取消和调用者隔离。深浅主题各 780/390px 场景含扫码、真实展开的绑定卡和成功授权卡；折叠后实按 Tab 验证不可进入。截图位于 `.tmp/ui-captures/messaging-workbench/`。

### 接入源码精简（2026-11-23）

- `test/e2e/messaging-settings.spec.ts`：隔离 Electron 通过「设置 → Channels → 连接账号」加载 14 个服务选项，经真实 IPC 调用打包的各平台管理处理器。覆盖 Token 保护、iMessage 权限文案、旧账号级配对和设置入口的拒绝，以及 Office 独立入口。使用替代传输和隔离数据。

宿主和打包回归覆盖账号兼容、账号管理与释放屏障。iMessage 回归用模拟发送器验证发送标记和新旧回声过滤，Office 回归用替代任务服务验证独立 Session 与结果回传。工作台的定向回归覆盖 PTY 提交、来源级配对及线程回复。各平台真实账号、断线恢复、富媒体和互动审批仍按原协调范围跟踪。多渠道对标矩阵

统一 Channel 运行证据来自 macOS arm64 的隔离 Electron 和离线夹具。Windows 和 Linux 仍待真机安装、权限、连接恢复及退出验收。真实账号的登录、接收、原话题回复与平台特殊能力待逐渠道验证。

账号卡的展开按钮用 `aria-expanded` 表达状态。详情折叠时立即设置 `inert`，避免退场动画期间焦点仍能进入内部控件。离开账号页会取消进行中的平台管理请求。
