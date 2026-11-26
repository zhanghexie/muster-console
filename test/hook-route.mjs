import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-route-'));
const compile = createSharedCompiler(process.cwd(), tmp);
const { handleHookRequest } = await import(pathToFileURL(compile('main/webAccess/hookRoute.ts')).href);
const events = [], logs = [];
let secret = '';
const server = http.createServer((req,res) => void handleHookRequest(req,res,{
  getHookToken: () => 'path-token', getHookSecret: () => secret, maxBodyBytes: 4096,
  ingestWebhook: async input => { events.push(input); return {triggered:0,skipped:0,queued:true}; },
  log: entry => logs.push(entry)
}).then(handled => { if (!handled) res.writeHead(404).end(); }));
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const url = `${base}/hook/path-token`;
const post = (headers={}, body='{}', target=url) => fetch(target,{method:'POST',headers,body});
try {
  assert.equal((await fetch(base)).status,404);
  const method = await fetch(url); assert.equal(method.status,405); assert.equal(method.headers.get('allow'),'POST');
  assert.equal((await post({},'{}',`${base}/hook/wrong`)).status,401);
  const push = await post({'x-github-event':'push'}, JSON.stringify({ref:'refs/heads/main',commits:[{}]}));
  assert.equal(push.status,200); assert.equal((await push.json()).queued,true); assert.equal(events[0].source,'github'); assert.equal(events[0].type,'push');
  assert.equal((await (await post({'x-github-event':'ping'})).json()).ignored,true);
  assert.equal((await post({},'invalid')).status,400);
  assert.equal((await post({},JSON.stringify({pad:'x'.repeat(5000)}))).status,413);
  const ready = JSON.stringify({
    action: 'ready_for_review', repository: { full_name: 'team/project' },
    number: 3, pull_request: { number: 3, draft: false, head: { sha: 'a'.repeat(40) } }
  });
  assert.equal((await post({'x-github-event':'pull_request'}, ready)).status,401);
  secret='secret';
  assert.equal((await post({'x-github-event':'push'})).status,401);
  const body=JSON.stringify({ref:'refs/heads/main',commits:[]});
  const sign = s => `sha256=${createHmac('sha256',s).update(body).digest('hex')}`;
  assert.equal((await post({'x-github-event':'push','x-hub-signature-256':sign('wrong')},body)).status,401);
  assert.equal((await post({'x-github-event':'push','x-hub-signature-256':sign(secret)},body)).status,200);
  assert.equal((await post({'x-github-event':'pull_request'}, ready)).status,401);
  const readySignature = `sha256=${createHmac('sha256', secret).update(ready).digest('hex')}`;
  const queued = await post({'x-github-event':'pull_request','x-hub-signature-256':readySignature,'x-github-delivery':'delivery-3'}, ready);
  assert.equal((await queued.json()).queued, true);
  assert.equal(events.at(-1).type, 'pull_request.ready_for_review');
  assert.equal(events.at(-1).scope, 'team/project');
  assert.equal(events.at(-1).deliveryId, 'delivery-3');
  assert.ok(logs.some(x=>x.outcome==='ignored')); assert.ok(logs.some(x=>x.outcome==='rejected'));
} finally { await new Promise(resolve=>server.close(resolve)); fs.rmSync(tmp,{recursive:true,force:true}); }
console.log('hook-route: authentication, validation and independent event ingestion passed');
