# 文件面板（Files Panel）

## 功能职责

右侧统一内容标签中的文件页与文件资源树：文件预览/编辑（CodeMirror 6）+ 两级搜索（跨文件 / 当前文件内）+ 树定位。整体双顶栏与作用域见 [右侧统一多标签](right-workspace-tabs.md)。

统一工作面用 `SplitPane reverse`，编辑器在左，当前资源树在右，分割比使用 `filesSplitRatio`，树开合由 SideToolsPanel 控制。第一行管理撤销、重做与内容标签，第二行在左侧内容分栏内显示绝对完整路径与文件工具。文件树打开的标签在工作区内共享，会话链接打开的标签归属来源会话。保留标签持久化时分别记录归属和固定状态。单击预览为临时标签。编辑与代码预览均使用平面内容面。独立 FilesPanel 接口仍用于组件夹具。

## 关键文件与入口

| 文件 | 职责 |
|---|---|
| `src/renderer/src/panels/FilesPanel.tsx` | 容器：逐内容标签编辑器保活与 Ref 打开闸口、快捷键（`files.find`）；文件/内容搜索经工具栏或命令表 `files.quickOpen` / `files.findInFiles`（见 [command-palette.md](command-palette.md)）、树开关、reveal |
| `src/renderer/src/components/FileTree.tsx` | 每源根一棵树：懒加载目录（`fs.listTreeDirRef`）、链接目录、展开态、键盘导航、删除、拖拽 |
| `src/main/workspaceFs.ts`、`src/main/workspaceFileAccess.ts` | 文件树的只读链接枚举、逻辑路径与物理目标分类；一般文件读写仍检查物理源根边界 |
| `src/renderer/src/components/FileEditor.tsx` | CM6 封装：预览/编辑切换、md/html 专门预览（md 预览走 MarkdownBody，含 mermaid 图；预览链卸 paint 合成层防文字发虚，见 [file-preview.md](file-preview.md)「Markdown 预览文字锐度」）、媒体只读、文件夹概览、**当前文件内查找**、**树定位按钮**；全格式分流见 [file-preview.md](file-preview.md) |
| `src/renderer/src/components/FileDocPreview.tsx` | Office/归档预览（docx 版式、xlsx/xls/csv 表格、pptx 大纲、zip/tar/gz 清单），解析库懒加载 |
| `src/renderer/src/components/HtmlFilePreview.tsx` | HTML 来源 base、桌面根协议与 Web 只读地址；加载完成且处于预览才挂载，编辑/离开时释放 |
| `src/renderer/src/components/QuickOpen.tsx`、`useQuickOpenQueries.ts` | 统一浮层：Ctrl+P 分类搜；文件/内容档使用带根身份的 listFiles/searchFiles，保留版本与请求取消 |
| `src/main/workspaceQueries.ts`、`src/shared/workspaceQuery.ts` | 多根文件/内容查询、共享进程池与公平候选，供 @ 与 QuickOpen 使用 |

## 树的图标与展开语义（2026-08-25 起）

文件树先计算可见行与多选状态，再构造拖拽/右键回调（依赖数组会在渲染时立即求值）；不能把 `selection` 或可见行声明放在这些回调后面。删除框关闭时 `pendingDelete` 合法为 null，标题/详情仍会求值，路径读取必须保留空值保护。`file-tree-initialization.spec.tsx` 覆盖初次挂载、双项选择、批量拖拽及右键，避免上述错误把工作台整体送入 ErrorBoundary。

### 树的多选与批量操作（2026-10-27 起）

文件树支持文件管理器标准多选（共享纯逻辑 `src/shared/listSelection.ts` + `useListSelection` hook，Git 仓树/变更树/标签列表同源）：Ctrl/⌘+点击切换、Shift+点击按锚点取可见行闭区间（Ctrl+Shift 并集）、Ctrl+A 全选、Shift+↑↓ 扩展、Esc 清空；修饰键点击不触发聚焦/预览等主操作，普通点击随时回到现状单选。工作区根行不参与选择；选区随可见行变化自动剪枝。

