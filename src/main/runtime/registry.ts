import type { RuntimeHost } from './host';
import { t } from '../../shared/i18n';

/**
 * 对照 RuntimeHost 校验 runtime id。
 * 未知 id 直接抛错，不再静默落到 cursor-cli。
 */
export function normalizeRuntimeKey(
  value: string | undefined | null,
  runtimes: RuntimeHost,
  fallback?: string
): string {
  const id = (typeof value === 'string' ? value.trim() : '') || (fallback?.trim() ?? '');
  if (!id) {
    throw new Error(t('runtime 未指定'));
  }
  if (!runtimes.get(id)) {
    throw new Error(t('runtime 未注册: {{id}}', { id }));
  }
  return id;
}
