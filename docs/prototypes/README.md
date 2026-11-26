# 原型与设计验证

本目录保存交互原型、实验稿和验证说明。原型用于验证形态，不代表当前实现；已经上线的功能以 `docs/features/` 为准。相关方案从 [`../plans/README.md`](../plans/README.md) 查找。自测截图、录屏和采集报告仅保留在本机生成目录，不提交 Git；说明中的历史截图路径可能在新拉取的仓库中不存在，应按对应脚本重新采集。

每个原型独占一个 kebab-case 文件夹，HTML、源码、样式、模板与设计说明放在同一目录；同一原型的版本和截图也归入对应文件夹。根目录只保留本索引。新增原型请沿用这个结构。

## 扩展与网页

- [扩展 Agent 交互示例](extension-agent-examples/extension-agent-examples.html)：日报、五子棋和书架共用宿主 AI 侧边栏，演示主界面与 AI 读取和操作同一个扩展状态。
- [实用工具与文件夹交互原型](extension-sidebar-study/extension-sidebar-study.html)：简化表头，常用网格末尾展开/收起整段分组列表，收起后释放会话空间；更多菜单添加常用、真实拖拽排序/移动、改名同步、解散/撤销与导航保存。
- [操作说明与验证记录](extension-sidebar-study/extension-sidebar-study.md)；[TSX 源码](extension-sidebar-study/extension-sidebar-study.tsx)、[外壳样式](extension-sidebar-study/extension-sidebar-study.css)。生成并预览：`node scripts/build-extension-sidebar-study.mjs --serve`。

## 聊天与智能界面

- [思考文字离开方式演示](thinking-sweep/index.html)：同一段思考文字三栏同时播放，对照「换行向上」（当前效果）、「向左扫出」与「左移淡出」（拟议方案）三种离开动画；可暂停、重播和调速。

- 调度的随身应用 · Metro 原型包含手机式待办、外部短信的本地演示、RSS 阅读器和磁贴开始屏。离线 HTML 支持三屏与单屏、深浅主题及点击操作。[打开原型](agent-apps-metro/index.html) · [设计与验证说明](agent-apps-metro/README.md) · 应用平台草案

- [子代理职业头像](subagent-avatars/README.md)：用户最终确认的 24 个简约扁平符号、裁切/透明处理脚本和早期方案来源；[正式实现](../features/subagent-characters.md) 包含 AI 选角和汇报身份。
- [子代理通用化原型（左栏树 + 下钻面板）](subagent-tree-drilldown/subagent-tree-drilldown.html)：子代理作为带 `parentSessionId` 的普通会话——左栏缩进挂树（父子链总深度上限 3 层，第四层灰显演示拒绝），中栏整页下钻、顶栏层级路径可回跳且区分会话/子代理/孙代理，父视图挂子代理卡片，注入卡演示子↔父双向通信；第二个会话的子代理标 Claude，说明不再锁死 Pi。[设计与交互清单](subagent-tree-drilldown/subagent-tree-drilldown.md)；方案见 子代理通用化计划。
- [智能界面组件演示](intelligent-ui/index.html)：生成式交互 UI 的 preset 八组件（table/kv/stats/compare/chart/steps/checklist/controls）全量形态与设计语言验证——主题 token 双源投影、深浅切换、ma-ui-runtime 种子渲染器、browser 模式链接卡与回填交互。[设计说明](intelligent-ui/README.md)；方案见 智能界面实施计划。

## 任务与工作区

- [工作区软件分类图标](workspace-icons/README.md)：已批准的 36 个软件/游戏符号原图、裁切坐标与透明资源重建脚本；[正式实现](../features/workspace-icons.md)。
- [任务与工作区简洁原型](task-workspace-simplification/task-workspace-simplification.html)：两页可点击预览；源文件夹收为紧凑列表，逐项展开操作，低频选项折叠。[设计与验证说明](task-workspace-simplification/task-workspace-simplification.md)。

## 右侧内容区域

