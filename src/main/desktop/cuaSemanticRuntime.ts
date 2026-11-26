import { createHash } from 'node:crypto';
import { CuaDriverUnavailableError } from './cuaDriverPath';
import { inheritRecordedDesktopOutcome, isRecordedDesktopOutcome } from './recordedDesktopOutcome';
import { CuaTransport, type CuaConnection, type CuaSetValueDelivery } from './cuaTransport';
import { CuaSemanticSession, CuaUncertainActionError, CuaWindowCaptureError, type CuaWindowPoint } from './cuaSemanticSession';
import { PreDispatchFailure, PreDispatchRecoveryRequired } from './preDispatchFailure';

/** These values are supplied by the host execution context, never by a model. */
export interface CuaSemanticActor {
  readonly sessionId: string;
  readonly taskId: string;
  readonly turnId: string;
  /** Host desktop run lifetime, distinct from one completed seat operation. */
  readonly lifetimeSignal?: AbortSignal;
  isCurrent(): boolean;
}

/**
 * Host resolver proves the native window instance; its values are never returned
 * to the caller. Generation must be shared across actors for the same window
 * instance and must change when its native handle is reused.
 */
export interface CuaSemanticTarget {
  readonly pid: number;
  readonly windowId: number;
  readonly generation: string;
  isCurrent(): boolean;
  /** Some compositor adapters can only recheck the live surface through the driver. */
  verify?(driver: CuaConnection, signal: AbortSignal): Promise<void>;
}

export interface CuaSemanticConnection extends CuaConnection {
  setValueDelivery(platform?: NodeJS.Platform, signal?: AbortSignal): Promise<CuaSetValueDelivery>;
}

export type CuaSemanticPage = ReturnType<CuaSemanticSession['page']>;
export type CuaSemanticObservation = Awaited<ReturnType<CuaSemanticSession['observe']>>;
export type CuaSemanticEffect = Awaited<ReturnType<CuaSemanticSession['act']>>;
export type CuaSemanticAction = { snapshotId: string; requestId: string } & (
  { action: 'click' | 'set_value'; ref: string; value?: string; delivery?: 'background' | 'foreground' } |
  { action: 'click'; point: CuaWindowPoint }
);
export type CuaPersistedOutcome =
  | { outcome: 'dispatched'; value: CuaSemanticEffect; invocationId?: string }
  | { outcome: 'unknown'; invocationId?: string; persistence?: 'failed' };

/**
 * A host-owned durable gate/outbox must record dispatch before calling dispatch,
 * enforce request-id/fingerprint consistency, serialize the shared desktop seat,
 * and block unresolved writes across actors and restarts until reconciliation.
 */
export type CuaPersistedAction = (
  request: Readonly<{ actor: CuaSemanticActor; hostWindowId: string; requestId: string; fingerprint: string;
    action: 'click' | 'set_value'; targetGeneration: string; isTargetCurrent(): boolean; isCurrent(): boolean }>,
  dispatch: (signal?: AbortSignal) => Promise<CuaSemanticEffect>,
  signal?: AbortSignal
) => Promise<CuaPersistedOutcome>;

export interface CuaSemanticRuntimeOptions {
  /** Required when no host connection factory is supplied. */
  binary?: string;
  createConnection?: () => CuaSemanticConnection;
  resolveTarget(actor: CuaSemanticActor, hostWindowId: string, signal?: AbortSignal): CuaSemanticTarget | Promise<CuaSemanticTarget>;
  runPersistedAction?: CuaPersistedAction;
  maxSessions?: number;
  ttlMs?: number;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Timer cleanup failures are also latched and reported on subsequent calls. */
  onCleanupError?: (error: Error) => void;
}

export class CuaSemanticRuntimeError extends Error {
  constructor(readonly code: 'invalid' | 'stale' | 'busy' | 'capacity' | 'closed' | 'driver' | 'cleanup_unconfirmed', message: string,
    readonly outcome?: 'unknown') { super(message); this.name = 'CuaSemanticRuntimeError'; }
}

