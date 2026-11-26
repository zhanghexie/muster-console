import type { AppCommand, AppRecord } from '../../../shared/agentApps';
import { t } from '../../../shared/i18n';
import { IconCheckSquare, IconClock, IconClose, IconPencil, IconPlus, IconRefresh, IconSave, IconStar, IconTrash } from '../components/icons';

export type PhoneIconName = 'add' | 'edit' | 'delete' | 'refresh' | 'send' | 'reply' | 'check' | 'undo' | 'read' | 'star' | 'processed' | 'reminder-off' | 'clock' | 'save' | 'close';
const sharedIcons = { add: IconPlus, edit: IconPencil, delete: IconTrash, refresh: IconRefresh, star: IconStar, processed: IconCheckSquare, clock: IconClock, save: IconSave, close: IconClose };
const paths = {
  send: 'm2 7 12-5-5 12-2-5-5-2Zm5 2 7-7',
  reply: 'm6 3-4 4 4 4M2 7h7a5 5 0 0 1 5 5',
  check: 'm3 8 3 3 7-7',
  undo: 'M3 3v4h4M3 7a5.5 5.5 0 1 1 1 6',
  read: 'm2 6 6-4 6 4v8H2V6Zm0 0 6 4 6-4M2 14l4-5m4 0 4 5',
  'reminder-off': 'M7 2a6 6 0 0 1 7 7M12.3 12.3A6 6 0 0 1 3.7 3.7M8 4v4l2 1M1.5 1.5l13 13',
};

/** The host derives visuals from command semantics, including agent-created apps. */
export function PhoneActionIcon({ name }: { name: PhoneIconName }) {
  const SharedIcon = sharedIcons[name as keyof typeof sharedIcons];
  return <span className="ap-action-icon" data-phone-icon={name} aria-hidden="true">{SharedIcon ? <SharedIcon size={18}/> : <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d={paths[name as keyof typeof paths]}/></svg>}</span>;
}

export function commandPresentation(command: AppCommand, record?: AppRecord): { icon: PhoneIconName; title: string } {
  const { handler, patch } = command;
  let title = command.title, icon: PhoneIconName;
  if (handler === 'reminders.set') {
    title = record ? record.values.enabled === false ? t('重新设置') : t('编辑提醒') : command.title;
    icon = record ? record.values.enabled === false ? 'clock' : 'edit' : 'add';
  } else if (handler === 'reminders.cancel') icon = 'reminder-off';
  else if (handler === 'records.remove') icon = 'delete';
  else if (handler.endsWith('.sync')) icon = 'refresh';
  else if (handler === 'mail.reply' || handler === 'messages.send' && record) { icon = 'reply'; if (handler === 'messages.send') title = t('回复'); }
  else if (handler.endsWith('.send')) icon = 'send';
  else if (handler === 'records.create' || handler === 'rss.subscribe') icon = 'add';
  else if (patch?.done === false) icon = 'undo';
  else if (patch?.saved === false || patch?.read === false || patch?.processed === false) icon = 'undo';
  else if (patch?.saved != null) icon = 'star';
  else if (patch?.read === true) icon = 'read';
  else if (patch?.processed === true) icon = 'processed';
  else icon = patch ? 'check' : 'edit';
  return { title, icon };
}

export function commandChangesRecord(command: AppCommand, record: AppRecord): boolean {
  if (command.handler === 'reminders.cancel' && record.values.enabled === false) return false;
  // A missing boolean has the same unchecked state as false in record forms.
  return !command.patch || !Object.entries(command.patch).every(([key, value]) =>
    typeof value === 'boolean' ? (record.values[key] ?? false) === value : record.values[key] === value);
}
