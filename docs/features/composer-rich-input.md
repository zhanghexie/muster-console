# Composer 富文本输入（contenteditable 原子 token）

功能职责：agent 输入框（AgentComposer）的输入核。以 contenteditable div 替代旧
textarea+镜像层，token（批注N / @文件 / /技能 / Worker 模型引用）是 `contenteditable=false` 的原子胶囊：
backspace 整颗删、光标自动跳过、中性纯色底/行内 × 按钮。设计取舍与实施过程见
composer-contenteditable-plan。

另含底部栏（`.agent-composer-toolbar`）的状态控件与窄面板降级，见下文「底部栏」节。调度、GUI 和展开的 CLI 输入框在底栏显示[用户待办提醒](session-reminders.md)入口，展开的面板可以覆盖输入区。

底栏按主次统一尺寸：辅助触发器共用 24px 高度、14px 图标、`--font-caption` 字号与 `--radius-control` 圆角；加号和队列为 24px 方形点击区，文字控件保持自适应宽度。发送/停止是主要动作，单独使用 32px 方形按钮和 18px 图标，与辅助控件底部对齐。尺寸规则限定在底栏，不改变菜单项、顶部建议或其他表面的按钮。发送中的品牌加载图案保留原尺寸。布局分组、颜色、权限与发送行为不变；窄容器仍按既有四档规则降级。生产组件 Chromium 几何回归入口为 `test/composer-toolbar-sizing-visual.mjs`。

## 关键文件与入口

| 文件 | 职责 |
|------|------|
| `src/renderer/src/components/ComposerEditable.tsx` | 输入核组件（uncontrolled contenteditable + imperative handle：focus/getText/getCaret/setCaret/insertText/insertToken/replaceRange） |
| `src/renderer/src/components/composerDomText.ts` | DOM 纯文本视图：文本/原子 token/br/原生 div、p 行块的统一序列化与光标偏移；空行占位 br 不重复计换行 |
| `src/renderer/src/components/composerMarkdown.ts` / `composerMarkdownDom.ts` | 输入内标题/有序/无序列表解析、换行续写/退出；保留源标记的行级呈现、原子引用节点和选区往返 |
| `src/renderer/src/components/AgentComposer.tsx` | composer 编排壳（输入核的消费方；排队面板见 [send-queue-panel.md](send-queue-panel.md)）。实现体按职责区块拆在同目录 `agentComposer/`（2026-09-26 拆分，对外导入路径不变），本文件只做钩子装配与余量 JSX |
| `src/renderer/src/components/CliSessionView.tsx`、`useCliComposerPlacement.ts`、`cliComposerPlacement.ts` | CLI 面板内可拖动贴边的胶囊与可调尺寸的悬浮输入区，复用输入核、草稿桶和批注桥；不接管 CLI 自身快捷键或斜杠命令 |
| `src/renderer/src/components/agentComposer/composerTypes.ts` | `Props` / `ComposerPreset` / `ComposerPresetItem`（类型单源） |
| `src/renderer/src/components/agentComposer/composerHelpers.ts` | 纯函数：触发词解析 `findTrigger`、命令判定（`isUnsupportedSlash` 等）、菜单装配 `buildSlashItems`、用量展示 `deriveContextUsage`、`formatTokenCount`（`test/composer-helpers.mjs` 锁行为）；`MODE_META` 数据驱动词条 |
| `src/renderer/src/components/agentComposer/useComposer*.ts`（`useComposer` 前缀 **7 个**钩子）+ `useTosendQueue.ts` / `useQuickInputPhrases.ts`（不以该前缀命名，同目录合计 **9 个**钩子） | `useComposerDraft`（草稿回灌/落盘/事件同步，echoValue=applyValue 命令式重建）、`useComposerSlashMenu`（触发菜单数据面：技能 `agent.listSkills`、文件 80ms 防抖、replaceTrigger/insertAtCaret）、`useComposerSubmit`（submit 本地命令拦截/busy 手动清单分流/图片快照回滚 + onKeyDown）、`useComposerCommands`（applyItem/runClear/runCompact）、`useTosendQueue`（手动确认清单 + 排队面板动作）、`useQuickInputPhrases`（/quickInput 命令态）、`useComposerMenus`（底栏五菜单开关 + preset roster 现拉）、`useComposerImages`（图片附件）、`useComposerInsertions`（composerInsert/pendingInsert/拖放/onEditorChange 热路径） |
| `src/renderer/src/components/agentComposer/` 其余在役文件 | `useSystemShortcuts.ts`（加号面板系统快捷操作：列表拉取/执行反馈）、`composerNotice.ts`（输入区失败/被拒提示唯一出口——`notify:toast` IPC 弹桌面 toast，见 [notification-system.md](notification-system.md) §2）、`focusBucket.ts`（最近聚焦草稿桶模块单例：定向插入只投目标 composer，不广播）。记忆/审核不再通过 `composerOverride` 挂载第二套输入框，而是直接使用 `AgentComposer` 并由 surface caps 关闭不适用能力。 |
| `src/renderer/src/components/agentComposer/Composer*.tsx`（输入和菜单组件） | `ComposerTriggerMenu`（@文件 / 命令与技能候选）、`ComposerQuickInputPanel`（快捷短语）、`ComposerAttachBar`（图片条+隐藏 file input，另导出 `ComposerCommandChip`）、`ComposerToolbarLeft`（加号、权限、Core 模式菜单）、`ComposerContextUsage`（用量环）、`ComposerModelCluster`（Harness 标识与模型簇，复用 `ModelPickerLayout` 的分列和参数选择，保存搜索和定位等界面状态）、`ComposerThinkingChip`、`ComposerSendButtons`、`ComposerDraftCapsules`（草稿参数胶囊）；业务状态经编排壳钩子注入 |
| `src/shared/composerSkills.ts` | 技能菜单收录 + `/skill:name` 展开（与 Pi `_expandSkillCommand` 同形态；`test/composer-skills.mjs`） |
| `src/renderer/src/components/ComposerImageStrip.tsx` | 输入凹槽内待发图片条：缩略图点开 ImageLightbox，× 移除 |
| `src/shared/composerTokens.ts` | 纯文本→token 分段（草稿/外部写入重建 DOM 时定位 批注N），`test/composer-tokens.mjs` 锁行为 |
| `src/shared/workerModelMention.ts` · `agentComposer/useComposerModelMention.ts` | 模型引用的可持久化表示、编辑和发送前校验 |
| `src/renderer/src/chatSurface/useSessionNotes.ts` | 批注编排：token 进草稿（经重建渲成胶囊）、对账双删、发送展开 |
| `src/renderer/src/styles/chat.css` | `.composer-editable` 排版（与旧 textarea 逐项对齐）与 data-empty placeholder |
| `src/renderer/src/styles/float.css` | `.composer-token` 原子胶囊样式（note 绿 / file 蓝 / skill 紫，悬浮 × ） |