type Entry = {
  key: string; actor: CuaSemanticActor; hostWindowId: string; active: boolean;
  lifetime: AbortController;
  target?: CuaSemanticTarget; targetKey?: string; driver?: CuaSemanticConnection; session?: CuaSemanticSession;
  delivery?: CuaSetValueDelivery; snapshotId?: string; expiresAt?: number;
  refs: Set<string>; timer?: ReturnType<typeof setTimeout>; closing?: Promise<void>; stopActorLifetime?: () => void;
};

const opaque = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const live = (check: () => boolean): boolean => { try { return check() === true; } catch { return false; } };
const unknownOutcome = (effect: CuaSemanticEffect['effect'] = 'unknown', invocationId?: string, persistence?: 'failed') => ({
  outcome: 'unknown' as const, ok: false as const, delivery: 'unknown' as const, effect,
  verification: 'not_performed' as const, ...(invocationId ? { invocationId } : {}), ...(persistence ? { persistence } : {})
});
const sameEffect = (left: CuaSemanticEffect, right: CuaSemanticEffect | undefined): boolean => !!right &&
  left.ok === right.ok && left.delivery === right.delivery && left.effect === right.effect &&
  left.verification === right.verification && left.code === right.code;

/**
 * Host-only session registry. It never accepts native IDs from a tool caller.
 * One observation per actor is retained; each action consumes it and closes
 * its private driver. Cleanup failures poison the registry until host recovery.
 */
export class CuaSemanticRuntime {
  private readonly entries = new Map<string, Entry>();
  private readonly snapshots = new Map<string, Entry>();
  private readonly actorBusy = new Set<string>();
  private readonly targetBusy = new Set<string>();
  private readonly createConnection: () => CuaSemanticConnection;
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private closed = false;
  private cleanupFailure?: Error;
  private closing?: Promise<void>;

