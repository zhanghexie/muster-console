import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WebAccessStatusInfo } from '../../../shared/webAccess';
import { BrandLoader } from '../components/BrandLoader';
import { IconCopy, IconGlobe, IconPhone } from '../components/icons';
import { SetupActions, SetupNext, useSetupAction } from './SetupParts';

export function ConnectRemote({ back, next, onSkip }: { back: () => void; next: () => void; onSkip: () => void }): React.JSX.Element {
  const { t } = useTranslation();
  const [connection, setConnection] = useState<Pick<WebAccessStatusInfo, 'qrDataUrl'> & { url: string }>();
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useSetupAction();
  const hostname = connection ? URL.parse(connection.url)?.hostname : undefined;
  const localOnly = !!hostname && (hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.'));

  const reveal = (): void => void run(async () => {
    const status = await window.api.webAccess.status();
    const url = status.urls[0];
    if (!status.running || !url) throw new Error(status.disabledReason || t('网页访问未启动'));
    setConnection({ url, qrDataUrl: status.qrDataUrl });
  });

  return <>
    {connection ? <div className="setup-card setup-remote-card">
      {connection.qrDataUrl && !localOnly && <img src={connection.qrDataUrl} width={132} height={132} alt={t('网页访问二维码')} />}
      <div className="setup-remote-details">
        <strong>{localOnly ? t('当前地址仅可在这台电脑上打开') : t('用手机相机扫码，或在浏览器打开地址')}</strong>
        {localOnly && <p>{t('如需在手机上访问，先连接同一网络，再到远程访问设置查看地址。')}</p>}
        <p>{t('连接地址带有访问密钥，请只在自己的设备上使用。')}</p>
        <button className="btn" type="button" disabled={busy} onClick={() => void run(async () => {
          try {
            await navigator.clipboard.writeText(connection.url);
            setCopied(true);
          } catch {
            throw new Error(t('无法复制连接地址，请在远程访问设置中手动复制。'));
          }
        })}><IconCopy />{copied ? t('已复制') : t('复制连接地址')}</button>
      </div>
    </div> : <div className="setup-card setup-row">
      <span className="setup-row-icon"><IconPhone size={20} /></span>
      <div className="setup-row-text"><strong>{t('浏览器远程访问')}</strong>
        <span>{t('手机或另一台电脑与这台电脑连上同一网络后即可访问。')}</span>
      </div>
    </div>}
    {error && <p className="setup-error" role="alert">{error}</p>}
    <SetupActions back={back} busy={busy}>
      <button type="button" className="btn ghost" disabled={busy} onClick={onSkip}>{t('稍后连接')}</button>
      {connection ? <SetupNext onClick={next} disabled={busy} /> :
        <button type="button" className="btn primary" disabled={busy} onClick={reveal}>
          {busy ? <BrandLoader size={16} /> : <IconGlobe />}{t('显示连接方式')}
        </button>}
    </SetupActions>
  </>;
}
