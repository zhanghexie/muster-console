# 本机存储

## 职责与入口

设置 → 其他 →「本机存储」按任务 worktree、会话、聊天附件、交接文档、扩展、手机应用、浏览器、主题和其他数据展示本实例已识别的文件。顶部占比条和分类大小随工作区范围变化；共享或无法归属的项目单独筛选。界面支持中英文即时切换，资源名称与路径保留原文。

进入、切换或重新打开设置页都不会启动扫描；只有用户点击「开始扫描」或「重新扫描」才读取本机存储。扫描期间以 `BrandLoading` 品牌标志显示真实请求状态，扫描失败显示错误。清理完成后依据逐项结果更新列表，保留尚未处理的项目供继续选择，不自动扫描；若结果无法确认，受影响项目暂停操作，其余项目仍可使用。手动重扫时丢弃旧快照，重扫失败时仍保留上次清理结果。

页面占满设置内容区的可用高度，标题、扫描操作和统计条位于圆角内容框外，分类与清理操作位于框内；标题、统计和底部操作保持可见。分类列表与项目详情各自滚动但不显示滚动条，仍可用滚轮和键盘操作；切换分类或范围时详情回到顶部。窄内容区将分类和详情上下排列，仍各自滚动；清理结果在操作栏以一行摘要显示，未完成项目按需展开查看，较长的失败详情在限高区域内滚动。

项目行直接显示不可清理的原因，默认收起详情，勾选时不展开或跳动；点击行展开详情，再次点击收起。详情展示来源、路径、占用、最近观测到的文件系统修改时间以及清理风险和影响；逻辑条目没有独立路径或时间时显示未知或共享存储。时间是有界扫描观测值，扫描不完整时不保证是实际最新值。路径以只读、可复制输入框和打开按钮展示，影响紧贴该行，详情会滚入可见区域。对已经不存在或无法访问的 worktree 目录，显示相应状态而不是提供必然失败的打开按钮；路径在扫描后失效或打开失败时，错误显示在对应项目旁并保留到重新扫描。

每类项目支持按名称、工作区或路径搜索，筛选全部、可清理或不可清理，并按占用大小或名称排序；大小未知的项目在按大小排序时排在最后。全选只作用于当前筛选结果中的可清理项目，包括尚未通过「显示更多」展开的项目；跨分类和筛选的选择保留，切换工作区范围会清空选择。底部显示已选数量和已统计大小，不代表实际释放量。清空选择、取消勾选或切换范围时清除对应的 App 数据删除选项，避免重新勾选时沿用旧的删除数据选择。

## 运行时路径合同

业务叶服务从注入的当前 userData 根调用 `userDataStorage` / `StorageRootResolver`，按目录 purpose（`resolve('app', purpose)`）或根文件 purpose（`file(purpose)`）派生路径。已接入日志、主题、等待提示、awareness/等待数据库、提醒库、聊天附件、浏览器下载/回执/截图/preload、桌面审计/epoch/dispatch/截图与清理、GUI widget、turn-changes 和后台 shell 输出。purpose 保留现有 Muster 目录与文件名，开发沙箱或测试注入根保持原样；不搬动既有数据，也不扫描或迁移旧产品根。叶服务在访问路径前拒绝旧产品根。

