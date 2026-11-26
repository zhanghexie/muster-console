import { ErrorTip } from '../components/ErrorTip';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { CHANNEL_APP_ID, isLegacyChannelApp, type AgentAppDefinition, type AppSnapshot, type AppView } from '../../../shared/agentApps';
import { MOTION, usePresence } from '../components/motion';
import { prefersReducedMotionPreference, useInteractionPreferences } from '../interactionPreferences';
import { AppDataView } from './AppDataView';
import { ChannelAppView } from './ChannelAppView';
import { CustomAppView } from './CustomAppView';
import { PhoneSettings } from './PhoneSettings';
import { localizeBuiltinApp, phoneAppName } from './appName';
import { localizeAppUserErrorText } from '../../../shared/appUserErrors';
import type { PhoneRoute } from './presentation';
import type { useAgentPhone } from './useAgentPhone';
import { usePhonePosition } from './phonePosition';
import { useKeybindingsOptional } from '../keybindings/KeybindingHost';
import lumiaFrame from './assets/lumia-930-yellow.png';
import './phone.css';

export function PhoneIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="1.5"/><path d="M10 18h4M10 5h4"/></svg>;
}
const FEATHER_STEPS = 7;
function Scene({ active, route, turn, direction, fast, children }: { active: boolean; route: PhoneRoute; turn: number; direction: 'forward' | 'back'; fast: boolean; children: React.ReactNode }) {
  const presence = usePresence(active, MOTION.exitMs + MOTION.staggerMs * FEATHER_STEPS / 2);
  useInteractionPreferences();
  const reduced = prefersReducedMotionPreference();
  const [settledTurn, setSettledTurn] = useState(-1);
  const moving = !reduced && turn !== settledTurn;
  useEffect(() => {
    if (reduced) { setSettledTurn(turn); return; }
    if (!active || !moving) return;
    const duration = fast ? MOTION.microMs + MOTION.panelMs + FEATHER_STEPS * MOTION.staggerMs / 2 : MOTION.menuMs + MOTION.moveMs + FEATHER_STEPS * MOTION.staggerMs;
    const timer = window.setTimeout(() => setSettledTurn(turn), duration);
    return () => window.clearTimeout(timer);
  }, [active, moving, turn, fast, reduced]);
  if (!presence.mounted) return null;
  return <section className="ap-scene mp-panel" {...presence.spread} data-app={route.appId ?? (route.settings ? 'settings' : 'home')} data-active={active} data-direction={direction} data-flight={moving ? 'moving' : 'idle'} data-fast={fast} aria-hidden={!active} {...(!active ? { inert: '' } : {}) as object}>{children}</section>;
}
export function AgentPhone({ workspaceId, workspaceName, phone, anchor, anchorReady }: { workspaceId: string; workspaceName: string; phone: ReturnType<typeof useAgentPhone>; anchor?: React.RefObject<HTMLElement | null>; anchorReady?: boolean }) {
  const { t } = useTranslation();
  const phaseText = { running: t('执行中'), succeeded: t('已完成'), failed: t('失败'), cancelled: t('已取消') };
  const { controller, state, setAuto } = phone;
  const keybindings = useKeybindingsOptional();
  const presence = usePresence(state.open);
  const position = usePhonePosition(presence.mounted, anchor, anchorReady);
  const [snapshot, setSnapshot] = useState<AppSnapshot>(), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false), [search, setSearch] = useState('');
  const [standard, setStandard] = useState(false);
  const request = useRef(0), scrollPositions = useRef(new Map<string, number>()), searchInput = useRef<HTMLInputElement>(null);
  const routeKey = JSON.stringify(state.route);
  const [navigation, setNavigation] = useState(() => ({ key: routeKey, turn: 0, direction: 'forward' as 'forward' | 'back', scenes: [{ key: routeKey, route: state.route }] }));
  if (navigation.key !== routeKey) {
    const previous = navigation.scenes.find(scene => scene.key === navigation.key)?.route;
    const direction = !state.route.appId && !state.route.settings || previous?.appId === state.route.appId && (previous?.entityId && !state.route.entityId || previous?.editCommand && !state.route.editCommand || previous?.channelId && !state.route.channelId || previous?.accountId && !state.route.accountId || previous?.folder && !state.route.folder || previous?.viewId === 'bindings' && state.route.viewId !== 'bindings') ? 'back' : 'forward';
    // Install both layers before paint; usePresence retains the outgoing tiles.
    setNavigation({ key: routeKey, turn: navigation.turn + 1, direction, scenes: [...navigation.scenes.filter(scene => scene.key !== routeKey).slice(-2), { key: routeKey, route: state.route }] });
    setStandard(false); setSearch('');
  }
  const refresh = useCallback(() => {
    const current = ++request.current;
    void window.api.agentApps.snapshot(workspaceId).then(value => { if (request.current === current) { setSnapshot(value); setError(''); } }).catch(err => { if (request.current === current) setError(String(err)); });
  }, [workspaceId]);
  useEffect(() => { setSnapshot(undefined); }, [workspaceId]);
  useEffect(() => { if (state.open) refresh(); return () => { request.current++; }; }, [workspaceId, state.open, refresh]);
  useEffect(() => window.api.on('agentApps:changed', event => { if (event.workspaceId === workspaceId) { setRevision(previous => previous + 1); if (state.open) refresh(); } }), [workspaceId, state.open, refresh]);
  const navigate = useCallback((route: PhoneRoute) => { controller.manual(route); setSearchOpen(false); setSearch(''); }, [controller]);
  const selectCustom = useCallback((entityId: string) => navigate({ ...state.route, entityId }), [navigate, routeKey]);
  const back = useCallback(() => {
    if (searchOpen) { setSearchOpen(false); setSearch(''); controller.interact(false); return; }
    if (state.route.editCommand) navigate({ ...state.route, editCommand: undefined });
    else if (state.route.entityId) navigate({ ...state.route, entityId: undefined });
    else if (state.route.accountId) navigate({ ...state.route, accountId: undefined });
    else if (state.route.folder) navigate({ ...state.route, folder: undefined });
    else if (state.route.channelId) navigate({ appId: state.route.appId, viewId: state.route.viewId });
    else if (state.route.appId === CHANNEL_APP_ID && state.route.viewId === 'bindings') navigate({ appId: CHANNEL_APP_ID, viewId: 'main' });
    else if (state.route.appId || state.route.settings) navigate({});
    else controller.close();
  }, [searchOpen, routeKey, controller, navigate]);
  const renderPage = (route: PhoneRoute, active: boolean) => {
    if (!snapshot) return <p className="ap-empty">{t('正在打开我的应用…')}</p>;
    if (route.settings) return <><header className="ap-heading ap-flight"><small>MY PHONE</small><h2>{t('设置')}</h2></header><PhoneSettings workspaceId={workspaceId} snapshot={snapshot} auto={state.auto} setAuto={setAuto} refresh={refresh}/></>;
    const installation = snapshot.apps.find(a => a.definition.id === route.appId);
    if (!route.appId) return <><header className="ap-heading ap-flight"><small>{workspaceName}</small><h2>{t('我的应用')}</h2></header><div className="ap-scroll ap-home">{snapshot.apps.filter(a => a.enabled && !isLegacyChannelApp(a.definition.id) && (!search || a.definition.name.includes(search) || phoneAppName(a.definition).toLowerCase().includes(search.toLowerCase()) || a.definition.description.includes(search))).map((item, i) => <button className="ap-tile ap-flight" key={item.definition.id} style={{ '--ap-i': Math.min(i + 2, FEATHER_STEPS) } as React.CSSProperties} onClick={() => navigate({ appId: item.definition.id, viewId: item.definition.homeView })}><span aria-hidden>{item.definition.icon}</span><strong>{phoneAppName(item.definition)}</strong></button>)}<button className="ap-home-settings ap-flight" onClick={() => navigate({ settings: true })}>{t('设置与连接 →')}</button></div></>;
    if (!installation?.enabled) return <p className="ap-empty">{t('应用已停用或不可用')}<button onClick={() => navigate({ settings: true })}>{t('管理应用')}</button></p>;
    if (route.appId === CHANNEL_APP_ID) return <ChannelAppView workspaceId={workspaceId} workspaceName={workspaceName} route={route} search={search} revision={revision} active={active && state.open} navigate={navigate}/>;
    const app: AgentAppDefinition = localizeBuiltinApp(installation.definition);
    const view: AppView | undefined = app.views.find(v => v.id === (route.viewId ?? app.homeView));
    if (!view) return <div className="ap-empty"><ErrorTip message={active ? t('页面不存在，请返回应用首页') : null} /><button onClick={() => navigate({ appId: app.id, viewId: app.homeView })}>{t('应用首页')}</button></div>;
    const operation = state.operation?.appId === app.id ? state.operation : undefined;
    const originalCommand = operation && installation.definition.commands.find(command => command.id === operation.commandId);
    const operationTitle = operation && originalCommand?.title === operation.title
      ? app.commands.find(command => command.id === operation.commandId)?.title ?? operation.title : operation?.title;
    const dataView = view.kind === 'custom' && standard ? { ...view, kind: 'list' as const } : view;
    return <>
      <header className="ap-heading ap-flight"><small>{phoneAppName(app).toUpperCase()} / MY APPS</small><h2>{route.editCommand ? t('编辑') : view.title}</h2></header>
      <ErrorTip message={active && state.open && operation?.error ? [operationTitle, localizeAppUserErrorText(operation.error)].filter(Boolean).join('：') : null} />
      {app.views.filter(v => v.kind !== 'operation').length > 1 && !route.entityId && !route.editCommand && <nav className="ap-pivot ap-flight" aria-label={t('应用页面')}>{app.views.filter(v => v.kind !== 'operation').map(v => <button key={v.id} aria-pressed={view.id === v.id} onClick={() => navigate({ appId: app.id, viewId: v.id })}>{v.title}</button>)}</nav>}
      {view.kind === 'operation' || view.kind === 'custom' && standard && !view.collection ? <div className="ap-scroll"><p>{operation ? `${operationTitle} · ${phaseText[operation.phase]}` : t('等待应用操作')}</p></div> : view.collection ? <AppDataView key={`${workspaceId}:${app.id}:${view.id}`} workspaceId={workspaceId} app={app} view={dataView} route={route} navigate={navigate} connections={snapshot.connections} search={search} revision={revision} scrollPositions={scrollPositions.current} custom={view.kind === 'custom' && !standard ? <CustomAppView workspaceId={workspaceId} app={app} view={view} entityId={route.entityId} operation={operation} revision={revision} select={selectCustom} interact={editing => controller.interact(editing)} fallback={() => setStandard(true)}/> : undefined}/> : <CustomAppView workspaceId={workspaceId} app={app} view={view} entityId={route.entityId} operation={operation} revision={revision} select={selectCustom} interact={editing => controller.interact(editing)} fallback={() => setStandard(true)}/>}
    </>;
  };
  if (!presence.mounted) return null;
  return createPortal(<aside className="agent-phone-panel mp-panel" data-overlay-root style={position} {...presence.spread} role="region" aria-label={t('{{name}}的手机', { name: workspaceName })} aria-hidden={!state.open} {...(!state.open ? { inert: '' } : {}) as object} onKeyDown={e => { if (!keybindings && e.key === 'Escape' && !e.nativeEvent.isComposing) { e.stopPropagation(); controller.close(); } }}>
    <div className="ap-device">
      <img className="ap-frame" src={lumiaFrame} alt={t('黄色 Lumia 930')} draggable={false}/>
      <div className="ap-screen" onFocusCapture={e => { if (e.target.matches('input,textarea,select,[contenteditable="true"]')) controller.interact(true); }} onBlurCapture={e => { if (!(e.relatedTarget instanceof Element) || !e.relatedTarget.matches('input,textarea,select,[contenteditable="true"]')) controller.interact(false); }}>
        <div className="ap-statusbar"><span>MY PHONE</span><span>▂▄▆　▰</span></div>
        {searchOpen && <div className="ap-search"><input ref={searchInput} aria-label={t('搜索应用内容')} value={search} placeholder={t('搜索')} onChange={e => setSearch(e.target.value)}/><button aria-label={t('取消搜索')} onClick={() => { setSearchOpen(false); setSearch(''); controller.interact(false); }}>×</button></div>}
        {error && <div className="ap-empty"><ErrorTip message={state.open ? error : null} /><button onClick={refresh}>{t('重试')}</button></div>}
        <div className="ap-scenes">{snapshot ? navigation.scenes.map(scene => <Scene key={scene.key} route={scene.route} turn={navigation.turn} direction={navigation.direction} fast={state.automatic} active={scene.key === routeKey}>{renderPage(scene.route, scene.key === routeKey)}</Scene>) : <p className="ap-empty">{t('正在打开我的应用…')}</p>}</div>
      </div>
      {/* The frame image supplies the three symbols; buttons are transparent hit areas. */}
      <nav className="ap-hardware" aria-label={t('手机导航')}><button type="button" aria-label={t('返回')} onClick={back}/><button type="button" aria-label={t('手机主页')} onClick={() => navigate({})}/><button type="button" aria-label={t('手机搜索')} onClick={() => { controller.interact(true); setSearchOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); }}/></nav>
    </div>
  </aside>, document.body);
}
