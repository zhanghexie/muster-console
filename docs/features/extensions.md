# 扩展工作台 extension

## 职责和范围

只接受 `当前 manifest 合同`（`src/shared/extensionManifest.ts`）。当前实现的扩展源码只保留一份，不再向各工作区分发副本：全局扩展位于应用 profile 的 `extensions/global/<id>`，项目扩展位于选中项目源码根的 `.muster/extensions/<id>`，绑定一个具体源根，其他项目即使属于同一工作区也不能调用。工作区只保存实例绑定和运行时数据，不复制源码。扩展包随各仓库正常 Git 工作流管理，宿主不自动暂存、提交或修改忽略规则。

旧版顶层清单字段（`views`/`tools`/`background`/`native`/`host`/`capabilities`/`hostTools`/`toolbar`/`schemaVersion`）与旧运行时链（工作区副本同步、coordinator、watch service、replica 事务、native recovery、background runtime）及 `dynamicTools` 域已整体退役，不做旧兼容；详见 [动态工具（退役）](dynamic-tools.md)。

扩展中心和工作区独立激活是安装管理主线。目标合同、迁移顺序和验收矩阵见 [扩展中心与工作区激活](extension-center.md) 及 实施计划。当前已经接入GitHub Contents 扩展索引、离线日报回退、远程包校验、安装、更新和卸载。

工作区激活和中心安装已落地。`<userData>/extension/workspace-activation.json` 保存工作区级开关，管理服务支持单个工作区和全部工作区启用，管理页可以选择本地扩展目录、从中心安装和更新到 profile，工作台与运行时会使用同一份状态。卸载会检查所有工作区引用，关闭扩展运行实例并只删除源码包，工作区数据保持独立。启动时会把早期版本误写成文件的 `extension` 根路径迁移为目录，并保留原文件供恢复。

## 位置

```text
<userData>/extensions/global/<id>/  全局扩展的唯一源码目录，工作区不复制
<sourceRoot>/.muster/extensions/<id>/  项目扩展源码，可由 Git 管理
<userData>/extension/
  registry.json / reviews.json           package catalog 登记与本机审核结果
  workspace-activation.json              工作区级扩展启用状态
  project-mappings.json                  项目映射键的本机解析
  navigation.json                        各工作区、项目的导航组织
  packages/ / drafts/                    审核快照与创作草稿
  data/workspaces/<工作区身份哈希>/global/<id>/
  data/workspaces/<工作区身份哈希>/projects/<项目绑定哈希>/<id>/
  data/shared/global/<id>/               仅全局扩展显式声明共享时使用
```

`userData` 使用 Electron 当前实例的目录，开发沙箱与正式实例隔离。项目数据身份由工作区及清单中的相对路径或映射键决定；重新绑定映射键应仍是同一个项目。`data/`、`cache/` 和 `.git/` 不属于审核包，也不作为源码更新的覆盖目标。

## 发现、审核与安装（当前实现）

`ExtensionSourceLayout` 解析全局/项目源码目录；`discover` 异步读取包内容、按审核快照的同一套算法捕获文件字节、目录和执行位，校验清单并核对声明入口（`surface.entry`、`domain.entry`、`commandEntry`、`agent.systemPrompt`/`skills`/`mcp`）存在，计算整包指纹。`ExtensionPackageCatalog` 扫描源码根、登记指纹与实例绑定并持久化 `registry.json`；`syncGlobal()`/`syncProject(controlRoot)` 在启动、安装与刷新时核对，`queueGlobalSync`/`queueProjectSync` 做防抖刷新。catalog 只记录指纹与绑定，不复制源码。

创作链统一为：`ExtensionDraftStore` 在宿主私有草稿区编辑（不写工作区源码）→ `ExtensionReviewCoordinator` 整包立即审核 → 审核通过且候选未变化时 `publishExtensionPackageDirectory` 替换目标源码目录（保留 `data/`、`cache/`、`.git/`）→ `catalog.syncGlobal`/`syncProject` 登记 → 通知管理页。`ExtensionAuthoringServices` 装配上述流程，经 `host.extensions.run` 的 inspect/list/bindProject/create/write/removeFile/submit/retryReview 暴露。

`ExtensionReviewCoordinator` 以完整包指纹合并同一版本的审核，合并持续到审核记录完成写入，避免异步时序下重复审核。审核成功且候选仍未变化才发布；运行时核验实际源码字节，不为相同已批准版本再次审核。人工兜底展示目录、范围、指纹及原因；本机审核记录不随 Git 转移到别的机器。已审核分发快照损坏时保留损坏内容于同目录 `.corrupt-*` 并报错，不静默覆盖。发布前核对草稿基线与磁盘内容；新建要求目标不存在。同一目标串行发布。替换使用同卷暂存与不覆盖的重命名，迁移私有项或激活失败会原路回滚；若回滚本身失败，错误包含保留的恢复目录。

