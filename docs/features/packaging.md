# 打包与安装包（electron-builder）

## 功能职责

Windows 安装器同时分发 [外部 Agent CLI](cli.md)：独立 `out/main/cliRuns/entry.mjs` 随 asarUnpack 解包，`resources/cli` 作为 extraResources 原样保留 Skill／安装脚本／调度说明。NSIS 安装与卸载钩子运行该脚本，维护当前用户 PATH 及带归属标记的命令入口；不额外依赖 Node.js。第三方同名命令冲突会报告并保留原命令。

把 electron-vite 产物（`out/`）+ 生产依赖 node_modules 打成 Windows NSIS 安装包（`release/Muster-Console-<version>-Setup.exe`），mac dmg / linux AppImage·deb 同配置。体积与安装时长主要由「落盘总量 + 解出 asar 的物理文件数」决定。

## 关键文件与入口

- [electron-builder.yml](../../electron-builder.yml)：files/asarUnpack/targets；**注释里有依赖归类合同，改打包先读**。
- `package.json` 的 `"packageManager": "traversal"`（勿删）：强制 electron-builder 走 traversal 依赖收集器。
- `scripts`：`build:win` / `build:mac` / `build:linux`。
- [scripts/before-pack.mjs](../../scripts/before-pack.mjs)：`beforePack` 钩子：按构建目标剔除非宿主平台的 `@esbuild` 二进制（mac/darwin 一律保留双架构）、给 darwin prebuilds 的 spawn-helper 补执行位、补丁 node-pty unixTerminal 的 helperPath 双重 unpack 映射（详见下文 mac 节）。导出各规划函数供测试。
- Cua Driver 0.59.4 固定发行物和目标平台缓存由桌面驱动脚本准备。`beforePack` 在裁剪依赖前校验，`afterPack` 校验复制后的资源。[桌面驱动打包说明](../../scripts/desktop-driver/README.md)
- [`.npmrc`](../../.npmrc) + `package.json` 的 `config` 段：国内下载镜像（registry / Electron zip / nsis·winCodeSign 二进制，2026-09-20 起），覆盖 npm run 链路；机制边界与切源方法见「交互与已知边界」。
- [test/packaging-file-filters.mjs](../../test/packaging-file-filters.mjs)：排除模式与裁剪规划的回归守卫（进 `npm test`）。
- 体积分析脚本：`.tmp/asar-inspect.mjs`（列 asar 内按目录的体积/文件数）、`.tmp/verify-packaged-entries.mjs`（逐包核对入口文件存在）、`.tmp/check-ts-conditions.mjs`（校验被排除的 `.ts` 不在运行时解析条件下）。

## 数据流 / 依赖收集

**先合并，再制作安装包**：`electron-vite build` 将主进程和 preload 的应用源码合并为各自的入口产物；renderer 使用 Vite 分包，`rendererManualChunks` 按 React、CodeMirror、终端、Markdown 等依赖拆 chunk，动态加载的功能也可以有独立文件，因此不是全应用只输出一个 JS。入站 MCP、附件 worker、CLI 等独立入口由 esbuild 单独合并，部分 worker 和 SDK 资产则按路径复制。构建配置见 [electron.vite.config.ts](../../electron.vite.config.ts)。

**合并不等于代码压缩**：当前 electron-vite 2.3 的主进程、preload 和 renderer 构建预设均为 `minify: false`，本仓配置未覆盖；上述独立 esbuild 入口也未启用 minify。输出仍经过模块合并，但通常保留可读的变量名与空白。electron-builder 再将产物和生产依赖打入安装包；安装包压缩、asar 归档与 JS minify 是不同环节。

桌面驱动从 `.tmp/desktop-driver/${os}-${arch}/contents` 按目标架构作为 `extraResources` 复制到 `resources/desktop-driver/contents`，包括上游 LICENSE、NOTICE 和补充许可材料；不走会过滤这些文件的顶层 `files`。开发入口和普通 `npm run build` 不因驱动缓存缺失而阻断；正式打包按实际目标检查，缺失或哈希不符则失败且不自动下载。Windows Cua 可执行文件跳过额外资源重签名以保持上游字节；复制后的哈希检查在最终平台签名之前，真实安装包、macOS 签名/TCC 与其他平台运行仍须单独验收。当前桌面业务代码的驱动路径接线以 [桌面控制现状](desktop-control.md) 为准。

