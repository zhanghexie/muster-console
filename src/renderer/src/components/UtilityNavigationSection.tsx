import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isOverlayPageSwitch, overlayViewportOrigin, stripOverlayHost, useDismissOnPagePeek } from '../hooks/useDismissOnPagePeek';
import { useTranslation } from 'react-i18next';
import { navigationPath, type ExtensionNavigationNode as NavNode } from '../../../shared/extensionNavigation';
import { SPLIT_DRAG_MIME, encodeSplitDragPayload, type SplitPaneRef } from '../../../shared/centerSplit';
import type { RightPinApi } from '../rightDock';
import { ExtensionNavigationTree, NavigationIcon } from './ExtensionNavigationTree';
import { IconChevronDown, IconMore } from './icons';
import { MOTION, usePresence, usePresenceValue } from './motion';
import { CollapsibleRailStack } from './CollapsibleRailStack';

type Props = {
  nodes: NavNode[];
  selectedId: string | null;
  /** All navigation references bound to the current central work surface. */
  openedIds?: readonly string[];
  onChange: (nodes: NavNode[], announcement: string) => void;
  onSelect: (id: string | null) => void;
  libraryExpanded: boolean;
  onLibraryExpandedChange: (expanded: boolean) => void;
  /** Existing utility tiles can be supplied by the host without changing their actions. */
  builtinTiles?: React.ReactNode;
  advanced?: boolean;
  allowScope?: boolean;
  onUndo?: () => void;
  /** 分组通过标题旁的独立箭头按钮折叠/展开。 */
  collapsed?: boolean;
  /** Pause geometry reads while the workspace film covers the work surface. */
  paused?: boolean;
  onToggleCollapsed?: () => void;
  /** 固定到右侧（扩展入口）：状态查询与切换由宿主提供 */
  rightPin?: Pick<RightPinApi, 'canPin' | 'isPinned'>;
  onToggleRightPin?: (ref: SplitPaneRef) => void;
};