核心 workspace/session 路径通过 scopedPath 接入：主机 GUI snapshot/fork 侧文件/事件文件、调度 workspace 活动指针与 session 日志、workspace 邮箱账本/正文目录、session 证据目录。身份叶名统一经过 `safeScopedKey(value, maxLength)`：先做 NFC 规范化，仅含小写 ASCII 字母、数字、`_`、`-` 且未超长、非 Windows 保留名的 ID 保持可读原路径；发生字符净化、大小写变化、保留名或截断时，输出净化前缀加 `~` 和原始规范化 ID 的 16 位 SHA-256 稳定后缀。这样 `a/b` 与 `a?b`、大小写不同或仅前缀相同的长 ID 不会在大小写不敏感或 Unicode 规范化文件系统上别名。`StorageRootResolver.resolve` 用于 workspace/session scope，`Store.getPiSessionDir`、`schedulerSessionId`/调度 SQLite 路径和 `agentMessagesFilePath`（mailbox）都走同一 helper；简单 UUID 的既有文件位置保持不变。resolver 统一校验非空 scope、单层叶名、路径逃逸与跨平台设备保留名，物理位置保持 purpose 根/原 leaf，不搬入另一棵新 scope 树。现有会话附件哈希、widget 会话目录和 native transcript 布局保持各自既有身份合同，不能机械改成另一套 scope 树。Config 的 config.json 和主 Store 的登记 JSON 文件已接受控 file purpose；Store 的普通/strict 写入、取消待写与注册表主文件/备份均共享同一解析回调。通用 PersistQueue 仍允许调用方注入目录（GUI Store 保持独立合同），不强制把子目录误认作产品根。memory/USER.md 也从 memory purpose 派生。交接文档的创建、读取与清理，扩展的发现/工作台/草稿/共享及工作区数据/恢复状态，反馈队列和凭据、壁纸、头像及实例端口文件均经对应 purpose 派生；真实路径校验与写入使用同一个根。能力管理的库与备份、沙箱 capability-home、入站 MCP 管理记录、持久允许规则、安全评审历史/Pi home、运行时注册表、证据、邮箱账本和模型筛选偏好也使用 purpose。外部 HOME、显式 CLI home 和工作区控制根保持原合同；现有 Muster 工作区邮箱位置迁移保持既有语义。GUI snapshot/fork 侧文件及 fallback event log、调度活动指针和日志也使用目的根；Muster Core 的 GUI 和调度共用 `userData/muster-core` 作为 SDK 配置目录，模型和凭据从工作台配置生成。会话仍分别存入 `agents/pi/sessions` 和 `agents/pi/modes`。shared Claude 配置解析器接受主进程预解析的隔离路径，外部 CLAUDE_CONFIG_DIR 和 ~/.claude 保持原合同。会话/第三方运行时服务其余目录尚需逐域接入；暴露 resolver 或将 app.getPath 替换成 getter 本身不代表完成。

## 发布前 schema v1 与持久化合同

发布前版本采用直接切换。运行时不读取旧 JSON、旧 mailbox、旧 Agent Apps 或旧 knowledge 路径，也不做静默猜测、兼容双写或自动迁移。清理旧开发数据必须由显式 pre-release reset 完成，reset 结果写入发布记录。

`StorageManifest` 集中登记 userData 下的 purpose、根文件和 workspace scoped 资产，驱动路径解析、inventory、清理与恢复诊断。新增直接拼接 `userData` 的入口必须先登记 manifest。邮箱使用 `agent-messages/<safeScopedKey>.sqlite` 和同 purpose 下的不可变正文文件，SQLite v1 以 WAL、`synchronous=FULL`、事务和进程级写链保存状态，读取损坏时保留原文件并返回明确错误。

声明信任账本使用 `declaration-trust` purpose，工作区身份通过 `safeScopedKey` 生成文件名，包含大小写、Unicode 或路径分隔符的身份不会互相覆盖。

资产的持久化强度由调用方标记为 best-effort、process-crash safe、power-loss durable 或 audit durable。SQLite 资产记录 WAL、checkpoint、恢复来源和损坏提示；JSON 资产只保留 canonical 字段，不以 sidecar 或兼容双写补偿并发。

## 统计口径

主进程以当前实例的 `app.getPath('userData')` 和会话登记的外置任务 worktree 为入口。工作区源文件、第三方程序目录、其他实例、导出路径与远端数据在统计范围之外。会话按已知身份聚合 GUI 快照、事件日志、范围索引、分叉资料和原始输入。附件按 `gui:`、`cli:`、`scheduler:` 的短及旧完整哈希匹配，交接文档按目标会话 ID 匹配。归属无法核实或发生冲突的条目仅供诊断。已登记的全局扩展包按目录计一次，工作区激活项和手机 App 安装项使用逻辑条目。工作区的扩展源码由项目管理，统计范围为 profile。SQLite 主文件、WAL、SHM、应用图片和扩展工作区数据目录按工作区哈希归属。无法独立分摊的条目显示「共享存储」，无法读取时显示「大小未知」。空分类显示 0 B。

整个 userData 的统计枚举是 StorageInventory 的显式职责，构造时先拒绝旧产品根；动态未知条目保留原有安全计数逻辑，不把枚举出的任意名称当成业务 purpose。Agent Apps SQLite 叶路径按 workspace scope 与 agent-apps purpose 派生。

