# 记忆中心与记忆对话

正式中心由 `KnowledgeCenter` / `KnowledgePanel` 提供，沿用左栏记忆入口；记忆子系统会话位于调度 `AgentFloat` 的正文底部面板中。两处职责分别是知识浏览/来源/删除与按需后台整理的可见转录。存储与自动决策见 [记忆系统](memory-system.md)，实施边界见 优化方案。

## 中心五个入口

| 入口 | 内容 |
|---|---|
| 总览 | 实际知识数、用户画像注入字符数、候选进度和账本动态；保持缩放、框选、平移、适配和画布帮助 |
| 长期知识 | 当前知识（生效/整理中/暂停），按范围/状态/文本筛选，支持语义查找、来源、可选修订与删除；不混入退场记录 |
| 任务历史 | 任务事实、显式退场/删除追溯视图及原始会话查询；不作为经验常驻注入 |
| 主动提醒 | 独立 `MemoryIntentTab` 的触发、限频、取消、重新武装与状态 |
| 整理记录 | 默认待关注（待处理、失败及受保护版本的更正建议），真实候选/用户请求的内容、阶段、依据数量、尝试次数、结果或原因、最早重试时间；分页筛选、归档/移回、暂停/恢复、重试失败、打开原会话及模型/检索设置 |

`KNOWLEDGE_CENTER_TABS` 定义正式五页签。旧 review/approvals/recycle 路由在中心转向长期知识；profile 转为同页的用户画像范围筛选，包含个人信息与原有偏好，不再占独立页签。旧八页签 hub（`MemoryPanel`/`MemoryCenterTabs`，生产零 import 的退休格式查看器）已按 X4-F06（2026-10-25）连同 preload memory 域死暴露删除；`memoryCenterRoute` 与 `MemoryOverview` 为活组件保留。审批角标组件为兼容导出空组件，不轮询已停用的 badge IPC，也不把候选数量变成人工待办。

`KnowledgeCenter` 独占左对齐的顶层标题和导航，中心与独立知识列表均不显示返回终端按钮；每个 tab 与 panel 具有成对 ARIA ID、`aria-controls` / `aria-labelledby`。方向键/Home/End按事件所在页签移动和激活；非活动页签 inert/aria-hidden。页签体通过既有 xfade/usePresence 骨架保活，切换不丢总览画布状态。

## 知识列表与来源

来源逐条显示事件来源、时间与快照核对入口；已有测试、集成测试、实际运行或用户确认依据时显示对应记录类型，没有这些记录时不显示空缺等级标签。原始会话的正常条目标为「原始记录」，失败与中止状态仍单独展示。

卡片显示结论、范围、真实状态、方法、条件、例外、未来用途和 revision；内部 pending 显示“整理中”，needs_revalidation 显示“已暂停”，不要求用户处理。每批渲染30条，可继续加载。默认文本筛选；“按含义查找相关记忆”调用实际混合检索，直接展示本次命中原因和适用性，语义命中不再受同一字面查询二次过滤。

带 `entryId` 的跳转只在当前工作区目标首次出现时定位一次，目标未加载则等待；后台共享快照刷新不重新填入标题或重置范围。用户清空搜索、编辑关键词、改变范围后保持其选择；新跳转或切换工作区才重新定位，并拒绝消费旧工作区快照。切换界面语言只重新渲染文案，不重读列表或清除搜索、展开的依据和未保存草稿。

卡片可修订内容与条件、停止使用、删除及展开依据/历史。编辑表单不增加保存时机说明。保存按钮为“保存并生效”：通过带revision的IPC直接生成新版本，无需等待整理模型。页面核对回执ID、范围和递增版本后显示实际状态及“撤销本次修改”，旧快照不能刷回旧正文；失败保留草稿与原卡，并展示实际错误。停止使用立即退出后续召回。

