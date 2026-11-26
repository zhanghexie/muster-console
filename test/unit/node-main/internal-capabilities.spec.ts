import { describe, expect, it, vi } from 'vitest';
import { InternalCapabilities } from '../../../src/main/runtimeKernel/internalCapabilities';
import { PermissionGate, type RunContext } from '../../../src/main/runtimeKernel/kernelContracts';
import { LifecycleScope } from '../../../src/main/runtimeKernel/lifecycleScope';

function fixture() {
  const gate = new PermissionGate(), calls = new InternalCapabilities(gate), scope = new LifecycleScope('extension');
  const context = (permission: string): RunContext => ({ correlationId: 'turn-1', caller: { id: 'extension:approved', kind: 'internal', isAlive: () => true },
    workspaceId: 'workspace', permissions: [permission], createdAt: Date.now() });
  return { gate, calls, scope, context };
}

describe('internal capability execution boundary', () => {
  it('uses explicit permissions, trusted identity, correlation and parameter-free bounded audit', async () => {
    const { gate, calls, scope, context } = fixture();
    const handler = vi.fn((input: { secret: string }, run: RunContext) => {
      expect(calls.currentContext()).toBe(run);
      return input.secret.length;
    });
    const call = calls.register(scope, 'extension.tool', 'plugin', handler);
    await expect(call.invoke({ secret: 'private-content' }, { ...context(call.permission), permissions: [] })).rejects.toThrow('missing permission');
    expect(handler).not.toHaveBeenCalled();
    for (let i = 0; i < 205; i++) expect(await call.invoke({ secret: 'private-content' }, context(call.permission))).toBe(15);
    expect(calls.listAudit()).toHaveLength(200);
    expect(JSON.stringify(calls.listAudit())).not.toContain('private-content');
    expect(calls.listAudit()[0]).toMatchObject({ correlationId: 'turn-1', callerId: 'extension:approved', status: 'ok' });
    gate.revoke(call.permission);
    await expect(call.invoke({ secret: '' }, context(call.permission))).rejects.toThrow('not granted');
    await scope.dispose();
  });

  it('revokes admission immediately and waits for a cancelled accepted handler to settle', async () => {
    const { calls, scope, context } = fixture();
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let signal!: AbortSignal;
    const call = calls.register(scope, 'extension.wait', 'plugin', async (_input: null, _run, abort) => {
      signal = abort; started(); await new Promise<void>(resolve => { release = resolve; }); return 'late';
    });
    const pending = call.invoke(null, context(call.permission));
    const result = expect(pending).rejects.toThrow('disposed');
    await entered;
    let siblingSignal!: AbortSignal;
    const sibling = calls.register(scope, 'extension.sibling', 'plugin', async (_input: null, _run, abort) => {
      siblingSignal = abort;
      await new Promise<void>(resolve => abort.addEventListener('abort', () => resolve(), { once: true }));
    });
    const siblingResult = expect(sibling.invoke(null, context(sibling.permission))).rejects.toThrow('disposed');
    await Promise.resolve();
    let disposed = false;
    const closing = scope.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(signal.aborted).toBe(true);
    expect(siblingSignal.aborted).toBe(true);
    expect(disposed).toBe(false);
    await expect(call.invoke(null, context(call.permission))).rejects.toThrow('unavailable');
    release(); await result; await siblingResult; await closing;
    expect(calls.registry.list()).toEqual([]);
  });

  it('rejects stale callers, pre-cancelled work and duplicate registrations without running handlers', async () => {
    const { calls, scope, context } = fixture();
    const handler = vi.fn(() => true);
    const call = calls.register(scope, 'extension.tool', 'plugin', handler);
    expect(() => calls.register(scope, call.id, 'other', handler)).toThrow('already registered');
    await expect(call.invoke(null, { ...context(call.permission), caller: { id: 'stale', kind: 'internal', isAlive: () => false } })).rejects.toThrow('no longer active');
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(call.invoke(null, context(call.permission), controller.signal)).rejects.toThrow('cancelled');
    expect(handler).not.toHaveBeenCalled();
    await scope.dispose();
  });
});
