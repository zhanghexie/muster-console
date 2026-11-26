# 会话内文本搜索（Ctrl+F）

调度面板与 GUI Worker 会话共用的查找：居中悬浮条搜当前/全部会话消息正文，匹配高亮并滚动定位。

## 职责

- `Ctrl+F` 按**虚拟屏当前页**分流：工作页（会话+终端）→ 会话查找；Git/文件页 → 当前文件查找。分屏时读取当前已提交的逻辑聚焦槽，正文点击不获取DOM焦点也能路由；旧格查找输入框残留activeElement不覆盖新格焦点。调度面和文件编辑器仍按所属焦点分流。Composer / 终端聚焦不劫持。
- 默认搜当前会话；范围钮切到全部会话后出分组命中列表，点击或 ↑↓ 跳到该会话该消息。
- GUI 会话悬停顶栏的查找按钮直接打开所属 session 的当前会话查找，保留查询词并递增聚焦标记；分屏时先聚焦该槽，不依赖全局焦点猜测归属。终端和工具顶栏不显示该按钮。实现接线在 `panels/CenterPanel.tsx`。
- 只匹配 user/assistant 的 **text part**（无 parts 时回落 `content`），忽略 thinking / 工具卡 / 宿主通栏 / 本地回显；大小写不敏感。
- 浮条定位在所属会话内，宽度取该会话可用宽度并留左右12px，内部SearchBar覆盖全局viewport宽度/360px最小宽度；拖动分隔线时由CSS直接随容器变化，不测量或跨格portal。中央GUI会话的浮条在悬停顶栏高度下方额外留8px，调度/文件沿用原定位。分隔条不是把浮层切开：旧版内部浮条溢出父定位层后跨过了独立分屏骨架层；修复约束浮条边界，无需抬高全局z-index。
- 浮层进出场走 `usePresence` + `mp-pop` token，禁止自造时长/keyframes。

## 关键文件

| 文件 | 职责 |
|---|---|
| `src/shared/chatSearch.ts` | 可检索正文 / 命中 / 分组纯函数 |
| `src/main/chatHistorySearch.ts`、`src/main/ipc/chatSearch.ts` | 120 条范围扫描、snippet 结果、按调用者取消与域退出回收 |
| `src/renderer/src/chatSurface/ChatFindBar.tsx` | 居中浮条 + 全部会话结果列表 |
| `src/renderer/src/chatSurface/useChatFind.ts` | 开合/查询/范围/跨会话跳转 |
| `src/renderer/src/chatSurface/chatFindRegistry.ts` | 多表面归属、调度面板打开缝 |
| `src/renderer/src/chatSurface/chatFindHighlight.ts` | 渲染后包 `<mark>` |
| `src/renderer/src/components/SearchBar.tsx` | 统一搜索条（inline / float） |
| `src/renderer/src/components/FindFloatBar.tsx` | 居中浮条共用壳（会话 + 文件内查找） |
| `src/renderer/src/App.tsx` | Ctrl+F读取分屏当前逻辑槽及实际引用，传给目标解析器 |
| `src/renderer/src/styles/agent-chat.css`、`styles/split.css` | 浮条宽度、顶栏避让、结果列表样式与行内高亮隔离 |
| `src/renderer/src/keybindings/findSurface.ts` | 虚拟屏激活页 → Ctrl+F 默认面 |
| `src/shared/keybindings.ts` | `chat.find`（when=`chatFind`，默认 Ctrl+F） |

## 交互

- 浮条：🔍 + 输入 + `n/N` + ↑上一个 + ↓下一个 + 范围（多层图标，按下=全部）+ ×。
- `Enter` / `Shift+Enter` 下一个 / 上一个（环形）；`Esc` 关闭（浮条入 overlay 栈，焦点不在输入框也能关）。
- 正文mark只用行内背景强调；结果列表的flex/整行宽度样式限定在.chat-find-results内，不能污染同名mark.chat-find-hit。搜索和清除不改变消息气泡矩形、正文文本和既有换行。
- 重复 `Ctrl+F` 已开时把焦点拉回输入框并全选。
- 命中在折叠回合里：该条 `forceFoldOpen`，露出正文再高亮。
- 仅在查找打开且该表面可交互时搜索：已完整加载的当前会话即时 `useMemo`；稀疏当前会话与全部会话通过 `chat:search` / `agentSession:search` 防抖查询主进程范围索引。关闭或隐藏保留共享查询词与活动身份，停止正文扫描/新历史请求并使在途结果失效；重新启用时按最新消息重算。

## 全部会话模式（设计决策）

