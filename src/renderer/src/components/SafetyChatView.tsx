import React, { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatSurfaceView } from '../chatSurface/ChatSurfaceView';
import type { SafetySurface } from '../chatSurface/safetySurface';

/** Safety uses the scheduler's transcript and AgentComposer; approval policy stays in the backend adapter. */
export function SafetyChatView({ surface, workspaceId, cwd, active, disabled }: {
  surface: SafetySurface;
  workspaceId: string;
  cwd?: string;
  active: boolean;
  disabled: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const view = useSyncExternalStore(surface.subscribe, surface.getViewState);
  const snapshot = view.snapshot;
  return <section className="memory-curator-view" aria-label={t('审批子系统会话')}>
    <ChatSurfaceView surface={surface} workspaceId={workspaceId} cwd={cwd}
      live={active} interactionActive={active}
      disabled={disabled || !active || (view.loading && !snapshot)}
      findEnabled={false} remindersEnabled={false}
      header={view.error ? <div className="empty-hint memory-curator-welcome">
        <button type="button" className="agent-chat-clear-btn" disabled={disabled || !active || view.loading}
          onClick={() => void surface.refresh()}>{t('重新读取审批会话')}</button>
      </div> : !snapshot?.messages.length ? <div className="empty-hint memory-curator-welcome">
        <p className="hint-muted">{t('在这里讨论低频业务审批和设置放行规则。代理只做判断，不执行工程任务。')}</p>
      </div> : undefined}/>
  </section>;
}
