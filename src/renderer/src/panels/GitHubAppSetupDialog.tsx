import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitHubAppInput, GitHubAppSetup, GitHubConnection } from '../../../shared/githubPr';
import { GITHUB_PR_APP_PERMISSIONS } from '../../../shared/githubPr';
import { AnimatedDetails } from '../components/AnimatedDetails';
import { AppConfirmDialog } from '../components/AppConfirmDialog';

const REGISTER_APP_URL = `https://github.com/settings/apps/new?${new URLSearchParams({
  url: 'https://github.com/zhanghexie/muster-console', public: 'false', webhook_active: 'false',
  ...GITHUB_PR_APP_PERMISSIONS
})}`;

export function GitHubAppSetupDialog({ open, connected, onSaved, onClose }: {
  open: boolean;
  connected: boolean;
  onSaved: (connection: GitHubConnection) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const id = useId();
  const appInput = useRef<HTMLInputElement>(null);
  const [setup, setSetup] = useState<GitHubAppSetup>();
  const [app, setApp] = useState('');
  const [clientId, setClientId] = useState('');
  const [manual, setManual] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [invalid, setInvalid] = useState<'app' | 'clientId'>();

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setSetup(undefined);
    setApp('');
    setClientId('');
    setManual(false);
    setError('');
    setInvalid(undefined);
    setLoading(true);
    void (async () => {
      try {
        const result = await window.api.pr.appSetup();
        if (!alive) return;
        if (result.ok) {
          const current = result.value.active;
          setSetup(result.value);
          setApp(current ? `https://github.com/apps/${current.slug}` : '');
          setClientId(current?.clientId ?? '');
        } else setError(result.message);
      } catch { if (alive) setError(t('读取 GitHub 设置失败，请重试')); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [open, t]);

  useLayoutEffect(() => {
    if (open && !loading) appInput.current?.focus({ preventScroll: true });
  }, [open, loading]);
  useLayoutEffect(() => {
    if (open && invalid === 'app' && !busy) appInput.current?.focus();
  }, [open, invalid, busy]);

  function clearError() {
    setError('');
    setInvalid(undefined);
  }

  async function save(input: GitHubAppInput | null) {
    if (busy || loading) return;
    setBusy(true);
    clearError();
    try {
      const result = await window.api.pr.configureApp(input);
      if (result.ok) onSaved(result.value);
      else {
        setError(result.message);
        if (result.kind === 'appLookup') { setManual(true); setInvalid('clientId'); }
        else if (result.kind === 'configuration') setInvalid(input?.clientId !== undefined ? 'clientId' : 'app');
      }
    } catch { setError(t('保存 GitHub 设置失败，请重试')); }
    finally { setBusy(false); }
  }

  const current = setup?.active;
  return <AppConfirmDialog open={open} title={t('配置 GitHub')} className="pr-setup-dialog"
    formId={id} busy={busy} confirmDisabled={loading} confirmLabel={t(connected ? '保存配置' : '保存并连接')}
    onCancel={onClose} content={
      <form id={id} className="pr-create-body" method="post" onSubmit={event => {
        event.preventDefault();
        void save({ app: app.trim(), ...(manual ? { clientId: clientId.trim() } : {}) });
      }}>
        <div className="pr-field">
          <label htmlFor={`${id}-app`} className="pr-field-label">{t('GitHub App 链接或名称')}</label>
          <input ref={appInput} id={`${id}-app`} name="app" className="pr-input" type="text" required
            value={app} maxLength={512} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
            disabled={loading || busy} placeholder="https://github.com/apps/your-app" aria-invalid={invalid === 'app' || undefined}
            aria-describedby={`${id}-app-help${invalid === 'app' ? ` ${id}-error` : ''}`}
            onChange={event => {
              setApp(event.target.value);
              if (current && clientId === current.clientId) setClientId('');
              clearError();
            }} />
          <p id={`${id}-app-help`} className="pr-muted">{t('公开 App 可直接从链接读取配置。')}</p>
        </div>
        <AnimatedDetails className="pr-setup-manual" summary={t('手动填写 Client ID')} open={manual}
          onToggle={value => { if (!busy && !loading) { setManual(value); clearError(); } }}>
          <div className="pr-field">
            <label htmlFor={`${id}-client`} className="pr-field-label">Client ID</label>
            <input ref={node => { if (node && invalid === 'clientId' && !busy) node.focus(); }}
              id={`${id}-client`} name="clientId" className="pr-input" type="text" required={manual}
              disabled={!manual || loading || busy} maxLength={100} autoComplete="off" autoCapitalize="none" autoCorrect="off"
              spellCheck={false} value={clientId} placeholder="Iv1.…" onChange={event => { setClientId(event.target.value); clearError(); }}
              aria-invalid={invalid === 'clientId' || undefined}
              aria-describedby={`${id}-client-help${invalid === 'clientId' ? ` ${id}-error` : ''}`} />
            <p id={`${id}-client-help`} className="pr-muted">{t('在 GitHub App 的设置页面复制 Client ID。')}</p>
          </div>
        </AnimatedDetails>
        {error && <p id={`${id}-error`} className="pr-muted pr-setup-error" role="alert">{error}</p>}
        <div className="pr-toolbar-actions">
          <button type="button" className="btn tiny" onClick={() => void window.api.shell.openExternal(REGISTER_APP_URL)}>
            {t('创建 GitHub App')}
          </button>
          {current && <button type="button" className="btn tiny" onClick={() => void window.api.shell.openExternal(
            `https://github.com/apps/${current.slug}/installations/new`)}>{t('在 GitHub 授权仓库')}</button>}
          {setup?.source === 'custom' && <button type="button" className="btn tiny" disabled={busy} onClick={() => void save(null)}>
            {t(setup.hasDefault ? '使用默认 App' : '移除本机配置')}
          </button>}
        </div>
        <p className="pr-muted">{t('新建 App 时请在 GitHub 勾选 Enable Device Flow。')}</p>
        {connected && <p className="pr-muted">{t('切换 GitHub App 后需要重新授权账号。')}</p>}
      </form>
    } />;
}
