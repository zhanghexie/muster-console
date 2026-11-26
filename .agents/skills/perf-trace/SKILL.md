---
name: perf-trace
description: 严格性能排查与优化。优先在真实 Electron 与真实大会话固定场景采集，以 CPU/渲染归因和回归测试证明修复。覆盖真实 wheel、会话/界面切换、冷暖路径、帧长尾、主进程事件循环、CPU/DOM/内存及功能和阅读位置一致性。达到 60fps 不代表优化结束。
---

# 性能排查与优化（perf-trace）

先读 `docs/features/performance.md` 的当前架构/已修项和 `docs/features/testing.md`，再读相关功能文档。脚本在本技能 `scripts/`。产物放私有临时目录或 gitignored `.tmp/perf-<日期>/`；不把会话正文、截图或原始 profile 提交到仓库。

涉及滚轮手感、历史/查找跳转、流式跟随或局部动画反馈时，按需读 [references/scroll-feel.md](references/scroll-feel.md)：复用生产组件场景，固定用户/系统动效与输入节奏，核对可见内容位移和打断语义。原生细滚轮不证明增强分支已执行，跨模式/距离倍数不能直接报性能收益；合成 CDP 输入也不等于真实触控板验收。

## 目标与停止条件

**不设“60fps 达标即结束”的门槛。** 平均 FPS、longtask=0、renderer 空闲都可能掩盖输入延迟、主进程阻塞或 GPU 卡顿。显示器可能高于 60Hz；先校准可见空闲页面的实际 rAF 回调节奏，再报告分布与长尾。rAF 只是 renderer 回调调度，不等于硬件刷新率或实际呈现帧；需要时结合 trace/真实观察。

每轮问：时间花在哪里、能否少计算/布局/分配、是否只是把工作推迟或隐藏了内容？持续处理仍有价值的瓶颈；满足任一条件才结束该方向，并说明证据：

1. profile 已无有价值且可安全移除的重复工作，剩余开销有明确来源；
2. 多轮等价比较中，候选收益已处在空闲噪声/重复波动内；
3. 候选会改变功能、内容、可访问性、阅读位置，或引入不合理的维护/内存成本。

先减少真实工作，再考虑预加载、保活、渐进处理。后者须同时测首次进入、热切换、稳态内存、隐藏页面持续工作。延迟转移到启动/后续滚动不算消除。不为性能截断正文、丢事件、改顺序、漏已展开内容或降低功能/动画质量。

## 安全与证据边界

- 用户允许真实场景时优先附加真实实例；不默认换沙盒。不读 `.metaAgent/local/`，不私读存储造数据，不创建/发送消息、写草稿、清空/删除、关会话或重启 worker。
- 只做授权的导航、滚动、界面开合。场景写明返回原界面的步骤；脚本能恢复滚动，不能猜测如何撤销任意业务操作。
- 不擅自 reload、清缓存、强制 GC、改窗口/缩放/分辨率/GPU/动画。需要启动或重启时先核实授权和进程所有权；不因端口占用就杀模糊匹配的进程树。
- CDP 拒绝/超时、目标歧义、探针缺失、测试失败、场景不符须及时告知用户；保留失败文件并非零退出。不能静默换实例或删失败样本。
- profile 的时间相关不等于因果；组件测试不证明真实帧表现。可用局部计数/隔离 fixture 证因果，但不能替代真实前后测量。

## A. 附加正确实例

```powershell
$S = '.agents/skills/perf-trace/scripts'
node "$S/discover.mjs"
node "$S/discover.mjs" 9333
node "$S/eval.mjs" 9333 '({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,hidden:document.hidden})'
node "$S/shot.mjs" 9333 .tmp/perf-2026-10-16/initial.png
```

`discover-ports.ps1` 只查 MetaAgent/electron 主进程监听口，随后探 `/json/list`。discover 仅输出识别到的 app target 的 id/类型/脱敏入口（dev 只保留 origin 与入口 path），不输出外站 URL、查询参数、hash 或安装目录；无 app target 非零退出。`DevToolsActivePort` 可能是另一份 dev 的残留，不能单独据此认实例。共享 client 支持安装版 `app.asar`、生产 `file:///.../out/renderer/index.html` 和 localhost；多窗口必须显式 `targetId`（eval/shot 最后可选参数，scenario 顶层字段），显式 id 也需通过 app 页面识别。仍须核实端口/PID 属于本次授权实例，不附加任意外部页面。

