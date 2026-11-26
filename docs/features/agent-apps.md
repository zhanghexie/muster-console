# 调度 AI 的手机应用

手机通过 Channel 应用从全局目录选择本工作区使用的 Channel。绑定后，当前调度 Agent 和手机可以阅读、搜索和发送获授权来源的消息。原短信与邮箱的持久记录、连接及后台任务由兼容层读取。[消息接入](multi-channel-messaging.md) 统一 Channel 产品与验收账本

模型出口对 `host.apps.run` 的直接 install 成功结果返回安装后的 sdkVersion、id、name、version、homeView、permissions 及其他告警/证据，省略调用者刚提交的 collections、commands、views、icon、description 和 notificationHint。installFromLibrary 的调用者只提交库 ID，因此回执保留完整 collections、commands（含固定 patch 和宿主补全的 presentation）及不含 html 的 views，提供选择命令、参数字段和页面入口所需的定义；只去 icon、description、notificationHint 和页面 HTML。不能依赖 describe 补齐这些基本合同：它返回完整安装对象，额外的 HTML、审核指纹和库元数据可能使最终信封超过 12k。describe 仍显式读取完整定义，query/call、图像资产路径和外发回执不套用安装投影；安装回执不证明页面已渲染。命令或字段定义本身特别大时仍受既有总预算限制，本轮没有新增分页。服务、手机 IPC 和持久化保留原始定义，见逐动作回执审计。

应用和数据归属工作区。人在调度面板点击手机可操作同一份持久数据。手机以约 310px 宽的透明外层覆盖在调度面板上方，调度输出和输入仍保持可用。再次点手机按钮、按 Escape 或在主页按返回可收起。默认磁贴包括待办、提醒、Channel 和 RSS/Atom 阅读器。黄色 Lumia 930 外壳、WP 排版和三键导航沿用原型，工作台和原型共用一份机身图片。[机身素材说明](../prototypes/agent-apps-metro/assets/README.md)

旧邮箱使用 IMAP/SMTP，旧手机消息使用专用飞书机器人。外部消息只有通过单独的远程输入配对和授权才能操作既有工作台会话。待办截止时间和唤醒提醒各自持久化。

自定义页面接入超时提示、标准视图入口以及未改动的内置应用和相册示例的名称、字段、视图和操作标签跟随界面语言实时切换；可按翻译后的名称搜索。翻译仅用于展示，按应用、字段和命令身份核对原值，不修改持久定义、记录或调用参数。手机 IPC、操作状态及连接错误展示会翻译可识别的宿主错误，飞书会话列表的两种宿主不可用原因在人工 IPC 回传时翻译；服务存储、模型工具结果及未知诊断细节不受影响。页面作者提供的内容、用户自定义标签与未知错误作为数据原样展示。

新导入的 RSS、邮件和飞书消息对宿主生成的标题、正文或发送者占位额外携带可选 `placeholderFields` 来源标记，随连接器结果跨主进程与服务 worker，并与记录一起写入 SQLite；显示时只翻译标记种类、字段和原值均匹配的占位。外部内容即使恰好与占位文字相同也不打标；没有标记的历史记录保持原文，不推测来源。显式编辑字段会清除其标记，其他字段的更新不影响标记；消息内容从远端变化时只为实际变化的字段接收新标记。模型工具查询新记录也能看到该可选标记；记录原值、搜索、发送参数和旧记录均不改写。

飞书接收事件发现新对话时，宿主自动生成的连接名另带可选 `namePlaceholder`；历史连接名和外部提供的同名内容不推测来源。列表、连接选择和设置仅在标记与原值匹配时投影翻译；编辑名称会清除标记，单独改权限或通知设置则保留。后续读取到远端真实名称时清除标记，数据和目标身份不变；旧列表接口中的自动占位也带可选标记。

## 入口与关键文件

服务 worker 在创建时即归 Runtime Kernel scope 所有，并由 `phone-apps` 域实际启动。关闭先拒绝新请求、取消宿主连接器/人工确认和手机飞书入口，再等待服务 stop、真实 worker terminate、所有已接受宿主回调与手机飞书子进程退出。`start()` 的迟到回执不能重新安装工作区定时器。飞书 event stream 的同步 `stop()` 只请求关闭，`stopAndWait()` 同时等待 consume 进程 close 和对应 profile 的 daemon stop 回执；清理失败保留 stream 以便重试，不用历史错误污染成功重试。

| 层 | 文件 | 职责 |
|---|---|---|
| 合同与 SDK | `src/shared/agentApps.ts` | App 定义、字段/命令/视图校验、展示绑定、标准 CRUD 工厂 |
| 内置应用 | `src/shared/agentAppsBuiltins.ts` | 声明宿主维护的内置应用、旧工具兼容定义和 Channel 命令 |
| Channel | `src/renderer/src/agentApps/ChannelAppView.tsx`、`src/main/agentApps/appChannels.ts`、`legacyChannelRecords.ts` | 手机 Channel 页面、工具命令、作用域检查和旧记录投影 |
| 持久事务 | `src/main/agentApps/sqliteRepository.ts`、`sqliteStateStore.ts`、`store.ts` | 工作区 SQLite、增量记录、原子提交、游标/待投递事件、发送回执和恢复；`store.ts` 保留状态类型 |
| 本机共享库 | `src/main/agentApps/library.ts` | 本机应用定义和版本快照、私有可见性、冲突检测；不保存工作区业务数据 |
| 后台服务 | `src/main/agentApps/serviceWorker.ts`、`serviceClient.ts` | 在 worker 线程运行完整手机服务和数据库，代理主进程专属的凭据、网络、审批和通知能力 |
| 图片资产 | `src/main/agentApps/images.ts`、`managedImageSource.ts` | 工作区/App 资产归属、原图/缩略图、附件来源校验与回收 |
| 业务与后台 | `src/main/agentApps/service.ts` | 统一命令执行、CAS、权限、后台轮询、到期提醒、取消与退避 |
| 外部适配 | `src/main/agentApps/connectors.ts` | IMAPFlow、Nodemailer、RSS/Atom、既有 lark-cli 运行器 |
| RSS 代理适配 | `src/main/agentApps/feedProxy.ts` | Electron 系统/PAC 代理选择、隔离网络会话、跨平台 TUN 网卡识别 |
| 手机机器人授权 | `src/main/agentApps/feishuAccounts.ts` | 按工作区独立 profile 的状态、扫码创建、取消、超时、凭据生效核验；与调度端机器人隔离 |
| 宿主接线 | `src/main/agentApps/wiring.ts`、`credentialPolicy.ts` | 系统凭据托管、外发安全服务接线、订阅策略、内部通知和空闲唤醒 |
| 模型工具 | `src/main/capabilities/{catalog,hosts}/agentApps.ts` | 调度专用 `host.apps.run`，由可信调用作用域固定工作区/身份 |
| 人工桥 | `src/main/ipc/agentApps.ts`、`src/preload/index.ts` | 同服务调用、无副作用查询、账户管理 |
| 手机入口 | `src/renderer/src/panels/AgentFloat.tsx` | 顶栏右侧、收起前的手机按钮，手机订阅不依赖聊天面板打开；自动展示可展开调度输出，手机不让聊天区域 inert |
| 展示与页面 | `src/renderer/src/agentApps/` | presentation、useAgentPhone、AgentPhone、phonePosition、AppDataView、commandPresentation、CustomAppView、PhoneSettings、FeishuConnectionSetup、phone.css |
| 作者真源 | `resources/skills/apps/SKILL.md` | 英文调用说明、完整最小包、受控 handler、页面 SDK 与验收方法 |

