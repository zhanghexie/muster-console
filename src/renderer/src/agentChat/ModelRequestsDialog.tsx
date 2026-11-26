import { ErrorTip } from '../components/ErrorTip';
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { ModelRequestRow } from '../../../shared/modelRequest';
import { Segmented } from '../components/settings/shared';
import { IconClose, IconRefresh } from '../components/icons';
import { AnimatedDetails } from '../components/AnimatedDetails';
import { usePresence } from '../components/motion';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { RequestCompressionView } from './RequestCompressionView';
import type { ModelRequestRecording } from './ModelRequestRecording';
import './modelRequests.css';

function displayValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

const FormattedRequestJson = React.lazy(() => import('./FormattedRequestJson'));

function RequestBody({ body, session, row }: { body: string; session: string; row: ModelRequestRow }): React.JSX.Element {
  const { t } = useTranslation();
  const [view, setView] = useState<'content' | 'raw' | 'compression'>('content');
  const [formatted, setFormatted] = useState(true);
  const data: unknown = React.useMemo(() => {
    try { return JSON.parse(body); } catch { return undefined; }
  }, [body]);
  const validJson = data !== undefined;
  const object = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
  const raw = view === 'raw';
  const content = view === 'content';
  const compression = view === 'compression';
  const contentPane = usePresence(content);
  const compressionPane = usePresence(compression);
  const rawPane = usePresence(raw);
  return <>
    <div className="request-tabs">
      <Segmented value={view} onChange={setView} label={t('请求视图')} options={[
        { value: 'content', label: t('内容') }, { value: 'compression', label: t('压缩') }, { value: 'raw', label: t('原始请求体') }
      ]}/>
      {raw && validJson && <label className="request-format"><input type="checkbox" checked={formatted}
        onChange={event => setFormatted(event.target.checked)}/>{t('格式化 JSON')}</label>}
    </div>
    <div className="xfade-stack">
      {compressionPane.mounted && <div className={`request-document request-compression xfade xfade-instant${compression ? ' is-shown' : ''}`}
        {...compressionPane.spread} aria-hidden={!compression} {...(!compression ? { inert: '' as unknown as boolean } : {})} tabIndex={0}>
        <RequestCompressionView session={session} row={row} data={data}/>
      </div>}
      {contentPane.mounted && <div className={`request-document xfade xfade-instant${content ? ' is-shown' : ''}`}
        {...contentPane.spread} aria-hidden={!content} {...(!content ? { inert: '' as unknown as boolean } : {})} tabIndex={0}>
        {!object ? <pre>{body}</pre> : Object.entries(object).map(([key, value]) => {
          if (['messages', 'input', 'contents'].includes(key) && Array.isArray(value)) {
            return <section key={key}><h4>{key}<span>{value.length}</span></h4>{value.map((message, index) => {
              const text = typeof message?.content === 'string' && Object.keys(message).every(k => ['role','content'].includes(k));
              return <article key={index}><header><span className="request-sequence">{index + 1}</span>
                <strong>{String(message?.role ?? message?.type ?? key)}</strong></header>
                <pre className={text ? 'request-prose' : undefined}>{text ? message.content : displayValue(message)}</pre>
              </article>;
            })}</section>;
          }
          if (key === 'tools' || key === 'toolConfig') return <AnimatedDetails className="request-tools" key={key}
            summary={Array.isArray(value) ? key + ' · ' + value.length : key}><pre>{displayValue(value)}</pre></AnimatedDetails>;
          return <section className={value === null || typeof value !== 'object' && String(value).length < 64 ? 'request-field' : undefined}
            key={key}><h4>{key}</h4><pre>{displayValue(value)}</pre></section>;
        })}
      </div>}
      {rawPane.mounted && <div className={`request-document request-source xfade xfade-instant${raw ? ' is-shown' : ''}`}
        {...rawPane.spread} aria-hidden={!raw} {...(!raw ? { inert: '' as unknown as boolean } : {})} tabIndex={formatted && validJson ? -1 : 0}>
        {formatted && validJson ? <React.Suspense fallback={<p role="status">{t('加载中…')}</p>}>
          <FormattedRequestJson body={body} label={t('格式化 JSON')}/>
        </React.Suspense> : <pre>{body}</pre>}
      </div>}
    </div>
  </>;
}