- **批量删除**：右键落在多选区内 → 菜单「删除 N 项」（多项时不提供逐项 reveal），祖先目录吸收其选中子路径去重，确认框列前 5 条路径；逐项 `fs.remove`，部分失败时对话框带错误滞留且重试只删剩余项。
- **批量拖出**：拖动选区内行 = 拖整选区（按可见行序）；应用内 MIME 携带全部绝对路径（agent 输入得 `@a @b @c`），OS 级拖出走 `shell.startPathDrag` 的路径数组（Electron `files` 字段覆盖 `file`）。拖选区外行仍只拖该行。
- 右键选区外的行 → 塌缩为单行菜单（现状语义）。行多选态视觉用 `is-multiselected`（`--interaction-pressed` 底色，比 `is-active` 弱一档）。回归：`test/unit/file-tree-multiselect.spec.tsx`、`file-tree-initialization.spec.tsx`、`test/list-selection.mjs`。

- **文件夹图标 = 唯一展开指示器**（指示器与图标合一）：展开=`IconFolderOpen`（盖子掀开）、收起=`IconFolder`（`src/renderer/src/components/icons.tsx`）。整棵树（文件树/Git 仓树/Git 变更树）不再有 ▸/▾ 三角；`.file-tree-twist` class 已废弃，叶子行保留 `.file-tree-twist-spacer` 对位槽。注意：此约定针对**树行**。整树收起按钮统一位于上顶栏，图标与 Git / 收藏夹面板同源。文件树标题行的「搜索文件」和「所有文件中搜索」图标分别打开 QuickOpen 文件档 / 内容档。
- 行点击：目录行=聚焦+开合；文件单击=复用临时预览，双击或 Enter=保留标签；编辑也会自动保留。

### 符号链接与 Junction

树会展示符号链接和 Windows Junction，目录链接按需逐层展开，链接行带标识；失效、权限错误或指向祖先的循环链接保留在树中并显示无法读取，悬停可查看错误。树上仍使用源根下的逻辑相对路径；实际目标位于该源根内时沿用普通文件预览和编辑，位于源根外时使用既有外部文件只读预览。链接本身及其下的条目暂不提供树内删除，包含这些条目的多选也不提供批量删除，避免把删除链接误当作删除目标。其他文件仍可照常删除。

单独的 `fs.listTreeDir[Ref]` 仅用于树的只读枚举：允许从源根中的链接浏览区外目录，校验工作区、源根、相对路径及根版本；`fs.listDir`、stat、读写、删除和媒体工作区协议仍执行原有物理路径边界。未登记源根的链接目标不会被加入跨文件搜索或文件监听范围，目标变更或链接重定向不保证即时刷新，可手动刷新文件树；已打开的外部文件沿用外部只读预览的现有行为。

桌面端的工作区 HTML 文件在「预览」旁提供「浏览器预览」（紧凑工具栏用地球图标）。它按源根和相对路径在右侧浏览器打开磁盘上已保存的版本，可直接操作网页、播放演示稿。编辑中的改动要等保存后再打开才能看到；编辑器内的「预览」可以查看当前草稿。外部只读文件和 Web 网关使用原有文件预览。

## 定位当前文件（reveal）

- 下顶栏的十字准星按钮（`IconLocate`）→ FilesPanel `revealInTree()`：强制树可见 + 发 `revealTree` 请求。
- FileTree `reveal` prop（`{ path, isDir, nonce }`）：展开祖先链（**文件只展开到父目录**，自身不进 expanded——否则懒加载 effect 会把文件当目录 listDir）、聚焦目标行；`pendingReveal` + `rowById` effect 处理懒加载时序——目标行进入可见集合后 `scrollIntoView({ block: 'center' })` 再清除（行上靠 `data-file-tree-row` 属性锚定）。
- 打开目录（文件夹概览）也走同一 reveal（isDir=true，定位到目录自身）。

## 当前文件内查找（默认 Ctrl+F）

- 触发：FilesPanel 注册 `files.find`（面板 active 时）。**有打开的文本文件**（非媒体/目录）→ 打开编辑器内查找条；否则回落到命令面板「内容」档（搜索所有文件）。重复该快捷键把焦点拉回输入框（`FileEditorHandle.focusFindBar`）。可在设置「快捷键」改绑。
- 实现（`FileEditor.tsx`，无 `@codemirror/search` 依赖）：React 侧对 `view.state.doc` 逐行字面量匹配（大小写开关、上限 2000 条）→ `setFindMatches` StateEffect 整包下发 → `findDecorations` StateField 输出 `EditorView.decorations`（`.cm-find-match`，活动命中 `.is-active`）。
- 导航：Enter/‹ ›（环形）、Shift+Enter 上一个、Esc 关闭并清高亮；活动命中 `selection + EditorView.scrollIntoView(center)`。计数 `n/m` 实时显示。
- 联动：文档编辑（查找条开着）防抖 160ms 重算；换文件后重算（条保持打开、关键字保留）；落到媒体/目录/错误态自动收起；md/html 预览态会先切回编辑视图再查。