`src/main/index.ts` 创建服务并在 IPC 注册后启动，退出时等待后台服务停止；它枚举所有已配置工作区，不依赖当前选区。新模型说明及通知注入已登记在 `src/main/agent/injection-registry.ts`。

SQLite 状态按工作区缓存，单条记录和图片资产变更只更新受影响的记录视图及 revision；同一服务生命周期内缓存失效重读不会把仍在运行的操作当作重启中断，首次打开工作区时仍执行中断恢复。工作区移除时，worker 等待在途请求、后台任务和图片清理收口后关闭对应数据库；等待期间重新加入会取消该次释放，数据保留。关闭失败会记录错误并在后续工作区更新时重试。

## 工具、IPC 和数据流

模型固定入口为 `host.apps.run({action,appId?,commandId?,params?,requestId?,definition?,enabled?})`，支持 list、describe、query、call、install、uninstall、listLibrary、installFromLibrary、publish、setPrivate、setEnabled、图片 importImage/imagePath，以及配置邮箱的 saveMailbox/testMailbox。`uninstall` 只作用于当前工作区的自制 App，默认保留记录，`params.deleteData:true` 明确删除其数据；内置 App 只能停用。卸载停止该 App 后台任务、关联提醒与尚未消费的通知，移除其连接授权但不删除共享连接或其他 App 数据；保留外发回执以防重发。同一已批准定义或同一共享库身份重新安装时可恢复保留记录，不同定义不得仅凭相同 ID 接管记录。它与九个 runFactory 域并存；安装新 App 不增加宿主静态工具。Worker 不开放此入口。先 list/describe 取得字段和命令；模型调用没有打开手机、动画或等待展示的参数。

手机使用 `agentApps:snapshot/query/call`，接收 `agentApps:operation/changed/feishuStatus`，其他配置、安装、图片和兼容 IPC 保持原合同。客户端身份由宿主确定。人工命令使用 human，模型来自调度作用域，后台使用 background。兼容配置保留本工作区手机专用飞书机器人的扫码和已接入邮箱编辑。

`host.apps.run` 通过 `call` 访问 `muster.channel` 的 `catalog`、`bind`、`unbind`、`channels`、`search`、`list`、`get`、`state`、`reply`、`send`、`save-draft` 命令。宿主按可信调用作用域处理目录和当前工作区绑定。人在手机主页的「绑定 Channel」从全局目录选择或解除，目录仅显示 Channel ID、名称、来源数量和绑定状态。解除绑定即撤去本工作区对该 Channel 的查看、回复和通知，其他工作区仍可使用。后台任务不能外发，模型发送还经宿主授权。远程配对由桌面单独管理。模型显式使用旧 `mail`、`messages` 时仍须满足原工作区和账户权限，且来源属于当前工作区至少一个已绑定的 Channel。

本机应用库位于 `userData/agent-app-library/catalog.json`，自制 App 默认登记共享，也可设为私有；启动和列库时登记现有自制定义。相同 ID 的不同定义作为冲突条目保留，安装时不覆盖其他身份。共享版本只包含声明式定义，不携带记录、连接或授权；目标工作区自行安装，AI 发起自制定义安装时审核，人从界面安装直接执行。完整定义与随应用分发的内置 App 或相册模板一致时，AI 首次安装、更新和重新启用也免审核；修改过的定义不因同名而免审。版本更新需显式执行。人工来源由 IPC 固定并跨 worker 线程传递，模型参数不能指定来源。工作区本地有未发布修改时拒绝直接更新，发布时也校验基线，避免并发覆盖。不同 `userData` 或设备不会同步。

```text
工具调用 / 人工命令 → AgentAppsServiceClient → 服务 worker / 事务 / 连接器 → 实际结果
                            └─ 微任务派发 operation → 有界队列 → 手机定位/反馈
后台到期 / 同步 → 记录 + 游标 + outbox 原子提交 → 持久投递账本 → 空闲准入 → PI 隐藏事件上下文
                                                                       └→ 会话一行数量提示
手机展示 / 切页 → query 读取持久记录（不重放命令，不唤醒模型）
```

新版存储在 Electron `userData/agent-apps/<workspaceId SHA-256>.sqlite`。每工作区一份，包含安装定义、记录、任务、连接、应用独立游标、outbox、请求回执和最近 120 条操作。数据库在服务 worker 内访问，使用 WAL、事务和修订校验；列表查询按应用及集合等条件分页。记录表将 `app_id`、记录 `revision`、`status`、`externalId` 和 `dueAt` 保存在稳定列，并按应用/集合建立精确过滤索引，扩展字段继续保留在 JSON 兼容载荷中。应用定义的未知顶层扩展字段和记录的未知顶层扩展字段都保留，但分别受 64 KiB UTF-8 字节预算约束，超出时整个写事务拒绝。记录搜索只保留可重建的 SQLite FTS5 trigram 派生表，写入、删除和打开时重建都与记录身份绑定，短于三字符的查询也走该派生表的 substring 路径；记录表不再复制 `search_values`。未知过滤继续走 JSON 路径。记录及连接写入要求 expectedRevision；发送要求稳定 requestId，参数不一致的同 ID 请求拒绝。已有库打开或校验失败直接报错、保留原库，不用空数据冒充恢复。当前 SQLite schema v1 采用 clean-break，缺少稳定列或搜索派生表的旧 Agent Apps SQLite 直接拒绝打开并保留原库；这不读取旧 JSON 工作区格式，也不替代本机旧数据的一次性备份、迁移和读回核验。

