import { ErrorTip } from './ErrorTip';
import { randomUuid } from '../../../shared/randomUuid';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CustomSelect } from './CustomSelect';
import { createPortal } from 'react-dom';
import { isOverlayPageSwitch, overlayViewportOrigin, stripOverlayHost, useDismissOnPagePeek } from '../hooks/useDismissOnPagePeek';
import { useTranslation } from 'react-i18next';
import {
  canMoveNavigation, dissolveNavigationFolder, moveNavigation, navigationChildren,
  navigationPath, visibleNavigation,
  type ExtensionNavigationNode as NavNode, type NavigationMove
} from '../../../shared/extensionNavigation';
import { SPLIT_DRAG_MIME, encodeSplitDragPayload, type SplitPaneRef, type SplitSide } from '../../../shared/centerSplit';
import type { RightPinApi } from '../rightDock';
import { centerSplitIncoming } from '../centerSplitStore';
import { IconChevronDown, IconFolder, IconFolderOpen, IconMore, IconPlus } from './icons';
import { ExtensionIcon } from '../extensionIcons';
import { MOTION, usePresence, usePresenceValue } from './motion';

// Candidate component used by the isolated prototype; no app store or IPC is touched.
export type NavigationEdit = { kind: 'folder' | 'rename'; parentId: string | null; nodeId?: string; title: string; scope?: 'workspace' | 'global' };
type Edit = NavigationEdit;
type EditOptions = { parentId: string | null; scope?: 'workspace' | 'global' };
type Menu = { id: string; x: number; y: number; host: HTMLElement; origin: { left: number; top: number }; page: 'root' | 'moving' | 'split' };
type Props = {
  nodes: NavNode[];
  selectedId: string | null;
  openedIds?: readonly string[];
  onChange: (nodes: NavNode[], announcement: string) => void;
  onSelect: (id: string | null) => void;
  heading?: string;
  /** Compact utility layout keeps the accessible tree label and puts creation actions below the list. */
  hideHeading?: boolean;
  onToggleFavorite?: (id: string) => void;
  advanced?: boolean;
  allowScope?: boolean;
  onUndo?: () => void;
  /** 固定到右侧：状态查询与切换由宿主提供（原型/独立使用时不传即不显示该项） */
  rightPin?: Pick<RightPinApi, 'canPin' | 'isPinned'>;
  onToggleRightPin?: (ref: SplitPaneRef) => void;
};

export function NavigationIcon({ node, kind: legacyKind, open = false, size = 16 }: { node?: NavNode; kind?: NavNode['kind']; open?: boolean; size?: number }): React.JSX.Element {
  const current = node ?? ({ id: '', parentId: null, title: '', kind: legacyKind ?? 'extension' } as NavNode);
  const { kind } = current;
  if (kind === 'folder') return open ? <IconFolderOpen size={size} /> : <IconFolder size={size} />;
  if (kind === 'extension') return <ExtensionIcon value={current.icon} size={size} fallback="·" className="extension-nav-icon-image" />;
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    {kind === 'web' ? <><circle cx="10" cy="10" r="7.5" /><ellipse cx="10" cy="10" rx="3.2" ry="7.5" /><path d="M2.5 10h15" /></>
      : <><rect x="2.5" y="2.5" width="6" height="6" rx="1.5" /><rect x="11.5" y="2.5" width="6" height="6" rx="1.5" /><rect x="2.5" y="11.5" width="6" height="6" rx="1.5" /><rect x="11.5" y="11.5" width="6" height="6" rx="1.5" /></>}
  </svg>;
}

