# 会话滚动手感与局部反馈

仅在修改滚轮增强、跳转/贴底跟随或局部反馈动画时读取。正式真实场景与停止条件仍按 `../SKILL.md`，不能以 60fps、零长任务或组件场景通过停止归因。当前入口：`src/renderer/src/chatSurface/transcriptScrollController.ts`、`src/renderer/src/chatSurface/transcriptScrollAnchor.ts`、`src/renderer/src/interactionPreferences.ts`；行为合同见 `docs/features/chat-transcript.md`、`docs/features/settings.md`、`docs/features/animation-system.md`。

## 固定偏好、输入与见证

每份证据记录以下条件，保留原 manifest 和报告快照，不回写旧 baseline：

- `scrollFeel`（native/crisp/soft）、`scrollDistance`（0.5–2）、用户 motion（system/subtle/reduced）、系统媒体查询是否 reduce、根 `data-ui-motion` 的有效值。偏好存储键是 `metaagent.interaction.v1`，独立于 AppConfig。真 app 通过可见设置入口切换，记录原值并在本轮结束恢复；不通过业务 API 改真实任务、消息或会话。
- 输入 `deltaMode`、deltaX/deltaY、修饰键、目标是外层还是嵌套滚动区；输入数量、实际时间戳/cadence、迟到与 CDP ack，不能只记声明的 intervalMs。设备观测与脚本输入分开标记。
- 同一可见 scroller、展开态、起点、方向、内容见证、预估/真实 scrollHeight 与 clientHeight。记录可见消息锚点/偏移；真实 ID/selector 只留本地，正文不落报告。
- 每段输入前/中/后位置、可见内容位移、目标和未呈现余债、最后输入到落定时间、反向制动、隐藏/切出后的停止状态。工具没有提供的字段明确标为未采集，不凭等待时间或私有对象猜值。

默认 native 不接管滚轮/触控板；距离倍数只用于被增强模式识别的离散滚轮，不用于原生回退或查找跳转距离。各档在自身固定条件下做源码前后比较；native 与 soft、1× 与 1.5× 的位移/缓动本就不同，不能把不同工作量的 CPU/帧数相减叫优化。偏好不同但旧工具字段相同也不构成等价样本。

## 确认确实覆盖增强分支

wheel 没有可信设备 ID。本仓使用启发式，阈值以当前 controller 与回归为准：

- pixel mode 只接受较大整数离散档（当前 80–240，40 的倍数或 100）；同幅间隔至少 32ms，快速/细碎/衰减像素输入会进入原生冷却回退。
- line mode 当前接受 1–6 的整数幅度并换成像素；不能把只生成 pixel wheel 的 CDP 场景说成验证了 line mode。
- 默认 30px/16ms 细 wheel 基准在 native 与增强档都可能完全走浏览器回退，**不能证明 crisp/soft 的处理路径已执行**。另设同幅 100/120px、实际间隔约 40–80ms 的离散输入，核对真实事件 defaultPrevented 与可见位移；新单步前等待上轮回退冷却结束。
- 横向、修饰键/缩放、已被处理的事件、内部滚动区消费及 overscroll 阻断分别检验；内部到边界允许滚动链时再交给外层。细碎或高速输入应保留原生，不为命中增强而改设备设置或偷偷覆盖事件。

100/120px 只描述当前合成场景，不代表所有鼠标。高分辨率鼠标、系统加速、触控板、触摸屏可能产生相似事件；CDP/Chromium 的 trusted/defaultPrevented 证明当前脚本事件路由，不证明真实设备的惯性、手势或主观手感。设备未测即列未测，可退回 native。

## 复用生产场景

从仓库根运行，选择新的产物目录；不复制现有可执行场景另造脚本。两条都是隔离组件 + 生产 CSS/主题 + mock IPC，不连接真实会话，不能替代 Electron 大会话矩阵。字体/页面错误仍由捕获工具判定；未知 mock 调用保留在 manifest，不能清空它或屏蔽 console.error 来求通过。

