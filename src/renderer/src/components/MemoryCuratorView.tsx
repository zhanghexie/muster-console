import React, { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatSurfaceView } from '../chatSurface/ChatSurfaceView';
import type { MemoryCuratorSurface } from '../chatSurface/memoryCuratorSurface';

/** Memory uses the scheduler's transcript and AgentComposer; only the surface adapter is purpose-specific. */
export function MemoryCuratorView({ surface, workspaceId, cwd, active, disabled }: {
  surface: MemoryCuratorSurface;
  workspaceId: string;
  cwd?: string;
  active: boolean;
  disabled: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const view = useSyncExternalStore(surface.subscribe, surface.getViewState);
  const snapshot = view.snapshot;
  return <section className="memory-curator-view" aria-label={t('记忆子系统会话')}>
    <ChatSurfaceView surface={surface} workspaceId={workspaceId} cwd={cwd}
      live={active} interactionActive={active}
      disabled={disabled || !active || !!snapshot?.paused || (view.loading && !snapshot)}
      findEnabled={false} remindersEnabled={false}
      header={view.error ? <div className="empty-hint memory-curator-welcome">
        <button type="button" className="agent-chat-clear-btn" disabled={disabled || !active || view.loading}
          onClick={() => void surface.refresh()}>{t('重新读取记忆会话')}</button>
      </div> : !snapshot?.messages.length ? <div className="empty-hint memory-curator-welcome">
        <p className="hint-muted">{t('这里只处理记忆的查询、整理、更正和删除，不执行工程任务。')}</p>
      </div> : undefined}/>
  </section>;
}
