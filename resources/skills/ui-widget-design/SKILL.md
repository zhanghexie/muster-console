---
name: ui-widget-design
description: 使用 host.ui.render 生成会话内交互内容：可组合 ma-* 基础组件、共享状态/动作、离线 D3/Three.js，统一 HTML 创作入口。需要筛选、选择、计算、探索或继续操作时使用。
x-muster-skill: ui-widget-design
x-muster-version: 0.1.34
---

# ui-widget-design：智能部件创作指南

`host.ui.render({title, html, mode?, note?, update?})` 返回 `{markdown, link, version, receipt, presentation?}`。GUI 会话把 **markdown 字段原样**放进回答正文。CLI 会话由宿主自动打开右侧浏览器的本会话「交互 UI」页，多次调用共用一页，按顺序排列 GUI 同款交互卡片，只展示 UI；无需逐组件另开网页。`presentation.opened=true` 时提示用户去右侧浏览器查看和操作；为 false 时明确告知自动打开失败，并提供返回的 markdown 入口。打开页签不等于渲染成功，按需用 `host.ui.inspect` 核对。每个部件一次调用；一轮可多次、按叙述顺序。普通文字不必改成控件；当用户要筛选、选择、调参、探索或继续操作时用交互内容。

- `mode`：`inline`（缺省，自然高度铺在会话里，普通滚轮滚会话）｜`browser`（独立工作视图，如地图/3D）。长表也可 inline，只允许必要的横向滚动。
- `html` 必填：用公共组件组成片段。表格、图表的数据放入 JSON script，由 source 引用；不传 preset/data。
- 表达式读取同一份 JSON 用 `source('script-id')`，如 `count(source('demo-data').rows)`、`sum(source('demo-data').values)`、`source('demo-data').rows.length`；JS 对应 `maUi.source(id)`。与组件 source 共用解析缓存，结果深层只读，源文本/id/type变化自动刷新。不会自动把顶层键注册成变量，也不写进状态或模型上下文。每源最多2MiB/100000容器节点；组件 `.data=...` 是该组件的显式覆盖，不会替换公共 JSON 源。只给需要保留的小型计算结果命名，不要把整源命名后复制进状态。
- `note`：部件脚注（一行结论/出处）
- `update`：本会话已有 `link`，原位更新并增加版本，保持展示方式；保留有相同 name/id 的状态。不要为小修改不断生成新卡。
- `host.ui.inspect({link?,pointer?,offset?,limit?})` 读取公开选择、容量与回执；无 link 为部件列表分页（默认4项）；有 link 时 pointer 为 modelContent 内的 JSON Pointer（如 `/selected/name`，默认根），offset/limit 分段读取数组、对象条目或字符串。跟随 `nextOffset`，大型条目使用返回的 pointer 下钻，私有字段不可读取。生成成功只是 generated，不能代替 rendered。

## 20 个公共组件（运行时 v2）

只传 HTML **片段**；无需声明 html/body、加载库或自己实现宿主桥。公共 `maUi`、离线 `maUi.d3`（D3 7.9.0）和 `maUi.three`（Three.js 0.186.1，含 OrbitControls）在作者代码之前就绪；`THREE` 是 `maUi.three` 的同实例全局别名。宿主深浅主题、工作区色、字号与字体自动同步。颜色/字体仍用下文 token。

