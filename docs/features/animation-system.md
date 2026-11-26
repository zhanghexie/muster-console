# 动画系统（motion tokens + presence）

全应用统一的进出场/切换动画体系。原则（用户定稿）：非线性、整体公用一套曲线；可打断（从哪里来、回哪里去）；流畅而克制。调研与决策全记录见 audits/animation-system-research.md；2026-09-28 的整体修正见 plans/motion-fixes-plan.md（已实施）。

## 职责

静止阅读层不常驻强制合成：横向虚拟屏使用 2D `translateX` 与既有 transform transition，不设置常驻 `will-change`；纵向工作区在 `.ws-rail-idle` 恢复 `will-change:auto`，移动阶段仍保留合成提示。避免祖先 3D 层使 Markdown 等文字在 Windows 下失去次像素抗锯齿。回归见 `test/unit/reading-compositing.spec.ts`。

保活叠放页的品牌加载动画在任一外层 `.xfade` 未选中时暂停（`brand-loading.css` 的 `animation-play-state`），内层 `is-shown` 不能覆盖隐藏外层。显示后从原相位恢复，不重建图形或更改循环时长；减少动态效果仍关闭动画。避免隐藏 Git/工具标签的 SVG 持续触发布局。组件回归见 `brand-loader.spec.tsx`，真实 Chromium 的嵌套显隐、相位恢复和减少动态效果见 `test/fixtures/virtual-screen-perf/`。

CLI 输入区使用 `usePresence` + `mp-panel`/`mp-pop` 从胶囊位置缩放进出，吸边位移使用 transform token；展开面板外壳从测量得到的胶囊边缘持续可见地缩放，外壳由胶囊透明度过渡到不透明，展开后保持不透明；调整尺寸后重新计算缩放原点，原点允许位于面板外以对齐贴在远侧的胶囊。过渡期间胶囊外壳透明、按钮淡化，面板内容稍后淡入；收起反向交接，面板退场结束后才隐藏保活的输入区并恢复胶囊外壳，快速反向切换从当前位置继续。轻微动态档沿用较小的面板位移并淡化，减少动态档即时切换。建议提示让展开图标以 opacity/transform 呼吸，隐藏会话暂停、减少动态效果时关闭。终端空白长按使用同一套可反向打断的面板在场状态预览：预览面板落定后，图标以 `--dur-breath / 3` / `--ease-loop` 放大；输入框或胶囊内层同时按八段 `--dur-breath / 24` / `--ease-loop` 逐渐增强缩放颤动，小胶囊使用更大的缩放差以保持可见，不覆盖 `mp-panel` / `mp-pop` 的 transform。该颤动期也是约 600 毫秒的可取消窗口，JS 与 CSS 均使用同源 breath token，各段依次计时避免渲染卡顿后集中跳过。到阈值更换图标，两者以 `--dur-micro` / `--ease-standard` 回弹；提前松手从当前值反向恢复。减少动态效果时取消缩放，但保留手势阈值。

- 唯一的曲线/时长来源（CSS 变量 token），改一处全局生效；
- 可打断的进出场机制（`usePresence` / `usePresenceValue` + CSS **transition**，非 keyframes）；
- 本机动效档位与系统减少动态效果共同决定有效模式，CSS 与在场/滚动控制器即时响应；
- 五类场景骨架类：面板弹窗（`mp-panel`）、菜单浮层（`mp-pop`）、遮罩（`mp-scrim`）、视图叠放「先出后入」（`xfade`/`xfade-stack`，高频切换用 `xfade-instant` 瞬切）、手风琴（`acc`）。

## 浏览器自有 picker 的限定例外

`CustomSelect` 的现代路径使用 `appearance: base-select`；`::picker(select)` 属于浏览器，React 无法挂载其伪元素或通过 `usePresence` 延迟卸载。它使用 `@starting-style` + 可反向 transition，视觉属性仅 opacity/transform；display/overlay 的 `allow-discrete` 只保留绘制与顶层身份，不做尺寸动画。入场使用 `--dur-menu`/`--ease-standard`，退场使用 `--dur-micro`/`--ease-exit`，缩放沿用 mp-pop 的 0.98/0.985。subtle 取消缩放，用户 reduced 或系统 prefers-reduced-motion 关闭过渡。该例外不适用于普通 React 弹层；旧浏览器 `CustomSelectFallback` 继续用 usePresence/mp-pop。

