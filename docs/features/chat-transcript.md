# 聊天转写渲染层（ChatTranscript）

## 会话链接与文件打开

桌面会话中的 HTTP(S) 链接（包括 localhost）单击进入所属工作区的内置浏览器；文件路径和附件名称进入工作台文件预览。链接右键可选内置浏览器或系统浏览器；文件链接、工具路径、附件名称及有源文件的图片右键可选工作台、系统默认应用或文件管理器。用户消息上的链接右键优先于消息历史菜单。内嵌图片单击仍使用大图查看器；没有文件路径的数据图片不提供文件操作。

`ChatLinkBoundary` 在会话转写范围处理事件，`MarkdownBody`、`ToolTitleTarget`、`ChatAttachmentCard` 及有源路径的图片提供目标标记；其他 Markdown 阅读位置不改变行为。`onFileLink.ts` 统一解析工作区链接、file URI、相对及绝对路径，并保留行列；相对路径按会话 cwd 解析。系统打开经 `shell:openPath` 调 Electron `shell.openPath`，文件管理器沿用 `shell:revealPath`，错误显示原因；后者区分路径不存在与权限等其他访问失败，保留底层诊断。网页访问端没有内置浏览器，HTTP(S) 链接仍由访问设备浏览器打开；网关不允许调用宿主的 `shell:openPath`。`test/unit/chat-link-navigation.spec.tsx` 和 `test/unit/node-main/system-file-open.spec.ts` 覆盖转写交互、路径及失败处理；`test/e2e/chat-link-navigation.spec.ts` 在 Windows 隔离 Electron 验证文件预览、网页加载和系统打开 IPC（系统应用使用替身），macOS/Linux 真机未验收。

聊天消息的 Markdown 图片支持 Windows 盘符、Unix 绝对路径、`file://` 和相对会话 cwd 的路径；本地路径经 `buildExternalFileUrl` 和 `filePreviewUrl` 使用既有只读媒体服务，Web 网关走对应 `/media/ext/` 路由。HTTP(S) 图片保持原地址；缺少 cwd、路径无效或图片加载失败时显示提示。图片以紧凑卡片按比例显示，宽度不超过消息区或 320px、高度不超过 220px；卡片展示 Markdown 标题，没有标题时展示替代文字。点击或键盘激活卡片打开 `ImageLightbox`，可缩放、拖动和关闭，点击不会触发消息的其他操作。不会复制或托管原文件，源文件被移走后历史消息无法显示。其他 Markdown 阅读场景保持原有行为。组件回归见 `test/unit/markdown-local-images.spec.tsx`。

转写图片、输入区附件、队列预览和证据截图共用 `ImageLightbox`。查看器将全窗磨砂置于图片和工具条下方，关闭时立即释放交互并保留遮罩至淡出结束。嵌在调度对话上打开时，两层遮罩共用同一个 macOS 合成衬底。见 [窗口背景](frame-backdrop.md)。

附件消息在 `ChatMessageView` 通过 `shared/attachmentDisplay.ts` 作展示投影：用户只看到正文和附件卡片（原生图片为缩略图），图片预览保持原有行为，模型专用的元信息和提取文字不直接渲染；原始消息保留完整上下文。详见 [multimodal-input.md](multimodal-input.md)。

工具卡展开后先显示命令或实际参数，再显示结果或读取内容。终端命令独立显示，其他参数仍可查阅。摘要中的文件链接显示文件名，悬停查看完整路径。搜索摘要显示匹配式或查询，MCP 调用显示工具名，无文件路径时显示服务名。迟到的参数沿用原调用 ID 更新卡片，展开状态随卡片保留。

会话主动读到的来信正文是输出内容，折叠工具活动时继续显示；展开时位于原调用附近，快速切换不会产生重复卡片。宿主发给 Worker 的事件信仅在来源、主题和事件正文均匹配时翻译主题，其他信件及原始正文保持不变。

调度与 GUI 转写消息支持 `displayItems` 宿主展示记录（`shared/displayItems.ts`）：可信宿主捕获会话、消息和片段锚点，再附加带类型的数据；当前首个类型是实际读到的来信。记录随展示历史保存和分叉复制，过滤历史思考时同步调整锚点；来源消息被清空或会话实例被替换后拒绝迟到写入。记录不写入模型消息、工具返回值、上下文或分叉种子；原有工具结果照常交给引擎。旧历史无记录时仍按工具结果展示。CLI/TUI 暂不通过本机制显示。支持新的数据类型时需明确来源、权限、渲染、去重和历史兼容，不能把任意模型输出当作可信宿主记录。

> R-23 一期（2026-09-20）：长会话渲染的两条治理线——**时间衰减**（旧回合归档只读）与
> **长转录窗口裁剪**（超长会话只挂尾部窗口 + 「加载更早」回填）。窗口裁剪仍是 display 层行为，
> 时间衰减会同步触发调度 SQLite 的工具 payload 归档。关联 [chat-surface.md](chat-surface.md)（宿主合同）、
> [animation-system.md](animation-system.md)（本层未新增进出场动画）。

调度与 GUI 首开使用 `chat:historyRange` / `agentSession:getHistoryRange`，默认只取最近 120 条。两个 surface 的 `PageMapCoordinator` 按绝对消息位置保存互不重叠的页（每页最多 120 条）；`messages` 是保留页与本地待发送内容的有界投影，不再累积所有读过的正文。视口附近保留前后缓冲页，另保留最近 240 条所在页供实时输出；离开这些范围后同时释放 page payload、行投影和逐消息时钟。正在导航的目标页临时保留到新视口接管，避免旧视口在异步回填后先把目标淘汰。

GUI 历史响应的 `mode` 只描述 Muster Core 的权限档，外部 Harness 可省略；渲染层在首开、旧页加载、目标定位和实时缺口恢复中均接受该形态，不用宿主默认档填补。字段存在时仍校验其字符串类型，`busy`、分页范围和消息数量的校验保持有效。`agent-session-history-range.spec.tsx` 覆盖 Core 与外部 Harness 的不同响应，`native-harness-history.spec.ts` 通过隔离 Electron 的实际历史 IPC 验证冷加载与重新打开。

`ChatTranscript` 通过 `sparseTranscript.ts` 读取绝对槽位：未加载位置是有高度的占位行，已加载但被展示过滤的位置是空槽。不会创建与历史总数等长的正文数组；虚拟器只产生当前窗口的行（最多 120 条），前后 spacer 保留滚动坐标。视口跨越任一缺页区间时自动按范围补载，因此上翻、下翻、滚动条跳转和追尾使用同一条链路。压缩标记归属锚点消息的测量框，不因另一页到达而改变消息的绝对位置。后台任务等未提供分页合同的只读入口继续使用原有密集行源。

`historyRange` 第四参数 `targetMessageId` 请求目标附近的一页；`ensureMessageLoaded` 只发送一次定位请求，不再线性翻阅旧页。不存在的目标返回空页，错误保留在 surface 的 `historyError`。请求按会话代际和范围去重；清空/逐出后的迟到响应不得恢复旧内容。阅读位置恢复遇到已淘汰锚点时也通过目标接口补页。测量、折叠和流式高度变化仍由 anchor compensation 与 ResizeObserver 处理。

