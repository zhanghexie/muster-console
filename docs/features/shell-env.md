# Shell 环境探测与 Git Bash 兜底

> 关键词：shellPath、Git Bash 探测、WindowsApps WSL stub、无 bash 兜底、powershell 工具

## 功能职责

普通交互终端设置 `TERM_PROGRAM=MusterConsole`；创建期所有权 bootstrap 使用私有环境键，传给用户 Shell 前移除这些键。原 Shell 环境、参数、输入与 resize 保持既有语义，关闭屏障见 [终端控制](terminal-control.md)。

Windows 交互 PowerShell 启动脚本 `encoding/winUtf8.ts` 同时设置控制台输入/输出、外部进程管道 `$OutputEncoding` 及 Get-Content/Out-File/Set-Content/Add-Content 的 UTF-8 默认编码。`utf8ChildEnv` 为宿主创建的子进程提供 Python UTF-8 环境。Get-Content 的默认设置修复 Windows PowerShell 5.1 读取无 BOM UTF-8 文件时按 ANSI 解码的问题；不改动源文件。引擎自己另起的 PowerShell/Python 不一定继承交互初始化，仍应显式指定 UTF-8；此边界不等于宿主传输层故障。

Codex GUI 的 `drivers/codex/env.ts` 也复用 `utf8ChildEnv` 给官方 SDK/CLI 补 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8` 等缺省值，保留用户显式环境。它不能代替引擎内部 PowerShell 的 `Get-Content -Encoding UTF8` 和 `$OutputEncoding`；本轮没有改动用户 profile 或让宿主全局执行任意初始化脚本。

宿主探测本机 Shell 供终端配置档、后台任务及扩展使用。Windows 上的 Git Bash 探测还由 Pi 引擎复用，回答三个问题：

1. 本机有哪些可用 Shell（终端配置档 / 后台终端 / 扩展 action.shell）；
2. Git Bash 在哪（Pi 的 bash 工具必须有一个真 bash）；
3. 探测不到时如何降级（不再裸抛 "No bash shell found"）。

## 关键文件与入口

| 文件 | 职责 |
|------|------|
| `src/main/shell/profiles.ts` | `detectGitBashPath()` / `listShellProfiles()` 单源探测；`setManualGitBashPath()` 手工值注入与缓存作废；进程级缓存 + 后台预热 |
| `src/main/agent/piConfigSync.ts` | `syncPiShellPath()` 把探测结果同步进 `userData/muster-core/settings.json`（shellPathAuto 宿主标记；死值/变更解冻结，活手工值尊重） |
| `src/main/config.ts` | `AppConfig.shell.manualGitBashPath` 归一化 / 持久化白名单 / 加载与更新时注入探测层 |
| `src/main/agentSession/drivers/pi/shellEnv.ts` | GUI Pi 会话 shell 环境解析（纯逻辑）：显式 > 隔离目录 settings.json > 宿主探测；无 bash 时产出 powershell 引导段 |
| `src/main/agentSession/drivers/pi/driver.ts` | `connect()` 把解析结果合并进 `SettingsManager.inMemory`；无 bash 时 bash→powershell 工具替换 + 系统提示追加 |
| `src/main/ipc/sessions.ts` | `shell:getInfo`（后台任务生效配置档与 Windows Git Bash 状态）；`shell:listProfiles`（终端菜单） |
| `src/renderer/src/components/settings/ShellSettings.tsx` | 设置 → 通用 → 「命令行环境」分区 |
| `src/main/index.ts` | 启动时 win32 无 Git Bash 的桌面 toast 提示（`shell-env:no-bash` 同键原地更新） |

## 探测顺序（detectGitBashPath）

1. **手工值**（`AppConfig.shell.manualGitBashPath`，设置页维护）：存在才生效；不存在（卸载/改名）回落自动；
2. 标准安装位置（Program Files / Program Files (x86) / LOCALAPPDATA Programs）；
3. PATH 上 `git.exe` 的兄弟 bash：`<root>\cmd\git.exe → <root>\bin\bash.exe`、`<root>\mingw64\bin\git.exe → <root>\usr\bin\bash.exe`（覆盖自定义安装盘如 `D:\Git`）;
4. PATH 上的 `bash.exe`，但**排除 WindowsApps 里的 WSL 占位 stub**（0 字节重解析点，不是真 bash）。

pi 自身裸探测只认第 2、4 条且不排除 stub——这就是历史上自定义安装盘下 bash 工具报
"No bash shell found"、或误用 WSL stub 的根因。

## GUI Pi 会话接线（2026-09-25 修复）

driver `connect()` 用 `SettingsManager.inMemory(input.piSettings)` 构造设置，**不读**隔离目录
settings.json，`syncPiShellPath` 写入的 shellPath 对 GUI 会话原本完全无效。修复后：

- `resolvePiShellEnv()` 按优先级把 shellPath 合并进 inMemory settings：
  显式 `piSettings.shellPath`（模式/调用方手工值，最高）> 隔离目录 `settings.json`
  （存在性校验通过才采信，死值回落探测）> `detectGitBashPath()`；
- Pi bash 工具运行时读 `settingsManager.getShellPath()`（`agent-session.js _buildRuntime`），
  命中即不再走裸探测。

## 无 bash 兜底（B）

探测链全部落空（win32 且无手工值、无 Git Bash）时，不再让 bash 工具裸抛错：

- 会话工具面把 `bash` 换成 Pi 自带的 `powershell` 原生工具（模式白名单/政策层目录仍按
  bash 声明，语义不变——两者都是 shell 执行器；`excludeTools` 兜底排除 bash）。
  模式硬守卫（guardExtension/modeExtension 只读门控）与策略分类（tools/policy.ts
  `NATIVE_CLASS`）对 `powershell` **同判**（2026-10-01 M-2：此前只认 bash，无 bash
  场景下守卫整体失效、powershell 落未知工具退化为询问）；
- 系统提示末尾追加引导段（`NO_BASH_PROMPT_NOTE`）：本机无 bash，shell 操作一律用
  powershell 工具（PowerShell 语法）；该条件性 system 注入点已在
  `src/main/agent/injection-registry.ts` 登记（`worker.system.no-bash-note`，
  channel=system / mode=conditional / survivesCompact=false）；
- 用户可见提示两处：启动时桌面 toast（win32 无 Git Bash 一次性推送，同键不重复刷屏）+
  Windows 设置页 Shell 区块的安装指引（附 Git for Windows 下载链接）。

## 设置页 Shell 区块（C）

设置 → 通用 → 「命令行环境」（`data-settings-item="general-shell"`）：

- 各平台显示新后台任务会使用的 Shell 名称及可复制、可打开位置的路径。`shell:getInfo`
  使用后台任务同一个 `pickBgShellProfile` 选档函数，并返回 `bgShellProfile`。
- Windows 提供「自动（Git Bash 优先）」和「强制 PowerShell」两档（`AppConfig.shell.bgShellMode`）。
  缺省自动档不入盘，改档只影响新后台任务。Git Bash 与后台命令选中的 Shell 不同时单独展示。
- Windows 未找到 Git Bash 时提供安装指引，也可在设置页指定已有的 `bash.exe`。
  路径保存即时生效（ConfigManager.update → `setManualGitBashPath` 作废探测缓存 →
  `syncPiConfigFromApp` 同步 Pi 设置），留空或清除恢复自动探测，路径不存在时提示自动回落。
- macOS 和 Linux 显示探测到的后台命令 Shell。没有可用配置档时提示检查 bash 或 zsh，
  IPC 探测异常时显示错误并提供重试。

从桌面启动时，`src/main/shell/loginEnv.ts` 会从登录 Shell 补入工具搜索路径。普通工作台在后台读取。`demo-build` 与可交互的 `demo-run` 在重定向主目录前发起查询，工作台等到查询结束才接收命令。真实用户的 Shell 可在登录脚本里配置 nvm 等工具，Demo 子进程继续使用场景自己的 `HOME`。Windows 继承父进程的搜索路径。

Shell 区块直接调用 `config.update` 即时保存；`SettingsModal` 将 `shell` 视为即时配置，普通表单的旧草稿不会在随后点击「保存」时覆盖刚写入的路径或档位。

## 数据流（手工值）

```
设置页 ShellSettings
  → window.api.config.update({ shell: { manualGitBashPath } })
  → ConfigManager.update（normalizeShell → save 白名单 → applyShellEnv）
  → profiles.setManualGitBashPath（作废 cachedGitBash / cachedProfiles / warmPromise）
  → 下一次 detectGitBashPath / listShellProfiles 命中手工值
  → syncPiShellPath（写入 pi settings，带 shellPathAuto 宿主同步标记）
  → 新开的 GUI/终端/后台会话拿到正确 bash
