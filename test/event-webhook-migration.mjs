import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'event-webhook-'));
let log, server;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
  const load = p => import(pathToFileURL(compile(p)).href);
  const { EventLog } = await load('main/awareness/eventLog.ts');
  const { EventRouter } = await load('main/awareness/eventRouter.ts');
  const { handleHookRequest } = await load('main/webAccess/hookRoute.ts');
  log = new EventLog(path.join(tmp, 'db'));
  log.subscribe({subject:'session',workspaceId:'w',source:'gitlab',types:['issue'],scope:'6528',mode:'instant',createdAt:Date.now(),expiresAt:null});
  const delivered = [];
  const router = new EventRouter(log, async (sub, event) => { delivered.push({ sub, event }); });
  server = http.createServer((req, res) => void handleHookRequest(req, res, {
    getHookToken: () => 'path-token', getHookSecret: () => 'shared-secret',
    ingestWebhook: async input => { router.publish(input); return { triggered: 0, skipped: 0, queued: true }; }
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/hook/path-token`;
  const payload = JSON.stringify({ object_kind: 'issue', project: { id: 6528 }, object_attributes: { project_id: 6528, iid: 42, action: 'open', title: 'issue' } });
  const send = () => fetch(url, { method: 'POST', headers: { 'x-gitlab-token': 'shared-secret', 'x-gitlab-event': 'Issue Hook', 'x-gitlab-event-uuid': 'uuid-1' }, body: payload });
  assert.equal((await (await send()).json()).queued, true);
  await router.replay();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].sub.subject, 'session');
  assert.equal(delivered[0].event.scope, '6528');
  await send(); await router.replay();
  assert.equal(delivered.length, 1, 'GitLab redelivery does not duplicate event notification');
  assert.equal(log.list().length, 1);
  assert.equal(log.payload(log.list()[0].id).text, payload);
  router.stop(); await new Promise(resolve => server.close(resolve)); server = undefined;
  log.close(); log = undefined;
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  log?.close(); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
}
console.log('event-webhook-migration: ok');