```powershell
# 会话手感：沿用 chat-scroll.tsx，场景通过夹具入口显示偏好/样本控件。
node .agents/skills/ui-verification/scripts/capture-component.mjs --fixture test/fixtures/chat-scroll.tsx --scenario test/fixtures/chat-scroll-feel-scenario.mjs --target .chat-surface-view --styles base,float,agent-chat,markdown,chat --themes light,dark --widths 780,390 --out .tmp/ui-captures/scroll-feel-new

# 局部反馈：真实 Segmented / ChatHoverbar / MarkdownBody，侧栏行仅验证生产 CSS。
node .agents/skills/ui-verification/scripts/capture-component.mjs --fixture test/fixtures/interaction-motion.tsx --scenario test/fixtures/interaction-motion-scenario.mjs --target .interaction-motion-fixture --styles base,left,extension-navigation,settings,chat,markdown --themes light,dark --widths 780,390 --out .tmp/ui-captures/interaction-motion-new

# 生产设置保存条：显式settle仅控制内存IPC；成功/失败/重试与实际DOM交互保持生产路径。
node .agents/skills/ui-verification/scripts/capture-component.mjs --fixture test/fixtures/settings-save-motion.tsx --scenario test/fixtures/settings-save-motion-scenario.mjs --target .settings-page --styles base,skel,float,settings,responsive --themes light,dark --widths 1100 --height 900 --out .tmp/ui-captures/settings-save-new
```

先核真实宿主支持尺寸与App根标记，再解释窄布局失败。当前桌面BrowserWindow最小宽1100；完整SettingsModal的780/390仅是明确标记的桌面边界探针，不等于MobileApp验收。不能为了让不支持尺寸绿而用夹具CSS隐藏导航，也不能漏掉App的is-narrow标记制造假失败。局部按钮/标记与转录场景的390验证仍各有其组件范围。

手感场景覆盖真实 wheel、CV 高度结算、单块正文位移、反向、嵌套消费/滚动链、键盘接管跳转、隐藏、live reduced 和输入框空格不误取消跟随；其分阶段 JSON 是带额外观察探针的交互证据，不能当同口径正式帧基准。局部场景核对 2×12px 常驻竖条、实际中间态、底片和按钮坐标、复制固定边界/DOM 身份、失败与 reduced。中间态截图用 `animations:'allow'`，稳定态另拍；生成图不等于实际看过。颜色必须来自 applyTheme(builtinTheme)，不以自造色或强制禁动画代替验证。

真实实例继续使用现有 real-bench/trace/compare，不新增参数或改变工具语义。以下仅是离散 wheel 步骤示意，需先检查可见目标和滚动余量，把它放入已核准的完整 manifest：

```json
{
  "name": "detent-up", "kind": "scroll", "selector": ".chat-list",
  "startRatio": 0.65, "deltaY": -120, "count": 12,
  "intervalMs": 80, "maxInFlight": 1, "assertStableWitness": true
}
```

```powershell
$S = '.agents/skills/perf-trace/scripts'
node "$S/real-bench.mjs" 9333 .tmp/approved-feel-scenario.json .tmp/feel-baseline-new.json
node "$S/real-bench.mjs" 9333 .tmp/approved-feel-scenario-after.json .tmp/feel-after-new.json
node "$S/compare.mjs" .tmp/feel-baseline-new.json .tmp/feel-after-new.json
# 另轮诊断，不把 trace/profile 毫秒与未开启这些诊断的正式轮绝对比较。
node "$S/trace-capture.mjs" 9333 .tmp/approved-feel-scenario.json .tmp/feel-diagnostic-new
node "$S/trace-analyze.mjs" .tmp/feel-diagnostic-new.trace.json .tmp/feel-diagnostic-new.analysis.json
```

只在不流式且滚动不改变内容挂载的场景使用 assertStableWitness；虚拟化等场景需要独立语义见证。真实自动轮之外，至少保留真实设备上翻/下翻/反向、当前阅读位置和最终落点的人工观察边界，不把合成 wheel 认证成硬件覆盖。

## 度量与必须复查的失败路径

**内容位移先于“看起来变快”。** 除校准后的 rAF p50/p95/p99/max 与 trace 呈现/CPU/layout/分配，还观察输入到首次 scrollTop/可见内容变化、停止输入到落定、实际/目标位移和余债。输入到下一 rAF 或第一次位置采样是代理，不是物理呈现延迟；主动缓动会增加有工作帧数，这不能单独解释为变慢。长历史跳转仅播最后一屏时，验证最终锚点、阅读记忆与跟随权限，不能把少走距离称作等价计算收益。

