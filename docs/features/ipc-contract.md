# IPC 通道面与返回值合同

> 状态：合同规范 v1（2026-10-25 依可靠性专项 X4-IPC面完整性 F-05 批复立规范——不做一次性大改，规范约束新通道与既有通道触碰时对齐）
> 代码主入口：`src/main/ipc/handle.ts`（统一注册入口）
> 关联：`src/main/ipc.ts`（域注册链）、`src/main/ipc/rendererRequest.ts`（主→渲染一次性请求）、`src/main/webAccess/server.ts`（web 网关复用）

## 1. 注册面与通道注册表

- **统一入口 `handle()`**：所有桌面 IPC 通道经 `src/main/ipc/handle.ts` 的 `handle(channel, fn)` 注册，不做 `ipcMain.handle` 直连。包装层提供三件事：重抛前统一记 `[ipc] <channel> failed:` 日志（渲染层大量 `void window.api.x()` 调用点的主进程侧唯一现场）；维护**通道注册表**（重复注册立即 throw 并带通道名）；`invokeIpcChannel`/`hasIpcChannel` 供 web 网关以合成 event 复用同一批 handler——不经 `handle()` 注册的通道进不了注册表，网关与对账守卫都看不见。
- **扩展面板方法登记**：`src/shared/extensions.ts` 的 `EXTENSION_PANEL_METHODS` 和 `isExtensionPanelMethod` 是 preload、web SDK、IPC 与 Host 共用的 typed method registry。`ui.confirm`、`agent.send` 和其他面板 SDK 方法都必须先登记，`extension:panelCall`、`extensionSurface:call` 在到达扩展代码前拒绝未登记方法，新增方法必须先补登记和回归测试。
- **注册链**：`index.ts` 启动时先挂 3 个早期自救通道（`app:boot:wait`/`app:relaunch`/`app:log-dir`），再按 `ipc.ts` 的 entries 注册表逐域注册（当前 27 个常驻域 + feishu 条件域；每域作为一个 Runtime Kernel 服务域 `ipc:<id>` 注册，顺序即中断波及面：任一域注册期 throw，其后所有域不注册）。
- **通道身份**：`ipcCaller(event)` 提供宿主注入的桌面 sender 身份或 WebSocket 连接身份。需要向调用者推送事件的通道可使用 `sendEvent`，如扩展领域事件。渲染层参数不可指定连接身份或事件目的地。
- **寄信展示**：`mailPresentation:viewport` 和 `mailPresentation:depart` 限主工作台窗口主帧。上飞请求只释放同一寄件视图下由宿主签发的待寄 ID。寄件地址、正文和权限来自原寄信调用。收件界面收到 `messages:activity` 时，邮件已提交到邮箱。
- **第二实例转发**：`app:second-instance` 是主进程锁持有者发给渲染层的 typed event，携带原始 `commandLine` 和 `workingDirectory`。主窗口尚未完成加载时由主进程排队，渲染层对绝对路径直接处理，对相对路径按工作目录解析后复用工作区打开入口。

## 2. 返回值合同规范（核心规范）

- **新通道一律返回 `{ ok: boolean, error?: string }` 或等价的可判别联合（discriminated union）**；富数据通道在 `ok:true` 时携带载荷字段。
- **禁止用裸 `boolean` / 裸 `undefined` 作为「操作失败」信号**：裸 `false` 三义混淆（宿主未就绪 / 目标不存在 / 操作被拒），调用方无法区分，也就无法给用户可行动的提示。
- **失败必须带 `error` 文案**；「宿主未就绪」守护模式参照 agentSession 域既有形态：`{ ok: false, error: 'GUI 会话宿主未就绪' }`（良性 `false` 不带 error）。
- **对外合同**：extension 扩展面板的 `ma.ui.confirm` 返回 `{confirmed, cancelledBy?}`；调用者检查 `confirmed`，不能把整个对象当成布尔值。
- 扩展管理 `extensions:preserveTransaction` 返回 `{ok:true,preservedPath}` 或 `{ok:false,error}`，只在用户确认保留冲突现场后将事务记录归档；工作区和当前事务状态在主进程重新校验。
- 收藏夹 `workspaceBookmarks:read` / `workspaceBookmarks:change` 返回 `{ok:true,snapshot,cleanupError?}` 或 `{ok:false,error}`。读回执可携带迁移清理错误，快照仍可用。修改回执在项目收藏文件写入后返回。

## 3. 遗留形态登记（触碰时对齐，不做一次性大改）

存量约 362 个通道不做专项合同改造（批量改合同的风险大于收益），以下遗留形态在**各自下一次触碰的批次**顺手对齐本规范：

- **裸布尔遗留**：`workflow:delete` 返回裸 boolean（与同文件 `workflow:overview` 返回富对象并存）；themes/extensions/workflow/sessions 各域的删除族同属此类。
- **域文件错位遗留**：`chat:switchModel` 注册于 `src/main/ipc/fs.ts`——chat:* 前缀 12 个通道中 11 个也都在 fs.ts，属域归属整理欠账的历史遗留；位置维持现状（本次不搬），下次触碰该族时再议是否挪回 sessions/agentSession 域文件。