shot 拒绝覆盖旧证据，截图只放私有路径。eval 能执行任意 JS，操作者只传授权的只读检查；不导出正文。CDP/页面异常非零。网络权限拒绝时按工具授权渠道处理，不换错实例。

## B. 固定矩阵与正确性见证

按消息数/parts/字节等元数据选用户指定工作区的数个真实大会话；记录 ID/规模/代码块表格工具卡/展开态，不落正文。至少考虑以下矩阵，按实际影响说明已测和未测：

| 场景 | 固定条件 | 正确性见证 |
|---|---|---|
| 大会话首次进入 | 该实例首次进入/首屏实际正文就绪 | 目标 ID、高亮及真实内容，不能量到隐藏旧页 |
| 热会话来回切 | 同目标/顺序，至少 3 轮 | 内容完整、无串会话、焦点正确 |
| 连续上/下滚动 | 可见 scroller、同起点方向输入量及实际节奏 | 收到真实 wheel、确实移动、已展开内容不丢 |
| 阅读中切出切回 | 可见消息锚点和像素偏移 | 阅读态不强拉底，位置保持 |
| 贴底/流式 | 原贴底状态/速率/规模 | 既有跟随规则、消息顺序/不丢事件 |
| 界面切换 | 设置/搜索/看板/Dock/虚拟屏/文件/Git 等真实入口 | 交互/尺寸/状态/开合/滚动完整 |
| 空闲/循环后资源 | 同窗口/展开态/循环次数/静置时长 | 无隐藏持续工作，无持续增长的 DOM/listener/堆 |

第一个 `.chat-list` 经常是保活隐藏页，必须按可见性过滤并验证命中点。不要一直向已到底的容器发 wheel；上/下分步并断言真实移动方向。

`first-entry` 仅指该实例未进入目标，不是 OS 冷缓存，只允许 1 轮。`warm` 单独 manifest 至少 3 轮。不要为冷测截图先打开目标，也不把 reload 当磁盘冷缓存。cacheState/build 是操作者声明，工具不假装能自动证明。

## C. 真实 wheel/导航基准

先确认实际 DOM 选择器再填 manifest；示例占位 ID 不可直接运行：

```json
{
  "id": "large-chat-v1",
  "cacheState": "warm",
  "build": "baseline-<commit>-<dirty-source-hash>",
  "rounds": 3,
  "settleMs": 500,
  "calibrationMs": 1800,
  "steps": [
    {
      "name": "session-a", "kind": "click", "intent": "navigate",
      "selector": "[data-session-row='ACTUAL_ID']",
      "ready": [
        { "selector": "[data-session-row='ACTUAL_ID'].active" },
        { "selector": ".ACTUAL_VISIBLE_CONTENT_READY_SELECTOR" }
      ]
    },
    {
      "name": "up", "kind": "scroll", "selector": ".chat-list", "index": 0,
      "startRatio": 0.65, "deltaY": -30, "count": 40,
      "intervalMs": 16, "maxInFlight": 4, "assertStableWitness": true
    },
    {
      "name": "down", "kind": "scroll", "selector": ".chat-list",
      "startRatio": 0.35, "deltaY": 30, "count": 40,
      "intervalMs": 16, "maxInFlight": 4, "assertStableWitness": true
    },
    { "name": "idle", "kind": "idle", "durationMs": 1500 }
  ]
}
```

动作目标选择器只从有尺寸的元素中取 index，中心 `elementFromPoint` 验无遮挡。click 必须 `intent:navigate` 和非空 `ready`；高亮断言不足以证明正文就绪，另加真实内容标记。ready 支持 `{selector,attribute,value}`，对全部候选过滤 display/visibility、hidden/aria-hidden/inert 祖先、视口与滚动祖先裁剪，不再接受第一个有尺寸的隐藏保活节点。不额外等待 opacity 动画结束；ready 是可见布局/状态就绪见证，不等于 GPU 实际呈现。禁止空数组、`||true`、无条件成功、仅固定等待。ready 必须能证明本动作的目标切换/打开/关闭；可使用组合条件，不要求每个子条件在动作前都为 false，但不能拿原本已满足的无关条件证明一次有效切换。

