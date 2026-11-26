import type { IpcMainInvokeEvent } from 'electron';
import type { AppContext } from '../context';
import { handle, ownIpcResource } from '../ipc/handle';
import { onAgentMessageAppended } from '../metaAgent/messageStore';
import { projectMailActivity, type MailPresentationResult } from '../../shared/mailActivity';
import { foregroundMailWindow, launchMailDepartures, releaseMailDepartures, setMailDepartureViewport } from './departure';

/** UI only. Publishing never waits for animation or changes any mailbox/read/wake state. */
export function attachMailboxPresentation(ctx: AppContext): () => void {
  return onAgentMessageAppended((workspaceId, m, body) => {
    if (m.receipt !== 'stored') return;
    const activity = projectMailActivity(workspaceId, m, body);
    if (activity) foregroundMailWindow(ctx)?.webContents.send('messages:activity', activity);
  });
}

export function registerMailPresentationIpc(ctx: AppContext): void {
  const senderWindow = (event: IpcMainInvokeEvent) => {
    const win = ctx.getWindow();
    return win && !win.isDestroyed() && event?.sender === win.webContents &&
      event.senderFrame && event.senderFrame === win.webContents.mainFrame ? win : undefined;
  };
  handle('mailPresentation:viewport', (event, viewportId: string, mailboxId: string, active: boolean): MailPresentationResult => {
    const win = senderWindow(event);
    if (!win) return { ok: false, error: 'Mail preview requires the desktop workbench window' };
    if (typeof viewportId !== 'string' || !viewportId || typeof mailboxId !== 'string' || !mailboxId || typeof active !== 'boolean')
      return { ok: false, error: 'Invalid mail preview viewport' };
    setMailDepartureViewport(win, viewportId, mailboxId, active);
    return { ok: true };
  });
  handle('mailPresentation:depart', async (event, viewportId: string, requestIds: string[]): Promise<MailPresentationResult> => {
    const win = senderWindow(event);
    if (!win) return { ok: false, error: 'Mail departure requires the desktop workbench window' };
    if (typeof viewportId !== 'string' || !Array.isArray(requestIds) || !requestIds.every(id => typeof id === 'string'))
      return { ok: false, error: 'Invalid mail departure request' };
    return await launchMailDepartures(win, viewportId, requestIds)
      ? { ok: true } : { ok: false, error: 'The preview expired or the write was not confirmed' };
  });
  ownIpcResource(() => {
    const win = ctx.getWindow();
    if (win) return releaseMailDepartures(win);
  });
}
