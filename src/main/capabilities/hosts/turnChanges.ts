import type { AppContext } from '../../context';
import { currentAgentSessionId, currentAgentWorkspaceId, isSchedulerInvocation } from '../../agent/agentScope';
import { isHeadlessTurn } from '../../agent/turnScope';
import { turnChanges } from '../../turnChanges/runtime';

/** Caller identity comes from the trusted tool scope, never the model's arguments. */
export const turnChangesHost = {
  'turnChanges.trackFiles': async (_ctx: AppContext, args: { action?: unknown; paths?: unknown; rootId?: unknown; captureId?: unknown }) => {
    const session = currentAgentSessionId(), workspace = currentAgentWorkspaceId();
    const owner = session ? `gui:${session}` : isSchedulerInvocation() && workspace && !isHeadlessTurn() ? `dispatch:${workspace}` : undefined;
    const tracker = owner && turnChanges().activeForOwner(owner);
    if (!tracker) throw new Error('No active review turn is available for this caller.');
    if (!Array.isArray(args.paths) || !args.paths.length || args.paths.some(item => typeof item !== 'string')) throw new Error('paths must contain exact file paths.');
    if (args.action === 'begin') {
      if (args.captureId !== undefined) throw new Error('captureId is only accepted for complete.');
      if (args.rootId !== undefined && typeof args.rootId !== 'string') throw new Error('rootId must be a string.');
      return { captureId: await tracker.beginFiles(args.paths as string[], args.rootId as string | undefined) };
    }
    if (args.action === 'complete') {
      if (args.rootId !== undefined) throw new Error('rootId is only accepted for begin.');
      if (typeof args.captureId !== 'string' || !args.captureId) throw new Error('captureId is required.');
      await tracker.completeFiles(args.captureId, args.paths as string[]);
      return { completed: true };
    }
    throw new Error('Choose begin or complete.');
  }
};
