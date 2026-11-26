import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MOTION, usePresence, usePresenceValue } from '../../../src/renderer/src/components/motion';

export type ContentKind = 'file' | 'image' | 'git' | 'diff' | 'web';
export interface Content { kind: ContentKind; key: string; title: string; path: string; view?: 'changes' | 'history' | 'pr' }
export interface Tab { id: string; project: string; session: string; pinned: boolean; preview: boolean; content: Content; draft?: string; editing?: boolean; zoom?: number; rotation?: number }
interface Visit { tabId: string; content: Content }
interface History { entries: Visit[]; index: number }
interface BrowserUi { favoritesOpen: boolean; expanded: string[] }
export type ResourcePanel = 'files' | 'git' | 'browser';
interface ResourceUi { panel: ResourcePanel; collapsed: boolean; expanded: Record<ResourcePanel, string[]> }
export interface TabsModel { project: string; session: string; tabs: Tab[]; selected: Record<string, string>; histories: Record<string, History>; closed: Tab[]; nextId: number; browserUi?: BrowserUi; resources?: ResourceUi }
export type Action =
  | { type: 'open'; content: Content; source: 'preview' | 'keep' }
  | { type: 'select'; id: string }
  | { type: 'scope'; project?: string; session: string }
  | { type: 'pin' | 'keep' | 'close'; id: string }
  | { type: 'closeOthers' | 'closeRight'; id: string }
  | { type: 'reopen' }
  | { type: 'history'; dir: -1 | 1 }
  | { type: 'update'; id: string; patch: Partial<Pick<Tab, 'draft' | 'editing' | 'zoom' | 'rotation'>> }
  | { type: 'navigate'; id: string; content: Content }
  | { type: 'favorites'; open?: boolean; folder?: string }
  | { type: 'resources'; panel?: ResourcePanel; collapsed?: boolean; folder?: string; reveal?: string }
  | { type: 'move'; id: string; before: string };

