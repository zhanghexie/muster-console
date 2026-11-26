/**
 * AgentSessionHost 内部状态合同（host.ts 拆分的共享类型层）：
 * SessionEntry 是每会话的全部可变状态；HostCore 是宿主实例暴露给各拆分模块的字段面
 * （各模块函数以 `host: HostCore` 首参接收宿主实例，只读写这里列出的字段）。
 */
import type { AppContext } from '../../context';
import type { SessionMeta } from '../../../shared/types';
import type { GuiThinkingLevel, GuiWorkerMode } from '../../../shared/types';
import type { ModeController } from '../../agent/providers/modeExtension';
import type {
  GuiApprovalDecision,
  GuiRuntimeConnection,
  GuiRuntimeDriver,
  GuiSendImage,
  GuiUserQuestionOutcome
} from '../types';
import type {
  GuiChatMessage,
  GuiCompactionRecord,
  GuiInjectionSnapshot,
  GuiWorkerPush
} from '../../../shared/guiWorker';
import type { GuiLastUsage } from '../../../shared/guiContextUsage';
import type { GuiSessionStore } from '../persist';
import type { GuiSessionToolset } from '../tools/registry';
import type { WorkspaceExecutionContext } from '../../../shared/workspaceExecutionContext';

/** 与调度 Orchestrator 对齐的排队上限 */
export const MAX_QUEUE = 8;

/** fork transcript 前缀的长度上限（无种子回放能力的引擎降级用） */
export const FORK_TRANSCRIPT_MAX = 80_000;

/** 旧数据迁移：只有 permissionMode 没有 guiMode 的会话。
 *  acceptEdits 必须显式迁 default——不能掉进 fallback，否则升级后旧会话会变成 auto（权限静默升级）。 */
export function migrateMode(session: SessionMeta, fallback: GuiWorkerMode): GuiWorkerMode {
  if (session.guiMode) return session.guiMode;
  switch (session.permissionMode) {
    case 'ask':
      return 'ask';
    case 'auto':
      return 'auto';
    case 'acceptEdits':
      return 'default';
    default:
      return fallback;
  }
}

/** The Cursor ACP menu omits full access, so its implicit mode must be visible. */
export function initialGuiWorkerMode(session: SessionMeta): GuiWorkerMode {
  if (session.runtime !== 'pi') return 'default';
  return session.configurePermissions === true ? migrateMode(session, 'default') : 'auto';
}

export interface QueuedItem {
  messageId: string;
  text: string;
  images?: GuiSendImage[];
  /** 宿主催办及历史调度来源；用户手打排队不标 */
  fromInject?: boolean;
}

export interface ActiveApproval {
  approvalId: string;
  toolCallId: string;
  nativeChoices?: import('../../../shared/nativeSessionConfig').NativeApprovalChoice[];
  isCurrent?: () => boolean;
  resolve: (d: GuiApprovalDecision) => void;
}

export interface ActiveSubagentApproval {
  cardId: string;
  sessionId: string;
  nativeChoices?: ActiveApproval['nativeChoices'];
  isCurrent: () => boolean;
  resolve: ActiveApproval['resolve'];
}

export interface ActiveUserQuestion {
  questionId: string;
  resolve: (r: GuiUserQuestionOutcome) => void;
}

