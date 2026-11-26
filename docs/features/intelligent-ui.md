# 智能界面（会话内交互 UI）

宿主渲染失败的默认提示、已知状态保存/读取失败及发送动作的默认确认标题随界面语言显示；桥接回执、作者提供的标题与错误内容保持原始信息。

独立网页区的部件预加载脚本仍先校验真实用户激活，再向主进程转发动作。浏览器通过已有外观消息附带可选的本地化激活提示，切换语言时向现有 guest 更新；旧消息没有该字段时沿用原中文提示，旧部件可忽略新增字段。

新生成或更新的部件包含多语言运行时。会话内 iframe 与网页区 guest 的初始化/外观消息携带可选 `locale`，语言变化更新同一文档中宿主自有的默认标签、状态和可识别的运行时错误展示，不重建控件或修改输入；未携带该字段时保留原语言。作者提供的文字、外部错误和 `maUi.getDiagnostics()`/回执中的原始诊断不翻译。旧 HTML 已嵌入自己的运行时，保持原样；需重新生成或更新后才获得新运行时。`test/ui-widget-runtime-i18n.mjs` 守卫运行时中文来源、英文键、占位参数及错误来源，组件测试覆盖切换和状态保留。

`host.ui.render` 将交互内容保存到应用会话目录，返回可放入正文的 Markdown。生成/校验/沙箱、GUI driver 和 CLI 链路保留；运行时 v2 补可组合控件、状态与动作，修复展示与滚动。历史评估见 2026-10-13 报告，实施/验收账本见 完整修复计划。原计划的 DIL 说法是历史信息，当前 Codex 对照以评估的本机技能证据为准。

GUI Worker 首条输入和调度能力摘要提示用 `mermaid` Markdown 代码块说明流程、依赖和状态变化。用户需要筛选、调参或比较不同情景时，在实际提供 `ui.render` 的会话中提示使用交互部件。CLI 首条简报面向 Markdown 交付物提示 Mermaid，并指向可用的交互部件工具，部件显示在会话右侧页面。

## 入口与数据流

1. Worker 和调度均调 `host.ui.render({title,html,mode?,note?,update?})`，用公共组件与原生语义标签组成 HTML 片段，不向模型暴露 sessionId。GUI/PTY 绑定本会话 id；调度从可信 scheduler/workspace 调用作用域取得 `orchestrator:<workspace UUID>`，忽略参数中的目标身份。主进程生成 `userData/agent-sessions/<安全目录名>/ui/<n>-<slug>.<inline|browser>.html`。Worker 目录名保持原样；调度映射为 `orchestrator.<小写 UUID>`，点号命名空间不与 Worker 的字母/数字/下划线/连字符 ID 冲突，映射可逆且不含路径分隔符、盘符或相对段。render、update、inspect、存储列表共用映射，动作回执还原逻辑身份。缺失或非法宿主身份明确报错，不要求模型填写不存在的参数。新建与更新均在返回前执行有界运行时冒烟，原始异常及可得的行号回到 warnings；冒烟超时或不可用也明确告警。返回 `markdown/link/version/receipt/warnings?`，生成成功是 generated，冒烟不冒充用户表面已渲染。title/html 必填；旧 preset/data 及未知字段明确拒绝。
2. Markdown 插件将直接/引用式产物链接提升为独立块，避免 iframe/div/button 埋在段落内。工具结果支持直接对象、宿主 `{ok,result}`、MCP text 和 structuredContent。产物挂在对应 `ui.render` 工具片段之后，位于工具日志折叠体之外，因此折叠工具调用不会隐藏部件；助手正文中的重复链接降为普通文本，避免把部件再次追加到本轮末尾。代码引用/裸路径不抢输出位置。
   browser 模式的链接卡消费当前表面的文字和悬停角色；inline 内容区同时绑定 canvas 的文字与焦点边框，避免主题种子与实际底色错配。
