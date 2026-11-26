import type { AppContext } from './context';
import type { WorkspaceSwitchResult } from '../shared/types';
import { t } from '../shared/i18n';

/** Close the workspace view after revoking its desktop execution scope. */
export function closeWorkspaceWithSessions(ctx: AppContext, id: string): WorkspaceSwitchResult {
  const error = ctx.workspaces.closeError(id);
  if (error) return { ok: false, message: error };
  try {
    ctx.desktopEpochs?.endScheduler?.(id);
  } catch (error) {
    return { ok: false, message: t('工作区关闭失败：{{error}}', { error: error instanceof Error ? error.message : String(error) }) };
  }
  return ctx.workspaces.close(id);
}

export interface WorkspaceClosePreparation {
  commit(result: WorkspaceSwitchResult): Promise<void>;
  rollback(): Promise<void>;
}

/** Prepare the renderer before closing; keep the workspace open on any preflight failure. */
export async function closeWorkspaceCoordinated(ctx: AppContext, id: string,
  prepare: (id: string) => Promise<WorkspaceClosePreparation>, beforeClose?: () => void): Promise<WorkspaceSwitchResult> {
  const initialError = ctx.workspaces.closeError(id);
  if (initialError) return { ok: false, message: initialError };
  let transaction: WorkspaceClosePreparation;
  try { transaction = await prepare(id); }
  catch (error) { return { ok: false, message: `Workspace close preparation failed: ${error instanceof Error ? error.message : String(error)}` }; }
  let result: WorkspaceSwitchResult;
  try { beforeClose?.(); result = closeWorkspaceWithSessions(ctx, id); }
  catch (error) { result = { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  if (!result.ok) {
    try { await transaction.rollback(); }
    catch (error) { return { ...result, message: `${result.message ?? 'Workspace close failed'}; rollback failed, inspect views: ${error instanceof Error ? error.message : String(error)}` }; }
    return result;
  }
  try { await transaction.commit(result); }
  catch (error) { return { ...result, ok: false, message: `Workspace closed, but view cleanup failed: ${error instanceof Error ? error.message : String(error)}` }; }
  return result;
}
