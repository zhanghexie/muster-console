# 网页访问（Web Access）

## 功能职责

同一份 Electron 主进程继续承担全部业务逻辑（会话/PTY/GUI Worker），额外开一个
HTTP+WebSocket 网关：浏览器打开网页后拿到与桌面壳等价的 `window.api`，可以远程
使用会话功能（会话列表、终端、GUI 聊天）和桌面布局的扩展面板。共享的主进程事件通过
中继广播，扩展面板事件按实例归属投递给对应的连接。

渲染产物缺失时，已鉴权入口返回的开发引导页按宿主当前语言显示；其 token 仍只向已鉴权请求返回。网页端调用内置浏览器时，网关按当前语言提示到 Muster 桌面应用继续操作。其他受限或不存在的 IPC 通道在错误提示中保留通道名。

设置、Git、文件面板等未做专门适配：invoke 通道全通所以大多能用，浏览器硬伤处
（见「已知边界」）自然降级。

## 关键文件与入口

网关由 Runtime Kernel 的 `host-entrypoints` 域实际启动。退出先停止 HTTP/WS 新请求受理，随后退休会话域，最后回收连接并等待已受理的 HTTP 请求与 WS invoke 完成；关闭 socket 本身不代表宿主调用已结束。`WebAccessServer.stop()` 返回这一完整屏障，关闭失败保留服务引用供重试。浏览器服务与截图清理器和网关共用域 scope，截图清理等待当前 sweep 完成。