3. inline 使用 `muster-ext` 只读协议和 `sandbox="allow-scripts"` iframe，在视口预载带内挂载。内容真实高度直接用于 iframe，不做 720px/60vh 截断；普通纵向滚轮传给所属会话，数字输入不会被滚轮改值。横向表格可横滚；专门地图/3D 区只有明确聚焦 `data-ma-wheel="local"` 才接管。
4. 用户主动收起/展开，宿主复用 `usePresence/acc`，iframe DOM 和参数保留，隐藏内容 inert。折叠和转交的滚轮先摘掉会话贴底跟随。显式折叠选择保存到宿主；切会话重挂会恢复。
5. 状态以原路径为身份，保存在相邻 `.state.json`。公开值是 modelContent；privateContent 保存恢复值/页签/排序等。字段增量按路径串行合并，默认参数注册不会覆盖其他表面的已存值；待回执期间的较新同步排队补应用。去重后的持久状态最多 256KiB，公开值不在恢复区重复落盘；读取时补齐运行时管理的 values，用户自定义私有对象保持原样。host.ui.inspect 和 maUi.stateUsage 给出字节占用；有界原子替换处理 Windows 短时占用。晚到写入不得重建已删除的会话目录。
6. 运行时先于作者脚本加载，捕获 error/unhandledrejection；ready/init 恢复状态，render 才表示渲染成功。degraded、作者错误、超时显示原因并提供重试/网页区入口，保存错误不冒充成功。10 秒未收到 render 时，无桥信号立即超时；已有 ready/state/resize 等活体信号则向同一 iframe 发一次 probe，最多再等 2 秒后才判失败，明确作者错误仍立即失败。后续无错误文本的 degraded resize 或同状态可见性回执不会抹掉该表面已捕获的原始异常；成功 render 或新版本清除旧错误。IntersectionObserver 区分预载与实际可见，回执分别记录 generated/mounted/rendered/degraded/failed、visible、error 和时间。同一产物可同时出现在多个卡片或网页中：主进程按卡片实例及真实 guest 身份独立记录活体回执，优先报告最近的可见表面；隐藏的挂载回执不能覆盖可见页面的 render。卡片卸载、guest 导航或销毁时释放对应来源，产物先被删除时只移除内存记录，不重建文件；进程重启后磁盘记录不能证明界面仍可见。
7. copy/openUrl/followup 统一校验并回执；动作由实际用户手势触发。followup=draft 追加已有草稿，mode=send 经现有宿主确认后发送。发送确认不会因 SDK 的短操作超时而迟到发送。GUI 多表面只由所属卡片表面认领。
8. 单文件浏览器页的专用 preload 连接同一宿主存储/动作；主进程只接受 webview，再按 sender 的真实 muster-ext URL 判断文件身份，网页不能另传文件路径。状态发布只送同文件的合格表面。用户主动在网页区打开内容会选择前台；普通 AI 开页和点击部件链接保持后台，动作来源在 IPC 入口捕获，不受异步状态读取或用户切页影响。更新产物通过该页面的操作队列刷新，主题、字体、可见性和宿主参数继续同步。CLI 划词和胶囊识屏保留为单文件备用入口；默认自动聚合展示见下节。
9. 下一 GUI 用户回合只将本会话公开参数/选择、路径和版本送进引擎，原用户转写保持原样。最多 8 项、12KiB；超限给 `requiresInspect` 和路径。`host.ui.inspect` 可按需读取公开选择和回执。privateContent 不注入模型。A3 登记 `worker.turn-prefix.ui-widget-state`，Pi 与 SDK 共用 Host.startTurn；CLI 按需 inspect。

## CLI 自动展示与会话聚合页

CLI 的 `host.ui.render` 在生成、冒烟及读取元数据完成后，根据宿主真实会话 runtime 判断 CLI/GUI。CLI 调用 `BrowserTabService.openUiSession`，按工作区和会话复用 `muster-ui://session/<sid>` 标签；关闭后再次生成会重建标签，重启恢复的同会话标签也会复用。`uiWidget:present` 请求当前会话的右侧工作区选择并露出该页，不切换用户正在使用的其它会话。GUI 保持正文链接与工具结果兜底展示。

这是右侧浏览器中的宿主内部页面，不给内部 URL 创建 webview。`UiSessionPage` 经 `uiWidget:list` 读取该会话产物，按序号排序，所有产物（含 mode=browser）都使用 GUI 同源 `UiWidgetCard` 以 inline 卡片排列，只包含交互 UI，不复制模型叙述、用户消息或工具记录；每个部件仍有独立沙箱 iframe，新增卡片不重挂已有卡片。`uiWidget:updated` 同时负责新产物追加和原位更新，更新使用原路径身份，保留参数、折叠和主题同步。自然高度与滚轮转交沿用 GUI 桥。新到内容会定位到对应卡片，列表读取错误显示重试入口；浏览器刷新会重新读取列表。

卡片动作使用 `uiWidget:session-action` 复用宿主现有网页动作处理：draft 回填所属 CLI 的工作台草稿并展开输入区，供用户编辑后发送；send 仍须用户确认，再经会话信箱投递。聚合页由所属卡片接收动作结果并定向回填一次；单文件 webview 则经 `uiWidget:draft` 按所属 runtime 路由到 CLI 或 GUI 草稿，避免直接写入终端或重复投递。切走聚合页时，仍保活的卡片立即撤销可见回执，忽略迟到的视口观察。切回后重新观察卡片的视口位置。

