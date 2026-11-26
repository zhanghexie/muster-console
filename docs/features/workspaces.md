# 工作区管理

> 状态：多文件夹创建与编辑入口已开放，2026-10-01；2026-10-16 新隔离模式保留源 cwd，旧会话不自动迁移。范围与剩余工作见 多文件夹工作区计划。旧单目录工作区可直接添加源文件夹。

## 职责与模型

工作区把会话、调度历史、主题/头像、索引开关和偏好归到 workspaceId。WorkspaceInfo 现有 roots（稳定 rootId）、defaultRootId、固定 controlRoot 与 rootsRevision；旧单根数据读入时迁成单元素 roots。path 与 AppConfig.workspace 仅投影默认 cwd，不能用来选择区级管理数据位置。

新建与编辑表单可选 [36 个软件/游戏分类图标](workspace-icons.md)，保存为稳定 `builtin-workspace:<id>` 字符串；缺省开发图标。工作区 emoji 网格与自定义输入已移除，上传图片保留，旧 emoji 仍兼容显示。左栏、调度面板、看板、调度注入和手机列表共用同一资源解析。

AppConfig.workspaces 保存逻辑分组，activeWorkspaceId 表示 UI 当前区。会话已有显式 workspaceId 和独立 cwd；变更工作区默认根不修改会话 cwd。普通源根可跨工作区重用，管理根不能共用。离线根保留登记；外部配置结构损坏保留原记录和 rootsError，拒绝访问并反馈，避免整个配置回到首启默认值。

首启不自动创建工作区。`DEFAULT_CONFIG.workspaces = []`、`activeWorkspaceId = ''`，`workspace` 只是推荐 cwd 投影。推荐根由 `src/main/defaultWorkspaceRoot.ts` 的 `defaultWorkspaceRoot()` 解析为用户主目录下的 `Muster`，三平台使用同一目录名，由 `path.join` 解析分隔符。推荐目录在用户选择该路径并提交创建时按需建立。

`ensureDefaultWorkspaceRoot()` 在启动链（`src/main/index.ts`，ConfigManager 构造后、其他工作区服务装配前）**仅当已有工作区登记确实引用该根**时补建目录：零工作区、已有 config.json 的机器（含旧版指向用户主目录的默认工作区）都不落盘、不迁移；目录被同名文件占用或无写权限时抛错，由启动链用错误对话框明确提示，不静默回退。`normalizeWorkspaces()` 不再给空列表补默认区：只有配置里根本没有 `workspaces` 数组（老单字段配置）才按 `workspace` 路径迁出一个，用户删空后重启仍保持零工作区。回归见 `test/default-workspace-root.mjs`。

## 零工作区的新建入口

演示模式允许直接选择已有项目作为源文件夹。宿主将每个演示工作区的管理数据保存到对应场景，推荐新建项目的位置在可删除场景之外。工作区登记、相对项目绑定和真实 cwd 仍按所选源解析。[本地演示与会话回放](demo-mode.md)

桌面收到零工作区快照后交给 [首次设置](first-run.md)。前三个连接步骤完成后进入工作台，左下角「工作区」标题旁原有的「＋」以描边提示，点击同一入口打开 `CreateWorkspaceModal`。完成过引导的用户关闭最后一个工作区后，桌面显示选目录和建工作区的恢复页。浏览器工作台沿用 `AgentFloat` 的零工作区弹窗，已有工作区的桌面用户仍从该处打开普通多根创建或编辑表单。

`workspaces:list` 经 `StoreProvider.workspaceRecommendation` 给桌面引导表单和恢复页提供推荐目录。两处均预选该目录，用户确认后提交 `ensureRecommendedRoot: true`，`WorkspaceService.open()` 核验目标等于推荐根后才按需创建目录。用户也可直接选择已有项目，选择结果成为源根、默认 cwd 和管理根。推荐名称由桌面本地化为「我的工作区」，也可在提交前填写自定义名称。