function RecordingSwitch({ enabled, pending, error, change }: ModelRequestRecording): React.JSX.Element {
  const { t } = useTranslation();
  const id = React.useId();
  return <div className="request-recording"><label htmlFor={id}>{t('记录本会话请求')}<input id={id} className="s-switch" type="checkbox" role="switch"
    checked={enabled === true} disabled={enabled === undefined || pending} onChange={event => change(event.currentTarget.checked)}
    aria-describedby={error ? id + '-error' : undefined}/></label>
    {error && <small id={id + '-error'} role="alert">{error === 'read' ? t('记录开关读取失败') : t('记录开关更新失败')}</small>}</div>;
}

type CompactAction = () => Promise<{ ok: boolean; error?: string }>;

function RequestBrowser({ sessionId, compact, recording }: { sessionId: string; compact?: CompactAction; recording: ModelRequestRecording }): React.JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ModelRequestRow[]>([]);
  const [page, setPage] = useState<number[]>([]);
  const [revision, refresh] = React.useReducer((n: number) => n + 1, 0);
  const [selected, select] = useState<number>();
  const [detail, setDetail] = useState<{id: number; body: string | null}>();
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [compacting, setCompacting] = useState(false);
  const [compactStatus, setCompactStatus] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState('');
  const [exportError, setExportError] = useState(false);
  async function exportRequests(call?: number) {
    if (exporting) return;
    setExporting(true);
    setExportStatus('');
    setExportError(false);
    try {
      const result = await window.api.agentSession.exportModelRequests(sessionId, call);
      if (result.ok) {
        setExportStatus(t('已导出 {{count}} 次调用', { count: result.count }) +
          (result.omitted ? t('（{{count}} 条正文未保存）', { count: result.omitted }) : ''));
      } else if (!result.canceled) {
        setExportError(true);
        setExportStatus(t('模型请求导出失败：{{error}}', { error: result.error || t('未知错误') }));
      }
    } catch (error) {
      setExportError(true);
      setExportStatus(t('模型请求导出失败：{{error}}', { error: String(error) }));
    } finally { setExporting(false); }
  }
  async function compactCurrent() {
    if (!compact || compacting) return;
    setCompacting(true);
    setCompactStatus('');
    try {
      const result = await compact();
      setCompactStatus(result.ok ? t('当前会话已压缩') : result.error || t('压缩失败'));
      if (result.ok) { setPage([]); refresh(); }
    } catch (error) { setCompactStatus(String(error)); }
    finally { setCompacting(false); }
  }
  const before = page.at(-1);
  useEffect(() => {
    let live = true;
    setListState('loading');
    void window.api.agentSession.modelRequests(sessionId, before).then(result => {
      if (!live) return;
      setRows(result);
      select(id => result.some(row => row.id === id) ? id : result[0]?.id);
      setListState('ready');
    }, () => { if (live) { setRows([]); select(undefined); setListState('error'); } });
    return () => { live = false; };
  }, [sessionId, before, revision, recording.enabled]);
  useEffect(() => {
    if (selected === undefined) return;
    let live = true;
    void window.api.agentSession.modelRequestBody(sessionId, selected).then(body => {
      if (live) setDetail({ id: selected, body });
    }, () => { if (live) setDetail({ id: selected, body: null }); });
    return () => { live = false; };
  }, [sessionId, selected, revision]);
  const row = rows.find(item => item.id === selected);
  return <div className="request-columns">
    <div className="request-list"><header><h4>{t('调用记录')}</h4><button className="modal-close" aria-label={t('刷新')} title={t('刷新')} onClick={refresh}><IconRefresh/></button></header>
      <RecordingSwitch {...recording}/>
      <div className="request-export-actions" aria-busy={exporting}>
        <div><button type="button" className="ui-btn compact" disabled={exporting || listState !== 'ready' || !row}
          onClick={() => void exportRequests(selected)}>{t('导出当前调用')}</button>
          <button type="button" className="ui-btn compact" disabled={exporting || listState !== 'ready' || !rows.length}
            title={t('导出本会话仍保留的全部调用，包含其他分页')} onClick={() => void exportRequests()}>{t('导出全部调用')}</button></div>
        {exporting && <small role="status">{t('导出中…')}</small>}
        {exportStatus && (exportError ? <ErrorTip message={exportStatus} /> : <small role="status">{exportStatus}</small>)}
      </div>
      {compact && <div className="request-compact-action"><button type="button" className="ui-btn compact"
        disabled={compacting} onClick={compactCurrent}>{compacting ? t('压缩中…') : t('压缩当前会话')}</button>
        {compactStatus && <small role="status">{compactStatus}</small>}</div>}
      <div className="request-rows">{rows.map(item => <button type="button" key={item.id} aria-pressed={item.id === selected} onClick={() => select(item.id)}>
        <span className="request-row-heading"><strong>{item.model}</strong><span className="request-id">#{item.id}</span></span>
        {!!item.compressionCount && <span className="request-compression-count">{t('压缩 {{n}} 项', { n: item.compressionCount })}</span>}
        <small><time title={new Date(item.at).toLocaleString()}>{new Date(item.at).toLocaleTimeString()}</time><span>{item.bytes < 1024 ? item.bytes + ' B' : (item.bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' KiB'}</span></small>
      </button>)}
      {!rows.length && <p role="status">{listState === 'error' ? t('调用记录读取失败') : listState === 'loading' ? t('加载中…') : t('暂无模型请求记录')}</p>}</div>
      <footer>{page.length > 0 && <button onClick={() => setPage(page.slice(0, -1))}>{t('上一页')}</button>}
        {rows.length === 50 && <button onClick={() => setPage([...page, rows[rows.length - 1]!.id])}>{t('下一页')}</button>}</footer>
    </div>
    <div className="request-detail">{row && <>
      <header className="request-heading"><h4>{row.model} <span className="request-id">#{row.id}</span></h4>
        <div className="request-meta"><span>{row.protocol}</span><span>{new Date(row.at).toLocaleString()}</span><span>{row.bytes.toLocaleString()} B</span>
          {!row.complete && <span className="request-warning">{t('发送未完成')}</span>}</div></header>
      {row.omitted ? <p role="status">{t('请求正文超过 50 MB 存储上限')}</p> : detail?.id !== selected || !detail ? <p role="status">{t('加载中…')}</p> : detail.body === null
        ? <p role="status">{t('无法读取请求正文')}</p> : <RequestBody key={row.id} body={detail.body} session={sessionId} row={row}/>}
    </>}</div>
  </div>;
}

