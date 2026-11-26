import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, type MutableRefObject } from 'react';
import { leftNavigationKey, type LeftNavigationEntry } from '../../../shared/leftNavigation';
import { usePanelHistory } from '../panelHistory';
import { centerSplitCanRestoreHistory, centerSplitRestoreHistory, getCenterSplitState, useCenterSplit, type CenterSplitState } from '../centerSplitStore';
import type { SplitPaneRef } from '../../../shared/centerSplit';

interface Options {
  workspaceId: string;
  enabled: boolean;
  page: 'terminal' | 'git';
  primary: SplitPaneRef;
  showPage: (page: 'terminal' | 'git') => void;
}

function snapshot(page: Options['page'], primary: SplitPaneRef, split: CenterSplitState): LeftNavigationEntry {
  return page === 'git' ? { page: 'git' }
    : { page: 'terminal', primary: { ...primary }, ...(split.open ? { split: {
      secondary: { ...split.secondary }, ...(split.tertiary ? { tertiary: { ...split.tertiary } } : {}),
      dir: split.dir, ratio: split.ratio, ratios: split.ratios ? [...split.ratios] as [number, number] : undefined, focused: split.focused, layoutId: split.layoutId,
      order: split.order ? [...split.order] : undefined
    } } : {}) };
}

/** One committed left-side visit, including split slots; the right is a single opaque visit. */
export function useLeftNavigationHistory(options: Options) {
  const split = useCenterSplit();
  const history = usePanelHistory();
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const current = snapshot(options.page, options.primary, split);
  const latest = useRef({ options, current, history });
  latest.current = { options, current, history };
  const previous = useRef<{ workspaceId: string; entry: LeftNavigationEntry } | null>(null);
  const replay = useRef<{ workspaceId: string; done: boolean; expected?: LeftNavigationEntry } | null>(null);

  useEffect(() => {
    if (!options.enabled || previous.current?.workspaceId !== options.workspaceId) {
      previous.current = options.enabled ? { workspaceId: options.workspaceId, entry: current } : null;
      replay.current = null;
      return;
    }
    if (split.pendingLayout) return;
    if (replay.current) {
      // Completion can run during a layout effect, before the new App props render.
      if (!replay.current.done || !replay.current.expected ||
          leftNavigationKey(current) !== leftNavigationKey(replay.current.expected)) return;
      replay.current = null;
    } else if (leftNavigationKey(previous.current.entry) !== leftNavigationKey(current) &&
        (previous.current.entry.page === 'git' || previous.current.entry.primary.kind !== 'empty')) {
      history.pushLeft(options.workspaceId, previous.current.entry);
    }
    previous.current = { workspaceId: options.workspaceId, entry: current };
  });

  const navigate = useCallback((dir: -1 | 1): void => {
    const { options: opts, current: from, history: h } = latest.current;
    if (!opts.enabled || (replay.current && !replay.current.done)) return;
    const valid = (entry: LeftNavigationEntry) => entry.page === 'git' || centerSplitCanRestoreHistory(entry.primary);
    const target = (dir === -1 ? h.backLeft : h.forwardLeft)(opts.workspaceId, from, valid);
    if (!target) return;
    const request: NonNullable<typeof replay.current> = { workspaceId: opts.workspaceId, done: false };
    replay.current = request;
    const complete = (result: 'applied' | 'cancelled' | 'failed'): void => {
      if (request.done || replay.current !== request || latest.current.options.workspaceId !== request.workspaceId) return;
      if (result !== 'applied') (dir === -1 ? h.forwardLeft : h.backLeft)(opts.workspaceId, target);
      // Cancellation belongs to a newer user intent: let that visit be recorded.
      if (result === 'cancelled') replay.current = null;
      else {
        if (result === 'failed') opts.showPage(from.page);
        request.expected = result === 'failed' ? from : target.page === 'git' ? target
          : snapshot(target.page, target.primary, getCenterSplitState());
        request.done = true;
      }
      refresh();
    };
    // Replay must not let the pointer left over a peek immediately reverse the page switch.
    opts.showPage(target.page);
    if (target.page === 'git') complete('applied');
    else {
      try { centerSplitRestoreHistory(target.primary, target.split, complete); }
      catch (error) { complete('failed'); throw error; }
    }
  }, []);
  const back = useCallback(() => navigate(-1), [navigate]);
  const forward = useCallback(() => navigate(1), [navigate]);
  return { back, forward };
}

export type LeftNavigationController = ReturnType<typeof useLeftNavigationHistory>;

/** Keep focus/resize/store subscriptions out of the App root and its large panel tree. */
export function LeftNavigationRecorder({ navigationRef, ...options }: Options & {
  navigationRef: MutableRefObject<LeftNavigationController | null>;
}): null {
  const { back, forward } = useLeftNavigationHistory(options);
  useLayoutEffect(() => {
    navigationRef.current = { back, forward };
    return () => { navigationRef.current = null; };
  }, [navigationRef, back, forward]);
  return null;
}
