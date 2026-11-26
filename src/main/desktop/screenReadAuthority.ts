import type { DesktopDispatchJournal } from './dispatchJournal';
import type { DisplayCaptureTarget } from './displayCapture';
import { MAX_DESKTOP_GRANT_TTL_MS } from './grants';
export const SCREEN_READ_SCOPE = 'screen-capture-all-displays-v1';

/** This authority is host-owned; session identity and display target must not come from model arguments. */
export class ScreenReadAuthority {
  private readonly approved = new Map<string, { taskId: string; expiresAt: number }>();
  private readonly requestedTask = new Map<string, string>();
  private readonly denied = new Set<string>();
  private readonly generation = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly scope = SCREEN_READ_SCOPE;

  constructor(private readonly journal: Pick<DesktopDispatchJournal, 'hasRefusal' | 'recordRefusal' | 'clearRefusal'>,
    private readonly confirm: (sessionId: string, target: Readonly<DisplayCaptureTarget>, signal?: AbortSignal, isCurrent?: () => boolean) => Promise<boolean>,
    private readonly audit: (sessionId: string, target: Readonly<DisplayCaptureTarget> | null,
      result: 'approved' | 'denied' | 'revoked' | 'reconsidered') => Promise<void>,
    private readonly now: () => number = () => performance.now()) {
    if (!journal || typeof journal.hasRefusal !== 'function' || typeof journal.recordRefusal !== 'function' ||
      typeof journal.clearRefusal !== 'function' || typeof confirm !== 'function' || typeof audit !== 'function') throw new Error('Invalid screen capture authority');
  }

  private enqueue<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const operation = previous.then(run), tail = operation.then(() => undefined, () => undefined);
    this.tails.set(sessionId, tail);
    void tail.then(() => { if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId); });
    return operation;
  }

  /** A token is valid only while this host-owned session grant remains current. */
  isAuthorized(sessionId: string, taskId: string, generation: number): boolean {
    const grant = this.approved.get(sessionId);
    return (this.generation.get(sessionId) ?? 0) === generation && this.requestedTask.get(sessionId) === taskId &&
      grant?.taskId === taskId && grant.expiresAt > this.now() && !this.denied.has(sessionId);
  }

  authorize(sessionId: string, raw: DisplayCaptureTarget, isCurrent: () => boolean, signal?: AbortSignal): Promise<number> {
    if (typeof sessionId !== 'string' || !sessionId.trim() || !raw || typeof isCurrent !== 'function' ||
      [raw.taskId, raw.surfaceId, raw.surfaceGeneration, raw.geometryRevision].some(value => typeof value !== 'string' || !value.trim()) ||
      !Number.isSafeInteger(raw.displayId) || raw.displayId < 0 || !raw.bounds ||
      ![raw.bounds.x, raw.bounds.y, raw.bounds.width, raw.bounds.height, raw.scaleFactor].every(Number.isFinite) ||
      raw.bounds.width <= 0 || raw.bounds.height <= 0 || raw.scaleFactor <= 0) return Promise.reject(new Error('Invalid screen capture authorization'));
    const target = Object.freeze({ ...raw, bounds: Object.freeze({ ...raw.bounds }) });
    try {
      signal?.throwIfAborted();
      if (!isCurrent()) throw new Error('Screen capture authorization changed');
    } catch (error) { return Promise.reject(error); }
    // A new host-verified task invalidates the old task synchronously, including
    // confirmations already waiting in the queue.
    if (this.requestedTask.get(sessionId) !== target.taskId) {
      this.requestedTask.set(sessionId, target.taskId);
      this.approved.delete(sessionId);
      this.generation.set(sessionId, (this.generation.get(sessionId) ?? 0) + 1);
    }
    let generation = this.generation.get(sessionId) ?? 0;
    return this.enqueue(sessionId, async () => {
      const assertCurrent = (): void => {
        signal?.throwIfAborted();
        if ((this.generation.get(sessionId) ?? 0) !== generation || !isCurrent()) throw new Error('Screen capture authorization changed');
      };
      assertCurrent();
      if (this.denied.has(sessionId) || await this.journal.hasRefusal(sessionId, this.scope)) throw new Error('Screen capture was previously declined');
      assertCurrent();
      const existing = this.approved.get(sessionId);
      if (existing && existing.taskId === target.taskId && existing.expiresAt > this.now()) return generation;
      if (existing) {
        this.approved.delete(sessionId);
        generation++;
        this.generation.set(sessionId, generation);
      }
      const allowed = await this.confirm(sessionId, target, signal, isCurrent) === true;
      if (!allowed && !signal?.aborted) {
        this.denied.add(sessionId);
        await this.journal.recordRefusal(sessionId, this.scope);
      }
      assertCurrent();
      await this.audit(sessionId, target, allowed ? 'approved' : 'denied');
      assertCurrent();
      if (!allowed) throw new Error('Screen capture declined');
      this.approved.set(sessionId, { taskId: target.taskId, expiresAt: this.now() + MAX_DESKTOP_GRANT_TTL_MS });
      return generation;
    });
  }

  /** Explicit human revocation. In-flight confirmations are invalidated synchronously. */
  revoke(sessionId: string): Promise<void> {
    if (typeof sessionId !== 'string' || !sessionId.trim()) return Promise.reject(new Error('Invalid screen capture session'));
    this.generation.set(sessionId, (this.generation.get(sessionId) ?? 0) + 1);
    this.approved.delete(sessionId);
    this.denied.add(sessionId);
    return this.enqueue(sessionId, async () => {
      await this.journal.recordRefusal(sessionId, this.scope);
      await this.audit(sessionId, null, 'revoked');
    });
  }

  /** Only an explicit human request may clear a previously persisted refusal. */
  reconsiderAfterUserRequest(sessionId: string): Promise<void> {
    if (typeof sessionId !== 'string' || !sessionId.trim()) return Promise.reject(new Error('Invalid screen capture session'));
    return this.enqueue(sessionId, async () => {
      const persisted = await this.journal.hasRefusal(sessionId, this.scope);
      if (!persisted && !this.denied.has(sessionId)) throw new Error('No screen capture refusal to reconsider');
      await this.audit(sessionId, null, 'reconsidered');
      if (persisted) await this.journal.clearRefusal(sessionId, this.scope);
      this.denied.delete(sessionId);
    });
  }
}