## 数据流（同步回路）

桌面新建任务直接挂载聊天使用的 `AgentComposer`。创建表单顶部的运行位置、工作区隔离与名称共用行高和边距，窄窗改为纵向排列。创建态的斜杠命令、文件候选、快捷短语和加号菜单共用编辑器上沿作为垂直锚点。浮层与输入框间隔 4px，最多高 260px，空间不足时缩短列表并在列表内滚动。工具栏的权限、启动模式、Harness 选择面板都在各自按钮上方 4px 处展开，上方空间不足时面板内部滚动。权限和模式与按钮左边对齐，Harness 与按钮右边对齐，窄窗时向视口内收。权限复用聊天输入框的配置开关和档位行。启动模式仅在引擎支持时显示，使用公共选择器。Harness 复用聊天模型浮层，GUI / CLI、模型和参数在其中切换，确认后才写回任务草稿。打开或关闭列表时，表单和编辑器保持原位。创建时每次打开都有独立草稿，正文、附件和编辑器在浏览 Harness 时保留。普通 Enter 换行，⌘Enter 或 Ctrl+Enter 启动任务或保存定时定义。输入法组词和当前候选菜单优先处理按键。加号、快捷短语、文件引用和技能沿用聊天编辑器。技能查询使用所选源根与目标引擎，原生技能写作 `/skill:name`，其他引擎使用带路径的技能引用。扩展声明的技能保留原始命令。已有会话的停止、消息队列和插话由会话入口提供。

