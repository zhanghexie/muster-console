# 自动更新（electron-updater）

## 功能职责

Windows 安装版（NSIS）的自动更新：启动后延迟静默检查更新源 → 发现新版自动后台下载（blockmap 差量，通常远小于 200MB 全量；下载全程任务栏进度条实时可见）→ 完成后系统 toast 必弹 + 弹「立即重启？」+ 托盘菜单插入「重启并安装更新」→ 静默安装并自启。用户可无视弹窗继续用旧版：退出应用时会自动补装（`autoInstallOnAppQuit` 默认开）。自动安装失败（如 UAC 被拒）走「打开已下载安装包手动安装」兜底。macOS/Linux 不启用（mac 自动更新必须签名+公证，未配置）。

更新源为公开仓库 `zhanghexie/muster-console` 的 GitHub Releases。由此配置构建的安装包可匿名读取已发布的 Release。

## 关键文件与入口

| 文件 | 说明 |
|---|---|
| [electron-builder.yml](../../electron-builder.yml) `publish` 块 | 构建时将 GitHub 发布源写入安装包的 `resources/app-update.yml`。客户端启动时读取该配置。 |
| `package.json` `release:win` 脚本 | 出包 + 发布一体：`electron-builder --publish always` 自动上传三件套并建 tag/release |
| `src/main/updater/index.ts` | 更新服务：事件挂载、状态机、启动检查调度、安装与兜底 |
| `src/main/updater/surface.ts` | 全局可见面纯决策：任务栏进度值 / 通知条目文案 / 托盘菜单模板（`test/updater-surface.mjs` 守卫） |
| `src/main/ipc/updater.ts` | `updater:getState / updater:check / updater:install / updater:revealInstaller`（走统一 `handle()`，web 网关可见） |
| `src/shared/updater.ts` | `UpdaterStatus` 状态快照类型；`updater:status` 事件（登记于 `src/shared/ipcEvents.ts` 白名单） |
| `src/renderer/src/components/settings/AboutPane.tsx` | 设置 →「关于」页：版本号、检查更新、下载进度、重启安装、手动兜底入口 |
| `src/preload/index.ts` | `window.api.updater.*` 与 `app.version()` |

## 数据流

```
[构建期] electron-builder.yml publish 块 → resources/app-update.yml 烘进安装包
[发布期] GH_TOKEN=… npm run release:win → electron-builder 上传 Setup.exe/.blockmap/latest.yml
         到 GitHub Release（tag v<version>，releaseType: release 即直接发布）
[运行期] initUpdater（registerIpc 链内调用一次）
  ├─ 非 win32 或 dev（无 MUSTER_UPDATER_DEV=1）→ state='unsupported'，仅显示版本号
  └─ NsisUpdater 子类（暴露 protected installerPath 供兜底）挂事件：
       启动 +3min 静默检查（失败只记日志）→ checking
       update-available → autoDownload 自动下载（差量优先，失败回退全量）
         ├─ 系统 toast「发现新版本，正在后台下载」（updateKey=updater:progress；
         │  同版本已播报过「已就绪」则跳过——「跳过重启 → 再次检查」会重发本事件，
         │  不守卫会把通知倒回下载中文案且不再自愈）
         └─ download-progress → updater:status 节流广播（500ms）+ 任务栏进度条
              （下载进度不推通知——应用内通知面板已移除，toast 只在状态迁移时各弹
              一次）。首个真进度解除「已就绪」播报守卫（缓存命中秒发 downloaded 无
              进度事件，防打扰不受影响），同版本重下（撤回重发/缓存损坏）可再次走完
              下载中→已就绪；downloaded/error 后迟到的进度事件直接忽略，不倒转状态机
       update-downloaded → 同键通知收口「已就绪」+ 系统 toast 必弹
         ├─ 窗口可见：ui.confirm「立即重启？」→ 是 = installNow
         │    └─ installNow（X7-F03）：扩展任务运行中不硬撞 before-quit 确认门——
         │       toast「更新已暂缓，将在下次退出工作台时完成安装」后返回，
         │       退出时 autoInstallOnAppQuit 兜底；quit 被确认门取消（返回工作台）
         │       时 noteInstallDeferred 清 30s 安装失败窗残留并补同款 toast
         ├─ 托盘菜单插入「重启并安装更新 vX」（离开 downloaded 态自动移除）
         └─ 不操作则退出时静默安装
       error（安装触发失败，30s 窗口内）→ 保持 downloaded 态 + toast 指引手动安装
       error（下载途中）→ 通知条目同键收口成「下载失败」（无开始条目的检查失败不打扰）
```

通知条目归属「发现更新那一刻」的活动工区（`notifyWsId` 快照），全程固定：下载中切换工区不会分裂出第二条同键条目，面板可见性跟随归属工区；任务栏/托盘/toast/「关于」页不受切工区影响。

状态机（`UpdaterState`）：`unsupported / idle / checking / downloading / downloaded / error`；快照经 `updater:getState` 拉取、`updater:status` 推送，`AboutPane` 订阅镜像。

## 手动发布 Windows 安装包

