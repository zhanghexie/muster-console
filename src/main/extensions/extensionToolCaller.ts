import { AsyncLocalStorage } from 'node:async_hooks';
import type { AppContext } from '../context';
import type { WorkspaceExecutionContext } from '../../shared/workspaceExecutionContext';
import { currentAgentSessionId, isSchedulerInvocation } from '../agent/agentScope';
import { assertWorkspaceExecutionContextCurrent, captureWorkspaceExecutionContext } from '../workspaceExecutionContext';
import type { ExtensionAuthoringCaller } from './extensionAuthoring';

interface SchedulerCaller { context: WorkspaceExecutionContext; actor: string }
const schedulerCaller = new AsyncLocalStorage<SchedulerCaller>();

/** Capture a scheduler session's trusted project and draft owner at session creation. */
export function runAsExtensionSchedulerCaller<T>(context: WorkspaceExecutionContext, actor: string, fn: () => T): T {
  if (!actor || actor.length > 500 || actor.includes('\0')) throw new Error('Invalid scheduler extension identity');
  return schedulerCaller.run({ context, actor }, fn);
}

/** Resolve the authenticated caller; model arguments cannot select another workspace or project. */
export function resolveExtensionToolCaller(ctx: AppContext, signal?: AbortSignal): ExtensionAuthoringCaller {
  const sessionId = currentAgentSessionId();
  if (sessionId) {
    const session = ctx.sessions.peek(sessionId);
    if (!session) throw new Error('Extension caller session no longer exists');
    const context = captureWorkspaceExecutionContext(ctx.config.get(), session, ctx.sessions.list());
    if (!context) throw new Error('Extension caller has no bound workspace and project');
    assertWorkspaceExecutionContextCurrent(ctx.config.get(), context);
    return { workspaceId: context.workspaceId, sourceRootId: context.sourceRootId, actor: `session:${sessionId}`, ...(signal ? { signal } : {}) };
  }
  const scheduler = schedulerCaller.getStore();
  if (!scheduler || !isSchedulerInvocation()) throw new Error('Extension caller identity is unavailable');
  assertWorkspaceExecutionContextCurrent(ctx.config.get(), scheduler.context);
  return { workspaceId: scheduler.context.workspaceId, sourceRootId: scheduler.context.sourceRootId, actor: `scheduler:${scheduler.actor}`, ...(signal ? { signal } : {}) };
}
