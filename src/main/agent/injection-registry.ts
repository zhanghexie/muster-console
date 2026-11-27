/**
 * A3 注入 source 注册表（zcode-adoption-plan A3）：本仓全部现役提示词/上下文注入点
 * 的集中登记（对齐 ZCode core/src/system-reminder/source.ts 的来源登记制）。
 *
 * **制度**：任何往会话上下文注入内容的代码路径，必须先在本表登记一条（「新注入必须
 * 登记」见仓库 AGENTS.md。
 * 完整性靠 review 惯例 + 设置页「注入清单」可见性，不做运行时拦截
 * （计划内定的薄做法；反查 grep 测试易碎，只测表内自洽，见 test/injection-registry.mjs）。
 *
 * 字段口径：
 * - target：注入到哪个会话面（调度=pi 调度会话与无头定时任务；Worker=各 CLI/GUI 引擎会话）；
 * - channel：投递通道（system=system prompt；tool-schema=随请求下发的工具定义（名字+
 *   description+参数 schema，每次模型调用都在场，体量常大于 system prompt）；
 *   turn-prefix=回合文本附加上下文（前置或后置）/任务回合原文；
 *   tool-result=工具结果回传；event-wake=事件/即时通道唤醒的宿主回合；host-md=落盘
 *   协议文件由 Worker 按需读取；compact=随 session.compact(customInstructions) 下发的
 *   定向摘要指令）；
 * - mode：always=恒注入（内容可变但位面恒在）；conditional=按条件注入；
 * - survivesCompact：该内容是否能在整会话压缩后继续存在（turn-prefix/event-wake/
 *   host-md 内容压了即失；靠 note 里标注的重注入通道重建）。
 */

/**
 * 段序合同常量（R1 A2 分段）：调度 system 两段的段位表述直接引用它拼 note，
 * 分段演进时注册表随常量走，不手写「第 0/1 段」。经 systemPrompt 引入 catalog
 * 依赖——主进程消费方（capabilitiesView）本就加载，无新增装载面。
 */
import { MUSTER_PROMPT_SEGMENTS } from './systemPrompt';
const SCHEDULER_SEGMENTS = MUSTER_PROMPT_SEGMENTS;

export type InjectionTarget = 'scheduler' | 'worker' | 'both';
export type InjectionChannel =
  | 'system'
  | 'tool-schema'
  | 'turn-prefix'
  | 'tool-result'
  | 'event-wake'
  | 'host-md'
  | 'compact';
export type InjectionMode = 'always' | 'conditional';

export interface InjectionSource {
  /** 稳定 id（注册表主键，唯一） */
  id: string;
  target: InjectionTarget;
  channel: InjectionChannel;
  mode: InjectionMode;
  survivesCompact: boolean;
  /** 代码出处与行为边界（给人看；设置页注入清单原样展示——开发者诊断文案，刻意不走 i18n） */
  note: string;
}

