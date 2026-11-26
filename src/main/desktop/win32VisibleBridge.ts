import type { TrustedDisplayActor } from './displayService';
import type { DesktopDeliveryLease } from './desktopTurns';
import type { createDesktopDeliverySelector } from './desktopDeliverySelector';
import { captureInvocationWin32Slot, runWithDesktopDeliveryInvocation } from './desktopDeliveryInvocation';
import { PreDispatchFailure } from './preDispatchFailure';
import type { Win32VisibleActor, Win32VisibleControl, Win32VisibleDeliverySlot, Win32VisibleRequest } from './win32VisibleControl';

type Selector = ReturnType<typeof createDesktopDeliverySelector>;
interface Options {
  control: Pick<Win32VisibleControl, 'act' | 'launch'>;
  selector: Selector;
  activity: { visibilityEpoch(): number | undefined; stop(): Promise<void> };
  resolveTarget(actor: TrustedDisplayActor, windowId: string): { isCurrent(): boolean };
  isPointOnTarget: NonNullable<Win32VisibleDeliverySlot['isPointOnTarget']>;
  reportStopError(error: unknown): void;
}

/** Host-only adapter from a visible seat call to its current engine delivery slot. */
export class Win32VisibleBridge {
  constructor(private readonly options: Options) {
    if (!options || typeof options.control?.act !== 'function' || typeof options.control?.launch !== 'function' ||
        typeof options.selector?.win32 !== 'function' || typeof options.activity?.visibilityEpoch !== 'function' ||
        typeof options.activity?.stop !== 'function' || typeof options.resolveTarget !== 'function' ||
        typeof options.isPointOnTarget !== 'function' || typeof options.reportStopError !== 'function') {
      throw new Error('Windows visible desktop bridge dependencies are unavailable');
    }
  }

  act(actor: TrustedDisplayActor, lease: DesktopDeliveryLease, request: Win32VisibleRequest, requestId: string, signal?: AbortSignal) {
    return this.invoke(actor, lease, request.windowId, (owner, slot) => this.options.control.act(owner, request, requestId, slot, signal));
  }

  launch(actor: TrustedDisplayActor, lease: DesktopDeliveryLease, appId: string, requestId: string, signal?: AbortSignal) {
    return this.invoke(actor, lease, undefined, (owner, slot) => this.options.control.launch(owner, appId, requestId, slot, signal));
  }

  private invoke(actor: TrustedDisplayActor, lease: DesktopDeliveryLease, windowId: string | undefined,
    execute: (actor: Win32VisibleActor, slot: Win32VisibleDeliverySlot) => ReturnType<Win32VisibleControl['act']>) {
    try {
      if (!actor || !lease || typeof actor.isCurrent !== 'function' || !actor.isCurrent() ||
          actor.sessionId !== lease.owner || typeof lease.turnId !== 'string' || !lease.turnId ||
          typeof lease.isCurrent !== 'function' || !lease.isCurrent() || lease.signal.aborted) {
        throw new Error('Desktop caller is no longer current');
      }
      const epoch = this.options.activity.visibilityEpoch();
      if (epoch === undefined) throw new Error('Desktop indicator is not visible');
      const selected = windowId === undefined ? undefined : this.options.resolveTarget(actor, windowId);
      if (windowId !== undefined && (!selected || typeof selected.isCurrent !== 'function' || selected.isCurrent() !== true)) {
        throw new Error('Desktop target changed');
      }
      const owner: Win32VisibleActor = Object.freeze({ sessionId: actor.sessionId, taskId: actor.taskId, turnId: lease.turnId,
        isCurrent: () => actor.isCurrent() && lease.isCurrent() && !lease.signal.aborted });
      const currentTarget = () => owner.isCurrent() && (!selected || selected.isCurrent());
      return runWithDesktopDeliveryInvocation({ actor: owner, lease, indicatorEpoch: epoch,
        isIndicatorCurrent: value => this.options.activity.visibilityEpoch() === value,
        isTargetCurrent: currentTarget, isPointOnTarget: this.options.isPointOnTarget,
        onUnknown: () => {
          // stop() freezes this shared run synchronously before its cleanup awaits.
          void this.options.activity.stop().catch(error => {
            try { this.options.reportStopError(error); }
            catch (reportError) { console.error('[desktop] Failed to report desktop stop error', reportError); }
          });
        } }, async () => {
          let slot: Win32VisibleDeliverySlot;
          try { slot = captureInvocationWin32Slot(this.options.selector, owner); }
          catch (error) { throw new PreDispatchFailure(error); }
          return execute(owner, slot);
        });
    } catch (error) { throw new PreDispatchFailure(error); }
  }
}