- **用户输入**：DOM 变化 → `input` 事件 → serialize + 一次 caret 度量 → `onChange(text, caret)` →
  AgentComposer 写 `valueRef` + `setDraft`（300ms 落盘）+ `onValueChange` + findTrigger 刷菜单。
  **普通打字不 `setValue`**：输入核本就是 uncontrolled，每击回写会让整棵 Composer（底栏/
  排队面板/菜单）重渲。只在空↔非空（发送钮）或命令态搜索时才回写 React state。
- **外部写入**（草稿事件 / composerInsert / 快捷短语 / 清空）：`applyValue` 回写 state，
  并经 handle `setText` 命令式重建——因为 value 可能已是目标串（按键没回写），React
  bail 不会触发 `value` effect。`value` prop ≠ `emittedRef` 时也会重建（草稿回灌）。
- **GUI/调度发送契约**：serialize 产物是「批注N / `@path ` / `/skill:name `」纯文本；
  发送前由 `noteAnnotations` 按完整 token 单次展开，避免编号 1 匹配编号 10、或递归替换引文内文字。
  手动入队先固化正文和 `noteDraft`，取回时恢复批注表并避让编号；队列正文发送不再展开，
  见 [send-queue-panel.md](send-queue-panel.md)。菜单插引用 = token 节点 + 一个空格文本
  （保持 `@path ` 形态）；草稿回灌时 @path 不反向 token 化（无法校验路径真伪）。

## 交互与已知边界

- **多根 @ 引用**：`workspace.listFiles` 按所有登记源根有界查询；候选以 FileRef 为 key，多根标签使用 `根名/相对路径`，副文本显示完整来源路径。胶囊 label 与 `data-token` 分离，发送仍为 `@源根绝对路径 `，同名相对文件不会混淆。80ms 防抖请求带 requestId；查询改变、菜单关闭/卸载和源根版本变化取消旧请求，并丢弃晚到结果。根级失败保留其余候选并提示来源，截断提示缩小范围；多根下拒绝没有 FileRef 的旧候选。队列/草稿仍保留纯文本且不反向 token 化 @ 引用。

- 换行的发送/草稿契约统一为 `\n`。Enter 发送/选择候选，Shift+Enter 换行；键盘及
  `beforeinput insertLineBreak` 共用续写逻辑。有序列表沿当前编号递增，无序列表沿用
  原符号和缩进，空列表项再次换行退出；标题后换行为普通行。正文开头 Backspace
  移除当前行格式，Home 落在正文开头而非隐藏源标记内。IME 合成期不格式化、不提交。
- 输入区直接呈现 `#`–`######` 标题和有序/无序列表，源标记由行级 `data-prefix`
  属性承担（`measure()` 在行内容前合成等长虚拟偏移，序列化/复制/发送语义不变），
  列表标记由行级伪元素呈现；不另挂预览层。代码围栏中的标记保持字面值。
  2026-10-07 报单②：源标记曾是**零字号内联 span**——Chromium 的 caret 度量取相邻
  内联对象样式，空列表项行（前缀 + 占位 br）里所有元素边界位的光标都被毒化为
  0 高度（不可见，原生点击落点也一样；jsdom 无法复现，回归见
  `test/e2e/composer-ordered-caret.spec.ts` 真 Chromium 闪烁探针）。修复：前缀
  移进行属性、零宽 span 彻底出内联流；前缀内部/首后偏移统一归位行首内容位。
  每次输入只更新输入核 DOM 和 refs，仍不回写整棵 Composer 的 React state；原子
  批注/文件/技能节点原位迁移，装饰 label/× 不进入正文。复制/剪切输出 Markdown 源码，
  跨行替换按序列化范围重建，避免原生空行块残留。发送后 parts 与旧 content 路径共用
  MarkdownBody，普通软换行也保持可见，不更改发送正文。
- 粘贴一律 preventDefault：文件走 `onPasteFiles`；明确的本机文件类型或文件 URI 优先走本机文件剪贴板，其余取 text/plain 插入；无文件和文本时也尝试本机文件剪贴板——外部
  HTML 永不进 DOM。文件/路径拖放由容器 onDrop 接管，文本拖入按纯文本插到落点。
