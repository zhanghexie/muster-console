# Magpie 技能、MCP 与子代理研究

调研日期：2026-11-11。对象为 [yetone/magpie](https://github.com/yetone/magpie)。本机参考源码位于 `refs/magpie`，已更新到 `245f07b19e44c33df99acdce5653d38b168342bf`（2026-11-11）。仓库是浅克隆，`refs/` 被本仓忽略，不随本仓提交。

本文只做源码和文档研究，没有启动 Magpie、登录账户、写入任何 Agent 配置或调用真实 MCP。结论以这个提交为准；Magpie 上游持续变化，当前能力不等同于稳定 SDK 合同。

## 先看整体模型

Magpie 的 Library 是资源真源，保存指令、Skills、MCP、Hooks、Subagents、项目绑定和插件拆包结果。每次编辑都经过串行的 `change`：加载 `library.json`，修改资源，保存，向目标 Agent 同步，再保存 `Applied` 记录和备份。`Applied` 是“我写过什么”的归属账本，后续删除或更新只针对仍然与账本哈希一致的文件。

这使 Magpie 的资源管理与 Agent 执行保持两层关系：Library 管理内容和归属，Agent 仍按自己的文件格式加载，Gateway/Router 负责运行时连接。它不是把所有 Agent 强制改成同一个运行时。

## Skills：从统一资源到按需索引

Magpie 的 Skill 是包含 `SKILL.md` 的目录。来源可以是 GitHub、其他 Git 仓库、本地目录或市场；来源身份与展示名称分开处理，同名 Skill 不会因为名字相同就错误覆盖。Git 来源使用独立目录、浅 fetch、无 shell、禁止危险 Git transport、关闭交互式凭据提示，并在失败时返回明确原因。市场探测和安装分离，探测结果有短期缓存，安装结果逐项报告 `had/installed/skipped`。

每个 Skill 都可以按 Agent 选择 link 或 copy。link 适合能直接读取 Library 目录的 Agent，copy 适合不跟随链接、WSL 或用户明确要求隔离的 Agent。复制带有可识别的标记和内容哈希；如果 Agent 侧的复制品被用户改过，下一次同步会先尝试把最新编辑带回 Library，再更新目标。用户目录中已经存在的 Skill 可以显式 hand-over 到 Library，失败时保留原位置并给出逐项结果。`OffHere` 只影响本机，不随跨机器同步传播。

几个细节值得借鉴：

- `disable-model-invocation: true` 被识别为 Manual only。它仍可由用户显式调用，但不进入模型自动选择的列表。
- Skill 分组只是展示层组织，Agent 仍逐个获得 Skill；这避免把 UI 分组误认为运行时能力。
- Skill 的来源、当前目标、复制方式、被编辑后的 behind 状态和用户拥有的同名目录分别呈现。用户目录里的内容不会因为“被发现”就静默删除。
- Library 对外部目录、共享 `~/.agents/skills`、WSL 和已卸载 Agent 都有显式边界；卸载后仍保留 Magpie 曾写过的目标，只允许把它清理出去，不再继续投递新内容。

### Skill router

最新版本提供独立的 Skill router。打开后，每个目标 Agent 的技能目录只得到一个 `magpie-skills` Skill；它的 `SKILL.md` 列出可用 Skill 的描述以及对应 `SKILL.md` 路径，真实 Skill 放在隐藏的 `.skills/<name>` 下。模型先看到一个目录和每个 Skill 的短描述，任务匹配后再读取具体正文。

路由器会排除手动 Skill、明确保持 direct 的 Skill、Agent 自己已经拥有的同名 Skill、被策略阻止的 Skill，以及目标 Agent 不支持路由的情况。Claude Code 还会获得 Magpie 写入的最小读取授权规则，这些规则同样被 `Applied.RouterRules` 记录，用户自己的规则不会被覆盖。

路由器提供了三个有价值的控制面：

1. **上下文预算**：模型首轮只得到索引，不会把所有 Skill 正文一次塞进上下文。
2. **使用观测**：读取 `.skills/<name>/SKILL.md` 可以被识别为实际使用了该 Skill；读取路由器本身只算目录调用，不重复计数。
3. **显式退出**：关闭路由器会移除索引目录和 Magpie 的授权规则，并恢复原来的逐 Skill 链接；用户手动指定的 Skill 保持 direct。

这不是把 Skill 变成远程服务，而是把“发现”与“读取正文”拆开。它保留了 Agent 原生的 Skill 语义，同时减少首轮提示词体积。

## MCP：统一模型、原生投影和运行时路由

Library 中的 MCP Server 用统一结构保存 command/args/cwd/env 或 URL/headers、OAuth、禁用工具、启动超时、项目和 Agent 归属。同步时再按目标 Agent 的格式写入：Claude Code、Codex、Gemini、Cursor、OpenCode、Pi、Droid 等各有自己的文件和字段。用户原有配置字段会被保留，Magpie 只记录并回收自己写入的那一部分。

MCP 管理面和运行面分开：连接测试执行 initialize、initialized、tools/list，返回工具摘要和分步错误；它不执行真实工具调用，也不等于当前会话已经加载。连接预算、命令/HTTP 超时、stderr 消费、OAuth 续签和缓存失效分别处理。无法动态注册 OAuth 客户端时，界面提示用户使用服务商允许的自有 OAuth 应用，避免假装已经完成授权。

MCP 服务器有三种容易混淆的状态：

- `ServerOn`：资源是否可用；关闭会隐藏服务器、保留绑定关系和配置，停止路由器进程。
- `Agents` / 项目绑定：哪些目标得到它。
- 健康检查结果：最近一次握手是否成功，不能代替前两者。

单工具禁用也按能力差异处理。Codex、Gemini CLI、Claude Code、OpenCode、Droid 等可以写各自的 deny/exclude 规则；只支持整服务器的 Agent 保留完整工具列表。Magpie 记录自己写入的规则，用户已有同名规则不会被覆盖。

### MCP router

MCP router 打开后，每个支持的 Agent 收到一个名为 `magpie` 的 Streamable HTTP Server，原来逐个写入 Agent 的 MCP 条目被收回。路由器在第一次 list/call 时启动或连接后端，每个 Library Server 只运行一个共享 backend，其他 Agent 和外部应用都通过同一个入口访问。服务器空闲、编辑、关闭路由器或网关退出时，进程树会被回收。

当前版本的路由器已经超过“把多个 MCP 合成一个 URL”的简单模型：

- **直连例外**：有状态或必须在 Agent 工作目录运行的 Server 可以标为 direct；它不会被路由器列出，目标 Agent 保留自己的原生条目。
- **按需工具**：工具超过阈值时，非原生 Tool Search Agent 只看到 `find_tools` 和 `call_tool`。`find_tools` 根据查询、服务器名称、描述和工具名打分，先返回少量完整 schema，再返回更多名称和短描述。这样不会在每轮请求中携带全部 MCP schema。
- **路由器说明**：`initialize` 返回服务器用途、标题和工具摘要；路由器可以有用户定义的名字，帮助模型区分多个 Magpie 实例。服务端会缓存这些摘要，并在工具列表变化时失效。
- **项目作用域**：Claude Code 和 Codex 可以得到带项目键的路由地址，路由器按项目加入/关闭的 Server 计算可见集合。当前没有把 backend 按项目复制成多份，而是在调用时按作用域过滤。
- **调用隔离**：每个 MCP client 会话、Agent、外部 key 和浏览器窗口可以有自己的 session 标识；浏览器类工具不会因为共享 backend 而让所有 Agent 落到同一个标签页。
- **安全和预算**：本机、LAN key、代理和网页调用经过不同 guard；调用先过 gateway key 的额度限制。需要本机用户权限的 Server 不对远程访客暴露，受限 key 不能借路由器启动本地程序。
- **远端路由器**：另一个 Magpie 可以作为 Library Server 被显式加入。`X-Magpie-Router` 防止两个路由器互相递归发现，远程 Server 被移除、改地址或 key 时会被识别为不同归属。

这个设计把“配置分发”和“工具执行”集中起来，同时保留 direct 例外和 per-caller 运行状态，避免所有 MCP 都被迫承担同一种生命周期。

## 子代理：声明式资源绑定，投影成各家原生角色

Magpie 的 Library Subagent 是一个声明式对象：`name`、`description`、`prompt`、可选 `model`、要绑定的 Skills、MCP Servers，以及被哪些 Agent 使用。界面把它作为独立资源管理，支持单个 Agent 芯片、批量分配、编辑、删除和能力不支持原因展示。

同步时，Magpie 按原生格式投影：

| Agent | 文件 | Magpie 能写的内容 |
|---|---|---|
| Claude Code | `~/.claude/agents/<name>.md` | YAML front matter、prompt、Skills、MCP servers |
| Codex | `$CODEX_HOME/agents/<name>.toml` | name、description、developer instructions、可选 model |
| OpenCode | `agents/<name>.md` | description、`mode: subagent` |
| Gemini/Qwen/Grok/Cursor | 各自 `agents/<name>.md` | name、description、prompt |
| Factory Droid | `~/.factory/droids/<name>.md` | name、description、MCP servers |
| Copilot CLI | `agents/<name>.agent.md` | name、description、prompt |

只有 Claude Code 的文件能显式绑定 Skill，只有 Claude Code 和 Droid 的文件能按名称绑定 MCP；其他 Agent 的子代理继承该 Agent 自己的全局能力。只有 Codex 的原生 role 文件能指定子代理模型；其模型作为配置层覆盖 lead 在 `spawn_agent` 中的选择。其他 Agent 的子代理使用各自 Agent 选择的模型。

写入策略与 Skills/MCP 相同：`Applied.Subagents` 按文件保存哈希。文件仍与 Magpie 写入内容一致时才能更新或删除；用户改过后即视为用户文件，Magpie 不再覆盖。已有同名用户文件也不覆盖，文件被删除则下次同步可以重新写回。每次写入先备份。WSL 目标当前明确不投递子代理，界面保留灰色状态和原因。

插件可以把 Skills、MCP、Hooks 和 Subagents 作为一个 bundle 安装；拆包后它们成为普通 Library 资源，支持统一分配、启停、更新和命名冲突前缀。插件关闭不等于删除用户自己的同名资源。

## 对照工作台现状

| 能力 | Magpie | 工作台当前做法 | 判断 |
|---|---|---|---|
| Skills 真源 | Library + 多来源安装 + Agent 原生目录投影 | `~/.agents/skills`、项目 `.agents/skills` 和宿主私有根；运行时显式加载 | 工作台已经有更清晰的通用根和宿主根边界；不宜重新引入按 CLI 自动写入的广泛投影 |
| Skill 发现 | 市场/仓库/文件夹探测，手动/自动调用区分，Skill router 索引 | 菜单点名、路径注入、`skillsList`、使用策略和注入审计 | 可借鉴索引和手动 Skill 语义，但应接入现有 injection registry 与按需加载合同 |
| MCP 配置 | 规范模型后按目标格式投影，或由 MCP router 统一承载 | 宿主 config 全局/项目作用域，`McpHub` 按工作区共享，`mcp.search`/`mcp.call` 中转 | 工作台已经选择了 router 路线；Magpie 的按需工具搜索、路由器说明、direct 例外和 caller session 值得补充 |
| 子代理 | 一份角色文件投影到多个 CLI，资源绑定依赖各家格式 | 普通 worker 会话 + `parentSessionId`，继承 runtime/model/thinking/guiMode，父子通信和自动通知 | 工作台的会话语义更强，不应退回文件角色作为主模型；可增加“声明式子代理模板”作为创建输入 |
| 归属与清理 | `Applied` 文件哈希、逐文件备份、用户编辑即脱管 | Skills 用 expected hash；MCP 统一存宿主 config，不写 CLI 原生配置；Worker 会话由宿主管理 | 继续扩大“写外部文件”前，应采用 Magpie 式逐文件 owner/hash/backup |

## 对工作台的具体启发

### P0：把 MCP router 的运行时细节补进现有中转

工作台已经把第三方 MCP 收敛到宿主 `McpHub`，因此最值得直接吸收的是运行时策略：

1. **工具按需发现**：当一个 workspace 的 MCP schema 超过预算时，让 `mcp.search` 返回服务器用途、工具名和少量 schema，`mcp.call` 负责执行；不要把完整工具 schema 每回合都交给引擎。
2. **服务器用途摘要**：为 Server 保存可编辑的标题、用途和工具摘要，搜索结果与模型提示都能解释“哪个服务适合做什么”。
3. **direct 例外**：明确允许某个 Server 直接绑定到特定会话/引擎，用于必须在工作目录运行或需要原生 client session 的工具；direct 不应绕过全局使用策略。
4. **调用方会话与工作区**：把 caller、workspace、project、MCP client session 绑定到一次 call，尤其是浏览器/文件类有状态工具，避免共享池把不同 Agent 混到一起。
5. **动态列表失效**：尊重 `notifications/tools/list_changed`，配置变化和 server 编辑关闭旧连接，区分“握手成功”“已加载”“本次调用成功”。

这些可以在现有 `McpHub` 和 `mcp.search/call` 上渐进实施，不需要恢复逐 CLI 原生 MCP 写入。

### P1：增加 Skill 的索引层，但不改变真源

Magpie 的 `magpie-skills` 说明了一个上下文优化方向：保留当前 `SKILL.md` 目录和显式路径注入，额外生成一个只读索引，包含名称、描述、手动/自动标记和正文路径；模型先搜索/选择，再按路径加载正文。索引生成和读取必须登记到现有 injection registry，不能在未登记的注入点偷偷增加上下文。

工作台已有 `skillsList`、`runtimeSkills` 和能力使用策略，因此更适合做“运行时索引/搜索”而不是再创建一个品牌目录。手动 Skill、宿主私有 Skill、同名来源偏好和工作区范围都应继续使用现有策略。索引只能帮助发现，不能把“显示在清单里”当成“本轮已经使用”。

### P1：声明式子代理模板，继续落到普通会话

可以为 `sessions.create` / `delegateTask` 增加可选的子代理模板：任务名、描述、系统提示片段、模型/思考默认值、允许的资源引用和父会话继承策略。宿主在创建时解析成普通 worker 会话，仍由现有 `parentSessionId`、能力策略、审批和通知链路控制。

模板只引用 Skill/MCP ID，不复制正文、凭据或 CLI 配置。模板的能力在创建时生成快照，后续 Library 变化不应悄悄改变正在运行的会话；新会话可以重新解析。这样借鉴 Magpie 的资源绑定，又保留工作台已经实现的普通会话、父子通信和跨 runtime 能力。

### P2：插件 bundle 的资源拆包

Magpie 把 Claude 插件拆成普通 Skills、MCP、Hooks 和 Subagents，并保留 bundle 来源。工作台扩展系统可以考虑类似的“资源声明清单”：安装扩展时声明它提供哪些 Skill/MCP/模板，卸载或禁用只撤销扩展拥有的资源，用户同名资源保留；每个资源记录 owner、source、hash 和 cleanup 状态。

这需要先对齐现有扩展资源信任门和宿主注入注册表，不能直接把第三方插件的 Skill 或 MCP 自动当成可信能力。

## 不建议直接照搬的部分

- 不要把 Magpie 的多 CLI 原生配置投影恢复到工作台当前会话架构；那会重新引入格式漂移、配置覆盖和跨平台回收问题。
- 不要把 MCP Hub 的单一 URL 当成所有工具都适合共享；浏览器、工作目录和本地进程必须保留 direct 或 caller session 边界。
- 不要把 Skill/插件的安装数量、握手状态或“已显示”当成模型本轮真的使用了能力。
- 不要把子代理角色文件当作权限沙箱；Magpie 自己也只是声明/配置投影，真正权限仍由 Agent、宿主和操作系统决定。

## 研究边界

本次核对了 `internal/library`、`internal/gateway`、`internal/agent`、`internal/plugin` 以及 `docs/subsystems/library.md`、`skill-router.md`、`mcp-router.md`、`plugin-tools.md`、`agent-wiring.md` 和相关测试。未启动 Magpie，未运行其完整测试套件，未在 macOS/Linux/WSL 真机上验证 CLI 版本和文件路径；截图只用于确认界面呈现方向，不作为源码行为证据。
