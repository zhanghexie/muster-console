# 扩展内置图标

扩展 current 的 `icon` 和 `surface.icon` 支持 `builtin-extension:<id>` 形式的稳定内置 ID。宿主把 ID 当作清单数据保存，渲染层再映射到应用包中的透明 SVG，因此全局扩展在不同工作区、Windows、macOS 和 Linux 上都使用同一套资源，不保存绝对路径或打包后 URL。

当前目录包含 130 个手绘单色 SVG 图标，覆盖开发工具、办公效率、金融消费、出行生活、健康教育、媒体社交、安全网络和家庭服务等应用商店常见类型，以及两个内置样例的品牌图标（`daily-report`、`gomoku`，与样例面板 header 的自绘形状同源，面板内外同形）。目录、显示名称和默认值以 `src/shared/extensionIcons.ts` 为准；旧版内置 ID 会通过兼容别名映射到新 SVG，未知的内置 ID 仍按清单校验失败，旧的 emoji 或短字仍按兼容文本显示。

资源在 `src/renderer/src/assets/extensions/`，由 `src/renderer/src/extensionIcons.tsx` 通过 Vite asset glob 加载。`ExtensionIcon` 在 CSS `url()` 中用带引号的字符串引用 SVG，兼容开发时的资源路径和生产构建内联的 SVG data URL。单色 SVG 作为蒙版，颜色取容器前景色，尺寸沿用各入口传入的值。扩展管理页、扩展面板状态栏、全局目录、扩展导航树和溢出菜单共用 `ExtensionIcon`。导航快照从当前 manifest/catalog 重新投影 icon ID，catalog 同步保存该 ID，旧 catalog 缺少该字段时按默认图标回退。

设计来源和可复现裁切在 [原型资料](../prototypes/extension-icons/README.md) 与 `scripts/build-extension-icons.py`。总图只作设计来源，不参与运行时加载。

跨平台共用清单 ID、静态资源和解析逻辑。`test/e2e/web-extension-panel.spec.ts` 覆盖生产构建中工作日报侧栏和面板状态栏的图标蒙版。已在 macOS 上通过隔离 Electron 宿主和 Chromium 验证，并查看深色常规宽度和浅色窄窗口截图。Windows 和 Linux 视觉验收待实测。
