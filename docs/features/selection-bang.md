# 大爆炸选词浮层（SelectionBangOverlay）

功能职责：把一段选中文本「爆炸」成词片（token chips），用户点选/滑动挑选词后拼回有序文本，支持复制、搜索、发给 Agent、打开链接、资源管理器定位、文件区预览，以及把选中词拖到文件区 / Git / Agent / 终端。入口：划词浮条「爆炸」按钮与终端胶囊识屏（见 [menus-and-tooltips.md](menus-and-tooltips.md)、[text-entity-recognition.md](text-entity-recognition.md)）；来源不限终端（全局 portal）。

## 关键文件与入口

- `src/renderer/src/components/SelectionBangOverlay.tsx`：浮层本体（portal 到 body、`.sel-bang-mask` 全屏遮罩，根挂 `data-overlay-root` 纳入点外判定）
- `src/renderer/src/components/selectionMenuController.ts`：`SelectionBangState`（text/cwd/originTop）与开关控制；`syncSelectionMenuToLiveSelection` 给划词浮条滚动跟手（爆炸打开期间浮条已关）
- `src/shared/terminalSelectionText.ts`：`tokenizeForBangLimited` 分词（超限截断并 tip）与 `joinTokens`（按 token 下标排序拼接，乱序点选拼回仍有序）
- `src/renderer/src/terminal/selectionActions.ts`：复制/搜索/打开链接/资源管理器/预览/`beginSelectionDrag` 拖出数据
- `src/renderer/src/styles/selection.css`：`.sel-bang-*` 样式

## 交互模型（2026-09-04 定稿：累加式选词）

- **单击词片**：加入选择（可连续点选多个，累加不互斥）。
- **按住滑动**：从起点词滑到终点词，区间内词并入选择；只累加，不取消手势前已选的词。滑动期间指针 capture 到 `.sel-bang-chips-wrap`，用 `elementFromPoint` 命中词片。
- **再点已选词**：从选择中移除该词（单击移除）。实现上 pointerdown 先记 `pendingToggleRef`，pointerup 原地抬起才生效；若真拖出（`dragstart`/`pointercancel`）则作废待定，保证拖出与移除不冲突。
- **选择态标识**：只加深背景（`--ink` 30% 叠加），不改边框（用户定稿：不用高亮边框）；is-url/is-path 的边框微染色仅作类型提示保留。
- 底部 `working` 文本 = `joinTokens(tokens, picked)`（按下标排序）；分词时丢掉的空白在拼回时回填——仅两侧都是 ASCII 字母/数字的 token 边界补一个空格（英文词句拼回可读），CJK 相邻、路径/URL/标点边界不补（`needsSpaceBetween`）。URL/路径感知按钮按拼回文本判定。

## 数据流

SelectionBar/胶囊识屏 → `selectionMenuController` 置 `SelectionBangState` → `SelectionBangOverlay` 分词渲染 → 点选产生 `picked: Set<number>` → `joinTokens` 拼回 → 复制/搜索/发给 Agent（`services.insertComposer`）/路径动作，或 `beginSelectionDrag` 拖出到各区。

## 已知边界

- 分词超限（`MAX_BANG_TOKENS`）只显示前 N 词并 tip 提示，后半段不可选。
- 已选词的拖出走 HTML5 drag（桌面鼠标）；触摸下拖出不可用，单击等于移除。
- 滑动手势只增不减：滑过头再滑回来只影响本次手势的区间，历史选择需逐词点击移除（有意为之，避免误滑清场）。
- 爆炸遮罩挂 `data-overlay-root`：点词片不会被全局看板当成点外关闭（调度面板已不点外关闭）。
- **组件级测试约定**：本组件交互逻辑（累加/移除/拖出仲裁/pendingToggle 作废）目前**无组件级自动化测试**（纯函数部分由 `test/terminal-selection-text.mjs` 覆盖）——按测试规约「UI 交互改动须带组件测试」，**触碰该组件的下一个改动批次必须先补 `test/unit/` 组件测试**（`window.api` 用 helpers/api-mock）再动交互行为。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D04-D05.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：把终端输出/划词里散落的词元「爆炸」成词片挑选拼回有用文本（错误信息里抽标识符、日志里抽路径参数），再复制/搜索/发 Agent/打开链接/资源管理器定位/预览/拖到文件区/Git/Agent/终端；入口=划词浮条「爆炸」按钮+终端胶囊识屏，来源不限终端（全局 portal）。
- 为什么这样设计：累加式选词交互 2026-09-04 用户定稿（单击累加、滑动区间并入、再点已选词移除；选中态只加深背景不用高亮边框）；joinTokens 按 token 下标排序拼回——乱序点选仍得有序文本；空白回填规则（仅两侧 ASCII 字母数字补空格）让英文词句拼回可读、CJK 相邻/路径/URL/标点边界不被破坏；遮罩挂 data-overlay-root 防被看板点外判定误关。
- 明确不做：滑动手势只增不减（防误滑清场，用户定稿）；分词超限（MAX_BANG_TOKENS）只显示前 N 词并 tip，后半段不可选；触摸下拖出不可用（HTML5 drag 桌面鼠标），单击等于移除；拖出目标面固定为文件区/Git/Agent/终端四区。
- 歧义点：无（交互模型用户已定稿，剩余边界均为小颗粒取舍）。
