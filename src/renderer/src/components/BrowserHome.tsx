import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { applyBookmarkChange, bookmarkId, findBookmark, isBookmarkUrl, type BookmarkChange } from '../../../shared/bookmarks';
import type { BookmarkNode } from '../../../shared/rightWorkspace';
import { HOME_SEARCH_CHANGED, homeSearchEngineLabel, readHomeSearchPreferences, writeHomeSearchPreferences, type HomeSearchPreferences } from '../browserHomePreferences';
import { useRightWorkspace } from '../rightWorkspace';
import { useUiStore } from '../store';
import { bookmarkDisplayLabel } from '../bookmarkDisplay';
import { AppConfirmDialog } from './AppConfirmDialog';
import { BrowserHomeAppearanceDialog, useHomeAppearance } from './BrowserHomeAppearance';
import { BrowserHomeEditor, BrowserHomeEngines, type HomeEditorRequest } from './BrowserHomeDialogs';
import { IconBookmarkPlus, IconCheckSquare, IconChevronDown, IconChevronLeft, IconChevronRight, IconChevronUp, IconClipboard, IconClock, IconExternalLink, IconFile, IconFolder, IconFolderPlus, IconGlobe, IconImage, IconPencil, IconScissors, IconSearch, IconSliders, IconSort, IconTrash } from './icons';
import { usePresence } from './motion';
import '../styles/browser-home.css';

type Navigation = { path: string[]; cursors: Record<string, string> };
type Confirm = { title: string; detail?: string; danger?: boolean; run: () => void };
const ROOT = '__root__';
const navKey = (workspaceId: string): string => `muster.browser.home.navigation.v1:${workspaceId}`;

function readNavigation(workspaceId: string): Navigation {
  try {
    const value = JSON.parse(localStorage.getItem(navKey(workspaceId)) ?? 'null') as Navigation | null;
    return { path: Array.isArray(value?.path) ? value.path.filter(id => typeof id === 'string') : [], cursors: value?.cursors && typeof value.cursors === 'object' ? value.cursors : {} };
  } catch { return { path: [], cursors: {} }; }
}

function pathTo(nodes: BookmarkNode[], id: string, ancestors: BookmarkNode[] = []): BookmarkNode[] | null {
  for (const node of nodes) {
    if (node.id === id) return [...ancestors, node];
    const path = node.children && pathTo(node.children, id, [...ancestors, node]);
    if (path) return path;
  }
  return null;
}

function flatten(nodes: BookmarkNode[], label: (node: BookmarkNode) => string, ancestors: string[] = []): Array<{ node: BookmarkNode; path: string[] }> {
  return nodes.flatMap(node => [{ node, path: ancestors }, ...flatten(node.children ?? [], label, [...ancestors, label(node)])]);
}

function urlsOf(nodes: BookmarkNode[]): string[] {
  return nodes.flatMap(node => node.url ? [node.url] : urlsOf(node.children ?? []));
}

