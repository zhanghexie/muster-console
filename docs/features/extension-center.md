---
doc_type: feature
status: partially_implemented
---

# 扩展中心与工作区激活

当前实现已接入 profile 级工作区激活存储、运行时激活门、本地扩展目录安装、GitHub 静态扩展索引、安装、更新和安全卸载。

## 安装来源

扩展只从两个入口进入系统：扩展中心和本地开发入口。

- 扩展中心提供固定到 GitHub 提交的版本包。
- 本地开发入口登记本地目录或导入本地包，来源标记为 `local-dev`。

管理页使用一排「全局扩展」「项目扩展」「扩展中心」页签。全局扩展按「下载的扩展」与「本地扩展」显示，内置日报列入本地组。中心安装来源记录在应用 profile 的包登记表中，绑定到当前包指纹，和运行信任独立。缺少来源记录的旧包先归本地，和官方索引精确匹配的版本可在核验时补登记。项目页显示所选项目的扩展及项目选择，源码绑定到该项目。

扩展身份使用 `publisherId/extensionId`。版本和完整包指纹组成 release 身份，避免不同发布者或不同来源之间发生覆盖。

## 审核与运行

官方索引由 Muster 发布者维护。中心安装校验 catalog 字段、下载 SHA-256、包指纹、清单身份、版本、宿主最低版本及声明入口。来自默认索引、固定到提交 SHA 的官方版本在校验后记录到应用的包登记表。运行时重新核对全局安装目录、当前包指纹与宿主兼容性，匹配即可打开，并可在离线时使用已登记的发布记录。正式的发布签名与自动审核是后续目标。

宿主可用官方目录核对已安装的同版内容，在联网确认后重新核验磁盘文件，再登记发布记录。内置日报通过应用资源离线验证。自定义包在扩展管理中启用，运行前核对当前目录和整包指纹。工作区启用状态、清单权限、MCP 授权和危险操作确认各有检查入口。

全局页与项目页显示当前工作区的启用状态，源码校验失败列入问题区。创作链单独按清单和整包指纹记录审核状态，没有相应审核记录时创作工具返回待审核。安装及启动内置日报不创建创作审核记录。

## GitHub 分发与凭据

