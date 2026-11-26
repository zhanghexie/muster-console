# 隔离 worktree（派活 isolate + 验收合入）

> 状态：2026-10-07 已实现私有合入快照、可逆审查免确认、物理路径归属核对与逐仓冲突报告；外置存储、多层建组与安全清理维持。历史背景（2026-09-21：R-18b 多仓隔离组·嵌套容器落地——自动发现嵌套独立仓建组、repoSet 收窄、全或无预检、零改动过滤、逐仓清理，见 §7。2026-09-20：`sessions.review` 确认框按本次 decision 展示动作与后果。2026-09-18：隔离树目录名改为纯 `<sessionId 前 8 位>`，与分支 `ao/<id8>` 对齐，存量 `<id8>-<slug>` 共存不迁移。2026-09-16：`sessions.integrate` 审批策略化，`approval` 缺省 required / 可 auto 免批留痕）
> 代码：创建 `src/main/sessions/createTerminal.ts` isolate 分支（2026-09-26 自 sessions.ts 拆出，sessions.ts 保留委托）+ `src/main/git/worktree.ts`；收尾/自愈 `src/main/git/worktreeSessionOps.ts`；合入 `src/main/git/worktreeIntegrate.ts` 与 `src/main/git/mergeIsolate.ts`；多仓组 `src/main/git/nestedRepos.ts`；Worker `sessions.requestIntegrate` → 调度 `sessions.integrate`
> 关联：看板归档清理见 [board-status.md](board-status.md)；派活见 [worker-inject.md](worker-inject.md)；设计定稿见 ../plans/archive/collab-retro-plan.md（已归档）链四

---

## 1. 分工：干活在树里，收尾在主仓

### 新建目录布局（2026-10-19）

新建普通 worktree、单仓隔离及多组任务统一使用 `<存储根>/t-<12位任务哈希>/<仓库名至多16字符>-<10位仓库哈希>`。任务哈希输入完整工作区 ID 与完整会话 ID（普通手动创建用目录名作为任务键），仓库哈希输入规范 commonDir；不会把相同 UUID 前 8 位直接当作相同任务。目录名只含 ASCII 字母、数字、连字符和下划线，附带哈希避免 Windows 保留设备名；Windows 路径身份忽略大小写，macOS/Linux 保留大小写。系统存储根仍遵循各平台应用数据目录及已有自定义配置。

`workspaceResolve.ts` 的 `compactWorktreePath` 只决定新建落点。旧工作区/仓库哈希层级、旧 `<id8>` 或 `<id8>-<slug>` 目录及持久化映射不迁移；审阅、合入、清理仍以已登记的实际路径和 Git 身份为准。同一旧任务追加新仓可以同时持有新旧布局，不重建已有成员。

短哈希不是所有权凭证：准备阶段拒绝已存在的目标，创建阶段再次检查，并以非递归 `mkdir` 独占目标目录；遇到占用或短标识冲突明确失败，不借用空目录、不覆盖、不自动清理对方资源。创建失败仅尝试移除自身标识未变且仍为空的占位目录，已产生内容或身份变化则保留给既有回滚保护处理；面向用户的 IPC 翻译保留目录提示，不改写 Git 原始诊断与路径，分隔符有歧义时保留整条原文。分支命名仍为 `ao/<id8>`，不同完整会话若撞到已有短分支名，也明确失败而不复用。路径规则由 `test/git-workspace-resolve.mjs` 覆盖三平台参数、名称和边界；`test/task-worktree-create.mjs` 以真实 Git 覆盖新旧共存、短分支冲突、目标占用、并发独占和各创建入口。

新建隔离任务的登记 `cwd` 保存来源位置，包括非 Git 聚合目录。`worktreeGroups.cwdPolicy=source` 标识该登记格式，`revision` 记录映射代次。`worktreePath` 是稳定的主组投影，供默认审阅和操作使用。旧会话缺少该标志时继续使用登记的树内 cwd。

Codex GUI 和 Codex CLI 在启动前由 `workspaceExecutionContext.ts` 从登记的源仓映射出实际执行 cwd。源仓内的子目录映射到任务树中的对应子目录。覆盖所选仓的非 Git 聚合目录使用主组树根。仓库未登记、对应子目录缺失、工作树身份变化或分支与登记不符时会报告错误并拒绝运行。GUI 线程、CLI 和宿主后台 Shell 均使用校验后的目录。从工作区访问其他已登记的任务仓时使用其绝对路径。采用来源 cwd 的其他 Worker 通过任务树绝对路径修改、测试和运行 Git。

收尾的 git 不能让同一只 Worker 做：

- `git merge` 进 main 要在**主仓 cwd** 执行（main 已在主仓检出）
- `git worktree remove` 从 worktree cwd 会失败；Windows 上进程 cwd / GUI 子进程还锁着目录

人不需要切到调度会话再说一遍。Worker 通知调度即可：

| 角色 | 做什么 |
|------|--------|
| Worker（CLI / GUI） | 在对应任务树中修改、测试和提交，跨仓操作使用任务树绝对路径。做完报 `needs_you`，人明确说合入后调 `sessions.requestIntegrate` |
| 调度 | 收到【请合入隔离 worktree】后立刻 `sessions.integrate`；按 §3.1 决定 `approval` |
| 宿主 | 在主仓 `git merge` → 停会话 → 删 worktree → `git branch -d`；AI 发起的合入先经业务审核，人工看板验收直接进入 Git 预检 |

---

## 1.1 会话中按需追加

`sessions.isolate { sessionId?, isolationGroups, apply? }` 默认只规划所选仓的 dirty/现有映射，`apply=true` 复用 `git/worktreeAttach.ts` 的任务/commonDir 锁与建树事务追加。Worker 身份绑定自身，调度支持标准会话引用并核对工作区；隐藏、归档、Shell、非 Agent 会话不创建资源。重复本任务成员不重建，不借用其他任务资源。给已存在父组追加 repoSet 会明确要求直接选择实际子仓，不静默忽略请求。

创建、登记和当前连接可访问分开返回：`activation=next-connection` 表示下一次 GUI 连接快照生效，当前回合保持原捕获范围；PTY 的原生额外目录须重拉/续作更新，文字回注不能扩权。追加失败保留旧组和 cwd，只补偿本次资源；发布持久化失败先恢复并保存旧登记，再回滚新树，保存恢复也失败则保留资源与映射、报告路径，避免删除可能仍被磁盘引用的树。准备命令目前由首次创建路径执行；追加不自动重跑准备脚本。

遗留资源、所有权变化及回滚失败的工作台通知按当前语言显示；删除会话时历史清理和 worktree 清理同时失败也会分别保留两条原因。给 Agent 的操作回执、实际路径及底层诊断保持原文。

新模式单组丢树也保留元数据并拒绝继续，不静默转写源目录；续作转移全部映射和借用引用。审阅/提交与交验维度门按全部登记成员处理，源 dirty 不自动迁入或清除。并发提醒按物理文件区分不同树，回退额外核对当前逐仓可写策略，不能用共享父根绕过新映射。

## 2. Worker：`sessions.requestIntegrate`

Catalog `1.19.0`。在 Worker 白名单与 GUI `HOST_STATUS_TOOL_IDS`。CLI 经令牌可省略 sessionId。**不是 dangerous**（不执行合入；请求前可能做 P11 机械快照提交）。内部走 R10 上行通道（通信单通道）：消息账本 `kind=ask`（tag=notice、meta.intent=integrate，askId 为回复句柄），调度文案仍含【请合入隔离 worktree】。

无隔离 worktree 的会话调用会抛错，不通知调度。调度未就绪同样抛错。

协调文案由 `src/shared/integrateRequest.ts` 生成，与派活时的「任务已直接拉起」一样走 `orchestrator.send`（busy 则排队）。

多组任务使用 `worktreeTaskWorker.ts`：全部来源根与任务/仓操作锁在首 await 前占用；全部成员身份、注册、锁、分支/提交与状态先预检，再深处先提交。needs_you 检查全部组但不提交，提示按 rootId/groupId/嵌套路径区分。requestIntegrate 逐仓机械快照，不碰源检出用户文件/索引；子模块先提交子仓，再快照父仓 gitlink。钩子失败、晚到提交、身份变化或最终仍脏时阻断 notice，保留前序提交与失败仓索引；重试使用真实 Git 状态。发送前再次校验所有权和物理身份，结果/持久待处理请求/协调文案带全部固定组映射，不随默认根/排序变化转移。主仓注册按实际路径核对；Git 将吸收型子模块主检出记为 gitdir 时，用本地 core.worktree 精确反解，不能仅凭 commonDir 相同准入伪造主仓。真实 Git、实际请求入口、三层嵌套、子模块和部分失败回归见 `test/task-worktree-worker-guard.mjs`。Worker 宿主 Git 命令通过 gitEnvironment.ts 清除继承的仓库定位/索引/局部配置环境，显式固定 --work-tree，保留全局配置与认证环境；真实重定向回归确认源仓 HEAD/索引不变。既有准备命令、Node PTY 与 GUI 跨组释放回归保持，新增 source-cwd 模式另有定向验收。

---

## 3. 调度：`sessions.integrate`

**不在** Worker 白名单。调度经 Catalog 调；`sessionId` 必填。AI 发起合入时由会话服务提交安全审核，审核通过后复核目标，再进行 Git 预检；看板人工点击「通过并合入」直接进入 Git 预检。`approval` 影响合入结果留痕和失败通知，不绕过 AI 的业务审核。

