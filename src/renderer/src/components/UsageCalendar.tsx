import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { addUsageDays } from '../../../shared/usageStats';
import { type Presence } from './motion';

/** 日历选值（日历日口径，端点含入） */
export interface CalendarRange {
  fromKey: string;
  toKey: string;
}

interface Props {
  todayKey: string;
  /** 当前生效范围（作为初始选择） */
  value: CalendarRange;
  presence: Presence;
  /** 触发按钮所在容器：其内的点击不算「外点」，否则 mousedown 先关、click 再开，开关钮失效 */
  anchorRef?: React.RefObject<HTMLElement | null>;
  onApply: (range: CalendarRange) => void;
  onClose: () => void;
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function keyToDate(key: string): Date {
  return new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
}

function dateToKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 单月网格：周一开头，前置补空 */
function monthGrid(year: number, month: number): Array<string | null> {
  const lead = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells: Array<string | null> = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(dateToKey(new Date(year, month, d)));
  return cells;
}

/**
 * 日期范围日历（双月并排）：先点起点再点终点，跨度封顶 366 天、不许未来。
 * 进出场由父级 usePresence 驱动（mp-pop 骨架类）。
 */
export function UsageCalendar({
  todayKey,
  value,
  presence,
  anchorRef,
  onApply,
  onClose
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);

  const [anchor, setAnchor] = useState(() => {
    const base = DAY_KEY_RE.test(value.fromKey) ? keyToDate(value.fromKey) : keyToDate(todayKey);
    return { y: base.getFullYear(), m: base.getMonth() };
  });
  /** toKey 为空串表示只选了起点 */
  const [sel, setSel] = useState<CalendarRange>({ fromKey: value.fromKey, toKey: value.toKey });

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (rootRef.current && rootRef.current.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose]);

  const months = useMemo(
    () => [
      anchor,
      { y: anchor.m === 11 ? anchor.y + 1 : anchor.y, m: (anchor.m + 1) % 12 }
    ],
    [anchor]
  );

  const today = keyToDate(todayKey);
  const curMonth = { y: today.getFullYear(), m: today.getMonth() };
  const rightMonth = months[1];
  /** 右月已到当前月则不能再往后翻 */
  const canNext = rightMonth.y < curMonth.y || (rightMonth.y === curMonth.y && rightMonth.m < curMonth.m);

  /** 只在「已选起点、等终点」时用跨度帽；两端都有后不再禁，以便直接点新起点 */
  const awaitingEnd = Boolean(sel.fromKey && !sel.toKey);
  const capEnd = awaitingEnd && DAY_KEY_RE.test(sel.fromKey) ? addUsageDays(sel.fromKey, 365) : '';

  const clickDay = (key: string): void => {
    if (key > todayKey) return;
    if (!sel.fromKey || sel.toKey) {
      setSel({ fromKey: key, toKey: '' });
      return;
    }
    // 超出跨度帽：当作新起点，而不是禁用（否则过早起点会把今天也点不了）
    if (capEnd && key > capEnd) {
      setSel({ fromKey: key, toKey: '' });
      return;
    }
    if (key >= sel.fromKey) setSel({ fromKey: sel.fromKey, toKey: key });
    else setSel({ fromKey: key, toKey: '' });
  };

  const shiftMonth = (delta: number): void => {
    setAnchor((a) => {
      const d = new Date(a.y, a.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  };

  const ready = Boolean(sel.fromKey && sel.toKey);
  const weekDays = [t('周一'), t('周二'), t('周三'), t('周四'), t('周五'), t('周六'), t('周日')];

  return (
    <div
      ref={rootRef}
      className="usage-cal mp-pop"
      {...presence.spread}
      role="dialog"
      aria-modal="true"
      aria-label={t('选择日期范围')}
    >
      <div className="usage-cal-head">
        <button
          type="button"
          className="usage-cal-nav"
          onClick={() => shiftMonth(-1)}
          aria-label={t('上一个月')}
        >
          ‹
        </button>
        <span className="usage-cal-title">
          {t('{{y}}年{{m}}月', { y: months[0].y, m: months[0].m + 1 })} –{' '}
          {t('{{y}}年{{m}}月', { y: months[1].y, m: months[1].m + 1 })}
        </span>
        <button
          type="button"
          className="usage-cal-nav"
          onClick={() => shiftMonth(1)}
          disabled={!canNext}
          aria-label={t('下一个月')}
        >
          ›
        </button>
      </div>
      <div className="usage-cal-months">
        {months.map((mo) => (
          <div key={`${mo.y}-${mo.m}`} className="usage-cal-month">
            <div className="usage-cal-grid usage-cal-dow">
              {weekDays.map((d) => (
                <span key={d}>{d}</span>
              ))}
            </div>
            <div className="usage-cal-grid">
              {monthGrid(mo.y, mo.m).map((key, i) => {
                if (!key) return <span key={`blank-${i}`} className="usage-cal-day is-blank" aria-hidden />;
                const disabled = key > todayKey;
                const inRange = ready && key >= sel.fromKey && key <= sel.toKey;
                const isEdge = key === sel.fromKey || key === sel.toKey;
                const cls =
                  'usage-cal-day' +
                  (disabled ? ' is-disabled' : '') +
                  (inRange && !isEdge ? ' is-in' : '') +
                  (isEdge && !disabled ? ' is-edge' : '') +
                  (key === sel.fromKey && !sel.toKey ? ' is-pending' : '') +
                  (key === todayKey ? ' is-today' : '');
                return (
                  <button
                    key={key}
                    type="button"
                    className={cls}
                    disabled={disabled}
                    aria-label={key}
                    onClick={() => clickDay(key)}
                  >
                    {Number(key.slice(8, 10))}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="usage-cal-foot">
        <span className="usage-cal-sel">
          {ready
            ? t('{{from}} ~ {{to}}', { from: sel.fromKey, to: sel.toKey })
            : sel.fromKey
              ? t('已选 {{from}}，再选结束日期', { from: sel.fromKey })
              : t('选择开始日期')}
        </span>
        <div className="usage-cal-actions">
          <button type="button" className="ui-btn" onClick={() => setSel({ fromKey: '', toKey: '' })}>
            {t('清除')}
          </button>
          <button
            type="button"
            className="ui-btn primary"
            disabled={!ready}
            onClick={() => {
              if (!ready) return;
              onApply({ fromKey: sel.fromKey, toKey: sel.toKey });
              onClose();
            }}
          >
            {t('应用范围')}
          </button>
        </div>
      </div>
    </div>
  );
}