## 数据流 / IPC

文件身份为 `WorkspaceFileRef { workspaceId, rootId, relativePath }`。FilesPanel 按稳定 rootId 渲染独立 FileTree，共用外层滚动区。右侧资源树不再为每个源根重复名称和绝对路径；「文件」标题行只有一个刷新，点一次让全部源根重读目录并 `fs.refreshWatch`。树行仍显示根文件夹名，悬停可见路径。树的展开各自维护，选中与 reveal 只交给对应根。多个源根在同一列表里上下相接，看起来像同一个目录下的两个文件夹；上下键走到一棵树的第一行或最后一行时，进入相邻源根，键盘高亮同时只有一行。源根行的路径编号是空字符串，左右键仍按普通文件夹开合（右展开、左折叠）。方向键选中只改变行底色，不画焦点框。目录/文本/保存/删除/stat 使用 Ref API，根版本变化后丢弃旧异步结果；目录读取失败等待手动刷新，避免反复自动请求离线目录。旧独立 FilesPanel 夹具仍是每棵树自带标题和刷新。

跨面板打开经 UiStore `openWorkspaceFile` nonce 槽（SideToolsPanel 消费 → `filesRef.openPath`），可携 FileRef；等待懒挂载期间切区或变更根版本会取消旧请求。旧字符串先经 `fs.resolveRef` 在主进程解析：绝对路径定位更具体的源根，多根下无来源相对路径拒绝。`requestOpenWorkspaceFile` 会请求切到 Git 虚拟屏；若虚拟屏关闭，App 先打开虚拟屏再切页，避免文件开在宽度为 0 的 Git 页里。

`fs.listFiles/searchFiles` 返回带 FileRef 的条目、rootsRevision、根级 error/timedOut/truncated 与整体 cancelled。列表总预算最多 8000、内容命中最多 200，按在线物理根平均分配后交错输出；未使用份额暂不回收。跨请求共享最多 2 个 rg 子进程，排队也计入 45s/25s 总时限，活动请求最多 32 个。物理别名去重，父根排除已选子根，显式登记到跳过目录中的源根仍可独立查询。结果检查 realpath，查询前后检查根位置/目录身份；`ConfigManager.onChanged` 事件按 workspace rootsRevision 取消过期查询（无每请求轮询），根版本更新、关闭和 `fs.cancelQuery` 取消子进程，显式取消或版本过期清空结果。

`workspace.listFiles` 复用上述列表查询，保持旧 @ 枚举隐藏/忽略文件的语义，总扫描预算 2000；每根内部模糊排序后交错取最多 40 个候选，仅发送候选与元数据。@ 以根名/相对路径显示，以源根绝对路径发送。QuickOpen 使用 `fs.listFiles/searchFiles`，来源标签与 FileRef 导航保留根；共享在途枚举按消费者释放，版本变更/关闭/退场取消旧查询，根级失败/截断可见。旧 `listPaths/searchText` 多根下继续拒绝裸路径歧义。

同名相对路径的 autosave、撤销、重做与批注队列均保留根身份。临时预览在同一标签内切回文件。根改名/排序不会重读已加载文档或清空未保存正文；不同根切换会读取对应文件。媒体/Office 预览按文件身份重建，旧异步 Word 渲染只触及旧宿主节点。批注给模型的路径采用对应源根的绝对路径，药丸回跳继续携 FileRef；旧单根批注保留兼容。

HTML 图片、CSS 与脚本等相对资源按文件所在源根/目录解析；默认 base 和作者指定的相对 base 都保留来源。HTML 仅在正文加载并进入预览后挂载，切编辑时卸载，外层继续用现有 xfade。Web 地址仅授权源根只读资源，关闭/切根后释放；媒体/Office URL 在 Web 转为携根身份的 HTTP 路由，详见 [文件预览](file-preview.md)。

## 打开闸口与外部只读预览（2026-09-02 起）

跨面板打开（终端扫描/划词/会话链接/localhost 映射 → `requestOpenWorkspaceFile`）统一由 FilesPanel 闸口判定：

