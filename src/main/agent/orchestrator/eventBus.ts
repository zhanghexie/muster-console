import { applySchedulerDisplayEdit, type SchedulerDisplayEdit } from '../../runtimeKernel/schedulerSession';
/**
 * 调度事件泵：主进程内订阅（onEvent）与渲染层推送（webContents.send）同源同序。
 * （自 orchestrator.ts 拆分；监听器表由门面持有，经 OrchestratorHost 触达。）
 */
import type { OrchestratorHost } from './internal';
import { CHAT_HISTORY_PAGE_SIZE } from '../../../shared/chatHistory';

const liveSequences = new WeakMap<OrchestratorHost, Map<string, number>>();

function sequenceFor(o: OrchestratorHost, payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const workspaceId = (payload as { workspaceId?: unknown }).workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId) return undefined;
  let byWorkspace = liveSequences.get(o);
  if (!byWorkspace) {
    byWorkspace = new Map();
    liveSequences.set(o, byWorkspace);
  }
  const next = (byWorkspace.get(workspaceId) ?? 0) + 1;
  byWorkspace.set(workspaceId, next);
  return next;
}

export function liveSequenceFor(o: OrchestratorHost, workspaceId: string): number | undefined {
  return liveSequences.get(o)?.get(workspaceId);
}

/**
 * Keep history publications bounded. Structural edits publish a tail page after
 * durable acceptance; subscribers use the supplied range metadata to fetch
 * older history rather than retaining a full broadcast copy.
 */
export function compactHistoryForRenderer(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const record = payload as {
    messages?: unknown;
    before?: unknown;
    total?: unknown;
    hasEarlier?: unknown;
  };
  if (!Array.isArray(record.messages)) return payload;
  if (
    Number.isSafeInteger(record.before) &&
    Number.isSafeInteger(record.total) &&
    typeof record.hasEarlier === 'boolean'
  ) return payload;
  const total = record.messages.length;
  const before = Math.max(0, total - CHAT_HISTORY_PAGE_SIZE);
  return {
    ...(payload as Record<string, unknown>),
    messages: record.messages.slice(before),
    before,
    total,
    hasEarlier: before > 0
  };
}

/** 事件泵（orchestrator/* 模块经 OrchestratorHost.emit 推送；勿在模块外直接调用） */
export function emit(o: OrchestratorHost, channel: string, payload: unknown): void {
  // Durable event acceptance precedes publication. A failed append must not
  // report a successful message to subscribers or the renderer.
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const bucket = typeof record.workspaceId === 'string' ? o.buckets?.get(record.workspaceId) : undefined;
    const session = bucket?.schedulerSession;
    if (session) {
      const insertionIndex = channel === 'agent:message' && typeof record.id === 'string' && !session.hasMessage(record.id)
        ? bucket.display.findIndex(message => message.id === record.id) : undefined;
      session.recordDisplayEvent(channel, record, o.ctx.config.get().liveThinkingOnly !== false,
        insertionIndex !== undefined && insertionIndex >= 0 ? insertionIndex : undefined);
    }
  }
  publish(o, channel, payload);
}

/** Accept a structural command before changing the live read model. */
export function commitDisplayEdit(o: OrchestratorHost, workspaceId: string, edit: SchedulerDisplayEdit, committed?: () => void): void {
  const bucket = o.ensureBucket(workspaceId);
  bucket.schedulerSession?.recordEdit(edit, o.ctx.config.get().liveThinkingOnly !== false);
  bucket.display = applySchedulerDisplayEdit(bucket.display, edit);
  if (bucket.streamingAssistant) bucket.streamingAssistant = bucket.display.find(message => message.id === bucket.streamingAssistant!.id);
  committed?.();
  publishCurrentHistory(o, workspaceId);
}

export function publishCurrentHistory(o: OrchestratorHost, workspaceId: string): void {
  const bucket = o.ensureBucket(workspaceId);
  const total = bucket.display.length, before = Math.max(0, total - CHAT_HISTORY_PAGE_SIZE);
  o.emit('agent:history', { workspaceId, messages: bucket.display.slice(before), total, before, hasEarlier: before > 0 });
}

/** Only explicit reset or native-session import may replace the full projection. */
export function replaceDisplay(o: OrchestratorHost, workspaceId: string, reason: 'reset' | 'native-import'): void {
  const bucket = o.ensureBucket(workspaceId);
  if (reason === 'reset' && bucket.display.length) throw new Error('Reset must have an empty transcript');
  bucket.schedulerSession?.persist({ display: bucket.display, api: bucket.api, piSessionFile: bucket.piSessionFile });
  publishCurrentHistory(o, workspaceId);
}

/** Browsing is a read, never a durable history replacement. */
export function publishHistoryRange(o: OrchestratorHost, workspaceId: string, page: import('../../../shared/chatSurface').ChatHistoryPage): void {
  publish(o, 'agent:history', { ...page, workspaceId });
}

function publish(o: OrchestratorHost, channel: string, payload: unknown): void {
  for (const cb of o.eventListeners) {
    try {
      cb(channel, payload);
    } catch (e) {
      console.error('[orchestrator] event listener failed', e);
    }
  }
  const rendererPayload = channel === 'agent:history' ? compactHistoryForRenderer(payload) : payload;
  const sequencedChannels = channel === 'agent:message' || channel === 'agent:token' ||
    channel === 'agent:thinking' || channel === 'agent:tool' || channel === 'agent:done' ||
    channel === 'agent:history';
  const eventSeq = sequencedChannels ? sequenceFor(o, rendererPayload) : undefined;
  const outgoing = eventSeq === undefined || !rendererPayload || typeof rendererPayload !== 'object'
    ? rendererPayload
    : { ...(rendererPayload as Record<string, unknown>), eventSeq };
  o.ctx.getWindow()?.webContents.send(channel, outgoing);
}

/**
 * 主进程内订阅 agent 事件（与渲染层推送同源同序）。
 * 主进程常驻服务用；回调抛错不影响渲染层推送。
 */
export function onEvent(
  o: OrchestratorHost,
  cb: (channel: string, payload: unknown) => void
): () => void {
  o.eventListeners.add(cb);
  return () => {
    o.eventListeners.delete(cb);
  };
}
