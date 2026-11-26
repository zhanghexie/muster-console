# 五子棋扩展

源码与扩展级回归位于 [muster-extension-gomoku](https://github.com/zhanghexie/muster-extension-gomoku)。扩展目录为 `gomoku/`。

五子棋是全局扩展示例。面板使用 Canvas 绘制 15 路棋盘，DomainRuntime 保存棋局、难度、执棋方、提示和 AI 落子；面板只展示当前局面，AI 通过 Domain 查询按需读取，不接收人类的转动或落子历史注入。

## 入口与职责

| 文件 | 职责 |
| --- | --- |
| `gomoku/extension.json` | sidebar 清单、Domain 查询和命令权限 |
| `gomoku/domain.mjs` | 棋盘状态、胜负判定、AI 落子与状态事件 |
| `gomoku/ui/panel.html` | 面板结构和 SDK/Domain 入口 |
| `gomoku/ui/styles.css` | 面板视觉、深浅主题和窄布局 |
| `gomoku/ui/ui.mjs` | Canvas 绘制、鼠标落子、键盘快捷键、音效和状态刷新 |
| `gomoku/ui/logic.mjs` | 棋盘数据结构、胜负检查和三档落子策略 |

## 交互与数据流

面板启动后调用 `ma.agent.domain.snapshot()`，通过 `state.changed` 事件刷新。点击棋盘交叉点调用 `game.place`；新局、悔棋、提示、难度和执棋方分别使用对应的 Domain 命令。棋盘绘制在面板进程内完成，棋盘外的空白拖动不产生额外状态。

右侧显示当前回合、计时、步数、本地战绩、难度和声音开关。桌面宽度下棋盘与控制侧栏并排；窄面板改为棋盘在上、控制区在下，并保持完整的操作按钮和状态信息。

棋盘 CSS 依据面板可用宽高决定正方形尺寸，窄栏由棋盘可用宽度决定大小并纵向滚动。Canvas 观察自身的布局尺寸并同步绘图和命中几何，避免尺寸反馈使点击偏离交叉点。

## 验证

`test/e2e/extensions-gomoku-panel.spec.ts` 在真实 Windows Electron 中打开面板并点击中心交叉点，确认 Domain 写入导致步数变化、无渲染错误，同时保存面板截图。macOS/Linux 尚未进行真机验收。
