export interface WaitingTip { 'zh-CN': string; en: string }
export type WaitingTipsResult =
  | { ok: true; path: string; tips: WaitingTip[] }
  | { ok: false; path: string; error: string };

/** Reject malformed data as a whole; never silently display a partial list. */
export function parseWaitingTips(raw: unknown): WaitingTip[] {
  if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 1 || !Array.isArray((raw as { tips?: unknown }).tips))
    throw new Error('Expected version 1 and a tips array');
  const tips = (raw as { tips: unknown[] }).tips;
  if (tips.length > 200) throw new Error('At most 200 tips are allowed');
  return tips.map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`Tip ${index + 1} must be an object`);
    const item = value as Record<string, unknown>;
    if (typeof item['zh-CN'] !== 'string' || typeof item.en !== 'string' || !item['zh-CN'].trim() || !item.en.trim() || item['zh-CN'].length > 300 || item.en.length > 300)
      throw new Error(`Tip ${index + 1} needs non-empty zh-CN and en text (max 300 characters)`);
    return { 'zh-CN': item['zh-CN'].trim(), en: item.en.trim() };
  });
}
