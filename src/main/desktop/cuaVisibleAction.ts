import type { DesktopDeliveryLease } from './desktopTurns';
import type { CuaPersistedAction, CuaSemanticEffect } from './cuaSemanticRuntime';
import type { VisibleActionDispatcher } from './visibleActionDispatcher';
import type { VisibleAcknowledgementOutcome, VisibleIndicatorEpoch } from './visibleActionCoordinator';
import { VisibleActionPreDispatchFailure } from './visibleActionCoordinator';
import { PreDispatchFailure, PreDispatchRecoveryRequired } from './preDispatchFailure';
import { inheritRecordedDesktopOutcome } from './recordedDesktopOutcome';

export interface CuaHostDeliverySlot {
  /** The desktop run lifetime, not the private Cua session or one input operation. */
  lease: DesktopDeliveryLease;
  indicatorEpoch: VisibleIndicatorEpoch;
  isIndicatorCurrent(epoch: VisibleIndicatorEpoch): boolean;
  isTargetCurrent(): boolean;
  /**
   * Stage privately only. Register an engine expectation after semantic.act
   * returns a matching dispatched result and its complete output is serialized.
   * Invoke the closure only after independent engine delivery confirmation.
   */
  stageDelivery(invocationId: string, value: CuaSemanticEffect,
    acknowledge: (deliveryId: string) => Promise<VisibleAcknowledgementOutcome>): void | Promise<void>;
}

/** Host-only bridge; a model cannot supply its delivery slot or native target proof. */
export function createCuaVisibleAction(dispatcher: Pick<VisibleActionDispatcher, 'run'>,
  captureSlot: (request: Parameters<CuaPersistedAction>[0]) => CuaHostDeliverySlot): CuaPersistedAction {
  if (typeof dispatcher?.run !== 'function' || typeof captureSlot !== 'function') throw new Error('Cua visible action dependencies are required');
  return async (request, dispatch, semanticSignal) => {
    let slot: CuaHostDeliverySlot;
    try { slot = captureSlot(request); }
    catch (error) { throw new PreDispatchFailure(error); }
    try {
      if (!slot || !slot.lease || typeof slot.lease.isCurrent !== 'function' || !slot.lease.signal ||
          slot.lease.owner !== request.actor.sessionId || slot.lease.turnId !== request.actor.turnId ||
          typeof slot.isTargetCurrent !== 'function' || typeof slot.isIndicatorCurrent !== 'function' ||
          typeof request.isTargetCurrent !== 'function' || typeof request.targetGeneration !== 'string' || !request.targetGeneration ||
          typeof slot.stageDelivery !== 'function' || !request.isCurrent() || !request.isTargetCurrent() || !slot.lease.isCurrent()) {
        throw new Error('Cua delivery context is unavailable');
      }
    } catch (error) { throw new PreDispatchFailure(error); }
    const leaseSignal = slot.lease.signal, leaseCurrent = slot.lease.isCurrent.bind(slot.lease);
    const targetCurrent = slot.isTargetCurrent.bind(slot), indicatorCurrent = slot.isIndicatorCurrent.bind(slot);
    const pinnedTargetCurrent = request.isTargetCurrent.bind(request);
    const stage = slot.stageDelivery.bind(slot), indicatorEpoch = slot.indicatorEpoch;
    let result: Awaited<ReturnType<VisibleActionDispatcher['run']>>;
    try {
      result = await dispatcher.run({ sessionId: request.actor.sessionId, taskId: request.actor.taskId,
        target: request.hostWindowId, action: `cua.${request.action}`, indicatorEpoch,
        isCurrent: () => request.actor.isCurrent() && leaseCurrent() && pinnedTargetCurrent() && targetCurrent(),
        isIndicatorCurrent: indicatorCurrent, signal: leaseSignal },
      request.requestId, request.fingerprint, signal => {
        const combined = signal && semanticSignal ? AbortSignal.any([signal, semanticSignal]) : signal ?? semanticSignal;
        return dispatch(combined);
      });
    } catch (error) {
      if (error instanceof VisibleActionPreDispatchFailure) {
        if (error.recoveryRequired) throw new PreDispatchRecoveryRequired(error);
        throw new PreDispatchFailure(error);
      }
      throw error;
    }
    if (result.reply.outcome === 'unknown') {
      return inheritRecordedDesktopOutcome(result, { outcome: 'unknown' as const, invocationId: result.reply.invocationId });
    }
    if (!('acknowledge' in result)) throw new Error('Cua delivery receipt is unavailable');
    // CuaSemanticRuntime compares this persisted projection with the exact
    // action result it observed before exposing it as a tool result.
    const value = result.reply.value as unknown as CuaSemanticEffect;
    await stage(result.reply.invocationId, value, result.acknowledge);
    return { outcome: 'dispatched', value, invocationId: result.reply.invocationId };
  };
}
