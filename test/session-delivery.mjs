import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-delivery-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
  const { deliverSession } = await import(pathToFileURL(compile('main/agentSession/delivery.ts')).href);
  const confirmed = { status: 'confirmed' };
  const calls = [];
  const adapter = {
    capabilities: { interject: true, snapshot: true },
    isBusy: () => true,
    async wake(content, id) { calls.push(['wake', content, id]); return confirmed; },
    async interject(content, id) { calls.push(['interject', content, id]); return confirmed; },
    async snapshot(id) { calls.push(['snapshot', id]); return 'original work'; },
    async interrupt(id) { calls.push(['interrupt', id]); return confirmed; },
    async queue(content, id, reason) { calls.push(['queue', content, id, reason]); }
  };
  const run = priority => deliverSession(adapter, 'event', { priority, deliveryId: 'wait-1' });

  assert.equal((await run('normal')).status, 'queued');
  assert.deepEqual(calls.splice(0).map(c => c[0]), ['queue']);
  assert.equal((await run('preempt')).status, 'confirmed');
  assert.deepEqual(calls.splice(0).map(c => c[0]), ['interject']);

  adapter.interject = async () => ({ status: 'unsupported', reason: 'no channel' });
  assert.equal((await run('preempt')).status, 'confirmed');
  assert.deepEqual(calls.map(c => c[0]), ['snapshot', 'interrupt', 'wake']);
  assert.match(calls[2][1], /event[\s\S]*original work/);
  calls.length = 0;

  adapter.interject = async () => ({ status: 'uncertain', reason: 'timeout' });
  assert.equal((await run('preempt')).status, 'uncertain');
  assert.deepEqual(calls, [], 'unknown submission must not stop or send again');
  adapter.interject = async () => ({ status: 'deferred', reason: 'native busy' });
  assert.equal((await run('preempt')).status, 'deferred');
  assert.deepEqual(calls, []);
  adapter.interject = async () => ({ status: 'unsupported', reason: 'no channel' });
  adapter.snapshot = async () => { throw new Error('snapshot unavailable'); };
  assert.equal((await run('preempt')).status, 'deferred');
  assert.deepEqual(calls, [], 'snapshot failure must not interrupt the live turn');
  adapter.capabilities.interject = false;
  adapter.capabilities.snapshot = false;
  assert.equal((await run('preempt')).status, 'queued');
  assert.match(calls.pop()[3], /No preemption channel/);
  assert.deepEqual(calls, [], 'no native preemption capability must not interrupt or submit while busy');
  adapter.isBusy = () => false;
  assert.equal((await run('normal')).status, 'confirmed');
  assert.deepEqual(calls.splice(0), [['wake', 'event', 'wait-1']], 'idle delivery uses the ordinary host channel without a wake declaration');
  assert.equal((await run('preempt')).status, 'confirmed');
  assert.deepEqual(calls.splice(0), [['wake', 'event', 'wait-1']], 'a deferred preempt request uses the same channel at the idle boundary');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
}
console.log('session-delivery: ok');
