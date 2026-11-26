import { useState, type CSSProperties } from 'react';
import {
  clampRatio, deriveSnapLayout, getCenterSplitDividers, getCenterSplitPaneCells, getCenterSplitRatios,
  type CenterSnapCell, type CenterSnapTarget
} from '../../../shared/centerSplit';
import type { RightTab } from '../../../shared/rightWorkspace';
import { normalizeRightPanelSplit, removeRightPanelSlot, rightPaneRef, rightSplitGeometry, RIGHT_PANEL_LAYOUTS,
  type RightPanelLayout, type RightPanelSplit } from '../../../shared/rightPanelLayout';

type SplitLayout = RightPanelSplit & { scope: string; selected: string };

export function rightPaneRect(cell: CenterSnapCell, content = false): CSSProperties {
  return {
    inset: `${content ? `calc(${cell.y * 100}% + var(--right-content-toolbar-height))` : `${cell.y * 100}%`} ${(1 - cell.x - cell.width) * 100}% ${(1 - cell.y - cell.height) * 100}% ${cell.x * 100}%`
  };
}

export function useRightWorkspaceSplit(scope: string, tabs: RightTab[], selected: string | undefined, suspended: boolean, select: (id: string) => boolean) {
  const [stored, setLayout] = useState<SplitLayout | null>(null);
  let layout = stored;
  if (layout && (layout.scope !== scope || !selected)) {
    layout = null;
    setLayout(null);
  } else if (layout && selected) {
    const previousIds = layout.tabIds;
    const ids = previousIds.map(id => tabs.some(tab => tab.id === id) ? id : null);
    // New tabs and existing background tabs replace the focused slot. Focus
    // changes between already displayed tabs leave their slots intact.
    if (!ids.includes(selected)) ids[previousIds.indexOf(layout.selected)] = selected;
    if (selected !== layout.selected || ids.some((id, index) => id !== previousIds[index])) {
      layout = { ...layout, selected, tabIds: ids };
      setLayout(layout);
    }
  }

  const refs = (layout?.tabIds ?? [selected ?? null]).map(rightPaneRef);
  const state = rightSplitGeometry(layout);
  const cells = getCenterSplitPaneCells(state);
  const visible = !!layout && !suspended;
  const styles = layout && !suspended ? new Map(layout.tabIds.flatMap((id, index) => id ? [[id, rightPaneRect(cells[index], true)]] : [])) : undefined;
  const dividers = getCenterSplitDividers(state);

  const preview = (id: string, target: CenterSnapTarget) =>
    tabs.some(tab => tab.id === id) ? deriveSnapLayout(state, refs, rightPaneRef(id), target, true) : null;
  const commit = (id: string, target: CenterSnapTarget) => {
    const candidate = preview(id, target);
    if (!candidate || !select(id)) return;
    const ids: (string | null)[] = candidate.panes.map(() => null);
    candidate.panes.forEach((ref, index) => { if (ref.kind === 'tab') ids[candidate.order[index]] = ref.tabId; });
    setLayout({ scope, selected: id, ...normalizeRightPanelSplit({ layoutId: candidate.layoutId, tabIds: ids,
      ...(ids.length === 2 ? { ratio: candidate.ratio } : {}) }) });
  };
  const fill = (slot: number, id: string) => {
    if (!layout || layout.tabIds[slot] || layout.tabIds.includes(id) || !select(id)) return;
    const ids = [...layout.tabIds];
    ids[slot] = id;
    setLayout({ ...layout, tabIds: ids, selected: id });
  };
  const apply = (next: RightPanelLayout) => {
    setLayout(next.split && next.selectedTabId ? { ...next.split, scope, selected: next.selectedTabId } : null);
  };
  const remove = (slot: number) => {
    if (!layout || !layout.tabIds.some((id, index) => id && index !== slot)) return;
    const next = removeRightPanelSlot(layout, layout.selected, slot);
    if (next.selectedTabId === selected || next.selectedTabId && select(next.selectedTabId)) apply(next);
  };
  const resize = (index: 0 | 1, value: number) => {
    const divider = dividers[index];
    if (!layout || !divider || !Number.isFinite(value)) return;
    const ratio = Math.min(divider.max, Math.max(divider.min, clampRatio(value)));
    if (!state.tertiary) setLayout({ ...layout, ratio });
    else {
      const ratios = getCenterSplitRatios(state);
      ratios[index] = ratio;
      setLayout({ ...layout, ratios: getCenterSplitRatios({ ...state, ratios }) });
    }
  };
  const restore = (ratio: number, ratios?: [number, number]) =>
    setLayout(current => current && { ...current, ratio: ratios ? undefined : ratio, ratios });

  return {
    snapshot: layout ? normalizeRightPanelSplit(layout) : null,
    apply, visible, refs, state, styles, cells, dividers, preview, commit, fill, remove, resize, restore,
    clear: () => setLayout(null), layoutKey: JSON.stringify([scope, layout?.layoutId, layout?.tabIds]),
    layouts: RIGHT_PANEL_LAYOUTS
  };
}
