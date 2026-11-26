import { ErrorTip } from '../ErrorTip';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClaudeGuiStatus } from '../../../../shared/claudeGui';
import { FieldRow, SettingsSection, SettingRow, Switch } from './shared';
import { SettingsPathField } from './SettingsPathField';

/** Reads local files only. A found configuration is never presented as verified authentication. */
export function ClaudeAccountSettings({ isolated, busy, onChange }: { isolated: boolean; busy: boolean; onChange: (value: boolean) => Promise<void> }): React.JSX.Element {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ClaudeGuiStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  const saveRequest = useRef(0);
  useEffect(() => () => { ++saveRequest.current; }, []);
  const request = useRef(0);
  const read = (): void => {
    const current = ++request.current;
    setLoading(true); setError(''); setStatus(null);
    void window.api.agentSession.claudeStatus().then(result => { if (current === request.current) setStatus(result); })
      .catch(cause => { if (current === request.current) setError((cause as Error).message); })
      .finally(() => { if (current === request.current) setLoading(false); });
  };
  useEffect(() => { read(); return () => { ++request.current; }; }, [isolated]);
  const changeSource = async (next: boolean): Promise<void> => {
    const current = ++saveRequest.current;
    setSaving(true); setSaveError(''); setSaved(false);
    try { await onChange(next); if (current === saveRequest.current) setSaved(true); }
    catch (cause) { if (current === saveRequest.current) setSaveError((cause as Error).message || String(cause)); }
    finally { if (current === saveRequest.current) setSaving(false); }
  };
  return <SettingsSection title={t('账号与配置')} item="worker-claude-gui"
    desc={t('登录、服务地址与默认模型由 Claude Code 配置管理。下方显示当前聊天使用的配置。')}
    side={<button type="button" className="btn tiny" disabled={loading || busy || saving} onClick={read}>{t(loading ? '读取本机配置中…' : '重新读取配置')}</button>}>
    <SettingRow title={t('使用独立配置目录')} desc={t('仅用于工作台聊天；开启后需在独立目录登录或配置服务，终端不变。')}>
      <Switch label={t('使用独立配置目录（不复用 ~/.claude；需在该目录重新登录或配中转）')} checked={isolated} disabled={busy || saving} onChange={next => void changeSource(next)}/>
    </SettingRow>
    {saved ? <p className="settings-ok" role="status">{t('聊天配置已保存')}</p> : null}
    {saveError ? <ErrorTip message={saveError} /> : null}
    {status ? <div className="worker-config-fields">
      <SettingsPathField label={t('配置目录')} path={status.configDir} tip={t(isolated ? '当前使用独立配置' : '当前复用本机配置')}/>
      <FieldRow label={<span className="s-path-label">{t('配置中的默认模型')}<span className="s-field-readonly">{t('只读')}</span></span>}>
        <input className="s-input" readOnly aria-label={t('配置中的默认模型')} value={status.model || t('跟随 Claude Code 默认设置')}/>
      </FieldRow>
    </div> : null}
    {error ? <ErrorTip message={error} /> : null}
  </SettingsSection>;
}
