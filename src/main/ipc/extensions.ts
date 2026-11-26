import { handle, ipcCaller, ownIpcResource } from './handle';
import { app, dialog, type IpcMainInvokeEvent } from 'electron';
import type { AppContext } from '../context';
import type { ExtensionAppSystem } from '../extensions/extensionAppSystem';
import type { ExtensionManagementSnapshot, ExtensionNavigationSnapshot, ExtensionToolbarRunResult } from '../../shared/extension';
import { isExtensionPanelMethod, type ExtensionBridgeCall } from '../../shared/extensions';
import type { PanelPlacement } from '../extensions/panelViews';
import type { ExtensionPanelEventEmitter } from '../extensions/extensionHost';
import type { ExtensionPublishingConnection, ExtensionPublishingLocalResult } from '../../shared/extensionPublishing';
import { t } from '../../shared/i18n';
import { approvedCommunityCatalogUrl, configuredPublishingOrigin, ExtensionPublishingClient } from '../extensions/extensionPublishingClient';
import { ExtensionPublishingLocalService } from '../extensions/extensionPublishingLocalService';
import { signalExtensionTrialWindow } from '../extensions/extensionTrialEnvironment';
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid extension request');
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\0')) throw new Error(`Invalid ${name}`);
  return value;
}
function bridgeCall(value: unknown): ExtensionBridgeCall {
  const input = record(value);
  if (!Array.isArray(input.args)) throw new Error('Invalid extension call arguments');
  const method = text(input.method, 'method');
  if (!isExtensionPanelMethod(method)) throw new Error(`Unsupported extension method: ${method}`);
  return { id: text(input.id, 'call id'), method, args: input.args };
}

function surfaceEvents(event: IpcMainInvokeEvent): ExtensionPanelEventEmitter {
  const caller = ipcCaller(event);
  return value => caller.sendEvent?.('extensionSurface:event', value);
}