export function ExtensionNavigationTree({ nodes, selectedId, openedIds = selectedId ? [selectedId] : [], onChange, onSelect, heading, hideHeading = false, onToggleFavorite, advanced = false, allowScope = true, onUndo, rightPin, onToggleRightPin }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const headingText = heading ?? t('扩展');
  const [menu, setMenu] = useState<Menu | null>(null);
  const [editor, setEditor] = useState<Edit | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<NavigationMove | null>(null);
  const [focused, setFocused] = useState<string | null>(selectedId);
  const [notice, setNotice] = useState('');
  const tree = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const dragRef = useRef<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverId = useRef<string | null>(null);
  const menuState = usePresenceValue(menu, MOTION.microMs);
  const rows = visibleNavigation(nodes);
  const liveMenu = menuState.value;
  const targetNode = nodes.find(node => node.id === liveMenu?.id);
  useDismissOnPagePeek(!!menu, returnFocus.current, () => setMenu(null));

  function announce(next: NavNode[], message: string): void {
    setNotice(message);
    onChange(next, message);
  }
  function focusRow(id: string | null): void {
    setFocused(id);
    requestAnimationFrame(() => {
      const row = [...(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].find(el => el.dataset.nodeId === id);
      row?.focus();
    });
  }
  function toggle(node: NavNode, expanded?: boolean): void {
    if (node.kind !== 'folder') return;
    onChange(nodes.map(item => item.id === node.id ? { ...node, expanded: expanded ?? !node.expanded } : item), '');
  }
  function closeMenu(restore = true): void {
    setMenu(null);
    if (restore) returnFocus.current?.focus();
  }
  function openMenu(node: NavNode, x: number, y: number, trigger: HTMLElement): void {
    returnFocus.current = trigger;
    const host = stripOverlayHost(trigger);
    setMenu({ id: node.id, x, y, host, origin: overlayViewportOrigin(host), page: 'root' });
  }
  function beginEdit(edit: Edit): void {
    setMenu(null);
    setEditor(edit);
  }
  function stopHover(): void {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    hoverId.current = null;
  }
  function endDrag(): void {
    stopHover();
    dragRef.current = null;
    setDragging(null);
    setDrop(null);
  }
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent): void => {
      if (!isOverlayPageSwitch(returnFocus, event.target) && !menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [menu?.id, menu?.page]);

  function relocate(move: NavigationMove): void {
    const source = nodes.find(node => node.id === move.sourceId);
    const target = nodes.find(node => node.id === move.targetId);
    const next = moveNavigation(nodes, move);
    if (next === nodes) { setNotice(t('不能移入自己或自己的子文件夹')); return; }
    const message = move.placement === 'inside'
      ? target ? t('已将“{{source}}”移到“{{target}}”', { source: source?.title, target: target.title }) : t('已将“{{source}}”移到最外层', { source: source?.title })
      : move.placement === 'before'
        ? t('已将“{{source}}”移到“{{target}}”之前', { source: source?.title, target: target?.title })
        : t('已将“{{source}}”移到“{{target}}”之后', { source: source?.title, target: target?.title });
    announce(next, message);
    focusRow(move.sourceId);
  }
  function handleDragOver(event: React.DragEvent, node: NavNode): void {
    if (!dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
    const placement = node.kind === 'folder' && ratio >= 0.25 && ratio <= 0.75 ? 'inside' : ratio < 0.5 ? 'before' : 'after';
    const move: NavigationMove = { sourceId: dragRef.current, targetId: node.id, placement };
    if (!canMoveNavigation(nodes, move)) {
      event.dataTransfer.dropEffect = 'none'; setDrop(null); stopHover(); return;
    }
    event.dataTransfer.dropEffect = 'move';
    setDrop(move);
    if (placement === 'inside' && node.kind === 'folder' && !node.expanded) {
      if (hoverId.current !== node.id) {
        stopHover(); hoverId.current = node.id;
        hoverTimer.current = setTimeout(() => { toggle(node, true); hoverTimer.current = null; }, MOTION.moveMs);
      }
    } else stopHover();
  }
  function handleKey(event: React.KeyboardEvent<HTMLDivElement>, node: NavNode, index: number): void {
    if (event.target !== event.currentTarget) return;
    const nextFocus = (i: number): void => focusRow(rows[Math.max(0, Math.min(rows.length - 1, i))]?.node.id ?? null);
    if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const siblings = navigationChildren(nodes, node.parentId);
      const neighbor = siblings[siblings.findIndex(item => item.id === node.id) + (event.key === 'ArrowUp' ? -1 : 1)];
      if (neighbor) relocate({ sourceId: node.id, targetId: neighbor.id, placement: event.key === 'ArrowUp' ? 'before' : 'after' });
    } else if (event.key === 'ArrowDown') { event.preventDefault(); nextFocus(index + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); nextFocus(index - 1); }
    else if (event.key === 'Home') { event.preventDefault(); nextFocus(0); }
    else if (event.key === 'End') { event.preventDefault(); nextFocus(rows.length - 1); }
    else if (event.key === 'ArrowRight' && node.kind === 'folder') {
      event.preventDefault(); if (!node.expanded) toggle(node, true); else if (nodes.some(item => item.parentId === node.id)) nextFocus(index + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault(); if (node.kind === 'folder' && node.expanded) toggle(node, false); else if (node.parentId) focusRow(node.parentId);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); onSelect(node.id); if (node.kind === 'folder') toggle(node);
    } else if (event.key === 'F2') {
      event.preventDefault(); returnFocus.current = event.currentTarget;
      beginEdit({ kind: 'rename', nodeId: node.id, parentId: node.parentId, title: node.title });
    } else if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect();
      openMenu(node, rect.right - 12, rect.top, event.currentTarget);
    }
  }
  const menuActions: Array<{ label: string; run: () => void; disabled?: boolean; danger?: boolean }> = [];
  if (targetNode && liveMenu) {
    if (liveMenu.page !== 'root') {
      menuActions.push({ label: `‹ ${t('返回')}`, run: () => setMenu({ ...liveMenu, page: 'root' }) });
    }
    if (liveMenu.page === 'split') {
      // 分屏到四向：非文件夹节点可进分屏（文件夹无面板内容）
      for (const [side, label] of [['left', t('左侧')], ['right', t('右侧')], ['top', t('上方')], ['bottom', t('下方')]]) {
        menuActions.push({
          label,
          run: () => {
            closeMenu(false);
            centerSplitIncoming({ kind: 'utility', sel: `nav:${targetNode.id}` }, side as SplitSide);
          }
        });
      }
    } else if (liveMenu.page === 'moving') {
      const destinations = [null, ...nodes.filter(node => node.kind === 'folder').map(node => node.id)];
      for (const id of destinations) {
        const move: NavigationMove = { sourceId: targetNode.id, targetId: id, placement: 'inside' };
        if (!canMoveNavigation(nodes, move)) continue;
        menuActions.push({ label: id ? navigationPath(nodes, id).map(node => node.title).join(' / ') : t('最外层'),
          disabled: targetNode.parentId === id, run: () => { closeMenu(false); relocate(move); } });
      }
    } else {
      if (advanced && allowScope && !targetNode.parentId) menuActions.push({ label: targetNode.scope === 'global' ? t('仅当前工作区可见') : t('所有工作区可见'), run: () => {
        closeMenu();
        const scope: 'workspace' | 'global' = targetNode.scope === 'global' ? 'workspace' : 'global';
        announce(nodes.map(node => navigationPath(nodes, node.id).some(ancestor => ancestor.id === targetNode.id) ? { ...node, scope } : node), t('已更改“{{title}}”的可见范围', { title: targetNode.title }));
      } });
      if (targetNode.kind !== 'folder') menuActions.push({ label: t('分屏显示'), run: () => setMenu({ ...liveMenu, page: 'split' }) });
      const pinRef: SplitPaneRef = { kind: 'utility', sel: `nav:${targetNode.id}` };
      if (rightPin && onToggleRightPin && rightPin.canPin(pinRef)) menuActions.push({ label: rightPin.isPinned(pinRef) ? t('移回中栏') : t('固定到右侧'), run: () => {
        closeMenu(false); onToggleRightPin(pinRef);
      } });
      if (onToggleFavorite) menuActions.push({ label: targetNode.favorite ? t('从常用移除') : t('添加到常用'), run: () => {
        closeMenu(); onToggleFavorite(targetNode.id);
      } });
      if (targetNode.kind === 'folder') menuActions.push({ label: t('新建子文件夹'), run: () => beginEdit({ kind: 'folder', parentId: targetNode.id, title: '' }) });
      menuActions.push(
        { label: t('重命名'), run: () => beginEdit({ kind: 'rename', nodeId: targetNode.id, parentId: targetNode.parentId, title: targetNode.title }) },
        { label: t('移动到…'), run: () => setMenu({ ...liveMenu, page: 'moving' }) }
      );
      const siblings = navigationChildren(nodes, targetNode.parentId);
      const index = siblings.findIndex(node => node.id === targetNode.id);
      for (const direction of [-1, 1]) menuActions.push({ label: direction < 0 ? t('向上移动') : t('向下移动'), disabled: !siblings[index + direction],
        run: () => { closeMenu(false); relocate({ sourceId: targetNode.id, targetId: siblings[index + direction].id, placement: direction < 0 ? 'before' : 'after' }); } });
      menuActions.push({ label: targetNode.kind === 'folder' ? t('解散文件夹，保留内容') : t('取消固定'), danger: true, run: () => {
        closeMenu(false);
        announce(targetNode.kind === 'folder' ? dissolveNavigationFolder(nodes, targetNode.id) : nodes.filter(node => node.id !== targetNode.id),
          targetNode.kind === 'folder' ? t('已解散“{{title}}”，内容已保留', { title: targetNode.title }) : t('已取消固定“{{title}}”', { title: targetNode.title }));
        if (selectedId === targetNode.id) onSelect(targetNode.parentId);
        focusRow(targetNode.parentId);
      } });
    }
  }
  const focusedVisible = rows.some(row => row.node.id === focused);
  const creationActions = <>
    {onUndo && <button className="ext-nav-icon" aria-label={t('撤销上一次导航修改')} onClick={onUndo}>{t('撤销')}</button>}
    <button className="ext-nav-icon" aria-label={t('新建文件夹')} title={t('新建文件夹')} onClick={event => { returnFocus.current = event.currentTarget; beginEdit({ kind: 'folder', parentId: null, title: '' }); }}><IconPlus size={17} />{hideHeading && <span>{t('新建文件夹')}</span>}</button>
  </>;
  return <div className="ext-nav">
    {!hideHeading && <div className="ext-nav-heading"><span>{headingText}</span><span className="ext-nav-heading-actions">{creationActions}</span></div>}
    <div ref={tree} className="ext-nav-tree" role="tree" aria-label={headingText} onKeyDown={event => { if (event.key === 'Escape') endDrag(); }}>
      {rows.map(({ node, depth }, index) => {
        const siblings = navigationChildren(nodes, node.parentId);
        const dropHere = drop?.targetId === node.id ? drop.placement : undefined;
        return <div key={node.id} role="treeitem" aria-label={node.title} aria-level={depth + 1}
          aria-setsize={siblings.length} aria-posinset={siblings.findIndex(item => item.id === node.id) + 1}
          aria-expanded={node.kind === 'folder' ? node.expanded : undefined} aria-selected={selectedId === node.id}
          tabIndex={node.id === focused || (!focusedVisible && index === 0) ? 0 : -1}
          data-node-id={node.id} data-parent-id={node.parentId ?? ''} data-kind={node.kind} data-drop={dropHere}
          data-pane-open={openedIds.includes(node.id) || undefined} data-pane-focused={selectedId === node.id || undefined}
          className={`ext-nav-row${selectedId === node.id ? ' is-selected is-pane-focused' : ''}${openedIds.includes(node.id) ? ' is-pane-open' : ''}${dragging === node.id ? ' is-dragging' : ''}`}
          style={{ '--nav-depth': Math.min(depth, 5) } as React.CSSProperties}
          title={navigationPath(nodes, node.id).map(item => item.title).join(' / ')} draggable
          onFocus={event => { if (event.target === event.currentTarget) setFocused(node.id); }}
          onClick={() => { focusRow(node.id); onSelect(node.id); if (node.kind === 'folder') toggle(node); }}
          onKeyDown={event => handleKey(event, node, index)}
          onContextMenu={event => { event.preventDefault(); openMenu(node, event.clientX, event.clientY, event.currentTarget); }}
          onDragStart={event => { dragRef.current = node.id; setDragging(node.id); setMenu(null); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-muster-navigation', node.id); if (node.kind !== 'folder') event.dataTransfer.setData(SPLIT_DRAG_MIME, encodeSplitDragPayload({ kind: 'utility', sel: `nav:${node.id}` })); }}
          onDragEnd={endDrag} onDragOver={event => handleDragOver(event, node)}
          onDrop={event => { event.preventDefault(); event.stopPropagation(); if (drop && dragRef.current === drop.sourceId && drop.targetId === node.id) relocate(drop); endDrag(); }}>
          <span className={`ext-nav-chevron${node.kind === 'folder' && !node.expanded ? ' is-closed' : ''}`}>
            {node.kind === 'folder' && <IconChevronDown size={11} />}
          </span>
          <span className="ext-nav-node-icon"><NavigationIcon node={node} open={node.kind === 'folder' && node.expanded} /></span>
          <span className="ext-nav-title">{node.title}</span>
          {node.favorite && <span className="ext-nav-favorite-mark" aria-label={t('已添加到常用')} title={t('已添加到常用')}>★</span>}
          {node.kind === 'folder' ? <span className="ext-nav-count">{navigationChildren(nodes, node.id).length}</span> : <span className="ext-nav-type">{t('扩展')}</span>}
          <button className="ext-nav-icon ext-nav-more" tabIndex={-1} aria-label={t('{{title}}的更多操作', { title: node.title })} onClick={event => {
            event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); openMenu(node, rect.right, rect.bottom, event.currentTarget);
          }}><IconMore size={15} /></button>
        </div>;
      })}
      {!nodes.length && <div className="ext-nav-empty">{t('把常用扩展放在这里')}<br /><span>{t('添加你的第一个入口')}</span></div>}
    </div>
    {hideHeading && <div className="ext-nav-footer-actions">{creationActions}</div>}
    {dragging && <div className={`ext-nav-root-drop${drop?.targetId === null ? ' is-over' : ''}`}
      onDragOver={event => { if (!dragRef.current) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; stopHover(); setDrop({ sourceId: dragRef.current, targetId: null, placement: 'inside' }); }}
      onDrop={event => { event.preventDefault(); if (dragRef.current) relocate({ sourceId: dragRef.current, targetId: null, placement: 'inside' }); endDrag(); }}>
      {t('移到最外层')}
    </div>}
    <div className="ext-nav-live" role="status" aria-live="polite">{notice}</div>
    {menuState.presence.mounted && liveMenu && createPortal(<div ref={menuRef} role="menu" aria-label={liveMenu.page === 'moving' ? t('移动到文件夹') : liveMenu.page === 'split' ? t('分屏显示') : t('入口操作')}
      className="ext-nav-menu mp-pop" {...menuState.presence.spread} data-h-strip-overlay=""
      aria-hidden={!menu || undefined} {...(!menu ? { inert: '' } : {})}
      style={{
        left: Math.max(8, Math.min(liveMenu.x, window.innerWidth - 272)) - liveMenu.origin.left,
        top: Math.max(8, Math.min(liveMenu.y, window.innerHeight - Math.min(360, menuActions.length * 36 + 16))) - liveMenu.origin.top
      }}
      onKeyDown={event => {
        if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); closeMenu(); return; }
        const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && buttons.length) {
          event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
        }
      }}>
      {menuActions.map(action => <button key={action.label} role="menuitem" disabled={action.disabled} className={action.danger ? 'is-danger' : ''} onClick={action.run}>{action.label}</button>)}
    </div>, liveMenu.host)}
    <NavigationEditor nodes={nodes} advanced={advanced} allowScope={allowScope} value={editor} onClose={() => { setEditor(null); returnFocus.current?.focus(); }} onSave={(title, options) => {
      if (!editor) return;
      let next: NavNode[];
      let id = editor.nodeId;
      if (editor.kind === 'rename') next = nodes.map(node => node.id === id ? { ...node, title } : node);
      else {
        id = randomUuid();
        const parentId = options?.parentId ?? editor.parentId;
        const base = { id, title, parentId, ...(advanced && allowScope ? { scope: nodes.find(node => node.id === parentId)?.scope ?? options?.scope ?? 'workspace' } : {}) };
        const newNode: NavNode = { ...base, kind: 'folder', expanded: true };
        next = [...nodes.map(node => node.id === editor.parentId && node.kind === 'folder' ? { ...node, expanded: true } : node), newNode];
      }
      announce(next, editor.kind === 'rename' ? t('已重命名为“{{title}}”', { title }) : t('已添加“{{title}}”', { title }));
      setEditor(null); onSelect(id!); focusRow(id!);
    }} />
  </div>;
}