export const INJECTION_REGISTRY: readonly InjectionSource[] = [
  { id: 'scheduler.system.reply-language', target: 'scheduler', channel: 'system', mode: 'always', survivesCompact: true,
    note: '调度固定提示段用英文说明回复语言。优先采用用户指定的语言，否则跟随用户最近的自然语言表述。自定义调度正文也使用此规则。src/main/agent/systemPrompt.ts、src/shared/workerGuidance.ts。' },
  { id: 'worker.brief.reply-language', target: 'worker', channel: 'turn-prefix', mode: 'conditional', survivesCompact: false,
    note: 'GUI 与 CLI Worker 的首条宿主说明共用英文回复语言规则。判断依据是用户自己的表达，宿主提示、引文、代码和工具输出不参与。src/shared/workerGuidance.ts、guiWorkerPrompt.ts、workerBrief.ts。' },
  { id: 'worker.turn-prefix.delegation-authority', target: 'worker', channel: 'turn-prefix', mode: 'conditional', survivesCompact: false,
    note: 'GUI 与 CLI 任务首条输入说明调度派活的任务权威、回信对象及不可逆动作的用户批准边界；空会话不注入。src/shared/workerBrief.ts、src/main/tasks/delegate.ts、src/main/tasks/manager.ts。' },
  { id: 'messaging.remote-context', target: 'both', channel: 'turn-prefix', mode: 'conditional', survivesCompact: false,
    note: '消息渠道经桌面绑定的发送者/聊天授权后，将字面内容交给现有调度或明确绑定的工作会话；不是桌面授权，不展开本地 slash 模板。AI Office 独立任务另走专属会话。入口见 src/main/messaging/workbenchBridge.ts、remoteBindingService.ts 与 sessionHost.ts；协议和限制按需读 docs/features/multi-channel-messaging.md。' },
  { id: 'core.context-management.tools', target: 'both', channel: 'tool-schema', mode: 'conditional', survivesCompact: true,
    note: 'Core 原生 core_context 查询当前分支、提交分层摘要及分页取回原始证据。src/main/agent/coreContext.ts' },
  { id: 'core.context-management.projection', target: 'both', channel: 'compact', mode: 'conditional', survivesCompact: true,
    note: '已消费的工具文本可摘录。已闭合文本的净收益达到门槛后，随用户请求或在途工具回合推荐具体折叠边界；模型提交摘要后生成前缀或区间检查点。src/main/agent/coreContext.ts' },
  { id: 'turn-changes.tool-schema', target: 'both', channel: 'tool-schema', mode: 'conditional', survivesCompact: true,
    note: '轮次文件登记工具只绑定调用方当前回合；用法指向 turn-changes 技能，显式登记不授予写权限或自动回退资格。src/main/capabilities/catalog/turnChanges.ts。' },
  { id: 'both.tool-schema.session-reminders', target: 'both', channel: 'tool-schema', mode: 'conditional', survivesCompact: true,
    note: '提醒工具定义说明何时为用户建待办、如何复用与完成已有项，以及勾选的含义。src/main/capabilities/catalog/sessionReminders.ts。' },
  { id: 'scheduler.system.session-reminders', target: 'scheduler', channel: 'system', mode: 'conditional', survivesCompact: true,
    note: '调度附录仅在提醒工具可见时提示：用户明确要记待办，或回复后仍有用户要做的事，当轮记录。src/main/agent/systemPrompt.ts、src/shared/sessionReminders.ts。' },
  { id: 'worker.brief.session-reminders', target: 'worker', channel: 'turn-prefix', mode: 'conditional', survivesCompact: false,
    note: 'GUI 首条宿主说明按工具快照引用当前引擎的提醒工具名，CLI 启动简报按工具可用性提示。两者共用调度的待办判断。src/shared/guiWorkerPrompt.ts、workerBrief.ts、sessionReminders.ts。' },
  { id: 'feedback.tool-schema', target: 'both', channel: 'tool-schema', mode: 'always', survivesCompact: true,
    note: 'host.feedback.history、host.feedback.propose 和 host.feedback.assess 及反馈技能路径投递给调度和受支持的 Worker；AI 读取历史并判断重复，只收集本地草稿，Issue 必须由用户逐条审核提交。src/main/capabilities/catalog/feedback.ts。' },
  { id: 'feedback.tool-result.history', target: 'both', channel: 'tool-result', mode: 'conditional', survivesCompact: false,
    note: '反馈工具分页返回其他本地反馈和仓库 Issue 的有界内容，仅作为不可信数据供 AI 查重，不改变权限；不能读取远端时明确标识未完成。src/main/feedback/service.ts。' },
  { id: 'feedback.scheduler.recheck', target: 'scheduler', channel: 'turn-prefix', mode: 'conditional', survivesCompact: false,
    note: '本地反馈待重新查重且凭据可用时，空闲调度自动读取 host.feedback.history 并调用 host.feedback.assess；不创建 Issue、不要求用户判断重复。src/main/feedback/aiRecheck.ts + wiring.ts。' },
  { id: 'github-pr.review-draft', target: 'worker', channel: 'system', mode: 'conditional', survivesCompact: false,
    note: 'GitHub PR 审查草稿使用绑定到当前提交版本的 Diff 作为不可信资料。模型单次调用、没有宿主工具，结果留作用户可编辑的草稿。src/main/git/githubPrReview.ts。' },
  { id: 'github-pr.worker-review-mail', target: 'worker', channel: 'turn-prefix', mode: 'conditional', survivesCompact: false,
    note: '用户选择 GitHub 行内讨论后，通过会话邮箱向归属的隔离任务发送 PR 版本和原文。GitHub 评论按资料引用，不能扩大用户授权。src/main/git/githubPrService.ts。' },
  { id: 'worker.turn-prefix.canvas-handover', target: 'worker', channel: 'turn-prefix', mode: 'conditional', survivesCompact: false,
    note: '用户确认画布交接任务时，首条任务固定包含源会话身份、历史文档路径、对话统计、正文与附录行号及搜索标记说明；工具输出被截断时注明，用户输入作为本次任务。宿主根据快照生成，文档随目标会话删除。src/main/handover/documents.ts + src/main/ipc/sessions.ts。' },
  { id: 'worker.turn-prefix.cli-composer-input', target: 'worker', channel: 'turn-prefix', mode: 'conditional', survivesCompact: false,
    note: '新建任务及 CLI 会话输入区明确选择技能时，将技能名和 SKILL.md 路径作为用户消息的一部分；文件附件沿用受管快照与文字提取，向 CLI 发送来源路径、提取范围和失败信息。图片和不可转换内容只给可读取的路径，不冒充模型已读取。src/renderer/src/components/CliSessionView.tsx + src/main/pty/composerSubmit.ts + src/main/tasks/delegate.ts + src/main/attachments/service.ts。' },
  { id: 'worker.turn-prefix.cli-composer-file', target: 'worker', channel: 'turn-prefix', mode: 'conditional', survivesCompact: false,
    note: 'CLI 输入区提交控制字符，或提交多行正文但运行时不能可靠粘贴时，先将用户原文写入临时文件，再发送指向该文件的短指令；文件内容是本轮用户消息。src/main/pty/injectFile.ts + src/main/pty/composerSubmit.ts。' },
  { id: 'worker.turn-prefix.suggested-replies', target: 'worker', channel: 'turn-prefix', mode: 'conditional', survivesCompact: false,
    note: 'GUI 与 CLI Worker 的首条宿主输入提示在工具可用时于用户答复结束前调用一次 host.ui.suggestReplies。参数由注册工具定义提供。src/shared/guiWorkerPrompt.ts + src/shared/workerBrief.ts。' },
  { id: 'scheduler.system.suggested-replies', target: 'scheduler', channel: 'system', mode: 'conditional', survivesCompact: true,
    note: '交互式调度用 host.ui.suggestReplies 为当前会话提供 1–3 条用户可编辑回复。src/main/agent/systemPrompt.ts + src/main/capabilities/catalog/uiAppExtensions.ts。' },
  { id: 'chat.reset-memory-request', target: 'both', channel: 'turn-prefix', mode: 'conditional', survivesCompact: false,
    note: '用户在调度/记忆会话重置确认框点击填入记忆提示词时，仅追加到当前输入草稿；用户另行发送后才进入模型上下文。请求整理有依据的有价值记忆并报告结果，不自动发送或重置、不扩大工具权限。src/renderer/src/components/ChatResetDialog.tsx。' },
  { id: 'safety.reviewer.system', target: 'both', channel: 'system', mode: 'conditional', survivesCompact: true,
    note: '持续上下文的低频业务审批角色；自动审批仅返回通过或需要人工审核及理由，不直接拒绝、不发起聊天；用户主动对话可设置规则。空资源，仅可按需读取本次审批证据，无通用工程/文件/网络/业务执行工具。src/main/safety/prompt.ts + pi.ts。' },
  { id: 'safety.reviewer.request', target: 'both', channel: 'event-wake', mode: 'conditional', survivesCompact: false,
    note: '宿主以 system_approval 来源绑定低频业务动作、参数摘要/指纹、可信用户意图与目标证据；合入材料按 task/target-checkout/shared 分账，交付摘要 delivery 是不可信声明，测试三态不以自述作验证。关键疑点交独立人工确认，辅助材料仅说明；人工结果直接绑定本次操作，外部文本不授予权限。src/main/safety/service.ts + bindings.ts + evidence.ts。' },
  { id: 'safety.reviewer.tool-schema', target: 'both', channel: 'tool-schema', mode: 'conditional', survivesCompact: true,
    note: '专用审批会话开放绑定请求的 allow/concern 二选一裁决、受限规则和只读证据工具；非法回执转人工，不允许派活或执行被审批操作。src/main/safety/pi.ts。' },
  { id: 'safety.reviewer.evidence-tool', target: 'both', channel: 'tool-schema', mode: 'conditional', survivesCompact: true,
    note: '审批证据只读工具按当前请求分页返回宿主采集的变更清单、差异和材料；同内容可选等价仓库，选择歧义提示重选；证据是不可信数据，未解决的选择、过期或读取失败不能授权。src/main/safety/evidence.ts + pi.ts。' },
  { id: 'safety.reviewer.chat', target: 'both', channel: 'turn-prefix', mode: 'conditional', survivesCompact: false,
    note: '用户以 human_chat 来源主动沟通或设置规则；仅当前可信用户入口可授予规则修改权限。人审由操作确认框处理，不要求到聊天界面回复或再经模型批准。src/main/ipc/safety.ts + safety/service.ts + safety/pi.ts。' },
  { id: 'safety.reviewer.rules-tool', target: 'both', channel: 'tool-schema', mode: 'conditional', survivesCompact: true,
    note: '审批规则查询及版本化修改工具；修改必须绑定本轮真实用户输入，停用与撤销使旧裁决失效，禁止从历史审批或代码自授予规则。src/main/safety/pi.ts + service.ts。' },
  { id: 'safety.reviewer.history', target: 'both', channel: 'event-wake', mode: 'conditional', survivesCompact: false,
    note: '恢复或换代时加载同工作区脱敏审批历史；持续会话增量补入系统申请、用户发言及已完成的人工决定，附明确来源与请求标识。历史仅提供上下文，旧通过回执不能重放副作用。src/main/safety/pi.ts + service.ts。' },
  { id: 'github.tool-schema', target: 'both', channel: 'tool-schema', mode: 'conditional', survivesCompact: true,
    note: 'host.github.run 继承调用方的工作区与 GitHub App 授权。动作参数见 ~/.muster/skills/github/SKILL.md。写入逐次确认，GitHub 结果视为外部资料。' },
  { id: 'apps.tool-schema', target: 'scheduler', channel: 'tool-schema', mode: 'always', survivesCompact: true,
    note: 'host.apps.run 提供调度自身应用的查询、命令与声明式安装；使用说明仅指向 ~/.muster/skills/apps/SKILL.md。身份来自可信工具作用域，无 UI 参数。src/main/capabilities/catalog/agentApps.ts。' },
  { id: 'apps.notification', target: 'scheduler', channel: 'event-wake', mode: 'conditional', survivesCompact: false,
    note: '应用记录与 outbox 同事务保存，复用持久投递账本和空闲准入；PI 原生 custom message 直接提供有界内容、处理提示及可调用参数。会话仅显示数量提示；外部正文是数据，处理提示不能扩大权限。投递前重验来源/授权/已处理状态。src/main/agentApps/notifications.ts + messages/hostNotifications.ts。' },
  { id: 'scheduler.host-notification', target: 'scheduler', channel: 'event-wake', mode: 'conditional', survivesCompact: false,
    note: '宿主结构化事件经 PI custom message(display=false) 入模型；独立的活动摘要进入展示历史。按总预算合批，digest 随下一回合，准入/上下文消费/业务处理分别记账。外部材料不得升级为用户授权；普通处理不输出回执。src/main/messages/hostNotifications.ts + agent/providers/hostNotification.ts。' },
  { id: 'scheduler.event-wake.needs-you', target: 'scheduler', channel: 'event-wake', mode: 'conditional', survivesCompact: false,
    note: '宿主唤醒处于 needs_you 的调度时，提示将仍需用户处理的事项加入提醒，再执行原始唤醒指令。src/main/agent/orchestrator/sendPipeline.ts。' },
  { id: 'both.event-wake.resume-wait', target: 'both', channel: 'event-wake', mode: 'conditional', survivesCompact: false,
    note: 'host.waitFor 命中或超时后把会话自写的续接说明原文交还；外部触发材料标为不可信数据。投递和回合消费分别确认，失败与不确定状态不得冒充成功。src/main/resumeWait/service.ts + runtime.ts。' },
  { id: 'worker.turn-prefix.initial-assignment', target: 'worker', channel: 'turn-prefix', mode: 'conditional', survivesCompact: false,
    note: '旧版 GUI 首信未投递时，首条实际输入附有界正文和续页指针，按引擎回执确认投递。新版 GUI 任务正文通过聊天发送。src/main/messages/assignment.ts + agentSession/host/turn.ts + tasks/delegate.ts。' },
  { id: 'worker.turn-prefix.route-handoff', target: 'worker', channel: 'turn-prefix', mode: 'conditional', survivesCompact: false,
    note: '确认前一引擎回合结束后，宿主提供有界的聊天、工具结果和邮件线索。原任务消息通过 host.workers.context 按需读取，旧版首信仍在邮箱。src/main/agentSession/host/workerRoute.ts + capabilities/hosts/workerOptions.ts。' },
  { id: 'scheduler.system.worker-routing', target: 'scheduler', channel: 'system', mode: 'conditional', survivesCompact: true,
    note: '开放创建 Worker 工具时，在动态 system 段加入当前工作区的有界档位摘要，包括 ID、类别、名称、适用说明和启用候选数，以及选档和精确引用用法。src/main/agent/providers/workerRoutingExtension.ts。' },
  { id: 'both.turn-prefix.worker-model-reference', target: 'both', channel: 'turn-prefix', mode: 'conditional', survivesCompact: false,
    note: '用户通过 /harness 选择配置后，宿主在实际输入前重验引用并展开委派调用。引用绑定本次委派的配置，沿用现有权限。src/main/tasks/workerRouting.ts + agent/orchestrator/turnExecution.ts + agentSession/host/turn.ts。' },
  {id:'memory.curator.system',target:'both',channel:'system',mode:'conditional',survivesCompact:true,
    note:'按需Pi记忆会话专用角色与封闭记忆工具合同；可依据用户原话整理全局画像、偏好，无工作区/全局技能、原生工具、MCP或通用调度能力。src/main/memory/curator/prompt.ts + pi.ts'},
  {id:'memory.curator.candidate',target:'both',channel:'event-wake',mode:'conditional',survivesCompact:false,
    note:'主Agent显式提交后才唤醒；候选与依据为数据，身份/授权来自宿主可靠队列，不把后台消息当用户授权。src/main/memory/curator/runtime.ts + prompt.ts'},
  {id:'memory.curator.user-input',target:'both',channel:'turn-prefix',mode:'conditional',survivesCompact:false,
    note:'用户主动在记忆视图查询、更正或管理记忆；不承接工程/联网/派活，不扩角色权限。src/main/memory/curator/runtime.ts + prompt.ts'},
  {id:'memory.curator.receipt-repair',target:'both',channel:'event-wake',mode:'conditional',survivesCompact:false,
    note:'模型结束后宿主复核仍缺事务回执时，仅给未完成候选一次补结算提示；共享原批次模型/时间/证据预算，不复做已完成项或新增用户授权。src/main/memory/curator/runtime.ts + prompt.ts'},
  {id:'memory.curator.compaction',target:'both',channel:'compact',mode:'conditional',survivesCompact:false,
    note:'专用压缩约束预留；当前达到上下文预算时在下一个明确任务前换代，不新增压缩模型请求。候选与提交以账本恢复。src/main/memory/curator/prompt.ts + runtime.ts'},
  { id: 'both.tool-schema.resident', target: 'both', channel: 'tool-schema', mode: 'always', survivesCompact: true,
    note: '常驻清单即模型全部可用面——工具原生注册直调；复杂与低频域收敛为 host.*.run 入口，action 枚举即动作词表，params 不再展开，参数细节在 ~/.muster/skills/<域>/SKILL.md（desktop/panel 于 2026-11-12 收成域壳，per-action 校验仍在宿主侧）。发现层（tools.search/tools.call）已退役；目录不注入每轮。GUI 面 agentSession/tools/discovery.ts 常驻过滤；调度面 providers/piProvider.ts registerTools；PTY/ACP 面 inboundMcp/toolList.ts。src/shared/toolDiscovery.ts。' },
  { id: 'both.tool-result.event-mail', target: 'both', channel: 'tool-result', mode: 'conditional', survivesCompact: false,
    note: 'events.subscribe 命中的事实及注册事件经持久日志与邮箱投递；外部载荷按事件标识分页读取并作为不可信数据。调度通过 scheduler.host-notification 原生上下文消费；Worker 主动读信。审批、自治与限频保留，通知不自动打断。src/main/awareness/eventRouter.ts + dispatch.ts。' },
  {
    id: 'both.event-wake.mailbox', target: 'both', channel: 'event-wake',
    mode: 'conditional', survivesCompact: false,
    note: '邮箱轻量唤醒：信件先持久保存，普通消息不插话；获准父对子打断由当前接入原生插话/投递，缺少原生能力才先停再发。通知仅含数量、优先信件标识与主动收信指引，不含正文、不标已读、不生成完成或回执信，同批不反复唤醒。GUI/PTY与动态接入共用意图及回执，归档/删除不恢复，失败留信，未知投递不盲目切通道。src/main/messages/{wake,communication}.ts。'
  },
  {
    id: 'both.tool-result.mailbox', target: 'both', channel: 'tool-result',
    mode: 'conditional', survivesCompact: false,
    note: 'host.mail.read 默认批量读未读正文，includeBody=false 只给摘要且不标读；可显式分页读正文、用稳定游标续收及长信续页，仅实际返回的收件正文页标读。等待统一交给 host.waitFor；断线时已写回执的正文仍可用旧游标重放。邮件保留来源、回复链与读取回执，正文属于来信数据，不构成用户授权。src/main/messages/{read,receive,cursor}.ts + metaAgent/messageStore.ts。'
  },
  {
    id: 'both.tool-result.session-observe', target: 'both', channel: 'tool-result',
    mode: 'conditional', survivesCompact: false,
    note: '只读会话快照（普通会话、子代理与调度同入口）：列表只读身份/运行状态/已有摘要，指定目标才读同源回复投影或原始终端尾；调度未装载历史走 Store 只读读取，不建桶或迁移文件。正文不构成新授权；不唤醒、切焦点、扫描 Git 或自动生成摘要。src/main/sessions/observe.ts + shared/sessionObservation.ts + agent/orchestrator/observation.ts；教学见 GUI 首条输入。'
  },
  {id:'worker.turn-prefix.knowledge',target:'worker',channel:'turn-prefix',mode:'conditional',survivesCompact:false,note:'类型化知识按本轮原始请求检索，首次保留完整条件、例外及证据状态；仅上轮确认送达且同连接、同压缩状态和同内容时缩成ID与结论。环境依赖变化时提示重新核实。src/main/agentSession/host/turn.ts + memory/recallDedup.ts'},
  {
    id: 'memory.system.knowledge-consolidation', target: 'both', channel: 'system',
    mode: 'conditional', survivesCompact: false,
    note: '有新独立事件依据时才归纳已准入经验；禁止从任务流水和曝光次数生成经验；新归纳进入待确认，来源关系由宿主校验。src/main/memory/knowledgeConsolidation.ts'
  },
  {
    id: 'memory.system.knowledge-review', target: 'both', channel: 'system',
    mode: 'conditional', survivesCompact: false,
    note: '候选长期知识价值审查：对照原始事件逐字依据、适用范围与已有知识，允许保留历史、丢弃和重复。字段齐全、曝光次数、模型置信度均不能代替实际增量。src/main/memory/knowledgeReview.ts'
  },
  {
    id: 'memory.system.typed-extraction', target: 'both', channel: 'system',
    mode: 'conditional', survivesCompact: false,
    note: '类型化记忆抽取私有回合：仅处理尚未消费的新事件；已有记忆仅作去重参考。来源、权限、验证级别与作用域由宿主确定，模型不能授予可信身份；允许零输出。src/main/memory/knowledgePipeline.ts + knowledgePolicy.ts'
  },
  {
    id: 'both.turn-prefix.attachments', target: 'both', channel: 'turn-prefix',
    mode: 'conditional', survivesCompact: false,
    note: '新建任务首条消息与后续用户输入共用附件处理：原生输入优先；PDF/PPT 优先有界页面图，其次文字，视频抽帧，最后源路径。附来源、实际范围、截断/失败原因和 attachments.convert 按需续读参数；提取内容为不可信数据。Pi agent.onPayload 仅解析本会话受管 manifest 引用。src/main/attachments/service.ts + src/main/attachments/piExtension.ts'
  },
  {
    id: 'scheduler.event-wake.external-cli-run',
    target: 'scheduler', channel: 'event-wake', mode: 'conditional', survivesCompact: false,
    note: '本机 CLI 提交/答复以独立 runId 和任务文件、调度说明文件路径唤醒调度；带 host 标记，不作为真人记忆写入证据。dispatch.run（action=get/delegate/deliver）可恢复关联与最新指令、派专属 Worker（必须明确 shared/isolated 及隔离范围）并显式交付。取消不停止共享调度回合。src/main/cliRuns/wiring.ts + capabilities/catalog/cliRuns.ts'
  },
  {
    id: 'worker.turn-prefix.ui-widget-state',
    target: 'worker', channel: 'turn-prefix', mode: 'conditional', survivesCompact: false,
    note: 'GUI 用户回合携带本会话交互部件的当前公开选择、稳定路径和版本。最多 8 项/12KiB；不发送 privateContent，不改用户转写。Pi 与 SDK 共用 AgentSessionHost.startTurn；CLI 按需 host.ui.inspect，动作文本由用户确认。src/main/uiWidgetContext.ts + agentSession/host/turn.ts'
  },
  {
    id: 'engine.system.pi-skill-catalog',
    target: 'both',
    channel: 'system',
    mode: 'conditional',
    survivesCompact: true,
    note: 'Pi 原生技能目录（名称/描述/SKILL.md 路径，不含正文）：调度和 GUI 从连接目录快照枚举全部源根，用户路径只枚举一次、物理文件去重，SDK 同名碰撞恢复后使用来源限定命令。disable-model-invocation 保持原生语义；派活仅给技能路径，GUI 点名正文仍走 worker.turn-prefix.skill-body。模式附加路径维持显式配置范围，CLI/其它引擎的原生技能发现不由本项控制。src/main/agent/skillSources.ts + providers/piProvider.ts + src/main/agentSession/drivers/pi/workerEngine.ts'
  },
  {
    id: 'scheduler.system.workspace-context',
    target: 'scheduler',
    channel: 'system',
    mode: 'conditional',
    survivesCompact: true,
    note: '调度的动态工作区目录事实段：全部源根、单一固定 cwd、管理目录、读写范围与映射。回合在记忆等待前捕获并占用全部根；目录变化仅下轮重建连接并续同一历史。Pi 原生文件工具按相同快照校验，shell/MCP 不宣称 OS 沙箱。设置预览与注入度量使用同源目录段。src/main/agent/schedulerWorkspaceContext.ts + systemPrompt.ts + providers/piProvider.ts'
  },
  {
    id: 'worker.turn-prefix.cli-workspace-context',
    target: 'worker',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: 'CLI 启动/派活/回注简报附同一进程目录快照：单 cwd、固定管理根、源根/任务读写范围与隔离映射；原生额外目录参数传可写根及当前会话专属交接文档目录（原生参数可能允许写入后者），不把隔离源检出扩成可写根。未声明目录参数时提示交接文件受 CLI 沙箱限制；普通 TTY 回注不扩张已运行进程。提示词分配范围不等于 CLI/OS 权限沙箱。src/main/sessions.ts + src/main/sessions/cliWorkspaceContext.ts + src/main/capabilities/hosts/chat.ts'
  },
  // ── 调度面：system prompt（R1 分段）──
  {
    id: 'scheduler.system.stable-body',
    target: 'scheduler',
    channel: 'system',
    mode: 'always',
    survivesCompact: true,
    note: `调度正文（customBody 或内置默认）+ 全局行为规约；引导主动提交用户提供的画像和偏好，派活显式选择 shared/isolated，dirty 仅作任务隔离决策参考。pi appendSystemPrompt 的 ${SCHEDULER_SEGMENTS[0]} 段（MUSTER_PROMPT_SEGMENTS[0]，会话内字节不变；段序以该常量为准）。src/main/agent/systemPrompt.ts buildMetaAgentAppendPrompt`
  },
  {
    id: 'scheduler.system.catalog-map',
    target: 'scheduler',
    channel: 'system',
    mode: 'always',
    survivesCompact: true,
    note: "Catalog 附录（R5 终态）：常驻清单即模型全部可用面——全部工具原生注册带 schema 直调，八域 run 单入口（schema 枚举即动作词表，参数细节在 ~/.muster/skills/ 对应技能），发现层已退役。附录只留常驻面流程句与当前可用家族短索引，按当前身份、回合隐藏集裁剪。src/main/agent/systemPrompt.ts + capabilities/catalog/api.ts"
  },
  { id: 'scheduler.system.visual-output', target: 'scheduler', channel: 'system', mode: 'always', survivesCompact: true,
    note: '调度的能力附录提示按需使用 Mermaid，并在本轮开放 ui.render 时说明何时采用交互部件。src/main/agent/systemPrompt.ts + src/shared/visualOutputGuidance.ts。' },
  // ── 调度面：工具定义 ──
  {
    id: 'scheduler.tool-schema.catalog',
    target: 'scheduler',
    channel: 'tool-schema',
    mode: 'always',
    survivesCompact: true,
    note: "调度常驻工具由过滤后的源清单投影为 host.*；host.ask 合并用户提问，host.sessions.update 合并字段设置，host.llm.run 包含 quota，其他复杂域使用 host.*.run。公开 schema 和角色来自同一投影，原来源仅用于内部权限及执行；旧名不注册，动态 ext.* 沿用信任边界。Agent 创建必须显式选择 shared/isolated。模型面为 host.desktop.run 与 host.panel.run（params 不展开，参数见对应技能文档）；桌面动作的平台与权限边界见 docs/features/desktop-control.md，panel 网页仅支持右侧。src/main/agent/providers/piProvider.ts + capabilities/catalog/projectedCatalog.ts + capabilities/projectedScheduler.ts"
  },
  // ── 调度面：回合前缀 ──
  {
    id: 'scheduler.turn-prefix.memory-bucket',
    target: 'scheduler',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: '调度生效约束与全局用户画像 bootstrap（MemoryService.injectKnowledge，versionToken 未变跳过重注入）。src/main/agent/orchestrator/memoryInjection.ts applySchedulerMemoryInjection；compact 后置 memoryInjectionDue 重注入'
  },
  {
    id: 'scheduler.turn-prefix.situation',
    target: 'scheduler',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: 'R-12 编排态势 .muster/scheduler/SITUATION.md（桶建立/clearHistory/compact 后 due 时现采现写再注入）。src/main/agent/orchestrator/memoryInjection.ts applySchedulerMemoryInjection'
  },
  {
    id: 'scheduler.turn-prefix.trigger-recall',
    target: 'scheduler',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: '类型化知识按需召回：工作范围及全局经验、偏好或显式历史查询，1500ms有界；同一连接与压缩状态下上轮确认送达且未变化的条目缩为ID与结论，其他条目包含完整条件、例外和依据状态。仅用户回合。src/main/agent/orchestrator/memoryInjection.ts + memory/recallDedup.ts'
  },
  {
    id: 'scheduler.turn-prefix.intents-scan',
    target: 'scheduler',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: 'B7 standing intents 消息面扫描（全词预筛→隐藏块；仅用户回合）。src/main/agent/orchestrator/memoryInjection.ts composeReadPathTurnText'
  },
  {
    id: 'scheduler.turn-prefix.date-change',
    target: 'scheduler',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: 'C1 跨日日期提醒：首次锚定/跨自然日注入一行 <系统提醒>（pi system prompt 无日期，保前缀缓存不改 system）。src/shared/dateChangeReminder.ts + src/main/agent/orchestrator/memoryInjection.ts applyDateChangeReminder'
  },
  {
    id: 'scheduler.turn-prefix.prompt-tasks',
    target: 'scheduler',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: '无头定时任务的任务原文（runHeadlessPiTask，调度域独立会话的回合文本；经决策门挡 needs_you 期触发）。src/main/agent/providers/piProvider.ts + src/shared/promptTasks.ts'
  },
  {
    id: 'scheduler.turn-prefix.workflow-command',
    target: 'scheduler',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: '调度输入框展开 /workflow-new 与 /workflow 指令。新建只给 ~/.muster/skills/workflow/SKILL.md 创作路径，运行先用 host.workflow.run 的 list 动作核对，再用 start。界面仍显示用户原文，宿主自治回合不展开。src/main/agent/orchestrator/turnExecution.ts + src/shared/workflowCommand.ts'
  },
  // ── 调度面：事件/即时唤醒 ──
  {
    id: 'scheduler.event-wake.orch-events',
    target: 'scheduler',
    channel: 'event-wake',
    mode: 'conditional',
    survivesCompact: false,
    note: "编排泵的 wake/digest/mute 与归并窗口保留，flush 把正文存入调度邮箱；读信提醒经 mailbox.wake 和原调度自治准入。工作流待答、失败、中断属于底线，完成与触发受阻唤醒，进展只捎带。订阅事实另外使用同一个邮箱底座，不再经旧 fact sink 或直接发送正文。src/main/orchestrator/events.ts + messages/wake.ts + shared/subscriptionPolicy.ts"
  },
  {
    id: 'scheduler.event-wake.immediate-channels',
    target: 'scheduler',
    channel: 'event-wake',
    mode: 'conditional',
    survivesCompact: false,
    note: "会话提问、答复和普通业务通信统一保存邮箱，空闲时提示读信；requestIntegrate 保留合入审批控制流程。通知与实际已读、处理、交付分别表达。src/main/messages/deliver.ts + wake.ts + capabilities/hosts/sessions.ts"
  },
  // ── 调度面：工具结果 ──
  {
    id: 'scheduler.tool-result.ask-question',
    target: 'scheduler',
    channel: 'tool-result',
    mode: 'conditional',
    survivesCompact: false,
    note: 'host.ask 决策卡的用户作答回传（工具结果进上下文，取消即失败）。shared/orchestratorAskQuestion.ts'
  },
  {
    id: 'scheduler.tool-result.workflow-ask-human',
    target: 'scheduler',
    channel: 'tool-result',
    mode: 'conditional',
    survivesCompact: false,
    note: 'workflow.askHuman：工作流脚本 wf.ask {to:human} 的问题默认亮在工作流面板由用户直接答；用户在对话里提起时调度可用本工具原样弹成问题卡，用户答案直接回写脚本，工具结果只回执答案与一句说明（未作答时问题仍挂着）。src/main/capabilities/hosts/workflow.ts + src/shared/workflow.ts'
  },
  // ── 调度面：压缩摘要指令（B1 层级二 / B3 结构化模板 + transcript 指针）──
  {
    id: 'scheduler.compact.micro-instructions',
    target: 'scheduler',
    channel: 'compact',
    mode: 'conditional',
    survivesCompact: true,
    note: 'B1 微压缩触发时随 session.compact(customInstructions) 下发的定向摘要指令（旧轮询结果只留一行结论）；B3 起与全量模板共用 compactSummary 六节核心（逐字保留条款随核心带上）；压缩产出的摘要即压缩后上下文，故 survivesCompact=true。src/shared/microcompactPolicy.ts buildMicroCompactInstructions'
  },
  {
    id: 'scheduler.compact.summary-template',
    target: 'scheduler',
    channel: 'compact',
    mode: 'conditional',
    survivesCompact: true,
    note: 'B3 结构化压缩摘要模板：手动 /compact（用户补充说明优先级最高）与 0.8 自动压缩时随 session.compact(customInstructions) 下发的六节摘要要求（核心诉求/关键事实与决策/用户规约与安全约束逐字保留/派活与验收在途/压缩前正在做什么/下一步建议）；摘要即压缩后上下文，故 survivesCompact=true。src/shared/compactSummary.ts buildFullCompactInstructions + src/main/agent/orchestrator/compaction.ts compactSession'
  },
  {
    id: 'scheduler.turn-prefix.transcript-pointer',
    target: 'scheduler',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: 'B3 transcript 快照指针：compact 前快照会话 JSONL 成功后，下一回合前缀注入一行「完整历史快照已存 <路径>」（host 与用户回合都带，注入即清；与 MEMORY/SITUATION 桶分工=桶给结论、快照给细节）。src/main/agent/transcriptSnapshot.ts + src/shared/compactSummary.ts buildTranscriptPointerLine + src/main/agent/orchestrator/memoryInjection.ts applyTranscriptPointerInjection'
  },
  // ── Worker 面 ──
  {
    id: 'worker.brief.mail-continuity',
    target: 'worker',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: 'GUI 与 CLI Worker 的首条宿主输入简述 notice、ask、handoff 的用途，并在 waitFor 可用时提示挂起等待期间继续其他工作。src/shared/workerGuidance.ts。'
  },
  {
    id: 'worker.brief.memory-skill',
    target: 'worker',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: 'GUI 与 CLI 首条宿主输入要求在延续旧工作、参考既有决策或偏好时主动检索，指引记录值得回看的工作和提交持久信息。GUI 只提示当前可用工具。src/shared/memoryFormat.ts、guiWorkerPrompt.ts、workerBrief.ts。'
  },
  {
    id: 'worker.memory-skill.host-gate',
    target: 'worker',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: 'GUI 首条引擎消息和 CLI 首条简报要求在本会话首次调用记忆工具前读取 ~/.muster/skills/memory/SKILL.md。CLI 以 MUSTER_HOST 判定宿主。src/shared/memoryFormat.ts、guiWorkerPrompt.ts、workerBrief.ts。'
  },
  {
    id: 'worker.turn-prefix.cli-host',
    target: 'worker',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: '传统 CLI 的首条简报直接携带宿主身份、状态上报指引和当前全局行为规约。src/shared/workerBrief.ts。'
  },
  {
    id: 'worker.tool-schema.pty-http',
    target: 'worker',
    channel: 'tool-schema',
    mode: 'conditional',
    survivesCompact: false,
    note: 'CLI 的 HTTP 回退按需从同一个宿主工具 URL 读取 Worker 白名单及参数 schema，需会话 Bearer 身份。src/main/protocol/shellApi.ts。'
  },
  {
    id: 'worker.turn-prefix.gui-policy',
    target: 'worker',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: 'GUI Worker 首条适用输入介绍宿主与 Harness 分工、会话身份和目录，并按可用工具说明状态上报、协作与文件改动登记。GUI 与 CLI 共用需要用户行动和交付完成的判断条件。muster_host_context 标出 GUI 说明，引擎确认后续聊沿用投递状态。src/shared/guiWorkerPrompt.ts、workerGuidance.ts。'
  },
  {
    id: 'worker.system.pi-persona',
    target: 'worker',
    channel: 'system',
    mode: 'conditional',
    survivesCompact: true,
    note: '内置 Pi 自定义模式的 persona 随会话系统提示投递。src/main/agentSession/host/connection.ts。'
  },
  {
    id: 'worker.system.extension-agent',
    target: 'worker',
    channel: 'system',
    mode: 'conditional',
    survivesCompact: true,
    note: '绑定 sidebar 扩展实例的 Extension Agent 领域提示词；在侧栏及用户从扩展创建的项目任务中按包指纹注入，不能替换宿主安全策略或跨扩展复用。src/main/extensions/extensionAgentService.ts promptForSession + src/main/agentSession/host/connection.ts。'
  },
  {
    id: 'worker.tool-schema.extension-agent-domain',
    target: 'worker',
    channel: 'tool-schema',
    mode: 'conditional',
    survivesCompact: true,
    note: '当前扩展实例的 DomainRuntime 查询与命令工具目录；工具身份、扩展权限和实例包指纹由宿主复核，面板与 Agent 共用领域命令。src/main/extensions/extensionAgentService.ts toolsForSession + src/main/agentSession/host/connection.ts。'
  },
  {
    id: 'worker.tool-schema.extension-agent-mcp',
    target: 'worker',
    channel: 'tool-schema',
    mode: 'conditional',
    survivesCompact: true,
    note: '当前扩展实例声明并信任的 MCP descriptor 经独立 ExtensionMcpSessionManager 注册为 ext.<id>.mcp.* 工具；每个 Pi 会话有独立 McpHub，关闭时回收 stdio/HTTP 连接，不改全局 MCP 配置。src/main/extensions/extensionMcpSession.ts + extensionAgentService.ts。'
  },
  {
    id: 'worker.event.extension-agent-domain',
    target: 'worker',
    channel: 'event-wake',
    mode: 'conditional',
    survivesCompact: false,
    note: '当前扩展实例 DomainRuntime 事件只用于刷新扩展界面；不会通过 host nudge 写入 Agent 会话或自动触发模型调用。Agent 在需要时通过当前扩展的 state.snapshot 或查询工具按需读取最新状态。src/main/extensions/extensionAgentService.ts extensionSubscribe + extensionAgentToolset。'
  },
  {
    id: 'worker.turn-prefix.workspace-context',
    target: 'worker',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: '普通 GUI 会话（含子代理）的目录快照：当前会话受管附件目录仅加入可读范围（不加入 SDK 可写根），工作区身份、全部源根、单 cwd（新任务保留源目录）、固定管理根、可读/可写目录与版本化隔离映射；源检出仅供参考、任务树用绝对路径修改/测试/Git，host.sessions.isolate 可追加登记，下次连接生效；根版本或物理目录变化在下一回合重建连接，运行中不扩权，子代理复用同一连接路径。数据来自 src/main/workspaceExecutionContext.ts 与 agentSession/host/connection.ts。引擎能力由共享描述符说明，不将提示词目录列表称为 OS 沙箱。'
  },
  {
    id: 'worker.turn-prefix.muse-policy',
    target: 'worker',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: 'Muse GUI 将已物化工作台政策段放入连接内首轮 turn/start 的输入前缀；宿主工具通过独立 MSP 会话与 MCP 桥注册。src/main/agentSession/drivers/muse/driver.ts。'
  },
  {
    id: 'worker.turn-prefix.zcode-policy',
    target: 'worker',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: 'ZCode GUI 使用首轮用户消息前缀传递已物化工作台政策段；当前 ZCode 适配不注册工作台宿主工具，提示不得宣称这些工具可用。src/main/agentSession/drivers/zcode/driver.ts。'
  },
  {
    id: 'worker.tool-schema.host-tools',
    target: 'worker',
    channel: 'tool-schema',
    mode: 'always',
    survivesCompact: true,
    note: 'Worker 常驻面按 GUI、ACP 或 PTY preset 与实际权限过滤后投影为 host.*；提问通道存在时公开 host.ask，旧问卷名不再额外注册。host.browser.run 的动作参数见 ~/.muster/skills/browser/SKILL.md；内部来源仍用于权限与身份绑定，模型工具面不提供动态 Harness 登记与信任状态动作。模型面为 host.desktop.run 与 host.panel.run（params 不展开，参数见对应技能文档）；桌面动作的平台与权限边界见 docs/features/desktop-control.md，panel 网页仅支持右侧。src/main/agentSession/tools/projectedGuiTools.ts + src/main/inboundMcp/toolList.ts + src/main/protocol/shellApi.ts'
  },
  {
    id: 'worker.tool-schema.pi-cli-host-mcp',
    target: 'worker',
    channel: 'tool-schema',
    mode: 'conditional',
    survivesCompact: true,
    note: '外部 Pi / Oh My Pi CLI 由受管启动显式加载 _pi-host-mcp.mjs，会话内从统一 stdioEntry 读取 pty-allowlist 工具 schema 并经 registerTool 注册；调用和取消沿原宿主身份网关传递，关闭时回收 MCP 子进程，不改调度出站 MCP 配置，不追加提示词。src/main/runtime/host.ts + runtime/builtins/scripts/_pi-host-mcp.mjs。'
  },
  {
    id: 'both.tool-schema.mcp-relay',
    target: 'both',
    channel: 'tool-schema',
    mode: 'always',
    survivesCompact: true,
    note: 'MCP 中转：常驻 host.mcp.search / host.mcp.call；第三方 server 不进引擎原生工具清单，经宿主 mcpHub 中转。权限与 actor 绑定仍落在内部真实动作；默认模式审批、ask/plan 只读门保持原规则。src/main/agent/mcpProxy.ts + capabilities/hosts/mcp.ts。'
  },
  {
    id: 'worker.turn-prefix.ui-widgets-hint',
    target: 'worker',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: 'GUI 与 CLI Worker 首条输入按需提示 Mermaid 和交互部件。GUI 仅提示实际注册的 ui.render，CLI 指向 Markdown 交付物及可用的宿主工具。src/shared/visualOutputGuidance.ts + guiWorkerPrompt.ts + workerBrief.ts。'
  },
  {
    id: 'worker.tool-result.ui-session-page',
    target: 'worker',
    channel: 'tool-result',
    mode: 'conditional',
    survivesCompact: false,
    note: 'host.ui.render 返回结构化控件诊断（表达式/位置/建议）供模型修正；CLI 返回会话交互 UI 页打开状态并提示去右侧查看；失败保留原始链接，不冒充已渲染。host.ui.inspect 的原工具 schema 增加 pointer/offset/limit，按公开参数分段读取，不暴露 privateContent。src/main/capabilities/hosts/uiWidgets.ts + catalog/uiAppExtensions.ts'
  },
  {
    id: 'worker.turn-prefix.tree-guard',
    target: 'worker',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: 'P5/P11 上报守卫：仅过早上报缺少理由、任务仓确有未提交改动等 Worker 可行动事项经 injectHostNudge 回注并去重。瞬时锁只读检查最多尝试4次、默认间隔200ms，恢复仅记日志；持续检查或快照故障经 merge_blocked 编排事件通知调度，不注入 Worker。requestIntegrate 快照结果直接返回工具，不额外唤醒模型；写入不自动重放、保留部分提交。提示使用中英本地化文案，原始异常仅供宿主诊断。src/main/agentSession/workerTreeGuard.ts + workerTreeRetry.ts + git/worktreeTaskWorker.ts'
  },
  {
    id: 'worker.turn-prefix.skill-body',
    target: 'worker',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: 'A2 skill 点名即加载：GUI 的 /skill:name 与点名装入正文，未点名不整目录注入。裸词只用当前任务源根/用户范围；同名显式命令要求限定来源，来源消失或文件物理身份变化返回警告，限定命令本身不再触发另一份同名正文。裸词仍要求可辨识名或 automention opt-in。单回合预算 20k 字符；会话去重与审计 skillId 使用物理文件身份，显式加载不受已注入限制。派活正文不复制，改走 skill-pointer。src/shared/skillInject.ts + src/main/agent/skillInject.ts prepareEngineSkillText'
  },
  {
    id: 'worker.turn-prefix.skill-pointer',
    target: 'worker',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: 'A5 披露分级：派活简报里点名的 skill 只附「名 + SKILL.md 绝对路径」指路块，正文由 Worker 自行读取（.agents/skills 已链到各 CLI skill 目录）。审计 trigger=brief-pointer。src/shared/skillInject.ts formatSkillPointerBlock + src/main/agent/skillInject.ts appendNamedSkillsToBrief'
  },
  {
    id: 'worker.turn-prefix.mode-hooks-memory',
    target: 'worker',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: 'pi GUI Worker modeHooks memoryInject：生效约束与全局用户画像逐轮快照，预算受 MemoryService.injectKnowledge 限制；不注入任务流水。src/main/agentSession/drivers/pi/modeHooksExtension.ts'
  },
  {
    id: 'worker.turn-prefix.read-state-stale',
    target: 'worker',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: 'A1 read-state 过期提示：Read 登记 / Write·Edit·bash 疑似写后标脏，下一轮 startTurn 前缀注入【read-state】重读提醒（同回合多文件合并一条；docs/**、契约、AGENTS/HOST、.agents/skills/** 优先排序）。src/shared/readState.ts + src/main/agentSession/host/readStateTrack.ts + src/main/agentSession/host/turn.ts'
  },
  {
    id: 'worker.turn-prefix.plan-approved',
    target: 'worker',
    channel: 'turn-prefix',
    mode: 'conditional',
    survivesCompact: false,
    note: 'C2 计划门批准回灌：计划类工具（exit_plan_mode/createPlan 等）经确认卡批准后，下一回合 startTurn 前缀注入「Approved Plan + Pre-authorized prompts」（取走即清）；allowedPrompts 预授权在 decideToolCallPermission 的 shell 面即刻生效（严格命中：等值/纯空白前缀，含元字符不命中）。src/shared/planApproval.ts + src/main/agentSession/host/approvals.ts takePlanApprovedFeedback + src/main/agentSession/host/turn.ts + src/main/agentSession/tools/policy.ts'
  },
  {
    id: 'worker.system.no-bash-note',
    target: 'worker',
    channel: 'system',
    mode: 'conditional',
    survivesCompact: false,
    note: 'shell-env 三件套 B：win32 探测不到 Git Bash 时，GUI Worker system prompt 末尾追加「本机无 bash，shell 操作一律用 powershell 工具」引导段（NO_BASH_PROMPT_NOTE；appendSystemPromptOverride 拼接，探测恢复后不再注入；compact 后 system prompt 重建时按当时探测结果重算）。src/main/agentSession/drivers/pi/workerEngine.ts + src/main/agentSession/drivers/pi/shellEnv.ts'
  },
  {
    id: 'worker.tool-result.ask-question',
    target: 'worker',
    channel: 'tool-result',
    mode: 'conditional',
    survivesCompact: false,
    note: 'Worker 侧 host.ask 用户作答经工具结果回传；可用通道由宿主连接快照决定。src/main/agentSession/tools/workerHostAsk.ts + projectedGuiTools.ts'
  }
];

/** 设置页/诊断面板消费：注册表快照（顺序即登记顺序） */
export function listInjections(): readonly InjectionSource[] {
  return INJECTION_REGISTRY;
}

/**
 * 按 id 取注册表条目（A3 登记制的查找口）。
 * S2.1 digest 信任现状（2026-09-27 复审）：一期只做**记账**——ensureForApp 把
 * registry 条目 + HOST/HOST-EXT 片段登记进 DeclarationTrustStore（pending_trust /
 * 内容变 → stale_digest 落账本），注入路径尚未消费信任态（未接线审批面）；
 * 二期接线时在注入组装处过滤 filterInjectablePhaseOne 并配 pending 审批卡。
 */
export function getInjectionSource(id: string): InjectionSource | undefined {
  return INJECTION_REGISTRY.find((s) => s.id === id);
}
