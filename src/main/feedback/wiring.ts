import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import path from 'node:path';
import { app, clipboard, net } from 'electron';
import type { AppContext } from '../context';
import { FeedbackService } from './service';
import { createDirectFeedbackRemote } from './directRemote';
import { DEFAULT_FEEDBACK_TARGET } from '../../shared/feedback';
import { createFeedbackAiRechecker } from './aiRecheck';
import { openExternalUrl } from '../shell/reveal';

const recheckRequests = new WeakMap<AppContext, ReturnType<typeof createFeedbackAiRechecker>>();
/** Retry deferred AI checks after the scheduler becomes available. */
export function requestFeedbackAiCheck(ctx: AppContext): void { recheckRequests.get(ctx)?.request(); }
export function onFeedbackSchedulerIdle(ctx: AppContext, workspace: string): void {
  const rechecker = recheckRequests.get(ctx);
  rechecker?.onIdle(workspace);
  rechecker?.request();
}

export function createFeedbackService(ctx: AppContext): FeedbackService {
  const fetcher = ((input, init) => net.fetch(input instanceof URL ? input.href : input, init)) as typeof fetch;
  const rechecker = createFeedbackAiRechecker({ needsCheck: () => !!ctx.feedback?.needsAiCheck(),
    scheduler: () => ctx.orchestrator, workspace: () => ctx.resolveBubbleWorkspaceId(),
    incomplete: () => ctx.feedback?.reportAiCheckIncomplete(), onError: error => console.error('[feedback] AI duplicate check failed:', error) });
  const requestCheck = () => rechecker.request();
  recheckRequests.set(ctx, rechecker);
  const changed = () => {
    const win = ctx.getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('feedback:changed', {});
    requestCheck();
  };
  return new FeedbackService({
    file: path.join(userDataStorage(app.getPath('userData')).resolve('app', 'feedback'), 'queue.json'),
    appVersion: app.getVersion(),
    remote: createDirectFeedbackRemote(fetcher, DEFAULT_FEEDBACK_TARGET),
    issuePage: {
      open: async url => {
        const result = await openExternalUrl(url);
        if (!result.ok) throw new Error(result.error);
      },
      copyBody: body => clipboard.writeText(body)
    },
    changed, needsAiCheck: requestCheck
  });
}
