# CLI 入站 stdio MCP

> 状态：实现说明（2026-11-01，内置 CLI 方言与会话工具桥）
> 代码主入口：`src/shared/inboundMcp.ts`、`src/main/inboundMcp/`、`src/main/ipc/inboundMcp.ts`
> 关联：GUI 进程内 MCP [gui-worker-session.md](gui-worker-session.md)；调度出站 MCP [mcp-settings.md](mcp-settings.md)；Worker HTTP 兜底 [worker-inject.md](worker-inject.md)

把 **CLI（pty）Worker 白名单工具面**（`shared/hostTools` preset `pty-allowlist`，投影为 `WORKER_TOOL_ALLOWLIST`）做成独立 **stdio MCP server**：R4/R5 后投影 = Worker 常驻清单 ∩ preset（pty 28 项，原生注册带 schema 直调），供 Claude Code / Cursor / Gemini CLI / OpenCode 原生 `tools/list` 发现。ACP/Codex GUI 与 pty **共用** `stdioEntry.mjs`（差异在 preset / catalog env 与可信 HTTP 网关）；内置 Pi 在受管 worker 内装配工具并通过 IPC 调用工作台宿主，Claude GUI 经 SDK MCP 接入 GUI 工具网关。GUI 通道的工具装配与差异见 [GUI Harness 目录与接入](gui-harness-integration.md)。

---

## 1. 用户可见行为

PTY stdio 的普通工具调用在 HTTP 请求体顶层设置 `resultView: "model"`；宿主保留原始证据，在 12,000 字符序列化限额前产生模型回执。现有 HTTP 脚本省略该字段时继续获得原始结构。GUI 的 invoke 网关由 GUI 工具直接生成模型回执；PTY 的 `/status` 仍使用状态上报协议。详见模型返回值审计。

- 设置 → 能力管理 → **宿主接入** 独立页签显示 **Harness 使用工作台工具**；失败数在分类栏持续可见，原生/会话接入不计异常。启动、runtime 注册变更和工作区根拓扑变化自动收敛，无需手动安装；配置读取不会修改文件。
- 配置详情和失败提示中，已有的本地文件路径使用只读、可复制的路径框和「打开位置」；未提供路径的原生/会话接入不虚构路径。打开复用 `shell.revealPath`，文件在系统文件管理器中定位，目录直接打开；路径失效或权限不足时就地显示错误。
- 策略来自 `RuntimeHost.list()` 的可信 `integrations.mcp`：`config-file`、`native`、`session`、`unsupported`。内置 harness 共用声明驱动路径，管理器不按品牌维护固定配置名单；未声明显示“部分接入未声明”，原生/会话接入显示由适配器提供，不冒称配置文件或实时连接成功。
- 文件声明包含 `home/workspace/config` 根、相对子路径、平台覆盖、JSON/JSONC/TOML/YAML 格式及嵌套服务器键。工作区展开每个有效源根；没有工作区显示等待工作区。普通声明的平台配置根为 Windows APPDATA、macOS Library/Application Support、Linux XDG_CONFIG_HOME 或 ~/.config；内置方言遵循各引擎实际路径，不能统一套平台根。沙箱强制隔离。
- 配置一致不重复写；损坏文档、结构异常、未知同名服务、权限/写入失败分别报告并保留原文件。所有格式保留其他配置值和第三方服务；JSONC/YAML 只局部编辑宿主条目并保留其他注释，TOML 必要更新会重新序列化，注释与排版不保留，幂等时保持原字节。
- 文件路径及现有祖先的真实路径不得进入私有 `.muster` 存储。写入前后核对身份和字节变化，未知服务不接管。不同 harness 的冲突配置目标明确报错。
- 失败通过通知和页面持续警告报告；重试复用启动流程。配置成功只证明配置和受控身份匹配，不证明当前 CLI 已握手连接或工具执行成功；文件配置通常由新会话采用。

---

## 内置接入覆盖（2026-11-01）

