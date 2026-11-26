import { expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }));
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, callback: unknown) => electron.handlers.set(channel, callback),
  removeHandler: (channel: string) => electron.handlers.delete(channel)
} }));
vi.mock('../../../src/main/browser/tabs', () => ({ normalizeUrlInput: (url: string) => url }));
import { registerBrowserIpc } from '../../../src/main/ipc/browser';
import { registerScopedIpc, listIpcCapabilities, invokeIpcChannel } from '../../../src/main/ipc/handle';
import { LifecycleScope } from '../../../src/main/runtimeKernel/lifecycleScope';
import type { BrowserTabService } from '../../../src/main/browser/tabs';

it('revokes actual browser registrations from both transports when their domain closes', async () => {
  const scope = new LifecycleScope('browser-scope-fixture');
  const restore = vi.fn(() => ({ tabs: [] }));
  registerScopedIpc('host-entrypoints:browser', scope, () => registerBrowserIpc({ restore } as unknown as BrowserTabService));
  const registrations = listIpcCapabilities().filter(entry => entry.source === 'host-entrypoints:browser');
  expect(registrations.length).toBeGreaterThan(10);
  expect(registrations.every(entry => entry.permission === `ipc:${entry.id}`)).toBe(true);
  await invokeIpcChannel('browser:restore', [], { id: 'desktop:fixture', kind: 'desktop', isAlive: () => true });
  expect(restore).toHaveBeenCalledOnce();
  await scope.dispose();
  expect(listIpcCapabilities().some(entry => entry.source === 'host-entrypoints:browser')).toBe(false);
  expect(registrations.some(entry => electron.handlers.has(entry.id))).toBe(false);
  await expect(invokeIpcChannel('browser:restore', [])).rejects.toThrow('无此通道');
});
