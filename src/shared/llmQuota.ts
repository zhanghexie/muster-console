/**
 * R11：用量/配额预检纯函数。
 * 产品决策（保守默认）：本地不调厂商计费 API，remaining 恒为 unknown；
 * 401 与 429/quota 从错误文案拆开（不再混进「流错误」）。
 */

export const DEFAULT_QUOTA_WINDOW_MS = 15 * 60 * 1000;

export type LlmErrorClass = 'auth' | 'rate_limit' | 'other';

export interface QuotaSample {
  ok: boolean;
  error?: string;
  startedAt: number;
  providerHint?: string;
  providerId?: string;
}

export interface LlmQuotaView {
  providerId: string;
  remaining: null;
  remainingSource: 'not-exposed';
  windowMs: number;
  sampleCount: number;
  failCount: number;
  failRate: number;
  classified: { auth: number; rate_limit: number; other: number };
  rateLimited: boolean;
  authFailed: boolean;
  resetAt: number | null;
}

export function normalizeQuotaWindowMs(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_QUOTA_WINDOW_MS;
  const n = Math.floor(raw);
  if (n < 60_000) return 60_000;
  if (n > 24 * 60 * 60 * 1000) return 24 * 60 * 60 * 1000;
  return n;
}

export function classifyLlmError(error: string | undefined): LlmErrorClass | null {
  if (!error || !error.trim()) return null;
  const s = error.toLowerCase();
  if (
    /\b401\b/.test(s) ||
    /unauthorized/.test(s) ||
    /invalid[_\s-]?api[_\s-]?key/.test(s) ||
    /authentication/.test(s) ||
    /incorrect api key/.test(s)
  ) {
    return 'auth';
  }
  if (
    /\b429\b/.test(s) ||
    /rate[_\s-]?limit/.test(s) ||
    /too many requests/.test(s) ||
    /quota[_\s-]?(exceeded|exhausted)/.test(s) ||
    /insufficient[_\s-]?quota/.test(s) ||
    /resource has been exhausted/.test(s) ||
    /速率限制|使用上限|限额.*重置/.test(s)
  ) {
    return 'rate_limit';
  }
  return 'other';
}

export function sampleMatchesProvider(sample: QuotaSample, providerId: string): boolean {
  if (!providerId) return true;
  if (sample.providerId) return sample.providerId.toLowerCase() === providerId.toLowerCase();
  const hint = (sample.providerHint ?? '').toLowerCase();
  if (!hint) return true;
  return hint === providerId.toLowerCase() || hint.includes(providerId.toLowerCase());
}

export function computeLlmQuota(
  samples: readonly QuotaSample[],
  providerId: string,
  now: number,
  windowMs: number
): LlmQuotaView {
  const from = now - windowMs;
  const matching = samples.filter((s) => s.startedAt <= now && sampleMatchesProvider(s, providerId));
  const inWin = matching.filter((s) => s.startedAt >= from);
  // 智谱错误中的北京时间重置提示可跨越近窗；过期后自动解除，不推测余额。
  const resets = matching.filter(s => !s.ok && classifyLlmError(s.error) === 'rate_limit')
    .map(s => s.error?.match(/限额将在\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s*重置/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map(m => Date.parse(`${m[1]}T${m[2]}+08:00`)).filter(ts => ts > now);
  const resetAt = resets.length ? Math.max(...resets) : null;
  const classified = { auth: 0, rate_limit: 0, other: 0 };
  let failCount = 0;
  for (const s of inWin) {
    if (s.ok) continue;
    failCount += 1;
    const c = classifyLlmError(s.error) ?? 'other';
    classified[c] += 1;
  }
  const sampleCount = inWin.length;
  return {
    providerId,
    remaining: null,
    remainingSource: 'not-exposed',
    windowMs,
    sampleCount,
    failCount,
    failRate: sampleCount === 0 ? 0 : failCount / sampleCount,
    classified,
    rateLimited: classified.rate_limit > 0 || resetAt !== null,
    resetAt,
    authFailed: classified.auth > 0
  };
}