左栏目标可能被滚动祖先裁剪；只有显式 `revealTarget:true` 才会在测量外 `scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'})` 并等待既有 settle。默认不自动滚。导航项跳转后消失时用 `afterSelector` 指定持续存在的新检查区域；关闭浮层可用 `ready:[{selector:'.modal',absent:true}]`，要求该匹配 DOM 真正移除，不能空 ready。错误附 round/step.name/stage；受控 missing/obscured 等白名单原因可见，任意页面异常正文仍隐藏。

全局导航可用 `kind:'key'`，`key` 仅允许 `Escape`、`Ctrl+P`、`Ctrl+Shift+G`、`Ctrl+Shift+Backslash`；必须 ready，不发送 text，不允许 Enter 或其他输入/提交键。`kind:'hover'` 对经过命中验证的 selector 发原生 mouseMoved，也必须 ready。key 无需 selector，afterSelector 可选；hover 需要 selector，afterSelector 可选。两者计时/探针与既有动作一致，不用 JS click 代替原生输入。

虚拟屏切页用 `key:'Ctrl+Shift+Backslash'`（`src/shared/keybindings.ts` 的 virtualScreen.toggle，默认 ctrl+shift+backslash，when:notTyping）。先确认焦点与实际用户快捷键配置，ready 验证真实 dock/切页状态。旧 sweep 把分割把手短按当切屏已失效：`App.tsx` 明确把手无短按动作，不能把点击后没变化算作切屏成功。右栏开合用 `.chrome-right-toggle`，它保留 dock 姿态，不保证切到右页；右栏开合与虚拟屏切页须分别验证。

```powershell
node "$S/real-bench.mjs" 9333 .tmp/perf-scenario.json .tmp/perf-baseline.json
node "$S/real-bench.mjs" 9333 .tmp/perf-scenario-after.json .tmp/perf-after.json
node "$S/compare.mjs" .tmp/perf-baseline.json .tmp/perf-after.json
```

runner 不启动/刷新 app、不调用 window.api、不造数据、不存正文，拒覆盖旧文件。每步输出：

- 校准 rAF p50/p95/p99/观测 Hz；帧间隔 p50/p95/p99/max，超 1.25/1.5/2/4 倍预算、超 50/100ms、估算错过的节奏槽；包含窗口起点到首个 rAF 回调，不能漏首次挂载冻结。
- Long Task 数/总时长/长尾；Event Timing 总延迟/输入等待/处理时长；输入收到至下一 rAF 的代理指标。Event Timing 下限 16ms 且不覆盖 wheel；代理不是实际呈现延迟。

输入到下一回调的代理值使用回调执行时的 performance.now 减 received，并以 observedInput.clock=performance.now-at-callback 标记。rAF 的参数是共享帧时间戳，可能早于输入收到时间，用它相减会产生负值；无此 clock 标记的旧 capture 不可用该代理字段做前后结论。这一修正不改变原有全帧间隔序列或 toolRevision:2。
- **实际发送 cadence/迟到/CDP 往返**。声明 intervalMs=16 只是计划；ack 可能把真实节奏拖成 30–45ms，禁止说“固定 60Hz”。maxInFlight 有界并发 1..16，收齐承诺，不无限积压；前后实际输入差异大须重录。
- Task/Script/Layout/RecalcStyle 时长、renderer 主线程忙碌比例、DOM/Document/listener 与 JS heap 前后。TaskDuration 不是整应用 OS CPU，未强制 GC 的单次 heap 差不是泄漏。
- 字符数/本地内容 hash/代码块表格图片数、起止位置/高度、可见消息锚点。无正文/标签；hash 仅是变化见证，不独自证明语义和视觉完全一致。

可用 witnessSelector 指稳定内容区域。assertStableWitness 适用于不流式且滚动不改变正文挂载的场景；虚拟化/流式需独立语义检查，不能为了全绿忽略缺内容。

