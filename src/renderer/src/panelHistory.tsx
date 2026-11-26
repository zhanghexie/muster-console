import React, {
  createContext,
  useCallback,
  useContext,
  useReducer,
  useRef
} from 'react';
import type { SideToolsTab } from './components/SideToolsSwitcher';
import { useWorkspaceStore } from './store';
import { t } from '../../shared/i18n';
import { PanelHistoryCore } from '../../shared/panelHistoryCore';
import { leftNavigationKey, type LeftNavigationEntry } from '../../shared/leftNavigation';
import { resolveWorkspaceId } from '../../shared/workspaceFallback';

/** Left navigation snapshots and legacy right-axis history, scoped to each workspace.
 * The production right workspace owns its independent content history. */
export type LeftHistoryEntry = LeftNavigationEntry;
export type LeftHistoryCurrent = LeftNavigationEntry;

/** 右侧时间线条目：Files↔Git 页切换 / 仓库选中切换 / 打开文件切换 */
export type RightHistoryEntry =
  | { kind: 'tab'; tab: SideToolsTab }
  | { kind: 'repo'; path: string }
  | { kind: 'file'; path: string; external: boolean; fileRef?: import('../../shared/types').WorkspaceFileRef };

/** 右侧各轴的当前值 */
export type RightHistoryCurrent = {
  tab: SideToolsTab;
  /** 当前选中仓库绝对路径（无则 null） */
  repo: string | null;
  /** 当前打开的文件（无打开文件/目录视图时 null） */
  file: { path: string; external: boolean; fileRef?: import('../../shared/types').WorkspaceFileRef } | null;
};

/** 条目比较键：条目对象每次新建，去重必须按值（同轴同值 = 同一条目） */
const rightEntryKey = (e: RightHistoryEntry): string =>
  e.kind === 'tab'
    ? `t:${e.tab}`
    : e.kind === 'repo'
      ? `r:${e.path}`
      : `f:${e.external ? 'x' : 'w'}:${JSON.stringify([e.fileRef?.workspaceId, e.fileRef?.rootId, e.path])}`;

/**
 * 旧右轴夹具的返回/前进「回放」引起的状态变化不记成新历史：时间窗抑制。
 * 回放的 push 都发生在点击后的一两个 commit 内（含 selectTab await flush 之后再
 * push 的异步路径）；窗内多次 push 全吞——repo 回放「先切 Git 页再选仓」的双 push
 * 由此一并覆盖；窗口自然过期，no-op 回放也不会残留标记吞掉下一次真实导航。
 */
const REPLAY_SUPPRESS_MS = 250;

type PanelHistoryValue = {
  /** 指定工作区左侧可返回/可前进步数 */
  leftBackDepth: (wsId: string) => number;
  leftForwardDepth: (wsId: string) => number;
  /** 指定工作区右侧可返回/可前进步数 */
  rightBackDepth: (wsId: string) => number;
  rightForwardDepth: (wsId: string) => number;
  /**
   * 左侧完整导航快照入栈；回放由 useLeftNavigationHistory 的确认状态隔离，不使用时间窗。
   */
  pushLeft: (wsId: string, entry: LeftHistoryEntry) => void;
  /** 返回：当前快照入前进栈、弹返回栈顶；返回栈空返回 undefined */
  backLeft: (wsId: string, current: LeftHistoryCurrent, valid?: (entry: LeftHistoryEntry) => boolean) => LeftHistoryEntry | undefined;
  /** 前进：当前快照入返回栈、弹前进栈顶；前进栈空返回 undefined */
  forwardLeft: (wsId: string, current: LeftHistoryCurrent, valid?: (entry: LeftHistoryEntry) => boolean) => LeftHistoryEntry | undefined;
  /**
   * 右侧任一轴（Files↔Git 页 / 仓库选中）切换后入栈（按工作区），并清空该区前进栈。
   * backRight/forwardRight 同样开启短暂抑制窗（吞掉回放触发的 push）。
   */
  pushRight: (wsId: string, entry: RightHistoryEntry) => void;
  /** 返回：当前快照入前进栈、弹返回栈顶；返回栈空返回 undefined */
  backRight: (wsId: string, current: RightHistoryCurrent) => RightHistoryEntry | undefined;
  /** 前进：当前快照入返回栈、弹前进栈顶；前进栈空返回 undefined */
  forwardRight: (wsId: string, current: RightHistoryCurrent) => RightHistoryEntry | undefined;
};

const PanelHistoryContext = createContext<PanelHistoryValue | null>(null);

/** 面板历史绑定的 workspaceId（左右栈都按工作区独立；无激活工作区时退首区） */
export function useHistoryWsId(): string {
  const { activeWorkspaceId, workspaces } = useWorkspaceStore();
  return resolveWorkspaceId(activeWorkspaceId, workspaces);
}

