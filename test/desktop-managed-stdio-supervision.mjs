/** Owned no-op fixtures only; never inspect or terminate another session's processes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const prefix = 'cua-supervised-fixture-';
const temp = fs.mkdtempSync(path.resolve('.tmp', prefix));
const hosts = new Set();
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const moduleFile = compile('main/desktop/managedStdioTransport.ts');
  // owner.ts 为登记受管进程而 import processMonitor，后者经 ipc/handle 拉入
  // `import { ipcMain } from 'electron'`。独立宿主（尤其 ELECTRON_RUN_AS_NODE
  // 的真实 Electron）不提供该具名导出，会在发出 plan 前直接崩。夹具只需进程归属，
  // 进程监视器元数据是纯展示功能，这里以空实现切断依赖链。
  const processMonitorOut = path.join(temp, 'compiled', 'main', 'processMonitor.mjs');
  fs.writeFileSync(processMonitorOut,
    'export const registerOwnedProcess = () => {};\n' +
    'export const unregisterOwnedProcess = () => {};\n' +
    'export const collectProcessMonitorSnapshot = async () => ({ processes: [], processCount: 0 });\n' +
    'export const registerProcessMonitorIpc = () => {};\n');
  const { ManagedStdioTransport } = await import(pathToFileURL(moduleFile));
  const jobFile = path.resolve('src/main/agentSession/drivers/codex/worker/windows-job.ps1');

  // Confirm the Windows-only wrapper leaves both POSIX platforms on the
  // existing direct child/process-group policy without executing either OS.
  const platformProperty = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    for (const platform of ['darwin', 'linux']) {
      Object.defineProperty(process, 'platform', { ...platformProperty, value: platform });
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
      let actual;
      const transport = new ManagedStdioTransport('/fixture/driver', { DISPLAY: ':fixture' }, 250, ['mcp', '--direct'], options => {
        actual = options; return { child, ready: Promise.resolve(), reclaim: async () => { child.emit('close'); } };
      });
      await transport.start();
      assert.equal(actual.command, '/fixture/driver'); assert.deepEqual(actual.args, ['mcp', '--direct']);
      assert.deepEqual(actual.spawnOptions.env, { DISPLAY: ':fixture' });
      assert.equal(actual.spawnOptions.stdio, 'pipe'); assert.equal(actual.identityChallenge, undefined);
      await transport.close();
    }
  } finally { Object.defineProperty(process, 'platform', platformProperty); }

  if (process.platform === 'win32') {
    // The launch plan is captured before ownership awaits; MCP cannot be sent
    // while the wrapper is still waiting for its guardian assignment.
    {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), connected: true });
      let finishReady, launchMessage, options;
      const ready = new Promise(resolve => { finishReady = resolve; });
      child.send = (message, callback) => {
        if (message.type === 'launch') { launchMessage = message; queueMicrotask(() => child.emit('message', { type: 'driver-started' })); }
        callback?.();
      };
      const args = ['fixed-argument'], env = { PATH: 'original', NODE_OPTIONS: '--require untrusted' };
      const transport = new ManagedStdioTransport(process.execPath, env, 250, args, value => {
        options = value; return { child, ready, reclaim: async () => { child.emit('close'); } };
      }, jobFile);
      const starting = transport.start();
      child.emit('message', { type: 'wrapper-ready' });
      await assert.rejects(transport.send({ jsonrpc: '2.0', id: 1, method: 'early' }), /not connected/);
      args[0] = 'changed'; env.PATH = 'changed';
      assert.equal(options.spawnOptions.env.NODE_OPTIONS, undefined);
      finishReady(); await starting;
      assert.deepEqual(launchMessage.args, ['fixed-argument']); assert.equal(launchMessage.env.PATH, 'original');
      await transport.close();
    }
    // A child that exits in the same IPC turn as startup must not be exposed
    // as connected merely because the started message arrived first.
    {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), connected: true });
      child.send = (message, callback) => {
        if (message.type === 'launch') queueMicrotask(() => {
          child.emit('message', { type: 'driver-started' }); child.emit('message', { type: 'driver-exited' });
        });
        callback?.();
      };
      const transport = new ManagedStdioTransport(process.execPath, {}, 250, [], () => ({
        child, ready: Promise.resolve(), reclaim: async () => { child.emit('close'); }
      }), jobFile);
      queueMicrotask(() => child.emit('message', { type: 'wrapper-ready' }));
      await assert.rejects(transport.start(), /exited during startup/);
    }
    const copiedJob = path.join(temp, 'compiled', 'main', 'agentSession', 'drivers', 'codex', 'worker', 'windows-job.ps1');
    fs.mkdirSync(path.dirname(copiedJob), { recursive: true });
    fs.copyFileSync(jobFile, copiedJob);
    const marker = path.join(temp, 'driver-started');
    const driver = path.join(temp, 'no-op-driver.cjs');
    const missing = path.join(temp, 'missing-driver.exe');
    const failingJob = path.join(temp, 'failing-job.ps1');
    fs.writeFileSync(failingJob, `# MUSTER_WINDOWS_JOB_PROTOCOL=opened-challenge-v1\n` +
      `[Console]::Out.WriteLine('{"type":"opened"}')\n` +
      `$command = [Console]::In.ReadLine()\n` +
      `if ($command -eq 'assign') { [Console]::Out.WriteLine('{"type":"failure","message":"fixture"}') }\n` +
      `while ($null -ne [Console]::In.ReadLine()) {}\n`);
    fs.writeFileSync(driver, `const fs = require('node:fs');\nconst { spawn } = require('node:child_process');\n` +
      `fs.writeFileSync(${JSON.stringify(marker)}, 'started');\n` +
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio:'ignore' });\n` +
      `child.once('spawn', () => process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'fixture-ready',params:{pid:process.pid,childPid:child.pid}})+'\\n'));\n` +
      `process.stdin.resume(); setInterval(() => {},1000);\n`);
    const hostFile = path.resolve('test/fixtures/cua-supervised-host.mjs');

    const launch = (mode, executable = process.execPath) => {
      const env = executable === process.execPath ? process.env : { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
      const selectedJob = mode === 'assign-failure' ? failingJob : jobFile;
      const child = spawn(executable, [hostFile, moduleFile, selectedJob, driver, missing, mode],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true, env });
      hosts.add(child);
      // 宿主子进程若在发出 plan 前崩溃，必须把 stderr 带回父侧；否则只剩 20s 超时，看不出原因。
      let hostStderr = '';
      child.stderr.on('data', chunk => { hostStderr = (hostStderr + chunk.toString()).slice(-4000); });
      const queue = [], waiters = [];
      child.on('message', message => {
        const i = waiters.findIndex(waiter => waiter.type === message?.type);
        if (i >= 0) { const waiter = waiters.splice(i, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message); }
        else queue.push(message);
      });
      // 超时定时器是 unref 的；宿主若提前退出，必须主动 reject 等待者，
      // 否则只剩 Node 的 "unsettled top-level await" 静默退出，看不到宿主 stderr。
      child.once('exit', (code, signal) => {
        for (const waiter of waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error(`Fixture host exited before ${waiter.type} (code=${code}, signal=${signal})` +
            `${hostStderr ? `；宿主 stderr: ${hostStderr}` : ''}`));
        }
      });
      const next = type => {
        const i = queue.findIndex(message => message?.type === type);
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
        return new Promise((resolve, reject) => {
          const waiter = { type, resolve, reject, timer: undefined };
          waiter.timer = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1);
            reject(new Error(`Fixture did not report ${type}${hostStderr ? `；宿主 stderr: ${hostStderr}` : ''}`)); }, 20000).unref();
          waiters.push(waiter);
        });
      };
      const exited = once(child, 'exit').then(() => { hosts.delete(child); });
      return { child, next, exited };
    };
    const alive = pid => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    const gone = async (...pids) => {
      assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
      const deadline = Date.now() + 10000;
      while (pids.some(alive)) {
        if (Date.now() >= deadline) throw new Error('An owned fixture process remained after reclamation');
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    };
    const normalStartup = async (mode, executable) => {
      fs.rmSync(marker, { force: true });
      const host = launch(mode, executable), plan = await host.next('plan');
      assert.equal(plan.job, 'job'); assert.equal(plan.coverage, 'windows-job'); assert.equal(plan.hasPrivateArgs, true);
      await host.next('started');
      const ready = await host.next('fixture-ready');
      assert.equal(ready.wrapperPid, plan.wrapperPid);
      assert.equal(fs.existsSync(marker), true);
      return { ...host, ready };
    };

    // Bundle the actual transport into a standalone main entry to verify the
    // inline wrapper and existing unpacked guardian layout survive bundling.
    {
      const { build } = await import('esbuild');
      const entry = path.join(temp, 'bundle', 'main', 'index.cjs');
      await build({ entryPoints: ['src/main/desktop/managedStdioTransport.ts'], outfile: entry,
        bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' });
      const guardian = path.join(path.dirname(entry), 'agentSession', 'drivers', 'codex', 'worker', 'windows-job.ps1');
      fs.mkdirSync(path.dirname(guardian), { recursive: true }); fs.copyFileSync(jobFile, guardian);
      const { ManagedStdioTransport: BundledTransport } = createRequire(import.meta.url)(entry);
      const transport = new BundledTransport(process.execPath, process.env, 250, [driver]);
      let received;
      const ready = new Promise(resolve => { received = resolve; });
      transport.onmessage = received;
      try {
        await transport.start();
        const message = await ready;
        assert.equal(message.method, 'fixture-ready');
        await transport.close();
        await gone(message.params.pid, message.params.childPid);
      } finally { await transport.close(); }
      const config = createRequire(import.meta.url)('yaml').parse(fs.readFileSync('electron-builder.yml', 'utf8'));
      assert.ok(config.asarUnpack.includes('out/main/agentSession/drivers/codex/worker/**'));
    }

    {
      const host = await normalStartup('normal');
      host.child.send('close');
      const result = await host.next('close-result');
      assert.deepEqual({ same: result.same, ok: result.ok }, { same: true, ok: true });
      await gone(host.ready.wrapperPid, host.ready.driverPid, host.ready.childPid, host.ready.guardianPid);
      host.child.send('exit'); await host.exited;
    }
    {
      const host = await normalStartup('host-crash');
      assert.equal(host.child.kill('SIGKILL'), true);
      await host.exited;
      await gone(host.ready.wrapperPid, host.ready.driverPid, host.ready.childPid, host.ready.guardianPid);
    }
    {
      const host = await normalStartup('asset-resolve');
      host.child.send('close'); assert.equal((await host.next('close-result')).ok, true);
      await gone(host.ready.wrapperPid, host.ready.driverPid, host.ready.childPid, host.ready.guardianPid);
      host.child.send('exit'); await host.exited;
    }
    // Exercise the actual Electron executable in Node mode as well as system
    // Node; this creates no BrowserWindow and sends no desktop input.
    {
      const electron = createRequire(import.meta.url)('electron');
      const host = await normalStartup('electron-host-crash', electron);
      assert.equal(host.child.kill('SIGKILL'), true);
      await host.exited;
      await gone(host.ready.wrapperPid, host.ready.driverPid, host.ready.childPid, host.ready.guardianPid);
    }
    {
      const host = await normalStartup('guardian-crash');
      host.child.send('kill-guardian');
      assert.equal((await host.next('guardian-killed')).ok, true);
      await host.next('wrapper-closed');
      await gone(host.ready.wrapperPid, host.ready.driverPid, host.ready.childPid, host.ready.guardianPid);
      host.child.send('close');
      const result = await host.next('close-result');
      assert.equal(result.ok, false, 'a lost guardian must not be reported as a confirmed cleanup');
      host.child.send('exit'); await host.exited;
    }
    for (const mode of ['bad-challenge', 'assign-failure', 'missing-driver', 'slow-challenge']) {
      fs.rmSync(marker, { force: true });
      const host = launch(mode), plan = await host.next('plan');
      assert.equal(plan.job, 'job'); assert.equal(plan.hasPrivateArgs, true);
      if (mode === 'slow-challenge') {
        await host.next('challenge-entered'); host.child.send('close');
        const close = await host.next('close-result');
        assert.equal(close.same, true); assert.equal(close.ok, false);
      }
      const failure = await host.next('start-failed');
      assert.equal(failure.started, false);
      if (['bad-challenge', 'assign-failure', 'slow-challenge'].includes(mode)) assert.equal(failure.cleanupUnconfirmed, true);
      assert.equal(fs.existsSync(marker), false, 'the driver must never start before successful ownership');
      await gone(...(failure.guardianPid ? [plan.wrapperPid, failure.guardianPid] : [plan.wrapperPid]));
      host.child.send('exit'); await host.exited;
    }
    console.log('Cua supervision: real Windows Job normal, host crash, guardian crash and failure paths passed; no desktop input');
  } else {
    console.log('Cua supervision: macOS/Linux process plans simulated; real Windows Job fixture skipped');
  }
} finally {
  for (const child of hosts) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.all([...hosts].map(child => child.exitCode === null && child.signalCode === null ? once(child, 'exit').catch(() => {}) : undefined));
  removeWorkspaceFixture(temp, prefix);
}
