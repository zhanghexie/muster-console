/**
 * 自由视图布局持久化：localStorage 一份全局布局（节点位 / 连线 / 分组 / 视图与相机 / 工作区过滤），
 * 模块级小 store + useSyncExternalStore（仿 needsReadStore）。读写全走这里，
 * 组件不得直接碰 localStorage。读取端只做形状校验兜底，坏数据回落空布局重来。
 */
import { useSyncExternalStore } from 'react';
import {
  emptyFreeViewLayout,
  parseFreeViewLayout,
  type FreeViewLayout,
  type FreeViewMode,
  type BoardFilterPanel
} from './freeViewGeom';

const STORAGE_KEY = 'gboard.freeview.v1';
const SAVE_DEBOUNCE_MS = 300;

function parseLayout(raw: string | null): FreeViewLayout | null {
  if (!raw) return null;
  try {
    return parseFreeViewLayout(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

let state: FreeViewLayout = parseLayout(localStorage.getItem(STORAGE_KEY)) ?? emptyFreeViewLayout();
const listeners = new Set<() => void>();

let saveTimer: number | null = null;
function scheduleSave(): void {
  if (saveTimer != null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* 配额满等异常：布局是锦上添花，静默放弃本次写盘 */
    }
  }, SAVE_DEBOUNCE_MS);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 读当前布局（手势类闭包里取最新值用，避免 stale state） */
export function getFreeViewLayout(): FreeViewLayout {
  return state;
}

export function setFreeViewLayout(next: FreeViewLayout): void {
  state = next;
  scheduleSave();
  for (const l of listeners) l();
}

export function updateFreeViewLayout(fn: (l: FreeViewLayout) => FreeViewLayout): void {
  setFreeViewLayout(fn(state));
}

export function useFreeViewLayout(): FreeViewLayout {
  return useSyncExternalStore(subscribe, () => state);
}

/** 面板只订阅视图/筛选，画布拖拽和相机更新不重绘整个看板。 */
export function useFreeViewOptions(): {
  view: FreeViewMode;
  filterActiveWorkspace: boolean;
  filterWorkspaceIds: string[] | null;
  filterPanelIds: BoardFilterPanel[] | null;
} {
  const view = useSyncExternalStore(subscribe, () => state.view);
  const filterActiveWorkspace = useSyncExternalStore(subscribe, () => state.filterActiveWorkspace);
  const filterWorkspaceIds = useSyncExternalStore(subscribe, () => state.filterWorkspaceIds);
  const filterPanelIds = useSyncExternalStore(subscribe, () => state.filterPanelIds);
  return { view, filterActiveWorkspace, filterWorkspaceIds, filterPanelIds };
}

/** 状态/自由视图切换（持久） */
export function setFreeViewMode(view: FreeViewMode): void {
  if (state.view === view) return;
  updateFreeViewLayout((l) => ({ ...l, view }));
}

/** 仅当前工作区过滤（持久；缺省 false。无激活工作区时调用方应禁用开关、仍显示全部） */
export function setFilterActiveWorkspace(on: boolean): void {
  if (state.filterActiveWorkspace === on && state.filterWorkspaceIds === null) return;
  updateFreeViewLayout((l) => ({ ...l, filterActiveWorkspace: on, filterWorkspaceIds: null }));
}

/** Multi-select workspace filter. `null` keeps all current and future workspaces visible. */
export function setBoardFilterWorkspaceIds(ids: string[] | null): void {
  const next = ids === null ? null : [...new Set(ids)];
  if (JSON.stringify(state.filterWorkspaceIds) === JSON.stringify(next) && !state.filterActiveWorkspace) return;
  updateFreeViewLayout((l) => ({ ...l, filterActiveWorkspace: false, filterWorkspaceIds: next }));
}

/** Multi-select panel filter. `null` keeps every board panel visible. */
export function setBoardFilterPanelIds(ids: BoardFilterPanel[] | null): void {
  const next = ids === null ? null : [...new Set(ids)];
  if (JSON.stringify(state.filterPanelIds) === JSON.stringify(next)) return;
  updateFreeViewLayout((l) => ({ ...l, filterPanelIds: next }));
}
