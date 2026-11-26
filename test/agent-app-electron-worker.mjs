import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, '..');
const temp = fs.realpathSync(os.tmpdir()), folder = fs.mkdtempSync(path.join(temp, 'phone-electron-worker-'));
if (path.dirname(fs.realpathSync(folder)) !== temp) throw new Error('Unexpected fixture directory');
try {
  const worker = path.join(folder, 'service-worker.cjs'), client = path.join(folder, 'service-client.cjs');
  for (const [source, outfile] of [['serviceWorker.ts', worker], ['serviceClient.ts', client]]) buildSync({ entryPoints: [path.join(root, 'src/main/agentApps', source)], outfile, bundle: true, platform: 'node', format: 'cjs', external: ['sharp'], banner: { js: `var require=require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});` }, logLevel: 'silent' });
  const script = path.join(folder, 'run.cjs');
  fs.writeFileSync(script, `
    const assert=require('node:assert/strict'),path=require('node:path');
    const {AgentAppsServiceClient}=require(${JSON.stringify(client)});
    (async()=>{
      assert.ok(process.versions.electron);
      const service=new AgentAppsServiceClient(${JSON.stringify(worker)},{root:path.join(${JSON.stringify(folder)},'data'),workspaces:()=>['fixture'],emit:()=>{},encrypt:v=>v,decrypt:v=>v,confirmSend:async()=>false,deliver:async()=>({muted:true}),connectors:{feed:async()=>[],sync:async()=>({records:[],cursor:{}}),send:async()=>({messageId:'fake'}),test:async()=>{},listFeishuChats:async()=>({chats:[]})}});
      try {await service.start();assert.equal((await service.snapshot('fixture')).apps.length,4);await service.execute('fixture',{appId:'tasks',commandId:'create',params:{values:{title:'fixture'}}},{kind:'human',runId:'fixture'});assert.equal((await service.query('fixture',{appId:'tasks'})).total,1);} finally {await service.stop();}
      console.log('electron worker SQLite passed');
    })().catch(error=>{console.error(error);process.exitCode=1});
  `);
  const result = spawnSync(require('electron'), [script], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}`);
  assert.match(result.stdout, /electron worker SQLite passed/);
  console.log('agent app Electron worker: isolated SQLite startup, query and shutdown passed');
} finally { fs.rmSync(folder, { recursive: true, force: true }); }