Unix 全局 Esc 监听辅助进程由构建插件单独打成 `out/main/desktop/unix-escape-worker.cjs`，Wayland 停止控件的 Python 辅助程序原样复制到同目录；二者列入 `asarUnpack` 并通过路径适配读取真实文件。Wayland 还依赖系统 Python、GObject、GTK 3 和 GTK Layer Shell，资源存在不代表该会话支持这些依赖或已接入产品。定向测试构建真实 worker 并检查路径和解包配置，macOS/Linux 安装版仍未验证。

1. **traversal 收集器**（`app-builder-lib/out/node-module-collector/traversalNodeModulesCollector.js`）：只从根 package.json 的 `dependencies`+`optionalDependencies` 出发直接遍历 node_modules（防环、按包名去重、嵌套提升到顶层）。**devDependencies 一律不进包**；默认 npm 收集器（`npm list -a`）在本仓依赖图上会指数级膨胀至 OOM，故必须走 traversal。
2. **依赖归类合同**（详见 electron-builder.yml 注释）：
   - 只被 `src/renderer` 引用的包 → **devDependencies**（renderer 由 Vite 打进 `out/renderer` 的入口或分包，node_modules 里再发一份是死重）。典型：react 系、`@codemirror/*`、`@xterm/*`、pele（2026-10-24 替换 mermaid）、docx-preview。`xlsx` 同时被主进程动态导入，因此仍在生产依赖中。
   - 被 main/preload/shared 引用且由 `externalizeDepsPlugin` 外置，或被 `createRequire`/子进程按包名解析的包 → **dependencies**。注意易漏：`qrcode`（main 生成配对二维码）、`i18next`（shared/i18n）、`@vscode/ripgrep`（workspaceRg 按平台解析）、`@larksuite/cli`（larkCli spawn）、`node-pty`。`yaml` 是例外：主进程的静态引用已配置为合并进 bundle，但 Pi 运行时的 `@earendil-works/pi-coding-agent` 仍依赖独立的 `yaml` 包，不能仅凭主进程已合并就从安装包删除。CodeGraph、平台 bundle 及其独占语法解析依赖已删除，不再手动补装；仍存活的依赖按实际主进程/子进程引用保留。
3. **asarUnpack**（0.1.17 起整树解包）：部分应用 worker/预加载入口和 `node_modules/**/*` 生产依赖整树落到真实文件系统。历史上按包名手工维护闭包清单，两度漏包后改为整树解包，与 dev 解析环境对齐。**不能笼统地认为 `ELECTRON_RUN_AS_NODE` 一定无法读 ASAR**：2026-10-28 在 Windows、Electron 43.7.0 的隔离实验中，归档内的 `openai`、`zod` 和 `typebox` 均可通过 CommonJS 和 ESM 加载。但普通外部 Node 进程、原生模块及需要真实路径的文件仍须逐项验证；部分代码会显式将路径改写到 `app.asar.unpacked`（如宿主 MCP 启动器）。简单加载实验不代表产品完整调用链已通过，收窄解包范围必须检查路径、生产依赖闭包和各平台真实安装包。
   - 内置引擎 worker `out/main/agentSession/drivers/pi/worker.cjs` 由构建插件单独生成并解包。Pi 上游 MIT 许可证通过 `extraResources` 从 `resources/third-party/pi-LICENSE.txt` 复制到安装资源，绕开通用许可证文件排除规则；安装包中实际落点和三平台启动仍待用户验证。