真实 picker 的开关、快速反转、减少动态效果由 `test/fixtures/custom-select-native-scenario.mjs` 验证；组件接线见 `test/unit/custom-select-native.spec.tsx`。

## 关键文件

在场状态与交互注册：`stage` 是 CSS 动画阶段，不能单独当作“当前可交互”。初始关闭和退场卸载后均为 `mounted=false, stage='enter'`。常驻弹窗的 `useOverlayDismiss` 必须同时检查 `presence.mounted && presence.stage !== 'out'`，避免不可见弹窗截走终端 Esc；关闭退场阶段立即释放 Esc，退场完成后也不得重新注册。回归见 `test/unit/overlay-presence-escape.spec.tsx`。

| 文件 | 内容 |
|---|---|
| `src/renderer/src/styles/base.css` | `:root` 内 `--ease-*`/`--dur-*` token；文件末段 mp/xfade/acc 骨架、轻微档位移、复制反馈原语与用户/系统 reduced 全局兜底 |
| `src/renderer/src/components/motion.tsx` | `usePresence(open)`（三态 enter/in/out + 延迟卸载 + 反向打断回弹）、`usePresenceValue(value)`（值驱动 + 退场期冻结快照）、`prefersReducedMotion()`、`MOTION` 常量（与 CSS 对齐，`test/motion-token-sync.mjs` 守） |
| `src/renderer/src/components/AnimatedDetails.tsx` | **可动画折叠 details（2026-10-31）**：保留原生 summary 语义、接管开合；acc 0fr↔1fr + presence 延迟卸载，收起态内容零挂载。工具卡/思考卡/harness 标注共用 |
| `src/renderer/src/chatSurface/smoothComposerHeight.ts` | **输入条高度弹簧（2026-10-31）**：可见会话的 composer 悬浮层高度变化经弹簧逐帧写显式 height，`--composer-overlay-h` 同步跟随；隐藏时停用并清除显式高度，重新显示时在绘制前直接采用当前自然高度，避免带动消息滚动。弹簧常量在 spring.ts（非 token 时长） |
| `src/renderer/src/interactionPreferences.ts` | `muster.interaction.v1` 本机偏好及订阅；系统 matchMedia/storage 实时同步，根 `data-ui-motion` 表达有效档位 |
| `src/renderer/src/chatSurface/transcriptScrollController.ts` | 会话滚轮/跳转/贴底的有界动画；token 时长与曲线、用户输入取消、偏好变化结束当前动作，隐藏时停止 RAF。2026-10-30 起流式贴底改为二阶阻尼弹簧（`spring.ts` 的 k/c 是物理常量，非 token 时长），与流式揭示引擎（`useStreamReveal.ts`）共用全局单 rAF ticker（`revealTicker.ts`），详见 [chat-transcript.md](chat-transcript.md) |
| `src/renderer/src/components/settings/shared.tsx`、`src/renderer/src/styles/settings.css` | `Segmented` 常驻共享底片，按钮保持原宽/位置，仅平移底片；尺寸/字体/可见性事件校准 |
| `src/renderer/src/styles/left.css`、`src/renderer/src/styles/extension-navigation.css`、`src/renderer/src/styles/right-workspace.css` | 常驻 2×12px 焦点伪元素、行内操作透明度和仅图标微按压；保留拖放标记及按钮命中区域 |
| `src/renderer/src/components/CollapsibleRailStack.tsx` | 左栏分组共用折叠栈，presence + acc 过渡轨道高度，实用工具保留原位置的首行，会话和终端用 transform 保留当前项，隐藏项 inert |
| `src/renderer/src/components/UtilityNavigationSection.tsx` | 实用工具磁贴保持原网格，扩展树通过 presence + acc 退场并立即设为 inert |
| `src/renderer/src/workspaceTransit.ts` | 工作区切换过场状态机（arm → to-skel → 切区 → fade）+ `useWorkspaceTransitSwitch` 统一入口 |
| `src/renderer/src/panels/CenterPanel.tsx` | `UtilityLayer` keyed 层列表：中栏工具面板 A→B「先出后入」、旧层保留原实例 |
| `src/renderer/src/components/envelope/*`、`styles/mail-envelope.css` | 前台代理邮箱：共用原型 `EnvelopePaper` 网格和原生 transition。寄件侧在上飞起点提交待寄邮件，垂直轨道等收到存信回执再运行；收件侧从存信事件合并展示，反放沿用同一逻辑时钟。外层 `MailEnvelopeViewport` 使用 presence、前台取消与减少动态效果下的静态展示 |