export function ModelRequestsDialog({ sessionId, open, onClose, compact, recording, focusComposer }: {
  sessionId: string;
  open: boolean;
  onClose(): void;
  compact?: CompactAction;
  recording: ModelRequestRecording;
  focusComposer?(): void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const presence = usePresence(open);
  useOverlayDismiss(open && presence.mounted, onClose);
  const closeButton = React.useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open || !presence.mounted) return;
    const previous = document.activeElement;
    closeButton.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous !== document.body && previous.isConnected && !previous.closest('[inert]')) previous.focus();
      else focusComposer?.();
    };
  }, [open, presence.mounted, focusComposer]);
  if (!presence.mounted) return null;
  return createPortal(<div className="modal-mask mp-scrim model-requests-mask" data-mp-stage={presence.stage} {...(!open ? { inert: '' } : {})} aria-hidden={!open}
    onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-label={t('模型请求')} className="modal mp-panel model-requests" data-mp-stage={presence.stage}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:enabled, input:enabled, summary, [tabindex="0"]')).filter(el => !el.closest('[inert]'));
        const edge = event.shiftKey ? elements[0] : elements.at(-1);
        if (document.activeElement === edge) { event.preventDefault(); (event.shiftKey ? elements.at(-1) : elements[0])?.focus(); }
      }}>
      <div className="modal-head"><h3>{t('模型请求')}</h3><button ref={closeButton} className="modal-close" aria-label={t('关闭')} title={t('关闭')} onClick={onClose}><IconClose/></button></div>
      <RequestBrowser key={sessionId} sessionId={sessionId} compact={compact} recording={recording}/>
    </section>
  </div>, document.body);
}
