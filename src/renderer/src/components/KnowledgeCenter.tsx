import { ErrorTip, ErrorTipDetails } from './ErrorTip';
import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { KnowledgeApi, KnowledgeSnapshot } from '../../../shared/knowledge';
import {PROFILE_INJECTION_BUDGET} from '../../../shared/knowledge';
import { useUiStore, useWorkspaceStore } from '../store';
import { useMemoryCenterRoute, requestMemoryCenterTab, KNOWLEDGE_CENTER_TABS, type MemoryCenterTabId } from '../memoryCenterRoute';
import { KnowledgePanel } from './KnowledgePanel';
import { IntentTab } from './MemoryIntentTab';
import { usePresence } from './motion';
import { MemoryOverview, type MemoryOverviewLive } from './MemoryOverview';
import { MemoryProcessingView } from './MemoryProcessingView';

function normalizedTab(tab: MemoryCenterTabId): MemoryCenterTabId {
  return ['profile', 'review', 'approvals', 'recycle'].includes(tab) ? 'entries' : tab;
}
function CenterTab({ id, active, children }: { id: MemoryCenterTabId; active: boolean; children: React.ReactNode }): React.JSX.Element {
  const presence = usePresence(active);
  return <div id={`knowledge-panel-${id}`} aria-labelledby={`knowledge-tab-${id}`} aria-hidden={!active}
    className={`xfade${active ? ' is-shown' : ''}`} role="tabpanel" {...presence.spread} {...(!active ? { inert: '' as unknown as boolean } : {})}>
    <div className="memory-tabwrap">{children}</div>
  </div>;
}

