import { HARNESS_CATALOG } from '../../shared/harnessCatalog';
import type { SessionMeta } from '../../shared/types';

/** Resolve the product identity persisted on a session, independently of its model. */
export function sessionHarness(session: SessionMeta, runtimeLabel = ''): { id: string; name: string } | undefined {
  const runtime = session.type === 'terminal' && session.launchKind !== 'shell' ? session.runtime?.trim() : undefined;
  if (!runtime) return undefined;
  const key = runtime === 'acp' ? session.piModeId?.trim() || 'acp' : runtime;
  const entry = runtime === 'acp'
    ? HARNESS_CATALOG.find(item => item.acpPresetId === key)
    : HARNESS_CATALOG.find(item => item.runtimeId === key || item.cliRuntimeId === key);
  const fallback = runtime === 'acp' ? (key === 'acp' ? 'ACP' : key) : runtimeLabel || key;
  return { id: entry?.id ?? key, name: entry?.name ?? fallback };
}
