import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-command-'));
const owners = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const compile = createSharedCompiler(process.cwd(), folder);
  const { startOwnedCommand } = await import(pathToFileURL(compile('main/agentSession/process/ownedCommand.ts')));
  const { spawnOwnedProcess } = await import(pathToFileURL(compile('main/agentSession/process/owner.ts')));
  let stdout = '', stderr = '';
  const owner = await startOwnedCommand({ command: process.execPath, args: ['-e', 'process.stdout.write("hello");process.stderr.write("diagnostic");process.exitCode=7;'],
    cwd: folder, assertCurrent() {}, stdout: chunk => { stdout += chunk; }, stderr: chunk => { stderr += chunk; } });
  owners.push(owner);
  assert.equal(await owner.completed, 7);
  assert.equal(stdout, 'hello'); assert.equal(stderr, 'diagnostic');
  await owner.close();

  if (process.platform !== 'win32') {
    let groupPid;
    const command = await startOwnedCommand({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: folder,
      assertCurrent() {}, leader: child => { groupPid = child.pid; } });
    owners.push(command);
    const kill = process.kill;
    let probes = 0;
    try {
      process.kill = (pid, signal) => {
        if (pid === -groupPid && signal === 0 && probes++ === 0) {
          throw Object.assign(new Error('temporary group visibility error'), { code: 'EPERM' });
        }
        return kill(pid, signal);
      };
      await command.close();
      assert.ok(probes >= 2, 'EPERM alone does not confirm that a signaled group has exited');
    } finally { process.kill = kill; }

    const unconfirmed = spawnOwnedProcess({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
      spawnOptions: { stdio: 'ignore' }, windows: { kind: 'taskkill' }, reclaimTimeoutMs: 120 });
    await unconfirmed.ready;
    try {
      process.kill = (pid, signal) => {
        if (pid === -unconfirmed.child.pid && signal === 0) {
          throw Object.assign(new Error('group visibility remains restricted'), { code: 'EPERM' });
        }
        return kill(pid, signal);
      };
      await assert.rejects(unconfirmed.reclaim(), /进程回收 超时|无法确认工作进程组全部退出/);
      assert.equal(unconfirmed.state, 'reclaim_failed');
    } finally { process.kill = kill; }
  }

  const marker = path.join(folder, 'descendant-ticks');
  const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'x');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),20);setTimeout(()=>process.exit(),5000);`;
  const parent = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:${process.platform === 'win32'},stdio:'ignore'}).unref();setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)}))process.exit(0)},10);`;
  const tree = await startOwnedCommand({ command: process.execPath, args: ['-e', parent], cwd: folder, assertCurrent() {} });
  owners.push(tree);
  assert.equal(await tree.completed, 0, 'natural command exit still reclaims its container');
  const before = fs.readFileSync(marker, 'utf8'); await delay(120);
  assert.equal(fs.readFileSync(marker, 'utf8'), before, 'surviving descendant cannot keep writing after container release');

  const never = await startOwnedCommand({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: folder, assertCurrent() {} });
  owners.push(never); const completion = never.completed.catch(error => error);
  await Promise.all([never.close(), never.close()]);
  assert.ok(await completion instanceof Error);
  await assert.rejects(startOwnedCommand({ command: 'muster-fixture-command-does-not-exist', args: [], cwd: folder, assertCurrent() {} }));
  console.log(`owned command: real pipes, exit code, ${process.platform === 'win32' ? 'detached Job descendant' : 'inherited POSIX group descendant'}, concurrent close and startup failure passed`);
} finally {
  await Promise.allSettled(owners.map(owner => owner.close()));
  fs.rmSync(folder, { recursive: true, force: true });
}
