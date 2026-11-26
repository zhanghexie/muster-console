# Qwen Code 接入

Qwen Code 在「设置 → Harness 接入」提供工作台聊天和原生终端两个入口。Runtime 预检负责发现 `qwen` 命令并提供安装指引。登录及 API Key 由本机 Qwen CLI 管理。

关键声明位于 `src/shared/harnessCatalog.ts` 和 `src/main/runtime/builtins/registry.json`：

- 工作台聊天使用通用 ACP driver，启动 `qwen --acp`，模型、思考参数及该版本声明的会话设置由 Qwen ACP 的 `configOptions` 动态发现。权限请求以原生选项显示并回传对应 optionId。
- Qwen 会在参数流开始时发一条占位工具调用，参数就绪后按相同 ID 上报路径、命令及 `_meta.toolName`。工作台用补发信息更新原卡片。委托 MCP 调用显示解析后的工具名和服务。读取和文件搜索使用 ACP 文本结果，保留文件正文和匹配列表。此前历史如果只保存了占位事件，无法从工作台已保存的卡片恢复实际参数。
- Qwen 会在 `available_commands_update` 中附带可见 Skills 的描述和 `SKILL.md` 正文，供它的桌面端显示详情。工作台使用同一条通知里的斜杠菜单条目。聊天和模型发现的入站限额见 [ACP 通用 driver](acp-gui-driver.md#已知边界)。
- 原生终端使用 `src/main/runtime/builtins/scripts/qwen-cli.mjs`，首次以 `qwen --session-id <id>` 将工作台记录的 ID 绑定到原生会话。`--model` 和 `--approval-mode` 由 `src/shared/cliLaunchOptions.ts` 做结构化校验后注入。
- 用户级和工作区级 Skills 目录分别映射到 `~/.qwen/skills` 与 `<workspace>/.qwen/skills`，通过能力管理页维护链接和作用域。
- 工作台宿主 MCP 中转写入 `~/.qwen/settings.json` 的 `mcpServers`，路径由 `src/main/harnessIntegration/builtinMcp.ts` 按 Windows、macOS、Linux 解析，并保留用户已有 JSON 内容。

## 原生终端重启

手动重启终端和冷启动后按需打开会话共用恢复路径。适配器在原工作目录用 Qwen 的 `sessions list --json` 查找相同 ID，沿用 Qwen 自己的历史存储配置。找到记录后以 `qwen --resume <id>` 打开原对话。查询无需模型回合。查询失败或结果截断且无法确认 ID 时会报告错误。工作台继续使用 Windows 命令包装和 macOS/Linux 的直接 argv 启动。

空白会话、未开启聊天记录以及旧适配器创建的会话可能没有可匹配的 ID。恢复查无记录时提示原因并保留原会话 ID。用户可从会话菜单选择「开启新对话」，再在同目录的终端内用 `/resume` 手选旧的 Qwen 历史；手选只改变当前 Qwen 进程中的会话。全局参数显式选择原生会话或 `--worktree` 时，普通创建沿用这些参数。恢复及显式新开需要先移除这类覆盖。

`test/runtime-qwen-cli.mjs` 覆盖内置脚本升级、精确 ID 匹配、空历史和查询失败。Windows 上以真实 Qwen Code 0.27.2、ConPTY 和回环模拟模型验证了同目录两条会话精确恢复较早一条，原历史出现在终端及下一次模型请求中。macOS/Linux 真机尚未验证。

## ACP 验证

Windows 本机 Qwen Code 0.27.2 使用隔离配置、500 个临时 Skills 和回环模拟模型，验证了中文输入、1,760,288 字符的命令目录通知和随后返回的正文。修复前同一场景因超过 1 MiB 在正文前断开。`test/acp-driver-replay.mjs` 覆盖分块大帧及后续正文。实际远端服务和 macOS/Linux 真机需要分别验证。

同版本使用回环模拟模型和本地 MCP 验证了读文件、执行命令、搜索和委托 MCP 的真实事件。`test/acp-stream-map.mjs` 回放对应报文形状，`test/e2e/acp-tool-display.spec.ts` 使用模拟 ACP 引擎验证 Windows Electron 中的读文件卡及增量 IPC。
