import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}));

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (channel: string) => mocks.handlers.delete(channel),
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    }
  }
}));

import { CapabilityRegistry } from '../../src/main/runtimeKernel/capabilityRegistry';
import { handle, invokeIpcChannel, listIpcCapabilities, registerScopedIpc, ownIpcResource, ipcRunContext, ipcPermissions, listIpcAudit } from '../../src/main/ipc/handle';
import { DomainRegistry } from '../../src/main/runtimeKernel/domainRegistry';
import { LifecycleScope } from '../../src/main/runtimeKernel/lifecycleScope';

afterEach(() => vi.restoreAllMocks());

describe('ipc capability entry', () => {
  it('cancels resources registered before the first channel before awaiting their handler', async () => {
    const scope = new LifecycleScope('ipc-search-order');
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const entered = vi.fn();
    registerScopedIpc('search-order', scope, () => {
      ownIpcResource(() => finish());
      handle('test.search-order', async () => { entered(); await held; });
    });
    const call = invokeIpcChannel('test.search-order', []);
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    await scope.dispose(); await call;
  });
  it('revokes sibling channels and waits for accepted desktop and internal calls before disposal completes', async () => {
    const scope = new LifecycleScope('ipc-pending');
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    let entered = 0;
    registerScopedIpc('pending', scope, () => {
      handle('test.pending.one', async () => { entered++; await held; return 'done'; });
      handle('test.pending.two', () => 'two');
    });
    const first = mocks.handlers.get('test.pending.one')!({ sender: { id: 1, isDestroyed: () => false } });
    const second = invokeIpcChannel('test.pending.one', []);
    await vi.waitFor(() => expect(entered).toBe(2));
    let stopped = false;
    const stopping = scope.dispose().then(() => { stopped = true; });
    await Promise.resolve();
    expect(mocks.handlers.has('test.pending.two')).toBe(false);
    await expect(invokeIpcChannel('test.pending.two', [])).rejects.toThrow('无此通道');
    expect(stopped).toBe(false);
    finish();
    expect(await first).toBe('done'); expect(await second).toBe('done');
    await stopping; expect(stopped).toBe(true);
  });

  it('registers a synchronous disposal-triggering handler before its owner starts draining', async () => {
    const scope = new LifecycleScope('ipc-reentrant');
    let finish!: () => void, stopping: Promise<void> | undefined;
    let stopped = false;
    const held = new Promise<void>(resolve => { finish = resolve; });
    registerScopedIpc('reentrant', scope, () => handle('test.reentrant', () => {
      stopping = scope.dispose().then(() => { stopped = true; });
      return held;
    }));
    const call = invokeIpcChannel('test.reentrant', []);
    await vi.waitFor(() => expect(stopping).toBeDefined());
    expect(stopped).toBe(false);
    finish(); await call; await stopping; expect(stopped).toBe(true);
  });
  it('unregisters a failed IPC domain from both transports and preserves domain attribution', async () => {
    const domains = new DomainRegistry();
    domains.register({ id: 'ipc:fixture', start: (_ctx, scope) => registerScopedIpc('fixture', scope, () => {
      handle('test.scoped', () => 'scoped');
      expect(listIpcCapabilities()).toContainEqual({ id: 'test.scoped', source: 'fixture', permission: 'ipc:test.scoped', auditTag: 'fixture:test.scoped' });
      throw new Error('half registered');
    }) });
    await expect(domains.startAll()).rejects.toThrow('half registered');
    expect(mocks.handlers.has('test.scoped')).toBe(false);
    await expect(invokeIpcChannel('test.scoped', [])).rejects.toThrow('无此通道');
  });
  it('routes desktop IPC through the CapabilityRegistry instead of a private closure', async () => {
    const spy = vi.spyOn(CapabilityRegistry.prototype, 'get');
    const impl = vi.fn(() => 'ok');
    handle('test.registry.entry', impl, { permission: 'test.read', auditTag: 'test-read' });

    const desktop = mocks.handlers.get('test.registry.entry');
    expect(desktop).toBeDefined();
    expect(await desktop!({ sender: { id: 1, isDestroyed: () => false } })).toBe('ok');
    expect(spy).toHaveBeenCalledWith('test.registry.entry');

    expect(await invokeIpcChannel('test.registry.entry', [])).toBe('ok');
    expect(impl).toHaveBeenCalledTimes(2);
    expect(listIpcCapabilities()).toContainEqual({
      id: 'test.registry.entry',
      source: 'ipc',
      permission: 'test.read',
      auditTag: 'test-read'
    });
  });

  it('keeps unregistered channels and duplicate registrations rejected', async () => {
    await expect(invokeIpcChannel('test.missing', [])).rejects.toThrow('无此通道');
    handle('test.duplicate', () => 1);
    expect(() => handle('test.duplicate', () => 2)).toThrow('通道重复注册');
  });

  it('enforces transport permissions through nested calls and records correlation without arguments', async () => {
    const execute = vi.fn(() => 'private');
    handle('usage:summary', execute);
    handle('test.forward', () => invokeIpcChannel('usage:summary', []));
    const web = { id: 'web:test', kind: 'web' as const, isAlive: () => true };
    await expect(invokeIpcChannel('test.forward', [{ secret: 'never audit this' }], web)).rejects.toThrow('permission denied');
    expect(execute).not.toHaveBeenCalled();
    const records = listIpcAudit().slice(-2);
    expect(records.map(item => item.status)).toEqual(['denied', 'failed']);
    expect(records[0].correlationId).toBe(records[1].correlationId);
    expect(JSON.stringify(records)).not.toContain('secret');
    expect(records.every(item => item.callerId === 'web:test')).toBe(true);
    expect(await mocks.handlers.get('usage:summary')!({ sender: { id: 1, isDestroyed: () => false } })).toBe('private');
  });

  it('rejects dead callers, missing caller grants and revoked runtime grants before executing', async () => {
    const execute = vi.fn(() => ipcRunContext()?.caller.kind);
    handle('test.protected', execute, { permission: 'protected.run' });
    const caller = { id: 'web:permissions', kind: 'web' as const, isAlive: () => true, permissions: ['protected.run'] };
    await expect(invokeIpcChannel('test.protected', [], { ...caller, isAlive: () => false })).rejects.toThrow('no longer connected');
    await expect(invokeIpcChannel('test.protected', [], { ...caller, permissions: [] })).rejects.toThrow('missing permission');
    ipcPermissions.revoke('protected.run');
    await expect(invokeIpcChannel('test.protected', [], caller)).rejects.toThrow('not granted');
    expect(execute).not.toHaveBeenCalled();
    ipcPermissions.grant('protected.run');
    expect(await invokeIpcChannel('test.protected', [], caller)).toBe('web');
  });

  it('closes admission before domain disposal and prevents queued handlers from starting', async () => {
    vi.resetModules();
    const isolated = await import('../../src/main/ipc/handle');
    const work = vi.fn(() => 1);
    isolated.handle('test.shutdown-admission', work);
    const pending = isolated.invokeIpcChannel('test.shutdown-admission', []);
    isolated.stopIpcAdmission();
    await expect(pending).rejects.toThrow('stopping');
    expect(work).not.toHaveBeenCalled();
    expect(() => isolated.handle('test.after-stop', work)).toThrow('stopping');
    expect(isolated.listIpcAudit().at(-1)?.status).toBe('denied');
  });
});
