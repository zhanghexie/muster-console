import type { AppContext } from '../context';
import type { FeedbackDraft, FeedbackMatch } from '../../shared/feedback';
import { handle as registerIpc, type IpcHandler } from './handle';
import { t } from '../../shared/i18n';

function localize(error: unknown): never {
  if (!(error instanceof Error)) throw error;
  throw new Error(t(error.message));
}
function handle<T extends IpcHandler>(channel: string, fn: T): void {
  registerIpc(channel, (event, ...args) => {
    try {
      const result = fn(event, ...args);
      return result instanceof Promise ? result.catch(localize) : result;
    } catch (error) { return localize(error); }
  });
}

/** Feedback approvals are available only from the local main window. */
export function registerFeedbackIpc(ctx: AppContext): void {
  function service(event: Electron.IpcMainInvokeEvent) {
    const win = ctx.getWindow();
    if (!win || !event?.sender || event.sender.id !== win.webContents.id || event.senderFrame !== win.webContents.mainFrame) throw new Error('反馈审核只支持本机工作台窗口');
    if (!ctx.feedback) throw new Error(ctx.feedbackError ? t('反馈服务不可用：{{error}}', { error: t(ctx.feedbackError) }) : t('反馈服务不可用'));
    return ctx.feedback;
  }
  handle('feedback:snapshot', event => service(event).snapshot());
  handle('feedback:createManual', (event, input: unknown) => service(event).createManual(input));
  handle('feedback:update', (event, id: string, revision: number, draft: FeedbackDraft) => service(event).update(id, revision, draft));
  handle('feedback:updateText', (event, id: string, revision: number, text: string) => service(event).updateText(id, revision, text));
  handle('feedback:reject', (event, id: string, revision: number) => service(event).reject(id, revision));
  handle('feedback:delete', (event, id: string, revision: number) => service(event).delete(id, revision));
  handle('feedback:restore', (event, id: string, revision: number) => service(event).restore(id, revision));
  handle('feedback:prepare', (event, id: string, revision: number) => service(event).prepare(id, revision));
  handle('feedback:duplicate', (event, id: string, revision: number, match: FeedbackMatch) => service(event).markDuplicate(id, revision, match));
  handle('feedback:submit', (event, id: string, revision: number, reviewId: string, distinct: boolean) => service(event).submit(id, revision, reviewId, distinct));
  handle('feedback:copyIssueBody', (event, id: string, revision: number) => service(event).copyIssueBody(id, revision));
  handle('feedback:reconcile', (event, id: string, revision: number, returnToDraft?: boolean) => service(event).reconcile(id, revision, returnToDraft));
}
