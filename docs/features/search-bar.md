# 统一搜索条（SearchBar）

左栏会话列表与 Git 仓库列表共用的过滤条，与会话查找浮条同款视觉：左放大镜、输入、命中计数、可选右侧操作。海拔走 `--bg-overlay`，圆角 `--radius-control`。会话查找的 ↑↓ / 范围 / 关闭见 [chat-find.md](chat-find.md)。

## 职责

- 统一过滤条外观与键盘：Esc 清空并失焦；清空按钮只清查询、保持焦点。
- 左栏：输入即过滤工作会话 / 终端（名称、胶囊文案、摘要；兼容 runtime / cwd / shell）。
- Git 仓库树：换皮为同款组件，过滤逻辑与 150ms 防抖、Esc 关闭、空查询失焦关闭保持原样。

## 关键文件

| 文件 | 职责 |
|---|---|
| `src/renderer/src/components/SearchBar.tsx` | 统一条：图标 / 输入 / 计数 / 清空；`variant=float` + `trailing` 给会话查找 |
| `src/shared/sessionListSearch.ts` | 左栏匹配纯函数 |
| `src/shared/gitRepoSearch.ts` | 仓库名/路径子串匹配（与换皮前一致） |
| `src/renderer/src/panels/LeftPanel.tsx` | 工作会话 / 终端标题行接入 |
| `src/renderer/src/panels/GitRepoSearchInput.tsx` | Git 仓库搜索条（150ms 防抖 + Esc 关闭） |
| `src/renderer/src/panels/gitpanel/GitPanelCore.tsx` | `displayedRepos` 仍先隐藏过滤再搜 |
| `src/renderer/src/styles/base.css` | `.search-bar*` 原子样式 |

## 交互

- **左栏**：点 ⌕ 展开搜索条（替换分组标题）；计数 `命中/可见总数`；Esc 清空并失焦后收起；无匹配显示「无匹配的工作会话 / 终端」。
- 左栏实用工具、会话和终端列表的标题、条目与空态禁止鼠标框选；搜索框及会话内联重命名仍可选字编辑。通用按钮、页签和菜单项标签同样禁止框选，不改变正文的默认选择行为。
- **Git**：点 ⌕ 展开；本地受控 + 150ms 防抖上抛（击键不重算树）；Esc 立即清查询并关闭；空查询失焦关闭；无匹配仍「无匹配仓库」。
- 悬浮/聚焦边框走 `--dur-micro` / `--ease-hover`，不自造时长。

## 测试

- `test/session-list-search.mjs` / `test/git-repo-search.mjs`：匹配纯函数
- `test/unit/search-bar.spec.tsx`：计数 / 清空 / Esc
- `test/unit/left-session-search.spec.tsx`：左栏过滤 / 计数 / 空态 / Esc
- `node test/selection-controls-visual.mjs`：生产左栏和工作区组件搭配模拟 IPC，在 Chromium 中真实拖动验证导航、控件禁选，以及正文、搜索和重命名可选；覆盖深浅主题与 780/390px。
- `test/unit/git-repo-search.spec.tsx`：仓库搜索防抖与 Esc 关闭

## 已知边界

- 当前文件内查找（Ctrl+F）与会话查找共用 `FindFloatBar`（居中浮条 + Aa 区分大小写，Esc 入 overlay 栈关闭）。跨文件搜索走命令面板「内容」档（Ctrl+Shift+F / 工具栏「所有文件中搜索」），不是这根浮条。
- 轨迹列头搜索、分支弹出层、AgentFloat 历史会话搜索（session-header-search）仍是旧 input。
- 左栏仍是点图标展开，不是常驻条（窄栏省高）。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D07.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：左栏会话列表与 Git 仓库列表共用的过滤条（点 ⌕ 展开、命中计数、Esc 清空失焦）：输入即过滤会话（名称/胶囊/摘要/cwd）或仓库（名称/路径子串）。
- 为什么这样设计：统一组件换皮复用（与会话查找浮条同款视觉、海拔 --bg-overlay）；Git 侧 150ms 防抖上抛（击键不重算树）、左栏即时过滤；清空按钮只清查询保持焦点、Esc 才失焦收起——两条退出路径语义分开。
- 明确不做：左栏不做成常驻条（窄栏省高）；当前文件查找（Ctrl+F）与会话查找走 FindFloatBar、跨文件走命令面板「内容」档——三个查找面显式分工不合并；轨迹列头/分支弹层/AgentFloat 历史搜索仍是旧 input（存量未收敛）。
- 歧义点：无真决策（三查找面分工明确；旧 input 收敛属 P3 打磨，不改变 review 判定）。
