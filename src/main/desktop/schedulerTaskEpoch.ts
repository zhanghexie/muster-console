import { MAX_DESKTOP_GRANT_TTL_MS } from './grants';
import type { DesktopEpochHistory } from './epochHistory';

/** Host-derived application and action class; never treat model arguments as authority. */
export interface DesktopTaskScope { appId: string; actionClass: string }
export type DesktopTaskConfirmation = Readonly<DesktopTaskScope & { kind: 'start' | 'extend'; taskId?: string }>;
type Receipt = { approvalId?: string };
type Entry = { taskId: string; expiresAt: number; historyGeneration: number };
export class DesktopTaskConfirmationDeclined extends Error {
  constructor() { super('Desktop task confirmation declined'); this.name = 'DesktopTaskConfirmationDeclined'; }
}

/** Staging boundary. Only host UI events may call startNew; no model-facing route is registered. */
export class SchedulerDesktopTaskEpochs {
  private readonly current = new Map<string, Entry>();
  private readonly usedIds = new Set<string>();
  private readonly closing = new Set<string>();
  private readonly generations = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly confirm: (request: DesktopTaskConfirmation, signal?: AbortSignal, sessionId?: string) => Promise<Receipt>,
    private readonly audit: (sessionId: string, request: DesktopTaskConfirmation, result: 'approved' | 'denied', approvalId?: string) => Promise<void>,
    private readonly history: DesktopEpochHistory, private readonly now: () => number = () => performance.now()) {
    if (!history || typeof history.generation !== 'function' || typeof history.record !== 'function' ||
        typeof history.owns !== 'function' || typeof history.findByHash !== 'function' || typeof history.endSession !== 'function') throw new Error('Desktop epoch history is required');
  }

  private enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(sessionId) ?? Promise.resolve();
    const result = prior.then(operation), tail = result.then(() => undefined, () => undefined);
    this.tails.set(sessionId, tail);
    void tail.then(() => { if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId); });
    return result;
  }

  /** Invalidates in-flight work synchronously; archive/close must invoke this. */
  closeSession(sessionId: string): void {
    this.checkId(sessionId);
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
    this.current.delete(sessionId);
    this.closing.add(sessionId);
    this.history.endSession(sessionId);
    this.closing.delete(sessionId);
  }

  isCurrent(sessionId: string, taskId: string): boolean {
    const item = this.current.get(sessionId);
    try { return !this.closing.has(sessionId) && !!item && item.taskId === taskId && item.expiresAt > this.now() &&
      this.history.generation(sessionId) === item.historyGeneration; }
    catch { return false; }
  }

  /** Host-only snapshot for binding a wait to its current confirmation receipt. */
  currentBinding(sessionId: string): { epoch: string; anchor: string; generation: number } | null {
    this.checkId(sessionId);
    const item = this.current.get(sessionId);
    if (!item || this.closing.has(sessionId) || item.expiresAt <= this.now()) return null;
    return this.history.generation(sessionId) === item.historyGeneration ? { epoch: item.taskId, anchor: item.taskId, generation: item.historyGeneration } : null;
  }

  /** Artifact storage still enforces its own TTL; replacing an epoch does not revoke history. */
  ownsArtifact(sessionId: string, taskId: string): boolean {
    return !this.closing.has(sessionId) && this.history.owns(sessionId, this.history.generation(sessionId), taskId);
  }

  /** Hash comes from host-owned capture metadata, not from a model claim. */
  findArtifactTask(sessionId: string, taskHash: string): string | undefined {
    if (this.closing.has(sessionId)) return undefined;
    return this.history.findByHash(sessionId, this.history.generation(sessionId), taskHash);
  }

  ensure(sessionId: string, scope: DesktopTaskScope, isCurrent: () => boolean, signal?: AbortSignal): Promise<string> {
    return this.run(sessionId, scope, isCurrent, 'ensure', signal);
  }

  /** Host-only entry, after an explicit request to start a new chain. */
  startNew(sessionId: string, scope: DesktopTaskScope, isCurrent: () => boolean, signal?: AbortSignal): Promise<string> {
    return this.run(sessionId, scope, isCurrent, 'start', signal);
  }

  /** Additional application/action/range approval never changes the active epoch. */
  extend(sessionId: string, scope: DesktopTaskScope, isCurrent: () => boolean, signal?: AbortSignal): Promise<string> {
    return this.run(sessionId, scope, isCurrent, 'extend', signal);
  }

  private run(sessionId: string, scope: DesktopTaskScope, isCurrent: () => boolean,
    mode: 'ensure' | 'start' | 'extend', signal?: AbortSignal): Promise<string> {
    try {
      this.checkId(sessionId);
      if (!scope || ![scope.appId, scope.actionClass].every(value => typeof value === 'string' && !!value.trim()) ||
          typeof isCurrent !== 'function') throw new Error('Invalid desktop task scope');
    } catch (error) { return Promise.reject(error); }
    const snapshot = Object.freeze({ appId: scope.appId, actionClass: scope.actionClass });
    const generation = this.generations.get(sessionId) ?? 0;
    return this.enqueue(sessionId, async () => {
      const assertCurrent = (): void => {
        signal?.throwIfAborted();
        if (this.closing.has(sessionId)) throw new Error('Desktop session is closing');
        if ((this.generations.get(sessionId) ?? 0) !== generation || !isCurrent()) throw new Error('Desktop caller changed');
      };
      assertCurrent();
      const historyGeneration = this.history.generation(sessionId);
      const existing = this.current.get(sessionId);
      const active = existing && existing.expiresAt > this.now() && existing.historyGeneration === historyGeneration ? existing : undefined;
      if (mode === 'ensure' && active) return active.taskId;
      if (mode === 'extend' && !active) throw new Error('No active desktop task to extend');
      const request: DesktopTaskConfirmation = Object.freeze({ ...snapshot,
        kind: mode === 'extend' ? 'extend' : 'start', ...(mode === 'extend' ? { taskId: active!.taskId } : {}) });
      const receipt = await this.confirm(request, signal, sessionId);
      assertCurrent();
      const approvalId = receipt?.approvalId;
      const allowed = typeof approvalId === 'string' && !!approvalId.trim();
      await this.audit(sessionId, request, allowed ? 'approved' : 'denied', allowed ? approvalId : undefined);
      assertCurrent();
      if (!allowed) throw new DesktopTaskConfirmationDeclined();
      if (mode === 'extend') {
        if (!this.isCurrent(sessionId, active!.taskId)) throw new Error('Desktop task expired during confirmation');
        return active!.taskId;
      }
      if (this.usedIds.has(approvalId)) throw new Error('Desktop approval receipt was already used');
      this.history.record(sessionId, historyGeneration, approvalId);
      this.usedIds.add(approvalId);
      const taskId = approvalId;
      this.current.set(sessionId, { taskId, expiresAt: this.now() + MAX_DESKTOP_GRANT_TTL_MS, historyGeneration });
      return taskId;
    });
  }

  private checkId(value: string): void {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid desktop session identity');
  }
}
