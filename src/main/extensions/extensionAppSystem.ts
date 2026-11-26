import { executeExtensionHostTool } from './executeExtensionHostTool';
import { app, dialog, safeStorage, shell } from 'electron';
import type { AppContext } from '../context';
import { createExtensionAppHost } from './extensionAppAdapter';
import { ExtensionManagementService } from './extensionManagement';
import { ExtensionWorkbench } from './extensionWorkbench';
import { ExtensionAuthoringService } from './extensionAuthoring';
import { ExtensionAuthoringServices } from './extensionAuthoringServices';
import { createExtensionSafetyReviewer } from './extensionSafety';
import { ExtensionSourceLayout } from './extensionSourceLayout';
import { ExtensionPackageCatalog } from './extensionPackageCatalog';
import { ExtensionCenterService } from './extensionCenter';
import { approvedCommunityCatalogUrl } from './extensionPublishingClient';
import { extensionTrialTarget } from './extensionTrialEnvironment';
import { ExtensionHost } from './extensionHost';
import { ExtensionDevelopmentTrustStore } from './extensionDevelopmentTrust';
import { ensureExtensionStorageRoot, extensionWorkspaceActivationPath, ExtensionWorkspaceActivationStore } from './extensionWorkspaceActivation';
import { installBundledSamples, installLocalPackage, refreshDevelopmentPackage, refreshDevelopmentSample, SAMPLE_IDS } from './extensionSampleInstaller';
import { llmChat, llmChatStream } from './extensionLlm';
import { ExtensionMediaStore } from './extensionMediaStore';
import { ExtensionExportService } from './extensionExportService';
import { ExtensionModelGateway } from './extensionModelGateway';
import { defaultRootFor } from '../../shared/workspaceRoots';
import fs from 'node:fs';
import path from 'node:path';
import type { ExtensionDiscoveredExtension, ExtensionTransactionPreserveResult } from '../../shared/extension';
import { t } from '../../shared/i18n';

