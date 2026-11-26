// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyManager } from '../../../src/main/pty/manager';
import { preparePtySpawnHelper } from '../../../src/main/pty/spawnHelper';
import type { createOwnedInteractivePty } from '../../../src/main/pty/interactiveOwner';
vi.stubGlobal('window', globalThis);
const native = vi.hoisted(() => ({ calls: [] as Array<{ command: string; options: any; proc: any }>, create: undefined as undefined | (() => any) }));
vi.mock('node-pty', () => ({ spawn(command: string, _args: unknown, options: unknown) { const proc = native.create!(); native.calls.push({ command, options, proc }); return proc; } }));
vi.mock('../../../src/main/pty/spawnHelper', () => ({ preparePtySpawnHelper: vi.fn() }));
let pid = 100;
class FakePty {
  pid = ++pid; writes: string[] = []; sizes: number[][] = []; killed = 0; exited = false;
  data = new Set<(data: string) => void>(); exits = new Set<(event: { exitCode: number }) => void>();
  onData(fn: (data: string) => void) { this.data.add(fn); return { dispose: () => this.data.delete(fn) }; }
  onExit(fn: (event: { exitCode: number }) => void) { this.exits.add(fn); return { dispose: () => this.exits.delete(fn) }; }
  write(data: string) { this.writes.push(data); } resize(cols: number, rows: number) { this.sizes.push([cols, rows]); } kill() { this.killed++; }
  exit(code = 0) { if (this.exited) return; this.exited = true; for (const fn of this.exits) fn({ exitCode: code }); }
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function until(check: () => boolean) { for (let i = 0; i < 30; i++) { if (check()) return; await Promise.resolve(); } throw new Error('fixture did not become ready'); }
type Options = Parameters<typeof createOwnedInteractivePty>[0];
type RecordRow = { options: Options; proc: FakePty; ready: ReturnType<typeof deferred<void>>; closed: ReturnType<typeof deferred<void>>; completed: ReturnType<typeof deferred<number>>; closes: number; failures: number };
const fixtures: Array<{ manager: PtyManager; records: RecordRow[] }> = [];
function fixture(initialFailures = 0) {
  const records: RecordRow[] = [];
  const factory: typeof createOwnedInteractivePty = options => {
    const proc = options.spawn({ command: 'controlled-bootstrap', args: [], env: { ELECTRON_RUN_AS_NODE: '1' } }) as unknown as FakePty;
    const row = { options, proc, ready: deferred<void>(), closed: deferred<void>(), completed: deferred<number>(), closes: 0, failures: initialFailures }; records.push(row);
    return { ready: row.ready.promise, completed: row.completed.promise, close() { row.closes++; if (row.failures) { row.failures--; return Promise.reject(new Error('container close unconfirmed')); }
      return row.closed.promise.then(() => { proc.exit(); row.completed.resolve(0); }); } };
  };
  const manager = new PtyManager(() => null, factory);
  const result = { manager, records }; fixtures.push(result); return result;
}
beforeEach(() => { native.calls.length = 0; native.create = () => new FakePty(); });
afterEach(async () => { for (const f of fixtures.splice(0)) { for (const row of f.records) { row.failures = 0; row.ready.resolve(); row.closed.resolve(); } await f.manager.killAllAndWait(); } });
const launch = { command: 'original-shell', args: [] };

describe('interactive PTY manager ownership', () => {
  it('reports a failed late startup owner even when shutdown entered during native spawn', async () => {
    const { manager, records } = fixture(1);
    let shutdown: Promise<void> | undefined;
    manager.onPtyPid = (_id, pid) => { if (pid !== null) shutdown = manager.killAllAndWait(); };
    const start = expect(manager.spawn('s', launch, '/fixture')).rejects.toThrow('cleanup failed');
    await until(() => records.length === 1); records[0].ready.resolve();
    await start; await expect(shutdown!).rejects.toThrow('could not confirm closure');
    expect(records[0].closes).toBe(1); records[0].closed.resolve();
    await manager.killAllAndWait(); expect(records[0].closes).toBe(2);
  });
  it('queues exact input until ownership is ready and retains native resize/Ctrl+C bytes', async () => {
    const { manager, records } = fixture(); manager.getHostEnv = () => ({ MUSTER_HOST: '1' });
    const start = manager.spawn('s', launch, '/fixture'); await until(() => records.length === 1);
    expect(manager.write('s', 'echo text\r\x03')).toBe(true); expect(records[0].proc.writes).toEqual([]);
    manager.resize('s', 177, 51); expect(records[0].proc.sizes).toEqual([[177, 51]]);
    expect(records[0].options.env.TERM_PROGRAM).toBe('MusterConsole'); expect(records[0].options.env.MUSTER_HOST).toBe('1');
    records[0].ready.resolve(); const generation = await start;
    expect(manager.desktopProcessGeneration('s')).toBe(generation); expect(records[0].proc.writes).toEqual(['echo text\r\x03']);
  });

  it('cancels a queued spawn before executing any bootstrap', async () => {
    const { manager, records } = fixture(); const start = expect(manager.spawn('s', launch, '/fixture')).rejects.toThrow('cancelled');
    await manager.killAndWait('s'); await start; expect(records).toHaveLength(0);
  });

  it('rejects just the terminal request before native spawn when its helper cannot run', async () => {
    const { manager } = fixture();
    vi.mocked(preparePtySpawnHelper).mockImplementationOnce(() => { throw new Error('spawn-helper cannot execute'); });
    await expect(manager.spawn('s', launch, '/fixture')).rejects.toThrow('spawn-helper cannot execute');
    expect(native.calls).toHaveLength(0);
    expect(manager.isRunning('s')).toBe(false);
  });

  it('does not replace a PTY until actual closure and never lets the old generation kill the new one', async () => {
    const { manager, records } = fixture(); const first = manager.spawn('s', launch, '/fixture'); await until(() => records.length === 1); records[0].ready.resolve(); const old = await first, writer = manager.captureWriter('s');
    const second = manager.spawn('s', launch, '/fixture'); await Promise.resolve(); await Promise.resolve(); expect(records).toHaveLength(1);
    expect(writer.write('s', 'stale')).toBe(false); expect(manager.write('s', 'new input')).toBe(true);
    records[0].closed.resolve(); await until(() => records.length === 2); records[1].ready.resolve(); const current = await second;
    expect(current).not.toBe(old); await manager.killAndWait('s', old); expect(records[1].closes).toBe(0); expect(records[1].proc.writes).toEqual(['new input']);
  });

  it('retains failed owners after removing the UI entry and retries the same close handle', async () => {
    const { manager, records } = fixture(); const start = manager.spawn('s', launch, '/fixture'); await until(() => records.length === 1); records[0].ready.resolve(); await start;
    records[0].failures = 1; await expect(manager.killAndWait('s')).rejects.toThrow('owner retained');
    let done = false; const retried = manager.killAndWait('s').then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
    records[0].closed.resolve(); await retried; expect(records[0].closes).toBe(2);
  });

  it('never revives running state when the actual shell exits before the spawn continuation', async () => {
    const { manager, records } = fixture(); let disposed = 0; const failed = expect(manager.spawn('s', launch, '/fixture', undefined, undefined, () => disposed++)).rejects.toThrow('exited before launch committed');
    await until(() => records.length === 1); records[0].options.commandExited?.(0); records[0].proc.exit(0); records[0].ready.resolve(); records[0].closed.resolve(); await failed;
    expect(manager.isRunning('s')).toBe(false); expect(manager.desktopProcessGeneration('s')).toBeUndefined(); expect(disposed).toBe(1);
  });
});
