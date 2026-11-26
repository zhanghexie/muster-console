/**
 * A4 轮级工具可见性（zcode-adoption-plan A4；ZCode 同型机制：
 * refs/ZCode/apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts:221-238
 * buildTurnDisallowedTools——automation 轮隐藏 Cron 写工具、off-peak 轮隐藏闲时写工具）。
 *
 * 给调度域回合打**回合类型标签**，映射出该类回合应隐藏的工具组/定点工具：
 * - interactive：用户对话轮（调度聊天），全量工具面；
 * - prompt-task：定时任务轮（headless prompt task 执行，runHeadlessPiTask 每次新建独立
 *   会话，会话创建即回合发起）——隐藏定时任务写组（防递归自建）等无关高危写面；
 * - event-wake：编排事件/即时通道唤醒的宿主自治轮（orchestrator send {host:true}），
 *   与交互轮共享同一长会话。映射为空集（见函数内理由），且不落轮级裁剪接线：
 *   pi 的 setActiveToolsByName 是会话级开关（agent-session.d.ts:309-318「重建 system
 *   prompt，下一回合生效」），在共享会话上逐轮翻动会打穿前缀缓存。
 *
 * 未知/缺省类型一律返回空集（fail-open：识别不了就不裁剪，宁放过不误杀）。
 * 本模块保持零导入（纯类型+纯函数），供 piProvider / catalog / 测试三方共用。
 */

/** 调度域回合类型标签 */
export type SchedulerTurnKind = 'interactive' | 'prompt-task' | 'event-wake';

/** 一类回合应隐藏的工具面：整组隐藏 + 组内定点隐藏（读写混合组保读藏写） */
export interface TurnHiddenTools {
  /** 整组隐藏（catalog 组名 = 工具名首个点号前缀） */
  groups: readonly string[];
  /** 定点隐藏的 catalog 工具名（点号全名） */
  tools: readonly string[];
}

const EMPTY_HIDDEN: TurnHiddenTools = { groups: [], tools: [] };

/**
 * piProvider runPiTurn 的回合作用域标记 → 调度回合类型标签。
 * （'headless'=无头定时任务轮；'host'=事件唤醒自治轮；'user'=用户对话轮。）
 */
export function schedulerTurnKindFromTurnScope(
  turnKind: 'user' | 'headless' | 'host' | undefined | null
): SchedulerTurnKind {
  if (turnKind === 'headless') return 'prompt-task';
  if (turnKind === 'host') return 'event-wake';
  return 'interactive';
}

/**
 * 回合类型 → 本轮隐藏工具面（纯映射，逐条给理由）。
 * 未知/缺省类型 fail-open 返回空集。
 */
export function resolveTurnHiddenTools(kind: string | null | undefined): TurnHiddenTools {
  switch (kind) {
    case 'prompt-task':
      return PROMPT_TASK_HIDDEN;
    case 'interactive':
      // 用户在场，保留全量能力（含定时任务管理——用户可能当面要求加任务）。
      return EMPTY_HIDDEN;
    case 'event-wake':
      // 自治唤醒轮（Worker 完工补位/邮箱收信 决策/requestIntegrate）恰恰需要完整
      // 派活与协调面（如收信后答复或调整任务）；且与交互轮共享长会话，
      // 逐轮收缩要翻动 setActiveToolsByName → 重建 system prompt → 打穿前缀缓存。
      // ZCode 同口径：buildTurnDisallowedTools 只裁 automation/off-peak 执行轮，不裁唤醒轮。
      return EMPTY_HIDDEN;
    default:
      // 未知标签 fail-open：不裁剪（新增回合类型忘接映射时宁可全量，不可误瞎）。
      return EMPTY_HIDDEN;
  }
}

/**
 * prompt-task（无头定时任务执行轮）隐藏面。
 * 注意：这是**工具面裁剪**不是沙箱——pi 内建 bash/read/write 仍在，直改 userData 文件
 * 不在本裁剪目标内（与 ZCode 工具面裁剪同口径：防模型误用递归自建，不防恶意绕行）。
 */
