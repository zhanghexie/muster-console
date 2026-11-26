import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-api-shutdown-'));
let server;
try {
  const compile = createSharedCompiler(process.cwd(), folder);
  const { AcceptedWork } = await import(pathToFileURL(compile('main/net/acceptedWork.ts')));
  const { userDataStorage } = await import(pathToFileURL(compile('main/runtimeKernel/storageRootResolver.ts')));
  const ts = createRequire(import.meta.url)('typescript');
  const source = fs.readFileSync('src/main/protocol/shellApi.ts', 'utf8').replace(/^import[\s\S]*?from '[^']+';\r?\n/gm, '');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  let holdListen;
  const deps = { exports: {}, http, fs, path, AcceptedWork, userDataStorage, app: { getPath: () => folder },
    loadInstancePorts: () => undefined, saveInstancePorts() {}, ensureInstanceId: () => 'fixture', resolvePreferredPort: () => 0,
    listenPreferred: async target => {
      const port = await new Promise((resolve, reject) => { target.once('error', reject); target.listen(0, '127.0.0.1', () => { target.removeListener('error', reject); resolve(target.address().port); }); });
      if (holdListen) await holdListen;
      return { port };
    } };
  const { ShellApiServer } = Function(...Object.keys(deps), `${code}\nreturn exports;`)(...Object.values(deps));
  server = new ShellApiServer({});
  let release, entered;
  const accepted = new Promise(resolve => { entered = resolve; });
  server.handle = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  await server.start();
  const response = fetch(server.baseUrl).catch(() => null);
  await accepted;
  let closed = false;
  const closing = server.stop().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false, 'HTTP close is not accepted handler completion');
  assert.equal(server.baseUrl, '', 'discovery stops advertising a closing listener');
  release(); await closing; await response;
  await assert.rejects(server.start(), /stopping/, 'a stopped owner cannot listen again');
  let finishListen;
  holdListen = new Promise(resolve => { finishListen = resolve; });
  server = new ShellApiServer({});
  const startup = server.start();
  while (!server.server.listening) await new Promise(resolve => setImmediate(resolve));
  let finishedStop = false;
  const concurrentStop = server.stop().then(() => { finishedStop = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finishedStop, false, 'stop owns the in-flight listen continuation');
  finishListen(); await assert.rejects(startup, /stopped during startup/); await concurrentStop;
  assert.equal(server.server, null);
  console.log('Shell API real HTTP shutdown waits accepted handler completion');
} finally { await server?.stop(); fs.rmSync(folder, { recursive: true, force: true }); }
