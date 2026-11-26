/** Real node-pty output -> production manager -> bounded wait. No external CLI/model. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

if (!process.argv.includes('--pty-child')) {
  // A naturally exited ConPTY retains its output worker. Calling node-pty.kill()
  // again enumerates the dead console (AttachConsole failed). Release the fixture's
  // owning process after assertions instead, without private SDK APIs or hiding stderr.
  const child = fork(fileURLToPath(import.meta.url), ['--pty-child'], {stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  let output = '', errors = '';
  child.stdout.on('data', data => output += data); child.stderr.on('data', data => errors += data);
  const closed = new Promise(resolve => child.once('exit', resolve));
  const timer = setTimeout(() => child.kill(), 45000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('message', resolve); child.once('error', reject);
      child.once('exit', () => reject(Error('PTY fixture exited before reporting: ' + errors)));
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(errors, '', 'real PTY fixture must have no unexpected stderr');
    process.stdout.write(output);
  } finally { child.kill(); await closed; clearTimeout(timer); }
} else {
try { await check(); process.send({ok:true}); }
catch (error) { process.send({ok:false,error:error.stack || String(error)}); }
}

async function check() {
const require = createRequire(import.meta.url), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-owner-'));
const compile = createSharedCompiler(process.cwd(), dir);
const entry = compile('main/pty/backgroundOwner.ts');
const { startOwnedBackgroundPty, backgroundPtyEndpoint } = await import(pathToFileURL(entry));
const shim = path.join(dir, 'node_modules/node-pty'); fs.mkdirSync(shim, { recursive: true });
fs.writeFileSync(path.join(shim, 'package.json'), '{"main":"index.cjs"}');
fs.writeFileSync(path.join(shim, 'index.cjs'), `exports.spawn=require(${JSON.stringify(require.resolve('node-pty'))}).spawn;`);
const { PtyManager, disposePtyAsync } = await import(pathToFileURL(compile('main/pty/manager.ts')));
const manager = new PtyManager(() => null);
assert.equal(backgroundPtyEndpoint('win32', 'C:/Temp', 'abc'), String.raw`\\.\pipe\muster-bg-abc`);
for (const platform of ['darwin', 'linux']) {
  assert.equal(backgroundPtyEndpoint(platform, '/tmp', 'abc'), '/tmp/m-bg-abc');
  assert.equal(backgroundPtyEndpoint(platform, '/var/folders/' + 'long/'.repeat(40), 'abc'), '/tmp/m-bg-abc');
}
const pty = require('node-pty');
const owners = [], processes = [];
const jobPath = path.join(process.cwd(), 'src/main/agentSession/drivers/codex/worker/windows-job.ps1');
const spawn = launch => {
  const proc = pty.spawn(launch.command, launch.args, { cwd: dir, name: 'xterm', cols: 100, rows: 25, env: { ...process.env, ...launch.env } });
  processes.push(proc); proc.onData(() => {}); return proc;
};
try {
  const marker = path.join(dir, 'tree.json');
  const script = `const fs=require('node:fs'),{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({root:process.pid,child:child.pid}));process.exit(0);`;
  const owner = await manager.spawnOwnedBackground('owned', { command: process.execPath, args: ['-e', script] }, dir, () => {}); owners.push(owner); processes.push(manager.entries.get('owned').proc);
  assert.equal(await owner.completed, 0, 'natural shell completion includes tree reclamation');
  assert.equal(manager.entries.get('owned').exitCode, 0, 'PTY projection uses logical command exit code');
  const pids = JSON.parse(fs.readFileSync(marker));
  for (const pid of [processes[0].pid, pids.root, pids.child]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const blocked = path.join(dir, 'blocked');
  await assert.rejects(startOwnedBackgroundPty({ launch: { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(blocked)},'bad')`] }, cwd: dir, spawn, assertCurrent() { throw Error('source changed'); }, jobPath }), /source changed/);
  assert.equal(fs.existsSync(blocked), false, 'source guard executes after ownership and before user command');
  if (process.platform === 'win32') {
    const staleGuardian = path.join(dir, 'stale.ps1'); fs.writeFileSync(staleGuardian, '# wrong protocol');
    const before = processes.length;
    await assert.rejects(startOwnedBackgroundPty({ launch: { command: process.execPath, args: ['-e', 'process.exit(0)'] }, cwd: dir, spawn, assertCurrent() {}, jobPath: staleGuardian }), /协议|守护/);
    assert.equal(processes.length, before, 'invalid Job protocol is rejected before spawning a PTY');
  }
  const runningMarker = path.join(dir, 'running.json');
  const running = await startOwnedBackgroundPty({ launch: { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(runningMarker)},String(process.pid));setInterval(()=>{},1000);`] }, cwd: dir, spawn, assertCurrent() {}, jobPath }); owners.push(running);
  const cancelledCompletion = assert.rejects(running.completed, /cancelled/);
  while (!fs.existsSync(runningMarker)) await new Promise(resolve => setTimeout(resolve, 5));
  const commandPid = Number(fs.readFileSync(runningMarker, 'utf8'));
  const firstClose = running.close(); assert.equal(running.close(), firstClose, 'concurrent close shares reclamation');
  await firstClose; await cancelledCompletion;
  assert.throws(() => process.kill(commandPid, 0), { code: 'ESRCH' });
  if (process.platform === 'win32') {
  const crashMarker = path.join(dir, 'crashing.json');
  const crash = await startOwnedBackgroundPty({ launch: { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(crashMarker)},String(process.pid));setTimeout(()=>process.kill(process.ppid,'SIGKILL'),100);setInterval(()=>{},1000);`] }, cwd: dir, spawn, assertCurrent() {}, jobPath }); owners.push(crash);
  await assert.rejects(crash.completed, /leader exited|connection closed/);
  const crashCommandPid = Number(fs.readFileSync(crashMarker, 'utf8'));
  assert.throws(() => process.kill(crashCommandPid, 0), { code: 'ESRCH' }, 'unexpected leader exit also reclaims its Job');
  }
  console.log(`background-pty-owner: OK (${process.platform}, owned before start, natural root exit and descendant cleanup)`);
} finally {
  await Promise.allSettled(owners.map(owner => owner.close()));
  // Container/root exit is already confirmed; native ConPTY cleanup must not enumerate dead PIDs.
  for (const proc of processes) disposePtyAsync(proc, true);
  fs.rmSync(dir, { recursive: true, force: true });
}
}
