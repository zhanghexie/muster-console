---
doc_type: feature
---

# 扩展 current Agent 资源

`src/main/extensions/extensionAgentResources.ts` 提供扩展 Agent 会话的实例级资源校验和挂载记录。

## 当前行为

- 只允许声明 `agent` 的 sidebar 扩展挂载资源。
- 系统提示词、Skill 和 MCP 路径必须解析到扩展包根目录内的真实普通文件。
- 系统提示词限制为 64 KiB，Skill 和 MCP 资源单文件限制为 256 KiB。
- MCP 资源必须同时声明 `agent.mcp` 权限，并由调用方传入显式信任状态。
- `trusted-once` 的挂载记录只绑定当前 Agent Session；Pi 释放时关闭该 Session 的 MCP 客户端，Runtime 关闭时清除资源挂载。
- Skill 正文通过当前会话的 `readSkill` 按声明路径按需读取，返回的 skillRoot 是该技能文件的父目录。可传 resource 读取其下的 UTF-8 模板、脚本或参考资料，单文件上限 256 KiB。
- `currentAgentResourceManager` 只负责校验和挂载，不修改用户全局 MCP 配置；通过信任门后由 `currentMcpSessionManager` 执行 descriptor 模块。
- MCP descriptor 默认导出 `McpServerConfig` 或工厂函数（也接受 `mcp`/`createMcpDescriptor` 导出），沿用 `McpHub` 的 stdio/HTTP 连接、超时、错误格式化和关闭逻辑。

例如 `agent/mcp/bookshelf.mjs` 可以导出 `({ packageRoot }) => ({ name: 'bookshelf', transport: 'stdio', command: 'node', args: ['agent/mcp-server.mjs'], cwd: packageRoot })`。descriptor 只描述上游 MCP server；工具实现仍由该 server 提供，扩展业务状态写入优先使用 DomainRuntime 命令。

## 接入边界

`currentAgentResourceManager` 返回当前会话的资源描述和系统提示词。`ExtensionAgentService.opencurrent` 在资源挂载成功后调用 `currentMcpSessionManager.open`：每个 Pi Session 建立自己的 `McpHub`，调用 `tools/list` 生成 `ext.<id>.mcp.<server>.<tool>` 工具并投影到同一个 Agent Session；调用结果仍经过统一 MCP 格式化和宿主权限门。现有 extension 日报仍走过渡桥接。

## 已知边界

当前实现完成了路径校验、实例隔离、信任门、工具注册和 MCP 连接回收。MCP descriptor 的网络/进程副作用仍由宿主 `McpHub` 和 Agent 权限策略控制；任何调用方都不能把未信任 MCP 资源注入 Pi，也不能把扩展资源写入用户全局 MCP 配置。

