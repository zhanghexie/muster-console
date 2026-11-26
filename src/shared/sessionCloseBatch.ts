/**
 * sessions.delete 规划：解析 id / 校验已归档 / 整批中止。
 * 确认框与 handler 共用，避免「框里一组、执行另一组」。
 */
import { t } from './i18n';
import { matchFlexibleSessionId, type SessionQueryRow } from './sessionQuery';
import { dimensionGateBadgeLabel, hasRedGate } from './dimensionGates';

export type ConfirmSessionSnapshot = {
  id: string;
  name?: string;
  cwd?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  phase?: string;
  lifecycle?: string;
  lastUsedAt?: number;
  createdAt?: number;
  archived?: boolean;
  type?: string;
  /** R-14 维度门红灯一行摘要（如「维度门未过：多语言」）；无红灯缺省 */
  dimensionGateRed?: string;
};

export type CloseBatchRow = SessionQueryRow & {
  type?: string;
  lastUsedAt?: number;
  createdAt?: number;
  phase?: { value?: string } | string;
  lifecycle?: string;
};

export type CloseBatchFailure = {
  id: string;
  name?: string;
  error: string;
  reason: 'missing' | 'unarchived' | 'scheduled' | 'ambiguous';
  reasonLabel: string;
};

export type CloseBatchPlan = {
  targets: ConfirmSessionSnapshot[];
  failed: CloseBatchFailure[];
};

export function normalizeCloseBatchIds(args: { sessionIds?: unknown }): string[] {
  const raw = Array.isArray(args.sessionIds) ? args.sessionIds : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    const q = String(x ?? '').trim();
    if (!q || seen.has(q)) continue;
    seen.add(q);
    out.push(q);
  }
  return out;
}

/**
 * 会话 → 确认框快照（唯一实现：confirmDialog / closeBatch 共用，勿再各写一份）。
 */
export function sessionToConfirmSnapshot(s: {
  id: string;
  name?: string;
  cwd?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  phase?: { value?: string } | string;
  lifecycle?: string;
  lastUsedAt?: number;
  createdAt?: number;
  archived?: boolean;
  type?: string;
  dimensionGates?: import('./dimensionGates').DimensionGatesSnapshot;
}): ConfirmSessionSnapshot {
  return {
    id: s.id,
    name: s.name,
    cwd: s.cwd,
    worktreePath: s.worktreePath,
    worktreeBranch: s.worktreeBranch,
    phase: typeof s.phase === 'string' ? s.phase : s.phase?.value,
    lifecycle: s.lifecycle,
    lastUsedAt: s.lastUsedAt,
    createdAt: s.createdAt,
    archived: s.archived,
    type: s.type,
    ...(hasRedGate(s.dimensionGates)
      ? { dimensionGateRed: dimensionGateBadgeLabel(s.dimensionGates) }
      : {})
  };
}

export function planCloseBatch(rows: readonly CloseBatchRow[], ids: string[]): CloseBatchPlan {
  const targets: ConfirmSessionSnapshot[] = [];
  const failed: CloseBatchFailure[] = [];
  const seen = new Set<string>();
  for (const ref of ids) {
    const flex = matchFlexibleSessionId(rows, ref);
    if (flex.kind === 'none') {
      failed.push({
        id: ref,
        error: t('会话不存在: {{id}}', { id: ref }),
        reason: 'missing',
        reasonLabel: t('未找到')
      });
      continue;
    }
    if (flex.kind === 'many') {
      failed.push({
        id: ref,
        error: t('会话 id 前缀不唯一: {{id}}（匹配 {{n}} 个）', { id: ref, n: flex.ids.length }),
        reason: 'ambiguous',
        reasonLabel: t('id 不唯一')
      });
      continue;
    }
    if (seen.has(flex.id)) continue;
    seen.add(flex.id);
    const row = rows.find((x) => x.id === flex.id);
    if (!row) {
      failed.push({
        id: ref,
        error: t('会话不存在: {{id}}', { id: ref }),
        reason: 'missing',
        reasonLabel: t('未找到')
      });
      continue;
    }
    if (row.type === 'scheduled') {
      failed.push({
        id: row.id,
        name: row.name,
        error: t('scheduled 会话由服务管理，请使用 automations.delete 删除服务'),
        reason: 'scheduled',
        reasonLabel: t('定时会话')
      });
      continue;
    }
    if (!row.archived) {
      failed.push({
        id: row.id,
        name: row.name,
        error: t('会话尚未归档：请先归档再删除（删除仅对已归档会话开放）'),
        reason: 'unarchived',
        reasonLabel: t('未归档')
      });
      continue;
    }
    targets.push(sessionToConfirmSnapshot(row));
  }
  return { targets, failed };
}