- 行级呈现会重排原生编辑节点，因此输入核统一维护有界撤销历史（至多 100 步，历史
  DOM 总量约百万字符，至少保留最近一步）。连续输入合并，换行、粘贴、引用插入、剪切及
  IME 提交独立记录；Ctrl/Cmd+Z 撤销，Ctrl+Y 或 Ctrl/Cmd+Shift+Z 重做，正文、选区和
  原子引用一起恢复。外部草稿回灌/清空会重置历史，避免恢复已发送或其他会话的草稿。
  浏览器 insertText 只负责原生文字输入，不再依赖其 undo 栈。
- 删除护栏：Chromium 默认整颗删非编辑节点；`beforeinput deleteContent*` 另有
  getTargetRanges 护栏，删除边界切进 token 时扩为整颗。格式行的源前缀不可被原生选区选中；
  当选区覆盖全部可见正文时，删除按完整源文本清空（含虚拟前缀），并保留撤销历史。
  删除胶囊后的末尾空格时，Chromium 可能在胶囊后补一个未标记的 `br`；该行尾占位不计作换行。
- placeholder 由 `data-empty` 驱动。删光未提交的拼音时，Chromium 可能直接在编辑区根节点留下单个 `<br>` 光标占位；序列化按空草稿处理，合成结束后清掉占位并恢复可用的建议预览。显式换行仍由行块边界表示。
- 全局快捷键宿主（KeybindingHost）已把 `[contenteditable="true"]` 视为可编辑目标，
  输入框内打字不受全局快捷键劫持。
- `/` 与 `@` 补全菜单经 `useOverlayDismiss` 接入全局关闭栈，Escape 先关闭当前菜单；
  未变化的文本/光标不重新计算触发词，避免 keyup 重开。再输入或移动光标可重新发现。
  `test/unit/agent-composer-skills.spec.tsx` 与 `test/e2e/workspace-skills.spec.ts` 覆盖关闭后原文发送。
- 建议回复仅在草稿完全为空时以独立灰字层预览；顶部最多显示 10 个字符的胶囊或 Shift+Tab 循环切换候选，Tab 作为一次可撤销编辑接受，已有草稿包括空格时不覆盖。建议组末尾可清除当前一组，失败恢复提示，待答问题不受影响。长候选省略显示，悬停提示保留完整内容；命令菜单与快捷短语的 Tab 优先，IME 合成期不处理建议。数据来源、会话隔离及调度问答见 [建议胶囊与回复补全](suggestion-capsules.md)。
- 回归：`test/unit/composer-live-markdown.spec.tsx` 覆盖输入内格式、续写/退出、选区替换、
  引用/撤销/IME/复制剪切；`test/composer-newlines-visual.mjs` 使用实际 AgentComposer 在
  Chromium 中按真实键盘验证输入与发送，覆盖深浅主题及 780/390px 两档。

## 底部栏（模式胶囊 / 用量环 / 窄面板降级）

布局：`.agent-composer-toolbar` = 左组（＋附件菜单、权限和 Core 模式菜单、后台任务胶囊）+
右组（用量环、模型触发器、自动入队/留待确认小按钮、发送/停止），`space-between`。

### 控件