1. **登记源根内存在**（`fs.statRef` ok）→ `openPath`（可编辑，走 autosave）。
2. **确实位于全部源根之外的完整绝对路径** → `shell.statPaths` 存在且是文件时进入外部只读预览。区外判定不看错误文案：主进程 `withWorkspaceFileTarget` 抛携带 `reason:'outside-workspace-roots'` 的结构化错误，`fs:resolveRef` 把 reason 原样带回，渲染层用 `shared/errors` 的 `isOutsideWorkspaceRootsResult` 判定（结构化信号优先，英文原文 `path outside workspace roots` 保留兜底，文案改写/翻译不再破坏外部只读通道）。未知/移除根、旧相对路径歧义、根内 Junction 越界均返回原错误，不回退到默认根或区外通道。旧区外打开请求完成前若已有后续导航，会丢弃旧结果。

外部只读预览（FileEditor `isExternal`）：文本经主进程 `fs:readExternal`（防护与 `fs:readText` 一致——2MB 上限/二进制拒绝；**无对应写通道，写权限仍圈在工作区根内**）。头部显示「外部文件 · 只读」标识，隐藏编辑/预览切换、树定位与保存状态；md/html 预览与 Ctrl+F 查找可用。**媒体/Office/归档的外部文件（2026-09-04 起）**不再走文本通道报二进制，而是经 `muster-ext://` 只读协议服务字节，图片/音视频/PDF/文档与工作区内同构预览——详见 [file-preview.md](file-preview.md)。

**md 预览里的相对链接（2026-09-03）**：按「当前预览文件所在目录」解析（shared/workspaceRelPath `resolveDocLink`：`docs/README.md` 里的 `features/x.md` → `docs/features/x.md`；`../` 上跳、file:// URI 转路径、URL 编码解码），结果经 `onOpenPath` 进 FilesPanel 打开；绝对路径落在工作区外时按闸口同规则做磁盘级判断 → 外部只读预览。此前 md 预览没接 onFileLink，相对链接被渲染成裸 `<a target=_blank>`，按应用页面源解析成 `http://localhost:5188/…` 坏链（实证：预览 AGENTS.md 点 `[docs/features/animation-system.md](…)`）。MarkdownBody 在无 onFileLink 的视图（调度悬浮卡/文本工具结果卡等）对相对 href 一律渲染纯文本，杜绝同类坏链。

## 外部修改：实时刷新与覆盖保护（2026-08-28 起）

打开中的文件被外部程序/agent 修改时，编辑器**不再视而不见，也绝不盲目覆盖**：

- **mtime 乐观锁**：`fs.readText` 返回读取时的 `mtimeMs`，FileEditor 存为基线；`fs.writeText` 接受期望基线，写前 `stat` 比对（1ms 容差），不符返回 `{ ok:false, conflict:true }` 拒绝写盘；写入成功返回新 `mtimeMs` 供刷新基线。
- **fs:changed 监听**：FileEditor 订阅 `fs:changed`（`workspaceFsWatcher` 已有广播），过滤出当前路径（含 `''` 全量档）：
  - 无未保存修改（`useAutoSave.isDirty()` 为假）→ `refreshFromDisk()` 静默重读：内容有变才替换文档（避免自己保存触发的回声事件重置光标/滚动），md/html 预览文本同步更新（外改实时预览）；内容没变只刷基线。
  - 有未保存修改 → 置 `diskChanged`，头部下方弹黄色冲突横幅：**重新加载**（放弃本地修改载入磁盘）/ **覆盖保存**（下一次 flush 跳过乐观锁强制写）/ ×（暂时忽略）。
- **保存冲突收敛**：自动保存撞上乐观锁时同样置 `diskChanged` 弹横幅；横幅在场时隐藏普通「重试」按钮（其重试仍会被锁拒绝）。写盘在途（`savesInFlightRef`）期间忽略该路径的 fs:changed，避免读到写前旧内容。
- 媒体/文件夹/加载中不参与监听与刷新；初始读取失败时基线为空，后续保存不带锁（不误伤）。

主进程 WorkspaceFsWatcher 按 realpath 归一、父子覆盖与物理目录身份共享句柄；根内跳过规则仍先过滤，显式登记的跳过目录单独监听。事件携 `workspaceId/rootId/rootsRevision`，每根独立 200ms 防抖、最多 1000 个路径，超限折为该根的 `''`。分发前校验真实路径，跨界 Junction 不送自动化；移除/版本变更/关闭后丢弃旧批次。源目录同路径重建时更换旧句柄，关闭一个工作区不关闭其他区仍使用的物理范围。

