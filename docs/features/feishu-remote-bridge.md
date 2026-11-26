# 飞书远程桥退役与 Channel 接入

独立 `FeishuBridge` 已退役。飞书与其他 IM 共用 [Channel 消息接入](multi-channel-messaging.md)：账号在「设置 → Channels」管理，远程输入在「远程访问 → 远程输入」启用，再从已授权聊天使用 `/ws`、`/s`、`/bind`、`/unbind`。

## 已移除的路径

- 主进程独立桥、启动/停止域、卡片回流、旧会话绑定与自动状态推送。
- `feishu:*` IPC、preload API、状态事件及 `AppConfig.feishu` 运行时配置。
- 桌面会话角标、绑定菜单和命令建议，飞书专属通知偏好与终端截图直发接口。
- 旧桥专用卡片构建器、生命周期及回流测试；通用命令解析迁到 `src/shared/workbenchCommands.ts`，由 Channel 和桌面共同使用。

桌面输入 `/bind` 或 `/unbind` 显示 Channel 操作指引。远程会话选择由来源、发送者和授权代际隔离，不再有全局飞书绑定对象。终端截图只生成本地结果，远程回传由 Channel 原请求的回复路径负责。

## 保留的 Channel 来源适配

`src/main/feishu/larkCli.ts`、`consumerArbiter.ts` 与 `agentApps/feishuAccounts.ts` 仍为已有手机飞书连接提供传输、工作区 profile 与 AppID 消费仲裁。它们不是独立调度桥，收件和远程输入通过统一 Channel 服务处理。旧手机记录、发送回执和跨工作区绑定保持可读，相关路径见 [手机应用](agent-apps.md)。

旧独立桥的全局 `muster` profile 不再自动启动；CLI 接入、收发和监听必须明确指定有效 profile，缺少身份时在启动进程前拒绝并提示在 Channels 重新接入，纯二维码生成不加载该旧 profile。原全局绑定不转为 Channel 操作权限。曾只配置该桥的用户需要在 Channels 中接入账号并重新验证操作人。升级不扫描或删除 CLI 凭据目录，也不直接操作用户私有历史。配置规范化忽略旧 `feishu` 与 `notify.feishuBoundOnly` 字段。

远程页现行 id 为 `remoteAccess`；旧 `feishu` 页面深链仅映射到该页，不恢复旧桥。历史实施记录保留在 `docs/plans/implemented/feishu-*.md`，不能作为当前 Channel 富媒体、互动卡片或远程审批的验收证据。

## 退役验收（2026-11-17）

- 四组 TypeScript 检查通过。定向逻辑 17 个文件通过，覆盖旧配置丢弃、旧 preload/事件移除、通用命令、来源授权、终端截图、CLI 与旧数据兼容。
- CLI 默认账号清除后，`lark-cli-run`、`phone-feishu-accounts` 和 `i18n-coverage` 再次通过；缺失、空白或无效 profile 拒绝且不创建进程，二维码参数不含旧 profile。最终四组类型检查、3 项错误本地化组件用例、再次生产重建及 `phone-feishu-setup` Electron（6.2 秒）通过。
- 7 个组件测试文件共 34 项通过，覆盖旧设置入口和通知选项消失、桌面绑定命令提示、会话角标移除、启动回滚与退出顺序。
- 生产重建后的隔离 Electron `agent-apps`、`logical-channels`、`phone-feishu-setup` 共 3 项通过（39.1 秒）。传输和模型使用替身，未访问真实账号。
- 已查看远程访问与通知页深浅主题、780/390px 的 8 张截图，复核见 `.tmp/ui-captures/retire-feishu/review.md`；无横向溢出或旧桥入口。
- 初次较宽定向运行发现 `composer-helpers.mjs` 原有 token 格式断言期待 `98k`，当前实现返回 `100k`，与本次删除无关，未扩大修改该行为。此次命令菜单与手动输入路径由 `channel-desktop-commands.mjs` 和实际组件回归覆盖。

本机为 macOS；上述是代码、模拟和隔离 Electron 验证。真实飞书账号及 Windows/Linux 真机尚未验收。
