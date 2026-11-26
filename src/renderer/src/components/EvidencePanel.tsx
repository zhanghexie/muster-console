/**
 * 会话证据页（T4.5）：时间线回看 Worker 工作证据——看板 phase 翻转事件
 * （pty 切片缩略）+ 后台任务终态摘要 + browser 截图（默认关）+
 * 留言投递账本（O10 内联条目）。
 * 数据来自 EvidenceCollector（T4.4）的 userData/evidence/<sessionId>/；
 * 入口：左栏右键 / 看板卡片右键「查看证据」（evidenceViewStore 驱动，App 根层级
 * 唯一宿主）。进出场：usePresence + mp-scrim/mp-panel；条目展开：acc 手风琴
 * （动画规约，见 docs/features/animation-system.md）。正文/图片按条目懒加载。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { EvidenceEntry, EvidenceIndex } from '../../../shared/evidence';
import { getResolvedLocale } from '../../../shared/i18n';
import { BOARD_STATUS_PRESENTATION } from '../panels/boardPresentation';
import { closeEvidenceView, useEvidenceView, type EvidenceViewTarget } from '../panels/evidenceViewStore';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { usePresenceValue } from './motion';
import { ImageLightbox } from './ImageLightbox';
import { IconChevronDown, IconClock, IconClose, IconRefresh, IconTerminal } from './icons';

/** BoardStatus（EvidencePhaseRef.from/to 的真实词表）→ 胶囊色调（session-capsule 体系） */
function capsuleOf(status: string): string {
  switch (status) {
    case 'done':
      return 'done';
    case 'blocked':
    case 'waiting':
      return 'waiting';
    case 'error':
      return 'error';
    case 'working':
    case 'scheduled':
      return 'active';
    default:
      return 'info'; // idle / no_signal / exited / 首次（无 from）
  }
}

function statusLabel(status: string): string {
  return BOARD_STATUS_PRESENTATION[status as keyof typeof BOARD_STATUS_PRESENTATION]?.label ?? status;
}

function phaseSourceLabel(source: string): string {
  if (source === 'model') return 'model';
  if (source === 'llm') return 'llm';
  if (source === 'user') return 'user';
  return source;
}

/** M/D HH:mm:ss（秒级精确——翻转时刻的取证时间线） */
function fmtTs(ts: number): string {
  const d = new Date(ts);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

interface LoadState {
  loading: boolean;
  error?: string;
  index: EvidenceIndex | null;
}

// ---------- 条目：phase 翻转（pty 切片） ----------

const PhaseFlipItem = React.memo(function PhaseFlipItem({
  sessionId,
  entry,
  expanded,
  onToggle
}: {
  sessionId: string;
  entry: EvidenceEntry;
  expanded: boolean;
  onToggle: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const phase = entry.phase!;
  // 正文懒加载：首次展开才拉（undefined=未加载 / null=失败或已清理）
  const [text, setText] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!expanded || text !== undefined) return;
    let alive = true;
    void window.api.evidence
      .entryText(sessionId, entry.id)
      .then((r) => {
        if (alive) setText(r?.text ?? null);
      })
      .catch(() => {
        if (alive) setText(null);
      });
    return () => {
      alive = false;
    };
  }, [expanded, text, sessionId, entry.id]);

  return (
    <li className="ev-item ev-flip">
      <button
        type="button"
        className="ev-item-head"
        aria-expanded={expanded}
        onClick={() => onToggle(entry.id)}
      >
        <span className="ev-item-time" title={new Date(entry.ts).toLocaleString(getResolvedLocale())}>
          {fmtTs(entry.ts)}
        </span>
        <span className="ev-flip-flow">
          <span className={`session-capsule ${capsuleOf(phase.from ?? '')}`}>{statusLabel(phase.from ?? '')}</span>
          <span className="ev-flip-arrow" aria-hidden>
            →
          </span>
          <span className={`session-capsule ${capsuleOf(phase.to)}`}>{statusLabel(phase.to)}</span>
        </span>
        <span className="ev-item-side">
          <span className="ev-item-src" title={t('上报来源')}>{phaseSourceLabel(phase.source)}</span>
          {entry.afterTs ? <span className="ev-flip-after">{t('含后续')}</span> : null}
        </span>
        <IconChevronDown size={12} className={`ev-item-chev${expanded ? ' is-open' : ''}`} />
      </button>
      <div className={`acc${expanded ? ' is-open' : ''}`}>
        <div className="acc-body">
          <div className="ev-item-body">
            {text === undefined ? (
              <span className="hint-muted">{t('加载中…')}</span>
            ) : text === null ? (
              <span className="hint-muted">{t('切片文件已清理或读取失败（证据保留 7 天）')}</span>
            ) : (
              <pre className="ev-flip-pre">{text}</pre>
            )}
          </div>
        </div>
      </div>
    </li>
  );
});

