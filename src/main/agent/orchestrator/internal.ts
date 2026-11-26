/**
 * Orchestrator 门面与 orchestrator/* 职责模块之间的内部协作面。
 * （拆分约定：门面类 implements OrchestratorHost；职责模块只经由该接口
 * 触达桶表/事件/持久化等共享状态，不反向 import 门面，避免运行时环。）
 */
import type { AppContext } from '../../context';
import type {
  AgentContextStatus,
  AgentMode,
  ChatImageAttachment,
  ChatMessage
} from '../../../shared/types';
import type { PiCompactResult } from '../../../shared/piEvents';
import type { CompactBreakerTripReason } from '../../../shared/compactBreaker';
import type { OrchestratorAskOutcome, OrchestratorHumanWait } from '../../../shared/orchestratorAskQuestion';
import type { TurnGate, TurnGateQueue } from '../../../shared/turnGate';
import type { HostNotificationDelivery } from '../../../shared/hostNotification';
import type { AgentModelSelection } from '../agentModelSelection';
import type { WsAgentBucket } from './types';
import { randomUUID } from 'node:crypto';

export interface SchedulerSendOptions {
  host?: boolean;
  gateToken?: string;
  requireIdle?: boolean;
  schedulerWake?: true;
  beforeStart?: () => boolean;
  onAccepted?: () => void;
  messageId?: string;
  desktopInstructionNoted?: boolean;
  onSkipped?: (error?: unknown) => void;
  notification?: HostNotificationDelivery;
  workbenchRemote?: SchedulerWorkbenchRemoteTurn;
}

/** Trusted in-process IM submission. No transport identities enter the scheduler. */
export interface SchedulerWorkbenchRemoteTurn {
  assistantId: string;
  signal: AbortSignal;
  settle(message: ChatMessage | undefined): void;
}

/** Begin/end are synchronous so callers cannot borrow a later turn across an await. */
export function endSchedulerDesktopTurn(o: OrchestratorHost, bucket: WsAgentBucket, wsId: string): void {
  const id = bucket.desktopTurnId;
  if (!id) return;
  bucket.desktopTurnId = undefined;
  o.ctx?.desktopTurns?.().end(`orchestrator:${wsId}`, id);
}

export function beginSchedulerDesktopTurn(o: OrchestratorHost, bucket: WsAgentBucket, wsId: string, instructionId?: string,
  continuation?: import('../../../shared/hostNotification').HostDesktopContinuation): void {
  const turns = o.ctx?.desktopTurns?.();
  if (!turns) return;
  endSchedulerDesktopTurn(o, bucket, wsId);
  const id = randomUUID();
  bucket.desktopTurnId = id;
  try {
    turns.begin(`orchestrator:${wsId}`, id, () => bucket.busy && bucket.desktopTurnId === id, !!instructionId, instructionId,
      { workspaceId: wsId, ...(continuation ? { continuation } : {}) });
  } catch (error) {
    if (bucket.desktopTurnId === id) bucket.desktopTurnId = undefined;
    throw error;
  }
}

/** Activate only after the engine has both accepted and consumed this steer. */
export function activateSchedulerDesktopSteer(o: OrchestratorHost, bucket: WsAgentBucket, wsId: string): void {
  const pending = bucket.desktopPendingSteers ?? [];
  const latest = pending.find(item => item.serial === bucket.desktopSteerSerial);
  if (!latest || !latest.accepted || !latest.consumed || bucket.desktopSteersInFlight ||
      !bucket.busy || bucket.piSession !== latest.session || pending.some(item => item.serial < latest.serial && !item.consumed)) return;
  beginSchedulerDesktopTurn(o, bucket, wsId, latest.id);
  bucket.desktopPendingSteers = [];
}

/** Match a consumed native user message conservatively; transformed input fails closed. */
export function observeSchedulerDesktopSteer(o: OrchestratorHost, bucket: WsAgentBucket, wsId: string, event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const e = event as { type?: unknown; message?: { role?: unknown; content?: unknown } };
  if (e.type !== 'message_start' || e.message?.role !== 'user') return;
  const content = e.message.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) && content.length === 1 &&
    content[0]?.type === 'text' && typeof content[0]?.text === 'string' ? content[0].text : undefined;
  if (text === undefined) return;
  const item = bucket.desktopPendingSteers?.find(candidate => !candidate.consumed && candidate.session === bucket.piSession && candidate.text === text);
  if (!item) return;
  item.consumed = true;
  if (item.serial === bucket.desktopSteerSerial) activateSchedulerDesktopSteer(o, bucket, wsId);
}