4. **安装体积裁剪**（0.1.23 起，四条互不相干的裁剪）：
   - `files` 按扩展名排除生产依赖里的死重：`*.map`（4350 个 / 43MB，文件数最大头）、`*.{ts,mts,cts}`（各包 src/ + 类型声明：minimatch 的 `*.ts` 匹配 `index.d.ts` / `*.mts` 匹配 `index.d.mts`，不必再写一条 `*.d.ts`）、`*.md` 与 LICENSE。共约 6969 个文件 / 55MB，运行时零用途。electron-builder 默认 `excludedExts` 只覆盖应用目录、不覆盖 node_modules，所以必须显式写进 `files`。已核实 `out/` 内无这几类，且被排除的 32 个 `.ts` 导出目标全挂在打包器专用条件（`@zod/source` 等）下，Node 运行时解析路径上一个都没有。
   - `electronLanguages: [zh-CN, en-US]`：Electron 默认发全部 55 个 Chromium `locales/*.pak`（46.6MB），应用只支持这两种语言（i18n `supportedLngs`），裁掉 53 个省 45.5MB。app-builder-lib 的非 mac 分支直接删 `locales/*.pak`，Windows 同样生效。
   - `beforePack: ./scripts/before-pack.mjs` 剔除非目标平台的 `@esbuild` 预编译二进制（25 个包 / 271.8MB，占解包树 36%）：`esbuild` 是 `@earendil-works/chord`（pi-coding-agent 闭包内）的真实运行时依赖不能整包排除，但它把 26 个平台包全列进 `optionalDependencies`，而 pi-coding-agent 自带 `npm-shrinkwrap.json` 会把它们全装进嵌套 node_modules（绕过 npm 的 os/cpu 过滤），traversal 收集器再提升到顶层。钩子按 `electronPlatformName + arch` 只留宿主平台那个（**darwin 例外：一律保留两个架构**，因为 mac 双架构 dmg 一次运行连打，按架构裁剪会让第一架构 pass 删掉第二架构需要的目录——2026-10-07 首次 mac 出包实测踩过，x64 dmg 里 @esbuild 整体缺失）。宿主平台包缺失时打 warn 而非静默通过。**注意它会真删 node_modules 里的目录，需要恢复跑 `npm install`**。
   - 平台 vendor 排除使用 `!node_modules/@anthropic-ai/claude-agent-sdk-*/**`。Claude GUI 在运行时加载 JS SDK，安装包使用用户本机的原生 CLI。Codex GUI 通过本机 CLI 的 app-server 工作，依赖树无需安装 Codex npm 包。原生 worker 随主进程资产解包。

记忆系统已移除本地向量模型、`@huggingface/transformers` 和 ONNX 推理依赖及相应 extraResources；旧模型资源不再参与构建。实际安装包体积和安装耗时仍需重新出包测量。

## 优化候选（2026-10-28 调查，未实施）

- **纠正生产依赖归类**：`border-beam`、`rehype-katex`、`remark-math` 的产品源码引用位于渲染层，当前却列在 `dependencies`；按当前 traversal 依赖图，假设只移动这三个根依赖到 `devDependencies`，约 69 个包节点不再可达，过滤常见排除项后约 511 文件 / 5.24 MiB。此为依赖图估算，最终以真实构建和安装产物为准；必须验证数学公式、看板与构建产物。
- **收窄 ASAR 解包和依赖去重**：前述 ASAR 简单加载实验支持对纯 JS 依赖做小批量迁移，但仍须核对 worker/外部进程、显式路径改写和原生模块。当前依赖图同时包含 `@anthropic-ai/sdk` 0.123.0 和 0.129.0；是否能通过版本对齐去重，取决于真实 SDK 兼容性与重新安装后的依赖图。ASAR 归档主要减少物理文件数，去重与删除浏览器资产才直接减少落盘字节数；各项估算不能直接相加。
- **JS minify 与安装器压缩**：对 10 月 28 日现有 `out/` 中 Vite JS 做离线 esbuild minify，原始总量约 15.0→10.5 MiB；产物之后已有源码改动，这不是新构建或安装包实测。Windows NSIS 默认生成差分友好的非 solid 7z（1 MiB 字典），改压缩参数须同时测完整安装包、差分更新下载量和安装耗时，不能只比 Setup 文件大小。

## 交互与已知边界