GUI `liveSeq` 和调度 `eventSeq` 分别检查重复、乱序与缺口；恢复只拉尾部范围并保留阅读页，响应在途期间的较新消息优先。实时增量更新保留页，未加载旧页的正文等到对应范围读取时恢复。GUI 冷范围读取使用 `messageRangeIndex.ts` 的字节索引和消息 ID 二分定位，无需每页完整解析检查点。首次无索引、索引失效和崩溃后检查点落后于事件日志仍需一次完整恢复；热引擎与 scheduler 的完整投影仍属于阶段 3/4。正常冷范围路径是 O(page bytes + log total)，不是全部路径 O(1)。

远距离导航同步设置实际滚动位置和虚拟视口，避免旧 scrollTop 在测量时覆盖新目标。隐藏保活页停止行高观测和滚动记忆更新，零布局不写回测量缓存。回合展开选择由 `transcriptFoldState.ts` 保存少量会话/消息 ID，跨虚拟行卸载保留；最多 64 个会话代际、每代际 256 个展开选择，关闭即释放，不保存正文。进程重启后回合回到默认折叠状态，工具卡内部临时状态仍随卸载复位。

验证：`page-map-surface-integration.spec.tsx` 覆盖万条消息的双向淘汰、回填、导航页接管与持续追加；`chat-transcript-window.spec.tsx` 覆盖真实组件的稀疏占位与绝对行索引。`test/e2e/chat-sparse-history.spec.ts` 在 Windows 的隔离 Electron 中验证万条会话 tail→多处远距目标→工具展开/卸载/回填→切换会话→跨页滚轮→tail→restart，以及阅读旧页时经真实 IPC 注入的受控流式增量、深浅主题和窄窗口。该增量是测试替身，不等于真实模型驱动验收；macOS/Linux 真机未测。不建立性能基线，不宣称帧率或耗时提升比例。

## 等待回复时的功能提示

助手流式回合的空占位以三个单色圆点和「努力工作中」显示等待，圆点依次明暗变化；后跟最多一条单行提示，提示前以「Tips」标明内容性质。正文、工具或实时思考到达即卸载提示，非流式空消息不显示等待。它只是 UI 内容，不写入转写或模型上下文。`showWaitingTips` 默认开启，设置保存后生效；关闭只隐藏等待行里的提示，通用设置中仍列出全部内容。多条提示每 5 秒随机轮换，避免与上一条重复，新等待行也会避开上一次显示的内容；仅一条不同内容时无法避免重复。文字被裁剪时可悬停查看完整内容。

提示的运行时唯一来源为 Electron `app.getPath('userData')/waiting-tips.json`，设置页显示实际路径。首次访问时从 `resources/waiting-tips.json`（安装包为 `process.resourcesPath/waiting-tips.json`，经 `extraResources` 分发）复制到用户目录，已有文件不覆盖。当前内置内容只是示例，可直接编辑用户目录的文件：UTF-8 JSON，格式为 `{"version": 1, "tips": [{"zh-CN": "中文", "en": "English"}]}`；允许空数组，最多 200 条，每种语言均需非空且不超过 300 字符，文件不超过 256 KiB。读入与校验在主进程 `waitingTips.ts`，通过 `config:waitingTips` 和 preload 向渲染层供数，Web 网关复用同一通道。

等待行或设置页订阅期间每 5 秒重读；没有订阅时不轮询，下次打开重新读取。修改文件无需重启，但不提供网络下发或更新服务。读取/校验失败时保留文件和本进程最近一次成功结果，设置页显示错误；首次失败时等待行只显示等待动画。`WaitingTip` 负责轮换，`waitingTips.ts` 共享读取与订阅，`GeneralPane` 展示列表。回归覆盖配置重启、实际文件初始化/编辑/错误、轮换及关闭，并用生产组件和 mock IPC 做深浅主题和窄布局截图；未验证安装包实际运行。

## 当前思考展示与展示记录

实时思考以固定 24px 的单行呈现，前方显示单色闪光动画，后方流式追加文本。工具分组内的思考原位占用同高的工具摘要行，保留分组的展开状态；结束后恢复工具摘要，展开列表按原顺序显示「进行了一段思考」。正文、内联审批和提问继续切断分组，分组前的思考仍显示独立行。

`LiveThinkingText` 将连续空白合并为一个空格。自然换行时，上一行短暂向左移动 24px 并淡出，随后原位显示最新行。同一行内追加不移动文字。退场期间继续接收原始内容，结束后直接展示最新行；突发多行时中间行可能不会逐行停留。首次挂载、调整宽度及减少动态时即时定位，隐藏页面不播放退场。空思考显示「思考中…」，不叠加消息等待提示。

会话状态使用统一的单色线条图形：等待三点、思考双闪光、无外框终端提示符、工具扳手和文件写入纸笔。工具运行行有命令或目标时显示简短内容，并以「执行中」标记状态；写入、编辑、补丁及 Codex 文件变更使用纸笔，其他工具使用扳手。终端符号和光标、工具扳手、纸笔分别采用轻量动态，执行结束后静止；保留的历史思考使用静态闪光。上下文压缩使用三条轻线的聚拢动画，完成后回到原有时钟图标。循环使用共享动画 token，隐藏会话暂停，用户或系统减少动态时静止。

通用设置 `liveThinkingOnly` 默认开启、保存后生效。开启时只展示当前思考的正文，结束后的分组内思考只显示摘要。读取已过滤思考的历史时，摘要也随原片段缺失。关闭设置后，可点击分组内摘要或独立思考卡的「正在思考中」查看原文。当前片段结束由后续片段或回合结束判断，驱动未单独传达思考结束事件时，这两者之前仍可能短暂显示。

GUI `GuiSessionStore.save` 与调度 `persistBucket` 在写展示记录前投影：移除 assistant 独立思考片段和旧字段，并调整审批、提问的片段锚点；流式中间保存也过滤。GUI 展示信封以紧凑 JSON 经原有原子写队列保存，同步退出和严格快照采用同一格式；读取兼容先前的缩进 JSON。不修改内存消息、引擎参数、Pi 原生会话或供模型使用的上下文。已在磁盘的旧展示记录不主动扫描删除；该会话下一次保存时按当前设置重新写入。关闭后只会保存之后可取得的思考，已过滤的历史不能从展示记录恢复；引擎自身的记录可能仍存在。工具输出是独立内容，不按文字猜测其中是否包含思考。

Cursor 子代理的嵌套事件将思考与正文放入工具进度，驱动现标记思考来源；开启时宿主直接省略这些嵌套思考增量，避免混入工具输出后落盘，因此这类嵌套思考也不作实时展示。已混入旧工具输出的文本无法可靠区分，不做清理。后台任务展示消息仅内存保存；终端 CLI 的原生界面和引擎自身数据不受此设置约束。

验证见 `thinking-display.spec.tsx`、`thinking-persist.spec.ts`、`thinking-host.spec.ts` 和 `cursor-stream-map.mjs`。`thinking-live-visual.mjs` 在 Chromium 中使用真实组件和模拟 IPC，检查流式追加、自然换行、改宽、减少动态，以及工具→思考→工具切换时的行高和展开后的顺序。`thinking-display.spec.tsx` 另覆盖回合结束后重新展开及内联卡片的分组边界。

