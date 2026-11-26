import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'background-owner-retry-'));
let owner, restore = () => {};
try {
  const compile = createSharedCompiler(process.cwd(), folder);
  const { startOwnedCommand } = await import(pathToFileURL(compile('main/agentSession/process/ownedCommand.ts')));
  let leader;
  owner = await startOwnedCommand({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: folder, assertCurrent() {}, leader: value => { leader = value; } });
  const completion = owner.completed.catch(error => error);
  if (process.platform === 'win32') {
    const { WindowsJob } = await import(pathToFileURL(compile('main/agentSession/process/windowsJob.ts')));
    const original = WindowsJob.prototype.reclaim;
    WindowsJob.prototype.reclaim = async function () { throw Error('fixture pre-signal guardian failure'); };
    restore = () => { WindowsJob.prototype.reclaim = original; };
  } else {
    const original = process.kill;
    process.kill = function (pid, signal) {
      if (pid === -leader.pid && signal === 'SIGKILL') throw Object.assign(Error('fixture pre-signal EPERM'), { code: 'EPERM' });
      return original.call(process, pid, signal);
    };
    restore = () => { process.kill = original; };
  }
  await assert.rejects(owner.close(), /fixture pre-signal/);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(leader.exitCode, null, 'a failed pre-signal reclaim preserves the authenticated held leader');
  assert.equal(leader.signalCode, null);
  restore();
  await owner.close();
  assert.notEqual(leader.exitCode === null && leader.signalCode === null, true, 'retry really releases the original process owner');
  assert.ok(await completion instanceof Error);
  console.log(`background owner retry: ${process.platform} held leader survives pre-signal failure and is reclaimed on retry`);
} finally {
  restore(); await owner?.close();
  assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
  fs.rmSync(folder, { recursive: true, force: true });
}
