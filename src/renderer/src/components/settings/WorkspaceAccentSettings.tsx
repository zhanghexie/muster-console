import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceInfo } from '../../../../shared/types';
import {
  ACCENT_FOLLOW_AVATAR, WORKSPACE_ACCENTS, normalizeWorkspaceAccentDefault,
  hasWorkspaceAccentOverride, workspaceAccentChoice, resolveWorkspaceAccent,
  setWorkspaceAccentDefault, type WorkspaceAccentDefault
} from '../../../../shared/workspaceAccent';
import { extractAvatarAccent } from '../../avatarAccent';
import { Segmented, SettingRow, SettingsRows, SettingsSection, Switch } from './shared';

type Scope = 'global' | 'workspace';
interface View {
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: string | null;
  defaults: WorkspaceAccentDefault;
}

/** 主题色即时保存；范围切换只选择编辑对象，不清除工作区覆盖。 */
export function WorkspaceAccentSettings(): React.JSX.Element {
  const { t } = useTranslation();
  const [view, setView] = useState<View | null>(null);
  const [scope, setScope] = useState<Scope>('global');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void window.api.config.get().then(cfg => {
      if (!alive) return;
      const workspaces = cfg.workspaces ?? [];
      setView({ workspaces, activeWorkspaceId: cfg.activeWorkspaceId, defaults: normalizeWorkspaceAccentDefault(cfg.workspaceAccentDefault) });
      const ws = workspaces.find(w => w.id === cfg.activeWorkspaceId);
      if (ws && hasWorkspaceAccentOverride(ws)) setScope('workspace');
    }).catch(e => { if (alive) setError(String(e)); });
    const off = window.api.on('workspaces:changed', p => {
      setView(v => v ? {
        workspaces: p.workspaces, activeWorkspaceId: p.activeWorkspaceId,
        defaults: p.workspaceAccentDefault ? normalizeWorkspaceAccentDefault(p.workspaceAccentDefault) : v.defaults
      } : v);
    });
    return () => { alive = false; off(); };
  }, []);

  const ws = view?.workspaces.find(w => w.id === view.activeWorkspaceId);
  const targetScope = ws ? scope : 'global';
  const overridden = !!ws && hasWorkspaceAccentOverride(ws);
  const current = view ? (targetScope === 'workspace' && ws ? workspaceAccentChoice(ws, view.defaults) : view.defaults) : null;

  const commit = async (next: WorkspaceAccentDefault | null): Promise<void> => {
    if (!view || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      if (targetScope === 'global' && next) {
        const cfg = await window.api.config.update({ workspaceAccentDefault: next });
        const defaults = normalizeWorkspaceAccentDefault(cfg.workspaceAccentDefault);
        setWorkspaceAccentDefault(defaults);
        setView(v => v ? { ...v, defaults } : v);
      } else if (ws) {
        const patch = next
          ? { accent: next.accent, accentOff: !next.enabled, ...(next.accent === ACCENT_FOLLOW_AVATAR ? { avatarAccent: await extractAvatarAccent(ws.avatar) } : {}) }
          : { accent: null, accentOff: false };
        const result = await window.api.workspaces.update(ws.id, patch);
        if (!result.ok) throw new Error(result.message || t('保存失败'));
        if (result.workspaces) setView(v => v ? { ...v, workspaces: result.workspaces! } : v);
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  const swatch = current && ws ? resolveWorkspaceAccent({ ...ws, accent: current.accent, accentOff: false }) : WORKSPACE_ACCENTS[0];
  return (
    <SettingsSection title={t('主题色')} item="appearance-accent">
      {view && current ? <SettingsRows>
        <SettingRow title={t('应用范围')} desc={targetScope === 'global'
          ? t('作为所有工作区的默认；已单独设置的工作区保留自己的颜色。')
          : t('仅影响当前工作区「{{name}}」。', { name: ws?.name })}>
          <Segmented<Scope> label={t('主题色作用范围')} value={targetScope} disabled={busy}
            onChange={setScope} options={[
              { value: 'global', label: t('全局默认') },
              ...(ws ? [{ value: 'workspace' as const, label: t('仅当前工作区') }] : [])
            ]} />
        </SettingRow>
        {targetScope === 'workspace' && <SettingRow title={overridden ? t('当前工作区已单独设置') : t('当前工作区跟随全局默认')}
          desc={overridden ? t('恢复跟随后，将自动采用全局默认的开关和颜色。') : t('修改下方选项后，仅对此工作区生效。')}>
          {overridden && <button className="ui-btn tiny ghost" disabled={busy} onClick={() => void commit(null)}>{t('恢复跟随全局')}</button>}
        </SettingRow>}
        <SettingRow title={t('启用主题色')} desc={t('用于窗口框色和主要操作按钮；关闭后使用中性色。')}>
          <Switch label={t('启用主题色')} checked={current.enabled} disabled={busy} onChange={enabled => void commit({ ...current, enabled })} />
        </SettingRow>
        <SettingRow title={t('颜色')} stacked desc={t('跟随头像时，各工作区使用自己的头像颜色。')}>
          <div className={`workspace-accent-swatches${current.enabled ? '' : ' is-off'}`} role="group" aria-label={t('主题色颜色')}>
            <button className={`workspace-accent-avatar${current.accent === ACCENT_FOLLOW_AVATAR ? ' is-selected' : ''}`}
              aria-pressed={current.accent === ACCENT_FOLLOW_AVATAR} disabled={busy || !current.enabled}
              onClick={() => void commit({ ...current, accent: ACCENT_FOLLOW_AVATAR })}>
              {t('跟随头像')}
            </button>
            {WORKSPACE_ACCENTS.map(accent => <button key={accent} type="button"
              className={`workspace-accent-swatch${current.accent === accent ? ' is-selected' : ''}`}
              style={{ '--sw': accent } as React.CSSProperties} aria-label={accent} aria-pressed={current.accent === accent}
              disabled={busy || !current.enabled} onClick={() => void commit({ ...current, accent })} />)}
            <label className={`workspace-accent-custom${current.accent !== ACCENT_FOLLOW_AVATAR && !(WORKSPACE_ACCENTS as readonly string[]).includes(current.accent) ? ' is-selected' : ''}`}>
              {t('自定义颜色')}
              <input type="color" aria-label={t('自定义主题色')} value={current.accent === ACCENT_FOLLOW_AVATAR ? swatch : current.accent}
                disabled={busy || !current.enabled} onChange={e => void commit({ ...current, accent: e.target.value.toLowerCase() })} />
            </label>
          </div>
        </SettingRow>
      </SettingsRows> : <p className="empty-hint">{t('加载主题色…')}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </SettingsSection>
  );
}