| 文件 | 职责 |
|------|------|
| `src/main/webAccess/server.ts` | `WebAccessServer`：HTTP 静态服务 `out/renderer` + WS `/ws`（invoke 关联/事件广播/推送帧/send 白名单）+ token 鉴权 + `/media/*` 字节路由 + `/hook/*` 分流；`bindNotifyBus` 接看板翻转推送（T1.2），`pushSubscription` 为离线 Web Push 预留位（只存不发）；凭证变更经「准备新值→原子持久化→发布/撤销」统一入口 `commitCredential`（R2，审计 2026-10-02） |
| `src/main/webAccess/credentials.ts` | 凭证存储独立模块（R2）：`web-access.json` 三态读取（缺失/损坏/读取失败）+ tmp+fsync+rename 原子写并返回成功判据；保留未知字段与 pushSubscription；无 electron 依赖，可独立测试 |
| `src/main/webAccess/hookRoute.ts` | `POST /hook/<hookToken>` 使用独立 token。GitHub PR、评审与 CI 事件要求 HMAC，GitLab 要求 Secret。鉴权后归一并把原载荷与投递 ID 交给事件日志和订阅路由。 |
| `src/main/webAccess/hookVerify.ts` | `verifyHubSignature256(secret, rawBody, header)`：恒时比较的 GitHub 签名校验纯函数（T3.2） |
| `src/shared/webhookPayload.ts` | GitHub 和 GitLab webhook payload 归一（issue/comment 等 → 事件数据）纯函数 |
| `src/main/webAccess/relay.ts` | `attachEventRelay(win)`：包装主窗口 `webContents.send`，主→渲染事件（`IPC_EVENT_CHANNELS` 白名单内）同步广播给 web 客户端 |
| `src/main/webAccess/ws.d.ts` | ws 的最小类型声明（不引 @types/ws） |
| `src/main/ipc/handle.ts` | CapabilityRegistry 共用入口；服务端生成 caller，dispatch 校验存活、PermissionGate 与 Web policy，嵌套转发保留身份和 correlationId；最近 200 次元数据审计不保存调用参数。`ipc/accessPolicy.ts` 统一网关与内部嵌套调用的 Web 禁用规则 |
| `src/main/workspaceFsProtocol.ts` | 协议 handler 处理体抽为 `handleWorkspaceMediaRequest(ctx, schemeUrl, request)` / `handleExternalFileRequest(schemeUrl, request)`，Electron 自定义协议与 web 网关共用 |
| `src/main/workspacePreview.ts` | HTML 沙箱使用的随机只读源根地址；版本/目录身份检查、释放与有效期，不授权 IPC |
| `src/main/index.ts` | createWindow 时 `attachEventRelay(win)`；启动链尾（registerIpc 之后）`webAccessRef.start(ctx)` + `bindNotifyBus(notifyBus)`（看板翻转→推送帧）；before-quit `stop()` |
| `src/renderer/src/webApiShim.ts` | 浏览器里的 `window.api` 替身：两层 Proxy 把 `ns.method(...)` 映射到 invoke 通道，`on()` 走网关事件；心跳半开重连 / 可靠 outbox / last-good 候选 / token 只认 query+Cookie；必须在 `main.tsx` 第一个 import（ES 求值顺序先于 i18n/theme） |
| `src/shared/randomUuid.ts` | 渲染层 UUID：优先使用原生 `randomUUID`，普通 HTTP 远程页面使用 `getRandomValues` 生成 UUIDv4；无安全随机源时显式失败，不降级为 `Math.random` |
| `src/shared/wsProtocol.ts` | WS 控制帧（hello/filter/ping/pong）、caps 过滤、send 可靠性与 outbox、token 解析、候选地址、心跳常量——shim 与 server 共用契约 |
| `src/shared/webApiPacking.ts` | `ARG_PACKERS`：桌面位置参数 → 主进程单对象 payload（steerOnBusy / editQueued / reorderQueued 等字段齐全） |
| `src/renderer/src/components/settings/RemoteAccessSettings.tsx` | 设置「远程访问」页：「用网址打开」扫码主卡（二维码 + 首选网址 + 提示，其余网址收进「其他网址」折叠）、「安全」区（重新生成 Token）、飞书小节（原 FeishuSettings 内容）、Webhook 折叠 |
| `src/renderer/src/onboarding/ConnectRemote.tsx` | [首次设置](first-run.md)按需显示扫描二维码和复制连接地址，支持稍后连接与网关失败反馈 |
| `src/main/ipc/app.ts` | `webAccess:status`（状态+URL+推荐地址二维码 dataURL+hook 信息）/ `webAccess:rotate`（换 token 踢客户端；落盘失败时 ok=false 保留旧凭证，R2）/ `webAccess:rotateHook`（换 hook token）/ `webAccess:setHookSecret`（设置/清除签名密钥；同判据） |
| `test/web-access.mjs` | e2e：构建产物 + dev 沙箱拉起真实应用，浏览器视角全链路（需先 `npm run build`，手动跑，已进 run.mjs EXCLUDE） |
| `test/web-stability.mjs` | 集成：最小 WS 服务端/客户端验证 ping/pong、caps 过滤、可靠 send 重发（listen(0)，进 npm test） |
| `test/e2e/workspace-file-roots.spec.ts` | 独立 Electron 沙箱/随机本机端口：Ref 版文件 API 在浏览器经 WS 调用，版本化媒体 HTTP 转发与 Range/206 |
| `test/e2e/web-insecure-uuid.spec.ts` | 独立 Electron 沙箱与普通 HTTP 浏览器：文件、搜索、GUI 历史、内置浏览器拒绝提示及收藏新标签页 |
| `test/e2e/web-extension-panel.spec.ts` | 独立 Electron 沙箱与 Chromium 验证工作日报资源、待办交互、跨面板事件、重载、重连与关闭 |
| `test/ws-protocol.mjs` | 纯函数：心跳/caps/outbox/token/候选地址 |
| `test/web-api-packing.mjs` | 纯函数：ARG_PACKERS 字段矩阵 |
| `docs/plans/implemented/web-access-plan.md` | 实施设计（架构决策与理由） |

## 数据流 / 通道