## 职责与结构

用户消息的结构化 parts 与旧 content 路径统一使用 MarkdownBody，支持标题、有序/无序列表等既有 Markdown 语法；用户段落与列表项保留普通软换行。助手沿用标准 Markdown 的换行规则，宿主审计消息继续纯文本显示。渲染不更改消息原文或模型上下文；展示记录按上文设置写入投影。

会话正文和 Markdown 文件预览的 GFM 表格保留原生表与列头。较宽时在表格自己的容器内横滚，Tab 聚焦后可用方向键访问边缘列。历史悬浮预览与邮件的 `displayOnly` 继续使用静态布局。组件回归见 `test/unit/markdown-table.spec.tsx`。

批注气泡仍在滚动时同步读取锚点位置；若测得的尺寸和坐标没有变化，则复用原位置状态，避免重复渲染编辑器。位置确有变化时仍立即更新。`test/unit/chat-note-entries.spec.tsx` 覆盖两条路径。

消息批注在条带内定位，进入虚拟屏露条时随条带移动并退场，同时释放键盘操作。切回后编辑框随页面重新出现，未提交草稿保持在原编辑器中。条带滑动结束时重测锚点。组件回归覆盖切屏、操作另一屏及切回。

统一聊天转写视图（调度 Agent 面板 / GUI Worker 会话 / 后台任务子代理面板共用）。关键文件：

| 文件 | 内容 |
|---|---|
| `src/renderer/src/chatSurface/ChatTranscript.tsx` | 转写主体：displayMessages 映射缓存 + **行级元素缓存**（行 deps 逐槽全等即复用旧 element，B1-6）+ 流式行 display 重映射限频（`STREAM_REMAP_THROTTLE_MS`，B1-7）、流式贴底（stickBottom；四个触发器：messages/busy effect、onScroll 补钉、容器 RO、**内容高度 RO**——折叠展开/异步内容/content-visibility 估算结算只长内容不产生 scroll 事件，由 `.agent-chat-col` 观察补钉，2026-09-26）、时间分隔、批注角标/气泡、压缩分割线插槽、会话历史停靠点（turnStops）、**窗口裁剪与 reveal 跳转**、**首开渐进挂载**（重会话按 part 预算分帧补齐，2026-10-14） |
| `src/renderer/src/chatSurface/spring.ts` | **二阶阻尼弹簧数值内核（2026-10-30）**：半隐式欧拉 + ≤1/120s 固定子步 + 单帧 dt 钳 0.1s + 收敛吸附（\|Δ\|、\|v\|<0.01）；文本 k=160/c=26（长文 144/24）、滚动 320/40——物理常量，不是 motion token 时长 |
| `src/renderer/src/chatSurface/revealTicker.ts` | **全局唯一 rAF ticker（2026-10-30）**：所有揭示引擎与滚动弹簧共用；每帧三相——measure（只读几何）→ update（弹簧积分+增量渲染）→ write（单一入口写 scrollTop），页面隐藏跳过、任务清空停 rAF |
| `src/renderer/src/chatSurface/useStreamReveal.ts` | **流式揭示引擎（2026-10-30）**：字符预算（多文本段累计 startOffset）+ 工具门控整行插入 + 思考不排队；`applyRevealToParts` 纯函数截断（全显时返回 null 保引用稳定），Hook 在 ChatMessageView 行内自持状态重渲（绕过行缓存，见下文专节） |
| `src/renderer/src/chatSurface/transcriptScrollController.ts` | 可取消的单任务滚动控制器与可见期输入 Hook：可选离散滚轮增强、统一导航、**弹簧流式跟随（2026-10-30，见专节）**、减少动态与活动期清理 |
| `src/renderer/src/chatSurface/transcriptDisplay.ts` | 宿主消息到 `ChatMessage` 的投影缓存、等价判断、流式重映射节流和过期消息剪枝，不依赖 React 或 DOM |
| `src/renderer/src/chatSurface/transcriptRangeController.ts` | 裁剪前缘冻结、旧页回填和首开渐进预算的纯范围决策，不持有滚动节点或请求状态 |
| `src/renderer/src/chatSurface/transcriptScrollMemory.ts` | 跨实例阅读位置 LRU，容量 64，仅保存绝对位置、消息锚点和回填量 |
| `src/renderer/src/chatSurface/transcriptInitialLayout.ts` | 首次贴底前实现尾部约一屏行的真实布局，首帧绘制后释放临时布局类；取消/隐藏/卸载清理待释放帧 |
| `src/renderer/src/chatSurface/chatSurfaceLayout.ts` | 首次贴底与输入条 ResizeObserver 共用布局坐标测量；先同步输入条真实占位高度与滚动条槽宽，再定位内容，避免默认 120px 与实测高度差造成开场位移 |
| `src/renderer/src/chatSurface/transcriptScrollAnchor.ts` | 最多三个可见点命中消息/正文锚点；读取单个锚点相对位置，避免遍历离屏行触发布局 |
| `src/renderer/src/interactionPreferences.ts` | 窗口内即时偏好与订阅：`scrollFeel` / `scrollDistance` / `motion`，持久化及跨窗口更新；用户或系统减少动态均生效 |
| `src/renderer/src/components/ChatMessageView.tsx` | 单消息渲染：parts 交错（思考/工具/正文）、turn-fold 回合折叠头（**置顶 + acc 折叠体展开/收起动画，稳态收起真卸载**，2026-10-31）、**时间衰减门（staleTurn）**、计划卡、批注操作行 |
| `src/renderer/src/components/MarkdownBody.tsx`、`chatSurface/UiArtifactContext.tsx` | 外层样式与正文解析分开 memo；产物抑制路径按值保持引用稳定，消息外观/等价克隆不广播 Context，真实文本/产物变化仍更新（性能证据见 [performance.md](performance.md) §18） |
| `src/shared/chatStaleTurn.ts` | 时间衰减纯函数：`STALE_TURN_MS`（24h）+ `isStaleTurn(createdAt, now, threshold)` |
| `src/renderer/src/chatSurface/ChatHistoryPanel.tsx` | 会话历史面板与预览复用输入条自适应列宽。每条提问右侧书签独立切换收藏，顶部「仅看收藏」筛选。打开时默认显示已加载历史，筛选时也可看到尚未加载的收藏。当前转写提供 `onNavigate` 统一跳转，独立用法保留原生 `scrollTo` / `chat-clip:reveal` 兜底。 |
| `src/renderer/src/chatSurface/useHistoryFavorites.ts` | 消息操作条与历史面板共用收藏存储，写入后同步已挂载的同一转写，跨窗口通过 `storage` 事件同步。 |
| `src/renderer/src/styles/chat.css` | `.turn-fold.is-stale`（归档态）、`.chat-clip-more*`（回填按钮）、contain 登记表（见下节：`.chat-turn-anchor` 88px / `.turn-fold-item` `.tool-call-block` 100px，2026-09-14 起） |
| `src/renderer/src/styles/markdown.css` | `.md-body > *` 子块 contain（100px，2026-09-26）+ 文件预览豁免 |

## 贴底与回底入口