export const FILES: Content[] = [
  { kind: 'file', key: 'design.md', title: 'design.md', path: 'design.md' },
  { kind: 'file', key: 'SideToolsPanel.tsx', title: 'SideToolsPanel.tsx', path: 'src/renderer/src/panels/SideToolsPanel.tsx' },
  { kind: 'file', key: 'FilesPanel.tsx', title: 'FilesPanel.tsx', path: 'src/renderer/src/panels/FilesPanel.tsx' },
  { kind: 'image', key: 'prototype.png', title: 'prototype.png', path: 'docs/prototypes/prototype.png' },
  { kind: 'file', key: 'browser.css', title: 'browser.css', path: 'src/renderer/src/styles/browser.css' }
];
export const GIT: Content = { kind: 'git', key: 'git:workbench', title: '代码审核', path: 'metaagent-workbench', view: 'changes' };
export const WEB: Content = { kind: 'web', key: 'web:preview', title: '交互原型', path: 'localhost:5188/preview' };
export const SETTINGS_WEB: Content = { kind: 'web', key: 'web:settings', title: '设置页原型', path: 'localhost:5188/settings' };
type TreeNode = { id: string; title: string; children: TreeNode[]; content?: Content } | { id: string; content: Content; meta?: string };
const FAVORITES: TreeNode[] = [
  { id: 'prototypes', title: '项目原型', children: [
    { id: 'preview', content: WEB },
    { id: 'settings', title: '设置页', children: [
      { id: 'settings-page', content: SETTINGS_WEB },
      { id: 'capabilities', content: { kind: 'web', key: 'web:capabilities', title: '能力管理', path: 'localhost:5188/settings/capabilities' } }
    ] }
  ] },
  { id: 'references', title: '开发参考', children: [
    { id: 'react', content: { kind: 'web', key: 'web:react', title: 'React 文档', path: 'react.dev/reference' } },
    { id: 'electron', content: { kind: 'web', key: 'web:electron', title: 'Electron 文档', path: 'electronjs.org/docs/latest' } }
  ] }
];
const initialBrowserUi = (): BrowserUi => ({ favoritesOpen: true, expanded: ['prototypes', 'settings'] });
const FILE_TREE: TreeNode[] = [{ id: 'project', title: 'metaagent-workbench', children: [
  { id: 'source', title: 'src/renderer/src', children: [
    { id: 'panels', title: 'panels', children: [{ id: 'side-tools', content: FILES[1] }, { id: 'files-panel', content: FILES[2] }] },
    { id: 'styles', title: 'styles', children: [{ id: 'browser-style', content: FILES[4] }] }
  ] },
  { id: 'prototype-files', title: 'docs/prototypes', children: [{ id: 'prototype-image', content: FILES[3] }] },
  { id: 'design', content: FILES[0] }
] }];
const REPO_TREE: TreeNode[] = [
  { id: 'workspace-repos', title: '工作区', children: [
    { id: 'main-repo', title: 'metaagent-workbench', content: GIT, children: [
      { id: 'packages', title: 'packages', children: [{ id: 'ui-kit', meta: '2', content: { kind: 'git', key: 'git:ui-kit', title: 'ui-kit', path: 'packages/ui-kit', view: 'changes' } }] }
    ] }
  ] },
  { id: 'external-repos', title: '外部仓库', children: [{ id: 'docs-site', meta: '0', content: { kind: 'git', key: 'git:docs-site', title: 'docs-site', path: 'docs-site', view: 'changes' } }] }
];
function treeParents(nodes: TreeNode[], key: string, parents: string[] = []): string[] | undefined {
  for (const node of nodes) {
    if (node.content?.key === key) return parents;
    if ('children' in node) { const chain = treeParents(node.children, key, [...parents, node.id]); if (chain) return chain; }
  }
}
const resourcePanelFor = (kind?: ContentKind): ResourcePanel => kind === 'web' ? 'browser' : kind === 'file' || kind === 'image' ? 'files' : 'git';
function initialResourceUi(s?: TabsModel): ResourceUi {
  return { panel: resourcePanelFor(s ? activeTab(s)?.content.kind : undefined), collapsed: false, expanded: { files: ['project', 'source', 'panels', 'prototype-files'], git: ['workspace-repos', 'main-repo', 'packages', 'external-repos'], browser: s?.browserUi?.expanded ?? initialBrowserUi().expanded } };
}
function followContentPanel(s: TabsModel, content = activeTab(s)?.content): TabsModel {
  const ui = s.resources ?? initialResourceUi(s), panel = content ? resourcePanelFor(content.kind) : ui.panel;
  if (s.resources && ui.panel === panel) return s;
  return { ...s, resources: { ...ui, panel } };
}
export const DIFF: Content = { kind: 'diff', key: 'diff:SideToolsPanel.tsx', title: 'SideToolsPanel.tsx', path: 'src/renderer/src/panels/SideToolsPanel.tsx' };
const code = 'export function SideToolsPanel() {\n  const tabs = useRightTabs();\n  const active = tabs.current;\n\n  return (\n    <RightWorkspace>\n      <TabStrip tabs={tabs.visible} />\n      <ContentTools content={active} />\n      <ContentView content={active} />\n    </RightWorkspace>\n  );\n}';
const scopeKey = (s: TabsModel) => `${s.project}/${s.session}`;
const sameContent = (a: Content, b: Content) => a.key === b.key || (a.kind === 'web' && b.kind === 'web' && a.path === b.path);
export const visibleTabs = (s: TabsModel) => s.tabs.filter(t => t.project === s.project && (t.pinned || t.session === s.session)).sort((a, b) => Number(b.pinned) - Number(a.pinned));
export function activeTab(s: TabsModel): Tab | undefined {
  const visible = visibleTabs(s);
  return visible.find(t => t.id === s.selected[scopeKey(s)]) ?? visible.find(t => !t.pinned) ?? visible[0];
}
export function initialTabs(): TabsModel {
  const tabs: Tab[] = [
    { id: 'guide', project: 'workbench', session: 'review', pinned: true, preview: false, content: FILES[0] },
    { id: 'review', project: 'workbench', session: 'review', pinned: false, preview: false, content: GIT },
    { id: 'build', project: 'workbench', session: 'build', pinned: false, preview: false, content: { ...GIT, key: 'git:worktree', title: '界面开发', path: 'codex/right-tabs' } },
    { id: 'other', project: 'demo', session: 'review', pinned: false, preview: false, content: { ...GIT, key: 'git:demo', title: '文档站', path: 'docs-site' } }
  ];
  return { project: 'workbench', session: 'review', tabs, selected: { 'workbench/review': 'review', 'workbench/build': 'build', 'demo/review': 'other' }, histories: { 'workbench/review': { entries: [{ tabId: 'review', content: GIT }], index: 0 } }, closed: [], nextId: 1, browserUi: initialBrowserUi() };
}
function focus(s: TabsModel, tab: Tab, record = true): TabsModel {
  const scope = scopeKey(s);
  const next = followContentPanel({ ...s, selected: { ...s.selected, [scope]: tab.id } }, tab.content);
  if (!record) return next;
  const history = s.histories[scope] ?? { entries: [], index: -1 };
  const visit = { tabId: tab.id, content: { ...tab.content } };
  if (JSON.stringify(history.entries[history.index]) === JSON.stringify(visit)) return next;
  const entries = [...history.entries.slice(0, history.index + 1), visit].slice(-40);
  return { ...next, histories: { ...s.histories, [scope]: { entries, index: entries.length - 1 } } };
}
function open(s: TabsModel, content: Content, source: 'preview' | 'keep', record = true): TabsModel {
  const existing = visibleTabs(s).find(t => sameContent(t.content, content));
  if (existing) {
    const tab = { ...existing, content, preview: source === 'keep' ? false : existing.preview };
    return focus({ ...s, tabs: s.tabs.map(t => t.id === tab.id ? tab : t) }, tab, record);
  }
  const preview = source === 'preview' ? visibleTabs(s).find(t => t.preview && !t.pinned) : undefined;
  const tab: Tab = { id: preview?.id ?? `tab-${s.nextId}`, project: s.project, session: s.session, pinned: false, preview: source === 'preview', content };
  const tabs = preview ? s.tabs.map(t => t.id === preview.id ? tab : t) : [...s.tabs, tab];
  return focus({ ...s, tabs, nextId: preview ? s.nextId : s.nextId + 1 }, tab, record);
}
function closeTabs(s: TabsModel, ids: string[]): TabsModel {
  const closing = s.tabs.filter(t => ids.includes(t.id));
  const current = activeTab(s);
  const visible = visibleTabs(s);
  const index = visible.findIndex(t => t.id === current?.id);
  const tabs = s.tabs.filter(t => !ids.includes(t.id));
  let next = { ...s, tabs, closed: [...s.closed, ...closing].slice(-12) };
  if (current && ids.includes(current.id)) {
    const replacement = [...visible.slice(index + 1), ...visible.slice(0, index).reverse()].find(t => !ids.includes(t.id));
    if (replacement) next = focus(next, replacement);
  }
  return next;
}
export function reduceTabs(s: TabsModel, action: Action): TabsModel {
  const tab = 'id' in action ? s.tabs.find(t => t.id === action.id) : undefined;
  switch (action.type) {
    case 'open': return open(s, action.content, action.source);
    case 'select': return tab && visibleTabs(s).includes(tab) ? focus(s, tab) : s;
    case 'scope': return followContentPanel({ ...s, project: action.project ?? s.project, session: action.session });
    case 'keep': return tab ? { ...s, tabs: s.tabs.map(t => t.id === tab.id ? { ...t, preview: false } : t) } : s;
    case 'pin': return tab ? { ...s, tabs: s.tabs.map(t => t.id === tab.id ? { ...t, pinned: !t.pinned, preview: false, session: s.session } : t) } : s;
    case 'update': return tab ? { ...s, tabs: s.tabs.map(t => t.id === tab.id ? { ...t, ...action.patch, preview: action.patch.editing || action.patch.draft !== undefined ? false : t.preview } : t) } : s;
    case 'navigate': return tab ? focus({ ...s, tabs: s.tabs.map(t => t.id === tab.id ? { ...t, content: action.content } : t) }, { ...tab, content: action.content }) : s;
    case 'favorites': {
      const ui = s.browserUi ?? initialBrowserUi();
      const expanded = action.folder ? ui.expanded.includes(action.folder) ? ui.expanded.filter(id => id !== action.folder) : [...ui.expanded, action.folder] : ui.expanded;
      return { ...s, browserUi: { favoritesOpen: action.open ?? ui.favoritesOpen, expanded } };
    }
    case 'resources': {
      const ui = s.resources ?? initialResourceUi(s), panel = action.panel ?? ui.panel;
      let expanded = action.folder ? { ...ui.expanded, [panel]: ui.expanded[panel].includes(action.folder) ? ui.expanded[panel].filter(id => id !== action.folder) : [...ui.expanded[panel], action.folder] } : ui.expanded;
      if (action.reveal && panel === 'files') expanded = { ...expanded, files: [...new Set([...expanded.files, ...(treeParents(FILE_TREE, action.reveal) ?? [])])] };
      return { ...s, resources: { panel, collapsed: action.collapsed ?? (action.panel ? false : ui.collapsed), expanded } };
    }
    case 'move': {
      if (!tab) return s;
      const target = s.tabs.find(t => t.id === action.before);
      if (!target || target.pinned !== tab.pinned || target.project !== tab.project || (!tab.pinned && target.session !== tab.session)) return s;
      const tabs = s.tabs.filter(t => t.id !== tab.id);
      tabs.splice(tabs.findIndex(t => t.id === target.id), 0, tab);
      return { ...s, tabs };
    }
    case 'close': return closeTabs(s, [action.id]);
    case 'closeOthers': return closeTabs(s, visibleTabs(s).filter(t => t.id !== action.id && !t.pinned).map(t => t.id));
    case 'closeRight': {
      const visible = visibleTabs(s);
      return closeTabs(s, visible.slice(visible.findIndex(t => t.id === action.id) + 1).filter(t => !t.pinned).map(t => t.id));
    }
    case 'reopen': {
      const last = [...s.closed].reverse().find(t => t.project === s.project && (t.pinned || t.session === s.session));
      if (!last) return s;
      const existing = visibleTabs(s).find(t => sameContent(t.content, last.content));
      const next = { ...s, closed: s.closed.filter(t => t.id !== last.id), tabs: existing ? s.tabs : [...s.tabs, last] };
      return focus(next, existing ?? last);
    }
    case 'history': {
      const key = scopeKey(s), history = s.histories[key];
      if (!history) return s;
      const index = history.index + action.dir, visit = history.entries[index];
      if (!visit) return s;
      let next = { ...s, histories: { ...s.histories, [key]: { ...history, index } } };
      const old = s.tabs.find(t => t.id === visit.tabId && visibleTabs(s).includes(t));
      // A reused preview must never overwrite an edited file when replaying its old visit.
      if (old && (old.content.key === visit.content.key || old.content.kind === 'web')) {
        const restored = { ...old, content: visit.content };
        next = { ...next, tabs: next.tabs.map(t => t.id === old.id ? restored : t) };
        return focus(next, restored, false);
      }
      return open(next, visit.content, 'keep', false);
    }
  }
}