export function PanelHistoryProvider({
  children
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const leftRef = useRef<Record<string, PanelHistoryCore<LeftHistoryEntry>>>({});
  const rightRef = useRef<Record<string, PanelHistoryCore<RightHistoryEntry>>>({});
  /** backRight/forwardRight 开启的抑制窗截止时刻 */
  const suppressRightUntilRef = useRef(0);
  const [, bump] = useReducer((c: number) => c + 1, 0);

  const leftOf = useCallback(
    (wsId: string): PanelHistoryCore<LeftHistoryEntry> => {
      let core = leftRef.current[wsId];
      if (!core) {
        core = new PanelHistoryCore<LeftHistoryEntry>(leftNavigationKey);
        leftRef.current = { ...leftRef.current, [wsId]: core };
      }
      return core;
    },
    []
  );

  const rightOf = useCallback((wsId: string): PanelHistoryCore<RightHistoryEntry> => {
    let core = rightRef.current[wsId];
    if (!core) {
      core = new PanelHistoryCore<RightHistoryEntry>(rightEntryKey);
      rightRef.current = { ...rightRef.current, [wsId]: core };
    }
    return core;
  }, []);

  /** 右侧按目标条目的轴，取当前态的同轴条目（返回/前进时倒进对向栈）；
   *  file 轴无打开文件时用空路径占位（回放侧跳过） */
  const sameAxisRightEntry = useCallback(
    (axis: 'tab' | 'repo' | 'file', current: RightHistoryCurrent): RightHistoryEntry =>
      axis === 'tab'
        ? { kind: 'tab', tab: current.tab }
        : axis === 'repo'
          ? { kind: 'repo', path: current.repo ?? '' }
          : { kind: 'file', path: current.file?.path ?? '', external: current.file?.external ?? false, fileRef: current.file?.fileRef },
    []
  );

  const pushLeft = useCallback(
    (wsId: string, entry: LeftHistoryEntry): void => {
      if (leftOf(wsId).push(entry)) bump();
    },
    [leftOf]
  );

  const backLeft = useCallback(
    (wsId: string, current: LeftHistoryCurrent, valid: (entry: LeftHistoryEntry) => boolean = () => true): LeftHistoryEntry | undefined => {
      const core = leftOf(wsId);
      while (core.back.length && !valid(core.back[core.back.length - 1])) core.back.pop();
      const target = core.goBack(current);
      bump();
      return target;
    },
    [leftOf]
  );

  const forwardLeft = useCallback(
    (wsId: string, current: LeftHistoryCurrent, valid: (entry: LeftHistoryEntry) => boolean = () => true): LeftHistoryEntry | undefined => {
      const core = leftOf(wsId);
      while (core.forward.length && !valid(core.forward[core.forward.length - 1])) core.forward.pop();
      const target = core.goForward(current);
      bump();
      return target;
    },
    [leftOf]
  );

  const pushRight = useCallback((wsId: string, entry: RightHistoryEntry): void => {
    if (Date.now() < suppressRightUntilRef.current) return;
    if (rightOf(wsId).push(entry)) bump();
  }, [rightOf]);

  const backRight = useCallback(
    (wsId: string, current: RightHistoryCurrent): RightHistoryEntry | undefined => {
      const core = rightOf(wsId);
      const top = core.back[core.backDepth - 1];
      if (!top) return undefined;
      const target = core.goBack(sameAxisRightEntry(top.kind, current));
      suppressRightUntilRef.current = Date.now() + REPLAY_SUPPRESS_MS;
      bump();
      return target;
    },
    [rightOf, sameAxisRightEntry]
  );

  const forwardRight = useCallback(
    (wsId: string, current: RightHistoryCurrent): RightHistoryEntry | undefined => {
      const core = rightOf(wsId);
      const top = core.forward[core.forwardDepth - 1];
      if (!top) return undefined;
      const target = core.goForward(sameAxisRightEntry(top.kind, current));
      suppressRightUntilRef.current = Date.now() + REPLAY_SUPPRESS_MS;
      bump();
      return target;
    },
    [rightOf, sameAxisRightEntry]
  );

  const leftBackDepth = useCallback(
    (wsId: string): number => leftRef.current[wsId]?.backDepth ?? 0,
    []
  );
  const leftForwardDepth = useCallback(
    (wsId: string): number => leftRef.current[wsId]?.forwardDepth ?? 0,
    []
  );
  const rightBackDepth = useCallback(
    (wsId: string): number => rightRef.current[wsId]?.backDepth ?? 0,
    []
  );
  const rightForwardDepth = useCallback(
    (wsId: string): number => rightRef.current[wsId]?.forwardDepth ?? 0,
    []
  );

  // 不做 useMemo：栈在 ref 里，深度须在每次 bump 重渲时现读
  const value: PanelHistoryValue = {
    leftBackDepth,
    leftForwardDepth,
    rightBackDepth,
    rightForwardDepth,
    pushLeft,
    backLeft,
    forwardLeft,
    pushRight,
    backRight,
    forwardRight
  };

  return <PanelHistoryContext.Provider value={value}>{children}</PanelHistoryContext.Provider>;
}

export function usePanelHistory(): PanelHistoryValue {
  const ctx = useContext(PanelHistoryContext);
  if (!ctx) throw new Error(t('usePanelHistory 必须在 PanelHistoryProvider 内使用'));
  return ctx;
}