配套的主进程放宽：`WorkspaceService.closeError()` 不再要求「至少保留一个工作区」，`close()` 删空时把 `activeWorkspaceId` 置空；`workspaces:close` 的 `applyClosedWorkspace()` 无条件广播 `workspaces:changed`、无条件 `syncFsWatches()`（清掉已关闭区的监听）；`workspaceFile:get` 在零工作区返回缺省配置，不让 `requireWorkspace` 抛错（渲染层挂载即拉该文件，抛错会留下永远 pending 的 ready 态）。回归见 `test/workspace-close-coordination.mjs`、`test/unit/workspace-onboarding.spec.tsx`、`test/unit/agent-float-ws-edit-click.spec.tsx`。

真 Electron 回归 `test/e2e/zero-workspace-onboarding.spec.ts` 使用临时产品数据跑推荐目录创建、重启续办、删空后恢复入口及空工作区的导航快照。普通 dev sandbox 会注入演示工作区，首次设置验收使用无预置工作区的产品启动路径。

左下工作区／调度列表支持按住条目 450ms 后上下拖动排序。按下立即轻压条目，不显示继续按住的文字提示，避免普通点击时提示闪现；触发后整行跟随指针，其他条目平滑让位，虚线空槽立即标出落点，标题显示目标序号与 Esc 取消提示。松手立即保存、整行吸附入槽；短按保持切区／开关对话，拖动生成的点击被抑制，下一次主动按下解除抑制。长按折叠列表自动展开，保留原抓取点，未移动便松手不改变排序。Escape、pointercancel、失去指针捕获、窗口失焦、窗口尺寸变化或祖先滚动取消并恢复原顺序；工作区集合变化、切区禁用或卸载直接清理手势。长按前移动超过 6px 取消武装，避免把普通移动误当排序；右键及外部文件拖入保留原行为。键盘聚焦条目按钮后 Alt+↑/↓ 同样可排序。

工作区列表的标题、名称与状态标签不参与文字框选，停靠和内联布局共用该规则；搜索、重命名及正文保留可选字行为。浏览器拖动回归见 `test/selection-controls-visual.mjs`。

工作区行、排序落点和会话行复用中栏面板的 `--radius-page` 和 `--corner-shape-page`。停靠工作区与同栏顶层会话行共用 38px 行高、2px 行距、图标与标题列，以及动作的右侧留白。工作区头像图案为 14px，按钮命中区为 24px。当前工作区在行左缘内侧显示 2×12px 的中性短竖线。切区按钮按 `activeWorkspaceId` 设置 `aria-current`，停靠和内联列表共用该标记，折叠、排序和打开调度对话时仍随当前工作区显示。

排序由 `renderer/hooks/useWorkspaceReorder.ts` 管理，作为本机列表偏好写入 localStorage `muster.workspaceOrder.v1`，不修改工作区登记、活动区或源根顺序。新工作区追加末尾，已关闭 ID 在显示时过滤；跨窗口 storage 事件同步。折叠态临时置顶当前区，展开后恢复手动顺序。存储失败在列表中明确提示，本次顺序仍可用但不保证重启恢复。Pointer Events 统一鼠标、触控及触笔路径，无平台专属命令。

折叠直接堆叠真实条目，保留头像、文字及行圆角。收起与开合动画期间行背景强制不透明，阻挡后排文字；展开落定恢复主题材质。对话态只收窄正在对话的条目，后排保持各自正常宽度。行深度持续保留，重叠时从前到后逐层降低绘制层级，缩放始终以顶部中心为原点。使用共用 renderer 实现，无平台分支。

工作区切换沿 `workspaceTransit.ts` 的胶片过场执行：切换前读取目标工作区布局，骨架按目标的会话栏宽度、虚拟屏终端/Git 比例、停靠侧及解析后的工作区框色/画布色绘制；左栏实用工具沿真实磁贴网格占位，中栏与右栏保留独立面板边界、内容条和底部输入区的结构，中栏内容列与输入区沿会话实际的 `--chat-col-max` / inset 规则限宽居中，输入框高度按编辑区 64px 加底栏 46px 的实际基础结构占位。位移使用工作区专用 `--dur-workspace`，目标工作面提交后骨架立即开始淡出，切区后的淡出使用 `--dur-workspacefade`。目标布局读取失败时回退当前布局。过场遮罩期间左栏栈暂停几何和活动行 reveal，切换完成后恢复，避免切换动画与保活列表测量争用渲染主线程。