export function NavigationEditor({ value, onClose, onSave, nodes = [], advanced = false, allowScope = true }: { value: Edit | null; onClose: () => void; onSave: (title: string, options?: EditOptions) => void; nodes?: NavNode[]; advanced?: boolean; allowScope?: boolean }): React.JSX.Element | null {
  const { t } = useTranslation();
  const { value: shown, presence } = usePresenceValue(value);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [scope, setScope] = useState<'workspace' | 'global'>('workspace');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedPresence = usePresence(advancedOpen);
  const form = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    if (!value) return;
    setTitle(value.title); setError('');
    setParentId(value.parentId); setScope(value.scope || 'workspace'); setAdvancedOpen(false);
  }, [value]);
  useLayoutEffect(() => {
    if (value && presence.mounted && presence.stage === 'in') form.current?.querySelector<HTMLInputElement>('input')?.select();
  }, [value, presence.mounted, presence.stage]);
  if (!presence.mounted || !shown) return null;
  return createPortal(<div className="ext-nav-scrim mp-scrim" {...presence.spread} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form ref={form} role="dialog" aria-modal="true" aria-labelledby="ext-nav-editor-title" className="ext-nav-dialog mp-panel" {...presence.spread}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
        if (event.key === 'Tab') {
          const controls = [...(form.current?.querySelectorAll<HTMLElement>('input, button, select') ?? [])].filter(element => !element.closest('[inert]'));
          if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
        }
      }}
      onSubmit={event => {
        event.preventDefault();
        const name = title.trim();
        if (!name) { setError(t('请输入名称')); return; }
        onSave(name, advanced ? { parentId, ...(allowScope ? { scope: nodes.find(node => node.id === parentId)?.scope ?? scope } : {}) } : undefined);
      }}>
      <h2 id="ext-nav-editor-title">{shown.kind === 'rename' ? t('重命名') : t('新建文件夹')}</h2>
      <p>{shown.kind === 'folder' ? t('把相关的扩展放在一起。') : t('只修改侧栏中显示的名称。')}</p>
      <label>{t('名称')}<input className="ui-input" value={title} onChange={event => setTitle(event.target.value)} maxLength={100} placeholder={shown.kind === 'folder' ? t('例如：设计工作室') : t('显示名称')} /></label>
      {advanced && shown.kind !== 'rename' && <>
        <label>{t('文件夹')}<CustomSelect ariaLabel={t('文件夹')} value={parentId ?? ''} onChange={value => setParentId(value || null)}
          options={[{ value: '', label: t('最外层') }, ...nodes.filter(node => node.kind === 'folder' && node.id !== shown.nodeId).map(node => ({ value: node.id, label: navigationPath(nodes, node.id).map(node => node.title).join(' / ') }))]} /></label>
        {allowScope && <><button className="ui-btn ghost tiny" type="button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(!advancedOpen)}>{t('高级选项')}</button>
        <div className={`acc${advancedPresence.stage === 'in' ? ' is-open' : ''}`} {...advancedPresence.spread} ref={element => { if (element) { if (advancedOpen) element.removeAttribute('inert'); else element.setAttribute('inert', ''); } }}><div className="acc-body">{advancedPresence.mounted && <div className="workbench-pin-options">
          <label>{t('可见范围')}<CustomSelect ariaLabel={t('可见范围')} disabled={!!parentId} value={scope} onChange={value => setScope(value as 'workspace' | 'global')}
            options={[{ value: 'workspace', label: t('当前工作区') }, { value: 'global', label: t('所有工作区') }]} /></label>
        </div>}</div></div></>}
      </>}
      {error && <ErrorTip message={error} />}
      <footer><button className="ui-btn ghost" type="button" onClick={onClose}>{t('取消')}</button><button className="ui-btn primary" type="submit">{shown.kind === 'rename' ? t('保存') : t('添加')}</button></footer>
    </form>
  </div>, document.body);
}