扫描使用 `lstat`，跳过 `.muster` 目录，不主动跟随符号链接、junction 或跨设备挂载点；重复硬链接只计一次。每项至多 2 万个目录项、整次 20 万个目录项并有 20 秒预算，触及上限、受保护目录、路径不可读、链接或重复硬链接时标为不完整；项目与总量显示下限，选中项详情显示不完整状态，不在概况额外添加说明和警告。数值是逻辑文件大小，并非磁盘分配量或可保证释放量；工作树与数据目录重叠时只统计一次并标明范围重叠。扫描为快照，不能代表持续变化的文件。

## 清理计划与依赖

快照由资源节点和 `{ dependentId, prerequisiteId }` 边组成。渲染层以快照的不透明 ID 表示选择，真实会话 ID、包指纹、Git 登记和文件身份由主进程据各域登记核验。边由最新业务数据派生。会话的 `parentSessionId` 指向父会话，worktree 的所有者及其借用者引用任务组，扩展激活记录引用对应包。会话的工作目录、续聊目录及其物理别名也参与 worktree 引用核对。节点可横跨工作区和当前筛选范围。

删除资源时沿反向依赖递归计算必删项，按依赖者先、资源后执行。删除依赖者时，只有资源的全部依赖者已进入本次清理范围，才把该资源列入「建议一并清理」。建议项默认未勾选。A 与 B 共享 C 时，删除任一会话会保留 C。如果 B 已先删除，删除 A 时会建议清理 C。直接选中 C 时，确认框列出 A 和 B，两者都必须处理。

一次最多处理 1000 项，含必删及勾选的建议项。确认框列出相关项目和影响，初始焦点在取消。主进程独立重算依赖闭包，拒绝遗漏必删项或形成环的请求。删除前核对现行登记、完整依赖集合和目标身份，并预检所有选中的 Git 资源与扩展包。预检失败会保留受影响的依赖组。执行中重新确认依赖已删除，新的引用或必删项失败会阻止删除被引用资源。逐项结果允许报告执行阶段的部分完成，独立的项目仍可继续。

`localStorage:startCleanup` 接受最近 10 分钟的扫描 ID 和已确认的选择，由 `localStorage:cleanupStatus` 查询进度。实例内同时运行一个清理任务，尝试过的项目需要重新扫描才能重试。已删除依赖的边即时失效，同一扫描的其余项目仍可继续选择。会话移除后的附件和交接清理单独显示后台状态。

## 清理能力

- **会话**可从设置页直接清理，运行中的普通会话先释放运行时，子会话先于父会话处理。`deleteLocalStorageSession` 严格落盘会话移除与保留的 worktree 所有权。存储页保留的所有权继续作为独立 worktree 显示。宿主管理的临时及调度会话使用各自的生命周期。GUI 或 CLI 的外部引擎历史由相应的引擎清理能力决定。
- **Worktree**按登记所有者聚合全部任务组。选中后先做只读 Git 预检，普通清理要求 checkout 干净且分支已合入。身份完整的任务可在确认时逐项勾选丢弃未提交改动和未合入分支。应用核对来源、实际 Git 登记、分支和物理路径，强制删分支使用当前提交比较删除。目录已缺失时核对 Git 残留和任务分支。工作区文件夹引用、未登记目录、无法核验的旧分支和目录访问错误会显示具体失败。
- **附件和交接**可在已归档且停止的会话中单独清理，也会随会话清理。删除附件会影响历史预览并保留原始文件。会话移除后关联清理在后台进行。同批选择的附件和交接只有在会话删除成功发起后才交给会话服务，否则按自身规则执行。
- **全局扩展**将包目录移入系统回收站。启用的工作区记录是包的依赖项，先停用再调用扩展管理服务卸载。已关闭工作区的激活也计入。扩展数据使用独立存储，内置包和项目源码遵循各自的生命周期。
- **自定义主题和自制 App**通过各域服务删除主题、回退引用和卸载 App。卸载 App 可选同时删除业务数据，关联提醒会停止。图像与 SQLite 物理大小取决于剩余引用和数据库状态。
- **浏览器**用 Electron 分区接口清除浏览器站点数据和 HTTP 缓存，影响工作区共用的网站登录。下载完成或中止后凭终态记录及文件身份清理。下载清理前将文件移到隔离位置并复核，变更时尝试恢复。下载记录以同一用户的本地进程可信为前提。
- **采集与诊断**按文件清理可识别的浏览器截图及录屏、终端截图和工作台日志。依赖这些文件的历史预览可能失效，日志写入器可重建日志。
- **其他数据**可按用途清理工作台缓存和网页数据、崩溃转储、性能快照、模型目录缓存、工具结果全文、会话证据、桌面采集、使用统计、会话待办提醒、自定义等待提示和后台任务历史。写入器持有的目录和文件用启动期流程清理。
- **待接入各域删除的资产**包括核心配置和工作区登记、邮箱、活动恢复数据、扩展业务数据、未核验的下载及未识别文件。这些条目提供统计和定位。接入时为对象提供身份、引用、预检与删除动作，共享的物理容器通过所属服务操作。

