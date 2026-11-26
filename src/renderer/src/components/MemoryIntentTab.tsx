import { ErrorTip } from './ErrorTip';
/** Active reminder view, without retired review/approval tabs. */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePresence } from './motion';
import type { IntentEventPredicate, MemoryCenterIntentRow } from '../../../shared/memoryCenterIpc';

/** intent 状态 → 展示标签 + 色调（armed=活跃蓝 / fired=已发射 / 终态=灰暗） */
function intentStateMeta(state: MemoryCenterIntentRow['state'], t: (k: string) => string): { label: string; tone: string } {
  switch (state) {
    case 'armed':
      return { label: t('待触发'), tone: 'is-lesson' };
    case 'pending':
      return { label: t('未武装'), tone: 'is-dim' };
    case 'fired':
      return { label: t('已发射'), tone: 'is-other' };
    case 'done':
      return { label: t('已完结'), tone: 'is-dim' };
    case 'cancelled':
      return { label: t('已取消'), tone: 'is-warn' };
    case 'expired':
      return { label: t('已过期'), tone: 'is-dim' };
    default:
      return { label: state, tone: 'is-dim' };
  }
}

/** 冷却剩余 → 人话（<1h 显示分钟，≥1h 显示小时） */
function fmtCooldown(remainMs: number | null, t: (k: string, opts?: Record<string, unknown>) => string): string {
  if (remainMs == null) return t('无');
  if (remainMs <= 0) return t('已解除');
  const minutes = Math.ceil(remainMs / 60_000);
  if (minutes < 60) return t('{{n}} 分钟', { n: minutes });
  const hours = Math.ceil(minutes / 60);
  return t('{{n}} 小时', { n: hours });
}

function fmtDay(ts: number | null): string {
  if (ts == null || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

export function IntentTab(): React.JSX.Element {
  const { t } = useTranslation();
  const [exampleOpen, setExampleOpen] = useState(false);
  const examplePresence = usePresence(exampleOpen);
  const [items, setItems] = useState<MemoryCenterIntentRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await window.api.memoryCenter.intents();
      setItems(r.items);
      setLoadError('');
    } catch (e) {
      setLoadError(String((e as Error)?.message ?? e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (id: number, kind: 'cancel' | 'rearm'): Promise<void> => {
    if (busyId != null) return;
    setBusyId(id);
    try {
      const r = kind === 'cancel' ? await window.api.memoryCenter.intentCancel(id) : await window.api.memoryCenter.intentRearm(id);
      if (!r.ok) setNote(r.error ?? t('操作失败'));
      else setNote(kind === 'cancel' ? t('已取消（持久状态，只有这里的重新武装能恢复）') : t('已重新武装（发射计数与冷却已清零）'));
      await load();
    } catch (e) {
      setNote(String((e as Error)?.message ?? e));
    } finally {
      setBusyId(null);
    }
  };

  if (loadError) return <ErrorTip message={loadError} />;
  if (items === null) return <div className="memory-tab-loading">{t('加载中…')}</div>;
  if (items.length === 0) {
    return (
      <div className="memory-page">
        <div className="memory-inner">
          <div className="ui-empty memory-empty" data-testid="intent-empty">
            <p className="ui-empty-title">{t('还没有主动提醒')}</p>
            <p className="ui-empty-desc">
              {t(
                '对调度说「以后每当…就提醒我」，它就会登记一条：消息里出现关键词或任务事件发生时提醒你，冷却与次数上限防骚扰。'
              )}
            </p>
            <div className="ui-empty-actions"><button type="button" className="ui-btn" data-testid="intent-empty-example" onClick={() => setExampleOpen((v) => !v)}>{exampleOpen ? t('收起例子') : t('看一个例子')}</button></div>
            <div className={`acc${examplePresence.mounted ? ' is-open' : ''}`}><div className="acc-body">{examplePresence.mounted ? <p className="ui-empty-desc">{t('例如：以后每当打包失败，就提醒我先检查网络和缓存。')}</p> : null}</div></div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="memory-page">
    <div className="memory-inner memory-list" data-testid="intent-list">
      {note ? <div className="memory-banner is-info">{note}</div> : null}
      {items.map((it) => {
        const meta = intentStateMeta(it.state, t);
        const terminal = it.state === 'cancelled' || it.state === 'done' || it.state === 'expired';
        return (
          <article key={it.id} className="memory-row intent-card" data-testid={`intent-${it.id}`}>
            <div className="review-card-head">
              <div className="review-card-body">
                <div className="memory-row-title" style={{ whiteSpace: 'normal' }}>
                  {it.description}
                </div>
                <div className="memory-row-meta" style={{ marginTop: 8 }}>
                  <span className={`memory-tag ${meta.tone}`}>{meta.label}</span>
                  {it.keywords.length > 0 ? (
                    <span className="memory-tag is-other" title={t('消息面：用户消息全词命中才触发')}>
                      {t('消息:')} {it.keywords.join(' + ')}
                    </span>
                  ) : null}
                  {it.eventPredicates.map((p, i) => (
                    <span key={i} className="memory-tag is-other" title={t('事件面：任务事件确定性匹配')}>
                      {t('事件:')} {intentPredicateLabel(p, t)}
                    </span>
                  ))}
                </div>
                <div className="memory-card-foot">
                  <span>
                    {t('发射 {{count}}/{{budget}}', { count: it.fireCount, budget: it.fireBudget ?? 3 })} ·{' '}
                    {t('冷却 {{c}}', { c: fmtCooldown(it.cooldownRemainMs, t) })} ·{' '}
                    {it.expiry != null ? t('到期 {{d}}', { d: fmtDay(it.expiry) }) : t('不过期')}
                  </span>
                  <span>{t('登记于 {{d}}', { d: fmtDay(it.createdAt) })}</span>
                </div>
              </div>
              <div className="approval-actions">
                {!terminal ? (
                  <button
                    type="button"
                    className="ui-btn danger compact"
                    disabled={busyId != null}
                    onClick={() => void mutate(it.id, 'cancel')}
                  >
                    {t('取消')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="ui-btn compact"
                  title={t('发射计数清零、冷却解除；已过期的续期 90 天')}
                  disabled={busyId != null}
                  onClick={() => void mutate(it.id, 'rearm')}
                >
                  {t('重新武装')}
                </button>
              </div>
            </div>
          </article>
        );
      })}
    </div>
    </div>
  );
}

/** 事件谓词 → 人话（t() 包原文；与 main 侧通知简述口径独立） */
export function intentPredicateLabel(
  p: IntentEventPredicate,
  t: (k: string, opts?: Record<string, unknown>) => string
): string {
  switch (p.kind) {
    case 'notify_flip':
      return t('会话相位 {{x}}', { x: p.trigger ?? '' });
    case 'merge_blocked':
      return p.branchIncludes ? t('合入受阻（分支含 {{x}}）', { x: p.branchIncludes }) : t('合入受阻');
    case 'pr_merged':
      return p.branchIncludes ? t('PR 已合并（分支含 {{x}}）', { x: p.branchIncludes }) : t('PR 已合并');
    default:
      return p.kind;
  }
}