生效条目可由用户直接确认，宿主追加用户确认依据并生成受保护的新版本。用户可将可复用经验复制为“工作台通用”：先检查和编辑正文及条件、移除项目范围，再明确提交；原条目不变，复制失败时保留表单。新副本不携带源证据、隐藏检索词或来源路径。记录的宿主参数已变化或无法核实、以及旧预算记录缺少依赖声明时，卡片显示重新核实提示和可用的新旧值。

修订历史中的“恢复版本 rN”恢复该版本完整内容和状态，先展示其摘要与历史状态；退场/删除记录可“修改并恢复”。撤销通过恢复操作产生新版本，不删除审计历史。用户确认版本显示自动整理保护说明，后台候选和错误策略补偿不能替用户改回。无需批准/拒绝每条自动候选。

删除收到匹配ID、范围、递增revision及rejected状态的宿主回执后立即从常用列表移除，不等待下一次轮询。组件保存已确认删除/退场的版本下限，并以最新条目版本复核语义命中；旧快照和旧搜索不能使条目复活，后续更高版本的明确恢复可以取代该下限。刷新失败独立显示，不把已确认的删除改报失败。`knowledge:list.deletedIds` 来自当前工作区、全局画像及工作台通用store的实际墓碑，用来区分“已删除”和系统未采用；任务历史中的“退场与删除记录”提供追溯与显式恢复。

依据按事件时间排序，显示会话/轮次/快照身份；Diff 按需读取，不把最后快照当作当前代码。读取失败与快照不可用明确显示；已知的宿主快照错误和关联检索说明在展示时跟随语言，用户结论、关系代码及未知错误保留原文。刷新 revision、切换工作区或卸载时使旧证据请求失效，迟到 Diff 不能覆盖当前版本。

任务历史中的原始会话查询需用户显式展开，选择当前工作区 GUI/调度来源后按关键词读取，不重新提炼、不回灌；最多最后50条匹配，单条正文上限4000字符并明确截断。宿主返回截断标记供界面翻译提示，原文中恰好含相同文字时不会被替换；来源名、已知状态及范围错误按界面语言显示。助手陈述未验证，原始记录不能代替实际运行证据。

## 调度面板内的记忆对话

调度表头重置旁的脑形按钮打开记忆子系统；面板从正文底部上滑，铺满正文区域，仅露出调度表头。记忆表头按“左侧回转箭头重置、居中标题、右侧向下箭头收起”排列；图标按钮保留操作提示与无障碍名称。没有角色侧栏，调度始终是主体；点击表头、脑按钮或Escape收回，外点不透传调度动作。usePresence/mp-panel和现有token保证可逆开合；面板独立重置、关闭，后台不因关闭而暂停。

调度仍使用 `orchestratorSurface`；`memoryCuratorSurface` 独立适配 `memoryCurator` API。两者按 workspace/purpose 分开草稿、快照、busy、错误和滚动；记忆转写身份包含 generation，清空换代不复用旧阅读位置。记忆首次访问才读取历史；切换回调度时保活记忆视图，工作区移除逐出缓存并使在途旧回调失效。打开/切换/读取不会发送用户消息或启动模型。

`MemoryCuratorView` 直接复用 `ChatSurfaceView` / `ChatTranscript` / `AgentComposer`，显示真实文字和工具输入/结果。记忆 surface 只通过 caps 关闭图片、技能、提醒、后台任务和工程动作；模型按钮保留，但委托当前 workspace 的调度 surface，输入框切换模型与调度 Agent 共用同一 `chat.switchModel` 链路。整个记忆面板沿用调度的glass-float底色及继承的文字、选中、悬停与焦点色，不另套overlay配色；输入条底部遮罩自然沿用同一底色，保留悬浮间距且不出现黑条。输入只用于记忆查询、更正、删除/恢复；实际能力仍由主进程专用工具边界决定。

