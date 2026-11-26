# 系统托盘与关闭行为（tray）

## 功能职责

窗口的关闭按钮**不是退出**：点关闭（Windows 原生 titleBarOverlay 的 ✕ / macOS 红绿灯）只把主窗口隐藏到系统托盘；应用保持完整运行（终端会话、Agent、飞书桥、webAccess 网关全部继续）。真正的退出只有一个入口：**右键托盘图标 → 「退出 集序」**（英文界面为 “Quit Muster Console”）。

- 托盘左键单击 = 显示主窗口（最小化状态会先 restore）。
- 托盘右键菜单 = 「显示主窗口」/「退出 集序」；更新下载完成后动态插入**「重启并安装更新 vX」**（点击即静默安装+自启，见 auto-update.md），离开 downloaded 态自动移除。

## 关键文件与入口

| 文件 | 职责 |
| --- | --- |
| `src/main/tray.ts` | 创建 Tray 实例、右键菜单（含动态更新项 `setTrayUpdateItem`）、模块级保活（防 GC 回收图标消失） |
| `src/main/updater/surface.ts` | 菜单模板纯函数 `trayMenuTemplate`（可单测：test/updater-surface.mjs） |
| `src/main/index.ts` | `isQuitting` 标记 + `mainWindow.on('close')` 拦截、`showMainWindow()`、托盘创建时机 |

## 数据流 / 行为链

1. `app.whenReady` → 窗口创建后调用 `createTray({ showWindow: showMainWindow })`；托盘图标取 `build/icon.png`（回退 `icon.ico`，与 `electron-builder.yml` 的 `files` 一致）。macOS 菜单栏不自动缩放，darwin 上显式缩到 16pt 并补 32px @2x 表示（`test/mac-chrome.mjs` 守卫）；Windows Tray 自动缩放、ico 原生，沿用原图。
2. 用户点窗口关闭 → `close` 事件里 `isQuitting === false` → `preventDefault()` + `win.hide()`。渲染层/任务无感知。
3. 用户托盘右键「退出」→ `app.quit()` → `before-quit` 置 `isQuitting = true` → 之后的 `close` 放行 → 正常走 `before-quit` 清理链（flushPersist / closeAll / killAll 等）。
4. 其它既有退出路径不受影响：`app:quit` IPC（webAccess 侧已在 denylist 拦截）、`app:relaunch`（`app.exit(0)`，不经过 close 拦截）。
5. 动态更新项：updater 状态迁移 → `setStatus` 单漏斗 → `syncTrayItem` → `setTrayUpdateItem(item | null)` → `rebuildMenu()` 整体重建右键菜单。菜单项经 updater/surface.ts 的 `trayMenuTemplate` 纯函数生成（有更新项插在「显示主窗口」与分隔线之间）；`setTrayUpdateItem` 先于 `createTray` 到达时先存状态、创建时一次性带上。语言切换经 `subscribeLocale` 触发重建，菜单文案即时生效。

## 已知边界

- `devServerShutdown.ts` 的 `window-all-closed → app.quit()` 在本机制下基本不会触发（窗口只在退出时才真正关闭）；开发态退出走托盘菜单或终端 Ctrl+C。
- 托盘左键在 macOS 上因挂了 context menu 只会弹出菜单（Electron 平台行为），显示主窗口走菜单项或 Dock。
- 托盘左键在 **Linux GNOME**（AppIndicator 后端）下**不派发** `click` 事件（Electron 已知平台行为，仅右键菜单可用）——左键显示主窗口在该环境失效，须用右键菜单「显示主窗口」。KDE 及部分 X11 桌面不受影响；GNOME 路径未真机验证（2026-10-25 审查登记）。
- 找不到图标文件时托盘不创建并打 `[tray] app icon not found` 错误日志；此时窗口关闭即永久隐藏，只能任务管理器结束进程（正常打包/dev 均有图标，不会命中）。
- 主进程文案用 `t()`：`显示主窗口` / `` t(`退出 ${PRODUCT_NAME_ZH}`) ``（展示名取 src/shared/productIdentity.ts 的 `PRODUCT_NAME_ZH` =「集序」，英文词条回落 `PRODUCT_NAME` = Muster Console；身份名不允许中英混排）/ `重启并安装更新 v{{version}}`（`test/i18n-coverage.mjs` 对账；en 断言见 `test/updater-surface.mjs`）。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D07.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：关窗≠退出的托盘驻留——窗口 ✕/红绿灯只隐藏（终端会话、Agent、飞书桥、webAccess 全继续）；真正退出唯一入口是托盘右键「退出 集序」；更新下载完成态动态插「重启并安装更新」。
- 为什么这样设计：close 事件 isQuitting 门拦截+hide（渲染层/任务无感知），退出走 before-quit 完整清理链；托盘左键=显示主窗口；菜单模板纯函数可单测、setStatus 单漏斗同步动态项、语言切换即时重建；macOS 显式缩 16pt+@2x（平台差异各按其法处理）。
- 明确不做：不做关窗行为偏好设置；托盘图标缺失不创建并打错误日志（此时关窗=永久隐藏，只能任务管理器——正常打包不命中）；macOS 左键弹菜单是 Electron 平台行为不改；app:relaunch 走 app.exit(0) 不经 close 拦截。
- 歧义点：关窗=强制驻托盘、无任何用户偏好（代码证实无 minimizeToTray 类配置）——A=长期强制（多会话长任务下误退成本高，「退出必须显式」是产品语义；review 把后台驻留当预期，只关注首次发现性提示）／B=设置页加关窗行为偏好（驻托盘/退出可选）。推荐 A——会话持续运行是核心场景，B 增配置面且易误选退出丢会话；若用户自己曾被「关不掉」困扰则升 B。
