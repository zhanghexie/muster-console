# 命令面板（Command Palette）

> 状态：实现说明，2026-10-01：文件/内容查询已贯穿多源根身份。普通多根创建入口仍待后续阶段开放。
> 代码主入口：`src/shared/commandPalette.ts`、`src/renderer/src/components/QuickOpen.tsx`、`src/renderer/src/App.tsx`

## 功能职责

Ctrl+P 打开分类万能搜（页签切换，不是多种互斥浮层）：

| 页签 | 内容 |
|------|------|
| 全部 | 空查询：工作区 + 会话。有字才追加命令、设置项和文件（默认不搜文件、不搜正文） |
| 会话 | 跨工作区会话（含归档） |
| 工作区 | 已打开工作区 |
| 文件 | 当前工作区全部登记源根的**路径**（每根模糊排序后交错取 40 条） |
| 内容 | 当前工作区登记源根的文件正文（ripgrep，`fs.searchFiles`）；空查询不搜 |
| 命令 | 快捷键目录 |
| 设置 | 设置页、分组、字段（含主题色盘项）；空查询列出目录 |

- **Ctrl+P**（`palette.goto`，`notTyping`）：打开并停在「全部」。
- **Ctrl+Shift+P**（`palette.commands`，`always`）：打开并停在「命令」。
- **Ctrl+Shift+F**（`files.findInFiles`，`always`）：打开并停在「内容」。文案是「所有文件中搜索」（2026-10-07 报单③由「搜索所有文件」改），不是当前文件查找（那是 Ctrl+F 浮条）。
- **Files 工具栏 / `files.quickOpen`**：打开并停在「文件」。
- 行首 `>`：强制「命令」档；Tab 切走其它档时会去掉 `>`。
- **Tab / Shift+Tab** 循环页签。底栏：↑↓ 选择、Enter 打开、Tab / Shift+Tab 切换分类。路径/标题命中字蓝色高亮；内容预览命中 yellow soft。
- 「内容」档底栏有 Aa 区分大小写。点击命中 → `requestOpenWorkspaceFile`（带 FileRef/行号）。多根结果显示 `根名/相对路径`，同名文件分别导航到自己的源根；文件行 title 保留完整来源路径。
- 「建议」：全部或会话档显示「新建任务」（有查询时标签带「query」，回车仍只打开新建任务，不预填名称）。
- 文件/正文查询在结果返回前显示与工作区胶片统一的 shimmer 行骨架，并保留可读的「枚举文件中…」/「搜索中…」状态。
- 搜索面板以实底从窗口顶缘滑入和滑出，独立的磨砂层在后面淡入淡出。关闭时立即释放指针、焦点和 Esc。流程沿用 [动画系统](animation-system.md) 的 `mp-panel-fly` 和 `mp-scrim`。

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/shared/commandPalette.ts` | 页签、命中、高亮切片、回车分流、正文预览切片 |
| `src/renderer/src/components/QuickOpen.tsx` | 浮层 UI、来源标签、公平候选与 Ref 导航 |
| `src/renderer/src/components/useQuickOpenQueries.ts` | 根版本缓存、在途共享与消费者计数、关闭/切区取消、内容档 280ms 防抖与晚到结果守卫 |
| `src/renderer/src/store.tsx` | `openCommandPalette(mode)` → 初始页签 |
| `src/renderer/src/keybindings/KeybindingHost.tsx` | handler 灰色 / 执行 |
| `src/main/workspaceQueries.ts`、`workspaceRg.ts` | 多根预算/并发/真实路径守卫与流式 `@vscode/ripgrep` |

独立 `FindInFiles` 面板已撤：跨文件搜索只走本浮层「内容」档。当前文件查找仍是 `FindFloatBar`（见 [search-bar.md](search-bar.md) / [chat-find.md](chat-find.md)）。

## 数据流

```
Ctrl+P / Ctrl+Shift+P / Ctrl+Shift+F / Files 工具栏
        │
        ▼
openCommandPalette(goto|command|file|content) → 全部 | 命令 | 文件 | 内容
        │
        ▼
