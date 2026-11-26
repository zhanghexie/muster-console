import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePresence } from '../motion';

type Navigate = (id: string) => void;
export interface WorkerDetailView { id: string; label: string; content: React.ReactNode | ((navigate: Navigate) => React.ReactNode) }
function DetailView({ shown, id, label, tabId, children }: { shown: boolean; id: string; label: string; tabId?: string; children: React.ReactNode }): React.JSX.Element {
  const presence = usePresence(shown);
  return <div id={id} role={tabId ? 'tabpanel' : 'region'} aria-label={tabId ? undefined : label} aria-labelledby={tabId} aria-hidden={!shown}
    className={`worker-task-view xfade${shown && presence.stage === 'in' ? ' is-shown' : ''}`}
    ref={node => { if (node) node.inert = !shown; }}>{children}</div>;
}
/** Each view owns one real scope; first-visit mounting preserves drafts after navigation. */
export function WorkerDetailViews({ views, requestedView }: { views: WorkerDetailView[]; requestedView?: string }): React.JSX.Element {
  const { t } = useTranslation();
  const id = useId();
  const [selected, setSelected] = useState(requestedView ?? views[0]?.id);
  const [visited, setVisited] = useState<string[]>([requestedView ?? views[0]?.id]);
  const current = views.some(view => view.id === selected) ? selected : views[0]?.id;
  const select: Navigate = next => { setSelected(next); setVisited(previous => previous.includes(next) ? previous : [...previous, next]); };
  useEffect(() => { if (requestedView) select(requestedView); }, [requestedView]);
  return <div className="worker-task-layout" data-settings-layout="flat">
    {views.length > 1 ? <div className="worker-task-tabs" role="tablist" aria-label={t('Agent 配置内容')}>
      {views.map((view, index) => <button type="button" key={view.id} id={`${id}-${view.id}-tab`} role="tab"
        aria-controls={`${id}-${view.id}`} aria-selected={current === view.id} tabIndex={current === view.id ? 0 : -1}
        onClick={() => select(view.id)} onKeyDown={event => {
          const next = event.key === 'Home' ? views[0] : event.key === 'End' ? views[views.length - 1]
            : event.key === 'ArrowRight' ? views[(index + 1) % views.length] : event.key === 'ArrowLeft' ? views[(index + views.length - 1) % views.length] : undefined;
          if (next) { event.preventDefault(); select(next.id); document.getElementById(`${id}-${next.id}-tab`)?.focus(); }
        }}>{view.label}</button>)}
    </div> : null}
    <div className="worker-task-pages xfade-stack">{views.filter(view => view.id === current || visited.includes(view.id)).map(view =>
      <DetailView key={view.id} shown={view.id === current} id={`${id}-${view.id}`} label={view.label} tabId={views.length > 1 ? `${id}-${view.id}-tab` : undefined}>
        {typeof view.content === 'function' ? view.content(select) : view.content}
      </DetailView>)}
    </div>
  </div>;
}