const PROMPT_TASK_HIDDEN: TurnHiddenTools = {
  groups: [
    // 定时任务定义全组写（create/update/delete/setEnabled/runNow）：
    // 防递归自建/自改——任务执行轮不能反过来管理自己的定义（D8 核心目标；
    // ZCode AUTOMATION_MUTATION_TOOL_NAMES「保留只读、隐藏 mutation」同型）。
    'automations',
    // 运行时注册/更新/删除：系统级变更与任务执行无关；runtimes.list 读随之舍弃
    // （裁剪后无派活需求，读运行时列表也无用）。
    'runtimes',
    // 模型/凭证配置写（upsertProvider/setDefault/testConnection）：配置面变更禁止；
    // listProviders/quota 读随之舍弃（任务轮不需要换模型/查额度）。
    'llm',
    // 闲时任务组（ZCode OFF_PEAK_MUTATION_TOOL_NAMES 对应物，防闲时递归自建）：
    // 本仓暂无该组，占位留名——未来若新增同名组自动被裁（隐藏不存在的组是 no-op）。
    'offPeak'
  ],
  tools: [
    // 建议回复只服务交互会话，无头任务没有当前用户输入框。
    'ui.suggestReplies',
    'ui.reminders',
    // sessions 组为读写混合：藏派生/合入/归档/收编等写面，保读（observe/search/readMessages）与自身状态上报（setStatus）。
    // 派生 Worker 会话——与派生会话相同理由。
    'sessions.create',
    // 切换/恢复会话：抢中栏焦点类动作，无头轮无界面语义。
    'sessions.select',
    'sessions.recoverInterrupted',
    'sessions.interrupt',
    'sessions.restartConversation',
    'sessions.setArchived',
    // 关闭/归档/验收/收编：批量生命周期变更，与任务执行无关且不可逆风险高。
    'sessions.delete',
    'sessions.review',
    'sessions.completeAndArchive',
    'sessions.setOrchestrated',
    // 合入面（requestIntegrate/integrate）：worktree 合入是交互域审批动作。
    'sessions.requestIntegrate',
    'sessions.integrate',
    // 跨会话留言/回复：调度协调行为，任务轮自言自语场景不需要。
    'sessions.message',
    // 订阅策略写：定时任务轮不得改交互调度被什么唤醒（保 scheduler.policy.get 读）。
    'scheduler.policy.set',
    // 工作流会派活——与派生会话相同理由；答复/问人/取消是交互调度对 run 的控制面。
    // 九域收敛后这些动词只作为 workflow.run 的 action 存在（原工具退为内部真源）：
    // 动词名单保留给执行面按真实目标复核，注册面由 isToolDefHidden 的 run 入口规则
    // 把 workflow.run 整体隐藏（域读面随之不可达——W4 另设读入口时再放）。
    'workflow.start',
    'workflow.reply',
    'workflow.askHuman',
    'workflow.cancel'
  ]
};

/**
 * run 入口（`X.run` 信封）与其 catalog 域组的对应：入口名前缀通常即域组
 * （workflow.run → workflow），改名域在此登记（runs.* 域的入口叫 dispatch.run）。
 * 本模块保持零导入，改名映射与 catalog/runTools RUN_TOOL_DOMAIN_SPECS 的 runName
 * 改名保持同源维护（两侧漂移由 test/turn-visibility.mjs 第 3 节钉住）。
 */
const RUN_ENTRY_GROUP_OVERRIDES: Readonly<Record<string, string>> = {
  'dispatch.run': 'runs'
};

/** 是否九域 run 单入口名（`X.run` 信封；动作枚举在入口 schema，动词真源在域内工具） */
export function isRunEntryName(toolName: string): boolean {
  return toolName.endsWith('.run');
}

/**
 * catalog 工具名 → 组名（无点号的裸名自成一组，如 intent；九域 run 入口归入其域组，
 * 改名入口按 RUN_ENTRY_GROUP_OVERRIDES，如 dispatch.run → runs）。
 */
export function catalogGroupOf(toolName: string): string {
  const overridden = RUN_ENTRY_GROUP_OVERRIDES[toolName];
  if (overridden) return overridden;
  const dot = toolName.indexOf('.');
  return dot === -1 ? toolName : toolName.slice(0, dot);
}

/** 该工具定义在给定隐藏面下是否应隐藏（组命中或定点命中） */
export function isToolDefHidden(def: { name: string }, hidden: TurnHiddenTools): boolean {
  if (hidden.groups.length === 0 && hidden.tools.length === 0) return false;
  if (hidden.tools.includes(def.name)) return true;
  const group = catalogGroupOf(def.name);
  if (hidden.groups.includes(group)) return true;
  // 九域 run 入口（X.run 信封）把域内全部动词复活为 action——隐藏面只要裁到本域
  // 任一定点工具（读写混合组「保读藏写」的动词级裁剪）或整组，入口就必须整体隐藏：
  // 注册面无法按 action 拆分，保住入口等于把被裁动词重新放出来。副作用是该域读面
  // （workflow.list/get/validate 等）随之不可达，按需另设只读入口再放。
  if (isRunEntryName(def.name)) {
    return hidden.tools.some((name) => catalogGroupOf(name) === group);
  }
  return false;
}

/**
 * 展开隐藏面为具体 catalog 工具名列表（组名展开成组内全部工具 + 定点名单，去重）。
 * piProvider 用它把组级隐藏展开成 pi createAgentSession 的 excludeTools 名单。
 */
export function hiddenToolNames(
  defs: ReadonlyArray<{ name: string }>,
  hidden: TurnHiddenTools
): string[] {
  const out = new Set<string>();
  for (const def of defs) {
    if (isToolDefHidden(def, hidden)) out.add(def.name);
  }
  return [...out];
}