会话顶部不显示待处理/失败计数、暂停/恢复或汇总错误条；管理信息与控制统一留在记忆中心的整理记录/设置。模型状态由调度 workspace 的共享状态条提供，模型按钮可在输入框中直接切换。转写保留轮次错误的「查看详情」与重试，错误详情在窗口 tip 显示，历史读取失败仍在阅读区提供重新读取；发送失败仍在输入区提示并保留草稿。输入区运行时停止按钮及宿主暂停状态继续生效。发送成功才清草稿；Enter发送、Shift+Enter换行，输入法组合回车不发送。重置按钮先弹出取消、填入记忆提示词、确认重置三选确认框；提示词仅追加到当前记忆输入草稿并关闭弹窗，保留已有内容，由用户检查后发送，不自动发送或清空。该入口与审批面板复用 ChatResetDialog；记忆确认文案仍明确不删除已保存的记忆。只有确认重置才清空，取消不调用清空且不发消息，重复点击确认最多提交一次；失败保留确认框并显示错误；上层确认框期间记忆面板不消费其点击/Escape。清空对话不删除知识；后台候选的运行不依赖面板是否打开。

## 总览与设置

总览以脑形呈现内部运转：用户画像、长期知识、候选、记忆子系统、处理状态、任务历史及独立提醒完整落在轮廓内；对话会话在脑外，作为输入。发现有用内容与明确记住共用候选入口；由记忆子系统读取已有知识后，保存、补依据、仅留任务事实或不收录。提醒有独立的返回对话路径，蓝色回路只表示按预算注入和按任务召回。节点保留点击/键盘进入详情，画布保留居中适配、框选放大、右键平移与动态栏收放。

记忆子系统节点通过 `requestAgentPanel(workspaceId,'memory')` 打开调度浮层正文中的记忆子系统底部面板，不再跳转到设置占位页；调度卡/调度胶囊明确选择dispatch，关闭已打开的记忆面板并显示调度会话。候选节点打开整理记录的待处理筛选，处理状态及首次页签打开待关注筛选（pending/running/deferred/failed及done/needs_user）。`memoryCurator:inspect` 只读查询真实队列（每页默认30、最多50），不claim、不重试、不发模型请求，不返回原始依据全文或租约令牌；页面合并进度推送刷新。旧页签ID `index` 保留以兼容路由，显示名为“整理记录”。

记录展示与知识生命周期独立。全部记录/已处理默认显示未归档记录；done完成满7天自动归档，失败不会按时间隐藏，可在已归档筛选查看。已处理及失败记录可手动归档或移回，进行中的候选不可隐藏。归档不删除知识、证据、回执或去重身份，不改变决策；失败归档后不计入活跃失败及批量重试，移回只恢复展示，不调用模型。已完成记录移回后重新计算7天窗口。`memoryCurator:setArchived` 校验终态后持久更新，界面等有效宿主回执再刷新；操作失败保留卡片，末页变空回退有效页，旧工作区/旧请求回调不覆盖当前视图。

执行模型的纠错在整理记录中标为“记忆更正请求”，展示原ID/提交版本、问题、核查线索和可选建议。排队/延期/失败不显示已应用；完成后区分已更正、已暂停、未采用及“审查完成，待你处理”，仅真实updated/suspended展示结果版本。`needs_user`完整展示未应用草稿及“打开原记忆”，用户自行核对当前版本并使用原有修订/停用入口；打开不会保存，也不会把受保护草稿当作有效记忆。此审核结果仍保留为needs_user，不跟踪后续独立用户编辑是否采纳。

可信预算耗尽的有限自动续跑显示为等待重试并注明原因和时间，只有最终failed显示失败；预算、拆批和总尝试次数见[记忆系统](memory-system.md)。暂停/恢复/重试均为显式控制，查看、归档和移回不唤醒模型。

`knowledge:list.activity` 从新知识账本全量聚合24小时/7天事件次数，最多返回200条、渲染50条动态，排除未来事件。保存/补依据与冲突暂停的边只显示实际账本次数；查重读取本身没有账本事件，不制造脉冲。取代、删除和提醒取消在动态中展示，不伪装成提醒发射或候选流转。

