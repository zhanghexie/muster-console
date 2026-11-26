import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExtensionCenterInstallProgress } from '../../../shared/extensionCenter';
import { IconDownload, IconSpinner, IconWarn } from '../components/icons';
import { usePresenceValue } from '../components/motion';

function downloadSize(bytes: number, locale: string): string {
  const [unit, divisor] = bytes >= 1_000_000 ? ['megabyte', 1_000_000] as const
    : bytes >= 1_000 ? ['kilobyte', 1_000] as const : ['byte', 1] as const;
  return (bytes / divisor).toLocaleString(locale, { style: 'unit', unit, maximumFractionDigits: 1 });
}

export function ExtensionCenterInstallStatus({ progress, pending, error }: {
  progress?: ExtensionCenterInstallProgress;
  pending: boolean;
  error?: string;
}): React.JSX.Element | null {
  const { t, i18n } = useTranslation();
  const labelId = useId();
  const status = usePresenceValue(progress || pending || error ? { progress, error } : null);
  if (!status.presence.mounted || !status.value) return null;

  const current = status.value.progress;
  const reason = status.value.error;
  const labels = {
    preparing: t('正在准备安装'),
    downloading: t('正在下载安装包'),
    verifying: t('正在校验安装包'),
    installing: t('正在安装扩展'),
  };
  const download = current?.phase === 'downloading' ? current : undefined;
  const total = download?.totalBytes;
  const locale = i18n.resolvedLanguage || i18n.language;
  return <div className="ext-center-install-feedback mp-panel" data-mp-stage={status.presence.stage} aria-hidden={status.presence.stage === 'out'}>
    {reason ? <div role="status" className="ext-center-install-error">
      <span className="ext-center-install-label"><IconWarn size={14} />{t('扩展安装失败')}</span>
      <p>{reason}</p>
    </div> : <>
      <div className="ext-center-install-line">
        <span id={labelId} role="status" className="ext-center-install-label">
          {total !== undefined ? <IconDownload size={14} /> : <IconSpinner size={14} />}
          {current ? labels[current.phase] : t('安装中…')}
        </span>
        {download && (total !== undefined || download.receivedBytes > 0) && <span className="ext-center-install-size">
          {total !== undefined ? <>
            <span>{downloadSize(download.receivedBytes, locale)} / {downloadSize(total, locale)}</span>
            <strong>{Math.floor(100 * download.receivedBytes / total)}%</strong>
          </> : t('已下载 {{size}}', { size: downloadSize(download.receivedBytes, locale) })}
        </span>}
      </div>
      {download && total !== undefined && <progress aria-labelledby={labelId} className="ext-center-install-progress" max={total} value={download.receivedBytes} />}
    </>}
  </div>;
}