export function BrowserHome({ tabId, visible, active, workspaceId, sessionId }: {
  tabId: string; visible: boolean; active: boolean; workspaceId: string; sessionId: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const bridge = useRightWorkspace();
  const { flashTip } = useUiStore();
  const nodes = bridge?.model.bookmarks[workspaceId] ?? [];
  const canEdit = !!bridge && bridge.model.workspaceId === workspaceId && bridge.model.bookmarkDefaultsVersion[workspaceId] !== undefined;
  const [navigation, setNavigation] = useState<Navigation>(() => readNavigation(workspaceId));
  const [query, setQuery] = useState(''), [searchCursor, setSearchCursor] = useState(-1);
  const [mode, setMode] = useState<'browse' | 'multi' | 'organize'>('browse');
  const [temporarySort, setTemporarySort] = useState<'default' | 'name' | 'time'>('default');
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [cut, setCut] = useState<string[]>([]);
  const [editor, setEditor] = useState<HomeEditorRequest | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [enginesOpen, setEnginesOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const { appearance, imageUrl, loadError } = useHomeAppearance();
  const lastAppearanceError = useRef('');
  const [searchPrefs, setSearchPrefs] = useState<HomeSearchPreferences>(readHomeSearchPreferences);
  const [selectedEngines, setSelectedEngines] = useState<Set<string>>(() => new Set());
  const [engineCursor, setEngineCursor] = useState(0), [engineKeysActive, setEngineKeysActive] = useState(false);
  const searchPresence = usePresence(!!query.trim());
  const actionsPresence = usePresence(mode === 'organize');
  const searchRef = useRef<HTMLInputElement>(null), searchResultsRef = useRef<HTMLDivElement>(null), listRef = useRef<HTMLDivElement>(null);
  const focusOnce = useRef(false), storageWarned = useRef(false);
  const bridgeRef = useRef(bridge); bridgeRef.current = bridge;

  useEffect(() => {
    const update = () => setSearchPrefs(readHomeSearchPreferences());
    window.addEventListener(HOME_SEARCH_CHANGED, update);
    window.addEventListener('storage', update);
    return () => { window.removeEventListener(HOME_SEARCH_CHANGED, update); window.removeEventListener('storage', update); };
  }, []);
  useEffect(() => {
    if (!active || focusOnce.current) return;
    focusOnce.current = true;
    searchRef.current?.focus({ preventScroll: true });
  }, [active]);
  useEffect(() => {
    if (!workspaceId) return;
    try { localStorage.setItem(navKey(workspaceId), JSON.stringify(navigation)); }
    catch {
      if (!storageWarned.current) { storageWarned.current = true; flashTip(t('新标签页位置保存失败')); }
    }
  }, [navigation, workspaceId, flashTip, t]);
  useEffect(() => {
    if (!canEdit) return;
    const last = navigation.path.at(-1);
    if (last) {
      const actual = pathTo(nodes, last);
      const path = actual && !actual.at(-1)?.url ? actual.map(item => item.id) : [];
      if (path.join('\u0000') !== navigation.path.join('\u0000')) setNavigation(prev => ({ ...prev, path }));
    }
    setSelection(prev => {
      const next = new Set([...prev].filter(id => !!findBookmark(nodes, id)));
      return next.size === prev.size ? prev : next;
    });
  }, [nodes, navigation.path, canEdit]);
  useEffect(() => { if (!visible) { setEditor(null); setConfirm(null); setEnginesOpen(false); setAppearanceOpen(false); } }, [visible]);
  useEffect(() => {
    if (!loadError) lastAppearanceError.current = '';
    else if (visible && lastAppearanceError.current !== loadError) { lastAppearanceError.current = loadError; flashTip(loadError); }
  }, [loadError, visible, flashTip]);

  const folderId = navigation.path.at(-1) ?? null;
  const folder = folderId ? findBookmark(nodes, folderId) : null;
  const rawItems = folderId ? folder?.children ?? [] : nodes;
  const items = temporarySort === 'default' || mode === 'organize' ? rawItems : [...rawItems].sort((a, b) => {
    if (temporarySort === 'name') return (!!a.url === !!b.url ? a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }) : a.url ? 1 : -1);
    if (a.dateAdded == null && b.dateAdded != null) return 1;
    if (a.dateAdded != null && b.dateAdded == null) return -1;
    return (b.dateAdded ?? 0) - (a.dateAdded ?? 0);
  });
  const cursorKey = folderId ?? ROOT;
  const cursorId = items.some(node => node.id === navigation.cursors[cursorKey]) ? navigation.cursors[cursorKey] : items[0]?.id;
  const current = items.find(node => node.id === cursorId);
  const index = current ? items.indexOf(current) : -1;
  const parentId = navigation.path.length > 1 ? navigation.path[navigation.path.length - 2] : null;
  const parentItems = folderId ? parentId ? findBookmark(nodes, parentId)?.children ?? [] : nodes : [];
  const searchResults = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return [];
    const label = (node: BookmarkNode): string => bookmarkDisplayLabel(node, t);
    return flatten(nodes, label).filter(({ node }) => `${node.label} ${label(node)} ${node.url ?? ''} ${node.description ?? ''}`.toLocaleLowerCase().includes(term)).slice(0, 8);
  }, [nodes, query, t]);
  const defaultEngine = searchPrefs.engines.find(engine => engine.id === searchPrefs.defaultId) ?? searchPrefs.engines[0];
  useEffect(() => {
    const popup = searchResultsRef.current;
    if (!popup || !engineKeysActive) return;
    const selected = popup.querySelector<HTMLElement>(searchCursor < 0 ? '.browser-home-search-engines .is-keyboard-active' : '.browser-home-result.is-selected');
    if (!selected) return;
    const bounds = popup.getBoundingClientRect(), item = selected.getBoundingClientRect();
    if (item.top < bounds.top) popup.scrollTop -= bounds.top - item.top;
    else if (item.bottom > bounds.bottom) popup.scrollTop += item.bottom - bounds.bottom;
  }, [engineKeysActive, engineCursor, searchCursor, searchResults.length]);

  const change = (mutation: BookmarkChange): boolean => {
    if (!canEdit || !bridge) { flashTip(t('收藏夹尚未就绪')); return false; }
    const result = applyBookmarkChange(nodes, mutation);
    if (result.error) {
      flashTip(result.error === 'cycle' ? t('不能将文件夹移入自身') : result.error === 'limit' ? t('收藏夹层级或数量超过上限') : t('无法完成收藏夹操作'));
      return false;
    }
    bridge.dispatch({ type: 'bookmarkChange', workspaceId, change: mutation });
    return true;
  };
  const choose = (id: string, key = cursorKey) => setNavigation(prev => ({ ...prev, cursors: { ...prev.cursors, [key]: id } }));
  const enter = (node: BookmarkNode) => {
    if (node.url) return;
    setNavigation(prev => ({ ...prev, path: [...prev.path, node.id] }));
    setSelection(new Set());
  };
  const back = () => { setNavigation(prev => ({ ...prev, path: prev.path.slice(0, -1) })); setSelection(new Set()); };
  const selectedNodes = () => selection.size ? items.filter(node => selection.has(node.id)) : current ? [current] : [];

  const openUrls = (urls: string[], firstBackground = false) => {
    if (!urls.length) return;
    const initialModel = bridgeRef.current?.model;
    const parent = initialModel?.tabs.find(tab => tab.content.kind === 'web' && tab.content.browserId === tabId);
    const owner = { workspaceId, sessionId: parent?.sessionId ?? sessionId, scope: parent?.scope ?? 'session' as const, openerId: tabId };
    const currentWorkspace = initialModel?.workspaceId ?? workspaceId, currentSession = initialModel?.sessionId ?? sessionId;
    const perform = async () => {
      for (const [i, url] of urls.entries()) {
        const model = bridgeRef.current?.model;
        if (model && (model.workspaceId !== currentWorkspace || model.sessionId !== currentSession)) return;
        try { await window.api.browser.open({ url, ...owner, background: firstBackground || i > 0 }); }
        catch (error) { flashTip(String(error)); return; }
      }
    };
    if (urls.length > 10) setConfirm({ title: t('打开 {{count}} 个网页？', { count: urls.length }), run: () => { void perform(); } });
    else void perform();
  };
  const openSelected = (background = false) => openUrls(urlsOf(selectedNodes()), background);
  const copyCurrent = async () => {
    if (!current?.url) return;
    try { await navigator.clipboard.writeText(current.url); flashTip(t('链接已复制')); }
    catch (error) { flashTip(t('复制链接失败：{{error}}', { error: String(error) })); }
  };
  const copyDescription = async () => {
    if (!current?.description) return;
    try { await navigator.clipboard.writeText(current.description); flashTip(t('描述已复制')); }
    catch (error) { flashTip(t('复制失败：{{error}}', { error: String(error) })); }
  };
  const runSearch = () => {
    const term = query.trim(); if (!term) return;
    const activeEngine = engineKeysActive ? searchPrefs.engines[engineCursor] : searchPrefs.engines.find(engine => engine.id === searchPrefs.defaultId);
    const chosen = searchPrefs.engines.filter(engine => selectedEngines.has(engine.id) || engine.id === activeEngine?.id);
    openUrls(chosen.map(engine => engine.url.replace('%s', encodeURIComponent(term))));
  };
  const locate = (node: BookmarkNode) => {
    const path = pathTo(nodes, node.id); if (!path) return;
    const parents = path.slice(0, -1).map(item => item.id);
    setNavigation(prev => ({ path: parents, cursors: { ...prev.cursors, [parents.at(-1) ?? ROOT]: node.id } }));
    setQuery(''); setSearchCursor(-1); listRef.current?.focus();
  };
  const toggleSelection = (id: string) => setSelection(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const moveCursor = (delta: -1 | 1) => {
    if (items.length) choose(items[Math.max(0, Math.min(items.length - 1, Math.max(0, index) + delta))].id);
  };
  const toggleCurrentSelection = () => {
    if (!current) return;
    if (mode === 'browse') setMode('multi');
    toggleSelection(current.id);
  };
  const toggleOrganize = () => setMode(value => value === 'organize' ? 'browse' : 'organize');
  const focusList = () => listRef.current?.focus({ preventScroll: true });
  const startDelete = () => {
    const targets = selectedNodes(); if (!targets.length) return;
    setConfirm({ title: t('删除选中的 {{count}} 项收藏？', { count: targets.length }), detail: t('文件夹中的收藏也会被删除。'), danger: true, run: () => { change({ kind: 'remove', ids: targets.map(node => node.id) }); setSelection(new Set()); } });
  };
  const startSort = (sortMode: 'name' | 'time') => setConfirm({ title: sortMode === 'name' ? t('按名称整理全部收藏？') : t('按添加时间整理全部收藏？'), run: () => { change({ kind: 'sort', mode: sortMode }); } });
  const paste = (before: boolean) => {
    if (!cut.length) return;
    const remaining = items.filter(node => !cut.includes(node.id));
    const anchor = current ? remaining.findIndex(node => node.id === current.id) : -1;
    const insertion = anchor < 0 ? remaining.length : anchor + (before ? 0 : 1);
    if (change({ kind: 'move', ids: cut, parentId: folderId, index: insertion })) { setCut([]); setSelection(new Set()); }
  };
  const onListKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!active || editor || confirm || enginesOpen || appearanceOpen || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input,textarea,select')) return;
    const key = event.key;
    if (key === '/') { event.preventDefault(); searchRef.current?.focus(); return; }
    if (key === 'ArrowDown' || key === 'j' || key === 'ArrowUp' || key === 'k') {
      event.preventDefault(); moveCursor(key === 'j' || key === 'ArrowDown' ? 1 : -1); return;
    }
    if (key === 'ArrowLeft' || key === 'h') { event.preventDefault(); back(); return; }
    if ((key === 'ArrowRight' || key === 'l') && current && !current.url) { event.preventDefault(); enter(current); return; }
    if (key === 'Enter') { event.preventDefault(); openSelected(); return; }
    if (key === 'o' || key === 'O') { event.preventDefault(); openSelected(key === 'O'); return; }
    if (key === 'y') { event.preventDefault(); void copyCurrent(); return; }
    if (key === 'c') { event.preventDefault(); void copyDescription(); return; }
    if ((key === ' ' || key === 'v' && mode === 'organize') && current) { event.preventDefault(); toggleCurrentSelection(); return; }
    if (key === 'v' && mode !== 'organize') { event.preventDefault(); setMode(mode === 'multi' ? 'browse' : 'multi'); if (mode === 'multi') setSelection(new Set()); return; }
    if (key === 's' && mode === 'browse') { event.preventDefault(); setTemporarySort(value => value === 'default' ? 'name' : value === 'name' ? 'time' : 'default'); return; }
    if (key === 'e') { event.preventDefault(); toggleOrganize(); return; }
    if (key === 'Escape') { event.preventDefault(); if (cut.length) setCut([]); else { setMode('browse'); setSelection(new Set()); } return; }
    if (mode === 'multi' || mode === 'organize') {
      if (key === 'a') { event.preventDefault(); setSelection(selection.size === items.length ? new Set() : new Set(items.map(node => node.id))); return; }
      if (key === 'i' && mode === 'multi' || key === 'I' && mode === 'organize') { event.preventDefault(); setSelection(new Set(items.filter(node => !selection.has(node.id)).map(node => node.id))); return; }
    }
    if (mode !== 'organize' || !canEdit) return;
    if (key === 'r' && current) { event.preventDefault(); setEditor({ kind: 'rename', id: current.id, label: current.label }); }
    else if (key === 'i' && current) { event.preventDefault(); setEditor({ kind: 'description', id: current.id, description: current.description }); }
    else if (key === 'd') { event.preventDefault(); startDelete(); }
    else if (key === 'f') { event.preventDefault(); setEditor({ kind: 'folder', parentId: folderId }); }
    else if (key === 'b') { event.preventDefault(); setEditor({ kind: 'bookmark', parentId: folderId }); }
    else if (key === 'x') { event.preventDefault(); setCut(selectedNodes().map(node => node.id)); }
    else if (key === 'p' || key === 'P') { event.preventDefault(); paste(key === 'P'); }
    else if (key === 'm' && selection.size && current && !selection.has(current.id)) {
      event.preventDefault();
      const remaining = items.filter(node => !selection.has(node.id));
      const anchor = remaining.findIndex(node => node.id === current.id);
      if (change({ kind: 'move', ids: [...selection], parentId: folderId, index: anchor + 1 })) setSelection(new Set());
    }
    else if (key === 'n' || key === 't') { event.preventDefault(); startSort(key === 'n' ? 'name' : 'time'); }
  };

  const row = (node: BookmarkNode, opts: { selected?: boolean; onClick: () => void; onActivate?: () => void }) => <button key={node.id} type="button" className={`browser-home-row${opts.selected ? ' is-selected' : ''}${selection.has(node.id) ? ' is-multi' : ''}${cut.includes(node.id) ? ' is-cut' : ''}`} aria-pressed={opts.selected} aria-description={node.url ? undefined : t('{{count}} 项', { count: node.children?.length ?? 0 })} onClick={opts.onClick} onDoubleClick={() => { if (mode !== 'organize') opts.onActivate?.(); }}>
    {node.url ? node.favicon ? <img className="browser-home-favicon" src={node.favicon} alt=""/> : <IconGlobe size={16}/> : <IconFolder size={16}/>}<span className="browser-home-row-text"><span>{bookmarkDisplayLabel(node, t)}</span>{node.url ? <small>{node.url}</small> : <small aria-hidden="true">{t('{{count}} 项', { count: node.children?.length ?? 0 })}</small>}</span>{selection.has(node.id) ? <span aria-label={t('已选中')}>✓</span> : null}
  </button>;

  const percentage = (value: number) => `${Number(value.toFixed(4))}%`;
  const homeStyle = {
    '--browser-home-panel-opacity': percentage(100 - appearance.transparency),
    '--browser-home-control-opacity': percentage(100 - appearance.transparency * 0.55),
    '--browser-home-selection-opacity': percentage(100 - appearance.transparency * 0.6),
    '--browser-home-border-opacity': percentage(100 - appearance.transparency * 0.7),
    '--browser-home-material-blur': `${appearance.blur}px`
  } as React.CSSProperties;
  return <div className={`browser-home${appearance.wallpaper === 'default' ? ' browser-home-wallpaper-default' : ''}${appearance.blur ? ' has-material-blur' : ''}${visible ? '' : ' is-hidden'}`} style={homeStyle} data-browser-tab-id={tabId} aria-hidden={!visible} {...(visible ? {} : { inert: '' })}>
    <div className="browser-home-wallpaper-anchor" aria-hidden="true"><div className="browser-home-wallpaper-viewport"><div className={`browser-home-wallpaper-image${appearance.wallpaper === 'default' ? ' browser-home-wallpaper-default' : ''}`} style={appearance.wallpaper === 'custom' && imageUrl ? { backgroundImage: `url("${imageUrl}")` } : undefined}/></div></div>
    <div className="browser-home-inner">
      <div className="browser-home-search-area">
      <div className="browser-home-search">
        <IconSearch size={16}/>
        <input ref={searchRef} aria-label={t('搜索收藏或网页')} placeholder={t('搜索收藏或网页')} value={query} onChange={event => { setQuery(event.target.value); setSearchCursor(-1); setEngineKeysActive(false); }} onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); if (query) { setQuery(''); setSearchCursor(-1); setEngineKeysActive(false); setSelectedEngines(new Set()); } else listRef.current?.focus(); }
          else if (event.key === 'ArrowDown' && query.trim()) { event.preventDefault(); if (!engineKeysActive) { setEngineKeysActive(true); setEngineCursor(Math.max(0, searchPrefs.engines.findIndex(engine => engine.id === searchPrefs.defaultId))); } else setSearchCursor(prev => Math.min(searchResults.length - 1, prev + 1)); }
          else if (event.key === 'ArrowUp' && engineKeysActive) { event.preventDefault(); if (searchCursor < 0) setEngineKeysActive(false); else setSearchCursor(prev => Math.max(-1, prev - 1)); }
          else if (event.key === 'Tab' && engineKeysActive) { event.preventDefault(); if (searchCursor >= 0) setSearchCursor(-1); else setEngineCursor(prev => (prev + (event.shiftKey ? -1 : 1) + searchPrefs.engines.length) % searchPrefs.engines.length); }
          else if (engineKeysActive && searchCursor < 0 && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); setEngineCursor(prev => (prev + (event.key === 'ArrowRight' ? 1 : -1) + searchPrefs.engines.length) % searchPrefs.engines.length); }
          else if (engineKeysActive && searchCursor >= 0 && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); }
          else if (engineKeysActive && searchCursor < 0 && event.key === ' ') { event.preventDefault(); const engine = searchPrefs.engines[engineCursor]; if (event.shiftKey) setSelectedEngines(prev => prev.size === searchPrefs.engines.length ? new Set() : new Set(searchPrefs.engines.map(item => item.id))); else if (engine) setSelectedEngines(prev => { const next = new Set(prev); if (next.has(engine.id)) next.delete(engine.id); else next.add(engine.id); return next; }); }
          else if (event.key === 'Enter') { event.preventDefault(); const result = searchResults[searchCursor]; if (result) { if (result.node.url) openUrls([result.node.url]); else locate(result.node); } else runSearch(); }
        }}/>
        {defaultEngine ? <span className="browser-home-engine-name" role="status" aria-label={t('默认搜索引擎：{{name}}', { name: homeSearchEngineLabel(defaultEngine, t) })} title={t('默认搜索引擎：{{name}}', { name: homeSearchEngineLabel(defaultEngine, t) })}>{homeSearchEngineLabel(defaultEngine, t)}</span> : null}
        <button type="button" className="btn ghost browser-home-engine-settings" title={t('管理搜索引擎')} aria-label={t('管理搜索引擎')} onClick={() => setEnginesOpen(true)}><IconSliders size={16}/></button>
      </div>
      {searchPresence.mounted ? <div ref={searchResultsRef} className="browser-home-search-results mp-pop" {...searchPresence.spread} aria-hidden={!query.trim()} {...(query.trim() ? {} : { inert: '' })}>
        <div className="browser-home-search-engines">{searchPrefs.engines.map((engine, i) => <button key={engine.id} type="button" className={`btn${selectedEngines.has(engine.id) ? ' is-selected' : ''}${engineKeysActive && searchCursor < 0 && engineCursor === i ? ' is-keyboard-active' : ''}`} aria-pressed={selectedEngines.has(engine.id)} onClick={() => setSelectedEngines(prev => { const next = new Set(prev); if (next.has(engine.id)) next.delete(engine.id); else next.add(engine.id); return next; })}>{homeSearchEngineLabel(engine, t)}</button>)}<button type="button" className="btn primary" onClick={runSearch}>{t('搜索网页')}</button></div>
        {searchResults.map(({ node, path }, resultIndex) => <button type="button" key={node.id} className={`browser-home-result${searchCursor === resultIndex ? ' is-selected' : ''}`} onClick={() => node.url ? openUrls([node.url]) : locate(node)}><span>{bookmarkDisplayLabel(node, t)}</span><small>{path.join(' / ') || t('收藏夹')}</small></button>)}
      </div> : null}
      </div>
      <div className="browser-home-panel">
      <div className="browser-home-toolbar">
        <div className="browser-home-path"><button type="button" onClick={() => setNavigation(prev => ({ ...prev, path: [] }))}>{t('收藏夹')}</button>{navigation.path.map((id, i) => { const item = findBookmark(nodes, id); return item ? <React.Fragment key={id}><span>/</span><button type="button" onClick={() => setNavigation(prev => ({ ...prev, path: prev.path.slice(0, i + 1) }))}>{bookmarkDisplayLabel(item, t)}</button></React.Fragment> : null; })}</div>
        <button type="button" className="btn ghost browser-home-icon-button" title={t('新建文件夹')} aria-label={t('新建文件夹')} disabled={!canEdit} onClick={() => setEditor({ kind: 'folder', parentId: folderId })}><IconFolderPlus size={16}/></button>
        <button type="button" className="btn ghost browser-home-icon-button" title={t('新建收藏')} aria-label={t('新建收藏')} disabled={!canEdit} onClick={() => setEditor({ kind: 'bookmark', parentId: folderId })}><IconBookmarkPlus size={16}/></button>
        <button type="button" className="btn ghost browser-home-icon-button" title={t('壁纸与透明度')} aria-label={t('壁纸与透明度')} onClick={() => setAppearanceOpen(true)}><IconImage size={16}/></button>
      </div>
      <div className="browser-home-columns" ref={listRef} tabIndex={0} role="region" aria-label={t('收藏夹导航')} onKeyDown={onListKey}>
        <div className="browser-home-column browser-home-parent">{parentItems.map(node => row(node, { selected: node.id === folderId, onClick: () => { back(); choose(node.id, parentId ?? ROOT); } }))}</div>
        <div className="browser-home-column browser-home-current">{items.length ? items.map(node => row(node, { selected: node.id === cursorId, onClick: () => { if (mode === 'multi') toggleSelection(node.id); choose(node.id); listRef.current?.focus(); }, onActivate: () => node.url ? openUrls([node.url]) : enter(node) })) : <div className="browser-home-empty">{t('此文件夹暂无收藏')}</div>}</div>
        <div className="browser-home-column browser-home-preview">{current ? current.url ? <div className="browser-home-details"><strong>{bookmarkDisplayLabel(current, t)}</strong><a href={current.url} onClick={event => { event.preventDefault(); openUrls([current.url!]); }}>{current.url}</a>{current.description ? <p>{current.description}</p> : null}<small>{current.dateAdded != null ? t('添加于 {{date}}', { date: new Date(current.dateAdded).toLocaleDateString() }) : t('添加时间未知')}</small></div> : (current.children ?? []).map(node => row(node, { onClick: () => { enter(current); choose(node.id, current.id); } })) : null}</div>
      </div>
      <div className={`browser-home-footer${mode === 'organize' ? ' is-organizing' : ''}`}>
        <div className="browser-home-navigation" role="toolbar" aria-label={t('收藏导航操作')}>
          <button type="button" className="btn ghost browser-home-direction" title={`${t('返回上一级')} (← / H)`} aria-label={t('返回上一级')} disabled={!navigation.path.length} onClick={() => { back(); focusList(); }}><IconChevronLeft size={15}/></button>
          <button type="button" className="btn ghost browser-home-direction" title={`${t('上一项')} (↑ / K)`} aria-label={t('上一项')} disabled={index <= 0} onClick={() => { moveCursor(-1); focusList(); }}><IconChevronUp size={15}/></button>
          <button type="button" className="btn ghost browser-home-direction" title={`${t('下一项')} (↓ / J)`} aria-label={t('下一项')} disabled={index < 0 || index >= items.length - 1} onClick={() => { moveCursor(1); focusList(); }}><IconChevronDown size={15}/></button>
          <button type="button" className="btn ghost browser-home-direction" title={`${t('进入文件夹')} (→ / L)`} aria-label={t('进入文件夹')} disabled={!current || !!current.url} onClick={() => { if (current) enter(current); focusList(); }}><IconChevronRight size={15}/></button>
          <button type="button" className="btn ghost browser-home-action" title={`${t('打开选中收藏')} (Enter)`} aria-label={t('打开选中收藏')} disabled={!urlsOf(selectedNodes()).length} onClick={() => openSelected()}><IconExternalLink size={15}/><kbd aria-hidden="true">Enter</kbd></button>
          <button type="button" className={`btn ghost browser-home-action${current && selection.has(current.id) ? ' is-selected' : ''}`} title={`${t('选择当前项')} (Space)`} aria-label={t('选择当前项')} aria-pressed={!!current && selection.has(current.id)} disabled={!current} onClick={() => { toggleCurrentSelection(); focusList(); }}><IconCheckSquare size={15}/><kbd aria-hidden="true">Space</kbd></button>
          <button type="button" className={`btn ghost browser-home-action${mode === 'organize' ? ' is-selected' : ''}`} title={`${mode === 'organize' ? t('退出整理模式') : t('进入整理模式')} (E / Esc)`} aria-label={mode === 'organize' ? t('退出整理模式') : t('进入整理模式')} aria-pressed={mode === 'organize'} disabled={!canEdit} onClick={() => { toggleOrganize(); focusList(); }}><IconSliders size={15}/><kbd aria-hidden="true">E</kbd></button>
        </div>
        {actionsPresence.mounted ? <div className="browser-home-actions mp-panel" role="toolbar" aria-label={t('收藏整理操作')} {...actionsPresence.spread} aria-hidden={mode !== 'organize'} {...(mode === 'organize' ? {} : { inert: '' })}>
          <button type="button" className="btn ghost browser-home-action" title={`${t('重命名')} (R)`} aria-label={t('重命名')} disabled={!current} onClick={() => current && setEditor({ kind: 'rename', id: current.id, label: current.label })}><IconPencil size={15}/><kbd aria-hidden="true">R</kbd></button>
          <button type="button" className="btn ghost browser-home-action" title={`${t('编辑描述')} (I)`} aria-label={t('编辑描述')} disabled={!current} onClick={() => current && setEditor({ kind: 'description', id: current.id, description: current.description })}><IconFile size={15}/><kbd aria-hidden="true">I</kbd></button>
          <button type="button" className="btn ghost browser-home-action" title={`${t('剪切')} (X)`} aria-label={t('剪切')} disabled={!current} onClick={() => setCut(selectedNodes().map(node => node.id))}><IconScissors size={15}/><kbd aria-hidden="true">X</kbd></button>
          <button type="button" className="btn ghost browser-home-action" title={`${t('粘贴')} (P)`} aria-label={t('粘贴')} disabled={!cut.length} onClick={() => paste(false)}><IconClipboard size={15}/><kbd aria-hidden="true">P</kbd></button>
          <button type="button" className="btn ghost browser-home-action" title={`${t('删除')} (D)`} aria-label={t('删除')} disabled={!current} onClick={startDelete}><IconTrash size={15}/><kbd aria-hidden="true">D</kbd></button>
          <button type="button" className="btn ghost browser-home-action" title={`${t('按名称排序')} (N)`} aria-label={t('按名称排序')} onClick={() => startSort('name')}><IconSort size={15}/><kbd aria-hidden="true">N</kbd></button>
          <button type="button" className="btn ghost browser-home-action" title={`${t('按时间排序')} (T)`} aria-label={t('按时间排序')} onClick={() => startSort('time')}><IconClock size={15}/><kbd aria-hidden="true">T</kbd></button>
        </div> : null}
      </div>
      </div>
    </div>
    <BrowserHomeEditor request={editor} onClose={() => setEditor(null)} onSave={(request, value) => {
      if (request.kind === 'rename' && request.id) return change({ kind: 'update', id: request.id, label: value.label }) ? null : t('请输入有效名称');
      if (request.kind === 'description' && request.id) return change({ kind: 'update', id: request.id, description: value.description }) ? null : t('无法保存描述');
      if (!value.label.trim()) return t('请输入有效名称');
      if (request.kind === 'bookmark' && !isBookmarkUrl(value.url)) return t('请输入有效的网页或文件网址');
      const node: BookmarkNode = { id: bookmarkId(), label: value.label.trim(), dateAdded: Date.now(), ...(request.kind === 'bookmark' ? { url: value.url.trim() } : { children: [] }) };
      return change({ kind: 'add', parentId: request.parentId ?? null, node }) ? null : t('无法完成收藏夹操作');
    }}/>
    <AppConfirmDialog open={!!confirm} title={confirm?.title ?? ''} detail={confirm?.detail} danger={confirm?.danger} onCancel={() => setConfirm(null)} onConfirm={() => { const action = confirm; setConfirm(null); action?.run(); }}/>
    <BrowserHomeEngines open={enginesOpen} value={searchPrefs} onClose={() => setEnginesOpen(false)} onChange={value => { try { writeHomeSearchPreferences(value); } catch (error) { flashTip(t('搜索引擎保存失败：{{error}}', { error: String(error) })); } }}/>
    <BrowserHomeAppearanceDialog open={appearanceOpen} appearance={appearance} imageUrl={imageUrl} loadError={loadError} onClose={() => setAppearanceOpen(false)} onError={flashTip}/>
  </div>;
}
