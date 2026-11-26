# Git 仓库树（repo tree）

## 功能职责

GitPanel 将发现的源仓和包含源仓的目录按实际路径组成树。一个目录同时是 Git 仓库时共用同一行，工作区根仓也在该行下展开子目录和嵌套仓。多源工作区按登记的源文件夹分组，支持隐藏、置顶、搜索和排序。Worktree 检出从仓库树左边的 Git 详情工具栏切换。

仓库详情的操作、分区丢弃、状态失败与远端同步反馈见 [Git 操作与同步状态](git-operations.md)。本地 status 与后台仓库摘要均不构成联网检查；检查时间由显式/低频 Fetch 的实际结果维护。

布局：生产入口使用 [右侧统一多标签](right-workspace-tabs.md)。仓库树由 `GitPanel layout="resources"` 放入共用右侧资源宿主，仓库内容由固定 `fixedRepoPath` 的 `layout="content"` 标签显示。点击仓库打开 / 激活仓库标签，切到独立 Diff 时资源树跟随其仓库；手动切资源胶囊不改变审核内容。仓库 / 文件 / 收藏夹共用 `filesSplitRatio` 与顶栏收起按钮，Git 内 Changes↔Diff 等内部分栏仍不持久。`git.hiddenView` 三态与树隐藏 / 置顶逻辑保留。无统一 Context 的旧组件夹具仍使用 `git-repo-split` 与 `git.repoListSplitRatio`。

## 关键文件与入口

| 文件 | 职责 |
|---|---|
| `src/main/git/scan.ts` | `findGitRootsDetailed`：有界并发、按层扫描，命中 `.git` 仍继续下钻；记录根/子目录读取失败，跳过生成物、宿主数据与符号链接；旧 `findGitRoots` 保留数组接口 |
| `src/main/git/discoveryCache.ts` | 深度 32 的物理拓扑快照，重叠源根去重，扫描队列共用目录池；浏览保留父仓忽略的独立 Git 入口。隔离预检延迟执行 `.gitignore` 过滤和 HEAD 健康检查（并发上限 8），复用同一目录快照 |
| `src/main/git/service.ts` | `listRepoLocations(force, workspaceId, requestedPaths)` 发布无状态目录，供 Git 面板、隔离选仓和准备设置共用；显式补充登记主仓的外置 linked 检出。`listReposDetailed` 保留完整摘要兼容接口。物理去重/最具体根投影、摘要并发上限 6、同仓在途请求去重、当前登记准入与范围校验保持；dirty TTL 从 porcelain 完成时计时（见 [performance.md](performance.md)） |
| `src/shared/gitOperations.ts`、`src/main/ipc/git.ts`、`src/renderer/src/panels/gitpanel/GitWorkspaceScope.tsx` | 类型化 Git 操作与显式方法名单；`git:invokeScoped` 携 workspaceId/rootsRevision 复用原 IPC，renderer 在切区/根版本变化后释放旧请求与交互状态 |
| `src/shared/gitRepoTree.ts` | 纯函数：`buildGitRepoTree`（按源分组和路径组树，隐藏父仓以相同 ID 保留目录）、`flattenGitRepoTree`（按展开状态产出可见行）、`buildChainById`（全树 ID 到祖先链） |
| `src/renderer/src/panels/gitpanel/` | 2026-09-26 自 `panels/GitPanel.tsx`（现为其 re-export 垫片）拆出：`GitRepoRows.tsx`（`FolderRow`/`RepoRow`，模块级 memo，props 全原始值+稳定回调）、`useRepoTree.ts`（expanded/focusedId 状态、选中与自动展开 effect）、`useGitPrefs.ts`（hiddenView/置顶/隐藏/排序的 workspace.json 水合与写盘）；仓库搜索条为统一 [SearchBar](search-bar.md)（过滤仍走 `repoMatchesSearchQuery`） |
| `src/renderer/src/panels/gitpanel/WorktreeSwitcher.tsx`、`GitDetailTopBar.tsx` | 详情工具栏的 Worktree 选择器按需读取检出，核对当前工作区与源根版本，再打开或激活该路径的 Git 标签 |