```
浏览器 ──HTTP──▶ WebAccessServer（主进程内，默认端口 7950）
  GET /             → 入口页（要求 token：未授权 401——dev fallback 页内嵌 token 明文）+ 静态服务 out/renderer（./assets 相对路径任意挂载点可用）
  GET /media/ws/<id>/<enc-rel>  → 拼回旧单根协议 URL（旧扩展地址固定绑定管理根）
  GET /media/ws/workspace/<enc-rel>?v=2&workspaceId=…&rootId=… → 保留查询参数，复用 FileRef/realpath 校验与 Range 服务
  GET /media/ext/<enc-abs>      → 拼回 muster-ext://f/<enc-abs>（工作区外只读）
  GET/HEAD /media/preview/<随机地址>/<enc-rel> → 限定源根只读资源，HTML 沙箱无需完整 token/Cookie
  GET/HEAD /media/extension/<面板令牌>/view/<包内路径> → 扩展面板已审核资源；`__sdk__/` 提供该面板的 SDK
  POST /hook/<hookToken>        → webhook 事件接收（独立 token、GitHub PR 类事件必验签、GitLab 必填密钥）
  WS /ws?token=     → 文本帧 JSON：
    C→S {t:'invoke', id, channel, args} → S→C {t:'result', id, ok, result|error}
    C→S {t:'send', channel, args}       → ipcMain.emit（白名单见下）
    C→S {t:'hello', caps:{terminal?, stream?}}  → 兴趣声明（重连后重发；未声明=全量）
    C→S {t:'filter', drop:[channel,…]}          → 显式丢弃列表（整表替换 hello 派生的 drop，非并集）
    C→S {t:'ping'} / S→C {t:'pong'}             → 应用层心跳（半开检测）
    S→C {t:'event', channel, payload}   → 广播（webContents.send 单点包装分叉；按 caps 过滤）
    S→C {t:'push', type:'session-status', sessionId, phase, label}
                                        → 看板翻转推送（NotifyBus 决策通过时，
                                          phase 为 needs_you/done/error 触发类）
```

帧/可靠性/caps/候选地址契约在 `src/shared/wsProtocol.ts`（畸形控制帧静默丢弃），invoke 打包表在
`src/shared/webApiPacking.ts`（shim 与 server 共用）。服务端对**全部输入帧**先过 `parseClientFrame`
结构解码（合法 JSON 但非协议对象——null/数组/标量/字段类型不对——一律静默丢弃，不进入业务分派；
R1，审计 2026-10-02），解码后的类型化分支才执行带鉴权/owner 语义的分派；message 回调带局部
失败收尾（意外异常记日志并释放该连接，不透传全局）。已被吊销（token 轮换后 close 在途）或已断开
的连接不再受理任何帧。

HTML `srcDoc` 保留不开放同源的沙箱，无法依赖父页 SameSite Cookie。已鉴权父页通过 `fs:createPreview` 创建最多 64 个、固定 1 小时有效的源根只读地址；子资源只接受 GET/HEAD，每次检查根版本、realpath 与目录身份，离开/编辑/切根由 `fs:releasePreview` 撤销。地址不包含完整网关 Token，也不能调用 IPC；普通 `/media/ws`、`/media/ext` 仍要求原有鉴权。资源范围与边界见 [文件预览](file-preview.md)。

扩展面板通过 `extensionSurface:open`、`extensionSurface:call`、`extensionSurface:reload` 和 `extensionSurface:close` 复用桌面宿主。网页 shim 显式映射 `openExtension`、`reloadExtension` 和 `closeExtension`，其参数与桌面 preload 一致。宿主用 `ipcCaller` 将 `extensionSurface:event` 直接投递给打开面板的连接。每个连接使用自己的面板令牌，共用同一工作区的扩展运行时和业务状态。

网页网关按 WebSocket 归属校验面板调用、重载、关闭和摆放。`/media/extension/` 用有效的面板令牌授权沙箱 iframe 的 GET/HEAD 请求，复用宿主的包指纹和路径校验。资源采用 `no-store` 和 `Referrer-Policy: no-referrer`，模块和字体可从不携带登录 Cookie 的沙箱加载。网页面板可放在当前屏或右侧标签页，原生独立窗口由桌面应用提供。

