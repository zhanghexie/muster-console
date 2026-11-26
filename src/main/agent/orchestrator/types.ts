/**
 * 调度 Orchestrator 的桶/队列数据类型与模块级常量。
 * （自 orchestrator.ts 按调度职责拆分：类型仅搬家，字段与语义逐字保留。）
 */
import type { AgentMode, ChatImageAttachment, ChatMessage } from '../../../shared/types';
import type { PiSessionHandle } from '../../../shared/piEvents';
import type { CompactBreakerState } from '../../../shared/compactBreaker';
import type { SchedulerSessionAdapter } from '../../runtimeKernel/schedulerSession';

/** busy 时新消息入队等待自动续发；超过上限则拒绝并通知 */
export const MAX_AGENT_QUEUE = 8;

/** 调度转录索引去抖窗（回合 settle 后合并批量索引；B5 §4） */
export const TRANSCRIPT_INDEX_DEBOUNCE_MS = 2_000;

export function normalizeAgentMode(v: unknown): AgentMode {
  return v === 'ask' || v === 'plan' ? v : 'default';
}

export interface QueuedTurn {
  /** 对应 display 里的用户消息 id（撤回时按 id 删除） */
  id: string;
  text: string;
  images?: ChatImageAttachment[];
  /** host 自治回合标记（B3 直写门：续发回合同样不建用户消息证据面） */
  host?: boolean;
  /** Recorded at acceptance; absent for restored or host messages. */
  desktopInstructionId?: string;
}

export interface PendingDesktopSteer {
  id: string;
  text: string;
  serial: number;
  session: PiSessionHandle;
  accepted: boolean;
  consumed: boolean;
}

export interface WsAgentBucket {
  /** Append-only scheduler history adapter; display is its current live projection. */
  schedulerSession?: SchedulerSessionAdapter;
  display: ChatMessage[];
  api: unknown[];
  piSession: PiSessionHandle | null;
  /**
   * 当前回合流式 assistant 占位的引用：startTurn/retry 置位、收口 finally 清空、
   * 插话切分（queueOps.sendNow）换新。piProvider 经 getAssistant 间接层取它落
   * delta/终态章，切分后输出进新占位（与 GUI 会话 splitSteeredTurn 同语义）。
   * 纯内存，不持久化。
   */
  streamingAssistant?: ChatMessage;
  /** Prevent desktop interjections from sharing the output of an IM-owned turn. */
  workbenchRemoteAssistantId?: string;
  /** 当前绑定的 Pi 会话文件；装载历史会话后置位，send 优先 open 它续聊 */
  piSessionFile?: string;
  busy: boolean;
  /** Host-owned desktop turn, never supplied by model/tool arguments. */
  desktopTurnId?: string;
  desktopExecution?: object;
  desktopSteerSerial?: number;
  desktopSteersInFlight?: number;
  desktopPendingSteers?: PendingDesktopSteer[];
  /** 下一次 send 时 SessionManager.create（由 clearHistory 置位） */
  resetPiOnNextSend: boolean;
  /** busy 期间发送的消息排队；回合正常结束后自动出队续发 */
  queue: QueuedTurn[];
  /** Agent 模式（default/ask/plan），持久化到 agent-modes.json */
  mode: AgentMode;
  /** 会话级覆盖服务商 */
  providerId?: string;
  /** 会话级覆盖模型 */
  modelId?: string;
  /** 工作区级思考档（未设=跟随默认） */
  thinkingLevel?: string;
  /**
   * O8 自治回合闸：本区当前回合链持有的槽 token（host 入口开回合时占槽，链收口释放；
   * 人链/无闸直通时 undefined）。busy 期间排队消息续发的链沿用同一 token（自治链=一槽）。
   */
  gateToken?: string;
  /**
   * R-12 调度记忆注入标记：true=下个回合前把 scheduler/MEMORY.md + SITUATION.md
   * 作为回合前缀注入（桶建立 / clearHistory / compact 后置位，注入即清除——
   * 同一会话内存态内幂等；标记纯内存，重启后视为未注入）。
   */
  memoryInjectionDue: boolean;
  /**
   * 最近一次调度记忆前缀的 versionToken（B5 §7 逐回合刷新）：文件未变跳过重注入
   * （前缀已在上下文）；变化（写入/外部编辑/翻日）才重新注入并更新 token。
   */
  memoryInjectionVersion?: string;
  /**
   * B1 微压缩（idle 触发）：最近一次 assistant 回合完成时间。事件唤醒/人回来时
   * 距今超过 idle 阈值先试微压缩再进回合（长空闲时 prompt cache 本就过期，清理
   * 零缓存代价）。纯内存：重启后无值，首轮不触发（下回合收口起记时）。
   */
  lastTurnCompletedAt?: number;
  /**
   * C1 date-change：上次注入日期提醒的日期键（YYYY-MM-DD，本地时区）。无值（新
   * 桶/重启）= 首次锚定注入一行；此后跨自然日才再注入。纯内存即可（重启
   * 重新锚定一次，代价一行前缀，符合最小侵入存储惯例——桶持久化只落 display/api/文件指针）。
   */
  lastTurnDateKey?: string;
  /**
   * B2 双熔断状态机（rapid-refill + 连续失败）：自动压缩链的会话级内存态。
   * 喂线：回合收口 feedBreakerTurnCompleted；自动压缩前后 beginAutoCompactAttempt /
   * recordAutoCompactOutcome；手动 /compact 成功 recordManualCompactSuccess（恢复）；
   * 会话重建（clearHistory/切换/分叉）resetCompactBreaker。纯内存：重启复位
   * 可接受（最坏多压缩一次，不会漏压缩——与 C1 同惯例）。
   */
  compactBreaker: CompactBreakerState;
  /**
   * B3 transcript 快照指针：compact 前快照成功的盘上路径，下一回合前缀注入
   * 「完整历史快照已存 <路径>」后清除（一次性）。会话切换/清空时随指针失效清除。
   */
  transcriptPointer?: string;
}