export interface SessionEntry {
  nativeConfig?: import('../../../shared/nativeSessionConfig').NativeConfigSnapshot;
  nativeConfigIdentity?: import('../../../shared/nativeSessionConfig').NativeConfigIdentity;
  nativeConfigPending?: boolean;
  permissionStrategySwitch?: boolean;
  assignmentDelivery?: { executionTurnId: string; userMessageId?: string; handle: import('../../messages/assignment').InitialAssignmentDelivery };
  workerSwitch?: symbol;
  workerSwitchAbort?: AbortController;
  workerRouteHandoff?: string;
  activeWorkerHostTools?: number;
  openWorkerNativeTools?: Set<string>;
  sessionId: string;
  runtimeId: string;
  cwd: string;
  workspaceId?: string;
  worktreePath?: string;
  /** 会话模式（default/ask/plan/auto，与调度同源）；派生权限走 derivePermissionMode */
  mode: GuiWorkerMode;
  /** 会话级思考档（Pi；缺省=跟随默认。每回合热读，切档即时生效不重连） */
  thinkingLevel: GuiThinkingLevel | null;
  /** Frozen at turn start; session edits during a busy turn affect the next turn only. */
  turnModelParameters?: import('./modelParameters').TurnModelParameterSnapshot;
  /** plan 批准执行中（门控解除、权限恢复 acceptEdits） */
  planExecuting: boolean;
  /** C2 计划门：批准回灌文本（下一回合 startTurn 前缀注入，取走即清；内存态不落盘） */
  planApprovedFeedback: string | null;
  /** C2 计划门：批准生效的 allowedPrompts 预授权清单（会话级，decideToolCallPermission 消费） */
  planAllowedPrompts: string[];
  /** 每会话一个模式控制器（Pi 挂扩展：工具禁用/bash 白名单/回合提示，切档即时生效） */
  modeController: ModeController;
  /** 计划卡挂在哪条消息上（进度原地更新） */
  planMessageId: string | null;
  /** 连接建立时的 provider/model 快照（切模型检测用） */
  connectionModelKey: string | null;
  connectionWorkspaceKey?: string;
  hostIntroDelivery?: import('../persist').GuiHostIntroDelivery;
  pendingHostIntro?: { context: string; assistantMessageId?: string };
  connectionAdmissionModel?: import('../modelAdmissionPolicy').AdmissionModel;
  turnWorkspaceContext?: WorkspaceExecutionContext;
  releaseWorkspaceContext?: () => void;
  messages: GuiChatMessage[];
  /** Serializes a user-requested native fork against new sends. */
  forking?: boolean;
  pendingSends?: number;
  /** Native message admission may still be unresolved when a turn completes. */
  nativeDeliveryInFlight?: number;
  busy: boolean;
  execution?: import('../../../shared/executionLifecycle').ExecutionLifecycle;
  abortRequested: boolean;
  abortError?: string;
  abortPreparing?: boolean;
  setupStop?: Promise<void>;
  holdQueueAfterTurn?: boolean;
  queue: QueuedItem[];
  /** Harness 透明·连接级注入快照信封（重连换代追加；随消息一并落盘） */
  injections: GuiInjectionSnapshot[];
  /** Harness 透明·逐轮注入段已知文本（injection-update 报到；连接快照合并它防换代丢失） */
  injectionUpdates: Map<string, string>;
  /** Harness 透明·压缩记录信封（已完成；账本退役后的持久化替代源） */
  compactions: GuiCompactionRecord[];
  /** 压缩标记序号（running/complete 推送的 markerId；跨连接单调） */
  compactionSeq: number;
  /** 进行中的压缩（同一时刻至多一个；willRetry 保持打开） */
  openCompaction: { markerId: string; at: number } | null;
  /** 最近收口的压缩 markerId（compact 结果补写规模时定位） */
  lastClosedCompaction: string | null;
  /** 本回合已同步落过的插话文本（driver steering 事件到达时按文本去重，防双落；
   *  短队列——连续两次不同文本的可见插话在事件泵消费前的窗口内各自可命中） */
  lastSteeredTexts: string[];
  connection: GuiRuntimeConnection | null;
  connecting: Promise<GuiRuntimeConnection> | null;
  activeApproval: ActiveApproval | null;
  activeUserQuestion: ActiveUserQuestion | null;
  assistant: GuiChatMessage | null;
  toolset: GuiSessionToolset | null;
  /** ACP AvailableCommands → 斜杠菜单（内存；不落盘） */
  slashCommands: Array<{ name: string; description?: string; inputHint?: string }>;
  /** ACP CurrentMode */
  engineMode: { modeId: string; name?: string } | null;
  /** fork 首连种子（引擎原生消息回放；连接成功后一次性消费） */
  forkSeed: import('../forkContextSpool').ForkContextSpool | null;
  /** fork transcript 前缀（无种子回放能力的引擎：首轮 prompt 前置；一次性消费） */
  forkTranscript: string | null;
  forkTranscriptSource: import('../forkContextSpool').ForkContextSpool | null;
  /** Durable fork prefix delivery state; unknown blocks automatic resends. */
  forkDeliveryState?: 'pending' | 'sending' | 'unknown';
  forkPendingError?: string;
  /** Keep delivered-fork resume identity durable independently of the session table. */
  forkResumeGuard?: boolean;
  /** A guarded turn may still change its native identity until it has settled. */
  forkGuardInFlight?: boolean;
  /** Expected identity during first transcript delivery or a guarded operation. */
  forkGuardToken?: string;
  /** Owner of a completed turn waiting for its strict history commit. */
  forkSettlement?: symbol;
  /** Identifies the owner of an asynchronous manual or automatic compaction. */
  compactOperation?: symbol;
  /** clear() 进行中：finishTurn 不派发队列、startTurn 不开新回合（清空竞态收口） */
  clearing: boolean;
  closed: boolean;
  /** 本回合 startTurn 时刻（P5：回合开始 N 秒内 needs_you 要带 reason） */
  turnStartedAt?: number;
  /**
   * O6：当前回合开始时刻（busy=true→记、收口→清；区别于 P5 的 turnStartedAt——
   * 那个是「最近一次回合开始」，收口不清）。sessions.observe 的 activeTurnMs 据此算。
   */
  activeTurnStartedAt?: number;
  /** Stable engine execution identity, even when steering splits a visible assistant message. */
  activeExecutionTurnId?: string;
  memoryAuthority?: ReturnType<typeof import('../../agent/turnScope').createPromptAuthorityScope>;
  preparedBgDigest?: { turnId: string; prepared: import('../background/manager').PreparedBgDigest };
  /** Changes on each accepted user instruction, including steering within one engine turn. */
  activeDesktopTurnId?: string;
  /** 本回合已安排的网络续作次数（成功收口清零） */
  turnRetryAttempt: number;
  turnRetryTimer: ReturnType<typeof setTimeout> | null;
  /** 本回合原始用户输入（无进度时重发；续作提示不带图）及对应的转写消息。 */
  lastTurnInput: { text: string; images?: GuiSendImage[]; userText?: string; userMessageId?: string; assistantMessageId: string; literalText?: boolean } | null;
  /** 本回合最终发进引擎的完整文本（skill 展开/fork 前缀/digest 之后）：网络续作重发用存档 */
  lastSentPayload: string | null;
  /** 最后已知上下文用量（落盘；重启后连接未建时回落） */
  lastUsage: GuiLastUsage | null;
  /** A newly selected model must not inherit the previous model's window. */
  pendingUsageModelKey?: string;
  /**
   * fork 种子刚回放完：resume-token 上的 getContextUsage 可能是占位 0，
   * 要等到本会话第一次真实回合收口才允许写入 lastUsage。
   */
  skipUsagePersistUntilTurn: boolean;
}

