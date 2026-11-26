import {
  CENTER_SNAP_LAYOUTS, getCenterSplitPaneCells, getCenterSplitRatios, SPLIT_RATIO_MAX, SPLIT_RATIO_MIN,
  type CenterSnapLayoutId, type CenterSplitPaneState, type RightSplitRef
} from './centerSplit';

export const RIGHT_PANEL_LAYOUTS = CENTER_SNAP_LAYOUTS.filter(layout => layout.id !== 'wide');
export type RightPaneRef = RightSplitRef | { kind: 'empty' };

export interface RightPanelSplit {
  layoutId: CenterSnapLayoutId;
  /** Physical slot order. An unfilled slot contains null. */
  tabIds: (string | null)[];
  ratio?: number;
  ratios?: [number, number];
}

export interface RightPanelLayout {
  selectedTabId: string | null;
  split: RightPanelSplit | null;
}

export const rightPaneRef = (tabId: string | null): RightPaneRef => tabId ? { kind: 'tab', tabId } : { kind: 'empty' };

export function rightSplitGeometry(split: RightPanelSplit | null): CenterSplitPaneState<RightPaneRef> {
  const third = split?.tabIds.length === 3;
  return { open: !!split, secondary: rightPaneRef(split?.tabIds[1] ?? null),
    tertiary: third ? rightPaneRef(split.tabIds[2]) : undefined, dir: split?.layoutId === 'stack' ? 'col' : 'row',
    layoutId: third ? split.layoutId : undefined, ratio: split?.ratio, ratios: split?.ratios };
}

const validRatio = (value: unknown): value is number =>
  typeof value === 'number' && value >= SPLIT_RATIO_MIN && value <= SPLIT_RATIO_MAX;

export function validateRightPanelSplit(split: RightPanelSplit): void {
  const preset = RIGHT_PANEL_LAYOUTS.find(layout => layout.id === split?.layoutId);
  if (!preset || !Array.isArray(split.tabIds) || split.tabIds.length !== preset.cells.length) {
    throw new Error('Right split slot count must match the layout');
  }
  const ids = split.tabIds.filter(id => id !== null);
  if (!ids.length || ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error('Right split requires distinct tab IDs');
  }
  if (preset.cells.length === 2) {
    if (split.ratios !== undefined || split.ratio !== undefined && !validRatio(split.ratio)) throw new Error('Invalid right split ratio');
  } else if (split.ratio !== undefined || split.ratios !== undefined && (
    !Array.isArray(split.ratios) || split.ratios.length !== 2 || !split.ratios.every(validRatio) ||
    (split.layoutId === 'thirds' && (split.ratios[0] > 0.6 || split.ratios[1] - split.ratios[0] < SPLIT_RATIO_MIN - 1e-9))
  )) throw new Error('Invalid right split ratios');
}

export function normalizeRightPanelSplit(split: RightPanelSplit): RightPanelSplit {
  validateRightPanelSplit(split);
  const { layoutId, tabIds } = split;
  return tabIds.length === 3
    ? { layoutId, tabIds: [...tabIds], ratios: getCenterSplitRatios(rightSplitGeometry(split)) }
    : { layoutId, tabIds: [...tabIds], ratio: split.ratio ?? 0.5 };
}

export function rightPanelLayoutTabIds(layout: RightPanelLayout): string[] {
  return (layout.split?.tabIds ?? [layout.selectedTabId]).filter(id => id !== null);
}

export function sameRightPanelLayout(a: RightPanelLayout, b: RightPanelLayout): boolean {
  const first = a.split, second = b.split;
  return a.selectedTabId === b.selectedTabId && (first === second || !!first && !!second &&
    first.layoutId === second.layoutId && first.ratio === second.ratio &&
    first.ratios?.[0] === second.ratios?.[0] && first.ratios?.[1] === second.ratios?.[1] &&
    first.tabIds.length === second.tabIds.length && first.tabIds.every((id, index) => id === second.tabIds[index]));
}

/** Removing a slot keeps the visible order and leaves every tab in the tab strip. */
export function removeRightPanelSlot(split: RightPanelSplit, selectedTabId: string, slot: number): RightPanelLayout {
  if (!Number.isInteger(slot) || slot < 0 || slot >= split.tabIds.length) throw new Error('Right split slot is unavailable');
  const cells = getCenterSplitPaneCells(rightSplitGeometry(split));
  const survivors = split.tabIds.flatMap((tabId, index) => tabId && index !== slot ? [{ tabId, cell: cells[index] }] : []);
  survivors.sort((a, b) => a.cell.x - b.cell.x || a.cell.y - b.cell.y);
  const tabIds = survivors.map(item => item.tabId);
  const selected = tabIds.includes(selectedTabId) ? selectedTabId : tabIds[0];
  if (!selected) throw new Error('Cannot remove the last populated right split slot');
  const stacked = survivors.length === 2 && survivors[0].cell.x === survivors[1].cell.x;
  return { selectedTabId: selected, split: tabIds.length === 2 ? { tabIds, layoutId: stacked ? 'stack' : 'halves', ratio: 0.5 } : null };
}