返回值新增 `presentation: {opened,url,tabId?,error?}`，usage 在打开成功时要求模型提示用户去右侧浏览器查看；打开失败时保留产物及 Markdown，warnings/usage 明确报告失败。opened 仅表示宿主已登记/激活页签，实际绘制仍以 receipt 为准。A3 登记 `worker.tool-result.ui-session-page`。内部页面不接受 browser DOM 工具（明确 capability_unsupported），模型通过 `host.ui.inspect` 读取状态；单文件产物页仍支持原浏览器能力。Windows/macOS/Linux 使用同一 Electron/React/IPC 链路，无新增平台命令。

## 可组合创作接口

HTML 是产物载体；作者可用声明式公共组件，不必重复手写交互和宿主桥。公共 `maUi` 提供 get/set/subscribe、getUi/setUi、getWidgetState/setWidgetState、whenReady 和 copy/openUrl/followup/sendFollowup；离线 `maUi.d3` 为固定 D3 7.9.0，`maUi.three` 为固定 Three.js 0.186.1（含 OrbitControls，`window.THREE` 为同实例别名），两者在作者脚本之前就绪，许可证随产物保留。Three.js 核心与 OrbitControls 经 esbuild 打包为内联 IIFE，无需 CDN 或模块导入；其他 addons 不在公共入口中。三维示例见 [three-demo.fragment.html](../prototypes/intelligent-ui/three-demo.fragment.html)，WebGL2 不可用时须显示失败原因；画布 resize、滚轮焦点和 GPU 资源释放由作者管理。

Mermaid 图使用 `<pre class="mermaid">...</pre>` 声明，也支持 `<div class="mermaid">` 和 `<ma-mermaid>`。生成器仅在产物包含 Mermaid 主机时注入离线 Pele bundle；运行时调用与聊天 Markdown `MermaidBlock` 相同的 `pele.render` 引擎，主题色和字体经 `--pele-*` 变量跟随宿主。解析成功后源码替换为 SVG，并通过现有 resize 回执更新 iframe 自然高度；语法未完成或无效时保留源码回退，同时上报可恢复诊断，不卸载整个部件。外观变化会重新渲染已声明的图。

产物 CSP 允许 `data:`/`blob:` 内嵌图片，外部图片、脚本和网络请求仍被禁止。图片或 Mermaid 都必须以内嵌 HTML 资源/源码提供。

20 个公共组件：布局/内容为 ma-stack、ma-row、ma-grid、ma-card、ma-text、ma-badge；表单/动作为 ma-input（含 number/date/textarea/password）、ma-select、ma-checkbox、ma-slider、ma-button；分区为 ma-tabs、ma-details；数据为 ma-table、ma-chart、ma-list；复合输入为 ma-date-range、ma-cascade、ma-tree、ma-file。共享 name/bind/filter/selection 支持筛选→列表/图表→详情→继续提问。

- ma-text 静态文本依次使用 value 属性、text 属性、子文本（显式空 value 保留）；ma-badge 也支持 text 属性。bind 有值时优先使用状态，无值时使用显式 fallback 或静态文本。ma-text 的 expr 自动读取共享输入、计算与恢复，name 发布原值供后续输出/按钮引用；format/digits/currency/unit 统一显示，variant=metric 配 label/trend/tone。支持严格相等、字符串拼接、len/count/includes/concat/lower/upper/trim 与原数学函数；有界 AST 与函数白名单，不 eval；除零、缺参、循环或非有限值就地显示可恢复错误，清除失效的命名结果。私有依赖自动传递到结果。
- ma-select appearance=segmented 复用原生 option 和共享状态；方向键/Home/End、单一 tab 停靠点与禁用项跳过。
- ma-table 的 data/comparison/details 共用筛选/搜索/选择/插槽与格式化；比较推荐列/语义标签，详情键值对象/行标题。只有 data 默认排序；没有三个独立的表格实现。page-size 默认50、可选1–200，分页/排序/筛选保留选择并在查询变化时回首页；selection-value=id 或 selection-mode=multiple 仅保存稳定 ID。stats 输出总数/筛选数/选中数/页码等轻量统计。virtual 使用320px局部视口、40px固定行与前后缓冲，DOM 行数随视口有界；仅适用于无自定义单元格/操作插槽的 data 表格，其他情况明确报错并建议分页。虚拟区聚焦后才接管垂直滚轮。选择初值 null，可 private。原有 ma-chart 支持真实容器宽度、单位/标签/tooltip、系列切换和零值/负值/单点。
- ma-list 的 plain/steps/checklist 共用数组或 {rows}、筛选与搜索；项含稳定 id、label、description、status、date、progress、disabled。清单保存完成 id 数组，步骤 completion 可引用它联动；已完成进度显示 100%，取消勾选恢复数据进度（取消初始已完成项为 0%）。更新完成状态保留勾选节点和键盘焦点。原生 data-ma-bind 单选按 value 匹配选项，不改写各选项值。