- **加号系统快捷操作**：在设置 → 快捷键中配置名称和系统组合键，每次打开加号菜单读取最新项。
  点击后收起菜单，再通过当前平台适配器发送系统按键（Windows/macOS/Linux）；发送中阻止重复操作，失败在工具栏提示。
  多项菜单限制高度并滚动。配置/IPC/平台边界见 [快捷键系统](keybindings.md#系统快捷操作)。

- **权限与模式**：GUI 权限菜单使用紧凑图标行，说明通过信息图标提供；当前档位标记选中，引擎未接通的档位置灰。Panda 已覆盖的 Harness 和 Core 不再提供工作台旧权限作为新选择，当前旧档只以不可重选的旧权限状态显示；Cursor、Gemini 和自定义运行时保留原有选项。Core 自定义模式独立成菜单，打开时读取模式花名册，首条消息后锁定其他模式；调度面保留原有合并菜单。选择 Core 模式若定义了默认权限仍会同步该权限，部分 Core 模式会带入旧档。权限策略和各引擎支持边界见 [GUI Harness](gui-harness-integration.md)。
- **用量环**（`agent-ctx-ring`，button）：SVG 圆环，hover tooltip；点击弹**纯展示**
  详情菜单 `agent-ctx-menu`（百分比大字 + 已用/上限的精确 token 数 + tokens 未知注记）；状态条使用十进制 k/M 缩写，缺少可靠数据时不构造百分比。
  数据只有 `ChatUsageInfo {tokens, contextWindow}`，**没有手动压缩/清理上下文能力**
  （pi 仅自动 compaction 生命周期事件，未透传渲染层），故菜单无操作项。
- **模型触发器**：GUI 会话始终显示当前 Harness 品牌图标和模型名，菜单仅供模型及参数选择；ACP 优先显示会话实际 agent 的图标，未知身份使用字母占位。调度面在全图标档显示立方体。
  模型菜单按模型和参数分列并可搜索；GUI 会话按对应 Harness 的「可选模型」筛选，隐藏项不会替换已有会话的当前模型，默认模型仍可选。通用参数和调度思考档通过共用 `ModelPickerLayout` 纵向显示。调度思考档取当前模型声明的产品档，不用脑图标推断档位；设置影响当前工作区、下回合生效。旧 Cursor 参数胶囊（`agent-param-wrap`）仅在尚无通用参数描述时保留；未提供档位目录的旧思考接口继续保留独立胶囊。

### 窄面板降级（容器查询，按底栏自身宽度而非窗口）

`.agent-composer-toolbar { container-type: inline-size }`，chat.css 末尾 `@container` 分档：

| 档 | 触发 | 变化 |
|----|------|------|
| L3 | ≥600px | 全文字（默认样式） |
| L2 | 360–599px | 环去文字、旧思考胶囊只留图标、模型名截断（max-width 110px） |
| L1 | <360px | 权限和模式胶囊只留图标、GUI 模型只留 Harness 图标（调度面为立方体）、模型参数胶囊隐藏 |
| L0 | <300px | 兜底按序隐藏：后台任务胶囊 → 思考档 |

配套收缩安全网：左右两组 `min-width:0` 且可收缩，胶囊/模型文字一律
`ellipsis` 截断——即使档位间隙内超出也截断而不重叠（历史 bug：右组 `flex:none` +
子项不可收缩导致窄面板左右两组文字物理重叠）。

已知边界：极窄下被隐藏的旧控件（后台任务/旧思考胶囊/旧 Cursor 参数胶囊）没有替代入口，面板宽度
恢复即回来；上下文环详情菜单数据为快照值，不做实时刷新。

## 悬浮输入条（盖在会话流上）

`.chat-surface-view` 里输入条不再占 flex 底栏：`.agent-chat-composer-wrap` 绝对定位贴底，
会话转写铺满剩余高度并从输入条下方滑过。wrap 自身即阅读列：`width: min(--chat-col-max,
100% - 2*--chat-col-inset)` + `left/right:0` + `margin:auto`，与消息列 `.agent-chat-col`
同约束——不能量 `getBoundingClientRect` 写 left/width（调度浮窗进场 `scale` 会把视口
坐标量脏，动画结束不重测，输入框偏左）。wrap（`.agent-chat-composer-wrap`，输入条外层容器；其 `background` 即防漏字的遮挡层）
`bottom:0` + `padding-bottom: var(--composer-dock-inset)`：输入条离窗口底有间距，背景
（`--composer-fade: var(--bg-panel)`）盖住底 padding 区。GUI 对话页与调度浮窗都用阅读面同色实底，不再挂模糊伪元素；输入条背后和底部间距都不会漏出滚过的文字。GUI 会话与调度浮窗的 wrap 比阅读列左右各宽 `--composer-cover`（6px），
正好盖住贴列边的头像。水平居中一律按「滚动条透明」算：转写 `scrollbar-gutter: stable`
只在右侧留常驻槽，`.chat-list` 左 padding 补偿一槽宽（槽宽非定值——thin 随引擎/系统变，
由 `ChatSurfaceView` 布局时实测 `offsetWidth-clientWidth` 写入 `--chat-sb`，禁止 CSS 写死，
旧 `right: 8px` 即因此错位），消息列中轴恒为视口中线，滚动条出现与否都不移轴。
wrap 宽度（2026-10-10 用户定稿）：`min(阅读上限+2*cover, 100% - 2*dock-inset)`——
**左右可见边距 = 底边悬浮间距（14px），压到最窄时三边一致**；不再按槽宽收缩
（dock-inset 14 > thin 槽宽 ~11，滚出的滚动条与输入条右缘仍留 ~3px 空隙）。
此前的模糊带和透明垫底均已移除；轨迹页由壳挂
`.chat-surface-view.is-trace` 改成 `--bg-panel`（与 `.trace-view` 同色，避免 dock 区露出黑条）。
上沿 `border-radius: var(--radius-composer)` 与 `.chat-input-shell` 同角；会话输入框独立使用
`--radius-composer: 20px`，不再跟随页面与弹窗的 10px 圆角，高度与间距保持原值。
`--composer-overlay-h` 含 dock padding。无顶沿渐隐遮罩。`--composer-overlay-h`
+ `--composer-scroll-gap`（24px）给转写 `padding-bottom` 与跳底浮钮让位。待发图片在
`.chat-input-shell` 内（`ComposerImageStrip`），点缩略图开 `ImageLightbox`。
`test/composer-overlay.mjs` 锁上述契约。

**输入条族材质**：`.chat-input-shell` 是唯一外轮廓，使用 resolver 的 `--surface-input`
（内置浅色由淡灰 `bg-input: #f2f3f5` 派生，与白色阅读面区分；深色仍使用原 `bg-raised`）
与完整的 `--border-control` 四边描边；空/非空不改变表面或轮廓。focus-within 同时将四边
提高到 `--border-focus`，材质规则不得单独覆写顶边。深色 `--shadow-input: none`，靠输入底色与阅读面的明暗差成形；浅色保留主题 `shadow-input` 的轻投影（内置为 `0 2px 8px rgba(20, 24, 34, 0.04)`），配合淡灰输入底色与白色阅读面形成轻微层次。静息与聚焦共用该投影，聚焦只改变描边，不叠加光晕。
输入、菜单与浮层按实际所在面映射 `input / overlay` 前景、选中与状态 context，不在 CSS
继续混色。发送/停止共用 `--action-bg / fg` 及 hover/pressed 配对；调度浮窗打开非活跃
项目时只从同一 resolver 取得目标项目的 action 色，不改当前阅读面或默认头像。

内部从上至下为顶部状态栏、展开的排队面板、附件与编辑区、工具栏。
顶部状态栏将会话建议、收起的队列胶囊和 `/quickInput` 命令胶囊放在同一行，共用 28px 高度、caption 字号、中性纯色底与胶囊圆角；窄面板自然换行，无状态时不占空行。各胶囊上间距随各自的 `acc` 折叠，避免卸载时高度跳变。`QueueSendPanel.renderHeader` 将收起胶囊交给编排壳装配，独立队列用法仍保留原布局；命令胶囊独立使用 `usePresence` + `acc`。最后一个附件移除时，附件条也保留快照并折叠退场，退场期间不可交互，可中途恢复。「加入自动队列 / 留待确认」是发送旁的紧凑图标，Enter 去向放在发送/停止提示内。
草稿动作常驻，空草稿或输入锁定时禁用，不再随首字输入/清空播放展开动画，避免输入区高度跳动。
队列透明平铺，胶囊使用所在面的 `--interaction-hover / selected-hover`；GUI 与调度共用。输入壳在深浅模式下均读取一次解析的 `--surface-input`，保持项目色的低强度混入和清楚的控制边界。禁用控件使用 `--fg-disabled`，不再通过整颗透明度反复降低文字对比。
取回排队消息时追加到已有文字后并合并图片（按 id 去重），保留正在编辑的草稿。
输入区整体仍由现有 ResizeObserver 测量，队列与建议的开合高度一并计入转写底部让位。
`test/composer-material-css.mjs` 与 `test/unit/composer-solid-layout.spec.tsx` 覆盖材质、真实组件
接线、取回文图不覆盖草稿、队列菜单/键盘/拖拽和收起焦点。


## 问答、快捷短语与批注的统一材质

- 底栏发送/停止为 32px 主题色主按钮，留待确认和自动队列为 24px 中性辅助按钮。悬停提示实际动作及 Enter 去向；空草稿只禁用。上沿状态不存在时没有 padding，存在时由统一状态栏承担间距。
- 问答使用 `UserQuestionCard`：待答、已回答和已取消共用紧凑卡片，`chat-card-header` 表头最小44px、raised底色、28px问答图标底座，左侧「Agent 提问」、右侧中性状态标记和多题页码；内容区使用canvas及配对前景/hover，外框20px圆角、细边、无阴影。题干、选项和已答答案统一使用control字号，已答题目/答案用文字颜色区分，不额外放大或加重答案；选项细描边、中性选中底与圆形/方形标记，`aria-pressed` 同步选中，标记不再用内阴影；自定义输入使用input底色和配对文字，底部分隔操作栏使用28px中性描边按钮。普通新消息成功受理后，调度挂起卡显示「已被新消息取代」并解除等待；聊天输入仅精确选项可快捷作答，批注与自由文本保持普通消息语义（详见 chat-surface.md）。已回答/取消为只读题目与答案列表，多题用细分隔，答案以细竖线突出。题目来源、分页、多选、自定义回答、提交/取消及审批语义不变。
- 快捷短语使用 `ComposerQuickInputPanel`：名称与单行内容摘要上下排列，编辑/删除在悬停或聚焦时出现，无 hover 设备常显；仍以主输入全文搜索、上下键导航、Enter/Tab 填入和 Escape 退出。搜索态禁止消息按钮发送查询词；浮层经 `useOverlayDismiss` 接入全局关闭栈，Escape 优先返回编辑列表/退出命令，避免背景弹层截获。
- 批注原子胶囊显示「批注 · 内容摘要」，`data-token` 和序列化仍保留 `批注N`。内容变更原位更新 label/title，不重建光标附近 DOM。聊天/文件/网页均消费 `NoteEditor`：简短来源标识（仅文件/网页）+ 多行 textarea + 中性取消/删除 + 明暗反色保存；Enter 换行、Ctrl+Enter 保存、Escape 取消，IME 合成期不提交。会话卡 portal 到 body，以零尺寸内容锚点定位，按实际高度、窗口 resize/滚动避让输入条；阅读区过矮时使用视口并保留可见操作。文件卡按实际尺寸/窗口 resize 夹回视口；网页卡保留截图让位。原文只保存在批注数据中供发送引用，不重复展示。
- 回归：`composer-note-tokens.spec.tsx`、`note-editor.spec.tsx`、`file-note-entry-host.spec.tsx`、`composer-queued-notes.spec.tsx`；实机装配/深浅/窄布局为 `test/e2e/composer-send-actions.spec.ts`。

## 表面层级

输入壳静息与聚焦均不画阴影（用户试看方案）；聚焦仅替换 input-focus-border，保持单圈边框。看板卡片保留原投影。参见 [表面悬浮层级](surface-elevation.md)。

### 品牌加载反馈

发送请求等待 onSend 确认期间显示单色三卫星环轨（圆形核心），防止重复提交；确认成功、拒绝或异常即结束动画，失败保留草稿。后续 busy 回合仍用静态停止按钮，不用运行状态驱动发送动画。详见 [品牌加载动效](brand-loading.md)。

## Worker 模型引用

在工作台调度、GUI 会话和受管 CLI 输入区键入 `/harness`。从斜杠菜单点击命令或按 Enter、Tab，打开与新建任务和当前会话模型共用的选择器。上下移动当前列，右键进入下一列，左键返回。最后有效列的 Enter 确认，`/` 聚焦搜索。GUI 与 CLI 分开选型，来源从当前会话或调度的可信工作目录取得。Escape 保留草稿并恢复焦点。IME 合成提交后显示命令候选，`@` 继续搜索工作区文件。

在普通 Core 会话、扩展 AI 侧栏和调度 Agent 输入区，`/record-requests` 在本地启动[请求录制](model-request-viewer.md)并打开面板。点击输入框右上角的「录制中」可重开面板。Tab 可补全命令，再追加 `view` 查看历史。

确认后，模型引用胶囊替换命令文本，展示 Harness、模型与所选思考强度。点击或聚焦后按 Enter 编辑，退格、Delete 或点 × 整颗删除，可撤销与重做。编辑器和已发送的消息可展开查看引用对应的简短委派调用。草稿、手动队列和宿主自动队列沿用 `[@model:…]` 原子表示，取回编辑或重载时按原引用恢复。

发送前校验当前来源和引用。过期时 Composer 保留草稿，在输入区提示点击胶囊重选。发送给宿主的队列正文仍包含原引用，宿主在向引擎实际提交时再次校验，展开为带 `targetRef` 的 `host.sessions.create` 调用提示。Worker 为当前会话创建子代理时同时传 `asSubagent: true`。每颗胶囊绑定一个委派配置。系统原生终端输入和远程网页表面没有模型引用选择器。

## 文件附件

Composer 的附件入口已扩展为任意文件；保留 `images` 命名兼容历史草稿/队列。普通文件显示名称/大小/移除，图片保留灯箱。FileReader 读取期间禁止发送和入队，读取失败显示提示；切换草稿桶后丢弃旧异步读取。系统文件剪贴板通过本机专用 IPC 兜底，网页端不会读取宿主剪贴板。

文件接收不再取决于模型图片开关：非视觉模型也可接收本地提取文字或路径。主进程转换与会话源文件管理见 [多模态输入](multimodal-input.md)。

CLI 悬浮输入区复用相同 `ComposerEditable`、附件条、`useComposerImages`、`useComposerInsertions`、`useComposerSlashMenu`、`useComposerCommands`、`useComposerSubmit`、快捷短语和加号菜单（含已配置的系统快捷操作）。正文最小容纳两行，随内容自然增高并共用 GUI 的 240px 滚动上限；用户只调面板宽度，旧版手动高度不再覆盖自然布局。输入适配器只列技能与 `/quickInput`，其他斜杠命令原样交给 CLI；`@` 文件和工作台路径拖放使用带引号的完整路径，显式选择技能时胶囊序列化为技能名与 `SKILL.md` 路径提示，避免依赖某个 CLI 的私有 `/skill:` 语法。技能发现按该 CLI 的实际入口及会话目录快照查询。CLI 菜单挂到终端面板内的独立浮层，按可用空间在输入框上下放置，避免被输入框的滚动裁剪；选项、快捷短语、输入面板共用现有在场和 Esc 规则。文件和图片待发条可折叠、重开，组件卸载后在同一应用运行期间按会话恢复；未完成的异步读取在后台继续，失败会在回到会话时提示。会话删除释放缓存并作废在途读取。尚未发送的附件只保存在渲染进程内，应用重启后需重新添加（文本草稿仍按原规则落盘）。

CLI 文件/技能引用使用带 JSON 字符串的可持久化文本格式。批注对账、孤儿清理、输入核回灌与发送展开都跳过完整引用区间，避免路径或技能名中的「批注1」被当成批注 token 删除或展开；其余正文中的批注照常处理。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D06.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：输入核 contenteditable：原子 token（批注N/@文件//技能胶囊整颗删/光标跳过）、输入内行级 Markdown（标题/列表直接呈现）、有界撤销历史/删除护栏/IME 纪律、底部栏控件与窄面板容器查询四级降级、悬浮输入条（盖会话流、三边距一致 14px）。
- 为什么这样设计：uncontrolled+imperative handle——普通打字不回写 React state（每击回写重渲整棵 Composer）；发送契约仍是纯文本 token 序列（批注按完整 token 单次展开，防编号 1 匹配编号 10）；外部写入走 setText 命令式重建（React bail 不触发 value effect）；粘贴一律 preventDefault，外部 HTML 永不进 DOM；源标记走行级 data-prefix（零字号内联 span 曾毒化 caret，e2e 真 Chromium 闪烁探针守回归）。
- 明确不做：不做 inline 加粗/斜体的输入内呈现（保持源码可见，不另挂预览层；代码围栏内标记保持字面）；当前草稿批注表内存态（重启丢表，队列 noteDraft 另存）；L0 极窄隐藏控件无替代入口（宽度恢复即回来）；上下文环详情纯展示（压缩走 /compact，不在环上清理）。
- 歧义点：输入内呈现范围止于行级（标题/列表）——A=终态（inline 格式保持 Markdown 源码原样，渲染职责归正文 MarkdownBody；contenteditable 双重呈现复杂度已有 caret 毒化教训）／B=逐步扩展 inline 呈现（加粗等实时可见）。推荐 A。
