import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { InboundMcpSetupStatus } from '../../../../shared/inboundMcp';
import { AdvancedDetails, SettingRow, SettingsRows, SettingsSection } from './shared';
import { SettingsPathControl } from './SettingsPathField';

/** Configuration health, never a claim that a CLI session is connected. */
export function useInboundMcpStatus(active = true) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<InboundMcpSetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const retrying = useRef(false);
  const mounted = useRef(false);
  const load = useCallback(async (repair = false): Promise<void> => {
    if (retrying.current) return;
    const request = ++generation.current;
    if (repair) { retrying.current = true; setBusy(true); }
    try {
      const next = await (repair ? window.api.inboundMcp.install() : window.api.inboundMcp.status());
      if (!next || !Array.isArray(next.engines)) throw new Error(t('无法读取自动配置状态'));
      if (mounted.current && request === generation.current) setStatus(next);
    } catch (error) {
      if (mounted.current && request === generation.current) setStatus({ ok: false, engines: [], error: String(error instanceof Error ? error.message : error) });
    } finally {
      if (repair) { retrying.current = false; if (mounted.current) setBusy(false); }
    }
  }, [t]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);
  useEffect(() => {
    if (!active) return;
    void load();
    const refresh = (): void => { void load(); };
    window.addEventListener('focus', refresh);
    const off = window.api.on('inboundMcp:changed', refresh);
    return () => { window.removeEventListener('focus', refresh); off(); generation.current++; };
  }, [active, load]);
  return { status, busy, load };
}

export function InboundMcpStatus({ active = true }: { active?: boolean }): React.JSX.Element {
  return <InboundMcpStatusView setup={useInboundMcpStatus(active)}/>;
}

export function InboundMcpStatusView({ setup }: { setup: ReturnType<typeof useInboundMcpStatus> }): React.JSX.Element {
  const { t } = useTranslation();
  const { status, busy, load } = setup;
  const failed = status?.ok === false;
  const undeclared = status?.engines.filter(engine => engine.state === 'unsupported' || engine.state === 'pending-workspace') ?? [];
  const hasFiles = status?.engines.some(engine => engine.state === 'configured');
  const summary = failed ? t('配置异常') : undeclared.length ? t('部分接入未声明') : hasFiles ? t('已配置') : t('由适配器接入');
  return <div className="cm-cli-setup" data-testid="inbound-mcp-status">
    <SettingsSection title={t('Harness 使用工作台工具')} side={<span className={`s-tag ${failed ? 'warn' : ''}`}>{busy ? t('正在配置…') : !status ? t('正在检查…') : summary}</span>}>
      <SettingsRows item="inbound-mcp">
        <SettingRow title={t('自动配置')} desc={t('按已注册 Harness 的可信声明自动配置。文件配置在新 CLI 会话生效；原生与会话接入由适配器提供，未声明的接入方式会明确标注。')}>
          <button type="button" className="btn" disabled={busy || !status} onClick={() => { void load(true); }}>{busy ? t('正在配置…') : failed ? t('重试配置') : t('重新检查')}</button>
        </SettingRow>
      </SettingsRows>
      {undeclared.length > 0 && <div className="cm-cli-warning" role="status"><strong>{t('部分 Harness 尚无可用的文件配置声明')}</strong>{undeclared.map(engine => <p key={engine.id}>{engine.label} · {engine.state === 'pending-workspace' ? t('等待工作区') : t('未声明支持')}{engine.detail ? ` · ${engine.detail}` : ''}</p>)}</div>}
      {status && <AdvancedDetails summary={t('查看 Harness 接入方式')}>{status.engines.map(engine => <div key={engine.id} className="cm-native-path"><strong>{engine.label}</strong><span>{engine.state === 'configured' ? t('配置文件已配置') : engine.state === 'native' ? t('原生工具接入') : engine.state === 'session' ? t('会话适配器接入') : engine.state === 'unsupported' ? t('未声明支持') : engine.state === 'pending-workspace' ? t('等待工作区') : t('配置异常')}</span>{engine.detail && <p>{engine.detail}</p>}{engine.path && <SettingsPathControl label={`${engine.label} · ${t('配置文件')}`} path={engine.path}/>}</div>)}</AdvancedDetails>}
      {failed && <div className="cm-cli-warning" role="alert">
        <strong>{t('部分 CLI 无法使用工作台工具')}</strong>
        {status.error && !status.engines.some(engine => engine.state === 'error') && <p>{status.error}</p>}
        {status.engines.filter(engine => engine.state === 'error').map(engine => <div key={engine.id}><strong>{engine.label}</strong><p>{engine.error || t('自动配置未完成，请重试。')}</p>{engine.path && <SettingsPathControl label={`${engine.label} · ${t('配置文件')}`} path={engine.path}/>}</div>)}
      </div>}
    </SettingsSection>
  </div>;
}