| 元件 | 属性/组合方式 |
|---|---|
| ma-stack / ma-row / ma-grid | 纵列/自动换行横列/窄宽度自动单列网格；grid columns=1…4 |
| ma-card | 语义分组；label 为可选小标题，避免给每段重复画边框 |
| ma-text / ma-badge | bind 指向共享状态，text 可 fallback；text 支持 expr 计算、name 命名结果、format/digits/unit；variant=metric、label/trend 排指标；tone=success/danger/warning/info/neutral，tone-bind 引用状态，tone-expr 使用相同表达式语法（ma-text 控制趋势颜色，badge 控制标签颜色） |
| ma-input | name、label、type=text/number/date/textarea/password、value、min/max/step/placeholder/rows/required/disabled；password 自动 private |
| ma-select | name、label、value；子节点为原生 option；appearance=segmented 显示分段单选，方向键/Home/End 切换并跳过 disabled 选项 |
| ma-checkbox / ma-slider | name、label；checkbox checked；slider min/max/step/value；可加 private |
| ma-button | label、action=followup/copy/openUrl、prompt 或 text、url、mode=draft/send；支持 {共享键}、{selected.name}、行内 {row.name} 占位 |
| ma-tabs | name、label；直接子 section 的 label/data-label 是页签；支持左右键/Home/End；选择仅恢复 UI |
| ma-details | name、label、open；子内容为详情；开合仅恢复 UI |
| ma-table | source 指向 JSON script id；columns/rows；variant=data/comparison/details；filter + filter-key、search、selection、row-key；page-size=1…200（默认50），筛选/排序变化回首页；selection-value=id 保存单选 ID，selection-mode=multiple 保存 ID 数组；stats=状态键 发布 totalCount/filteredCount/selectedCount/page/pageCount；virtual 使用320px聚焦滚动与40px固定行，限无自定义单元格的data表格；template data-column="列键" 为单元格插槽，template data-actions 为行操作 |
| ma-chart | source、type=bar/line/pie/donut、label、unit、x-label/y-label、height；rows 用 label-key/value-key；filter + filter-key；也支持 labels/series 数据，多系列可切换 |
| ma-list | source 指向 JSON script id；数组或 {rows}；variant=plain/steps/checklist；label、filter + filter-key、search；清单 name 保存完成 id 数组，private 仅恢复；步骤 completion 引用该数组实现联动 |
| ma-date-range | name、label、start/end（YYYY-MM-DD）、min/max、private、disabled；共享值为 {start,end}，校验日期及先后顺序，错误输入不覆盖已保存的有效值 |
| ma-cascade | name、label、source、labels（JSON数组）、private、disabled；数据为嵌套 [{value,label,children?,disabled?}]，value 全树唯一，最多16层/10000节点；共享值为已选路径 value 数组，换上级清除下级 |
| ma-tree | 同级联的节点数据与 source；name、label、multiple、private、disabled；单选保存value或null，多选保存独立节点value数组；原生 details 开合保留，方向键/Home/End 导航，不隐含勾选子节点 |
| ma-file | name、label、multiple、accept、max-files=1…4、max-bytes=1…65536、private、disabled；用户本地选择 UTF-8 txt/md/csv/json/log，总计128KiB；校验类型、大小、编码和JSON语法。共享值为 [{name,type,size,text}]，默认私有；用户勾选“将已选文件内容提供给模型”后才公开，每次重新导入撤回勾选。没有远端网络上传；二进制文件不支持，不保存机器绝对路径 |

给交互控件稳定的 name，给表格/图表稳定的 id，更新时可以恢复匹配的状态。任意原生控件可用 `data-ma-bind="键"`；`data-ma-private` 不交模型。显示值可用 `data-ma-bind="selected.name"`，条件显示用 `data-ma-visible="selected"`。不需要自己查兄弟控件或各维护一份状态。

```html
<ma-stack>
  <ma-row>
    <ma-select name="status" label="状态" value="all">
      <option value="all">全部</option><option value="可用">可用</option>
    </ma-select>
    <ma-input name="query" label="搜索" placeholder="输入方案名"></ma-input>
  </ma-row>
  <script type="application/json" id="plans">{"columns":[{"key":"name","label":"方案"},{"key":"cost","label":"费用/元","num":true},{"key":"status","label":"状态"}],"rows":[{"id":"a","name":"方案 A","cost":80,"status":"可用"},{"id":"b","name":"方案 B","cost":110,"status":"待评估"}]}</script>
  <ma-grid>
    <ma-table id="plans-table" source="plans" filter="status" filter-key="status" search="query" selection="selected" row-key="id">
      <template data-actions><ma-button action="copy" text="{row.name}，{row.cost} 元" label="复制"></ma-button></template>
    </ma-table>
    <ma-chart id="plans-chart" source="plans" filter="status" filter-key="status" label-key="name" value-key="cost" label="费用对比" unit="元"></ma-chart>
  </ma-grid>
  <div data-ma-visible="selected">
    <ma-row><ma-text bind="selected.name"></ma-text><ma-button label="继续分析" prompt="分析 {selected.name} 的费用 {selected.cost} 元" mode="draft"></ma-button></ma-row>
  </div>
</ma-stack>
```

