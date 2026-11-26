import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UpdaterStatus } from '../../../../shared/updater';
import { PRODUCT_NAME_ZH } from '../../../../shared/productIdentity';
import { SettingRow, SettingsRows, SettingsSection } from './shared';
import { FeedbackPane } from './FeedbackPane';

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function formatTime(ts: number | undefined): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return '';
  }
}

/** 「关于」页：版本号 + 检查更新/下载进度/重启安装（主进程 updater 状态机的渲染层镜像）。 */
export function AboutPane(): React.JSX.Element {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UpdaterStatus | null>(null);
  const [revealMiss, setRevealMiss] = useState(false);

  useEffect(() => {
    let mounted = true;
    void window.api.updater.getState().then((s) => {
      if (mounted) setStatus(s);
    });
    const off = window.api.on('updater:status', (s) => setStatus(s));
    return () => {
      mounted = false;
      off();
    };
  }, []);

  // 状态机任何迁移都视为新局面，清掉上一态的「安装包缺失」提示
  useEffect(() => {
    setRevealMiss(false);
  }, [status]);

  const check = (): void => {
    void window.api.updater.check();
  };

  const reveal = (): void => {
    void window.api.updater.revealInstaller().then((ok) => setRevealMiss(!ok));
  };

  const stateLine = (): React.ReactNode => {
    if (!status) return null;
    if (status.state === 'idle') {
      return status.checkedAt
        ? `${t('已是最新版本')} · ${formatTime(status.checkedAt)}`
        : t('尚未检查更新');
    }
    if (status.state === 'checking') return t('正在检查更新…');
    if (status.state === 'downloading' && !status.progress) {
      return `${t('发现新版本，正在准备下载…')}${status.availableVersion ? ` v${status.availableVersion}` : ''}`;
    }
    if (status.state === 'downloading' && status.progress) {
      const size = formatBytes(status.progress.total)
        ? ` · ${formatBytes(status.progress.transferred)}/${formatBytes(status.progress.total)}`
        : '';
      const speed = formatBytes(status.progress.bytesPerSecond)
        ? ` · ${formatBytes(status.progress.bytesPerSecond)}/s`
        : '';
      return `${t('正在下载')} v${status.availableVersion ?? ''} · ${Math.round(status.progress.percent)}%${size}${speed}`;
    }
    if (status.state === 'downloaded') {
      return `${t('新版本已就绪')}${status.availableVersion ? ` v${status.availableVersion}` : ''}`;
    }
    if (status.state === 'error') {
      return `${t('检查更新失败')}: ${status.errorMessage ?? t('网络不可用或更新源不可达')}`;
    }
    return null;
  };

  return (
    <div className="settings-section about-pane">
      {status ? <SettingsSection title={t('版本')} item="about-update">
        <SettingsRows>
          <SettingRow
            title={<span>{t(PRODUCT_NAME_ZH)} <code className="mono">v{status.currentVersion}</code></span>}
            desc={
              status.state === 'unsupported'
                ? t('自动更新仅在 Windows 安装版（NSIS 安装包）上启用；macOS / Linux 请手动下载新安装包。')
                : stateLine()
            }
          >
            {status.state !== 'unsupported' ? (
              <button
                type="button"
                className="btn tiny"
                disabled={
                  status.state === 'checking' ||
                  status.state === 'downloading' ||
                  status.state === 'downloaded'
                }
                onClick={check}
              >
                {status.state === 'checking' ? t('检查中…') : t('检查更新')}
              </button>
            ) : null}
          </SettingRow>
          {status.state === 'downloading' && status.progress ? (
            <SettingRow title={t('下载进度')} desc={
              formatBytes(status.progress.bytesPerSecond)
                ? `${formatBytes(status.progress.bytesPerSecond)}/s`
                : undefined
            }>
              <div className="about-progress" style={{ width: 160 }}>
                <div className="about-progress-fill" style={{ width: `${Math.min(100, Math.max(0, status.progress.percent))}%` }} />
              </div>
            </SettingRow>
          ) : null}
          {status.state === 'downloaded' ? (
            <SettingRow
              title={t('新版本已就绪')}
              desc={revealMiss ? t('安装包已被清理，请重新检查更新') : t('不立即重启也可以：退出应用时会自动完成安装。')}
            >
              <button type="button" className="btn tiny" onClick={() => void window.api.updater.install()}>
                {t('重启并安装更新')}
              </button>
              <button type="button" className="btn ghost tiny" onClick={reveal}>
                {t('打开安装包文件夹')}
              </button>
            </SettingRow>
          ) : null}

          <SettingRow
            title={t('自动更新')}
            desc={t('发现新版本自动下载，退出应用时完成安装。')}
          >
            <span className={`s-tag ${status.state === 'unsupported' ? '' : 'ok'}`}>
              {status.state === 'unsupported' ? t('此平台不适用') : t('已启用')}
            </span>
          </SettingRow>
        </SettingsRows>
      </SettingsSection> : <p className="empty-hint">{t('加载版本信息…')}</p>}
      <FeedbackPane />
    </div>
  );
}