/** 宿主实例暴露给拆分模块的字段面（原 AgentSessionHost 的私有字段，拆分后放宽为 readonly 公开） */
export interface HostCore {
  readonly semanticRoot?: string;
  readonly ctx: AppContext;
  readonly openedSessionIds: Set<string>;
  readonly entries: Map<string, SessionEntry>;
  readonly drivers: { get(runtimeId: string): GuiRuntimeDriver | undefined; values(): IterableIterator<GuiRuntimeDriver> };
  readonly store: GuiSessionStore;
  readonly modelAdmission: import('../harnessModelAdmission').HarnessModelAdmission;
  /** 后台子代理审批冒泡（approvalId → 卡片消息与应答；不占父会话 activeApproval 槽） */
  readonly subagentApprovals: Map<
    string,
    ActiveSubagentApproval
  >;
  /** 主进程侧推送订阅（渲染层 webContents 之外的口子；飞书回流用） */
  readonly pushSubs: Set<(payload: GuiWorkerPush) => void>;
  /** 流式正文节流落盘（回合中崩溃的丢失窗口从「整回合」压到 2s） */
  readonly streamPersistTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** 每连接只挂一个事件泵（error 后连接复用时防双泵瓜分事件） */
  readonly pumpedConns: WeakSet<GuiRuntimeConnection>;
}