自动跟随与实际离底分别维护：向上滚动外层会话解除跟随，即使仍在 60px 底部容差内；增强滚轮的程序写入保留对应方向，异步 scroll 送达时不会因基线已同步而误恢复跟随。向下回到底部或点击「滚动到底部」恢复跟随。容器与内容的 ResizeObserver 在跟随时补钉，不跟随时保持阅读位，但仍按最新几何更新回底按钮。内容增长、输入条让位或视口变矮无需产生 scroll 事件，也能显示离底入口；恢复历史阅读位置时同样同步按钮。按钮沿用 `usePresence` + `mp-pop-up`。

首次贴底、重新可见及异步历史第一次到达时，先通过 `syncChatSurfaceLayout` 同步输入条真实占位与滚动条槽宽，再从尾行向前实现约一屏内容：临时 `chat-positioning-row` 将这些行及其 Markdown/工具子块的 `content-visibility` 设为 `visible`，再即时贴底。React 子组件 layout effect 先于父组件执行，不能只等 ChatSurfaceView 的测量 effect；否则重挂会先按 CSS 默认 120px 贴底，输入条实测 124px 后再补移 4px。输入条 ResizeObserver 后续继续调用同一个测量函数。临时布局类保留至首帧绘制后（两次 rAF），随后恢复原规则；用户接管、切会话、隐藏或卸载提前释放并取消待执行帧。不会展开整段历史，也不在正常流式更新中重复准备；若单行很长，该尾行仍需一次真实布局。这样避免调度面板每次重挂时行/子块估高分几帧结算，导致虽一直贴底、可见回复仍大幅跳动。面板自身的淡入/缩放入场保持原样。

滚轮意图按实际滚动区域分流：事件目标到 `.chat-list` 之间存在仍可上翻的内部滚动区时，保留外层跟随；内部到顶后，允许滚动链则继续检查祖先并可解除外层跟随，`overscroll-behavior-y: contain/none` 则阻断向外传递。跟随已解除时不再重复读取祖先样式；回底恢复跟随后重新检查。不会通过一律阻止事件冒泡来破坏内部到边界后继续滚动会话的行为。内嵌 iframe UI 仍经 `chat-scroll:user-interaction` 传递意图。

组件回归：`chat-transcript-content-pin.spec.tsx` 覆盖内部消费/边界滚动链/阻断滚动链、容差内上翻后内容增长、容器变矮；`chat-jump-bottom.spec.tsx` 覆盖点击恢复、容差、位置恢复与按钮。两者将减少动态固定为即时路径，滚动插值与取消由 `transcript-scroll-controller.spec.tsx` 单独覆盖。生产组件与 CSS、mock IPC 的 Chromium 入口见下文测试表。

## 流式弹簧揭示与滚动跟随（2026-10-30）

数据到达节奏与上屏节奏解耦：store/deltaBatcher 合批（≤50ms）与转写层重映射限频（100ms）不变，
新增「揭示引擎 + 滚动弹簧」两层数值平滑，共用全局唯一 rAF ticker（`revealTicker.ts`，
三相帧序：measure 只读 → update 积分+增量渲染 → write 写 scrollTop；dt 钳 0.1s）。

**文本揭示（`useStreamReveal`，挂在 ChatMessageView 行内）**：

- 模型：一条流式 assistant 消息的全局字符预算 `shown`，由弹簧推进（k=160/c=26，ζ≈1.03，
  约 0.3s 收敛；正文超 `REVEAL_LONG_TEXT_CHARS=4000` 自动降档 144/24）。数据侧只更新弹簧目标
  （全文长度），不逐 token 改 DOM。
- 多文本段按到达顺序累计 startOffset，`local = clamp(shown - startOffset, 0, len)` 只取前缀；
  渲染节拍下限 `REVEAL_RENDER_MIN_INTERVAL=33ms`（≤30 次/秒，markdown 只重解析活动段，
  已完成段保持 part 引用稳定命中 ChatMarkdownBody/ToolCallCard memo）。
- **工具行不占字符预算**：仅当它之前的正文全部揭示（`shown >= startOffset`）才整行一次性插入
  （parts 前缀截断天然幂等，key 稳定不重复）；UI 单行省略沿用 `.tool-lite-detail` 的
  ellipsis/nowrap。思考段是 live 活动指示，不排队、即时出现。
- 终态对齐：流结束（streaming 翻 false）即渲染全文并注销 ticker 任务（光标随 is-streaming
  消失）；切会话/重新生成按消息 id 重挂、挂载即 snap 到当前全文（不回放）；内容收缩立即 snap。
- 边界：用户/系统减少动态时揭示关闭（文本按合批节奏直出，现状行为）；保活隐藏面板
  （checkVisibility）暂停推进，重新可见时积压 >`REVEAL_HIDDEN_SNAP_CHARS=600` 直接吸附；
  半截 Markdown 语法按前缀渲染，与既有批内行为一致（不做段边界补全）。

**滚动跟随弹簧化（`transcriptScrollController.followBottom`）**：贴底补钉从「固定时长
ease + 截止时间」改为活目标二阶阻尼弹簧（k=320/c=40，ζ≈1.12 稍过阻尼，约 0.2s 收敛、
无过冲）——目标每帧重测 `scrollHeight-clientHeight`，同一在途跟随只更新目标不重启，
收敛（吸附阈值 0.01px）即收工；内容再增长由既有 RO/补钉触发重挂。突发大块正文或工具
插行不再硬跳。**契约变更（取代 2026-10-17 的「原生模式流式跟随即时」）：所有手感档
（native/crisp/soft）统一弹簧**；首次定位、新回合、恢复对齐与 prepend 补偿仍即时，
显式导航（jumpTo）与滚轮增强（wheel）的固定时长 token 动画不变；用户接管/隐藏立即取消，
减少动态落到语义目标。程序写入经 onWrite 同步基线，既有用户滚动判定不误伤。

已知边界：揭示的 React 渲染是异步落地，与滚动弹簧的同帧测量可能差一帧，由既有内容高度
RO 补钉收敛（视觉上无感）；揭示重渲绕过 B1-6 行缓存（行元素引用不变，成本限于流式行自身）。

回归：`test/unit/stream-reveal.spec.tsx`（弹簧数学/截断纯函数/揭示投影/隐藏积压）、
`transcript-scroll-controller.spec.tsx` 的弹簧跟随与无过冲用例、
`chat-tool-card-memo.spec.tsx`（揭示下工具卡 memo 契约）。

## 回合折叠：折叠头置顶与展开/收起动画（2026-10-31）

当前轮次的 assistant 正文在流式输出和回复结束后均完整保留，直到下一条实际发送的用户消息出现才按历史回合折叠；排队消息和宿主静默插话不划界。同一轮有多条 assistant 消息时均保留；运行期间工具行平铺，回合结束后已完成的工具和思考收进折叠头，正文及读信卡保持可见，展开后工具回到原顺序，运行中的工具仍可见。重新打开会话按消息顺序还原这一规则；没有用户消息的旧记录只将最后一条 assistant 视为当前轮。当前轮不受 24 小时归档影响。`chat-current-turn-fold.spec.tsx` 覆盖结束、宿主读信、排队、发送下一轮与手动展开。

用户反馈两个问题一次收口：① 点「工作了 N 秒」折叠头展开时内容整块蹦出；② 折叠头
此前插在**首个可折叠 part 的位置**（落在第一段正文下面），不像 Cursor 在回合最前。

