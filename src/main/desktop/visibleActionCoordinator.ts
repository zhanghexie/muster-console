import { randomBytes } from 'node:crypto';
import type { WriteOutbox } from './writeOutbox';
import type { DesktopTaskLock } from './taskLock';
import type { VisibleActionBarrier, VisibleActionMarker } from './visibleActionBarrier';
import { boundedVisibleActionResult, type VisibleActionJson } from './visibleActionJson';

export type VisibleIndicatorEpoch = string | number;

/** Every field and callback must be bound by the host, never by a model. */
export interface VisibleActionContext {
  sessionId: string;
  taskId: string;
  target: string;
  action: string;
  indicatorEpoch: VisibleIndicatorEpoch;
  isCurrent(): boolean;
  isIndicatorCurrent(epoch: VisibleIndicatorEpoch): boolean;
  signal?: AbortSignal;
}

export type VisibleActionOutcome =
  /** The host must bind deliveryToken to actual downstream delivery, not a model-supplied claim. */
  | { outcome: 'known'; invocationId: string; value: VisibleActionJson; deliveryToken: string }
  | { outcome: 'unknown'; invocationId: string; reason: 'backend-failed' | 'result-persistence-failed' | 'current-changed' | 'lock-release-failed' };

export type VisibleAcknowledgementOutcome =
  | { outcome: 'acknowledged' }
  | { outcome: 'unknown'; reason: 'acknowledgement-failed' | 'current-changed' | 'lock-release-failed' | 'barrier-release-failed' };

/** The backend was never called, even if an outbox record was already created. */
export class VisibleActionPreDispatchFailure extends Error {
  readonly code = 'pre-dispatch-failure';
  constructor(message: string, readonly invocationId?: string, cause?: unknown, readonly recoveryRequired = false) {
    super(message, { cause });
    this.name = 'VisibleActionPreDispatchFailure';
  }
}

export class VisibleActionAcknowledgementFailure extends Error {
  readonly code = 'acknowledgement-rejected';
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'VisibleActionAcknowledgementFailure';
  }
}

type Outbox = Pick<WriteOutbox, 'create' | 'markDispatched' | 'complete' | 'get' | 'acknowledge' | 'isTaskBlocked'>;
type Lock = Pick<DesktopTaskLock, 'acquire'>;
type Barrier = Pick<VisibleActionBarrier, 'read' | 'isTaskBlocked' | 'begin' | 'prepareDelivery' | 'matches' | 'finish'>;

function identity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new Error('Invalid visible action identity');
}

