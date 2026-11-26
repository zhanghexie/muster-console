import type { AppContext } from '../../context';
import { currentAgentWorkspaceId, isSchedulerInvocation } from '../../agent/agentScope';
import { getCliRuns } from '../../cliRuns/runtimeRef';
import { CliError } from '../../../shared/cli';
import { controlRootFor, requireWorkspace } from '../../workspacePaths';

function scoped(ctx: AppContext, id: string) {
  const service = getCliRuns(), run = service.store.get(id);
  if (!isSchedulerInvocation() || currentAgentWorkspaceId() !== run.workspaceId) throw new CliError('not_authorized', 'CLI run tools require the scheduler identity in this run workspace');
  service.workspace(run.workspaceId);
  return { service, run, root: controlRootFor(requireWorkspace(ctx.config.get(), run.workspaceId)) };
}
export const cliRunsHost = {
  'runs.get': (ctx: AppContext, args: { runId: string }) => { const { service } = scoped(ctx, args.runId); return service.store.view(args.runId); },
  'runs.delegate': (ctx: AppContext, args: { runId: string; task: string; [key: string]: unknown }) => { const { service } = scoped(ctx, args.runId); return service.delegate(args.runId, args); },
  'runs.progress': (ctx: AppContext, args: { runId: string; text: string }) => scoped(ctx, args.runId).service.store.progress(args.runId, args.text),
  'runs.ask': (ctx: AppContext, args: { runId: string; question: string }) => scoped(ctx, args.runId).service.store.question(args.runId, args.question),
  'runs.deliver': (ctx: AppContext, args: { runId: string; summary: string; artifacts: string[]; verification: string }) => {
    const { service, run } = scoped(ctx, args.runId);
    for (const worker of run.workers) {
      if (!worker.sessionId) throw new CliError('workers_not_ready', 'Worker has no linked session');
      const session = ctx.sessions.get(worker.sessionId);
      if (session && (session.workspaceId !== run.workspaceId || session.meta?.creationKey !== 'cli:' + worker.taskId)) throw new CliError('ownership_conflict', `Worker ${worker.sessionId} ownership changed`);
      if (!session || session.queuedInjects || !['needs_you', 'done'].includes(session.phase?.value ?? '') || session.lifecycle === 'working') throw new CliError('workers_not_ready', `Worker ${worker.sessionId} is still executing`);
    }
    return service.store.deliver(args.runId, args.summary, args.artifacts, args.verification);
  },
  'runs.fail': (ctx: AppContext, args: { runId: string; error: string }) => scoped(ctx, args.runId).service.store.fail(args.runId, args.error)
};
