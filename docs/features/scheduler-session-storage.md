# 调度会话存储

调度聊天的可恢复展示投影按 session 保存为 SQLite。一个工作区可以先使用基础 session，也可以通过 active pointer 切换到一个独立 fork session。Pi 原生会话文件仍由 Pi 存储负责，本功能只保存调度界面需要的消息投影。

## 入口与关键文件

- `src/main/runtimeKernel/schedulerSqlite.ts` 创建数据库、写入消息片段和工具行、分页读取、fork 元数据和时间归档。
- `src/main/runtimeKernel/schedulerSession.ts` 把 `agent:message`、`agent:token`、`agent:thinking`、`agent:tool` 和结构性编辑映射到 SQLite。
- `src/main/agent/orchestrator/buckets.ts` 创建 session adapter，并在生命周期边界保存 metadata 或当前 assistant 的变化。
- `src/main/agent/orchestrator/eventBus.ts` 先写 durable projection，再发布渲染事件。
- `src/renderer/src/components/ChatMessageView.tsx` 识别 `archived`，保持归档回合收起并卸载工具内容。

## 数据流

数据库文件位于 `scheduler-sessions/<session-id>.sqlite`。消息身份、顺序和生命周期在 `scheduler_message`，正文/思考/工具位置在 `scheduler_part`，工具参数和结果在 `scheduler_tool`，API、Pi 文件指针、fork 关系和 revision 在 `scheduler_meta`。正文只保留在 part 表，工具结果只保留在 tool 表。

流式正文合并到相邻 part，工具事件更新同一工具行。重复的 assistant 生命周期快照只更新变化的元数据，不复制工具参数和结果。历史范围按消息 ordinal 直接分页，冷浏览不创建执行 bucket，也不需要完整重放。

## 时间归档

超过 `STALE_TURN_MS` 且已经完成的 assistant 回合会自动归档。归档保留最终正文、工具 ID/名称/状态和必要元数据，清除 thinking、工具参数、结构化输入、完整结果、预览路径和 patch。正文为空时才保存短摘要。归档消息带 `archived=true`，渲染层不再提供工具展开入口。

这一步只清理调度 SQLite。Pi 原生 session 文件不读取、不改写、不迁移。

## 已知边界

- 当前是 clean-break 存储格式，旧 scheduler NDJSON 不提供兼容读取或迁移。
- 归档依赖有效 `createdAt` 和完成状态。缺时间戳或未收口的回合不会自动清理。
- 真实 Electron 主进程内存、Windows/macOS/Linux 真机和安装包验证需要单独进行。
