# UI 截图采集

## 职责

`npm run capture:ui` 启动当前源码的 Electron 开发版，以 `MUSTER_NO_SANDBOX=1` 使用真实 userData，通过本机 CDP 连接主窗口，依次拍摄主要 UI 页面。脚本结束后关闭自己启动的进程树。默认产物放在 Git 忽略的 `.tmp/ui-captures/<时间戳>/`，其中 `index.html` 是缩略图索引，`manifest.json` 记录截图、遗漏入口与启动诊断。

## 关键文件与入口

- `scripts/capture-ui.mjs`：启动、连接、导航、截图和生成索引。
- `scripts/dev-no-sandbox.mjs`：现有非沙盒启动入口；采集脚本沿用它。
- `src/renderer/src/App.tsx`：工作页、虚拟屏、全局看板、命令面板、设置入口。
- `src/renderer/src/panels/LeftPanel.tsx`：实用功能与扩展面板入口。
- `src/renderer/src/panels/SideToolsPanel.tsx`：文件、Git、浏览器页。
- `src/renderer/src/components/settings/SettingsModal.tsx`：设置导航；脚本动态遍历现有页签。
- `src/renderer/src/components/MemoryPanel.tsx`：记忆中心导航；脚本动态遍历现有页签。

## 采集范围与运行方式

默认拍当前工作页、左栏折叠闭合与划开态、左栏实用功能（包括已安装扩展面板）、记忆中心各页、文件/Git/浏览器、全局看板状态与自由视图、命令面板、调度对话和设置各页。文件树根目录若有对应文件，再补拍 Markdown 阅读、普通文本只读 CM 和代码编辑器三态（缺样本即跳过），用于核对 L1 平面阅读与 L0 代码画布。左栏速览截图先从检测带外进入把手，拍完先移开输入焦点再用 Escape 收回；原有展开偏好随后恢复。单个入口失败时继续采集，并在清单中写明错误。截图取当前可见窗口区域；长滚动页、菜单与确认框的每种状态、每个用户会话内容不逐一展开。内置浏览器为页面内 `<webview>`（2026-10-08 起），网页内容随主渲染页一同截到。

```powershell
npm run capture:ui
npm run capture:ui -- --out E:\ui-shots --width 1600 --height 1000
```

默认尺寸为 1440×900。脚本临时选用空闲的 Vite 与 CDP 端口，避免占用常规开发端口 5188；连接后核验 `sandbox.getInfo().enabled === false`，不满足就停止采集。截图包含真实会话和设置内容，分享前需自行查看。导航会触发应用正常的页签/布局持久化；脚本尽量恢复采集前的可见布局。

## 已知边界

- 同时运行另一个真实数据实例时，飞书卡片事件只能有一个消费者，截图实例可能报重复订阅；该诊断写进索引与 manifest，但不影响页面截图。
- 快捷键由用户改绑后，命令面板和虚拟屏的默认快捷键可能失效；脚本会在遗漏入口清单里报告。

## 局部组件验证与技能

单个控件或交互的修改可使用项目技能 [ui-verification](../../.agents/skills/ui-verification/SKILL.md)：先选择受影响回归测试，再用生产组件 + Chromium 的隔离夹具复现与截图，并实际打开图片检查。技能附有可替换 TSX 夹具与动作模块的截图脚本，输出 PNG、字体/几何/页面错误清单及索引。它不启动真实数据实例，不证明主进程 IPC 或内置浏览器 `<webview>` 链路；这些链路仍使用聚焦的 Electron 验证。截图脚本生成产物后标记视觉检查待完成，避免将生成成功等同于视觉验收。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：npm run capture:ui 全 UI 页面截图索引（真实 userData+CDP，自动遍历设置/记忆页签）+ ui-verification 技能的组件级隔离夹具截图，供视觉自查与改动留证。
- 为什么这样设计：连接后核验非沙盒态防误采；单入口失败继续采集并登记错误；产物落 Git 忽略的 .tmp；「生成成功≠视觉验收」——产物标记待检、必须实际打开图片；导航会触发正常持久化、尽量恢复采集前布局。
- 明确不做：长滚动页/菜单每种状态/用户会话内容不逐一展开；组件夹具不证明 IPC 或 webview 链路（归聚焦 Electron 验证）。
- 歧义点：无真决策。