/** Favorites reference the same navigation nodes; a shortcut never owns a second copy. */
export function UtilityNavigationSection({ nodes, selectedId, openedIds = selectedId ? [selectedId] : [], onChange, onSelect, builtinTiles, libraryExpanded, onLibraryExpandedChange, advanced, allowScope, onUndo, collapsed, paused, onToggleCollapsed, rightPin, onToggleRightPin }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ id: string; left: number; top: number; host: HTMLElement } | null>(null);
  const state = usePresenceValue(menu, MOTION.microMs);
  const menuRef = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const collapseToggleRef = useRef<HTMLButtonElement>(null);
  const libraryToggleRef = useRef<HTMLButtonElement>(null);
  const shortcutsId = useId();
  const libraryId = useId();
  const libraryOpen = libraryExpanded && !collapsed;
  const libraryPresence = usePresence(libraryOpen);
  const favorites = nodes.filter(node => node.favorite);
  const current = nodes.find(node => node.id === state.value?.id);
  useDismissOnPagePeek(!!menu, trigger.current, () => setMenu(null));

  function close(): void { setMenu(null); trigger.current?.focus(); }
  function toggleFavorite(id: string): void {
    const node = nodes.find(item => item.id === id);
    if (!node) return;
    onChange(nodes.map(item => item.id === id ? { ...item, favorite: !item.favorite } : item),
      node.favorite ? t('已将“{{title}}”从常用移除，列表入口保留', { title: node.title }) : t('已将“{{title}}”添加到常用', { title: node.title }));
  }
  function reveal(node: NavNode): void {
    if (collapsed) onToggleCollapsed?.();
    onLibraryExpandedChange(true);
    const ancestors = new Set(navigationPath(nodes, node.id).map(item => item.id));
    onChange(nodes.map(item => ancestors.has(item.id) && item.kind === 'folder' ? { ...item, expanded: true } : item), '');
    onSelect(node.id);
    requestAnimationFrame(() => {
      const row = [...(section.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].find(element => element.dataset.nodeId === node.id);
      row?.scrollIntoView?.({ block: 'nearest' }); row?.focus({ preventScroll: true });
    });
  }
  function open(node: NavNode, element: HTMLElement, x?: number, y?: number): void {
    trigger.current = element;
    const rect = element.getBoundingClientRect();
    const host = stripOverlayHost(element);
    const origin = overlayViewportOrigin(host);
    setMenu({
      id: node.id, host,
      left: Math.max(8, Math.min(x ?? rect.right, window.innerWidth - 272)) - origin.left,
      top: Math.max(8, Math.min(y ?? rect.bottom, window.innerHeight - 128)) - origin.top
    });
  }
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent): void => {
      if (!isOverlayPageSwitch(trigger, event.target) && !menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [menu?.id]);

  return <section className="utility-navigation" ref={section} aria-label={t('实用工具')}>
    <div className="utility-navigation-title panel-header-label">
      <span>{t('实用工具')}</span>
      <button type="button" className="panel-header-toggle" ref={collapseToggleRef}
        aria-expanded={!collapsed} aria-controls={`${shortcutsId} ${libraryId}`}
        aria-label={collapsed ? t('展开实用工具') : t('折叠实用工具')}
        title={collapsed ? t('展开实用工具') : t('折叠实用工具')}
        onClick={() => onToggleCollapsed?.()}>
        <IconChevronDown size={14} className="panel-header-chevron" />
      </button>
    </div>
    <div id={shortcutsId} role="group" aria-label={t('常用工具')}>
      <CollapsibleRailStack collapsed={!!collapsed} paused={paused} className="utility-feature-list" keepFirstRow>
        {builtinTiles}
        {favorites.map(node => <div className="utility-favorite" key={node.id} data-favorite-id={node.id}>
          <button type="button" className={`utility-feature-item${selectedId === node.id ? ' active is-pane-focused' : ''}${openedIds.includes(node.id) ? ' is-pane-open' : ''}`}
            data-pane-open={openedIds.includes(node.id) || undefined} data-pane-focused={selectedId === node.id || undefined}
            aria-label={node.title} aria-pressed={selectedId === node.id}
            title={navigationPath(nodes, node.id).map(item => item.title).join(' / ')}
            draggable={node.kind !== 'folder'}
            onDragStart={event => {
              if (node.kind === 'folder') return;
              event.dataTransfer.effectAllowed = 'copy';
              event.dataTransfer.setData(SPLIT_DRAG_MIME, encodeSplitDragPayload({ kind: 'utility', sel: `nav:${node.id}` }));
            }}
            onClick={() => onSelect(node.id)}
            onContextMenu={event => { event.preventDefault(); open(node, event.currentTarget, event.clientX, event.clientY); }}
            onKeyDown={event => { if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); open(node, event.currentTarget); } }}>
            <span className="utility-feature-icon"><NavigationIcon node={node} /></span>
            <span className="session-name"><span className="session-name-text">{node.title}</span></span>
          </button>
          <button type="button" className="ext-nav-icon utility-favorite-more" aria-label={t('{{title}}的常用操作', { title: node.title })}
            aria-haspopup="menu" aria-expanded={menu?.id === node.id}
            onClick={event => open(node, event.currentTarget)}><IconMore size={13} /></button>
        </div>)}
        <button type="button" ref={libraryToggleRef} className="utility-feature-item utility-library-toggle"
          aria-label={libraryOpen ? t('收起更多工具') : t('展开更多工具')} aria-expanded={libraryOpen} aria-controls={libraryId}
          onClick={() => {
            if (collapsed) onToggleCollapsed?.();
            if (libraryOpen || !libraryExpanded) onLibraryExpandedChange(!libraryOpen);
          }}>
          <span className="utility-feature-icon"><IconChevronDown size={16} /></span>
          <span className="session-name"><span className="session-name-text">{libraryOpen ? t('收起') : t('展开')}</span></span>
        </button>
      </CollapsibleRailStack>
    </div>
    <div id={libraryId} className={`utility-navigation-library acc${libraryPresence.stage === 'in' ? ' is-open' : ''}`}
      {...libraryPresence.spread} aria-hidden={!libraryOpen} ref={element => { if (element) { if (libraryOpen) element.removeAttribute('inert'); else element.setAttribute('inert', ''); } }}>
      <div className="acc-body">{libraryPresence.mounted && <div className="utility-navigation-library-content">
        <ExtensionNavigationTree nodes={nodes} selectedId={selectedId} openedIds={openedIds} onChange={onChange} onSelect={onSelect}
          heading={t('扩展')} hideHeading onToggleFavorite={toggleFavorite} advanced={advanced} allowScope={allowScope} onUndo={onUndo}
          rightPin={rightPin} onToggleRightPin={onToggleRightPin} />
      </div>}</div>
    </div>
    {state.presence.mounted && state.value && current && createPortal(<div role="menu" aria-label={t('常用入口操作')} ref={menuRef}
      className="ext-nav-menu mp-pop" {...state.presence.spread} data-h-strip-overlay=""
      aria-hidden={!menu || undefined} {...(!menu ? { inert: '' } : {})}
      style={{ left: state.value.left, top: state.value.top }}
      onKeyDown={event => {
        if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); close(); }
        if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + 1) % buttons.length]?.focus();
        }
      }}>
      <button role="menuitem" onClick={() => { close(); reveal(current); }}>{t('在列表中显示')}</button>
      {rightPin && onToggleRightPin && rightPin.canPin({ kind: 'utility', sel: `nav:${current.id}` }) && <button role="menuitem" onClick={() => {
        close(); onToggleRightPin({ kind: 'utility', sel: `nav:${current.id}` });
      }}>{rightPin.isPinned({ kind: 'utility', sel: `nav:${current.id}` }) ? t('移回中栏') : t('固定到右侧')}</button>}
      <button role="menuitem" onClick={() => {
        setMenu(null); toggleFavorite(current.id);
        requestAnimationFrame(() => {
          const next = libraryOpen ? section.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') : null;
          (next ?? (collapsed ? collapseToggleRef.current : libraryToggleRef.current))?.focus();
        });
      }}>{t('从常用移除')}</button>
    </div>, state.value.host)}
  </section>;
}
