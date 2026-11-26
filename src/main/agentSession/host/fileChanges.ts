import type { HostCore, SessionEntry } from './internal';
import type { GuiChatMessage } from '../../../shared/guiWorker';
import type { ReportedFileChange, TurnChanges } from '../../../shared/turnChanges';
import { turnChanges } from '../../turnChanges/runtime';
import type { TurnChangeTracker } from '../../turnChanges/service';
import { reviewRootDirs } from '../../turnChanges/rootDirs';
import { nativeWritePaths } from '../../turnChanges/pathCapture';
import { persistEntry, syncEntry } from './base';

type TrackerState = { message: GuiChatMessage; tracker?: TurnChangeTracker; prepared?: Promise<void> };

const trackers = new WeakMap<SessionEntry, TrackerState>();
const ownsSnapshot = (host: HostCore, entry: SessionEntry, message: GuiChatMessage, id: string) =>
  host.entries.get(entry.sessionId) === entry && !entry.closed && entry.messages.includes(message) && message.turnChanges?.id === id;

/**
 * Register the turn's tracker synchronously — before the engine can send —
 * with its real snapshot ID on the message. File bodies are read only for
 * paths declared by tools or an explicit registration. Review is auxiliary.
 */
export function beginFileChanges(host: HostCore, entry: SessionEntry, message: GuiChatMessage): void {
  const roots = entry.turnWorkspaceContext?.writableDirectories.map(d => d.path) ?? [entry.cwd];
  const state: TrackerState = { message };
  trackers.set(entry, state);
  let tracker: TurnChangeTracker;
  try {
    tracker = turnChanges().begin(`gui:${entry.sessionId}`, message.id, entry.turnWorkspaceContext?.cwd ?? entry.cwd, roots, reviewRootDirs(entry.turnWorkspaceContext));
  } catch (error) {
    // Defensive only: begin() absorbs preparation failures itself.
    message.turnChanges = { id: '', state: 'error', files: [], warnings: [`文件审阅初始化失败：${String(error instanceof Error ? error.message : error)}`] };
    if (!entry.closed && entry.messages.includes(message)) { persistEntry(host, entry, [message]); syncEntry(host, entry); }
    return;
  }
  state.tracker = tracker;
  // The live summary (real snapshot ID, coverage warnings) is published
  // synchronously: collision publishing matches messages by this ID.
  message.turnChanges = { ...tracker.summary };
  if (entry.messages.includes(message)) { persistEntry(host, entry, [message]); syncEntry(host, entry); }
  // Late repository identity lands on the message only
  // while this turn still owns it.
  state.prepared = tracker.ready.then(() => {
    if (trackers.get(entry) !== state || !ownsSnapshot(host, entry, message, tracker.summary.id)) return;
    message.turnChanges = { ...tracker.summary };
    persistEntry(host, entry, [message]);
    syncEntry(host, entry);
  }).catch(error => console.error('[turn-changes] preparation settlement failed', error));
}

/** The tracker's repository identity as soon as it is read. */
export function liveTurnRepository(entry: SessionEntry): TurnChanges['repository'] {
  return trackers.get(entry)?.tracker?.summary.repository;
}

export function noteFileChangeStart(entry: SessionEntry, id: string, name: string, input: Record<string, unknown>, kind?: string, late = false): void {
  // Built-in Pi's worker owns an awaited write hook; the stream copy is not a
  // second observed write. Keep non-file events for coverage diagnostics.
  const paths = nativeWritePaths(name, input, kind);
  if (late) {
    if (paths.length || ['edit', 'delete', 'move'].includes(kind ?? ''))
      trackers.get(entry)?.tracker?.noteRootFailure('工具完成后才报告文件，部分改动可能未记录');
    return;
  }
  if (entry.runtimeId === 'pi' && paths.length) return;
  try { void trackers.get(entry)?.tracker?.toolStart(id, name, input, kind)?.catch(error => console.error('[turn-changes] tool start capture failed', error)); }
  catch (error) { console.error('[turn-changes] tool start capture failed', error); }
}
export function markFileChangeExecution(entry: SessionEntry): void {
  try { trackers.get(entry)?.tracker?.markExecutionStarted?.(); }
  catch (error) { console.error('[turn-changes] execution boundary failed', error); }
}
export function noteFileChangeEnd(entry: SessionEntry, id: string, ok: boolean, patch?: string, changes?: ReportedFileChange[]): void {
  try { void trackers.get(entry)?.tracker?.toolEnd(id, ok, patch, false, changes)?.catch(error => console.error('[turn-changes] tool end capture failed', error)); }
  catch (error) { console.error('[turn-changes] tool end capture failed', error); }
}
export function noteFileChangeWarning(entry: SessionEntry, message: string): void {
  try { trackers.get(entry)?.tracker?.noteRootFailure(message); }
  catch (error) { console.error('[turn-changes] coverage warning failed', error); }
}
export function finishFileChanges(host: HostCore, entry: SessionEntry, expectedMessage?: GuiChatMessage): void {
  const state = trackers.get(entry);
  if (!state || (expectedMessage && state.message !== expectedMessage)) return;
  trackers.delete(entry);
  const tracker = state.tracker;
  if (tracker && ownsSnapshot(host, entry, state.message, tracker.summary.id)) {
    state.message.turnChanges = { ...(state.message.turnChanges ?? { id: '', files: [], warnings: [] }), state: 'collecting', preparing: false, finalizing: true };
    persistEntry(host, entry, [state.message]); syncEntry(host, entry);
  }
  if (!tracker) return;
  void tracker.finish().then(summary => {
    // A clear/retry/close must never resurrect a removed message.
    if (!ownsSnapshot(host, entry, state.message, tracker.summary.id)) return;
    state.message.turnChanges = { ...summary };
    persistEntry(host, entry, [state.message]);
    syncEntry(host, entry);
    if (summary.state === 'ready' && summary.files.length) turnChanges().requestRetention?.(`gui:${entry.sessionId}`, { id: summary.id, messageId: state.message.id });
  }).catch(error => {
    console.error('[turn-changes] capture failed', error);
    if (!ownsSnapshot(host, entry, state.message, tracker.summary.id)) return;
    state.message.turnChanges = { id: tracker.summary.id, state: 'error', files: [], warnings: [`改动快照失败：${String(error)}`] };
    persistEntry(host, entry, [state.message]);
    syncEntry(host, entry);
  });
}
