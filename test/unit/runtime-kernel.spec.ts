import { describe, expect, it } from 'vitest';
import { DomainRegistry } from '../../src/main/runtimeKernel/domainRegistry';
import { LifecycleScope } from '../../src/main/runtimeKernel/lifecycleScope';

describe('Runtime Kernel lifecycle contracts', () => {
  it('waits for in-flight startup and closes acquired resources before disposal resolves', async () => {
    const registry = new DomainRegistry();
    const events: string[] = [];
    let ready!: () => void;
    registry.register({ id: 'slow', start: async () => {
      await new Promise<void>(resolve => { ready = resolve; });
      return () => { events.push('closed'); };
    } });
    registry.register({ id: 'next', dependsOn: ['slow'], start: () => { events.push('unexpected start'); } });
    const start = registry.startAll();
    const stop = registry.dispose();
    let stopped = false;
    void stop.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    ready();
    await expect(start).rejects.toThrow('cancelled');
    await stop;
    expect(events).toEqual(['closed']);
    await expect(registry.startAll()).rejects.toThrow('disposed');
  });

  it('reports both startup and cleanup failures', async () => {
    const registry = new DomainRegistry();
    registry.register({ id: 'bad', start: (_ctx, scope) => {
      scope.add(() => { throw new Error('cleanup failed'); });
      throw new Error('start failed');
    } });
    const error = await registry.startAll().catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.map((item: Error) => item.message)).toEqual(['start failed', 'cleanup failed']);
  });
  it('shares the pending scope disposal barrier between concurrent callers', async () => {
    const scope = new LifecycleScope('pending');
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    scope.add(() => pending);
    const first = scope.dispose();
    expect(scope.dispose()).toBe(first);
    let finished = false;
    void first.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await first;
  });

  it('still flushes earlier domains after a later domain fails to stop', async () => {
    const registry = new DomainRegistry();
    const events: string[] = [];
    registry.register({ id: 'storage', start: () => () => { events.push('flush'); } });
    registry.register({ id: 'worker', dependsOn: ['storage'], start: () => () => { events.push('stop'); throw new Error('failed stop'); } });
    await registry.startAll();
    const first = registry.dispose();
    expect(registry.dispose()).toBe(first);
    await expect(first).rejects.toThrow('Runtime domain disposal failed');
    expect(events).toEqual(['stop', 'flush']);
    expect(registry.list().every(domain => domain.state === 'stopped')).toBe(true);
  });
  it('disposes children and resources in reverse order exactly once', async () => {
    const order: string[] = [];
    const root = new LifecycleScope('root');
    root.add(() => { order.push('root-resource'); });
    const child = root.child('child');
    child.add(() => { order.push('child-resource'); });
    await root.dispose();
    await root.dispose();
    expect(order).toEqual(['child-resource', 'root-resource']);
    expect(child.isDisposed).toBe(true);
  });

  it('starts domains by dependency and unwinds started domains after failure', async () => {
    const events: string[] = [];
    const registry = new DomainRegistry();
    registry.register({ id: 'store', start: (_ctx, scope) => { events.push('store:start'); scope.add(() => { events.push('store:stop'); }); } });
    registry.register({ id: 'session', dependsOn: ['store'], start: () => { events.push('session:start'); } });
    registry.register({ id: 'broken', dependsOn: ['session'], start: () => { events.push('broken:start'); throw new Error('fixture failure'); } });
    await expect(registry.startAll()).rejects.toThrow('fixture failure');
    expect(events).toEqual(['store:start', 'session:start', 'broken:start', 'store:stop']);
    expect(registry.list().map(item => [item.id, item.state])).toEqual([
      ['store', 'stopped'],
      ['session', 'stopped'],
      ['broken', 'failed']
    ]);
  });

  it('rejects missing dependencies and cycles before starting a domain', async () => {
    const missing = new DomainRegistry();
    missing.register({ id: 'session', dependsOn: ['store'], start: () => {} });
    await expect(missing.startAll()).rejects.toThrow('dependency missing');

    const cycle = new DomainRegistry();
    cycle.register({ id: 'a', dependsOn: ['b'], start: () => {} });
    cycle.register({ id: 'b', dependsOn: ['a'], start: () => {} });
    await expect(cycle.startAll()).rejects.toThrow('dependency cycle');
  });

  it('disposes the failed domain scope and keeps registration retryable after graph validation fails', async () => {
    const events: string[] = [];
    const registry = new DomainRegistry();
    registry.register({
      id: 'broken',
      start: (_ctx, scope) => {
        scope.add(() => { events.push('broken:stop'); });
        throw new Error('broken startup');
      }
    });
    await expect(registry.startAll()).rejects.toThrow('broken startup');
    expect(events).toEqual(['broken:stop']);
    expect(registry.list()).toEqual([{ id: 'broken', state: 'failed', dependsOn: [] }]);

    const invalid = new DomainRegistry();
    invalid.register({ id: 'a', dependsOn: ['missing'], start: () => {} });
    await expect(invalid.startAll()).rejects.toThrow('dependency missing');
    invalid.register({ id: 'missing', start: () => {} });
    await expect(invalid.startAll()).resolves.toBeUndefined();
  });

  it('disposes started domains in dependency order regardless of registration order', async () => {
    const events: string[] = [];
    const registry = new DomainRegistry();
    registry.register({ id: 'session', dependsOn: ['store'], start: (_ctx, scope) => {
      scope.add(() => { events.push('session:stop'); });
    } });
    registry.register({ id: 'store', start: (_ctx, scope) => {
      scope.add(() => { events.push('store:stop'); });
    } });
    await registry.startAll();
    await registry.dispose();
    expect(events).toEqual(['session:stop', 'store:stop']);
  });
});

it('includes late acquisitions and their failures in the current disposal barrier', async () => {
  const scope = new LifecycleScope('late');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  scope.add(() => { order.push('earlier'); });
  scope.add(async () => { await gate; order.push('first'); });
  const stopping = scope.dispose();
  const rejected = expect(stopping).rejects.toThrow('late resource failed');
  await Promise.resolve();
  scope.add(async () => { await Promise.resolve(); order.push('late'); throw new Error('late resource failed'); });
  expect(scope.dispose()).toBe(stopping);
  release(); await rejected;
  expect(order).toEqual(['first', 'late', 'earlier']);
});

it('exposes the cleanup barrier for an acquisition reported after initial disposal', async () => {
  const scope = new LifecycleScope('already-closed'); await scope.dispose();
  let release!: () => void;
  scope.add(() => new Promise<void>(resolve => { release = resolve; }));
  const stopping = scope.dispose(); let done = false;
  void stopping.then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  release(); await stopping; expect(done).toBe(true);
});
