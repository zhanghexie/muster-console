import type { SessionsService } from '../sessions';
import type { DesktopEpochHistory } from './epochHistory';
import { t } from '../../shared/i18n';

/** Host-only worker identity. Archive must call invalidateBeforeArchive before changing session state. */
export class WorkerDesktopEpochs {
  private readonly poisoned = new Set<string>();
  constructor(private readonly sessions: Pick<SessionsService, 'peek' | 'sessionScopeToken'>,
    private readonly history: DesktopEpochHistory) {
    if (typeof history?.endSessions !== 'function') throw new Error('Atomic worker desktop epoch history is required');
  }

  private checkId(value: string): void {
    if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('Invalid worker desktop identity');
  }
  private session(sessionId: string) {
    this.checkId(sessionId);
    if (this.poisoned.has(sessionId)) throw new Error(t('桌面任务身份需要恢复；请检查存储并重启工作台后重试。'));
    const session = this.sessions.peek(sessionId);
    if (!session || session.archived || session.type !== 'terminal' || session.launchKind === 'shell' || !session.workspaceId) return null;
    const token = this.sessions.sessionScopeToken(sessionId);
    return token ? { session, token } : null;
  }
  currentBinding(sessionId: string): { epoch: string; anchor: string; generation: number } | null {
    if (!this.session(sessionId)) return null;
    return { epoch: sessionId, anchor: sessionId, generation: this.history.generation(sessionId) };
  }
  capture(sessionId: string, workspaceId: string): { taskId: string; generation: number; isCurrent: () => boolean } {
    this.checkId(workspaceId);
    const binding = this.session(sessionId);
    if (!binding || binding.session.workspaceId !== workspaceId) throw new Error('Worker session or workspace is not current');
    const generation = this.history.generation(sessionId);
    return { taskId: sessionId, generation, isCurrent: () => {
      try {
        const current = this.session(sessionId);
        return !!current && current.session === binding.session && current.token === binding.token &&
          current.session.workspaceId === workspaceId && this.history.generation(sessionId) === generation;
      } catch { return false; }
    } };
  }
  /** Failure must abort archive/close: a restart must never revive an old generation. */
  invalidateBeforeArchive(sessionId: string): void {
    this.invalidateBatchBeforeArchive([sessionId]);
  }
  invalidateBatchBeforeArchive(sessionIds: readonly string[]): void {
    if (!Array.isArray(sessionIds) || !sessionIds.length || new Set(sessionIds).size !== sessionIds.length) throw new Error('Invalid worker desktop session batch');
    for (const sessionId of sessionIds) {
      this.checkId(sessionId);
      if (!this.session(sessionId)) throw new Error('Worker session is not current');
    }
    try { this.history.endSessions!(sessionIds); }
    catch (error) {
      for (const id of sessionIds) this.poisoned.add(id);
      throw new Error(t('桌面任务身份保存失败：{{error}}。请检查存储并重启工作台后重试。', { error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

/** Register before exposing desktop actions. The host owns the returned disposer. */
export function bindWorkerEpochArchive(sessions: Pick<SessionsService, 'onBeforeArchive'>, epochs: WorkerDesktopEpochs): () => void {
  return sessions.onBeforeArchive(rows => {
    const ids = rows.filter(row => row.type === 'terminal' && row.launchKind !== 'shell' && !!row.workspaceId).map(row => row.id);
    if (ids.length) epochs.invalidateBatchBeforeArchive(ids);
  });
}