## Token 词典

```css
--ease-standard: cubic-bezier(0.16, 1, 0.3, 1);  /* 入场签名：快起缓收（easeOutExpo 型） */
--ease-exit:     cubic-bezier(0.4, 0, 0.2, 1);    /* 退场：缓起快收 */
--ease-hover:    ease-out;                         /* 微交互 */
--ease-move:     cubic-bezier(0.33, 0.1, 0.25, 1); /* 大位移（虚拟屏/工作区胶片/全局看板） */
--ease-loop:     cubic-bezier(0.37, 0, 0.63, 1);   /* 循环装饰（对称缓入缓出） */
--dur-micro:   120ms;  /* hover/图标；菜单退场；xfade 旧视图淡出 */
--dur-menu:    160ms;  /* 菜单/小浮层 */
--dur-panel:   280ms;  /* 面板/弹窗入场 */
--dur-exit:    200ms;  /* 面板类退场（菜单退场用 --dur-micro） */
--dur-move:    420ms;  /* 大位移（虚拟屏/工作区胶片/全局看板整屏下拉/终端扫描揭幕） */
--dur-workspace: 360ms; /* 工作区胶片位移，短于通用大位移 */
--dur-workspacefade: 160ms; /* 工作区胶片切区后的骨架淡出 */
--dur-stagger:  30ms;  /* 级联步长（工作区栈逐层延迟、扫描下划线逐项延迟） */
--dur-loop:    900ms;  /* 循环装饰·快档：旋转/闪烁（spinner、光标、骨架光标） */
--dur-breath: 1800ms;  /* 循环装饰·慢档：呼吸/起伏（需要你、打字点、脉冲、shimmer；更大面积取其倍数） */
--spinner-stroke: 1.4; /* 运行态 spinner 线宽（IconSpinner 唯一点） */
--spinner-dash: 75 25; /* pathLength=100；75% 弧 + 25% 缺口 = 90° */
```

`MOTION`（motion.tsx）与每个 `--dur-*` 一一对应（`microMs`…`breathMs`），键与值都由 `test/motion-token-sync.mjs` 校验；渲染层禁止再定义具名时长常量（`WS_SLIDE_MS` 之类，同一守卫拦截），JS 侧计时一律读 `MOTION`。`test/motion-skeleton-css.mjs` 守 styles 下无字面量时长（reduced-motion 兜底的 `0.01ms`/`0s` 除外）。

循环装饰只有两档节拍：快档 `--dur-loop`（闪烁/旋转）、慢档 `--dur-breath`（呼吸/起伏），大面积慢物体取慢档的倍数。看板探出采用 20px 上下浮动（`g-board-peek-bob`，`--peek-breath=calc(var(--dur-breath) * 1.75)`，默认 3.15 秒），并叠加用户指定的 Libraries.dev `border-beam` 的 line 彩色底边装饰，流动周期传入 `MOTION.breathMs * 1.5`（默认 2.7 秒）；库内部的渐变角度、滤镜与装饰淡入由库生成，不用于面板进出场。Beam 常驻包裹真实 BoardPanel 内容，两种装饰都只在探出落定时运行，悬停/聚焦同时暂停浮动与光效流动/呼吸/闪光（保留光效淡入），减少动态关闭浮动并仅隐藏装饰伪元素/光晕，展开/退场即时停止循环与装饰；不隐藏或重挂载内容容器。旧看板反光与渐变灯带保持移除。文字类呼吸（气泡「运行中」）低谷不低于 0.75 透明度，保证可读。

运行态 spinner 相位：CSS `animation` 从各元素挂载时刻起表，后出现的缺口会永久错开。`IconSpinner` 挂载时写 `animation-delay: -(now % --dur-loop)`（`motion.tsx` 的 `spinnerPhaseDelayMs`），任意时刻缺口朝向一致。禁止拉长 `--dur-loop` 掩盖错位，也勿在 CSS 覆写 delay。

## 机制：为什么是 transition 而不是 keyframes

