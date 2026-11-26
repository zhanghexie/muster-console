import type { DesktopDisplayService, TrustedDisplayActor } from './displayService';
import type { runDesktopInventory } from './inventoryProcess';

type WindowInventory = Awaited<ReturnType<typeof runDesktopInventory>>;

/** Internal metadata composition; no capture, activation or native input is performed. */
export class DesktopListService {
  constructor(private readonly displays: Pick<DesktopDisplayService, 'list'>,
    private readonly windows: (signal?: AbortSignal) => Promise<WindowInventory>) {
    if (!displays || typeof displays.list !== 'function' || typeof windows !== 'function') throw new Error('Invalid desktop list adapters');
  }

  async list(raw: TrustedDisplayActor, signal?: AbortSignal): Promise<{
    displays: ReturnType<DesktopDisplayService['list']>;
    windows: { ok: true; data: WindowInventory } | { ok: false; error: string };
  }> {
    if (!raw || typeof raw.sessionId !== 'string' || !raw.sessionId.trim() || typeof raw.taskId !== 'string' || !raw.taskId.trim() ||
        typeof raw.isCurrent !== 'function') throw new Error('Invalid desktop caller');
    const actor = Object.freeze({ sessionId: raw.sessionId, taskId: raw.taskId, isCurrent: raw.isCurrent.bind(raw) });
    const check = (): void => { signal?.throwIfAborted(); if (!actor.isCurrent()) throw new Error('Desktop caller is no longer current'); };
    check();
    let windows: { ok: true; data: WindowInventory } | { ok: false; error: string };
    try { windows = { ok: true, data: await this.windows(signal) }; }
    catch (error) { check(); windows = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    check();
    // Refresh after the asynchronous worker: stale geometry must not escape as current.
    const displays = this.displays.list(actor);
    check();
    return { displays, windows };
  }
}