内置日报由 `extensionSampleInstaller.ts` 安装到全局扩展目录，包指纹、manifest、DomainRuntime 和 Agent 资源统一经过宿主校验；样例清单与退役清理由 `SAMPLE_IDS` / `RETIRED_SAMPLE_IDS` 维护。`data/`、`cache/` 等非源码数据不参与包指纹。文件变化会使运行中的实例进入重新验证流程，变化时 call 抛错、resource 返回 409，显式 reload 重新绑定新指纹并重建 iframe 文档，重新加载 HTML、样式与脚本。

## 扩展中心与工作区激活规划

目标实现会把安装来源、profile 级安装记录、工作区激活记录和运行实例拆开。中心包使用 `publisherId/extensionId`、版本、完整包指纹和发布签名识别；本地开发包使用 `sourceKind=local-dev`，不进入中心审核。中心审核只发生在上传发布阶段，客户端安装、运行和更新执行签名、摘要、清单和兼容性校验。

工作区不再通过项目源码目录拥有扩展包。安装后默认关闭，用户可以在当前工作区启用，也可以对全部现有工作区批量启用。关闭工作区扩展必须同时停止或拒绝面板、toolbar、DomainRuntime、Agent 和后台任务。现有项目包会在迁移阶段导入为全局本地开发包，并恢复原有可见工作区。

## 运行与交互

公开运行面板统一通过 `DomainExtensionPanel` 和 `ExtensionHost` 打开。`ExtensionHost` 按 catalog 登记的指纹绑定实例，sidebar 节点点击后由 `DomainExtensionPanel` 通过 `workbench` IPC 打开，面板资源和 DomainRuntime 绑定到同一 package fingerprint。声明 agent 时，Pi Agent 也绑定到该实例。官方中心发布记录只对匹配的全局包指纹有效。开发态包由 `ExtensionDevelopmentTrustStore` 记录显式信任，持久信任沿用目录身份，单次信任绑定当前指纹。启动扩展声明的 MCP 需要显式信任。

sidebar 扩展可选接入宿主 Agent。建议在需要通用助手操作领域状态时声明 agent，自带 LLM 交互的扩展可独立运行。声明 agent 的扩展在宿主底栏提供 AI 可见性开关，隐藏时会话可在后台继续运行。

DomainRuntime 与 toolbar command 由 `extensionIsolatedRuntime` 经 `spawnOwnedProcess` 启动独立 Node worker，cwd 为扩展包目录，包内相对 import 相对于模块文件。顶栏命令从 `context.sourceRoot` 取得绑定项目的绝对路径。扩展 HTML 由宿主统一移除 canvas 获焦轮廓；面板 iframe 沙箱通过实例令牌和桥接权限访问宿主；任务、事件和默认数据按实例隔离。Node 能力有本机权限，进程隔离不是 OS 权限沙箱。

打开面板和显式重载时，宿主从磁盘重新计算包指纹，并检查[扩展激活与运行许可](extension-development-trust.md)。运行中的资源请求复用已核验的指纹，文件监听使缓存失效，无法递归监听时由异步轮询补查。点击重载会重建 iframe，即使入口路径和版本号都没变，也会重新执行页面脚本。获准运行的包指纹改变时，宿主同时切换到新版本的 DomainRuntime。Pi 会话历史保留，扩展需要跨重载保存的业务状态应写入实例存储。

管理页平铺「全局扩展 / 项目扩展 / 扩展中心」三个页签。全局页按下载与本地来源分组，支持跨工作区批量切换，全部关闭后可卸载到系统回收站。项目页的选择器切换所看的项目扩展，切换时保留页签并清除旧项目内容。已安装扩展显示当前工作区的启用状态、源码位置、指纹和校验问题。创作审核结果保留在创作链中，扩展中心按索引分类显示可下载版本。侧栏保留文件夹、收藏、排序和面板位置；分屏中的面板临时显示在所在格子，退出分屏后继续使用保存的位置。零工作区时 `workbench:navigation` 返回空导航；选中工作区后按项目根加载。导航文件损坏时保留独立备份并重建，无法备份或读写时以只读方式启动并提示。

扩展同步、内置日报与导航的已知宿主状态原因以稳定原文保存在登记状态中，管理页显示时通过 `src/shared/extensionReason.ts` 按当前语言翻译；切换语言不重写登记文件。扩展调用宿主文件选择器时使用当前语言的标题。外部错误详情、路径和未识别原因原样保留。

