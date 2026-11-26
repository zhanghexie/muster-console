import type { AgentRuntimeEntry, SessionMeta } from '../../shared/types';
import { isChatRuntimeId } from '../../shared/agentRuntimeCapabilities';

type RestartAction = { id: 'respawn' | 'new-conversation'; label: string };

export function sessionRestartActions(
  session: SessionMeta, runtimes: readonly AgentRuntimeEntry[], t: (key: string) => string
): RestartAction[] {
  if (session.type !== 'terminal' || session.archived) return [];
  const runtime = runtimes.find(entry => entry.id === session.runtime);
  if (session.launchKind === 'shell' || runtime?.surface === 'chat' || isChatRuntimeId(session.runtime ?? '')) {
    return [{ id: 'respawn', label: t('重启') }];
  }
  if (!runtime?.enabled) return [];
  return [
    ...(runtime.terminalResume === 'by-id' && session.externalSessionId
      ? [{ id: 'respawn' as const, label: t('恢复原对话') }]
      : []),
    { id: 'new-conversation', label: t('开启新对话') }
  ];
}

export function runSessionRestart(sessionId: string, action: RestartAction['id']): Promise<void> {
  return action === 'new-conversation'
    ? window.api.sessions.respawn(sessionId, 'new')
    : window.api.sessions.respawn(sessionId);
}