- [统一多标签原型](side-tools-tabs/side-tools-tabs.html)：已评审的历史原型；左边统一内容标签，右上三段式纯图标胶囊，资源树跟随内容，普通标签随会话、Pin 随项目，聊天交付物新开，文件单击预览、双击或编辑保留，仓库与独立 Diff 可并排审核。[原型规则与验证说明](side-tools-tabs/side-tools-tabs.md)，[正式实现](../features/right-workspace-tabs.md)。31 项原型组件 / 状态用例及深浅主题、窄布局 Chromium 检查属于历史记录，正式双顶栏与验收以功能文档为准。生成、包装与浏览器回归步骤见说明；附件示例使用代码生成 SVG，不依赖自测截图。

## Composer 与消息输入

- [页面折信发送动画](envelope-send/README.md)：上下各 1/3 同步内折，自然露出固定袋体，入袋后随上飞合盖，竖直加速飞出；支持重播、慢放、暂停和逐帧拖动。仅交付动画，待另一任务接入会话间消息卡片。[直接预览](envelope-send/envelope-send.html)。
- [composer-queue-study.css](composer-queue-study/composer-queue-study.css)
- [composer-queue-study.html](composer-queue-study/composer-queue-study.html)
- [composer-queue-study.tsx](composer-queue-study/composer-queue-study.tsx)
- [composer-related-study.tsx](composer-related-study/composer-related-study.tsx)
- [composer-send-actions-study.html](composer-send-actions-study/composer-send-actions-study.html)

## 记忆中心

- [memory-center-pages.html](memory-center-pages/memory-center-pages.html)
- [memory-center-polish.html](memory-center-polish/memory-center-polish.html)
- [memory-empty-states.html](memory-empty-states/memory-empty-states.html)
- [memory-entry-lifecycle.html](memory-entry-lifecycle/memory-entry-lifecycle.html)
- [memory-flow-overview-clean.html](memory-flow-overview-clean/memory-flow-overview-clean.html)
- [memory-flow-overview.html](memory-flow-overview/memory-flow-overview.html)
- [memory-namespace-global.html](memory-namespace-global/memory-namespace-global.html)
- [memory-reject-fate.html](memory-reject-fate/memory-reject-fate.html)
- [memory-review-expand.html](memory-review-expand/memory-review-expand.html)
- [memory-search-lab.html](memory-search-lab/memory-search-lab.html)
- [memory-staging-pool.html](memory-staging-pool/memory-staging-pool.html)
- [memory-terminology-narrative.html](memory-terminology-narrative/memory-terminology-narrative.html)

## 看板、主题与布局

- [Windows 分屏方式原型](center-split-snap/center-split-snap.html)：已评审的历史原型；整块面板提起，顶部选择布局小格，源面板保持清晰浮窗，磨砂只提示落点，松手落位后选择空位会话。原型保留两格、三格、四格及窄屏切换，51 项组件用例与真实 Chromium 检查通过；[正式实现](../features/center-split.md) 已限制最多三格并保留其他已占用内容。[设计与验证说明](center-split-snap/center-split-snap.md)；预览：`node scripts/build-center-split-snap.mjs --serve`。

- [分屏顶部把手原型](center-split-handle/center-split-handle.html)：历史交互方案；默认无顶栏，顶部悬浮显现居中三个点与渐隐背景；拖起整块面板，另一块先铺满，达到边缘阈值后两块真实内容按最终尺寸分屏，分别裁剪高斯模糊，并显示实际1px分隔线。没有描边空槽或额外标题，移出恢复浮动；边缘松手提交，取消恢复，关闭铺满。18项组件验证、深浅主题30张浏览器截图及持久视觉回归通过；该停靠方式已由 Windows 式 Snap 取代。[设计与验证说明](center-split-handle/center-split-handle.md)；生成与本机预览：`node scripts/build-center-split-handle.mjs --serve`。