关闭、断线、网关停机或登录令牌轮换都会撤销对应的资源地址并释放面板。连接断开时仍在打开的面板在完成后立即回收。重连后，网页为当前打开的扩展重新创建面板，并从宿主读取当前业务状态。手机布局使用单独的导航，见 [手机端表面](mobile-surface.md)。

- **invoke**：默认按 `ns:method` 命名，shim 里 `CHANNEL_OVERRIDES` 存例外
  （`sessions.delegate→tasks:delegate`、
  `agentSession.historyRange→agentSession:getHistoryRange`、
  `workspaces.listFiles→workspace:listFiles`、`app.bootWait→app:boot:wait`、
  `app.logDir→app:log-dir`、`usage.llmCall→usage:llm-call`）。多位置参数通道由
  `shared/webApiPacking.ts` 的 `ARG_PACKERS` 打成主进程单对象（尤其
  `agentSession:send` 必须带 `steerOnBusy`、`editQueued`/`reorderQueued` 字段齐全）。
  GUI 会话历史保持桌面端的位置参数顺序 `sessionId, before, limit, targetMessageId`。
  invoke 客户端超时 **30s**（`INVOKE_TIMEOUT_MS`）后 reject 并清 pending，半开时 UI 不永久转圈。
- **send 语义通道**：preload 里走 `ipcRenderer.send`（`ipcMain.on` 注册、不在 handle
  注册表）的三条由 shim 特判为 `{t:'send'}` 而非 invoke：`pty.input`、`pty.resize`、
  `sessions.touchUsed`；动态回执 `confirmRespond`/`dialogRespond`/`terminal.replyCapture`
  同理。曾因全部映射成 invoke 被网关「无此通道」静默拒绝——终端输入失效，见 2026-09-06 journal。
- **send 白名单**：`pty:input`、`pty:resize`、`sessions:touch-used` + 动态回执前缀
  `ui:confirm:` / `ui:dialog:` / `terminal:capture:`。
- **可靠 vs 不可靠 send**（断线语义，`shared/wsProtocol.isReliableSend`）：
  - **可靠**（动态回执 `ui:confirm:` / `ui:dialog:` / `terminal:capture:`）：进 outbox
    且 **onclose 不清空**，重连 onopen 重发（至少一次；`ipcMain.once` 重复 emit 可接受，
    requestId 幂等先到先得）。flush 中途 `send` 抛错则当前及之后保留在 outbox。累计
    失败超 `RELIABLE_FLUSH_ATTEMPTS_MAX` 才放弃并给用户可见 note。
    边界：**发送瞬间 ws 已 OPEN 的帧不进 outbox**（浏览器 send 只缓冲不抛错）——TCP
    恰在其后半开死亡时该帧丢失不补发，由心跳半开检测（阈值 50s，加检出粒度最坏约
    75s）重连兜底；outbox 有界（`OUTBOX_MAX`），极端积压下最旧的可靠帧也可能被挤掉。
  - **不可靠**（`pty:input` / `pty:resize` / `sessions:touch-used`）：断线时丢弃；
    发送时若已非 OPEN 仍入 outbox，重连后尽量送达（pty 输入丢一点可接受）。
- **心跳 / 半开检测**（`shared/wsProtocol`）：
  - shim 每 `HEARTBEAT_INTERVAL_MS`（25s）发 `{t:'ping'}`；超过约 2 个周期
    （`HEARTBEAT_TIMEOUT_MS`）没收到任何帧/pong → 主动 close 走重连。
  - server 回 `{t:'pong'}`，并对每连接 `isAlive` 标记 + 协议层 `ws.ping()` 周期扫表，
    连续无 pong 则 `terminate()` 清僵尸（`broadcastRaw` send 抛错也会 terminate 并摘出）。
