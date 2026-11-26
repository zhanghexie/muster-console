import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import { app } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

import type { AppContext } from '../context';
import type { SessionReminderSnapshot, SessionReminderTarget } from '../../shared/sessionReminders';
import { SessionReminderStore } from './store';

let instance: SessionReminderStore | undefined;
function store(): SessionReminderStore {
  return instance ??= new SessionReminderStore(userDataStorage(app.getPath('userData')).file('session-reminders'));
}

export function closeSessionReminderStore(): void {
  instance?.close();
  instance = undefined;
}

function key(prefix: string, parts: string[]): string {
  return `${prefix}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

/** Deleting a session must not create a database if reminders were never used. */
function existingStore(): SessionReminderStore | undefined {
  if (instance) return instance;
  return existsSync(userDataStorage(app.getPath('userData')).file('session-reminders')) ? store() : undefined;
}

/** Internal lifecycle hooks use trusted identities, including after the target is gone. */
export function purgeSessionReminders(sessionId: string): void {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid session id.');
  existingStore()?.deleteScope(key('session', [sessionId]));
}

/** Reconcile known deleted sessions after a restart or an earlier partial cleanup. */
export function purgeEndedSessionReminders(sessionIds: readonly string[]): void {
  if (!sessionIds.length) return;
  if (sessionIds.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid session id.');
  existingStore()?.deleteScopes(sessionIds.map(id => key('session', [id])));
}

export function purgeSchedulerReminders(workspaceId: string, sessionFile: string): void {
  if (typeof workspaceId !== 'string' || !workspaceId || typeof sessionFile !== 'string' || !sessionFile) throw new Error('Invalid scheduler conversation.');
  existingStore()?.deleteScope(key('scheduler', [workspaceId, sessionFile]));
}

/** Resolve the target against live host state, never against a model-provided scope key. */
export function resolveReminderScope(ctx: AppContext, target: SessionReminderTarget): string | null {
  if (!target || typeof target !== 'object') throw new Error('Invalid reminder target.');
  if (target.kind === 'session') {
    if (typeof target.sessionId !== 'string' || !ctx.sessions.get(target.sessionId)) throw new Error('Session does not exist.');
    return key('session', [target.sessionId]);
  }
  if (target.kind === 'scheduler') {
    if (typeof target.workspaceId !== 'string' || !ctx.workspaces.list().some(item => item.id === target.workspaceId)) throw new Error('Workspace does not exist.');
    if (!ctx.orchestrator) throw new Error('Scheduler is unavailable.');
    // The scheduler resolves cold conversation metadata without creating a bucket.
    const sessionFile = ctx.orchestrator.getCurrentSessionFile(target.workspaceId);
    return sessionFile ? key('scheduler', [target.workspaceId, sessionFile]) : null;
  }
  throw new Error('Invalid reminder target.');
}

export function listSessionReminders(ctx: AppContext, target: SessionReminderTarget): SessionReminderSnapshot {
  const scope = resolveReminderScope(ctx, target);
  return { scope, items: scope ? store().list(scope) : [] };
}

export function publishSessionRemindersChanged(ctx: AppContext, target: SessionReminderTarget): void {
  const win = ctx.getWindow();
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('sessionReminders:changed', target);
}

export function addSessionReminder(ctx: AppContext, target: SessionReminderTarget, text: unknown, sourceMessageId: string | null) {
  const scope = resolveReminderScope(ctx, target);
  if (!scope) throw new Error('The current conversation is not ready for reminders yet.');
  const result = store().add(scope, text, sourceMessageId);
  if (result.created) publishSessionRemindersChanged(ctx, target);
  return result;
}

export function completeSessionReminder(ctx: AppContext, target: SessionReminderTarget, expectedScope: string, id: string, done: boolean, by: 'user' | 'ai') {
  const scope = resolveReminderScope(ctx, target);
  if (!scope || scope !== expectedScope) throw new Error('The conversation changed; refresh reminders and try again.');
  const item = store().setCompleted(scope, id, done, by);
  publishSessionRemindersChanged(ctx, target);
  return item;
}

/** User-facing operation; the AI tool intentionally does not expose deletion. */
export function deleteSessionReminder(ctx: AppContext, target: SessionReminderTarget, expectedScope: string, id: string): void {
  const scope = resolveReminderScope(ctx, target);
  if (!scope || scope !== expectedScope) throw new Error('The conversation changed; refresh reminders and try again.');
  store().delete(scope, id);
  publishSessionRemindersChanged(ctx, target);
}
