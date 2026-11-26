import { GlobalDesktopWriteBarrier, type GlobalDesktopAuthority, type GlobalDesktopRecoveryFence } from './globalDesktopWriteBarrier';
import type { GlobalDesktopTransitionFence } from './globalDesktopLegacy';
import { createGlobalDeliveryEvidenceVault } from './globalDeliveryEvidenceVault';
import { GlobalVisibleActionDispatcher, type GlobalVisibleActionAuthority } from './globalVisibleActionDispatcher';
import { VisibleActionPreDispatchFailure, type VisibleActionContext, type VisibleAcknowledgementOutcome } from './visibleActionCoordinator';
import type { VisibleActionDispatcher, VisibleDispatch } from './visibleActionDispatcher';
import type { GlobalEngineDelivery } from './globalEngineDelivery';

/** The host must establish these facts independently; no default proof exists. */
export type GlobalDesktopHostAuthority = Omit<GlobalDesktopAuthority, 'verifyDelivery'>;
export type GlobalDesktopActionAuthority = Omit<GlobalVisibleActionAuthority, 'deliveryEvidence'>;

type CommonOptions = {
  root: string;
  authority: GlobalDesktopHostAuthority;
  actions: GlobalDesktopActionAuthority;
};
export type GlobalDesktopCompositionOptions = CommonOptions & (
  | { mode: 'activate'; legacyRoots: readonly string[]; legacyOutboxes: readonly string[]; fence: GlobalDesktopTransitionFence }
  | { mode: 'open' }
);

/** Host-private composition; none of its callbacks or engine capabilities go to a model. */
export interface GlobalDesktopComposition {
  readonly dispatcher: Pick<VisibleActionDispatcher, 'run'>;
  /** Suitable for AppContext.desktopEngineDelivery. Always returns this composition's vault. */
  desktopEngineDelivery(): GlobalEngineDelivery;
  inspectMarker(): ReturnType<GlobalDesktopWriteBarrier['inspect']>;
  inspectLegacyEpoch(): ReturnType<GlobalDesktopWriteBarrier['inspectLegacyEpoch']>;
  recover: GlobalDesktopWriteBarrier['recover'];
  acknowledgeUnknown: GlobalDesktopWriteBarrier['acknowledgeUnknown'];
  recoverAbandonedLock: GlobalDesktopWriteBarrier['recoverAbandonedLock'];
  /**
   * Reject new work, revoke delivery proofs, cancel active work, then wait for
   * the actual backend and lock cleanup before closing SQLite. An uncooperative
   * backend can keep this promise pending. No marker is automatically cleared.
   */
  close(): Promise<void>;
}

function hostAuthority(raw: GlobalDesktopHostAuthority, verifyDelivery: GlobalDesktopAuthority['verifyDelivery']): GlobalDesktopAuthority {
  if (!raw || typeof raw !== 'object' || 'verifyDelivery' in raw ||
      typeof raw.legacyWritersExcluded !== 'function' || typeof raw.legacyAutomaticContinuationsExcluded !== 'function' ||
      typeof raw.executorStopped !== 'function' || typeof raw.verifyRecovery !== 'function' ||
      typeof raw.verifyAbandonedLock !== 'function' ||
      (raw.verifyUnknownContinuation !== undefined && typeof raw.verifyUnknownContinuation !== 'function') ||
      (raw.verifyStorageUpgrade !== undefined && typeof raw.verifyStorageUpgrade !== 'function') ||
      (raw.onBackgroundCleanupError !== undefined && typeof raw.onBackgroundCleanupError !== 'function')) {
    throw new Error('Explicit host global desktop authority callbacks are required');
  }
  return Object.freeze({ legacyWritersExcluded: raw.legacyWritersExcluded.bind(raw),
    legacyAutomaticContinuationsExcluded: raw.legacyAutomaticContinuationsExcluded.bind(raw), verifyDelivery,
    executorStopped: raw.executorStopped.bind(raw), verifyRecovery: raw.verifyRecovery.bind(raw),
    verifyAbandonedLock: raw.verifyAbandonedLock.bind(raw),
    ...(raw.verifyUnknownContinuation ? { verifyUnknownContinuation: raw.verifyUnknownContinuation.bind(raw) } : {}),
    ...(raw.verifyStorageUpgrade ? { verifyStorageUpgrade: raw.verifyStorageUpgrade.bind(raw) } : {}),
    ...(raw.onBackgroundCleanupError ? { onBackgroundCleanupError: raw.onBackgroundCleanupError.bind(raw) } : {}) });
}