拖动期间固定 DOM 顺序和展开后的槽位几何，每帧合并指针输入，仅通过 transform 移动原行；命中计算不读取正在动画的邻居位置。松手使用公共 panel token 吸附，结束后提交 DOM 顺序并清除临时样式；减少动态效果时立即落定，中途切换偏好也结束等待。`AgentFloat` 的未读调度回复层按工作区行纵向坐标重测，拖动和折叠期间跟随行位置；排序时禁止折叠／新建，且藏按钮只关 opacity/visibility 不退布局——按压态在每次 pointerdown 行时立即挂上，`display:none` 会让栈头高度塌 6px、点一下行表头就下沉又弹回（2026-10-31 报单，守卫见 `ws-stack-collapse.spec.tsx`）。内联栈显式恢复指针命中，幽灵占位仍不接收指针。

`test/unit/workspace-reorder.spec.tsx` 覆盖反馈、跟手／让位／吸附、持久化、取消与清理、短按、连续新点击、键盘、存储失败、折叠抓取点及真实 AgentFloat 详情卡互斥；`agent-ws-scheduler-entry.spec.tsx` 覆盖正常详情预览，`ws-stack-collapse.spec.tsx` 验证当前项语义随切区和折叠更新。`node test/workspace-reorder-visual.mjs` 使用生产组件/CSS、模拟 IPC 和真实 Chromium 鼠标，覆盖停靠／内联 × 深／浅 × 780／390px 的八组流程，包括折叠展开、减少动态效果和点击切区时短竖线移到当前项。停靠夹具用真实会话栏测量两种行的图标、标题、动作和行距，并在实色框和模拟 Mica、Vibrancy 下与中栏面板比较计算圆角。截图落于 `.tmp/workspace-reorder-visual/`。

管理根的 workspace.json 由 `metaAgent/workspaceFile.ts` 读取：仅文件不存在时创建默认配置，合法对象补齐缺省键并保留未知字段。JSON 损坏、顶层或 git 字段结构非法、读取权限错误均向调用方报错，不重置或覆盖原文件；准备命令设置的保存同样遵守这一规则。回归见 `test/worktree-preparation.mjs`。

编辑弹窗的“隔离准备命令”通过 `workspaces:getWorktreePreparation` / `workspaces:saveWorktreePreparation` 按显式 workspaceId 读写，允许编辑非活动工作区。加载返回源根/管理根物理身份、根版本与配方版本；保存过期请求拒绝覆盖，保留未知及其他 Git 配置。命令独立保存，不在保存时执行；关闭主表单不撤销已经保存的命令。仓库刷新只更新目标候选，不重置命令草稿；命令作用范围及实际执行见 [Worktree 隔离](isolate-worktree.md)。

桌面新建任务默认共享检出，用户可手动选择隔离；隔离仓以版本化路径映射附加到任务。CLI 可按引擎支持情况设置逐任务模型、权限、模式和思考强度，具体来源及限制见 [内置 Runtime 与 Harness 接入](agent-runtime-registration.md)。单一运行 cwd、固定管理根与主审阅组分开保存。聚合目录可作为 cwd，其他源仓继续共享，详见 [Worktree 隔离](isolate-worktree.md)。

## 关键入口

启动恢复、扩展绑定、记忆中心/调度记忆/订阅策略、任务归档/守卫与事件清理统一使用固定管理根；真实 Electron 创建→切换默认根→重启用例验证管理根处理和第二根对照数据不变（28.9s）。合入受阻通知按全部源码根/extra 仓及实际会话仓组归属，不以活动区兜底。