`main/harnessIntegration/mcp.ts` 的 `harnessMcpTargets()` 只解释已启用 Runtime 的声明；`integrations.mcp` 缺失时直接产出 `state: unsupported` 与 `No trusted MCP integration declaration is available for this harness.`，没有探测 CLI 的真实 MCP 能力。设置页 `InboundMcpStatus.tsx` 将该状态显示为“未声明支持”，与等待工作区一起放进黄色提示。点击“重新检查”会重跑既有声明流程，不能补出源码中缺失的声明。

截图中的警告源于缺少声明，不能据此断言引擎不支持 MCP。现已补齐保留的 13 个新 PTY 入口和 `pi-external` / `omp` 两个 GUI 入口。DeepSeek CLI 按产品目录移除：官方 Harness 不附带官方 TUI，不能以第三方终端产品替代；其 ACP 聊天接入不受本项影响。

文件策略共 16 项（原有 Claude/Cursor/Gemini/Codex/OpenCode 5 项 + 新增 11 项）。`builtinMcp.ts` 解析环境覆盖、已有配置和三平台路径。`mcpEntry.ts` 生成固定字段，声明只接受数据。

| CLI | 用户配置与关键字段 |
| --- | --- |
| Kimi | 优先使用 `KIMI_CODE_HOME` 或 `KIMI_SHARE_DIR`。默认 `~/.kimi-code/mcp.json`，仅有旧数据目录时沿用 `~/.kimi/mcp.json`。服务键为 `mcpServers` |
| Grok | `GROK_HOME` 或 `~/.grok/config.toml`；`mcp_servers` |
| Command Code | `~/.commandcode/mcp.json`；`mcpServers`，`transport: stdio` |
| Cline | `CLINE_MCP_SETTINGS_PATH` 或 `~/.cline/data/settings/cline_mcp_settings.json`；`mcpServers` |
| Kilo | `KILO_CONFIG` 或 XDG `kilo/kilo.json`（兼容既有 jsonc/config.json）；`mcp`，`type: local`、command 数组、environment |
| Copilot | `COPILOT_HOME` 或 `~/.copilot/mcp-config.json`；`mcpServers`，`type: local`、`tools: ["*"]` |
| Devin | Windows APPDATA/devin，其余 XDG/devin。优先 `mcp_config.json`，仅有 `config.json` 时沿用已有文件。服务键为 `mcpServers` |
| Hermes | `HERMES_HOME` 或 `~/.hermes/config.yaml`；YAML `mcp_servers` |
| Muse | XDG `muse/settings.json`；文档 `schema_version: 1`、`mcp_servers`、`transport: stdio` |
| ZCode | `~/.zcode/cli/config.json`；`mcp.servers`、`type: stdio`、`features.mcp: true`；显式关闭时保留并报错 |
| MiMo | `MIMOCODE_CONFIG`，或 `MIMOCODE_HOME/config`，否则 XDG/mimocode；兼容 json/jsonc/config.json；`mcp`，command 数组 |

Kilo/MiMo 同时存在多个候选文件、相对覆盖路径、inline/config-dir 覆盖时明确要求处理。Windows Cline/Command Code 的原生 MCP 客户端使用 `shell: true`，含空格的 Electron 路径经固定 `cmd.exe /d /s /c` 包装。macOS/Linux 保持直接 argv。无法安全表示 `%`、`!` 或换行的路径明确报错。Muse 保留已有 `schema_version`，缺省时写入 `1`。ZCode 尊重显式关闭的 MCP 开关。

Pi/OMP CLI 使用 `session` 策略：`RuntimeHost.resolveLaunch` 在有可信会话 env 时投递 `MUSTER_INBOUND_MCP_LAUNCH`，启动脚本显式加载 `_pi-host-mcp.mjs`。扩展连接统一 stdioEntry，完成 initialize、分页 tools/list、api.registerTool、tools/call；失败上抛，取消转发，session_shutdown/进程结束回收子进程。工具 schema 投递登记在 A3 的 `worker.tool-schema.pi-cli-host-mcp`，不新增提示词。不写调度共用的 `~/.pi/agent/mcp.json`。Pi/OMP GUI 的 `session` 声明对应原有 `drivers/externalPi/bridge.ts`，其 HTTP 工具桥仍独立于 CLI stdio 扩展。