## 仓库树交互

仓库、文件与变更树使用共享中性选中填充及配对前景。仓库滚动区左右各留 5px，避免选中背景贴住资源面板边界；隐藏仓库只降低文字层级，保留完整行与控件可读性，不再淡化整行。提交历史泳道继续保留图线类别色，分支胶囊仅边界保留泳道色，正文使用当前行的 secondary 前景；当前分支使用 info 底 / 字配对。声明回归见 `test/color-surfaces-css.mjs`，开合、选仓和键盘语义保持原实现。

- **行点击**：带子仓的仓库行（expandable 的 RepoRow）点击 = **选中 + 展开/收起**（与目录行行为对齐）；无子仓的仓库行点击只选中。键盘 Enter 同语义。
- **隐藏父仓**：常规视图里，有可见子仓的隐藏仓库以文件夹显示，子仓层级和目录展开状态由原路径保留。点击文件夹或按 Enter 只控制开合，选择子仓仍可打开对应 Git 标签。用工具栏的眼睛显示已隐藏仓库后，该行恢复仓库操作，可从行菜单取消隐藏。
- **多选与行右键（2026-10-27 起）**：Ctrl/⌘ 点选、Shift 范围（共享 `useListSelection`，见 [files-panel.md](files-panel.md) 多选节）；修饰键点击不切仓、不展开，普通点击随时回单选。行右键：单选=在资源管理器中打开 / 置顶 / 隐藏（与行内按钮同义）；多选=「隐藏所选（N 个）」「固定所选 / 取消固定所选」（按选中态动态显示），批量动作经 `useGitPrefs.hideRepos(paths, hide)` / `setReposPinned(paths, pinned)` 单次 patch 写盘；目录行参与范围序但不计入动作。拖动选区内行 = 拖所有选中仓库路径（多路径 MIME + `startPathDrag` 数组）。回归：`test/unit/repo-list-multiselect.spec.tsx`。
- **层级与图标**：目录与仓库共享图标列。同级按目录名排序，其他排序只调整同级仓库顺序。可展开节点用打开/关闭的文件夹图标，叶仓用 Git 分支图标。黄色改动点紧跟仓名，分支摘要与操作靠右。Shift+F10 和右键打开同一行菜单。
- **偏好写入失败**：Git 仓库的隐藏、置顶和列表等偏好使用所属工作区的配置回执；写入失败或异常时在仓库面板内显示可关闭的错误提示，切区、重载或卸载后的过期回执不向当前工作区误报。失败时当前会话的显示选择仍保留，重新启动后未保存的选择可能恢复旧值。
- **选中自动展开祖先**仍保留：换选仓库时展开其祖先链并聚焦。
- **自动展开**：`chainById` 独立于展开状态。切换源仓或选中仓的祖先路径变化时展开它的祖先。摘要刷新和排序时，祖先路径相同就保留手动折叠。回归见 `test/git-repo-tree.mjs`、`test/unit/repo-list-multiselect.spec.tsx`。

## 从 Git 工具栏切换 Worktree

Git 详情工具栏在分支按钮右边显示 **Worktree**，用 `CustomSelect` 列出检出并指明当前项。选项包括当前会话的有效任务组成员、当前仓库的已登记检出（含工作区内的主检出），以及目录快照已发现的其他 linked checkout。路径用于区分同名成员。展开时调用 `git:listRepoLocations` 与当前仓的 scoped `worktreeList`。本地目录新增的发现沿用手动刷新，重新展开会重读当前仓的 Git 注册记录。

选择后通过 `listRepoLocations(false, workspaceId, [path])` 复核该确切路径和源根版本，成功后打开或激活对应 Git 标签。暂存、提交、分支和审阅操作使用该检出的实际路径。失效检出提供反馈，过期范围请求取消导航。

## 已知边界

