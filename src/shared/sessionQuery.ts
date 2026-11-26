

export const SHORT_ID_MIN = 8;

export type SessionQueryRow = {
  id: string;
  name?: string;
  archived?: boolean;
  worktreePath?: string;
  cwd?: string;
  externalSessionId?: string;
};

export function normalizeFsPath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** lastUsedAt 缺省回落 createdAt（与 SessionMeta 注释一致） */
export function sessionUsedAt(s: { lastUsedAt?: number; createdAt?: number }): number {
  if (typeof s.lastUsedAt === 'number' && Number.isFinite(s.lastUsedAt)) return s.lastUsedAt;
  if (typeof s.createdAt === 'number' && Number.isFinite(s.createdAt)) return s.createdAt;
  return 0;
}

export type FlexibleMatch =
  | { kind: 'one'; id: string; matchedBy: 'sessionId' | 'externalSessionId' | 'idPrefix' | 'worktreePath' }
  | { kind: 'many'; ids: string[]; matchedBy: 'idPrefix' | 'worktreePath' }
  | { kind: 'none' };

export function matchFlexibleSessionId(
  rows: readonly SessionQueryRow[],
  sid: string
): FlexibleMatch {
  const q = sid.trim();
  if (!q) return { kind: 'none' };

  const byId = rows.find((x) => x.id === q);
  if (byId) return { kind: 'one', id: byId.id, matchedBy: 'sessionId' };
  const byExt = rows.find((x) => x.externalSessionId === q);
  if (byExt) return { kind: 'one', id: byExt.id, matchedBy: 'externalSessionId' };

  const looksPath = /[\\/]/.test(q) || q.length > 24;
  if (looksPath) {
    const nq = normalizeFsPath(q);
    const hits = rows.filter((x) => {
      const wp = x.worktreePath ? normalizeFsPath(String(x.worktreePath)) : '';
      const cwd = x.cwd ? normalizeFsPath(String(x.cwd)) : '';
      return (wp && (wp === nq || wp.endsWith(nq) || nq.endsWith(wp))) || (cwd && cwd === nq);
    });
    if (hits.length === 1) return { kind: 'one', id: hits[0]!.id, matchedBy: 'worktreePath' };
    if (hits.length > 1) return { kind: 'many', ids: hits.map((h) => h.id), matchedBy: 'worktreePath' };
  }

  if (q.length >= SHORT_ID_MIN) {
    const lower = q.toLowerCase();
    const prefixHits = rows.filter(
      (x) =>
        x.id.toLowerCase().startsWith(lower) ||
        (typeof x.externalSessionId === 'string' && x.externalSessionId.toLowerCase().startsWith(lower))
    );
    if (prefixHits.length === 1) return { kind: 'one', id: prefixHits[0]!.id, matchedBy: 'idPrefix' };
    if (prefixHits.length > 1) return { kind: 'many', ids: prefixHits.map((h) => h.id), matchedBy: 'idPrefix' };
  }

  return { kind: 'none' };
}

export function findSessions<T extends SessionQueryRow>(
  rows: readonly T[],
  query: { worktreePath?: string; shortId?: string; name?: string }
): { matches: T[]; matchedBy: string } {
  const wp = query.worktreePath?.trim();
  const shortId = query.shortId?.trim();
  const name = query.name?.trim();
  if (wp) {
    const nq = normalizeFsPath(wp);
    const matches = rows.filter((x) => {
      const p = x.worktreePath ? normalizeFsPath(String(x.worktreePath)) : '';
      const cwd = x.cwd ? normalizeFsPath(String(x.cwd)) : '';
      return (p && (p === nq || p.endsWith(nq) || nq.endsWith(p))) || cwd === nq;
    });
    return { matches, matchedBy: 'worktreePath' };
  }
  if (shortId) {
    const flex = matchFlexibleSessionId(rows, shortId);
    if (flex.kind === 'one') {
      return { matches: rows.filter((r) => r.id === flex.id), matchedBy: flex.matchedBy };
    }
    if (flex.kind === 'many') {
      const set = new Set(flex.ids);
      return { matches: rows.filter((r) => set.has(r.id)), matchedBy: flex.matchedBy };
    }
    return { matches: [], matchedBy: 'shortId' };
  }
  if (name) {
    const q = name.toLowerCase();
    return {
      matches: rows.filter((x) => String(x.name ?? '').toLowerCase().includes(q)),
      matchedBy: 'name'
    };
  }
  return { matches: [], matchedBy: 'none' };
}

/** 活跃 coding worker（占并发位）：与 hasActiveCodingWorkerInRepo 排除项对齐，但不限仓库 */
export function isActiveCodingWorker(s: {
  type?: string;
  launchKind?: string;
  lifecycle?: string;
  archived?: boolean;
  phase?: { value?: string };
  activity?: unknown;
  firstSignalAt?: number;
}): boolean {
  if (s.type !== 'terminal' || s.launchKind === 'shell') return false;
  if (s.archived || s.lifecycle === 'exited') return false;
  // 只计「正在运行」的占用：空闲（idle）、等验收（needs_you）、已完成（done）都不占
  if (s.lifecycle === 'idle') return false;
  if (s.phase?.value === 'done' || s.phase?.value === 'needs_you') return false;
  return true;
}

export function countActiveCodingWorkers(
  sessions: Parameters<typeof isActiveCodingWorker>[0][]
): number {
  return sessions.filter(isActiveCodingWorker).length;
}

/**
 * 0=不限制；缺省/非法 → 50。
 * 上限出于本机性能考虑（同时真正在跑回合的 Worker 数），空闲/等验收/已完成不占额度；
 * 服务商限流（429 等）不由这里硬扛，由调度 Agent 发起前预检、失败时自行降速少发起。
 */
export function resolveMaxConcurrentWorkers(raw: unknown): number {
  if (raw === 0 || raw === '0') return 0;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) return 50;
  return Math.floor(n);
}

export function shouldQueueByCount(active: number, max: number): boolean {
  if (max === 0) return false;
  return active >= max;
}

/** 批量 id：完整 UUID / 短前缀 / worktree；单项失败进 failed，不中断 */
export function resolveQueryIds(
  rows: readonly SessionQueryRow[],
  ids: string[]
): { ok: string[]; failed: string[] } {
  const ok: string[] = [];
  const failed: string[] = [];
  for (const raw of ids) {
    const q = String(raw).trim();
    if (!q) continue;
    const flex = matchFlexibleSessionId(rows, q);
    if (flex.kind === 'one') ok.push(flex.id);
    else failed.push(q);
  }
  return { ok, failed };
}