| 文件 | 作用 |
|---|---|
| src/shared/types.ts、workspaceRoots.ts | 根与 FileRef 模型、旧单根适配、默认 cwd/管理根、节点身份纯函数 |
| src/main/workspacePaths.ts | 配置结构归一、realpath 去重、显式工作区/源根解析、FileRef/绝对路径定位、异步版本 token |
| src/main/sessions/targets.ts | 会话/派活源目录选择、来源快照、Junction 校验、旧归属唯一回填及外置树登记反查 |
| src/main/workspaceExecutionContext.ts、agentSession/host/workspaceContext.ts | GUI/子代理目录快照、物理文件策略、全部引用根的运行占用及 SDK 额外目录 |
| src/main/workspaceFileAccess.ts | 文件 IPC 与媒体统一 FileRef 适配、旧参数歧义保护、异步根版本与源根删除保护 |
| src/main/defaultWorkspaceRoot.ts | 推荐目录名/推荐工作区名称/纯路径计算（Node-only，无 electron 依赖） |
| src/main/config.ts | 单根迁移、首启零工作区归一、已登记推荐根补建、管理根冲突诊断、活动区投影与持久化、宿主递增根版本 |
| src/main/index.ts | 启动链按已有登记补建推荐根、创建失败的错误对话框提示（首启不建目录） |
| src/main/workspaceConfigPatch.ts | 通用配置 IPC 的工作区保护，拒绝绕过专用生命周期/版本/依赖守卫 |
| src/main/workspaces.ts | 目录校验/open、多根登记/元数据更新、固定管理根与移除守卫、switchTo/close |
| src/main/workspaceRootDependencies.ts、workspaceRootUses.ts | 移除依赖汇总、会话创建/释放及文件操作在途登记、客户端文件视图归属 |
| renderer hooks/useFileRootUse.ts、webGatewayStatus.ts | 文件视图登记/释放、断线只读与重连重登记；状态订阅不初始化连接 |
| src/main/ipc/workspaces.ts | 创建/编辑/切换/关闭 IPC、推荐信息随 list 下发、删空时无条件广播 changed、零工作区 workspaceFile 缺省、索引与 workspaceFile 配置 |
| src/main/ipc/helpers.ts | resolveWorkspacePath、codeIndexRootsFor、applyWorkspaceActivation |
| src/preload/index.ts、renderer store.tsx | API、列表/变更事件、统一工作区动作 |
| renderer components/CreateWorkspaceModal.tsx、WorkspaceRootsEditor.tsx | 普通创建与所有工作区编辑共用多根草稿、版本、管理根保护和批量选择；`required` 常驻引导与推荐路径一键填入；保留显式单目录兼容模式 |
| renderer components/WorkspaceRootDependencies.tsx、workspaceDependencyNavigation.ts | 显示移除阻挡、保持草稿及按原工作区/根定位对象，等待后重验身份 |
| renderer panels/AgentFloat.tsx | 新建/编辑弹窗宿主，索引勾选/进度，工作区堆叠列表 |
| renderer onboarding/WorkspaceSetup.tsx | 桌面删空后的恢复页，默认推荐目录、原生单文件夹选择和名称 |
| renderer components/ChromeBar.tsx | 顶栏“工作区设置”请求当前区编辑弹窗，应用设置另有入口 |

## 生命周期/数据流

