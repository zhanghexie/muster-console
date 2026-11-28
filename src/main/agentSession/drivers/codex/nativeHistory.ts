import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t } from '../../../../shared/i18n';
import type { NativeSessionHistoryAction, NativeSessionHistoryTarget } from '../../../../shared/sessionLifecycle';
import type { SessionMeta } from '../../../../shared/types';
import { codexHomeOf, CodexRpcError, withCodexNativeRpc } from './nativeRpc';

export function codexHistoryStorageKey(env: Record<string, string>): string {
  return 'codex:' + createHash('sha256').update(codexHomeOf(env)).digest('hex');
}

function historyIds(session: Readonly<SessionMeta>, action: NativeSessionHistoryAction): string[] {
  const current = session.runtimeResumeToken;
  if (!current) return [];
  const ids = (session.codexContinuationHistory ?? []).flatMap(({ sourceId, stagingId }) =>
    stagingId && action !== 'unarchive' ? [sourceId, stagingId] : [sourceId]);
  ids.push(current);
  // Both ordinary forks and attached continuations can reference earlier history.
  return [...new Set(action === 'delete' ? ids.reverse() : ids)];
}

export function describeCodexHistory(session: Readonly<SessionMeta>, env: Record<string, string>): NativeSessionHistoryTarget | undefined {
  const ids = historyIds(session, 'archive');
  return ids.length ? {
    provider: 'Codex', storageKey: session.nativeHistoryStorageKey ?? codexHistoryStorageKey(env), ids,
    actions: ['archive', 'unarchive', 'delete'], permanentDelete: true, deletesNativeChildSessions: true
  } : undefined;
}

type ThreadReceipt = { thread?: { id?: string; path?: string } };

function inActiveSessions(file: string | undefined, home: string): boolean {
  if (!file || !path.isAbsolute(file)) return false;
  let resolved = path.resolve(file);
  try { resolved = fs.realpathSync.native(resolved); } catch { /* use the native receipt path */ }
  if (process.platform === 'win32') resolved = resolved.toLowerCase();
  return path.relative(home, resolved).split(path.sep)[0] === 'sessions';
}

function missingRollout(error: unknown, id: string, archived = false): boolean {
  return error instanceof CodexRpcError && error.code === -32600 &&
    error.message === `no ${archived ? 'archived ' : ''}rollout found for thread id ${id}`;
}

function missingThreadRead(error: unknown, id: string): boolean {
  return missingRollout(error, id) || (error instanceof CodexRpcError && error.code === -32600 && error.message === `thread not loaded: ${id}`);
}

function activeWriter(error: unknown, id: string): boolean {
  return error instanceof CodexRpcError && error.code === -32600 &&
    error.message.endsWith(`thread ${id} already has an active writer`);
}

export async function updateCodexHistory(
  session: Readonly<SessionMeta>, action: NativeSessionHistoryAction, executable: string, env: Record<string, string>
): Promise<void> {
  const ids = historyIds(session, action);
  if (!ids.length) return;
  if (session.nativeHistoryStorageKey && session.nativeHistoryStorageKey !== codexHistoryStorageKey(env)) {
    throw new Error(t('Codex 会话属于另一个历史目录，请使用原来的 Codex 配置后重试。'));
  }
  // History is scoped by CODEX_HOME and thread ID. Archived worktrees may be gone.
  const cwd = session.cwd && fs.statSync(session.cwd, { throwIfNoEntry: false })?.isDirectory() ? session.cwd : os.homedir();
  const home = codexHomeOf(env);
  await withCodexNativeRpc(cwd, executable, env, async request => {
    for (const threadId of ids) {
      try {
        const result = await request(`thread/${action}`, { threadId });
        if (action === 'unarchive' ? (result as ThreadReceipt | undefined)?.thread?.id !== threadId
          : !result || typeof result !== 'object' || Array.isArray(result)) {
          throw new Error(t('Codex 未确认原生会话操作。'));
        }
      } catch (error) {
        if (action !== 'unarchive' && missingRollout(error, threadId)) continue;
        const locked = activeWriter(error, threadId);
        if (action === 'unarchive' && (locked || missingRollout(error, threadId, true))) {
          // A session archived only on the workbench side may still be open in Codex.
          // Confirm that it already has an active rollout without resuming it.
          try {
            const read = (await request('thread/read', { threadId }) as ThreadReceipt | undefined)?.thread;
            if (read?.id === threadId && inActiveSessions(read.path, home)) continue;
          } catch (readError) {
            if (!locked && threadId !== session.runtimeResumeToken && missingThreadRead(readError, threadId)) continue;
            throw readError;
          }
        }
        if (locked) throw new Error(t('Codex 仍在使用关联会话。待占用解除后可重试。'));
        if (action === 'delete' && error instanceof CodexRpcError && error.code === -32600 &&
            (error.message.includes('forked history still references it') || error.message.startsWith('cannot delete thread while attached thread '))) {
          throw new Error(t('Codex 拒绝删除仍被其他分支引用的会话。'));
        }
        if (error instanceof CodexRpcError && error.code === -32601) {
          throw new Error(t('此 Codex 版本不支持这项历史操作，请更新 Codex 后重试。'));
        }
        throw error;
      }
    }
  });
}