- **事件兴趣过滤**（弱网防洪泛）：客户端可 `{t:'hello', caps:{terminal,stream}}` 或
  `{t:'filter', drop:[…]}`。手机 shim 默认 `terminal:false, stream:false`（丢
  `pty:data` 等与 `agent:token`/`agent:thinking`，保留 `agent:message`/`agent:history`
  对账）。**未声明 caps 的客户端保持全量**（桌面 web / 旧客户端向后兼容）。
- **推送帧**（T1.2，与事件广播分流）：主进程 `NotifyBus` 决策通过的看板翻转
  （仅 →needs_you/→done/→error 且写入源可信，45s 账本去重/免打扰/隐藏会话拦截，
  决策矩阵见 [notification-system.md](notification-system.md)）由 `bindNotifyBus` 构造
  `{t:'push', type:'session-status', sessionId, phase, label}` 广播给全部已鉴权客户端；
  `label` 是主进程拼好的「会话名 · 触发文案」，手机端直用不二次本地化。帧解析/词表
  契约在 `src/shared/webPush.ts`（畸形帧 shim 侧静默丢弃）。离线 Web Push 刻意不做：
  `web-access.json` 仅预留 `pushSubscription` 存储位（token 轮换不洗掉，将来接
  Web Push 协议从这里读）。
- **invoke 黑名单**（web 侧拒绝）：`workspaces:pickDir`（原生对话框
  弹在宿主机上，web 用户无法操作）、`app:quit`，以及 `browser:*` 整组前缀（内置浏览器依赖 Electron）。
  网页访问的收藏栏在访问设备的新标签页打开 HTTP(S) 收藏。网页端跳过内置浏览器初始化，选中内置网页标签或宿主文件收藏时提示在桌面应用中打开。
  同族原生对话框三通道 2026-10-25 起一并拉黑
  （reliability/web-access F-01）：`app:pickWallpaper`、`capabilityManagement:pickDirectory`
  直接入名单。`shell:openPath` 仅允许桌面调用，网页端不能启动宿主机上的文件或应用。
  旧扩展安装/更新通道 `workbench:managePackage` 已删除，网页端也不能调用。
  `git:invokeScoped` 按其实际 Git 方法
  检查同一名单，不能经包装入口打开原生选择器；shim 将可变位置参数打包为 args 数组，
  与桌面 scoped IPC 相同，Git 服务校验发起工作区 ID/根版本及本区仓登记。
