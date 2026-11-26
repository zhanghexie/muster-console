
import { t } from './i18n';

const QUEUE_SUFFIX = /\s*·\s*(?:排队|queued\s*)\d+$/i;
const QUEUE_ONLY = /^(?:排队注入\s+\d+\s*条|\d+\s+injects?\s+queued)$/i;

export function countInjectQueued(queue: ReadonlyArray<{ fromInject?: boolean }>): number {
  let n = 0;
  for (const q of queue) if (q.fromInject) n += 1;
  return n;
}

/** 去掉上次叠上的「· 排队N」/「排队注入 N 条」，避免重复追加。 */
export function stripInjectQueueSuffix(label: string): string {
  const s = label.trim();
  if (!s) return '';
  if (QUEUE_ONLY.test(s)) return '';
  return s.replace(QUEUE_SUFFIX, '').trim();
}

/**
 * 左栏胶囊：有未消化注入时叠「· 排队N」；无底文则「排队注入 N 条」。
 * 总长 ≤40（与 setLiveStatus 一致）。
 */
export function formatInjectQueueCapsule(baseLabel: string | undefined, pending: number): string {
  const n = Math.max(0, Math.floor(Number(pending) || 0));
  const base = stripInjectQueueSuffix(baseLabel ?? '');
  if (n <= 0) return base;
  if (!base) return t('排队注入 {{n}} 条', { n }).slice(0, 40);
  const suffix = t(' · 排队{{n}}', { n });
  const budget = 40 - suffix.length;
  const head = budget > 0 && base.length > budget ? base.slice(0, budget) : base;
  return `${head}${suffix}`.slice(0, 40);
}