1. 创建：普通入口批量选择源文件夹，提交 roots/defaultRootId/controlRootId；旧单目录接口继续兼容。新条目生成 workspaceId，源根校验真实目录，管理根冲突拒绝。旧 open(path) 按管理根查找已有区并切换。
2. 激活：applyWorkspaceActivation解析 controlRoot、确保脚手架、绑定扩展/调度桶、恢复会话选中、同步watcher、为全部源根后台预热轮次文件基线、广播workspaces:changed并重放主题。启动恢复、源根编辑与关闭活动区后的回退激活也接预热；不等待扫描完成，预热期间发送按文件写前采集，碰撞与安全回退边界见 [轮次快照](turn-checkpoint.md)。
3. 编辑：名称/头像/主题与索引保持原接口；源根/默认 cwd 变更须携 expectedRootsRevision，宿主检测过期拒绝。表单只显示完整路径，取消源根排序与显示名称编辑，既有 label 元数据仍保留。普通更新禁止重定位现有 rootId，移除管理根拒绝。移除其他根先经过 rootRemovalGuard，未注册守卫时拒绝；解除关联不删盘。索引接口使用 rootId+子路径的引用。
4. 关闭：编辑窗口使用共用 AppConfirmDialog 确认，显示工作区名和保留磁盘文件的说明；取消保留编辑草稿。关闭最后一个工作区后进入空工作区的新建页。宿主先检查目标，再撤销调度桌面任务并关闭区内会话，全部成功后才从配置移除工作区、清理调度状态并重绑回退区。撤销或会话关闭失败时保留工作区并返回错误；此前已成功关闭的会话不会自动恢复，提示明确说明可能部分关闭。Worker 代次写入失败后，该 Worker 在本进程内保持冻结；排除存储问题后须重启工作台再试。

通用 `config:update` 用于设置；工作区登记、活动区、默认 cwd 的变化必须经 `workspaces:open/update/switch/close`。若请求携带这些字段，仅与当前快照完全一致时兼容接受；过期或改变登记的请求整项拒绝，不部分保存其他设置。「完全一致」按 `workspaceConfigPatch.ts` 的 `JSON.stringify` 全等比较判定——**键序也算变化**：语义相同但键序不同的对象同样会被判「改了登记」而整项拒绝（现实触发面窄：patch 由同一套类型化对象派生、JSON.parse 往返保序，属刻意从严的已接受口径）。设置页保存排除 workspaces、activeWorkspaceId 与 workspace，旧草稿不能覆盖另一窗口的新根/活动区。主进程 WorkspaceService 继续使用 ConfigManager 内部写入；本保护不阻止用户手工编辑磁盘配置文件，不替代完整根移除依赖检查。回归见 `test/workspace-config-ipc.mjs`、`test/unit/settings-page.spec.tsx` 与独立 Electron 的 `test/e2e/workspace-file-roots.spec.ts`。

### 源文件夹移除依赖

`index.ts` 在主进程服务装配后接入守卫。运行/启动中的会话（含 hidden 会话）、仍登记在会话上的隔离树（包括已归档但清理未完成/保留的树）、派活队列及正在出队的任务、服务定义（停用仍有来源）及启动快照、运行中的后台任务、未完成的共享任务及其排队写入、客户端打开的文件/目录和在途文件写入/删除都能阻止移除。共享任务按 lockScope 的固定来源检查，todo/blocked/needs_review 仍有依赖，done 释放；旧来源无法确定时保守阻挡候选根。设置页显示任务 ID/标题及完成或由宿主重新指定源根的提示，不把持久任务误报为临时操作。失败返回 `rootDependencies`，含 rootId、类别、对象 ID、名称/路径以及会话/服务 ID；检查与配置更新同步完成，拒绝时没有部分保存，也不替用户关闭任务或删除目录。

创建/派活在第一次 await 前登记源根，直到会话入列或失败；出队到会话入列之间不会失去依赖。归档/关闭异步释放期间也保留登记。文件 IPC 在 realpath 校验前登记写入/删除，完成或失败后释放；新文件的 Junction 别名还未能定位到单根时短暂保留所有候选根，避免校验与写入之间可被撤销。写入按稳定根 ID、登记路径与物理路径核对，改名/排序/默认变更不会把已完成写盘误报失败；查询/读取仍按根版本丢弃旧结果。

会话读取范围在内存中持有不可由模型指定的身份令牌；归档和关闭会使令牌失效，即使随后恢复同一会话，也不能重新使用归档前的在途范围。浏览器上传及内部面板桥复用此检查；重新调用需重新取得当前范围。

