import { ErrorTip } from '../ErrorTip';
import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessCatalogRefreshRow } from '../../../../shared/harnessCatalogRefresh';
import { localizeGuiHostError } from '../../../../shared/guiHostError';
import { useOverlayDismiss } from '../../keybindings/KeybindingHost';
import { IconRefresh } from '../icons';
import { usePresence } from '../motion';

type RefreshState = {
  phase: 'detecting' | 'reading' | 'done';
  workspace: string;
  rows: HarnessCatalogRefreshRow[];
  error?: string;
};

export function HarnessCatalogRefresh({ active, detecting }: { active: boolean; detecting: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  const dialogId = useId();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<RefreshState | null>(null);
  const request = useRef<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const presence = usePresence(active && open);
  const visible = active && open && presence.stage !== 'out';
  const busy = state?.phase === 'detecting' || state?.phase === 'reading';
  const close = (): void => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  useOverlayDismiss(visible && presence.mounted, close);
  useEffect(() => {
    const off = window.api.on('agentSession:harnessCatalogRefreshProgress', event => {
      if (event.requestId !== request.current) return;
      if (event.kind === 'catalogs') {
        setState({ phase: 'reading', workspace: event.workspace, rows: event.rows });
      } else {
        setState(previous => previous ? { ...previous, rows: previous.rows.map(row => row.id === event.row.id ? event.row : row) } : previous);
      }
    });
    return () => { request.current = null; off(); };
  }, []);
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  useEffect(() => {
    if (!visible || !presence.mounted) return;
    closeButton.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [visible, presence.mounted]);

  const refresh = async (): Promise<void> => {
    setOpen(true);
    if (request.current) return;
    const id = globalThis.crypto?.randomUUID?.() ?? `refresh-${Date.now()}`;
    request.current = id;
    setState({ phase: 'detecting', workspace: '', rows: [] });
    try {
      const result = await window.api.agentSession.refreshHarnessModelCatalogs(id);
      if (request.current !== id) return;
      if (result.ok) setState({ phase: 'done', workspace: result.workspace, rows: result.rows });
      else setState(previous => ({ phase: 'done', workspace: previous?.workspace ?? '', rows: previous?.rows ?? [], error: result.error }));
    } catch (error) {
      if (request.current === id) setState(previous => ({ phase: 'done', workspace: previous?.workspace ?? '', rows: previous?.rows ?? [],
        error: (error as Error).message || String(error) }));
    } finally {
      if (request.current === id) request.current = null;
    }
  };

  const done = state?.rows.filter(row => row.state !== 'queued' && row.state !== 'reading').length ?? 0;
  const rowStatus = (row: HarnessCatalogRefreshRow): string => {
    switch (row.state) {
      case 'queued': return t('等待刷新');
      case 'reading': return t('读取中…');
      case 'done': return t('已读取 {{count}} 个模型', { count: row.models ?? 0 });
      case 'partial': return t('部分完成');
      case 'failed': return t('刷新失败');
    }
  };
  return <div className="worker-refresh" ref={container}>
    <button type="button" className="btn tiny" ref={trigger} title={t('重新检测本机并刷新模型目录')}
      aria-haspopup="dialog" aria-expanded={visible} aria-controls={visible ? dialogId : undefined}
      disabled={detecting && !busy} onClick={() => void refresh()}>
      <IconRefresh size={13}/>{busy ? t('查看刷新进度') : t('刷新')}
    </button>
    {presence.mounted && state ? <div id={dialogId} className="worker-refresh-popover mp-pop" {...presence.spread}
      ref={node => { if (node) node.inert = !visible; }} aria-hidden={!visible || undefined} role="dialog" aria-label={t('模型目录刷新')}>
      <div className="worker-refresh-heading">
        <div><strong>{t('模型目录刷新')}</strong>{state.workspace ? <div className="worker-refresh-detail">{state.workspace}</div> : null}</div>
        <button className="btn tiny" type="button" ref={closeButton} onClick={close}>{t('关闭')}</button>
      </div>
      {visible && <ErrorTip message={state.error ? localizeGuiHostError(state.error) : state.rows.flatMap(row => {
        const reason = row.error ?? row.coverage?.detail;
        return reason ? [row.name + ' · ' + localizeGuiHostError(reason)] : [];
      }).join('\n')} />}
      {state.phase === 'detecting' ? <p role="status">{t('正在检测本机引擎…')}</p> : null}
      {state.rows.length > 0 ? <>
        <p role="status">{t('已处理 {{done}}/{{total}} 项', { done, total: state.rows.length })}</p>
        <progress aria-label={t('模型目录刷新进度')} max={state.rows.length} value={done}/>
        <ul className="worker-refresh-list">
          {state.rows.map(row => <li key={row.id}>
            <div className="worker-refresh-row">
              <div><strong>{row.name}</strong>{row.source ? <div className="worker-refresh-detail">{row.source}</div> : null}</div>
              <span className="worker-refresh-detail">{rowStatus(row)}</span>
            </div>
            {row.progress?.total ? <div className="worker-refresh-detail">
              {t('思考档 {{done}}/{{total}}', { done: row.progress.completed, total: row.progress.total })}
              {row.progress.model ? <> · {row.progress.model}</> : null}
            </div> : null}
            {row.coverage?.total ? <div className="worker-refresh-detail">
              {t('已确认 {{done}}/{{total}} 个模型的思考档', { done: row.coverage.read, total: row.coverage.total })}
              {row.coverage.read < row.coverage.total && !row.coverage.detail ? <> · {t('引擎未返回部分模型的思考档配置')}</> : null}
            </div> : null}
          </li>)}
        </ul>
      </> : state.phase === 'done' && !state.error ? <p role="status">{t('没有可刷新的外部模型目录')}</p> : null}
    </div> : null}
  </div>;
}
