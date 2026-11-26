import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { ExtensionPublishingApi, ExtensionPublishingConnection, ExtensionPublishingSession, ExtensionSubmission, ExtensionSubmissionReview } from '../../../shared/extensionPublishing';
import { usePresence } from '../components/motion';
import { showTip } from '../tips';

export function useExtensionPublishing(api?: ExtensionPublishingApi) {
  const [session, setSession] = useState<ExtensionPublishingSession>();
  const [mine, setMine] = useState<ExtensionSubmission[]>([]);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!api) return;
    const request = ++generation.current;
    const current = await api.session().catch(error => {
      if (request === generation.current) { setSession(undefined); setMine([]); }
      throw error;
    });
    if (request !== generation.current) return;
    setSession(current);
    const submissions = current.login ? await api.mine() : [];
    if (request === generation.current) setMine(submissions);
  }, [api]);
  useEffect(() => {
    void refresh().catch(() => {});
    return () => { generation.current++; };
  }, [refresh]);
  const pending = mine.some(row => row.status === 'checking' || row.status === 'ready');
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void refresh().catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, [pending, refresh]);
  return { session, mine, refresh };
}

function PublishingDialog({ open, title, close, busy, children }: { open: boolean; title: string; close: () => void; busy: boolean; children: React.ReactNode }) {
  const { t } = useTranslation();
  const presence = usePresence(open);
  const id = useId(), ref = useRef<HTMLDialogElement | null>(null);
  const setDialog = useCallback((dialog: HTMLDialogElement | null) => {
    if (!dialog && ref.current?.open) ref.current.close();
    ref.current = dialog;
  }, []);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (open && dialog && !dialog.open) dialog.showModal();
  }, [open, presence.mounted]);
  if (!presence.mounted) return null;
  return createPortal(<dialog ref={setDialog} className="modal ext-publishing-dialog mp-panel" aria-labelledby={id} {...presence.spread}
    onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <header className="modal-head"><h3 id={id}>{title}</h3><button type="button" className="modal-close" disabled={busy} aria-label={t('关闭')} onClick={close}>×</button></header>
    {children}
  </dialog>, document.body);
}

export function SubmissionStatus({ submission }: { submission: ExtensionSubmission }) {
  const { t } = useTranslation();
  const label = { checking: t('初检中'), ready: t('待审核'), changes: t('需修改'), published: t('已上架') }[submission.status];
  return <span className={`ext-status ${submission.status === 'published' ? 'on' : 'warning'}`} role="status">{label}</span>;
}

export function ExtensionSubmissionDialog({ open, id, name, previous, api, session, close, submitted }: {
  open: boolean; id: string; name: string; previous?: ExtensionSubmission; api: ExtensionPublishingApi;
  session?: ExtensionPublishingSession; close: () => void; submitted: () => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [repository, setRepository] = useState(previous?.repository ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [invalid, setInvalid] = useState(false);
  const send = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (!session?.login) await api.signIn();
      await api.submit(id, repository.trim());
      submitted();
      close();
      showTip(t('扩展已上传，正在初检'));
    } catch (cause) {
      setError(String(cause));
      // Sign-in may have succeeded before GitHub rejected repository access.
      submitted();
    } finally { setBusy(false); }
  };
  return <PublishingDialog title={t('提交到扩展中心')} open={open} close={close} busy={busy}>
    <p>{name}</p>
    {previous?.status === 'changes' && previous.reason && <p>{previous.reason}</p>}
    <form className="ext-publishing-form" onSubmit={event => void send(event)}>
      <label htmlFor={fieldId}>{t('公开 GitHub 仓库地址')}</label>
      <input id={fieldId} name="repository" type="url" className="ui-input" autoFocus required readOnly={Boolean(previous)}
        autoCorrect="off" autoCapitalize="none" spellCheck={false} aria-invalid={invalid} aria-describedby={`${fieldId}-help`}
        value={repository} onInvalid={() => setInvalid(true)} onChange={event => { setRepository(event.currentTarget.value); setInvalid(false); setError(''); }} />
      <p className="ext-manager-desc" id={`${fieldId}-help`}>{t(previous ? '此次更新沿用已绑定的仓库。' : '选择你名下的公开空仓库。扩展文件会上传到该仓库。')}</p>
      <p role="status">{error || (busy ? (session?.login ? t('正在上传扩展…') : t('完成 GitHub 授权后会继续上传。')) : '')}</p>
      <div className="modal-actions">
        {error && session?.installUrl && <button className="btn" type="button" onClick={() => void api.authorizeRepository().catch(cause => setError(String(cause)))}>{t('授权仓库')}</button>}
        <button className="btn" type="button" disabled={busy} onClick={close}>{t('取消')}</button>
        <button className="btn primary" type="submit" disabled={busy}>{t('提交审核')}</button>
      </div>
    </form>
  </PublishingDialog>;
}