“今日生效”由账本按本地日历零点至当前时刻聚合 `auto_admitted` / `auto_corrected` / `auto_superseded_source` / `user_restored` / `user_revised` 的不同条目ID，包含恢复，同条当日重复生效只计一次，跨库去重；与动态窗口长度、24小时操作次数不同。“积压”来自实际处理队列 pending；“失败”来自处理器 failed；知识暂停数来自 `needs_revalidation` 或策略停用条目，不使用旧 pending 知识数。Pi 节点优先显示真实 paused/running 状态。

用户画像徽标直接使用主进程 `profileInjectionChars / 2400`；2400是实际核心注入预算，不是条目存储量上限。`MemoryOverview.live` 使用中心共享快照，不请求退休的 recycle/log/events/stagingList。新旧路由都不会产生人工审批页。

“按需自动整理”只处理收到的候选，普通回合结束不触发。记忆设置不再提供独立模型选择；整理会话沿用当前 workspace 调度模型，切换统一从记忆输入框的模型按钮完成。旧 `memoryConsolidation.providerId/modelId` 只作为历史配置保留，不再形成第二个选择器或第二条模型路由。

记忆检索使用正文与模型提交的关键词，不再提供向量模型、远程向量服务或相关配置。所有新中心、历史、专用对话和设置文案使用 t()。

## 工作日报

工作日报的 发布包位于 `resources/extensions/daily-report/`，由 package catalog 按包指纹安装到全局扩展目录；运行数据按工作区存放于 userData，源码包和运行数据分离。

面板通过SDK `ma.journal.list()` / `ma.journal.read(day)`读取同一宿主日志服务，要求fs:ro权限。工作区安装固定读取安装工作区controlRoot；全局安装绑定当前视图所属工作区，不由页面传路径。旧日志格式兼容，HTML身份注释不显示，读取失败显示错误而非“没有日志”。异步切日后旧结果和错误均不能覆盖新日期。日志实际来自 `<controlRoot>/.muster/memory/journal/`，不读取旧 `docs/journal` 或 `.muster/journal`。LLM 仅在点击所选日期的生成/重新生成按钮时调用；打开面板、切日和查看已有日报均不触发模型，移除近七天批量补生成入口。生成日期固定为点击时的日期，生成中切日不会串到新日期；历史日期也可手动重新生成。待办和派活行为不变。

组件回归`test/unit/daily-report-memory.spec.tsx`覆盖真实面板脚本的读取、元数据隐藏、键盘切日、失败提示、迟到错误、手动生成/历史重生成及生成中切日；桥接权限/工作区边界见memory-journal-bridge，面板解析与格式合同一致性见`test/journal-panel-parse.mjs`。原 Windows Electron 用例 memory-journal.spec.ts（当前目录 IPC 读回、旧目录不导入、点击打开日报及修订→停用→撤销→历史恢复链路）已随扩展 迁移移除；修订/恢复的真实界面链路现行由 `test/e2e/knowledge-memory.spec.ts`（知识修订恢复与失效依据）与 `test/e2e/memory-correction-review.spec.ts`（更正审查与修订保留）覆盖；所有数据均为隔离夹具，不等于真实用户数据库或macOS/Linux验收。

## 关键文件与验证边界

中心：`components/{KnowledgeCenter,KnowledgePanel,KnowledgeHistory,MemoryOverview,MemoryProcessingView,MemoryIntentTab}.tsx`、`memoryCenterRoute.ts`。对话：`panels/AgentFloat.tsx`、`components/MemoryCuratorView.tsx`、`components/AgentComposer.tsx`、`chatSurface/{ChatSurfaceView,memoryCuratorSurface}.ts`。IPC：`memory/{knowledgeIpc,curatorIpc}.ts`；提醒：`memory/ipc.ts` → `memory/centerState.ts`。桥接：`preload/index.ts`、`shared/{memoryCurator,knowledge}.ts`。