export function KnowledgeCenter({ onOpenSettings }: { onOpenSettings?: (tab?: 'memory') => void }): React.JSX.Element {
  const { activeWorkspaceId } = useWorkspaceStore(), { t } = useTranslation();
  if (!activeWorkspaceId) return <section className="knowledge-empty">{t('请先选择工作区。')}</section>;
  return <WorkspaceKnowledgeCenter key={activeWorkspaceId} activeWorkspaceId={activeWorkspaceId} onOpenSettings={onOpenSettings} />;
}
function WorkspaceKnowledgeCenter({ activeWorkspaceId, onOpenSettings }: { activeWorkspaceId: string; onOpenSettings?: (tab?: 'memory') => void }): React.JSX.Element {
  const { t } = useTranslation();
  const { requestAgentPanel } = useUiStore();
  const requests = useRef(0), alive = useRef(true);
  const [queueRoute,setQueueRoute] = useState<{filter:'attention'|'queued';nonce:number}>({filter:'attention',nonce:0});
  const route = useMemoryCenterRoute(), [view, setView] = useState<MemoryCenterTabId>('overview');
  const [visited, setVisited] = useState<Set<MemoryCenterTabId>>(new Set(['overview']));
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot | null>(null), [error, setError] = useState(''), [intents, setIntents] = useState(0);
  const [entriesNamespace, setEntriesNamespace] = useState('all'), [entriesRouteKey, setEntriesRouteKey] = useState(0);
  const selectTab = (tab: MemoryCenterTabId): void => {
    const normalized = normalizedTab(tab);
    if (tab === 'profile') { setEntriesNamespace('profile'); setEntriesRouteKey(key => key + 1); }
    setView(normalized); setVisited(current => new Set([...current, normalized]));
  };
  useEffect(() => {
    if (!route) return;
    setEntriesNamespace(route.tab === 'profile' ? 'profile' : 'all'); setEntriesRouteKey(route.nonce);
    selectTab(route.tab);
  }, [route?.nonce]);
  const api = useMemo<KnowledgeApi>(() => ({
    historySources: () => window.api.knowledge.historySources(activeWorkspaceId), history: input => window.api.knowledge.history(activeWorkspaceId, input),
    govern: input => window.api.knowledge.govern(activeWorkspaceId, input), undoGovernance: input => window.api.knowledge.undoGovernance(activeWorkspaceId, input),
    list: async () => { const token = ++requests.current; const data = await window.api.knowledge.list(activeWorkspaceId); if (alive.current && token === requests.current) { setSnapshot(data); setError(''); } return data; },
    search: input => window.api.knowledge.search(activeWorkspaceId, input), decide: input => window.api.knowledge.decide(activeWorkspaceId, input),
    revise: input => window.api.knowledge.revise(activeWorkspaceId, input), confirm: input => window.api.knowledge.confirm(activeWorkspaceId, input), promoteHost: input => window.api.knowledge.promoteHost(activeWorkspaceId,input), supersede: input => window.api.knowledge.supersede(activeWorkspaceId, input),
    restore: input => window.api.knowledge.restore(activeWorkspaceId, input), evidence: input => window.api.knowledge.evidence(activeWorkspaceId, input),
    process: () => window.api.knowledge.process(activeWorkspaceId), create: input => window.api.knowledge.create(activeWorkspaceId, input)
  }), [activeWorkspaceId]);
  useEffect(() => {
    alive.current = true;
    const pull = async (): Promise<void> => { try { await api.list(); } catch (failure) { if (alive.current) setError(String((failure as Error).message)); } };
    void pull(); const timer = window.setInterval(() => void pull(), 30_000);
    void window.api.memoryCenter.intents().then(data => { if (alive.current) setIntents(data?.items?.filter(item => ['pending', 'armed', 'fired'].includes(item.state)).length ?? 0); }).catch(failure => { if (alive.current) setError(String((failure as Error).message)); });
    return () => { alive.current = false; requests.current++; window.clearInterval(timer); };
  }, [api]);
  const refresh = useCallback(() => api.list(),[api]);
  const openCurator = (): void => requestAgentPanel(activeWorkspaceId,'memory');
  const live: MemoryOverviewLive = { stats: {
    curated: snapshot?.active ?? 0,
    profileChars: snapshot?.profileInjectionChars ?? 0,
    profileMax: PROFILE_INJECTION_BUDGET, pending: snapshot?.pending ?? 0, intents,
    recycle: snapshot?.history ?? 0,
    lastConsolAt: snapshot?.activity?.items[0]?.ts ?? null
  }, feed: snapshot?.activity ?? { items: [], kindCounts24h: {}, kindCounts7d: {} }, backlog: snapshot?.processing?.pending ?? 0,
    processing: snapshot ? {
      failed: snapshot.processing?.failed ?? 0, running: snapshot.processing?.running, paused: snapshot.processing?.paused,
      suspended: snapshot.records.filter(record => record.status === 'needs_revalidation' || snapshot.policySuppressedIds?.includes(record.id)).length
    } : undefined
  };
  return <main className="prompt-task-panel memory-panel">
    <header className="prompt-task-toolbar"><div><h1>{t('记忆中心')}</h1><span>{snapshot ? t('{{active}} 条长期知识 · 自动整理', { active: snapshot.active }) : t('加载中…')}</span></div></header>
    <nav className="memory-tabs" role="tablist" aria-label={t('记忆中心页签')} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      const eventTab = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[role="tab"]') : null;
      const eventIndex = eventTab ? buttons.indexOf(eventTab) : -1;
      const current = eventIndex >= 0 ? eventIndex : buttons.findIndex(button => button.getAttribute('aria-selected') === 'true');
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus(); buttons[next]?.click();
    }}>{KNOWLEDGE_CENTER_TABS.map(tab => <button id={`knowledge-tab-${tab.id}`} aria-controls={`knowledge-panel-${tab.id}`} key={tab.id} role="tab" tabIndex={view === tab.id ? 0 : -1}
      aria-selected={view === tab.id} className={`memory-tab${view === tab.id ? ' is-active' : ''}`} onClick={() => selectTab(tab.id)}>{t(tab.labelKey)}</button>)}</nav>
    {error ? <ErrorTip message={t('记忆数据读取失败：{{error}}', { error })} /> : null}
    {snapshot?.integrityIssues?.length ? <div className="memory-banner"><ErrorTipDetails message={t('部分记忆资产缺失或与账本不一致，已停止召回和覆盖；请核对：{{ids}}', { ids: snapshot.integrityIssues.map(issue => issue.id).join('、') })} /></div> : null}
    <div className="xfade-stack memory-tabbody">
      {KNOWLEDGE_CENTER_TABS.map(({id:tab}) => <CenterTab key={`${activeWorkspaceId}:${tab}`} id={tab} active={view === tab}>
        {!visited.has(tab) ? null : tab === 'overview' ? <MemoryOverview center={null} pending={snapshot?.pending ?? 0} live={live} onSelectTab={selectTab} onOpenCurator={openCurator}
          onInspectQueue={destination => {setQueueRoute(previous=>({filter:destination==='candidates'?'queued':'attention',nonce:previous.nonce+1}));selectTab('index');}} /> :
          tab === 'intent' ? <IntentTab /> :
          tab === 'index' ? <MemoryProcessingView key={queueRoute.nonce} workspaceId={activeWorkspaceId} snapshot={snapshot} initialFilter={queueRoute.filter}
            onRefresh={refresh} onOpenConversation={openCurator} onOpenSettings={onOpenSettings?()=>onOpenSettings('memory'):undefined} /> :
          <KnowledgePanel key={`${activeWorkspaceId}:${tab}:${entriesRouteKey}`} api={api} workspaceKey={activeWorkspaceId} embedded page={tab === 'history' ? 'history' : 'entries'} sharedSnapshot={snapshot}
            onNavigateEntry={id => requestMemoryCenterTab('entries', { entryId: id })} initialTab={tab === 'history' ? 'history' : 'active'} initialNamespace={tab === 'entries' ? entriesNamespace : 'all'} focusEntryId={route && normalizedTab(route.tab) === tab ? route.entryId : undefined} />}
      </CenterTab>)}
    </div>
  </main>;
}