- **发现候选复验**：共享生成物策略跳过 `.tmp`，测试临时仓即使正在存活也不进入扫描快照。缓存读取检查候选目录和 Git 入口，消失路径不返回仓行；嵌套隔离另核 commonDir/HEAD 及刷新时身份，替换 `.git` 要求刷新。linked 检出保留浏览身份，但不会再被当作独立嵌套源仓；参考仓的自动隔离排除设置独立于隐藏/置顶，不影响浏览。复验只读文件，不深扫目录或增加 Git 子进程。
- **独立仓浏览与隔离排除**：浏览以独立 `.git` 入口为依据，父仓 `.gitignore` 不删除子仓身份；父仓忽略 `Plugins/` 时，插件仓和更深嵌套仓仍进入列表。浏览隐藏仍由工作区隐藏名单控制。自动隔离保持最近包围仓 `.gitignore` 的既有排除策略和显式隔离排除设置，以免把参考克隆自动纳入任务；忽略匹配只读 `.gitignore`，不读 `.git/info/exclude` 或全局 excludesFile。隔离候选/健康结果按拓扑刷新缓存，强制刷新后重建；目录浏览不启动这些 Git 健康进程。
- **源根身份**：多根按登记顺序显示同级源文件夹，用登记名称和完整路径消歧；源根正好是源仓时由仓库行承载。单根目录直接展示其内部层级，根本身是源仓时由根仓行承载。↑/↓ 在可见行间切换选中，Enter/左右键沿用目录开合规则。重叠范围按物理路径发现一次，仓归更具体的根，Junction 根别名不会复制仓列表。linked checkout 依 Git 身份从仓库树、仓库搜索和隐藏计数中移除；共享 commonDir 的各检出在 Worktree 入口保持独立。
- **列表与异步范围**：renderer 显式传 workspaceId，主进程核对根版本/路径，返回 workspaceId/rootId；根变化后的旧列表拒绝，切区/卸载/新导航使旧列表、status 和 diff 失效。默认根非 Git 不会挡住第二根；多根无已选仓时，仅在默认根中选择确定候选，不随意选择其他根的第一仓。文件事件按 rootId/版本解析，普通事件只刷新摘要。
- **准入撤销**：不再以发现快照或 allowed 集合作永久授权。仓操作每次核对当前源根登记和 realpath；移除源根后，旧 status 缓存与 linked worktree 不能延续授权。另一工作区仍登记的源根保留它的访问能力；根内越界 Junction 不扩大范围。这不是 OS 沙箱。
- **操作所属区**：面板的读取、暂存/提交/丢弃、分支/远端、worktree 与采纳 Git 调用均传 `{workspaceId, rootsRevision}`；主进程只接受列举的方法，目标仓须在本区当前源根内，或是其登记主仓的 linked checkout。无效/过期身份不回落活动区；返回前核对版本与已使用仓的登记，缓存和 single-flight 不能借用另一工作区的授权。每条 SimpleGit 命令提交前重新校验，丢弃 unlink 与采纳真实 apply 前也核对；已经启动的单个 Git 进程不会因根变化自动回滚，使用中移除依赖保护仍属 P3。旧无范围 Git IPC 在进入 handler 时捕获活动区，内部任务直接使用 GitService 的跨区调用待 P3/P4 迁移。
- **初始化**：没有仓库时引导「在工作区根目录初始化」。只发现 Worktree 时，资源区的「打开 Git 详情」打开一个已发现的检出，随后可从工具栏切换。`git:initRepo` 接受目录路径，工作区外源仓通过「添加源文件夹」登记。renderer 切区或根版本变化时重建面板交互，释放旧 busy/确认状态，A→B→A 晚到结果也不刷新或覆盖新范围。恢复选仓的 status 读取跟随 ready/选仓。
- **扫描失败**：目录离线、不是目录、权限/读取失败均携 rootId/登记路径反馈，部分失败保留其他来源的仓。面板展示前 4 处路径/原因及总数，支持手动重试；全部失败不显示“没有仓库”或初始化引导。详细 IPC 返回 `{workspaceId, rootsRevision, repos, issues, issueCount}`，issues 最多 100 项；根版本/成员变化使旧失败、status 和 diff 失效。目录遍历错误与拓扑同快照缓存，手动重扫后恢复；每次列表读取仍检查来源是否存在，离线来源不能复活旧仓行。健康检查发现的残缺仓仍沿用嵌套跳过清单，这一字段不表示仓内 Git 状态完整成功。
- **隔离完整性**：嵌套发现/建组遇到相关目录读取失败时明确失败，在创建检出前停止；另一来源或主仓范围外的错误不阻挡它。`git.refreshRepos` 同样返回有界 issues/总数，全区刷新结束前再次核对全部范围；`ok:true` 表示请求完成，issueCount 非零仍为部分扫描。

