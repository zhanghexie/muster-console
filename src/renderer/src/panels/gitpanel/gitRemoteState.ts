import { useCallback, useSyncExternalStore } from 'react';
import type { GitActionResult, GitRemoteCheck } from '../../../../shared/types';

export type RemoteKind = 'fetch' | 'pull' | 'push';
export type RemoteOperation = {
  kind: RemoteKind; branch: string; tracking: string | null; startedAt: number; automatic: boolean;
  finishedAt?: number; result?: GitActionResult;
};
export type RemoteSnapshot = {
  running: RemoteOperation | null;
  notice: RemoteOperation | null;
  history: RemoteOperation[];
  check?: GitRemoteCheck;
  checkIdentity?: string;
};
const empty: RemoteSnapshot = { running: null, notice: null, history: [] };
const entries = new Map<string, RemoteSnapshot>();
const listeners = new Map<string, Set<() => void>>();
export const remoteSnapshot = (key: string): RemoteSnapshot => entries.get(key) ?? empty;
function publish(key: string, value: RemoteSnapshot): void {
  entries.set(key, value);
  if (entries.size > 100) for (const [oldKey, entry] of entries) {
    if (entries.size <= 100) break;
    if (!entry.running && !listeners.get(oldKey)?.size) entries.delete(oldKey);
  }
  listeners.get(key)?.forEach(fn => fn());
}
export function beginRemote(key: string, operation: RemoteOperation): boolean {
  const previous = remoteSnapshot(key);
  if (previous.running) return false;
  publish(key, { ...previous, running: operation });
  return true;
}
export function finishRemote(key: string, operation: RemoteOperation, result: GitActionResult): void {
  const previous = remoteSnapshot(key);
  if (previous.running !== operation) return;
  const finished = { ...operation, finishedAt: Date.now(), result };
  const preserveFailure = previous.notice?.result?.ok === false && result.ok && previous.notice.kind !== operation.kind;
  publish(key, { ...previous, running: null,
    notice: operation.automatic || preserveFailure ? previous.notice : finished,
    history: [finished, ...previous.history].slice(0, 5),
    check: operation.kind === 'fetch' ? { attemptedAt: operation.startedAt,
      checkedAt: result.ok ? finished.finishedAt : previous.checkIdentity === JSON.stringify([operation.branch, operation.tracking]) ? previous.check?.checkedAt : undefined,
      error: result.ok ? undefined : result.message ?? 'Fetch failed' } : previous.check,
    checkIdentity: operation.kind === 'fetch' ? JSON.stringify([operation.branch, operation.tracking]) : previous.checkIdentity });
}
export function dismissRemote(key: string): void { publish(key, { ...remoteSnapshot(key), notice: null }); }
export function useRemoteSnapshot(key: string): RemoteSnapshot {
  return useSyncExternalStore(useCallback(fn => {
    const set = listeners.get(key) ?? new Set(); set.add(fn); listeners.set(key, set);
    return () => { set.delete(fn); if (!set.size) listeners.delete(key); };
  }, [key]), useCallback(() => remoteSnapshot(key), [key]));
}
export function resetGitRemoteStateForTest(): void { entries.clear(); }