页签 + 查询
        ├─ 工作区 → switchWorkspace
        ├─ 会话 → 必要时先切工作区，再 sessions.select
        ├─ 文件 → fs.listFiles → requestOpenWorkspaceFile({ path, fileRef })（仅需要时枚举）
        ├─ 内容 → fs.searchFiles → requestOpenWorkspaceFile({ path, fileRef, line })（防抖 280ms）
        ├─ 设置项 → 打开设置弹窗并切到对应页（可滚到字段）
        └─ 命令 → runAction（切模式 id 仍走同一层换页签）
```

## 边界

- 全部档空查询不枚举文件；切到文件档或全部档打字才 `fs.listFiles`。同工作区/根版本的在途列表请求共享，最后一个消费者退出才取消；同一浮层内切分类复用已加载版本，关闭重开先显示模块缓存并重新枚举。取消后晚到或根版本不匹配的结果不得进入模块缓存；切区再回来若只有预热缓存仍须重查。关闭、退场、切区或根版本变化取消旧查询，A→B→A 也不接受首个 A 的晚到结果。旧裸路径接口在多根工作区仍拒绝歧义。
- 根级失败/超时保留其他根结果并显示来源，截断提示缩小范围；总体预算、固定根份额及共享 2 个 rg 的边界见 [文件面板](files-panel.md)。失败后关闭重开可重试；不把已截断列表称为全量结果。
- 方向键与悬停按候选身份保存选择；同一查询内新增会话或结果重排不把已选文件换到另一项。查询、分类、工作区、根版本或打开序号变化时同步复位；原候选消失时选首项。复位不依赖延后的 effect，避免覆盖刚按下的方向键。
- **内容档不混进「全部」**：正文搜索贵，且会和路径命中抢位置。要从任意页搜正文：Ctrl+Shift+F 或 Tab 到「内容」。
- 无 `@` `#` `:`、无 MRU。建议行标签可带当前查询，回车仍只打开新建任务，不预填名称。
- 会话在已关闭工作区：switchWorkspace 失败则提示、不 select。
- 上次查询 / 分类不持久化（2026-09-20 拍板：瞬态搜索；见 [ui-state-persistence.md](ui-state-persistence.md) §4）。每次打开空白。
- 内容搜索字面量子串，不支持正则（与当前文件查找一致）。上限 200 条。

## 验证

`quick-open-content.spec.tsx` 与 `quick-open-roots.spec.tsx` 覆盖空查询、防抖、键盘导航/行号、同名来源、异步新增会话后保留所选文件、查询往返复位、部分失败/截断、根版本变化、A→B→A 的晚到结果及已加载缓存恢复、共享请求最后消费者取消；`quick-open-roots.spec.tsx` 另守住 `mp-panel-fly` 与磨砂遮罩骨架。查询后端回归见文件面板文档。独立 Electron E2E 通过文件工具栏实际打开文件/内容搜索，以原生方向键和 Enter 打开第二根文件，验证文本与磁盘隔离。Chromium 生产组件夹具的深浅主题与 390px 截图位于 `.tmp/ui-captures/quick-open-motion/`，已逐张查看；真实 Electron 截图本轮因已有同 userData 实例占用单实例锁未完成。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D07.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：Ctrl+P 分类万能搜（全部/会话/工作区/文件/内容/命令/设置七页签单浮层）：跳转、执行命令、改设置、多根文件与 ripgrep 正文搜索；Ctrl+Shift+F 即「内容」档。
- 为什么这样设计：「全部」档空查询只给工作区+会话（默认不搜文件/正文——正文贵且抢位置，要搜走专用档）；多根结果带根名消歧义、同名文件各回各根；方向键按候选身份保存选择（结果重排不换已选项）；根级失败保留其他根结果并标注来源、不把截断当全量；在途请求按根版本共享+最后消费者取消。
- 明确不做：无 @ # : 语法、无 MRU、内容档不混进「全部」、不支持正则（与当前文件查找一致）；上次查询/分类不持久化（2026-09-20 拍板瞬态搜索）；会话在已关闭工作区切区失败只提示不 select。
- 歧义点：无真决策（内容档隔离、瞬态、无正则均为明文取舍且有修因报单支撑）。
