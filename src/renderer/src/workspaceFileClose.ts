export interface WorkspaceCloseFile { id: string; identity: string; docked: boolean }
type Result = { ok: true } | { ok: false; error: string };
type DockTransaction = { ok: true; commit(): Result; rollback(): Result } | { ok: false; error: string };
export interface WorkspaceFileCloseTransaction { commit(): void; rollback(): void }
type WorkspaceFileCloseHandler = (workspaceId: string) => Promise<WorkspaceFileCloseTransaction>;
const handlers = new Set<WorkspaceFileCloseHandler>();
const pending = new Set<string>();
export function registerWorkspaceFileClose(handler: WorkspaceFileCloseHandler): () => void {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}
export const isWorkspaceFileClosePending = (workspaceId: string): boolean => pending.has(workspaceId);
export async function prepareWorkspaceFileClose(workspaceId: string): Promise<WorkspaceFileCloseTransaction> {
  if (!workspaceId) throw new Error('Workspace identity is required');
  if (pending.has(workspaceId)) throw new Error('Workspace close is already pending');
  if (handlers.size !== 1) throw new Error('Workspace file surface is unavailable or ambiguous');
  const handler = [...handlers][0]!;
  pending.add(workspaceId);
  try {
    const transaction = await handler(workspaceId);
    if (handlers.size !== 1 || !handlers.has(handler)) {
      transaction.rollback();
      throw new Error('Workspace file surface changed during preparation');
    }
    let finished = false;
    const finish = (action: 'commit' | 'rollback'): void => {
      if (finished) throw new Error('Workspace close transaction is already finished');
      finished = true;
      try { transaction[action](); } finally { pending.delete(workspaceId); }
    };
    return { commit: () => finish('commit'), rollback: () => finish('rollback') };
  } catch (error) { pending.delete(workspaceId); throw error; }
}

/** Caller must prevent new edits and opens until the returned transaction finishes. */
export async function prepareWorkspaceFiles(ops: {
  read(): readonly WorkspaceCloseFile[];
  dirty(): boolean;
  flush(id: string): Promise<void>;
  begin(ids: string[]): DockTransaction;
  remove(): void;
}): Promise<{ commit(): void; rollback(): void }> {
  const snapshot = ops.read().map(item => ({ ...item }));
  if (new Set(snapshot.map(item => item.id)).size !== snapshot.length) throw new Error('Duplicate workspace file identity');
  const current = (): boolean => JSON.stringify(ops.read()) === JSON.stringify(snapshot);
  for (const item of snapshot) {
    await ops.flush(item.id);
    if (!current()) throw new Error('Workspace files changed during preparation');
  }
  if (ops.dirty()) throw new Error('Workspace has unsaved files');
  const dock = ops.begin(snapshot.filter(item => item.docked).map(item => item.id));
  if (!dock.ok) throw new Error(dock.error);
  const check = (): void => { if (!current() || ops.dirty()) throw new Error('Workspace files changed or are unsaved'); };
  try { check(); }
  catch (error) {
    const rollback = dock.rollback();
    const reason = error instanceof Error ? error.message : String(error);
    if (!rollback.ok) throw new Error(`${reason}; rollback failed: ${rollback.error}`);
    throw error;
  }
  let finished = false;
  return {
    commit: () => {
      if (finished) throw new Error('Workspace close transaction is already finished');
      try { check(); }
      catch (error) {
        finished = true;
        const rollback = dock.rollback();
        const reason = error instanceof Error ? error.message : String(error);
        if (!rollback.ok) throw new Error(`${reason}; rollback failed: ${rollback.error}`);
        throw error;
      }
      finished = true;
      const result = dock.commit();
      if (!result.ok) throw new Error(result.error);
      ops.remove();
    },
    rollback: () => {
      if (finished) throw new Error('Workspace close transaction is already finished');
      finished = true;
      const result = dock.rollback();
      if (!result.ok) throw new Error(result.error);
    }
  };
}