## 其他数据的重启清理

`maintenanceCatalog.ts` 为每种逻辑数据声明一组受管路径。SQLite 主文件及 WAL、SHM 和回滚日志同时处理。后台任务的登记、备份及输出也作为一个项目。工具结果、桌面采集等数据清理后的历史链接会失效，确认时显示相关影响。默认 Chromium 分区的维护范围要求 Electron 的 `sessionData` 与当前 `userData` 使用同一路径。内置浏览器分区由浏览器的专用操作管理。

用户确认后，主进程在当前 profile 的 `.storage-maintenance` 原子写入清理记录，记录只接受编译进应用的组 ID，并绑定 profile 目录身份与路径清单。设置页显示「等待重启清理」，保留占用并允许继续处理其他项目。用户可点「重启并清理」，正常退出再启动也会处理队列。

启动时取得单实例锁后、数据库与 Chromium 打开数据前，`StartupStorageMaintenance` 在同卷隔离整组的已登记文件，写入隔离结果。启动后台任务逐项回收隔离目录，此时服务已可重建原路径。中断后可以继续回收。清理验证实际目录条目、类型与设备，符号链接和 junction 不会被递归跟随。文件被占用时尝试还原整组，失败原因在重扫后的项目详情中可见。若有成员无法恢复，启动会提示相关路径并暂停，后续启动先恢复这些成员，避免服务读到只剩一部分的数据库。

## 关键实现

| 文件 | 职责 |
| --- | --- |
| `src/shared/localStoragePlan.ts` | 必删闭包、删除顺序和候选建议 |
| `src/main/storage/inventory.ts` / `src/main/storage/sessionDependencies.ts` | 有界扫描、快照、会话引用发现、预检及逐项执行 |
| `src/main/storage/maintenanceCatalog.ts` / `src/main/storage/startupMaintenance.ts` | 逻辑数据组、隔离记录、启动期移出与后台回收 |
| `src/main/browser/downloadStore.ts` | 唯一下载身份、持久凭据和隔离后复核删除 |
| `src/main/ipc/localStorage.ts` / `src/preload/index.ts` / `src/shared/localStorage.ts` | IPC 注册、桥接及结构 |
| `src/renderer/src/components/settings/LocalStoragePane.tsx` / `local-storage.css` | 设置页交互、占比条、范围选择和确认 |
| `src/main/sessions.ts` / `src/main/git/worktreeTaskCleanup.ts` | 会话释放、所有权接续、Git 预检和登记清理 |
| `src/main/extensions/extensionAppSystem.ts` | 全局扩展包与工作区激活登记和生命周期 |
| `src/shared/i18n/locales/fragments/local-storage.ts` | 新增中英文文案 |

定向回归覆盖共享 worktree 的依赖闭包、后加入的引用、失败保留、截图与日志身份、扩展工作区停用及建议项重新计算。`test/local-storage-worktree-integration.mjs` 使用隔离真实 Git 和会话服务验证缺失登记、未合入分支保留及显式丢弃后的共享 worktree 删除。`test/local-storage-dependencies-visual.mjs` 用生产设置组件验证焦点、依赖确认和可选项，覆盖深浅主题与宽窄窗口。`test/e2e/local-storage-ipc.spec.ts`、`test/e2e/local-storage-manual-scan.spec.ts` 和 `test/e2e/local-storage-batch.spec.ts` 使用隐藏 Electron 窗口、隔离 userData 和真实 preload / IPC 验证依赖清单、手动扫描与批量结果，会话后端由测试替身驱动。

`test/e2e/local-storage-maintenance.spec.ts` 在两次启动之间验证「其他数据」的确认、排队和实际文件清理，并核对未选数据。`test/local-storage-maintenance-visual.mjs` 覆盖深浅主题及宽窄窗口下的确认与等待重启状态。主进程回归覆盖 SQLite 伴随文件、文件占用时的还原和重试、程序中断与跨目录链接。
