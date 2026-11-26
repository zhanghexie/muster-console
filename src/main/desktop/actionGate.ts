import type { DesktopAuthority } from './authority';
import type { DesktopGrantRequest } from './grants';
import type { UnknownActionBoundary, UnknownActionChains } from './unknownActionChain';
import type { DesktopTaskLock } from './taskLock';

type ActionOutcome<T> = { outcome: 'dispatched'; value: T; recordId?: string } | { outcome: 'unknown'; reason?: string };

/** Staged composition only: real adapters must derive identity, class and evidence in the host. */
export class DesktopActionGate {
  private readonly tasks = new Map<string, AbortController>();
  private readonly ended = new Set<string>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly takeoverVersions = new Map<string, number>();
  constructor(private readonly authority: DesktopAuthority, private readonly chains: UnknownActionChains,
    private readonly confirm: (boundary: Readonly<UnknownActionBoundary>, signal: AbortSignal) => Promise<boolean>,
    private readonly audit: (boundary: Readonly<UnknownActionBoundary>, decision: 'allowed' | 'denied' | 'attempt') => Promise<void>,
    private readonly lock: Pick<DesktopTaskLock, 'run'>,
    /** Resolve host-owned capture and return a synchronous validity check for later dispatch. */
    private readonly verifyEvidence: (boundary: Readonly<UnknownActionBoundary>, signal: AbortSignal) => Promise<() => boolean>,
    private readonly turnGranted: (taskId: string) => boolean = () => false) {
    if (!lock || typeof lock.run !== 'function' || typeof verifyEvidence !== 'function') throw new Error('Desktop task lock and evidence verifier are required');
  }

  /** The input-seat owner calls this on trusted physical input, before releasing keys. */
  takeover(taskId: string): void {
    this.takeoverVersions.set(taskId, (this.takeoverVersions.get(taskId) ?? 0) + 1);
    this.chains.invalidate(taskId);
    this.tasks.get(taskId)?.abort();
    this.tasks.delete(taskId);
  }

  endTask(taskId: string): void {
    this.takeover(taskId);
    this.ended.add(taskId);
    this.authority.revokeTask(taskId);
  }

  async runUnknown<T>(raw: Omit<DesktopGrantRequest, 'effect'>, boundary: UnknownActionBoundary,
    isCurrent: () => boolean, dispatch: (signal?: AbortSignal, isAuthorized?: () => boolean) => Promise<T>, signal?: AbortSignal,
    preflight?: () => void, prepareDispatch?: (signal?: AbortSignal, isAuthorized?: () => boolean) => void): Promise<ActionOutcome<T>> {
    if (!raw || !boundary || boundary.taskId !== raw.taskId || boundary.appId !== raw.target?.appId ||
        boundary.processInstance !== raw.target?.processInstance || boundary.surfaceId !== raw.target?.surfaceId ||
        boundary.surfaceGeneration !== raw.target?.surfaceGeneration ||
        typeof isCurrent !== 'function' || typeof dispatch !== 'function') throw new Error('Unknown action boundary does not match target');
    const request = { ...raw, target: { ...raw.target }, effect: { kind: 'reversible' as const } };
    const evidence = Object.freeze({ ...boundary, region: Object.freeze({ ...boundary.region }) });
    let currentAfterRelease = (): boolean => false;
    return this.serialize(request.taskId, signal, async combined => {
      combined.throwIfAborted();
      preflight?.();
      if (!isCurrent()) throw new Error('Desktop target or task changed');
      await this.authority.assertTaskAvailable(request.taskId);
      combined.throwIfAborted();
      if (!isCurrent()) throw new Error('Desktop target or task changed');
      const evidenceCurrent = await this.verifyEvidence(evidence, combined);
      if (typeof evidenceCurrent !== 'function') throw new Error('Invalid desktop evidence proof');
      combined.throwIfAborted();
      if (!isCurrent() || evidenceCurrent() !== true) throw new Error('Desktop evidence is no longer current');
      const generation = await this.chains.authorize(evidence, item => this.confirm(item, combined), this.audit, () => this.turnGranted(request.taskId));
      combined.throwIfAborted();
      const stillCurrent = (): boolean => !combined.aborted && isCurrent() && evidenceCurrent() === true &&
        this.chains.isAuthorized(evidence.taskId, evidence.appId, evidence.actionClass, generation);
      currentAfterRelease = stillCurrent;
      if (!stillCurrent()) throw new Error('Desktop action chain invalidated');
      await this.audit(evidence, 'attempt');
      if (!stillCurrent()) throw new Error('Desktop action chain invalidated');
      const authorized = () => !signal?.aborted && stillCurrent() && this.authority.isGrantCurrent(request);
      return this.authority.run(request, stillCurrent, dispatchSignal => dispatch(dispatchSignal, authorized), combined, true,
        prepareDispatch && (dispatchSignal => prepareDispatch(dispatchSignal, authorized)));
    }, () => currentAfterRelease() && this.authority.isGrantCurrent(request));
  }

