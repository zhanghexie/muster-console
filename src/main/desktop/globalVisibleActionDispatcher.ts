import { createHash } from 'node:crypto';
import { GlobalDesktopPreDispatchRecoveryRequired, type GlobalDesktopBackendResult,
  type GlobalDesktopWriteBarrier, type GlobalDesktopWriteContext } from './globalDesktopWriteBarrier';
import { GlobalDesktopWriteConflict } from './globalDesktopWriteStore';
import { PreDispatchFailure } from './preDispatchFailure';
import { VisibleActionPreDispatchFailure, type VisibleActionContext, type VisibleAcknowledgementOutcome } from './visibleActionCoordinator';
import type { VisibleActionDispatcher, VisibleDispatch } from './visibleActionDispatcher';

// This is an in-process host capability, not a property or reason in the tool
// response. Only the dispatcher can brand a read of a verified prior request.
const recordedRequests = new WeakSet<object>();
export function isRecordedGlobalVisibleRequest(result: unknown): boolean {
  return !!result && typeof result === 'object' && recordedRequests.has(result);
}

export interface GlobalVisibleRequest {
  readonly sessionId: string;
  readonly taskId: string;
  readonly requestId: string;
  readonly action: string;
  readonly target: string;
  readonly fingerprint: string;
}

/**
 * A deterministic host-side identity for a new operation in this exact scope.
 * A trusted continuation of an existing operation must reuse the original
 * identity instead of deriving a fresh one from the new task/session.
 */
export function scopedGlobalVisibleRequestId(sessionId: string, taskId: string, requestId: string): string {
  if (![sessionId, taskId, requestId].every(value => typeof value === 'string' && !!value.trim() && value.length <= 1024)) {
    throw new Error('Invalid global visible request scope');
  }
  return createHash('sha256').update(JSON.stringify(['global-visible-action-v1', sessionId, taskId, requestId])).digest('hex');
}

/** All callbacks are host-private; no model or tool argument can act as authority. */
export interface GlobalVisibleActionAuthority {
  /**
   * Resolve the durable globally unique logical-operation ID before dispatch.
   * New scoped requests may use scopedGlobalVisibleRequestId; trusted retries
   * must reuse the original ID even across task/session changes. Persist any
   * required continuation mapping before returning. Never return requestId raw.
   */
  resolveLogicalOperationId(request: GlobalVisibleRequest): string | Promise<string>;
  /** Classify the trusted backend's dispatch result; uncertain effects stay unknown. */
  classifyResult(request: GlobalVisibleRequest, value: unknown): GlobalDesktopBackendResult;
  /**
   * Look up host-private evidence independently recorded after the exact result
   * reached the engine. An invocation ID or an acknowledge call is not evidence.
   * The barrier's separate verifyDelivery callback must validate the same record.
   */
  deliveryEvidence(request: GlobalVisibleRequest, operationId: string): string | undefined | Promise<string | undefined>;
}

/**
 * A global alternative to VisibleActionDispatcher, not a wrapper around it.
 * No legacy task outbox is entered before the global barrier accepts a write.
 * The host retains the returned acknowledgement closure and must connect its
 * independent engine-delivery evidence source before using it in production.
 * After restart a pending result blocks writes, but cannot be redelivered from
 * this interface: the global store retains hashes, not the result or token.
 */
export class GlobalVisibleActionDispatcher implements Pick<VisibleActionDispatcher, 'run'> {
  private readonly resolve: GlobalVisibleActionAuthority['resolveLogicalOperationId'];
  private readonly classify: GlobalVisibleActionAuthority['classifyResult'];
  private readonly evidence: GlobalVisibleActionAuthority['deliveryEvidence'];

  constructor(private readonly barrier: Pick<GlobalDesktopWriteBarrier, 'run' | 'acknowledge'>,
    authority: GlobalVisibleActionAuthority) {
    if (typeof barrier?.run !== 'function' || typeof barrier?.acknowledge !== 'function' || !authority ||
        typeof authority.resolveLogicalOperationId !== 'function' || typeof authority.classifyResult !== 'function' ||
        typeof authority.deliveryEvidence !== 'function') throw new Error('Global visible action dependencies are required');
    this.resolve = authority.resolveLogicalOperationId.bind(authority);
    this.classify = authority.classifyResult.bind(authority);
    this.evidence = authority.deliveryEvidence.bind(authority);
  }