- **历史体积基线（0.1.23 裁剪落地，2026-09-15 实测）**：Setup **170MB**、落盘 **757.5MB**、物理文件 **8336**（其中 `app.asar.unpacked` 8313 个 / 426MB，`app.asar` 16.3MB，Electron 运行时本身 313.8MB 是固定成本）。相对 0.1.22 的 266.5MB / 1129.7MB / 15128 个文件：安装包 −36%、落盘 −33%、**文件数 −45%**。安装耗时受解压、临时目录拷贝、Defender/EDR 扫描和磁盘等共同影响，减少小文件值得优先评估，但收益须以真实安装对比。**这组数字测于 claude/codex GUI SDK 进 dependencies 之前**。
- **历史抽查（0.1.27，2026-10-03，本地未发布）**：Setup **227541804 字节 / 217.0 MiB**，`win-unpacked` **963723843 字节 / 919.1 MiB、9091 文件**（不含测试沙盒），`app.asar` **20234928 字节 / 19.3 MiB**。106 个 out 文件与打包内容逐文件 SHA256 一致，打包版启动与静态毛玻璃资源加载通过；未执行安装向导，不把解包目录统计当成真实安装目录统计。网络受限时可指定已有同版本运行时：`npx electron-builder --win --config --publish never --config.electronDist=node_modules/electron/dist`；本次实际版本为 43.7.0。证据在 `.tmp/ui-captures/workspace-material/package-qa.json` 与 `packaged-smoke.json`。
- **旧产物抽查（0.1.31，2026-10-22）**：Setup **212264040 字节 / 202.4 MiB**，`win-unpacked` **744.0 MiB / 9411 文件**；其中 `app.asar.unpacked/node_modules` **381.1 MiB / 9370 文件**，`app.asar` **23.8 MiB**，`resources/memory-model` **23.3 MiB**。这是已有解包目录的统计，不是当前代码的重新出包或真实安装耗时。
- CodeGraph 与独占语法解析资源已退出生产依赖及打包清单。上述体积是历史产物，删减后的安装包大小和安装耗时须实际出包重测。
- 历史：0.1.10→0.1.16 安装包 114→230MB（CodeGraph +39MB、larksuite/cursor 解包 +37MB、mermaid 死重）；2026-09-06 依赖归位后 asar 288→126MB、Setup 230→189MB；0.1.22 涨到 266.5MB（@esbuild 全平台二进制随 pi-coding-agent 升级进包）；0.1.23 裁剪到 170MB。
- **不要给 `win`/`mac`/`linux` 加平台专属 `files`（2026-09-15 踩坑实测）**：加上后顶层 `files` 的正向模式（`out/**/*` 等）会在**主匹配器**里整体失效（node_modules 匹配器不受影响，只有应用目录这一侧丢），electron-builder 随即按 `containsOnlyIgnore()` 判定「只有排除模式」并自动补 `**/*`，把整个仓库根目录扫进 asar——实测 asar 18MB→1792MB、Setup 266.5MB→1061MB，而且**构建正常退出、不报任何错**（当时进包的是 `refs/` 竞品克隆 470MB、`.dev-sandbox/userData` 365MB、`.tmp` 289MB）。要按构建目标裁东西一律走 `beforePack`。另注：node_modules 的过滤器（`getNodeModuleFileMatcher`）**只采纳 `!` 开头的模式**，正向模式一律丢弃，所以「排掉一批再单独放回一个」在 `files` 里无解，这也是 @esbuild 平台裁剪必须用钩子的原因。守卫见 `test/packaging-file-filters.mjs`。
- **国内镜像**通过 [.npmrc](../../.npmrc) 将 registry 设为 `https://registry.npmmirror.com`，npm 的默认 `replace-registry-host=npmjs` 会替换 lockfile 中指向 npmjs 的地址。Electron zip 和 nsis/winCodeSign 二进制镜像在 `package.json` 的 `config` 段，键名 `electron_mirror` 和 `electron_builder_binaries_mirror` 保持小写，避免在 Windows 上被大小写变体遮蔽。npm 只把根项目的 `npm_package_config_*` 注入自己的 `npm run` 和生命周期脚本。
  - Electron v42 起由 `require('electron')` 按需安装平台二进制。开发命令共用 [`scripts/run-electron-vite.mjs`](../../scripts/run-electron-vite.mjs)，在 Vite 构建前调用该入口，沿用 npm 注入的镜像，并把解析出的路径传给 electron-vite。显式提供 `ELECTRON_EXEC_PATH` 时直接使用该路径。下载失败会显示 Electron 安装错误并中止启动，镜像恢复后可重跑 `npm run dev`。回归覆盖见 [`test/dev-electron-bootstrap.mjs`](../../test/dev-electron-bootstrap.mjs)。
  - electron-builder 打包时通过内嵌的 @electron/get 3.1.0 下载 Electron zip，通过 `getBinariesMirrorUrl` 下载 nsis/winCodeSign。**镜像优先级**为 `NPM_CONFIG_*`/`npm_config_*` > `npm_package_config_*` > `ELECTRON_MIRROR` 或 `ELECTRON_BUILDER_BINARIES_MIRROR`。Windows 对环境变量名大小写不敏感。镜像故障时用 `NPM_CONFIG_ELECTRON_MIRROR` 或 `NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR` 覆盖相应镜像，也可临时改 `config` 段的值。这两个键放进 `.npmrc` 会触发 npm 的未知配置警告，还会在 Windows 上遮蔽同名 `NPM_CONFIG_*` 环境变量。registry 可用 `npm install --registry=…` 临时切换，也可修改项目 `.npmrc`，其优先级高于 `~/.npmrc`。镜像配置守卫见 `test/packaging-file-filters.mjs` 第 7 节。
