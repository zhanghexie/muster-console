# 产品身份与命名（product-identity）

## 功能职责

一处定义 Muster / 集序 的全部身份派生：app 名、UA、安装器与包名、存储目录、实例注册表、CLI 名、脚手架标记、反馈环境行。唯一真源 `src/shared/productIdentity.ts`，禁止在任何业务代码里另写产品名字面量或拼接「新旧名字」。

## 命名分工（用户 2026-11-10 定规矩）

| 用途 | 常量 | 值 | 允许出现的位置 |
|---|---|---|---|
| 身份名（技术标识） | `PRODUCT_NAME` | `Muster Console`（纯 ASCII） | `app.setName`/UA、`electron-builder.yml` 的 `productName`、日志、CLI 帮助、脚手架标记、反馈环境行、演示工作区英文文案 |
| 展示名（中文） | `PRODUCT_NAME_ZH` | `集序` | 只经 `t()` 词条进入界面：窗口标题、启动遮罩、关于页、托盘提示与「退出 集序」、单实例提示 |
| 英文词条 | — | `Muster Console` | `locales/en.ts` 把 `集序` / `集序 正在启动` / `集序 已在运行` / `退出 集序` 译成对应英文 |

**禁止**再造 `Muster Console · 集序` 这类中英混排名：它既进不了技术标识（见下节事故），在界面上也是两种语言挤一个名字。

## 为什么不能把中文名塞进身份名（2026-11-10 事故）

产品名曾被写成 `Muster Console · 集序`。Electron 用 app 名拼默认 UA（去空格）→ `MusterConsole·集序/0.1.34 …`；Electron 43.x 的 `protocol.handle` 要把请求头转成 WebIDL `Headers`，非 Latin-1 字符（≥U+0100）在 ByteString 转换处抛 `TypeError: … character at index N has a value of 65533 (U+FFFD)`。异常发生在 handler **之前**，主进程一行日志都不打，渲染层只有 `net::ERR_UNEXPECTED`：

- `muster-ws://`、`muster-root://`、`muster-ext://`、`muster-app://` 四类协议**同时失效**；
- 表现：图片/音视频/PDF/HTML 预览全部「无法预览」，扩展面板白屏，而文件确实存在、`fs.stat` 还能读出大小（所以卡片上大小是对的）；
- 定位手法与证据见 [file-preview.md](file-preview.md)「自定义协议的硬前提」节。

因此 `src/main/index.ts` 启动期做一次 `app.userAgentFallback = asciiUserAgent(app.userAgentFallback)`：身份名已是 ASCII 时是恒等变换，未来任何非 ASCII 品牌词都会被这层挡住。守卫 `test/user-agent-ascii.mjs`。

## 关键文件与入口

```
src/shared/productIdentity.ts   身份/展示名常量 + asciiUserAgent（UA 兜底清洗）
src/main/index.ts               启动期应用 UA 清洗；窗口标题与单实例提示用展示名
src/main/productStorage.ts      app.setName(PRODUCT_NAME) + userData 根（PRODUCT_STORAGE_DIR）
src/main/tray.ts / updater/surface.ts   托盘提示与「退出 集序」菜单
src/renderer/src/components/{BrandLoader,AppLogo}.tsx · settings/AboutPane.tsx  启动/关于的品牌展示
src/renderer/index.html · desktop-indicator.html   静态期标题与启动遮罩（无 i18n，直接写「集序」）
electron-builder.yml            productName: Muster Console（安装目录/快捷方式/包内 app 名）
```

## 边界与注意

- **安装器改名有升级代价**：`productName` 从 `Muster Console · 集序` 改为 `Muster Console` 后，NSIS 默认安装目录与 macOS/Linux 包名随之变化，已装机器升级可能并存一份旧目录/旧快捷方式，需要手动清理（本轮由用户拍板改名，未做安装期迁移脚本）。
- 存储身份**不跟显示名走**：userData 仍是 `%APPDATA%/muster-console`（`PRODUCT_STORAGE_DIR`），改名不会孤立已有配置与会话。
- 历史文档（`docs/plans/`、`docs/audits/`）里的旧名是当时记录，不回改。