  async run(raw: VisibleActionContext, requestId: string, fingerprint: string,
    dispatch: (signal?: AbortSignal) => Promise<unknown>): Promise<VisibleDispatch> {
    let context: VisibleActionContext;
    let request: GlobalVisibleRequest;
    try {
      if (!raw || [raw.sessionId, raw.taskId, raw.target, raw.action].some(value =>
        typeof value !== 'string' || !value.trim() || value.length > 1024) ||
        !((typeof raw.indicatorEpoch === 'string' && !!raw.indicatorEpoch.trim() && raw.indicatorEpoch.length <= 1024) ||
          (typeof raw.indicatorEpoch === 'number' && Number.isSafeInteger(raw.indicatorEpoch) && raw.indicatorEpoch >= 0)) ||
        typeof raw.isCurrent !== 'function' || typeof raw.isIndicatorCurrent !== 'function' ||
        (raw.signal !== undefined && (!raw.signal || typeof raw.signal.aborted !== 'boolean' || typeof raw.signal.addEventListener !== 'function')) ||
        typeof requestId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(requestId) ||
        typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(fingerprint) || typeof dispatch !== 'function') {
        throw new Error('Invalid global visible action request');
      }
      context = Object.freeze({ sessionId: raw.sessionId, taskId: raw.taskId, target: raw.target, action: raw.action,
        indicatorEpoch: raw.indicatorEpoch, isCurrent: raw.isCurrent.bind(raw),
        isIndicatorCurrent: raw.isIndicatorCurrent.bind(raw), signal: raw.signal });
      request = Object.freeze({ sessionId: context.sessionId, taskId: context.taskId, requestId,
        action: context.action, target: context.target, fingerprint: fingerprint.toLowerCase() });
    } catch (error) { throw new VisibleActionPreDispatchFailure('Global visible action was not dispatched', undefined, error); }

    const current = (): boolean => {
      try { return !context.signal?.aborted && context.isCurrent() === true &&
        context.isIndicatorCurrent(context.indicatorEpoch) === true && !context.signal?.aborted; }
      catch { return false; }
    };
    let logicalId: string;
    try {
      if (!current()) throw new Error('Global visible action context is no longer current');
      logicalId = await this.resolve(request);
      if (typeof logicalId !== 'string' || !logicalId.trim() || logicalId.length > 1024 || logicalId === requestId || !current()) {
        throw new Error('A stable host-owned global operation identity is required');
      }
    } catch (error) { throw new VisibleActionPreDispatchFailure('Global visible action was not dispatched', undefined, error); }

    const globalContext: GlobalDesktopWriteContext = Object.freeze({ requestId: logicalId, publicRequestId: requestId, sessionId: context.sessionId,
      taskId: context.taskId, target: context.target, action: context.action, fingerprint: request.fingerprint,
      isCurrent: current, signal: context.signal });
    let entered = false;
    let result: Awaited<ReturnType<GlobalDesktopWriteBarrier['run']>>;
    try {
      result = await this.barrier.run(globalContext, async signal => {
        entered = true;
        const value = await dispatch(signal);
        return this.classify(request, value);
      });
    } catch (error) {
      if (entered) throw error;
      const recovery = error instanceof GlobalDesktopPreDispatchRecoveryRequired;
      const conflict = error instanceof PreDispatchFailure && error.cause instanceof GlobalDesktopWriteConflict;
      throw new VisibleActionPreDispatchFailure(recovery ? 'Global visible action was not dispatched; global state requires inspection' :
        conflict ? 'Desktop request ID was already used for a different operation' : 'Global visible action was not dispatched',
      recovery ? error.operationId : undefined, error, recovery);
    }
    if (result.outcome === 'unknown') {
      const visible: VisibleDispatch = { reply: { outcome: 'unknown', invocationId: result.operationId, reason: result.reason } };
      if ('recordedRequest' in result && result.recordedRequest === true) recordedRequests.add(visible);
      return visible;
    }

    const { operationId, deliveryToken, value } = result;
    let confirmed = false;
    let pending: Promise<VisibleAcknowledgementOutcome> | undefined;
    const acknowledge = (): Promise<VisibleAcknowledgementOutcome> => {
      if (confirmed) return Promise.resolve({ outcome: 'acknowledged' });
      if (pending) return pending;
      const attempt = (async (): Promise<VisibleAcknowledgementOutcome> => {
        try {
          if (!current()) return { outcome: 'unknown', reason: 'current-changed' };
          const evidenceId = await this.evidence(request, operationId);
          if (typeof evidenceId !== 'string' || !evidenceId.trim() || evidenceId.length > 1024) {
            return { outcome: 'unknown', reason: 'acknowledgement-failed' };
          }
          const outcome = await this.barrier.acknowledge(globalContext, operationId, deliveryToken, evidenceId);
          if (outcome.outcome === 'confirmed') { confirmed = true; return { outcome: 'acknowledged' }; }
          if (outcome.outcome !== 'unknown') return { outcome: 'unknown', reason: 'acknowledgement-failed' };
          return { outcome: 'unknown', reason: outcome.reason === 'current-changed' ? 'current-changed' :
            outcome.reason === 'lock-release-failed' ? 'lock-release-failed' : 'barrier-release-failed' };
        } catch { return { outcome: 'unknown', reason: 'acknowledgement-failed' }; }
      })();
      pending = attempt;
      void attempt.finally(() => { if (pending === attempt) pending = undefined; });
      return attempt;
    };
    return { reply: { outcome: 'dispatched', value, invocationId: operationId }, acknowledge };
  }
}