字段与完整例子按需读宿主私有的 [ui-widget-design 技能](../../resources/skills/ui-widget-design/SKILL.md)；当前契约见 [contract](../prototypes/intelligent-ui/contract.md)。[composed-demo.fragment.html](../prototypes/intelligent-ui/composed-demo.fragment.html) 展示筛选/图表/详情，[convenience-demo.fragment.html](../prototypes/intelligent-ui/convenience-demo.fragment.html) 展示无作者脚本的计算、分段选择、指标、比较/属性表、步骤/待办。创作入口只有 HTML 组合，没有九型分发器、模板别名或递归 JSX 解释器。

主题使用宿主 getResolvedAppearance 的颜色角色与计算字体 token，订阅 appearance/uiFont，传完整 cssVars 和字体样式表。会话 inline 产物展开时以 `surface-canvas` 覆盖整个外壳及左右/底部留白，1px `border-subtle`、20px `radius-chat-card`，无阴影，内容左右/底部留白12px；顶部栏与审阅卡共用 `chat-card-header`，最小高44px、内边距6px/12px、raised底色和细分隔，左侧 `IconSliders` 使用28px图标底座，右侧展开/收起与审阅操作共用28px细描边按钮及hover/focus/禁用样式。尺寸由 base.css 的 `--chat-card-header-*` 统一；折叠时保留同高表头并去掉内容留白。中间内容区与 iframe 正文使用会话同源的 `surface-canvas` 背景及配对文字/hover；生成文档的 `body.ma-artifact`（含 `html.in-frame`）实际使用 `bg-card` 绘制背景，因此 appearance 桥将 `bg-canvas` 与 `bg-card` 一并映射到 canvas，避免 iframe 的灰底覆盖内容区；宿主仅顶部栏使用 raised，其余外壳与内容同色，避免两侧露出灰条，已有产物无需重新生成。加载占位同样使用 canvas；独立网页仍使用原 canvas 映射。窄网格改为单列；图表重新计算几何和刻度，不整体缩小文字。公共控件使用原生语义/键盘；页签支持左右键/Home/End，表格排序按钮保留焦点。仅改变表面样式，保留自然高度、加载监督、参数和折叠行为。

HTML 静态检查会对 ma-text/ma-badge 的非法 tone 告警，并列出 success/danger/warning/info/neutral。任意原生 HTML 与 data-* 属性仍由作者管理，没有通用的未知属性拒绝器；旧 preset/data 的严格字段诊断已随接口移除，不能把新 HTML 接口的宽松属性当作旧路径已修复。

## 表达式、诊断与复合控件

用户反馈的 count/严格相等/字符串、条件 tone、错误定位、状态容量及大表问题已进入统一运行时实现。表达式仍有4096字符/512token/32层边界；sum及条件count最多10000项，字符串结果最多65536字符。`+` 遇到字符串采用拼接，`==` 保留数值宽松比较，`===`/`!==` 使用严格类型比较。`count(array,"status","done")` 可做有界计数；大表统计直接读 stats，不把数据源复制进状态。

ma-text 与 ma-badge 支持 tone-bind/tone-expr，计算后仍校验五种合法语义颜色。组件的 build/refresh 编译和求值错误统一就地显示，并以诊断记录携带 code/component/id/name/attribute/expression/position/hint；恢复有效输入或移除控件会清除对应诊断。`maUi.getDiagnostics()` 可读取当前诊断。host.ui.render 的冒烟同时返回 warnings 与有界 diagnostics（最多3项、长表达式带 offset/length 摘录、明确 omitted 数）；相同消息来自不同控件时不会合并为一个。模型出口按包含 ok/result 的最终 JSON 计算 12,000 字符预算：短回执原样返回；转义后的诊断/告警过大时，`shared/interfaceToolResult.ts` 仅缩短已知文字字段，以 `modelReceiptTruncated: {reason:'tool-result-budget', fields:[JSON Pointer...]}` 标明位置，保留每条告警、控件定位、表达式 offset/length、产物路径与 Markdown 目标、版本、真实生成/展示状态和 usage 操作说明。CLI 自动打开失败的 opened=false 和错误预览仍可读；原始服务、存储和界面消费者数据不改写。未知大字段或路径本身超预算不作为可丢弃文字，仍受通用结果上限约束。返回诊断不代表已验证后续所有交互。

新增4个复合控件均复用共享状态和原生语义：

