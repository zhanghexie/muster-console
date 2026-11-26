import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CENTER_SNAP_LAYOUTS, type CenterSnapTarget } from '../../../shared/centerSplit';
import type { RightTab } from '../../../shared/rightWorkspace';
import { rightPaneRect, type useRightWorkspaceSplit } from '../hooks/useRightWorkspaceSplit';
import { CenterSnapBar } from './CenterSnapBar';
import { IconClose } from './icons';
import { usePresenceValue } from './motion';
import type { RightContentToolbarHosts } from '../rightWorkspace';
import { RightContentIcon, RightWorkspaceContentToolbar, rightTabTitle } from './RightWorkspaceToolbar';
import { SnapDividers } from './SnapDividers';

type Split = ReturnType<typeof useRightWorkspaceSplit>;
export type RightSnapSource = { id: string; dragging?: boolean };

type RegisterToolbar = (id: string, region: keyof RightContentToolbarHosts, node: HTMLElement | null) => void;

function PaneToolbar({ tab, busy, canRemove, remove, register }: {
  tab?: RightTab; busy: boolean; canRemove: boolean;
  remove: () => void; register: RegisterToolbar;
}) {
  const { t } = useTranslation();
  const id = tab?.id;
  const locationRef = useCallback((node: HTMLDivElement | null) => { if (id) register(id, 'location', node); }, [id, register]);
  const toolbarRef = useCallback((node: HTMLDivElement | null) => { if (id) register(id, 'toolbar', node); }, [id, register]);
  const close = canRemove ? <button type="button" className="right-icon right-pane-close" disabled={busy}
    title={t('收起此侧')} aria-label={t('收起此侧')} onClick={remove}><IconClose size={12}/></button> : null;
  return <div className="right-pane-header" data-right-split-tab={id}>
    <RightWorkspaceContentToolbar locationRef={locationRef} toolbarRef={toolbarRef} trailing={close}
      fallback={!tab || tab.content.kind === 'extension' ? <span className="right-pane-title">
        {tab ? <RightContentIcon tab={tab}/> : null}<span>{tab ? rightTabTitle(tab, t) : t('空面板')}</span>
      </span> : undefined}/>
  </div>;
}

export function RightWorkspaceSplitControls({ split, tabs, selected, container, busy, dragSource, registerToolbar }: {
  split: Split; tabs: RightTab[]; selected?: string; container: RefObject<HTMLDivElement | null>;
  busy: boolean; dragSource: RightSnapSource | null; registerToolbar: RegisterToolbar;
}) {
  const { t } = useTranslation();
  const available = tabs.filter(tab => !split.styles?.has(tab.id));
  if (!split.visible) return null;
  return <>
    {split.refs.map((ref, slot) => {
      const tab = ref.kind === 'tab' ? tabs.find(item => item.id === ref.tabId) : undefined;
      return <div key={slot} className="right-pane-controls" style={rightPaneRect(split.cells[slot])}
        data-right-split-slot={slot} data-selected={tab != null && selected === tab.id}
        onDragOver={!tab && dragSource?.dragging && !split.styles?.has(dragSource.id) ? event => {
          event.preventDefault(); event.dataTransfer.dropEffect = 'move';
        } : undefined}
        onDrop={!tab && dragSource?.dragging ? event => {
          event.preventDefault(); split.fill(slot, dragSource.id);
        } : undefined}>
        <PaneToolbar tab={tab} busy={busy} canRemove={!tab || (split.styles?.size ?? 0) > 1}
          remove={() => split.remove(slot)} register={registerToolbar}/>
        {!tab ? <div className="right-pane-picker center-snap-assist" aria-label={t('选择内容')}>
          {available.map(item => <button type="button" className="center-snap-assist-choice" disabled={busy} key={item.id} onClick={() => split.fill(slot, item.id)}>
            <RightContentIcon tab={item}/><span>{rightTabTitle(item, t)}</span>
          </button>)}
          {!available.length ? <div className="right-empty-hint">{t('打开文件、仓库或网页开始查看')}</div> : null}
        </div> : null}
      </div>;
    })}
    <SnapDividers container={container} dividers={split.dividers} state={split.state} layoutKey={split.layoutKey}
      enabled={!busy && !dragSource?.dragging} testId="right-split-divider" onChange={split.resize} onRestore={split.restore}/>
  </>;
}

export function RightWorkspaceSnapPicker({ split, tabs, source, container, dismiss, restoreFocus }: {
  split: Split; tabs: RightTab[]; source: RightSnapSource | null; container: RefObject<HTMLDivElement | null>; dismiss: () => void; restoreFocus: () => void;
}) {
  const { t } = useTranslation();
  const { presence, value } = usePresenceValue(source);
  const [target, setTarget] = useState<CenterSnapTarget | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!source) { setTarget(null); return; }
    if (source.dragging) return;
    const frame = requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus());
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !(event.target as HTMLElement).closest?.('[data-right-snap-trigger]')) dismiss();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('pointerdown', outside, true); };
  }, [source, dismiss]);
  const cell = target && CENTER_SNAP_LAYOUTS.find(layout => layout.id === target.layoutId)?.cells[target.index];
  const preview = usePresenceValue(source ? cell : null);
  if (!value || !presence.mounted) return null;
  const close = () => { dismiss(); if (!value.dragging) restoreFocus(); };
  const commit = (destination: CenterSnapTarget) => { split.commit(value.id, destination); close(); };
  return <div className="right-snap-overlay">
    {preview.value && preview.presence.mounted && container.current ? createPortal(
      <div className="right-snap-preview center-pane-preview mp-scrim" {...preview.presence.spread}
        style={rightPaneRect(preview.value)} aria-hidden="true"/>, container.current) : null}
    <div ref={root} className="right-snap-position">
      <CenterSnapBar layouts={split.layouts} testIdPrefix="right-snap"
        currentRefs={split.refs} sourceRef={{ kind: 'tab', tabId: value.id }} target={target} previewFor={destination => split.preview(value.id, destination)}
        labelFor={ref => {
          const tab = ref.kind === 'tab' ? tabs.find(item => item.id === ref.tabId) : undefined;
          return tab ? rightTabTitle(tab, t) : t('空面板');
        }} renderIcon={ref => {
          const tab = ref.kind === 'tab' ? tabs.find(item => item.id === ref.tabId) : undefined;
          return tab ? <RightContentIcon tab={tab}/> : null;
        }} presenceSpread={presence.spread} onPreview={setTarget} onSelect={commit}
        onDropTarget={source?.dragging ? commit : undefined} onDismiss={close}/>
    </div>
  </div>;
}