Kimi 等 ACP GUI 使用 `drivers/acp/driver.ts` 的 `session/new.mcpServers` 投递宿主 stdio 服务；相应独立 CLI 使用本机配置/启动参数，两者不会自动互相补齐。逐引擎官方证据与所需格式适配见 内置 CLI MCP 核对。配置已写入、引擎支持 MCP、当前会话连接成功须分别验证。

### 验证证据与边界

`test/integration/builtin-mcp-native.mjs` 用隔离 HOME/配置、真实官方 CLI、本地模型协议夹具、生产配置写入器、生产 stdioEntry/宿主 HTTP 网关执行只读 `sessions.readMessages` 夹具。通过要求：宿主处理器收到精确 nonce、生成唯一 proof、proof 出现在引擎下一次模型请求中且引擎正常退出。只有模型响应和只读数据源为夹具，MCP 客户端与传输是真实实现；不等同于真实云模型选择工具能力、真实用户账号或 Electron UI 验收。

Windows 通过：Kimi 2.4.1、Grok 1.0.70、Command Code 1.88.2、Cline 3.0.74、Kilo 7.8.18、Copilot 1.0.105、Hermes 0.19.0、Pi 1.4.0、OMP 18.14.2、Muse 1.4.14-R7309.1、ZCode CLI 0.17.1（官方 Desktop 3.17.1 资源）、MiMo 0.1.16。Pi/OMP GUI 的原有桥接源也在真实引擎中通过同样 proof 回传验证，未启动 Electron GUI。

Devin 3000.11.234 官方 Windows 二进制已通过原生 `mcp list` 识别生成的 muster 配置；隔离账号未登录，打印模式进入登录选择，`auth status` 确认 Not logged in，因此没有完成 tools/call，不能宣称真实调用通过。Windows 原生目录查询要求隔离 USERPROFILE 下存在标准 AppData 子目录，测试已补齐，并关闭其它工具配置的默认导入；旧版布局仍仅离线测试。macOS/Linux 均仅参数化路径/错误分支代码测试，未真机验证。其他既有引擎未在本次重新进行真实调用验收。

---

## OpenCode MCP 配置布局

内置声明使用 `config-file`、`jsonc` 与 `dialect: opencode`。`opencode.ts` 从已有文件识别 `mcp.<name>` 或 `mcp.servers.<name>`。文件尚无布局时，`opencodeConfigProbe.ts` 在临时 HOME/XDG 和空工作目录用 `--pure debug config` 查看 CLI 是否读取扁平配置，超时为 3 秒。读回试验条目时采用扁平布局，其余情况采用嵌套布局。状态查询直接读配置。异步准备完成后重新读取当前注册与工作区拓扑。Windows shim 沿用 `winCmdLaunchArgs` 和 `windowsVerbatimArguments`，macOS/Linux 直接传 argv。