function snapshot(raw: VisibleActionContext): VisibleActionContext {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid visible action context');
  const { sessionId, taskId, target, action, indicatorEpoch, isCurrent, isIndicatorCurrent, signal } = raw;
  for (const value of [sessionId, taskId, target, action]) identity(value);
  if (!((typeof indicatorEpoch === 'string' && !!indicatorEpoch.trim() && indicatorEpoch.length <= 1024) ||
      (typeof indicatorEpoch === 'number' && Number.isSafeInteger(indicatorEpoch) && indicatorEpoch >= 0)) ||
      typeof isCurrent !== 'function' || typeof isIndicatorCurrent !== 'function' ||
      (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'))) {
    throw new Error('Invalid visible action context');
  }
  return Object.freeze({ sessionId, taskId, target, action, indicatorEpoch, isCurrent, isIndicatorCurrent, signal });
}

function current(context: VisibleActionContext): void {
  if (context.signal?.aborted || context.isCurrent() !== true || context.isIndicatorCurrent(context.indicatorEpoch) !== true || context.signal?.aborted) {
    throw new Error('Visible action task, target or indicator is no longer current');
  }
}

/**
 * All entry points for a task must share the same lock, outbox and barrier.
 * The host owns context validity, indicator generation, backend and delivery.
 */
export class VisibleActionCoordinator {
  constructor(private readonly outbox: Outbox, private readonly lock: Lock, private readonly barrier: Barrier) {
    if (!outbox || !lock || typeof lock.acquire !== 'function' || !barrier ||
        ['create', 'markDispatched', 'complete', 'get', 'acknowledge', 'isTaskBlocked'].some(key => typeof outbox[key as keyof Outbox] !== 'function') ||
        ['read', 'isTaskBlocked', 'begin', 'prepareDelivery', 'matches', 'finish'].some(key => typeof barrier[key as keyof Barrier] !== 'function')) {
      throw new Error('Visible action requires a shared outbox, task lock and barrier');
    }
  }

  async run(raw: VisibleActionContext, backend: (signal?: AbortSignal) => Promise<unknown>): Promise<VisibleActionOutcome> {
    let context: VisibleActionContext;
    try {
      context = snapshot(raw);
      if (typeof backend !== 'function') throw new Error('Visible action backend is required');
      current(context);
    } catch (error) { throw new VisibleActionPreDispatchFailure('Visible action was not dispatched', undefined, error); }

    let release: (() => Promise<void>) | undefined;
    let invocationId: string | undefined;
    let dispatched = false;
    let acquiring = false;
    let persistenceAttempted = false;
    let failure: unknown;
    let outcome: VisibleActionOutcome | undefined;
    try {
      acquiring = true;
      release = await this.lock.acquire(context.taskId);
      acquiring = false;
      current(context);
      if (this.barrier.read(context.taskId)) throw new Error('Previous visible action requires delivery or independent recovery');
      if (this.barrier.isTaskBlocked(context.taskId)) throw new Error('Previous task write requires delivery or independent recovery');
      if (this.outbox.isTaskBlocked(context.sessionId, context.taskId)) throw new Error('Previous write requires delivery or independent recovery');
      current(context);
      persistenceAttempted = true;
      invocationId = this.outbox.create({ sessionId: context.sessionId, taskId: context.taskId, source: 'desktop', action: context.action, target: context.target });
      current(context);
      const marker = this.barrier.begin(context.taskId, context.sessionId, invocationId);
      current(context);
      this.outbox.markDispatched(context.sessionId, invocationId);
      current(context);
      dispatched = true;
      let value: unknown;
      try {
        value = await backend(context.signal);
      } catch {
        try { this.outbox.complete(context.sessionId, invocationId, { outcome: 'unknown' });
          outcome = { outcome: 'unknown', invocationId, reason: 'backend-failed' };
        } catch { outcome = { outcome: 'unknown', invocationId, reason: 'result-persistence-failed' }; }
      }
      if (!outcome) {
        try {
          this.outbox.complete(context.sessionId, invocationId, { outcome: 'known', value });
          const row = this.outbox.get(context.sessionId, invocationId);
          if (!row || row.taskId !== context.taskId || row.target !== context.target || row.action !== context.action ||
              row.state !== 'result' || row.result?.outcome !== 'known') throw new Error('Visible action result was not persisted');
          const storedValue = boundedVisibleActionResult(row.result.value);
          const deliveryToken = randomBytes(32).toString('base64url');
          this.barrier.prepareDelivery(context.taskId, marker, deliveryToken, storedValue);
          outcome = { outcome: 'known', invocationId, value: storedValue, deliveryToken };
        } catch { outcome = { outcome: 'unknown', invocationId, reason: 'result-persistence-failed' }; }
      }
    } catch (error) {
      failure = error;
      if (dispatched && invocationId) outcome = { outcome: 'unknown', invocationId, reason: 'backend-failed' };
    }

    if (release) {
      try { await release(); }
      catch (error) {
        if (dispatched && invocationId) return { outcome: 'unknown', invocationId, reason: 'lock-release-failed' };
        throw new VisibleActionPreDispatchFailure('Visible action was not dispatched; task lock release failed and requires recovery', invocationId, error, true);
      }
    }
    if (!dispatched || !invocationId) {
      const recoveryRequired = acquiring || persistenceAttempted;
      throw new VisibleActionPreDispatchFailure(recoveryRequired
        ? 'Visible action was not dispatched; persistent state or task lock requires recovery'
        : 'Visible action was not dispatched', invocationId, failure, recoveryRequired);
    }
    if (!outcome) return { outcome: 'unknown', invocationId, reason: 'backend-failed' };
    try { current(context); } catch { return { outcome: 'unknown', invocationId, reason: 'current-changed' }; }
    return outcome;
  }

  /** Verify a deduplicated reply against the authoritative outbox before returning it. */
  async verifyKnown(raw: VisibleActionContext, invocationId: string, deliveryToken: string, value: unknown): Promise<VisibleActionJson> {
    const context = snapshot(raw);
    identity(invocationId);
    if (typeof deliveryToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(deliveryToken)) throw new Error('Invalid visible action receipt');
    const candidate = boundedVisibleActionResult(value);
    current(context);
    const release = await this.lock.acquire(context.taskId);
    let confirmed: VisibleActionJson;
    try {
      current(context);
      const row = this.outbox.get(context.sessionId, invocationId);
      const marker = this.barrier.read(context.taskId);
      if (!row || row.taskId !== context.taskId || row.target !== context.target || row.action !== context.action || row.source !== 'desktop' ||
          (row.state !== 'result' && row.state !== 'delivered') || row.result?.outcome !== 'known') {
        throw new Error('Visible action receipt does not match the outbox');
      }
      confirmed = boundedVisibleActionResult(row.result.value);
      if (JSON.stringify(confirmed) !== JSON.stringify(candidate)) throw new Error('Visible action receipt result does not match the outbox');
      if (row.state === 'result') {
        if (!marker || !this.barrier.matches(marker, context.sessionId, invocationId, deliveryToken, confirmed)) {
          throw new Error('Visible action delivery receipt does not match the outbox');
        }
      } else if (marker) {
        throw new Error('Visible action task has an unresolved delivery');
      }
      current(context);
    } finally { await release(); }
    current(context);
    return confirmed;
  }

  /** Only a trusted host may acknowledge a known result after downstream delivery. */
  async acknowledgeKnown(raw: VisibleActionContext, invocationId: string, requestId: string, deliveryToken: string): Promise<VisibleAcknowledgementOutcome> {
    let context: VisibleActionContext;
    try {
      context = snapshot(raw); identity(invocationId); identity(requestId);
      if (typeof deliveryToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(deliveryToken)) throw new Error('Invalid visible action delivery token');
      current(context);
    }
    catch (error) { throw new VisibleActionAcknowledgementFailure('Visible action acknowledgement rejected', error); }

    let release: (() => Promise<void>) | undefined;
    let marker: VisibleActionMarker | null = null;
    let acknowledgementAttempted = false;
    let failure: unknown;
    try {
      release = await this.lock.acquire(context.taskId);
      current(context);
      marker = this.barrier.read(context.taskId);
      const row = this.outbox.get(context.sessionId, invocationId);
      if (!row || row.taskId !== context.taskId || row.target !== context.target || row.action !== context.action || row.source !== 'desktop' ||
          (row.state !== 'result' && row.state !== 'delivered') || row.result?.outcome !== 'known') {
        throw new Error('Only a matching known result may be acknowledged');
      }
      boundedVisibleActionResult(row.result.value);
      if (row.state === 'result') {
        if (!marker || !this.barrier.matches(marker, context.sessionId, invocationId, deliveryToken, row.result.value)) throw new Error('Visible action result was not delivered or its token does not match');
      } else if (marker) {
        // A prior acknowledgement may have committed before its lock release
        // failed. Retrying must not silently clear the durable barrier.
        throw new Error('Previous acknowledgement requires independent recovery');
      }
      current(context);
      acknowledgementAttempted = true;
      this.outbox.acknowledge(context.sessionId, invocationId, requestId);
      current(context);
    } catch (error) { failure = error; }

    if (release) {
      try { await release(); }
      catch (error) {
        if (acknowledgementAttempted) return { outcome: 'unknown', reason: 'lock-release-failed' };
        throw new VisibleActionAcknowledgementFailure('Acknowledgement was rejected; task lock release failed', error);
      }
    }
    if (failure) {
      if (acknowledgementAttempted) return { outcome: 'unknown', reason: 'acknowledgement-failed' };
      throw new VisibleActionAcknowledgementFailure('Visible action acknowledgement rejected', failure);
    }
    try { current(context); } catch { return { outcome: 'unknown', reason: 'current-changed' }; }
    if (marker) {
      try { this.barrier.finish(context.taskId, marker, () => current(context)); }
      catch { return { outcome: 'unknown', reason: 'barrier-release-failed' }; }
      // No await between the final check, synchronous barrier removal and this
      // check: a host stop queued on this JS thread cannot interleave them.
      try { current(context); } catch { return { outcome: 'unknown', reason: 'current-changed' }; }
    }
    return { outcome: 'acknowledged' };
  }
}
