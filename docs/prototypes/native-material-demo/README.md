# 原生侧栏材质小样

独立 Electron 窗口，仅验证最左侧侧栏的原生材质观感。复用工作台实际主题变量、左侧列表样式和图标，内容全部是示例，不读取会话或工作台本地存储。用户选定 Mica 后，正式工作台已接入 Windows Mica 与 macOS Vibrancy，见 [窗口材质与框色](../../features/frame-backdrop.md)；本小样继续独立保留，供材质对比。

从仓库根目录运行：

```powershell
node scripts/native-material-demo.mjs
```

窗口顶部可切换 Acrylic / Mica / 实色、深色 / 浅色，以及侧栏的中性叠层浓度。浓度调整只改变叠层透明度，不改变系统模糊半径。默认 12%。勾选「对照背景」时，小样后面放置一个独立彩色参考窗口；关闭后可观察真实桌面及其他窗口。可拖动标题区观察背景变化；关闭小样会一起关闭参考窗口。

## 原生路径与边界

- Windows 11 22H2（build 22621）及以上：调用 `BrowserWindow.setBackgroundMaterial('acrylic'|'mica')`。
- macOS：Acrylic 选项映射为原生 `setVibrancy('sidebar')`，状态文案会标明 Sidebar Vibrancy；Mica 禁用。小样本身未单独实机验证；同一映射已进入正式工作台并于 2026-10-09 在 mac 实机验收（见 frame-backdrop.md）。
- Linux、旧 Windows 或无原生方法的运行时：仅启用实色。没有声称跨平台外观一致。
- 窗口网页根背景透明；侧栏只有中性透明叠层，中间与右侧 DOM 使用不透明主题底。没有 CSS filter / backdrop-filter、壁纸截屏回填或逐帧采样；未设置完全透明窗口 `transparent: true`。
- 系统透明设置、电源策略可能将材质降级为实色。UI 显示请求的材质，不声称读取到系统最终合成策略。
- 使用仓库本地 Electron，不下载依赖、不启动正式工作台、不更新其配置。用户数据和生成产物仅在 `.tmp/native-material-demo/`。

## 文件与验证

`main.cjs` / `preload.cjs` 处理原生窗口与限定 IPC；`policy.cjs` 校验平台和输入；`App.tsx` / `styles.css` 是原型界面；`reference.html` 是独立参考窗口。构建入口为 `scripts/native-material-demo.mjs`，仅构建可加 `--build-only`。

```powershell
node test/native-material-policy.mjs
npx vitest run test/unit/native-material-prototype.spec.tsx
node scripts/native-material-demo.mjs --build-only
npx playwright test test/e2e/native-material-prototype.spec.ts --workers=1 --retries=0
```

E2E 通过真实 preload 桥切换材质、主题和参考窗口，检查透明根背景、无 CSS 模糊、窄窗口无溢出。截图使用 `desktopCapturer` 捕获实际桌面合成结果后只裁出小样窗口；普通 `webContents.capturePage()` 无法证明原生背景效果。证据位于 `.tmp/native-material-demo/captures/`，包括 Acrylic 深浅、Mica 深色、实色深色和 780px 浅色窗口，颜色采样在 `observations.json`。

2026-10-08 本机验证环境：Windows 11 build 26200，Electron 43.7.0。已查看上述五张真实桌面截图；Acrylic 侧栏随参考背景呈现蓝/紫变化，而中右工作面采样保持相同实色。未测安装版、macOS/Linux 原生外观、帧率或功耗；正式接入的验证入口与证据单独记录在功能文档中。
