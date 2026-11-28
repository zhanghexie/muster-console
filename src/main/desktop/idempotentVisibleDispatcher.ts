import { randomUUID } from 'node:crypto';
import type { DesktopActionIdempotency } from './actionIdempotency';
import { classifyDesktopActionResult } from './desktopActionAuthority';
import { boundedVisibleActionResult, type VisibleActionJson } from './visibleActionJson';
import { VisibleActionPreDispatchFailure, type VisibleActionContext } from './visibleActionCoordinator';
import { PreDispatchFailure } from './preDispatchFailure';
import { DesktopTaskLockCleanupError, DesktopTaskLockReleaseError } from './taskLock';
import type { VisibleActionDispatcher, VisibleDispatch } from './visibleActionDispatcher';

type Receipts = Pick<DesktopActionIdempotency, 'run'>;
type Stored = { outcome: 'dispatched'; invocationId: string; value: VisibleActionJson } |
  { outcome: 'unknown'; invocationId?: string; reason?: string };

/**
 * Reuse the existing durable request receipts without treating a tool result
 * as proof that any engine or business operation consumed it. The desktop
 * run is stopped by the caller when this returns an uncertain outcome.
 */
export class IdempotentVisibleDispatcher implements Pick<VisibleActionDispatcher, 'run'> {
  constructor(private readonly receipts: Receipts) {
    if (!receipts || typeof receipts.run !== 'function') throw new Error('Desktop request receipts are unavailable');
  }

  async run(raw: VisibleActionContext, requestId: string, fingerprint: string,
    dispatch: (signal?: AbortSignal) => Promise<unknown>): Promise<VisibleDispatch> {
    let context: VisibleActionContext;
    try {
      if (!raw || [raw.sessionId, raw.taskId, raw.target, raw.action].some(value =>
        typeof value !== 'string' || !value.trim() || value.length > 1024) ||
        !((typeof raw.indicatorEpoch === 'string' && !!raw.indicatorEpoch.trim() && raw.indicatorEpoch.length <= 1024) ||
          (typeof raw.indicatorEpoch === 'number' && Number.isSafeInteger(raw.indicatorEpoch) && raw.indicatorEpoch >= 0)) ||
        typeof raw.isCurrent !== 'function' || typeof raw.isIndicatorCurrent !== 'function' ||
        (raw.signal !== undefined && (!raw.signal || typeof raw.signal.aborted !== 'boolean' || typeof raw.signal.addEventListener !== 'function')) ||
        typeof requestId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(requestId) ||
        typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(fingerprint) || typeof dispatch !== 'function') {
        throw new Error('Invalid desktop action request');
      }
      context = Object.freeze({ sessionId: raw.sessionId, taskId: raw.taskId, target: raw.target, action: raw.action,
        indicatorEpoch: raw.indicatorEpoch, isCurrent: raw.isCurrent.bind(raw),
        isIndicatorCurrent: raw.isIndicatorCurrent.bind(raw), signal: raw.signal });
    } catch (error) { throw new VisibleActionPreDispatchFailure('Desktop action was not dispatched', undefined, error); }
    const current = (): boolean => {
      try { return !context.signal?.aborted && context.isCurrent() === true &&
        context.isIndicatorCurrent(context.indicatorEpoch) === true && !context.signal?.aborted; }
      catch { return false; }
    };
    if (!current()) throw new VisibleActionPreDispatchFailure('Desktop action was not dispatched');
    let entered = false, marking = false;
    let stored: Stored | { outcome: 'unknown' };
    try {
      stored = await this.receipts.run<Stored>(context.sessionId, context.taskId, requestId,
        { version: 1, target: context.target, action: context.action, fingerprint: fingerprint.toLowerCase() }, current,
        async markDispatch => {
          marking = true;
          markDispatch();
          entered = true;
          const invocationId = randomUUID();
          try {
            const value = await dispatch(context.signal);
            const classified = classifyDesktopActionResult({ sessionId: context.sessionId, taskId: context.taskId, requestId,
              target: context.target, action: context.action, fingerprint: fingerprint.toLowerCase() }, value);
            if (!current()) return { outcome: 'unknown', invocationId, reason: 'current-changed' };
            if (classified.outcome !== 'known') return { outcome: 'unknown', invocationId, reason: 'backend-uncertain' };
            return { outcome: 'dispatched', invocationId, value: boundedVisibleActionResult(classified.value) };
          } catch (error) {
            if (error instanceof PreDispatchFailure) {
              // The trusted backend wrapper proved its native call never started.
              entered = false;
              throw error;
            }
            return { outcome: 'unknown', invocationId, reason: 'backend-failed' };
          }
        }, context.signal);
    } catch (error) {
      if (entered) return { reply: { outcome: 'unknown', reason: 'dispatch-or-persistence-failed' } };
      const conflict = error instanceof Error && error.message === 'Desktop request ID was already used for a different operation';
      const recovery = error instanceof DesktopTaskLockCleanupError || error instanceof DesktopTaskLockReleaseError ||
        (marking && !(error instanceof PreDispatchFailure));
      throw new VisibleActionPreDispatchFailure(conflict
        ? 'The current attempt was not dispatched; this request ID has an earlier record whose result may be unknown'
        : recovery ? 'Desktop action was not dispatched; its receipt or lock may require inspection' : 'Desktop action was not dispatched',
      undefined, error, recovery);
    }
    if (stored.outcome === 'unknown') {
      return { reply: { outcome: 'unknown', ...('invocationId' in stored && stored.invocationId ? { invocationId: stored.invocationId } : {}),
        ...('reason' in stored && stored.reason ? { reason: stored.reason } : {}) } };
    }
    try {
      if (!current() || typeof stored.invocationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(stored.invocationId)) throw new Error('Invalid desktop receipt');
      const value = boundedVisibleActionResult(stored.value);
      const classified = classifyDesktopActionResult({ sessionId: context.sessionId, taskId: context.taskId, requestId,
        target: context.target, action: context.action, fingerprint: fingerprint.toLowerCase() }, value);
      if (classified.outcome !== 'known') throw new Error('Invalid desktop result');
      return { reply: { outcome: 'dispatched', invocationId: stored.invocationId, value },
        // This adapter has no independent engine-delivery proof. This method
        // exists only for the shared bridge interface and cannot claim one.
        acknowledge: async () => ({ outcome: 'unknown', reason: 'acknowledgement-failed' }) };
    } catch { return { reply: { outcome: 'unknown', reason: 'receipt-unavailable' } }; }
  }
}
