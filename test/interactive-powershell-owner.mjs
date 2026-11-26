/** Actual Windows PowerShell profile: direct ConPTY versus the production held owner. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
if (process.platform !== 'win32') { console.log('interactive-powershell-owner: Windows-only native control test'); process.exit(0); }
const require = createRequire(import.meta.url), pty = require('node-pty');
if (!process.argv.includes('--host-child')) {
  for (const [label, executable] of [['Node', process.execPath], ['Electron', require('electron')]]) {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    if (label === 'Electron') env.ELECTRON_RUN_AS_NODE = '1';
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [fileURLToPath(import.meta.url), '--host-child', label], { env, stdio: 'inherit', windowsHide: true });
      const timeout = setTimeout(() => { child.kill(); reject(Error(label + ' cooked PTY timed out')); }, 45000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(Error(label + ' cooked PTY failed: ' + code)); });
    });
  }
  process.exit(0);
}
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'powershell-owner-'));
const compile = createSharedCompiler(process.cwd(), folder);
const { resolveShellLaunchAsync } = await import(pathToFileURL(compile('main/shell/profiles.ts')));
const launch = await resolveShellLaunchAsync('powershell');
const { createOwnedInteractivePty } = await import(pathToFileURL(compile('main/pty/interactiveOwner.ts')));
const shim = path.join(folder, 'node_modules/node-pty'); fs.mkdirSync(shim, { recursive: true });
fs.writeFileSync(path.join(shim, 'package.json'), '{"main":"index.cjs"}');
fs.writeFileSync(path.join(shim, 'index.cjs'), `exports.spawn=require(${JSON.stringify(require.resolve('node-pty'))}).spawn;`);
const { PtyManager, disposePtyAsync } = await import(pathToFileURL(compile('main/pty/manager.ts')));
const events = [], stamp = (name, value) => events.push({ at: Date.now(), name, value });
const until = async (predicate, label) => { const end = Date.now() + 10000; while (!predicate()) { if (Date.now() > end) throw Error(label); await new Promise(resolve => setTimeout(resolve, 10)); } };
const direct = pty.spawn(launch.command, launch.args, { cwd: folder, env: process.env, cols: 100, rows: 30, name: 'xterm' });
let directOutput = '', directExited = false;
direct.onData(data => { directOutput += data; }); direct.onExit(() => { directExited = true; });
const manager = new PtyManager(() => null, options => {
  const owner = createOwnedInteractivePty({ ...options, jobPath: path.join(process.cwd(), 'src/main/agentSession/drivers/codex/worker/windows-job.ps1'),
    commandExited: code => { stamp('commandExited', code); options.commandExited?.(code); } });
  owner.ready.then(() => stamp('ready'), error => stamp('readyRejected', error.message)); return owner;
});
let argvOwner, missingOwner;
manager.onData = (_id, data) => stamp('data', data); manager.onExit = (_id, code) => stamp('nativeExit', code);
try {
  direct.write("[Console]::WriteLine('DIRECT_'+'READY')\r");
  await until(() => directOutput.includes('DIRECT_READY'), 'direct PowerShell profile never accepted input');
  stamp('directReady'); direct.write('exit 0\r'); await until(() => directExited, 'direct shell did not exit'); disposePtyAsync(direct, true);
  const argv = ['', 'space value', 'quote"value', 'C:\\末尾\\', '%literal%', '& | > ^'];
  const argvFile = path.join(folder, 'argv.json');
  argvOwner = createOwnedInteractivePty({ launch: { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(argvFile)},JSON.stringify(process.argv.slice(1)));`, ...argv] },
    cwd: folder, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, assertCurrent() {},
    spawn(bootstrap) {
      const proc = pty.spawn(bootstrap.command, bootstrap.args, { cwd: folder, cols: 100, rows: 30, env: { ...process.env, ...bootstrap.env } });
      proc.onData(() => {}); return proc;
    }
  });
  await argvOwner.ready; assert.equal(await argvOwner.completed, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, 'utf8')), argv, 'native argv must preserve empty, quotes, trailing backslashes, Unicode and shell metacharacters on both hosts');
  let failedOutput = '', missingRoot;
  missingOwner = createOwnedInteractivePty({ launch: { command: path.join(folder, 'missing-executable.exe'), args: [] },
    cwd: folder, env: { ...process.env }, assertCurrent() {},
    spawn(bootstrap) {
      const proc = pty.spawn(bootstrap.command, bootstrap.args, { cwd: folder, cols: 100, rows: 30, env: { ...process.env, ...bootstrap.env } });
      missingRoot = proc.pid; proc.onData(data => { failedOutput += data; }); return proc;
    }
  });
  await assert.rejects(missingOwner.ready, /Windows interactive command startup failed/);
  await missingOwner.close();
  assert.throws(() => process.kill(missingRoot, 0), { code: 'ESRCH' }, 'failed command startup still confirms root/container/native/output-worker closure');
  assert.doesNotMatch(failedOutput, /Windows interactive console bootstrap failed|InvalidOperationException|HasExited/, 'missing executable must preserve its first startup error without a secondary unassociated-process exception');
  const generation = await manager.spawn('shell', launch, folder, 100, 30); stamp('managerCommitted', generation);
  manager.write('shell', "[Console]::WriteLine('OWNED_'+'READY')\r");
  await until(() => manager.getBuffer('shell')?.includes('OWNED_READY'), 'owned PowerShell profile never accepted input');
  assert.equal(manager.isRunning('shell'), true);
  manager.resize('shell', 111, 33);
  manager.write('shell', "[Console]::WriteLine('BUSY_'+'START'); Start-Sleep -Seconds 60\r");
  await until(() => manager.getBuffer('shell')?.includes('BUSY_START'), 'cooked shell did not enter its command');
  const beforeInterrupt = manager.getBuffer('shell').length;
  manager.write('shell', '\x03');
  await until(() => manager.getBuffer('shell')?.slice(beforeInterrupt).includes('PS '), 'Ctrl+C did not restore the interactive prompt');
  manager.write('shell', "[Console]::WriteLine('AFTER_'+'INTERRUPT')\r");
  await until(() => manager.getBuffer('shell')?.includes('AFTER_INTERRUPT'), 'Ctrl+C did not return control to the same shell');
  assert.equal(manager.isRunning('shell'), true, 'Ctrl+C must not kill the held leader or interactive shell');
  manager.write('shell', 'exit 23\r'); await until(() => manager.entries.get('shell')?.status === 'exited', 'owned shell did not confirm native exit');
  assert.equal(manager.entries.get('shell').exitCode, 23);
  console.log(`interactive-powershell-owner: OK (${process.argv.at(-1)}, real profile, direct/owned ConPTY, cooked input/Ctrl+C/exit)`);
} catch (error) { console.error(JSON.stringify({ directOutput, events })); throw error; }
finally { await manager.killAllAndWait(); await argvOwner?.close(); await missingOwner?.close(); if (!directExited) direct.kill(); fs.rmSync(folder, { recursive: true, force: true }); }