- **新 clone 的 `npm install` 仍有一处 GitHub 直连（既有现状，非镜像配置引入）**：`@electron/node-gyp` 是 git+ssh 依赖（package-lock 全部 resolved 里唯一的非 registry 项），无 GitHub SSH key 的机器会卡在这步，与下载镜像无关。
- **Windows 静默安装边界（2026-09-08 实测）**：本包是多用户 NSIS（oneClick:false + perMachine:false），`initMultiUser` 按 HKLM `Software\<appId-GUID>\InstallLocation` 识别旧安装——只要存在 per-machine 残留记录（目录被手删、没走卸载也算），`/S` 静默升级就强制 `UAC_RunElevated`，UAC 被拒/超时则**整包不装**；且外层退出码与成败不对应（实测用户取消=0、成功=199），判定安装成败只认落盘目录 + HKLM `Uninstall\<GUID>` 的 DisplayVersion + 与 `release/win-unpacked` 逐字节比对（此为 2026-09-08 旧包口径；2026-09-13 起新包静默升级注册表写 HKCU，判定认 HKCU 对应键，见下方根治条）。Git Bash 传 `/S` 必须 `MSYS_NO_PATHCONV=1`（否则被 MSYS 路径转换成 `S:\`，弹出交互向导）；要免提权可加 `/currentuser` 强制 per-user（装到 `%LOCALAPPDATA%\Programs\MusterConsole`，绕开 HKLM 残留；2026-09-13 起新包已由 build/installer.nsh 根治，见下方根治条，此法用于旧包升级/兜底）。装到哪以注册表 InstallLocation 为准，勿信安装文件的 mtime（复制保留源文件时间，看安装目录 CreationTime）。**自动更新（electron-updater）的静默升级走的就是 `/S`**：updater 侧对安装失败有「打开已下载安装包手动装」的兜底分支，详见 [auto-update.md](auto-update.md)。
- **同版本覆盖安装边界（2026-09-13 实测，安装判定口径出自 `.tmp/install-rebuild-0.1.21-v2.ps1`，规范以本节正文为准）**：
  - `app.asar` 远早于 `app.asar.unpacked` 解包树拷完（解包树 ~18k 物理文件 + Defender 逐文件扫描是大头）。安装器还没退出时只验 asar 哈希就拉起应用，必崩 `ENOENT ... app.asar.unpacked\node_modules\i18next\index.js`——**完成判定必须等安装器进程退出 + 解包树文件数与 win-unpacked 一致（差 ≤6）且 30s 复数稳定**。
  - NSIS 产物天然缺 node-pty 的 6 个 arm64 专属文件（`third_party/conpty/*/win10-arm64/`、`prebuilds/win32-arm64/`），x64 机器不加载、无害；文件数比对按「源 -6 ≤ 装 ≤ 源」放行。
  - NSIS `SetOverwrite` 默认 ifnewer：dest mtime 比源新的文件会跳过覆盖，同版本重装后个别包文件 mtime 与源不一致属此现象（内容同版本时无实害）。
  - HKLM 残留在时 `/S` 会发 UAC 授权：consent 无人点就**无限期挂起**（外层安装器进程活着、零 CPU、零落盘，无窗口），重启机器前一直等。实测 `/currentuser` + `/D=D:\MetaAgent` 组合可完全绕开 UAC（`D:\MetaAgent` ACL 给 Authenticated Users Modify），`/D` 不被 per-user 默认目录覆盖、不会落到 `%LOCALAPPDATA%\Programs\MusterConsole`，安装 3 分钟内完成；卸载登记会写 HKCU（HKLM 残留条目仍在，两边 DisplayVersion 均为当前版本）。脚本见 `.tmp/install-planb.ps1`。
  - **残留触发提权已在产品层根治（2026-09-13）**：模板 `installer.nsi` install Section 对 `$hasPerMachineInstallation==1 && Silent` 硬编码 `UAC_RunElevated`（模板源码实锤，`/currentuser` 能绕开正因它清零该标志）。`build/installer.nsh`（yml `nsis.include` 引用）的 `customInit` 在 initMultiUser 之后镜像 `/currentuser` 的**完整语义**：无 `/allusers` 且检测到残留时，清零标志并 `setInstallModePerUser` 整体切回 per-user 模式——只清标志不够，initMultiUser 已按残留选定 per-machine 模式（INSTDIR=HKLM 残留路径、Shell 上下文=all），不切模式会以未提权 per-machine 上下文继续安装（HKLM 注册表/全用户快捷方式静默失败）却正常退出。切回后 HKCU 有记录则原位升级，无记录装 `%LOCALAPPDATA%\Programs\MusterConsole`；显式 `/allusers` 仍尊重原语义。已知边界：HKLM 单残留机走交互向导时模式页两侧文案失真（CurrentUser 侧显示「已存在安装()」、AllUsers 侧显示「全新安装」，因模式页读的是已翻转的标志）——不影响实际安装路径（Leave 按所选 radio + 注册表重设模式与 INSTDIR）。注意两点边界：**卸载器拦不到**——un.onInit 的 `initMultiUser` 内部（BUILD_UNINSTALLER 分支）就发 UAC+Quit，在 `customUnInit` 之前，自定义 include 无法干预（真 per-machine 安装的卸载本就需要提权，静默卸载无人点 UAC 仍会挂）；初版 nsh 只清标志未切模式，其「7 秒装完」实测恰逢测试机已有 HKCU 记录走了 per-user 分支，未覆盖 HKLM 单残留状态（2026-09-13 评审补全）。acid test 哈希判定在同内容覆盖时会秒匹配旧文件，必须等安装器进程退出后再拉应用。

顶栏命令、DomainRuntime 和扩展 MCP 共用 `out/main/extensions/sdk/extension-runtime-worker.mjs`。`electron.vite.config.ts` 生成入口，`asarUnpack` 将它落到 `app.asar.unpacked`。安装版用 `ELECTRON_RUN_AS_NODE` 从该真实路径启动 Worker。安装包冒烟测试使用实际产物发起 Worker 身份握手并确认退出，覆盖入口漏解包导致的启动失败。[扩展实例运行时](extension-runtime.md)

## 验证方法

### 配置层（改 `electron-builder.yml` / `scripts/before-pack.mjs` 必跑，已进 `npm test`）

- `node test/packaging-file-filters.mjs`：复刻 app-builder-lib 的 `minimatchAll`，断言排除/保留清单，并守住「平台专属 files 禁区」「顶层 files 保留正向模式」「beforePack 接线在位」「@esbuild 只删非目标平台」「Claude 平台 vendor 排除与 SDK 保留、Codex 依赖移除与原生 worker 解包」「国内镜像配置在位」。
- `npm run typecheck`：合入前语法/类型闸。Windows 下 `sessions.integrate` 后置闸门可能 `spawn EINVAL`（宿主起进程失败，不代表代码坏），需在主仓手动补跑一次。

完整 `electron-builder` 出包（约数十分钟，还要拉 winCodeSign）不在日常回归里跑；改裁剪配置后以本小节全绿为合入门槛，真机步骤按下节人工执行。

### 真机打包验收（人工执行）

1. **镜像已由 package.json `config` 内置（2026-09-20 起），正常无需设置**。npmmirror 故障需切回官方源时，须用优先级更高的 `NPM_CONFIG_*` 形式（直接设 `ELECTRON_MIRROR`/`ELECTRON_BUILDER_BINARIES_MIRROR` 会被内置 config 盖住、不生效；npm 会多打一条 Unknown env config 告警，无害）：
   `$env:NPM_CONFIG_ELECTRON_MIRROR='https://github.com/electron/electron/releases/download/'; $env:NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR='https://github.com/electron-userland/electron-builder-binaries/releases/download/'`
   （或临时改 package.json `config` 段两值——注意这会让守卫 `test/packaging-file-filters.mjs` 第 7 节转红，用后还原；`NPM_CONFIG_*` 方式不影响测试）
2. `npm run build:win`。`beforePack` 会真删非 win32-x64 的 `@esbuild` 目录，验完若还要在本树开发，补一次 `npm install`。
3. **体积抽查**：`release/Muster-Console-<version>-Setup.exe` 应在 170MB 量级（明显超 300MB 即裁剪失效或「平台专属 files」坑）。`app.asar` 应在 **20MB 量级**——偏大且 asar 里出现 `refs/`、`.dev-sandbox/`、`.tmp/` 就是那个坑。可用 `node .tmp/asar-inspect.mjs release/win-unpacked/resources/app.asar`。
4. **解包树抽查**（`release/win-unpacked/resources/app.asar.unpacked/node_modules`）：
   - 必须有：`i18next/index.js`、`@esbuild/win32-x64/esbuild.exe`、`@anthropic-ai/claude-agent-sdk`（JS）
   - 必须无：`@esbuild/darwin-*`、`@esbuild/linux-*`、`@anthropic-ai/claude-agent-sdk-win32-*`、`@openai/codex*`、成片的 `.map` / `.md` / `.d.ts`
5. **入口不误杀**：`node .tmp/verify-packaged-entries.mjs` 逐包核对 `main`/`module`/`exports`/`bin` 在解包树真实存在；对同一脚本传 `node_modules` 再跑一次做差分（源树本就缺的入口是既有现象：`@modelcontextprotocol/sdk` 的根导出、`@mariozechner/clipboard-linux-*-musl` 的 `.node`、`tree-sitter-wasms` 的 `bindings/node`）。`node .tmp/check-ts-conditions.mjs` 校验被排除的 `.ts` 没有挂在 Node 运行时解析条件（`import`/`require`/`default`/`node`）上。
6. **启动冒烟**：`MUSTER_SANDBOX=1` 跑 `release/win-unpacked/MusterConsole.exe`，看 `[boot]`/`[renderer load]`（缺模块会启动即崩）。沙箱落在 `release/win-unpacked/.dev-sandbox/`，验完删掉，否则污染文件数比对。
7. 把实测 Setup / 落盘 / 文件数回写上一节「体积基线」。

其余口径（完整性扫描、安装完成判定）见下。

### macOS 打包（2026-10-07 首次真实出包实测，arm64 宿主）

准备（新 clone 顺序执行）：

1. `npm install`（Electron 二进制 v42 起无 postinstall，首个 `require('electron')` 时惰性下载并继承 config 镜像，见「国内镜像」节；`npm install` 本身不下载二进制）。
2. `npm run rebuild`：node-pty 编到**宿主架构**的 Electron ABI（`build/Release` 只能放一个架构；另一架构 dmg 运行时由 `lib/utils.js` 回退到 `prebuilds/darwin-<arch>/` 的 N-API 产物，实测 Electron 43 可加载，prebuilds 里两个 darwin 架构都在、spawn-helper 执行位由 beforePack 补）。
3. `npm run build:mac` 一次生成双架构 dmg，产物为 `release/Muster-Console-<version>-{arm64,x64}.dmg`。「一键打包」也使用这个脚本。CLI 的 `--arm64`/`--x64` 与 yml 的 `mac.target.arch` 取并集。

已知边界（除上述并集行为外）：

- **node-pty helperPath 双重 unpack（已修，钩子补丁）**：node-pty 1.1.0 unixTerminal 在模块加载时 `helperPath.replace('app.asar', 'app.asar.unpacked')`，假设自己住在 asar 里；本仓 node_modules 整树 asarUnpack，node-pty 从 require 起就在真实 `app.asar.unpacked/` 路径上，被二次拼成 `app.asar.unpacked.unpacked/` → spawn-helper ENOENT → 打包版终端创建即 "posix_spawnp failed."（**dev 路径不含 app.asar 子串，永远复现不了**）。beforePack 把 replace 锚定到 `path.sep` 使其幂等；node-pty 升级后模式未命中会打 warn，需人工核对。Windows 的 conpty 不走 unixTerminal，不受影响。
- 本机 `build:mac` 使用 ad-hoc 签名封装完整的 `Muster Console.app`。macOS 可据此把辅助功能授权归到 `com.zhanghexie.muster.console`。仅有 Electron 链接器签名的旧包会使授权请求落到可执行文件路径，即使系统设置中的应用条目已开启也会报缺授权。可用 `codesign --verify --strict` 校验应用包，并用 `codesign -d --verbose=2` 核对标识。重新打包改变 ad-hoc 签名后，系统可能要求重新授权。[电脑操作状态与 macOS 授权](desktop-control.md#电脑操作状态与-macos-授权)
- 日常 CI 使用 ad-hoc 签名生成 macOS 验证包。正式发布通过 `main` 的 signed release Actions 检查 Windows 证书、macOS Developer ID 和 Apple 公证凭据，再强制签名并校验公证票据。缺少凭据时发布构建在打包前失败。
- 出包后 `npm install` 恢复被裁剪的非 darwin 平台目录。
- 验收口径：两个解包 app 里 `@esbuild`（嵌套 0.28.1 那份）必须是 x64+arm64 双架构；`node-pty/prebuilds/darwin-*/spawn-helper` 带执行位；ELECTRON_RUN_AS_NODE 下对解包 node_modules `require('node-pty')` 并 spawn `/bin/echo` 两架构都要通（x64 在 Rosetta 下测即可）。

- 完整性校验思路：lockfile 里 prod 可达包必须在 asar 头 ∪ app.asar.unpacked 中（非本平台 optional 包除外）；新增「疑似漏发」先查是否 createResolve/子进程解析的包。裸依赖扫描（不信任第三方包声明）：对可疑包扫描其 require()/动态导入，比对打包树。
- 安装完成判定（`.tmp/install-rebuild-0.1.21-v2.ps1` 口径）：安装器进程退出 → app.asar SHA256 与 win-unpacked 一致 → i18next/index.js 落盘 → 解包树文件数与源差 ≤6 且 30s 复数稳定 → 才拉起应用。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：electron-builder 三平台安装包（Win NSIS/mac dmg/linux AppImage·deb）+ Windows 包内分发外部 Agent CLI（NSIS 钩子维护用户级 PATH 与归属标记）。
- 为什么这样设计：traversal 收集器防默认 npm 收集 OOM；依赖归类合同（renderer-only→devDependencies 裁死重、main/子进程解析→dependencies）；整树 asarUnpack 防漏包（0.1.16 前手工闭包两度漏）；四条独立裁剪（扩展名/electronLanguages/beforePack 平台二进制/平台 vendor）；「平台专属 files 禁区」踩坑守卫；国内镜像内置 config 段；安装判定以注册表+落盘为准不信退出码。
- 发布签名由受保护分支 Actions 负责，PR 与本地保留无证书构建路径。beforePack 真删目录需 npm install 恢复；安装慢归因文件数优先于字节数（裁剪纪律）。