function Icon({ name }: { name: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = document.createElement('i');
    node.setAttribute('data-lucide', name); node.setAttribute('aria-hidden', 'true');
    ref.current?.replaceChildren(node);
    const lucide = (globalThis as unknown as { lucide?: { createIcons: (options: object) => void } }).lucide;
    lucide?.createIcons({ attrs: { width: 16, height: 16, 'stroke-width': 1.5 } });
  }, [name]);
  return <span className="st-icon" ref={ref} aria-hidden="true" />;
}
const kindIcon = (kind: ContentKind) => ({ file: 'file-text', image: 'image', git: 'git-branch', diff: 'file-diff', web: 'globe' })[kind];
function Tool({ icon, label, onClick, disabled, pressed, expanded, controls, className = '' }: { icon: string; label: string; onClick?: () => void; disabled?: boolean; pressed?: boolean; expanded?: boolean; controls?: string; className?: string }) {
  return <button type="button" className={`st-tool cursor-interaction ${className}`} aria-label={label} data-tooltip={label} disabled={disabled} aria-pressed={pressed} aria-expanded={expanded} aria-controls={controls} onClick={onClick}><Icon name={icon} /></button>;
}
type Popup = { kind: 'new' | 'manage' | 'files' | 'search' | 'repos' | 'find' | 'tools' | 'address' | 'branch'; tabId?: string; title: string };

