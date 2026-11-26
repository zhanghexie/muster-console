import { useSyncExternalStore } from 'react';

// 关闭面板时 GlobalBoard 也订阅：无信号提醒不依赖其他会话的广播。
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let now = Date.now();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 5000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { clearInterval(timer); timer = undefined; }
  };
}
export function useBoardClock(): number {
  return useSyncExternalStore(subscribe, () => now);
}