- **手动发现刷新**：仓库列表工具栏与面板顶栏刷新触发同一强制发现；目录结果返回前按钮禁用，目录发布后解锁，后台状态继续。并发强制目录请求复用一次扫描，旧列表和摘要不能覆盖新结果；失败通过窗口 tip 反馈。工具栏在最小 140px 仓库栏宽度下允许换行，操作仍可达。
- **发现与状态分离**：进程内首次使用一个范围时扫描一次；目录快照不按根目录 mtime/TTL 重扫。初次和手动刷新只等待目录清单，发布仓库树后独立读取选中仓与其他仓状态，不等待全仓汇总。状态未获取/失败时 `dirty` 缺省，分支显示省略号，不伪装成干净仓。外部新增/修复仓库需手动刷新；缓存读取检查来源与 Git 入口是否存在。应用内 `git init` 使相关范围失效，重启后首次重新发现；快照不持久化。
- **列表刷新触发**：切换已列出仓库仅读取其 status，不把选中路径加入列表 effect 依赖。目录请求从 ref 补充保存的选仓、任务组和文件定位对应外置 linked 检出。`.git`/`.git/config` 信号按 800ms 防抖读取缓存目录并安排摘要更新，空路径信号独立按 10 秒冷却；首次激活、工作区/根变化、请求定位范围变化读取目录清单。隐藏面板不读取列表/status/diff。切回/聚焦读取当前仓并安排其他已列出成员的小批次更新；折叠/隐藏仓行不减少后台目标。2 秒是 dirty TTL，不是全仓轮询周期。
- **后台摘要更新**：`repoSummaries(paths)` 是显式 scoped 操作，桌面/Web 共用 IPC，每次最多两个明确路径。命令前校验当前登记，返回前校验范围/版本。选中仓先启动，其他仓队列独立推进，慢选中仓不阻挡其他仓；批次完成即更新 branch/dirty/ahead/behind 和活动时间，未变化时复用行引用，不覆盖期间新选中的摘要。隐藏/失焦、切区/根变化、手动目录读取或卸载使旧队列失效，已启动进程正常结束，后续批次停止；重复聚焦等待旧批次，避免叠加进程。GIT_STATUS 失败保留目录行、清除未知状态并展示问题。手动刷新清空状态缓存并重新读取保持选中的仓；刷新前的慢请求不能回填缓存，新的同仓读取等待旧进程结束后重新查询；目录发布后继续后台汇总，总状态耗时仍取决于 Git 命令本身。
- **只读目录清单**：`git:listRepoLocations` 保留 workspaceId/rootsRevision、物理去重、最具体根投影、部分失败与 linked 标记；可选第三参数补充当前区登记主仓的任务检出。手动刷新重做目录发现并清空状态缓存，不执行健康/status 命令。隔离创建另作 Git 身份与健康验证，清单不授予访问权限。
- **窄仓库栏**：容器宽度不超过 240px 时用每层 10px 缩进、隐藏行内分支摘要，不超过 220px 时用每层 8px 缩进并将隐藏/置顶入口留在行菜单。深层目录可水平滚动，完整路径仍可悬停查看。详情工具栏较窄时优先显示分支和 Worktree 入口，当前仓库仍可从标签识别。
- **任务检出状态**：默认扫描排除旧 `.worktrees`。目录 IPC 可按当前会话、显式选中或文件定位补充登记 worktree，现有文件定位和详情状态仍使用该目录结果。Git 身份返回 `worktree` 标记。可见且有焦点的面板每 2.5 秒刷新当前任务仓状态，切走或失焦后停止。
- **工作区列表范围**：缺省展示 UI 活动工作区的全部源根，显式 workspaceId 不回落活动区；请求补充的 linked worktree 必须属于目标区登记源仓。调度 `git.refreshRepos()` 刷新全部已打开工作区（可传 workspaceId 只刷新一区），重叠物理范围只重扫一次，不必先切 UI。刷新只更新拓扑和摘要，不新增持久授权。
- `hiddenView` 在隐藏名单被清空时回落 exclude 并写盘；名单还在、扫描未完成时不按 count=0 回落（避免把刚 hydrate 的 only 冲掉）。