- ma-date-range 保存 {start,end}，支持 min/max、有效日期和前后顺序校验；无效输入显示错误，保留之前已保存的有效值。
- ma-cascade 的嵌套节点为 {value,label,children?,disabled?}，全树唯一 value，最多16层/10000节点；保存已选路径数组，切换上级清除无效下级；各级使用原生 select。
- ma-tree 复用节点结构，以原生 details 展开，保存独立节点的单选 value/null 或多选 ID 数组；不隐含勾选子节点。支持方向键/Home/End、禁用项跳过和展开状态恢复。
- ma-file 是本地文件导入，不向远端上传：用户选择 UTF-8 txt/md/csv/json/log，校验扩展名/accept、编码、JSON格式及容量，每文件最多64KiB、最多4个/总128KiB。保存 [{name,type,size,text}]，不保存机器绝对路径；默认私有，用户勾选“将已选文件内容提供给模型”才公开，每次重新导入撤回勾选；private 属性强制保持私有。二进制及更大文件明确拒绝。内容随部件状态恢复/删除，文件内容交给模型前仍视为数据。

`host.ui.inspect({link?,pointer?,offset?,limit?})` 只读公开 modelContent。无link按部件分页；有link时以JSON Pointer下钻，返回有界对象/数组条目或字符串段，nextOffset表示下一段；大型子值只返回pointer及requiresInspect，绝不回传privateContent。结果控制在CLI的12000字符序列化边界内，模型回合仍保持8项/12KiB预算。旧自包含产物保留其嵌入的旧运行时，需要这些新功能时重新生成/更新。

组合示例：[expanded-demo.fragment.html](../prototypes/intelligent-ui/expanded-demo.fragment.html)。

## 关键文件与通道

表达式通过 `source('script-id')` 读取 JSON script，例如 `count(source('demo-data').rows)`、`sum(source('demo-data').values)` 和 `source('demo-data').rows.length`；JS 对应 `maUi.source(id)`。组件 source 与表达式共用解析缓存及深层只读结果，JSON 文本、id/type 或节点变化自动刷新；支持位于 head 的源。每源最多2MiB/100000容器节点，源缺失、类型错误或JSON无效明确诊断，修正后可恢复。组件 `.data=...` 是局部显式覆盖；内嵌JSON在组件构建替换子节点后仍保留来源。JSON顶层键不会自动注册到状态或模型上下文，避免名称冲突和整份数据重复落盘。

表达式支持 `.includes(...)`、`.toUpperCase()`、`.toLowerCase()`、`.trim()` 四种白名单方法别名及链式调用，includes 支持可选 fromIndex；原函数形式继续可用。调用结果允许静态点字段及 `.length`，仅访问自有属性，禁止原型字段；其他方法在编译时明确拒绝，并给出支持语法或函数改写 hint。方法调用保留原接收者的状态依赖与 private 传播，不执行数据对象携带的函数。覆盖回归见 `test/unit/ui-widget-sources.spec.ts`，组合示例及 CLI 真实页面测试也覆盖共享源刷新和持久状态不包含整源。

2026-10-26 共享源与方法语法验证：5个组件文件50项、5个定向离线文件通过；构建及两条真实Electron用例通过（17.9秒）。覆盖动态JSON与id/type变更、初始无效/缺失源恢复、只读缓存与显式覆盖、方法白名单与private传播，以及CLI右侧页面中的输入联动、同源表格与统计同步刷新、落盘状态不包含整源。深/浅及390px截图已查看（.tmp/ui-captures/ui-expanded）。卡片旧测试补等待React effect后再发桥消息，避免未安装监听器的竞态。node类型检查通过；web/test仍被既有WorkspaceFilePatchOutcome与App/GitPanelCore/SideToolsPanel调用方不匹配阻断。Windows真Electron通过；macOS/Linux未实测；未运行全量。