公共 JS：`maUi.get(key, fallback)`、`maUi.set(key, JSON值, {private?:boolean})`、`maUi.subscribe(callback)`、`maUi.getUi/setUi`、`maUi.getWidgetState/setWidgetState`、`await maUi.whenReady()`、`maUi.format(value, {format,digits,currency,unit})`、`maUi.copy(text)`、`maUi.openUrl(http或https)`、`maUi.followup(text)`（追加草稿）、`maUi.sendFollowup(text, title?)`（宿主确认后发送）、`maUi.stateUsage()`（usedBytes/maxBytes/remainingBytes）、`maUi.getDiagnostics()`。set/action 返回 Promise；失败需显示原因。去重后的持久状态上限256KiB，公开值不在恢复区重复落盘；保留私有值和用户自定义对象。只保存选择ID、查询和页码，不把整表源数据放进状态。模型回合仍限8项/12KiB；大公开内容用host.ui.inspect分段读取。普通字段变化不自动发问。

图表按真实容器宽度重排；不要固定大 viewBox 再整体缩小。inline 不写 100vh、固定纵向滚动盒或 max-height；让内容自然铺开。地图/3D 确实要滚轮时，专用可聚焦区域加 `data-ma-wheel="local"`，仅明确聚焦后接管滚轮。

每次修改可 host.ui.render({update:旧link,...完整内容})；参数及 name/id 一致的控件状态会保留，不适配的旧键由作者在 whenReady 后显式迁移。旧 preset/data 已移除，不提供模板转换或历史 v1 自动升级。外部 API、外部图片和脚本不可加载；`data:`/`blob:` 内嵌图片允许。需要 Mermaid 时使用 `<pre class="mermaid">...</pre>`、`<div class="mermaid">` 或 `<ma-mermaid>`，宿主会按需注入与会话 Markdown 相同的 Pele 引擎并输出 SVG；语法错误保留源码并给出可恢复诊断。字体由宿主白名单提供，D3/Three.js 已离线内置。单个产物上限 2MiB，包含公共运行时和作者源副本。部件随会话删除，不作为永久文件发布。

## 三维创作

直接在内联脚本中用 `const THREE = maUi.three`，创建 Scene、PerspectiveCamera、WebGLRenderer、几何体、材质和灯光；视角控制用 `new THREE.OrbitControls(camera, renderer.domElement)`。无需 CDN、import map 或 `import('three')`，其他 addons 未内置。完整可运行片段见 [three-demo.fragment.html](examples/three-demo.fragment.html)。

容器用真实宽度和明确的画布高度，ResizeObserver 同步 renderer 尺寸与 camera.aspect；限制 pixelRatio，避免窄屏 GPU 开销过大。WebGLRenderer 需要 WebGL2，创建失败时显示具体原因并调用 `maUi.fail(error)`，不要报成功。几何体可直接生成；远程纹理/模型仍受 CSP 限制。较大场景用 mode=browser。

需要滚轮缩放的容器加 tabindex 和 `data-ma-wheel="local"`，只在容器有焦点时启用 OrbitControls.enableZoom，失焦时禁用，避免抢走会话滚动。document.hidden 时跳过绘制，pagehide 时停掉 animation loop、断开 observer 并 dispose controls/geometry/material/renderer。


## 组合选择

