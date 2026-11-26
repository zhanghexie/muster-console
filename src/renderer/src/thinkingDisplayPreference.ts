import { useSyncExternalStore } from 'react';

let liveOnly = true;
let revision = 0;
const listeners = new Set<() => void>();
export function setLiveThinkingOnly(value: boolean): void {
  revision++;
  if (liveOnly === value) return;
  liveOnly = value;
  for (const listener of listeners) listener();
}
export function initThinkingDisplayPreference(): void {
  const before = revision;
  void window.api.config.get().then(config => {
    if (before === revision) setLiveThinkingOnly(config.liveThinkingOnly !== false);
  }).catch(error => console.error('[thinking-display] Failed to load preference:', error));
}
export function useLiveThinkingOnly(): boolean {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => liveOnly);
}