export function SideToolsTabsPrototype({ imageSource, initialState, onStateChange }: { imageSource?: string; initialState?: TabsModel; onStateChange?: (state: TabsModel) => void }) {
  const [model, setModel] = useState<TabsModel>(() => followContentPanel(initialState ?? initialTabs()));
  const [popup, setPopup] = useState<Popup | null>(null);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [chatDraft, setChatDraft] = useState('');
  const root = useRef<HTMLDivElement>(null), surface = useRef<HTMLElement>(null), trigger = useRef<HTMLElement | null>(null);
  const dragging = useRef<string | null>(null);
  const visible = visibleTabs(model), current = activeTab(model), history = model.histories[scopeKey(model)];
  const resourceUi = model.resources ?? initialResourceUi(model);
  const { presence: resourcePresence, value: resourcePanel } = usePresenceValue(resourceUi.collapsed ? null : resourceUi.panel, MOTION.exitMs);
  const { presence, value: menu } = usePresenceValue(popup, MOTION.microMs);
  const dispatch = (action: Action) => setModel(s => { const next = reduceTabs(s, action); onStateChange?.(next); return next; });
  const closeMenu = () => { setPopup(null); trigger.current?.focus(); };
  const showMenu = (kind: Popup['kind'], title: string, tabId?: string) => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery(kind === 'address' ? current?.content.path ?? '' : '');
    setPopup(popup?.kind === kind && popup.tabId === tabId ? null : { kind, title, tabId });
  };
  const openContent = (content: Content, source: 'preview' | 'keep' = 'keep') => { dispatch({ type: 'open', content, source }); setPopup(null); setNotice(''); };
  useLayoutEffect(() => {
    const tab = root.current?.querySelector<HTMLButtonElement>(`[data-tab-id="${current?.id}"]`);
    tab?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [current?.id, model.project, model.session]);
  useEffect(() => {
    if (!popup) return;
    const input = root.current?.querySelector<HTMLInputElement>('.st-popover input');
    if (input) { input.focus(); if (popup.kind === 'address') input.select(); }
    else root.current?.querySelector<HTMLButtonElement>('.st-popover button')?.focus();
  }, [popup?.kind, popup?.tabId]);
  const navigateWeb = (value: string) => {
    if (!current || current.content.kind !== 'web' || !value.trim()) return;
    const url = value.trim();
    dispatch({ type: 'navigate', id: current.id, content: { kind: 'web', key: `web:${url}`, title: /settings/.test(url) ? '设置页原型' : '交互原型', path: url } });
    setPopup(null);
  };
  const onKeys = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { closeMenu(); return; }
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !typing) {
      event.preventDefault(); dispatch({ type: 'history', dir: event.key === 'ArrowLeft' ? -1 : 1 });
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l' && current?.content.kind === 'web') {
      event.preventDefault(); showMenu('address', '打开网址');
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w' && !typing && current) {
      event.preventDefault(); dispatch({ type: 'close', id: current.id });
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 't') {
      event.preventDefault(); dispatch({ type: 'reopen' });
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const panelButton = (event.target as HTMLElement).closest<HTMLElement>('[data-resource-panel]');
      if (panelButton && !event.altKey) {
        event.preventDefault();
        const panels: ResourcePanel[] = ['files', 'git', 'browser'], index = panels.indexOf(panelButton.dataset.resourcePanel as ResourcePanel);
        const panel = panels[(index + (event.key === 'ArrowRight' ? 1 : -1) + panels.length) % panels.length];
        dispatch({ type: 'resources', panel });
        requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(`[data-resource-panel="${panel}"]`)?.focus());
        return;
      }
      const button = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"][data-tab-id]');
      if (button && !event.altKey) {
        event.preventDefault(); const index = visible.findIndex(t => t.id === button.dataset.tabId);
        const next = visible[(index + (event.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length];
        if (next) { dispatch({ type: 'select', id: next.id }); requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(`[data-tab-id="${next.id}"]`)?.focus()); }
      }
    }
  };
  const localActions: [string, string, () => void][] = current ? current.content.kind === 'file' ? [
    [current.editing ? 'eye' : 'square-pen', current.editing ? '预览文件' : '编辑文件', () => dispatch({ type: 'update', id: current.id, patch: { editing: !current.editing } })],
    ['search', '当前文件内查找', () => showMenu('find', '当前文件内查找')],
    ['locate-fixed', '在文件树中定位', () => dispatch({ type: 'resources', panel: 'files', reveal: current.content.key })]
  ] : current.content.kind === 'image' ? [
    ['zoom-out', '缩小图片', () => dispatch({ type: 'update', id: current.id, patch: { zoom: Math.max(0.5, (current.zoom ?? 1) - 0.25) } })],
    ['scan', '适应窗口', () => dispatch({ type: 'update', id: current.id, patch: { zoom: 1, rotation: 0 } })],
    ['zoom-in', '放大图片', () => dispatch({ type: 'update', id: current.id, patch: { zoom: Math.min(2, (current.zoom ?? 1) + 0.25) } })]
  ] : current.content.kind === 'git' ? [
    ['files', '工作区变更', () => dispatch({ type: 'navigate', id: current.id, content: { ...current.content, view: 'changes' } })],
    ['history', '提交历史', () => dispatch({ type: 'navigate', id: current.id, content: { ...current.content, view: 'history' } })],
    ['git-pull-request', 'Pull Requests', () => dispatch({ type: 'navigate', id: current.id, content: { ...current.content, view: 'pr' } })]
  ] : current.content.kind === 'web' ? [
    ['link', '地址 / 搜索 · Ctrl+L', () => showMenu('address', '打开网址')],
    ['rotate-cw', '刷新网页', () => setNotice('当前网页预览已重新展示')],
    ['mouse-pointer-2', '选择网页元素', () => setNotice('已进入元素选择，点击页面标题添加备注')]
  ] : [
    ['columns-2', '切换双栏 Diff', () => setNotice('当前以紧凑逐行 Diff 展示')],
    ['file-text', '打开原文件', () => openContent(FILES[1])],
    ['message-square', '添加审核批注', () => showMenu('find', '审核批注')]
  ] : [];
  const menuTab = model.tabs.find(t => t.id === menu?.tabId) ?? current;
  const matching = FILES.filter(f => `${f.path} ${f.title} ${menu?.kind === 'search' && f.kind === 'file' ? code : ''}`.toLowerCase().includes(query.toLowerCase()));
  const repoContents = (nodes: TreeNode[]): Content[] => nodes.flatMap(node => 'children' in node ? [...(node.content ? [node.content] : []), ...repoContents(node.children)] : [node.content]);
  const matchingRepos = repoContents(REPO_TREE).filter(repo => `${repo.title} ${repo.path}`.toLowerCase().includes(query.toLowerCase()));
  const gitViews: Record<string, string> = { '工作区变更': 'changes', '提交历史': 'history', 'Pull Requests': 'pr' };

  return <div className="st-app" id="side-tools-tabs-prototype" ref={root} onKeyDown={onKeys}>
    <header className="st-app-chrome">
      <span className="st-brand"><Icon name="panels-top-left" /> MetaAgent</span>
      <button type="button" className="st-project cursor-interaction" aria-label="切换项目" onClick={() => { dispatch({ type: 'scope', project: model.project === 'workbench' ? 'demo' : 'workbench', session: 'review' }); setPopup(null); }}>{model.project === 'workbench' ? 'metaagent-workbench' : 'docs-site'}<Icon name="chevrons-up-down" /></button>
      <span className="st-app-chrome-spacer" />
      <span className="st-prototype-mark">设计预览</span>
    </header>
    <div className="st-workspace">
      <aside className="st-chat">
        <div className="st-session-switch" role="group" aria-label="当前会话">
          <button type="button" aria-pressed={model.session === 'review'} onClick={() => { dispatch({ type: 'scope', session: 'review' }); setPopup(null); }}>代码审核</button>
          <button type="button" aria-pressed={model.session === 'build'} onClick={() => { dispatch({ type: 'scope', session: 'build' }); setPopup(null); }}>界面开发</button>
        </div>
        <div className="st-chat-body">
          <div className="st-message-label"><Icon name="message-square" /> 你</div>
          <p>{model.session === 'review' ? '检查这次改动。我会对照代码和原型，看交互是否一致。' : '继续实现工具栏。保留我打开的参考资料。'}</p>
          <div className="st-message-label st-ai-label"><Icon name="sparkles" /> Codex <span>正在开发</span></div>
          <p>标签、当前内容工具和历史导航已经分开。这里是原型截图和可点击预览。</p>
          <button type="button" className="st-chat-attachment cursor-interaction" aria-label="从聊天打开原型图片" onClick={() => openContent(FILES[3])}>
            <Icon name="image" /><span><strong>prototype.png</strong><small>原型截图</small></span><Icon name="arrow-up-right" />
          </button>
          <button type="button" className="st-chat-link cursor-interaction" aria-label="从聊天打开交互原型" onClick={() => openContent(WEB)}><Icon name="globe" /> 查看交互原型 <Icon name="arrow-up-right" /></button>
          <button type="button" className="st-chat-link cursor-interaction" aria-label="从聊天打开审核文件" onClick={() => openContent(FILES[1])}><Icon name="file-text" /> SideToolsPanel.tsx</button>
          <p className="st-chat-note">请重点看打开图片后，是否还容易回到刚才的审核。</p>
        </div>
        <div className="st-composer"><textarea aria-label="会话输入" placeholder="继续讨论…" value={chatDraft} onChange={e => setChatDraft(e.target.value)} /><Tool icon="arrow-up" label="发送预览消息" onClick={() => { if (chatDraft.trim()) { setNotice('已保留这条预览消息'); setChatDraft(''); } }} /></div>
      </aside>
      <section className={`st-right ${resourceUi.collapsed ? 'is-tools-collapsed' : ''}`} aria-label="右侧内容区域" ref={surface}>
        <div className="st-unified-bar" data-testid="unified-toolbar">
          <div className="st-history" role="group" aria-label="右侧浏览历史">
            <Tool icon="chevron-left" label="返回刚才查看的内容" disabled={!history || history.index <= 0} onClick={() => dispatch({ type: 'history', dir: -1 })} />
            <Tool icon="chevron-right" label="前进到下一处内容" disabled={!history || history.index >= history.entries.length - 1} onClick={() => dispatch({ type: 'history', dir: 1 })} />
          </div>
          <div className="st-tabs" role="tablist" aria-label="打开的内容">
            {visible.map(tab => <div key={tab.id} className={`st-tab ${current?.id === tab.id ? 'is-active' : ''} ${tab.pinned ? 'is-pinned' : ''} ${tab.preview ? 'is-preview' : ''}`} data-testid={`tab-${tab.id}`} draggable
              onDragStart={e => { dragging.current = tab.id; e.dataTransfer.setData('text/plain', tab.id); }} onDragEnd={() => { dragging.current = null; }}
              onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (dragging.current) dispatch({ type: 'move', id: dragging.current, before: tab.id }); dragging.current = null; }}
              onContextMenu={e => { e.preventDefault(); showMenu('manage', '标签操作', tab.id); }}>
              <button type="button" className="st-tab-select cursor-interaction" id={`st-tab-${tab.id}`} data-tab-id={tab.id} role="tab" aria-selected={current?.id === tab.id} aria-controls={`st-panel-${tab.id}`} data-tooltip={`${tab.pinned ? '项目 Pin · ' : tab.preview ? '临时预览 · ' : ''}${tab.content.path}`} onClick={() => dispatch({ type: 'select', id: tab.id })} onDoubleClick={() => dispatch({ type: 'keep', id: tab.id })}>
                <Icon name={tab.pinned ? 'pin' : kindIcon(tab.content.kind)} /><span className="st-tab-title">{tab.content.title}</span>
              </button>
              <button type="button" className="st-tab-pin cursor-interaction" aria-label={`${tab.pinned ? '取消 Pin' : 'Pin 到项目'} ${tab.content.title}`} data-tooltip={tab.pinned ? '取消 Pin，仅当前会话保留' : 'Pin 到项目，所有会话可见'} onClick={() => dispatch({ type: 'pin', id: tab.id })}><Icon name={tab.pinned ? 'pin-off' : 'pin'} /></button>
              <button type="button" className="st-tab-close cursor-interaction" aria-label={`关闭 ${tab.content.title}`} data-tooltip="关闭标签" onClick={() => dispatch({ type: 'close', id: tab.id })}><Icon name="x" /></button>
            </div>)}
            {!visible.length && <span className="st-tab-empty">新标签</span>}
          </div>
          <div className="st-common-actions" role="group" aria-label="通用标签管理">
            <Tool icon="plus" label="新建标签" onClick={() => showMenu('new', '新建标签')} />
          </div>
          <div className="st-current-tools" role="group" aria-label={`当前${current ? ({ file: '文件', image: '图片', git: 'Git', diff: 'Diff', web: '网页' })[current.content.kind] : '内容'}工具`}>
            <div className="st-current-shortcuts">{localActions.map(([icon, label, action]) => <Tool key={label} icon={icon} label={label} onClick={action} pressed={current?.content.kind === 'git' && gitViews[label] === current.content.view} />)}</div>
            <Tool icon="ellipsis" label="当前内容的更多功能" onClick={() => showMenu('tools', '当前内容工具')} />
          </div>
        </div>
        <div className="st-panel-controls" role="group" aria-label="右侧面板控制" data-testid="panel-toolbar">
          <div className="st-panel-tabs" role="tablist" aria-label="右侧工具面板">
          {(['files', 'git', 'browser'] as ResourcePanel[]).map(panel => <button key={panel} type="button" className="st-panel-tab cursor-interaction" role="tab" id={`st-resource-tab-${panel}`} data-resource-panel={panel} aria-label={`${({ files: '文件', git: 'Git', browser: '浏览器' })[panel]}面板`} aria-selected={resourceUi.panel === panel} aria-controls={`st-resource-${panel}`} data-tooltip={({ files: '文件树', git: 'Git 仓库树', browser: '浏览器收藏夹' })[panel]} onClick={() => { dispatch({ type: 'resources', panel }); setPopup(null); }}><Icon name={({ files: 'folder-open', git: 'git-branch', browser: 'globe' })[panel]} /></button>)}
          </div>
          <Tool icon={resourceUi.collapsed ? 'panel-right-open' : 'panel-right-close'} label={resourceUi.collapsed ? '展开工具面板' : '收起工具面板'} expanded={!resourceUi.collapsed} controls="st-resource-trees" onClick={() => dispatch({ type: 'resources', collapsed: !resourceUi.collapsed })} />
        </div>
        <div className="st-content-stack xfade-stack">
          {model.tabs.map(tab => <section key={tab.id} id={`st-panel-${tab.id}`} role="tabpanel" aria-label={tab.content.title} hidden={current?.id !== tab.id} className={`st-content xfade xfade-instant ${current?.id === tab.id ? 'is-shown' : ''}`}>
            {tab.content.kind === 'git' ? <GitView tab={tab} onOpenDiff={name => openContent({ ...DIFF, key: `diff:${name}`, title: name, path: `src/renderer/src/panels/${name}` })} onView={view => dispatch({ type: 'navigate', id: tab.id, content: { ...tab.content, view } })} />
              : tab.content.kind === 'diff' ? <DiffView standalone />
              : tab.content.kind === 'image' ? <div className="st-image-view"><div className="st-image-stage"><img src={imageSource} alt="示例原型截图" style={{ transform: `scale(${tab.zoom ?? 1}) rotate(${tab.rotation ?? 0}deg)` }} /></div><div className="st-document-foot"><span>{tab.content.path}</span><span>{Math.round((tab.zoom ?? 1) * 100)}%</span></div></div>
              : tab.content.kind === 'file' ? <div className="st-file-view">{tab.editing ? <textarea aria-label={`编辑 ${tab.content.title}`} value={tab.draft ?? code} spellCheck={false} onChange={e => dispatch({ type: 'update', id: tab.id, patch: { draft: e.target.value } })} /> : tab.content.title === 'design.md' ? <article className="st-reading"><span className="st-overline">MetaAgent · 设计规范</span><h2>内容优先，壳层退后</h2><p>用户看的是代码、聊天和原型。工具条安静地承载内容，操作只在需要时出现。</p><h3>同一行，三个层级</h3><p>历史导航帮助找回刚才的位置；标签保留正在看的内容；当前工具只处理选中的内容。</p><h3>标签与 Pin</h3><p>普通标签属于当前会话。固定到项目的参考资料，可以在审核和开发之间持续使用。</p></article> : <pre className="st-code"><code>{tab.draft ?? code}</code></pre>}<div className="st-document-foot"><span>{tab.content.path}</span><span>{tab.editing ? tab.draft ? '编辑稿' : '编辑' : '预览'}</span></div></div>
              : <WebView tab={tab} picking={notice.startsWith('已进入元素')} onPick={() => showMenu('find', '网页元素备注')} onNavigate={content => dispatch({ type: 'navigate', id: tab.id, content })} onDraft={draft => dispatch({ type: 'update', id: tab.id, patch: { draft } })} />}
          </section>)}
          {!current && <div className="st-empty-state"><Icon name="panels-top-left" /><p>打开文件、Git 或网页</p><button type="button" onClick={() => showMenu('new', '新建标签')}>新建标签</button></div>}
        </div>
        {resourcePresence.mounted && resourcePanel && <aside id="st-resource-trees" className="st-resource-side mp-panel" aria-label="右侧资源树区域" data-mp-stage={resourcePresence.stage} aria-hidden={resourceUi.collapsed} ref={element => { if (element) element.inert = resourceUi.collapsed; }}>
          {(['files', 'git', 'browser'] as ResourcePanel[]).map(panel => <section key={panel} id={`st-resource-${panel}`} role="tabpanel" aria-labelledby={`st-resource-tab-${panel}`} hidden={resourcePanel !== panel}>
            <header className="st-resource-heading"><span>{({ files: '文件', git: '仓库', browser: '收藏夹' })[panel]}</span><div>
              {panel === 'files' && <><Tool icon="file-search" label="搜索文件" onClick={() => showMenu('files', '搜索文件')} /><Tool icon="text-search" label="所有文件中搜索" onClick={() => showMenu('search', '所有文件中搜索')} /></>}
              {panel === 'git' && <><Tool icon="search" label="搜索仓库" onClick={() => showMenu('repos', '搜索仓库')} /><Tool icon="rotate-cw" label="刷新仓库" onClick={() => setNotice('已刷新示例仓库树')} /></>}
            </div></header>
            <nav aria-label={({ files: '文件树', git: 'Git 仓库树', browser: '浏览器收藏夹' })[panel]}><ResourceTree nodes={panel === 'files' ? FILE_TREE : panel === 'git' ? REPO_TREE : FAVORITES} panel={panel} current={current?.content} expanded={resourceUi.expanded[panel]} onToggle={folder => dispatch({ type: 'resources', panel, folder })} onOpen={(content, source) => openContent(content, source)} /></nav>
          </section>)}
        </aside>}
        <div className="st-notice" aria-live="polite">{notice}</div>
        {presence.mounted && menu && <div className="st-popover-layer" onMouseDown={e => { if (e.target === e.currentTarget) closeMenu(); }}>
          <div className={`st-popover mp-pop ${['files', 'search', 'repos', 'find', 'address'].includes(menu.kind) ? 'is-search' : ''}`} data-mp-stage={presence.stage} role="dialog" aria-label={menu.title}>
            <div className="st-popover-heading"><strong>{menu.title}</strong><Tool icon="x" label="关闭菜单" onClick={closeMenu} /></div>
            {['files', 'search', 'repos', 'address', 'find'].includes(menu.kind) && <input aria-label={menu.title} value={query} placeholder={menu.kind === 'address' ? '网址或搜索词' : menu.kind === 'find' ? '输入批注或查找文字…' : menu.kind === 'repos' ? '输入仓库名或路径…' : '输入文件名或内容…'} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && menu.kind === 'address') navigateWeb(query); if (e.key === 'Enter' && menu.kind === 'find' && query.trim()) { setNotice(`已保留：${query.trim()}`); closeMenu(); } }} />}
            {(menu.kind === 'files' || menu.kind === 'search') && <div className="st-file-results">{matching.length ? matching.map(f => <button type="button" key={f.key} className="st-menu-row cursor-interaction" onClick={() => dispatch({ type: 'open', content: f, source: 'preview' })} onDoubleClick={() => openContent(f, 'keep')}><Icon name={kindIcon(f.kind)} /><span><strong>{f.title}</strong><small>{f.path}</small>{menu.kind === 'search' && query && <small>…{query}…</small>}</span><Icon name="corner-down-left" /></button>) : <p className="st-menu-empty">没有匹配的文件</p>}</div>}
            {menu.kind === 'address' && <><button type="button" className="st-menu-row" onClick={() => navigateWeb(query)}><Icon name="arrow-up-right" /> 打开 {query || '网址'}</button><button type="button" className="st-menu-row" onClick={() => navigateWeb(SETTINGS_WEB.path)}><Icon name="globe" /> 设置页原型</button></>}
            {menu.kind === 'repos' && matchingRepos.map(repo => <button type="button" className="st-menu-row" key={repo.key} onClick={() => openContent(repo)}><Icon name="git-branch" /><span><strong>{repo.path}</strong><small>打开仓库审核</small></span></button>)}
            {menu.kind === 'new' && <>{[[FILES[0], 'file-text', '文件与图片'], [GIT, 'git-branch', 'Git 仓库'], [WEB, 'globe', '网页']].map(([content, icon, label]) => <button type="button" key={label as string} className="st-menu-row" onClick={() => content === FILES[0] ? showMenu('files', '打开文件') : openContent(content as Content)}><Icon name={icon as string} />{label as string}</button>)}
              <button type="button" className="st-menu-row" disabled={!model.closed.some(t => t.project === model.project && (t.pinned || t.session === model.session))} onClick={() => { dispatch({ type: 'reopen' }); closeMenu(); }}><Icon name="undo-2" />重新打开关闭的标签</button>
            </>}
            {menu.kind === 'manage' && menuTab && <>{[
              [menuTab.pinned ? 'pin-off' : 'pin', menuTab.pinned ? '取消 Pin' : 'Pin 到项目', 'pin'],
              ['check', '保留此标签', 'keep'], ['x', '关闭此标签', 'close'],
              ['square-x', '关闭其他会话标签', 'closeOthers'], ['arrow-right-to-line', '关闭右侧会话标签', 'closeRight']
            ].map(([icon, label, type]) => <button type="button" className="st-menu-row" key={type} onClick={() => { dispatch({ type, id: menuTab.id } as Action); closeMenu(); }}><Icon name={icon} />{label}</button>)}</>}
            {menu.kind === 'tools' && current && <>
              <div className="st-menu-group">{current.content.title}</div>
              {localActions.map(([icon, label, action]) => <button type="button" className="st-menu-row" key={label as string} onClick={() => { setPopup(null); (action as () => void)(); }}><Icon name={icon as string} />{label as string}</button>)}
              {current.content.kind === 'image' && <button type="button" className="st-menu-row" onClick={() => { dispatch({ type: 'update', id: current.id, patch: { rotation: (current.rotation ?? 0) + 90 } }); closeMenu(); }}><Icon name="rotate-cw" />旋转图片</button>}
              {current.content.kind === 'git' && <><button type="button" className="st-menu-row" onClick={() => showMenu('branch', '切换分支')}><Icon name="git-branch" />main · 切换分支</button><button type="button" className="st-menu-row" onClick={() => { openContent(DIFF); }}><Icon name="file-diff" />在独立标签中审核 Diff</button><div className="st-menu-group">同步</div>{['Fetch', 'Pull', 'Push'].map(label => <button type="button" className="st-menu-row" key={label} onClick={() => { setNotice(`${label} 属于当前仓库的同步操作`); closeMenu(); }}><Icon name={label === 'Push' ? 'arrow-up-to-line' : 'arrow-down-to-line'} />{label}</button>)}</>}
              {current.content.kind === 'web' && <><button type="button" className="st-menu-row" onClick={() => { setNotice('开发者工具入口属于当前网页'); closeMenu(); }}><Icon name="code-2" />开发者工具</button><button type="button" className="st-menu-row" onClick={() => { setNotice('系统浏览器入口属于当前网址'); closeMenu(); }}><Icon name="external-link" />在系统浏览器中打开</button></>}
            </>}
            {menu.kind === 'branch' && ['main', 'codex/right-tabs'].map(name => <button type="button" className="st-menu-row" key={name} onClick={() => { setNotice(`正在查看 ${name} 分支的示例`); closeMenu(); }}><Icon name="git-branch" />{name}</button>)}
            {menu.kind === 'find' && <button type="button" className="st-menu-row" onClick={() => { if (query.trim()) setNotice(`已保留：${query.trim()}`); closeMenu(); }}><Icon name="check" />确认</button>}
          </div>
        </div>}
      </section>
    </div>
  </div>;
}
function GitView({ tab, onOpenDiff, onView }: { tab: Tab; onOpenDiff: (name: string) => void; onView: (view: 'changes' | 'history' | 'pr') => void }) {
  const [file, setFile] = useState('SideToolsPanel.tsx');
  return <div className="st-git-view">
    <div className="st-git-location"><span><Icon name="git-branch" /> main</span><span>{tab.content.path}</span><span className="st-git-change-count">4 个变更</span></div>
    {tab.content.view === 'history' ? <div className="st-history-content"><h2>提交历史</h2>{['统一右侧内容入口', '保留预览与编辑状态', '修复工作区切换'].map((t, i) => <button key={t} type="button" onClick={() => onOpenDiff(file)}><Icon name="git-commit-horizontal" /><span>{t}<small>Codex · {i + 1} 小时前</small></span><code>{['8bf2c13', '57db09e', '3da7a22'][i]}</code></button>)}</div>
      : tab.content.view === 'pr' ? <article className="st-reading"><span className="st-overline">Pull Requests</span><h2>统一右侧内容标签</h2><p>查看标签切换、图片预览和会话范围的交互是否一致。</p><button type="button" onClick={() => onView('changes')}>查看本地变更</button></article>
      : <div className="st-git-work"><div className="st-git-diff"><div className="st-diff-caption"><Icon name="file-diff" /><span>{file}</span><Tool icon="square-arrow-out-up-right" label="在新标签打开此 Diff" onClick={() => onOpenDiff(file)} /></div><DiffView /></div><aside className="st-change-list"><div className="st-list-heading">变更<span>4</span></div>{['SideToolsPanel.tsx', 'FilesPanel.tsx', 'browser.css', 'panelHistory.tsx'].map(name => <button type="button" className={file === name ? 'is-selected' : ''} key={name} onClick={() => setFile(name)} onDoubleClick={() => onOpenDiff(name)}><Icon name="file-text" /><span>{name}</span><small>M</small></button>)}<div className="st-git-summary"><span className="st-added">+42</span><span className="st-removed">−18</span></div><textarea aria-label="提交信息" placeholder="提交信息…" /></aside></div>}
  </div>;
}
function DiffView({ standalone = false }: { standalone?: boolean }) {
  const lines: [string, string][] = [['same', 'export function SideToolsPanel() {'], ['same', '  const workspace = useWorkspace();'], ['removed', '  const [sideTab, setSideTab] = useState("git");'], ['added', '  const tabs = useRightTabs(workspace.id);'], ['same', ''], ['same', '  return ('], ['removed', '    <SideToolsSwitcher tab={sideTab} />'], ['added', '    <RightWorkspace>'], ['added', '      <TabStrip tabs={tabs.visible} />'], ['added', '      <ContentTools content={tabs.current} />'], ['added', '      <ContentView content={tabs.current} />'], ['added', '    </RightWorkspace>'], ['same', '  );'], ['same', '}']];
  return <div className="st-diff-view">{standalone && <div className="st-diff-caption"><Icon name="file-diff" />src/renderer/src/panels/SideToolsPanel.tsx<span className="st-diff-branch">main · 工作区</span></div>}<div className="st-hunk">@@ −24,8 +24,12 @@</div>{lines.map(([kind, text], i) => <div className={`st-diff-line ${kind}`} key={i}><span>{i + 24}</span><span>{kind === 'added' ? '+' : kind === 'removed' ? '−' : ' '}</span><code>{text}</code></div>)}</div>;
}
interface ResourceTreeProps { nodes: TreeNode[]; panel: ResourcePanel; current?: Content; expanded: string[]; onToggle: (id: string) => void; onOpen: (content: Content, source: 'preview' | 'keep') => void }
function ResourceTree({ nodes, ...props }: ResourceTreeProps) {
  const { panel, current, onOpen } = props, prefix = ({ files: '打开文件', git: '打开仓库', browser: '打开收藏' })[panel];
  return <ul className="st-resource-tree">{nodes.map(node => 'children' in node
    ? <ResourceFolder key={node.id} node={node} {...props} />
    : <li key={node.id}><button type="button" className="st-tree-row cursor-interaction" aria-label={`${prefix} ${node.content.title}`} aria-current={current && sameContent(current, node.content) ? 'page' : undefined} data-tooltip={node.content.path} onClick={() => onOpen(node.content, panel === 'files' ? 'preview' : 'keep')} onDoubleClick={() => onOpen(node.content, 'keep')}><Icon name={kindIcon(node.content.kind)} /><span>{node.content.title}</span>{node.meta && <small>{node.meta}</small>}</button></li>)}</ul>;
}
function ResourceFolder({ node, ...props }: Omit<ResourceTreeProps, 'nodes'> & { node: Extract<TreeNode, { children: TreeNode[] }> }) {
  const { panel, current, expanded, onToggle, onOpen } = props;
  const open = expanded.includes(node.id), presence = usePresence(open, MOTION.exitMs);
  const prefix = node.content ? '打开仓库' : ({ files: '文件夹', git: '仓库分组', browser: '收藏文件夹' })[panel];
  return <li><button type="button" className="st-tree-row st-tree-folder cursor-interaction" aria-label={`${prefix} ${node.title}`} aria-expanded={open} aria-current={node.content && current && sameContent(current, node.content) ? 'page' : undefined} data-tooltip={node.content?.path ?? node.title} onClick={() => { onToggle(node.id); if (node.content) onOpen(node.content, 'keep'); }}><Icon name={open ? 'folder-open' : 'folder'} /><span>{node.title}</span>{node.content && <small>4</small>}</button>
    {presence.mounted && <div className="acc st-tree-children" data-mp-stage={presence.stage} aria-hidden={!open} ref={element => { if (element) element.inert = !open; }}><div className="acc-body"><ResourceTree nodes={node.children} {...props} /></div></div>}
  </li>;
}
function WebView({ tab, onNavigate, onDraft, picking, onPick }: { tab: Tab; onNavigate: (content: Content) => void; onDraft: (draft: string) => void; picking: boolean; onPick: () => void }) {
  return <div className={`st-web-layout ${picking ? 'is-picking' : ''}`}>
    <div className="st-web-view">
    <div className="st-web-address"><Icon name="lock-keyhole" /><span>{tab.content.path}</span></div>
    <article className="st-web-page"><span className="st-overline">MetaAgent / Prototype</span><h2 onClick={() => { if (picking) onPick(); }}>{tab.content.path === WEB.path ? '让内容在同一处流转' : tab.content.title}</h2><p>查看文件、对照改动、打开图片。每一份内容都有自己的标签。</p><div className="st-web-preview"><Icon name="panels-top-left" /><span>统一标签 · 当前内容工具</span></div><button type="button" className="st-web-next" onClick={() => onNavigate(SETTINGS_WEB)}>查看设置页原型 <Icon name="arrow-right" /></button><label className="st-web-draft">给原型留一条备注<input aria-label="网页里的备注草稿" value={tab.draft ?? ''} onChange={e => onDraft(e.target.value)} placeholder="切换标签后，草稿仍在这里" /></label></article>
    </div>
  </div>;
}
