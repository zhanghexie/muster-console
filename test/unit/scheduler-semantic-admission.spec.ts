import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSessionManager } from '../../src/main/runtimeKernel/sessionManager';
import { send } from '../../src/main/agent/orchestrator/sendPipeline';
import { sendNow } from '../../src/main/agent/orchestrator/queueOps';
import { MAX_AGENT_QUEUE } from '../../src/main/agent/orchestrator/types';
import type { TurnGateQueueItem } from '../../src/shared/turnGate';
import type { OrchestratorHost } from '../../src/main/agent/orchestrator/internal';
vi.mock('electron', () => ({ app: { getPath: () => '/unused-semantic-root' } }));
vi.mock('../../src/main/memory/runtime', () => ({ getMemoryService: () => undefined, resolveMemoryWorkspaceRoot: () => undefined }));
vi.mock('../../src/main/agent/orchestrator/askQuestions', () => ({ abortPendingAsk: vi.fn() }));
vi.mock('../../src/main/desktop/turnGrant', () => ({ desktopTurnGrants: { nextUserMessage: vi.fn() } }));
const fixtures: Array<{ dir: string; manager: FileSessionManager; end: () => void }> = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-scheduler-admit-'));
  const manager = new FileSessionManager(dir);
  const bucket = { display: [] as Array<{ id: string }>, queue: [] as Array<{ id: string }>, busy: false };
  let finish = (): void => {};
  const host = { ctx: { sessionLogs: manager, config: { get: () => ({}) }, notify: { push: vi.fn() } },
    checkSendImages: () => ({ ok: true }), ensureBucket: () => bucket, maybeIdleMicrocompact: async () => {},
    turnGate: { release: vi.fn() }, emit: vi.fn(), persistBucket: vi.fn(),
    startTurn: vi.fn(() => { bucket.busy = true; return new Promise<void>(resolve => { finish = resolve; }); }) } as unknown as OrchestratorHost;
  host.send = (text, wsId = 'ws', images, opts) => send(host, text, wsId, images, opts);
  const events = () => fs.readdirSync(dir).filter(name => name.endsWith('.ndjson')).flatMap(name => fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  fixtures.push({ dir, manager, end: () => finish() });
  return { dir, manager, bucket, host, events, end: () => finish() };
}
afterEach(async () => { for (const f of fixtures.splice(0)) { f.end(); await f.manager.dispose(); fs.rmSync(f.dir, { recursive: true, force: true }); } vi.restoreAllMocks(); });

describe('scheduler sendNow receipt', () => {
  it('acknowledges an idle send while its model turn is still running', async () => {
    const f = fixture();
    const received = vi.fn();
    const sending = sendNow(f.host, 'manually confirmed', 'ws').then(received);
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith('sent'));
    expect(f.host.startTurn).toHaveBeenCalledOnce();
    expect(f.bucket.display).toHaveLength(1);
    expect(f.bucket.busy).toBe(true);
    f.end();
    await sending;
  });

  it('reports the actual queue disposition if the scheduler becomes busy before admission', async () => {
    const f = fixture();
    f.host.maybeIdleMicrocompact = async () => { f.bucket.busy = true; };
    await expect(sendNow(f.host, 'manually confirmed', 'ws')).resolves.toBe('queued');
    expect(f.bucket.queue).toHaveLength(1);
    expect(f.host.startTurn).not.toHaveBeenCalled();
  });

  it('rejects a full fallback queue so the original row can be retried', async () => {
    const f = fixture();
    f.bucket.busy = true;
    f.bucket.queue = Array.from({ length: MAX_AGENT_QUEUE }, (_, index) => ({ id: `existing-${index}` }));
    await expect(sendNow(f.host, 'manually confirmed', 'ws')).resolves.toBe('failed');
    expect(f.bucket.queue).toHaveLength(MAX_AGENT_QUEUE);
    expect(f.bucket.display).toHaveLength(0);
  });
});

