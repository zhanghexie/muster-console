import type { CuaHostDeliverySlot } from './cuaVisibleAction';
import type { CuaPersistedAction } from './cuaSemanticRuntime';
import type { DesktopDeliveryLease } from './desktopTurns';
import type { VisibleIndicatorEpoch } from './visibleActionCoordinator';
import type { Win32VisibleActor, Win32VisibleDeliverySlot } from './win32VisibleControl';

export interface DesktopSlotContext {
  lease: DesktopDeliveryLease;
  indicatorEpoch: VisibleIndicatorEpoch;
  isIndicatorCurrent(epoch: VisibleIndicatorEpoch): boolean;
  isTargetCurrent(): boolean;
}
export interface DesktopDeliveryProvider {
  /** Presence, not liveness. A stale scope must fail, never fall through. */
  hasScope(): boolean;
  cua(request: Parameters<CuaPersistedAction>[0], context: DesktopSlotContext): CuaHostDeliverySlot;
  win32(actor: Win32VisibleActor, context: DesktopSlotContext & Pick<Win32VisibleDeliverySlot, 'isPointOnTarget' | 'onUnknown'>): Win32VisibleDeliverySlot;
}

/** Select only one private engine scope. Neither a tool argument nor an exception chooses a fallback. */
export function createDesktopDeliverySelector(providers: readonly DesktopDeliveryProvider[]) {
  if (!Array.isArray(providers) || !providers.length || providers.some(provider => !provider ||
      typeof provider.hasScope !== 'function' || typeof provider.cua !== 'function' || typeof provider.win32 !== 'function')) {
    throw new Error('Desktop delivery providers are unavailable');
  }
  const sources = [...providers];
  const current = (): DesktopDeliveryProvider => {
    const active = sources.filter(provider => provider.hasScope() === true);
    if (active.length !== 1) throw new Error('Desktop delivery requires one live host engine scope');
    return active[0]!;
  };
  return Object.freeze({
    cua(request: Parameters<CuaPersistedAction>[0], context: DesktopSlotContext): CuaHostDeliverySlot {
      return current().cua(request, context);
    },
    win32(actor: Win32VisibleActor, context: DesktopSlotContext & Pick<Win32VisibleDeliverySlot, 'isPointOnTarget' | 'onUnknown'>): Win32VisibleDeliverySlot {
      return current().win32(actor, context);
    }
  });
}