| 参数 | 说明 |
|------|------|
| `sessionId` | 要合入的隔离 Worker |
| `target` | 合入分支；省略=建树时记录的 base 分支（会话 `worktreeBaseBranch`，「从哪建回哪」，R-18）；旧会话无记录或 detached 建树才回落默认分支 |
| `message` | 可选合并提交说明 |
| `noFf` | `true` 时 `--no-ff`；**默认 false**（允许快进；是否改默认待产品决策） |
| `stashMain` | 主仓脏文件与待合入重叠时先将**重叠文件**存为私有 Git 快照再合、成功后按固定 ref 恢复（不读写共享 stash 栈）；默认 false。**仅 `sessions.integrate` 透传**；`sessions.review`（看板「通过并合入」）不带此参数，重叠会拒绝并弹失败 toast |
| `skipNpmInstall` / `skipTypecheck` | 关闭合入后依赖回灌 / typecheck 闸 |
| `onGateFail` | `warn`（默认：合入成功、闸失败只告警）或 `abort`（回滚 merge） |
| `approval` | `required`（**缺省**）或 `auto`；其它值按 `required`。无论取值如何，AI 合入都经过业务审核 |
| `confirmNote` / `reason` | 可选；确认框说明。`auto` 时写入桌面通知与验收账本 |

AI 合入的安全审核材料包括工作树与仓库快照；审核疑点或服务不可用时转人工确认，拒绝则不合入。人工看板验收不调用安全审核。`approval='auto'` 成功后仍留痕（失败不 toast）。

合入失败可见性（操作者 vs 调度）：

- **手动**（看板「通过并合入」`sessions.review` / Worker `sessions.requestIntegrate` 本身失败）：桌面 toast，文案含失败原因（如主仓脏重叠文件清单）。`updateKey=integrate-fail:<sessionId>`。编排事件 `merge_blocked` 仍发给调度（不替代给人看的反馈）。
- **自动**（调度 `sessions.integrate` + `approval=auto` 免确认）：失败只走编排事件，不重复弹用户通知。

### 3.1 调度合入留痕

`sessions.integrate({ sessionId, approval: 'auto', confirmNote: '样式微调' })` 成功后记录桌面 toast、会话 `acceptanceLog.note` 的 `approval=auto` 前缀及工具结果；该参数不跳过会话服务的安全审核。调度 `sessions.review` 的通过动作在有隔离树时也调用同一合入服务；人从看板发起的通过动作使用人工来源，不送审核。打回、搁置和仅归档不执行合入。

宿主步骤：

1. 确认隔离 worktree 干净（未提交则拒绝）
2. `git status --porcelain` 与 `HEAD...branch` 待合入文件求交：重叠则拒绝并列出文件（**不是冲突**）；`stashMain:true` 时只将重叠路径存入 `refs/muster/integrate/<uuid>` 再合（空 `--` 不带 pathspec 已不用——部分 git 会 stash 空集仍被拒）
3. 在**主仓** `git merge` 隔离分支（journal 走 `.gitattributes` `merge=union`，超时 `MERGE_TIMEOUT_MS` 15 分钟——合并提交会触发仓库的 pre-merge-commit 全量门禁）。冲突 abort，报告分级（机械/需裁定）+ 调用点；门禁拒绝（留下 `MERGE_HEAD`、无冲突文件）则 `merge --abort` + 还原私有快照，返回 `blockReason: 'gate-failed'`、`gates.mergeHook: 'failed'`，消息带门禁输出末尾
4. 若本次合入碰到 `package.json`/`package-lock.json`：`npm install`；若有 `scripts.typecheck` 则跑闸。Windows 经 `cmd.exe /d /s /c` 执行固定 npm 子命令（不能直接 execFile npm.cmd，否则可能 spawn EINVAL）；cwd 独立传递，不插入命令文本。`test/post-merge-npm.mjs` 在中文/空格/元字符临时路径运行真实离线 install 与 typecheck。默认失败只告警
5. 把工具结果回给调度
6. `phase=done`，约 2.5s 后安排归档与安全清理；旧单组、`cwdPolicy=source` 单组和多组共用 `finishIntegrate`。定时器在重启窗口会丢：未归档但已 done 的会话左栏/看板按完成态显示，可手动归档重试。实际清理仍逐仓检查身份、引用、工作区状态与目标分支，未通过时保留资源并通知；`cleanup: 'scheduled'` 不表示已经删除。

失败（不产生半成品 merge）：**该会话不是隔离 worktree**、worktree 未提交、切不到 target、脏主仓重叠、冲突（已 `merge --abort`）、pre-merge-commit 门禁拒绝（已 `merge --abort`）。已合入则跳过 merge，仍走清理。多仓组（会话有 `worktreeRepoSet`）额外走零改动过滤 + 全或无预检 + 逐仓真合（§7.2），结果带 `repos` 逐仓清单。

**冲突结构化报告**：真冲突时 abort 前抓冲突文件 + 领先提交数；并区分机械可解（`docs/journal/*.md` 等）与需裁定，尽力附 `git grep` 调用点。主仓脏文件重叠时**不再**误报「未能列出冲突文件」。

---

## 4. 创建、删除与归档收尾

永久删除界面在预览和实际清理期间保持弹窗打开，显示当前阶段并禁用重复操作；失败弹窗保留 Git 或目录原始原因，提供二次确认的“强制删除 worktree 和分支”。该选项绑定本次删除指纹，强制移除已登记 worktree 及其本地分支，仍被其他 worktree 使用或身份无法确认时返回明确失败。仅针对未登记目录的确认仍保留原有目录身份校验。