describe('scheduler semantic admission', () => {
  it('commits admission before the turn completes and never dispatches a duplicate stable ID', async () => {
    const f = fixture();
    const first = send(f.host, 'host wake', 'ws', undefined, { host: true, messageId: 'wake', gateToken: 'first' });
    await vi.waitFor(() => expect(f.events().some(event => event.type === 'semantic.scheduler.delivery.committed')).toBe(true));
    expect(f.host.startTurn).toHaveBeenCalledTimes(1);
    await send(f.host, 'host wake', 'ws', undefined, { host: true, messageId: 'wake', gateToken: 'duplicate' });
    expect(f.host.startTurn).toHaveBeenCalledTimes(1);
    expect(f.host.turnGate.release).toHaveBeenCalledWith('duplicate');
    f.end(); await first;
  });

  it('permits a definite requireIdle decline to retry with the same request ID', async () => {
    const f = fixture(); f.bucket.busy = true;
    await send(f.host, 'host wake', 'ws', undefined, { host: true, messageId: 'retry', gateToken: 'busy', requireIdle: true });
    expect(f.host.startTurn).not.toHaveBeenCalled();
    f.bucket.busy = false;
    const retry = send(f.host, 'host wake', 'ws', undefined, { host: true, messageId: 'retry', gateToken: 'retry', requireIdle: true });
    await vi.waitFor(() => expect(f.host.startTurn).toHaveBeenCalledOnce());
    f.end(); await retry;
    expect(f.events().filter(event => event.type === 'semantic.scheduler.delivery.committed')).toHaveLength(1);
  });

  it('does not acknowledge a failed durable append and retries the same request cleanly', async () => {
    const f = fixture(), onAccepted = vi.fn();
    vi.spyOn(f.host, 'emit').mockImplementationOnce(() => { throw new Error('append failed'); });
    await expect(send(f.host, 'host wake', 'ws', undefined, { host: true, messageId: 'append-retry', gateToken: 'bad', onAccepted })).rejects.toThrow('append failed');
    expect(onAccepted).not.toHaveBeenCalled(); expect(f.bucket.display).toHaveLength(0); expect(f.host.startTurn).not.toHaveBeenCalled();
    const retried = send(f.host, 'host wake', 'ws', undefined, { host: true, messageId: 'append-retry', gateToken: 'good', onAccepted });
    await vi.waitFor(() => expect(onAccepted).toHaveBeenCalledOnce());
    f.end(); await retried; expect(f.host.startTurn).toHaveBeenCalledOnce();
  });

  it('separates proven native context consumption from a failed host receipt write', async () => {
    const f = fixture();
    const batch = { ids: ['event-1'], summary: 'event', content: 'native context' };
    const completion = send(f.host, 'notification', 'ws', undefined, { host: true, messageId: 'notification', gateToken: 'gate',
      notification: { prepare: () => batch, accepted: async () => { throw new Error('host receipt write failed'); } } });
    await vi.waitFor(() => expect(f.host.startTurn).toHaveBeenCalledOnce());
    const forwarded = vi.mocked(f.host.startTurn).mock.calls[0][5]!;
    await expect(forwarded.accepted(batch)).rejects.toThrow('host receipt write failed');
    await vi.waitFor(() => expect(f.events().some(event => event.type === 'semantic.scheduler.notification-receipt-failed.committed')).toBe(true));
    const consumed = f.events().find(event => event.type === 'semantic.scheduler.notification-consumed.committed');
    expect(consumed.payload.result).toMatchObject({ boundary: 'native-context-persisted', receiptStatus: 'failed' });
    expect(f.events().some(event => event.type === 'semantic.scheduler.delivery.committed')).toBe(false);
    f.end(); await completion;
  });

  it('does not self-wait when the autonomy gate re-enters the send pipeline', async () => {
    const f = fixture(); let admitted!: Promise<void>;
    Object.assign(f.host, { gateQueue: { submit: (item: TurnGateQueueItem) => {
      admitted = send(f.host, item.text, item.workspaceId, item.images as Parameters<typeof send>[3], { ...item, host: true, gateToken: 'gate' }); return 'sent';
    } } as OrchestratorHost['gateQueue'] });
    await send(f.host, 'host wake', 'ws', undefined, { host: true, messageId: 'recursive' });
    await vi.waitFor(() => expect(f.host.startTurn).toHaveBeenCalledOnce());
    f.end(); await admitted;
    expect(f.bucket.display[0].id).toBe('recursive');
  });
});
