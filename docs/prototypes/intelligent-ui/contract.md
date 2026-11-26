# 会话内交互 UI 契约

> v0.9 / runtime v2（2026-10-26）。离线库增加 Three.js/OrbitControls，产物上限调整为 2MiB。用户明确要求简化且不兼容旧模板；移除九型 preset/data、专用运行器及 v1 自动转换，常见创作能力统一到公共组件。当前实现见 [intelligent-ui](../../features/intelligent-ui.md)，完整创作说明见 [ui-widget-design](../../../resources/skills/ui-widget-design/SKILL.md)。旧 index/trials 仅为历史原型。

## 工具

`ui.render({title, html, mode?, note?, update?}) → {markdown, link, version, receipt, presentation?, warnings?, diagnostics?}`

- `title`、`html`：必填非空字符串。html 为由公共组件和原生语义标签组成的片段，不含外围 html/body，无需加载运行器。
- `mode`：inline（默认，按自然高度铺在会话内）或 browser（独立网页区）。
- `note`：可选脚注，宿主转义后显示在内容底部。
- `update`：本会话已有产物 link；原路径更新、增加版本、保留相同 name/id 的状态，展示方式保持一致。
- 未声明字段拒绝；旧 preset/data 即使与 html 同时提供也拒绝。不静默回退或转成 HTML。
- 把返回 markdown 原样放进回答正文。generated 仅表示生成成功；通过 `ui.inspect({link?,pointer?,offset?,limit?})` 分段读取公开选择/容量与真实渲染回执；CLI自动复用右侧会话UI页，按usage引导用户查看。

## 组件与组合

20 个公共组件：ma-stack / ma-row / ma-grid / ma-card / ma-text / ma-badge / ma-input / ma-select / ma-checkbox / ma-slider / ma-button / ma-tabs / ma-details / ma-table / ma-chart / ma-list / ma-date-range / ma-cascade / ma-tree / ma-file。

- 比较、数据、详情共用 ma-table（variant=comparison/data/details）；JSON script 用 source 引用或放在组件内。比较列可 recommended:true，单元格 [文字,tone] 为语义标签；详情可直接接收键值对象并使用行标题。只有 data 默认开启排序，sortable 可覆盖。
- ma-text 的 expr 声明共享状态计算，name 命名原值结果；format/digits/currency/unit 统一格式。variant=metric 配 label/trend/tone 表达指标。表达式有界解析、不 eval，不接收任意调用/赋值；循环、除零、缺参和非有限结果就地显示错误，输入恢复后自动重算。私有依赖的结果也为私有。
- ma-select appearance=segmented 复用选择状态与 option，支持方向键/Home/End 并跳过禁用项。
- ma-list 的 plain/steps/checklist 共用数据与渲染，项含 id/label/description/status/date/progress/disabled。checklist 的 name 保存完成 id 数组；steps 的 completion 引用该数组联动。完成项进度显示 100%，取消勾选恢复数据进度（取消初始完成项为 0%）。筛选与搜索复用其他数据组件的状态接口。
- ma-stack/row/grid 负责布局，tabs/details 负责分区；不另设 group/controls 等整件类型。
- 任意原生标签可用 data-ma-bind、data-ma-visible；表格和图表共享筛选/选择。精确属性及例子按需读创作技能。

新增表达式函数、条件tone、分页/固定行虚拟表、ID多选和统计、4个复合输入的属性与约束见创作技能；可运行组合见 [expanded-demo.fragment.html](expanded-demo.fragment.html)。ma-file默认私有，只有用户主动勾选才公开内容；支持UTF-8文本/Markdown/CSV/JSON/log，每文件64KiB、总128KiB，不进行远端上传。编译及求值错误统一显示于控件并返回有界结构化诊断。

JSON script 与表达式通过 `source('id')` 共享只读数据，例如 `count(source('demo-data').rows)`；JS 使用 `maUi.source(id)`。共享解析缓存与深层冻结结果，源变化自动重算，不自动注册用户变量、不复制整源进状态或模型上下文；每源最多2MiB/100000容器节点。组件 `.data=...` 只覆盖该组件。表达式支持 `.includes(...)`、`.toUpperCase()`、`.toLowerCase()`、`.trim()` 白名单别名与链式调用，includes可传fromIndex；调用结果可读取静态自有字段及length，禁止原型字段和其他方法，拒绝时返回针对性hint。

## 状态、动作与资源

运行时先于作者脚本就绪，提供 `maUi.get/set/subscribe`、`getUi/setUi`、`getWidgetState/setWidgetState`、`whenReady`、`format` 和 copy/openUrl/followup/sendFollowup。set/action 返回 Promise，失败显示原因；公共组件自动同步状态，复杂作者订阅需判断值是否变化再更新，避免递归。常见场景无需作者脚本，见 [声明式样稿](convenience-demo.fragment.html)。完整创作说明由宿主显式加载 [ui-widget-design](../../../resources/skills/ui-widget-design/SKILL.md)。

公开参数进入下一 GUI 用户回合；private 只用于恢复 UI，去重后的持久状态不超过256KiB，公开值不重复落盘，private及用户自定义对象保留。公开模型回合仍限8项/12KiB，较大值通过ui.inspect的JSON Pointer/offset/limit读取。不会因普通字段变化自动提问。回填追加草稿，发送由宿主确认，操作有结果回执。产物 identity 为宿主认可的路径，状态和产物随会话删除。

主题、工作区色、字体与字号跟随宿主；普通纵向滚轮属于所属会话。长内容不设纵向高度上限；用户可主动折叠，宽表可横向滚动。D3 7.9.0（maUi.d3）和 Three.js 0.186.1（maUi.three/THREE，含 OrbitControls）在作者脚本之前离线提供；声明 `<pre class="mermaid">...</pre>`、`<div class="mermaid">` 或 `<ma-mermaid>` 时，生成器按需注入与聊天 Markdown 相同的 Pele Mermaid 引擎并输出 SVG；解析失败保留源码并报告可恢复诊断。其余 addons 未内置。三维画布需 WebGL2，示例见 [three-demo.fragment.html](three-demo.fragment.html)。业务网络/API、外部脚本和外部图片禁用，`data:`/`blob:` 内嵌图片允许，字体由宿主白名单提供。2MiB 文件上限包含公共运行资源及作者源副本，新增与更新共用该预算。

## 版本边界

新调用只接受上面的 HTML 契约；不保留旧模板别名、数据转译器、controls 专用求值器或 v1 升级逻辑。公共 expr 是组件共享能力，不接受旧 controls 数据结构。旧自包含文件保持原样，不删除用户产物，也不保证旧运行时与当前会话桥的交互。需要继续操作时按当前组件重新生成。

协议/工具目录/技能与生产源码同步更新；新增模型注入点仍须先登记 injection-registry。当前公开状态注入复用已有点，不增加常驻协议全文。
