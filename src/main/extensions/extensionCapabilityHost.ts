import type { AppContext } from '../context';
import type { ExtensionAuthoringRequest } from './extensionAuthoring';
import { resolveExtensionToolCaller } from './extensionToolCaller';

type Options = { signal?: AbortSignal };
type Input = Record<string, unknown>;
function system(ctx: AppContext) {
  if (!ctx.extensionSystem) throw new Error('Extension system is not ready');
  return ctx.extensionSystem;
}
function extensionAction(action: ExtensionAuthoringRequest['action']) {
  return (ctx: AppContext, args: Input, options?: Options): Promise<unknown> => system(ctx).authoring.execute(resolveExtensionToolCaller(ctx, options?.signal), { action, params: args });
}

/** Handlers are internal action targets. Caller identity always comes from the host. */
export const extensionHost = {
  'extensions.inspect': extensionAction('inspect'),
  'extensions.list': extensionAction('list'),
  'extensions.bindProject': extensionAction('bindProject'),
  'extensions.create': extensionAction('create'),
  'extensions.write': extensionAction('write'),
  'extensions.removeFile': extensionAction('removeFile'),
  'extensions.submit': extensionAction('submit'),
  'extensions.retryReview': extensionAction('retryReview')
};