- **折叠头置顶**：PartsBody 折叠态先出折叠头（多段渲染归第一段），其后是 acc 折叠体
  与尾部（末段正文）。展开态顺序 = 头 → 折叠体内全部条目（中段正文/思考/工具栈按
  真实交错序）→ 末段正文。
- **acc 折叠体**：可折叠前缀装进 `.turn-fold-body`（acc 骨架：grid 0fr↔1fr + opacity
  纯 transition，`--dur-panel` 展开 / 退场档收起，可打断）；`.acc-body` 内沿用
  `.chat-body` 的 6px 间距，展开终态与平铺零差异。展开时 ToolCallStack 渐进挂载
  （40 + 160/帧）在折叠体内继续生效——高度过渡与分批挂载叠出丝滑展开。
- **真卸载契约不变**：稳态收起 wrapper 不挂载、条目 el 不创建；收起瞬态由
  `usePresence` 延迟卸载（exitMs+80ms 兜底）播完退场再卸内容，退场中可反向打断回弹。
  「纯正文不折叠」「渐进补齐不丢卡」「时间衰减强制收起」契约原样。
- **输出与活动分离**：读信卡是输出，折叠时仍单独可见且不重复；「执行中」工具栈保持旧契约不参与折叠（收起态仍可见、
  不计入折叠头）；进入下一轮时自动收拢是瞬时的（此前折叠体不存在，无退场可播）；
  legacy 扁平路径（无 parts）保持原样瞬时。
- 回归：`chat-fold-unmount.spec.tsx`（原真卸载四契约 + 置顶/acc 展开/收起退场窗口/
  减少动态即时/CSS 骨架在场）。

## 展开/收起全面动画化 + 输入条高度弹簧（2026-10-31）

继回合折叠体后，会话内全部硬切展开一次收口：

- **AnimatedDetails（`components/AnimatedDetails.tsx`）**：保留 `<details>/<summary>`
  原生语义与键盘/无障碍行为，接管原生开合——展开/收起经 acc 骨架
  （grid 0fr↔1fr + opacity 纯 transition，可打断）；**收起态内容不进 DOM**
  （同原生 closed details 的零渲染成本；此前 jsdom 文本断言可见属实现细节，
  已随契约更新），收起瞬态由 usePresence 延迟卸载播退场。接入：工具卡
  `tool-lite` 详情、思考卡（历史思考展开）、harness 注入卡/工具行/详情抽屉。
  计划卡全文此前已是 acc。
- **输入条高度弹簧（`chatSurface/smoothComposerHeight.ts`，ChatSurfaceView 接线）**：
  composer 悬浮层高度变化（多行/附件条/排队面板/建议胶囊）经弹簧（k=320/c=40）
  逐帧写 wrap 显式 height——wrap `justify-content:flex-end` 底锚、溢出可见
  （qip/菜单等向上弹的绝对定位浮层不受裁剪），增长瞬间的溢出落在转写让位
  同弹簧释放的padding 区上；既有 wrap RO → `--composer-overlay-h` 逐帧跟随，
  **转写 padding 与跳底按钮让位同弹簧联动**（会话内容平滑移动）。首挂 snap、
  收敛即停 rAF、减少动态不接管（height auto）。已知边界：底 padding（含移动端
  safe-area）在挂载时装定一次，safe-area 运行时变化不重算（下次内容变化自愈）。

回归：`test/unit/chat-animated-details.spec.tsx`（AnimatedDetails 开合/退场窗口/
受控/减少动态/工具卡接入；composer 高度弹簧首挂 snap、增长与收缩平滑、
减少动态不接管）；`chat-tool-card-memo` / `harness-annotations` 随「收起零挂载」
契约更新。

## 滚动手感、导航与活动期（2026-10-17）

偏好默认 `scrollFeel: native`、`scrollDistance: 1`、`motion: system`。原生模式不接管手动滚轮，设备与浏览器自身的惯性、滚动距离保持原样；它不是“所有程序导航都瞬移”的开关。`scrollDistance`（0.5–2 倍）只用于显式 `crisp` / `soft` 增强模式，不缩放原生输入。

- **增强范围**：`WheelEvent` 没有可靠的鼠标/触控板类型字段。仅对较明确的离散输入作保守启发式：整数 1–6 行的 line 输入，或 80–240px 范围内的 40 整数倍及 100px pixel 输入；因此常见 100px / 120px 均有覆盖。小步、小数、高频或短间隔幅度变化/衰减序列退回原生，并短暂保留原生判定。首个大整数事件仍可能来自触控板，不能保证精准区分设备；增强必须由用户主动选择，原生随时可选。
- **输入边界**：Ctrl/Meta 缩放、Shift/横向输入、已被组件处理的事件均不接管。先检查真实内部滚动区及 `overscroll-behavior`；内部可消费或阻断链时保留原生，允许传递到外层时才增强。外层已到边界也不强制阻止原生链。只有确认可由当前转写消费的粗滚轮才 `preventDefault`。
- **有界目标**：控制器只有一个任务、一个 rAF，不累积动画队列；同向未呈现距离最多一屏，反向从当前已呈现位置接管。增强 wheel 保存剩余相对位移，不保存会被 CV 高度结算污染的旧绝对终点；以一个命中的可见正文元素为 witness，每帧只测该元素和容器的相对位置，先分离布局位移再消费本帧滚动距离。浏览器已锚定时不重复补偿。位移在原截止时间结束，此后最多两帧只修正该局部锚点，用户输入、隐藏或导航会一起取消；无可见命中时保守退回相对位移，不遍历全树强制实现离屏内容。`crisp` 与 `soft` 使用现有 `MOTION` 时长及 `--ease-standard`，不新增一套 CSS 动画曲线。
- **统一主动导航**：回底、查找、会话历史和 `chat-clip:reveal` 共用控制器。长距离先定位到目标邻近，只动画最后一屏，避免穿越整段历史；查找居中，历史停靠点留 8px。常态父级重渲染不因等价命中对象重播导航；扩窗/渐进新 DOM 仍重画并定位，`sessionId` 改变也重新定位同 id/index 的命中。查找缓存仍连接的 mark，重刷高亮导致旧 mark 断连时才按消息和活动命中重新解析，不在每帧扫描全部行。
- **历史收藏**。有正文或图片的已发送人工消息在复制按钮旁提供书签，历史面板使用同一书签，收藏后由空心变实心。两处通过 `useHistoryFavorites` 按转写 ID 写入本机 `localStorage`，后台子代理按任务 ID 独立分桶。只保存消息 ID、时间与提问摘要。筛选页优先使用已加载消息生成完整预览，其余条目显示摘要。点击不在当前范围的收藏时，GUI 与调度转写用现有的按消息 ID 读取链路回填并跳转。归档等只有顺序分页的转写需先加载对应历史。找不到或读不到目标时显示提示，仍可取消该条收藏。
- **用户接管**：滚轮、指针或触摸开始可取消在途动画；只有确实传到外层的竖向滚动、实际拖动/触摸滚动或本转写内的滚动键才解除其跟随许可。键盘在组件处理后判断，不阻止默认行为；输入框、contenteditable、IME、按钮/summary 等控件激活及其它面板不因空格/方向键误摘跟随。指针仅选中文字不等于滚动，手势结束即清理待判定状态。新的用户输入和显式导航也取消在途阅读锚点补偿。
- **流式跟随**：仅 `stickBottom` 允许时执行。2026-10-30 起所有手感档统一走二阶阻尼弹簧
  （k=320/c=40，见「流式弹簧揭示与滚动跟随」节；取代本节初版「原生模式即时」的约定）；
  首次定位、新回合及恢复对齐仍即时。同一在途弹簧只更新目标不重启、收敛即收工。用户/系统
  减少动态会使可见的在途任务立即结束到当前语义目标，之后不插值。