/** 每 ws 挂起的 askQuestion（工具等用户作答） */
export interface PendingAsk {
  questionId: string;
  since: number;
  resolve: (o: OrchestratorAskOutcome) => void;
}

export interface OrchestratorHost {
  readonly ctx: AppContext;
  /** 每工作区独立对话桶 */
  readonly buckets: Map<string, WsAgentBucket>;
  /** UI / getHistory / send 默认落点 */
  workspaceId: string;
  /** 每 ws 的 Agent 模式（agent-modes.json 持久化） */
  readonly modes: Record<string, AgentMode>;
  /** 每 ws 的调度对话模型选择（agent-models.json 持久化） */
  readonly models: Record<string, AgentModelSelection>;
  /** 每 ws 的调度思考档（agent-thinking.json 持久化；未写入=跟随默认） */
  readonly thinkings: Record<string, string>;
  /** 每 ws 的回合级自动重试定时器（瞬态失败后延时重发；stop() 可取消待触发的） */
  readonly autoRetryTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** 每 ws 连续瞬态失败的已自动重试次数（任一回合成功即清零） */
  readonly autoRetryAttempts: Map<string, number>;
  /** 每 ws 挂起的 askQuestion */
  readonly pendingAsks: Map<string, PendingAsk>;
  /** O8 全局自治回合闸（跨工作区 token 槽信号量 + 租约回收） */
  readonly turnGate: TurnGate;
  /** 闸满暂存 + 释放即 drain 的投递缓冲 */
  readonly gateQueue: TurnGateQueue;
  /** 事件监听器表（主进程内订阅，见 orchestrator/eventBus.ts） */
  readonly eventListeners: Set<(channel: string, payload: unknown) => void>;

  ensureBucket(workspaceId: string): WsAgentBucket;
  persistBucket(workspaceId: string): void;
  emit(channel: string, payload: unknown): void;
  emitContextStatus(workspaceId: string): void;
  getContextStatus(workspaceId?: string): AgentContextStatus;
  getThinkingLevel(workspaceId?: string): string | null;
  isBusy(workspaceId: string): boolean;
  schedulerModelFor(workspaceId: string): { providerId?: string; modelId?: string };
  invalidatePiSession(workspaceId?: string): void;
  abortPendingAsk(wsId: string): void;
  getHumanWait(workspaceId?: string): OrchestratorHumanWait | null;
  checkSendImages(
    workspaceId?: string,
    images?: ChatImageAttachment[]
  ): { ok: true } | { ok: false; error: string };
  send(
    text: string,
    workspaceId?: string,
    images?: ChatImageAttachment[],
    opts?: SchedulerSendOptions
  ): Promise<void>;
  startTurn(
    bucket: WsAgentBucket,
    wsId: string,
    text: string,
    images?: ChatImageAttachment[],
    host?: boolean,
    notification?: import('../../../shared/hostNotification').HostNotificationDelivery,
    desktopInstructionId?: string,
    causationId?: string,
    workbenchRemote?: SchedulerWorkbenchRemoteTurn
  ): Promise<void>;
  retry(workspaceId?: string): { accepted: boolean; error?: string };
  recallAborted(
    workspaceId?: string,
    messageId?: string
  ): { ok: boolean; text?: string; images?: ChatImageAttachment[]; error?: string };
  compactSession(
    workspaceId?: string,
    instructions?: string,
    opts?: { source?: 'manual' | 'auto' }
  ): Promise<PiCompactResult>;
  drainQueue(bucket: WsAgentBucket, wsId: string): Promise<void>;
  scheduleTurnAutoRetry(wsId: string, failedMsg: ChatMessage, delayMs: number): void;
  maybeAutoCompact(wsId: string): void;
  maybeIdleMicrocompact(wsId: string): Promise<void>;
  signalCompactBreakerTripped(wsId: string, reason: CompactBreakerTripReason): void;
  clearHistory(workspaceId?: string): void;
}