extension 面板初始化和外观消息带可选语言及独立序号；SDK 将最新语言写入页面 `lang`，即使主题消息或初始化乱序也不会回退。嵌入页与独立窗口使用同一链路。内置日报按页面语言更新宿主文案，保留未保存输入、用户日志、日报正文和给模型的原有指令；日报包更新仍走已审核的内置安装，用户自行修改过的副本不会覆盖。

## 扩展宿主工具与终端边界

在 `permissions` 声明 `hostTools` 后，面板通过 `ma.tool(name, args)`，领域处理函数和顶栏命令通过 `broker('tool', [name, args], context)` 调用宿主工具。`EXTENSION_HOST_TOOLS` 从 GUI、ACP 和 PTY Worker 的公开工具投影取并集，保留已有扩展入口 `host.sessions.select`、`host.runtimes.run`（`list`、`preflight`）、`host.terminal.write`、`host.tasks.render`。能力管理中的「扩展」筛选使用同一目录。支持公开点号名及 MCP 下划线名，域入口沿用 `{ action, params }` 和 Worker 的动作范围，例如 `host.llm.run` 只开放 `quota`。

工作区与项目根来自经过启用状态、指纹和信任校验的扩展实例。工作区类工具可直接用，`host.workers.options` 会使用扩展绑定的源根。`host.ui.notify` 等工具需要调用者会话时使用该扩展自己的侧栏 Agent 会话，调用参数中的 `sessionId` 只能作目标引用。绑定 Agent 后，邮件以该会话为发件人，`asSubagent: true` 创建该会话的子任务。需要真实回合或用户原文的工具继续检查这些前置条件，例如审阅文件采集、桌面控制和记忆直写。后台任务和 Node REPL 使用侧栏 Agent 会话的生命周期，后台终止限于该会话的任务。新增入口按真实动作应用 Worker `standard` 权限档及工作区工具规则，保留原业务审核，确认后重查绑定和规则。调度专属工具、引擎私有工具和内部动作名不进入扩展目录。

`terminal.create` 创建普通 Shell 会话，绑定当前工作区、源根、rootsRevision 和源根 cwd；显式提供的绑定值必须一致，cwd 不能是子目录或其他路径。它不创建隔离工作树。`shellProfileId` 必须是已登记的 profile，`name` 最长 60 个 UTF-16 代码单元。Windows、macOS、Linux 复用现有 Shell 发现与启动逻辑，登记不代表当前系统已经安装该 Shell，缺失时会报错。`select` 可选择是否选中；不同工作区的焦点切换仍受宿主规则约束。

`terminal.write` 必须传 `sessionId`，宿主将引用解析为真实 ID，并拒绝不属于当前工作区的会话；不支持仅凭名称定位。它可写入当前工作区中已有的运行中终端，包括并非由该扩展创建的终端；写入参数可包含 Enter 或 Ctrl-C。`text` 最多 8 KiB（UTF-8）；调用成功表示输入已写入，并不证明命令或构建成功，输出由用户在终端中查看。`terminal.capture` 不可用于读取或截图输出。

DomainRuntime 入口本来就拥有本机权限，可自行启动进程；新增通道让扩展能够使用工作台的可见终端，不构成 OS 权限提升或沙箱。这里的绑定是宿主工具的调用边界，不能限制扩展通过已有本机 Node 能力执行的其他操作。示例和参数见 [扩展创作说明](extension-authoring.md)。

## 代码与通道

| 入口 | 职责 |
|---|---|
| `src/shared/extensionManifest.ts` | 当前 manifest 合同与校验器（唯一真源） |
| `src/shared/extension.ts` | 管理/导航/运行时投影类型，re-export 清单合同 |
| `src/main/extensions/extensionAppSystem.ts`、`extensionHost.ts`、`extensionHostMedia.ts` | 主进程装配、服务生命周期、表面/实例宿主与媒体/导出桥接 |
| `extensionSourceLayout.ts`、`extensionPackageCatalog.ts` | 源码布局、发现、指纹登记与实例绑定 |
| `extensionAuthoringServices.ts`、`extensionAuthoring.ts`、`extensionDrafts.ts`、`extensionReview.ts` | 创作草稿、整包审核与统一发布 |
| `extensionPackageSnapshot.ts`、`extensionAtomicRename.ts`、`extensionSyntax.ts` | 包捕获/指纹、跨平台原子替换、语法预检 |
| `extensionAgentService.ts`、`extensionDomainRegistry.ts`、`extensionIsolatedRuntime.ts`、`extensionRuntimeWorker.ts` | sidebar Agent、DomainRuntime 与独立进程执行 |
| `extensionProjectBinding.ts`、`extensionProjectMappings.ts`、`extensionSampleInstaller.ts` | 可携带项目绑定、本机映射与内置样例 |
| `extensionWorkspaceActivation.ts`、`extensionManagement.ts` | profile 级工作区激活记录、当前工作区与全部工作区启用 |
| `panelViews.ts`、`extensionNavigation.ts`、`extensionWorkbench.ts` | 独立窗口、导航组织与工作台投影 |
| `src/main/ipc/extensions.ts` | `extensions:*` 管理与 `workbench:*` 导航、面板 IPC |
| `src/renderer/src/panels/ExtensionsManager*.tsx`、`DomainExtensionPanel.tsx` | 管理页及当前 DomainRuntime 面板 |
| `resources/extensions/daily-report/` | 唯一随宿主分发的扩展包，含 manifest、DomainRuntime、Agent 资源和面板 |

