import { useSyncExternalStore } from 'react';
import type { WaitingTip, WaitingTipsResult } from '../../shared/waitingTips';

type Snapshot = { enabled: boolean; tips: WaitingTip[]; path: string; error: string | null; loaded: boolean };
let snapshot: Snapshot = { enabled: true, tips: [], path: '', error: null, loaded: false };
let configRevision = 0;
let lastTipKey: string | null = null;

export function waitingTipKey(tip: WaitingTip): string {
  return JSON.stringify([tip['zh-CN'], tip.en]);
}

/** Pick at random while avoiding a repeat, including across successive waiting rows. */
export function pickNextWaitingTip(tips: readonly WaitingTip[], currentKey: string | null): WaitingTip | null {
  if (!tips.length) return null;
  const excluded = currentKey ?? lastTipKey;
  const alternatives = tips.filter(tip => waitingTipKey(tip) !== excluded);
  const candidates = alternatives.length ? alternatives : tips;
  const selected = candidates[Math.floor(Math.random() * candidates.length)]!;
  lastTipKey = waitingTipKey(selected);
  return selected;
}
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let reading = false;
function publish(next: Snapshot): void {
  if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
  snapshot = next;
  for (const listener of listeners) listener();
}
export function setWaitingTipsEnabled(enabled: boolean): void {
  configRevision++;
  publish({ ...snapshot, enabled });
}
export function initWaitingTipsPreference(): void {
  const revision = configRevision;
  void window.api.config.get().then(config => {
    if (revision === configRevision) setWaitingTipsEnabled(config.showWaitingTips !== false);
  }).catch(error => console.error('[waiting-tips] Failed to load preference:', error));
}
export async function refreshWaitingTips(): Promise<void> {
  if (reading) return;
  reading = true;
  try {
    const result: WaitingTipsResult = await window.api.config.waitingTips();
    if (!result || typeof result.ok !== 'boolean') throw new Error('Invalid response');
    if (result.ok) publish({ ...snapshot, path: result.path, tips: result.tips, error: null, loaded: true });
    else publish({ ...snapshot, path: result.path, error: result.error, loaded: true });
  } catch (error) {
    publish({ ...snapshot, error: error instanceof Error ? error.message : String(error), loaded: true });
  } finally { reading = false; }
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshWaitingTips();
    timer = setInterval(() => { void refreshWaitingTips(); }, 5000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) { clearInterval(timer); timer = undefined; }
  };
}
export function useWaitingTips(): Snapshot { return useSyncExternalStore(subscribe, () => snapshot); }
