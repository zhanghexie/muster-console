# Cua Driver 固定版本准备

此目录提供固定版本驱动的准备、构建校验和打包接线；准备工具不会安装或启动驱动。使用 Node.js 20 或更新版本、本项目已有的 `fflate` 和 Git。桌面业务运行时代码仍须按下述路径接入并单独验收。

```text
node scripts/desktop-driver/prepare.mjs --list
node scripts/desktop-driver/prepare.mjs --prepare --platform win32 --arch x64 --output <项目绝对路径>/.tmp/desktop-driver/win-x64 --archive <已下载压缩包绝对路径>
node scripts/desktop-driver/prepare.mjs --prepare --platform linux --arch arm64 --output <项目绝对路径>/.tmp/desktop-driver/linux-arm64 --archive <已下载压缩包绝对路径>
node scripts/desktop-driver/prepare.mjs --check --platform win32 --arch x64 --output <项目绝对路径>/.tmp/desktop-driver/win-x64
npm run desktop-driver:check
node scripts/desktop-driver/sbom.mjs --write .tmp/desktop-driver/sbom.cdx.json
node scripts/desktop-driver/sbom.mjs --check .tmp/desktop-driver/sbom.cdx.json
```

`--platform` 和 `--arch` 可省略，默认取当前 Node 平台及架构；只支持 `win32`、`darwin`、`linux` 的 `x64` 和 `arm64`。`--output` 的父目录必须已存在，目标本身不得存在。输出可以位于 Git 工作树外；在本项目工作树内时，输出只允许是固定的 `.tmp/desktop-driver/` 缓存根内新建的子目录，不能使用其他 Git 路径。使用此缓存前需创建该根目录并安装 Git；工具会确认项目是 Git 工作树根、缓存根及目标被忽略且缓存内没有已跟踪文件，检查失败时拒绝写入。输出和项目路径的各级祖先不得是 symlink/junction，输出路径不得经过其他嵌套 Git 工作树，也不接受包含 `..` 的输出路径。

下载与解包使用输出父目录内本次独占创建的临时目录；发布前重新检查路径和 Git 状态，以独占创建的目录接收结果，失败时仅清理确认仍属本次创建的临时目录，发布期间已经创建的目标目录则保留并在错误中指出。Windows 目录访问权限沿用父目录 ACL，应选择受信任的缓存根。若文件系统无法提供可核验的目录身份，工具会报错并保留该路径。`--archive` 适合离线或外部缓存，压缩包仍须匹配固定版本的完整大小和 SHA-256。

上述检查和清理基于 Node.js 的路径与目录身份信息，并非以系统目录句柄绑定所有操作：若其他进程同时恶意替换目录，检查与创建、移动或清理之间仍存在 TOCTOU 窗口。应将缓存放在受信任且不被不可信进程并发修改的工作区；不能把这些检查当成跨权限边界的沙箱。

结果位于 `output/contents/driver/` 和 `output/contents/notices/`。前者保留上游压缩包的完整文件集，包括 Windows `cua-driver-uia.exe`、Linux Wayland helper、macOS app bundle 以及上游 LICENSE 和第三方声明；后者补充 Node 原生运行时许可、MPL 正文和源码说明。输出路径及文件不会被后续调用覆盖。Unix 包需要保留可执行位，因此 Windows 上拒绝准备 Unix 目标；请在 macOS 或 Linux 上准备。跨架构准备只校验文件，不运行目标程序。

## 构建与打包

固定缓存名为 `win-x64`、`win-arm64`、`mac-x64`、`mac-arm64`、`linux-x64`、`linux-arm64`；macOS 两个目录使用同一个 universal 发行包。先按目标平台和架构准备对应目录，构建不会自动下载或以本地回执代替哈希。macOS 默认一次构建两个架构，需要事先准备 `mac-x64` 和 `mac-arm64` 两份缓存；Linux 默认目标架构由构建命令决定。不支持的架构、缺失缓存、内容或许可声明改变以及无法核验 Unix 模式都会明确失败。

`npm run dev`、`dev:run`、`dev:no-sandbox`、`dev:clean`、普通 `build` 和 `start` 不要求事先准备桌面驱动；需要时可单独运行 `npm run desktop-driver:check` 检查宿主缓存。实际使用驱动时，桌面业务入口负责报告缺失及准备方式。`build:win`、`release:win`、`build:mac`、`build:linux` 及直接调用 electron-builder 时，由现有 `beforePack` 在裁剪依赖前强制校验目标缓存，`afterPack` 在签名之前再次校验复制后的文件及声明。两次校验均基于固定清单，不证明运行或签名；`release:win` 原有发布行为不变。

