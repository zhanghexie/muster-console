# Markdown 数学公式

## 职责

会话正文与文件预览里的 LaTeX 公式渲染：行内 `$x^2$` 与块级 `$$…$$`（闭围栏独立成行）经 remark-math 识别、KaTeX 排版成 `.katex` DOM。所有走 `MarkdownBody` 的表面（聊天、文件 Markdown 预览、工具结果卡等）一处接入全部生效；`ui.render` 产物是独立 HTML 链路，不经此层。

## 关键文件与入口

| 文件 | 角色 |
| --- | --- |
| `src/renderer/src/components/MarkdownBody.tsx` | 插件接线：`REMARK_PLUGINS`（remarkMath 在 GFM 前）+ `REHYPE_PLUGINS`（rehypeKatex，`output:'html'` / `strict:false` / `throwOnError:false`）；`import 'katex/dist/katex.min.css'`（vite 连带产出 59 个字体资产） |
| `src/shared/markdownMathGuard.ts` | 货币误报守卫 `guardInlineMathCurrency`（纯函数，解析前预处理） |
| `src/renderer/src/styles/markdown.css` | 阅读域适配：`.katex` 字号压到 1.15em、`.katex-display` 并入 space-after 间距模型 + 横向滚动 |
| `test/unit/markdown-math.spec.tsx` | 组件级合同（7 用例） |
| `test/markdown-math-guard.mjs` | 守卫纯逻辑断言 |

## 数据流

`text` → `softenCjkMarkdownEmphasis`（CJK 强调兼容，不动 `$`）→ `guardInlineMathCurrency`（货币守卫）→ ReactMarkdown（remarkMath + GFM + ZWSP 剥离）→ rehypeKatex → `.katex` DOM。

- **货币守卫**：micromark 的单 `$` 配对没有空格侧规则，正文「价格是 $5 和总价 $10 合计」会被当成公式渲成乱码。守卫按 Pandoc 行内公式规则补位：**内容首尾是空白（空格/制表/换行）的单 `$` 配对转义开定界符**，按字面渲染；真公式首尾不落空白，不受影响。`$$` 连跑、代码围栏/行内代码（复用 `collectMarkdownCodeSpans`）、已转义 `\$` 原样跳过。
- **output:'html'**：KaTeX 只输出 HTML span，不生成默认的双份 MathML（流式正文 DOM 减半）；strict 关闭避免小错刷警告，throwOnError 关闭让坏公式按源码红字呈现、不炸整条消息。
- **颜色/主题**：KaTeX 字形走 currentColor 自动随主题；字体（woff2 等）由 vite 打包，Electron file:// 直接加载。

## 交互与已知边界

- **单行 `$$x$$` 是行内公式**：remark-math 的 flow（块级）数学要求闭围栏独立成行；单行 `$$…$$` 由 text 数学接走，渲成行内 `.katex`（无 `.katex-display` 居中态）。模型输出的多行 `$$` 块不受影响。
- **CJK 无空格货币仍误判**：`$5和$10`（首尾无空白）守卫判不出，会渲成公式——与 Pandoc 同限，接受；带空格行文（绝大多数）已被守卫覆盖。
- **流式**：闭合定界符到位前按原文显示，到位后切渲染，与代码块/mermaid 流式行为一致。
- **KaTeX vlist 自带 ZWSP**：渲染产物内部含 U+200B，属 KaTeX 自身结构；预处理层的「正文零 ZWSP」契约只查公式子树之外（见测试）。
- **体积**：katex 进 `vendor-markdown` chunk；59 个字体资产（woff2/woff/ttf 三格式全量）随包分发，未做 woff2 精简——如需瘦身可后续裁剪。

## 预热

`warmMarkdownParser` 样本已含行内/块级公式，KaTeX 首次初始化与 JIT 随预热移出首帧（P2-3② 机制，见 markdown-warmup.spec.tsx）。
