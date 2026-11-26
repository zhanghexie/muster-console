/**
 * 窗口背景（渲染层）：frameFx 同款三段式 + localStorage 缓存防启动闪烁。
 * 1. 模块加载即按缓存恢复全局与各工作区的背景；
 * 2. main.tsx 启动时 initFrameBackdrop()：config.get() 校正；
 * 3. 设置「外观 → 效果」切换走 setFrameBackdrop()（本地立即生效 + config.update 落盘）。
 * 生效背景 = 工作区独立设置 ?? 全局（shared/frameBackdrop.resolveFrameBackdrop）。
 */
import { useSyncExternalStore } from 'react';
import {
  DEFAULT_FRAME_BACKDROP,
  normalizeFrameBackdrop,
  normalizeFrameBackdropByWorkspace,
  resolveFrameBackdrop,
  type FrameBackdropChoice
} from '../../shared/frameBackdrop';

const CACHE_KEY = 'muster.frameBackdrop.v1';

export interface FrameBackdropState {
  global: FrameBackdropChoice;
  byWorkspace: Record<string, FrameBackdropChoice>;
}

const listeners = new Set<() => void>();

function readCache(): FrameBackdropState {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') as Partial<FrameBackdropState> | null;
    return {
      global: normalizeFrameBackdrop(raw?.global),
      byWorkspace: normalizeFrameBackdropByWorkspace(raw?.byWorkspace)
    };
  } catch {
    return { global: { ...DEFAULT_FRAME_BACKDROP }, byWorkspace: {} };
  }
}

let state: FrameBackdropState = readCache();

export function getFrameBackdropState(): FrameBackdropState {
  return state;
}

export function subscribeFrameBackdrop(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function apply(next: FrameBackdropState): void {
  state = next;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式等场景忽略 */
  }
  for (const fn of listeners) fn();
}

type Patch = {
  frameBackdrop?: FrameBackdropChoice;
  frameBackdropByWorkspace?: Record<string, FrameBackdropChoice>;
};

/** 滑块拖动每步都会 set：本地立即生效，落盘合并去抖 */
export const PERSIST_DEBOUNCE_MS = 200;
let pending: Patch = {};
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export function flushFrameBackdropPersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  const patch = pending;
  pending = {};
  if (!Object.keys(patch).length) return;
  try {
    void window.api.config.update(patch).catch(() => {
      /* 落盘失败保持本地态（与 frameFx 同口径） */
    });
  } catch {
    /* 单测 / 主进程不可达 */
  }
}

function persist(patch: Patch): void {
  pending = { ...pending, ...patch };
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(flushFrameBackdropPersist, PERSIST_DEBOUNCE_MS);
}

/** 设置页切换：workspaceId 给定 = 只改该工作区（独立背景），否则改全局默认 */
export function setFrameBackdrop(choice: FrameBackdropChoice, workspaceId?: string | null): void {
  const c = normalizeFrameBackdrop(choice);
  if (workspaceId) {
    const byWorkspace = { ...state.byWorkspace, [workspaceId]: c };
    apply({ ...state, byWorkspace });
    persist({ frameBackdropByWorkspace: byWorkspace });
  } else {
    apply({ ...state, global: c });
    persist({ frameBackdrop: c });
  }
}

/** 该工作区恢复跟随全局 */
export function clearWorkspaceFrameBackdrop(workspaceId: string): void {
  if (!(workspaceId in state.byWorkspace)) return;
  const byWorkspace = { ...state.byWorkspace };
  delete byWorkspace[workspaceId];
  apply({ ...state, byWorkspace });
  persist({ frameBackdropByWorkspace: byWorkspace });
}

/** main.tsx 启动调用：主进程配置为准校正 */
export function initFrameBackdrop(): void {
  try {
    void window.api.config
      .get()
      .then((cfg) => {
        apply({
          global: normalizeFrameBackdrop(cfg.frameBackdrop),
          byWorkspace: normalizeFrameBackdropByWorkspace(cfg.frameBackdropByWorkspace)
        });
      })
      .catch(() => {
        /* 主进程不可达保持缓存值 */
      });
  } catch {
    /* ignore */
  }
}

/** 某工作区当前生效的背景 */
export function useFrameBackdrop(workspaceId: string | null | undefined): FrameBackdropChoice {
  const s = useSyncExternalStore(subscribeFrameBackdrop, getFrameBackdropState);
  return resolveFrameBackdrop(s.global, s.byWorkspace, workspaceId);
}

export function useFrameBackdropState(): FrameBackdropState {
  return useSyncExternalStore(subscribeFrameBackdrop, getFrameBackdropState);
}

/** 测试用：只写内存态，不落盘 */
export function resetFrameBackdropForTest(next?: Partial<FrameBackdropState>): void {
  apply({
    global: normalizeFrameBackdrop(next?.global),
    byWorkspace: normalizeFrameBackdropByWorkspace(next?.byWorkspace)
  });
}
