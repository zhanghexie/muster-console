# 扩展创作接口

宿主协议指向安装的 `~/.muster/skills/muster-extensions/SKILL.md`。新工作区只创建扩展目录，已有工作区初始化时会清理仍与已知生成模板一致的旧说明。

使用 host.extensions.run({ action, params }) 管理扩展草稿、审核和运行。宿主绑定当前工作区、项目、源码根和草稿所有者，扩展不能伪造这些身份。

## 清单

扩展清单使用 当前 manifest 合同。全局包位于应用 profile 的 extensions/global/<id>，只保留一份源码；项目包位于当前项目的 .muster/extensions/<id>。

`icon` 和 `surface.icon` 可以使用 `builtin-extension:<id>` 选择宿主内置的 128 个系统风格图标，例如 `builtin-extension:calendar`、`builtin-extension:terminal`。完整目录见 [扩展内置图标](extension-icons.md)。旧版 emoji 或不超过 4 个字符的短字仍可读取，新增扩展应优先使用内置 ID。

sidebar 扩展必须声明 `domain`。需要宿主助手协作时，可声明 `agent`，并申请 `agent.state`、`agent.commands` 和 `agent.mcp` 中对应的权限。自带 LLM 交互的面板按需声明 `models` 权限。toolbar 扩展声明 `commands` 与 `commandEntry`，每条命令由 `{ id, title, handler }` 定义。`domain` 和 `agent` 只适用于 sidebar。

扩展面板通过 ../__sdk__/sdk.js 和 ../__sdk__/theme.css 接入宿主。

## 人和 AI 共用领域

domain.mjs 导出 createDomainRuntime()，提供 getSnapshot、query、execute、subscribe 和可选的 close。声明 agent 时，主界面与 Pi Agent 使用同一个实例，人的点击不会自动转成模型消息。Agent 在需要时通过 state.snapshot、query 工具读取当前状态，再通过声明的 command 改变状态。

DomainRuntime 和 toolbar command 在宿主管理的独立进程中执行。代码应使用可取消的异步操作，避免同步大 IO 和无限计算。宿主负责进程回收和请求取消，并为 DomainRuntime 提供版本检查、实例级串行化和危险命令确认。

## 顶栏命令

`commandEntry` 模块导出 `createCommandRuntime({ broker })`，也可使用默认导出。工厂返回带 `execute({ command, args, context })` 的对象。`command` 是清单中的 `handler`，`context` 提供 `workspaceId`、`extensionId`、`scope`、绑定时的 `sourceRootId`、`requestId` 和 `signal`。宿主从当前工作区绑定注入项目绝对路径 `sourceRoot`，并在有源根版本时提供 `rootsRevision`。

命令 worker 的 cwd 是扩展包目录，包内相对路径可以继续按原方式使用。读取项目文件时用 `context.sourceRoot` 拼出绝对路径，例如 `path.join(context.sourceRoot, 'package.json')`。

「一键打包」是绑定仓库根目录的项目扩展。它通过 `surface.command` 声明单个顶栏按钮，使用 `host.ask` 收集版本、目标平台和执行确认，再向绑定项目的可见终端提交命令。通过 `host.extensions.run` 创建项目草稿并审核发布，安装副本位于项目的 `.muster/extensions/build-package`。[一键打包使用说明](../../resources/extensions/build-package/README.md)

## 草稿、审核和运行

依次调用 inspect、create、多次 write、submit。更新已有包时传入 list 返回的 expectedFingerprint；新建要求该 ID 在目标作用域下不存在。list 按当前字节指纹返回 pending、approved 或 rejected，拒绝时包含原因。submit 对草稿整包立即审核，审核通过并核对安装基线后发布到源码布局（全局包 `extensions/global/<id>`，项目包 `.muster/extensions/<id>`，保留 `data/`、`cache/`、`.git/`），再由 package catalog 扫描登记；rejected/stale 透传原因。retryReview 对已安装的包按 id 和可选 scope 重审，同 ID 跨作用域时必须指定 scope。旧合同的 `run` / `tools` / `invokeTool` 动作已退役。用户从顶栏按钮或菜单运行 toolbar 命令，领域命令经 DomainRuntime 执行。

## 扩展中心与本地开发的分工

扩展中心当前使用官方 GitHub 索引与固定到提交的版本包，客户端校验摘要、包指纹、清单身份和宿主兼容性。发布审核与签名属于后续的发布流程。现行运行信任见 [扩展中心与工作区激活](extension-center.md)。开发态源码变化通过指纹重新验证和 reload 生效。

创作接口管理草稿与本机审核。安装管理负责中心安装、本地安装、更新、卸载和工作区激活。配置发布服务的桌面端可从全局本地扩展选择「提交到扩展中心」，走 GitHub 授权、上传和候选登记。发布身份、试装和审批由 [扩展中心发布服务](extension-center.md#投稿审核和试装) 管理。

声明 agent 的面板底栏提供 AI 开关。隐藏侧栏后同一会话可在后台继续运行。Skill、system prompt 和 MCP descriptor 由 manifest 声明并按扩展实例挂载。省略 agent 的面板仍可调用 ma.agent.domain 和权限允许的模型及数据接口。

## 宿主工具、可见终端和平台

在清单 `permissions` 声明 `hostTools` 后，面板用 `ma.tool(name, args)`，DomainRuntime 和顶栏命令用 `await broker('tool', [name, args], context)`。顶栏命令传入当前 `execute` 收到的 `context`。缺少 `hostTools` 时，调用返回 `Extension did not declare hostTools permission`。能力管理的「扩展」筛选可查询公开工具名，参数与 Worker 工具面共用，域动作用法见相应宿主技能。

`host.ui.notify`、邮箱读取、当前会话状态、后台任务和 REPL 等依赖调用者身份的工具要求扩展拥有自己的侧栏 Agent。当前回合和审批要求由宿主按实际动作判定。

`host.terminal.create` 创建绑定当前工作区和源根的普通 Shell。`host.terminal.write` 要求同一工作区的 `sessionId`，写入成功表示终端已收到输入。完整绑定和工具范围见 [扩展宿主工具](extensions.md#扩展宿主工具与终端边界)。

DomainRuntime、toolbar command 和 native 入口具有本机权限，worker 进程隔离不是操作系统沙箱。Windows、macOS、Linux 使用同一套扩展合同，进程与 Shell 差异由宿主适配层处理。平台能力缺失时必须明确报错。

制作作品库时按 `~/.muster/skills/muster-extensions/SKILL.md` 的 “Building a project artifact workflow” 接入草稿、技能资源、作品引用和浏览器预览。
