import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'managed-stdio-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { ManagedStdioTransport } = await import(pathToFileURL(compile('main/desktop/managedStdioTransport.ts')));
  const jobPath = path.resolve('src/main/agentSession/drivers/codex/worker/windows-job.ps1');
  const fixture = path.join(temp, 'fixture.cjs');
  fs.writeFileSync(fixture, `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'ignore' });
child.once('spawn', () => process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'ready',params:{pid:process.pid,childPid:child.pid}})+'\\n'));
process.stdin.resume(); process.stdin.on('data', data => process.stdout.write(data)); setInterval(() => {}, 1000);`);
  const transport = new ManagedStdioTransport(process.execPath, process.env, 150, [fixture], undefined, jobPath);
  let resolveMessage;
  let message = new Promise(resolve => { resolveMessage = resolve; });
  transport.onmessage = value => resolveMessage(value);
  let closed = false;
  transport.onclose = () => { closed = true; };
  await transport.start();
  const ready = await message;
  assert.equal(ready.method, 'ready');
  message = new Promise(resolve => { resolveMessage = resolve; });
  await transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal((await message).method, 'ping');
  await transport.close();
  assert.equal(closed, true, 'close must wait for the actual child close event');
  assert.throws(() => process.kill(ready.params.pid, 0), /ESRCH/);
  assert.throws(() => process.kill(ready.params.childPid, 0), /ESRCH/, 'owned descendant should also be reclaimed');
  await assert.rejects(transport.send({ jsonrpc: '2.0', id: 2, method: 'ping' }), /not connected/);
  await transport.close();
  const exitsEarly = path.join(temp, 'exits-early.cjs');
  fs.writeFileSync(exitsEarly, 'setTimeout(() => process.exit(0), 100);');
  const early = new ManagedStdioTransport(process.execPath, process.env, 150, [exitsEarly], undefined, jobPath);
  const didExit = new Promise(resolve => { early.onclose = resolve; });
  await early.start();
  await didExit;
  if (process.platform === 'win32') await early.close();
  else await assert.rejects(early.close(), /无法.*确认/, 'an already exited POSIX root cannot prove descendant reclamation');
  if (process.platform !== 'win32') {
    const { spawnOwnedProcess } = await import(pathToFileURL(compile('main/agentSession/process/owner.ts')));
    const owner = spawnOwnedProcess({
      command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
      spawnOptions: { stdio: 'pipe' }, windows: { kind: 'taskkill' }
    });
    await owner.ready;
    const kill = process.kill;
    const denied = Object.assign(new Error('fixture permission denied'), { code: 'EPERM' });
    process.kill = (pid, signal) => {
      if (pid === -owner.child.pid && signal === 'SIGKILL') throw denied;
      return kill(pid, signal);
    };
    try {
      await assert.rejects(owner.reclaim(), error => /无法确认工作进程组全部退出/.test(error.message) && error.cause === denied);
    } finally {
      process.kill = kill;
      await owner.reclaim();
    }
  }
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
  child.connected = true;
  child.send = (message, callback) => { if (message.type === 'launch') queueMicrotask(() => child.emit('message', { type: 'driver-started' })); callback?.(); };
  let reclaimed = false;
  const fakeOwner = { child, ready: Promise.resolve(), reclaim: async () => { reclaimed = true; child.emit('close'); } };
  const broken = new ManagedStdioTransport(process.execPath, process.env, 150, [], () => fakeOwner, jobPath);
  if (process.platform === 'win32') queueMicrotask(() => child.emit('message', { type: 'wrapper-ready' }));
  let brokenError;
  const errorMessage = new Promise(resolve => { brokenError = resolve; });
  broken.onerror = brokenError;
  let brokenClosed;
  const closedMessage = new Promise(resolve => { brokenClosed = resolve; });
  broken.onclose = brokenClosed;
  await broken.start();
  try {
    child.stdout.end();
    const failure = await Promise.race([errorMessage, new Promise(resolve => setTimeout(() => resolve(null), 1500))]);
    assert.match(failure?.message ?? '', /output.*(ended|closed)/, 'an unexpectedly closed stdout must fail instead of hanging');
    await closedMessage;
    assert.equal(reclaimed, true, 'a broken driver must be reclaimed');
  } finally { await broken.close(); }
  const noisyChild = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
  noisyChild.connected = true;
  noisyChild.send = (message, callback) => { if (message.type === 'launch') queueMicrotask(() => noisyChild.emit('message', { type: 'driver-started' })); callback?.(); };
  let noisyReclaimed = false;
  const noisy = new ManagedStdioTransport(process.execPath, process.env, 150, [], () => ({ child: noisyChild,
    ready: Promise.resolve(), reclaim: async () => { noisyReclaimed = true; noisyChild.emit('close'); } }), jobPath);
  if (process.platform === 'win32') queueMicrotask(() => noisyChild.emit('message', { type: 'wrapper-ready' }));
  noisy.onerror = () => { throw new Error('observer failed'); };
  await noisy.start();
  assert.doesNotThrow(() => noisyChild.stderr.emit('error', new Error('driver pipe failed')),
    'a broken error observer must not crash the host while the driver is reclaimed');
  await noisy.close();
  assert.equal(noisyReclaimed, true);
  console.log('Managed stdio: messages and confirmed child exit passed');
} finally { removeWorkspaceFixture(temp, 'managed-stdio-'); }
