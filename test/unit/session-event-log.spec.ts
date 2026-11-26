import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionEventLog } from '../../src/main/runtimeKernel/sessionEventLog';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-session-log-'));
  roots.push(root);
  return root;
}

function event(sessionId: string, type: string, payload: unknown) {
  return { eventId: `${type}-${Math.random()}`, sessionId, seq: 999, type, schemaVersion: 1, createdAt: Date.now(), payload };
}

describe('SessionEventLog', () => {
  it('keeps accepted batches readable during async flush and replays a shared writer without duplicates', async () => {
    const root = createRoot(), log = new SessionEventLog(root, 'flush-race', { writeBehindMs: 60_000 });
    log.appendSync(event('flush-race', 'message', { text: 'first' }));
    await log.flush('seed');
    log.appendSync(event('flush-race', 'message', { text: 'second' }));
    const append = fs.promises.appendFile.bind(fs.promises);
    let finish!: () => void;
    const blocked = vi.spyOn(fs.promises, 'appendFile').mockImplementationOnce(async (...args) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return append(...args);
    });
    const flush = log.flush('blocked');
    try {
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      log.appendSync(event('flush-race', 'message', { text: 'third' }));
      const replayed: number[] = []; log.loadSync(item => replayed.push(item.seq));
      expect(replayed).toEqual([1, 2, 3]);
      expect(log.readAllSync().map(item => item.seq)).toEqual([1, 2, 3]);
      expect(log.readRangeSync({limit: 10}).map(item => item.seq)).toEqual([1, 2, 3]);
      expect((await log.readRange({ limit: 10 })).map(item => item.seq)).toEqual([1, 2, 3]);
      expect(() => log.deleteSync()).toThrow('write is in flight');
    } finally { finish(); await flush; blocked.mockRestore(); }
    const replayed: number[] = []; log.loadSync(item => replayed.push(item.seq));
    expect(replayed).toEqual([1, 2, 3]);
  });
  it('assigns monotonic seq values, publishes live events and bounds range reads', async () => {
    const root = createRoot();
    const log = new SessionEventLog(root, 'session-a', { writeBehindMs: 60_000 });
    const live: number[] = [];
    const unsubscribe = log.subscribeLive(item => live.push(item.seq));
    expect(await log.append(event('session-a', 'message', { text: 'one' }))).toEqual({ seq: 1 });
    expect(await log.append(event('session-a', 'message', { text: 'two' }))).toEqual({ seq: 2 });
    unsubscribe();
    expect(await log.readRange({ fromSeq: 1, limit: 1 })).toMatchObject([{ seq: 1, payload: { text: 'one' } }]);
    expect(await log.readRange({ fromSeq: 1, toSeq: 10, limit: 10 })).toHaveLength(2);
    expect(live).toEqual([1, 2]);
  });

  it('treats a retried event id as an idempotent append', async () => {
    const log = new SessionEventLog(createRoot(), 'session-retry', { writeBehindMs: 60_000 });
    const first = event('session-retry', 'message', { text: 'retry me' });
    expect(await log.append(first)).toEqual({ seq: 1 });
    expect(await log.append(first)).toEqual({ seq: 1 });
    expect(await log.readRange({ limit: 10 })).toHaveLength(1);
  });

  it('flushes append batches and restores them without rewriting the full history', async () => {
    const root = createRoot();
    const original = new SessionEventLog(root, 'session-b', { writeBehindMs: 60_000 });
    await original.append(event('session-b', 'message', { text: 'one' }));
    expect(fs.existsSync(path.join(root, 'session-b.ndjson'))).toBe(false);
    await original.flush('test');
    await original.append(event('session-b', 'message', { text: 'two' }));
    await original.flush('test');
    const restored = new SessionEventLog(root, 'session-b', { writeBehindMs: 60_000 });
    expect(await restored.readRange({ limit: 10 })).toMatchObject([
      { seq: 1, payload: { text: 'one' } },
      { seq: 2, payload: { text: 'two' } }
    ]);
  });

  it('persists sparse byte offsets and seeks from a validated sidecar after restart', async () => {
    const root = createRoot();
    const options = { writeBehindMs: 60_000, offsetIndexStride: 2 };
    const original = new SessionEventLog(root, 'session-indexed', options);
    for (let seq = 1; seq <= 6; seq += 1) {
      await original.append(event('session-indexed', 'message', { text: `第${seq}条` }));
    }
    await original.flush('index');

    const file = path.join(root, 'session-indexed.ndjson');
    const sidecarFile = `${file}.index.json`;
    const sidecar = JSON.parse(fs.readFileSync(sidecarFile, 'utf8')) as {
      stride: number;
      lastSeq: number;
      checkpoints: Array<{ seq: number; byteOffset: number }>;
    };
    expect(sidecar).toMatchObject({ stride: 2, lastSeq: 6 });
    expect(sidecar.checkpoints.length).toBe(3);
    expect(sidecar.checkpoints[1].byteOffset).toBeGreaterThan(0);

    const createReadStream = vi.spyOn(fs, 'createReadStream');
    const restored = new SessionEventLog(root, 'session-indexed', options);
    await expect(restored.readRange({ fromSeq: 5, limit: 2 })).resolves.toMatchObject([
      { seq: 5, payload: { text: '第5条' } },
      { seq: 6, payload: { text: '第6条' } }
    ]);
    expect(createReadStream.mock.calls.some(([, streamOptions]) =>
      !!streamOptions && typeof streamOptions === 'object' && Number(streamOptions.start) > 0
    )).toBe(true);
    createReadStream.mockRestore();
  });

  it('keeps long JSON lines intact across reusable stream buffers', async () => {
    const root = createRoot();
    const original = new SessionEventLog(root, 'session-long-line', { writeBehindMs: 60_000 });
    const text = `${'前缀'.repeat(40_000)}-tail`;
    await original.append(event('session-long-line', 'message', { text }));
    await original.flush('long-line');

    const restored = new SessionEventLog(root, 'session-long-line', { writeBehindMs: 60_000 });
    expect(restored.readAllSync()[0]?.payload).toMatchObject({ text });
    const asyncRestored = new SessionEventLog(root, 'session-long-line', { writeBehindMs: 60_000 });
    await expect(asyncRestored.readRange({ limit: 1 })).resolves.toMatchObject([{ payload: { text } }]);
  });

  it('rebuilds a stale sidecar from the authoritative log before seeking', async () => {
    const root = createRoot();
    const options = { writeBehindMs: 60_000, offsetIndexStride: 2 };
    const original = new SessionEventLog(root, 'session-index-rebuild', options);
    for (let seq = 1; seq <= 4; seq += 1) {
      await original.append(event('session-index-rebuild', 'message', { seq }));
    }
    await original.flush('index');

    const sidecarFile = path.join(root, 'session-index-rebuild.ndjson.index.json');
    const stale = JSON.parse(fs.readFileSync(sidecarFile, 'utf8')) as {
      checkpoints: Array<{ seq: number; byteOffset: number }>;
    };
    stale.checkpoints[1].byteOffset += 1;
    fs.writeFileSync(sidecarFile, `${JSON.stringify(stale)}\n`, 'utf8');

    const restored = new SessionEventLog(root, 'session-index-rebuild', options);
    await expect(restored.readRange({ fromSeq: 3, limit: 1 })).resolves.toMatchObject([
      { seq: 3, payload: { seq: 3 } }
    ]);
    const repaired = JSON.parse(fs.readFileSync(sidecarFile, 'utf8')) as {
      checkpoints: Array<{ seq: number; byteOffset: number }>;
    };
    expect(repaired.checkpoints[1].byteOffset).not.toBe(stale.checkpoints[1].byteOffset);
  });

  it('recovers an unterminated torn tail while keeping newline-delimited corruption fatal', async () => {
    const validRoot = createRoot();
    const validOriginal = new SessionEventLog(validRoot, 'session-valid-tail', { writeBehindMs: 60_000 });
    await validOriginal.append(event('session-valid-tail', 'message', { text: 'one' }));
    await validOriginal.flush('test');
    const validFile = path.join(validRoot, 'session-valid-tail.ndjson');
    fs.writeFileSync(validFile, fs.readFileSync(validFile, 'utf8').replace(/\n$/, ''), 'utf8');
    const validRestored = new SessionEventLog(validRoot, 'session-valid-tail', { writeBehindMs: 60_000 });
    expect(await validRestored.readRange({ limit: 10 })).toHaveLength(1);
    expect(fs.readFileSync(validFile, 'utf8').endsWith('\n')).toBe(true);

    const root = createRoot();
    const original = new SessionEventLog(root, 'session-tail', { writeBehindMs: 60_000 });
    await original.append(event('session-tail', 'message', { text: 'one' }));
    await original.flush('test');
    const file = path.join(root, 'session-tail.ndjson');
    fs.appendFileSync(file, '{"eventId":"torn"', 'utf8');
    const restored = new SessionEventLog(root, 'session-tail', { writeBehindMs: 60_000 });
    expect(await restored.readRange({ limit: 10 })).toMatchObject([{ seq: 1, payload: { text: 'one' } }]);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('torn');

    fs.appendFileSync(file, '{"eventId":"bad"}\n', 'utf8');
    const corrupted = new SessionEventLog(root, 'session-tail', { writeBehindMs: 60_000 });
    await expect(corrupted.readRange({ limit: 10 })).rejects.toThrow('invalid envelope');
  });

  it('forks a bounded prefix into a new session id', async () => {
    const root = createRoot();
    const log = new SessionEventLog(root, 'session-c', { writeBehindMs: 60_000, createEventId: (() => {
      let n = 0;
      return () => `fork-${++n}`;
    })() });
    await log.append(event('session-c', 'message', { text: 'one' }));
    await log.append(event('session-c', 'message', { text: 'two' }));
    const fork = await log.fork({ atSeq: 1 });
    expect(fork.sessionId).toBe('fork-1');
    const forked = new SessionEventLog(root, fork.sessionId, { writeBehindMs: 60_000 });
    expect(await forked.readRange({ limit: 10 })).toMatchObject([{ seq: 1, sessionId: 'fork-1', payload: { text: 'one' } }]);
  });

  it('rejects unbounded ranges and cross-session events', async () => {
    const log = new SessionEventLog(createRoot(), 'session-d', { writeBehindMs: 60_000 });
    await expect(log.readRange({ limit: 0 })).rejects.toThrow('between 1 and');
    await expect(log.append(event('other', 'message', {}))).rejects.toThrow('another session');
  });

  it('bounds pending encoded bytes without advancing the sequence on rejection', () => {
    const log = new SessionEventLog(createRoot(), 'pending-budget', { writeBehindMs: 60_000, maxPendingBytes: 450 });
    const first = event('pending-budget', 'message', { text: 'a'.repeat(100) });
    expect(log.appendSync(first)).toEqual({ seq: 1 });
    expect(log.pendingBytesCount).toBeGreaterThan(0);
    expect(() => log.appendSync(event('pending-budget', 'message', { text: 'b'.repeat(100) })))
      .toThrow('pending byte limit exceeded');
    expect(log.readRangeSync({ limit: 10 }).map(item => item.seq)).toEqual([1]);
    expect(log.pendingBytesCount).toBeLessThanOrEqual(450);
    log.flushSync();
    expect(log.pendingBytesCount).toBe(0);
  });

  it('forks in bounded batches without reading the full log or including later appends', async () => {
    const root = createRoot();
    let id = 0;
    const log = new SessionEventLog(root, 'parent', { writeBehindMs: 60_000, createEventId: () => `child-${++id}` });
    for (let i = 0; i < 1200; i++) log.appendSync(event('parent', 'message', { i }));
    const fullRead = vi.spyOn(log, 'readAll').mockRejectedValue(new Error('unbounded read forbidden'));
    const readRange = log.readRange.bind(log);
    const ranges = vi.spyOn(log, 'readRange').mockImplementation(async query => {
      if (query.fromSeq === 1) await log.append(event('parent', 'message', { i: 1200 }));
      return readRange(query);
    });
    const fork = await log.fork();
    expect(fullRead).not.toHaveBeenCalled();
    expect(ranges.mock.calls.map(([query]) => query.fromSeq)).toEqual([1, 513, 1025]);
    expect(ranges.mock.calls.every(([query]) => query.limit <= 512 && query.toSeq === 1200)).toBe(true);
    const child = new SessionEventLog(root, fork.sessionId);
    expect(await child.readRange({ fromSeq: 1200, limit: 10 })).toMatchObject([{ seq: 1200, payload: { i: 1199 } }]);
    await log.flush('test');
  });

  it('never truncates an existing fork destination and removes failed partial forks', async () => {
    const root = createRoot();
    const log = new SessionEventLog(root, 'parent', { createEventId: () => 'child', writeBehindMs: 60_000 });
    log.appendSync(event('parent', 'message', {}));
    const file = path.join(root, 'child.ndjson');
    fs.writeFileSync(file, 'existing session');
    await expect(log.fork()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fs.readFileSync(file, 'utf8')).toBe('existing session');
    fs.unlinkSync(file);
    vi.spyOn(log, 'readRange').mockRejectedValueOnce(new Error('read failed'));
    await expect(log.fork()).rejects.toThrow('read failed');
    expect(fs.existsSync(file)).toBe(false);
    expect(await log.readRange({ limit: 1 })).toHaveLength(1);
    for (const atSeq of [-1, 0.5, NaN, Infinity]) {
      await expect(log.fork({ atSeq })).rejects.toThrow('safe integer');
    }
  });
  it('cold-opens from a valid sidecar without scanning bodies and preserves recent event deduplication', async () => {
    const root = createRoot(), sessionId = 'cold-index';
    const log = new SessionEventLog(root, sessionId, { writeBehindMs: 60000 });
    let last = event(sessionId, 'message', {text: ''});
    for (let i = 0; i < 2000; i++) {
      last = event(sessionId, 'message', {text: 'body'.repeat(100)});
      log.appendSync(last);
    }
    await log.flush('seed');
    const restored = new SessionEventLog(root, sessionId, { writeBehindMs: 60000 });
    const read = vi.spyOn(fs, 'readSync');
    try {
      restored.loadSync();
      expect(read).not.toHaveBeenCalled();
      expect(restored.appendSync(last)).toEqual({seq: 2000});
      expect(restored.readRangeSync({fromSeq: 1999, limit: 2}).map(item => item.seq)).toEqual([1999, 2000]);
      const next = restored.appendSync(event(sessionId, 'message', {text: 'new'}));
      expect(next.seq).toBe(2001);
      expect(restored.readRangeSync({fromSeq: 2000, limit: 2}).map(item => item.seq)).toEqual([2000, 2001]);
    } finally { read.mockRestore(); restored.flushSync(); }
  });

  it.each(['recent-id', 'recent-seq', 'missing-checksum'])('rebuilds legal-JSON sidecar damage (%s) from event facts without false deduplication', async mutation => {
    const root = createRoot(), sessionId = `integrity-${mutation}`;
    const log = new SessionEventLog(root, sessionId, {writeBehindMs:60000});
    let last = event(sessionId,'message',{index:0});
    for(let index=0;index<8;index++){last=event(sessionId,'message',{index});log.appendSync(last);}
    await log.flush('seed');
    const file = path.join(root,`${sessionId}.ndjson.index.json`);
    const snapshot = JSON.parse(fs.readFileSync(file,'utf8'));
    const fakeId = 'damaged-recovery-id';
    if(mutation==='recent-id')snapshot.recentEventIds.at(-1)[0]=fakeId;
    if(mutation==='recent-seq')snapshot.recentEventIds.at(-1)[1]=7;
    if(mutation==='missing-checksum')delete snapshot.checksum;
    fs.writeFileSync(file,JSON.stringify(snapshot));
    const restored = new SessionEventLog(root,sessionId,{writeBehindMs:60000});
    const read = vi.spyOn(fs,'readSync');
    try {
      restored.loadSync();
      expect(read).toHaveBeenCalled();
      expect(restored.appendSync(last)).toEqual({seq:8});
      expect(restored.appendSync({...event(sessionId,'message',{index:8}),eventId:fakeId})).toEqual({seq:9});
      expect(restored.readRangeSync({limit:20}).map(item=>item.seq)).toEqual([1,2,3,4,5,6,7,8,9]);
    } finally {read.mockRestore();restored.flushSync();}
    const fresh = new SessionEventLog(root,sessionId);
    const fastRead = vi.spyOn(fs,'readSync');
    try {fresh.loadSync();expect(fastRead).not.toHaveBeenCalled();}
    finally {fastRead.mockRestore();}
  });

});