- **activity 生命周期**：`ChatSurfaceView` 将可交互、实况且未禁用的状态传为 `interactionActive`。隐藏时同步取消控制器和阅读补偿，卸下当前转写的原生输入监听，暂停渐进扩批，不在后台维持滚动 rAF，也不按隐藏的零高度写掉阅读位置。重新可见时，即使消息引用未变，也重新处理一次贴底/待恢复位置；有阅读意图时保持阅读位置。首次恢复与 prepend 补偿始终即时，不经过动画队列。

## 时间衰减与调度工具归档（R-23）

- **规则**：距今超过 `STALE_TURN_MS = 24h` 的已结束 assistant 回合，调度 SQLite 归档其工具 payload，渲染为「仅末输出」形态——
  折叠头强制收起（`effOpen = false`）且**不可展开**（`aria-disabled` + title「较早的回合已折叠归档」，
  点击无反应），中间工具/思考/正文维持真卸载。近期回合维持现状（折叠头可点开）。
- 归档保留最终正文、工具 ID、工具名、状态和必要生命周期元数据，清除工具参数、原始结果、终端输出、预览路径、补丁和思考正文。
- 调度会话每个 session 使用一个 SQLite 文件，SQLite 只保存当前消息投影，不保存重复生命周期事件。Pi 原生会话文件不在本机制范围内。
- **缺时间戳回落（保守）**：`createdAt` 缺失/0/NaN/负数/未来值不会触发自动归档，渲染仍视为「近期」可展开
  （guiWorker 迁移路径把缺 ts 归一成 0；宁可多渲染可展开，不静默吞内容）。
- **判定边界**：`now - createdAt >= threshold` 恰好压线 = 已衰减（见 `test/chat-stale-turn.mjs`）。
- **求值时机**：衰减在 `renderedWindow` memo 内取 `Date.now()` 求值，**无独立计时器**——
  页面静置跨过 24h 阈值后要等下一次消息/交互触发的重渲才收拢（已知边界，接受）。
- 衰减回合上的批注：不为其展开回合（归档态优先），气泡走 `is-from-bar` 兜底定位。

## 双向范围渲染与密集行源回退

调度和 GUI 的分页会话使用绝对消息槽位。存在未加载槽位或总行数超过 `MEASURED_VIRTUALIZER_THRESHOLD`（1000）时启用 measured virtualizer；按视口、overscan 和 120 行上限渲染，前后 spacer 表达尚未挂载的历史。没有分页合同的入口仍使用密集行源：超过 500 行时保留原尾部窗口策略，超过 1000 行也启用 measured virtualizer。

- 上下滚动均按绝对范围请求缺页；顶部按钮在 measured 档向前移动一屏。密集回退档沿用每次 240 条的扩窗。
- 停靠点 `chat-clip:reveal` 先补目标页，再同步物理滚动位置和虚拟窗口；窗口外正文被释放后仍可重新定位。
- ResizeObserver 记录行高与 margin，变化发生在阅读锚点之前时补偿 scrollTop；缺页占位也参与测量，避免第一条实消息被误认成窗口起点。隐藏保活页不参与测量。
- 流式跟随只在尾部开启；旧页阅读不因 tail 更新而被淘汰。清空和会话代际变化使旧请求、测量、阅读与展开记忆失效。
- 切回保活会话保留位置；LRU 重挂以进程内的消息 ID/偏移记忆恢复，缺页时用目标接口补载。应用重启默认读取尾页，未持久化阅读坐标和手动展开选择。
- 批注角标仅挂在已渲染消息上，离屏时不显示；页到达后按实际几何重测。未测量历史仍用估高，滚动条总高度会随已读范围校正；不承诺未知图片或结构性 margin 的精确预估。

`transcriptRangeController.ts` 提供无 DOM 的裁剪前缘和渐进尾部预算决策，`measuredVirtualizer.ts` 提供范围计算、稀疏行高和 anchor compensation。`sparseTranscript.ts` 不创建 total 长度的数组。`transcriptDisplay.ts` 独立维护宿主消息到 ChatMessage 的等价映射缓存和流式重映射节流，`transcriptScrollMemory.ts` 独立维护容量 64 的阅读位置 LRU。当前 Windows 长会话证据及跨平台、真实 driver 边界见本文顶部与重构执行账本。

## 首开渐进挂载（2026-10-14 性能专项）

**问题**：按 part 量计的重会话（几十条消息撑上千工具卡，如 12MB 转写 / 1800+ parts）
消息数 < 500 不触发裁剪、首开一次性挂全部行——style/layout/paint 压成单帧
93–145ms 长任务 + 多帧 117–150ms 间隙（CDP 真机实测，见
[performance.md](performance.md) §19）。

**机制**（`ChatTranscript.tsx`）：

- **启用门槛**：会话 parts 总量 `> PROGRESSIVE_PARTS_THRESHOLD (600)` 才渐进
  （阈值高于 500 条纯正文会话的 parts 量，保住「短会话零行为差异」契约；
  实测重会话在 1000+ parts 档）。
- **首批**：从尾部 `PROGRESSIVE_FIRST_PARTS (64)` part 预算起步。步骤数不等于折叠后的可见高度：
  若实际内容不足一屏，在 layout effect 内、首帧绘制前扩批并重做尾部真实布局与即时贴底，
  直到填满视口或已挂满历史。预算至少翻倍且覆盖下一整行，避免单条超大消息造成空转；
  只填首屏，不提前挂完离屏历史。隐藏/用户接管取消该准备，待恢复阅读位置时仍由恢复路径负责。
- **补齐**：每帧 rAF 自尾部加 `PROGRESSIVE_STEP_PARTS (140)` 向上补（既有真机样本约
  10 帧 / 200ms 走完 1800 parts）；跟随态在每批提交后、绘制前即时贴底，不应用旧阅读锚点或流式平滑动画。
  用户上翻阅读时才按 prepend 前的可见锚点即时对齐，缺锚时按 scrollHeight 增量兜底（与「加载更早」同机制）。
- **立即放行**：`chat-clip:reveal`（停靠点跳转）与查找命中（findActive 指向未
  挂载行）把预算直接放行到挂满——显式导航不等分帧。
- **生命周期**：预算随 sessionId 重算（切回重会话重新渐进）；隐藏活动期暂停扩批、重显续上。
  预算走满后恒挂满，流式/更新路径零差异。