原始 manifest 必须和 baseline 一起保留，后续调整 prepare/reveal/ready 时另存新文件。新 real-bench 报告把同一 hash 对象保存为私有 `scenarioDefinition` 快照：删除 build/targetId 后深拷贝，`scenarioHash=sha256(JSON.stringify(scenarioDefinition))`；采样语义与 toolRevision:2 不变。build/targetId 仍另记，不能为了通过 compare 修改旧报告的hash或覆盖旧manifest。快照含真实selector/ID，只落本地报告，不打印到console或外发。旧报告没有快照时依赖当时保留的原manifest；缺失即明确证据边界，不重建成想当然的“同场景”。

滚后恢复：原贴底按**新 max** 恢复并验证距底，适应 content-visibility 实际高度变化；阅读态仅从至多 3 个可见 hit-test 点找 data-mid/data-message-id 锚点，恢复行偏移。无锚点时合法 clamp 并写 warning/result.restoration，不能声称已验证相同阅读位置。禁止逐个测量离屏行以求恢复，那会强制布局并污染场景。

缺目标/遮挡/无移动/方向错误/见证变化/后台隐藏/renderer error/还原失败均 incomplete+非零；保留失败文件。compare 拒绝工具版本、场景/冷热、窗口/DPR、profile 开关、rAF cadence 或滚动内容位置不等价的 capture。scroll 另核对实际 dispatch p50/p95、p95 迟到（容差 max(10%,2ms)）、接收/发送输入计数、观察窗口时长（容差 max(10%,100ms)）、还原方法和见证；clamp、缺见证或不同阅读位置不能作为等价。相应不等价行只输出原因与输入/窗口条件，不输出绝对帧/任务/CPU收益 delta；总体部分不可比时非零退出。这些是样本等价容差，不是性能达标线。主进程修复让实际输入更密集时，应分开报告输入响应收益和不同负载下的 renderer 表现，不能直接把绝对长任务次数相减当优化。

长矩阵可将进度重定向到**新的私有日志**，避免控制终端的输出背压干扰采集进程；先确认日志不存在，退出码仍必须检查。这只是工具侧隔离措施，不是产品修复或超时原因证明。CDP 超时后先保存 incomplete 和失败阶段，用新连接立即只读核实 renderer/探针/内存；随后能响应不证明此前未冻结。若反复出现，可另开诊断轮记录独立连接的只读心跳与采样 Node 自身事件循环迟到，区分 app、单连接与控制进程；额外诊断有负载，不能把它当无探针正式计时。拒绝擅自加长超时、自动重试吞错、reload 或杀应用“恢复”；正式重测另存，不覆盖失败轮，未定位就明确未定位。

只有采样语义改变才要求双方重录并考虑工具版本变化；兼容检查/脱敏等收紧可保留 toolRevision:2，不修改既有证据。新 capture 记录 readinessPolicy=visible-ancestors-viewport-v1；新旧策略不同时 compare 省略导航 readyMs delta 并提示审查实际 manifest/目标切换见证，不能把旧隐藏节点误命中的数据视作有效基线。负 delta 只是相应可比字段的成本下降，不是自动验收。

## D. 必须区分 renderer、主进程与呈现链路

**renderer 很闲却 CDP ack/IPC/界面响应慢时，先查主进程。** 不要为了 rAF=60/longtask=0 就认定应用没问题。周期性同步 IO/JSON/crypto/扫描都能让 main 阻塞数百 ms，同时 renderer 继续空转。

renderer 归因：同场景另加 `profile:true`，每步 1ms CPU profile。profile 轮与无 profile 轮不可直接比较毫秒；正式前后用无 profile。CPU profile 的 `(program)` 不能独自证明 layout，需 timeline。Chrome trace 可看 main/style/layout/paint/compositor/GPU 和输入实际呈现；禁截图、原始 trace 只放私有目录，报告仅聚合/源码位置。

对同一已核准 manifest 收集呈现链路诊断（不并发另跑 real-bench）：

```powershell
node "$S/trace-capture.mjs" 9333 .tmp/perf-scenario.json .tmp/diagnostic-baseline
node "$S/trace-analyze.mjs" .tmp/diagnostic-baseline.trace.json .tmp/diagnostic-baseline.analysis.json
# 仅在追查样式/布局的全树失效时启用；保留新的 prefix。
node "$S/trace-capture.mjs" 9333 .tmp/perf-scenario.json .tmp/diagnostic-invalidations --invalidations
```