## 验证

- `test/git-repo-tree.mjs` 覆盖单根与多根隐藏父仓、目录和仓库顺序、已登记的 linked 源根、Windows 路径比较和 POSIX 大小写。`git-hidden-view-persist.spec.tsx` 覆盖隐藏后的层级与开合、取消隐藏和隐藏操作取消待执行的键盘切仓。`repo-list-multiselect.spec.tsx` 覆盖键盘开合、状态刷新后保留折叠和窄栏可用的行菜单。`worktree-switcher.spec.tsx` 覆盖打开时读取、路径复核、检出消失和切区后的晚到请求。
- `git-interaction-safety.spec.ts` 在 macOS Electron 用真实 Git 验证隐藏父仓后的缩进、目录开合与详情、黄点位置、提交样式和从分支旁的入口切换主检出。`task-worktree-review.spec.ts` 验证从工具栏选择第二组的同名嵌套 Worktree，随后采纳到对应源仓。深浅主题及窄栏截图位于 `.tmp/ui-captures/git-safety/` 和 `.tmp/ui-captures/task-worktree-review/`。

### D:\MetaApp 漏仓与等待修复（2026-10-14）

旧实现的父仓 `.gitignore` 过滤把原始 115 个入口降至 16 个，编辑器 `Plugins/` 下 46 个入口全部被删（39 个直接插件仓、7 个更深嵌套仓）。目录遍历约 2.79 秒，但旧面板还要等首次完整状态汇总 35.46 秒；dirty TTL 从命令开始计时，使随后缓存列表仍重做 16 次 status、耗时 20.66 秒。

修复后用实际 D:\MetaApp 和生产 GitService 独立实例测量，目录保留 115 个入口、0 个发现问题：

| 阶段 | 实测 | 工作量 |
|---|---|---|
| 首次纯拓扑发现 | 2.25 秒 | 38,981 次 readdir（含临时控制根），0 个 Git 子进程 |
| 缓存目录清单 | 69–72 毫秒 | 0 次 readdir、0 个 Git 子进程，115 个仓 |
| 手动目录刷新 | 2.27 秒 | 重扫目录，0 个 Git 子进程，115 个仓 |

目录不再受父仓忽略规则或 HEAD 健康进程阻挡；面板先发布目录再更新状态，慢查询缓存从完成时记时。以上是已热 OS 缓存下的目录阶段测量，完整状态查询在后台继续，不代表所有仓库状态在 2.27 秒内完成；也不等同冷盘首开或最终绘制耗时。源仓 HEAD/ref/index 均保持不变。

回归：`test/git-directory-first.mjs` 覆盖被忽略/深层仓、目录零 Git 进程、慢 status TTL、同仓在途去重与强制刷新后晚到缓存失效；`git-discovery-cache.mjs` 验证浏览保留参考仓且自动隔离继续排除；`git-workspace-roots.mjs` 验证显式任务检出目录。实际 Hook/RepoRow 用例验证目录发布早于慢状态、选中仓不阻塞其他仓、未知标记、失败保留目录、手动刷新选中状态及晚到结果丢弃。`worktree-storage.spec.ts` 增加真实 preload/IPC 的任务目录参数与被父仓忽略的插件发现。

