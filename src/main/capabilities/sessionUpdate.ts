/** The old setters have different caller rights; combining their schema must not combine their authority. */
export interface SessionUpdateInput {
  sessionId?: string;
  name?: string;
  pinned?: boolean;
  archived?: boolean;
  orchestrated?: boolean;
  model?: { providerId: string; modelId: string } | null;
  thinking?: 'off' | 'low' | 'medium' | 'high' | 'max' | null;
}
export type SessionUpdateOperation =
  | { tool: 'sessions.rename'; args: { sessionId: string; name: string } }
  | { tool: 'sessions.setPinned'; args: { sessionId: string; pinned: boolean } }
  | { tool: 'sessions.setArchived'; args: { sessionIds: string[]; archived: boolean; __actorSessionId?: string } }
  | { tool: 'sessions.setOrchestrated'; args: { sessionId: string; orchestrated: boolean } }
  | { tool: 'sessions.setModel'; args: { sessionId: string; providerId?: string; modelId?: string } }
  | { tool: 'sessions.setThinking'; args: { sessionId: string; level: string | null } };

/** Validate the complete request before executing any setter. Identity is supplied by the host. */
export function planSessionUpdate(
  input: SessionUpdateInput,
  caller: { kind: 'scheduler' } | { kind: 'worker'; sessionId: string },
  target: { id: string; parentSessionId?: string }
): SessionUpdateOperation[] {
  if (!input || !target?.id || input.sessionId !== target.id) throw new Error('Invalid session update target');
  const allowed = new Set(['sessionId', 'name', 'pinned', 'archived', 'orchestrated', 'model', 'thinking']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('Unknown session update field');
  const keys = Object.keys(input).filter(key => key !== 'sessionId');
  if (!keys.length) throw new Error('At least one session update field is required');
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) throw new Error('name must be non-empty');
  for (const field of ['pinned', 'archived', 'orchestrated'] as const) {
    if (input[field] !== undefined && typeof input[field] !== 'boolean') throw new Error(`${field} must be a boolean`);
  }
  if (input.model !== undefined && input.model !== null &&
      (!input.model || typeof input.model !== 'object' || Array.isArray(input.model) ||
       Object.keys(input.model).some(key => key !== 'providerId' && key !== 'modelId') ||
       typeof input.model.providerId !== 'string' || typeof input.model.modelId !== 'string' ||
       !input.model.providerId.trim() || !input.model.modelId.trim())) throw new Error('model requires providerId and modelId, or null');
  if (input.thinking !== undefined && input.thinking !== null &&
      !['off', 'low', 'medium', 'high', 'max'].includes(input.thinking)) throw new Error('Invalid thinking level');
  if (caller.kind === 'worker') {
    if (input.name !== undefined && target.id !== caller.sessionId) throw new Error('Worker can rename only its own session');
    if (input.archived !== undefined && target.parentSessionId !== caller.sessionId) throw new Error('Worker can archive only its direct child');
    if (input.pinned !== undefined || input.orchestrated !== undefined || input.model !== undefined || input.thinking !== undefined) {
      throw new Error('This update field is available only to the scheduler');
    }
  }
  const id = target.id;
  const operations: SessionUpdateOperation[] = [];
  if (input.name !== undefined) operations.push({ tool: 'sessions.rename', args: { sessionId: id, name: input.name.trim() } });
  if (input.pinned !== undefined) operations.push({ tool: 'sessions.setPinned', args: { sessionId: id, pinned: input.pinned } });
  if (input.orchestrated !== undefined) operations.push({ tool: 'sessions.setOrchestrated', args: { sessionId: id, orchestrated: input.orchestrated } });
  if (input.model !== undefined) operations.push({ tool: 'sessions.setModel', args: { sessionId: id, ...(input.model ?? {}) } });
  if (input.thinking !== undefined) operations.push({ tool: 'sessions.setThinking', args: { sessionId: id, level: input.thinking } });
  // Archiving can stop the target. Always do it after the other requested updates.
  if (input.archived !== undefined) operations.push({ tool: 'sessions.setArchived', args: { sessionIds: [id], archived: input.archived,
    ...(caller.kind === 'worker' ? { __actorSessionId: caller.sessionId } : {}) } });
  return operations;
}

/** Each old setter has its own failure modes; report completed effects rather than claiming atomicity. */
export async function executeSessionUpdate(
  operations: readonly SessionUpdateOperation[],
  execute: (operation: SessionUpdateOperation) => Promise<unknown>
): Promise<{ ok: boolean; completed: Array<{ tool: string; result: unknown }>; failed?: { tool: string; error: string } }> {
  const completed: Array<{ tool: string; result: unknown }> = [];
  for (const operation of operations) {
    try {
      const result = await execute(operation);
      const value = result && typeof result === 'object' ? result as { ok?: unknown; failed?: unknown } : undefined;
      if (value?.ok === false || (Array.isArray(value?.failed) && value.failed.length > 0)) {
        return { ok: false, completed, failed: { tool: operation.tool, error: JSON.stringify(result) } };
      }
      completed.push({ tool: operation.tool, result });
    } catch (error) {
      return { ok: false, completed, failed: { tool: operation.tool, error: error instanceof Error ? error.message : String(error) } };
    }
  }
  return { ok: true, completed };
}
