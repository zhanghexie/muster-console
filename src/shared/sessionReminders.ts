/** Session-scoped reminders are independent of scheduled phone reminders. */
export type SessionReminderTarget =
  | { kind: 'scheduler'; workspaceId: string }
  | { kind: 'session'; sessionId: string };

export interface SessionReminder {
  id: string;
  text: string;
  createdAt: number;
  completedAt: number | null;
  completedBy: 'user' | 'ai' | null;
  /** Only present when the host can identify a real chat message. */
  sourceMessageId: string | null;
}

export interface SessionReminderSnapshot {
  /** Opaque current-conversation identity. Null means no conversation exists yet. */
  scope: string | null;
  items: SessionReminder[];
}

export const SESSION_REMINDER_GUIDANCE =
  'Use action=add before replying if asked to save a chat to-do or the user still needs to act (choose a version, upload a file, verify a result). Skip optional ideas and your own work. Reuse open items. When resolved, list and complete the item.';