- **范围**：当前工作区未归档的 GUI 会话 + 当前工作区调度对话（`chat:search`）。不扫调度历史 Pi 文件（打开每个文件成本高，留给后续）。
- **列表**：浮条下方 `mp-pop` 分组（会话名 → 角色 + snippet）。当前会话命中排在最前。
- **跳转**：GUI 命中 `jumpToSession`；调度命中 `openDispatchChat`（AgentFloat `ensureChatOpen`）。查找开合/查询/活动下标是模块共享态，切会话不丢。
- **归属**：同时开着调度浮窗与 GUI 时，焦点在谁搜谁；无焦点优先 GUI。

## 测试

- `test/chat-search.mjs`：text part / host / thinking / 大小写 / 分组
- `test/unit/chat-find-bar.spec.tsx`：开合、Ctrl+F 劫持、计数导航、范围列表、mark 高亮、Esc 关浮条（含下层 overlay / IME）
- `test/chat-find-split-visual.mjs`：生产CenterPanel/查找控制器/浮条/高亮/CSS，真实Ctrl+F和顶栏图标、两/三分屏、分隔线改宽、顶栏避让及mark行内不重排，深浅主题；仅IPC与消息叶内容为替身。
- `test/e2e/chat-find-split.spec.ts`：当前源码构建的隔离Electron，实际App快捷键、第二/第一格普通文本点击路由、宽度跟随和顶栏图标，深浅主题。
- `test/unit/node-main/chat-history-search*.spec.ts`：有界页扫描、snippet 上限、取消、调用者隔离与域退出。
- `test/e2e/chat-sparse-history.spec.ts`：真实 Electron 万条历史、搜索未加载目标、高亮/回填/回尾/重启。
- `test/unit/chat-find-idle.spec.tsx`：关闭/隐藏不扫描正文或拉历史，重新启用恢复，迟到结果不回填。

## 已知边界

- Markdown 渲染后 DOM 文本与源 text part 可能不完全对齐（加粗/链接拆节点），活动 mark 按该消息内 DOM 第 N 个命中，偶发偏差。
- 每次查询最多 2000 个命中，仅传回 snippet、消息 ID 和绝对序号；主进程逐页扫描，每页最多 120 条，页间让出事件循环。全会话最多同时查询两个会话。查找本身仍为 O(total) 扫描，但不把全量历史传入 renderer。
- 未打开过的 GUI 会话也从持久化范围读取；命中未加载的消息通过目标 range 回填再定位。关闭/隐藏/新查询会取消旧任务，域退出等待任务结束。读取失败显示结果不完整，不伪装成零命中。
- 搜索期间清空/删除导致序号变化会报错并要求重试；有效冷索引允许有界读取，索引损坏或缺失仍可能一次重建。
- 手机表面未单独验收本浮条（窄屏仍居中，可能挡较多正文）。
- 专注模式双栏同时可见：默认跟会话；焦点进文件编辑器后改走文件查找。

2026-10-17验证：分屏目标回归在修复前收到a而非b而转红；真实Chromium高亮回归在修复前发现display:flex而非inline。修复后110项定向组件用例、node/web/test三套类型检查、生产组件浏览器深浅两/三分屏检查与源码构建通过；隔离Electron实际App定向用例1项通过（10.5s）。浏览器测试切owner时曾同时匹配正常presence退场旧条，已按所属会话限定查询。既有IME测试仍有act警告。截图分别位于.tmp/ui-captures/chat-find-split/与test-results/chat-find-split对应目录；本轮未操作或重启用户现有客户端。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D06.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：Ctrl+F 会话内/全部会话（当前工作区 GUI 会话+调度对话）搜 user/assistant 正文，高亮定位跳转；按虚拟屏当前页分流（会话查找 vs 文件查找），Composer/终端聚焦不劫持；GUI 顶栏查找按钮直达所属会话。
- 为什么这样设计：只搜 text part（忽略 thinking/工具卡/宿主通栏/本地回显）——搜「人能读到的正文」；完整当前会话 useMemo 即时、稀疏/全部会话范围查询防抖，关闭/隐藏停扫描并作废在途结果（idle 契约，不白烧 CPU）；浮条定宽随所属会话不分屏错位（曾跨层溢出）；高亮只包行内 mark，不改气泡矩形与既有换行。
- 明确不做：不搜 thinking/工具卡；不跨工作区；全部模式上限 2000 条；未打开过的 GUI 会话从范围索引查找（不拉全量正文）；Markdown DOM 与源 text part 偶发活动 mark 偏移接受；手机表面未单独验收。
- 歧义点：「全部会话」不扫调度历史 Pi 文件（打开每个文件成本高）——A=长期边界（历史内容找回已由 session-search 承担，find 是当前阅读面的 UI 查找工具，分工不重复；review 不把不扫当缺失）／B=规划补扫（find 也要覆盖历史文件）。推荐 A。
