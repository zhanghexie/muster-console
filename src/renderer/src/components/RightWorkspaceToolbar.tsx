import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChordLabel } from '../keybindings/KeybindingHost';
import { dataTransferHasPaths, pathsFromDataTransfer } from '../../../shared/fileDropPaths';
import type { RightTab, ResourcePanel } from '../../../shared/rightWorkspace';
import { RESOURCE_PANELS, isDockedRightContent, rightContentLocation, rightContentTitle } from '../../../shared/rightWorkspace';
import { ContextMenu, type ContextMenuItem, type ContextMenuPoint } from './ContextMenu';
import { useListSelection } from '../hooks/useListSelection';
import { usePresence } from './motion';
import { IconShrink } from './icons';
import { IconBranch, IconChat, IconChevronLeft, IconClose, IconDiff, IconEye, IconFile, IconFolderOpen, IconGlobe, IconImage, IconLayout, IconMore, IconPanelToggle, IconPin, IconPuzzle, IconTerminal, IconWrench } from './icons';

export function RightContentIcon({ tab }: { tab: RightTab }): React.JSX.Element {
  if (tab.content.kind === 'extension') return <IconPuzzle size={14}/>;
  if (tab.content.kind === 'session') return tab.content.chat ? <IconChat size={14}/> : <IconTerminal size={14}/>;
  if (tab.content.kind === 'utility') return <IconWrench size={14}/>;
  const Icon = tab.content.kind === 'web' ? IconGlobe : tab.content.kind === 'git' ? IconBranch : tab.content.kind === 'review' ? IconEye : tab.content.kind === 'diff' ? IconDiff : tab.content.kind === 'image' ? IconImage : IconFile;
  return <Icon size={14}/>;
}
export function rightTabTitle(tab: RightTab, t: (key: string) => string): string {
  return tab.content.kind === 'utility' ? t(tab.content.title) : tab.content.kind === 'review' ? t('审阅') : rightContentTitle(tab.content);
}

