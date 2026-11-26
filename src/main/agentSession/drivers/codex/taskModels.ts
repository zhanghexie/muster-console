import type { AppConfig } from '../../../../shared/types';
import type { CodexModelListResult } from '../../../../shared/codexModels';
import { assertSessionTargetCurrent, resolveSessionTarget, type SessionTarget, type SessionTargetInput } from '../../../sessions/targets';
import { listCodexModels } from './models';

/** Creation reads the catalog in a registered source folder before a session exists. */
export async function listTaskCodexModels(getConfig: () => AppConfig, source: SessionTargetInput, refresh = false,
  query: typeof listCodexModels = listCodexModels,
  onSuccess?: (target: SessionTarget) => void): Promise<CodexModelListResult> {
  try {
    if (!source.workspaceId || !source.rootId) throw new Error('task source folder required');
    const target = await resolveSessionTarget(getConfig(), source);
    assertSessionTargetCurrent(getConfig(), target);
    const result = await query(target.cwd, refresh);
    assertSessionTargetCurrent(getConfig(), target);
    if (result.ok) onSuccess?.(target);
    return result;
  } catch (error) { return { ok: false, error: (error as Error).message || String(error) }; }
}
