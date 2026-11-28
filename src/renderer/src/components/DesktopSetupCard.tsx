import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DesktopSetupIssue, DesktopSetupPermission, DesktopSetupStatus } from '../../../shared/desktopSetup';
import { usePresence } from './motion';
import './desktop-setup.css';

export function DesktopSetupNotice(): React.JSX.Element {
  const [notice, setNotice] = useState<DesktopSetupStatus | null>(null);
  useEffect(() => window.api.on('ui:desktopSetup', setNotice), []);
  return <DesktopSetupCard open={notice !== null} initialStatus={notice} onClose={() => setNotice(null)} />;
}

export function DesktopSetupCard({ open, initialStatus, onClose, id }: {
  open: boolean;
  initialStatus?: DesktopSetupStatus | null;
  onClose?: () => void;
  id?: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const heading = useId();
  const presence = usePresence(open);
  const [status, setStatus] = useState<DesktopSetupStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const revision = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++revision.current;
    setChecking(true);
    setOpenFailed(false);
    setReadFailed(false);
    try {
      const next = await window.api.desktopSetup.status();
      if (!next || !Array.isArray(next.issues)) throw new Error('Desktop setup status is unavailable');
      if (current === revision.current) setStatus(next);
    } catch {
      if (current === revision.current) {
        setStatus(null);
        setReadFailed(true);
      }
    } finally {
      if (current === revision.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setStatus(initialStatus ?? null);
    setReadFailed(false);
    setOpening(false);
    setOpenFailed(false);
    if (initialStatus) setChecking(false);
    else void refresh();
    return () => { ++revision.current; };
  }, [open, initialStatus, refresh]);

  const openSettings = async (permission: DesktopSetupPermission): Promise<void> => {
    if (!open || checking || opening) return;
    const current = revision.current;
    setOpening(true);
    setOpenFailed(false);
    try {
      const result = await window.api.desktopSetup.openSettings(permission);
      if (current === revision.current) setOpenFailed(!result.ok);
    } catch {
      if (current === revision.current) setOpenFailed(true);
    } finally {
      if (current === revision.current) setOpening(false);
    }
  };

  if (!presence.mounted) return null;
  function issueTitle(issue: DesktopSetupIssue): string {
    switch (issue.code) {
      case 'permission_required': return t('缺少 macOS 授权');
      case 'permission_check_failed': return t('无法检测 macOS 授权');
      case 'capability_unsupported': return t('桌面后端不可用');
      case 'dependency_missing': return t('缺少桌面驱动');
      case 'screen_locked': return t('Mac 屏幕已锁定，请解锁后重新检测。');
      case 'desktop_session_unavailable': return t('桌面会话不可用');
    }
  }

  const ready = status?.macApp
    ? t('当前进程已检测到屏幕录制和辅助功能授权，可以直接重试电脑操作。')
    : t('已找到桌面后端和驱动。');
  const readError = t('无法读取电脑操作状态，请重新检测。');
  const openError = t('无法打开系统设置。请手动进入「系统设置 → 隐私与安全性」，选择对应权限项。');
  const busy = checking || opening;
  return <article id={id} className={`desktop-setup-card mp-panel${onClose ? ' desktop-setup-notice mp-panel-top' : ''}`}
    {...presence.spread} aria-labelledby={heading} aria-hidden={!open || undefined}
    ref={node => { if (node) node.inert = !open; }}>
    <h3 id={heading}>{t('电脑操作状态')}</h3>
    <div className="desktop-setup-content">
      <p className="desktop-setup-announcement" role="status">
        {openFailed ? openError : checking ? '' : readFailed ? readError : status?.issues.map(issueTitle).join(' · ') || (status ? ready : '')}
      </p>
      {checking && !status?.issues.length && <p>{t('正在检测电脑操作状态…')}</p>}
      {readFailed && <p>{readError}</p>}
      {!checking && status?.issues.length === 0 && <p>{ready}</p>}
      {status?.issues.map(issue => <div key={issue.code} className="desktop-setup-issue">
        <strong>{issueTitle(issue)}</strong>
        {issue.code === 'permission_required' && status.macApp ? <>
          <ul className="desktop-setup-permissions">
            {issue.permissions.map(permission => <li key={permission}>
              <div className="desktop-setup-permission">
                <div><b>{permission === 'screenRecording' ? t('屏幕与系统音频录制') : t('辅助功能')}</b>
                  <p>{permission === 'screenRecording' ? t('用于截取显示器画面。') : t('用于读取窗口内容和控制应用。')}</p></div>
                <button type="button" className="btn" aria-disabled={busy} onClick={() => void openSettings(permission)}>
                  {permission === 'screenRecording' ? t('打开屏幕录制设置') : t('打开辅助功能设置')}
                </button>
              </div>
            </li>)}
          </ul>
          <p>{status.macApp === 'electron'
            ? t('请为当前运行的 Electron.app 勾选权限。开发版和安装版需要分别授权。')
            : t('请为 Muster Console.app 勾选权限。开发版和安装版需要分别授权。')}</p>
          <p>{t('用「+」添加未列出的应用。勾选后重新检测。')}</p>
          <p>{t('如果 macOS 要求退出，或检测仍显示缺少权限，请完全退出并重新打开当前应用，再检测一次。')}</p>
        </> : issue.code !== 'permission_required' && issue.code !== 'permission_check_failed' && issue.detail ? <p>{issue.detail}</p> : null}
        {issue.code === 'permission_check_failed' && <p>{t('请重新检测。如果仍无法读取授权，请退出并重新打开当前应用。')}</p>}
      </div>)}
      {openFailed && <p>{openError}</p>}
    </div>
    <footer className="desktop-setup-actions">
      <button type="button" className="btn" aria-disabled={busy} onClick={() => { if (open && !busy) void refresh(); }}>
        {checking ? t('检测中…') : t('重新检测')}
      </button>
      {onClose && <button type="button" className="btn ghost" aria-label={t('关闭电脑操作提示')}
        onClick={() => { if (open) onClose(); }}>{t('关闭')}</button>}
    </footer>
  </article>;
}