transition 改目标值即从**当前插值位置**续走——退场中途重开，直接回弹到入场目标，天然可打断（h-strip 平移已验证多年）。keyframes 重启会跳变（GlobalBoard 已于 2026-10-05 改用 presence + transition）。因此约定：**进出场一律 transition，keyframes 只允许一次性内容入场**（如看板归档列）与循环装饰。

`usePresence(open, exitMs)`：
- `open=true`：挂载 + `enter`（CSS 起始态，`transition:none`）提交到 DOM → 同一次提交的 layout 阶段读一次 `document.body.offsetWidth` 强制样式计算，让起始态成为「已计算样式」→ 同步切 `in` 起播。入场在首帧即开始，不空等定时器，也不受后台定时器节流影响；
- `open=false`：`out` 播退场，`exitMs+80ms` 兜底后卸载；
- `out` 期间 `open` 回真：取消卸载、回 `in`，从当前位置回弹（不经过 enter）；
- 首挂载 `open` 即 true 也播 enter→in（菜单类「挂载即入场」复用：`usePresence(true)`）。
- 有效减少动态效果时直接进入 `in` 或卸载，不读 enter 起播布局、不等待退场兜底；偏好或系统在退场中切到减少时，订阅会立即取消旧计时器，快速重开不会被迟到计时器卸载。

`usePresenceValue(value, exitMs)`：value 非空即打开；转空时返回最后一个非空值直到卸载（退场期内容不闪空）；非空→非空直接换内容不过场（队列换请求、面板换区）。ConfirmDialog、ExtensionUiDialog、EvidencePanel、PromptTaskPanel 详情、Tooltip、AgentFloat 对话面板都用它，不再手写 `snapRef`。

调用方挂法：`<div className="xxx mp-panel" {...presence.spread}>`（spread 即 `data-mp-stage`）。**退场层自动 `pointer-events:none`**，快照闭包悬空调用被天然免疫。

动效设置来自通用页「滚动与动效」，与滚轮手感/距离一起保存在 localStorage `muster.interaction.v1`，即时生效且不进 `AppConfig` 草稿。默认 `system`；`subtle` 保持公共骨架 token 时长与曲线，把 mp-panel 入/退位移缩到 3/2px、菜单缩放更接近 1，mp-pop-up 入/退位移缩到 2/1px；不改变稳定态布局。`reduced` 或系统 `prefers-reduced-motion: reduce` 任一成立即有效减少，系统要求不能被轻微档覆盖。根 `data-ui-motion` 写有效值，存储仍保留用户所选档；CSS 同时保留系统媒体查询以覆盖初始化前。

有效减少时 CSS 关闭公共骨架过渡，全局动画时长压到 0.01ms、循环次数为 1、过渡延迟清零，enter 起始态直接取目标值；用户减少档还把 CSS scroll-behavior 设回 auto。左栏/实用工具与扩展树的静态焦点伪元素在用户/系统 reduce 下显式 `transition:none`，保证直接取选中或未选中目标值；极短但非零的 duration 仍会创建 transition，不能单凭时长推断即时终态。`prefersReducedMotion()` 转读独立偏好模块；`usePresence` 通过布尔 external-store 快照订阅用户/系统变化，会话滚动控制器同样订阅并结束当前动作。其他 JS sleep/兜底计时须在动作前读该函数；若动作需要响应中途变化，须订阅取消，不能仅依赖 CSS 缩短时长。滚轮增强的设备启发式和原生回退边界见 [settings.md](settings.md)。

## 骨架类适用场景

| 类 | 场景 | 位移 |
|---|---|---|
| `.mp-panel` | 弹窗/大面板（居中） | translateY(8px)+scale(0.985) |
| `.mp-panel-top` | 顶部轻提示（BootStatusBanner 等），与 mp-panel 并用 | 自上而下 8px |
| `.mp-panel-fly` | 顶栏下方整面板（反馈审核、运行监视器、搜索和全局看板） | 保持不透明，滑过窗口上缘，给投影留出退场距离 |
| `.mp-pop` | 菜单/小浮层（右键、下拉、popover、Tooltip） | scale(0.98)，无轴向位移；退场 `--dur-micro` |
| `.mp-pop-up` | 向上弹的菜单（composer），与 mp-pop 并用 | 自下而上 4px |
| `.mp-scrim` | 全屏遮罩 | 仅 opacity |
| `.xfade-stack` + `.xfade` | 常驻视图叠放互切（页签/双视图） | 仅 opacity + visibility 延迟收口，「先出后入」 |
| `.xfade.xfade-instant` | 高频实例切换（工作会话），保留叠放保活结构 | 无过渡，瞬切 |
| `.acc` + `.acc-body` | 手风琴（grid-rows 0fr↔1fr，内容保活） | 高度 + opacity；展开 `--dur-panel`，收起 `--dur-exit`/`--ease-exit` |
| `.agent-float-panel.is-*` | 调度对话浮窗专用（stage 映射 is-entering/is-open/is-exiting） | translateX(-12px)+scale(0.96)，原点对准来源工作区行 |
| `.main-view.sessions-peek .ws-stage` | 折叠左栏临时速览 | 工作面 translateX(`--sessions-col-w`) 露出下层左栏；入场 `--dur-panel`，收回 `--dur-exit`，工作区胶片过场时先关闭 |

