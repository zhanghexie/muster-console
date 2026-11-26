// @vitest-environment node
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
const fixtures = vi.hoisted(() => ({ factory: undefined as undefined | (() => any), requests: [] as string[] }));
vi.mock('node:fs', () => ({ default: { statSync: () => ({ isDirectory: () => true }) } }));
vi.mock('../../../src/main/agentSession/drivers/acp/agents', () => ({ getAcpPresets: () => [{ id: 'opencode' }], resolveAcpLaunch: () => ({ command: 'fixture', args: [] }) }));
vi.mock('../../../src/main/agentSession/process/controlledChild', () => ({ createControlledChild: () => fixtures.factory!() }));
vi.mock('../../../src/main/agentSession/drivers/acp/jsonRpc', () => ({ NdjsonRpc: class extends EventEmitter {
  async request(method: string) { fixtures.requests.push(method); return method === 'initialize' ? { protocolVersion: 1 } : { models: { currentModelId: 'fixture', availableModels: [{ modelId: 'fixture', name: 'Fixture' }] } }; }
  close() {} respondError() {} failExternal() {}
} }));
import { listAcpModels } from '../../../src/main/agentSession/drivers/acp/models';
vi.stubGlobal('window', globalThis);
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function owner() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false });
  return { child, started: true, ready: Promise.resolve(), reclaim: vi.fn(async () => {}) };
}
describe('ACP model discovery creation ownership', () => {
  it('waits ownership before initialize and real reclamation before returning/cache commit', async () => {
    fixtures.requests = []; const started = deferred(), closed = deferred(), lease = owner();
    lease.ready = started.promise; lease.reclaim.mockImplementation(() => closed.promise); fixtures.factory = () => lease;
    let settled = false; const pending = listAcpModels({ cwd: '/owned-success', agentId: 'opencode', refresh: true }).then(result => { settled = true; return result; });
    await tick(); expect(fixtures.requests).toEqual([]);
    started.resolve(); await tick(); expect(fixtures.requests).toEqual(['initialize', 'session/new']); expect(settled).toBe(false);
    expect((await listAcpModels({ cwd: '/owned-success', agentId: 'opencode' })).ok).toBe(false);
    closed.resolve(); expect((await pending).ok).toBe(true); expect(lease.reclaim).toHaveBeenCalledOnce();
    expect((await listAcpModels({ cwd: '/owned-success', agentId: 'opencode' })).ok).toBe(true);
  });
  it('reports cleanup failure and never caches an unconfirmed process outcome', async () => {
    const lease = owner(); lease.reclaim.mockRejectedValue(new Error('container close unconfirmed')); fixtures.factory = () => lease;
    const result = await listAcpModels({ cwd: '/owned-failure', agentId: 'opencode', refresh: true });
    expect(result).toMatchObject({ ok: false, cleanupFailed: true, error: 'container close unconfirmed' });
    expect((await listAcpModels({ cwd: '/owned-failure', agentId: 'opencode' })).ok).toBe(false);
  });
});
