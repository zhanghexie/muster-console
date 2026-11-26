import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { FreeCanvasHandle } from './types';
import type { FreePoint, FreePort } from '../freeViewGeom';

const KEY = 'muster:canvas-queued-handovers-v1';
type Placement = { id: string; from: string; port: FreePort; world: FreePoint; at: number };

function read(): Placement[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is Placement => !!item && typeof item.id === 'string' && typeof item.from === 'string' &&
      ['n', 'e', 's', 'w'].includes(item.port) && Number.isFinite(item.world?.x) && Number.isFinite(item.world?.y) &&
      Number.isFinite(item.at) && Date.now() - item.at < 30 * 24 * 60 * 60 * 1000).slice(-100);
  } catch { return []; }
}

export function rememberQueuedHandover(placement: Omit<Placement, 'at'>): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify([...read().filter(item => item.id !== placement.id), { ...placement, at: Date.now() }]));
    return true;
  } catch { return false; }
}

/** Queue items have no session yet. Place the node when its reserved ID appears. */
export function useQueuedHandoverPlacement(sessions: readonly { id: string }[], canvas: RefObject<FreeCanvasHandle>, active = true): void {
  useEffect(() => {
    if (!canvas.current) return;
    const pending = read();
    const ids = new Set(sessions.map(session => session.id));
    const ready = pending.filter(item => ids.has(item.id));
    if (!ready.length) return;
    for (const item of ready) canvas.current.placeSession(item.id, item.world, { id: item.from, port: item.port, kind: 'handover' });
    try { localStorage.setItem(KEY, JSON.stringify(pending.filter(item => !ids.has(item.id)))); }
    catch (error) { console.error('[handover] 无法清理已落位的排队记录', error); }
  }, [sessions, canvas, active]);
}