退场档：面板类退场 `--dur-exit`，菜单类（`mp-pop`）与视图淡出（`xfade`）退场 `--dur-micro`。

顶栏飞入面板的上层卡片与 `.mp-scrim-layer.backdrop-blur-overlay.mp-scrim` 是同一定位容器内的兄弟层。外壳负责定位与层叠，磨砂遮罩在下层淡入淡出，内容卡片保持实底并仅过渡位移，避免收起时父子透明度叠乘透出工作台文字。macOS Vibrancy 下，临时背景采样边界避免原生窗框上残留上一帧，框色衬底按同一遮罩阶段和 token 淡入淡出，详见 [窗口背景](frame-backdrop.md)。关闭即释放命中，退场期保留 DOM 以支持反向打开。全局看板的遮罩由展开状态驱动，收回到探条和完全关闭均淡出，稳定探条没有遮罩。`test/e2e/panel-exit-layering.spec.ts` 在虚拟屏双页布局检查四个面板的退场和材质分支。

全局看板状态/自由视图使用 xfade 常驻骨架的 `board-slide` 修饰：保持 opacity=1，以 `--dur-panel` / `--ease-standard` 做双向 translateX 平移，退出层延迟 visibility 收口，隐藏层即时 inert/aria-hidden，父层裁剪。两层不重挂载，连续切换从当前插值反向续走。`test/unit/board-card-layout.spec.tsx` 守状态、保活和样式契约。

全局看板状态列的工作区文件夹使用 `usePresence` + `acc`/`acc-body`：折叠立即 inert/aria-hidden，退场完成后卸载内容，快速重开可反转；工作区组的开合状态在看板挂载期间保留。

### xfade「先出后入」

旧视图 `--dur-micro` + `--ease-exit` 淡出；新视图 `--dur-panel` + `--ease-standard` 淡入，但延迟 `calc(var(--dur-micro) / 2)`——两屏文字不会在同一时刻以可辨认的透明度叠印（旧版两层同时交叉淡化会叠字）。`visibility 0s linear var(--dur-micro)` 延迟收口保证隐藏期不可交互/聚焦。空档期会透出叠放宿主的底色，**宿主底色须与所在页一致**。

工作会话切换（TerminalView `terminal-wrap` / AgentChatView `agent-chat-view`）是高频操作，挂 `xfade-instant` 瞬切：仍保留叠放保活（不重建 xterm），只去掉过渡。

### 中栏工具层：keyed 层列表

工具层不另涂底（透出中栏页的中性实底，design.md §1.1），底层内容由 CSS 藏起：`.center-panel:has(> .center-utility-layer:not([data-mp-stage='out'])) > .xfade` 置 `visibility:hidden`——只要有未退场的工具层，终端/对话视图就不参与绘制。

CenterPanel 以 selection 为 key 在同一父节点下渲染层列表（当前面板 + 仍在退场的旧面板，按首次打开顺序排，顺序稳定不移动 DOM——扩展 iframe 被移动会整页重载）。A→B 时 A 的实例原地转 `out`，**不重新挂载**（滚动位置、已加载数据、扩展 iframe 都保留）；退场中切回 A 直接回弹到 `in`；层自己播完退场后经 `onGone` 摘除，快速连切任意多层都各自淡出。时序同 xfade「先出后入」：退场层 `--dur-micro` 淡出，有层在退场时新层延迟 micro/2 入场；A→null 时退场层转 out 即解除遮藏，终端 `.xfade` 以同款延迟淡回。`test/unit/center-utility-crossfade.spec.tsx` 守「旧层必须淡出 + 不重挂载 + 回弹」。