默认目录使用 [zhanghexie/muster-extension-index](https://github.com/zhanghexie/muster-extension-index) 的 `main/catalog.json`，通过 [GitHub Contents API](https://docs.github.com/en/rest/repos/contents#get-repository-content) 请求原始内容。每个独立扩展仓库包含可安装的同名目录以及 `releases/<版本>.json`。索引的包 URL 使用提交 SHA，下载器要求同一 HTTPS origin，并核对 Contents API 中的 GitHub 所有者。索引中的扩展 ID 唯一，与 profile 的安装目录一一对应。

官方索引和六个扩展仓库公开，Muster 默认匿名读取目录与安装包。自建私有中心可以在应用启动环境中提供 `MUSTER_EXTENSION_CENTER_GITHUB_TOKEN`。凭据仅需覆盖索引与该中心的扩展仓库，权限为 Contents 只读。主进程在启动时消费该变量，Bearer 头只发往索引同所有者的 GitHub Contents API，请求拒绝重定向。

`MUSTER_EXTENSION_CENTER_URL` 可以覆盖目录地址，适用于同源静态 HTTPS 或本地 `file:` 测试目录。公开内容可以匿名请求。设置 `MUSTER_EXTENSION_CENTER_LOCAL=1` 使用本地回退。详情页支持展示发布者、仓库、主页、许可、更新说明、README、更新时间和同源截图。

官方六个版本的 [Cloudflare Pages 镜像](https://muster-extension-center.pages.dev/catalog.json) 已上线。镜像保持目录 schema v1，复制固定到 GitHub 提交的原始包字节，并把包地址映射到 Pages 同域的版本和摘要路径。`scripts/build-extension-center-mirror.mjs` 复核提交、SHA-256 和 Pages 大小上限。客户端可通过上述覆盖地址验收镜像。已安装的公开 GitHub 版本继续按现有 GitHub 来源规则登记，Pages 覆盖地址在旧版界面显示为自定义远程目录。

`extensionCenter:list` IPC 返回目录来源与扩展列表。列表工具栏和扩展详情显示主进程实际选用的来源，区分 GitHub、自定义远程目录、本地文件目录与内置目录。使用上次成功的缓存时保留原目录来源，回退到日报时显示内置目录。

索引 release 可带 `category`，支持 `creative`、`reading`、`productivity`、`games`。列表按分类分组并在同一内容列中对齐，缺失或未知分类归到「其他」。

发布目录的可选 `icon` 取自扩展清单，支持稳定的内置图标 ID 和旧短文本图标。列表和详情优先显示已安装版本登记的图标。未安装版本使用目录图标，首批六个官方发布还可按包身份和指纹读到宿主随附的清单图标。内置日报使用随包清单，缺少有效图标的其他条目显示名称首字。

## 本地回退

本地目录只提供 `muster/daily-report`，日报源码来自 `resources/extensions/daily-report`，发行包通过 Electron extraResources 安装到 `extensions/daily-report`。启动安装日报不需要网络。全局扩展页提供本地目录安装与卸载。

## 目录读取性能与降级

远程 catalog 在宿主进程按中心实例保留 30 秒短 TTL。TTL 内的读取直接复用已校验目录；过期后的并发读取共用一个请求（single-flight），避免切换工作区或重复打开面板时重复下载和解析同一份 JSON。手动刷新、安装后状态同步和卸载后状态同步会显式绕过 TTL。

最近一次成功的远程目录会留在进程内作为失败回退。刷新超时、网络断开或目录校验失败时，若存在这份缓存就继续展示它并重新计算本机安装状态；只有从未成功读取远程目录时才回退到随应用分发的日报目录。缓存不会绕过目录 schema、来源同源和 release 字段校验。

目录请求使用 5 秒时限。远程安装包从发出请求开始计时，收到响应头或新的数据块时重新计时。连续 30 秒没有进展时取消下载，并提示检查网络后重试。安装包完整下载后才校验并写入扩展目录。

管理页首次挂载只读取已安装扩展。键盘方向键移动页签焦点，按 Enter 或空格选中。用户选中「扩展中心」后才发起目录请求，后续刷新沿用同一缓存合同。

## 安装进度

扩展中心列表和详情在对应扩展旁显示准备安装、下载、校验和安装阶段。下载使用主进程已读字节数。响应提供可与读取字节数比较的总大小时，显示进度条、已下载量、总大小和百分比。压缩传输或未知总大小时显示正在下载和已读大小。校验和写入阶段显示当前步骤。失败原因留在操作所在卡片，点「重试」可以再次尝试。更新使用同一流程。

`ExtensionCenterService` 在下载、校验、原子写入的真实节点报告进度。主进程对下载字节更新限频，同一 `packageKey` 的并发安装共用一次请求。`extensionCenter:installProgress` 推送带修订号的进行中安装快照，`extensionCenter:list` 附带当前快照。重新打开扩展中心时读取快照，迟到的目录响应不能覆盖更新的进度，安装结束后刷新目录状态。

## 独立仓库与发包

| 扩展 | GitHub 仓库 | 首发版本 |
| --- | --- | --- |
| 五子棋 | [muster-extension-gomoku](https://github.com/zhanghexie/muster-extension-gomoku) | 4.0.1 |
| 书房 | [muster-extension-library](https://github.com/zhanghexie/muster-extension-library) | 1.0.1 |
| 魔方 | [muster-extension-rubiks-cube](https://github.com/zhanghexie/muster-extension-rubiks-cube) | 1.0.1 |
| 媒体创作台 | [muster-extension-dsh-media-desk](https://github.com/zhanghexie/muster-extension-dsh-media-desk) | 0.1.1 |
| 代码动画 | [muster-extension-code-animation](https://github.com/zhanghexie/muster-extension-code-animation) | 0.3.1 |
| 歸藏设计 | [muster-extension-guizang-design](https://github.com/zhanghexie/muster-extension-guizang-design) | 0.1.1 |

书房、魔方和媒体创作台的仓库各自锁定依赖，带构建脚本和共享 motion 定义快照。使用它们自己的 `npm ci` 与 `npm run build` 重建 `ui/`。素材、作者署名与第三方许可随扩展保留。

发包用 `node scripts/pack-extension-release.mjs <同名扩展目录> <输出安装包> [官方前版目录 ...]` 生成 JSON artifact 和索引元数据。打包、发现新版和审核通过的投稿均从该版本清单采集 `icon`。索引的 `previousFingerprints` 允许从精确匹配的官方前版更新；首次迁移包含主仓两个已知快照的指纹。SHA 与版本标签先推到扩展仓，再提交索引。

## 投稿、审核和试装

桌面端配置 `MUSTER_EXTENSION_PUBLISH_URL` 后，全局本地扩展条目提供「提交到扩展中心」。`extensionPublishing:*` 只接收桌面主窗口调用。主进程读取所选扩展源码的完整快照，使用中心格式打包，上传请求只带该扩展的包和选定仓库。第一次填写自己的公开空仓库地址，后续可复用来源提交更新。

`scripts/extension-publishing-service.mjs` 使用 GitHub App 的授权码及 PKCE 验证账号，按 GitHub 数字 ID 核对仓库所有者。作者在 GitHub 将 App 安装到目标仓库，使其用户访问令牌能写入该仓。`scripts/upload-extension-submission.mjs` 以 Git 原子推送写入分支与版本标签。服务重新从固定提交读取包，校验版本、入口、指纹和 JS/TS 语法，并保存待审核候选。手动初检工作流只在私有仓执行。

服务端每次按审核员名单校验队列、详情、包下载和审核动作。作者的提交记录显示自己扩展的版本与处理结果。审核员在「待审核」里试装，正式安装器把精确候选装进独立的测试 profile，工作台启动后打开该扩展。扩展仍走通常的运行信任确认。测试 profile 隔离应用状态，第三方代码需要用具备系统隔离的测试环境运行。试装成功后才能批准同一摘要，服务在批准时重新核对包，并只把已批准的记录放进自己的公开 `/catalog.json`。配置发布服务的客户端使用默认中心时，会在原官方目录之后附加该服务的已批准包。官方身份与工作区启用规则沿用现有合同。

桌面端在「扩展管理」按住 Shift 并在三秒内连续点击「扩展中心」标签三次，打开「发布管理」。面板显示当前连接，可登录 GitHub；服务端确认审核员身份后显示「待审核」。手势只控制入口的显示。普通作者沿用扩展卡的投稿流程。

「启动本机服务」会选择一份 `publishing.env`，由主进程读取配置并启动同一服务脚本。开发版使用当前源码检出，安装版从服务源码检出的根目录选择配置文件。两种方式都需要服务源码依赖（`npm ci`）与应用 PATH 中的 Git，Node 使用 Electron 自带的运行时。配置中的相对数据路径以配置文件所在目录为准。服务监听回环地址，启动成功后桌面端自动切换到本机连接，相应的已批准包会并入默认目录。停止服务或退出桌面端时，应用回收自己启动的进程并恢复启动时配置的连接。登录凭据绑定各自的连接。

独立部署需要 Node 24、Git 和服务源码依赖。以 `MUSTER_PUBLISH_ORIGIN` 配置公开 HTTPS 地址，`MUSTER_PUBLISH_DATA` 配置私有持久目录，`MUSTER_PUBLISH_REVIEWERS_FILE` 指向数字 ID 的 JSON 数组，`MUSTER_PUBLISH_GITHUB_CLIENT_ID`、`MUSTER_PUBLISH_GITHUB_CLIENT_SECRET` 和 `MUSTER_PUBLISH_GITHUB_APP` 配置 GitHub App 信任和安装入口。App 回调为 `<地址>/login/callback`。使用 `node --env-file=publishing.env scripts/extension-publishing-service.mjs` 启动，由 HTTPS 入口代理 `MUSTER_PUBLISH_PORT`（默认 8791）的回环监听。活动登录保存在服务进程，重启后重新登录。

仓库回归可在独立扩展仓运行。宿主的外部扩展 Electron 验收使用 `MUSTER_EXTENSION_CENTER_E2E=1` 访问默认公开目录，或用 `MUSTER_EXTENSION_CENTER_URL` 指向自备的本地目录夹具。Chromium 面板走查夹具读取 `MUSTER_EXTENSION_FIXTURE_ROOT/<id>/<id>` 中的源码及已构建 UI。标准宿主离线测试和日报启动均可在干净 checkout 运行。

## 工作区激活

安装记录属于应用 profile，启用记录属于工作区。安装默认不自动启用，用户可以在当前工作区启用或对全部现有工作区批量启用。工作区关闭扩展后，面板、toolbar、DomainRuntime、Agent 和后台任务都必须停止或拒绝继续调用。

同一扩展可以在一个工作区开启，在另一个工作区关闭。扩展版本更新不会改变已有工作区的启用状态。

当前实现已经持久化工作区激活记录，管理页支持当前工作区切换和全部现有工作区批量启用。工作台导航、toolbar、面板调用、资源读取和扩展任务会读取同一份激活状态。

本地安装入口使用系统目录选择器，把经过 Manifest 和整包指纹校验的目录原子复制到 profile 全局扩展目录，安装后默认对所有工作区关闭。中心安装沿用同一 profile 目录和工作区激活记录。用户在「扩展管理」启用后即可使用。内置日报随应用安装并默认启用。

## 更新与卸载

远程更新先检查磁盘中的实际包指纹。官方前版可原子切换，内容有变化的同名副本会收到导出或移走副本的提示。更新失败时旧版本继续可用，工作区数据和启用状态保留。

全局源码包和工作区数据分别管理。扩展中心卸载前要求停用所有相关工作区的激活。设置「本机存储」可确认同一清理计划，在所有激活停用成功后卸载包。卸载会关闭该扩展的面板和命令运行实例，并验证当前包指纹。

全局扩展页可通过 `extensions:uninstallGlobal` 将旧版中心扩展或手工安装的全局包移到系统回收站。宿主检查所有工作区的启用状态和本机包指纹，再移走包目录；系统回收站不可用时显示错误并保留源包。内置日报和项目源码不在此入口的卸载范围内。

## 运行时边界

所有运行入口共享工作区激活检查，包括面板打开、reload、toolbar、DomainRuntime 调用、资源读取和后台任务。检查内容包括包存在、来源状态、工作区 enabled、当前指纹、Manifest、权限和运行实例身份。

扩展运行进程仍具有宿主当前的本机权限，进程隔离不等同于操作系统沙箱。跨平台路径、权限、原子替换和进程回收由宿主适配层提供明确错误。

## 当前迁移边界

现有全局包会迁移为 profile 级安装记录，并把原有全局 enabled 行为展开为各现有工作区的激活记录。现有项目包会导入为全局 `local-dev` 包，并只对原来可见的工作区建立激活记录。旧本机审核记录保留为历史信息，不再成为本地运行时的审核门。
