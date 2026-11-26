import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'controlled-child-'));
const owners = [];
const closed = child => new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
try {
  const compile = createSharedCompiler(process.cwd(), folder);
  const { createControlledChild, shutdownControlledChildren } = await import(pathToFileURL(compile('main/agentSession/process/controlledChild.ts')));
  const secret = 'fixture-pipe-only-秘密';
  const source = `const crypto=require('node:crypto');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{console.log(JSON.stringify({hash:crypto.createHash('sha256').update(input).digest('hex'),args:process.argv.slice(1),custom:process.env.CUSTOM,leaked:process.env.MUSTER_FIXTURE_PARENT,owner:process.env.MUSTER_BG_OWNER_TOKEN}));process.exitCode=9;});`;
  process.env.MUSTER_FIXTURE_PARENT = 'must-not-reappear';
  const owner = createControlledChild(process.execPath, ['-e', source, 'space value', '中文"quote'], {
    cwd: new URL(pathToFileURL(folder).href + '/'), env: { CUSTOM: 'exact-child-env', ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  owners.push(owner); let output = ''; owner.child.stdout.on('data', data => { output += data; }); owner.child.stderr.resume();
  const done = closed(owner.child);
  owner.child.stdin.end(secret); // Write before async Job readiness, as the Claude SDK does.
  await owner.ready;
  assert.ok(owner.child.pid > 0);
  assert.equal((await done).code, 9);
  assert.equal(owner.child.killed, false, 'natural completion preserves a normal process outcome');
  const response = JSON.parse(output);
  assert.equal(response.hash, crypto.createHash('sha256').update(secret).digest('hex'));
  assert.deepEqual(response.args, ['space value', '中文"quote']);
  assert.equal(response.custom, 'exact-child-env'); assert.equal(response.leaked, undefined); assert.equal(response.owner, undefined);
  assert.equal(owner.child.spawnargs.includes(secret), false, 'stdin credentials never move into argv');

  const sideEffect = path.join(folder, 'never-started');
  const cancelled = createControlledChild(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sideEffect)},'bad')`], { cwd: folder });
  owners.push(cancelled); const cancellation = closed(cancelled.child); const startup = cancelled.ready.catch(error => error);
  await cancelled.reclaim(); await cancellation; assert.ok(await startup instanceof Error);
  assert.equal(fs.existsSync(sideEffect), false, 'cancel during bootstrap never activates user code');

  const active = createControlledChild(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], { cwd: folder });
  owners.push(active); active.child.stdout.resume(); active.child.stderr.resume(); const activeClose = closed(active.child);
  let exitDelivered = false; active.child.once('exit', () => { exitDelivered = true; });
  await active.ready;
  await Promise.all([active.reclaim(), active.reclaim()]); await activeClose;
  assert.equal(active.child.killed && exitDelivered, true, 'SDK waitForExit can recognize an already delivered host-owned termination');
  const readGate = path.join(folder, 'allow-stdin');
  const slowSource = `const fs=require('node:fs'),crypto=require('node:crypto');let bytes=0;const hash=crypto.createHash('sha256');process.stdin.on('data',data=>{bytes+=data.length;hash.update(data);});process.stdin.on('end',()=>{console.log(JSON.stringify({bytes,hash:hash.digest('hex')}));clearInterval(timer);});process.stdin.pause();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(readGate)})){process.stdin.resume();clearInterval(timer);}},10);`;
  const slow = createControlledChild(process.execPath, ['-e', slowSource], { cwd: folder }); owners.push(slow);
  let slowOutput = ''; slow.child.stdout.on('data', data => { slowOutput += data; }); slow.child.stderr.resume(); slow.child.stdin.on('error', () => {});
  const slowClosed = closed(slow.child); await slow.ready;
  const large = Buffer.alloc(20 * 1024 * 1024, 120); let inputFinished = false;
  const input = new Promise(resolve => { assert.equal(slow.child.stdin.write(large, error => { inputFinished = true; resolve(error); }), false); });
  slow.child.stdin.end();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(inputFinished, false, 'stdin callback waits for the slow reader, not local socket buffering');
  fs.writeFileSync(readGate, 'read'); assert.ifError(await input); await slowClosed;
  const received = JSON.parse(slowOutput);
  assert.equal(received.bytes, large.length, 'a chunk larger than the protocol frame cap is split without loss');
  assert.equal(received.hash, crypto.createHash('sha256').update(large).digest('hex'), 'EOF follows every acknowledged input byte');

  const blocked = createControlledChild(process.execPath, ['-e', 'process.stdin.pause();setInterval(()=>{},1000)'], { cwd: folder }); owners.push(blocked);
  blocked.child.stdout.resume(); blocked.child.stderr.resume(); blocked.child.stdin.on('error', () => {});
  const blockedClosed = closed(blocked.child); await blocked.ready;
  let writeSettled = false;
  const blockedWrite = new Promise(resolve => blocked.child.stdin.write(Buffer.alloc(2 * 1024 * 1024), error => { writeSettled = true; resolve(error); }));
  await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(writeSettled, false);
  await blocked.reclaim(); await blockedClosed;
  assert.ok(await blockedWrite instanceof Error, 'closing a blocked stdin rejects its pending acknowledgement');
  await shutdownControlledChildren();
  assert.throws(() => createControlledChild(process.execPath, [], { cwd: folder }), /stopping/);
  console.log(`controlled child: ${process.platform} real Job/group, pre-ready stdin, exact env, argv, cancellation and global drain passed`);
} finally {
  delete process.env.MUSTER_FIXTURE_PARENT;
  await Promise.allSettled(owners.map(owner => owner.reclaim()));
  fs.rmSync(folder, { recursive: true, force: true });
}