- **鉴权 / token**：token **持久保存**（启动时复用 `userData/web-access.json` 里的旧值，重启后
  网址/书签不变；文件缺失/损坏时生成新 token 并落盘——旧盘面已不可用，覆盖是唯一安全路径；
  **读取失败（EACCES/EIO 等）则停用远程服务并原样保留盘面**，磁盘/权限故障恢复后重启即回旧
  状态，不意外轮换也不丢字段；启动路径任何必要落盘失败同样停用并在设置页展示原因，不带病运行）。换 token 的唯一
  途径是设置页「重新生成 Token」（`webAccess:rotate`）。轮换/设置以**原子落盘成功为判据**
  （tmp+rename，R2）：写盘失败时 IPC 显式返回失败、内存/磁盘/连接均保持旧状态（旧 token 继续
  生效，不误导「已撤销」）；写盘成功才发布新 token 并**立即吊销全部旧连接**（新 invoke/send
  即刻拒绝，不等异步 close 握手完成；close 4001 通知客户端清 Cookie 重扫码，在途请求的取消
  不属于本合同）。同一 `web-access.json` 还持有 webhook 端点用的 `hookToken`/`hookSecret`（T3.2，
  见 [runtime-status.md](runtime-status.md) 的订阅与投递节），轮换只动自己的字段（hook 轮换
  不改网页 token 与 rotatedAt），未知字段与 pushSubscription 原样保留。
  设置 →「远程访问」页
  展示全部可用地址（含 token）与推荐地址二维码，可一键复制（推荐地址=组网/局域网等远程可达地址优先：Tailscale 等 CGNAT 100.64/10 > 私网 > 其他，127.0.0.1 垫底——扫码端是别的设备，回环地址只对工作机自己有效）。
  **客户端 token 来源**（`shared/wsProtocol.resolveWebToken`，**不写 localStorage**——
  轮换后旧 token 粘住会 4001）：`?token=` query > Cookie `ma_web_token`（连接成功后
  写入，SameSite=Lax，使 `<img>` 媒体请求免带 token）> 空（提示缺 token，visibility/online
  再解析）。`?ws=` 基址仍可存 localStorage。HTTP 另接受 Bearer 头。
  错 token 以 close code 4001 拒绝：shim **清 Cookie**、提示「请用新链接或扫码打开」，
  冷却约 **5s**（`TOKEN_REJECT_COOLDOWN_MS`）后重试；若 URL `?token=` 与当前不一致
  （用户已用新链接打开）则**立即**换 token 重试不空等。rotate 后旧设备须重扫码/新链接
  打开（旧 Cookie 不再有效）。免鉴权静态面收敛为**仅 `/assets/*`**（内容 hash 无密，
  web-access F-02）；其余一切根级路径——入口页（`/` 与 `/index.html`，含构建产物未命中时
  的 dev fallback 形态——页内嵌 token 明文）以及未来新增的任何根级产物（version.json、
  配置快照等）——与普通 `/media/ws`、`/media/ext` 同口径要求 token；文件预览使用独立的只读源根令牌。未授权的其他请求返回 401，不再随 serveStatic 对 out/renderer 全放行。
- **端口被占（P14）**：优先绑默认 **7950**（`MUSTER_WEB_PORT` 或本实例 `userData/instance-ports.json` 可覆盖）。占用时改系统分配端口并落盘该实例 userData，桌面不受影响。调度用 `app.instances()` 看各实例 pid/端口/AUMID。e2e 夹具设 `MUSTER_INSTANCE_ID`，Windows AUMID 加实例后缀，避免与用户实例同名。
  注意 ws 库会把 http server 的 error 中继到 WebSocketServer，WSS 上必须挂 error 监听。
- **WS 地址解析**（shim，`shared/wsProtocol` 候选状态机）：`?ws=` 覆盖 > localStorage > 默认候选（页面由网关服务
  （:7950）时同源直达；否则先同源再同主机 7950——覆盖 vite dev 5188 场景），
  连上的地址写回 localStorage。**last-good 优先**：onopen 成功过的 base 在后续重连
  先试它，失败才轮换其它候选；若 `?ws=`/localStorage 覆盖地址是唯一候选且连不上，
  回退并入 `defaultCandidates()`（旧 IP 不粘死）。`document.visibilitychange`
  （回 visible）与 `window` `online` 时若 ws 非 OPEN，取消退避立即 `connect()`
  （手机锁屏回前台主场景）。无 token 时标记状态并周期/唤醒后再试，不永久静默。

- **启用与关闭**：默认开启，绑 `0.0.0.0:7950`（占用则动态端口并落盘）；环境变量 `MUSTER_WEB_PORT` 换端口（含 `0`=系统分配）、
  `MUSTER_WEB_HOST` 换绑定（如 `127.0.0.1` 只本机）、`MUSTER_WEB=0` 关闭。
  连接地址与二维码在 **设置 →「远程访问」** 查看；启动日志也会打印带 token 的 URL。
- 网关启动失败（端口占用等）只记日志，不影响桌面使用（设置页会显示原因）。
- dev 用法：`npm run dev` 照常跑（此时网关下无构建产物，`GET /` 返回引导页），
  浏览器开 `http://<本机IP>:5188/?token=…`（token 从设置页或日志取），shim 自动连
  7950 网关。

## 交互与已知边界