export function ExtensionPublishingAdminDialog({ open, api, session, close, refresh, refreshCatalog }: {
  open: boolean; api: ExtensionPublishingApi; session?: ExtensionPublishingSession;
  close: () => void; refresh: () => Promise<void>; refreshCatalog?: () => void;
}) {
  const { t } = useTranslation();
  const [connection, setConnection] = useState<ExtensionPublishingConnection>();
  const [working, setWorking] = useState(''), [error, setError] = useState('');
  const [review, setReview] = useState(false), [reviewBusy, setReviewBusy] = useState(false);
  const running = useRef(false);
  const reviewing = review && session?.reviewer === true;
  const synchronize = useCallback(async () => {
    setConnection(await api.connection());
    await refresh();
  }, [api, refresh]);
  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setWorking(label); setError('');
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { running.current = false; setWorking(''); }
  }, []);
  useEffect(() => {
    if (open) void run(t('正在检查发布服务…'), synchronize);
  }, [open, run, synchronize, t]);
  const toggleLocal = () => run(t(connection?.local ? '正在停止发布服务…' : '正在启动发布服务…'), async () => {
    const result = connection?.local ? await api.stopLocal() : await api.startLocal();
    if (!result.ok) throw new Error(result.error);
    if (result.canceled) return;
    refreshCatalog?.();
    await synchronize();
  });
  return <PublishingDialog open={open} title={t(reviewing ? '待审核' : '发布管理')} busy={reviewing && reviewBusy}
    close={() => { setReview(false); close(); }}>
    {reviewing ? <ExtensionReviewContent api={api} busy={reviewBusy} setBusy={setReviewBusy} back={() => setReview(false)}
      changed={() => { void refresh().catch(() => {}); refreshCatalog?.(); }} />
      : <div className="ext-publishing-form">
        {connection?.origin ? <p><code>{connection.origin}</code>{connection.local && <> · {t('本机服务')}</>}</p>
          : connection && <p>{t('尚未连接发布服务')}</p>}
        {session?.login && <p>GitHub · {session.login}{!session.reviewer && <> · {t('当前账号无审核权限')}</>}</p>}
        <p role="status">{working}</p>
        {error && <p role="alert">{error}</p>}
        <div className="modal-actions">
          {connection?.origin && <button type="button" className="btn" disabled={Boolean(working)}
            onClick={() => void run(t('正在检查发布服务…'), synchronize)}>{t('重新检测')}</button>}
          {connection && <button type="button" className="btn" disabled={Boolean(working)} onClick={() => void toggleLocal()}>
            {t(connection.local ? '停止本机服务' : '启动本机服务…')}
          </button>}
          {session?.available && !session.login && <button type="button" className="btn primary" disabled={Boolean(working)}
            onClick={() => void run(t('请在浏览器完成 GitHub 登录。'), async () => { await api.signIn(); await synchronize(); })}>{t('登录 GitHub')}</button>}
          {session?.reviewer === true && <button type="button" className="btn primary" disabled={Boolean(working)} onClick={() => setReview(true)}>{t('待审核')}</button>}
        </div>
      </div>}
  </PublishingDialog>;
}