1. 源码和 Releases 使用同一个公开仓库。[`zhanghexie/muster-console`](https://github.com/zhanghexie/muster-console)
2. 用 `npm version --no-git-tag-version` 更新版本号，将该版本提交推送到发布仓库。版本号以 `package.json` 为准。
3. `GH_TOKEN=<PAT> npm run release:win`（Electron zip 与 nsis·winCodeSign 镜像已由 package.json `config` 内置，2026-09-20 起；npmmirror 故障需切官方源时设 `NPM_CONFIG_ELECTRON_MIRROR` / `NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR` 覆盖——直接设 `ELECTRON_MIRROR` 会被内置值盖住，详见 [packaging.md](packaging.md)「国内镜像」）
   - `GH_TOKEN`：classic PAT 勾 `repo` scope，或 fine-grained PAT 对该仓库给 Contents: read+write；只在发布机环境变量里，绝不入库；
   - 发布机需能直连 github.com（electron-builder 上传走 GitHub API + uploads）；
   - `releaseType: release` = 传完直接可见；若改回默认 draft，需要去 GitHub 页面手动点 Publish，更新器看不到 draft。
   - **跨仓库首发 422 坑（2026-09-14 实测）**：electron-builder 建 Release 时把**本仓**的 commit SHA 当 `target_commitish` 传给发布仓库（该 SHA 在载体仓库不存在）；若彼时远端又没有对应 tag——载体仓库的 tag 不会自动产生，预建的 draft Release 也不生成 tag——POST /releases 即 422 "Published releases must have a valid tag"。此时 draft 可能已被发布流程转成正式 Release 且只传上一部分资产（如仅 blockmap），处于「更新源坏」状态。**修复：直接重跑本发布命令**——第二次运行能找到已存在的 Release 与 tag，补齐缺失资产（同名资产按名覆盖），全程幂等，无需手工清理；本地 `release/latest.yml` 若是旧构建残留（version 对不上），以上传后远端为准，勿手传。
4. 发布后运行 `curl -fsS https://api.github.com/repos/zhanghexie/muster-console/releases/latest`，检查 `tag_name` 以及 `assets` 中的 `latest.yml`、安装包和对应的 `.blockmap`。

## dev 联调（不打包）

1. 项目根建 `dev-app-update.yml`（与 app-update.yml 同构）：
   ```yaml
   provider: github
   owner: zhanghexie
   repo: muster-console
   ```
2. 以 `MUSTER_UPDATER_DEV=1` 启动 dev：updater 启用 + `forceDevUpdateConfig` 读上面这份配置，启动 2s 后即检查。
3. 端到端演练：远端发一个高于本地 `package.json` 版本的 Release → 观察 AboutPane 进度 → 下载完成弹窗 → 重启后安装（dev 态安装的是正式安装包，会把 dev 环境覆盖成安装版——建议在测试机做）。

## 迁移

- 更新源地址不写进应用代码：构建时由 `publish` 块烘成安装包内的 `app-update.yml`。将来换托管= 改 `publish` 块 + 换发布命令，应用代码零改动。
- **clean-break 分叉**：Muster 使用新的 `appId`、`productName` 和 `executableName`，旧 MetaAgent 安装包不原地升级，用户需要单独安装 Muster。新客户端不读取旧 feed。
- 安装包继续读取构建时写入的更新源。已安装的旧版本可通过旧源接收桥接版本，或手动安装指向新仓库的新版本。

## 已知边界

- **首次启用需人工过渡**：0.1.18 及更早的安装包内没有 app-update.yml（构建时无 publish 配置），永远无法自动更新——首个带更新能力的版本（0.1.19+）要靠用户最后手动安装一次，之后全自动。
- **客户端网络要求**：更新检查和下载需要访问 GitHub API 与 Release 资产。网络受限时，手动检查会在「关于」页显示错误。
- **静默升级 UAC 边界**（packaging.md 2026-09-08 实测）：HKLM 有 per-machine 残留记录时 `/S` 强制提权，UAC 被拒则装不上且外层无可靠退出码。updater 侧 30s 窗口内的安装 error 会转「手动安装」兜底提示（toast + AboutPane 的「打开安装包文件夹」）；若 error 晚于应用退出才发生，用户侧表现是「重启后仍是旧版」——重新检查更新即可，安装包仍在缓存。
- **draft Release 客户端不可见**：GitHubProvider 只读 published release，别用 draft 做灰度。
- 未配签名：electron-updater 未配置 `publisherName` 时跳过 Windows 签名校验，完整性靠 latest.yml 的 sha512；GitHub 不强制签名（与 GitLab 无关，代码签名是独立事项，见 packaging.md）。
- 中文 artifactName 上传 GitHub 时经 safeArtifactName 归一化；Muster 当前产物名为 `Muster-Console-<v>-Setup.exe`，`latest.yml` 里引用的正是实际归一化名，客户端按 url 直取。

## 验证方法

- 静态：`npm run typecheck`、`npm run build`（main/preload/renderer 三端）。
- 烘包验证：`build:win` 后看 `release/win-unpacked/resources/app-update.yml`，应为 `provider: github` + 正确 owner/repo。
- 发布首个正式 Release 后，按上述查询命令确认匿名访问可返回版本和三个发布资产。
- 状态机/IPC：dev 起 `MUSTER_UPDATER_DEV=1`（配 dev-app-update.yml）或直接看 AboutPane 的 unsupported 态与版本号显示。
- 端到端（建议在测试机）：安装 0.1.19 → GitHub 发更高版本 → 重启应用等静默检查 → 验证差量下载、弹窗、静默安装与重启后版本号；再手工构造 HKLM 残留验证 UAC 兜底分支。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：Windows 安装版 electron-updater 自动更新——GitHub Releases 托管、差量下载、后台静默+toast/托盘/关于页三出口、退出补装、失败手动兜底。
- 为什么这样设计：启动+3min 静默检查失败只记日志不打扰；状态机同键通知收口防「已就绪→下载中」倒转；通知条目归属发现更新那一刻的工区快照全程固定；安装 error 30s 窗口转「打开安装包手动装」兜底；更新源烘进 app-update.yml（换托管=改 publish 块零代码改动）；换源走桥接发布双发。
- 明确不做：mac/Linux 不启用（签名未配）；网络无法访问 GitHub 时更新静默失败（About 页可见错误）；draft Release 不做灰度；不承诺内网环境可用。

---