capture 先在已核准主 target 开 Tracing（无 screenshots、ReturnAsStream），异步启动同一 real-bench 子进程，不调用业务 API，不额外启动 CPU Profiler（manifest 的 profile:true 仍照常执行）。finally 始终 end、分块 IO.read/close；benchmark 失败也保留 trace 和 incomplete summary，拒绝覆盖旧产物。数据丢失/断连/无流/读流失败均非零；部分文件只是证据，不算完成。诊断 trace 包含 runner 的校准、准备、动作、还原，不能冒充只量 wheel 的窗口；其开销也不能与无 trace 的正式计时直接比较。

采集窗口从工具自身 `performance.now()` 计时，summary 的 `captureElapsedMs` 边界明确为发出 Tracing.start 请求前至 Tracing.end 确认后（包含控制往返，排除读流/写文件）；失败未确认停止则为 null、captureTiming.complete=false。不能用 trace 里最早/最晚所有事件时间戳推采集时长：Chromium 会回放采集前仍在途的 FrameSequenceTrackerV3/Frame 等 async begin，可能早数分钟。analyze 的 `rawTimestampSpanMs` 是原始跨度，旧 `durationMs` 仅保留兼容别名且已弃用；`observedSynchronousSpanMs` 只包围有效同步 X 事件，也不是精确 capture 或 action 时长。CLI 同时显示两种跨度和边界警告。EventLatency 原字段保留所有原始配对，`withinObservedSynchronousWindow` 另外排除跨同步观察窗口的配对，显式报告 excludedPairs 与越界起止；CLI使用这个有边界的诊断桶，缺同步窗口则明确 raw-unbounded，不把缺埋点当零。即使在同步窗口内也不代表仅发生在用户动作中。

全 trace 的 Long RunTask 可能来自 Profiler.start/stop、探针准备、校准或还原；必须按时间范围/父链核对正式动作窗口，不能将它们和无 profile 的 action-only rAF/longtask 直接相加或归咎于应用交互。报告明确区分工具控制采集窗口、同步观察跨度、正式步骤观察窗口与原始 async 跨度。

`--invalidations` 额外启用 `disabled-by-default-devtools.timeline.invalidationTracking`。这是高开销归因轮，文件可能很大；只用于定位 selector 触发的 subtree invalidation 与 UpdateLayoutTree 范围，不能把不同 category 的毫秒直接前后相减。默认关闭，summary 记录开关与警告。全树重算也可能来自动态 `<style>` / `@property` 注册与注销；CPU 中第一个 `scrollHeight`/`offsetWidth` 读取可能只是强制冲刷之前积累的样式工作，不能把所有成本归咎于测量函数本身。保留纯样式壳时仍须销毁原本应销毁的业务子树，隐藏壳必须无可聚焦内容、无动画/RAF，并用真实库检查样式节点及文本不重写；依赖库根据 children 读样式的 effect 也要检查。

analyze 按 thread_name 与 X 事件聚合 count/total/max；嵌套/并行事件 total **不可相加为 CPU 总量**。Long RunTask（≥50ms）保留线程身份，主进程的数百 ms RunTask 不能因 renderer 空闲而忽略。EventLatency 的异步 b/e 必须按 pid、category/scope、name、id2（兼容 legacy id）配对，允许跨 tid，按 event_type 分桶，显式保留未匹配起止；不同 PID 的相同 local id 不能串配。ScrollJankV4 只数明确的 is_janky 布尔值，无埋点=不可用。PipelineReporter 只报 state 直方图；STATE_PRESENTED_PARTIAL 或 Presentation 原始最大间隙都不能直接当掉帧。报告需要同时解释输入、main、renderer、compositor/GPU，而非拿一个 rAF/FPS 数替代。

