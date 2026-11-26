# Markdown CJK 强调兼容

> 状态：实现说明 v1（2026-09-20）
> 代码主入口：`src/shared/cjkMarkdownEmphasis.ts`、`src/renderer/src/components/MarkdownBody.tsx`
> 关联：[chat-surface.md](chat-surface.md)（会话正文）· [gui-worker-session.md](gui-worker-session.md) · [file-preview.md](file-preview.md)（md 预览共用 MarkdownBody）

调度 / GUI 会话、文件预览、文本工具结果卡都走同一 `MarkdownBody`（react-markdown + remark-gfm，严格 CommonMark）。中文里「强调定界符贴着全角标点、外侧紧跟汉字」时加粗/斜体/删除线不生效，按字面显示 `**`。

## 1. 根因

CommonMark [emphasis flanking](https://spec.commonmark.org/0.31.2/#emphasis-and-strong-emphasis) 把 `。！？、）` 等算 punctuation。right-flanking 要求：定界符前是标点时，后面必须是空白或标点。汉字不满足。

实证（unified + remark-parse + remark-gfm）：

| 源 | 解析 |
|---|---|
| `**a。**b` | 纯文本（本 bug） |
| `**a。** b` | `strong`「a。」 |
| `*a。*b` / `~~a。~~b` | 同样失败（斜体、GFM 删除线共用 flanking） |
| `已经完成。**然后继续**做` | 已能 `strong`（标点在强调**外侧**） |
| `然后**。强调**继续` | 失败（开启侧内侧是标点） |

CommonMark [#650](https://github.com/commonmark/commonmark-spec/issues/650)（2020 起）尚未定案 CJK 规则。不能等规范。

## 2. 选型

评估过三条路：

| 方案 | 做法 | 复制文本 | 代码块 | 否决/采用 |
|---|---|---|---|---|
| **A. 解析前插 ZWSP**（本仓采用） | 仅在 flanking 会失败时，在「内侧标点 ↔ `*`/`**`/`~~`」之间插 U+200B；围栏/行内代码跳过；remark 插件解析后从 **text** 节点剥掉 ZWSP | 悬浮条复制走 parts 原文（无 ZWSP）。划选复制：剥完后 DOM 无 U+200B | 扫描器跳过 ` ``` ` / `~~~` 围栏与成对 `` ` ``，不改代码内容 | **采用**。零新依赖，与现有 remark-gfm 叠，纯函数可单测 |
| B. `remark-cjk-friendly` + `remark-cjk-friendly-gfm-strikethrough` | micromark 层改 flanking（[tats-u/markdown-cjk-friendly](https://github.com/tats-u/markdown-cjk-friendly) 规范）；Cherry Studio 等用这条 | 源与 DOM 都不插字符 | 解析器自己处理 | 两条新 ESM 依赖；删除线包要求 ES2024 正则 `v` 旗。效果等价，本仓不引入 |
| C. 等 CommonMark 改 spec | — | — | — | #650 六年未合，排除 |

ZWSP **必须插在定界符内侧**：`**a。\u200b**b` 能解析，`**a。**\u200bb` 不能——U+200B 是 Cf 不是空白，插在闭合外侧帮不上 right-flanking。业界「CJK 与 `**` 相邻处插零宽空格」的准确落点是内侧。

不选「一律在 CJK 与 `*` 之间插」的宽规则，避免给已经能 flanking 的 `**bold**` / `系数*因子` 添噪音。

## 3. 接线

`MarkdownBody` 是唯一 ReactMarkdown 入口（`ChatMarkdownBody` → 调度/GUI 会话；FileEditor md 预览；TextToolResultCard；MobileFiles）。兼容层挂在这里即两表面 + 预览一起生效。

```
text → softenCjkMarkdownEmphasis（跳过代码，必要时插 ZWSP）
    → remark-gfm
    → remarkStripCjkEmphasisZwsp（只剥 type=text 的 U+200B）
    → React 渲染
```

`*` / `**` / `***`… 与 `~~`（≥2 个 `~`）都处理。单 `~`、`_` / `__` 不动。

## 4. 回归

- `test/cjk-markdown-emphasis.mjs`：插入点、幂等、围栏/行内代码跳过、预处理后 parse 出 strong/em/delete 且剥净 ZWSP
- `test/unit/markdown-cjk-emphasis.spec.tsx`：`**已经完成。**然后` 渲 strong、代码块/行内代码 `**` 不动、表格/英文加粗不回归、斜体与删除线

## 5. 已知边界

- **`_` / `__` 强调**：同一套 flanking，中文几乎不用下划线强调，未兼容。
- **缩进代码块**（行首 4 空格）：不当围栏，可能被 soften。聊天/预览极少出现。
- **未闭合的行内 `` ` ``**：按 CommonMark 当字面量，不保护其后内容。
- **原文里的 U+200B**：正文 text 节点里的零宽空格会被剥掉（code / inlineCode 的 value 不动）。
- **标点在强调外侧**（`完成。**然后**做`）本就能解析，预处理不插、不改。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D06.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：中文聊天「**已经完成。**然后」类强调贴全角标点不渲染（CommonMark flanking 把全角标点算 punctuation）——所有 MarkdownBody 消费面（两表面/文件预览/文本工具卡）一次兼容。
- 为什么这样设计：解析前仅在会失败的 flanking 位内侧插 U+200B、解析后从 text 节点剥净——零新依赖、复制走 parts 原文无 ZWSP、围栏/行内代码跳过、纯函数可单测；实证否决 remark-cjk-friendly（两条 ESM 依赖+ES2024 正则要求）与等 spec（#650 六年未合）；不选「CJK 与 * 一律插」宽规则，避免给已能渲染的 `**bold**`/`系数*因子` 添噪。
- 明确不做：`_`/`__` 不兼容（中文几乎不用下划线强调）；缩进代码块不当围栏；正文 text 节点原有的 U+200B 会被剥掉；标点在强调外侧本就能解析的不插不改。
- 歧义点：无真决策（选型已实证锁定，边界是刻意取舍）。