工作区 SQLite schema 错误属于持久故障。后台轮询首次记录后会暂停该工作区的后台处理并保留原错误，避免每个 tick 重复刷屏；重启工作台或完成显式 pre-release storage reset 后重新尝试。

加载已有工作区时，对宿主内置应用按 definition.version 补入新版定义，保留启用偏好、安装时间、记录、任务和自制应用；升级原子落盘，不覆盖更新版本。该通道只用于兼容的定义增补，破坏性 schema 变更必须另行迁移。提醒 v2 补入 remove 命令，v4 补入可选的星期字段；已有工作区无需重新安装，原有任务继续按原来的周期运行。

定义与命令执行器由手机服务 worker 加载，主进程负责 IPC、凭据及外部能力接线。开发模式下，渲染页面热更新或仅构建 out/ 不会让已运行的旧服务应用升级；需要重新启动工作台。验收已有工作区时应读取该实例的 `agentApps.snapshot`，确认提醒版本及 remove 命令，再进入真实提醒详情核对入口，不能仅用新启动的隔离测试实例代替用户实例的生效检查。

发送提交前把 recordId 和 submitted 回执原子保存；成功更新实际 messageId；超时或崩溃恢复标为 uncertain，同一请求不会重新发送。已提交动作不因 UI 关闭撤销。外部副作用不声称严格 exactly-once；需要核对远端后再决定新尝试。外发回执长期保留，其余请求最近 1000 条；大邮箱的完整真实负载尚未做容量验收。

## 图片和相册

本机共享库包含可安装的相册示例，使用同一受控应用合同。人可以选取或拖入图片，列表显示缩略图、详情显示原图；调度 Agent 可从当前调度对话的受管附件导入并取得所属 App 的图片路径。来源文件被复制而非移动。暂支持单帧 JPEG、PNG、WebP，单张最多 25 MB、4000 万像素；不支持的格式明确报错。

原图和去除元数据的缩略图存放在 `userData/agent-app-assets/<workspace-hash>/<asset-id>/`，SQLite 保存元信息及记录引用，不把图片主体放进业务记录。页面通过按工作区和 App 校验的宿主桥取得 blob URL；删除引用、卸载和中断恢复按资产归属与引用检查，不能读取其他工作区或 App 的图片。隔离 Windows Electron 已验证选图、列表、详情、重启和受限自定义页面，macOS/Linux 尚未真机验证。

## 内置应用行为

| 应用 | 已实现 | 时间与通知 |
|---|---|---|
| 待办 | 标题、下一步/完成依据、完成/恢复、截止时间、等待对象、编辑/删除、搜索 | 截止不自动唤醒；显式关联提醒；完成/删除取消对应任务及未投递提醒 |
| 提醒 | 单次、按分钟重复、按当地时间每日或每周指定星期重复、改期、取消/重新设置、删除、关联 App/记录、到期与错过处理 | 服务每 2 秒检查；`dailyTime` 使用本地日历时间并处理系统时区切换，可选 `weekdays` 为逗号分隔的 0–6（周日到周六），清空后恢复每日；固定分钟周期不自动变为日历周期；通知保存独立的发生时间和下一次时间；取消保留记录，删除移除记录，均停止计时及未投递通知；catch-up 补一次，skip 忽略超过一分钟的过期发生点 |
| Channel | 按 Channel → 来源对话 → 消息打开。在 Channel 主页跨已授权的 Channel 搜索正文和主题，结果标注来源。查看未读、已处理、发送状态、原消息回复与单一来源的新消息。旧邮箱带草稿、明确收件人、主题与附件元信息。 | 每个来源可选汇总、立即或静默；已用作远程输入的消息不重复唤醒调度 |
| 阅读 | RSS/Atom 订阅/编辑/取消、刷新、去重、来源、摘要/正文/原文 URL、已读/已处理、收藏、关键词 | 每源自定义 1–10080 分钟，默认 30；默认摘要提醒，可唤醒或静音 |

已有手机邮箱和飞书连接投影为全局 `legacy:` 来源，身份按原工作区和连接 ID 派生。原定义、连接、记录、草稿、游标、发送回执、权限和 outbox 仍由原工作区保存。其它工作区绑定后通过原工作区的兼容连接读取、回复、保存草稿，已读和处理状态按工作区保存。原 IMAP 轮询和飞书 CLI 继续使用同一个消费者。缺少连接的历史可以在只读来源查看，原工作区失效时其中的历史也暂不可访问。请恢复原工作区，在「设置 → Channels → 连接账号 → 已有连接」检查连接，或接入新账号并替换来源。回复由宿主回查原消息引用。旧邮箱可填写收件人和主题，原生邮箱主动发送固定为所选来源对端。

原生和旧手机来源分别使用持久通知游标。一个工作区的多个 Channel 收到同一来源事件时，宿主选一个 Channel 投递，立即优先于汇总。手机 worker 将新游标和通知一起写入本工作区 outbox。新增绑定可查看已有历史，绑定前的事件不会补发通知。

旧手机飞书或邮箱收到新内容时，由原工作区 outbox 将入站记录引用交给主进程。主进程按原始来源和工作区去重，只给事件发生时已经绑定的工作区登记通知。原工作区解除绑定或将旧连接设为静默时，其它有效工作区仍按各自的 Channel 通知设置接收。原工作区已有持久投递记录时跳过重复通知。旧邮箱批次每个工作区至多通知一次，代表内容从仍未读、未处理的原记录中取出，全部原消息继续保存在收件。投递和模型消费前重验绑定、来源权限与消息状态。

“同步”“通知”“已读”“已处理”独立：游标、outbox 回执、read、processed 分别记录，打开页面不会自动声称读过或办完。IMAP 不修改服务端已读标记。短信回复目标以宿主保存的 origin 验证，伪造普通字段不能跨越已授权对话。

旧手机 IMAP 显式设置 `clientInfo: {name:'muster-console',version:'0.1'}`，通过 RFC 2971 ID 发送工作台标识。连接测试和收信共用客户端工厂。EXAMINE 必须返回有效 mailbox，UID 元数据缺失时先试 STATUS。若服务器有 UIDVALIDITY 而两条命令都没有 UIDNEXT，则首次用 UID SEARCH ALL 取最近 50 封，此后按持久游标增量查。EXAMINE false、无效 UIDVALIDITY 或 SEARCH false 均返回错误。EXAMINE 被拒绝时保留服务器错误说明，例如 Unsafe Login。同步失败记录到连接 lastError，最后成功时间及游标保持原值，恢复成功后清除错误。

