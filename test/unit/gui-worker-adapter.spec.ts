import { describe, expect, it, vi } from 'vitest';
import { GuiWorkerAdapterRegistry } from '../../src/main/agentSession/guiWorkerAdapter';
import type { GuiDriverConnectInput, GuiRuntimeConnection, GuiRuntimeDriver } from '../../src/main/agentSession/types';

function connection() { return { close: vi.fn(async () => {}), send: vi.fn(async () => {}), abort: vi.fn(async () => {}) } as unknown as GuiRuntimeConnection; }
function driver(runtimeId: string, connect = vi.fn(async () => connection())) { return { runtimeId, connect } as unknown as GuiRuntimeDriver; }
const input = { sessionId: 's' } as GuiDriverConnectInput;

describe('GUI Worker adapter ownership', () => {
  it('uses one registry for runtime lookup and rejects duplicate registrations', () => {
    const registry = new GuiWorkerAdapterRegistry();
    registry.register({ runtimeId: 'pi', driver: driver('pi') });
    expect(() => registry.register({ runtimeId: 'pi', driver: driver('pi') })).toThrow('already registered');
    expect([...registry.drivers()]).toEqual([registry.get('pi')!.driver]);
    expect(registry.getDriver('pi')).toBe(registry.get('pi')!.driver);
  });
  it('owns pending connections, closes late resolutions and rejects new work during disposal', async () => {
    let resolve!: (value: GuiRuntimeConnection) => void;
    const registry = new GuiWorkerAdapterRegistry(), conn = connection();
    registry.register({ runtimeId: 'pi', driver: driver('pi', vi.fn(() => new Promise(done => { resolve = done; }))) });
    const pending = registry.getDriver('pi')!.connect(input);
    await Promise.resolve();
    const disposed = registry.dispose();
    const rejection = expect(pending).rejects.toThrow('closed during connect');
    resolve(conn); await disposed; await rejection;
    expect(conn.close).toHaveBeenCalledOnce();
    await expect(registry.getDriver('pi')!.connect(input)).rejects.toThrow('shutting down');
  });
  it('blocks a second writer until close succeeds, shares concurrent close and permits recovery afterward', async () => {
    const registry = new GuiWorkerAdapterRegistry(), conn = connection();
    let finish!: () => void;
    conn.close = vi.fn(() => new Promise<void>(done => { finish = done; }));
    registry.register({ runtimeId: 'pi', driver: driver('pi', vi.fn(async () => conn)) });
    const facade = registry.getDriver('pi')!, owned = await facade.connect(input);
    await expect(facade.connect(input)).rejects.toThrow('still owned');
    const first = owned.close(), second = owned.close(); expect(first).toBe(second);
    await Promise.resolve(); expect(() => owned.send('late')).toThrow('closing');
    finish(); await first; expect(conn.close).toHaveBeenCalledOnce();
    await expect(facade.connect(input)).resolves.toBeDefined();
  });
  it('keeps failed close owned and still disposes other drivers', async () => {
    const registry = new GuiWorkerAdapterRegistry(), bad = connection(), good = connection();
    bad.close = vi.fn(async () => { throw new Error('fixture close failure'); });
    registry.register({ runtimeId: 'bad', driver: driver('bad', vi.fn(async () => bad)) });
    registry.register({ runtimeId: 'good', driver: driver('good', vi.fn(async () => good)) });
    const badConnection = await registry.getDriver('bad')!.connect(input);
    await registry.getDriver('good')!.connect(input);
    await expect(badConnection.close()).rejects.toThrow('fixture close failure');
    await expect(registry.getDriver('bad')!.connect(input)).rejects.toThrow('still owned');
    await expect(registry.dispose()).rejects.toThrow('registry shutdown failed');
    expect(good.close).toHaveBeenCalledOnce();
  });
  it('waits for accepted maintenance before completing adapter disposal', async () => {
    const registry = new GuiWorkerAdapterRegistry();
    let finish!: () => void;
    const engine = driver('pi');
    engine.purge = () => new Promise<void>(done => { finish = done; });
    registry.register({ runtimeId: 'pi', driver: engine });
    const work = registry.getDriver('pi')!.purge!({ sessionId: 's' });
    let finished = false;
    const disposed = registry.dispose().then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    expect(() => registry.getDriver('pi')!.purge!({ sessionId: 'late' })).toThrow('shutting down');
    finish(); await work; await disposed; expect(finished).toBe(true);
  });
});
