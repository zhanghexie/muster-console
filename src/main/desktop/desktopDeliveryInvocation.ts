import { AsyncLocalStorage } from 'node:async_hooks';
import type { CuaPersistedAction } from './cuaSemanticRuntime';
import type { DesktopDeliveryLease } from './desktopTurns';
import type { VisibleIndicatorEpoch } from './visibleActionCoordinator';
import type { Win32VisibleActor, Win32VisibleDeliverySlot } from './win32VisibleControl';
import type { createDesktopDeliverySelector } from './desktopDeliverySelector';

type Selector = ReturnType<typeof createDesktopDeliverySelector>;
export interface DesktopDeliveryInvocation {
  readonly actor: Win32VisibleActor;
  readonly lease: DesktopDeliveryLease;
  readonly indicatorEpoch: VisibleIndicatorEpoch;
  /** Verified window ref for a semantic action; launch has no target window. */
  readonly targetWindowId?: string;
  isIndicatorCurrent(epoch: VisibleIndicatorEpoch): boolean;
  isTargetCurrent(): boolean;
  isPointOnTarget?: Win32VisibleDeliverySlot['isPointOnTarget'];
  onUnknown: Win32VisibleDeliverySlot['onUnknown'];
}
type Scope = Readonly<DesktopDeliveryInvocation & { isOpen(): boolean }>;
const invocations = new AsyncLocalStorage<Scope>();
const live = (check: () => boolean): boolean => { try { return check() === true; } catch { return false; } };
const identity = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 1024;

/** Wrap only a host tool execution; never populate this context from tool arguments. */
export function runWithDesktopDeliveryInvocation<T>(input: DesktopDeliveryInvocation, execute: () => Promise<T>): Promise<T> {
  const { actor, lease, indicatorEpoch } = input ?? {};
  if (!actor || !lease || ![actor.sessionId, actor.taskId, actor.turnId].every(identity) ||
      actor.sessionId !== lease.owner || actor.turnId !== lease.turnId ||
      typeof actor.isCurrent !== 'function' || typeof lease.isCurrent !== 'function' || !lease.signal || typeof lease.signal.addEventListener !== 'function' ||
      !((typeof indicatorEpoch === 'string' && identity(indicatorEpoch)) ||
        (typeof indicatorEpoch === 'number' && Number.isSafeInteger(indicatorEpoch) && indicatorEpoch >= 0)) ||
      (input.targetWindowId !== undefined && !identity(input.targetWindowId)) ||
      typeof input.isIndicatorCurrent !== 'function' || typeof input.isTargetCurrent !== 'function' ||
      typeof input.onUnknown !== 'function' || (input.isPointOnTarget !== undefined && typeof input.isPointOnTarget !== 'function') ||
      typeof execute !== 'function' || invocations.getStore() || lease.signal.aborted ||
      !live(() => actor.isCurrent()) || !live(() => lease.isCurrent()) ||
      !live(() => input.isIndicatorCurrent(indicatorEpoch)) || !live(() => input.isTargetCurrent())) {
    throw new Error('Desktop delivery invocation is unavailable');
  }
  let open = true;
  const pinned = Object.freeze({ actor: Object.freeze({ sessionId: actor.sessionId, taskId: actor.taskId, turnId: actor.turnId,
    isCurrent: actor.isCurrent.bind(actor) }), lease, indicatorEpoch,
    ...(input.targetWindowId ? { targetWindowId: input.targetWindowId } : {}),
    isIndicatorCurrent: input.isIndicatorCurrent.bind(input), isTargetCurrent: input.isTargetCurrent.bind(input),
    ...(input.isPointOnTarget ? { isPointOnTarget: input.isPointOnTarget.bind(input) } : {}), onUnknown: input.onUnknown.bind(input),
    isOpen: () => open });
  return invocations.run(pinned, async () => { try { return await execute(); } finally { open = false; } });
}

function current(actor: { sessionId: string; taskId: string; turnId: string; isCurrent(): boolean }) {
  const value = invocations.getStore();
  if (!value || !value.isOpen() || !actor || actor.sessionId !== value.actor.sessionId || actor.taskId !== value.actor.taskId ||
      actor.turnId !== value.actor.turnId || typeof actor.isCurrent !== 'function' || value.lease.signal.aborted ||
      !live(() => actor.isCurrent()) || !live(() => value.actor.isCurrent()) || !live(() => value.lease.isCurrent()) ||
      !live(() => value.isTargetCurrent()) || !live(() => value.isIndicatorCurrent(value.indicatorEpoch))) {
    throw new Error('Desktop delivery invocation changed');
  }
  return value;
}

/** Resolve the current call's private Windows slot; no caller supplies a slot. */
export function captureInvocationWin32Slot(selector: Selector, actor: Win32VisibleActor): Win32VisibleDeliverySlot {
  const value = current(actor);
  return selector.win32(actor, value);
}

/** The semantic registry calls this within the same host invocation. */
export function captureInvocationCuaSlot(selector: Selector, request: Parameters<CuaPersistedAction>[0]) {
  const value = current(request?.actor);
  if (!value.targetWindowId || request.hostWindowId !== value.targetWindowId ||
      typeof request.isTargetCurrent !== 'function' || !live(() => request.isTargetCurrent())) throw new Error('Desktop semantic target changed');
  return selector.cua(request, { ...value, isTargetCurrent: () => live(() => value.isTargetCurrent()) && live(() => request.isTargetCurrent()) });
}