隔离组集合按每组 sourceRoot 独立汇总，hidden/已归档会话保留的第二组也阻止移除其源根；父子根/物理别名共用容器后，原选择根仍以 sourceRoots/session.sourceRoot 保留依赖。集合损坏时保守挡住该区候选根。会话重启与续作保留全部组、原来源及实际子目录 cwd，借用第二组按该组来源解析。内部跨组创建在目录校验和 runtime probe 前占用全部选中根，发布前重验，第二组失败不启动半个任务；跨组创建/合入与手动逐组清理已接通；残留树或分支保留全部来源和归档所有者，完整采纳/Worker 收尾及普通 UI 开放继续在 P4 实施，见 [隔离 worktree](isolate-worktree.md)。

`fs.openFile/closeFile` 以主进程生成的客户端身份登记 FileRef，另一客户端不能解除；打开新路径校验失败保留原视图，晚到结果不覆盖新登记。桌面文件面板隐藏时继续保留打开态，换文件/清空/卸载释放；网页断线或桌面 WebContents 销毁释放其视图。写入独立于客户端登记，断线后仍保护已开始的写盘。网页重连按原 FileRef 重登记，确认前不可编辑；离线浏览器尚未发到主进程的本地正文不属于主进程在途写入，重连若来源已移除须明确报错，不改指默认根。

当前检查覆盖现有单来源会话、跨根隔离组，以及 GUI 回合/后台子代理和 CLI 进程快照中全部引用根。CLI 在启动 await 前登记，异步 kill 后等实际 PTY 退出才释放，不能因归档立即允许移除附加根；跨根隔离组的全部源根和成员均保持占用登记。编辑弹窗显示源路径、类别、对象和处理入口；保存被拒后保留草稿，重试再向主进程检查。查看会话/服务复用会话选择，文件携原 FileRef；动作会关闭设置，未保存草稿不生效。等待列表或切区时对象/根/弹窗失效报错并保留设置，不选择默认根；隐含临时会话不可选中，排队与在途操作提示等待。文件来自其他窗口时须在原窗口关闭，入口不会代用户停止任务、解除其他客户端或删除目录。逻辑回归见 `test/workspace-root-dependencies.mjs`；文件视图、保存失败保留与重连见 `test/unit/file-root-use.spec.tsx`、`file-editor-roots.spec.tsx`、`workspace-file-trees.spec.tsx`；编辑草稿/实际 Store/服务跳转/等待失效及重复保存见 test/unit/workspace-root-dependencies.spec.tsx；真实客户端归属/隐藏视图/断线解除关联及设置阻挡→原文件导航见上述 Electron/Web E2E，CLI 附加根占用见 `test/e2e/cli-workspace-context.spec.ts`。

## 路径消费者与边界

