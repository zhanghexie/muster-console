import type { TrustedDisplayActor } from './displayService';
import type { DesktopDeliveryLease } from './desktopTurns';

/** Keep a capture's identity tied to the run, not only the finished seat call. */
export function bindDesktopActorToRun(actor: TrustedDisplayActor, lease?: DesktopDeliveryLease): TrustedDisplayActor {
  if (!lease) return actor;
  if (!actor || actor.sessionId !== lease.owner || typeof actor.isCurrent !== 'function' ||
      typeof lease.isCurrent !== 'function' || !lease.signal || lease.signal.aborted || !lease.isCurrent()) {
    throw new Error('Desktop capture run is unavailable');
  }
  const actorCurrent = actor.isCurrent.bind(actor), runCurrent = lease.isCurrent.bind(lease);
  return Object.freeze({ ...actor, isCurrent: () => {
    try { return !lease.signal.aborted && actorCurrent() === true && runCurrent() === true; } catch { return false; }
  } });
}