| 文件 | 职责 |
|---|---|
| src/shared/uiRender.ts | HTML 工具参数校验与静态样式警告 |
| src/main/uiRuntime/{styles.css,bridge.js,expressions.js,components.js,data-components.js,advanced-components.js} | 唯一公共运行时源；共享计算/格式化与组件，原型不再是实现来源 |
| src/main/uiRuntime/three.js | 离线 Three.js 核心和 OrbitControls，公开 window.THREE/maUi.three |
| src/main/uiRuntime/mermaid.js + node_modules/pele/dist/pele.global.js | Mermaid 主机自动挂载与离线 Pele 渲染；仅 Mermaid 产物注入 |
| scripts/gen-ui-assets.mjs / src/main/uiAssets.ts | 离线资源与技能打包；--check 守新鲜度 |
| src/main/uiArtifacts.ts | 自包含 HTML、元数据/作者源、2MiB 上限与互斥取号 |
| src/main/uiWidgetSmoke.ts | 串行隐藏 Electron 沙箱冒烟；仅内存状态回执，原始运行错误回 warnings |
| src/shared/uiWidgetProtocol.ts / src/main/uiWidgetStore.ts | JSON 状态、字段合并、回执与原位更新 |
| src/main/capabilities/hosts/uiWidgets.ts | ui.render/update 和 ui.inspect；只接受本会话产物 |
| src/shared/uiWidgetSession.ts | Worker/调度逻辑身份与安全目录名的可逆映射 |
| src/main/ipc/uiWidgets.ts / src/preload/index.ts | uiWidget:read/save/receipt/action；guest-* 使用真实页面 URL |
| src/shared/ipcEvents.ts | changed/updated/draft 的类型与运行时白名单同时登记 |
| src/shared/uiArtifactMarkdown.ts / uiMessageArtifacts.ts | Markdown 块化、识别真实结果封装、消息内去重与活动之外的输出 |
| src/renderer/src/chatSurface/{UiWidgetCard,useUiWidgetBridge,uiWidgetAppearance}.tsx/.ts | 监督、自然高度/滚动、折叠、状态与主题桥 |
| src/shared/uiSessionPage.ts / renderer/src/chatSurface/UiSessionPage.tsx | CLI 会话内部 URL、UI 卡片聚合与增量更新 |
| src/renderer/src/chatSurface/ChatSurfaceView.tsx | 回填认领、保留草稿与发送回执 |
| src/main/browser/tabs.ts / renderer/src/components/BrowserPage.tsx | 产物以 muster-ext 页导航进原生 webview 标签：前台真实合成与输入，后台 webview 隐藏/inert 停放、工具只走 DOM 语义动作（原独立后台执行预览页已移除，E2E 断言其节点计数为 0）；状态/主题同步 |
| src/main/uiWidgetContext.ts / uiWidgetInspect.ts / agentSession/host/turn.ts | 公开状态的有界引擎输入、JSON Pointer分段读取 |

## 版本与边界

- 2026-10-13 用户明确要求简化且不用兼容，已移除 preset/data、专用运行器/样式/controls 求值器及 v1 自动升级。公共 expr 复用共享状态，不接受旧 controls 数据。当前会话桥只接受 v2，旧文件保持原样，不保证旧运行时交互；需要继续操作时按当前契约重新生成。文件命名和 markdown/link 继续供当前工具使用。
- update 必须保持展示方式，增加 artifact version，现有引用和已挂载表面刷新。匹配的 name/id 保留状态；不适配的旧键需作者显式迁移。产物是当前可操作内容，不是版本快照档案。
- 会话删除清理 UI 文件及状态；它们不写进工作区 Git。2MiB 包含公共资源与作者源副本，新增与更新共用上限，去重持久状态另限 256KiB。包含 Three.js 的共享 JS 约 1.04MiB；普通图表也会携带该离线运行时。
- 业务网络/API、外部图片和脚本禁用；`data:`/`blob:` 内嵌图片允许。字体只开放宿主提供者白名单；D3/Three.js 与 Mermaid 的 Pele 引擎离线可用，CSP 未开放外部脚本或网络。远程纹理/模型和未打包 addons 不能直接使用；WebGL2 还取决于 Chromium/GPU 环境。ACP 未开放 widgets。当前自动模型上下文针对 GUI Worker；CLI 走 inspect/回填。没有宣称覆盖所有外部 SDK 服务或跨设备云同步。
- 冒烟使用真实生成文件及 allow-scripts iframe，隐藏 BrowserWindow 开启 sandbox/contextIsolation、关闭 Node、无 preload，不接宿主工具/用户状态/交互动作，外部网络与权限关闭。单次 2500ms 总预算包含排队，结束销毁窗口及临时 wrapper；只检查首次执行与 render 后 100ms，不证明完整交互、像素正确、GPU 或迟发异步任务。离线 D3/Three.js 内联资源正常执行，字体请求在冒烟中关闭。
- 原生 details/tabs 维持浏览器语义，公共 HTML 层不自造进出场动画；宿主的可折叠容器使用现有动画体系。

## 验证

2026-11-03 调度身份修复：`test/ui-widget-scheduler.mjs` 覆盖可信作用域、调度/Worker 生成、inspect/更新、目录映射及非法输入、跨工作区/Worker 越权路径和模型伪造身份。暂时还原 `capabilities/hosts/uiWidgets.ts` 后首次调度调用即报旧 sessionId 错误，退出码 1；恢复修复后通过。`ui-widget-state` 覆盖 IPC 列表与动作回执恢复调度逻辑身份；`ui-widget-message-output` 的 14 项组件用例通过，包含调度目录链接在工具结果和最终正文间只挂载一个 iframe。Windows 真实 Electron 的 `ui-widget-smoke` 已验证生产 handler 的调度/Worker 生成、调度更新与 inspect、真实沙箱冒烟；这不等于当前运行中工作台已加载新代码或完成调度对话卡片视觉验收。安装/开发主进程需加载本次构建后再验收；macOS/Linux 未真机验证，目录逻辑同时检查 win32/posix 路径语义。