监听失败通过根级 `error` 事件及目录 API 的 `watchError` 返回，树通过窗口 tip 提示错误，用户可手动刷新。点该根「刷新」经 `fs.refreshWatch` 重试离线/失效句柄；隐藏树重新显示时补读展开目录和监听状态。file 自动化现固定服务定义的 sourceRoot，并只消费同工作区/同根事件；同名文件不跨根触发，见 [定时服务](prompt-tasks.md)。

打开的文件/目录通过 `useFileRootUse` 向主进程登记，桌面切到 Git/浏览器或隐藏文件面板仍阻止解除该源根；换文件、清空与卸载释放，网页断线按连接释放。重连重新登记前编辑只读，登记失败显示错误。保存失败/冲突时 `FileEditorHandle.flush` 拒绝，FilesPanel 保留原文件与未保存正文、显示错误，不继续导航到其他文件或外部预览。主进程写入/删除另外保留在途根登记，直到磁盘操作完成，详见 [工作区管理](workspaces.md#源文件夹移除依赖)。

## 编辑↔预览叠放与 CM 生命周期（2026-08-29 起）

编辑器与 md/html 预览是常驻叠放淡切（`.file-editor-main.xfade-stack` > `.file-editor-pane.xfade`，编辑↔预览切换 CM 不卸载，undo 栈/滚动保留）。Markdown 与普通文本预览态给容器加 `is-reading-surface`，但预览、文本编辑、代码与 Diff 的宿主均使用共享 `ResolvedAppearance.surface-canvas` 平面内容底；普通文本不再局部覆盖 `--bg-canvas`，编辑器不另套圆角卡。Markdown 目录也使用工作面底色、文字和键盘焦点色。HTML 文档自身背景属于作者内容边界。**结构不变量：`file-editor-main` 容器必须无条件渲染**——空态/媒体/文件夹/错误/加载态只 `display:none` 让位，不可条件卸载。原因：EditorView 在 FileEditor 挂载时一次性创建（effect 依赖 `[]`、取 `hostRef.current`），若挂载时宿主不在 DOM（首挂是空态必如此），effect 空跑且不会重跑，此后所有文本文件都渲染为空白。

同日第二个回归：**未激活的 Git 页**（`.side-tools-page.xfade`）内嵌的 `.git-detail-pane.is-shown` 把 visibility/pointer-events 写回，形成透明但吃事件的 diff 面板压在编辑器上（能看不能点/滚）。已在 base.css 加嵌套不变量规则兜底（`.xfade:not(.is-shown) .xfade.is-shown`，详见 [animation-system.md](animation-system.md)）。

## 划词批注（2026-09-02 起）

编辑器/预览里划词，浮条多一项「批注」：贴浮条弹出**批注录入框**（路径:起止行 + 批注输入；选中文字不在卡片重复展示，Enter 换行、Ctrl+Enter/保存 存、Esc/点外取消）。GUI 和 CLI Agent 会话的 `批注N` token 带批注文字进入对应工作台输入框，发送时展开成结构化引用 `[文件批注 路径:起-止] 原文：“所选内容”；用户批注：…`，药丸点击回跳本面板对应行并打开批注编辑框；普通 Shell 展开文字后粘贴到终端。Agent 接收端未就绪时提示失败并保留录入框。确认后选中文字上留下批注标记与**计数角标**（编辑态 CM 装饰+widget、预览态包裹 span+内联角标，删除批注即摘除）；**点角标可二次编辑/删除**。路径/行号由 FileEditor 向 `noteBridge.registerFileNoteSource` 注册的解析器捕获（编辑态经 CodeMirror `posAtDOM` 得起止行；md/html 预览态无行号）；完整链路与边界见 [gui-worker-session.md](gui-worker-session.md) 的「文件批注」节。

## 已知边界

- 普通多根创建/编辑入口已开放；全部预览格式的多根真 app 验证仍待完成；代码索引跨根跳转已通过独立 Electron 验收。HTML 相对资源、多根查询后端、QuickOpen、@、watcher、按服务来源触发与根级外改刷新已接通；[手机文件页](mobile-surface.md)已具备选根与 Ref 导航/预览，外改仍靠返回目录或手动刷新补读。
- 当前打开的文件重启后清空（已拍板，见 [ui-state-persistence.md](ui-state-persistence.md) §4）；分割比跨重启保留。
- 当前文件查找是字面量子串匹配（与命令面板「内容」档一致），不支持正则。
- 预览格式矩阵与各格式上限见 [file-preview.md](file-preview.md)（.doc/.ppt/7z 等专有格式明确不支持，出「暂不支持预览」卡片 + 资源管理器按钮）。
- 定位滚动在祖先链较深时逐级等懒加载（每级一次 listDir），首次可能略有延迟。

## 验证

链接目录与文件分类、断链、循环、区内读写和区外写入拒绝由 `test/workspace-tree-links.mjs` 覆盖；`test/unit/file-tree-links.spec.tsx` 与 `workspace-file-trees.spec.tsx` 覆盖展开、鼠标/键盘、删除限制和只读预览。`test/e2e/workspace-file-links.spec.ts` 使用隔离 Windows Electron 工作区，验证真实 Junction 到区外技能、桌面及网页 IPC/只读预览和写入拒绝。深浅主题 280px / 200px 截图在 `.tmp/ui-captures/file-tree-links/`，已查看；当前 Windows 环境无法创建文件符号链接，文件链接分类使用模拟覆盖，macOS/Linux 未真机验证。

`workspace-file-trees.spec.tsx`、`file-editor-roots.spec.tsx`、`side-tools-file-roots.spec.tsx` 与 autosave/history/note 组件回归覆盖同名隔离、相对内链、键盘/定位、旧异步结果、离线失败、根变更保留编辑、媒体 URL、Word 宿主隔离与批注队列回跳；监听错误/手动恢复、隐藏后补读、根版本隔离和脏编辑冲突也有组件回归。`test/workspace-fs-watch-roots.mjs` 覆盖物理句柄共享、重叠/别名分发、撤销/旧批次、事件风暴、启动/运行失败及目录重建，并验证真实 Windows 事件。`test/e2e/workspace-file-roots.spec.ts` 在独立 Electron 沙箱实际打开第二根、键盘编辑/自动保存、外部程序修改对应根后自动刷新，切回第一根并检查磁盘；同时验证真实 IPC/Web/媒体。深浅主题常规宽度与 560px 四张截图存 `.tmp/ui-captures/workspace-file-roots/`，已逐张查看，使用系统字体。

多根查询由 `test/workspace-queries.mjs`、`test/workspace-rg-cancel.mjs` 覆盖真实 rg 与进程控制；`agent-composer-file-roots.spec.tsx` 验证标签/发送值分离、根版本取消、晚到错误与部分失败。上述 Electron E2E 同时验证新查询 IPC/Web 转发、同名 @ 候选及第二根引用插入；返回会话虚拟屏后通过真实入口操作。菜单深浅、常规/390px 四张截图位于 `.tmp/ui-captures/workspace-mentions/`，已查看，系统字体。

## 操作等待反馈

目录树读取统一在刷新入口显示一处单色品牌动效；FileEditor 读取/保存按各自请求状态显示，成功或失败结束。目录行保留文字，不逐行旋转。 组件与场景清单见 [品牌加载动效](brand-loading.md)。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D08-D00.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：右侧文件页——CodeMirror 6 预览/编辑 + 每源根一棵文件树 + 两级搜索（跨文件 QuickOpen / 当前文件 Ctrl+F）+ 树定位；多根工作区按 FileRef 精确寻址；划词批注进会话的入口；外部程序/Agent 改文件时的实时刷新与覆盖保护。
- 为什么这样设计：FileRef（workspaceId/rootId/relativePath）贯穿 autosave/历史/批注/媒体 URL（同名相对路径不串根）；外部修改走 mtime 乐观锁 + fs:changed 监听——无脏改静默重读、有脏改弹三选横幅（重载/覆盖/忽略），绝不盲写也绝不视而不见；打开闸口两分支：源根内可编辑、区外绝对路径只读预览（无写通道，写权限圈在工作区根内）；reveal 只展开到父目录（防懒加载把文件当目录 listDir）+ pendingReveal 处理时序；目录读取失败等手动刷新（不自动重试离线目录防请求风暴）；`.file-editor-main` 容器无条件渲染不变量（首挂空态会导致 EditorView effect 空跑，后续文件全部显示空白）。
- 明确不做：外部文件永远只读（含 md 预览相对链接跳到的区外文件）；当前打开的文件重启后清空（已拍板，ui-state-persistence §4）；当前文件查找是字面量子串、不支持正则（与命令面板内容档一致）；根解除关联不删盘；媒体/文件夹/加载中不参与监听与刷新。
- 歧义点：无真决策（区外只读、重启清空、无正则均为有明文修因的既定取舍；「多根全格式真 app 验证待完成」属测试覆盖缺口而非设计歧义）。