- 文件 IPC、文件树/编辑器、媒体、Markdown 相对内链、历史与批注回跳已贯穿 FileRef；Web API 代理映射到同一 IPC，媒体网关保留根查询参数。主进程 watcher 按物理范围共享句柄，事件带根/版本，支持根级错误与手动重试；多根查询后端、@ 与 QuickOpen 文件/内容搜索已接通。区外文件单独只读预览，见 [文件面板](files-panel.md)、[文件预览](file-preview.md)。
- Git 列表扫描目标工作区的全部源根，物理重叠去重、按最具体根分组；准入每次核对当前登记，旧缓存不能延续已解除关联的授权。面板 Git 读取/写入均携工作区 ID 和根版本，初始化缺省 cwd 取该区默认根；旧 IPC 在进入时捕获活动区。内部任务/隔离操作携带固定工作区范围并覆盖全部组，版本或登记失效时拒绝；真实生命周期见隔离 worktree 文档。发现首次/手动建快照，派活复用，普通事件不重扫，见 [Git仓库树](git-repo-tree.md)。
- 会话/派活入口支持 rootId，默认从 defaultRootId 取 cwd，并保存独立 sourceRoot；队列固定来源，创建/启动/重拉拒绝来源失效，fork/续作继承。旧无 ID 的路径归属仅唯一匹配才回填；简报词表/记忆与 provision 取管理根，技能仍取源目录。桌面/手机任务与定时服务的来源已固定，后台任务继承父会话来源与实际 cwd，等待期间失效拒绝拉起；GUI/后台子代理、CLI 和调度已捕获全部目录范围、登记运行占用并按引擎能力接入。CLI 普通回注保持进程快照，重拉才刷新。调度在记忆等待前占用全部根，目录变化下轮重建连接并续用原会话文件，保留 cwd/历史；Pi 原生文件工具校验同一快照，shell/MCP 不承诺 OS 沙箱。见 [会话模型](session-model.md)、[后台任务](background-tasks.md)、[Worker注入](worker-inject.md)、[GUI Worker](gui-worker-session.md)、[调度提示词](scheduler-prompt-injection.md)。
- 激活扩展、区配置/工作区文件、记忆 IPC 与脚手架按 controlRoot 解析；调度态势/记忆/策略、后台任务资格、事件清理和启动恢复也绑定同一管理根。技能按 cwd 发现并 realpath 去重，见 [技能](skills.md)、[记忆系统](memory-system.md)、[动态工具](dynamic-tools.md)。新增根的用户数据/执行信任不能自动合并。
- Web 网关文件 Ref API/媒体已用相同入口；[手机端](mobile-surface.md)已接通源文件夹选择、Ref 列表/文本/内链与媒体/HTML 来源资源，Office/归档仍提示电脑端预览，本地选择器不可经 Web 调用。

工作区内文本/目录/stat/删除入口与媒体协议已增加 realpath 校验，包含新文件最近存在祖先；源根自身可以是 Junction，根内指向区外的 Junction 不扩大权限。旧纯词法校验误拒绝 ..visible.txt 的问题同步修复。异步文件结果核对根版本；删除目录不能绕过根移除入口删除已登记子根。文件、Git、会话与技能入口均按登记身份校验；shell/MCP仍不承诺 OS 沙箱。

创建与编辑默认使用多根表单，旧单目录工作区也能直接添加第二根；可增删和切默认目录。名称与头像同组，头像选择按需展开；源根列表每项只显示完整路径、默认标记与展开箭头，展开后提供默认目录和移除，同一时间展开一项。管理目录不可移除。编辑页把隔离准备命令和关闭工作区放入更多设置；收起内容用 inert/aria-hidden 禁止聚焦，草稿保活，开合沿用 usePresence/acc。pickDir(true) 批量选择，显式单目录兼容模式和旧无参数接口保留。关闭后忽略在途选择结果；保存经父层、Store 和主进程透传全部根、默认根与版本，管理根固定。头像解码和保存期间锁定编辑及重复提交，关闭/改编辑目标后丢弃旧返回。路径自然换行，320px/390px 表单不横向裁切；下拉复用 CustomSelect，两个弹窗的触发器左右内边距均为 12px，浮层使用项目 c-select-menu。

`workspace-roots-editor.spec.tsx` 验证增删、默认目录、无排序及改名入口；`task-workspace-simplification.spec.tsx` 验证简洁首屏、隐藏区域不可聚焦和开合反转。此前真实 Electron 创建入口用例验证过旧区增根、批量创建、管理根/默认根及第二根文件读写，本次只更新其名称定位及展开步骤，未重跑该用例；本次视觉证据来自实际生产组件与生产 CSS 的 Chromium 夹具，IPC 为模拟。

文件导航、监听、查询、@/QuickOpen 与 HTML 相对资源已接通 rootId；桌面/Web 第二根 HTML、图片与 CSV，以及手机选根/文本/图片/HTML 真实预览通过。独立 Electron 全格式矩阵验证 19 类样例 A→B→A 的 57 次打开，修复 Word 左侧裁切，媒体与源字节/根身份一致。Git 多根发现/列表与面板操作范围已接通，目录离线/扫描失败显示具体路径并可重试，保留其他来源；扫描不完整的仓组禁止创建隔离。失败/重启/移交生命周期及只读性能已补验，阶段/取舍/验收见计划。