- 两种布局均写 `type: local`、`command: [executable, ...args]` 和 `environment`。保留原有布局、其他服务及其启用状态。混合布局、双配置文件和损坏文件会给出各自的错误。
- 三平台均使用 `XDG_CONFIG_HOME` 或 `~/.config/opencode`。既有 JSONC 或 JSON 原地维护，无文件时创建 `opencode.json`。绝对 `OPENCODE_CONFIG` 受同一私有路径与所有权守卫。使用 `OPENCODE_CONFIG_DIR` 或 `OPENCODE_CONFIG_CONTENT` 时按现有提示手动接入。高优先级的项目配置可能覆盖全局条目，运行时的实际连接由 CLI 确认。
- 扁平与嵌套布局的语义见 [OpenCode V1 MCP](https://opencode.ai/v1/docs/mcp-servers/) 和 [OpenCode MCP](https://opencode.ai/docs/mcp-servers)。此前 Windows 本机 OpenCode 1.19.3 使用隔离 HOME/XDG 的 `--pure debug config` 验证过扁平 JSONC 的读取。
- Windows 本机 OpenCode 2.2.5 的 `debug config --standalone` 读到了隔离配置中的工作台格式条目和 CLI 自己生成的条目。`mcp list --standalone` 在该夹具中显示空列表，实际工具连接待验证。

## 2. 数据流

```
pty spawn / 接入拥有的后台进程 → ~/.muster/pid-map/{rootPid}.json（token + status/tool URL）
CLI 引擎按 mcpServers.muster spawn stdioEntry.mjs
  → initialize / tools/list / tools/call
  → 身份：MUSTER_HOST_TOOLS_*（invoke 网关）或 MUSTER_* Shell URL；Claude Code 不传播父进程 env 时沿 ppid 查 pid-map（同一 token，仅投递路径不同）
  → invokeStyle：POST {token,name,arguments}；否则 setStatus→STATUS_URL、其余→TOOL_URL
ACP session/new 注入同一脚本 + HOST_TOOLS_TOKEN/URL/CATALOG（preset=acp-subset）
```

CLI 可能过滤 MCP 子进程的环境变量，身份解析保留 PID 树回溯。独立于 PTY 的 owned backend（如 Codex remote TUI 的 app-server）继承当前子会话的可信 env，并通过 RuntimeLaunch.processIds 在前台启动前登记同一身份；不能只绑定终端壳进程。Codex 缺少认证 remote 能力而退回普通 TUI 时，若 CLI 声明 `--no-daemon` 则在任务参数前加该选项，避免 MCP 子进程落到先前会话的共享后台；不支持该选项的旧版本无法保证隔离，启动时通知用户升级并重启会话。已经启动并连接旧 daemon 的会话不会自动换进程，需在安全停止后重新启动；宿主不按 cwd 或 PID 猜认其他后台归属。登记随该次启动租约释放，PID 复用或其他实例覆盖后旧租约不得删除新记录。文件原子替换，新建目录/文件在 POSIX 分别使用 0700/0600，Windows 沿用用户目录 ACL。此身份投递链与引擎配置分离；引擎配置由启动自动配置流程维护。

工作区 `.muster/runtime.json` 发现机制已移除。Shell API 启动和工作区打开/初始化均不再生成或访问该文件；旧文件原样保留，不读取、不更新、不自动清理，继续被忽略和安全禁区保护。Worker 使用已投递的 MCP 连接或 `MUSTER_HOST`、`MUSTER_SHELL_API`、`MUSTER_STATUS_URL`、`MUSTER_TOOL_URL`、`MUSTER_SESSION_TOKEN` / `MUSTER_SELF` 环境身份；MCP 的受控 PID 身份表保留，不用工作区文件补猜会话。

`ShellApiServer` 本机 HTTP 服务、实例端口保存和 userData 下 `shell-api.json` 诊断副本保留。该副本不是工作区发现协议，也不替代会话绑定的 token URL。hooks 仍经启动时投递的身份上报 `activity`；移除工作区发现文件不改变其路由、鉴权或事件语义。三平台共用该环境/MCP/HTTP 链路，没有新增平台专属发现分支。

祖先查询：Linux 读取 /proc（进程名含空格时也正确），macOS 使用 ps；Windows 优先 WMIC，系统已移除 WMIC 时用隐藏、无 profile 的 PowerShell CIM 查询。查询受限或失败返回无法识别，不猜测身份或回落到其他会话。

---

## 3. 关键文件

| 文件 | 职责 |
|------|------|
| `src/shared/inboundMcp.ts` | 工具名映射、JSON-RPC、HTTP 分发、配置 JSON 合并、TOFU 指纹、pid 回溯（纯函数） |
| `src/shared/inboundMcpStdio.ts` | NDJSON 帧（兼容旧 Content-Length） |
| `src/shared/hostTools/` | 宿主工具唯一真源（id/权限/preset）；stdio 与 GUI 均为投影 |
| `src/main/inboundMcp/stdioEntry.ts` | 统一 stdio 循环；esbuild 打成 `out/main/inboundMcp/stdioEntry.mjs`（asarUnpack） |
| `src/main/inboundMcp/toolList.ts` | preset → Worker 常驻清单 ∩ preset 的 MCP tools/list（原生 schema 投影；R5 发现层退役后无 tools.search/call） |
| `src/main/inboundMcp/registrar.ts` | 逐引擎只读检查/幂等自动配置、托管身份与冲突/损坏/写入错误保护 |
| `src/main/harnessIntegration/builtinMcp.ts` / `mcpEntry.ts` | 厂商文件布局、平台与环境路径、原生字段序列化和严格所有权匹配 |
| `src/main/runtime/builtins/scripts/_pi-host-mcp.mjs` | Pi/OMP CLI 会话所有的 stdio 工具扩展 |
| `src/main/inboundMcp/pidMap.ts` | 身份表 |
| `src/main/inboundMcp/launch.ts` | Electron 二进制 + `ELECTRON_RUN_AS_NODE` |
| `src/main/ipc/inboundMcp.ts` | 启动自动配置、只读 status、重试 install、变化广播和失败通知 |
| `src/renderer/src/components/settings/InboundMcpStatus.tsx` | 宿主接入页配置状态、警告与重试；共用状态 hook 在其它分类保留失败摘要 |

---

注册面共用 shared/toolDiscovery 常驻清单与 hostTools 元数据（R5 终态：常驻清单即全部可用面，无发现层）。没有 SDK 热注册要求；HTTP 继续以令牌和 preset 白名单核对真实目标，run 入口在网关/执行器侧按 action 展开。

## 4. 边界

- **不含** GUI 专属 `bgtasks.*`（pty Worker 白名单本来就没有）。
- 不写 `~/.pi/agent/mcp.json`（那是调度出站 MCP）。
- 工作台未开 / pid-map 未命中：工具返回错误，不静默落到调度身份。
- `tools/call` 的 host 抛错或返回无效结果时，仍按原请求 id 回传有文本的 `isError` 工具结果；HTTP 200 中的 `{ok:false}` 同样标记错误。stdio 最外层异常回传 JSON-RPC 内部错误，通知不产生响应。该兜底覆盖明确失败路径，不承诺连接中断后仍可送达结果或具备重试幂等性。
- 普通 `notifications/cancelled` 按 requestId 取消该工具的 AbortController，再传给 HTTP fetch 和共享宿主执行信号；请求结束清除注册，stdin 关闭或进程退出中止在途请求，已取消请求不回传晚到结果。相同在途 ID 明确拒绝，不覆盖别的请求。HTTP 只将未完成响应断线视为取消，正常正文结束不取消；网关关闭也中止在途等待。这是普通 MCP 请求/响应能力，不协商或依赖 Tasks 扩展；客户端未转发取消时仍受工具的有界超时保护。
- 无原生 MCP 的 CLI 从首条简报取得 HTTP 入口。带会话 Bearer 对 `MUSTER_TOOL_URL` 发 GET 获得当前 Worker 工具 schema，POST 仍走同一权限投影和执行通道。

## 5. 测试

- `test/inbound-mcp.mjs`：握手字段、分发、白名单拒绝、TOFU 指纹、配置合并、pid 回溯
- `test/inbound-mcp-pid-scope.mjs`：后台进程身份租约、PID 复用/跨实例覆盖、失败回收和三平台祖先查询分支；`test/integration/builtin-tui-native.mjs codex codex-legacy` 分别用真实私有 app-server 和 `--no-daemon` TUI 的 MCP 子进程核对环境与身份。
- `test/inbound-mcp-stdio.mjs`：真子进程旧 Content-Length 与官方 SDK NDJSON initialize / list / call，碎片头回归
- `test/host-tool-cancellation.mjs`：真实 stdioEntry + 官方 MCP 客户端取消到 HTTP 网关/宿主信号的端到端链路、请求 ID 隔离、正常完成不误取消、网关关闭取消。
- `test/delegation-fault-regression.mjs`：handler 抛错、undefined 结果及 HTTP 200 逻辑失败的关联 id、错误标记和文本。
- `test/opencode-mcp-setup.mjs` 覆盖两种布局、JSONC 保留、三平台路径、幂等升级与冲突保护。`test/opencode-config-probe.mjs` 覆盖隔离配置、真实 shim 和默认布局。
- `test/inbound-mcp-auto-setup.mjs`：真实隔离文件的幂等、结构/冲突保护、托管升级、部分失败、权限/链接与外部漂移。
- `test/inbound-mcp-auto-ipc.mjs`：真实启动入口、不弹确认、只读检查、重试、沙箱隔离与通知传输失败。
- `test/inbound-mcp-registrar.mjs`：旧显式写入兼容函数保留其它 mcpServers
- `test/unit/inbound-mcp-status.spec.tsx`：只读状态、失败与重试、异步乱序与卸载保护（原 Electron 级验收 `test/e2e/capability-management.spec.ts` 已随能力管理改造移除，自动配置的现行覆盖见上方 `inbound-mcp-auto-setup.mjs`/`inbound-mcp-auto-ipc.mjs`）。旧 `inbound-mcp-confirm.spec.tsx` 仅覆盖历史通用确认组件，不代表当前自动流程。
- `test/metaagent-ensure-for-app.mjs`：真实工作区 ensure/启动遍历/规约刷新在隔离 fixture 中不触碰旧 runtime 文件、不生成新文件、不依赖 Shell API；保留旧文件字节、mtime 与环境身份注入。

## 自动配置的托管记录

`userData/inbound-mcp-managed.json` 保存逐引擎的受控启动身份历史（command/args/env，最多 32 项），用于安装路径变动时识别旧宿主配置；不含用户其它配置或凭据，不向模型暴露，也不恢复 runtime.json 发现机制。历史 `config.inboundMcpTrust` 只用于精确命令/参数且受控环境字段的旧安装迁移。未知同名 entry 保留并报冲突。

配置写入按引擎独立处理：预读并校验结构和文件身份，保留其他配置值及第三方服务，临时文件写入后重新核对外部漂移再原子替换；文件符号链接保留，配置一致不重复写入。托管记录未保存也属于未完成状态，不能因配置恰好一致而显示成功。部分引擎失败不抹掉其它引擎结果或旧身份。沙箱实例强制使用隔离 userData/capability-home，不写真实 home。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D09.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；（近期待验收：2026-10-25 自动配置改造未提交未验收）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：外部 CLI Agent（Claude Code/Cursor/Gemini CLI/OpenCode 等经声明接入的 harness）把宿主工具面当 stdio MCP server 原生 `tools/list` 发现直调；宿主启动自动把这些 CLI 的配置文件写好 `mcpServers.muster` 条目——2026-10-25 用户定调：基础能力，放 MCP 页最上方自动进行、失败持续警告，不放高级设置、不弹确认。
- 为什么这样设计：白名单投影 pty-allowlist ∩ Worker 常驻清单（28 项，原生 schema 直调），ACP/Codex GUI 与 pty 共用 stdioEntry.mjs——各通道执行同一套宿主工具；收敛时机=启动/runtime 注册变更/工作区根拓扑变化，逐引擎独立幂等处理（一致不重写、部分失败不抹其它结果）；所有权与安全：预读校验结构、保留其他配置值与第三方服务、JSONC 只局部编辑宿主条目保注释排版、未知同名服务不接管、冲突明确报错、托管身份历史（userData/inbound-mcp-managed.json）识别旧宿主条目、文件路径不入私有 `.muster` 存储、沙箱强制隔离 home；身份链 pid-map+MUSTER_* env（CLI 过滤 env 时沿 ppid 回溯，owned backend 前台登记租约，查询受限返回无法识别不猜身份）；工具失败兜底：host 抛错/无效结果仍按原请求 id 回传有文本的 isError 结果，notifications/cancelled 真取消 AbortController、同 ID 拒绝不覆盖。
- 明确不做：不写 `~/.pi/agent/mcp.json`（那是调度出站 MCP）；不含 GUI 专属 bgtasks.*；工作台未开/pid-map 未命中不静默落调度身份；不承诺连接中断后结果可送达或重试幂等；配置成功≠当前 CLI 已握手（文件配置通常由新会话采用）；不恢复 runtime.json 工作区发现机制。
- 歧义点：①TOML 必要更新会重新序列化、注释与排版不保留（JSONC 保、TOML 不保，幂等时保原字节）——接受为长期代价还是换保留注释的 TOML 编辑方案？A=接受（TOML harness 配置罕见、语义值保留、文档已明示；review 不把丢注释当缺陷）／B=换保留型编辑库。推荐 A。②自动配置失败后的重试面：目前=启动/拓扑变化自动收敛+页面手动重试，无周期性后台重试——保持还是加有界退避自动重试？A=保持（写用户全局配置文件是副作用操作，自动反复试弊大于利；失败持续警告可见）／B=加退避重试（更「自愈」但写盘频率不可控）。推荐 A。
