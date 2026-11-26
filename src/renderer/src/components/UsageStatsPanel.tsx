import { ErrorTip, ErrorTipDetails } from './ErrorTip';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  USAGE_LLM_PAGE_MAX,
  USAGE_PAGE_DEFAULT,
  addUsageDays,
  rankToolCalls,
  sumCounts,
  usageDayKey,
  type UsageDay,
  type UsageLlmCall,
  type UsageSummary
} from '../../../shared/usageStats';
import { useWorkspaceStore } from '../store';
import { MOTION, usePresence } from './motion';
import { UsageCalendar, type CalendarRange } from './UsageCalendar';

const REFRESH_MS = 15_000;
/** 趋势条超过该天数改按周聚合 */
const DAILY_TREND_MAX = 14;
/** 能力趋势图最多展示的工具数 */
const TOOL_TREND_TOP = 8;

type RangeMode = 'today' | 'week' | 'month' | 'custom';
type ToolView = 'rank' | 'trend' | 'fail';

function fmtDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const msR = Math.round(ms);
  if (msR < 1000) return `${msR}ms`;
  const s = Math.round(msR / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return rest > 0 ? `${m}m ${rest}s` : `${m}m`;
  return `${rest}s`;
}

function fmtTime(ts: number, todayKey: string): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (usageDayKey(ts) === todayKey) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/** 「M/D」短日签；跨年时带年，避免自定义档 1/5~1/5 */
function shortDate(key: string, withYear = false): string {
  const m = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return key;
  const md = `${Number(m[2])}/${Number(m[3])}`;
  return withYear ? `${m[1]}/${md}` : md;
}

function rangeChipLabel(fromKey: string, toKey: string): string {
  const crossYear = fromKey.slice(0, 4) !== toKey.slice(0, 4);
  return `${shortDate(fromKey, crossYear)}~${shortDate(toKey, crossYear)}`;
}

type TrendPt = { date: string; value: number; hot: boolean };
type TrendPt2 = { date: string; a: number; b: number; hot: boolean };

/** 趋势点：≤14 天按日，更长按周聚合（标签取每周首日；含 today 的块高亮） */
function trendPoints(
  rangeDays: Array<{ date: string; day: UsageDay }>,
  pick: (day: UsageDay) => number,
  todayKey: string
): TrendPt[] {
  const daily = rangeDays.map((r) => ({
    date: r.date,
    value: pick(r.day),
    hot: r.date === todayKey
  }));
  if (daily.length <= DAILY_TREND_MAX) return daily;
  const weeks: TrendPt[] = [];
  for (let i = 0; i < daily.length; i += 7) {
    const chunk = daily.slice(i, i + 7);
    weeks.push({
      date: chunk[0].date,
      value: chunk.reduce((s, c) => s + c.value, 0),
      hot: chunk.some((c) => c.hot)
    });
  }
  return weeks;
}

/** 双序列趋势点（≤14 天按日，更长按周聚合，标签取每周首日） */
function trendPoints2(
  rangeDays: Array<{ date: string; day: UsageDay }>,
  pickA: (day: UsageDay) => number,
  pickB: (day: UsageDay) => number,
  todayKey: string
): TrendPt2[] {
  if (rangeDays.length <= DAILY_TREND_MAX) {
    return rangeDays.map((r) => ({
      date: r.date,
      a: pickA(r.day),
      b: pickB(r.day),
      hot: r.date === todayKey
    }));
  }
  const out: TrendPt2[] = [];
  for (let i = 0; i < rangeDays.length; i += 7) {
    const chunk = rangeDays.slice(i, i + 7);
    out.push({
      date: chunk[0].date,
      a: chunk.reduce((s, c) => s + pickA(c.day), 0),
      b: chunk.reduce((s, c) => s + pickB(c.day), 0),
      hot: chunk.some((c) => c.date === todayKey)
    });
  }
  return out;
}

/** 环比：上一等长同期存在给百分比，否则视为新增；两者皆零不值得展示 */
function deltaOf(
  cur: number,
  prev: number
): { kind: 'pct'; pct: number } | { kind: 'new' } | null {
  if (prev > 0) return { kind: 'pct', pct: Math.round(((cur - prev) / prev) * 100) };
  if (cur > 0) return { kind: 'new' };
  return null;
}

