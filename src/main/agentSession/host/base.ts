/**
 * AgentSessionHost 横切底层：推送、日志、转写同步/落盘、看板活动信号、
 * 注入队列胶囊联动与用量元数据落盘节流。被其余 host/* 模块共用。
 */
import type { GuiChatMessage, GuiWorkerPush } from '../../../shared/guiWorker';
import { countInjectQueued } from '../../../shared/injectQueue';
import type { GuiDriverConnectInput, GuiRuntimeDriver, GuiRuntimeProbeResult } from '../types';
import type { HostCore, SessionEntry } from './internal';
import { t } from '../../../shared/i18n';
import { advanceGuiLiveSequence, advanceGuiMessagesVersion, guiMessagesVersion } from './messagesVersion';
import { guiReplyLine } from '../../../shared/boardReplyPreview';

const GUI_SYNC_TAIL_SIZE = 120;

export function getDriver(host: HostCore, runtimeId: string): GuiRuntimeDriver | undefined {
  return host.drivers.get(runtimeId);
}

/** chat runtime 可用性预检：交给 driver.probe（未实现按 unknown；异常不打断批量预检） */
export async function probeRuntime(
  host: HostCore,
  runtimeId: string,
  piModeId?: string,
  modelOverride?: GuiDriverConnectInput['modelOverride']
): Promise<GuiRuntimeProbeResult> {
  const driver = getDriver(host, runtimeId);
  if (!driver) {
    return {
      status: 'unknown',
      problems: [
        {
          code: 'error',
          message: t('GUI runtime「{{id}}」的 driver 未注册（应用初始化异常）', { id: runtimeId })
        }
      ]
    };
  }
  if (typeof driver.probe !== 'function') return { status: 'unknown', problems: [] };
  try {
    return await driver.probe({ ...(piModeId ? { piModeId } : {}), ...(modelOverride ? { modelOverride } : {}) });
  } catch (e) {
    return {
      status: 'unknown',
      problems: [
        { code: 'error', message: t('预检异常：{{message}}', { message: (e as Error).message }) }
      ]
    };
  }
}

export function push(host: HostCore, payload: GuiWorkerPush): void {
  const isMessageEvent = payload.kind === 'sync' || payload.kind === 'delta' || payload.kind === 'part';
  // Only message events advance the live cursor. Execution, usage and metadata
  // pushes must not create false gaps for a renderer that is recovering ranges.
  const entry = host.entries.get(payload.sessionId);
  if (entry && !entry.closed && !entry.clearing) {
    // Accept the durable event before publishing the corresponding live event.
    if (payload.kind === 'delta') host.store.recordDelta(payload.sessionId, payload.messageId, payload.deltaKind, payload.delta);
    else if (payload.kind === 'part' && payload.part.kind === 'tool') host.store.recordToolPart(payload.sessionId, payload.messageId, payload.part);
  }
  const enriched = entry
    ? (() => {
        // Any push can follow a mutation to the live entry (metadata pushes are
        // emitted alongside message edits and may be delivered with no window).
        // Advance the validator before broadcasting so a later cold read cannot
        // incorrectly reuse a pre-push messagesVersion.
        advanceGuiMessagesVersion(entry);
        if (!isMessageEvent) return payload;
        const liveSeq = advanceGuiLiveSequence(entry);
        return { ...payload, messagesVersion: guiMessagesVersion(entry), liveSeq };
      })()
    : payload;
  try {
    host.ctx.getWindow()?.webContents.send('agentSession:event', enriched);
  } catch {
    /* 窗口可能已销毁 */
  }
  // 辅助应用窗口（扩展独立窗口）里的 AI 侧栏共用同一会话流。
  try {
    host.ctx.sendToAuxiliaryRenderers('agentSession:event', enriched);
  } catch {
    /* 同上 */
  }
  for (const cb of host.pushSubs) {
    try {
      cb(enriched);
    } catch (e) {
      console.error('[agentSession] push subscriber failed', e);
    }
  }
}

export function log(host: HostCore, entry: SessionEntry, level: 'info' | 'warn' | 'error', msg: string): void {
  const tag = `[agentSession:${entry.runtimeId}]`;
  if (level === 'error') console.error(tag, msg);
  else if (level === 'warn') console.warn(tag, msg);
  else console.log(tag, msg);
}