同类身份检查的有界源码排查：`hostTools/meta.ts` 的 self 工具中，`sessions.setStatus`、`sessions.rename` 有调度分支；`sessions.isolate` 操作显式目标 Worker，schema 提供 sessionId；`sessions.requestIntegrate` 为 Worker 专用且标记 schedulerHidden；`ui.notify` 提供 sessionId 或 workspaceId+sessionName 定位参数，不存在本次“隐去必需参数且无可信兜底”的矛盾。actor 工具中的 `ui.suggestReplies`、`ui.reminders`、`waitFor`、mailbox、events/share、feedback、memory 均有调度作用域或 host 工作区分支。未在上述范围发现第二处同型阻断；此结论是源码检查，不代表全部工具真实运行验收。

2026-10-26 完成能力扩展：8 个定向离线文件通过（状态落盘去重/旧对象兼容、公开JSON Pointer分段读取与隐私、桥状态同步、旧组件/数据组件、生成资源、参数与注入登记）；6 个组件文件56项通过，包含新增函数/定位/条件tone、1000个选择ID、日期纠错、级联重置、树键盘与多选、文件类型/大小/JSON校验及显式公开、分页与有界虚拟DOM。真实CLI→ui.render→右侧UiWidgetCard链路连续两次通过（39.8秒）：验证日期错误可继续改正、筛选/页码/选择、千行DOM有界、本地文件读取及公开控制、切会话恢复；独立Electron冒烟验证两处同文语法错误的结构化定位和warnings。当前构建通过。截图6张已逐张查看，位于 .tmp/ui-captures/ui-expanded，分深浅/390px顶部与底部取景；初轮长卡片截图跨出原生窗口，已弃用。

验收曾发现控件可恢复错误被宿主当作致命错误而卸载iframe，已新增recoverable诊断分支及同iframe保活回归。还发现跨iframe的DOM可见/尺寸更新早于命中区域绘制：事件记录显示点击落在iframe外壳，子节点未收到pointer，遮罩关闭，状态未回滚；测试等待实际高度与父子文档绘制帧，再执行物理点击，并连续复验，不用脚本设置勾选或失败重试。Windows实际Electron与本地受控CLI，未调用外部模型；文件选择通过自动化向真实input提供fixture，执行真实读取与校验，未自动化OS选择器；未做macOS/Linux真机或全量性能验收。

最终类型检查：tsconfig.node通过；web/test检查受并行工作区配置改动阻挡，App.tsx、GitPanelCore.tsx、SideToolsPanel.tsx仍把新的WorkspaceFilePatchOutcome当作WorkspaceFileConfig消费。这些调用处不属于本次UI改动，未修改；当前checkout不能宣称三套类型检查全绿。

2026-10-26 CLI 自动聚合页：5 个定向离线文件（browser-tab-lifecycle 共 48 条生命周期检查，另含 ui-widget-state/ui-render/ui-artifact-link/injection-registry）通过；4 个组件文件共 38 项通过。新增真实 CLI PTY 用例通过可信会话令牌调用生产 ui.render，验证右侧自动露出、一页多卡（含 browser 产物）、参数保存、原位更新、回填原终端、折叠与关闭后重开；生产冒烟用例覆盖自动打开不可用时保留产物并明确告警。最终构建两条 Electron 用例共 18.2 秒通过；三份 TypeScript 检查、构建、离线资源新鲜度通过。深/浅主题及 390px 页面容器截图已逐张查看，位于 .tmp/ui-captures/cli-ui-page。首轮错误地通过 config.update 切主题，截图步骤已改为 themes.activate 并等待 iframe 确认；真实工作面的首击激活需先在空白处点击，避免误把激活手势当作按钮动作。GUI followup 测试改为等待 React effect 建立后发桥消息，避免异步竞态。Windows 真 Electron 验证使用受控 CLI 代替真实模型，不代表外部模型效果、整 app 窄屏抽屉或 macOS/Linux 真机验收；未跑全量。

2026-10-14 后台执行验证：ui-widget-state 使用生产 IPC 与真实存储验证同文件状态发布和非自有窗口拒绝（当日验证所涉的独立 offscreen 执行页已随「恢复原生浏览并隔离后台语义操作」移除，现行模型为后台 webview 隐藏停放＋DOM 语义动作）。真实 Electron 的 browser-background-parallel 通过两条会话令牌验证后台 maUi 输入持久化、主进程参数发布、AI 点击链接不切前台，以及原位更新刷新后保留参数；不把旧 offscreen 页的验收直接外推到现行后台语义隔离。