业务数据和待投递通知同事务提交；outbox 的 deliveredAt/messageId 表示已保存至持久投递账本，通知头 notifiedAt/readAt 表示已进入 PI 上下文，业务记录 processed 表示处理完成。三者独立。失败指数退避；重启继续投递。已投递（deliveredAt 置位）且超过 7 天滚动保留窗的 outbox 事件由后台 tick 裁剪（无过期项不写事务）；未投递/重试中的事件永不裁剪，notificationId 续读只依赖近期事件，更老的 id 走既有「not found」错误路径。取消、删除、停用或撤权会使尚未进入模型的旧事件失效，即使它已保存至投递账本也会在发送前重验；已进入模型的上下文不能撤回，实际操作仍通过当前权限/CAS 检查。删除关闭自身及关联记录的后台任务；关联目标已删除仍可取消提醒。时间检查与网络工作分开，所有工作区最多两个同步任务并发。

提醒到期从 outbox 进入统一事件日志，由工作区的系统订阅保存原有 app 通知邮件；只有实际保存邮件或确认静音/失效后才确认 outbox。投递和模型消费前仍向 app 服务重验记录，用户订阅 `reminder` 来源也遵循同一工作区边界。邮件、RSS 等其他 app 的通知路径保持原样。

通知规则匹配 subscription policy 的 `factKind: app.<事件类型>`，否则使用来源/连接策略；实际投递前重新读取。wake 遵守既有空闲和自治闸，digest 随下一次实际回合输入，不另开 loop，mute 仅收取。首次 RSS 同步记录 feedSyncedAt 并发 rss.imported（默认 digest），以后新增为 rss.new；既有文章视为已建立基线。宿主关闭时不运行，重开恢复，没有系统守护进程或离线云执行承诺。

### AI 上下文与人的活动提示

`notifications.ts` 按当前记录、来源和授权生成内容，`messages/hostNotifications.ts` 合批、预算控制和消费记账。复用原有持久投递账本，但不再让调度调用内部邮箱工具取得应用事件；这些事件也不再出现在普通读信结果或来信信纸中。原有 Worker/Agent 信件继续走通用邮箱。

- 人的会话仅显示“收到 3 条 RSS 更新”等一行计数，不展示标题、内容、规则、ID 或处理流水。需要人介入的异常由实际错误路径报告。人仍可自行打开手机应用；工具操作展示保持原机制。
- AI 收到来源、变化类型、内容、用户处理提示、当前 id/revision 和命令引用。最多每批 8 个事件，模型事件正文总预算 14000 字符；单个来源材料通常不超过 8500 字符，正文超限显式列出 truncated 字段，供按 get 读取。预算是字符数，不宣称 tokenizer 实测。
- 大批次给准确的 `host.apps.run query params.notificationId` 续读参数，按 outbox 固定成员位置分页，返回 nextOffset；已处理不会移动位置，删除/撤权可导致短页或空页，不跨工作区/应用读取。续读同样按约 14000 字符预算返回紧凑记录，以 truncated 映射说明哪些记录字段被截断；选定记录的 get 仍可取全文。默认内容足够时无需查邮箱或重新发现工具。
- 处理提示为 `notificationHint`，最多 2000 字符。来源（订阅/连接）覆盖应用定义默认值，再回落宿主默认；空值使用默认。RSS 标准表单和邮箱/飞书连接设置可编辑，AI 可通过订阅命令和 saveMailbox 配置。提示和外部 data 分开，均不扩大权限。
- `agent/providers/hostNotification.ts` 调用 PI `sendCustomMessage(display:false,triggerTurn:false)` 持久输入，再经正常 prompt 入口保留鉴权、压缩和 before_agent_start 模式检查；触发文本不进人的展示。只在真实 custom message 事件及 session entry 确认后记消费回执，不把进入自治闸当作已消费。未知提交不会自动重放。
- 隐藏载荷从未写入展示消息。历史中的普通宿主事件信纸停止自动展开；PI 隐藏输入仍供模型恢复。宿主事件失败重试保持 host 来源并继续该事件，不重发前一个人的请求。

回归：`test/host-notifications.mjs` 覆盖内容密度、首次导入、当前权限/来源/已处理重验、固定批次、忙碌投递、消费/完成区别、重启及普通邮箱保留；`test/host-notifications-pi.mjs` 使用真实已安装 PI SDK 和离线模型流，验证隐藏持久输入、单次模型请求、回合前钩子与恢复。此前通知专项的三套类型检查和生产构建通过；该专项在 2026-10-24 经用户确认重启 Windows 工作台，草稿比对一致，运行中 IPC 确认 RSS v3、处理提示和批次校验已加载。界面字段/历史信纸用例已更新，按用户要求不主动执行 UI 验证；真实模型处理质量和 macOS/Linux 真机仍待验收。

## 账户和跨平台适配

「设置 → Channels → 连接账号」管理原生平台和兼容手机连接。已有手机邮箱可测试、编辑、停用和按旧 App 授权，继续使用原 IMAP/SMTP 和加密凭据。手机专用飞书机器人继续复用当前工作区的 CLI profile。自定义 App 还需要明确的账户授权才能发起实际连接操作。

手机主页、导航、连接设置、飞书接入状态和应用数据视图的部分固定文案随中英文设置切换；主进程飞书接入错误和应用通知摘要按当前语言生成。用户配置的工作区名、连接名、应用名、消息正文和上游原始错误等数据保持原文。其余尚未迁移的界面及主进程文案仍需逐项补齐。

调度 AI 可用 `host.apps.run({action:'saveMailbox',params:{...}})` 自行配置用户授权的邮箱，复用人工设置的 `saveConnection`、加密、CAS 和后台任务路径。`mailboxConfiguration.ts` 仅接受邮箱字段白名单，拒绝工作区、身份、密文等注入参数。新建至少需要稳定 id、address、imapHost、smtpHost 和 password/passwordEnv；默认 user/name=address、mailbox=INBOX、TLS、993/465 端口、后台启用、wake 通知及 mail.read 授权，显式 STARTTLS 则默认 143/587。更新必须提供 id/expectedRevision，其他字段和凭据省略即保留，可用 enabled:false 停用。grants 显式传入时替换，只允许已声明的 mail.read/mail.send；SMTP 单独密码和 IMAP 密码可以独立更新。授予 mail.send 后，实际 AI 普通发信在既有授权内直接执行。

