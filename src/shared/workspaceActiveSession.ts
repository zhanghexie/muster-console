import { buildSessionTree, flattenSessionTree } from './sessionTree';

/**
 * 工作区 ↔ 选中会话 的纯决策（不碰 process，供 test/*.mjs 直接转译）：
 * - decideAdoptActive：切区后重定 active（adoptActiveForWorkspace 消费）
 * - decideSelectDisplay：select / create(activate) 同区抢中栏 / 异区待显示
 * - resolveCenterActiveId：渲染层中栏实际该亮的会话（防跨区串台）
 */

export type WorkspaceSessionRow = {
  id: string;
  type?: string;
  archived?: boolean;
  hidden?: boolean;
  pinned?: boolean;
  pinnedAt?: number;
  lastUsedAt?: number;
  createdAt?: number;
  workspaceId?: string;
  cwd?: string;
  launchKind?: string;
  parentSessionId?: string;
};

/** Optional renderer hint captured from the visible rail when the archive was requested. */
export type ArchiveSelectionHint = { activeId: string; nextId: string };

export type AdoptActiveDecision = {
  activeId: string | null;
  remember: { workspaceId: string; sessionId: string } | null;
};

/**
 * select / create(activate) 的中栏显示决策：
 * - skip：hidden 或 activate=false，不改选中、不记待显示
 * - pending：目标会话属于另一工作区 → 不抢当前中栏，记入该区待显示
 * - show：同区（或无法判定归属）→ 可以抢中栏
 */
export type SelectDisplayDecision =
  | { kind: 'show' }
  | { kind: 'pending'; workspaceId: string }
  | { kind: 'skip' };

export function decideSelectDisplay(input: {
  sessionWorkspaceId?: string | null;
  activeWorkspaceId?: string | null;
  hidden?: boolean;
  /** 缺省 true（select 意图就是要显示） */
  activate?: boolean;
}): SelectDisplayDecision {
  if (input.hidden || input.activate === false) return { kind: 'skip' };
  const sessionWs = input.sessionWorkspaceId?.trim() || '';
  const activeWs = input.activeWorkspaceId?.trim() || '';
  if (sessionWs && activeWs && sessionWs !== activeWs) {
    return { kind: 'pending', workspaceId: sessionWs };
  }
  return { kind: 'show' };
}

/**
 * 中栏实际该亮的会话：activeId 必须属于当前活动工作区。
 * 跨区串台时（activeId 落在别的区）视为未选中，避免画面抢到当前区中栏。
 * activeWorkspaceId 尚未就绪时不拦截（启动瞬间避免空白闪一下）。
 */
export function resolveCenterActiveId(
  rows: readonly { id: string; workspaceId?: string }[],
  activeId: string | null,
  activeWorkspaceId: string | null
): string | null {
  if (!activeId) return null;
  const s = rows.find((r) => r.id === activeId);
  if (!s) return null;
  if (activeWorkspaceId && (s.workspaceId ?? '') !== activeWorkspaceId) return null;
  return activeId;
}

/** 左栏排序（与 LeftPanel.sortSessions 同语义）：置顶优先，同组内 pinnedAt / lastUsedAt（缺省 createdAt）新的在上 */
export function compareSessionsByRail(
  a: WorkspaceSessionRow,
  b: WorkspaceSessionRow
): number {
  const ap = a.pinned ? 1 : 0;
  const bp = b.pinned ? 1 : 0;
  if (ap !== bp) return bp - ap;
  if (ap && bp) return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
  return (b.lastUsedAt ?? b.createdAt ?? 0) - (a.lastUsedAt ?? a.createdAt ?? 0);
}

/** Choose the next remaining row, or the nearest previous row at the end of the list. */
export function adjacentSessionId(
  orderedIds: readonly string[],
  activeId: string,
  excludedIds: ReadonlySet<string>
): string | null {
  const index = orderedIds.indexOf(activeId);
  if (index < 0) return null;
  for (let i = index + 1; i < orderedIds.length; i++) {
    if (!excludedIds.has(orderedIds[i]!)) return orderedIds[i]!;
  }
  for (let i = index - 1; i >= 0; i--) {
    if (!excludedIds.has(orderedIds[i]!)) return orderedIds[i]!;
  }
  return null;
}

/** Unfiltered left-rail order: the work-session tree first, then the shell list. */
export function sessionIdsByRail(rows: readonly WorkspaceSessionRow[]): string[] {
  const candidates = rows.filter(row => row.type === 'terminal' && !row.archived && !row.hidden);
  const agents = candidates.filter(row => row.launchKind !== 'shell').sort(compareSessionsByRail);
  const shells = candidates.filter(row => row.launchKind === 'shell').sort(compareSessionsByRail);
  return [
    ...flattenSessionTree(buildSessionTree(agents)).map(row => row.session.id),
    ...shells.map(row => row.id)
  ];
}

/**
 * session-model F-02：「兜底选第一个」按左栏排序（compareSessionsByRail）取最上一行
 * terminal（与 adoptActiveForWorkspace 的 fallback 同语义），无候选返回 null。
 * listForAgent 的 activeId 兜底用它替换原来的列表序 find——否则调度/模型看到的
 * 「当前会话」可能与用户左栏第一行不同。
 */
export function railFirstTerminalId(
  rows: readonly WorkspaceSessionRow[]
): string | null {
  const candidates = rows.filter(
    (r) => r.type === 'terminal' && !r.archived && !r.hidden
  );
  return [...candidates].sort(compareSessionsByRail)[0]?.id ?? null;
}

/**
 * @param rows 会话全表（含 hidden 行，函数内自行排除）
 * @param resolveWorkspaceId 无 workspaceId 时按 cwd 归区（SessionsService 的同名方法）
 */
export function decideAdoptActive(
  rows: readonly WorkspaceSessionRow[],
  activeId: string | null,
  targetWorkspaceId: string,
  remembered: ReadonlyMap<string, string>,
  resolveWorkspaceId: (cwd?: string) => string
): AdoptActiveDecision {
  const wsOf = (r: WorkspaceSessionRow): string | null =>
    r.workspaceId ?? (r.cwd ? resolveWorkspaceId(r.cwd) : null);
  const cur = activeId ? rows.find((r) => r.id === activeId) : undefined;
  const curWs = cur ? wsOf(cur) : null;
  if (cur && curWs === targetWorkspaceId) {
    return { activeId: cur.id, remember: null };
  }
  const remember =
    cur && curWs && curWs !== targetWorkspaceId
      ? { workspaceId: curWs, sessionId: cur.id }
      : null;
  const memoId = remembered.get(targetWorkspaceId);
  const restored = memoId
    ? rows.find(
        (r) => r.id === memoId && !r.hidden && !r.archived && wsOf(r) === targetWorkspaceId
      )
    : undefined;
  const candidates = rows.filter(
    (r) =>
      r.type === 'terminal' && !r.archived && !r.hidden && wsOf(r) === targetWorkspaceId
  );
  const fallback = [...candidates].sort(compareSessionsByRail)[0];
  return { activeId: restored?.id ?? fallback?.id ?? null, remember };
}
