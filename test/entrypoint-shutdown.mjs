import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-shutdown-'));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
try {
  const compile = createSharedCompiler(process.cwd(), folder);
  const load = async source => import(pathToFileURL(compile(source)));
  const { CliRunService } = await load('main/cliRuns/service.ts');
  const { CliRunStore } = await load('main/cliRuns/runtime.ts');
  const { CliServer } = await load('main/cliRuns/server.ts');
  const dispatch = deferred(); let admit;
  const store = new CliRunStore(path.join(folder, 'runs'));
  const service = new CliRunService(store, { workspaces: () => [{ id: 'one', name: 'One' }],
    dispatch: async (_run, _input, accept) => { admit = accept; await dispatch.promise; return accept(); } });
  const server = new CliServer(service);
  await server.start(path.join(folder, 'discovery'), 'fixture', '1');
  const run = service.submit('one', 'work');
  assert.equal(typeof admit, 'function');
  let stopped = false;
  const closing = server.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false, 'accepted dispatch outlives its transport');
  assert.equal(admit(), false, 'shutdown rejects a late scheduler admission');
  assert.equal(store.get(run.runId).pending.length, 1, 'unadmitted instructions remain pending');
  dispatch.resolve(); await closing;

  const second = new CliServer(new CliRunService(store, { workspaces: () => [] }));
  const discovery = path.join(folder, 'corrupt-discovery');
  await second.start(discovery, 'corrupt', '1');
  const address = second.server.address();
  fs.writeFileSync(path.join(discovery, 'corrupt.json'), 'broken JSON');
  await assert.rejects(second.stop(), /CLI shutdown failed/);
  assert.equal(second.server.listening, false, 'descriptor errors must still close the listening socket');
  await assert.rejects(fetch(`http://127.0.0.1:${address.port}`), /fetch failed/);
  fs.unlinkSync(path.join(discovery, 'corrupt.json')); await second.stop();

  const { AgentAppsServiceClient } = await load('main/agentApps/serviceClient.ts');
  const workerFile = path.join(folder, 'host-worker.cjs');
  fs.writeFileSync(workerFile, `const {parentPort}=require('node:worker_threads'); parentPort.on('message',m=>{ if(m.kind==='request'){ parentPort.postMessage({kind:'result',id:m.id,result:null}); if(m.method==='start')parentPort.postMessage({kind:'host-call',id:99,method:'confirmSend',args:['one','mail',{}]}); }});`);
  const host = deferred(), entered = deferred(); let signal;
  const client = new AgentAppsServiceClient(workerFile, { root: folder, workspaces: () => [], emit() {}, connectors: { async closeImap() {} },
    confirmSend: async (_ws, _app, _values, source) => { signal = source; entered.resolve(); await host.promise; return false; } });
  try {
    await client.start(); await entered.promise;
    let complete = false;
    const stop = client.stop().then(() => { complete = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.aborted, true, 'worker stop cancels actual host UI request');
    assert.equal(complete, false, 'worker termination is not host callback completion');
    host.resolve(); await stop;
  } finally { host.resolve(); await client.stop(); }
  const retryClient = new AgentAppsServiceClient(workerFile, { root: folder, workspaces: () => [], emit() {}, connectors: { async closeImap() {} }, confirmSend: async () => false });
  await retryClient.start();
  const terminate = retryClient.worker.terminate.bind(retryClient.worker);
  retryClient.worker.terminate = async () => { throw Error('fixture terminate denied'); };
  await assert.rejects(retryClient.stop(), /App service shutdown failed/);
  retryClient.worker.terminate = terminate;
  await retryClient.stop();
  console.log('CLI dispatch and app-worker host callback shutdown barriers passed');
} finally { fs.rmSync(folder, { recursive: true, force: true }); }
