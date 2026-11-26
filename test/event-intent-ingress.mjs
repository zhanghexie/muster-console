import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'event-intent-'));
let log;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
  const load = p => import(pathToFileURL(compile(p)).href);
  const { EventLog } = await load('main/awareness/eventLog.ts');
  const { EventRouter } = await load('main/awareness/eventRouter.ts');
  const { bindMemoryIntentEvents } = await load('main/memory/runtime.ts');
  const { emitMemoryIntentEvent } = await load('main/memory/intentEvents.ts');
  log = new EventLog(path.join(tmp, 'db'));
  const delivered = [];
  const router = new EventRouter(log, async (sub, event) => delivered.push({ sub, event }));
  const ctx = { eventRouter: router, workspaces: { list: () => [{ id: 'w', path: tmp }] } };
  bindMemoryIntentEvents(ctx);
  emitMemoryIntentEvent({ kind: 'merge_blocked', workspaceId: 'w', branch: 'feature' });
  await router.replay();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].sub.subject, 'system:intent:w');
  assert.equal(delivered[0].event.type, 'merge_blocked');
  assert.equal(JSON.parse(log.payload(delivered[0].event.id).text).branch, 'feature');
  await router.replay();
  assert.equal(delivered.length, 1);
  router.stop(); log.close(); log = undefined;
} finally { log?.close(); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); }
console.log('event-intent-ingress: ok');