**两个时序约束**：① 新面板入列必须写在渲染期（渲染期 setState），放 useEffect 会在 paint 后才挂层——切换首帧新层缺席，闪出一帧底层内容（用户验收抓到的回归）；② 层卸载那一拍必须返回 null，不能留 `enter` 态空壳（`:has(:not(out))` 会误藏终端闪一帧）；逐帧验证须从切换起采样（rAF 记录合成不透明度），80ms 后才采样会错过首帧盲区。

**嵌套不变量（2026-08-29 补）**：`visibility` 与 `pointer-events` 都能被**后代元素显式写回**——隐藏的 `.xfade` 里若嵌着另一个常驻栈的 `.is-shown`（如未激活 Git 页的 `.git-detail-pane.is-shown`），子树会整体恢复可见/可命中，形成「看不见但吃掉点击/滚轮」的透明层（文件预览区被压失灵的根因）。base.css 已加兜底：`.xfade:not(.is-shown) .xfade.is-shown` 强制回隐，退场沿用延后 visibility 时序、不破坏外层淡出。新做常驻叠放时不要把 is-shown 子栈放进可被整体隐藏的宿主；不可避免时依赖该规则。

### 工作区切换过场

`workspaceTransit.ts` 纯状态机（依赖全注入，单测 `test/unit/workspace-transit.spec.ts`）：先读取目标工作区的布局快照，`arm`（按目标布局锁骨架、实况与骨架并排）→ 下一帧 `to-skel`（`--dur-workspace` 滑到骨架）→ 骨架盖满后才发切区 IPC → 等目标工作面提交并完成一帧可见布局后 `fade`（只淡出盖在实况上的骨架，`--dur-workspacefade`）→ 撤场。目标布局读取失败时回退当前布局。过场期间左栏会话/工具栈暂停同步几何读取和活动行自动滚动，撤场后补一次测量与 reveal，避免保活 DOM 在滑动窗口内强制布局。

- 切区 IPC **不能**与滑动并行：主进程 `workspaces:switch` 内即广播 `workspaces:changed` 并重放工作区主题，滑动途中发出会在仍可见的实况半屏上闪出新区（计划原写「并行」，实施时据此改为保持串行，只在淡出段省时）；
- 防重入「以最后一次为准」：滑动或切区 IPC 期间的新请求只记 pending，骨架下直接切到最后一次的目标，不再滑第二次；fade 期到达的请求在本次撤场后另起完整过场；失败撤场不淡出；
- 减弱动态：不滑不淡直接切区；
- 桌面所有入口（顶栏、命令面板、用量统计、看板、调度浮窗工作区栈、会话跳转）经 `useWorkspaceTransitSwitch(switchWorkspace)` 取 App 提供的带过场切区，无 Provider（手机端/单测）回落 store 直切。store 的 `switchWorkspace` 以 ref 判重（同一 id 连点不重复发 IPC）。

## 已接入清单

