# MCP 设置（能力管理 · 宿主中转）

## 职责与入口

设置 → AI → 能力管理 → MCP 是第三方服务器的唯一管理页；该页顶部同时显示 CLI 连接宿主自身的基础自动配置状态，失败显示警告和重试，见 [inbound-mcp.md](inbound-mcp.md)。管理页现状与交互见 [capability-management.md](capability-management.md)。

服务器支持创建、编辑、删除和 JSON 导入，stdio 命令/逐行参数/工作目录/env，以及 Streamable HTTP URL/headers。配置通过专用 IPC 即时保存；失败保留草稿，不随底部设置总保存写入。env/headers 在管理 DTO 中打码，留空保留旧值，显式移除才删除。乐观 revision 防止覆盖外部更新，重复名称不静默替换。

全局存 `mcp.servers`，项目存 `mcpByWorkspace[workspaceId]`，项目同名覆盖全局。项目页显示只读全局继承。`mcp.enabled` 是一份全局中转总开关，`server.enabled` 是条目配置状态，连接测试结果是独立状态；不能相互代替。总开关保存期间显示请求值，失败还原并报错。

使用权限由能力管理与 Worker 共用的全局/Harness/工作区策略控制（见[能力管理](capability-management.md#使用策略)）。任一层关闭都不可经宿主搜索或调用；工作区同名配置也不能绕过全局同名关闭。恢复使用权限不会替代配置启用或握手。Harness 身份取宿主绑定会话，工作区取同一可信会话/气泡或当前工作区；不采信模型参数。异步建连结束后再次检查，再向第三方发起调用，已发出的调用不可撤回。连接继续按工作区共享，此策略不恢复已退役的逐引擎配置部署。

## 数据流与暴露

管理页 → `capabilityManagement:* IPC` → `McpManagementService` → `ConfigManager`。运行时 `capabilities/hosts/mcp.ts` 按调用会话/气泡工作区读取 `effectiveMcp(workspaceId)`，建立按工作区共享的 McpHub。配置变化关闭旧池、建立新池；退出关闭所有池。在途调用可能因配置变化中断，模型可重试。

工作台管理的第三方工具不逐个装入 GUI 引擎，由常驻 `mcp.search` / `mcp.call` 和 McpHub 中转。没有逐引擎 targetIds 关联，不向 CLI 原生配置部署第三方项。原生发现、接入、拥有权台账和漂移观察已退役；历史台账文件留盘不动，不作为当前 UI 或路由依据。用户自己的 CLI 配置仍由用户/CLI 管理。

Claude GUI 只注入宿主 muster MCP 且保留 strictMcpConfig；Cursor/Codex/ACP 的工作台注入也只有宿主工具通路。Cursor CLI 按其自身规则还可加载用户或项目 `.cursor/mcp.json`，这些原生服务器不经过工作台的中转和使用策略；[Cursor ACP 文档](https://cursor.com/docs/cli/acp)说明团队级 MCP 在 ACP 模式不可用。CLI 启动自动配置写入的是宿主连接，不能当作第三方 MCP 原生部署。

## 连接与诊断

管理页测试新建官方 SDK client，initialize + tools/list 后关闭；不执行工具、不自动登录，也不经过 mcp.call 中转。成功表示“握手成功（直连验证）”，不证明现有会话加载或中转可达。关闭总开关时返回 relay-disabled，不启动诊断进程；缓存结果只在与产出时总开关状态一致时显示。

诊断有15秒预算，认证、命令缺失、无效配置、超时和连接错误分别报告；stderr 有界消费，错误信息隐藏 env/headers/URL 凭证。所有返回路径清理 owned transport/client/进程；Windows 包装命令同时清自己的子进程树。真实账户认证由使用者完成。

正式运行的 `agent/mcpHub.ts` 支持并行连接、15秒连接预算、120秒 tools/call、30秒失败冷却、断线摘除、stderr 消费、Windows .cmd 解析和 Streamable HTTP 失败后的 SSE 回落。`agent/mcpProxy.ts` 统一参数解析和输出。默认成功结果沿用第三方文本；仅当没有可格式化的内容块而回退到 `structuredContent` 时，宿主使用紧凑 JSON 而不添加缩进，避免空白挤占正文预算；资源块和服务端文本仍沿用既有格式与合并后的首尾空白处理。`shared/mcpRelay.ts` 在 executor 的 12k 序列化上限前把 call 信封收敛到 11.5k，截断时附标注。第三方明确返回 `isError` 时，中转保留失败状态并脱敏回传。远端调用发出后连接中断、取消或超时，远端可能已经产生副作用，结果不能视为确定未执行；中转层不自动重试。

`host.mcp.call` 可在 `args` 同级传 `resultPaths`，例如 `["/tag_name", "/published_at", "/items/0/title"]`。宿主在截断前从 `structuredContent` 或单个 JSON 对象/数组文本块按 JSON Pointer 取值。结果 JSON 的 `values` 以路径为键，`missing` 列出不存在的路径，`omitted` 列出放不进信封的值；保留的值都是完整的。路径按给定顺序处理，允许 1 到 12 个非根路径，每个最多 128 字符。普通文本和其他非 JSON 结果带说明按原格式返回。`resultPaths` 只影响送给模型的结果。服务器支持字段筛选或分页时，通过 `args` 传入对应参数也能减少服务器返回的数据。

## 关键文件与验证边界

- `src/main/capabilityManagement/mcpManagement.ts`：scope、配置与凭据保留、revision、总开关相关测试缓存。
- `src/main/capabilityManagement/mcpConnectionTest.ts`：独立SDK握手与诊断清理。
- `src/main/ipc/capabilityManagement.ts`：管理IPC、变化广播、总开关写入。
- `src/main/capabilities/hosts/mcp.ts`：按工作区共享中转池、search/call出口。
- `src/main/agent/mcpHub.ts` / `mcpProxy.ts`、`src/shared/mcpRelay.ts`：运行连接与结果边界。

回归入口：`test/mcp-management.mjs`、`test/mcp-config.mjs`、`test/mcp-hub.mjs`、`test/mcp-integration.mjs`、`test/unit/skills-management.spec.tsx`（原隔离 Electron 级验收 `test/e2e/capability-management.spec.ts` 已随能力管理改造移除，现行覆盖为上述离线与组件级文件）。本地握手与IPC测试不代表真实账户授权、远端服务可用或现有模型会话已加载。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D09.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：用户在设置→能力管理→MCP 管理第三方 MCP 服务器（stdio/Streamable HTTP），创建/编辑/删除/JSON 导入、env/headers 凭证打码、全局/项目作用域与同名覆盖；工作台管理的服务器经宿主 `mcp.search`/`mcp.call` 中转调用，引擎自身配置由引擎管理。
- 为什么这样设计：单一出口 McpHub 按工作区共享连接池（配置变化关旧池建新池、退出全关）——第三方凭证只存宿主 config（管理面打码、留空保留旧值、显式移除才删），不复制进各引擎配置文件；预算与降级：连接 15s/call 120s/失败冷却 30s/断线摘除，Streamable HTTP 失败回落 SSE，中转信封在 executor 12k 上限前按最终转义长度收敛到 11.5k 明确截断（防「成功结果被整体替换为超限失败」）；三态分离：`mcp.enabled` 中转总开关 / `server.enabled` 条目配置 / 连接测试握手结果互不代替——测试是独立 SDK 直连握手（initialize+tools/list 后即关，不执行工具不自动登录不过中转），「握手成功≠会话已加载≠mcp.call 可达」贯穿文案；错误信息隐藏凭证、Windows 包装命令清自己子进程树。
- 明确不做：不恢复已退役的逐引擎配置部署/原生发现/拥有权台账（历史台账文件留盘不作依据）；不自动登录、不代管第三方账户授权；用户自己的 CLI 配置仍由用户/CLI 管理；已发出的远端调用不可撤回。
- 歧义点：①「第三方 MCP 一律宿主中转」是终态架构还是过渡（未来可能恢复逐引擎原生部署以获得引擎侧原生 MCP 能力）？A=终态（退役是刚完成的收敛，凭证集中+三层策略统一兜得住；review 把任何原生部署回归当缺陷）／B=过渡（review 需整理引擎原生能力缺口清单）。推荐 A。②连接测试只做直连握手、不提供「经中转的端到端测试」是刻意边界还是待补？A=刻意（测试=配置正确性诊断，不依赖工作区会话上下文；中转可达性由 mcp.call 真实调用即知，review 不把缺端到端测试当 finding）／B=排期加端到端档。推荐 A。
