import type { AppContext } from '../context';
import type { SessionReminderTarget } from '../../shared/sessionReminders';
import { t } from '../../shared/i18n';
import { handle, ipcCaller } from './handle';
import { completeSessionReminder, deleteSessionReminder, listSessionReminders } from '../sessionReminders/service';

export function registerSessionRemindersIpc(ctx: AppContext): void {
  handle('sessionReminders:list', (_event, target: SessionReminderTarget) => listSessionReminders(ctx, target));
  handle('sessionReminders:setCompleted', (_event, target: SessionReminderTarget, scope: string, id: string, done: boolean) =>
    completeSessionReminder(ctx, target, scope, id, done, 'user'));
  handle('sessionReminders:delete', (event, target: SessionReminderTarget, scope: string, id: string) => {
    if (!ipcCaller(event).isAlive()) throw new Error(t('用户连接已断开'));
    deleteSessionReminder(ctx, target, scope, id);
  });
}