`MISSED_VSYNC_DURING_FAST_SCROLL` 等规则结果还须核对同事件 span、相邻滚动输入、FrameTimeline/提交/交换与是否跨步骤停顿。相对前帧的原始 missed/vsyncs 计数可能远大于这条滚动更新的时长，不能直接报“连续掉了 N 帧”，也不能未经该 build 埋点验证就说它是假 jank。另一轮正式 rAF 尖刺不能强行对应到诊断轮的某个事件；无 CPU 长任务也不能直接归因 OS/GPU，或证明实际呈现流畅。

有 invalidation 埋点时 analyze 仅聚合受控事件名、`Invalidation set invalidates subtree` 的显式 CSS selectors 和次数；同条记录的同selector只记一次，缺selector的事件另计，绝不输出 nodeName/nodeId/stackTrace/extraData。selector次数不是受影响节点数。UpdateLayoutTree 聚合 duration 与 `args.elementCount`（不是 beginData）；缺elementCount仍不可用，不补零，elementCount是Chromium诊断范围而非实际变更节点数。有 output 参数时完整JSON只写新文件，stdout仅打印小摘要；无output参数则完整stdout便于管道。原始trace/CPU profile仍可能含源码URL与运行时元数据，不外发真实trace。

已获授权并确认是自己的实际测试实例，需要 main Inspector 时由启动者设置 `--inspect=<port>`，不擅自重启用户实例。附加现有 Inspector：

```powershell
node "$S/main-profiler.mjs" 9335 .tmp/main-baseline 15
```

它只接 type=node，验证 Electron main，1ms Profiler 加自己的 25ms诊断 timer；保存 cpuprofile 和 summary（callback gap/迟到 p50/p95/p99/max、超 10/50/100/250ms，cpuUsage、RSS 等）。finally 清自身 timer，不读 env/argv/keys/正文、不发消息、不 reload/kill。timer 与 profiler 有开销，保持前后同条件；timer 迟到不是 renderer/GPU 帧。

OS 资源另采单个明确进程树：

```powershell
powershell -NoProfile -File "$S/process-sample.ps1" -RootPid <ACTUAL_MAIN_PID> -DurationSec 30 -OutputPath .tmp/perf-os-baseline.jsonl
```

记录 main/renderer/GPU/child 的 CPU、working set/private bytes、handles/threads。corePercent 可超 100%，machinePercent 除逻辑核；别混淆。root 退出/PID 复用显式失败。系统探测本身有开销，前后一致；内存泄漏要多轮循环+静置看平台，不能单轮涨就判定。

分配/GC/完整历史 clone 的证据可以另开一次堆采样诊断：

```powershell
node "$S/heap-capture.mjs" 9333 .tmp/perf-scenario.json .tmp/allocation-diagnostic
```

它先检查实际 `/json/protocol` 确实支持 HeapProfiler.startSampling 的全部参数：samplingInterval=131072 bytes、stackDepth=64、includeObjectsCollectedByMajorGC/MinorGC=true；缺任何参数就显式失败，不静默降低覆盖。对已核准target开启采样，子进程运行同一个已核准manifest，finally停止/保存 `.heapprof`，原始 `.bench.json` 与 `.summary.json` 全部拒覆写。采样囊括校准/准备/动作/恢复；15分钟runner上限，Ctrl+C/超时/子进程失败/协议不支持/断连/停止失败/写盘失败均 incomplete+非零，尽量保留部分证据，只能终止自己spawn的Node runner，绝不能杀应用或其他进程。独占运行采样器，勿同时运行别的heap/CPU/trace诊断；manifest profile:true会再加CPU开销并写警告。工具不发送业务消息、不reload，不forceGC、不HeapSnapshot、不读取对象值。

summary聚合树节点selfSize一次作为累计分配**采样估计**（不再次累加samples），记录top self bytes/function/最后7层parents、样本和节点数。includeCollected=true涵盖已被GC回收的分配，因此159MB估计不代表159MB仍驻留，更不自动证明内存泄漏；`(V8 API)`根的大分配只能作为桥接/clone线索，仍须IPC与源码路径交叉归因。该轮帧时延不能和未采样正式轮绝对比较。原始profile含源码URL/函数信息，只放私有临时目录；console只打印8条小摘要，URL/路径形式函数名及parents脱敏，不输出profile或完整URL。