- **输入条重显**：会话隐藏时停止输入条高度弹簧并清除显式高度；重显前按当前自然高度直接定位，避免隐藏期的尺寸变化在打开时推动转写内容。会话可见时输入条变化仍使用平滑高度过渡。
- **建议回复**：输入条在首次显示建议时直接取得完整高度；打开会话前测量自然高度并即时贴底，避免建议胶囊展开带动可见消息移动。退出状态仍保留原有过渡。
- **文件卡首开**：已有快照的会话等待首次可用性检查，文件卡装入后再即时定位并显示消息；查询超时解除等待并提示。具体见 [turn-checkpoint.md](turn-checkpoint.md)。

回归：`test/unit/chat-transcript-progressive.spec.tsx`；reveal 新断言验证目标同步放行、长跳只动画最后一屏、在控制器截止时间内落到 8px 停靠点，无旧 `scrollTo` 调用次数假设。`chat-transcript-initial-layout.spec.tsx` 覆盖首批不足一屏、超大单行、隐藏重显及分帧贴底；`node test/chat-opening-visual.mjs` 使用真实 AgentFloat/ChatSurfaceView 与模拟 IPC，检查两表面深浅主题、1000/620px 窗口首开/重开的逐帧位置。2026-10-23 的重会话样本修复前漂移 165.50px，修复后八组均 0.00px（容许浮点误差 0.001px）；不等同于真实 Electron 或 macOS/Linux 验收。证据位于 `.tmp/chat-opening-visual/`。

## 阅读位置记忆（2026-10-14 保活 LRU 配套）

会话视图被 LRU 逐出重挂（或调度面板关开重挂）时恢复切走时的阅读位置与
「加载更早」回填窗口，而不是一律贴底：

- **记忆**：模块级 Map（容量 64，进程内跨实例）。滚动中持续记绝对
  scrollTop + clipExtra；**滚动停止 150ms 后节流补记锚定消息**（视口顶行
  mid + 相对偏移）。只在滚动容器水平中心、靠近顶部最多命中三个可见点，
  不逐行读取离屏矩形；中心点兼容宽屏居中的阅读列。不能在卸载时量锚：LRU 逐出前视图已 display:none，
  几何全 0。回到底部即清记忆（贴底是重挂默认）。
- **恢复**：挂载期读记忆（恢复 clipExtra 窗口），渐进挂载走满后一拍执行；
  **锚定行优先、绝对值兜底**，即时写入，不播放导航动画。恢复即接管视口（渐进扩张的锚定补偿作废）。
- **有限修正**：恢复与 prepend 后最多两帧只重测同一个消息锚点，吸收刚进入视口的估算高度结算。
  新输入、显式导航、隐藏、会话换代或卸载会使该代补偿失效；不挂永久定位循环，不全树扫描。
- **优先级**：reveal（停靠点跳转）与查找命中显式导航 > 位置恢复。
- **已知边界**：①content-visibility 离屏块用估算高度、进视口才真实化——
  同一消息集的绝对 scrollHeight 跨挂载会漂移。局部修正只覆盖短窗口，不能保证后续异步内容、
  字体或两帧之外的高度变化不推移内容，也不宣称原有 ±几行偏移已全部修复；②可见点未命中消息、
  滚动停止 150ms 内被逐出、或锚行消息被删时，退绝对值与合法范围夹紧。

回归：`test/unit/chat-transcript-scroll-memory.spec.tsx`、`transcript-scroll-controller.spec.tsx` 的可见采样、两帧结算及输入/导航/会话代际用例。

## contain 登记表（2026-09-26，extreme-review P1-1/B1-1）

`content-visibility: auto` 渲染面收敛的选择器与估算高登记（**保持与本表一致，改 CSS 先改表**）：

| 选择器 | 文件:行 | 估算高 | 为何此值 |
|---|---|---|---|
| `.chat-turn-anchor` | chat.css:1335-1343 | `auto 88px` | 锚点级（整条消息），首版值沿用 2026-09-14；行高不可预估取中位 |
| `.turn-fold-item` | chat.css:789-797 | `auto 100px` | 折叠条目行高可预估（工具卡/思考块单行量级偏上） |
| `.tool-call-block` | chat.css:807-815 | `auto 100px` | 工具卡摘要头 + 折叠体，与折叠条目同量级 |
| `.md-body > *` | markdown.css:13-19 | `auto 100px` | 直接子块（段落/代码块/表格），整篇长文按块免 layout |
| `.md-body .ma-ui-card` | markdown.css（智能界面 inline 部件卡） | `auto 96px` | 挂载前轻量占位；内容自然高度，无 720px/60vh 截断，见 [intelligent-ui.md](intelligent-ui.md) |
| `.md-body.file-editor-md-body > *` 等三变体 | markdown.css:32-39 | —（`content-visibility: visible` 豁免） | 文件预览走虚拟屏，paint 隔离会按位图缩放发虚（既有 contain:none 决策顺延） |

**依赖守卫**：批注量位测量 effect（ChatTranscript.tsx:457-458，实读确认）对
content-visibility 跳过的锚点保留上次量位（`r.width === 0 && r.height === 0` 直接跳过，
不写 0,0）；RO 静默 120ms 后补测归位（ro-debounce 契约），P1-1 起流式期不再逐批重测。

**回滚开关**：锚点级 `.chat-turn-anchor` 规则保留不动；回滚 = 删除子块三处规则
（`.turn-fold-item` / `.tool-call-block` / `.md-body > *`，markdown.css 豁免规则随之空转）。
可执行守卫：`test/unit/chat-transcript-find-scroll.spec.tsx`「B1-1 子块 containment 规则在场」
（规则被删即红，键序豁免同检）。

## 测试

