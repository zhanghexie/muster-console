import { createContext, useContext } from 'react';
import { MOTION } from './components/motion';

/**
 * 工作区切换过场编排（胶片：arm → to-skel 滑到骨架 → 切区 → fade 骨架淡出）。
 *
 * 纯状态机，依赖全注入（App 注入 setState/IPC，单测注入 fake timers）：
 * - 切区（IPC）必须在骨架盖满后才发：主进程 workspaces:switch 内即广播
 *   workspaces:changed 并重放工作区主题，滑动途中发出会在仍可见的实况半屏上闪出新区；
 * - 防重入：过场中的新请求只记为 pending，「以最后一次为准」——骨架下直接续切，
 *   不再滑第二次；fade 期到达的请求在本次过场结束后另起一次完整过场；
 * - 减弱动态：跳过滑动与淡出，直接切区。
 */

export type SwitchResult = { ok: boolean; message?: string };
export type TransitPhase = 'arm' | 'to-skel' | 'fade';
export type WorkspaceTransitLayout = {
  leftW: number;
  virtualScreen: boolean;
  hDock: 'terminal' | 'git';
  /** Target horizontal split widths as fractions of the viewport. */
  termRatio: number;
  gitRatio: number;
  /** Target resolved surfaces, so the film does not flash the previous workspace theme. */
  frameColor?: string;
  canvasColor?: string;
};

export interface WorkspaceTransitDeps {
  /** phase=null 撤掉过场；arm 时带上目标 id 供调用方算方向/锁布局 */
  setPhase: (phase: TransitPhase | null, toId: string, layout?: WorkspaceTransitLayout | null) => void;
  doSwitch: (id: string) => Promise<SwitchResult>;
  sleep: (ms: number) => Promise<void>;
  nextFrame: () => Promise<void>;
  reducedMotion: () => boolean;
  /** Wait until the newly selected workspace has committed a visible work surface. */
  waitForVisible?: (id: string) => Promise<void>;
  /** Resolve target workspace layout before the film starts; failures use current layout. */
  resolveLayout?: (id: string) => Promise<WorkspaceTransitLayout | null>;
}

export interface WorkspaceTransit {
  /** 过场中调用返回同一个在途 Promise（结果为最终一次切区） */
  run: (toId: string) => Promise<SwitchResult>;
  isRunning: () => boolean;
}

export function createWorkspaceTransit(deps: WorkspaceTransitDeps): WorkspaceTransit {
  let inflight: Promise<SwitchResult> | null = null;
  let pending: string | null = null;
  /** 最近一次切区成功的目标：pending 与其相同则无需再切 */
  let current: string | null = null;

  const execute = async (first: string): Promise<SwitchResult> => {
    const animate = !deps.reducedMotion();
    let target = first;
    if (animate) {
      const layout = deps.resolveLayout ? await deps.resolveLayout(target) : null;
      deps.setPhase('arm', target, layout);
      await deps.nextFrame();
      deps.setPhase('to-skel', target);
      await deps.sleep(MOTION.workspaceMs);
    }
    // 滑动期间又点了别的区：还没切，直接切最后一次的目标
    if (pending != null) {
      target = pending;
      pending = null;
    }
    let res = await deps.doSwitch(target);
    if (res.ok) current = target;
    while (res.ok && pending != null) {
      const next = pending;
      pending = null;
      if (next === current) continue;
      target = next;
      res = await deps.doSwitch(target);
      if (res.ok) current = target;
    }
    if (!res.ok) {
      deps.setPhase(null, target);
      return res;
    }
    if (animate) {
      if (deps.waitForVisible) await deps.waitForVisible(target);
      else await deps.nextFrame();
      deps.setPhase('fade', target);
      await deps.sleep(MOTION.workspacefadeMs);
    }
    deps.setPhase(null, target);
    return res;
  };

  const run = (toId: string): Promise<SwitchResult> => {
    if (inflight) {
      pending = toId;
      return inflight;
    }
    current = null;
    inflight = (async () => {
      try {
        let res = await execute(toId);
        while (res.ok && pending != null) {
          const next = pending;
          pending = null;
          if (next === current) continue;
          res = await execute(next);
        }
        return res;
      } finally {
        inflight = null;
        pending = null;
      }
    })();
    return inflight;
  };

  return { run, isRunning: () => inflight != null };
}

/** App 提供的带过场切区；未提供（单测/手机端）时回落到 store 的直切 */
export const WorkspaceTransitContext = createContext<((id: string) => Promise<SwitchResult>) | null>(
  null
);

export function useWorkspaceTransitSwitch(
  fallback: (id: string) => Promise<SwitchResult>
): (id: string) => Promise<SwitchResult> {
  return useContext(WorkspaceTransitContext) ?? fallback;
}
