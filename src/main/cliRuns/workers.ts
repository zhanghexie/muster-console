import { CliError } from '../../shared/cli';
import type { DelegateTaskResult } from '../tasks/delegate';
import type { CliRun, CliWorker } from './runtime';
export function cliWorkerFromDelegate(result: DelegateTaskResult, taskId?: string): CliWorker {
  const sessionId = result.session?.id;
  if (!sessionId || !taskId) throw new Error('Delegation completed without a linked worker');
  return { taskId, sessionId, runtime: result.session!.runtime };
}
export function assertCliWorkerOwnership(run: CliRun, worker: CliWorker,
  session: { id: string; workspaceId?: string; meta?: Record<string,string> }) {
  if (session.id !== worker.sessionId || session.workspaceId !== run.workspaceId || session.meta?.creationKey !== 'cli:' + worker.taskId) {
    throw new CliError('ownership_conflict', 'Worker ownership changed; interruption was refused');
  }
}