定向纯逻辑/生成：ui-render、ui-artifacts、ui-artifact-link、ui-widget-assets/state/components/data-components/runtime-state。组件：ui-widget-convenience（计算/格式/错误与私有继承、分段键盘、表格变体、清单恢复/焦点、原生单选）、ui-widget-card/bridge/message-output、chat-transcript-content-pin、right-workspace-browser、terminal-ui-open、browser-webview-stack。真实 Electron 的 ui-widget-inline 用真实 Pi 工具、完整聊天呈现、真实 SDK 输入与 browser partition/preload；推理服务和 SDK 可执行文件为隔离夹具，不消耗外部推理。

2026-10-14 反馈回归通过：ui-render、ui-widget-state/runtime-state/assets 四个离线文件，以及 ui-widget-card/convenience 两个组件文件共 29 项，覆盖静态 text/value/子文本与绑定优先级、非法 tone 值提示、作者错误与行号的回执保留、活跃桥的单次超时复查。`test/e2e/ui-widget-smoke.spec.ts` 通过真实 ui.render 生产入口的新建/更新，检查首版抛错、更新版 Promise rejection、恢复、无 Node/宿主桥、缺失文件超时与窗口清理（4.0 秒）。node/web/test 三套类型检查通过。历史 stateRevision 已推进却瞬态超时的原竞态仍未完整复现，不把有限复查当作全部根因已解决。

离线三维回归：`test/ui-widget-three.mjs` 使用实际生成器与存储，验证作者执行前的 Three.js/OrbitControls API、D3 共存、MIT 许可证、CSP、新增/原位更新及超限拒绝。`test/ui-widget-three-visual.mjs` 在真实 Chromium 的 allow-scripts 沙箱和独立网页中运行生产生成 HTML 与 three-demo 片段，覆盖两主题/320–780px、真实绘制像素、拖动、画布尺寸、焦点前后滚轮与失焦禁用缩放，以及外部脚本/API 的 CSP 拦截；使用 SwiftShader WebGL2，不证明安装版/硬件驱动。2026-10-14：上述回归连同相关生成/运行时共 8 文件、三份类型检查与构建通过；四张截图已查看，位于 output/playwright/ui-widget-three（不提交）。

首轮完整修复的证据保留在实施账本。后续移除模板的验证结果以当日日志为准；不能用旧的手动重叠 iframe 截图宣称完整会话验收。日常验证 55s 分组，构建/真 app 共用 175s 上限，不跑全量。截图在 .tmp/ui-captures/ui-widget-native，不提交。

2026-10-13 当前公共能力验收：11 个纯逻辑/生成文件、8 个组件文件/71 用例、node/web/test 类型检查通过；完整 Electron 构建及同一链路连续 3 次通过（框架共 45.0s，各次 14.4–14.8s）。真实用例覆盖自然正反向滚动、筛选/选择、声明式计算与分段单选、清单与步骤/进度联动、宿主保存、切会话恢复、公开状态进入 Pi/SDK 及网页 guest 读取。原组合/便利组合/列表各有深浅 390/780px 四图，共 12 张逐张查看。旧参数拒绝与旧文件不转换有回归；没有运行全仓全量或外部推理服务。

加入多表/多网格后，原用例两处定位过宽已修正。还曾单次出现方案点击未生效，未取得该次事件证据；补实际 pointer/click 与状态采集后，一次完整运行及最终三次重复均通过。保留失败诊断，不将尚未复现的原因描述为已查明或已修复。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D06.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：Worker 用 ui.render 产出会话内交互 HTML（sandbox iframe+20 公共组件+离线 D3/Three），状态按路径落盘、下一回合只回传公开参数（≤8 项/12KiB，privateContent 不进模型）；更大产物走网页区，CLI 走 inspect/回填。
- 为什么这样设计：产物自包含落盘+返回 Markdown 链接（正文不嵌 iframe）；生成后真实冒烟（隐藏 Electron 沙箱、原始错误回 warnings）——「generated 不冒充已渲染」；回执五态+10s 超时的活体信号 probe 复查（有 ready/resize 等活体再等 2s，作者错误立即失败）；状态 256KiB 去重/有界原子替换、晚到写入不重建已删目录；CSP 全关外部脚本/网络，业务网络禁用。
- 明确不做：v1 preset/data 不兼容不迁移（2026-10-13 用户明确要求简化且不用兼容）；产物是可操作内容不是版本档案；远程纹理/模型/未打包 addons 不开放；冒烟只证首次执行+100ms，不证完整交互/像素/GPU。
- 歧义点：ACP 会话未开放 widgets——A=刻意边界（ACP 先保消息管线，ui.render 依赖宿主产物/状态桥整链，等真实需求再接；review 不把缺失当 finding）／B=路线图待补（review 记待接能力）。推荐 A。
