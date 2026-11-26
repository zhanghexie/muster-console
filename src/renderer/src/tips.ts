export interface AppTip {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

let current: AppTip | null = null;
let sequence = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

export const getTipSnapshot = (): AppTip | null => current;
export function subscribeTips(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function dismissTip(id?: number): void {
  if (id !== undefined && current?.id !== id) return;
  clearTimeout(timer);
  timer = undefined;
  if (!current) return;
  current = null;
  listeners.forEach(listener => listener());
}

/** Window-wide transient feedback; a newer tip replaces the previous one. */
export function showTip(message: string, options: { tone?: AppTip['tone']; durationMs?: number } = {}): void {
  const text = message.trim();
  if (!text) return;
  clearTimeout(timer);
  const id = ++sequence;
  current = { id, text, tone: options.tone ?? 'info' };
  const duration = Number.isFinite(options.durationMs) ? Math.max(1000, Math.min(10000, options.durationMs!)) : 3500;
  timer = setTimeout(() => dismissTip(id), duration);
  listeners.forEach(listener => listener());
}
