# 工作日报扩展

工作日报是全局扩展，按当前工作区读取工作日志、生成日报和管理待办。主面板和右侧 AI 侧边栏共享同一份 DomainRuntime 状态，Pi Agent Session 通过宿主工具读取和修改待办。

## 当前入口

| 文件 | 职责 |
| --- | --- |
| `resources/extensions/daily-report/extension.json` | 清单、全局作用域、sidebar AI、Domain 查询与命令声明 |
| `resources/extensions/daily-report/domain.mjs` | 日报快照、日志读取、待办查询和写入实现 |
| `resources/extensions/daily-report/agent.md` | Pi Agent 的系统提示词和工具使用边界 |
| `resources/extensions/daily-report/ui/panel.html` | 日历、日志详情、日报生成、待办和派活交互 |
| `resources/extensions/daily-report/client/styles.css` | 面板视觉源码、深浅主题与窄布局 |
| `resources/extensions/daily-report/ui/panel.css` | 构建生成的样式，包含宿主动画 token |

样式修改后运行 `node scripts/build-daily-report.mjs`。Electron 构建生成 `ui/panel.css`，打包时经 extraResources 复制到 `extensions/daily-report`。干净 profile 可离线启动日报。

## 数据和交互

面板通过 SDK 读写当前工作区数据。

- `todos.json` 保存待办、时间线、状态和派活记录
- `ui.json` 保存日历宽度和待办分组折叠状态
- `reports/<YYYY-MM-DD>.md` 保存生成后的日报
- `ma.journal` 读取工作区日志日期和正文
- `ma.llm.chat` 只在用户点击生成或重新生成日报时调用
- `ma.commands.execute('dispatch', ...)` 负责派活和跳转 Worker 会话

待办新增、编辑、状态切换、删除和派活记录统一经过 `ma.agent.domain.command` 进入 `DomainRuntime`。Domain 通过通用 broker 读写数据文件，写入后递增版本并发布 `state.changed`。面板收到事件后重新读取数据、日志日期和报告列表，更新日历、待办与详情。面板自己的命令完成后也刷新界面；异步刷新和详情读取都有代际保护，旧响应不会覆盖新日期或新语言。

待办标题中的 Enter 在输入法选字期间由输入法处理，普通 Enter 提交新增或编辑。界面填充待办属性和日期文案时使用 HTML 编码，状态切换和派活调用收回存储中的原始待办 ID。

快照使用通用 `domain.snapshot`；查询包括 `todos.list`、`todos.open` 和 `journal.dates`。清单声明的待办写入命令包括 `todo.create`、`todo.update`、`todo.setStatus` 和 `todo.delete`。面板派活后使用 Domain 已实现的 `todo.recordDispatch` 保存 Worker 会话记录。

## Agent Session 接入边界

日报清单声明 `surface.kind=sidebar` 和 `agent.profile=scheduler-pi`。宿主按清单声明挂载统一 AI 侧边栏，管理 Agent Session 的打开、释放与恢复。面板视觉不接管会话生命周期。

Agent 的上下文通过 DomainRuntime 的快照和查询工具取得，不依赖面板把每次人的点击转发给模型。Agent 写入后宿主发布状态变化事件，主面板重新读取同一运行时，因此人和 AI 操作的是同一份状态。

## 设计语言与验证

面板通过 `../__sdk__/theme.css` 使用工作台主题 token、字体和基础控件，未设置固定的主题或面板底色。主题热同步由扩展面板外观协议负责。

宽面板是独立滚动的日历/待办侧栏与正文阅读区；宽度不超过 720px 时使用一个滚动容器，依次显示日历、当日记录和待办编辑区。侧栏宽度和分组折叠偏好继续保存在原有 `ui.json`。

正文包含日期、当日概览、日志、当日待办和日报。概览的日志总数、已完成与进行中数量来自当前日期的日志条目，待推进数量来自当天仍未完成的待办。日报只在点击生成/重新生成时调用模型。长待办标题自然换行，状态和派活操作单独占行。

日历以周一为首列，星期标签和日期采用同一顺序。日期和待办分组使用原生按钮，分别暴露选中/展开状态；分组切换后保留键盘焦点。

验证入口：

- `test/unit/daily-report.spec.tsx`：真实 DomainRuntime 与面板连接、AI 写入刷新、概览计数、星期对齐、分组折叠、派活、语言切换、输入法 Enter 和持久待办 ID 往返。
- `test/unit/daily-report-memory.spec.tsx`：日志解析、失败提示、日期竞态、点击生成和所选日期保持。
- `test/extensions-daily-report-agent.mjs`、`test/journal-panel-parse.mjs`：发布契约、样式 token 有效性与日志格式一致性。
- `test/e2e/extensions-daily-panel.spec.ts`：真实 Electron 中新增待办、完成状态、概览刷新、键盘展开和日期切换，并保存面板截图。
- `test/fixtures/daily-report-extension-capture.mjs`：生产主题下中英文、深浅色、390/640/1000/1200px 布局与生成后的正文截图，浏览器边界使用确定性宿主替身。
- `test/fixtures/daily-report-memory-capture.mjs`：日志正常/错误状态的浏览器截图。

自动化通过与最终视觉认可分开记录；Windows Electron 验证不能替代 macOS、Linux 真机验收。