- HTTP 远程地址不是浏览器安全上下文，可能没有 `crypto.randomUUID`；文件视图、搜索等渲染层调用统一走 `randomUuid()`，仍使用浏览器的安全随机数。修复不改变 HTTP 明文传输的安全边界。
- **安全模型**：HTTP+WS 明文 + 单 token，仅限可信局域网；拿到 token 等于拿到
  桌面应用的全部能力（含 fs 读写/命令执行）。webhook 端点（T3.2）另发独立
  hook token；GitHub 签名可选，GitLab 强制校验共享 Secret token。路径和密钥泄露仍可能触发
  具有本机权限的任务；项目 ID 是路由过滤而非独立凭据。应在可信内网使用 TLS / 加密隧道并限制来源。
- **多客户端**：与桌面单窗口语义一致，全局共享 `activeId`——一端切会话所有端跟着切。
- **窄屏（手机）**：手机浏览器（移动 UA，或触摸主指针 + ≤820px 视口）进入独立的
  **手机端表面**（[mobile-surface.md](mobile-surface.md)）：三级页面栈（工作区列表 →
  工作区详情 → 对话页），浏览器返回手势/返回键弹栈；桌面窄窗口（鼠标）仍是
  `responsive.css` 抽屉布局，两套互不干扰。
- **浏览器内核要求**：入口产物含较新 JS 语法（模块脚本、逻辑赋值、疑似顶层
  await，实测底线约 Chrome 89+）；微信内置浏览器（X5）/ 旧系统 WebView 解析失败
  会**永远停在启动骨架屏**。骨架屏自带自报错：入口脚本报错或 25s 未挂载时，屏上
  直接显示失败原因 + UA（index.html 内联脚本，不依赖任何外部资源）。
- **拖拽**：拖文件进聊天/终端拿不到绝对路径（浏览器安全模型）、文件树拖出 no-op。
- **终端截图**（`app:captureRect`）无浏览器等价物，依赖它的功能降级。
- **剪贴板**：非安全上下文（http://局域网IP）下 navigator.clipboard 不可用；
  输入框原生 Ctrl+V 不受影响。
- **断线**：事件不补发，重连后靠下一次操作/事件自然对账（或 `agent:history` 对账）；
  pending invoke 会 reject（另有 30s invoke 超时）。**可靠 send**（审批/对话框/终端
  截图回执）进 outbox 重连重发，**不可靠 send**（pty 输入等）可丢——见上文可靠 vs 不可靠。
- **聊天发图**不受影响：AgentComposer 走 FileReader dataURL，浏览器原生可用。
- **i18n**：shim 的连接浮条刻意不走 t()（本模块先于 i18n 求值），文案中英双写；
  已在 `test/i18n-coverage.mjs` ALLOWLIST 登记理由。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：浏览器打开网页获得与桌面壳等价的 window.api（会话/终端/GUI 聊天远程可用）；桌面 IPC 路径完全不变，事件单点分叉广播给 web 客户端。
- 为什么这样设计：token 持久+原子落盘成功判据（写失败保持旧状态不带病运行）+轮换立即吊销旧连接；send 可靠/不可靠分型+outbox 重发；invoke 黑名单（原生对话框四通道含 managePackage 条件拒绝/app:quit/browser:*）；caps 兴趣过滤防弱网洪泛；HTML 沙箱只读源根地址不含完整 token 也不能调 IPC。
- 明确不做：离线 Web Push 刻意不做（仅预留 pushSubscription 存储位）；事件不补发靠重连对账；设置/Git/文件面板不做专门适配（invoke 全通自然降级）。
- 歧义点：安全姿态——HTTP+WS 明文+单 token，拿到 token=桌面应用全部能力（含 fs 读写/命令执行），依赖「可信局域网/Tailscale」前提——A=长期接受明文（安全边界靠组网层加密+设置页「暴露公网风险」提示；上 TLS 需证书管理、局域网收益低）／B=排期上 HTTPS/更强鉴权。推荐 A，但该前提必须保持为明示产品边界而非默认假设。