/**
 * 原生输入排队条数变化同步到会话胶囊。
 * pending 不变则静默（用户手打排队不吵醒调度）。
 */
export function applyInjectQueueChange(
  host: HostCore,
  entry: SessionEntry
): void {
  const pending = countInjectQueued(entry.queue);
  const prev = host.ctx.sessions.get(entry.sessionId)?.queuedInjects ?? 0;
  if (pending === prev) return;
  host.ctx.sessions.setQueuedInjects?.(entry.sessionId, pending);

}

export function syncEntry(host: HostCore, entry: SessionEntry): void {
  const start = Math.max(0, entry.messages.length - GUI_SYNC_TAIL_SIZE);
  push(host, {
    kind: 'sync',
    sessionId: entry.sessionId,
    messages: entry.messages.slice(start),
    before: start,
    total: entry.messages.length,
    hasEarlier: start > 0
  });
}

/**
 * 单个 part 落定（工具卡新增/出结果）：只推那一个 part，不推全量 messages。
 *
 * 全量 sync 在工具密集回合里很贵——真机一条 assistant 消息可到 2.93MB（277 个
 * 工具卡、工具输出 2.29MB），每个工具的 start/result 各推一次 = 一个回合 554 次
 * 全量，实测渲染层固定开销 3.39ms/次（主进程另有同量克隆）。part 粒度把每次的
 * payload 压到一个工具卡。消息级变化（计划卡、审批、排队、错误）仍走全量 sync。
 */
export function syncPart(host: HostCore, entry: SessionEntry, msg: GuiChatMessage, partIndex: number): void {
  const part = msg.parts[partIndex];
  if (!part) {
    // 下标对不上时先记录完整目标消息，再发布尾部投影。
    persistEntry(host, entry, [msg]);
    syncEntry(host, entry);
    return;
  }
  push(host, {
    kind: 'part',
    sessionId: entry.sessionId,
    messageId: msg.id,
    partIndex,
    part
  });
}

export function persistEntry(host: HostCore, entry: SessionEntry, changes: readonly (GuiChatMessage | null | undefined)[] | 'replace'): void {
  // Clear owns a durable tombstone and deletes this file after draining prior
  // writes. Late events must not schedule a new history write behind it.
  if (entry.clearing) return;
  // A retired entry can still receive a late driver callback after close has
  // removed it from the host. Do not resurrect its event log or checkpoint.
  if (entry.closed && host.entries.get(entry.sessionId) !== entry) return;
  host.ctx?.sessions?.setBoardReplyPreview?.(entry.sessionId, guiReplyLine(entry.messages));
  // Also cover message edits persisted without a UI push (for example hidden lifecycle work).
  advanceGuiMessagesVersion(entry);
  host.store.save(entry.sessionId, changes === 'replace' ? entry.messages : changes.filter((message): message is GuiChatMessage => !!message),
    entry.lastUsage, changes==='replace'?entry.injections:undefined, changes==='replace'?entry.compactions:undefined, changes !== 'replace');
}

export function applySignal(
  host: HostCore,
  entry: SessionEntry,
  kind: 'active' | 'idle' | 'blocked',
  event: string
): void {
  host.ctx.sessions.applyActivitySignal(entry.sessionId, kind, event);
}

/** 用量元数据节流落盘：正文/工具由事件日志直接受理，不再周期性复制整条 assistant。 */
export function scheduleStreamingPersist(host: HostCore, entry: SessionEntry): void {
  if (host.streamPersistTimers.has(entry.sessionId)) return;
  const timer = setTimeout(() => {
    host.streamPersistTimers.delete(entry.sessionId);
    if (host.entries.get(entry.sessionId) === entry && !entry.closed) {
      persistEntry(host, entry, []);
    }
  }, 2000);
  timer.unref?.();
  host.streamPersistTimers.set(entry.sessionId, timer);
}

export function cancelStreamingPersist(host: HostCore, sessionId: string): void {
  const timer = host.streamPersistTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    host.streamPersistTimers.delete(sessionId);
  }
}
