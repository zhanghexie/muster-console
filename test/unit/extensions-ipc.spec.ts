import { expect, it, vi } from 'vitest';
import type { AppContext } from '../../src/main/context';
import type { ExtensionAppSystem } from '../../src/main/extensions/extensionAppSystem';
import { ExtensionDevelopmentTrustRequiredError } from '../../src/main/extensions/extensionLiveBinding';

vi.mock('electron', () => ({ app: { isPackaged: true } }));

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => unknown>());
vi.mock('../../src/main/ipc/handle', () => ({ handle: (name: string, fn: (...args: any[]) => unknown) => handlers.set(name, fn), ownIpcResource: () => {} }));
import { registerExtensionsExtensionIpc } from '../../src/main/ipc/extensions';

it('exposes current catalog, surface and popup controls', async () => {
  handlers.clear();
  const send = vi.fn(), preserveTransaction = vi.fn(async () => ({ ok: false as const, error: 'Extension transactions are no longer used by the single package host' }));
  const ctx = { config: { get: () => ({ activeWorkspaceId: 'a' }) }, getWindow: () => ({ webContents: { send } }) } as unknown as AppContext;
  const panelViews = { ownsSender: vi.fn(() => true), init: vi.fn(), call: vi.fn(), appearance: vi.fn(), place: vi.fn() };
  const extensionHost = {
    ownsView: vi.fn(() => true), panelViews,
    developmentTrustStatus: vi.fn(() => ({ trusted: false, subject: { extensionId: 'dev', scope: 'global', directory: 'C:\\dev', fingerprint: `package-extension:${'a'.repeat(64)}` } })),
    trustDevelopment: vi.fn(() => ({ trusted: true, subject: {} })),
    revokeDevelopment: vi.fn(() => ({ trusted: false, subject: {} })),
    listDevelopmentTrust: vi.fn(() => []), open: vi.fn(), call: vi.fn(), reload: vi.fn(), close: vi.fn(), place: vi.fn()
  };
  const projectPath = vi.fn((_workspaceId: string, sourceRootId?: string) => `E:/project/${sourceRootId ?? 'default'}`);
  const catalog = { list: vi.fn(() => []), syncGlobal: vi.fn(() => ({ errors: [] })), setEnabled: vi.fn() };
  const uninstallGlobalPackage = vi.fn();
  const system = { preserveTransaction, uninstallGlobalPackage, authoringServices: { list: vi.fn(async () => ({ global: [], project: [{ id: 'selected-project-package' }], problems: [], issues: ['scan issue'] })) },
    management: { snapshot: vi.fn(() => ({ workspaceId: 'a', sourceRootId: 'two', selectionRevision: 3, listing: { issues: ['warning'] } })), selectionRevision: () => 3, select: vi.fn(), setEnabled: vi.fn() }, workbench: { toolbar: vi.fn(), runToolbar: vi.fn(), sync: vi.fn(), save: vi.fn(), projectPath }, extensionHost, catalog } as unknown as ExtensionAppSystem;
  registerExtensionsExtensionIpc(ctx, system);
  const invoke = (name: string, ...args: unknown[]) => handlers.get(name)!({ sender: { id: 7 } }, ...args);
  expect(() => invoke('extensions:snapshot', 'b')).toThrow(/Workspace changed/);
  await expect(invoke('extensions:snapshot', 'a')).resolves.toMatchObject({ sourceRootId: 'two', listing: { project: [{ id: 'selected-project-package' }], issues: ['warning', 'scan issue'] } });
  expect(system.authoringServices.list).toHaveBeenCalledWith('a', 'two', 'installed');
  expect(handlers.has('extensionCatalog:installSamples')).toBe(false);
  const fingerprint = `package-extension:${'a'.repeat(64)}`;
  expect(() => invoke('extensions:uninstallGlobal', { workspaceId: 'b', extensionId: 'dev', fingerprint })).toThrow(/Workspace changed/);
  expect(() => invoke('extensions:uninstallGlobal', { workspaceId: 'a', extensionId: 'dev', fingerprint: 'bad' })).toThrow(/Invalid extension fingerprint/);
  invoke('extensions:uninstallGlobal', { workspaceId: 'a', extensionId: 'dev', fingerprint });
  expect(uninstallGlobalPackage).toHaveBeenCalledWith('a', 'dev', fingerprint);
  await expect(invoke('extensions:preserveTransaction', { workspaceId: 'a', id: 'txn' })).resolves.toEqual({ ok: false, error: 'Extension transactions are no longer used by the single package host' });
  expect(preserveTransaction).toHaveBeenCalledWith('a', 'txn');
  await invoke('extensions:runToolbar', { workspaceId: 'a', sourceRootId: 'one', selectionRevision: 0, extensionId: 'quick-note', scope: 'global' });
  expect(system.workbench.runToolbar).toHaveBeenCalledWith(expect.objectContaining({ extensionId: 'quick-note', scope: 'global' }));
  expect(() => invoke('workbench:panelPlacement', { token: 't', placement: 'invalid' })).toThrow(/placement/);
  invoke('workbench:panelAppearance', { token: 't', appearance: {} });
  expect(extensionHost.panelViews.appearance).toHaveBeenCalledWith('t', {});
  invoke('extension:panelCall', { id: '1', method: 'data.read', args: [] });
  expect(panelViews.call).toHaveBeenCalledWith(7, { id: '1', method: 'data.read', args: [] });
  invoke('extension:panelMiddleClick');
  expect(panelViews.init).toHaveBeenCalledWith(7);
  expect(send).toHaveBeenCalledWith('workbench:middleClick', {});
  await expect(invoke('extensionCatalog:catalog')).resolves.toEqual({ packages: [], scan: [] });
  expect(catalog.syncGlobal).toHaveBeenCalledOnce();
});

it('classifies only the host development trust gate at the toolbar IPC boundary', async () => {
  const ctx = { config: { get: () => ({ activeWorkspaceId: 'a' }) } } as AppContext;
  const error = new ExtensionDevelopmentTrustRequiredError();
  const blocked = { status: 'development-trust-required', error: String(error) };
  const runToolbar = vi.fn().mockRejectedValueOnce(error).mockRejectedValueOnce(new Error(error.message)).mockResolvedValueOnce(blocked);
  const system = { catalog: { layout: {} }, workbench: { runToolbar } } as unknown as ExtensionAppSystem;
  registerExtensionsExtensionIpc(ctx, system);
  const invoke = () => handlers.get('extensions:runToolbar')!({}, { workspaceId: 'a', sourceRootId: 'one', selectionRevision: 0, extensionId: 'dev', scope: 'project' });
  await expect(invoke()).resolves.toEqual(blocked);
  await expect(invoke()).rejects.toThrow(error.message);
  await expect(invoke()).resolves.toEqual({ status: 'completed', result: blocked });
});