electron-builder 将目标缓存 `contents` 作为 `extraResources` 复制到 `process.resourcesPath/desktop-driver/contents/`，包含 `driver/` 和 `notices/`，不受 asar 内通用 Markdown/LICENSE 过滤影响。Windows 的 Cua 三个 `.exe`（及 SDK DLL、Node runtime）从额外资源签名转换中排除，以保留上游文件字节及签名；普通应用 `.exe` 的签名规则不变。开发环境宿主固定路径为项目 `.tmp/desktop-driver/<目标>/contents/driver/cua-driver[.exe]`，安装包内为 `process.resourcesPath/desktop-driver/contents/driver/cua-driver[.exe]`。这些路径需由宿主代码持有，不能由模型指定。

复制后校验发生在 electron-builder 最终签名之前，不能代替最终安装包回读、平台签名或公证验收；macOS 对嵌套 app 的签名和 TCC 授权主体仍须在真机核对。文件检查与复制之间仍存在并发替换窗口，构建目录必须受信任。

Windows x64 可运行 `node scripts/desktop-driver/verify-builder.mjs`，用本地 Electron 和已准备缓存在项目 `.tmp` 创建隔离的 electron-builder `dir` 夹具，校验实际复制结果后清理本次夹具；它不签名、不发布、不执行应用，也不生成安装器。该夹具使用生产打包配置与资源规则，但跳过会裁剪共享 `node_modules` 的原有 `beforePack` 依赖维护步骤，不能替代完整产品打包验收。

代码入口为 `describeTarget(platform, arch)`、`describeDesktopEnvironment(platform, env)`、`prepareDriver({ output, platform, arch, archivePath? })` 和 `inspectPrepared(output, { platform, arch })`。Linux 的桌面类型仅按环境变量提供提示，冲突时返回 `ambiguous`，不会将 XWayland 当成原生 Wayland 验证；Windows/macOS 会话状态未探测。`inspectPrepared` 每次重新校验所有固定文件及补充声明，不信任本地回执。`contentVerified` 仅表示内容与固定哈希一致；`modeVerified` 在 Windows 目标为 `null`，其余目标表示本机文件模式已核对。`runtimeVerified`、`signatureVerified` 和 `distributionReady` 均不会由本工具设为 true。系统权限、图形会话是否真正可用、目标应用及产品运行时不在本工具的判断范围。

## 固定来源与验证范围

`catalog.mjs` 固定 Cua Driver 0.59.4、源码提交 `01207bbf0ddcc0f2bb9642322c4e8b4b02319d1b`、完整发行压缩包的长度和官方 SHA-256，以及在压缩包通过校验后独立计算的逐文件长度和 SHA-256。不会从下载响应、环境变量或用户参数动态取得信任哈希。HTTPS 仅接受 GitHub 和指定 GitHub 发行资产域名的重定向，限制下载大小和时间。[Cua Driver 0.59.4 发行版](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.59.4)

2026-11-23 下载并核对了 0.59.4 的五个普通发行包，覆盖 Windows x64/arm64、Linux x64/arm64 和 macOS universal。六份目标缓存均通过准备入口及逐文件校验。macOS arm64 隔离 Electron 夹具验证了应用发现、截图、窗口聚焦、点击、键盘输入、语义读取和停止。Windows、Linux 和 macOS x64 的新版驱动尚未真机运行，签名安装包仍待验收。

固定压缩包解包时只接受清单中的普通文件和目录，拒绝链接、特殊文件、路径穿越、重复路径、额外文件、异常尺寸及不受支持的归档扩展。真实发行包经检查均不含链接或 TAR 扩展；未来版本不能沿用本清单，需重新审查。离线回归入口为 `node test/run.mjs desktop-driver-preparation`；测试临时数据均位于本项目 `.tmp/desktop-driver/` 下，并仅清理本次创建且身份仍匹配的测试目录。

补充许可材料的哈希以仓库中 LF 行尾的原始字节为准。离线回归会在下载驱动前验证这些固定文件，捕获格式化造成的哈希漂移。

## 分发前仍需完成

固定 SHA-256 不能替代对上游 Sigstore、平台签名、公证或产物来源证明的验证。依赖闭包和 SBOM、MPL 对应源码及修改的实际可获取性也需按最终选择的可执行文件与依赖完成审核。特别是本仓 `electron-builder.yml` 会过滤普通依赖中的 LICENSE 和 Markdown，接线时须显式将许可材料作为独立资源分发，并验证安装包中实际存在。macOS TCC 权限归属、签名/公证、Linux 依赖与 Wayland compositor、Windows 完整性级别及各架构运行均需分别验收。

`sbom.mjs --write` 生成确定性的 CycloneDX 1.5 JSON：内容来自 `package-lock.json` 和固定 Cua catalog/来源/NOTICE 属性，不把 `runtimeVerified`、签名或安装器验收伪造为通过；`--check` 用于构建前回归。Cua 二进制的完整传递依赖和对应源码可获取性仍需分发审核。