  /** Only a trusted adapter may classify an effect or supply an object fingerprint. */
  async runKnown<T>(raw: DesktopGrantRequest, isCurrent: () => boolean,
    dispatch: (signal?: AbortSignal, isAuthorized?: () => boolean) => Promise<T>, signal?: AbortSignal,
    preflight?: () => void, prepareDispatch?: (signal?: AbortSignal, isAuthorized?: () => boolean) => void): Promise<ActionOutcome<T>> {
    if (!raw || !raw.target || !raw.effect || typeof isCurrent !== 'function' || typeof dispatch !== 'function') throw new Error('Invalid desktop action request');
    const request = { ...raw, target: { ...raw.target }, effect: { ...raw.effect } };
    const takeoverVersion = this.takeoverVersions.get(request.taskId) ?? 0;
    return this.serialize(request.taskId, signal, combined => {
      preflight?.();
      const authorized = () => !combined.aborted && !signal?.aborted &&
        (this.takeoverVersions.get(request.taskId) ?? 0) === takeoverVersion && isCurrent() && this.authority.isGrantCurrent(request);
      return this.authority.run(request, isCurrent, dispatchSignal => dispatch(dispatchSignal, authorized), combined, true,
        prepareDispatch && (dispatchSignal => prepareDispatch(dispatchSignal, authorized)));
    },
      () => isCurrent() && this.authority.isGrantCurrent(request));
  }

  private async serialize<T>(taskId: string, signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<ActionOutcome<T>>, isCurrent: () => boolean): Promise<ActionOutcome<T>> {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('Invalid desktop task identity');
    if (this.ended.has(taskId)) throw new Error('Desktop task has ended');
    signal?.throwIfAborted();
    const task = this.tasks.get(taskId) ?? new AbortController();
    this.tasks.set(taskId, task);
    const combined = new AbortController();
    const abort = (): void => combined.abort();
    task.signal.addEventListener('abort', abort, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    if (task.signal.aborted || signal?.aborted) combined.abort();
    const previous = this.tails.get(taskId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      let result: ActionOutcome<T> | undefined;
      let released = false;
      try {
        const lockedResult = await this.lock.run(taskId, async () => {
          combined.signal.throwIfAborted();
          result = await run(combined.signal);
          return result;
        });
        released = true;
        if (lockedResult.outcome === 'dispatched' && lockedResult.recordId) {
          combined.signal.throwIfAborted();
          if (isCurrent() !== true || this.ended.has(taskId)) throw new Error('Desktop target or task changed');
          await this.authority.finishCoordinatedDispatch(taskId, lockedResult.recordId);
          combined.signal.throwIfAborted();
          if (isCurrent() !== true || this.ended.has(taskId)) throw new Error('Desktop target or task changed');
          return { outcome: 'dispatched' as const, value: lockedResult.value };
        }
        return lockedResult;
      } catch (error) {
        // The release may have succeeded despite the error. Keep a separate
        // process-local block until the host can recover safely.
        if (result) {
          if (result.outcome === 'dispatched') this.authority.markCoordinationUnknown(taskId, result.recordId ?? null);
          return { outcome: 'unknown' as const, reason: released ? 'authorization-or-finalization-failed' : 'coordinator-release-failed' };
        }
        throw error;
      }
    });
    const tail = operation.then(() => undefined, () => undefined);
    this.tails.set(taskId, tail);
    void tail.then(() => { if (this.tails.get(taskId) === tail) this.tails.delete(taskId); });
    try {
      return await operation;
    } finally {
      task.signal.removeEventListener('abort', abort);
      signal?.removeEventListener('abort', abort);
    }
  }
}
