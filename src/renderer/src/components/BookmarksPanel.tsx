import { randomUuid } from '../../../shared/randomUuid';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { rightScope, visibleRightTabs, type BookmarkNode } from '../../../shared/rightWorkspace';
import { browserHomeUrl, isBrowserHomeUrl } from '../../../shared/browserHome';
import { applyBookmarkChange, bookmarkDescendants, bookmarkId, type BookmarkChange } from '../../../shared/bookmarks';
import { useRightWorkspace } from '../rightWorkspace';
import { useUiStore } from '../store';
import { isWebGateway } from '../webGatewayEnvironment';
import { bookmarkDisplayLabel } from '../bookmarkDisplay';
import { ContextMenu, type ContextMenuPoint } from './ContextMenu';
import { AppConfirmDialog } from './AppConfirmDialog';
import { BrowserHomeEditor, type HomeEditorRequest } from './BrowserHomeDialogs';
import { IconFolder, IconFolderOpen, IconGlobe, IconHome } from './icons';

export function BookmarksPanel(): React.JSX.Element | null {
  const { t } = useTranslation(), bridge = useRightWorkspace(), { flashTip } = useUiStore();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<ContextMenuPoint & { node?: BookmarkNode } | null>(null);
  const [edit, setEdit] = useState<(HomeEditorRequest & { workspaceId: string }) | null>(null);
  const [deleting, setDeleting] = useState<BookmarkNode | null>(null);
  const pendingHome = useRef<{ scope: string; url: string } | null>(null);
  useEffect(() => {
    const pending = pendingHome.current;
    if (!pending || !bridge) return;
    if (pending.scope !== rightScope(bridge.model) || visibleRightTabs(bridge.model).some(tab => tab.content.kind === 'web' && tab.content.url === pending.url)) pendingHome.current = null;
  }, [bridge?.model]);
  useEffect(() => { setEdit(null); setMenu(null); setDeleting(null); }, [bridge?.model.workspaceId]);
  if (!bridge?.resourceHosts.browser) return null;
  const remote = isWebGateway();
  const nodes = bridge.model.bookmarks[bridge.model.workspaceId] ?? [];
  const ready = bridge.model.bookmarkDefaultsVersion[bridge.model.workspaceId] !== undefined;
  const save = (change: BookmarkChange): boolean => {
    if (!ready) { flashTip(t('收藏夹尚未就绪')); return false; }
    if (applyBookmarkChange(nodes, change).error) { flashTip(t('无法完成收藏夹操作')); return false; }
    bridge.dispatch({ type: 'bookmarkChange', workspaceId: bridge.model.workspaceId, change });
    return true;
  };
  const label = (node: BookmarkNode): string => bookmarkDisplayLabel(node, t);
  const folders = (items: BookmarkNode[], path = ''): Array<{ id: string; label: string }> => items.flatMap(node => node.url ? [] : [{ id: node.id, label: path ? `${path} / ${label(node)}` : label(node) }, ...folders(node.children ?? [], path ? `${path} / ${label(node)}` : label(node))]);
  const excluded = new Set(menu?.node ? bookmarkDescendants(menu.node).map(node => node.id) : []);
  const destinations = folders(nodes).filter(folder => !excluded.has(folder.id));
  const open = (node: BookmarkNode): void => {
    if (remote) { flashTip(t('请在桌面应用中打开此收藏')); return; }
    const tab = visibleRightTabs(bridge.model).find(tab => tab.scope === 'workspace' && tab.content.kind === 'web' && tab.content.url === node.url);
    if (tab) bridge.dispatch({ type: 'select', id: tab.id });
    else void window.api.browser.open({ url: node.url, workspaceId: bridge.model.workspaceId, sessionId: bridge.model.sessionId, scope: 'workspace' }).catch(error => flashTip(String(error)));
  };
  const openHome = (): void => {
    if (remote) {
      flashTip(t('内置浏览器仅在 Muster 桌面应用中可用。请在桌面应用中继续此操作。'));
      return;
    }
    const model = bridge.model, scope = rightScope(model);
    const homes = visibleRightTabs(model).filter(tab => tab.scope === 'workspace' && tab.content.kind === 'web' && isBrowserHomeUrl(tab.content.url));
    const history = model.histories[scope];
    const recent = history?.entries.slice(0, history.index).reverse().find(command => homes.some(tab => tab.id === command.afterSelected));
    const target = homes.find(tab => tab.id === bridge.current?.id) ?? homes.find(tab => tab.id === recent?.afterSelected) ?? homes[0];
    if (target) {
      if (target.id !== bridge.current?.id) bridge.dispatch({ type: 'select', id: target.id });
      return;
    }
    if (pendingHome.current?.scope === scope) return;
    const url = browserHomeUrl(randomUuid());
    pendingHome.current = { scope, url };
    bridge.open({ kind: 'web', browserId: '', url, title: t('新建标签页') }, 'keep');
  };
  const render = (list: BookmarkNode[], depth = 0): React.ReactNode => list.map(node => {
    const url = node.url?.trim();
    const href = url && /^https?:\/\//i.test(url) ? url : undefined;
    const row = {
      className: 'right-bookmark-row',
      style: { paddingLeft: 10 + depth * 14 },
      title: node.url ?? label(node),
      onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY, anchor: event.currentTarget, node });
      }
    };
    const icon = node.url ? node.favicon ? <img className="right-bookmark-favicon" src={node.favicon} alt=""/> : <IconGlobe size={14}/>
      : expanded.has(node.id) ? <IconFolderOpen size={14}/> : <IconFolder size={14}/>;
    const content = <>{icon}<span>{label(node)}</span></>;
    return <React.Fragment key={node.id}>
      {remote && href
        ? <a {...row} href={href} target="_blank" rel="noopener noreferrer">{content}</a>
        : <button {...row} type="button" aria-expanded={node.url ? undefined : expanded.has(node.id)} onClick={() => {
          if (node.url) { open(node); return; }
          setExpanded(prev => { const next = new Set(prev); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; });
        }}>{content}</button>}
      {node.children && expanded.has(node.id) ? render(node.children, depth + 1) : null}
    </React.Fragment>;
  });
  return createPortal(<div className="right-bookmarks">
    <div className="right-resource-heading"><span>{t('收藏夹')}</span><button className="right-icon" type="button" title={t('打开主页')} aria-label={t('打开主页')} disabled={!bridge.model.hydrated.includes(bridge.model.workspaceId)} onClick={openHome}><IconHome/></button></div>
    <div className="right-bookmark-tree" onContextMenu={e => { if (e.target === e.currentTarget) { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, anchor: e.currentTarget }); } }}>{render(nodes)}{!nodes.length ? <div className="right-empty-hint">{t('在网页工具栏收藏当前页面')}</div> : null}</div>
    {menu ? <ContextMenu x={menu.x} y={menu.y} anchor={menu.anchor} onClose={() => setMenu(null)} items={[{ id: 'folder', label: t('新建文件夹'), disabled: !ready }, { id: 'rename', label: t('重命名'), disabled: !ready || !menu.node }, { id: 'move', label: t('移动到'), disabled: !ready || !menu.node, children: [{ id: 'move-root', label: t('收藏夹根目录') }, ...destinations.map(folder => ({ id: `move:${folder.id}`, label: folder.label }))] }, { id: 'delete', label: t('删除'), danger: true, disabled: !ready || !menu.node }]} onSelect={action => {
      if (action === 'delete' && menu.node) setDeleting(menu.node);
      else if (action === 'rename' && menu.node) setEdit({ kind: 'rename', workspaceId: bridge.model.workspaceId, id: menu.node.id, label: menu.node.label });
      else if (action === 'folder') setEdit({ kind: 'folder', workspaceId: bridge.model.workspaceId, parentId: menu.node?.children ? menu.node.id : null });
      else if (menu.node && (action === 'move-root' || action.startsWith('move:'))) {
        const parentId = action === 'move-root' ? null : action.slice(5);
        save({ kind: 'move', ids: [menu.node.id], parentId });
        if (parentId) setExpanded(prev => new Set(prev).add(parentId));
      }
    }}/> : null}
    <BrowserHomeEditor request={edit?.workspaceId === bridge.model.workspaceId ? edit : null} onClose={() => setEdit(null)} onSave={(request, value) => {
      const label = value.label.trim();
      if (!label) return t('请输入有效名称');
      if (request.kind === 'rename' && request.id) return save({ kind: 'update', id: request.id, label }) ? null : t('无法完成收藏夹操作');
      if (request.kind !== 'folder') return t('无法完成收藏夹操作');
      const parentId = request.parentId ?? null;
      const folder = { id: bookmarkId(), label, children: [], dateAdded: Date.now() };
      if (!save({ kind: 'add', parentId, node: folder })) return t('无法完成收藏夹操作');
      if (parentId) setExpanded(prev => new Set(prev).add(parentId));
      return null;
    }}/>
    <AppConfirmDialog open={!!deleting} title={t('删除收藏？')} detail={deleting ? label(deleting) : undefined} danger onCancel={() => setDeleting(null)} onConfirm={() => { if (deleting) save({ kind: 'remove', ids: [deleting.id] }); setDeleting(null); }}/>
  </div>, bridge.resourceHosts.browser);
}