// ---------- 条目：后台任务终态摘要 ----------

const BgTaskItem = React.memo(function BgTaskItem({
  entry,
  expanded,
  onToggle
}: {
  entry: EvidenceEntry;
  expanded: boolean;
  onToggle: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const bg = entry.bgTask!;
  const capsule = bg.status === 'done' ? 'done' : bg.status === 'cancelled' ? 'info' : 'error';
  const statusText =
    bg.status === 'done' ? t('已完成') : bg.status === 'cancelled' ? t('已取消') : t('失败');
  return (
    <li className="ev-item ev-bgtask">
      <button
        type="button"
        className="ev-item-head"
        aria-expanded={expanded}
        onClick={() => onToggle(entry.id)}
      >
        <span className="ev-item-time" title={new Date(entry.ts).toLocaleString(getResolvedLocale())}>
          {fmtTs(entry.ts)}
        </span>
        <span className="ev-bgtask-cmd" title={bg.command}>
          {bg.command || t('（无命令）')}
        </span>
        <span className="ev-item-side">
          <span className={`session-capsule ${capsule}`}>
            {typeof bg.exitCode === 'number' ? `${statusText} · exit ${bg.exitCode}` : statusText}
          </span>
        </span>
        <IconChevronDown size={12} className={`ev-item-chev${expanded ? ' is-open' : ''}`} />
      </button>
      <div className={`acc${expanded ? ' is-open' : ''}`}>
        <div className="acc-body">
          <div className="ev-item-body">
            {bg.summary ? (
              <pre className="ev-bgtask-pre">{bg.summary}</pre>
            ) : (
              <span className="hint-muted">{t('无输出摘要')}</span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
});

// ---------- 条目：browser 截图 ----------

const BrowserShotItem = React.memo(function BrowserShotItem({
  sessionId,
  entry,
  onZoom
}: {
  sessionId: string;
  entry: EvidenceEntry;
  onZoom: (dataUrl: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.api.evidence
      .entryImage(sessionId, entry.id)
      .then((r) => {
        if (alive) setSrc(r?.dataUrl ?? null);
      })
      .catch(() => {
        if (alive) setSrc(null);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, entry.id]);

  return (
    <li className="ev-item ev-shot">
      <div className="ev-shot-row">
        <span className="ev-item-time" title={new Date(entry.ts).toLocaleString(getResolvedLocale())}>
          {fmtTs(entry.ts)}
        </span>
        {(() => {
          // 回合结束自动截图（任务 D）带 tab url；显式 browser.screenshot 不带
          const url = entry.turnShot?.url;
          const label = url ? `${t('浏览器截图')} · ${url}` : t('浏览器截图');
          return (
            <span className="ev-shot-label" title={url ?? undefined}>
              {label}
            </span>
          );
        })()}
        {src ? (
          <button type="button" className="ev-shot-thumb" onClick={() => onZoom(src)} title={t('查看大图')}>
            <img src={src} alt={t('浏览器截图')} draggable={false} />
          </button>
        ) : (
          <span className="ev-shot-missing hint-muted">{t('截图已清理或读取失败（证据保留 7 天）')}</span>
        )}
      </div>
    </li>
  );
});

/** 未知 kind 的中性兜底：渲染 kind 原文，不触发任何 IPC（截图类才调 entryImage） */
const UnknownItem = React.memo(function UnknownItem({ entry }: { entry: EvidenceEntry }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <li className="ev-item ev-msg">
      <div className="ev-msg-row">
        <span className="ev-item-time" title={new Date(entry.ts).toLocaleString(getResolvedLocale())}>
          {fmtTs(entry.ts)}
        </span>
        <span className="ev-msg-text">{t('未知条目类型：{{kind}}', { kind: entry.kind })}</span>
      </div>
    </li>
  );
});

// ---------- 面板主体 ----------

function EvidenceBody({
  target,
  open,
  onClose
}: {
  target: EvidenceViewTarget;
  /** 宿主层 target 仍在（重开同会话需重新拉取） */
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ loading: true, index: null });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [lightbox, setLightbox] = useState<string | null>(null);
  // 代次守卫：慢响应后到时会话可能已切换（退场期可继续操作左栏），旧响应不得覆盖新会话
  const genRef = useRef(0);

  const load = useCallback((): void => {
    const gen = ++genRef.current;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    void window.api.evidence
      .getIndex(target.sessionId)
      .then((idx) => {
        if (gen !== genRef.current) return;
        setState({ loading: false, index: idx, error: undefined });
      })
      .catch((err: unknown) => {
        if (gen !== genRef.current) return;
        setState({ loading: false, index: null, error: err instanceof Error ? err.message : String(err) });
      });
  }, [target.sessionId]);

  // 打开边沿 / 换会话拉取（退场期不拉）
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // 换会话重置展开态
  useEffect(() => {
    setExpanded(new Set());
    setLightbox(null);
  }, [target.sessionId]);

  const entries = useMemo(
    () => (state.index ? [...state.index.entries].sort((a, b) => b.ts - a.ts) : []),
    [state.index]
  );
  const toggle = useCallback((id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const span =
    entries.length > 0
      ? `${fmtTs(entries[entries.length - 1].ts)} – ${fmtTs(entries[0].ts)}`
      : null;

  return (
    <>
      <div className="modal-head">
        <h3>
          {t('证据')} · {target.sessionName}
        </h3>
        <span className="ev-head-actions">
          <button
            type="button"
            className="modal-close ev-refresh"
            title={t('刷新')}
            aria-label={t('刷新')}
            disabled={state.loading}
            onClick={load}
          >
            <IconRefresh size={13} />
          </button>
          <button type="button" className="modal-close" aria-label={t('关闭')} onClick={onClose}>
            <IconClose size={14} />
          </button>
        </span>
      </div>
      <div className="modal-body ev-body">
        {state.loading ? (
          <div className="ui-empty ev-empty">
            <IconClock size={28} />
            <p className="ui-empty-desc">{t('加载中…')}</p>
          </div>
        ) : state.error ? (
          <div className="ui-empty ev-empty">
            <p className="ui-empty-desc">{t('读取证据失败：{{message}}', { message: state.error })}</p>
            <button type="button" className="ui-btn" onClick={load}>
              {t('重试')}
            </button>
          </div>
        ) : entries.length === 0 ? (
          <div className="ui-empty ev-empty">
            <IconTerminal size={28} />
            <p className="ui-empty-desc">{t('暂无证据')}</p>
            <p className="hint-muted">
              {t('看板状态翻转、后台任务终态、任务流转与留言投递会自动归档，保留 7 天。')}
            </p>
          </div>
        ) : (
          <>
            <p className="ev-meta">
              {t('{{n}} 条证据', { n: entries.length })}
              {span ? <span className="ev-meta-span"> · {span}</span> : null}
            </p>
            <ol className="ev-timeline">
              {entries.map((e) =>
                e.kind === 'pty-slice' ? (
                  <PhaseFlipItem
                    key={e.id}
                    sessionId={target.sessionId}
                    entry={e}
                    expanded={expanded.has(e.id)}
                    onToggle={toggle}
                  />
                ) : e.kind === 'bgtask-summary' ? (
                  <BgTaskItem key={e.id} entry={e} expanded={expanded.has(e.id)} onToggle={toggle} />
                ) : e.kind === 'browser-shot' ? (
                  <BrowserShotItem
                    key={e.id}
                    sessionId={target.sessionId}
                    entry={e}
                    onZoom={setLightbox}
                  />
                ) : (
                  <UnknownItem key={e.id} entry={e} />
                )
              )}
            </ol>
          </>
        )}
      </div>
      <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />
    </>
  );
}

/** 宿主（App 根层级唯一挂载）：presence 进出场 + 关闭期内容冻结 */
export function EvidencePanel(): React.JSX.Element | null {
  const target = useEvidenceView();
  // 关闭瞬间冻结最后一次打开的目标（退场动画期不闪空）
  const { presence, value: snap } = usePresenceValue(target);
  const { t } = useTranslation();

  useOverlayDismiss(presence.mounted && presence.stage !== 'out', closeEvidenceView);

  if (!presence.mounted || !snap) return null;
  return createPortal(
    <div
      className="modal-mask evidence-mask mp-scrim"
      data-mp-stage={presence.stage}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeEvidenceView();
      }}
    >
      <div
        className="modal evidence-modal mp-panel"
        data-mp-stage={presence.stage}
        role="dialog"
        aria-modal="true"
        aria-label={t('会话证据')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <EvidenceBody target={snap} open={target != null} onClose={closeEvidenceView} />
      </div>
    </div>,
    document.body
  );
}
