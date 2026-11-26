# 智能界面组件演示（intelligent-ui）

当前生产契约只接受公共组件组成的 HTML，见 [contract.md](contract.md) 和 [功能文档](../../features/intelligent-ui.md)。生产样稿：[composed-demo.fragment.html](composed-demo.fragment.html) 为筛选/表格/图表联动；[convenience-demo.fragment.html](convenience-demo.fragment.html) 为无需作者脚本的计算、分段选择、比较/属性表和步骤/清单。两者共用 16 个公共组件。2026-10-13 用户要求移除旧模板及兼容。以下 index/trials 是九型方案的历史原型，不参与生成或验收，也不是当前创作指南；其中 uiPresets/preset 运行器指已经移除的旧实现。

intelligent-ui-plan 的设计语言与 preset 组件验证原型，双击 `index.html` 即开（无需构建、无网络依赖）。

## 契约与试写迭代（v0.4，2026-10-10）

- `contract.md`：`ui.render` 工具契约（§1-2 为未来 catalog 常驻注入，§3 起为 skill 按需内容）。
- `trials.mjs`：契约校验器（schema + controls 表达式默认值试算 + followup 占位引用检查）+ 试写预览生成（`node trials.mjs`：校验 `trials/*.json` 并重建 `trials/preview.html`）。校验器已长成正式实现 `src/shared/uiPresets.ts`（原型侧保留作契约演进的沙盒）。
- `trials/`：子代理**盲测**试写产物（提示词只含契约文本、禁读仓库文件，模拟真实 agent 首次使用）。r1/r2 共 14 份、机器校验 0 错；r1 反馈 13 条催生 v0.3（多序列 chart、占位符中文化、compare 优势标注、steps/checklist 备注、kv 分组），r2 反馈 8 条催生 v0.4（多序列语义色、trendDir 语义澄清、通用脚注、长类目截断）。双击 `trials/preview.html` 看全部试写的真实渲染。
- 试写暴露并修复的坑：占位符正则 `\w+` 不匹配中文（静默忽略）→ `[^{}]+`；SVG 子元素必须 `createElementNS`。

## 验证什么

1. **八个基本组件全量形态**：table / kv / stats / compare / chart（bar·line·donut）/ steps / checklist / controls——一次做全、不分期（2026-10-10 用户裁决）。
2. **设计语言 = 主题 token 双源投影**：深色取 `base.css :root` 原值、浅色取内置浅色主题（`src/shared/theme.ts`）原值；组件内颜色**只经 `var(--*)`**，状态淡底一律 `color-mix` 派生，不新增色源。右上角深浅切换即时验证和谐度。
3. **ma-ui-runtime 种子实现**：`<script id="ma-runtime">` 就是产物内联渲染器本体——读 `.ma-widget` 的 JSON 数据岛按 preset 分发渲染；经 `scripts/gen-ui-assets.mjs` 生成进 `src/main/uiAssets.ts` 内嵌到每个 artifact（inline/browser/独立预览共用**单渲染器**，见 features 文档「设计要点」）。
4. **产品形态**：会话流 mock 展示 inline 部件卡的摆放；`browser` 模式留链接卡、点击弹出独立渲染视图（右侧网页区的形态预览）；controls 的回填按钮演示 M5 交互（填入底部输入框，可编辑再发）。
5. **本地微交互**（部件自身完成、不经引擎）：table 点列头排序（▲/▼）、checklist 本地点击勾选/还原、chart 各数据点 hover 出 `label · 数值` 提示。修图教训：SVG 子元素必须 `createElementNS`，`document.createElement('rect')` 是 HTML 命名空间元素、挂进 `<svg>` 不渲染（首版图表全空白的根因）。

## 数据岛契约（与计划 M3 对齐）

```html
<figure class="ma-widget" data-preset="table" data-file="01-regression.inline.html">
  <script type="application/json" class="ma-data">{ …preset 数据… }</script>
</figure>
```

- `data-file` 文件名后缀编码模式（`.inline.html` / `.browser.html`），文件头 meta 兜底（正式实现）。
- controls 的 `expr` 走**迷你表达式求值器**（算术 + 比较 + round/min/max/sum 白名单），不 eval——这是 preset 安全性的关键设计。

## 边界（原型 ≠ 实现）

- 未含：`ui.render` 工具与落盘、链接识别（ChatMarkdownBody）、沙箱 iframe、CLI 右键扫描、appearance 桥、静态色检查。
- 页面骨架（会话流/输入框/顶栏）是演示布景，不属于契约；契约部分是 `ma-contract-style`（token + 骨架类）与 `ma-runtime`（渲染器）。
- 自测截图仅留本机，不提交。