const RESOURCE_ICONS = { files: IconFolderOpen, git: IconBranch, browser: IconGlobe } as const;
export function RightWorkspaceToolbar({ tabs, current, panel, collapsed, backDepth, forwardDepth, onHistory, onSelect, onClose, onAction, onMove, onResource, onCollapse, onDropPaths, transitioning = false, historyBusy = false, fullscreenId = null, onFullscreen, onSplit, onSplitDrag, splitOpen, onUnsplit }: {
  tabs: RightTab[]; current?: RightTab; panel: ResourcePanel; collapsed: boolean; backDepth: number; forwardDepth: number;
  onHistory: (dir: -1 | 1) => void; onSelect: (id: string) => void; onClose: (ids: string[]) => void;
  onAction: (action: 'pin' | 'keep', id: string) => void;
  onMove: (id: string, before: string) => void; onResource: (panel: ResourcePanel) => void; onCollapse: () => void;
  onDropPaths?: (panel: ResourcePanel, paths: string[]) => void; transitioning?: boolean; historyBusy?: boolean;
  fullscreenId?: string | null; onFullscreen?: (id: string) => void;
  onSplit?: (id: string) => void; onSplitDrag?: (id: string | null) => void;
  splitOpen?: boolean; onUnsplit?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const titleOf = (tab: RightTab): string => rightTabTitle(tab, t);
  const locationOf = (tab: RightTab): string => tab.content.kind === 'utility' ? titleOf(tab)
    : tab.content.kind === 'review' && !tab.content.filePath && !tab.content.repoPath ? t('审阅') : rightContentLocation(tab.content);
  const sessionLabel = t('跟随会话');
  const backChord = useChordLabel('sideTools.back');
  const forwardChord = useChordLabel('sideTools.forward');
  const backTitle = [backDepth > 0 ? t('撤销（可撤销 {{n}} 步）', { n: backDepth }) : t('撤销'), backChord].filter(Boolean).join(' · ');
  const forwardTitle = [forwardDepth > 0 ? t('重做（可重做 {{n}} 步）', { n: forwardDepth }) : t('重做'), forwardChord].filter(Boolean).join(' · ');
  const strip = useRef<HTMLDivElement>(null);
  const dragging = useRef<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuPoint & { id?: string } | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const isFullscreen = fullscreenId != null;
  useLayoutEffect(() => { setHovered(false); setFocused(false); }, [isFullscreen]);
  useEffect(() => {
    if (!fullscreenId || !hovered && !focused) return;
    const clear = () => { setHovered(false); setFocused(false); };
    const pointer = (event: PointerEvent) => { setFocused(false); if (!host.current?.contains(event.target as Node)) setHovered(false); };
    window.addEventListener('pointermove', pointer, true); window.addEventListener('pointerdown', pointer, true); window.addEventListener('blur', clear);
    return () => { window.removeEventListener('pointermove', pointer, true); window.removeEventListener('pointerdown', pointer, true); window.removeEventListener('blur', clear); };
  }, [fullscreenId, hovered, focused]);
  const presence = usePresence(!fullscreenId || hovered || focused || menu != null);
  // 多选（Ctrl/⌘ 点选、Shift 范围；横向轴）：显式选中的关闭不受固定保护限制
  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const selection = useListSelection({ orderedIds: tabIds, axis: 'horizontal' });
  useEffect(() => {
    if (transitioning) return;
    const reveal = (): void => { strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); };
    const timer = window.setTimeout(reveal, 0);
    return () => window.clearTimeout(timer);
  }, [current?.id, tabs.length, transitioning]);
  const target = tabs.find(tab => tab.id === (menu?.id ?? current?.id));
  const multiClose = Boolean(menu?.id && selection.isSelected(menu.id) && selection.selectedIds.size > 1);
  const items: ContextMenuItem[] = [
    { id: 'pin', label: target?.pinned ? t('取消固定') : t('固定标签页'), disabled: !target || isDockedRightContent(target.content) },
    { id: 'keep', label: t('保留标签页'), disabled: !target?.preview },
    ...(onFullscreen ? [{ id: 'fullscreen', label: t(fullscreenId === target?.id ? '退出全屏' : '全屏显示'), disabled: !target || historyBusy || transitioning }] : []),
    ...(onSplit && !isFullscreen ? [{ id: 'split', label: t('选择分屏布局'), disabled: !target || historyBusy || transitioning }] : []),
    ...(onUnsplit && splitOpen ? [{ id: 'unsplit', label: t('解散分屏（保留此侧）') }] : []),
    { id: 'divider', separator: true },
    ...(multiClose
      ? [{ id: 'close-selected', label: t('关闭选中的 {{n}} 个标签页', { n: selection.selectedIds.size }) }]
      : []),
    { id: 'close', label: t('关闭标签页'), disabled: !target },
    { id: 'others', label: t('关闭其他标签页'), disabled: !target || tabs.length < 2 },
    { id: 'right', label: t('关闭右侧标签页'), disabled: !target || tabs.at(-1)?.id === target.id },
    { id: 'all', label: t('关闭所有未固定标签页'), disabled: !tabs.some(tab => !tab.pinned) }
  ];
  return <div ref={host} className={`right-toolbar-host${fullscreenId ? ' is-fullscreen' : ''}`}
    onPointerEnter={() => setHovered(true)} onPointerMove={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocusCapture={event => setFocused((event.target as HTMLElement).matches(':focus-visible'))}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
    {fullscreenId ? <div className="right-fullscreen-hotzone" aria-hidden="true"/> : null}
    <div className={`right-workspace-toolbar${fullscreenId ? ' mp-scrim' : ''}`} data-mp-stage={presence.mounted ? presence.stage : 'out'}>
    <div className="right-tabs-row">
    <div className="right-history">
      <button type="button" className="right-icon" title={backTitle} aria-label={t('撤销')} disabled={historyBusy || backDepth === 0} onClick={() => onHistory(-1)}><IconChevronLeft/></button>
      <button type="button" className="right-icon" title={forwardTitle} aria-label={t('重做')} disabled={historyBusy || forwardDepth === 0} onClick={() => onHistory(1)}><IconChevronLeft className="right-forward"/></button>
    </div>
    <div className="right-tab-strip" ref={strip} role="tablist" aria-label={t('内容标签页')} onWheel={event => { if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) { event.currentTarget.scrollLeft += event.deltaY; event.preventDefault(); } }} onKeyDown={e => { selection.handleKeyDown(e, { currentId: current?.id ?? null, onMoveFocus: onSelect }); }}>
      {tabs.map(tab => <div key={tab.id} className={`right-tab${current?.id === tab.id ? ' is-selected' : ''}${selection.isSelected(tab.id) ? ' is-multiselected' : ''}${tab.preview ? ' is-preview' : ''}`} role="tab" tabIndex={current?.id === tab.id ? 0 : -1} aria-selected={current?.id === tab.id} aria-description={tab.scope === 'session' ? sessionLabel : undefined} title={locationOf(tab)} draggable
        onClick={e => { if (selection.click(tab.id, e) !== 'plain') return; onSelect(tab.id); }} onDoubleClick={() => onAction('keep', tab.id)}
        onAuxClick={e => { if (e.button === 1) { e.preventDefault(); onClose([tab.id]); } }}
        onKeyDown={e => { const index = tabs.indexOf(tab); if (!e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End')) { e.preventDefault(); const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs.at(-1) : tabs[(index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]; if (next) { onSelect(next.id); (strip.current?.children[tabs.indexOf(next)] as HTMLElement)?.focus(); } } if (e.key === 'Delete') onClose([tab.id]); }}
        onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, anchor: e.currentTarget, id: tab.id }); }}
        onDragStart={e => { dragging.current = tab.id; e.dataTransfer.setData('application/x-muster-right-tab', tab.id);
          if (!isFullscreen && !historyBusy && !transitioning) onSplitDrag?.(tab.id);
        }} onDragEnd={() => { dragging.current = null; onSplitDrag?.(null); }}
        onDragOver={e => { if (dragging.current) e.preventDefault(); }} onDrop={e => { if (dragging.current) { e.preventDefault(); onMove(dragging.current, tab.id); dragging.current = null; } }}>
        <RightContentIcon tab={tab}/><span className="right-tab-title">{titleOf(tab)}</span>
        {tab.scope === 'session' ? <span className="right-tab-session" title={sessionLabel} aria-hidden="true"><IconChat size={14}/></span> : null}
        {tab.pinned ? <IconPin size={11}/> : null}
        <button type="button" className="right-tab-close" aria-label={`${t('关闭标签页')} ${titleOf(tab)}`} onClick={e => { e.stopPropagation(); onClose([tab.id]); }}><IconClose size={11}/></button>
      </div>)}
    </div>
    <div className="right-tab-actions">
      {fullscreenId && onFullscreen ? <button type="button" className="right-icon" title={t('退出全屏')} aria-label={t('退出全屏')} onClick={() => onFullscreen(fullscreenId)}><IconShrink size={14}/></button> : null}
      {onSplit && !isFullscreen ? <button className={`right-icon${splitOpen ? ' is-on' : ''}`} data-right-snap-trigger type="button" title={t('选择分屏布局')} aria-label={t('选择分屏布局')} disabled={!current || historyBusy || transitioning}
        onClick={() => current && onSplit(current.id)}><IconLayout size={14}/></button> : null}
      <button className={`right-icon${current?.pinned ? ' is-on' : ''}`} type="button" title={current?.pinned ? t('取消固定') : t('固定标签页')} aria-label={current?.pinned ? t('取消固定') : t('固定标签页')} aria-pressed={!!current?.pinned} disabled={!current || isDockedRightContent(current.content)} onClick={() => current && onAction('pin', current.id)}><IconPin size={14}/></button>
      <button className="right-icon" type="button" title={t('标签页管理')} aria-label={t('标签页管理')} onClick={e => { const box = e.currentTarget.getBoundingClientRect(); setMenu({ x: box.left, y: box.bottom, anchor: e.currentTarget }); }}><IconMore/></button>
    </div>
    <div className="right-resource-controls">
      <div className="right-resource-capsule" role="tablist" aria-label={t('资源面板')}>
        {RESOURCE_PANELS.map(kind => { const Icon = RESOURCE_ICONS[kind]; const label = kind === 'files' ? t('文件') : kind === 'git' ? 'Git' : t('浏览器'); return <button type="button" key={kind} role="tab" aria-selected={panel === kind} aria-label={label} title={label} className={panel === kind ? 'is-selected' : ''} onClick={() => onResource(kind)} onDragOver={e => { if (dataTransferHasPaths(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }} onDrop={e => { if (!dataTransferHasPaths(e.dataTransfer)) return; e.preventDefault(); e.stopPropagation(); const paths = pathsFromDataTransfer(e.dataTransfer, file => window.api.shell.pathForFile(file)); if (paths.length) onDropPaths?.(kind, paths); else onResource(kind); }}><Icon size={14}/></button>; })}
      </div>
      <button className="right-icon" type="button" title={collapsed ? t('展开资源面板') : t('收起资源面板')} aria-label={collapsed ? t('展开资源面板') : t('收起资源面板')} aria-expanded={!collapsed} onClick={onCollapse}><IconPanelToggle size={14} placement="side" open={!collapsed}/></button>
    </div>
    </div>
    {menu ? <ContextMenu x={menu.x} y={menu.y} anchor={menu.anchor} items={items} onClose={() => setMenu(null)} onSelect={action => {
      if (action === 'close-selected') {
        onClose(tabIds.filter(id => selection.isSelected(id)));
        selection.clear();
      } else if (action === 'close' && target) onClose([target.id]);
      else if (action === 'others' && target) onClose(tabs.filter(tab => tab.id !== target.id && !tab.pinned).map(tab => tab.id));
      else if (action === 'right' && target) onClose(tabs.slice(tabs.indexOf(target) + 1).filter(tab => !tab.pinned).map(tab => tab.id));
      else if (action === 'all') onClose(tabs.filter(tab => !tab.pinned).map(tab => tab.id));
      else if (action === 'fullscreen' && target) onFullscreen?.(target.id);
      else if (action === 'split' && target) onSplit?.(target.id);
      else if (action === 'unsplit') onUnsplit?.();
      else if (target && (action === 'pin' || action === 'keep')) { onAction(action, target.id); return; }
      selection.clear();
    }}/> : null}
  </div></div>;
}

export function RightWorkspaceContentToolbar({ toolbarRef, locationRef, fallback, trailing }: {
  toolbarRef: (node: HTMLDivElement | null) => void;
  locationRef: (node: HTMLDivElement | null) => void;
  fallback?: React.ReactNode;
  trailing?: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  return <div className="right-current-row" role="toolbar" aria-label={t('当前内容工具')}>
    <div className="right-location-host" ref={locationRef}>{fallback}</div>
    <div className="right-content-tools" ref={toolbarRef}/>
    {trailing}
  </div>;
}