- 弹窗族：设置、命令面板（QuickOpen）、ConfirmDialog（含入站 MCP TOFU 审查体）、AppConfirmDialog（含 6 调用点 open prop 化）、NewTaskDialog、CreateWorkspaceModal、ExtensionUiDialog、EvidencePanel、PrCreateDialog、FeedbackCenter（顶栏下方飞入 + 磨砂层）、ProcessMonitorPanel（与全局看板共用飞入/飞出和磨砂层节拍）
- 菜单浮层：ContextMenu、顶栏工作区/扩展 overflow 菜单、GitBranchPopover、Composer plus/模型菜单、CustomSelect、聊天「滚动到底部」浮钮（mp-pop-up）、全局 Tooltip（退场可播，热身免延迟，见 [menus-and-tooltips.md](menus-and-tooltips.md)）
- 视图切换：Files↔Git 侧工具页、设置页签（滚动下放各页，含通知偏好免打扰 acc 手风琴）、对话↔轨迹、文件编辑↔预览（CM 保活）、Git 工作↔历史——均「先出后入」；**工作会话切换**（terminal-wrap/agent-chat-view）叠放保活 + `xfade-instant` 瞬切；Git PR 页签为常驻列表无独立进出场骨架
- 调度对话浮窗（AgentFloat）：`usePresenceValue(chatWorkspaceId)` 驱动面板与公共磨砂遮罩，退场中再点头像可回弹，开着换区只换内容不重播，见 [sessions-dock.md](sessions-dock.md)
- 调度并排对话：`usePresenceValue` 驱动整组在场，`mp-scrim` 淡入同单窗的磨砂遮罩。各列在独立尺寸的槽位中用 `mp-panel` 从工作区栏方向飞入，复用单窗缩放原点计算，以 `--dur-stagger` 错峰并封顶三步。拖动只更新槽位布局，每帧至多一次。收起各列同时飞回，退场时冻结会话内容，中途重开沿当前插值继续并跳过错峰。减少动态效果时立即切换，见 [调度面板入口](scheduler-panel-entry.md#并排对话)。
- 图片查看器：用图片地址驱动 `usePresence`，让独立磨砂遮罩淡入淡出。关闭立即隐藏图片和工具条、释放 Esc 与命中，退场中重开沿当前遮罩透明度反转。
- 调度面板整理：读取各槽位的原始边界，提交默认尺寸后通过 `transform` 把每列绘制回原边界，再以 `--dur-panel` / `--ease-standard` 同步平移与缩放到新布局。逻辑尺寸一次提交，滚动范围由槽位布局确定。整理使用外层槽位，开合继续由内层 `mp-panel` 驱动。再次拖拽接管布局，减少动态效果即时复位。
- 调度状态色条和筛选弹层复用 `usePresence` 与 `mp-pop`。色条从当前圆点左侧展开，筛选弹层跟随顶栏漏斗。动作区退场时立即停用交互，减少动态效果即时切换。
- 调度应用手机（AgentPhone）：透明外层覆盖调度面板，`usePresence/mp-panel` 向上滑入/向下滑出；App 页使用原型的 WP8 Turnstile Feather，旧磁贴翻出与新内容飞入交错进行。场景层透明、只让子元素旋转/淡出，避免实底新页掩盖旧磁贴；自动展示节奏较快但保留完整可见切换，token 时长/错峰有界，退出页 inert，结束清除3D变换，见 [agent-apps.md](agent-apps.md)。
- 手机 toast：`ma-toast-in` 为一次性内容入场（仅 opacity keyframes + token 时长），非面板进出场
- 面板：中栏工具面板（keyed 层列表，A→B 先出后入 + 开关；网页/扩展层退场后 display:none 保活，切区清理）、左栏工具/会话/终端分组栈（presence + acc，收起保留工具首行或会话/终端当前项，隐藏项 inert，原 DOM 保活）、任务详情手风琴、看板归档列（grid 轨道过渡）、Git 仓库列表收起（宽度收拢）、**会话回合折叠体（ChatMessageView，2026-10-31）**：折叠头置顶 + acc 0fr↔1fr 展开/收起，`usePresence` 延迟卸载播退场；稳态收起 wrapper 不挂载（真卸载契约不变，见 chat-transcript.md）、**会话内全部 details 展开（AnimatedDetails，2026-10-31）**：工具卡详情/思考卡/harness 标注，收起零挂载 + acc 过渡、**输入条高度弹簧（2026-10-31）**：composer 高度与转写让位同弹簧联动
- 全局看板：主动打开（进场/展开）走面板档保证跟手，探出也使用 token transition；usePresence 负责卸载兜底（见 [global-board.md](global-board.md)）。教训：用户主动触发的大面板也不宜上 420ms，大位移档只用于位移本身就是信息的场景（胶片、虚拟屏）与被动通知
- 左栏/扩展树焦点：2×12px 伪元素常驻，原地以 scaleY/opacity 收放；扩展树 before/after 拖放线显式覆盖焦点变换与透明度。会话/右侧标签关闭及更多入口淡入，微按压只缩放 SVG，标签与点击区不移动。
- 设置分段选择：常驻共享底片只平移，宽度即时校准，原生按钮/文字/焦点不动；字体、容器尺寸与保活页重显按事件校准，隐藏零宽不污染旧几何，底片接管时立即撤掉按钮填充。
- 聊天/代码复制：`ChatHoverbar` 与 `MarkdownBody` 代码块共用 `.copy-feedback` 常驻 12px 图标槽，原 IconCopy 淡出缩小、同槽伪元素对勾淡入回正；不插入成功文字撑宽按钮。成功的 1500ms 是业务反馈寿命，不是动画时长 token，连续复制刷新计时、卸载清理，剪贴板失败不进入成功状态。
- 存量字面量已全部 token 化（`motion-skeleton-css.mjs` 守）

## 明确不做（克制决策）

- 树展开（FileTree/GitRepoTree）：VSCode 同款瞬时，图标承担开合指示；
- 轨迹轮次折叠、UsageStats 手风琴：内容行多，保活换动画不值；
- 列表重排（会话列表、看板卡片跨列）FLIP 动画：状态变化已有胶囊颜色承担指示；
- 循环装饰动画（光效/呼吸/spinner）：不重构进出场机制；运行态 spinner 相位由 IconSpinner 负 delay 对齐全局时钟（`spinnerPhaseDelayMs`），用户/系统有效减少动态效果由全局 CSS 兜底。
- 上下文压缩分割线（`CompactDivider`）通过 `usePresence` 和 `--dur-exit`/`--ease-exit` 在进行中与完成状态间交叉淡化。压缩期间显示 `CompactionActivityIcon` 的循环装饰。

## 已知边界

- 输入条高度弹簧是内容尺寸联动的布局例外：JS 逐帧写 `height`，并让转写底部避让同步跟随；它不是面板进出场或可复用的高度过渡骨架。减少动态时沿既有偏好处理；没有对真实大会话的逐帧布局成本作新测量。
- 非减少档 enter→in 起播依赖「layout 阶段强制样式计算」让 `transition:none` 的起始态落成计算样式（Chromium 行为）；若日后发现某处入场不播，先查该元素是否在 flush 前尚未挂进文档（如 portal 目标晚挂），再考虑退回双 rAF；
- 设置弹窗：chunk 在应用空闲时预取并缓存模块，首开组件已就绪可播完整入场；若用户在预取完成前（启动后极早期）打开，仍会首开无入场；
- 气泡 padding/margin 等布局属性过渡债（调研文档「性能债」节）首期未动（原最大头的通知面板 max-height 债已随通知面板整体移除于 2026-09-15 消失）；另有两处 width/height 过渡存量债：气泡 dock 收窄（float.css `.agent-ws-stack-main`：槽位路径 2026-09-14 起改 margin-left 让位+flex 跟缩、头像改 transform，仍剩 margin/width 布局过渡——文字重排无法无失真 transform 化；浮层定宽路径保留 width 过渡）与分栏把手高亮线（base.css `.split-pane-handle-line`）——后者可改 scaleX/scaleY，待拆分时一并处理；
- 「先出后入」空档透出叠放宿主底色：新增叠放宿主时须与所在页同底；
- 运行态 spinner 负 delay 对齐的是 `performance.now()`；窗口后台被浏览器暂停动画后再挂新 spinner，新旧可能再偏一次（已挂载的彼此仍同步）。
- `test/unit/motion-presence.spec.tsx`、`interaction-preferences.spec.tsx`、`settings-segmented-motion.spec.tsx`、`navigation-micro-motion.spec.tsx`、`copy-feedback.spec.tsx` 分别守在场/本机偏好、底片、局部反馈与复制生命周期；`test/fixtures/interaction-motion.tsx` 与场景脚本使用生产组件和主题记录中间态、快速反向、初次/重显填充与减少效果。侧栏夹具行仅证明生产 CSS，不能替代 LeftPanel/扩展导航状态测试；生成截图与实际看过的视觉结论须分开记录。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：全应用统一的进出场/切换动画体系（token+presence 机制），原则为用户定稿：非线性、一套曲线、可打断、流畅而克制。
- 为什么这样设计：曲线/时长唯一 token 源（MOTION 常量同步由 motion-token-sync 守卫，禁另定义具名时长）；进出场一律 transition（可打断回弹），keyframes 只许一次性内容入场与循环装饰；五类骨架类分工（mp-panel/mp-pop/mp-scrim/xfade/acc）；本机档位+系统 reduced 即时生效且系统优先；中栏工具层 keyed 层列表「先出后入」不重挂载；spinner 负 delay 对齐全局时钟。
- 明确不做：树展开/轨迹折叠/列表 FLIP 重排不加动画（克制决策清单成文）；布局属性过渡存量债两处登记待拆分时处理；不用 keyframes 做进出场。
- 歧义点：无真决策（原则为用户定稿；起播依赖 Chromium 强制样式计算、后台 spinner 相位偏移等均为机制内已登记边界）。