宿主创建、嵌套健康探测、合入、回滚、分支事务清理、任务事实和子模块归因均使用 `gitEnvironment.ts` 的显式仓库环境；建后准备及合入验证命令也清除继承的仓级变量，保留用户全局配置与认证，并携带内部任务映射环境。Windows 宿主 Git 客户端及隔离 exec 调用使用进程级 `-c core.longpaths=true`，长路径检出和清理不依赖用户配置；不写源仓或全局 Git 配置。GitService 的客户端环境接纳与危险参数检查见 [Git 仓库树](git-repo-tree.md#验证)。真实重定向回归确保另一仓已有暂存文件及索引不受这些生命周期操作影响。

会话现保存 `worktreeGroups: { version: 1, primaryGroupId, groups }`。每组记录自己的目录、sourceRoot、主仓/commonDir、分支/基线、组内嵌套成员和逐仓合入结果（含 not-started）。主运行组用稳定 ID 指定，排序不改变 cwd；旧单树在创建/装载边界转成一组，旧身份无法恢复时保留缺失信息。`worktreePath/worktreeSource/worktreeBranch/worktreeBaseBranch/worktreeRepoSet` 暂为主组投影；旧单组合入更新投影后同步组记录，清理和续作移交同时处理新旧字段。坏集合保留并显示诊断，不降级到旧投影。

实现入口为 `src/shared/sessionWorktrees.ts`；新模式单组与多组统一走任务级身份/释放/清理守卫。`workspaceExecutionContext.ts` 为主仓和每个已选嵌套成员登记源路径→任务树映射；已映射源检出对宿主文件工具只读，未映射仓（含未选的独立子仓）保留共享写入。路径按 realpath/实际仓归属校验；SDK/Shell 额外目录能力不能表达完整排除规则时不宣称 OS 强隔离。`borrowedFrom` 显式引用不取得清理/提交所有权，源 cwd 相同不表示借用同一树；归档借用者直到连接释放、引用解除后才不再阻挡所有者清理。

模型通过 sessions.create 选择 isolation=isolated 时可省略 `isolationGroups`，此时只隔离 cwd 所属的 Git 仓库，无法确定时拒绝；在入队前解析并固定仓组。显式 `isolationGroups` 以 `rootId + relativePath + repoSet` 精确选择仓；每组 repoSet 必填，[] 仅所选主仓，显式列表包含需要的嵌套成员，不自动扩大范围。dispatch.run 的 delegate 及扩展调用 sessions.create 仍要求显式隔离组，后者还限制在扩展绑定项目内。shared 拒绝隔离组，Shell 仅支持 shared；旧顶层 repoSet 已从模型入口删除。桌面选择由 UI 明确提交，运行仓选择保留登记 cwd。聚合目录可作为登记 cwd，建树允许主组位于另一个已选源根，也允许提交基线尚无原子目录。Codex 启动时单独校验可用的映射。父子显式选择仍可共享容器，物理别名去重，全部所选源根单独保存；显式选择的来源身份/根租约在首次 await 前捕获。`worktreeTaskCreate.ts` 保留全组预规划、成员/base/准备命令验证及失败补偿；低层未传 preserveCwd 的旧调用继续原语义。

桌面新建任务默认共享检出，不根据 Git 状态自动改为隔离；用户可通过弹出菜单选择隔离运行及需要隔离的仓库。检测到主仓未提交改动时，展开的隔离选项简要说明它不带入这些改动，表单不常驻该说明；目标目录 Git 状态未知时不显示提示，也不因此阻止手动选择隔离。`NewTaskDialog` 以 `defaultAll=false`、`preserveCwd=true` 调用 `useWorktreeSelection`，首次加载预选所选源目录对应的顶层仓库，而不是工作区全部仓库。用户可在菜单内调整选择，登记 cwd 仍指向来源目录。创建使用普通 `git worktree add` 全量检出所选提交文件，没有 sparse 或按改动文件物化；Git 对象共享不等于工作文件共享。MetaApp 的只读成本核对与未实施建议见 多会话隔离成本审计。

`worktreeCreatePlan.ts` 捕获各仓 HEAD/起点提交及父仓 gitlink，计划冻结且只由创建它的 GitService 实例认领；写 Git 前重新检查来源、基线和存储身份。新任务按稳定 workspaceId + 物理 commonDir + sessionId 放置，默认根/排序/同仓别名不改变 namespace。目的地固定到捕获的物理路径，存储 Junction 换目标时拒绝继续创建，并可回滚旧目的地；不搬动历史路径。每组保存准确 `baseCommit`，submodule 从父仓的 gitlink 提交开始，允许其源 HEAD 已领先该提交。

全部组与嵌套树存在后才 provision：管理根的旧 `worktreeProvisionCommands` 在主容器执行一次；`worktreeRepoProvisionCommands` 按 rootId + 相对仓路径在对应隔离仓根执行，仅匹配实际所选范围，未隔离的源根不执行。已有单组请求遇到适用仓级配方时也使用创建事务，旧区级命令仍执行一次。环境变量为 `MUSTER_WORKSPACE_ID`、`MUSTER_WORKSPACE_CONTROL_ROOT`、`MUSTER_WORKTREE_PRIMARY` 与 `MUSTER_WORKTREE_GROUPS_JSON`（各组 rootId/sourcePath/worktreePath 映射）。每条命令前及会话行发布前重验任务树路径/commonDir/分支，命令普通失败保留完整任务并告警。源检出脏文件不复制进任务，返回具体来源提示。

编辑工作区的“隔离准备命令”懒加载所编辑工作区的管理根配置，支持工作区命令、仓级配方及“自动隔离排除”；排除项使用 rootId + 相对仓路径保存到 `git.worktreeIsolationExclusions`，其子仓同样排除。参考仓仍能在 Git 中浏览；显式选仓可覆盖自动排除。自动排除的仓不运行其准备命令。每个命令框保留整段多行文本。“保存准备命令”独立保存命令及排除项，不执行命令，取消工作区表单不撤销已明确保存的配置。`worktreePreparationSettings.ts` 校验工作区版本、管理根与源根物理路径和配置版本后同步比较写入，仅补丁修改上述三个 Git 配置字段；旧保存调用省略 exclusions 时保留原清单。其他窗口修改配置、源根变化、读取/解析失败均报错并保留草稿/原文件。配方中已移除来源仍显示，可由用户删除；刷新仓库不覆盖命令及排除草稿，重新加载配置才丢弃草稿。配置读取失败时队列在真正入队前拒绝，不留下“报错但已入队”的任务。

创建失败由 `worktreeRollback.ts` 逆序拆树并以起点提交比较删除分支。脏文件、新提交、仓身份变化、锁或未知创建所有权均保留并返回路径/仓/分支/原因；子树保留时必要父容器同样保留，不对未知资源强删。拆 submodule 后恢复空 gitlink 目录，避免父仓误判删除。生产会话入口将遗留资源明确通知，成功结果的宿主检查/回滚闭包不落盘。真实 Git 与实际会话入口回归见 `test/task-worktree-create.mjs`、`test/session-task-worktree-create.mjs`；覆盖并列仓、三层嵌套/submodule、第二组失败、新工作/竞态保留、Junction、全部树后的命令和来源/续作。

内部跨组任务的合入由 `worktreeTaskIntegrate.ts` 处理。所有组及组内嵌套仓先验证真实注册/commonDir/私有 Git 目录、来源根与物理路径、分支/提交、目标存在和可检出状态、索引锁/未结束 Git 操作，再统一做脏树/主仓重叠/冲突预演；全部通过后按各组嵌套深处先、主仓后逐仓合入。源仓与任务嵌套目录必须实际位于各自容器，Junction 不得把宿主合入转到未登记的物理仓；子模块按任务提交的真实 gitlink 分类，独立嵌套仓不进子模块守卫。写入前重验任务所有权、目录和全部尚未合入的提交；来源提交固定到预检 SHA。门禁运行期间出现新提交或脏文件会阻止成功验收。检查使用合并的 Git 查询，不为此重新扫描工程目录。

每个仓合入后立即保存 `group.integration`，含已合入/已合过/零改动/失败/未开始状态、预检提交、目标与门禁/告警。第二组真合失败时保留前序成果并停止后续，失败继续向 review/integrate 调用方抛出，不记 done、验收或清理。重启后重试固定此前目标，依据真实 Git 祖先关系决定跳过，不能仅信任已保存的成功；重置过的目标会重新合入。接口 `groups` 按 groupId/rootId 区分同名主仓和嵌套路径，旧单组 `repos` 兼容保留。嵌套仓跳过 npm/typecheck，各容器主仓分别运行；门禁中止只回退当仓合并，前序仓不撤回。守卫在 stash 后拒绝继续时保留并明确报告 stash，不向身份已改变的检出恢复用户改动。真实 Git 全任务预检、钩子失败/逐仓落盘、重启续作、分支重置、同名嵌套、提交/gitfile/根变更和并发/占用回归见 `test/task-worktree-integrate.mjs`。

跨组清理由 `worktreeTaskCleanup.ts` 接入归档、删除与确认后的放弃。第一次 await 前锁住任务和全部源根，GUI/PTY 先释放，再预检全部成员；与合入共用 `worktreeTaskOperation.ts` 的仓级锁。目录、主仓/commonDir、实际注册、私有 Git 目录、分支/提交、锁/未结束 Git 操作与脏树逐仓确认，未知替换目录即使放弃也保留。仍被其他未归档会话借用时全任务拒绝删除；清理进行中不能重新选择、借用、续作或移交。

设置「本机存储」把登记任务树建成独立资源。删除任务树要求先删除其所有者和全部引用会话，清理前由 Git 只读预检验证身份和状态。选择丢弃改动时，登记完整的任务允许清理未提交文件与未合入分支，执行阶段捕获分支提交并比较删除。单独删除会话时，任务树通过保留的所有权记录继续管理。旧单组和多组的生命周期操作共用任务操作锁，清理期间选择、恢复归档和重启不得并发。见 [本机存储](local-storage.md)。

按嵌套深处先、主容器后清理，脏/锁/身份变化/删除失败保留必要祖先，独立安全组可先完成。`group.cleanup` 逐仓保存树/分支是否已删除、观察到的 SHA/commonDir、状态与原因；每次树或分支删除后立即刷盘再继续，合入结果也改为立即刷盘。缺失目录只定向移除它自己的注册，不做全仓 prune；解除子模块后恢复空 gitlink 目录。已删除子树重新出现目录时阻止父容器删除。Windows 短暂目录占用可重试，每次都重验身份和脏树。

分支只在已合入且未被其他 worktree 使用时删除；Git ref 事务同时核对目标 SHA 并比较删除任务 SHA，晚到的新提交或目标变化保留分支。归档保留未合入树；明确删除会话时可移除干净树并保留未合入分支，通知其位置；放弃操作可移除已核实的脏树。普通归档和删除还检查 Git 忽略的文件（含依赖或构建产物），存在即保留；已登记的嵌套任务树分别检查。其他树、注册或分支残留保留完整组集合及归档会话行/历史，隐藏所有者转为可见并落盘；重启按真实资源续清理。对已归档但仍有遗留树的任务会话，再次 `sessions.setArchived(id, true)` 会重跑一次安全清理（处理保留原因后即可收尾；清理进行中则照常报操作占用）。部分清理或丢失任意成员阻止重新启动，不改去默认根。全部资源处理完成或已安全解除对保留分支的关联后才清除新旧字段；新模式 cwd 不变，旧模式回原来源子目录；删除会话行和历史在此之后。

永久删除入口等待任务级安全清理；清理失败保留会话，并在看板或左栏显示可关闭的原因弹窗。若目录和 Git 注册均已不存在、分支仍在且没有可信的已删树记录，用户明确删除会话时只解除该项关联，保留分支并通知其仓库和名称；不据此声称分支归属或删除分支。目录仍存在、身份异常、未提交或 Git 忽略的文件、其他引用资源时继续保留会话。看板和左栏的「放弃并清理」显示返回的失败原因，仍不可绕过身份校验。

已归档任务的目录仍存在、但 Git 已无对应登记时，失败弹窗提供「强制删除目录」；先预览会话登记的准确路径，再以单独的危险确认框说明将永久删除目录中所有文件且保留分支。取消不会执行删除。主进程生成五分钟内有效的一次性确认，绑定会话映射和目录身份；确认后重新核对工作区、来源、其他会话引用、实际路径、目录身份和 Git 登记，并拒绝目录内的其他 Git 仓库。包含或重叠已登记嵌套任务仓库的目录不提供递归强拆。多组任务只强删本次确认的目录，其余组仍按普通安全规则清理；强删成功后重试删除会话，剩余资源无法安全清理时显示原因。强删不会删除无法核实归属的分支。

排查依据（2026-11-03，Windows，只读现场加临时仓库实验）：分支是目标分支的祖先只说明它当前指向的提交可到达，不足以证明任务改动提交并合入。现场 `ao/518ff28b` 与 `ao/4283df3c` 的 reflog 目前均只显示从已存在基线创建分支，未见后续分支提交；其遗留文件时间晚于建树时间。后者的 waitFor 草稿早于主分支后续实现且内容不同；无法仅凭文件时间排除准备命令或手动复制，也无法确认历史操作人。另有未登记目录只剩 `node_modules`、`.tmp` 或 `.dev-sandbox` 等内容：临时真实 Git 仓库复现了 Windows 上 `git worktree remove` 返回成功并取消登记后，指向其他目录的 `node_modules` Junction 仍留在原目录；不能仅凭返回成功推断物理目录完全消失，也不能按普通目录对 Junction 的目标递归清理。

当前实现已覆盖邮件、事件、定时和持久等待。时间条件与超时同时积压的先后规则已接入现行 [会话续接](resume-wait.md#数据流与可靠性)。提醒 App 的事件订阅由 events 域承接。星期提醒和文件事件路径过滤已分别接入现行 [提醒 App](agent-apps.md) 与 [运行时状态流](runtime-status.md)，没有恢复独立订阅后端或订阅创建界面。原有草稿和其他未提交文件须先备份核验，再清理工作树。

防止再次漏掉任务成果的后续设计（尚未实施）：将提交/收尾、释放 Worker 写入、固定各仓 HEAD、全组脏检查、合入后复核和清理做成可恢复的宿主收尾事务；任何未知状态、失败或新写入均保留现场，并在看板显示具体仓及未提交/未合入原因。必须区分已提交合入、未提交文件、Git 忽略文件和准备命令生成物，不能仅凭分支是目标祖先认定任务成果已合入，也不能自动提交、覆盖或删除未知内容。工作台外直接运行 Git 或非受控进程写文件无法由该事务强制约束，仍须靠最终复核和保留现场兜底。

真实 Git 回归 `test/task-worktree-cleanup.mjs` 覆盖三层独立嵌套/真实子模块、脏/未合入/锁/坏 gitfile、缺失目录与无关注册、重启、分支复用/晚到提交、目录重新出现、并发与借用。`test/session-task-worktree-cleanup.mjs` 验证真实会话入口的释放顺序、残留所有者、归档/放弃与立即刷盘。实际创建/合入/清理及失败回滚另以 E 盘源仓和 C 盘任务树验证。独立 Electron `test/e2e/task-worktree-lifecycle.spec.ts` 经过公开创建 IPC、真实 Git 第二组 post-checkout 失败和 Node PTY：第一组回滚，未知创建归属的第二组保留并报路径，不发布会话；正常创建后实际退出/重启、固定第二组子目录续作、全部组移交、旧所有者归档不删树、脏树阻止合入、独立安全组先归档清理、残留清单跨重启保存、不完整任务拒绝拉起和解决脏文件后续清理均覆盖。真实进程由生产退出/归档释放，测试逐 PID 确认退出；不以手工杀进程代替该断言。真实 Pi/Electron GUI 跨组归档释放已由 `test/e2e/task-worktree-gui-lifecycle.spec.ts` 验证（43.3s）：真实 SDK dispose 时全部树存在，模型流关闭，安全组先清、脏组保留，解决脏文件后续清理；不完整会话消息在受理前拒绝，源 HEAD/业务文件及初始化后的状态/索引不变。仓级配方已接入产品，多文件夹既有自动化验收与实际使用边界见 多文件夹计划，本次 source-cwd 模式的定向证据见下节。

子模块先合入会使父仓看到新的 gitlink，原脏重叠检查因此误挡父仓。`submoduleMergeState.ts` 仅放行可归因于已保存嵌套合并的变化：真实子仓路径/commonDir、实际 `mergedCommit`、子仓干净、父仓 index gitlink 与 HEAD 相同，以及待合父仓指向该子任务提交都须匹配。用户暂存 gitlink、子仓脏文件或无此合并记录的 HEAD 不放行。非快进子仓保留目标分支的 merge commit，父仓记录任务 gitlink 时源检出可能仍领先，返回明确告警；不强制切子仓或擦掉其提交。父仓 checkout/merge/abort/闸失败 reset 禁止递归重置已经合入的子仓，即使项目配置 `submodule.recurse=true`。部分失败重试复用保存的合并提交并重新核验。中文/空格路径的预检使用 `-z`，避免 quotePath 造成错判；真实 FF/no-FF、父仓失败/重启续作、用户工作保留与门禁回退用例见 `test/task-worktree-integrate-submodule.mjs`。GitService 公开合入只接收已有选项白名单，任务协调器的固定 SHA、子模块证据与写入守卫不会由调用方载荷注入。

- 模型 Catalog 的 sessions.create / runs.delegate 必须显式传 `isolation: shared | isolated`，无 auto 或默认值；isolated 要求明确仓库组及每组 repoSet。执行层 delegateTask / 队列只接收已决定的 isolate 布尔值，入队固定选择，出队不按 dirty 重选；恢复沿用已有资源。`sessions/isolationPolicy.ts` 为 precheck/recommendIsolate 返回 dirty 三态与建议，约 3 秒预算；桌面新建任务只用状态显示隔离说明，不采纳建议改变选择。它不再从创建或派活执行层调用。原 dirty 规则作为模型可选决策线索，见 [隔离决策指引](worker-inject.md#隔离决策指引)；新树来自所选提交，不复制源 dirty，不整仓 stash/reset/提交。
- **base 守卫**（`addSessionWorktree`）：主仓 HEAD 停在别的 `ao/*` 分支（review 残留）或 detached 时，改用默认分支（origin/HEAD → main/master）作起点，避免新任务静默继承旧隔离分支的未合入工作；实际起点记录在 `GitWorktreeAddResult.baseBranch`，并落会话 `worktreeBaseBranch`（R-18「从哪建回哪」）——`sessions.integrate` 缺省 target 优先用它（显式 `target` 仍最优先），HEAD 正常建在用户 feature 分支时合入不再把 feature 领先提交搭车进默认分支；旧会话无此字段回落默认分支，base 分支后来被删则 checkout 失败走既有拒绝路径（不产生半成品）。
- **跨工作区派活**：旧单组/extra 路由按工作区路径及源仓路径分组（`resolveWorktreesRoot`）；新内部多组路由按逻辑 workspaceId 和物理 commonDir（`resolveTaskWorktreesRoot`），均使用目标来源。内部未指定范围的 GitService 调用认所有已打开工作区路径 + extras + `git worktree list`；面板 Git IPC 则固定发起工作区 ID/根版本，只准入该区登记源仓及 linked 检出，创建/删除和采纳也走这一范围，真实 apply 前再次核对。报错区分「不是 git 仓库」与「未登记/索引未刷新」，调度可用 `git.refreshRepos()` 强制刷新扫描。
- **provision 按目标工作区管理根读取**：`createTerminal` 按 workspaceId/rootId 固定源身份，`worktreeProvisionCommands` 从该区 controlRoot 读取。旧单组在全部嵌套仓建完后执行，新多组事务在全部组/嵌套仓建完后执行；命令失败保留工作目录并告警。建组返回后若来源失效，不产生会话行，回滚未完成时明确通知遗留路径/分支。准备命令设置已接入公开创建入口，普通多根创建入口与完整生命周期继续收口。
- **归档收尾**（`cleanupWorktreeOnArchive`）：删树前先查 `isBranchMergedIntoDefault`——分支有未合入提交时整树保留，`meta.orphanWorktree='unmerged'` 徽标 + 通知（此前「干净」只看未提交改动，已提交未合入的工作会被静默埋进 `ao/*` 分支）；干净才删，删后 `deleteMergedBranch` 顺手删分支。`deleteMergedBranch` 有 merge-base 兜底：HEAD 停在别的分支时，对默认分支校验祖先关系后才 `-D`（等价安全）；判不了按未合入保留。GUI 会话归档时经 `releaseThenCleanup` **先 await `chatBridge.release` 再删树**（桥接层不得 `void release(...)` 丢弃 Promise）；integrate 定时器若发现已归档但仍有 `worktreePath`，会再跑一遍拆链+清理（人手动先归档但锁失败时的补刀）。
- **删除会话也收尾**：人工永久删除先看子树和 Git 预览。旧单组与新版任务在正常删除时等待安全清理，受阻保留记录。显式选择「删除会话，保留 worktree」会先释放运行时，再持久化仅用于本机存储管理的 worktree 所有权，之后移除会话和历史。保留目录操作没有 Git 删除副作用。
- 遗留徽标 `meta.orphanWorktree`：`dirty`（未提交改动）/ `unmerged`（分支未合入）/ `locked`（删除失败，目录锁等）；旧数据 `'1'` 渲染层按 dirty 处理。归档卡片右键「清理 worktree」→ `discardWorktree`（force 删树，已合入分支一并删、未合入保留并说明）。
- **丢失处理**（`healMissingWorktree`）在 respawn 或选中 GUI 会话时检查 worktree。采用来源 cwd 格式的任务和旧 Codex 单树会话均保留隔离登记并阻止继续执行。其他旧单树会话沿用主仓恢复及「worktree 丢失」通知。
- 左栏和看板的永久删除面向已归档会话。调度通过 `sessions.delete` 删除时先走业务审核并复核目标，整批须为同工作区的已归档工作会话。设置「本机存储」提供单独的人工确认，允许停止并清理普通工作会话。Shell 退出和关闭工作区等宿主入口可以传 `allowUnarchived`。
- **归档分流**：左栏和看板依据实际执行状态与 worktree 影响确认。运行中的会话及后代先提示停止，隔离工作树按 Git 状态清理，与手动完成标记无关。清理顺序先子会话后父会话。
- 主仓 `.git/info/exclude` 追加 `/.worktrees/`；`worktreeAdd` 拒绝空 `dirName`（IPC 与 service 双层守卫）。

---

## 5. 部分采纳（T5.5）：hunk 级原子采纳到主仓

整支 merge（§3）的 hunk 级补充：Git 页选中隔离 worktree 时，diff 标题行出现「部分采纳」按钮，
打开后 diff 区切换为 **worktree 相对 merge-base 的全量 diff 勾选视图**（`AdoptDiffView`：文件级全选
+ 每 hunk 勾选，勾选键 = `@@` 头四元组 + 文件路径，`src/shared/gitAdopt.ts` 两端同源）。确认后
`git:adoptHunks` 原子应用到主仓，成功自动切到主仓查看 staged 结果。

五性质（参考 wmux TaskAdoptService，`src/main/git/adopt.ts`）：

1. **diff 基 = merge-base（主仓 HEAD ∩ worktree HEAD）**，不是主仓 HEAD——否则主仓分叉后的提交会以
   反向 diff 混进 patch，先采纳的被后采纳回滚；预览与采纳两侧 hunk 键也因行号错位而对不上。
2. **`git apply --check --3way` 先行 + 失败还原**：注：`--check` 在 3way 语义下对「可三方合并但带冲突」
   会放行，真 apply 非零退出后由 restore 兜底（`reset + checkout + clean`，仅限 patch 自己的路径，
   `:(literal)` pathspec 防通配）——主仓永不半应用。
3. **默认 staged 不 commit**：`git apply --3way --index` 写入工作树与 index，HEAD 不动；下一次采纳会被
   dirty-target 拒（含上次留下的 staged），先提交/还原再审。`--index` 显式声明，不单靠 `--3way` 暗示。
4. **临时 `GIT_INDEX_FILE`**（read-tree worktree HEAD + `add -A -N`）生成 diff：未跟踪文件可进
   预览，worktree 索引零污染（无 intent-to-add 残留，Worker 的 `git status` 不变）。
5. **按目标仓串行闸**：同主仓并发采纳串行执行（进程内 promise 链；GUI 自身 apply 路径与第二实例
   不在此覆盖，与 wmux 同诚实边界）。

多组任务由 `sessionWorktreeReview.ts` 归一全部组与嵌套成员，坏集合不回退旧投影，已清理目录不再列为审阅目标。Git 详情工具栏的 [Worktree 选择器](git-repo-tree.md#从-git-工具栏切换-worktree) 按来源目录、成员相对路径、分支和完整检出路径消歧。选定成员打开对应 Git 标签。部分采纳逐所选仓执行，只暂存对应源仓；与任务快照/合入/清理共用 commonDir 操作锁。采纳预览与真 apply 前校验物理目录、私有 gitfile/backlink、来源/commonDir、HEAD 和活动 Git 标记，重新核对源仓 HEAD 与脏状态，过期身份或提交拒绝写入。宿主 Git 命令清除仓级环境并固定工作树，临时 index 显式覆盖且不污染 Worker。吸收型子模块按本地 core.worktree 找实际源子仓。独立 Git 元数据仅从已登记来源或当前主检出反解，未知或多个不同来源拒绝猜测。实际采纳返回前切仓，不覆盖新仓草稿或跳回旧来源。

其它行为：主 checkout 自采纳拒；空勾选拒；勾选键与重新生成的 diff 对不上（worktree 在预览后被改）
→ stale 拒绝提示刷新；无共享提交 → 提示 rebase。

已知边界：二进制文件段（`GIT binary patch`）无 `@@` hunk，不可勾选不可部分采纳；纯 rename 无
内容改动的文件段同样无 hunk；主仓 HEAD 停在非默认分支时采纳落在当前检出的状态（用户可见，
与 wmux 一致，不自动切分支）。

## 6. 开 PR（T1.6）：worktree 变更视图直建 PR

隔离 worktree 仓在 Git 页仅有两种收尾：整支合入（§3，宿主 `sessions.integrate`）或
hunk 级采纳（§5）；远程验收场景补一个入口——选中 worktree 仓时远程操作区出现
「开 PR」：通过 GitHub App 创建 PR 后在 Git 页审阅变更、CI 与讨论（详见
[pr-loop.md](pr-loop.md)）。

- **仅 worktree 仓出现**（与「部分采纳」同判定）：共享检出没有独立分支语义，
  保持原有 Push 按钮只推分支，不给 PR 入口。
- 账号或目标仓库尚未授权时，打开 PR 页签进入 GitHub 授权流程。
- 建 PR 前核对 worktree 分支、提交与推送仓并建立 upstream，再按明确的 base 和 head 仓库创建 PR。
- 轮询/未读/降级细节见 pr-loop.md；本节只记与 worktree 生命周期的关系：
  PR 是整支合入的**替代**收尾，PR 合并后分支仍可走归档清理，两者不冲突。

## 7. 多仓隔离组·嵌套容器（R-18b）

UE 类工程的真实形态：主仓 + `Plugins/` 下每插件一个**嵌套独立 git 仓**（不是 submodule）。
单仓隔离对这种工程保护失效——隔离树里没有插件目录，Worker 只能跑出去改共享主检出。
多仓隔离组把一次隔离扩成**仓集合**：结构即真实工程、零链接机制。

### 7.1 发现与建组

- **发现快照**：`GitRepoDiscoveryCache` 统一 Git 列表、派活预发现与建组的仓库集合。首次使用时异步发现，
  后续复用最近一次手动刷新结果；工作区快照覆盖内部各主仓，外部仓按自己的范围缓存。含 `.git` 目录/gitfile，
  深度上限 32，命中仓后继续下钻，使用共享目录策略跳过 `.tmp` 等生成物、旧 `.worktrees`、宿主数据和符号链接。`Content` 等业务目录参与扫描。linked worktree 从 Git 详情工具栏切换，嵌套隔离候选只采用源仓；以 gitDir/commonDir 判断，初始化 submodule 的 gitfile 仍支持。
  不因 fs 事件、目录 mtime、切区或 worktree 增删重扫；新增、删除或修复源仓后点击 Git 列表刷新按钮或调用 `git.refreshRepos()`。
  缓存是进程内的，重启后首次使用重新扫描。独立 `discoverNestedReposDetailed` 保留给离线发现与测试，不再在派活两处直接全量调用。
- **.gitignore 过滤**（2026-10-06）：嵌套仓只对「扫描范围内最近包围仓」的 `.gitignore` 级联（仓根+各级父目录）
  判定，命中的不入发现结果（UI 列表 / 隔离组 / refreshRepos 同层；`gitignoreFilter.ts` 自实现匹配，
  与 `git check-ignore` 交叉验证）。刻息**不读** `.git/info/exclude`——建组时宿主会把各嵌套仓路径写进主仓
  info/exclude 防容器恒脏（ensureNestedReposExclude），读了会导致建过一次组后正常嵌套仓从发现里自我消失；
  也不读全局 excludesFile（机器本地配置）。扫描范围根自身永不过滤（源根/extras 是用户显式登记，登记即权威）；
  包围仓在扫描范围外时不判（源根落在更外层仓的忽略目录里时，其内嵌套仓照常发现）；包围仓被过滤时其内部
  嵌套仓一并过滤。快照无 TTL，`.gitignore` 变更随手动刷新/`refreshRepos` 强制重扫生效。
- **健全性校验**：发现刷新时以并发上限 8 校验每个候选 `.git/HEAD` 存在且
  `git --git-dir=<该仓> rev-parse --verify HEAD^{commit}` 成功。不健全的仓（缺 HEAD /
  对象丢失）**跳过并告警**（桌面通知 + 日志 + 派活简报，列路径与症状，提示修复或删除），
  不进 `repoSet`，不炸整组。**全部候选均残缺**则建组失败——不静默当成「无嵌套仓」只建主仓
  容器。缺 HEAD 时 `git -C <残缺仓>` 会向上发现主仓并误报成功，随后
  `worktree add -b ao/<id8>` 撞上主仓已有同名分支（`already exists`）；所以必须先查 HEAD
  文件，核对象时用 `--git-dir` 钉死该仓，禁止走 `-C` 回退。字面 `--verify HEAD` 在对象
  丢失时仍 exit 0（只回 SHA），必须剥到 commit。
  消费快照时即时检查候选目录、Git 入口、commonDir 身份与 HEAD；消失项和替换身份返回具体跳过原因，列表不复活幽灵路径，不运行失效 cwd 的 Git 命令。检查只读文件入口，不递归重扫或启动 Git；自动隔离读取排除偏好也不创建或迁移配置。实际建树仍使用当前源仓的分支、gitlink 和 Git 命令校验，不能以缓存健康结论绕过当前身份守卫。
- **嵌套仓范围**：模型 `sessions.create` 使用 `isolation=isolated` 时默认仅选 cwd 仓库；指定 `isolationGroups` 时，组内 `repoSet`（主仓相对路径数组）可只含列出的嵌套仓。旧顶层 repoSet 已删除，底层原生创建及旧会话仍保留对应实现。
  列不存在的报错（Windows 大小写不敏感匹配，建树用发现清单的真实拼写）；列出但残缺的跳过告警
  （全列残缺同「全部残缺」报错）；选择深层仓时自动补齐健康祖先，祖先残缺则拒绝建组。组内 repoSet 缺省=自动发现健全且未排除的仓；`[]`=仅选中的主仓，直接跳过嵌套发现；非空=显式列出的嵌套仓及必要祖先。三态贯穿组选择、底层原生创建、简报与准备命令筛选，不把健康过滤后的空集合重新扩大。
- **显式子仓的自动后代选择**：父组与显式选中的子仓合并为一个容器时，子仓的 `repoSet` 缺省代表自动包含其后代，不受父仓或子仓 `.gitignore` 对独立仓目录的忽略影响。复用完整发现拓扑并对原先被忽略的候选补做提交健全性检查；工作区主动隔离排除仍优先，普通自动发现继续执行原忽略策略，显式查询不污染自动发现缓存。`test/git-discovery-cache.mjs` 覆盖忽略、主动排除、坏 HEAD 与后续自动查询；`test/task-worktree-create.mjs` 覆盖真实三层仓、固定子模块提交与深层准备命令。
- **建组（创建有序 + 整组回滚）**：先建主仓 worktree 作**容器根**（新建目录为应用管理根内 `t-<任务哈希>/<仓库名>-<仓库哈希>/`，旧映射不迁移），再对每个嵌套仓在其**主检出内相对位置的镜像路径**上
  `git -C <嵌套仓> worktree add <容器根>/<相对路径> -b ao/<id8>`——每仓同名分支 `ao/<id8>`，
  注册在各仓自己 `.git`（git 自动给同名注册名加序号，并发任务各建容器互不冲突）。
  任一失败**整组回滚**（已建树 --force 拆 + 分支 -D；容器根+主分支由 service 层回收），
  回滚失败时停止删除祖先容器，明确报告遗留路径及错误，不宣称无残留；失败不产生会话行。独立仓执行 base 守卫；已初始化 submodule 按父仓 gitlink 固定提交建树，不把 detached 状态替换成最新 main。
- **SessionMeta 记账**：`worktreeRepoSet: Array<{ path, branch, baseBranch?, baseCommit?, kind? }>`（嵌套仓相对
  路径+分支+各自 base）；主仓仍走 `worktreePath/worktreeBranch/worktreeBaseBranch`，不进清单；`worktreeSource` 记录主检出及 common dir，续作连同组信息一起移交。成功合入后将实际 target 保存供归档判断。
- **容器排除（关键机制）**：嵌套仓目录在主仓视角是 untracked，不处理会让容器恒脏（脏树拒绝、
  零改动过滤全被误触，`git add .` 还会把插件内容误提交进主仓）。`ensureNestedReposExclude`
  把直接子仓的相对路径写进最近父仓 **common** `.git/info/exclude`——实测 git 对 linked worktree 读
  的是 common dir 的 info/exclude（per-worktree exclude 不生效，git 2.54 验证）。副作用：主检出的
  嵌套仓目录同样被隐藏（主仓本就不跟踪嵌套独立仓，status 更干净可接受）；清理后行保留
  （幂等无害，避免与并发会话竞态）。

#### 部分隔离与源目录关系

普通嵌套独立仓各有自己的 Git 元数据；父仓 worktree 不自动包含这些仓的工作目录。已选嵌套成员在容器中按原相对路径分别建 worktree，不通过链接把原始源码挂进去。未选成员不物化，也不会自动映射回原检出：父提交不跟踪的目录通常缺失；submodule 仅有 gitlink 时不能假设已初始化；父提交本来跟踪的普通文件则来自父提交，不能把它们当成子仓独立检出。

`repoSet` 控制嵌套成员（缺省自动发现、`[]` 仅所选主仓、显式列表含必要健康祖先）；只选择一个插件作为来源时，可将其自身作为独立组，不自动创建整个 Editor。父子来源同时选择会合并容器，实际成员仍受明确范围/发现规则影响。独立仓各自使用自己的 base，已识别 submodule 按父 gitlink 固定提交，二者不能混为同一种依赖关系。

`workspaceExecutionContext.ts` 在任务有隔离组时，将组目录列入 `writableDirectories`，原登记源根保留在 `readableDirectories`；未选源仓不会同时默认成为这个隔离会话的共享可写仓。因此当前支持“选中树可写、其他源可读”的上下文表达，不代表已经提供任意逐仓共享可写/隔离可写的混合执行模式。目录上下文与 SDK 工具约束不是 Shell/MCP 的 OS 沙箱，不能宣称原目录绝对写不到。

两种常见布局风险：只隔离插件 A 后，从原 Editor 工程运行构建不会自动改用隔离 A；隔离 Editor 和 A 却不准备依赖 B 时，任务容器里可能找不到 B。需要准备配方明确工程/插件路径、版本和独立产物目录；成功创建 worktree 不证明完整工程可编译。原目录的依赖仍由其他会话改动时，依赖输入也没有冻结。父仓状态干净不证明被忽略的独立子仓干净，dirty 推荐必须按实际任务仓区分。

合入/清理只处理登记的任务成员，未隔离的源仓不应作为组资源合入或删除；选中仓跨仓合入仍是预检后逐仓执行，可能部分成功。dirty 推荐与按需映射已按实施方案落地；完整工程依赖布局仍需任务显式准备，不自动拼装 UE 工程。

### 7.2 组级合入（全或无预检 + 零改动过滤）

`sessions.integrate` 对有 `worktreeRepoSet` 的会话走 `integrateRepoGroup`（嵌套先、主仓后）：

1. **零改动过滤（负担优化·事后，纯代码）**：逐仓双检 `git status --porcelain -uall`（脏）+
   `rev-list --count base..branch`（领先提交）——**皆零=未动仓**：排除出合入与验收
   （不 merge、不进闸、不进结果清单的合入部分），直接进清理列表。双检缺一不可
   （只看提交漏「改了没提交」，只看脏漏「提交后又还原」）；判不了按有改动处理。
   全部仓零改动也走成功收尾（done + 清理）。
2. **全或无预检**：待合仓逐个预检（树脏拒绝 / 该仓主检出脏重叠拒绝（stashMain 让路同单仓）/
   `git merge-tree --write-tree --name-only -z` 冲突预演），读完各仓预检后汇总**全部失败仓**（跨组任务带 rootId/仓路径），再整组拒绝；每仓独立列出冲突文件，NUL 名称区与诊断消息分开解析，中文/空格路径不转义、不把 Auto-merging/CONFLICT 当文件名，
   全部仓零改动。预演只往对象库写树对象，工作区/索引/引用零改动（gc 可回收，无观察面）。
   **选型**：merge-tree（git≥2.38）优于 `merge --no-commit`+abort——后者要在每个嵌套仓的
   **主检出**里 checkout target 再 abort，对用户真实工作区的扰动远大于写几个树对象；
   git < 2.38 降级跳过冲突预演（本地脏/重叠检查不受影响），真合窗口失败按已合/未合清单报告。
   显式 `target` 对每仓生效，缺该分支的仓整组拒。
3. **逐仓真合**：嵌套先、主仓后（主仓可能引用嵌套产物），每仓走单仓 merge 语义、
   **target 对称=各自 base**（显式 target 最优先）。预检后真合失败的小窗口：**不自动回滚
   已合仓**（误 reset 比残留更危险）——停止后续合入并报告已合/未合清单，人工裁定后重试
   （重试幂等：已合仓按「已在 target 上」跳过）。
4. **组级验收**：全部仓合入成功 → 任务 done（B2 收口自动）；部分未动仓不影响。
   结果 `repos` 为逐仓清单（`merged`/`already-merged`/`skipped-unchanged`/`failed`/`blocked`，
   repo='' 为主仓）。

### 7.3 事前提示（负担优化·事前）

首次任务信附「本次预计涉及插件」，按显式 `repoSet` 收窄；未指定时使用建组清单
（数量 >6 只报数量）。该提示随任务信保存到 Worker 邮箱；`sessions.create` 结果带回
`repoSet`（建组清单）与 `repoNote`（摘要）。

### 7.4 清理与归档（逐仓）

- **全组预检**：归档先检查容器身份、分支、脏状态及是否合入，再检查所有子仓；任何一项失败都保留整组。执行删除时由最深层向上，子仓删除失败立即停止。submodule 删除后恢复空 gitlink 目录，避免父仓误报删除。
- **顺序纪律（Windows 目录锁）**：嵌套树逐仓 `worktree remove` **先于**容器根——嵌套树目录
  在容器内，直接删根会连目录一起删但留下各嵌套仓的悬空注册。全部嵌套树拆完才走容器根
  现有清理路径。容器根被外部删除时，只有保存的源仓身份仍能确认才逐仓 prune；不能猜测工作区根并清理别的仓。
- **逐仓判定**：树脏 → 保留；分支未合入（**对该仓 base/target** 校验，不是默认分支——
  feature base 的零改动仓=base tip，按默认分支判会误保留）→ 保留；干净已合入 → 拆树 +
  删已合入分支。任一嵌套树保留 → **容器根必须一起保留**（保留树目录在容器内），归档徽标
  （unmerged > dirty > locked 优先级）+ 通知列保留仓路径；`discardWorktree`（放弃并清理）
  对嵌套仓 force 拆树、分支仍只删已合入。
- **UI**：左栏会话名的 worktree 标记带组大小（如「3仓」=主仓+2 嵌套，静态徽标，无新面板）。

### 7.5 一期边界（如实清单）

- **预检**：依赖 `git merge-tree --write-tree`（≥2.38）；旧版 git 降级跳过冲突预演，
  全或无退化为「真合串行+首败即停+清单报告」。
- **真合失败不自动回滚**（§7.2.3），预检后窗口极小，人工裁定。
- **仓级闸只在主仓跑**（嵌套仓不 provision install/typecheck 闸）；主仓零改动则整组不跑闸。
- **旧区级 provision 只跑主容器一次**；仓级配方可显式配置被选中隔离仓及其嵌套仓，全部树就绪后在映射目录运行。构建闸和依赖回灌仍按合入策略处理。
- **reflog watch 只盯主仓树**（`startGitReflogWatches` 未扩组）：嵌套仓集合随会话动态变化、
  fs.watch 句柄需要动态生命周期管理，而组任务的产出信号已有 Worker phase/needs_you 上报
  兜底——一期收益低于实现重量；后续需要时可在建组时为每嵌套仓补挂 watcher。
- **exclude 行清理后保留**（§7.1，幂等无害）。
- 显式 `target` 对每仓生效（缺该分支的仓整组拒）；不支持「只对主仓指定 target」。
- **组级合入会把各嵌套仓的主检出 checkout 到各自 target**（复用单仓 merge 语义）——合入后用户插件的主检出不在原分支上是预期副作用（对称 target=各自 base，通常即建树时的原分支）。
- **发现刷新仍有全树开销**，深度上限 32；目录读取有界并发 16，Git 健康检查有界并发 8。首次/手动刷新承担成本，派活复用快照；没有逐目录百分比进度。未初始化、磁盘上没有 Git 入口的 submodule 不会自动联网下载，应先在源仓初始化。
- **目录扫描不完整禁止建组**：根或相关子目录读取失败不能当作空仓清单。预检和创建共用带错误的快照，相关范围有失败时在创建主检出前停止，返回具体路径；范围外的错误不阻挡可用仓。修复路径/权限后从 Git 面板手动重扫再重试，部分列表结果及错误上限见 [Git 仓库树](git-repo-tree.md)。回归：`test/git-discovery-errors.mjs`。

### 7.6 嵌套发现耗时实测（2026-09-30）

对 `D:\MetaApp` 只读测试生产发现逻辑；本轮首测不等同于清空 OS 缓存后的冷盘测试，数字会受机器负载影响。

| 范围 | 旧发现三次耗时 | 每次目录遍历 / 文件条目 | 刷新后快照查询 |
|---|---|---|---|
| `metaworldeditor` | 4.71 / 3.65 / 3.68 秒 | 2,398 / 11,413 | 0.48–0.75 毫秒 |
| `unrealengine` | 5.12 / 3.19 / 3.08 秒 | 22,265 / 181,769 | 0.30–0.39 毫秒 |

另一次旧编辑器扫描共 3.74 秒，47 个候选的串行 Git 健康检查占 3.18 秒；资产遍历并非唯一成本。
新的整个工作区发现刷新为 5.20 秒（37,973 次 readdir、113 个候选），后续上述查询均为 0 次目录读取、0 个 Git 子进程。
这是发现阶段耗时，不包含列表状态汇总、worktree 检出、provision 或完整派活时间。`Content/MetaWorld/Default` 是实存子仓，不能用业务目录排除消除开销。
脚本与原始结果位于 `.tmp/measure-nested-discovery.mjs`、`.tmp/measure-nested-cache.mjs`、`.tmp/nested-discovery-measure/{before,after}.json`。

2026-10-01 补测生产 `GitService`：登记父工作区及 Editor/UE 两个重叠源根，物理范围去重后仍为 113 个仓。使用 `scripts/measure-workspace-git.mjs`，原始结果 `.tmp/metaapp-workspace-git-perf.json`；独立管理根/编译产物在本仓 `.tmp`，没有创建工程 worktree。沙箱与源文件所有者不同，临时 Git 配置只信任本次发现的具体仓路径，不修改用户全局配置；`GIT_OPTIONAL_LOCKS=0`，源仓 HEAD、分支引用和索引字节前后相同。Node 文件入口拒绝源 `.muster` 访问，原生 Git 内部文件访问未插桩。

| 阶段 | 耗时 | readdir / Git 子进程 | 结果 |
|---|---|---|---|
| 首次拓扑发现 | 5.02 秒 | 37,974 / 113 | 成功；目录/健康检查峰值并发 16/8 |
| 拓扑已发现后的首次状态摘要 | 19.72 秒 | 0 / 332 | **未通过**：UE `status` 触发 10 秒 block timeout，摘要降级按干净显示 |
| 复用拓扑的列表 | 19.31 秒 | 0 / 115 | 成功；状态摘要并发峰值 6 |
| 手动刷新完整列表 | 28.77 秒 | 37,974 / 447 | 成功；包含重扫、健康检查和状态摘要 |
| 刷新后复用拓扑的列表 | 17.75 秒 | 0 / 113 | 成功；2 秒 dirty TTL 在大列表运行期间已过期，仍查询状态 |
| 工作区拓扑缓存查询 | 0.28 毫秒 | 0 / 0 | 成功 |
| Editor / UE 嵌套缓存查询 | 2.53 / 1.57 毫秒 | 0 / 0 | 成功；包含实际准入检查 |

缺少 upstream 的 `rev-parse @{u}` 非零退出属于现有正常分支路径，另计，不作为失败。每阶段等待直属 Git 子进程退出，未分配 workspace watcher；活动资源快照仍可能含临时 ProcessWrap/FSReqPromise/Timer，不能据此声称全部 OS 句柄或后代进程无泄漏。数字为 OS 热缓存下单轮只读采样，不含检出、准备或模型派活，也不能把预扫描与摘要两个阶段直接当作一次未经预热的列表调用。初轮完整列表主要仍耗在状态查询，UE 超时与伪干净降级曾是 P5 未通过项。现 GitService 采用60秒无输出阈值，失败经现有问题通道显示且不发布未知仓行；修复后所有阶段均成功，原始报告 `.tmp/metaapp-workspace-git-perf-fixed.json`：拓扑6.51秒/缓存0.27毫秒，首次摘要31.59秒，手动列表36.37秒，拓扑复用23.33–25.60秒，Editor/UE嵌套缓存2.60/2.10毫秒。源HEAD/引用/索引字节仍不变。固定11秒延迟实际Git查询和未知状态/恢复回归已通过，临时还原修复会转红；不把成功返回的完整查询与旧超时降级耗时作提速对比，状态吞吐量仍是大工程限制。

## 8. 关键文件

| 文件 | 职责 |
|------|------|
| `src/shared/integrateRequest.ts` | 通知调度的协调文案 |
| `src/shared/integrateApproval.ts` | `approval` 解析 / 跳过确认判定 / 免批留痕 + 失败 toast 判定与文案（纯函数） |
| `src/main/git/mergeIsolate.ts` | 主仓 merge / 认主分支 / 删已合入分支（merge-base 兜底）/ `isBranchMergedIntoDefault`（无 electron） |
| `src/main/git/worktree.ts` | porcelain、命名、`pickDefaultBranch` |
| `src/main/git/discoveryCache.ts` | 列表/派活共用发现快照、显式刷新、范围复用和有界健康检查 |
| `src/main/git/worktreeTaskCreate.ts` | 任务级全部组预检/创建/映射、全部树后的准备、发布检查与遗留资源返回 |
| `src/main/git/worktreeTaskIntegrate.ts` | 全任务合入预检、逐仓结果落盘、部分失败停止及重启续作 |
| `src/main/git/submoduleMergeState.ts` | 验证本任务嵌套合并造成的 gitlink 变化，保留用户索引/子仓工作 |
| `src/main/git/worktreeCreatePlan.ts` | 固定源身份/提交与 gitlink、冻结计划、物理目的地与写前重验 |
| `src/main/git/worktreeRollback.ts` | 逆依赖回滚、新工作/未知所有权保护与分支比较删除 |
| `src/main/git/nestedRepos.ts` | R-18b 多仓组：发现（含健全性：HEAD + rev-parse）/ 建组（整组回滚）/ 容器排除 / 零改动双检 / 全或无预检（merge-tree）/ 组级合入 / 逐仓清理 / locks∩容器简报提示（无 electron） |
| `src/main/git/adopt.ts` | hunk 级原子采纳（五性质，无 electron，可注入 git） |
| `src/main/git/service.ts` | `addSessionWorktreeGroup`（建组入口 + 残缺仓跳过告警 + 嵌套失败回收容器根）/ `discoverNestedReposDetailedFor` / `invalidateRepoCaches` |
| `src/main/tasks/delegate.ts` | `repoSet`/`locks` 贯穿：预发现 + 简报提示 + 建组透传 + 结果摘要 |
| `src/main/ipc/pr.ts` | GitHub App 授权、带仓库作用域的 `pr:*` |
| `src/renderer/src/panels/PrPanel.tsx` | PR 页签，显示本人 PR、待审 PR 和应用内详情 |
| `src/renderer/src/panels/PrCreateDialog.tsx` | 开 PR 对话框，展示推送仓与目标仓 |
| `src/shared/gitAdopt.ts` | hunk 键序列化（渲染层与主进程同源） |
| `src/renderer/src/panels/AdoptDiffView.tsx` | 部分采纳勾选视图（react-diff-view + hunk checkbox） |
| `src/renderer/src/panels/LeftPanel.tsx` | 会话名 worktree 标记 + 多仓组大小徽标（静态） |
| `src/main/git/worktreeSessionOps.ts` | 归档/删除的树收尾（`cleanupSessionWorktreeOnArchive/OnClose` + `cleanupNestedRepoSet` 逐仓先拆）、丢失自愈（含嵌套 prune）、`discardSessionWorktree`（放弃并清理）；2026-09-26 自 sessions.ts 拆出 |
| `src/main/git/worktreeIntegrate.ts` | `integrateSessionWorktree`（含组级分支）+ `finishIntegrate` 延时归档收尾；2026-09-26 自 sessions.ts 拆出 |
| `src/main/sessions.ts` | 公开方法委托（`createTerminal` / `discardWorktree` / `integrateWorktree` 等，经 ctx 回接注册表状态）、`ChatSessionBridge.release` 与归档拆链保序（`archiveReleaseThenCleanup`） |
| `src/main/sessions/releaseThenCleanup.ts` | 拆链→删树保序（无 electron，离线可测） |
| `src/main/capabilities/hosts/sessions.ts` | `requestIntegrate` 入队调度回合 |
| `src/main/capabilities/catalog/sessionsOps.ts` | `sessions.requestIntegrate`（Worker）/ `sessions.integrate`（调度） |
| `src/main/agent/systemPrompt.ts` | 调度：收到【请合入】立刻 integrate；`approval` 判定标准 |

测试：`test/integrate-approval.mjs`（approval 缺省/跳过确认/留痕合同 + 手动失败弹 toast / 调度 auto 不弹 + 调度提示词）；`test/git-worktree.mjs`（目录名纯 id8 / 非法字符免疫 / 与分支 id8 对应 + 存量长名 porcelain 共存 + 真 git 合入 + 冲突结构化报告 + stashMain 重叠让路）；`test/merge-hook-gate.mjs`（真 git：pre-merge-commit 拒绝 → `gate-failed` + abort 无残留、未跟踪文件无损；放行照常合入）；`test/multi-repo-worktree.mjs`
（R-18b 真 git：发现深度/排除、健全性（无 HEAD 跳过 / 丢失对象跳过 / 健全入组 / 全残缺报错）、
建组容器结构与整组回滚、容器排除、零改动双检、全或无预检零改动断言、
逐仓对称 target、逐仓清理与未合入保留、容器丢失 prune + 纯函数 locks/repoSet + 接线守卫；
还原即红×3：整组回滚/预检拒绝/容器排除）；`test/git-hunk-adopt.mjs`
（真 git 五性质回归，逐条红灯自检：还原任一性质即红）；`test/unit/adopt-diff-view.spec.tsx`
（勾选交互与键合同）；`test/unit/pr-panel.spec.tsx` + `test/unit/pr-create-dialog.spec.tsx`
（PR 页签及开 PR 对话框）；`test/e2e/github-pr.spec.ts`（GitHub App 连接与评审发布夹具）；
`test/archive-cleanup-order.mjs`（拆链→删树保序）；`test/integrate-request.mjs`（协调文案）；白名单见 `test/terminal-capture.mjs`。

## 9. 存储、身份与迁移边界

- 默认根由 `defaultProductWorktreesRoot` 解析：Windows 使用 `%LOCALAPPDATA%`，macOS 使用用户的 `Library/Application Support`，Linux 使用 `$XDG_DATA_HOME`（缺省 `~/.local/share`），各自下接 `muster-console/worktrees`。首次新建隔离任务或在设置中打开默认目录时按需创建。
- 设置 → 通用 → 任务与工作区的 `worktreeStorageRoot` 可改为其他盘的绝对路径，保存后只作用于新建任务；不搬动已有 worktree，不更改运行中的 cwd。新根不得位于源仓内部。
- 工作区与源仓分组均包含可读名称及路径哈希，避免同名项目冲突；容器内保持嵌套仓的真实相对位置。路径移动后由 Git repair 和明确源仓记录恢复，应用不会强猜新位置。
- `repoIdentity.ts` 读取真实 gitfile/commondir，再交叉验证 Git 登记、源仓入口及 common dir。物理身份经 `realpathSync.native` 核对，并统一 Windows 扩展路径/UNC 前缀；登记路径、Git 返回路径与 Junction 别名一致时接受，坏 gitfile/backlink 仍拒绝。支持工作区包着仓、`.dev-sandbox/workspaces/demo-*` 嵌套仓、插件仓、extra 仓、linked worktree、separate git dir；不存在主检出的 bare 源仓保留为不支持边界。解析失败保留工作目录，不能继续删父容器。
- `.worktrees` 已进入共享扫描排除和 Git 发现排除。部分采纳也复用这一身份解析。当前会话、选中仓与文件定位通过 `git:listRepos(force, requestedPaths)` 按需带入已登记 worktree；标记由 Git 身份驱动，旧路径正则仅用于兼容。默认列表不枚举所有并发副本。Git 面板仅在可见且有焦点时每 2.5 秒刷新当前选中的任务仓状态，弥补工程 watcher 不再覆盖隔离目录后的刷新来源；不会监听全部任务副本。
- Worker 脏检查与兜底提交覆盖全组，按最深子仓到容器的顺序提交；宿主协议源模板不再假设隔离目录名必须为 `.worktrees`。
- 位置迁移减少主工程递归扫描涉及的目录，不能等同于已量化 CPU 改善。默认 rg 原本就跳隐藏目录；watcher 回调过滤只减少下游处理。Git 摘要缓存、single-flight 和并发上限保留。

回归入口：`test/worktree-management.mjs`（真实 Git）、`test/multi-repo-worktree.mjs`、`test/git-workspace-resolve.mjs`、设置/Git 面板组件测试及 `test/e2e/worktree-storage.spec.ts`。E2E 使用独立 cwd 的临时沙箱，不重置正在运行的开发实例。完整实施验收见 worktree-management-plan。

### 主仓让路与共享 stash 隔离

`stashMain` 经 `integrateSnapshot.ts` 用临时索引构造兼容 stash 的提交，保存选中路径的 index/worktree 内容（含未跟踪文件），先 pin 私有 ref 再清理选中路径；恢复经临时索引执行 `stash apply --index <ref>`，仅回写选中路径索引，保留无关暂存，成功才删除该 ref。宿主全程不写 `refs/stash`，Worker 的并发 push/pop 不会拿到主仓 WIP，宿主也不会弹 Worker 的条目。恢复冲突或身份守卫拒绝时保留 ref 并在结果给出恢复位置；不宣称恢复成功。真实两进程交错回归见 `test/integrate-stash-isolation.mjs`。

归属路径回归 `test/nested-repo-identity.mjs` 覆盖中文/空格源目录、demo-frontend 独立仓建组、外置隔离目录、Windows `\\?\` 扩展路径、Junction 登记与普通路径访问、坏 gitfile 拒绝。普通 demo 路径在修复前已通过；扩展路径在修复前返回 null（字符串比较与 Node 非 native realpath 边界），现场具体变体未取证。

逐仓冲突报告回归 `test/integrate-conflict-report.mjs`：两个 demo-* 嵌套仓与两个任务组均冲突，文件同名且含中文/空格；结构化 conflicts 精确、报告包含所有失败仓、源仓 HEAD 全部不变。回退旧解析器会把诊断文案当路径；回退跨组聚合会漏掉第二组。

父子会话的归档/删除由 SessionsService 对后代整枝执行，清理顺序为叶子到父；已有逐会话/逐仓组的释放及残留保留守卫仍有效。删除时若后代还有脏树、未合入提交或异步清理，父记录保留以维持关系；后代确实移除后由移除监听继续删父。真实 Git 回归见 test/session-task-worktree-cleanup.mjs 的 cascade 场景。

## 低频业务审批入口

`SessionsService.integrateWorktree` 在既有 Git 预检和合入执行前调用共享业务审批；IPC 和模型工具均调用该服务。材料包含实际会话及后代范围、主仓/嵌套仓/多组 worktree 的新鲜状态、源 HEAD 和目标提交、合入参数及现有验收记录。宿主在本地捕获并按哈希去重 Git 文本，审批模型先收概要，再用只读证据工具按本次仓库和文件分页查看；捕获不完整或未读取变更时不自动放行。返回后重新取得相同材料，参数、目标或代码变化拒绝执行。`deletePermanently` 同样先核对归档及工作区范围，审批精确整枝目标后复核再调用内部清理；普通归档与系统 shell/工作区资源回收不沿用永久删除审批。外部 CLI 直接执行 Git 命令不属于该业务工具覆盖。

`test/session-business-approval.mjs` 编译实际服务方法，验证等待和拒绝无执行、材料变化拒绝、批准执行一次。模型判断质量和各平台真机行为需单独验收。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D03.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：并行派活互不踩共享检出——Worker 在任务树改文件/测试/提交，收尾由宿主合入回主仓；多仓组覆盖「主仓+Plugins 嵌套独立仓」的 UE 工程形态。
- 为什么这样设计：分工「干活在树里、收尾在宿主」（merge 必须主仓 cwd、worktree remove 不能在树内做）；Worker 只 requestIntegrate，integrate 是 dangerous+approval 缺省 required（auto/required 的判定在调度 Agent，拿不准一律 required）；主仓让路走私有 Git 快照不碰共享 stash 栈；多仓组全或无预检（merge-tree 只写树对象零工作区扰动）+逐仓结果落盘+重启续作；归档前查未合入，防已提交工作被静默埋进 ao/* 分支。
- 明确不做：真合失败不自动回滚已合仓（误 reset 比残留更危险，人工裁定重试幂等）；不迁移旧目录布局/持久化映射；不自动拼装完整 UE 依赖工程（准备配方是任务显式责任）；新树不复制源 dirty。
- 歧义点：①noFf 缺省 false（允许快进；文档自己标注「是否改默认待产品决策」）——A=保持 false／B=改默认 no-ff（验收合入点留 merge commit 可追溯）。推荐 A 保持现状（acceptanceLog 已留验收痕，改默认波及全部既有调用与测试）。②嵌套 repoSet 默认范围：模型入口必填无默认，但桌面 UI defaultAll=true 首次全勾——保持全勾（结构即真实工程，防「隔离树缺插件目录、Worker 跑出去改共享检出」）还是保守化默认仅主仓？推荐保持全勾。