/** Construct the complete extension application services around the single package host. */
export function createExtensionAppSystem(ctx: AppContext) {
  let workbench: ExtensionWorkbench | undefined;
  let started = false, stopped = false;
  let preparation: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const publish = (): void => {
    if (stopped) return;
    for (const listener of listeners) try { listener(); } catch (error) { console.error('[extension] listener failed:', error); }
    const win = ctx.getWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send('extensions:changed', {});
    try { if (workbench && ctx.config.get().activeWorkspaceId) win.webContents.send('workbench:changed', workbench.sync()); }
    catch (error) { console.error('[extension] navigation refresh failed:', error); }
  };
  const adapter = createExtensionAppHost(ctx);
  const userData = adapter.userDataDirectory;
  const sourceLayout = new ExtensionSourceLayout({ userData });
  const catalog = new ExtensionPackageCatalog({ layout: sourceLayout });
  const extensionCenter = new ExtensionCenterService(userData, sourceLayout.globalRoot, catalog, { hostVersion: app.getVersion(), communityCatalogUrl: approvedCommunityCatalogUrl() });
  ensureExtensionStorageRoot(userData);
  const activation = new ExtensionWorkspaceActivationStore(extensionWorkspaceActivationPath(userData));
  const isWorkspaceActivated = (input: { workspaceId: string; extensionId: string; scope: 'global' | 'project'; controlRoot?: string; }): boolean => {
    const record = catalog.get(input.scope, input.extensionId, input.controlRoot);
    return activation.isEnabled(input, record?.enabled ?? true);
  };
  const developmentTrust = new ExtensionDevelopmentTrustStore(userData, extensionCenter);
  const mediaStore = new ExtensionMediaStore(userData);
  const exportService = new ExtensionExportService(mediaStore);
  const modelGateway = new ExtensionModelGateway(ctx.config, mediaStore, safeStorage);
  adapter.agent.setModelGateway(modelGateway);
  const extensionHost = new ExtensionHost(catalog, adapter.agent, developmentTrust, async (title, detail, signal) => (await ctx.ui.confirm(title, detail, { dangerous: true, signal })).confirmed,
    async (identity, name, rawArgs) => {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs as Record<string, unknown> : {};
      if (name !== 'dispatch') throw new Error(`Unknown extension panel command: ${name}`);
      if (args.mode === 'list') return ctx.runtimes.list().filter(runtime => runtime.enabled).map(runtime => ({ id: runtime.id, label: runtime.label }));
      if (args.mode === 'focus') { if (typeof args.sessionId !== 'string') throw new Error('缺少 sessionId'); await ctx.sessions.select(args.sessionId); return { ok: true, sessionId: args.sessionId }; }
      if (args.mode !== 'dispatch' || typeof args.runtimeId !== 'string' || typeof args.name !== 'string') throw new Error('缺少派活参数');
      const workspace = ctx.config.get().workspaces.find(item => item.id === identity.workspaceId);
      if (!workspace) throw new Error('工作区不存在');
      const root = identity.sourceRootId ? workspace.roots?.find(item => item.id === identity.sourceRootId) : defaultRootFor(workspace);
      if (!root) throw new Error('扩展源码根不存在');
      const session = await ctx.sessions.createTerminal({ name: args.name.slice(0, 60), runtime: args.runtimeId, cwd: root.path, workspaceId: identity.workspaceId, rootId: root.id, activate: false });
      if (!ctx.agentSessions) throw new Error('Agent Session host unavailable');
      await ctx.agentSessions.send(session.id, typeof args.task === 'string' ? args.task : args.name, undefined, { steerOnBusy: false });
      return { ok: true, sessionId: session.id };
    },
    (identity, messages, options, signal) => llmChat(ctx, identity.extensionId, messages, options, `extension:${identity.extensionInstanceId}`, signal),
    (identity, messages, options, signal, onDelta) => llmChatStream(ctx, identity.extensionId, messages, options, onDelta, `extension:${identity.extensionInstanceId}`, signal),
    undefined, ctx, mediaStore, async () => {
      const win = ctx.getWindow();
      const result = win ? await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: '选择扩展媒体文件' }) : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], title: '选择扩展媒体文件' });
      return result.canceled ? [] : result.filePaths;
    }, exportService, modelGateway, (context, name, raw, signal) => executeExtensionHostTool(ctx, context, name, raw, signal), isWorkspaceActivated);
  const syncCatalog = (): Promise<void> => {
    return catalog.syncGlobal().then(() => undefined).catch(error => { console.error('[extension] global catalog scan failed:', error); });
  };
  const ensureLegacyActivations = async (): Promise<void> => {
    const workspaceIds = ctx.config.get().workspaces.map(workspace => workspace.id);
    for (const record of catalog.list('global')) {
      const inputs = workspaceIds.map(workspaceId => ({ workspaceId, scope: 'global' as const, extensionId: record.extensionId }));
      await activation.ensure(inputs, record.enabled);
    }
  };
  const management = new ExtensionManagementService(catalog, () => ctx.config.get().workspaces, publish, () => workbench?.navigation.recoveryWarning ?? null, () => null, activation);
  workbench = new ExtensionWorkbench(ctx, management, catalog, extensionHost);
  const authoringServices = new ExtensionAuthoringServices({ userData, catalog, sourceLayout, workspaces: () => ctx.config.get().workspaces, review: createExtensionSafetyReviewer(ctx), changed: publish, enabled: input => activation.isEnabled({ workspaceId: input.workspaceId, scope: input.scope, extensionId: input.extensionId, ...(input.controlRoot ? { controlRoot: input.controlRoot } : {}) }, input.fallback), enabledInAnyWorkspace: id => management.isGlobalEnabledAnywhere(id) });
  const authoring = new ExtensionAuthoringService(authoringServices, () => ctx.config.get().workspaces);
  const developmentSamples = new Map<string, string>();
  const development = process.env.NODE_ENV_ELECTRON_VITE === 'development';
  if (development) extensionHost.setReloadPreparation(async (id, installed) => {
    const baseline = developmentSamples.get(id);
    if (baseline) {
      developmentSamples.set(id, await refreshDevelopmentSample(userData, installed, id, baseline));
      return;
    }
    // Local authoring packages are installed into the profile, so a normal
    // iframe reload would otherwise keep serving the stale installed copy.
    // In development, sync the conventional repository package before the
    // host verifies its fresh fingerprint.
    const candidates = [path.join(process.cwd(), 'extensions', id), path.join(process.cwd(), 'resources', 'extensions', id)];
    const source = candidates.find(candidate => fs.existsSync(path.join(candidate, 'extension.json')));
    if (source) await refreshDevelopmentPackage(installed, source, id);
  });
  const installSamples = async () => {
    const result = await installBundledSamples(userData, sourceLayout.globalRoot, undefined, undefined, {
      overwriteExisting: development,
      installedFingerprint: (id, fingerprint) => developmentSamples.set(id, fingerprint)
    });
    await syncCatalog();
    return result;
  };
  const installLocal = async (directory: string): Promise<{ extensionId: string }> => {
    const extensionId = await installLocalPackage(userData, sourceLayout.globalRoot, directory);
    await syncCatalog();
    await activation.ensure(ctx.config.get().workspaces.map(workspace => ({ workspaceId: workspace.id, scope: 'global' as const, extensionId })), false);
    publish();
    return { extensionId };
  };
  const installCenterRelease = async (packageKey: string): Promise<import('../../shared/extensionCenter').ExtensionCenterInstallResult> => {
    const result = await extensionCenter.install(packageKey);
    if (result.installed) {
      await syncCatalog();
      await activation.ensure(ctx.config.get().workspaces.map(workspace => ({ workspaceId: workspace.id, scope: 'global' as const, extensionId: result.extensionId })), false);
      publish();
    }
    return result;
  };
  const uninstallCenterRelease = async (packageKey: string): Promise<import('../../shared/extensionCenter').ExtensionCenterUninstallResult> => {
    const release = (await extensionCenter.list()).find(item => item.packageKey === packageKey);
    if (!release) throw new Error('Extension center release was not found');
    const active = activation.list().filter(record => record.scope === 'global' && record.extensionId === release.extensionId && record.enabled);
    if (active.length) throw new Error('请先关闭所有工作区中的该扩展后再卸载');
    await extensionHost.closeExtension(release.extensionId);
    const result = await extensionCenter.uninstall(packageKey);
    if (result.uninstalled) {
      await syncCatalog();
      publish();
    }
    return result;
  };
  const uninstallGlobalPackage = (workspaceId: string, extensionId: string, fingerprint: string) =>
    management.uninstallGlobal(workspaceId, extensionId, fingerprint, {
      layout: sourceLayout, close: id => extensionHost.closeExtension(id), trash: directory => shell.trashItem(directory),
    });
  const storagePackages = () => {
    const { workspaces, closedWorkspaces } = ctx.config.get();
    const activations = activation.list().filter(row => row.scope === 'global');
    return catalog.list('global').map(record => {
      const enabled = new Set(activations.filter(row => row.extensionId === record.extensionId && row.enabled).map(row => row.workspaceId));
      for (const { id } of [...workspaces, ...(closedWorkspaces ?? [])]) {
        if (management.isEnabled(id, 'global', record.extensionId)) enabled.add(id);
      }
      return { id: record.extensionId, name: record.name, directory: record.directory, fingerprint: record.fingerprint,
        builtin: SAMPLE_IDS.some(id => id === record.extensionId), enabledWorkspaceIds: [...enabled] };
    });
  };
  const verifyStoragePackage = async (id: string, fingerprint: string): Promise<void> => {
    const pkg = await sourceLayout.discover({ scope: 'global', extensionId: id });
    if (pkg.fingerprint !== fingerprint) throw new Error(t('扩展状态已变化，请重新扫描。'));
  };
  return {
    extensionHost, management, workbench, authoring, authoringServices, agent: adapter.agent, extensionDomains: adapter.extensionDomains, extensionResources: adapter.extensionResources, exports: exportService, catalog, extensionCenter, workspaceActivation: activation, installLocal, installCenterRelease, uninstallCenterRelease, uninstallGlobalPackage,
    /** The single host has no detached background tasks; domain commands are short-lived RPC. */
    runningTasks(): Array<{ workspaceId: string; sourceRootId: string; extensionId: string; id: string; command: string }> { return []; },
    async listExtensions(workspaceId: string): Promise<ExtensionDiscoveredExtension[]> {
      try {
        const listing = await authoringServices.list(workspaceId, management.rootId(workspaceId));
        return [...listing.global, ...listing.project];
      } catch { return []; }
    },
    /** Sync catalog projection for storage inventory: global plus this workspace's project packages. */
    extensionNames(workspaceId: string): Array<{ id: string; name: string; scope: 'global' | 'project' }> {
      const workspace = ctx.config.get().workspaces.find(item => item.id === workspaceId);
      if (!workspace) return [];
      const controlRoot = path.resolve(management.rootPath(workspaceId));
      const sameRoot = (value?: string): boolean => !!value && (process.platform === 'win32' ? path.resolve(value).toLowerCase() === controlRoot.toLowerCase() : path.resolve(value) === controlRoot);
      return catalog.list().filter(record => record.scope === 'global' || sameRoot(record.controlRoot)).map(record => ({ id: record.extensionId, name: record.name, scope: record.scope }));
    },
    storagePackages, verifyStoragePackage,
    disableStorageActivation: (workspaceId: string, id: string, fingerprint: string) => management.disableGlobalForStorage(workspaceId, id, fingerprint),
    uninstallStoragePackage: (id: string, fingerprint: string) => management.uninstallGlobal(undefined, id, fingerprint, {
      layout: sourceLayout, close: extensionId => extensionHost.closeExtension(extensionId), trash: directory => shell.trashItem(directory),
      checkInactive: () => storagePackages().find(record => record.id === id)?.enabledWorkspaceIds.length === 0
    }),
    async preserveTransaction(_workspaceId: string, _id: string): Promise<ExtensionTransactionPreserveResult> {
      return { ok: false, error: 'Extension transactions are no longer used by the single package host' };
    },
    onChanged(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    start() {
      if (started || stopped) return;
      started = true;
      preparation = (async () => {
        await syncCatalog();
        await ensureLegacyActivations();
        if (stopped) return;
        try {
          // Keep every shipped sample in sync during development. The installer
          // still preserves existing packages in production, where users may
          // have edited their local copy.
          const installed = await installSamples();
          const workspaceIds = ctx.config.get().workspaces.map(workspace => workspace.id);
          for (const extensionId of [...installed.installed, ...installed.skipped]) await activation.ensure(workspaceIds.map(workspaceId => ({ workspaceId, scope: 'global' as const, extensionId })), true);
        } catch (error) { console.error('[extension] built-in sample install failed:', error); }
        if (stopped) return;
        const trial = extensionTrialTarget(), trialWorkspace = ctx.config.get().activeWorkspaceId;
        if (trial && trialWorkspace && catalog.get('global', trial)) await activation.set({ workspaceId: trialWorkspace, scope: 'global', extensionId: trial }, true);
        // The bundled extension package is installed after the first catalog scan. Push
        // a fresh navigation snapshot so a newly started app can open it without
        // requiring a second refresh through the manager.
        publish();
      })();
      extensionHost.setPackagePreparation(preparation);
      void preparation.catch(error => console.error('[extension] package preparation failed:', error));
    },
    refresh() { if (!started || stopped) return; void syncCatalog(); },
    stop() { if (stopping) return stopping; stopped = true; listeners.clear(); workbench!.stop(); catalog.close(); stopping = (async () => {
      const results = await Promise.allSettled([authoringServices.stop(), extensionHost.closeAll(), preparation]);
      results.push(...await Promise.allSettled([adapter.dispose()]));
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      mediaStore.stop();
      if (errors.length) throw new AggregateError(errors, 'Extension system cleanup failed');
    })(); return stopping; }
  };
}
export type ExtensionAppSystem = ReturnType<typeof createExtensionAppSystem>;