function actionAuthority(raw: GlobalDesktopActionAuthority, deliveryEvidence: GlobalVisibleActionAuthority['deliveryEvidence']): GlobalVisibleActionAuthority {
  if (!raw || typeof raw !== 'object' || 'deliveryEvidence' in raw ||
      typeof raw.resolveLogicalOperationId !== 'function' || typeof raw.classifyResult !== 'function') {
    throw new Error('Explicit host global desktop action callbacks are required');
  }
  return Object.freeze({ resolveLogicalOperationId: raw.resolveLogicalOperationId.bind(raw),
    classifyResult: raw.classifyResult.bind(raw), deliveryEvidence });
}

/**
 * Construct once for one host-owned storage root. `activate` requires the
 * trusted legacy fence and full root/outbox inventory; `open` never activates
 * or repairs a missing/incomplete store. The caller supplies every exclusion
 * and recovery proof. Delivery proof always comes from this instance's vault.
 */
export async function createGlobalDesktopComposition(options: GlobalDesktopCompositionOptions): Promise<GlobalDesktopComposition> {
  if (!options || typeof options !== 'object' || !['activate', 'open'].includes(options.mode) ||
      typeof options.root !== 'string' || !options.root.trim()) throw new Error('Invalid global desktop composition options');
  let barrier: GlobalDesktopWriteBarrier | undefined;
  const vault = createGlobalDeliveryEvidenceVault(() => {
    if (!barrier) throw new Error('Global desktop barrier has not been opened');
    return barrier.inspect();
  });
  try {
    const authority = hostAuthority(options.authority, vault.verifier.verifyDelivery);
    const actions = actionAuthority(options.actions, vault.verifier.deliveryEvidence);
    barrier = options.mode === 'activate'
      ? await GlobalDesktopWriteBarrier.activate({ root: options.root, legacyRoots: options.legacyRoots,
        legacyOutboxes: options.legacyOutboxes, fence: options.fence, authority })
      : GlobalDesktopWriteBarrier.open(options.root, authority);
    const durable = barrier;
    const delegate = new GlobalVisibleActionDispatcher(durable, actions);
    const lifetime = new AbortController();
    const active = new Set<Promise<void>>();
    let state: 'open' | 'closing' | 'closed' = 'open';
    let closing: Promise<void> | undefined;
    const assertOpen = (): void => { if (state !== 'open') throw new Error('Global desktop composition is closing or closed'); };

    // Register before invoking host callbacks: one can synchronously initiate
    // shutdown, and SQLite must not close until that invocation has unwound.
    const track = <T>(run: () => Promise<T>): Promise<T> => {
      assertOpen();
      let finished!: () => void;
      const done = new Promise<void>(resolve => { finished = resolve; });
      active.add(done);
      try {
        return Promise.resolve(run()).finally(() => { active.delete(done); finished(); });
      } catch (error) {
        active.delete(done); finished(); return Promise.reject(error);
      }
    };

    const dispatcher: Pick<VisibleActionDispatcher, 'run'> = Object.freeze({
      run(raw, requestId, fingerprint, dispatch): Promise<VisibleDispatch> {
        if (state !== 'open') return Promise.reject(new VisibleActionPreDispatchFailure('Global desktop composition is closing or closed'));
        let context: VisibleActionContext;
        try {
          if (!raw || typeof raw.isCurrent !== 'function' || typeof raw.isIndicatorCurrent !== 'function') throw new Error('Invalid visible action context');
          const current = raw.isCurrent.bind(raw), indicatorCurrent = raw.isIndicatorCurrent.bind(raw);
          const signal = raw.signal ? AbortSignal.any([raw.signal, lifetime.signal]) : lifetime.signal;
          context = Object.freeze({ sessionId: raw.sessionId, taskId: raw.taskId, target: raw.target, action: raw.action,
            indicatorEpoch: raw.indicatorEpoch, isCurrent: () => !lifetime.signal.aborted && current() === true,
            isIndicatorCurrent: indicatorCurrent, signal });
        } catch (error) { return Promise.reject(new VisibleActionPreDispatchFailure('Invalid visible action context', undefined, error)); }
        return track(async () => {
          const result = await delegate.run(context, requestId, fingerprint, dispatch);
          // Preserve the private WeakSet identity on read-only duplicate replies.
          if (!('acknowledge' in result)) return result;
          const acknowledge = result.acknowledge.bind(result);
          return { reply: result.reply, acknowledge(deliveryId?: string): Promise<VisibleAcknowledgementOutcome> {
            if (state !== 'open') return Promise.resolve({ outcome: 'unknown', reason: 'current-changed' });
            return track(() => acknowledge(deliveryId));
          } };
        });
      }
    });

    const engineDelivery: GlobalEngineDelivery = Object.freeze({ stager: vault.stager, issuer: vault.issuer,
      inspectMarker() { assertOpen(); return durable.inspect(); } });
    const composition: GlobalDesktopComposition = Object.freeze({
      dispatcher,
      desktopEngineDelivery() { assertOpen(); return engineDelivery; },
      inspectMarker() { assertOpen(); return durable.inspect(); },
      inspectLegacyEpoch() { assertOpen(); return durable.inspectLegacyEpoch(); },
      recover(operationId: string, evidenceId: string, resolution: 'confirmed-applied' | 'confirmed-not-applied', isCurrent: () => boolean) {
        if (typeof isCurrent !== 'function') return Promise.reject(new Error('A current host recovery is required'));
        return track(() => durable.recover(operationId, evidenceId, resolution, () => state === 'open' && isCurrent() === true));
      },
      acknowledgeUnknown(operationId: string, authorization: object, isCurrent: () => boolean) {
        if (typeof isCurrent !== 'function') return Promise.reject(new Error('A current host continuation is required'));
        return track(() => durable.acknowledgeUnknown(operationId, authorization, () => state === 'open' && isCurrent() === true));
      },
      recoverAbandonedLock(evidenceId: string, fence: GlobalDesktopRecoveryFence) {
        if (!fence || typeof fence.isQuiescent !== 'function' || typeof fence.holdsExclusiveFence !== 'function') {
          return Promise.reject(new Error('A quiescent exclusive host recovery fence is required'));
        }
        return track(() => durable.recoverAbandonedLock(evidenceId, {
          isQuiescent: () => state === 'open' && fence.isQuiescent() === true,
          holdsExclusiveFence: () => state === 'open' && fence.holdsExclusiveFence() === true
        }));
      },
      close() {
        if (closing) return closing;
        state = 'closing';
        let resolveClose!: () => void;
        let rejectClose!: (error: unknown) => void;
        closing = new Promise<void>((resolve, reject) => {
          resolveClose = resolve;
          rejectClose = reject;
        });
        const failures: unknown[] = [];
        try { lifetime.abort(); } catch (error) { failures.push(error); }
        try { vault.close(); } catch (error) { failures.push(error); }
        void (async () => {
          await Promise.all([...active]);
          try { await durable.drain(); } catch (error) { failures.push(error); }
          try { durable.close(); } catch (error) { failures.push(error); }
          state = 'closed';
          if (failures.length) throw new AggregateError(failures, 'Global desktop composition cleanup failed');
        })().then(resolveClose, rejectClose);
        return closing;
      }
    });
    return composition;
  } catch (error) {
    const failures: unknown[] = [error];
    try { vault.close(); } catch (cleanup) { failures.push(cleanup); }
    try { barrier?.close(); } catch (cleanup) { failures.push(cleanup); }
    if (failures.length > 1) throw new AggregateError(failures, 'Global desktop composition construction and cleanup failed');
    throw error;
  }
}