/** 中性迷你趋势条（纯 div，今天亮一档） */
function MiniBars({
  points,
  ariaLabel
}: {
  points: TrendPt[];
  ariaLabel: string;
}): React.JSX.Element {
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <div className="usage-spark" role="img" aria-label={ariaLabel}>
      {points.map((p) => (
        <span
          key={p.date}
          className={`usage-spark-bar${p.hot ? ' is-today' : ''}${p.value === 0 ? ' is-zero' : ''}`}
          style={{ height: `${Math.max(8, Math.round((p.value / max) * 100))}%` }}
          title={`${shortDate(p.date)} · ${p.value}`}
        />
      ))}
    </div>
  );
}

/** 双序列堆叠趋势条（工作面板 / 终端） */
function StackBars({
  points,
  ariaLabel
}: {
  points: TrendPt2[];
  ariaLabel: string;
}): React.JSX.Element {
  const max = Math.max(1, ...points.map((p) => p.a + p.b));
  return (
    <div className="usage-stack" role="img" aria-label={ariaLabel}>
      {points.map((p) => (
        <span
          key={p.date}
          className={`usage-stack-col${p.hot ? ' is-today' : ''}`}
          title={`${shortDate(p.date)} · ${p.a}/${p.b}`}
        >
          <i className="usage-stack-a" style={{ height: `${Math.round((p.a / max) * 100)}%` }} />
          <i className="usage-stack-b" style={{ height: `${Math.round((p.b / max) * 100)}%` }} />
        </span>
      ))}
    </div>
  );
}

