/** Actual native PTY ownership, input, resize and Ctrl+C; no model or external service. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-owner-'));
const compile = createSharedCompiler(process.cwd(), dir);
const { INTERACTIVE_PTY_BOOTSTRAP } = await import(pathToFileURL(compile('main/pty/interactiveBootstrap.ts')));
new Script(INTERACTIVE_PTY_BOOTSTRAP);
const { createOwnedInteractivePty } = await import(pathToFileURL(compile('main/pty/interactiveOwner.ts')));
const pty = require('node-pty');
const owners = [];
const jobPath = path.join(process.cwd(), 'src/main/agentSession/drivers/codex/worker/windows-job.ps1');
const until = async predicate => {
  const end = Date.now() + 12000;
  while (!predicate()) { if (Date.now() > end) throw Error('Timed out waiting for native PTY output'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
function open(script, args = []) {
  let proc, output = '';
  const owner = createOwnedInteractivePty({
    launch: { command: process.execPath, args: ['-e', script, ...args] }, cwd: dir,
    env: { ...process.env, TERM_PROGRAM: 'MusterConsole' }, jobPath, koffiPath: require.resolve('koffi'),
    assertCurrent() {},
    spawn(launch) {
      proc = pty.spawn(launch.command, launch.args, { cwd: dir, cols: 90, rows: 25, name: 'xterm-256color', env: { ...process.env, ...launch.env } });
      proc.onData(data => output += data); return proc;
    }
  });
  owners.push(owner);
  return { owner, get proc() { return proc; }, get output() { return output; } };
}
try {
  const argvFile = path.join(dir, 'argv.json');
  const argv = ['', 'space value', 'quote"value', 'C:\\末尾\\', '%literal%', '& | > ^'];
  const quoted = open(`require('node:fs').writeFileSync(${JSON.stringify(argvFile)},JSON.stringify(process.argv.slice(1)));`, argv);
  await quoted.owner.ready; assert.equal(await quoted.owner.completed, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, 'utf8')), argv, 'native argv preserves empty, quotes, trailing backslashes, Unicode and shell metacharacters');
  const marker = path.join(dir, 'tree.json');
  const active = open(`const fs=require('node:fs'),{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({root:process.pid,child:child.pid}));process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',data=>{if(data.includes(3)){console.log('CTRL_C_RECEIVED');process.exit(17);}console.log('INPUT:'+data.toString());});process.stdout.on('resize',()=>console.log('SIZE:'+process.stdout.columns+'x'+process.stdout.rows));console.log('READY:'+process.env.TERM_PROGRAM);`);
  await active.owner.ready;
  await until(() => active.output.includes('READY:MusterConsole'));
  active.proc.write('raw-input');
  await until(() => active.output.includes('INPUT:raw-input'));
  active.proc.resize(111, 33);
  await until(() => active.output.includes('SIZE:111x33'));
  active.proc.write('\x03');
  assert.equal(await active.owner.completed, 17);
  assert.match(active.output, /CTRL_C_RECEIVED/);
  const tree = JSON.parse(fs.readFileSync(marker, 'utf8'));
  for (const pid of [active.proc.pid, tree.root, tree.child]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const cancelled = open('console.log("CANCEL_READY");setInterval(()=>{},1000)');
  await cancelled.owner.ready;
  const completion = assert.rejects(cancelled.owner.completed, /cancelled/);
  const closing = cancelled.owner.close();
  assert.equal(cancelled.owner.close(), closing);
  await closing; await completion;
  assert.throws(() => process.kill(cancelled.proc.pid, 0), { code: 'ESRCH' });
  console.log(`interactive-pty-owner: OK (${process.platform}; input, resize, Ctrl+C, descendant/native/output-worker close)`);
} finally {
  await Promise.all(owners.map(owner => owner.close()));
  fs.rmSync(dir, { recursive: true, force: true });
}