证据：`.tmp/git-scan-investigation/raw-scan.json`、`service-baseline-corrected.json`、`service-fixed-locations.json`。旧测量脚本不识别 `-c core.longpaths=true`，首轮无效；诊断副本仅放行这个参数后重测，结果均成功。独立 Electron 实例通过当前构建的真实 IPC 确认 115 个源仓、46 个插件仓、0 个发现问题；初次目录接口 3.48 秒，缓存后打开 Git 并展开到 MWCommon 1.42 秒，深浅主题截图均已查看（`.tmp/git-scan-investigation/electron-fixed.json`、`metaapp-dark.png`、`metaapp-light.png`）。长 E2E 已通过新增 Git 断言，随后因新建任务弹窗中缺少预期的 Pi（GUI）选项失败，未算整条场景通过。现有开发客户端主进程没有源码热更新，旧进程仍返回 16 个仓；需重启加载新主进程和 preload。

### 既有回归与历史测量

`scripts/measure-workspace-git.mjs` 使用独立管理根、只读 Git 和实际登记根，记录发现/列表/手动刷新/缓存、失败与资源快照。初轮 D:\MetaApp 的 UE 状态触发 10 秒无输出超时，伪干净降级不计验收通过；现 GitService 客户端改为 60 秒无输出阈值，其他宿主调用保留默认 10 秒，摘要并发仍为 6。状态失败不缓存或发布干净摘要，经现有 issues 通道报 git status 及具体路径，正常仓仍可用；显式请求的 linked 树同样受此保护，下一次列表重试可以恢复。修复后 113 仓首次摘要31.59秒、手动列表36.37秒、拓扑复用列表23.33–25.60秒，均无失败；拓扑缓存0.27毫秒。2秒 dirty TTL 不承诺大列表零 status spawn，本改动未解决状态查询吞吐量，原始数据/边界见 [隔离 worktree 实测](isolate-worktree.md#76-嵌套发现耗时实测2026-09-30)。`git-discovery-errors.mjs` 包含源仓/任务树状态错误、恢复和实际11秒延迟的真实 Git 查询；`git-workspace-roots.spec.tsx` 验证错误提示与重试。临时编译夹具还原未知状态和10秒阈值两项修复均转红。

宿主显式指定仓路径的 Git 命令通过 `gitEnvironment.ts` 清除继承的仓级目录、索引、对象库、namespace 与局部配置变量。`hostGitClient.ts` 保留宿主原有全局配置、SSH/认证/代理环境，只按实际继承环境接纳 simple-git 的对应类别；`raw`、配置写入和数组选项另经同库参数解析器检查，不因环境接纳而开放危险参数。客户端环境快照变化时重建，已有请求保持原快照。解析器作为直接依赖固定在现有安装的版本范围，不升级 simple-git。准备命令同样使用清洁的继承环境，并叠加内部任务映射元数据。

`test/git-host-environment.mjs` 用真实 A/B 源仓、两组任务和另一个带用户暂存文件的仓，覆盖客户端缓存后环境变更、全局配置读取与认证环境接纳、危险参数拒绝、创建/准备/事实/合入/清理/回滚、记忆提交、子模块 gitlink 判断与交验门；指定来源正确，另一仓的 HEAD、索引、状态及文件字节保持不变。

`test/git-workspace-roots.mjs` 使用真实 Git/磁盘，覆盖非 Git 默认根与第二根仓、重叠/别名去重、最具体根、工作区与版本在途隔离、手动刷新、登记撤销、linked 检出身份与 Junction 拒绝。`git-discovery-cache.mjs` 保留首次列表/预检并发只扫一次及派活/归档复用快照回归，`worktree-management.mjs` 覆盖旧树与外置树生命周期。`git-repo-tree.mjs`、`gitpanel-split-pure.mjs` 覆盖分组 ID/祖先链和身份变更不复用旧摘要。

`test/git-discovery-errors.mjs` 使用真实 Git 加确定性的 EACCES 注入，覆盖部分/全部失败、错误缓存/恢复、离线根不复活仓行、IPC 上限、扫描不完整禁止隔离和全区刷新版本检查。`test/unit/git-workspace-roots.spec.tsx` 九项实际 Hook/行组件回归覆盖选仓/折叠、失败重试、旧列表/status/diff、根事件、卸载与成员撤销；`git-hidden-view-persist.spec.tsx` 验证全失败不误导初始化。`test/e2e/worktree-storage.spec.ts` 在独立 Electron 沙盒/随机 Web 网关验证多根真实列表、第二根选仓、离线源根与重试恢复。仓库栏深浅主题 320/140px 四图已查看，源文件夹现改为单行名称、悬停路径，140px 下名称沿用普通目录截断。失败提示常规/390px 四图也已逐张查看，位于同一 `.tmp/ui-captures/workspace-git-roots/`；不等同真实用户工作区的端到端性能基准。

`test/git-operation-scope.mjs` 编译实际 IPC/服务，用真实 Git 验证跨区缓存/读写拒绝、非活动区暂存提交/建分支/初始化、并发范围与添加、选择器晚到/关闭、命令间撤销、在途 status、linked 树/采纳/清理及 apply 前撤销不写主仓（仅 Electron 目录对话框用确定性替身）。`test/unit/git-operation-scope.spec.tsx` 四项实际面板/范围回归覆盖参数、切区与版本变更晚到回调、busy 释放和 A→B→A；相关组件共 25 项。Electron/Web E2E 还验证真实面板暂存提交、指定范围读取、缓存后跨区写拒绝，以及 scoped 入口不能绕过 Web 原生选择器限制。

后台刷新回归：`git-workspace-roots.spec.tsx` 覆盖隐藏懒加载、当前仓先就绪/其他仓逐批更新、隐藏后停发/晚到丢弃、手动列表抢占、后台失败不伪干净；`git-hidden-view-persist.spec.tsx` 真实面板焦点入口不调用完整列表。`git-operation-scope.mjs` 验证实际 IPC 的目标数上限、非法参数、跨区/版本与登记撤销；`git-workspace-roots.mjs` 验证批次最具体根投影且不改变源根顺序。`worktree-storage.spec.ts` 验证桌面/Web scoped 批次的实际返回；本轮链路 29.5 秒通过。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D08-D00.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：GitPanel 仓库树把源仓按源文件夹组成树，支持多根分组、嵌套仓（UE Plugins 形态）和隐藏 / 置顶。Git 详情工具栏的 Worktree 入口浏览当前会话任务检出及当前仓库的其他检出。
- 为什么这样设计：目录发现与状态分离——先零 Git 子进程发布树（实测 2.25s/38981 readdir），再后台逐仓摘要（选中仓先动、批次推进、失败不伪干净、分支显示省略号）；chainById 只随树结构 memo（修「收起祖先被选中自动展开 effect 弹回」）；物理路径去重+最具体根投影、重叠源根不复制仓列表；扫描失败部分保留+展示前 4 处路径/原因+手动重试（全部失败不显示「没有仓库」误导初始化）；准入不持久化——每次核对当前源根登记与 realpath，移除源根后旧缓存不能延续授权。
- 自动隔离排除使用最近包围仓 `.gitignore`。外部新增或修复仓库使用手动刷新更新目录快照，工作区外源仓通过「添加源文件夹」登记。
- 歧义点：①自动隔离排除只认 `.gitignore`——A=长期边界（排除精度有限可接受，用户可用显式隔离排除设置纠正；review 不把「全局 excludesFile 未生效」当缺陷）／B=补全 exclude 来源（review 要把嵌套仓被父仓全局规则误排除/误纳入记 finding）。推荐 A——误判主要影响隔离候选预检，已有显式设置兜底；补全局 excludesFile 会引入用户环境依赖，行为更难预测。②外部新增仓库必须手动刷新才出现（无 TTL/事件触发的目录重扫）——A=长期纪律（目录快照成本纪律，115 仓重扫 2.25s 不宜常跑；review 把「新仓不自动出现」当预期，只看刷新按钮可达性）／B=增量重扫（已有 `.git`/`.git/config` 800ms 防抖信号通道，可低成本接上目录增量发现）。推荐 A——B 会把「信号触发重扫」的语义从已知路径摘要升级为全目录发现，复杂度上一档；先等真实「加了仓没看见」反馈。