function ExtensionReviewContent({ api, busy, setBusy, back, changed }: {
  api: ExtensionPublishingApi; busy: boolean; setBusy: (busy: boolean) => void; back: () => void; changed: () => void;
}) {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<ExtensionSubmission[]>([]), [detail, setDetail] = useState<ExtensionSubmissionReview>();
  const [error, setError] = useState(''), [returning, setReturning] = useState(false), [reason, setReason] = useState('');
  const reasonId = useId();
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (cause) { setError(String(cause)); changed(); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    let active = true;
    setBusy(true);
    void api.queue().then(rows => { if (active) setQueue(rows); }, cause => { if (active) setError(String(cause)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; setBusy(false); };
  }, [api, setBusy]);
  const decide = async (decision: 'approve' | 'return') => {
    if (!detail) return;
    await api.decide(detail.id, decision, decision === 'return' ? reason : undefined);
    setDetail(undefined); setReturning(false); setReason(''); setQueue(await api.queue()); changed();
    showTip(t(decision === 'approve' ? '扩展已上架' : '已退回修改'));
  };
  return <>
    <p role="status">{error || (busy ? t('处理中…') : '')}</p>
    {detail ? <div className="ext-publishing-form">
      <h4>{detail.name} · v{detail.version}</h4>
      <p>{t('发布者')} · {detail.report.release.publisherId}</p>
      <p>{t('初检通过 · {{files}} 个文件 · {{scripts}} 个脚本', { files: detail.report.fileCount, scripts: detail.report.syntaxChecked })}</p>
      <p>{t('声明权限')} · {detail.report.permissions.join(', ') || t('无')}</p>
      {detail.previous && <p>{t('上版权限')} · {detail.previous.permissions.join(', ') || t('无')}</p>}
      <p>{t('运行入口')} · {detail.report.domainEntry ?? detail.report.commandEntry ?? t('无')}</p>
      {detail.report.mcp.length > 0 && <p>MCP · {detail.report.mcp.join(', ')}</p>}
      <button className="ui-btn tiny" type="button" onClick={() => void window.api.shell.openExternal(detail.previous
        ? `${detail.repository}/compare/${detail.previous.commit}...${detail.commit}` : `${detail.repository}/commit/${detail.commit}`)}>{t(detail.previous ? '查看源码差异' : '查看源码')}</button>
      {returning && <><label htmlFor={reasonId}>{t('退回理由')}</label><textarea id={reasonId} className="ui-input" maxLength={2000} value={reason} onChange={event => setReason(event.currentTarget.value)} /></>}
      <div className="modal-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => { setDetail(undefined); setReturning(false); }}>{t('返回列表')}</button>
        <button type="button" className="btn" disabled={busy || returning} onClick={() => void run(async () => { await api.trial(detail.id); setDetail(await api.review(detail.id)); })}>{t(detail.trialed ? '再次试装' : '试装')}</button>
        <button type="button" className="btn" disabled={busy || (returning && !reason.trim())} onClick={() => returning ? void run(() => decide('return')) : setReturning(true)}>{t('退回修改')}</button>
        <button type="button" className="btn primary" disabled={busy || !detail.trialed || returning} onClick={() => void run(() => decide('approve'))}>{t('批准并发布')}</button>
      </div>
    </div> : queue.length ? <ul className="ext-review-queue">{queue.map(item => <li key={item.id}>
      <button type="button" className="ui-btn" disabled={busy} onClick={() => void run(async () => setDetail(await api.review(item.id)))}>{item.name} · v{item.version}</button>
    </li>)}</ul> : !busy && !error && <p>{t('暂无待审核扩展')}</p>}
    {!detail && <div className="modal-actions"><button type="button" className="btn" disabled={busy} onClick={back}>{t('返回发布管理')}</button></div>}
  </>;
}
