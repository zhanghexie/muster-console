import React, { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatSurface } from '../../../shared/chatSurface';
import type { ChatMessage, WorkspaceInfo } from '../../../shared/types';
import { formatHelpText } from '../../../shared/workbenchCommands';
import { formatWorkbenchStatus } from '../../../shared/workbenchStatus';
import { schedulerModelRequestId } from '../../../shared/modelRequest';
import { workspaceAccent, workspaceAccentEnabled } from '../../../shared/workspaceAccent';
import { resolveAppearance } from '../../../shared/resolvedAppearance';
import { getResolvedAppearance, getTheme, subscribeAppearance } from '../theme';
import { useWorkspaceAccentVersion } from '../useWorkspaceAccents';
import { workspaceAvatarImageSrc, workspaceIconUrl } from '../workspaceIcons';
import { useSessionStore, useWorkspaceStore } from '../store';
import { AppLogo } from '../components/AppLogo';
import { ChatSurfaceView } from '../chatSurface/ChatSurfaceView';

export function schedulerMessageRole(surface: ChatSurface, messageId: string): 'user' | 'assistant' | undefined {
  const messages = surface.getSnapshot().messages as readonly ChatMessage[];
  const role = messages.find(message => message.id === messageId)?.role;
  return role === 'user' || role === 'assistant' ? role : undefined;
}

export function useSchedulerActionStyle(workspaceId: string | null): React.CSSProperties {
  const accentVersion = useWorkspaceAccentVersion();
  const appearance = React.useSyncExternalStore(subscribeAppearance, getResolvedAppearance);
  const accent = workspaceAccent(workspaceId);
  const enabled = workspaceAccentEnabled(workspaceId);
  return useMemo(() => {
    if (!workspaceId) return {};
    const { cssVars } = resolveAppearance(getTheme(), { workspaceId, accent, enabled });
    // 阅读面沿工作台主题，主动作沿对话所属工作区。
    return Object.fromEntries(Object.entries(cssVars).filter(([key]) =>
      key.startsWith('--action-') || key === '--ws-accent' || key === '--on-accent'));
  }, [workspaceId, accent, enabled, accentVersion, appearance.revision]);
}

export function SchedulerIdentity({ workspace }: { workspace?: WorkspaceInfo }): React.JSX.Element {
  const name = workspace?.name ?? 'Agent';
  const avatar = workspace?.avatar?.trim() || '🤖';
  const image = workspaceAvatarImageSrc(avatar);
  return (
    <div className="agent-panel-identity" title={name}>
      <span className={`agent-panel-avatar${workspaceIconUrl(avatar) ? ' is-workspace-symbol' : ''}`} aria-hidden>
        {image ? <img className="agent-avatar-img" src={image} alt="" draggable={false} /> : avatar}
      </span>
      <div className="agent-panel-title-group"><div className="agent-panel-title">{name}</div></div>
    </div>
  );
}

type ConversationProps = Pick<React.ComponentProps<typeof ChatSurfaceView>,
  'surface' | 'live' | 'interactionActive' | 'disabled' | 'notesHost' | 'findEnabled'> & {
  workspace?: WorkspaceInfo;
};

export function SchedulerConversation({ workspace, surface, ...view }: ConversationProps): React.JSX.Element {
  const { t } = useTranslation();
  const { sessions, activeId } = useSessionStore();
  const { workspaces } = useWorkspaceStore();
  const empty = useSyncExternalStore(surface.subscribe, () => surface.getSnapshot().messages.length === 0);
  const onLocalCommand = useCallback((kind: 'status' | 'statusVerbose' | 'stop' | 'help' | 'bind' | 'unbind'): void => {
    if (kind === 'stop') {
      surface.actions.stop();
      return;
    }
    const echo = surface.actions.localEcho;
    if (kind === 'help') {
      const help = formatHelpText();
      echo?.(typeof window.api?.workerRouting?.reference === 'function'
        ? `${help}\n${t('在工作台输入 /harness，选择派活使用的 Harness、模型和参数。')}`
        : help);
      return;
    }
    if (kind === 'bind' || kind === 'unbind') {
      echo?.(t('请在已授权的 Channel 对话中使用 /bind 或 /unbind 选择远程会话。'));
      return;
    }
    const terminals = sessions
      .filter(s => s.type === 'terminal' && s.workspaceId === surface.sessionId)
      .map(s => ({
        name: s.name,
        runtime: s.runtime,
        status: s.status ?? 'idle',
        active: s.id === activeId,
        cwd: s.cwd,
        lifecycle: s.lifecycle,
        liveStatus: s.liveStatus?.label
      }));
    const { messages, busy, mode } = surface.getSnapshot();
    const chatMessages = (messages as readonly ChatMessage[]).slice().reverse();
    const lastUser = chatMessages.find(m => m.role === 'user' && m.content.trim() && !m.local && !m.host);
    const lastAssistant = chatMessages.find(m => m.role === 'assistant' && m.content.trim() && !m.local);
    echo?.(formatWorkbenchStatus({
      workspaceName: workspace?.name ?? '',
      workspaceCount: workspaces.length,
      agentBusy: busy,
      agentSessionTitle: lastUser?.content.trim().replace(/\s+/g, ' ').slice(0, 40),
      agentLastPreview: lastAssistant?.content.trim().replace(/\s+/g, ' ').slice(0, 120),
      agentMode: mode ?? 'default',
      terminals
    }, kind === 'statusVerbose' ? 'verbose' : 'brief'));
  }, [workspace?.name, workspaces.length, sessions, activeId, surface, t]);

  return (
    <ChatSurfaceView
      {...view}
      surface={surface}
      workspaceId={surface.sessionId}
      modelRequestSessionId={schedulerModelRequestId(surface.sessionId)}
      cwd={workspace?.path}
      onLocalCommand={onLocalCommand}
      header={empty ? (
        <div className="empty-hint chat-welcome">
          <div className="empty-logo" aria-hidden><AppLogo size={40} /></div>
          {t('我是调度 Agent。可以开 Cursor/Claude/OpenCode 工作面板、刷新对话、注册定时任务、给 Worker 派活……直接用自然语言说就行。')}
          <br />
          <span className="hint-muted">
            {t('快捷：输入 ')}<kbd>/</kbd>
            {t(' 打开命令面板（/status 看工作台状态），')}<kbd>@</kbd>
            {t(' 引用工作区文件；选中 AI 回复的文字可加批注；顶栏「重置」或 /new、/clear 清空上下文。')}
          </span>
        </div>
      ) : null}
    />
  );
}