real-bench子进程的探针由专用随机owner nonce标记，wrapper只清理匹配nonce的探针；“spawn了child”不能视为拥有当前window.__maRealPerf，child退出后新出现的其它探针也不能被清掉。nonce只通过专用进程环境变量传入，不入manifest/hash/正文采样，普通直接运行仍按自身安装/清理流程；不得据此收集其它环境变量。

线索需源码验证：micromark/Markdown 高频→解析输入/范围；React→订阅和 props；GC→上游分配；getBoundingClientRect→逐帧/离屏测量；main 周期CPU→同步 IO/序列化/扫描。不能仅凭函数名猜修复。

完整历史传输的复用须单独审查新鲜度：本仓 `host/messagesVersion.ts` 使用 live entry 的 UUID 代际/版本，不能拿消息数、字符数或数组引用代替。任何消息写入（含隐藏页）必须在 await/IO 前推进版本；共享 SDK/摘要对象的静默变化也是写入。磁盘、light、closed、clearing 和文件采集 collecting 过渡态保守全量。renderer 只有实际应用的完整响应可认证缓存，消息时钟变化不能继续认证旧版本；clear/resync 强制全量，epoch/clearSeq 守迟到响应，单飞不能吞强制刷新。unchanged 只省正文，mode/usage/injections 等元数据仍按各自时钟刷新；非法标记/版本、null、条件请求失败最多一次全量兜底。隐藏页仍退订，每次重现仍请求；保留旧无 token 调用与 Web 全量路径。用真实桥接/后台更新和竞态测试核对，再采样分配收益，不能只凭 memo 命中或堆末点验收。

## E. 证因果、修复、继续优化

- 一次聚焦可解释瓶颈，必要时局部临时计数；交付撤探针。mock memo 组件必须保留 React.memo，否则绕过真实契约。
- 同真实场景至少三轮，检查空闲噪声、实际输入节奏、内容/状态/阅读位置。报告 p95/p99、长任务总量、CPU/layout/内存，不能挑最佳轮/平均 FPS。
- bug 修复同改动带回归，还原修复应转红。纯逻辑 test/*.mjs、组件/hook test/unit、真 app 关键链路 test/e2e。性能测量不等于完整功能验收。
- 同 checkout 测试互斥，指定负责人统一跑相关子集，不擅自全套。采集耗时也应持续告诉用户发现、异常与未覆盖项。
- 每轮重看剩余 profile；低于 50ms 的重复布局也能吃掉每帧预算。达到 60Hz/零 longtask/测试通过都不是停止条件。
- 同步 docs/features/performance.md，按 journal 技能记结果。报告分别给源码回归、真实性能、功能/视觉证据与未覆盖边界；未完成矩阵不能写“全面通过”。

## 旧脚本及工具回归

recorder/analyze/profiler/profile-analyze 保留历史自由操作用途：只记 >100ms rAF gap、目标可能带标签，部分错误路径不能可靠非零；**不用作严格前后基准**。CPU 的 QPC 时间轴须核对原点，旧经验见 performance 文档。

bench.mjs 是历史沙盒造数器，会 reload/创建会话/发送消息；**禁止对用户真实实例运行**。`--skip-seed` 不是安全证明。局部复现优先组件/逻辑 fixture，另确认隔离实例。

`node test/run.mjs perf-real-bench` 是工具纯逻辑回归，不连接 app：生产 target、多实例歧义、120Hz 预算、无数据非零、空 readiness 禁止通过、不可比样本拒绝。真实 wheel/遮挡/首帧/高度真实化及阅读位置仍需真实实例和人工验收。

`node test/run.mjs perf-trace-analysis` 用小型纯 metadata fixture 守线程聚合、不可加总提醒、不同 PID 相同 id2 的正确配对、event_type 分桶、明确 jank flag 和原始 PipelineReporter 状态；不会连接真实 app 或启动采样。

`node test/run.mjs perf-heap-capture` 纯logic守严格参数/协议能力、selfSize累计估计、不重复加samples、父栈聚合、URL/路径脱敏；不连接CDP、不启动sampler。`perf-real-bench` 另守场景快照与hash一致、输入后改不污染快照、prepare差异保留拒比，以及nonce不匹配时不清其它探针。实际协议/heap负载/清理路径仍须授权实例实测。