桌面任务/空会话与手机创建入口现复用 `components/TaskSourceField.tsx`，运行位置直接显示完整路径，默认选择 defaultRootId 并在打开后固定工作区/源根；不随新默认目录移动，失效来源拒绝提交。新建任务的会话名称在任务框上方，运行方式与会话模式并排，模型与描述符驱动的参数直接显示；GUI 私有参数不传给 CLI。无更多选项，「新建空白」与「开始任务」相邻，空任务仍可创建空白。隔离开启及重新开启时全选已发现的可隔离仓库，默认运行仓优先当前源根的根仓，其次唯一子仓；多个子仓须用户选择。范围收起时显示全部/已选摘要，错误及扫描告警仍可见。手动刷新保留用户选择，来源版本或路径变化不会将旧选择默默转移，失效时禁止提交。预检/创建携 rootId 与 rootsRevision，空会话创建失败保留窗口，任务排队回执不等同已建会话。更多运行与来源边界见 [会话模型](session-model.md)。普通多根入口已开放；各引擎已接入的目录范围与限制见 GUI Worker、Worker 注入和调度提示词文档。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D08-D00.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：多文件夹逻辑工作区——一个 workspaceId 归拢多个源文件夹（roots+稳定 rootId+defaultRootId+固定管理根 controlRoot+rootsRevision），会话/调度/文件/Git/主题跨根共享；左栏长按拖动排序；新建/编辑多根表单。**已知在途背景（如实标注）：多文件夹基础层 P0–P5 实现与自动化验收已完成，但按 multi-folder-workspace-plan.md 仍「等待实际使用验收」——本域 review 结论应把这一状态计入，验收未完成前不把基础层行为当作长期契约冻结。**
- 为什么这样设计：固定管理根（第 5 项首版方案）承载 workspace.json/扩展绑定/记忆/调度桶/启动恢复——不随默认 cwd 或排序漂移，管理根不可移除、不能两区共用（防 `.muster` 数据互相覆盖）；rootsRevision 乐观并发——源根变更须携 expectedRootsRevision，过期整项拒绝不部分保存；config:update 保护排除 workspaces/activeWorkspaceId/workspace 字段（旧设置草稿不能覆盖另一窗口的新根/活动区）；移除走 rootRemovalGuard 依赖汇总（运行会话/隔离树/派活队列/服务定义/后台任务/共享任务/客户端文件视图/在途写入），拒绝时不部分保存、不代用户关任务删目录；排序仅 localStorage 本机偏好（不进工作区登记，跨窗口 storage 同步）；离线根保留登记报错、外部配置损坏保留原记录拒绝访问（不静默回退首启默认值）。
- 明确不做：不做第 6 项「独立工作区管理目录」迁移（接口已预留）；会话 cwd 不随默认根变更重定位；解除关联不删盘；旧单根数据/旧 open(path)/显式单目录模式保持兼容；普通源根可跨工作区重用但管理根不行。
- 歧义点：独立工作区管理目录（计划第 6 项：按 workspaceId 放应用目录，迁移配置/任务/记忆句柄/扩展，含备份失败恢复与 CLI 协议路径适配）——A=维持固定管理根首版，等真实痛点（管理根冲突、换机迁移需求）再立项；review 不把「管理根不能移除/换目录」当缺陷，只审守卫是否拒得干净／B=排期实施第 6 项。推荐 A——计划明文「接口预留第 6 项、独立管理目录迁移不属于本次首版」，且基础层尚未经实际使用验收，先行做迁移属风险倒挂；管理根现实痛点（如想把仓库挪盘）出现频率未知，先攒证据。

文件监听退出由`WorkspaceFsWatcher.stopAdmission()/shutdown()`管理：先停止新根/事件受理、清空debounce，再等待正在进行的真实路径检查与所有原生FSWatcher close事件（含配置变化已退休的句柄）。close失败保留owner并显式报告供重试；不把调用close()当成底层已经关闭。`stopAll()`仍用于可恢复的工作区重置，进程最终退出使用shutdown。
