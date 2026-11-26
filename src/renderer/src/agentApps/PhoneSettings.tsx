import { ErrorTip } from '../components/ErrorTip';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppLibraryItem, AppSnapshot } from '../../../shared/agentApps';
import { builtInAgentApps } from '../../../shared/agentAppsBuiltins';
import { phoneAppName, phoneBuiltinDescription } from './appName';
import { localizeAppUserErrorText } from '../../../shared/appUserErrors';

const builtinIds = new Set(builtInAgentApps().map(app => app.id));
export function PhoneSettings({ workspaceId, snapshot, auto, setAuto, refresh }: { workspaceId: string; snapshot: AppSnapshot; auto: boolean; setAuto: (value: boolean) => void; refresh: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [deleteDataFor, setDeleteDataFor] = useState<Record<string, boolean>>({});
  const [library, setLibrary] = useState<AppLibraryItem[]>([]), [libraryRevision, setLibraryRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLibrary([]);
    void window.api.agentApps.listLibrary(workspaceId).then(items => { if (active) setLibrary(Array.isArray(items) ? items : []); }).catch(err => { if (active) setError(err instanceof Error ? err.message : String(err)); });
    return () => { active = false; };
  }, [workspaceId, libraryRevision]);
  const run = async (fn: () => Promise<unknown>, success: string) => { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await fn(); setNotice(success); refresh(); setLibraryRevision(revision => revision + 1); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); } };
  return <div className="ap-scroll ap-settings">
    {error && <ErrorTip message={error} />}{notice && <p role="status">{notice}</p>}
    <label className="ap-check"><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)}/>{t('自动展示 AI 的应用操作')}</label>
    <p className="ap-muted">{t('显示过程不影响 AI 的执行速度。编辑或打开设置时暂缓自动切页，退出后自动继续。')}</p>
      <h3>{t('应用库')}</h3>{library.map(item => <section className="ap-connection" key={item.catalogId}>
        <strong>{phoneAppName({ id: item.appId, name: item.name })}</strong><small>{phoneBuiltinDescription(item.appId, item.description)} · v{item.version}</small>
        {item.conflict && <small>{t('应用标识冲突')}</small>}
        {item.canManageVisibility && <label className="ap-check"><input type="checkbox" checked={!item.private} disabled={busy} onChange={e => void run(() => window.api.agentApps.setPrivate(workspaceId, item.appId, !e.target.checked), t('应用状态已保存'))}/>{t('共享到本机应用库')}</label>}
        {item.installedVersion === undefined ? <button type="button" aria-label={t('安装 {{name}}', { name: item.name })} disabled={busy} onClick={() => void run(() => window.api.agentApps.installFromLibrary(workspaceId, item.catalogId), t('应用已安装'))}>{t('安装')}</button>
          : item.updateAvailable ? <button type="button" aria-label={t('更新 {{name}}', { name: item.name })} disabled={busy} onClick={() => void run(() => window.api.agentApps.installFromLibrary(workspaceId, item.catalogId), t('应用已更新'))}>{t('更新')}</button>
            : item.installedVersion > item.version && item.canPublish !== false ? <button type="button" disabled={busy} onClick={() => void run(() => window.api.agentApps.publish(workspaceId, item.appId), t('应用已发布'))}>{t('发布新版本')}</button>
              : <small>{t('已安装')}</small>}
      </section>)}
      <h3>{t('我的应用')}</h3>{snapshot.apps.map(a => <div className="ap-app-setting" key={a.definition.id}>
        <label className="ap-check"><input type="checkbox" checked={a.enabled} disabled={busy} onChange={e => void run(() => window.api.agentApps.setEnabled(workspaceId, a.definition.id, e.target.checked), t('应用状态已保存'))}/>{phoneAppName(a.definition)}</label>
        {!builtinIds.has(a.definition.id) && <div className="ap-app-options">
          <label className="ap-check"><input type="checkbox" aria-label={t('同时删除 {{name}} 的数据', { name: phoneAppName(a.definition) })} checked={!!deleteDataFor[a.definition.id]} disabled={busy} onChange={e => setDeleteDataFor(old => ({ ...old, [a.definition.id]: e.target.checked }))}/>{t('同时删除数据')}</label>
          <button type="button" aria-label={t('卸载 {{name}}', { name: phoneAppName(a.definition) })} disabled={busy} onClick={() => void run(async () => { await window.api.agentApps.uninstall(workspaceId, a.definition.id, !!deleteDataFor[a.definition.id]); setDeleteDataFor(old => ({ ...old, [a.definition.id]: false })); }, t('应用已卸载'))}>{t('卸载')}</button>
        </div>}
      </div>)}
      <ErrorTip message={snapshot.errors.map(localizeAppUserErrorText).join('\n')} />
  </div>;
}