正式中心直接导入 `MemoryIntentTab`；正式提醒 IPC 直接导入 `centerState`，设置页不再依赖向量状态界面。旧 `center.ts` 仅重导出这些仍在使用的函数以兼容旧测试，正式入口不经旧模块加载审批/巩固实现；渲染层旧重导出节点 `MemoryCenterTabs` 已随死树删除（X4-F06）。离线导入边界守卫见 `test/memory-curator-legacy-boundary.mjs`，按转译后运行时依赖检查，类型引用不算装载服务。

组件用例位于 `memory-curator-{surface,panel}.spec.tsx`、`knowledge-{center,panel,settings}.spec.tsx`、`memory-processing-view.spec.tsx`、`memory-settings.spec.tsx`、`memory-overview-layout.spec.tsx`；画布通用交互仍由 `memory-center.spec.tsx` 保留覆盖。生产组件截图入口为 `test/fixtures/memory-overview{.tsx,-scenario.mjs}`，真实 Chromium 采样轮廓内含、脑外会话、路径穿卡、标签/计数互遮与文字裁切，并覆盖深浅主题、窄/矮容器及真实拖拽。它使用确定性IPC夹具，不等于全应用、真实模型判断质量或 macOS/Linux 真机验收。

截图需按生产入口顺序加载 `base,float,board,memory`；`CanvasHelp` 的定位样式来自 `board.css`。场景同时断言帮助关闭后画布宽度不变，避免遗漏依赖样式造成夹具假象。

整理记录和删除追溯的视觉入口为 `test/fixtures/memory-usage{.tsx,-scenario.mjs}`：生产 `MemoryProcessingView` / `KnowledgePanel` 加最小切页壳和确定性IPC，覆盖处理/失败/重试/真实结果、删除回执→旧共享快照、历史类型菜单/来源查看，以及卸载后订阅与轮询释放；采用相同CSS顺序。

底部记忆子系统的完整壳入口为 `test/fixtures/memory-subsystem.tsx`，真实装配AgentFloat、StoreProvider、两套ChatSurface和输入组件。用 `node test/fixtures/capture-memory-subsystem.mjs --out .tmp/ui-captures/memory-subsystem-final-2026-10-22 --themes light,dark --widths 1200,1100` 捕获；包装器只预编译正式WebP图标，不改技能脚本。面板分别620/360px，覆盖表头不遮挡、viewport边界、Enter/ShiftEnter、失败保稿、Escape、表头关闭和快速反转。主窗口下限1100×640；整窗390会触发现有工作台锚点限制，不能把裁切截图计为通过。

模型纠错的组件回归见`test/unit/memory-processing-view.spec.tsx`；截图入口为`test/fixtures/memory-processing-corrections{.tsx,-scenario.mjs}`，覆盖排队、失败、已应用、未应用建议及原记忆导航。`test/e2e/memory-correction-review.spec.ts`使用真实KnowledgeStore/CuratorQueue生成受保护提案，在隔离Windows Electron点击原记忆、主动修订并核对IPC版本，确认原审核回执不因后续编辑自动改写；关闭模型，无外部模型服务。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：KnowledgeCenter 五页签（总览/长期知识/任务历史/主动提醒/整理记录）+ 调度 AgentFloat 底部记忆子系统对话；知识浏览/来源核对/直接修订/停用/删除/版本恢复，逐条自动候选不需要人工审批。
- 为什么这样设计：修订=「保存并生效」直接 IPC 新版本不等整理模型；删除回执先行+版本下限防旧快照复活；needs_user 提案只提示不自动应用；记忆对话直接复用调度 Agent 的输入框和会话流，只关闭不适用的能力，模型切换保持单一路由；管理信息统一留中心；done 满 7 天归档、失败不按时间隐藏。
- 明确不做：不把候选数量变成人工待办；任务历史原始会话查询不回灌不重提炼；不跟踪 needs_user 后用户手工编辑是否采纳；清空对话不删知识。
- 歧义点：无真决策（注入缺口归 memory-system 的 Q；交互细节均有 2026-10 用户反馈定稿与守卫测试支撑）。