`testMailbox` 接受 `params:{id}`，复用已存连接的 IMAP 只读打开及 SMTP verify，不发送测试邮件；失败写入手机设置可见的 lastError，成功清除旧错误。保存成功不代表网络认证通过。list/保存回执不返回密码或密文。passwordEnv/smtpPasswordEnv 由主进程解析已有环境变量，引用和值都不混入公开连接或应用操作记录；直接传 password/smtpPassword 时，应用存储虽加密，模型工具参数仍可能进入会话历史，优先使用已有授权凭据引用或让人在设置中输入密码。飞书专用机器人的扫码接入仍由人工完成，之后不再需要逐个选择会话或发送绑定码。

连接 ID 与原邮箱/飞书会话及身份固定绑定，目标变更需要新建连接、原连接可停用；不让历史回复引用或同步游标跨越新授权目标。名称、密码、通知策略与读写授权可继续编辑。

密码用 Electron safeStorage 加密；Windows/macOS 密钥后端不可用时拒绝保存，Linux 无 Secret Service/KWallet 或 basic_text 后端时明确提示安装/解锁密钥环，绝不降为明文。网络协议、路径、文件提交共用跨平台实现；CLI 使用已有跨平台 larkCli 适配层，不自行拼 shell 命令。Linux X11/Wayland 不涉及桌面输入 API。

手机只需扫码创建一次专用飞书机器人。每工作区使用固定的 `muster-phone-<workspaceId SHA-256 前24位>` CLI profile，独立调度远程桥已退役，消息由 Channel 统一处理。`config init --new` 的 `--profile` 和 `--name` 同时指向手机 profile，不覆盖调度凭据。

手机调用 `agentApps:feishuStatus/startFeishuSetup/cancelFeishuSetup` 并监听按 workspaceId 隔离的状态事件。扫码成功后，宿主在同一运行环境用 `auth status --json` 核验 appId 和 `identities.bot.available`；真正收到 CLI 的 `[event] ready` 后才报告 receiving/已连接。公开配置或另一终端的鉴权成功不能代替宿主凭据核验。取链接 20 秒、完成授权 10 分钟超时会取消本次扫码；迟到 QR/进程回执不覆盖新尝试。关闭手机页面不取消扫码，退出宿主停止本工作区资源，不影响调度桥。

会话自动发现不依赖设置页：已配置机器人在宿主启动时即监听，收件箱为空也启动；扫码完成后立即监听。人发给机器人的私信直接接收；群消息核对事件 mentions 是否包含该机器人自身 open_id，只有 @本机器人的消息才接收。身份通过同一 profile 的只读 bot info 接口取得并缓存，不能把 @其他人或“群里存在任意 @”当成匹配；普通未 @群消息即使远端授权推送，也不会自动进入手机。事件中非人类发送者不进入收件链路，避免机器人自身回声。

首条合格消息到达时，主进程在同一事务创建不可变的会话投递目标、收信保活任务、保存消息并写通知 outbox；以 workspace/profile/chatId 定位目标，以 connectionId/messageId 去重。新目标仅授予内置短信 messages.read/messages.send，默认新消息唤醒，保留账户授权检查。已有连接复用原 ID、消息与通知偏好；不会覆盖手工改名或恢复已撤销的权限。停用会话拒收；短信应用停用时不自动发现新目标。原调度桥占用的会话继续隔离。外界内容仍是非可信 data，不能改变这些权限或处理规则。

名称解析在首条消息持久化之后异步进行：群按 chatId 获取群名，私信按首条 messageId 获取发送者姓名；失败记录明确日志，消息仍可用，显示不含原始 ID 的临时名称。迟到的名称结果不得覆盖用户改名。短信首页由会话目标自动生成，点入对话后发送只填写正文，目标自动取当前对话；主页不提供默认选中第一个会话的发送入口。设置页只显示一个机器人接入区域，“对话设置”用于调整已发现对话的通知、停用和应用权限，没有逐个添加/选会话入口。展开使用 usePresence/acc，二维码使用 usePresenceValue/mp-panel。进入编辑页滚回顶部。

自定义页面的宿主桥接超时与操作提示随界面语言切换；更新语言通过既有 iframe 的受源和令牌校验消息完成，不重新挂载页面或改写作者内容。

旧版 `beginFeishuBinding`、手工连接保存及列表 IPC 保留兼容，正常接入使用扫码取得手机连接的凭据。飞书 CLI 的接入、鉴权与收发要求明确的连接 profile，生成二维码可独立执行。旧连接缺少 profile 时，保留已有收件和历史，继续收发前需在 Channels 重新接入。模型通过已有 accountId 使用 `messages.list/get/sync/send`，profile 和扫码由宿主管理。

专用机器人使用 `event consume im.message.receive_v1 --as bot`，不进入原调度消息路由。断开后按 1/3/10 秒最多重连三次；失败在设置中显示并可重试，退出清理计时器和消费流。stderr 按完整行缓冲，ready 标记分块也不会漏掉；CLI 错误读取真实 error 信息，不被版本提示淹没。收到但尚在异步核对 @ 身份的消息不因普通重连丢弃；停止宿主后的迟到处理无效。连接测试和 messages.sync 检查事件消费就绪，实时消息不依赖可能不支持 bot 鉴权的历史查询接口；sync count 只统计本次调用写入的数量。已收消息持久保存；宿主关闭期间消息不承诺补收。

