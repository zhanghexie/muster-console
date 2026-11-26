/**
 * 手机端 L1 工作区列表（mobile-remote-interaction-plan）：每区一张卡——
 * 状态汇总徽标（N 工作中 · M 需要你）+ 最近会话预览；needs_you 区置顶描边。
 * 只读工作区集合（增删是桌面端职责）；下拉由浏览器原生刷新兜底，状态本身实时推送。
 */
import React, { useMemo } from 'react';
import { workspaceAvatarImageSrc, workspaceIconUrl } from '../../workspaceIcons';
import { useTranslation } from 'react-i18next';
import { formatRelativeTime } from '../../../../shared/relativeTime';
import { useSessionStore, useWorkspaceStore } from '../../store';
import { listableSession, sessionZone } from '../sessionStatus';
import { workspaceNeedsYouCount } from '../../../../shared/schedulerStatus';
import type { SessionMeta } from '../../../../shared/types';

export function WorkspaceListPage(props: {
  onOpenWorkspace: (wsId: string) => void;
  children?: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { workspaces } = useWorkspaceStore();
  const { sessions } = useSessionStore();

  const cards = useMemo(() => {
    return workspaces
      .map((w) => {
        const own = sessions.filter((s) => listableSession(s) && (s.workspaceId ?? '') === w.id);
        const needs = workspaceNeedsYouCount({
          sessions,
          workspaceId: w.id
        });
        const working = own.filter((s) => sessionZone(s) === 'working').length;
        const last = own.reduce<SessionMeta | null>(
          (acc, s) =>
            !acc || (s.lastUsedAt ?? s.createdAt) > (acc.lastUsedAt ?? acc.createdAt) ? s : acc,
          null
        );
        return { ws: w, needs, working, last };
      })
      .sort((a, b) => {
        if (a.needs !== b.needs) return b.needs - a.needs;
        const at = a.last?.lastUsedAt ?? a.last?.createdAt ?? a.ws.openedAt;
        const bt = b.last?.lastUsedAt ?? b.last?.createdAt ?? b.ws.openedAt;
        return bt - at;
      });
  }, [workspaces, sessions]);

  return (
    <div className="ma-page-body ma-ws-list">
      {props.children}
      <main className="ma-scroll">
        {cards.length === 0 ? (
          <div className="ma-empty">{t('还没有工作区，请先在电脑端打开')}</div>
        ) : (
          cards.map(({ ws, needs, working, last }) => (
            <button
              type="button"
              key={ws.id}
              className={`ma-ws-card${needs > 0 ? ' needs' : ''}`}
              onClick={() => props.onOpenWorkspace(ws.id)}
            >
              <span className={`ma-ws-avatar${workspaceIconUrl(ws.avatar) ? ' is-workspace-symbol' : ''}`} aria-hidden>
                {workspaceAvatarImageSrc(ws.avatar) ? (
                  <img src={workspaceAvatarImageSrc(ws.avatar)} alt="" />
                ) : (
                  ws.avatar || ws.name.slice(0, 1)
                )}
              </span>
              <span className="ma-ws-info">
                <span className="ma-ws-name">{ws.name}</span>
                <span className="ma-ws-sub">
                  {last
                    ? `${last.name} · ${formatRelativeTime(last.lastUsedAt ?? last.createdAt)}`
                    : t('暂无会话')}
                </span>
              </span>
              <span className="ma-ws-badges">
                {needs > 0 ? <span className="ma-badge needs">{t('需要你 {{n}}', { n: needs })}</span> : null}
                {working > 0 ? <span className="ma-badge work">{t('工作中 {{n}}', { n: working })}</span> : null}
              </span>
            </button>
          ))
        )}
      </main>
    </div>
  );
}