/** Register only extension management, navigation, toolbar and panel channels. */
export function registerExtensionsExtensionIpc(ctx: AppContext, system: ExtensionAppSystem): void {
  let configured: URL | undefined, invalidOrigin = false;
  try { configured = configuredPublishingOrigin(); } catch { invalidOrigin = true; }
  const testToken = process.env.MUSTER_SANDBOX === '1' && configured?.protocol === 'http:' && configured.port
    ? process.env.MUSTER_EXTENSION_PUBLISH_TEST_SESSION : undefined;
  const defaultPublishing = new ExtensionPublishingClient(system.catalog.layout, configured, testToken);
  let localPublishing: ExtensionPublishingClient | undefined;
  const local = new ExtensionPublishingLocalService(app.isPackaged ? undefined : app.getAppPath(), origin => {
    localPublishing = origin && new ExtensionPublishingClient(system.catalog.layout, origin);
    system.extensionCenter.setCommunityCatalogUrl(origin ? new URL('/catalog.json', origin).href : approvedCommunityCatalogUrl());
  });
  ownIpcResource(() => local.dispose());
  const publishingWindow = (event: IpcMainInvokeEvent) => {
    const win = ctx.getWindow();
    if (!win || !event?.sender || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error('Extension publishing requires the desktop workbench');
    }
    return win;
  };
  const publishing = (event: IpcMainInvokeEvent) => {
    publishingWindow(event);
    if (!localPublishing && invalidOrigin) throw new Error(t('发布服务地址须为 HTTPS 或 127.0.0.1 上的 HTTP 地址。'));
    return localPublishing ?? defaultPublishing;
  };
  let selectingConfig: Promise<ExtensionPublishingLocalResult> | undefined;
  handle('extensionPublishing:connection', (event): ExtensionPublishingConnection => {
    publishingWindow(event);
    return { ok: true, origin: (local.origin ?? configured)?.origin, local: Boolean(local.origin) };
  });
  handle('extensionPublishing:startLocal', (event) => {
    const win = publishingWindow(event);
    if (local.origin) return { ok: true } as const;
    return selectingConfig ??= (async (): Promise<ExtensionPublishingLocalResult> => {
      try {
        const picked = await dialog.showOpenDialog(win, { properties: ['openFile'], title: t('选择发布服务配置文件'),
          defaultPath: app.isPackaged ? undefined : app.getAppPath() });
        if (picked.canceled || !picked.filePaths[0]) return { ok: true, canceled: true };
        await local.start(picked.filePaths[0]);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    })().finally(() => { selectingConfig = undefined; });
  });
  handle('extensionPublishing:stopLocal', async (event): Promise<ExtensionPublishingLocalResult> => {
    publishingWindow(event);
    try { await local.stop(); return { ok: true }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  });
  handle('extensionPublishing:session', event => publishing(event).session());
  handle('extensionPublishing:signIn', event => publishing(event).signIn());
  handle('extensionPublishing:authorizeRepository', event => publishing(event).authorizeRepository());
  handle('extensionPublishing:mine', event => publishing(event).mine());
  handle('extensionPublishing:submit', (event, id: unknown, repo: unknown) => {
    return publishing(event).submit(text(id, 'extension ID'), text(repo, 'repository'));
  });
  handle('extensionPublishing:queue', event => publishing(event).queue());
  handle('extensionPublishing:review', (event, id: unknown) => publishing(event).review(text(id, 'candidate')));
  handle('extensionPublishing:trial', (event, id: unknown) => publishing(event).trial(text(id, 'candidate')));
  handle('extensionPublishing:decide', (event, id: unknown, decision: unknown, reason: unknown) => {
    const client = publishing(event);
    if (decision !== 'approve' && decision !== 'return') throw new Error('Invalid review decision');
    return client.decide(text(id, 'candidate'), decision, typeof reason === 'string' ? reason : undefined);
  });
  handle('extensionPublishing:previewTarget', event => { publishingWindow(event); return signalExtensionTrialWindow(); });
  const active = (value: unknown): string => {
    const workspace = text(value, 'workspace');
    if (ctx.config.get().activeWorkspaceId !== workspace) throw new Error('Workspace changed; refresh the extension view');
    return workspace;
  };
  const withListing = async (snapshot: ExtensionManagementSnapshot): Promise<ExtensionManagementSnapshot> => {
    const listing = await system.authoringServices.list(snapshot.workspaceId, snapshot.sourceRootId, 'installed');
    if (system.management.selectionRevision(snapshot.workspaceId) !== snapshot.selectionRevision) throw new Error('Selected project changed; refresh the extension view');
    return { ...snapshot, listing: { ...listing, issues: [...snapshot.listing.issues, ...listing.issues] } };
  };
  handle('extensions:snapshot', (_event, workspaceId: unknown) => withListing(system.management.snapshot(active(workspaceId))));
  handle('extensions:preserveTransaction', (_event, value: unknown) => {
    try {
      const input = record(value), workspaceId = active(input.workspaceId);
      return system.preserveTransaction(workspaceId, text(input.id, 'transaction'));
    } catch (error) { return { ok: false as const, error: String(error) }; }
  });
  handle('extensions:selectProject', (_event, value: unknown) => {
    const input = record(value); return withListing(system.management.select(active(input.workspaceId), text(input.sourceRootId, 'project')));
  });
  handle('extensions:setEnabled', (_event, value: unknown) => {
    const input = record(value), workspaceId = active(input.workspaceId);
    if ((input.scope !== 'global' && input.scope !== 'project') || typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.selectionRevision) || Number(input.selectionRevision) < 0) throw new Error('Invalid extension scope, enabled state or project revision');
    return system.management.setEnabled(workspaceId, text(input.sourceRootId, 'project'), input.scope, text(input.extensionId, 'extension'), input.enabled, Number(input.selectionRevision)).then(withListing);
  });
  handle('extensions:setEnabledAll', (_event, value: unknown) => {
    const input = record(value);
    if (typeof input.enabled !== 'boolean') throw new Error('Invalid extension enabled state');
    return system.management.setEnabledAll(active(input.workspaceId), text(input.extensionId, 'extension'), input.enabled).then(() => ({ ok: true as const }));
  });
  handle('extensions:toolbar', (_event, workspaceId: unknown) => system.workbench.toolbar(active(workspaceId)));
  handle('extensions:runToolbar', async (_event, value: unknown): Promise<ExtensionToolbarRunResult> => {
    const input = record(value);
    if (!Number.isSafeInteger(input.selectionRevision) || Number(input.selectionRevision) < 0) throw new Error('Invalid project revision');
    if (input.scope !== undefined && input.scope !== 'global' && input.scope !== 'project') throw new Error('Invalid toolbar scope');
    const result = await system.workbench.runToolbar({ workspaceId: active(input.workspaceId), sourceRootId: text(input.sourceRootId, 'project'), selectionRevision: Number(input.selectionRevision), extensionId: text(input.extensionId, 'extension'), ...(input.menuId === undefined ? {} : { menuId: text(input.menuId, 'menu item') }), ...(input.scope === undefined ? {} : { scope: input.scope }) });
    return { status: 'completed', result };
  });
  handle('workbench:navigation', () => system.workbench.sync());
  handle('workbench:saveNavigation', (_event, value: unknown) => {
    const input = record(value); active(input.workspaceId); text(input.sourceRootId, 'project');
    return system.workbench.save(input as unknown as ExtensionNavigationSnapshot);
  });
  handle('workbench:panelAppearance', (_event, value: unknown) => { const input = record(value); const token = text(input.token, 'token'); const appearance = record(input.appearance); if (!system.extensionHost.ownsView(token)) throw new Error('Extension surface is unavailable'); return system.extensionHost.panelViews?.appearance(token, appearance); });
  handle('workbench:panelPlacement', (_event, value: unknown) => {
    const input = record(value);
    if (typeof input.placement !== 'string' || !['center', 'left', 'right', 'window'].includes(input.placement)) throw new Error('Invalid extension panel placement');
    const token = text(input.token, 'token');
    if (!system.extensionHost.ownsView(token)) throw new Error('Extension surface is unavailable');
    return system.extensionHost.place(token, input.placement as PanelPlacement);
  });
  // popup（独立窗口）的 preload IPC 按 sender 归属路由到当前扩展宿主。
  const panelViewsFor = (senderId: number) => {
    if (!system.extensionHost.panelViews?.ownsSender(senderId)) throw new Error('Extension popup is unavailable');
    return system.extensionHost.panelViews;
  };
  handle('extension:panelInit', event => panelViewsFor(event.sender.id).init(event.sender.id));
  handle('extension:panelMiddleClick', event => { const views = panelViewsFor(event.sender.id); views.init(event.sender.id); ctx.getWindow()?.webContents.send('workbench:middleClick', {}); });
  handle('extension:panelCall', (event, call: unknown) => panelViewsFor(event.sender.id).call(event.sender.id, bridgeCall(call)));
  handle('extension:panelFileAccess', event => panelViewsFor(event.sender.id).call(event.sender.id, { id: 'drop-access', method: 'files.pathAccess', args: [] }));
  handle('extensionCatalog:catalog', async () => {
    const scan = await system.catalog.syncGlobal();
    return { packages: system.catalog.list('global'), scan: scan.errors };
  });
  handle('extensionCatalog:setEnabled', (_event, value: unknown) => {
    const input = record(value);
    if (input.scope !== 'global' && input.scope !== 'project') throw new Error('Invalid extension scope');
    if (typeof input.enabled !== 'boolean') throw new Error('Invalid extension enabled state');
    const extensionId = text(input.extensionId, 'extension');
    let controlRoot: string | undefined;
    if (input.scope === 'project') {
      const workspaceId = text(input.workspaceId, 'workspace');
      controlRoot = system.workbench.projectPath(active(workspaceId), input.sourceRootId === undefined ? undefined : text(input.sourceRootId, 'project'));
    }
    return system.catalog.setEnabled({ scope: input.scope, extensionId, enabled: input.enabled, ...(controlRoot ? { controlRoot } : {}) });
  });
  handle('extensions:uninstallGlobal', (_event, value: unknown) => {
    const input = record(value);
    const workspaceId = active(input.workspaceId);
    const fingerprint = text(input.fingerprint, 'extension fingerprint');
    if (!/^package-extension:[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid extension fingerprint');
    return system.uninstallGlobalPackage(workspaceId, text(input.extensionId, 'extension'), fingerprint);
  });
  handle('extensionCatalog:installLocal', async () => {
    const win = ctx.getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { title: '选择本地扩展目录', properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ title: '选择本地扩展目录', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
    return system.installLocal(text(result.filePaths[0], 'extension directory'));
  });
  handle('extensionCenter:list', (_event, value?: unknown) => {
    if (value !== undefined && typeof value !== 'boolean') throw new Error('Invalid extension center refresh flag');
    return system.extensionCenter.listCatalog({ force: value === true });
  });
  handle('extensionCenter:install', (_event, value: unknown) => {
    const input = record(value);
    return system.installCenterRelease(text(input.packageKey, 'package key'));
  });
  handle('extensionCenter:uninstall', (_event, value: unknown) => {
    const input = record(value);
    return system.uninstallCenterRelease(text(input.packageKey, 'package key'));
  });
  handle('extensionSurface:open', (event, value: unknown) => {
    const input = record(value);
    if (input.mcpTrust !== undefined && input.mcpTrust !== 'trusted-once' && input.mcpTrust !== 'trusted-persistent') throw new Error('Invalid MCP trust');
    if (input.scope !== undefined && input.scope !== 'global' && input.scope !== 'project') throw new Error('Invalid extension scope');
    const workspaceId = active(input.workspaceId);
    const scope = input.scope === 'project' ? 'project' : 'global';
    const sourceRootId = input.sourceRootId === undefined ? (scope === 'project' ? system.management.rootId(workspaceId) : undefined) : text(input.sourceRootId, 'project');
    const controlRoot = scope === 'project' ? system.workbench.projectPath(workspaceId, sourceRootId) : undefined;
    return system.extensionHost.open({ workspaceId, extensionId: text(input.extensionId, 'extension'), scope, ...(controlRoot ? { controlRoot } : {}), ...(sourceRootId ? { sourceRootId } : {}), ...(input.surfaceId === undefined ? {} : { surfaceId: text(input.surfaceId, 'surface') }), ...(input.mcpTrust === undefined ? {} : { mcpTrust: input.mcpTrust }) }, surfaceEvents(event));
  });
  handle('extensionSurface:call', (_event, value: unknown) => {
    const input = record(value);
    if (!Array.isArray(input.args)) throw new Error('Invalid extension call arguments');
    const method = text(input.method, 'method');
    if (!isExtensionPanelMethod(method)) throw new Error(`Unsupported extension method: ${method}`);
    return system.extensionHost.call(text(input.token, 'token'), method, input.args);
  });
  handle('extensionSurface:reload', (event, value: unknown) => system.extensionHost.reload(text(value, 'token'), surfaceEvents(event)));
  handle('extensionSurface:close', (_event, value: unknown) => system.extensionHost.close(text(value, 'token')));
}