| 层 | 文件 | 覆盖 |
|---|---|---|
| 纯逻辑 | `test/chat-stale-turn.mjs` | 阈值/压线边界/缺 ts 与非法值回落 |
| 组件 | `test/unit/chat-stale-turn.spec.tsx` | 超期不可展开只留末输出、近期可展开、缺 ts 回落、legacy 路径、ChatTranscript 接线 |
| 组件 | `test/unit/chat-transcript-window.spec.tsx` | 3000 条只挂尾部窗口、短会话零差异、回填 + 视口锚定、裁剪态流式贴底、分割线位置、reveal 跳转、切会话重置 |
| 组件 | `test/unit/chat-history-panel.spec.tsx` | 实际宿主统一导航，独立用法的已挂载/未挂载兜底，悬浮不滚与点击不关闭 |
| 组件 | `test/unit/chat-transcript-find-scroll.spec.tsx` | find 先展开再测量精确活动命中；contain 子块规则在场（回滚开关自检） |
| 组件 | `test/unit/transcript-scroll-controller.spec.tsx` | 原生与显式粗滚轮、100/120px/line/精细回退、距离与反向、CV 结算/浏览器已锚定/边界钳制下的正文位移、嵌套/缩放/横向边界、弹簧流式跟随（活目标不重启/无过冲/native 同弹簧/减少动态即时）与导航、mark 重建、同命中跨会话、reduced/隐藏、双 pane 输入与按钮激活、锚点有界修正和代际取消 |
| 组件 | `test/unit/stream-reveal.spec.tsx` | **流式弹簧揭示（2026-10-30）**：弹簧子步积分/收敛吸附/dt 钳制/无过冲/长文换参；`applyRevealToParts` 多段累计预算截断、工具门控整行插入且不重复、思考不排队、全显返回 null；ChatMessageView 揭示投影——突发大块不整段蹦出、流结束立即终态且无 ticker 残留、减少动态直出、中途挂载 snap 不回放、隐藏暂停与大积压吸附 |
| 组件 | `test/unit/chat-fold-unmount.spec.tsx` | 真卸载四契约（收起零挂载/渐进补齐不丢卡/纯正文不折叠/legacy 同构）+ **折叠头置顶与 acc 折叠体（2026-10-31）**：稳态收起不挂载 wrapper、展开 is-open 且卡在折叠体内补齐、收起退场窗口（presence 延迟卸载）后退载恢复、减少动态即时、CSS 骨架在场自检 |
| 组件 | `test/unit/chat-animated-details.spec.tsx` | **AnimatedDetails 与输入条高度弹簧（2026-10-31）**：details 收起零挂载/展开 acc is-open/退场窗口后真卸载/受控模式/减少动态即时/工具卡接入；composer 高度首挂 snap、增长收缩均弹簧平滑、收敛停 rAF、减少动态不接管 |
| 组件 | `test/unit/chat-transcript-progressive.spec.tsx` | 渐进全量补齐、reveal 同步放行并有界完成、查找放行、轻会话与切会话 |
| 组件 | `test/unit/chat-transcript-initial-layout.spec.tsx` | 异步历史首定位前仅准备尾部一屏、绘制后释放、不在常态更新中重复准备、隐藏/卸载/用户接管及时清理；真实 ChatSurface 在 124/188px 输入条下首次写 scrollTop 前已经同步真实高度，重挂保持位置 |
| 组件 | `test/unit/chat-transcript-row-cache.spec.tsx` | B1-6 行级元素缓存：每条 deps 槽位「变化必换行」、未变行复用旧 element（非 memo 替身观测；还原槽位或退回整窗 useMemo 即红） |
| 既有 | `chat-transcript-memo / -compact / -ro-debounce / chat-fold-unmount / chat-jump-bottom / motion-presence` 等 | 行 memo（含 B1-5 harness 计量缓存、B1-7 流式重映射限频）、贴底、真卸载契约不回归 |
| Chromium 生产组件 | `test/fixtures/chat-scroll.tsx` + `chat-scroll-scenario.mjs` | 既有真实小步 wheel、嵌套消费/边界链与内容增长后跟随；默认夹具布局与原有准备方法保留 |
| Chromium 生产组件 | `test/fixtures/agent-float-scroll.tsx` + `agent-float-scroll-scenario.mjs` | 真实 AgentFloat 侧栏入口点击开合、重挂与退场中重开；逐帧按面板缩放归一可见回复偏移，深浅/窄布局截图；mock IPC，与真实客户端验收分开 |
| Chromium 生产组件 | 同一夹具 + `test/fixtures/chat-scroll-feel-scenario.mjs` | `enableScrollFeelFixture()` 准备入口显式显示原生/利落/柔和、距离、动态效果与样本/跳转控件。保留多消息 CV 困难样本，以同一可见正文元素的偏移检查视觉距离及不误贴底；另用普通单块正文自然实现后的稳定高度检查精确 100/120px 距离，未伪造高度。真实 `page.mouse.wheel` / 键盘检查中间呈现、有限收敛、反向、嵌套、隐藏、减少动态、输入时仍在途的跟随与最终回底；仅准备步骤用几何布点 |

新手感场景通过 `.agents/skills/ui-verification/scripts/capture-component.mjs` 的 `--fixture` / `--scenario` 运行，测量目标用 `--target .chat-list`，每轮使用新的 `--out`。场景保存数值输入/位置/高度/帧轨迹与关键截图；帧间隔只记录分布，不把 60fps 当通过线。表中是覆盖定义与入口，新增浏览器验收仍由本轮统一采集确认，本文不据用例存在宣称通过。Chromium 生产组件夹具使用 mock IPC，不等同真实 Electron、大会话、物理鼠标/触控板或 GPU 呈现验收。

注意 fixture：写死 2024 等历史时间戳的 assistant 消息现会被判「超期归档」不可展开——
测折叠/批注交互（非衰减）时用 `Date.now()` 近期时间戳（chat-note-entries.spec.tsx 已改）。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D06.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：三表面共用的转写容器：贴底跟随/回底浮钮、时间衰减（24h 后回合归档只读不可展开）、长转录范围渲染（分页会话采用稀疏槽位和最多 120 行的双向窗口，密集入口保留短会话策略）、首开渐进挂载（>600 parts 分帧补齐）、LRU 逐出重挂后的阅读位置记忆。
- 为什么这样设计：窗口裁剪仍是 display 层行为，调度 SQLite 的时间衰减会在回合完成且超过 24 小时后清理工具载荷，只保留最终正文、工具摘要和生命周期元数据；Pi 原生会话文件不参与这次清理；贴底与离底独立维护、内容高度 RO 补钉（折叠展开/异步内容不产 scroll 事件也要跟随）；衰减缺时间戳保守视为近期（宁可多渲染不静默吞内容）；裁剪/渐进门槛值保「短会话零行为差异」；统一滚动控制器单任务单 rAF，用户接管/隐藏即取消，长距离导航只动画最后一屏。
- 时间衰减边界：展示层衰减回合不展开，调度 SQLite 已归档回合即使查找命中也不允许重新挂载工具卡；无独立衰减计时器，静置跨阈值等下次重渲才收拢。Muster 阶段 5 已实施双向范围渲染，替代早期仅尾部回填的阶段性决定。


### 注入与压缩历史的按需读取

GUI Worker range 只携带当前正文页所需的注入摘要与压缩记录；`AgentSessionSurfaceStore` 按实际消息 ID 持有生效摘要及锚定的压缩记录，重叠范围覆盖同一 ID 的数据；`PageMapCoordinator` 淘汰正文后同时释放对应元数据，尾页游标滑动不累计重复信封。没有正文或元数据变化的窗口保留操作保持注入数组、压缩标记数组与 Harness 快照的引用稳定，符合 `useSyncExternalStore` 的重读契约，避免首屏保留窗口与 React commit 互相触发无限更新。实时注入仅接收单条摘要，保留有界尾部；不再通过事件复制完整注入历史。摘要含来源、字符数和工具数量，不含提示词全文。

`HarnessInjectCard` 使用现有 `AnimatedDetails`：展开后经 surface 的 `injectionDetails` 读取单条全文，显示读取/失败/重试；折叠即释放全文并使在途回执失效，记录或会话切换不会显示旧详情。哈希与内部引用不作为界面内容展示。

开启透明模式时，可见窗口内带发送记录的用户行通过 `agentSession:engineInput` 按引用读取提交文本。气泡以纯文本显示，复制按钮复制当前显示的内容。注入快照只在缺少发送记录的消息处按需展开，压缩标记显示在实际发生的位置。消息正文仍是用户原文，供查找、重发及分叉使用。详见 [Harness 透明模式](trajectory-view.md)。

组件回归见 `test/unit/harness-metadata.spec.tsx` 的失败重试、折叠释放、迟到回执和正文页淘汰，以及 `harness-annotations.spec.tsx` 的旧消息快照加载。`test/e2e/acp-tool-display.spec.ts` 通过真实 Electron 验证透明模式直接展示发送原文。
