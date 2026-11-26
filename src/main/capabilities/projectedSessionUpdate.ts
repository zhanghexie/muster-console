import { executeSessionUpdate, planSessionUpdate, type SessionUpdateInput, type SessionUpdateOperation } from './sessionUpdate';

const RUN_TARGETS = new Set(['sessions.setPinned', 'sessions.setOrchestrated', 'sessions.setModel', 'sessions.setThinking']);

export function sessionUpdatePermissionSource(tool: string, sources: readonly string[]): string {
  if (sources.includes(tool)) return tool;
  if (RUN_TARGETS.has(tool) && sources.includes('sessions.run')) return 'sessions.run';
  throw new Error(`Session update source is not authorized: ${tool}`);
}

export function planProjectedSessionUpdate(input: SessionUpdateInput,
  caller: { kind: 'scheduler' } | { kind: 'worker'; sessionId: string },
  target: { id: string; parentSessionId?: string } | undefined): SessionUpdateOperation[] {
  if (!input?.sessionId && caller.kind === 'scheduler') {
    if (Object.keys(input ?? {}).some(key => key !== 'sessionId' && key !== 'name') || typeof input?.name !== 'string' || !input.name.trim()) {
      throw new Error('Only the scheduler title can be changed without a session target');
    }
    return [{ tool: 'sessions.rename', args: { sessionId: '', name: input.name.trim() } }];
  }
  if (!target?.id) throw new Error('Session update target is unavailable');
  return planSessionUpdate({ ...input, sessionId: input.sessionId || (caller.kind === 'worker' ? caller.sessionId : '') }, caller, target);
}

/** Preflight every individual old permission before allowing the combined request to mutate. */
export async function executeProjectedSessionUpdate(input: SessionUpdateInput,
  caller: { kind: 'scheduler' } | { kind: 'worker'; sessionId: string },
  target: { id: string; parentSessionId?: string } | undefined, sources: readonly string[], deps: {
    authorize(source: string, operation: Readonly<SessionUpdateOperation>): Promise<() => boolean>;
    isCurrent(): boolean;
    execute(operation: SessionUpdateOperation): Promise<unknown>;
  }): ReturnType<typeof executeSessionUpdate> {
  if (!deps || typeof deps.authorize !== 'function' || typeof deps.isCurrent !== 'function' || typeof deps.execute !== 'function') {
    throw new Error('Session update authorization is unavailable');
  }
  const requested = planProjectedSessionUpdate(input, caller, target);
  const operations = requested.map(operation => {
    const args = { ...operation.args };
    if ('sessionIds' in args) args.sessionIds = Object.freeze([...args.sessionIds]) as unknown as string[];
    return Object.freeze({ ...operation, args: Object.freeze(args) }) as SessionUpdateOperation;
  });
  const planned = operations.map(operation => ({ operation, source: sessionUpdatePermissionSource(operation.tool, sources) }));
  const current = (): void => { if (!deps.isCurrent()) throw new Error('Session update caller or target changed'); };
  current();
  const guards: Array<() => boolean> = [];
  for (const item of planned) {
    const guard = await deps.authorize(item.source, item.operation); current();
    if (typeof guard !== 'function' || !guard()) throw new Error('Session update authorization changed');
    guards.push(guard);
  }
  return executeSessionUpdate(operations, async operation => {
    current();
    if (guards.some(guard => !guard())) throw new Error('Session update authorization changed');
    return deps.execute(operation);
  });
}
