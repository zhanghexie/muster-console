/** Active reminder state API; independent of retired approval/consolidation flows. */
import { t } from '../../shared/i18n';
import type {
  MemoryCenterIntentMutateResult,
  MemoryCenterIntentsResult,
  MemoryCenterIntentState,
  MemoryCenterIntentRow
} from '../../shared/memoryCenterIpc';
import type { MemoryDb } from './db';
import { cancelIntent, getIntent, listIntents, rearmIntent, sweepIntentExpiry } from './intents';
import { getMemoryService } from './serviceRef';

function openDb(root: string): MemoryDb {
  const svc = getMemoryService();
  if (!svc) throw new Error(t('记忆服务尚未就绪'));
  return svc.init(root);
}

export function memoryCenterIntents(root: string, now: number = Date.now()): MemoryCenterIntentsResult {
  const db = openDb(root);
  // 读取即搭过期清扫（piggyback，§9 不加定时子系统）；失败静默——读取不抛
  try {
    sweepIntentExpiry(db, now);
  } catch {
    /* ignore */
  }
  const items: MemoryCenterIntentRow[] = listIntents(db).map((i) => {
    const cooldownMs = i.cooldownMs ?? 0;
    const cooldownRemainMs =
      i.lastFiredAt != null ? Math.max(0, cooldownMs - (now - i.lastFiredAt)) : null;
    return {
      id: i.id,
      description: i.description,
      keywords: i.keywords,
      eventPredicates: i.eventPredicates,
      state: i.state as MemoryCenterIntentState,
      fireCount: i.fireCount,
      fireBudget: i.fireBudget,
      cooldownRemainMs,
      expiry: i.expiry,
      lastFiredAt: i.lastFiredAt,
      createdAt: i.createdAt,
      createdBy: i.createdBy
    };
  });
  return { items };
}

/** 手动取消意图（持久终态；永不从对话推断恢复） */
export function memoryCenterCancelIntent(root: string, id: number, now: number = Date.now()): MemoryCenterIntentMutateResult {
  const db = openDb(root);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: t('id 不能为空') };
  if (!getIntent(db, id)) return { ok: false, error: t('意图不存在') };
  cancelIntent(db, id, now);
  return { ok: true };
}

/** 重新武装意图（计数清零/冷却解除；过期续期 90d；cancelled 也可由人显式恢复） */
export function memoryCenterRearmIntent(root: string, id: number, now: number = Date.now()): MemoryCenterIntentMutateResult {
  const db = openDb(root);
  const r = rearmIntent(db, id, now);
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? t('操作失败') };
}