| 触发 | 必须有的见证 | 禁止的假通过 |
|---|---|---|
| 真实多消息 + content-visibility 高度结算 | 稳定可见锚点随预定剂量移动；记录高度与 top 同变、底部间距及落定后平台 | 固定旧绝对 top 超过新 max 而钳到底，却只因方向/帧数正确算顺滑 |
| 同向突发/快速反向 | 不积累多屏未呈现余债；反向以当前呈现位置接管，尾段有限且不迟到重启 | 只在最后静态截图检查方向，忽略停止输入后的长队列 |
| wheel/键盘/触摸/滚动条打断，live reduced/切出/隐藏 | 新操作取得控制权，旧动作不复活；隐藏无残余 RAF/位置漂移；输入框/IME/控件按键不误剥夺跟随 | preventDefault 所有按键，或“动画停了”但焦点/原生滚动/编辑被破坏 |
| Segmented 首次挂载/隐藏重显 | 底片同一 DOM、真实按钮坐标对齐、标签不动；可见底片和旧按钮填充不同时绘制 | 只看最终选中；按钮背景仍淡出时底片已出现，半透明叠色闪深 |
| 用户/系统 reduce | 分开确认根有效档、目标激活、computed duration/delay 与实际终态；静态焦点标记另须 transition-property:none 并零等待检查终态 | 仅凭近零时长算通过；或把下一 rAF 仍停起态说成已解决，放宽到普通 160ms/固定长等掩盖问题 |
| 复制成功/失败/连点/卸载 | 同一 12px 图标槽与按钮边界，载荷不变，拒绝不成功，旧计时器不提前撤销新反馈且卸载清理 | 用成功文字撑宽按钮、只 mock 成功，或吞掉 unhandled/error |
| 连续快速保存 | 第二次成功拥有完整反馈期限，跨过第一次旧截止点仍显示；旧控件立即撤掉、失败确认和离开不等待动画 | 布尔success一直true不更新计时器，只检查第一次保存或最后截图 |
| 设置遮挡大会话 | 分开采开/关、退出后真实卸载的样式结算；合成遮挡必须同时验证底层焦点/Tab/AX隔离与原值恢复 | 隐藏整个后代树却只统计设置控件；改opacity后忘记底层仍能交互，或禁用content-visibility掩盖成本 |

位置不变不能独自证明隐藏后已无持续回调，须用 trace/按归属计数核对产品控制器；观察探针自己的 RAF 单列，不能把它算成产品未停止。

已知失败机制应沉淀为可转红回归，而不是减少测试难度：

- **CV 高度结算**曾使旧绝对 wheel 目标落到新的底部钳制区。浏览器锚定可同时改变 scrollTop 与 scrollHeight，单看绝对 top 剂量会误判；应以至多几个可见命中点的锚点/偏移追踪可见距离，保留真实多消息/CV 样本，不能删除 CV、截正文或逐行强制测量离屏内容求稳定。
- **首显底片双填充**来自共享底片接管时，原选中按钮还按 background transition 淡向透明。终态颜色正确不能证明过程中无闪深；逐 rAF 保存两者 computed 背景 alpha（兼容 rgba 与 color(srgb … / a)）/底片 opacity，并看中间态截图。宽度即时更新与文字不移动是另一项独立见证。
- **设置开关不能只看React时间**：本轮CPU栈顶flushStyles/body.offsetWidth和removeChild分别兑现了材质遮底的整树visibility重算，独立trace的UpdateLayoutTree达82ms。父容器opacity+inert减少该成本，但inert仍有浏览器工作，不能仅靠删通配选择器或零JS循环宣称零成本。验证晚到原生材质确认、solid回退、出场期间保留、原inert值恢复，以及显式visible后代不透出。复用`node test/window-material-visual.mjs`（生产CSS像素、不是DWM）与`test/unit/settings-material-presence.spec.tsx`，真Electron另验焦点/Tab；不以Page截图认证DWM桌面或webview guest。诊断elementCount是范围字段，不是精确改变节点数。
- **近零时长不保证静态标记即时终态**：先把“CSS 时长是否近零”与“是否已到目标终态”拆开诊断，保留 raw duration/delay、transition-property、scale、opacity、根档位和目标激活状态，单位统一到 ms；需要检查下一帧时使用真实 rAF，不把它叫实际呈现帧。本轮 r3 已确认 active selector/aria 与有效 reduce 均正确，computed duration 为 `1e-05s`（0.01ms），但同步读取及下一 rAF 仍是 opacity=0、scaleY=.25，不能继续归结为单次同步首拍误判。最终仅对这类静态焦点伪元素在用户/系统 reduce 下显式 `transition:none`，从而不创建过渡；生产场景零等待断言 property=none、近零时长及正确的选中/未选中终态，不以增加等待或放宽到 160ms 求通过。r4 在本轮 Chromium 生产组件夹具的浅/深主题 × 780/390 四组通过这些断言；这是该局部浏览器观察，不能推成所有动画、浏览器或设备都存在同一机制或都已通过。

本参考说明方法、已发现机制与上述局部浏览器矩阵，不声明本轮完整真实性能、设备或全部视觉矩阵已通过。最终报告分开列源码/组件回归、浏览器实际交互及实际看过的图、真实 Electron 性能、设备手感与未覆盖项。
