import type { AppContext } from '../../context';
import { controlRootFor } from '../../../shared/workspaceRoots';
import { HOST_ACTOR_BOUND_TOOL_IDS } from '../../../shared/hostTools';

/** These fields are overwritten at the authenticated GUI/HTTP boundary. */
export const ACTOR_SESSION_ID_ARG = '__actorSessionId';
export const ACTOR_BOUND_TOOL_IDS: readonly string[] = HOST_ACTOR_BOUND_TOOL_IDS;
export function resolveToolActor(args?: Record<string, unknown>) {
  const id = typeof args?.[ACTOR_SESSION_ID_ARG] === 'string' ? args[ACTOR_SESSION_ID_ARG].trim() : '';
  return id ? { role: 'worker' as const, id } : { role: 'host' as const, id: 'host' };
}
export function resolveActorWorkspaceId(ctx: AppContext, args?: Record<string, unknown>): string {
  const actor = resolveToolActor(args);
  if (actor.role === 'worker') {
    const parent = actor.id.startsWith('bg-')
      ? ctx.bgTasks?.taskParentPairs().find(task => task.id === actor.id.slice(3))?.parentSessionId : undefined;
    const workspaceId = ctx.sessions.get(parent ?? actor.id)?.workspaceId;
    if (!workspaceId) throw new Error('actor workspace is unavailable');
    return workspaceId;
  }
  return (typeof args?.workspaceId === 'string' ? args.workspaceId.trim() : '') || ctx.resolveBubbleWorkspaceId();
}
export function resolveActorControlRoot(ctx: AppContext, args?: Record<string, unknown>): string {
  const workspaceId = resolveActorWorkspaceId(ctx, args);
  const matches = ctx.workspaces.list().filter(w => w.id === workspaceId);
  if (matches.length !== 1) throw new Error('workspace not found or ambiguous');
  return controlRootFor(matches[0]!);
}
