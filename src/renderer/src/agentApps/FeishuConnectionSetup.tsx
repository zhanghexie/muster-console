import { ErrorTip } from '../components/ErrorTip';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localizeAppUserErrorText } from '../../../shared/appUserErrors';
import type { AppFeishuStatus } from '../../../shared/agentApps';
import { usePresenceValue } from '../components/motion';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Connect one dedicated robot. Conversations are discovered by incoming messages. */
export function FeishuConnectionSetup({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AppFeishuStatus>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mounted = useRef(false), revision = useRef(0);
  const qr = usePresenceValue(status?.appBound ? null : status?.onboarding);
  const readStatus = useCallback(async () => {
    const current = ++revision.current;
    setError('');
    try {
      const next = await window.api.agentApps.feishuStatus(workspaceId);
      if (mounted.current && current === revision.current) setStatus(next);
    } catch (err) { if (mounted.current && current === revision.current) setError(message(err)); }
  }, [workspaceId]);
  useEffect(() => {
    mounted.current = true; setStatus(undefined);
    const unsubscribe = window.api.on('agentApps:feishuStatus', next => {
      if (next.workspaceId === workspaceId) { revision.current++; setStatus(next); }
    });
    void readStatus();
    return () => { mounted.current = false; revision.current++; unsubscribe(); };
  }, [workspaceId, readStatus]);
  const authorize = async (cancel = false) => {
    if (busy) return;
    setBusy(true); setError('');
    const current = revision.current;
    try {
      if (cancel) await window.api.agentApps.cancelFeishuSetup(workspaceId);
      else {
        const result = await window.api.agentApps.startFeishuSetup(workspaceId);
        if (!result.ok) throw new Error(result.error || t('扫码接入失败，请重试'));
        if (mounted.current && current === revision.current && result.url) setStatus(old => old && !old.appBound ? { ...old, onboarding: { url: result.url!, qrDataUrl: result.qrDataUrl } } : old);
      }
      if (mounted.current) await readStatus();
    } catch (err) { if (mounted.current) setError(message(err)); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <section className="ap-feishu-setup" aria-label={t('连接飞书')}>
    {error && <ErrorTip message={error} />}
    {!status && !error && <p role="status" className="ap-muted">{t('正在检查手机专用机器人…')}</p>}
    {status?.appBound ? <>
      <p className="ap-feishu-connected">{status.receiving ? t('✓ 手机机器人已连接') : t('手机机器人已配置')}</p>
      <p className="ap-muted">{t('私信和 @ 机器人的群消息会自动出现在短信中，直接打开对话即可回复。')}</p>
      {!status.receiving && !status.lastError && !status.pairingError && <p role="status" className="ap-muted">{t('正在连接收信服务…')}</p>}
    </> : status && <>
      <p className="ap-muted">{t('为这台手机扫码创建一个专用机器人。接入一次，就能自动接收私信和群里的 @ 消息。')}</p>
      {!status.cliReady && <ErrorTip message={t('飞书组件未安装，请重新安装完整版工作台。')} />}
      {!status.onboarding && <button type="button" className="ap-primary" disabled={busy || status.starting || !status.cliReady} onClick={() => void authorize()}>{busy || status.starting ? t('正在生成二维码…') : t('扫码创建专用机器人')}</button>}
    </>}
    {qr.presence.mounted && qr.value && <div className="ap-feishu-qr mp-panel" {...qr.presence.spread} {...(status?.appBound ? { inert: '' as unknown as boolean } : {})}>
      {qr.value.qrDataUrl ? <img src={qr.value.qrDataUrl} alt={t('飞书接入二维码')}/> : <p role="status">{t('二维码生成中…')}</p>}
      <p className="ap-muted">{t('用飞书扫一扫并完成创建，之后直接给机器人发消息。')}</p>
      <a href={qr.value.url} target="_blank" rel="noreferrer">{t('在浏览器打开授权页')}</a>
      <button type="button" disabled={busy} onClick={() => void authorize(true)}>{t('取消扫码')}</button>
    </div>}
    {(status?.lastError || status?.pairingError) && <ErrorTip message={localizeAppUserErrorText(status.lastError || status.pairingError!)} />}
    {(error || status?.lastError || status?.pairingError) && <button type="button" disabled={busy} onClick={() => void authorize()}>{t('重试连接')}</button>}
  </section>;
}
