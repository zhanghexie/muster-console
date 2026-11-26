import type { DesktopActionIdempotency } from './actionIdempotency';
import type { VisibleActionContext, VisibleActionCoordinator, VisibleAcknowledgementOutcome } from './visibleActionCoordinator';
import type { VisibleActionJson } from './visibleActionJson';

type Stored = { outcome: 'dispatched'; value: VisibleActionJson; invocationId: string; deliveryToken: string } |
  { outcome: 'unknown'; invocationId?: string; reason?: string };

export type VisibleDispatch =
  | { reply: { outcome: 'dispatched'; value: VisibleActionJson; invocationId: string };
      /** Only the host may invoke this after independently confirming engine delivery. */
      acknowledge(deliveryId?: string): Promise<VisibleAcknowledgementOutcome> }
  | { reply: { outcome: 'unknown'; invocationId?: string; reason?: string } };

/**
 * Composes durable request deduplication with the shared task-wide outbox.
 * A receipt closure remains in the host: never send it or the stored token to
 * an engine. Producing a reply is not itself evidence that it was delivered.
 */
export class VisibleActionDispatcher {
  constructor(private readonly receipts: Pick<DesktopActionIdempotency, 'run'>,
    private readonly coordinator: Pick<VisibleActionCoordinator, 'run' | 'verifyKnown' | 'acknowledgeKnown'>) {
    if (typeof receipts?.run !== 'function' || typeof coordinator?.run !== 'function' ||
        typeof coordinator?.verifyKnown !== 'function' || typeof coordinator?.acknowledgeKnown !== 'function') {
      throw new Error('Visible action dispatcher dependencies are required');
    }
  }

  async run(raw: VisibleActionContext, requestId: string, fingerprint: string,
    dispatch: (signal?: AbortSignal) => Promise<unknown>): Promise<VisibleDispatch> {
    if (!raw || typeof raw.isCurrent !== 'function' || typeof raw.isIndicatorCurrent !== 'function' ||
        typeof requestId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(requestId) ||
        typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(fingerprint) || typeof dispatch !== 'function') {
      throw new Error('Invalid visible action request');
    }
    const context: VisibleActionContext = Object.freeze({ sessionId: raw.sessionId, taskId: raw.taskId, target: raw.target,
      action: raw.action, indicatorEpoch: raw.indicatorEpoch, isCurrent: raw.isCurrent.bind(raw),
      isIndicatorCurrent: raw.isIndicatorCurrent.bind(raw), signal: raw.signal });
    const current = (): boolean => {
      try { return !context.signal?.aborted && context.isCurrent() === true &&
        context.isIndicatorCurrent(context.indicatorEpoch) === true; } catch { return false; }
    };
    const stored = await this.receipts.run<Stored>(context.sessionId, context.taskId, requestId,
      { version: 1, target: context.target, action: context.action, fingerprint: fingerprint.toLowerCase() }, current,
      async markDispatch => {
        const result = await this.coordinator.run(context, async signal => {
          markDispatch();
          return dispatch(signal);
        });
        if (result.outcome === 'unknown') return { outcome: 'unknown', invocationId: result.invocationId, reason: result.reason };
        return { outcome: 'dispatched', value: result.value, invocationId: result.invocationId, deliveryToken: result.deliveryToken };
      }, context.signal);
    if (stored.outcome === 'unknown') {
      return { reply: { outcome: 'unknown', ...('invocationId' in stored && stored.invocationId ? { invocationId: stored.invocationId } : {}),
        ...('reason' in stored && stored.reason ? { reason: stored.reason } : {}) } };
    }
    if (typeof stored.invocationId !== 'string' || !stored.invocationId.trim() ||
        typeof stored.deliveryToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(stored.deliveryToken)) {
      throw new Error('Visible action receipt is invalid; independent recovery is required');
    }
    const { invocationId, deliveryToken, value } = stored;
    const confirmed = await this.coordinator.verifyKnown(context, invocationId, deliveryToken, value);
    return {
      reply: { outcome: 'dispatched', value: confirmed, invocationId },
      // The same action can be reported by several native tool-call IDs after
      // a safe replay. Its host receipt identity must remain stable.
      acknowledge: () => this.coordinator.acknowledgeKnown(context, invocationId, `visible-action:${invocationId}`, deliveryToken)
    };
  }
}
