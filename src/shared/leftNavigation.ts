import type { CenterPaneSlot, CenterSnapLayoutId, SplitDir, SplitPaneRef } from './centerSplit';

/** Only left content belongs here. A visit to the right has no resource identity. */
export type LeftNavigationEntry =
  | { page: 'git' }
  | { page: 'terminal'; primary: SplitPaneRef; split?: LeftNavigationSplit };

export interface LeftNavigationSplit {
  secondary: SplitPaneRef;
  tertiary?: SplitPaneRef;
  layoutId?: CenterSnapLayoutId;
  order?: number[];
  dir: SplitDir;
  ratio: number;
  ratios?: [number, number];
  focused: CenterPaneSlot;
}

/** Focus and resize update the current snapshot without creating navigation steps. */
export function leftNavigationKey(entry: LeftNavigationEntry): string {
  if (entry.page === 'git') return 'right';
  const refKey = (ref: SplitPaneRef) => ref.kind === 'session' ? ['session', ref.sessionId]
    : ref.kind === 'utility' ? ['utility', ref.sel] : ['empty'];
  const split = entry.split;
  return JSON.stringify([refKey(entry.primary), split ? [refKey(split.secondary),
    split.tertiary ? refKey(split.tertiary) : null, split.layoutId, split.order, split.dir] : null]);
}
