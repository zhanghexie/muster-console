import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, fork, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-escape-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { WindowsEscapeMonitor, windowsEscapeScript } = await import(pathToFileURL(compile('main/desktop/windowsEscapeMonitor.ts')));
  const { spawnOwnedProcess } = await import(pathToFileURL(compile('main/agentSession/process/owner.ts')));
  const fixture = path.join(temp, 'monitor.cjs');
  assert.equal(windowsEscapeScript(path.join(temp, 'out', 'main')), path.join(temp, 'out', 'main', 'desktop', 'windows-escape-monitor.ps1'));
  assert.match(windowsEscapeScript(path.join(temp, 'app.asar', 'out', 'main')), /app\.asar\.unpacked/);
  assert.throws(() => windowsEscapeScript('relative'), /absolute/);
  fs.writeFileSync(fixture, `console.log('READY'); process.stdin.on('data', value => {
    if (String(value).includes('escape')) console.log('ESC'); else console.log('BAD');
  }); setInterval(() => {}, 1000);`);
  let owner, escaped, failed;
  const escapeEvent = new Promise(resolve => { escaped = resolve; });
  const failureEvent = new Promise(resolve => { failed = resolve; });
  const factory = options => owner = spawnOwnedProcess({ ...options, command: process.execPath,
    args: [fixture], spawnOptions: { env: process.env, stdio: 'pipe' } });
  const monitor = new WindowsEscapeMonitor(path.resolve('monitor.ps1'), () => escaped(), reason => failed(reason),
    { SystemRoot: 'C:\\Windows' }, factory, 'win32');
  await monitor.start();
  owner.child.stdin.write('escape');
  await escapeEvent;
  owner.child.stdin.write('bad');
  assert.match(await failureEvent, /invalid message/);
  await monitor.stop();
  await monitor.stop();
  const unsupported = new WindowsEscapeMonitor(path.resolve('monitor.ps1'), () => {}, () => {}, {}, factory, 'linux');
  await assert.rejects(unsupported.start(), /unavailable/);
  const fakeOwner = () => {
    let exit;
    return { child: { stdout: new PassThrough(), stderr: new PassThrough() }, ready: Promise.resolve(),
      exited: new Promise(resolve => { exit = resolve; }), reclaim: async () => { exit(); } };
  };
  let fake = fakeOwner();
  const raceFailures = [];
  const raced = new WindowsEscapeMonitor(path.resolve('monitor.ps1'), () => {}, reason => raceFailures.push(reason),
    { SystemRoot: 'C:\\Windows' }, () => fake, 'win32');
  const raceStart = raced.start();
  fake.child.stdout.write('READY\nBAD\n');
  await assert.rejects(raceStart, /invalid message/, 'READY followed by malformed output in the same chunk must fail startup');
  assert.match(raceFailures[0], /invalid message/);

  fake = fakeOwner();
  let reportEof;
  const eofFailure = new Promise(resolve => { reportEof = resolve; });
  const eofMonitor = new WindowsEscapeMonitor(path.resolve('monitor.ps1'), () => {}, reportEof,
    { SystemRoot: 'C:\\Windows' }, () => fake, 'win32');
  const eofStart = eofMonitor.start();
  fake.child.stdout.write('READY\n');
  await eofStart;
  fake.child.stdout.end();
  assert.match(await eofFailure, /output.*(ended|closed)/, 'lost output must mark the monitor unavailable');
  await eofMonitor.stop();

  fake = fakeOwner();
  let reportError;
  const streamFailure = new Promise(resolve => { reportError = resolve; });
  const streamMonitor = new WindowsEscapeMonitor(path.resolve('monitor.ps1'), () => {}, reportError,
    { SystemRoot: 'C:\\Windows' }, () => fake, 'win32');
  const streamStart = streamMonitor.start();
  fake.child.stdout.write('READY\n');
  await streamStart;
  fake.child.stderr.emit('error', new Error('broken stderr'));
  assert.match(await streamFailure, /error output failed/);
  await streamMonitor.stop();
  if (process.platform === 'win32' && process.env.MUSTER_TEST_ESCAPE_MONITOR === '1') {
    const classifier = path.join(temp, 'classify.ps1');
    fs.writeFileSync(classifier, `$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath $env:ESCAPE_MONITOR_TEST_SCRIPT -Raw -Encoding UTF8
$code = [regex]::Match($source, "(?s)Add-Type -TypeDefinition @'\\r?\\n(.*?)\\r?\\n'@").Groups[1].Value
if (-not $code) { throw 'monitor source was not found' }
Add-Type -TypeDefinition $code
if ([MetaAgentEscapeMonitor]::IsNonInjectedEscapeDown(27, 16, 256)) { throw 'injected down accepted' }
if (-not [MetaAgentEscapeMonitor]::IsNonInjectedEscapeDown(27, 0, 256)) { throw 'unflagged down rejected' }
if ([MetaAgentEscapeMonitor]::IsNonInjectedEscapeDown(27, 0, 256)) { throw 'repeat accepted' }
if ([MetaAgentEscapeMonitor]::IsNonInjectedEscapeDown(27, 16, 257)) { throw 'injected up accepted' }
if ([MetaAgentEscapeMonitor]::IsNonInjectedEscapeDown(27, 0, 256)) { throw 'injected up reset latch' }
if ([MetaAgentEscapeMonitor]::IsNonInjectedEscapeDown(27, 0, 257)) { throw 'key up emitted' }
if (-not [MetaAgentEscapeMonitor]::IsNonInjectedEscapeDown(27, 0, 256)) { throw 'second unflagged down rejected' }
if ([MetaAgentEscapeMonitor]::IsNonInjectedEscapeDown(65, 0, 256)) { throw 'other key accepted' }
`);
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', classifier], {
      env: { ...process.env, ESCAPE_MONITOR_TEST_SCRIPT: path.resolve('src/main/desktop/windows-escape-monitor.ps1') }, windowsHide: true, stdio: 'pipe'
    });
    const live = new WindowsEscapeMonitor(path.resolve('src/main/desktop/windows-escape-monitor.ps1'), () => {}, reason => { throw new Error(reason); });
    await live.start();
    await live.stop();
    // Closing the only parent stdin pipe models the EOF delivered when the
    // supervising process exits; no keyboard event is sent or inspected.
    const orphan = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.resolve('src/main/desktop/windows-escape-monitor.ps1')], { windowsHide: true, stdio: 'pipe' });
    try {
      let output = '';
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Escape helper did not start')), 10000);
        orphan.stdout.on('data', chunk => { output += chunk.toString(); if (output.includes('READY\n') || output.includes('READY\r\n')) {
          clearTimeout(timer); resolve();
        } });
        orphan.once('error', error => { clearTimeout(timer); reject(error); });
        orphan.once('exit', () => { clearTimeout(timer); reject(new Error('Escape helper exited before readiness')); });
      });
      await ready;
      const exited = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Escape helper did not exit after its parent pipe closed')), 5000);
        orphan.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
      });
      orphan.stdin.end();
      assert.deepEqual(await exited, { code: 0, signal: null }, 'parent pipe EOF must stop the real hook helper');
    } finally { if (orphan.exitCode === null && orphan.signalCode === null) orphan.kill(); }
    // Force-kill an owned Node supervisor and observe the exact helper process
    // handle, so PID reuse cannot make the test inspect or terminate another process.
    const ownerScript = path.join(temp, 'escape-owner.cjs');
    fs.writeFileSync(ownerScript, `const {spawn}=require('node:child_process');
const path=require('node:path');
const executable=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const child=spawn(executable,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',process.env.ESCAPE_MONITOR_TEST_SCRIPT],{windowsHide:true,stdio:'pipe'});
let sent=false, output='';
child.stdout.on('data',chunk=>{output+=chunk.toString();if(!sent&&output.includes('READY')){sent=true;process.send({kind:'ready',pid:child.pid});}});
child.on('error',()=>process.exit(1));
setInterval(()=>{},1000);`);
    const supervisor = fork(ownerScript, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ESCAPE_MONITOR_TEST_SCRIPT: path.resolve('src/main/desktop/windows-escape-monitor.ps1') } });
    const { default: koffi } = await import('koffi');
    const kernel = koffi.load('kernel32.dll');
    const openProcess = kernel.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'int', 'uint32']);
    const waitProcess = kernel.func('__stdcall', 'WaitForSingleObject', 'uint32', ['void *', 'uint32']);
    const terminateProcess = kernel.func('__stdcall', 'TerminateProcess', 'int', ['void *', 'uint32']);
    const closeHandle = kernel.func('__stdcall', 'CloseHandle', 'int', ['void *']);
    let processHandle;
    try {
      const message = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Escape supervisor did not become ready')), 10000);
        supervisor.once('message', value => { clearTimeout(timer); resolve(value); });
        supervisor.once('error', error => { clearTimeout(timer); reject(error); });
        supervisor.once('exit', () => { clearTimeout(timer); reject(new Error('Escape supervisor exited before readiness')); });
      });
      assert.equal(message.kind, 'ready');
      assert.ok(Number.isSafeInteger(message.pid) && message.pid > 0);
      processHandle = openProcess(0x00100001, 0, message.pid); // SYNCHRONIZE | PROCESS_TERMINATE
      assert.ok(processHandle, 'the owned helper process handle must be available');
      const parentExited = new Promise(resolve => supervisor.once('exit', resolve));
      supervisor.kill();
      await parentExited;
      const status = waitProcess(processHandle, 5000);
      if (status !== 0) terminateProcess(processHandle, 1);
      assert.equal(status, 0, 'the helper must exit after its supervisor is force-killed');
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill();
      if (processHandle) closeHandle(processHandle);
    }
    console.log('Windows Escape hook: classifier, real startup, parent EOF, forced supervisor exit and shutdown passed; physical key not tested');
  }
  console.log('Escape monitor: readiness, stop, malformed output and platform failure passed');
} finally { removeWorkspaceFixture(temp, 'desktop-escape-'); }