发送/回复继续使用 `+messages-send/reply`、`--content` JSON 文本与 `--idempotency-key`，防止正文被当作 `@file` 读取。Agent 普通外发在既有授权内直接执行，后台任务不允许外发；回复引用仍校验同一会话的宿主持久来源。人点击发送按钮执行同一业务命令。接收群消息的远端权限和 @ 字段参见[飞书消息事件](https://github.com/larksuite/cli/blob/v1.0.98/events/im/message_receive.go)，机器人身份参见[机器人信息接口](https://open.feishu.cn/document/client-docs/bot-v3/obtain-bot-info)。Windows/macOS/Linux 共用现有 CLI 适配，无平台专用新分支。

RSS 请求验证目标 URL 和 DNS 结果；直连固定已校验的连接地址，每次重定向重新检查，最多四次跳转、2 MB 解码后内容、20 秒整体超时（含 DNS/PAC 等待）；拒绝 XML 实体。普通域名先读取 Electron 系统/PAC 的实际路由：显式代理使用独立、不持久化、无 Cookie 的 Chromium 会话，固定所选 HTTP/HTTPS/SOCKS 代理且不自动降级 DIRECT；远端域名解析属于用户配置代理的信任边界。域名解析到 198.18.0.0/15 时不把该网段改成公网：无显式代理的 TUN 模式必须由 `os.networkInterfaces()` 确认存在该段的非 loopback IPv4 网卡，并且目标是 HTTPS，才把固定 fake-IP 交给系统隧道，保留 Host/SNI 与正常证书校验。缺少代理/TUN 证据、TUN 下的 HTTP 源均明确报错并提示操作方式。Windows/macOS/Linux 共用适配，不依赖网卡名称或平台 Shell；自定义其他 fake-IP 网段尚不支持。

字面量 fake-IP、回环、内网、链路本地、保留网段、本地域名，以及公网/fake-IP 混合真实内网的 DNS 答案仍拒绝；代理请求的重定向不自动跟随，逐跳重新检查。不共享浏览器 Cookie/登录信息，不访问 file/custom 协议。外部正文仅作文本展示，无脚本权限。IMAP/SMTP 不放开明文链路。

记忆 provenance 将 `host.apps.run/host_apps_run` 保守归为外部来源工具（转写只有 facade 名，不能可靠分辨每条结果的来源），与 browser 域同样处理；持久存过的来信不会因此变成可信用户指令或长期记忆授权。

## 自动展示和统一作者接口

操作事件携带 workspaceId、agentId、runId、operationId、sequence、阶段、viewId 和实体引用。执行只等待业务和持久审计，订阅异常不会改变结果；界面离线不补播全部历史。队列最多八项，合并同操作阶段，保留最近八个失败，旧操作完成不抢回新页面，也不占用展示节拍阻塞后续页面。队列按独立节拍推进，新事件到来不重置计时器；连续调用也会打开对应 App、进入目标记录并读回持久内容，不以底部操作计数或摘要替代真实页面。失败显示在对应应用页。

默认开启自动展示，偏好保存在手机内部“设置与连接”中；打开手机、普通浏览和滚动不暂停跟随，无“继续跟随”按钮。编辑/设置表单或输入控件聚焦时暂缓切页以保留草稿，退出后自动继续，sandbox 内容同样按输入焦点处理。主动收起后抑制同轮重开，切回工作区仍保留抑制；新回合遵守总开关。不自动跨工作区，不主动移动聊天输入焦点。

每次展开独立记录 `openedBy: user | agent`，关闭清空；它与控制自动切页动画的 `automatic` 分开。手动打开后即使跟随 AI 切页，仍保持用户归属，不自动收回；自动展开后用户主动导航或进入输入编辑也转为用户接管。仅 AI 自动打开时，等待全部已展示相关操作结束（成功、失败或取消）、展示队列排空，再保留最后结果 1.5 秒后自动收回手机，调度聊天面板保持展开。新操作、人工接管、切区或卸载取消旧计时；进行中集合独立于最多八项的展示队列，旧操作迟到完成不抢页，但会释放收回条件。已访问工作区在切走期间仍接收完成记账，不自动弹到其他工作区。自动收回不抑制同轮后续操作重新打开；用户主动关闭继续抑制同轮打扰。打开来源只在本次渲染会话中按工作区保存，不落业务存储，重启后默认关闭。

手机通过 `phonePosition` 跟随调度面板位置/大小，优先让手机中心与面板中心重合；仅在超出窗口时以最小位移退让，保持距窗口边缘至少 12px。不扩大调度面板、不拦截手机之外的点击。接入统一 `useOverlayDismiss` 栈，收起快捷键（默认 Escape）只关闭最顶层，并在手机内持有焦点时恢复入口按钮焦点。外层 `usePresence/mp-panel` 向上滑入、向下滑出，可中途反转。App 切换沿用原型的 WP8 Turnstile Feather：旧磁贴错峰翻出，新标题/列表随后飞入，透明场景层避免新页面盖住旧磁贴；自动展示使用更短的同源 token 节奏。只过渡 transform/opacity，结束后清除3D变换和临时滚动限制。减少动态效果取消空间旋转，不等于关闭自动展示。

手机内所有滚动条统一隐藏，保留滚轮、触控和键盘滚动；该规则同时注入自制 App 的 sandbox iframe，不要求作者逐页实现。返回/Home/搜索、通用列表/详情/表单、文件夹/会话导航都由宿主实现。

机身底部返回、Home、搜索直接使用 Lumia 图片自带符号，DOM 只保留三块透明 button 热区，不额外绘制 SVG、文字、背景或阴影，悬停/按下也保持透明。热区按机身比例随缩放定位，保留无障碍名称、键盘激活和 focus-visible 焦点轮廓。

命令按钮按视图声明顺序呈现。`commandPresentation` 根据 handler、固定 patch 与记录状态统一选择 SVG 图标：删除垃圾桶、取消提醒划线时钟、编辑铅笔、保存磁盘、取消叉号、恢复撤回箭头、回复弯箭头、发送纸飞机、收藏星形等；保留 WP 圆框和文字标签，内置及自制应用共用，不要求模型指定图标或操作 UI。已满足的固定 patch 不再显示重复操作（例如待办完成/恢复、已读/收藏）；提醒详情显示编辑/取消/删除，停用后显示重新设置/删除。时间使用本地可读格式，启用状态和重复周期直接可见。设置提醒总会启用，表单不再提供会被后端忽略的启用复选框。删除成功回到列表，自动展示事件清除已删除实体引用，失败保留详情和重试入口。

`defineRecordApp` 生成任意身份的 CRUD、标准页面和展示绑定；JSON 作者可以组合固定 patch、提醒/RSS/邮件/短信 primitives。安装和启用共用 `AgentAppsService` 业务校验；AI 操作自制定义按既有策略进入异步审批门，人工操作和确认属于自带资源的完整定义免审。需要审核时拒绝或服务不可用不提交安装，审核后复核原安装指纹，变更拒绝；既有已启用 App 不自动停用或批量重审，普通 CRUD 和发送不逐次送审。安装检查字段、版本、权限声明、视图和实体引用，缺少专用页时生成 operation 页；损坏的显式绑定拒绝。升级必须保留现有数据和活动后台任务，执行中升级拒绝，避免旧异步结果落入新 schema。

自定义内容使用已有 ma-* 公共组件实现，运行于 `sandbox=allow-scripts` 的独立 iframe，禁止网络、Node、父 DOM 与凭据访问。接口为只读 `app.query`、强制 `app.onPresent`、`app.select`；图片页面可通过 `app.asset`/`app.releaseAsset` 使用宿主受控资源。`maUi` 状态仅是页面临时状态；`ma-text` 等组件沿用公共运行时的文本绑定和诊断，组件错误显示于组件内并随语言切换。业务写操作保留在宿主命令按钮，不允许页面加载/展示回调重放业务。共享颜色/动效 token 随主题更新；静态检查拒绝硬编码颜色/时长和外部样式/嵌入。页面异常或未就绪显示真实错误及标准页回退。

手机应用的记录字段、连接选择和邮箱设置复用 `CustomSelect`，菜单支持键盘操作与主题浮层。必填选择项为空时阻止提交、显示提示并将焦点移到该字段；普通输入仍使用浏览器原生表单校验。

首版自制应用支持声明式业务组合与自定义内容脚本，**不支持任意后端 JavaScript、原生能力或任意网络请求**；这类完整权限程序仍属于已有受信任扩展，不自动成为受控 App。自定义 HTML 的静态样式检查不是任意 JavaScript 的完整视觉证明，作者仍需按 SDK 做真实预览验收。

## 验证和当前边界

### 统一 Channel（2026-11-17）

隔离 SQLite 定向回归覆盖旧草稿、收件游标、发送回执、工作区授权和新通知 outbox。真实 Electron 的 Channel 和旧手机飞书迁移场景使用真实手机服务 worker 与测试运输，已检查中文、英文、浅色和深色实际界面。截图见 `.tmp/ui-captures/phone-feishu-setup/review.md`。统一入口的真账号与平台验收见 统一 Channel 账本。

### 原有手机功能
- 2026-10-31 本机手动迁移并重启 Windows 工作台：备份并逐项核对 7 个工作区、736 条记录及应用定义、任务、连接、通知和回执，保留原 JSON 和单独备份；8 条可从事件标识确定发生时间的旧提醒已补回发生时间。重启后 SQLite 完整性及全部 736 条记录内容、任务/连接/回执身份和备份中的通知身份均复核一致；另一个工作区的手机应用库显示四个自动登记的旧自制 App 和相册模板。此次核验没有触发真实外发。其他 `userData` 的旧 JSON 不会自动迁移。
- 手机平台优化定向验证：17 项后端专项、7 项共享库/卸载/图片组件测试和 Node/Web 类型检查通过；隔离 Windows Electron 验证相册选图、缩略图、原图、自定义页和重启。一次隔离 E2E 测试进程异常退出后重跑通过，原因未确认；macOS/Linux 未做真机验收。10,000/50,000 条记录的隔离 Node 小样本测得增量存储写入延迟降低，但不是完整 Electron 压测或容量上限。

- `test/unit/agent-phone-auto-close.spec.tsx` 与 `agent-float-panel-actions.spec.tsx`：打开归属、三种终态自动收回、并发和迟到完成、人工接管、同轮再次自动打开/主动关闭抑制、切区完成记账、关闭自动展示后的完成处理，以及右侧入口真实点击开合。2026-10-25 首轮相关 32 个组件用例通过；后补的两项边界用例及窄布局最终调整按用户要求停止自测，交由用户验收。纯渲染层跨平台共用，未改主进程/平台 API，macOS/Linux 尚未真机验证。

- `test/agent-apps-imap.mjs`：163/126/yeah 使用工作台 ID、TLS/STARTTLS 与只读打开、EXAMINE 拒绝/false、STATUS 补齐或实际 UID 搜索回退、缺失 UIDVALIDITY/SEARCH false 不计空结果、最近 50 封与后续增量、合法空邮箱、连接资源释放、失败操作和连接错误回显、游标保留及恢复清错。2026-10-24 在重启后的 Windows 用户工作台，经原 IPC 测试 163 IMAP/SMTP 成功，4 封带服务器 origin 的收件箱记录持久化，重复同步 count=0、lastError 清空，草稿重启前后完全一致；未发送邮件。
- `test/agent-apps-rss-network.mjs`：显式系统代理、DIRECT + fake-IP TUN、无代理拒绝、DNS 固定、逐跳重定向/内网元数据拦截、2 MB 上限、取消 DNS 等待、隔离会话与跨平台网卡形态。2026-10-24 在本机实际 Mihomo TUN（DNS=198.18.1.101，系统代理=DIRECT）用新连接器获取 `https://openai.com/news/rss.xml` 成功，802420 bytes，解析 200 条；不修改用户订阅数据。显式代理与 macOS/Linux 为模拟验证，未作真机验收。
- `test/agent-apps-mailbox-tools.mjs`：真实工具 handler/调度身份作用域 → 保存/测试服务，覆盖默认值、字段白名单、跨区隔离、CAS、独立 SMTP 密码更新、停用与重启、凭据引用/公开结果无密码、认证失败回显、邮箱配置高危审核的通过/拒绝/并发变更保护，以及普通偏好修改免审核。使用离线连接器夹具，不代表真实邮箱认证或收发验收。
- `test/agent-apps.mjs`：持久化/重启、工作区隔离、CAS、取消/删除及待投递失效、删除停止循环任务/重启不再投递、关联目标删除后取消、内置旧版本升级保留数据与偏好、独立同步游标、慢网络不挡提醒、发送去重/不确定恢复、权限/撤销、会话回复来源、升级保护、公共 RSS 地址、CLI 参数/错误；Windows/macOS/Linux 凭据策略模拟。
- `test/unit/agent-app-actions.spec.tsx`：提醒取消与删除的区别、专用图标、最新记录版本、删除失败保留详情、完成/恢复按状态切换、提醒表单取消不写入。
- `test/unit/phone-feishu-setup.spec.tsx`：一个机器人接入入口、不生成绑定码/不选会话、已有通知偏好可编辑、独立扫码及工作区隔离、晚到状态不覆盖已连接事件、错误重试/取消、对话自动出现在列表、正文发送固定当前对话。按用户要求，本次只更新用例并类型检查，UI 留给用户验收。
- `test/phone-feishu-accounts.mjs`、`test/lark-cli-run.mjs`、`test/agent-apps.mjs`：已通过本次定向回归，覆盖无任何会话时启动监听、普通私信直接入库、精确 @机器人过滤、重复事件、重连期间已接收消息保留、停用/权限撤销保留、工作区隔离、重启持久化和 CLI 名称/身份参数；普通单条外发零 reviewer、零人工确认由 app-send-safety 单独覆盖。旧显式绑定接口的兼容测试继续保留。
- `test/e2e/phone-feishu-setup.spec.ts`：生产接收服务用事件夹具自动保存私信/@群目标及消息，再由 Electron/原生 IPC 读回并显示对话，编辑通知后核对持久目标；扫码/远端事件是夹具，不发送消息。本次同步更新但依用户要求未运行，原截图不代表新流程验收。
- `test/unit/agent-phone.spec.tsx`、`agent-phone-panel.spec.tsx`：未知 App 自动打开、打开观察不暂停/连续事件与旧回执不中断展示节拍、真实记录/错误显示、编辑草稿保护及自动恢复、翻转层保留和快速反转、无背景/无工具栏、调度正文可交互、310px覆盖定位与视口边界、全局浮层栈下收起与焦点恢复；机身三键无重复图标且返回/Home/搜索可操作；保留收起/切区/后续回合、总开关、连接表单、查询乱序、邮箱分栏、短信导航、有界展示队列。
- `test/e2e/agent-apps.spec.ts`：真实 Electron/生产工具执行器/IPC/存储/组件，仅模型服务为确定性测试服务。通过模型工具安装未知“观察笔记”、调用后自动定位、iframe 读回、人工编辑再由模型读回，并切到待办详情展示实际新记录；提醒真实点击取消/删除、工具删除后返回列表、深浅主题/窄布局操作栏及表单图标。检查机身图片三键位置的实际命中区域、正常/悬停/按下透明样式、搜索鼠标/键盘激活及返回；手机覆盖调度面板、无背景/工具栏、调度输入继续可用、隐藏滚动条但滚轮可用、滑入滑出及旧磁贴翻转的中间帧、减少动态效果。
- 定向工具目录/技能供给/注入/动画回归与原有 mailbox-scheduler 准入用例已运行。此前手机专项具有 Windows 真 Electron 证据；此前生命周期/安全门专项当时没有重启或真机 UI 验证，macOS/Linux 仅代码与模拟验证，未真机运行。
- 当前截图和数据证据：`.tmp/ui-captures/agent-apps-correction/`；每次 E2E 使用独立临时 userData/工作区，不接入个人账户、不发送真实消息。

原手机在 Windows 已验证专用飞书机器人扫码、凭据保存、群内 @ 消息从 CLI 持久化、IPC 回读及重启后的收件状态。显式 CLI profile 的 whoami 确认当时调度和手机机器人使用不同 AppID。此前也验证过 163 IMAP 只读收信、持久化与 SMTP 认证，飞书发送有用户反馈及本地 sent 记录。原有手机是真实账号的历史证据。IMAP 初次收取最近 50 个 UID，之后每批最多 50 封。飞书历史分页每批 50，编辑和撤回仅在本次同步覆盖到时更新。旧查询支持 offset 分页，limit 为 1–200，offset 为 0–1,000,000。原手机邮箱支持附件元信息，完整线程、附件传输、其他服务端文件夹和邮箱 OAuth 仍见 应用平台实施计划。

## 本地生命周期合同

RSS v4、邮箱 v2、短信 v2 增加删除本地记录及 unread/unprocessed，RSS 另有 unsave。状态按钮复用固定 patch 的当前值过滤与 WP 交互；空布尔值仍视作 false。删除不调用远端删除或消息撤回。取消订阅保留文章，停止刷新及这些文章尚未提交的通知。

新装和定义升级校验每个集合具有同集合、宿主视图 commands 可达的 records.remove；固定 patch 必须有可达反向命令或可编辑恢复表单。历史自建定义加载不强制重写，内置版本升级保留数据、启停、账户授权与通知偏好。

删除清理所有请求回执中的该记录正文；发送回执保留防重试事实。sending/uncertain 记录拒绝删除，必须先核对远端结果。同步和飞书事件接收共同检查工作区内按 App、连接/来源隔离的 SHA-256 删除标记。最多保留最近 10,000 个身份哈希，不保存正文；超出上限被淘汰的历史身份在来源重放时可能重新导入。这是有界去重保留策略，不承诺无限历史屏蔽。

此前生命周期专项的 6 项 Apps 后端回归通过：agent-apps、agent-apps-lifecycle、agent-apps-mailbox-tools、agent-apps-imap、agent-apps-rss-network、app-send-safety。覆盖删除重启与来源重放、混合通知批次、10,000 标记上限、状态恢复与定义迁移、普通单条发送零 reviewer/零人工确认，以及邮箱凭据/权限高危审核和审核后 CAS。其证据为离线连接器/宿主夹具；当时未运行组件用例或重启工作台。人工路径：手机分别进入文章、邮箱草稿/收件/已发、短信详情删除；重开手机并刷新来源；逐项切换已读/未读、已处理/未处理、收藏/取消收藏；停用提醒再设置，确认已投递通知不重放。

Fixed multi-field boolean patches require a reachable command reversing the entire vector, or a genuinely usable editor. Arbitrary text/number patches require an editor because another fixed value does not restore prior input. Mail draft-only editing cannot substitute for reversing received/sent record status.

Local removal, linked-reminder cancellation and unsubscribe remove only matching record identities from pending batches; unrelated batch members retain delivery. Re-enabling a cancelled overdue reminder requires an explicit dueAt instead of implicitly replaying its previous occurrence. A future dueAt can be retained when re-enabling.

Model saveMailbox validates the prepared connection and CAS before authorization. New accounts, credential changes, grant changes, re-enabling and server/identity/TLS changes pass independent high-risk safety review; ordinary rename, notify/hint or disabling edits retain routine execution. After review the host rechecks the previous connection configuration and revision (excluding background lastSyncAt/lastError); an intervening edit or another creator of the same id requires reload. Safety approval never replaces account permission validation.

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：调度 AI 的手机应用（待办/提醒/IMAP 邮箱/RSS/飞书短信），人与 AI 操作同一份持久数据；host.apps.run 为调度专用，Worker 不开放；已有手机飞书连接保留独立 profile，通过统一 Channel 读取和授权。
- 为什么这样设计：持久事务+CAS+outbox 三态独立（同步/通知/已读/已处理分别记账）；发送 requestId 幂等、uncertain 不自动重发需核对远端；外部内容一律非可信 data 不扩权限；安装/启用/邮箱凭据高危改动走安全审批门且审批后 CAS 复核；凭据 safeStorage 加密、后端不可用拒存绝不降明文。
- 明确不做：短信不是运营商 SMS；不建第二份日历数据；宿主关闭期间消息不承诺补收；无离线云执行承诺；附件下载/发送、完整邮件线程、邮箱 OAuth 等扩展项已记录在实施计划（路线图，非歧义）。
- 歧义点：自定义 App 能力边界——sandbox iframe 禁网络/无任意后端 JS/无原生能力，完整权限程序归受信任扩展——A=长期锁定（受控 App 永不获得网络与任意后端，静态样式检查只管视觉不放开 JS）／B=未来开放分级权限。推荐 A——「业务写操作保留在宿主命令按钮」的信任模型依赖此边界，放开需重设计权限面。
