import type { SessionMeta } from '../../shared/types';
import type { Store } from '../store';

const DEBOUNCE_MS = 200;

export class SessionPersister {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private store: Store,
    private getSessions: () => SessionMeta[]
  ) {}

  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, DEBOUNCE_MS);
    this.timer.unref?.();
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.store.saveSessions(this.getSessions().filter((s) => s.launchKind !== 'shell' && !s.hidden));
  }

  flushStrict(validate: () => void, project?: (sessions: SessionMeta[]) => SessionMeta[], commit?: () => void): Promise<void> {
    this.cancel();
    return this.store.saveSessionsStrict(() => {
      validate();
      const sessions = this.getSessions().filter((s) => s.launchKind !== 'shell' && !s.hidden);
      return project ? project(sessions) : sessions;
    }, commit).catch((error: unknown) => {
      // A failed strict attempt may have invalidated another session's queued
      // registry update. Requeue the latest complete registry before reporting.
      try { this.flush(); }
      catch (requeueError) {
        this.schedule();
        throw new Error(`会话注册表严格写入失败：${String(error)}；重新排队失败：${String(requeueError)}`);
      }
      throw error;
    });
  }
}