```

### 解冻结（shellPath 死值不让位）

shellPath 的两处消费都做了死值防护：

- **syncPiShellPath**（GUI 和调度共用的 Core 配置）：宿主同步值带 `shellPathAuto:
  true` 标记，探测结果变化时原地覆盖；无标记的已有值视为用户手工，活着就尊重；
  死值（卸载/挪盘，`existsSync=false`）无论是否标记都让位最新探测——否则首次同步后
  路径永久冻结，Git 挪盘后设置页新手工值永不生效。
- **resolvePiShellEnv**（GUI driver 文件档）：隔离目录 settings.json 里的 shellPath
  须通过存在性校验才采信，死值回落 `detectGitBashPath()` 最新结果。

## 测试

- `test/shell-profiles.mjs`：探测优先级（手工值 > 标准 > git 兄弟 > PATH；stub 排除）、
  手工值不存在回落、setManualGitBashPath 回环；
- `test/pi-shell-env.mjs`：resolvePiShellEnv 优先级、无 bash 兜底产出引导段、POSIX 不干预；
- `test/pi-shell-path-sync.mjs`：syncPiShellPath 宿主标记/幂等/挪盘解冻/手工尊重/死手工值覆盖；
- `test/bg-tasks.mjs`：`pickBgShellProfile` 选档（auto 优先 git-bash / 回落 profiles[0] / 强制
  powershell→pwsh→兜底）、bgCommandLaunch 各档 args；
- `test/unit/shell-settings.spec.tsx`：Windows、macOS、Linux 平台显示与错误路径，Windows
  路径保存、清除、自动回落、即时选档与配置回读，设置搜索入口。

## 已知边界

- 手工值是全局配置（不按工作区区分）；
- `bgShellMode` 同为全局配置；改档只影响新后台任务，已运行任务不受影响；
- Windows 自动档优先 Git Bash，缺失时按可用配置档顺序回落，通常使用 Windows PowerShell；
- 模式 `piSettings.shellPath` 显式值优先于设置页手工值（模式作者自负）；
- 启动 toast 只在 win32 且探测落空时推一次，之后以设置页告警为准；
- 终端（pty）类 pi 会话的 bash 由 pi CLI 自身解析（读其 agent 目录 settings.json，syncPiShellPath
  已覆盖）；本文件描述的 inMemory 合并仅针对 GUI Pi driver。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D03.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：Windows 宿主与 Pi 引擎共用一份本机 Shell 探测，回答三问：本机有哪些 Shell、Git Bash 在哪、探测不到怎么降级；终端配置档/后台终端/扩展 action.shell 与 Pi bash 工具共同消费。
- 为什么这样设计：探测链（手工值>标准位置>git 兄弟目录>PATH 排除 WSL stub）修复历史根因——pi 裸探测漏自定义安装盘、误用 WindowsApps 0 字节占位；手工值+shellPathAuto 标记解冻结，防挪盘后死值永久冻结；无 bash 不裸抛而是 bash→powershell 工具替换+守卫同判（M-2）+条件注入引导段（injection-registry 已登记 worker.system.no-bash-note）；设置页手工指定即时生效。
- 明确不做：POSIX 不干预；不改用户 profile、不全局执行任意初始化脚本；auto 档无 Git Bash 时后台仍走 PowerShell（与旧行为一致）；模式显式 piSettings.shellPath 优先于设置页（模式作者自负）。
- 歧义点：无 bash 降级边界——powershell 降级是正式支持形态，还是过渡（终态要「无 bash 拒绝建会话/强制引导安装」）？A=正式形态（review 把「降级路径可用+守卫同判」当合同，M-2 类回归算 P1）／B=过渡补丁（review 推动加硬门槛）。推荐 A——B 会把无 Git Bash 的 Windows 用户直接挡在门外，且已有 toast+设置页引导兜底。