- [全局看板参考风格原型](global-board-reference/global-board-reference.html)：全局看板界面形态对照——状态/自由视图切换、仅当前工作区过滤、批量清理与归档、新建入口和页脚摘要，深浅主题预览可切换。
- [全局看板视觉布局原型](global-board-reference/global-board-visual-layout.html)：全局看板另一版视觉布局设计稿，视图切换与批量清理等工具并入标题行，信息结构与参考版一致，深浅主题预览。

- [board-card-height.html](board-card-height/board-card-height.html)
- [board-glow-redesign.html](board-glow-redesign/board-glow-redesign.html)
- [frame-backdrop-templates.html](frame-backdrop-templates/frame-backdrop-templates.html)
- [静态毛玻璃材质原型](frosted-glass-study/frosted-glass-study.html)：主题色透过雾面，深浅主题、底色、雾度和原纯色对照；仅生成静态贴图。正式实现与验收见 [窗口材质](../features/frame-backdrop.md)。
- [原生侧栏材质小样](native-material-demo/README.md)：独立 Electron 窗口，Acrylic / Mica / 实色与深浅主题对照；仅侧栏露出系统材质，中右保持实色。运行：`node scripts/native-material-demo.mjs`。
- [sidebar-status-capsule-study.html](sidebar-status-capsule-study/sidebar-status-capsule-study.html)
- [ui-focus-material-readability.html](ui-focus-material-readability/ui-focus-material-readability.html)
- [ui-second-pass.html](ui-second-pass/ui-second-pass.html)

## Skills 与 MCP

- [能力管理交互原型](skills-manager/skills-manager.html)：全局/项目与继承分组、逐 Agent 关联、共享正文编辑、模拟 CLI 新建发现、同名来源对比和 MCP 连接状态。[交互与验证说明](skills-manager/skills-manager.md)；生成并预览：node scripts/build-skills-manager-prototype.mjs --serve。

## 设置与整体重设计

- [配色真实组件对照](color-system-native/color-system-native.md)：已获用户授权的历史方向对照；实际 Electron 工作台中保留基础色、字体与布局，比较原版与局部微调。生产配色已迁移，当前证据见 生产覆盖与视觉复核；对照截图仅留本机，隔离方式和材质边界见说明。
- [配色系统独立设计稿（2026-10-09）](color-system-study/color-system-study.html)：soft / clear 两版均未获用户接受，保留为历史设计记录；原验证不能作为新方向验收。对应 全面审查、顶层方案 与 [历史验证说明](color-system-study/color-system-study.md)。

- [设置重设计原型](settings-redesign/settings-redesign.html)；阶段截图归在 `settings-redesign/`。
- [设置重设计原型 v2 · 沉浸版（2026-10-08 提案）](settings-redesign-v2/settings-redesign-v2.html)：13 页统一 920px 单列宽，去节级卡片盒子，区域划分靠节标题+字阶+留白，线条只给表格型列表；设置行/字段行/列表行三种行原语、控件一套皮肤、「即时生效」节级标记、危险动作固定行；模型服务商/能力管理/文本工具从左右分栏改纵向手风琴；含现状六类不统一诊断与各页落点说明，深浅主题可切换、开关联动保存条。截图归在 `settings-redesign-v2/`。（同日早一版卡片式布局被用户否决，已由本版取代）
- [整体重设计原型](redesign/ui-redesign.html)；阶段截图归在 `redesign/`。

## Pi 轨迹透明模式

- [交互 demo](pi-trajectory-demo/trace-demo.html)
- 关闭、开启、展开与抽屉四态可在交互 demo 中重新查看；历史自测截图仅留本机，不随 Git 分发。

源码研究稿（`.tsx` / `.css`）与 HTML 同名实验稿在所属原型文件夹内并列保存；截图按所属实验在本机归档，生成产物由 `.gitignore` 排除。

## 仓库外归档

- **动映 · 代码动画** · [正式扩展](../features/code-animation.md)

  ZIP 的 SHA-256 为 `3388c564894401cb750cb79ff6e3d529ee187f956a67683253e38d9ed5042f4c`。