/** 单工具折线（SVG polyline，中性色；单点画圆，避免今日范围看不见线） */
function ToolSpark({ points }: { points: Array<{ date: string; value: number }> }): React.JSX.Element {
  const max = Math.max(1, ...points.map((p) => p.value));
  const w = 132;
  const h = 26;
  if (points.length <= 1) {
    const y = h - 2 - ((points[0]?.value ?? 0) / max) * (h - 4);
    return (
      <svg className="usage-tool-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
        <circle cx={w / 2} cy={y} r="2.5" fill="currentColor" />
      </svg>
    );
  }
  const step = w / (points.length - 1);
  const coords = points.map(
    (p, i) => `${(i * step).toFixed(1)},${(h - 2 - (p.value / max) * (h - 4)).toFixed(1)}`
  );
  return (
    <svg className="usage-tool-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline
        points={coords.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 细节区切换的「挂载即入场」（mp-pop 骨架，仅入场；轮播为单向换页） */
function DetailEnter({ children }: { children: React.ReactNode }): React.JSX.Element {
  const presence = usePresence(true, MOTION.exitMs);
  return (
    <div className="usage-detail mp-pop" {...presence.spread}>
      {children}
    </div>
  );
}

function OverviewCard({
  label,
  value,
  sub,
  subTone,
  points,
  delta,
  tip,
  selected,
  onClick
}: {
  label: string;
  value: number;
  sub: string;
  subTone?: 'error';
  points: TrendPt[];
  delta: ReturnType<typeof deltaOf>;
  tip?: string;
  selected: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={`usage-card${selected ? ' is-selected' : ''}`}
      onClick={onClick}
      title={tip}
      aria-pressed={selected}
    >
      <div className="usage-card-top">
        <div className="usage-card-meta">
          <div className="usage-card-label">{label}</div>
          <div className="usage-card-value">{value}</div>
        </div>
        <MiniBars points={points} ariaLabel={t('{{label}}趋势', { label })} />
      </div>
      <div className={`usage-card-sub${subTone === 'error' ? ' is-error' : ''}`}>{sub}</div>
      {delta ? (
        <div className={`usage-card-delta is-${delta.kind}`}>
          {delta.kind === 'new'
            ? t('较上一同期无数据')
            : t('较上一同期 {{p}}', {
                p: `${delta.pct > 0 ? '+' : ''}${delta.pct}%`
              })}
        </div>
      ) : null}
    </button>
  );
}

function quickRange(mode: RangeMode, todayKey: string): CalendarRange {
  if (mode === 'week') return { fromKey: addUsageDays(todayKey, -6), toKey: todayKey };
  if (mode === 'month') return { fromKey: addUsageDays(todayKey, -29), toKey: todayKey };
  return { fromKey: todayKey, toKey: todayKey };
}

export function UsageStatsPanel(): React.JSX.Element {
  const { t } = useTranslation();
  const { workspaces } = useWorkspaceStore();

  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState('');
  const [rangeMode, setRangeMode] = useState<RangeMode>('today');
  const [customRange, setCustomRange] = useState<CalendarRange | null>(null);
  const [calOpen, setCalOpen] = useState(false);
  const calPresence = usePresence(calOpen, MOTION.menuMs);

  const [selected, setSelected] = useState(0);
  const [failureLimit, setFailureLimit] = useState(50);
  const [toolView, setToolView] = useState<ToolView>('rank');
  const [llmLimit, setLlmLimit] = useState(USAGE_PAGE_DEFAULT);
  const [llmOpenId, setLlmOpenId] = useState<string | null>(null);
  const [llmDetail, setLlmDetail] = useState<UsageLlmCall | null>(null);
  const [llmDetailLoading, setLlmDetailLoading] = useState(false);
  /** llm 明细请求序号：并发点击时旧响应不得写入新展开区 */
  const llmReqSeq = useRef(0);
  /** summary 请求序号：快切范围/加载更多时旧响应不得盖新数据 */
  const summaryReqSeq = useRef(0);
  const rangeWrapRef = useRef<HTMLDivElement | null>(null);

  const todayKey = summary?.todayKey ?? usageDayKey(Date.now());
  const range = useMemo<CalendarRange>(
    () => (rangeMode === 'custom' && customRange ? customRange : quickRange(rangeMode, todayKey)),
    [rangeMode, customRange, todayKey]
  );

  const refresh = useCallback(async () => {
    const req = (summaryReqSeq.current += 1);
    try {
      const next = await window.api.usage.summary({
        fromKey: range.fromKey,
        toKey: range.toKey,
        llmLimit
      });
      if (summaryReqSeq.current !== req) return;
      setSummary(next);
      setError('');
    } catch (e) {
      if (summaryReqSeq.current !== req) return;
      setError((e as Error).message);
    }
  }, [range.fromKey, range.toKey, llmLimit]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const selectDetail = useCallback((i: number) => setSelected(i), []);

  const resetRangeLists = useCallback(() => {
    setFailureLimit(50);
    setLlmLimit(USAGE_PAGE_DEFAULT);
    setLlmOpenId(null);
    setLlmDetail(null);
  }, []);

  const applyRangeMode = useCallback(
    (mode: RangeMode) => {
      setRangeMode(mode);
      resetRangeLists();
      setCalOpen(false);
    },
    [resetRangeLists]
  );

  const applyCustom = useCallback(
    (r: CalendarRange) => {
      setCustomRange(r);
      setRangeMode('custom');
      resetRangeLists();
    },
    [resetRangeLists]
  );

  const openLlmDetail = useCallback(
    async (id: string) => {
      if (llmOpenId === id) {
        llmReqSeq.current += 1;
        setLlmOpenId(null);
        setLlmDetail(null);
        setLlmDetailLoading(false);
        return;
      }
      const req = (llmReqSeq.current += 1);
      setLlmOpenId(id);
      setLlmDetail(null);
      setLlmDetailLoading(true);
      try {
        const detail = await window.api.usage.llmCall(id);
        if (llmReqSeq.current === req) setLlmDetail(detail);
      } catch {
        if (llmReqSeq.current === req) setLlmDetail(null);
      } finally {
        if (llmReqSeq.current === req) setLlmDetailLoading(false);
      }
    },
    [llmOpenId]
  );

  const total = summary?.rangeTotal ?? null;
  const prev = summary?.prevTotal ?? null;
  const rangeDays = summary?.rangeDays ?? [];
  const points = useCallback(
    (pick: (day: UsageDay) => number): TrendPt[] => trendPoints(rangeDays, pick, todayKey),
    [rangeDays, todayKey]
  );

  // ---- 四张概览卡 ----
  const sessionsTotal = total ? total.agentSessions + total.shellSessions : 0;
  const toolCallsTotal = total ? sumCounts(total.toolCalls) : 0;
  const toolErrorsTotal = total ? sumCounts(total.toolErrors) : 0;
  const activeRows = Object.entries(total?.activeSessions ?? {}).sort((a, b) => b[1].lastActiveAt - a[1].lastActiveAt);
  const activeTotal = activeRows.length;

  const cardDefs = useMemo(() => {
    if (!total) return [];
    return [
      {
        label: t('新建会话'),
        value: sessionsTotal,
        sub:
          sessionsTotal > 0
            ? t('工作面板 {{agent}} · 终端 {{shell}}', {
                agent: total.agentSessions,
                shell: total.shellSessions
              })
            : t('范围内没有新建会话'),
        subTone: undefined as 'error' | undefined,
        delta: deltaOf(sessionsTotal, prev ? prev.agentSessions + prev.shellSessions : 0),
        points: points((d) => d.agentSessions + d.shellSessions),
        tip: t('发起即计（含拉起失败）')
      },
      {
        label: t('活跃会话'),
        value: activeTotal,
        sub: t('范围内发起过交互的会话，按会话去重'),
        subTone: undefined,
        delta: null,
        points: points((d) => Object.keys(d.activeSessions ?? {}).length),
        tip: t('工作面板发送、终端提交输入或调度发起回合；跨日同一会话只计一次')
      },
      {
        label: t('能力调用'),
        value: toolCallsTotal,
        sub:
          toolCallsTotal === 0
            ? t('范围内没有能力调用')
            : toolErrorsTotal > 0
              ? t('失败 {{n}} 次（{{p}}%）', {
                  n: toolErrorsTotal,
                  p: Math.round((toolErrorsTotal / toolCallsTotal) * 100)
                })
              : t('全部成功'),
        subTone: toolErrorsTotal > 0 ? ('error' as const) : undefined,
        delta: deltaOf(toolCallsTotal, prev ? sumCounts(prev.toolCalls) : 0),
        points: points((d) => sumCounts(d.toolCalls)),
        tip: t('宿主能力调用（Worker 引擎原生工具不计入）')
      },
      {
        label: t('扩展 LLM'),
        value: total.extLlmCalls,
        sub:
          total.extLlmCalls === 0
            ? t('范围内没有调用')
            : total.extLlmErrors > 0
              ? t('失败 {{n}} 次', { n: total.extLlmErrors })
              : 'ma.llm.chat',
        subTone: total.extLlmErrors > 0 ? ('error' as const) : undefined,
        delta: deltaOf(total.extLlmCalls, prev?.extLlmCalls ?? 0),
        points: points((d) => d.extLlmCalls),
        tip: t('扩展面板 ma.llm.chat 调用')
      }
    ];
  }, [total, prev, sessionsTotal, toolCallsTotal, toolErrorsTotal, activeTotal, points, t]);

  // ---- 细节区派生数据 ----
  const runtimeRows = useMemo(() => {
    if (!total) return [] as Array<[string, number]>;
    return Object.entries(total.sessionsByRuntime).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [total]);
  const runtimeMax = Math.max(1, ...runtimeRows.map(([, v]) => v));

  const toolRankRows = useMemo(() => (total ? rankToolCalls(total, 20) : []), [total]);
  const toolRankMax = Math.max(1, ...toolRankRows.map((r) => r.count));
  const toolTrendRows = useMemo(() => (total ? rankToolCalls(total, TOOL_TREND_TOP) : []), [total]);
  /** Top-8 之外合并成「其他」一条折线（计划 2-6：其余归其他） */
  const toolTrendOthers = useMemo(() => {
    if (!total || toolTrendRows.length < TOOL_TREND_TOP) return null;
    const top = new Set(toolTrendRows.map((r) => r.name));
    const names = Object.keys(total.toolCalls).filter((n) => !top.has(n));
    const count = names.reduce((s, n) => s + (total.toolCalls[n] ?? 0), 0);
    if (names.length === 0 || count === 0) return null;
    const pick = (d: UsageDay) => names.reduce((s, n) => s + (d.toolCalls[n] ?? 0), 0);
    return { points: trendPoints(rangeDays, pick, todayKey), count };
  }, [total, toolTrendRows, rangeDays, todayKey]);
  const toolFailRows = useMemo(
    () =>
      total
        ? rankToolCalls(total)
            .filter((r) => r.errors > 0)
            .sort((a, b) => b.errors - a.errors || b.count - a.count)
        : [],
    [total]
  );
  const toolFailMax = Math.max(1, ...toolFailRows.map((r) => r.errors));

  const extRows = summary?.llmByExt ?? [];
  const extMax = Math.max(1, ...extRows.map((r) => r.calls));
  const llmRows = summary?.llmCalls ?? [];

  const detailTabs = [t('新建会话'), t('活跃会话'), t('能力调用'), t('扩展 LLM')];

  return (
    <main className="prompt-task-panel usage-panel">
      <header className="prompt-task-toolbar">
        <div>
          <h1>{t('使用统计')}</h1>
          <span>
            {summary
              ? t('今天 {{todayKey}} · 全部工作区 · 计数永久保留 · 明细 30 天 / 1000 条', { todayKey })
              : t('加载中…')}
          </span>
        </div>
        <div className="prompt-task-toolbar-actions">
          <button type="button" className="ui-btn" onClick={() => void refresh()}>
            {t('刷新')}
          </button>
        </div>
      </header>
      {error && <ErrorTip message={error} />}

      <div className="usage-body">
        {/* 全局日期范围：快捷档 + 日历自定义，对全页生效 */}
        <div className="usage-range">
          <div className="prompt-task-tabs" role="tablist" aria-label={t('统计范围')}>
            {(
              [
                ['today', t('今日')],
                ['week', t('近 7 天')],
                ['month', t('近 30 天')]
              ] as Array<[RangeMode, string]>
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={rangeMode === mode}
                className={`prompt-task-tab${rangeMode === mode ? ' is-active' : ''}`}
                onClick={() => applyRangeMode(mode)}
              >
                {label}
              </button>
            ))}
            <div className="usage-rangewrap" ref={rangeWrapRef}>
              <button
                type="button"
                role="tab"
                aria-selected={rangeMode === 'custom'}
                className={`prompt-task-tab${rangeMode === 'custom' ? ' is-active' : ''}`}
                onClick={() => setCalOpen((v) => !v)}
              >
                {rangeMode === 'custom' && customRange
                  ? rangeChipLabel(customRange.fromKey, customRange.toKey)
                  : t('自定义')}
              </button>
              {calPresence.mounted && (
                <UsageCalendar
                  todayKey={todayKey}
                  value={range}
                  presence={calPresence}
                  anchorRef={rangeWrapRef}
                  onApply={applyCustom}
                  onClose={() => setCalOpen(false)}
                />
              )}
            </div>
          </div>
          {summary && (
            <span className="usage-range-note">
              {t('{{from}} ~ {{to}} · 共 {{n}} 天', {
                from: summary.fromKey,
                to: summary.toKey,
                n: rangeDays.length
              })}
            </span>
          )}
        </div>

        {/* 概览四卡：点击下钻对应细节 */}
        {summary && total ? (
          <div className="usage-cards">
            {cardDefs.map((card, i) => (
              <OverviewCard
                key={card.label}
                label={card.label}
                value={card.value}
                sub={card.sub}
                subTone={card.subTone}
                points={card.points}
                delta={card.delta}
                tip={card.tip}
                selected={selected === i}
                onClick={() => selectDetail(i)}
              />
            ))}
          </div>
        ) : (
          <div className="usage-cards" aria-busy>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="usage-card usage-skel">
                <div className="usage-skel-line is-w40" />
                <div className="usage-skel-num" />
                <div className="usage-skel-line is-w80" />
              </div>
            ))}
          </div>
        )}

        {/* 细节区：仅手动切换 */}
        {summary && total && (
          <section
            className="usage-section usage-detail-section"
          >
            <div className="usage-detail-head">
              <div className="prompt-task-tabs" role="tablist" aria-label={t('统计细节')}>
                {detailTabs.map((label, i) => (
                  <button
                    key={label}
                    id={`usage-detail-tab-${i}`}
                    type="button"
                    role="tab"
                    aria-selected={selected === i}
                    className={`prompt-task-tab${selected === i ? ' is-active' : ''}`}
                    onClick={() => selectDetail(i)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <DetailEnter key={selected}>
              <div role="tabpanel" aria-labelledby={`usage-detail-tab-${selected}`}>
              {/* ---- 会话 ---- */}
              {selected === 0 && (
                <div className="usage-detail-body">
                  <div className="usage-agg-block">
                    <div className="usage-agg-caption">{t('Runtime 构成（Agent 会话）')}</div>
                    {runtimeRows.length === 0 ? (
                      <p className="hint-muted">{t('范围内没有 Agent 会话')}</p>
                    ) : (
                      <div className="usage-agg-list">
                        {runtimeRows.map(([name, count]) => (
                          <div key={name} className="usage-agg-row">
                            <span className="usage-agg-name">{name}</span>
                            <span className="usage-tool-bar-track" aria-hidden>
                              <span
                                className="usage-tool-bar"
                                style={{
                                  width: `${Math.max(2, Math.round((count / runtimeMax) * 100))}%`
                                }}
                              />
                            </span>
                            <span className="usage-agg-count">{count}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="usage-agg-block">
                    <div className="usage-agg-caption">
                      {t('新会话趋势（上=工作面板 / 下=终端）')}
                    </div>
                    {sessionsTotal === 0 ? (
                      <p className="hint-muted">{t('范围内没有新建会话')}</p>
                    ) : (
                      <div className="usage-stack-wrap">
                        <StackBars
                          points={trendPoints2(
                            rangeDays,
                            (d) => d.agentSessions,
                            (d) => d.shellSessions,
                            todayKey
                          )}
                          ariaLabel={t('新会话趋势')}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {selected === 1 && (
                <div className="usage-detail-body">
                  <p className="hint-muted">{t('活跃会话从新版启用后开始记录，旧数据无法回填；趋势为每日去重数，范围合计跨日去重。')}</p>
                  {activeRows.length === 0 ? <p className="hint-muted">{t('范围内没有已记录的活跃会话')}</p> : (
                    <div className="usage-active-list">
                      {activeRows.map(([id, activity]) => (
                        <div className="usage-active-row" key={id}>
                          <span className="usage-active-name">{activity.runtime === 'scheduler' && id === `scheduler:${activity.workspaceId}` && activity.name === '调度 Agent' ? t('调度 Agent') : activity.name}</span>
                          <span>{activity.runtime}</span>
                          <span>{workspaces.find(w => w.id === activity.workspaceId)?.name || activity.workspaceId || t('未分配工作区')}</span>
                          <time>{fmtTime(activity.lastActiveAt, todayKey)}</time>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ---- 能力调用 ---- */}
              {selected === 2 && (
                <div className="usage-detail-body">
                  <div className="prompt-task-tabs" role="tablist" aria-label={t('能力视图')}>
                    {(
                      [
                        ['rank', t('排行')],
                        ['trend', t('趋势')],
                        ['fail', t('失败焦点')]
                      ] as Array<[ToolView, string]>
                    ).map(([view, label]) => (
                      <button
                        key={view}
                        type="button"
                        role="tab"
                        aria-selected={toolView === view}
                        className={`prompt-task-tab${toolView === view ? ' is-active' : ''}`}
                        onClick={() => setToolView(view)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {toolCallsTotal === 0 ? (
                    <div className="usage-empty ui-empty">
                      <p className="ui-empty-desc">{t('范围内没有能力调用')}</p>
                      <p className="hint-muted">
                        {t('调度 Agent / Worker 调用壳层能力后会在这里出现')}
                      </p>
                    </div>
                  ) : toolView === 'rank' ? (
                    <div className="usage-tool-list">
                      {toolRankRows.map((row) => (
                        <div key={row.name} className="usage-tool-row">
                          <span className="usage-tool-name">{row.name}</span>
                          <span className="usage-tool-bar-track" aria-hidden>
                            <span
                              className="usage-tool-bar"
                              style={{
                                width: `${Math.max(2, Math.round((row.count / toolRankMax) * 100))}%`
                              }}
                            />
                          </span>
                          <span className="usage-tool-count">{row.count}</span>
                          <span
                            className={`usage-tool-errors${row.errors > 0 ? '' : ' is-none'}`}
                            title={
                              row.errors > 0
                                ? t('失败率 {{p}}%', {
                                    p: Math.round((row.errors / row.count) * 100)
                                  })
                                : undefined
                            }
                          >
                            {row.errors > 0
                              ? `✕${row.errors} · ${Math.round((row.errors / row.count) * 100)}%`
                              : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : toolView === 'trend' ? (
                    <div className="usage-tool-list">
                      {toolTrendRows.map((row) => (
                        <div key={row.name} className="usage-trend-row">
                          <span className="usage-tool-name">{row.name}</span>
                          <ToolSpark points={points((d) => d.toolCalls[row.name] ?? 0)} />
                          <span className="usage-tool-count">{row.count}</span>
                        </div>
                      ))}
                      {toolTrendOthers ? (
                        <div className="usage-trend-row is-others">
                          <span className="usage-tool-name">{t('其他')}</span>
                          <ToolSpark points={toolTrendOthers.points} />
                          <span className="usage-tool-count">{toolTrendOthers.count}</span>
                        </div>
                      ) : null}
                      <p className="hint-muted usage-agg-note">{t('按日展示，超过 14 天每 7 天一段')}</p>
                    </div>
                  ) : toolFailRows.length === 0 ? (
                    <div className="usage-empty ui-empty">
                      <p className="ui-empty-desc">{t('范围内没有失败的能力调用')}</p>
                    </div>
                  ) : (
                    <div className="usage-tool-list">
                      {toolFailRows.map((row) => (
                        <div key={row.name} className="usage-tool-row">
                          <span className="usage-tool-name">{row.name}</span>
                          <span className="usage-tool-bar-track" aria-hidden>
                            <span
                              className="usage-tool-bar"
                              style={{
                                width: `${Math.max(2, Math.round((row.errors / toolFailMax) * 100))}%`
                              }}
                            />
                          </span>
                          <span className="usage-tool-count">✕{row.errors}</span>
                          <span className="usage-tool-errors">
                            {t('失败率 {{p}}%', {
                              p: Math.round((row.errors / row.count) * 100)
                            })}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {toolView === 'fail' && (
                    <div className="usage-agg-block">
                      <div className="usage-agg-caption">{t('最近失败详情（近 30 天 / 最多 1000 条）')}</div>
                      <p className="hint-muted">{t('仅新版启用后的失败有详情；取消单独标记，不保存调用参数。')}</p>
                      {(summary.toolFailures ?? []).length === 0 ? <p className="hint-muted">{t('范围内没有可用的失败详情，历史计数不受影响')}</p> : (
                        <div className="usage-failure-list">
                          {(summary.toolFailures ?? []).slice(0, failureLimit).map(row => (
                            <div className="usage-failure-item" key={row.id}>
                              <div className="usage-failure-head"><strong>{row.name}</strong><span>{row.cancelled ? t('已取消') : t('失败')}</span><time>{fmtTime(row.at, todayKey)}</time></div>
                              <pre className="usage-failure-error">{row.cancelled && row.error === '已取消' ? t('已取消')
                                : !row.cancelled && row.error === '调用失败，未提供原因' ? t('调用失败，未提供原因') : row.error}</pre>
                            </div>
                          ))}
                        </div>
                      )}
                      {(summary.toolFailures?.length ?? 0) > failureLimit && <button type="button" className="ui-btn" onClick={() => setFailureLimit(n => n + 50)}>{t('加载更多失败详情')}</button>}
                    </div>
                  )}
                </div>
              )}

              {/* ---- 扩展 LLM ---- */}
              {selected === 3 && (
                <div className="usage-detail-body">
                  <div className="usage-agg-block">
                    <div className="usage-agg-caption">
                      {t('按扩展聚合（明细保留 30 天 · 上限 1000 条）')}
                    </div>
                    {extRows.length === 0 ? (
                      <p className="hint-muted">{t('范围内没有扩展 LLM 调用')}</p>
                    ) : (
                      <div className="usage-agg-list">
                        {extRows.map((row) => (
                          <div key={row.extId} className="usage-agg-row">
                            <span className="usage-agg-name">{row.extId}</span>
                            <span className="usage-tool-bar-track" aria-hidden>
                              <span
                                className="usage-tool-bar"
                                style={{
                                  width: `${Math.max(2, Math.round((row.calls / extMax) * 100))}%`
                                }}
                              />
                            </span>
                            <span className="usage-agg-count">
                              {row.calls}
                              {row.errors > 0 ? t(' · 失败 {{n}}', { n: row.errors }) : ''}
                              {row.avgDurationMs != null
                                ? t(' · 平均 {{d}}', { d: fmtDuration(row.avgDurationMs) })
                                : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="usage-agg-block">
                    <div className="usage-agg-caption">{t('调用明细')}</div>
                    {llmRows.length === 0 ? (
                      <div className="usage-empty ui-empty">
                        <p className="ui-empty-desc">{t('范围内没有扩展 LLM 调用')}</p>
                        <p className="hint-muted">
                          {t('面板声明 llm 权限后调用 ma.llm.chat（如日报总结）会在这里留下参数与返回')}
                        </p>
                      </div>
                    ) : (
                      <>
                        <div className="usage-run-list">
                          {llmRows.map((call) => {
                            const expanded = llmOpenId === call.id;
                            return (
                              <div
                                key={call.id}
                                className={`usage-run-item${expanded ? ' is-expanded' : ''}`}
                              >
                                <button
                                  type="button"
                                  className="usage-run-row"
                                  onClick={() => void openLlmDetail(call.id)}
                                  title={t('点击展开请求参数与返回')}
                                >
                                  <span className={`task-run-status is-${call.ok ? 'ok' : 'error'}`}>
                                    {call.ok ? t('成功') : t('失败')}
                                  </span>
                                  <span className="usage-run-name">{call.extId}</span>
                                  <span className="usage-run-preview">{call.preview}</span>
                                  <span className="task-run-time">
                                    {fmtTime(call.startedAt, todayKey)}
                                  </span>
                                  <span className="task-run-duration">
                                    {fmtDuration(call.durationMs)}
                                  </span>
                                </button>
                                {expanded ? (
                                  <div className="usage-run-detail">
                                    <div className="usage-run-meta">
                                      {t('模型 {{model}} · 上限 {{max}} · 温度 {{temp}}', {
                                        model: call.model ?? '—',
                                        max: call.maxTokens,
                                        temp: call.temperature
                                      })}
                                    </div>
                                    {llmDetailLoading ? (
                                      <div className="usage-run-meta">{t('加载中…')}</div>
                                    ) : llmDetail ? (
                                      <>
                                        {llmDetail.messages.map((m, i) => (
                                          <div key={`${llmDetail.id}-${i}`} className="usage-llm-msg">
                                            <div className="usage-llm-role">{m.role}</div>
                                            <pre className="usage-llm-content">{m.content}</pre>
                                          </div>
                                        ))}
                                        {llmDetail.error ? (
                                          <ErrorTipDetails message={llmDetail.error} />
                                        ) : null}
                                        {llmDetail.text ? (
                                          <div className="usage-llm-msg">
                                            <div className="usage-llm-role">
                                              {t('assistant · 返回')}
                                            </div>
                                            <pre className="usage-llm-content">{llmDetail.text}</pre>
                                          </div>
                                        ) : null}
                                      </>
                                    ) : (
                                      <div className="usage-run-meta">
                                        {t('明细已超出保留窗口')}
                                      </div>
                                    )}
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                        {summary.llmCallsTotal > llmRows.length ? (
                          llmRows.length >= USAGE_LLM_PAGE_MAX ? (
                            <p className="hint-muted usage-agg-note">
                              {t('已达单次显示上限 {{n}} 条', { n: USAGE_LLM_PAGE_MAX })}
                            </p>
                          ) : (
                            <button
                              type="button"
                              className="ui-btn usage-more"
                              onClick={() =>
                                setLlmLimit((n) => Math.min(n + USAGE_PAGE_DEFAULT, USAGE_LLM_PAGE_MAX))
                              }
                            >
                            {t('加载更多（还有 {{n}} 条）', {
                              n: Math.min(
                                summary.llmCallsTotal - llmRows.length,
                                USAGE_LLM_PAGE_MAX - llmRows.length
                              )
                            })}
                            </button>
                          )
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              )}
              </div>
            </DetailEnter>
          </section>
        )}
      </div>
    </main>
  );
}
