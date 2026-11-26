import type { WorkerRoutingFollowGlobalInput, WorkerRoutingLayer, WorkerRoutingReadInput, WorkerRoutingResetCooldownInput, WorkerRoutingSaveInput, WorkerRoutingScope } from '../../shared/workerRouting';
import type { AppContext } from '../context';
import { resolveSessionTarget } from '../sessions/targets';
import { clearRoutingCooldown, followGlobalWorkerRouting, mintWorkerReference, routingSettings, saveWorkerRoutingSettings, validateWorkerReference } from '../tasks/workerRouting';
import { optionText, WorkerOptionError } from '../tasks/workerRoutingCatalog';
import { handle } from './handle';

export function registerWorkerRoutingIpc(ctx: AppContext): void {
  const target = (scope: WorkerRoutingScope) => {
    if (!scope || !optionText(scope.workspaceId) || !optionText(scope.rootId) || !Number.isSafeInteger(scope.rootsRevision) || scope.rootsRevision < 0 ||
        (scope.cwd !== undefined && !optionText(scope.cwd, 8192))) throw new WorkerOptionError('Choose a current Workspace source folder.');
    return resolveSessionTarget(ctx.config.get(), { workspaceId: scope.workspaceId, rootId: scope.rootId, rootsRevision: scope.rootsRevision, cwd: scope.cwd });
  };
  const layer = (value: unknown): WorkerRoutingLayer => {
    if (value !== 'global' && value !== 'workspace') throw new WorkerOptionError('Choose the global or workspace Worker routing settings.');
    return value;
  };
  handle('workerRouting:read', async (_event, args: WorkerRoutingReadInput) => routingSettings(ctx, await target(args?.scope), layer(args?.layer)));
  handle('workerRouting:save', async (_event, args: WorkerRoutingSaveInput) => saveWorkerRoutingSettings(ctx, await target(args?.scope), { ...args, layer: layer(args?.layer) }));
  handle('workerRouting:followGlobal', async (_event, args: WorkerRoutingFollowGlobalInput) =>
    followGlobalWorkerRouting(ctx, await target(args?.scope), args?.expectedVersion));
  handle('workerRouting:reference', async (_event, args: { scope: WorkerRoutingScope; config: unknown }) => mintWorkerReference(ctx, await target(args?.scope), args?.config));
  handle('workerRouting:validate', async (_event, args: { scope: WorkerRoutingScope; targetRef: string }) => validateWorkerReference(ctx, await target(args?.scope), args?.targetRef));
  handle('workerRouting:resetCooldown', async (_event, args: WorkerRoutingResetCooldownInput) => {
    const source = await target(args?.scope);
    return clearRoutingCooldown(ctx, source, layer(args?.layer), args?.expectedVersion, args?.memberId);
  });
}
