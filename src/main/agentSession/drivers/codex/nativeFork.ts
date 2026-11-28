import type { GuiNativeForkPoint, GuiRuntimeConnection } from '../../types';
import { CodexRpcError, withCodexNativeRpc } from './nativeRpc';

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};

function unavailableThread(error: unknown, threadId: string): boolean {
  return error instanceof CodexRpcError && error.code === -32600 &&
    (error.message === `no rollout found for thread id ${threadId}` || error.message.startsWith(`session ${threadId} is archived.`));
}

/** Fork only a completed native turn; the standard user-message boundary is finer. */
export async function forkCodexTurn(
  point: GuiNativeForkPoint, cwd: string, executable: string, env: Record<string, string>, recordedSessionToken?: string
): Promise<Awaited<ReturnType<NonNullable<GuiRuntimeConnection['nativeFork']>>>> {
  return withCodexNativeRpc(cwd, executable, env, async request => {
    // Page lightweight turn metadata, avoiding an unbounded full transcript read.
    const deadline = Date.now() + 30_000;
    let pagesLeft = 20;
    const hasCompletedTurn = async (threadId: string): Promise<boolean> => {
      let cursor: string | undefined;
      while (pagesLeft > 0 && Date.now() < deadline) {
        pagesLeft--;
        const result = obj(await request('thread/turns/list', { threadId, limit: 100, itemsView: 'notLoaded', ...(cursor ? { cursor } : {}) }));
        if (!Array.isArray(result.data)) return false;
        const match = result.data.map(obj).find(turn => turn.id === point.entryId);
        if (match) {
          if (match.status !== 'completed') throw new Error('Codex 分叉截点不是已完成回合');
          return true;
        }
        if (!result.nextCursor) return false;
        if (typeof result.nextCursor !== 'string' || result.nextCursor === cursor) throw new Error('Codex 回合列表游标无效');
        cursor = result.nextCursor;
      }
      return false;
    };
    let sourceId = point.sessionToken;
    if (!await hasCompletedTurn(sourceId)) {
      if (!recordedSessionToken || recordedSessionToken === sourceId || pagesLeft === 0 || Date.now() >= deadline) return { status: 'unsupported' };
      const current = obj(obj(await request('thread/read', { threadId: sourceId })).thread);
      if (current.id !== sourceId || typeof current.attachedToThreadId !== 'string' || current.forkedFromId !== current.attachedToThreadId) {
        return { status: 'unsupported' };
      }
      try {
        if (!await hasCompletedTurn(recordedSessionToken)) return { status: 'unsupported' };
      } catch (error) {
        if (unavailableThread(error, recordedSessionToken)) return { status: 'unsupported' };
        throw error;
      }
      sourceId = recordedSessionToken;
    }
    let response: Obj;
    try {
      response = obj(await request('thread/fork', { threadId: sourceId, lastTurnId: point.entryId, cwd,
        excludeTurns: true, deferGoalContinuation: true, config: { mcp_servers: {} } }));
    } catch (error) {
      if (sourceId !== point.sessionToken && unavailableThread(error, sourceId)) return { status: 'unsupported' };
      throw error;
    }
    const fork = obj(response.thread);
    if (typeof fork.id !== 'string' || !fork.id || fork.id === sourceId || fork.id === point.sessionToken ||
        (fork.forkedFromId != null && fork.forkedFromId !== sourceId))
      throw new Error('Codex 返回的分叉会话标识无效，请检查原生会话记录');
    return { status: 'forked', token: fork.id };
  });
}