- 比较方案：ma-table variant="comparison"，维度作为行、方案作为列；columns 中 recommended:true 自动突出推荐列，单元格 ["完整","success"] 自动显示语义标签，仍可用 template 插槽。
- 键值详情：ma-table variant="details"，JSON 可以直接为 {"环境":"生产","异常":0}；无表头，第一列为行标题。普通数据表共用同一实现，sortable="true/false" 可覆盖排序默认值。
- 指标摘要：ma-grid + ma-text variant="metric"；label、unit、trend="较上期 {change}%"、tone 设置统一排版，值用 bind 或 expr。
- 进度与待办：ma-list variant="steps/checklist"；同一 source 可生成两种视图。每项用稳定 id、label（或 name）、description、status=todo/doing/done/blocked，可加 date、progress（0–100）、disabled。checklist 的 name 保存完成 id 数组；步骤的 completion 引用同一数组。已完成项的进度显示 100%；取消本次勾选恢复数据进度，取消初始已完成项显示 0%。没有 completion 时步骤只读数据中的 status。
- 调参计算：ma-input/ma-select/ma-slider + ma-text expr。结果可设置 name，直接用于其他表达式或按钮 prompt；常见计算无需写订阅和作者脚本。
- 组合布局：ma-stack/ma-row/ma-grid；分区用 ma-tabs/ma-details。不要重新定义 compare、kv、group 等专用组件或加载旧模板运行器。

```html
<ma-input name="price" label="单价" type="number" value="80"></ma-input>
<ma-input name="quantity" label="数量" type="number" value="3"></ma-input>
<ma-select name="discount" label="折扣" appearance="segmented" value="1">
  <option value="1">原价</option><option value="0.9">九折</option>
</ma-select>
<ma-text name="total" expr="round(price * quantity * discount, 2)"
  variant="metric" label="预计费用" format="currency" currency="CNY"></ma-text>
<ma-button label="继续分析" prompt="请按总费用 {total} 元分析。"></ma-button>
```

expr 可引用共享 name 和对象字段（如 selected.cost、items.length；中英文名称均可），支持 + - * / %、==/!=/===/!==、大小比较、&&/||/!、三元条件。+ 任一侧为字符串时拼接；数值相加需使用数值输入。白名单：min/max/abs/ceil/floor/pow/round、sum（数值参数或数组）、len（字符串/数组长度）、count(array) 或 count(array,"status","done")、includes/contains（字符串/数组，可选fromIndex）、concat、lower/upper/trim、source(id)。额外允许 `.includes(...)`、`.toUpperCase()`、`.toLowerCase()`、`.trim()` 四种方法别名及链式调用；如 `source('demo-data').name.trim().toUpperCase()`。仅映射白名单，不调用数据对象里的函数；其他方法明确拒绝并给hint。支持调用结果的静态点字段，仍禁止原型字段、赋值和动态代码。最多4096字符/512token/32层，sum与条件count最多10000项，字符串结果最多65536字符。编译/求值错误在控件就地显示，工具返回diagnostics携带code/component/id/name/attribute/expression/position/hint；返回表达式摘录有expressionOffset/Length。修正输入后的计算可恢复。命名结果继承private依赖，不要另写同名状态。

format=number/currency/percent/duration/text；digits=0…8（默认 2），currency 默认 CNY，duration 输入秒并显示 分:秒，unit 附加单位。percent 的原值为比率，如 0.7 显示 70.00%；格式化只改显示，不改共享原值。表格 columns 也可设置同样的格式属性。

这里只保留一套公共组件、状态和动作。完整的无作者脚本例子见 [convenience-demo.fragment.html](examples/convenience-demo.fragment.html)。普通静态表格用 Markdown；只有用户需要交互时才生成部件。

日期范围、层级选择、文件导入、分页/千行表与条件标签的组合例子见 [expanded-demo.fragment.html](examples/expanded-demo.fragment.html)。源数据留在 JSON script 或组件的 `.data`，模型只读取参数与统计。

## 样式与资源

颜色用 var(--ink)、var(--ink-soft)、var(--text-2)、var(--text-3)、var(--green)、var(--red)、var(--yellow)、var(--blue)、var(--purple)、var(--action-bg)、var(--bg-card)、var(--hairline)。字号用 var(--fs-body)、var(--fs-ui)、var(--fs-caption)、var(--fs-title)，避免硬编码。maUi.d3 和 maUi.three 已离线提供；不要加载外部脚本或重新实现宿主桥。
