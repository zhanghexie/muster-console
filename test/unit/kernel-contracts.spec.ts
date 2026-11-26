import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '../../src/main/runtimeKernel/contracts';
import { CapabilityRegistry } from '../../src/main/runtimeKernel/capabilityRegistry';
import { DomainRegistry } from '../../src/main/runtimeKernel/domainRegistry';
import type { LifecycleScope } from '../../src/main/runtimeKernel/lifecycleScope';
import { StorageRootResolver } from '../../src/main/runtimeKernel/storageRootResolver';
import {
  EventBus,
  PermissionGate,
  RuntimeKernel,
  type PluginContext,
  type RuntimePlugin,
  type SessionFactory
} from '../../src/main/runtimeKernel/kernelContracts';

const envelope = (type: string, seq = 1): EventEnvelope => ({
  eventId: `e-${seq}`,
  sessionId: 's1',
  seq,
  type,
  schemaVersion: 1,
  createdAt: 1,
  payload: {}
});

const sessions: SessionFactory = {
  create: async () => { throw new Error('not used in contract tests'); },
  open: async () => { throw new Error('not used in contract tests'); },
  release: async () => {}
};

function makeKernel() {
  return new RuntimeKernel<() => void>({
    domains: new DomainRegistry(),
    capabilities: new CapabilityRegistry<() => void>(),
    storage: new StorageRootResolver({
      userDataPath: path.join('/data', 'userData'),
      appDataPath: path.join('/data', 'appData')
    }),
    sessions
  });
}

describe('Runtime Kernel contract layer', () => {
  it('waits for a plugin that synchronously requests shutdown inside apply', async () => {
    const kernel = makeKernel();
    let release!: () => void, stopped = false, cleaned = false;
    let stopping: Promise<void> | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const application = kernel.apply({ id: 'reentrant-stop', version: '1', async apply(ctx) {
      ctx.scope.add(() => { cleaned = true; });
      stopping = kernel.dispose().then(() => { stopped = true; });
      await held;
    } });
    const rejected = expect(application).rejects.toThrow('disposed during');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(stopping).toBeDefined(); expect(stopped).toBe(false); expect(cleaned).toBe(false);
    release(); await rejected; await stopping;
    expect(cleaned).toBe(true); expect(stopped).toBe(true);
  });
  it('starts and drains domains before disposing plugin resources', async () => {
    const kernel = makeKernel();
    const order: string[] = [];
    await kernel.apply({ id: 'production-shape', version: '1', apply(ctx) {
      ctx.scope.add(() => { order.push('plugin'); });
      ctx.domain.register({ id: 'storage', start: () => () => { order.push('flush'); } });
      ctx.domain.register({ id: 'worker', dependsOn: ['storage'], start: () => () => { order.push('worker'); } });
    } });
    await kernel.start();
    const stopping = kernel.dispose();
    expect(kernel.dispose()).toBe(stopping);
    await stopping;
    expect(order).toEqual(['worker', 'flush', 'plugin']);
    expect(kernel.domains.list().every(domain => domain.state === 'stopped')).toBe(true);
  });

  it('reserves concurrent plugin IDs and waits for applying plugins before shutdown', async () => {
    const kernel = makeKernel();
    let resume!: () => void;
    let released = false;
    const plugin: RuntimePlugin<() => void> = { id: 'slow', version: '1', async apply(ctx) {
      await new Promise<void>(resolve => { resume = resolve; });
      ctx.scope.add(() => { released = true; });
    } };
    const applying = kernel.apply(plugin);
    await expect(kernel.apply(plugin)).rejects.toThrow('already applied');
    const stopping = kernel.dispose();
    expect(released).toBe(false);
    resume();
    await expect(applying).rejects.toThrow('disposed during');
    await stopping;
    expect(released).toBe(true);
    expect(kernel.listPlugins()).toEqual([]);
  });
  it('requires both a granted permission and an explicit RunContext permission', () => {
    const gate = new PermissionGate(['sessions.read']);
    const kernel = makeKernel();
    const context = kernel.createRunContext({ caller: { id: 'desktop:1', kind: 'desktop', isAlive: () => true }, permissions: ['sessions.read'] });
    expect(() => gate.assert(context, 'sessions.read')).not.toThrow();
    expect(() => gate.assert({ ...context, permissions: [] }, 'sessions.read')).toThrow('RunContext is missing permission');
    expect(() => gate.assert(context, 'sessions.write')).toThrow('Permission not granted');
    expect(context.correlationId).toBeTruthy();
  });

  it('keeps a failing listener from blocking others without swallowing the error', () => {
    const bus = new EventBus();
    const seen: number[] = [];
    const off = bus.on('tick', () => seen.push(1));
    bus.on('tick', () => seen.push(2));
    bus.emit(envelope('tick'));
    expect(seen).toEqual([1, 2]);
    off();
    bus.emit(envelope('tick', 2));
    expect(seen).toEqual([1, 2, 2]);

    bus.on('broken', () => { throw new Error('listener failed'); });
    bus.on('broken', () => seen.push(3));
    expect(() => bus.emit(envelope('broken'))).toThrow('listener failed');
    expect(seen).toEqual([1, 2, 2, 3]);

    bus.dispose();
    bus.emit(envelope('tick', 3));
    expect(seen).toEqual([1, 2, 2, 3]);
  });

  it('gives plugins the full context and releases their scope and events on dispose', async () => {
    const kernel = makeKernel();
    let pluginScope: LifecycleScope | undefined;
    let received = 0;
    const plugin: RuntimePlugin<() => void> = {
      id: 'contract.test',
      version: '1.0.0',
      apply(ctx: PluginContext<() => void>) {
        pluginScope = ctx.scope;
        expect(ctx.domain).toBe(kernel.domains);
        expect(ctx.capabilities).toBe(kernel.capabilities);
        expect(ctx.permissions).toBe(kernel.permissions);
        expect(ctx.sessions).toBe(sessions);
        ctx.events.on('tick', () => { received += 1; });
      }
    };
    await kernel.apply(plugin);
    expect(kernel.listPlugins()).toEqual(['contract.test']);
    await expect(kernel.apply(plugin)).rejects.toThrow('already applied');

    kernel.events.emit(envelope('tick'));
    expect(received).toBe(1);

    await kernel.dispose();
    expect(pluginScope?.isDisposed).toBe(true);
    kernel.events.emit(envelope('tick', 2));
    expect(received).toBe(1);
  });

  it('disposes the child scope when a plugin fails to apply', async () => {
    const kernel = makeKernel();
    let pluginScope: LifecycleScope | undefined;
    await expect(kernel.apply({
      id: 'failing.plugin',
      version: '1.0.0',
      apply(ctx) {
        pluginScope = ctx.scope;
        throw new Error('plugin apply failed');
      }
    })).rejects.toThrow('plugin apply failed');
    expect(pluginScope?.isDisposed).toBe(true);
    expect(kernel.listPlugins()).toEqual([]);
    await kernel.dispose();
  });
});
