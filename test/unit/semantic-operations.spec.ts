import { currentToolInvocation, runWithToolInvocation, runOutsideToolInvocation } from '../../src/main/runtimeKernel/toolInvocation';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SemanticOperations } from '../../src/main/runtimeKernel/semanticOperations';

const roots: string[] = [];
function root(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-semantic-')); roots.push(dir); return dir; }
afterEach(() => { vi.restoreAllMocks(); for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const accepted = (result: { accepted: boolean }): boolean => result.accepted;

describe('semantic operation admission', () => {
  it('shares concurrent delivery, then rejects duplicate effects across reconstruction', async () => {
    const dir = root(), journal = new SemanticOperations('worker', dir);
    let release!: (value: { accepted: boolean }) => void;
    const effect = vi.fn(() => new Promise<{ accepted: boolean }>(resolve => { release = resolve; }));
    const first = journal.run('wake', 'request-1', ['mail-1'], effect, accepted);
    const second = journal.run('wake', 'request-1', ['mail-1'], effect, accepted);
    await vi.waitFor(() => expect(effect).toHaveBeenCalledTimes(1));
    release({ accepted: true });
    expect(await first).toEqual(await second);
    const recovered = new SemanticOperations('worker', dir);
    expect(await recovered.run('wake', 'request-1', ['mail-1'], effect, accepted)).toEqual({ accepted: true });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(recovered.acceptedCauses('wake').has('mail-1')).toBe(true);
    const events = fs.readFileSync(path.join(dir, 'sessions', fs.readdirSync(path.join(dir, 'sessions')).find(name => name.endsWith('.ndjson'))!), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(event => event.payload.phase)).toEqual(['dispatching', 'committed']);
    expect(events.every(event => event.causationId === 'mail-1' && event.correlationId === 'request-1')).toBe(true);
  });

  it('permits the same request after a definite rejection or pre-dispatch failure', async () => {
    const dir = root(), journal = new SemanticOperations('worker', dir);
    const effect = vi.fn().mockResolvedValueOnce({ accepted: false }).mockRejectedValueOnce(new Error('unavailable before submission')).mockResolvedValue({ accepted: true });
    expect(await journal.run('wake', 'retry', [], effect, accepted)).toEqual({ accepted: false });
    await expect(journal.run('wake', 'retry', [], effect, accepted)).rejects.toThrow('before submission');
    expect(await new SemanticOperations('worker', dir).run('wake', 'retry', [], effect, accepted)).toEqual({ accepted: true });
    expect(effect).toHaveBeenCalledTimes(3);
  });

  it('reports unknown admission after restart and never automatically resubmits it', async () => {
    const dir = root(), journal = new SemanticOperations('worker', dir);
    const effect = vi.fn().mockRejectedValue(Object.assign(new Error('stream lost'), { deliveryUncertain: true }));
    await expect(journal.run('wake', 'unknown', ['mail'], effect, accepted)).rejects.toMatchObject({ deliveryUncertain: true, message: expect.stringContaining('投递 unknown 的结果未知') });
    const recovered = new SemanticOperations('worker', dir);
    await expect(recovered.run('wake', 'unknown', ['mail'], effect, accepted)).rejects.toMatchObject({ deliveryUncertain: true, message: expect.stringContaining('请检查原生会话历史') });
    expect(recovered.uncertainCauses('wake')).toEqual(new Set(['mail']));
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('treats a persisted unfinished attempt as unknown without hiding a legitimate deferred retry', async () => {
    const dir = root(), journal = new SemanticOperations('worker', dir);
    let release!: (result: { accepted: boolean }) => void;
    const effect = vi.fn(() => new Promise<{ accepted: boolean }>(resolve => { release = resolve; }));
    const first = journal.run('wake', 'interrupted', ['mail'], effect, accepted);
    await vi.waitFor(() => expect(effect).toHaveBeenCalledOnce());
    const recovered = new SemanticOperations('worker', dir);
    await expect(recovered.run('wake', 'interrupted', ['mail'], effect, accepted)).rejects.toMatchObject({ deliveryUncertain: true });
    release({ accepted: false }); await first;
    const retry = vi.fn(async () => ({ accepted: true }));
    expect(await new SemanticOperations('worker', dir).run('wake', 'interrupted', ['mail'], retry, accepted)).toEqual({ accepted: true });
  });

  it('does not dispatch when durable reservation fails', async () => {
    const journal = new SemanticOperations('worker', root());
    const log = (journal as unknown as { log: { flush: () => Promise<void> } }).log;
    const flush = vi.spyOn(log, 'flush').mockRejectedValueOnce(new Error('disk unavailable'));
    const effect = vi.fn(async () => ({ accepted: true }));
    await expect(journal.run('wake', 'disk', [], effect, accepted)).rejects.toThrow('disk unavailable');
    expect(effect).not.toHaveBeenCalled();
    flush.mockRestore();
    await journal.run('wake', 'disk', [], effect, accepted);
    expect(effect).toHaveBeenCalledOnce();
  });
});

it('keeps parallel native tool causes through projected actions and clears detached host work', async () => {
  const dir = root(), journal = new SemanticOperations('recipient', dir);
  await Promise.all(['a', 'b'].map(toolCallId => runWithToolInvocation({ sessionId: 'source', turnId: 'turn', toolCallId }, async () => {
    await Promise.resolve();
    await runWithToolInvocation({ sessionId: 'source', toolCallId: `action-${toolCallId}` }, async () => {
      expect(currentToolInvocation()).toMatchObject({ toolCallId, actionId: `action-${toolCallId}` });
      await journal.fact('child-result', toolCallId, [`letter-${toolCallId}`], { ok: true });
    });
    expect(runOutsideToolInvocation(currentToolInvocation)).toBeUndefined();
  })));
  expect(currentToolInvocation()).toBeUndefined();
  const file = fs.readdirSync(path.join(dir, 'sessions')).find(name => name.endsWith('.ndjson'))!;
  const events = fs.readFileSync(path.join(dir, 'sessions', file), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(events).toHaveLength(2);
  for (const event of events) {
    const id = event.payload.operationId;
    expect(event).toMatchObject({ causationId: id, correlationId: 'source:turn', payload: {
      causes: [`letter-${id}`], invocation: { sessionId: 'source', toolCallId: id, actionId: `action-${id}`, turnId: 'turn' }
    } });
  }
  expect([...journal.acceptedCauses('child-result').keys()].sort()).toEqual(['letter-a', 'letter-b']);
});
