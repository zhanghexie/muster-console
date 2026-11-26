import { app, session } from 'electron';
import { clearAttachments } from '../attachments/service';
import { deleteSessionHandover } from '../handover/paths';
import { StorageInventory } from '../storage/inventory';
import { StartupStorageMaintenance } from '../storage/startupMaintenance';
import { builtInAgentApps } from '../../shared/agentAppsBuiltins';
import type { LocalStorageSelection } from '../../shared/localStorage';
import type { AppContext } from '../context';
import { handle } from './handle';
import { t } from '../../shared/i18n';

export function registerLocalStorageIpc(ctx: AppContext): void {
  const browserSession = session.fromPartition('persist:browser');
  const userData = app.getPath('userData');
  const service = new StorageInventory({
    maintenance: new StartupStorageMaintenance(userData, app.getPath('sessionData')),
    browserStoragePath: browserSession.getStoragePath(),
    clearBrowserData: async () => {
      await browserSession.clearStorageData();
      try { await browserSession.clearCache(); }
      catch (error) { throw new Error(t('站点数据已清除，但缓存清理失败：{{error}}', { error: (error as Error)?.message || String(error) })); }
    },
    downloadStatus: file => ctx.browser?.downloadStatus(file) ?? 'unknown',
    downloadIdentity: file => {
      if (!ctx.browser) throw new Error(t('下载记录不可用。'));
      return ctx.browser.downloadIdentity(file);
    },
    removeDownload: (file, expected) => {
      if (!ctx.browser) throw new Error(t('下载记录不可用。'));
      ctx.browser.removeDownload(file, expected);
    },
    userData,
    workspaces: () => {
      const { workspaces, closedWorkspaces } = ctx.config.get();
      return [...workspaces, ...(closedWorkspaces ?? [])].map(({ id, name }) => ({ id, name }));
    },
    sessions: () => ctx.sessions.rootDependencyRoster(),
    themes: () => ctx.themes.list(),
    extensions: workspaceId => ctx.extensionSystem?.extensionNames(workspaceId) ?? [],
    extensionPackages: () => ctx.extensionSystem?.storagePackages() ?? [],
    verifyExtension: (id, fingerprint) => {
      if (!ctx.extensionSystem) throw new Error(t('扩展清理服务不可用。'));
      return ctx.extensionSystem.verifyStoragePackage(id, fingerprint);
    },
    disableExtension: (workspaceId, id, fingerprint) => {
      if (!ctx.extensionSystem) throw new Error(t('扩展清理服务不可用。'));
      return ctx.extensionSystem.disableStorageActivation(workspaceId, id, fingerprint);
    },
    uninstallExtension: (id, fingerprint) => {
      if (!ctx.extensionSystem) throw new Error(t('扩展清理服务不可用。'));
      return ctx.extensionSystem.uninstallStoragePackage(id, fingerprint);
    },
    apps: workspaceId => {
      if (!ctx.agentApps) throw new Error(t('应用服务尚未就绪'));
      return ctx.agentApps.snapshot(workspaceId);
    },
    builtinAppIds: new Set(builtInAgentApps().map(a => a.id)),
    removeSession: id => ctx.sessions.deleteLocalStorageSession(id),
    preflightWorktree: (id, dependents, discard) => ctx.sessions.preflightLocalStorageWorktree(id, dependents, discard),
    cleanupWorktree: (id, discard) => ctx.sessions.cleanupArchivedWorktree(id, { discard }),
    removeTheme: id => {
      const result = ctx.themes.remove(id);
      if (result.ok) ctx.getWindow()?.webContents.send('themes:changed', ctx.themes.payload());
      return result;
    },
    clearAttachments: scope => clearAttachments(app.getPath('userData'), scope),
    removeHandover: id => deleteSessionHandover(app.getPath('userData'), id),
    uninstallApp: (workspaceId, appId, deleteData) => {
      if (!ctx.agentApps) throw new Error(t('应用服务尚未就绪'));
      return ctx.agentApps.uninstall(workspaceId, appId, deleteData).catch(error => {
        const detail = (error as Error)?.message || String(error);
        const prefix = 'App was uninstalled, but image cleanup failed: ';
        if (detail.startsWith(prefix)) throw new Error(t('应用已卸载，但图片清理失败：{{error}}', { error: detail.slice(prefix.length) }));
        if (detail === 'App has operations in progress; retry uninstall after they finish') throw new Error(t('应用仍有操作进行中，请稍后重试。'));
        throw error;
      });
    }
  });
  handle('localStorage:scan', () => service.scan());
  handle('localStorage:startCleanup', (_event, snapshotId: string, selections: LocalStorageSelection[]) => service.startCleanup(snapshotId, selections));
  handle('localStorage:cleanupStatus', (_event, jobId: string) => service.cleanupStatus(jobId));
}