  constructor(private readonly options: CuaSemanticRuntimeOptions) {
    if (!options || typeof options.resolveTarget !== 'function') throw new CuaSemanticRuntimeError('invalid', 'A host target resolver is required');
    if ((options.createConnection !== undefined && typeof options.createConnection !== 'function') ||
        (options.runPersistedAction !== undefined && typeof options.runPersistedAction !== 'function') ||
        (options.onCleanupError !== undefined && typeof options.onCleanupError !== 'function')) {
      throw new CuaSemanticRuntimeError('invalid', 'Invalid Cua semantic runtime callbacks');
    }
    this.maxSessions = options.maxSessions ?? 8;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1 || this.maxSessions > 64 ||
        !Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > 60_000 || typeof this.now !== 'function' ||
        !['win32', 'darwin', 'linux'].includes(this.platform)) {
      throw new CuaSemanticRuntimeError('invalid', 'Invalid Cua semantic runtime limits');
    }
    if (options.createConnection) this.createConnection = options.createConnection;
    else {
      if (!options.binary) throw new CuaSemanticRuntimeError('invalid', 'A host-owned Cua driver path is required');
      this.createConnection = () => new CuaTransport(options.binary!);
    }
  }

  async observe(actor: CuaSemanticActor, hostWindowId: string, signal?: AbortSignal, withImage = false): Promise<CuaSemanticObservation> {
    const captured = this.captureActor(actor);
    if (!opaque(hostWindowId)) throw new CuaSemanticRuntimeError('invalid', 'A host window reference is required');
    const key = this.actorKey(captured);
    return this.withActor(key, async () => {
      this.assertOpen();
      await this.sweep();
      const previous = this.entries.get(key);
      if (previous) await this.retire(previous);
      this.assertOpen();
      this.assertActor(captured);
      signal?.throwIfAborted();
      if (this.entries.size >= this.maxSessions) throw new CuaSemanticRuntimeError('capacity', 'Cua semantic session capacity reached');
      const entry: Entry = { key, actor: captured, hostWindowId, active: true, refs: new Set(), lifetime: new AbortController() };
      this.entries.set(key, entry);
      if (captured.lifetimeSignal) {
        const lifetime = captured.lifetimeSignal;
        const stop = () => { void this.retire(entry).catch(error => this.reportCleanup(error)); };
        entry.stopActorLifetime = () => lifetime.removeEventListener('abort', stop);
        lifetime.addEventListener('abort', stop, { once: true });
        if (lifetime.aborted) stop();
      }
      let unlock: (() => void) | undefined;
      const stopAbort = this.closeOnAbort(entry, signal);
      const operationSignal = signal ? AbortSignal.any([signal, entry.lifetime.signal]) : entry.lifetime.signal;
      try {
        let target: CuaSemanticTarget;
        try { target = await this.abortable(Promise.resolve().then(() => this.options.resolveTarget(captured, hostWindowId, operationSignal)), operationSignal); }
        catch (error) {
          if (operationSignal.aborted) throw error;
          throw new CuaSemanticRuntimeError('stale', 'Cua target could not be resolved');
        }
        this.assertEntry(entry, captured, signal);
        if (!target || !Number.isSafeInteger(target.pid) || target.pid <= 0 || !Number.isSafeInteger(target.windowId) || target.windowId <= 0 ||
            !opaque(target.generation) || typeof target.isCurrent !== 'function' || !live(() => target.isCurrent())) {
          throw new CuaSemanticRuntimeError('stale', 'Cua target is unavailable or has changed');
        }
        const targetCurrent = target.isCurrent.bind(target);
        const pinned = Object.freeze({ pid: target.pid, windowId: target.windowId, generation: target.generation,
          isCurrent: targetCurrent, verify: target.verify?.bind(target) });
        entry.target = pinned;
        entry.targetKey = JSON.stringify([pinned.pid, pinned.windowId, pinned.generation]);
        unlock = this.lockTarget(entry.targetKey);
        entry.driver = this.createConnection();
        await this.abortable(entry.driver.connect(), operationSignal);
        this.assertEntry(entry, captured, signal);
        await this.verifyTarget(entry, operationSignal);
        try { entry.delivery = await this.abortable(entry.driver.setValueDelivery(this.platform, operationSignal), operationSignal); }
        catch (error) {
          if (operationSignal.aborted) throw error;
          throw new CuaSemanticRuntimeError('driver', 'Cua set_value delivery capability could not be verified');
        }
        this.assertEntry(entry, captured, signal);
        entry.session = new CuaSemanticSession(entry.driver, hostWindowId, pinned.generation, pinned.pid, pinned.windowId,
          () => this.entryCurrent(entry, captured), entry.delivery);
        const page = await this.abortable(entry.session.observe(operationSignal, withImage), operationSignal);
        await this.verifyTarget(entry, operationSignal);
        this.assertEntry(entry, captured, signal);
        entry.snapshotId = page.snapshotId;
        entry.expiresAt = Math.min(page.expiresAt, this.now() + this.ttlMs);
        this.snapshots.set(page.snapshotId, entry);
        this.rememberRefs(entry, page);
        this.scheduleExpiry(entry);
        return { ...page, expiresAt: entry.expiresAt };
      } catch (error) {
        const wasCurrent = this.entryCurrent(entry, captured);
        await this.retireOrThrow(entry, error);
        if (error instanceof CuaSemanticRuntimeError || error instanceof CuaWindowCaptureError || error instanceof CuaDriverUnavailableError) throw error;
        if (this.closed) throw new CuaSemanticRuntimeError('closed', 'Cua semantic runtime is closed');
        if (signal?.aborted) throw new CuaSemanticRuntimeError('stale', 'Cua observation was interrupted');
        if (!wasCurrent) throw new CuaSemanticRuntimeError('stale', 'Cua observation or target is no longer current');
        throw new CuaSemanticRuntimeError('driver', 'Cua observation failed');
      } finally { stopAbort(); unlock?.(); }
    });
  }

  async page(actor: CuaSemanticActor, snapshotId: string, offset: number): Promise<CuaSemanticPage> {
    const captured = this.captureActor(actor);
    return this.withActor(this.actorKey(captured), async () => {
      this.assertOpen();
      const entry = this.findEntry(captured, snapshotId);
      let unlock: (() => void) | undefined;
      try {
        this.assertEntry(entry, captured);
        unlock = this.lockTarget(entry.targetKey!);
        const page = entry.session!.page(snapshotId, offset);
        this.assertEntry(entry, captured);
        this.rememberRefs(entry, page);
        return this.projectPage(page, entry.expiresAt!);
      } catch (error) {
        if (!this.entryCurrent(entry, captured)) await this.retireOrThrow(entry, error);
        throw error;
      } finally { unlock?.(); }
    });
  }

  async act(actor: CuaSemanticActor, request: CuaSemanticAction, signal?: AbortSignal) {
    const captured = this.captureActor(actor);
    if (!request || !opaque(request.snapshotId) || !opaque(request.requestId) || ('point' in request
      ? request.action !== 'click' || !request.point || ![1, 2].includes(request.point.count) ||
        (request.point.button !== undefined && !['left', 'middle', 'right'].includes(request.point.button))
      : !opaque(request.ref) ||
        !['click', 'set_value'].includes(request.action) || (request.delivery !== undefined && !['background', 'foreground'].includes(request.delivery)) ||
        (request.action === 'set_value' && (typeof request.value !== 'string' || request.value.length > 4096)))) {
      throw new CuaSemanticRuntimeError('invalid', 'Invalid Cua window action');
    }
    const action = Object.freeze('point' in request
      ? { snapshotId: request.snapshotId, requestId: request.requestId, action: request.action,
        point: Object.freeze({ x: request.point.x, y: request.point.y, count: request.point.count, button: request.point.button }) }
      : { snapshotId: request.snapshotId, ref: request.ref, requestId: request.requestId,
        action: request.action, value: request.action === 'set_value' ? request.value : undefined, delivery: request.delivery ?? 'background' });
    if (!this.options.runPersistedAction) throw new CuaSemanticRuntimeError('invalid', 'Durable semantic action execution is unavailable');
    return this.withActor(this.actorKey(captured), async () => {
      this.assertOpen();
      const entry = this.findEntry(captured, action.snapshotId);
      let unlock: (() => void) | undefined;
      let stopAbort = () => {};
      let invoked = false, settled = false;
      let actionValue: CuaSemanticEffect | undefined;
      let actionError: unknown;
      let persisted: CuaPersistedOutcome | undefined;
      try {
        this.assertEntry(entry, captured, signal);
        if (action.point) entry.session!.validatePoint(action.snapshotId, action.point);
        else {
          if (!entry.refs.has(action.ref)) throw new CuaSemanticRuntimeError('stale', 'Cua semantic reference is unavailable');
          if (action.action === 'set_value' && entry.delivery === 'unavailable') {
            throw new CuaSemanticRuntimeError('invalid', 'Semantic set_value is unavailable');
          }
          if (action.action === 'set_value' && entry.delivery === 'background-only' && action.delivery === 'foreground') {
            throw new CuaSemanticRuntimeError('invalid', 'Foreground semantic set_value is unavailable');
          }
        }
        unlock = this.lockTarget(entry.targetKey!);
        stopAbort = this.closeOnAbort(entry, signal);
        const operationSignal = signal ? AbortSignal.any([signal, entry.lifetime.signal]) : entry.lifetime.signal;
        await this.verifyTarget(entry, operationSignal);
        // A write can invalidate every actor's observation of this native target.
        for (const other of [...this.entries.values()]) if (other !== entry && other.targetKey === entry.targetKey) await this.retire(other);
        this.assertEntry(entry, captured, signal);
        // The durable wrapper can bind a request id to its full arguments without
        // persisting the typed value, native handle or element token in plaintext.
        const argumentsForReceipt = action.point ? [action.snapshotId, action.action, action.point] :
          [action.snapshotId, action.ref, action.action, action.value, action.delivery];
        const fingerprint = createHash('sha256').update(JSON.stringify([captured.sessionId, captured.taskId, captured.turnId,
          entry.hostWindowId, entry.target!.generation, ...argumentsForReceipt])).digest('hex');
        const dispatch = (inner?: AbortSignal): Promise<CuaSemanticEffect> => {
          const operation = (async (): Promise<CuaSemanticEffect> => {
            if (invoked) throw new CuaSemanticRuntimeError('invalid', 'Cua action cannot be dispatched twice');
            this.assertEntry(entry, captured, signal);
            inner?.throwIfAborted();
            invoked = true;
            const effective = inner ? AbortSignal.any([operationSignal, inner]) : operationSignal;
            const stopInnerAbort = this.closeOnAbort(entry, inner);
            try {
              actionValue = action.point ? await entry.session!.clickPoint(action.snapshotId, action.point, effective)
                : await entry.session!.act(action.snapshotId, action.ref, action.action, action.value, effective, action.delivery);
              return actionValue;
            } catch (error) { actionError = error; throw error; }
            finally { stopInnerAbort(); settled = true; }
          })();
          // Even a broken wrapper that discards its dispatch promise must not
          // turn a late driver failure into an unhandled process rejection.
          void operation.catch(() => undefined);
          return operation;
        };
        try {
          const pinnedTarget = entry.target!;
          const pending = this.options.runPersistedAction!(Object.freeze({ actor: captured, hostWindowId: entry.hostWindowId,
            requestId: action.requestId, fingerprint, action: action.action, targetGeneration: pinnedTarget.generation,
            isTargetCurrent: pinnedTarget.isCurrent, isCurrent: () => this.entryCurrent(entry, captured) && !operationSignal.aborted }), dispatch, operationSignal);
          persisted = await this.abortable(pending, operationSignal);
        } catch (error) { actionError ??= error; }
        if (!invoked && (actionError instanceof PreDispatchFailure || actionError instanceof PreDispatchRecoveryRequired)) throw actionError;
        const stillCurrent = this.entryCurrent(entry, captured) && !signal?.aborted;
        const id = typeof persisted?.invocationId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(persisted.invocationId)
          ? persisted.invocationId : undefined;
        const persistence = persisted?.outcome === 'unknown' && persisted.persistence === 'failed' ? 'failed' : undefined;
        const effect = actionError instanceof CuaUncertainActionError ? actionError.outcome.effect : 'unknown';
        await this.retire(entry);
        // Driver cleanup can await for an arbitrary time; the owner or target
        // may have changed after the pre-cleanup check.
        const currentAfterCleanup = !this.closed && !this.cleanupFailure && !signal?.aborted &&
          live(() => captured.isCurrent()) && (!entry.target || live(() => entry.target!.isCurrent())) &&
          (entry.expiresAt === undefined || entry.expiresAt > this.now());
        const known = persisted?.outcome === 'dispatched' && invoked && settled && !!actionValue && !actionError &&
          stillCurrent && currentAfterCleanup && sameEffect(actionValue, persisted.value);
        if (!known) {
          const outcome = unknownOutcome(effect, id, persistence);
          // A verified prior request did not enter this backend invocation.
          // Any new dispatch, error, or stale lease keeps the normal stop path.
          return persisted && !invoked && !actionError && stillCurrent && currentAfterCleanup && isRecordedDesktopOutcome(persisted)
            ? inheritRecordedDesktopOutcome(persisted, outcome) : outcome;
        }
        return { outcome: 'dispatched' as const, ...actionValue!, ...(id ? { invocationId: id } : {}) };
      } catch (error) {
        await this.retireOrThrow(entry, error, invoked);
        if (invoked) return unknownOutcome(actionError instanceof CuaUncertainActionError ? actionError.outcome.effect : 'unknown');
        if (error instanceof PreDispatchFailure || error instanceof PreDispatchRecoveryRequired) throw error;
        if (error instanceof CuaSemanticRuntimeError) throw error;
        if (signal?.aborted) throw new CuaSemanticRuntimeError('stale', 'Cua semantic action was interrupted before dispatch');
        throw new CuaSemanticRuntimeError('driver', 'Cua semantic action could not be started');
      } finally { stopAbort(); unlock?.(); }
    });
  }

  /** Close one actor's session, including a pending connection. */
  async closeActor(actor: CuaSemanticActor): Promise<void> {
    const captured = this.captureActor(actor);
    const entry = this.entries.get(this.actorKey(captured));
    if (entry) await this.retire(entry);
  }

  /** Explicitly reclaim expired or invalidated identities. */
  async sweep(): Promise<void> {
    this.assertOpen();
    for (const entry of [...this.entries.values()]) {
      if (!entry.active || !live(() => entry.actor.isCurrent()) || (entry.target && !live(() => entry.target!.isCurrent())) ||
          (entry.expiresAt !== undefined && entry.expiresAt <= this.now())) await this.retire(entry);
    }
    this.assertOpen();
  }

  /** Stop and await all helpers without closing the registry for a later user turn. */
  async stopAll(): Promise<void> {
    const failures: unknown[] = [];
    for (const entry of [...this.entries.values()]) {
      try { await this.retire(entry); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Cua desktop helpers could not be reclaimed');
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const results = await Promise.allSettled([...this.entries.values()].map(entry => this.retire(entry)));
      if (results.some(result => result.status === 'rejected') || this.cleanupFailure) {
        throw new CuaSemanticRuntimeError('cleanup_unconfirmed', 'Cua driver cleanup could not be confirmed', 'unknown');
      }
    })();
    return this.closing;
  }

  private captureActor(actor: CuaSemanticActor): CuaSemanticActor {
    if (!actor || !opaque(actor.sessionId) || !opaque(actor.taskId) || !opaque(actor.turnId) || typeof actor.isCurrent !== 'function' ||
        (actor.lifetimeSignal !== undefined && (!actor.lifetimeSignal || typeof actor.lifetimeSignal.aborted !== 'boolean' ||
          typeof actor.lifetimeSignal.addEventListener !== 'function' || typeof actor.lifetimeSignal.removeEventListener !== 'function'))) {
      throw new CuaSemanticRuntimeError('invalid', 'A trusted Cua actor is required');
    }
    const signal = actor.lifetimeSignal, current = actor.isCurrent.bind(actor);
    return Object.freeze({ sessionId: actor.sessionId, taskId: actor.taskId, turnId: actor.turnId,
      ...(signal ? { lifetimeSignal: signal } : {}), isCurrent: () => !signal?.aborted && current() });
  }
  private actorKey(actor: CuaSemanticActor): string { return JSON.stringify([actor.sessionId, actor.taskId, actor.turnId]); }
  private assertActor(actor: CuaSemanticActor): void {
    if (!live(() => actor.isCurrent())) throw new CuaSemanticRuntimeError('stale', 'Cua actor is no longer current');
  }
  private assertOpen(): void {
    if (this.cleanupFailure) throw new CuaSemanticRuntimeError('cleanup_unconfirmed', 'Cua driver cleanup could not be confirmed', 'unknown');
    if (this.closed) throw new CuaSemanticRuntimeError('closed', 'Cua semantic runtime is closed');
  }
  private entryCurrent(entry: Entry, actor: CuaSemanticActor): boolean {
    return !this.closed && !this.cleanupFailure && entry.active && this.entries.get(entry.key) === entry &&
      live(() => entry.actor.isCurrent()) && live(() => actor.isCurrent()) &&
      (!entry.target || live(() => entry.target!.isCurrent())) && (entry.expiresAt === undefined || entry.expiresAt > this.now());
  }
  private assertEntry(entry: Entry, actor: CuaSemanticActor, signal?: AbortSignal): void {
    this.assertOpen(); signal?.throwIfAborted();
    if (!this.entryCurrent(entry, actor)) throw new CuaSemanticRuntimeError('stale', 'Cua observation or target is no longer current');
  }
  private async verifyTarget(entry: Entry, signal: AbortSignal): Promise<void> {
    if (!entry.target?.verify) return;
    try { await this.abortable(entry.target.verify(entry.driver!, signal), signal); }
    catch (error) {
      if (signal.aborted) throw error;
      throw new CuaSemanticRuntimeError('stale', 'Cua window changed. Refresh the window list and look again.');
    }
  }
  private findEntry(actor: CuaSemanticActor, snapshotId: string): Entry {
    if (!opaque(snapshotId)) throw new CuaSemanticRuntimeError('invalid', 'Invalid Cua observation reference');
    const entry = this.snapshots.get(snapshotId);
    if (!entry || entry.key !== this.actorKey(actor)) throw new CuaSemanticRuntimeError('stale', 'Cua observation is unavailable');
    return entry;
  }
  private rememberRefs(entry: Entry, page: CuaSemanticPage): void {
    for (const element of page.elements) if (element.ref) entry.refs.add(element.ref);
  }
  private projectPage(page: CuaSemanticPage, expiresAt: number): CuaSemanticPage {
    return { ...page, expiresAt };
  }
  private async withActor<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.actorBusy.has(key)) throw new CuaSemanticRuntimeError('busy', 'Cua actor already has an operation in progress');
    this.actorBusy.add(key);
    try { return await operation(); } finally { this.actorBusy.delete(key); }
  }
  private lockTarget(key: string): () => void {
    if (this.targetBusy.has(key)) throw new CuaSemanticRuntimeError('busy', 'Cua target already has an operation in progress');
    this.targetBusy.add(key);
    return () => { this.targetBusy.delete(key); };
  }
  private scheduleExpiry(entry: Entry): void {
    entry.timer = setTimeout(() => { void this.retire(entry).catch(error => this.reportCleanup(error)); }, Math.max(1, entry.expiresAt! - this.now()));
    entry.timer.unref?.();
  }
  private closeOnAbort(entry: Entry, signal?: AbortSignal): () => void {
    if (!signal) return () => {};
    const onAbort = () => { void this.retire(entry).catch(error => this.reportCleanup(error)); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    return () => signal.removeEventListener('abort', onAbort);
  }
  private abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) {
      void promise.catch(() => undefined);
      return Promise.reject(signal.reason ?? new Error('Aborted'));
    }
    return new Promise((resolve, reject) => {
      const aborted = () => reject(signal.reason ?? new Error('Aborted'));
      signal.addEventListener('abort', aborted, { once: true });
      void promise.then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, error => { signal.removeEventListener('abort', aborted); reject(error); });
    });
  }
  private retire(entry: Entry): Promise<void> {
    if (entry.closing) return entry.closing;
    let resolveClose!: () => void, rejectClose!: (error: unknown) => void;
    entry.closing = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    entry.active = false;
    entry.stopActorLifetime?.(); entry.stopActorLifetime = undefined;
    entry.lifetime.abort(new Error('Cua semantic session closed'));
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.snapshotId) this.snapshots.delete(entry.snapshotId);
    entry.session?.close();
    void (async () => {
      try { await entry.driver?.close(); }
      catch {
        this.cleanupFailure = new CuaSemanticRuntimeError('cleanup_unconfirmed', 'Cua driver cleanup could not be confirmed', 'unknown');
        throw this.cleanupFailure;
      }
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    })().then(resolveClose, rejectClose);
    return entry.closing;
  }
  private async retireOrThrow(entry: Entry, _error: unknown, dispatched = false): Promise<void> {
    try { await this.retire(entry); }
    catch { throw new CuaSemanticRuntimeError('cleanup_unconfirmed', 'Cua driver cleanup could not be confirmed', dispatched ? 'unknown' : undefined); }
  }
  private reportCleanup(error: unknown): void {
    const safe = error instanceof Error ? error : new Error('Cua driver cleanup could not be confirmed');
    try { if (this.options.onCleanupError) this.options.onCleanupError(safe); else console.error('[desktop] Cua driver cleanup failed', safe.message); }
    catch { console.error('[desktop] Cua cleanup failure notification failed'); }
  }
}