作者合同见 [extension 创作说明](extension-authoring.md)，工具面形态见 [宿主工具面](tool-discovery.md)，实施与验证状态见 统一扩展宿主与模型媒体能力计划。运行证据与平台限制以计划中的实际验证记录为准。

## Runtime Kernel 退出屏障

嵌入面板的 `muster-app` 资源通过 Electron buffer protocol 适配层交付，复用实例身份、审核指纹、路径和 Range 校验。当前 Electron 的 `protocol.handle` 可以加载面板 HTML，却可能让同一 iframe 的 CSS、SDK 和 ES module 请求返回 `ERR_UNEXPECTED`，因此不能只验证入口 HTML 已显示。面板仍使用 `sandbox="allow-scripts allow-downloads"`，初始化握手在 iframe `load` 和 SDK `ready` 之间按实例 token 去重。

扩展域的 `stop()` 等待 DomainRuntime/toolbar 独立进程实际关闭与实例资源回收。Windows 的受控 worker 在初始化任何审核扩展代码前响应 fresh nonce，Job handle 确认该原始进程后赋值；Unix 使用独立 worker 进程组。Job 持续拥有自然退出子进程的后代，因此 Windows 的 worker 先退出也不影响收回整个容器；Unix worker 崩溃退出时无法安全证明旧组 ID 归属则明确拒绝，不信号可能复用的 PID。这是跨平台验证及归属边界，不能把根进程消失视为收树成功。

丢弃、禁用和身份失效触发的异步清理保留到应用退出，不因实例已移出 Map 而丢失。停机同步拒绝新调用、取消任务，单资源失败不跳过其它资源，最终聚合错误。领域调用取消既发送 AbortSignal，也等待真实 handler Promise。应用层等待内置包准备，审核取消后等待已受理工作收口。Windows 结果不替代 macOS/Linux 真机验证。

扩展宿主 LLM 调用可接收内部 AbortSignal，传入实际 fetch 并覆盖响应体读取；外部取消返回 AbortError，60 秒请求超时返回 TimeoutError，两者不会混报。取消后释放同实例的并发名额，已取消请求不再把迟到正文记为成功。扩展自绘 prompt/select/multiSelect/menu 同样从调用 scope 传入宿主 signal，详见 notification-system 的通用对话框合同。

创作流按快照中全部原始文件字节计算自动审核证据上限（50 MiB，含边界）。超限沿用人工复核；模型自身的上下文容量仍取决于提供方。

## 扩展发起项目任务

声明 `project.tasks` 的侧栏可通过 `ma.tasks.create(title, draft)` 弹出当前项目的「新建任务」并预填名称、草稿和技能胶囊。取消不会创建会话。用户确认后，宿主按所选 GUI Harness 和模型创建任务，并重新校验发起时的扩展身份、项目和包指纹。已有任务连接和调用领域工具时会校验当前包的启用状态与信任。领域命令的上下文包含来源任务 ID。登记侧栏作品时优先保存宿主传入的 `context.taskRef`，普通项目任务保存 `context.sessionId`。这两个值都可传给 open、preview、thumbnail。侧栏引用绑定工作区、扩展实例、安装范围及项目根，可跨应用重启解析到当前侧栏。扩展可用 `ma.tasks.open(sessionId)` 回到任务，用 `ma.tasks.preview(sessionId, relativePath)` 打开同一项目的作品。HTML 自动在右侧浏览器中运行，其他文件走文件预览。隔离任务按其工作目录解析作品路径；右侧助手当前会话登记的作品可在该侧栏继续修改。技能资源合同见 [Agent 资源](extension-agent-resources.md)。
