/** Real GUI Claude process lifecycle, with an offline SDK/CLI protocol fixture. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(root, '.tmp');
fs.mkdirSync(scratch, { recursive: true });
const folder = fs.mkdtempSync(path.join(scratch, 'claude-driver-owned-'));
const compile = createSharedCompiler(root, folder);
// Negative control compiles one historical driver into this fixture tree. It
// never restores or edits the shared checkout, and uses the same dependencies.
const driverEntry = 'main/agentSession/drivers/claude/driver.ts';
const driverRef = process.argv.find(arg => arg.startsWith('--driver-ref='))?.slice('--driver-ref='.length);
let driverOutput;
const readFileSync = fs.readFileSync;
try {
  if (driverRef) {
    const historical = execFileSync('git', ['show', `${driverRef}:src/${driverEntry}`], { cwd: root, encoding: 'utf8' });
    fs.readFileSync = function (file, ...options) {
      return typeof file === 'string' && path.resolve(file) === path.join(root, 'src', driverEntry)
        ? historical : readFileSync.call(fs, file, ...options);
    };
  }
  driverOutput = compile(driverEntry);
} finally { fs.readFileSync = readFileSync; }
const { ClaudeRuntimeDriver } = await import(pathToFileURL(driverOutput));
const { shutdownControlledChildren } = await import(pathToFileURL(compile('main/agentSession/process/controlledChild.ts')));
const { WindowsJob } = await import(pathToFileURL(compile('main/agentSession/process/windowsJob.ts')));
const { ConnectionCleanupError } = await import(pathToFileURL(compile('main/agentSession/host/retirement.ts')));
const cleanupRequests = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error(`Timed out: ${label}`);
    await delay(10);
  }
}

class Messages {
  items = [];
  waiters = [];
  ended = false;
  emit(value) {
    if (this.ended) return;
    const next = this.waiters.shift();
    if (next) next({ value, done: false }); else this.items.push(value);
  }
  end() { this.ended = true; for (const next of this.waiters.splice(0)) next({ done: true }); }
  [Symbol.asyncIterator]() {
    return { next: () => this.items.length ? Promise.resolve({ value: this.items.shift(), done: false })
      : this.ended ? Promise.resolve({ done: true }) : new Promise(resolve => this.waiters.push(resolve)) };
  }
}

function fixture(name, { initializationError = false } = {}) {
  const cwd = path.join(folder, name); fs.mkdirSync(cwd);
  const marker = path.join(cwd, 'descendant-ticks');
  const started = path.join(cwd, 'cli-started');
  const cleanup = path.join(cwd, 'cleanup-request'); cleanupRequests.push(cleanup);
  const childProgram = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'x');const tick=setInterval(()=>{if(fs.existsSync(${JSON.stringify(cleanup)})||!fs.existsSync(${JSON.stringify(cwd)}))process.exit();fs.appendFileSync(${JSON.stringify(marker)},'x')},15);setTimeout(()=>{clearInterval(tick);process.exit()},15000);`;
  const program = path.join(cwd, 'cli.cjs');
  fs.writeFileSync(program, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},'started');
require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childProgram)}],{detached:${process.platform === 'win32'},stdio:'ignore'}).unref();
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const ready=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(ready);emit({type:'system',subtype:'init',session_id:'fixture-${name}'});}},5);
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const input=JSON.parse(line);const text=String(input.message.content);
emit({type:'result',subtype:'success',is_error:false,session_id:'fixture-${name}',result:'done'});
if(text.includes('natural-exit'))setImmediate(()=>process.exit(0));});
process.stdin.on('end',()=>process.exit(0));setInterval(()=>{if(fs.existsSync(${JSON.stringify(cleanup)}))process.exit(0)},15);setTimeout(()=>process.exit(0),15000);
`);
  const state = { child: undefined, childClosed: false, closeCalls: 0, lines: [], errors: [], logs: [], feedFinished: false };
  const controller = new AbortController();
  const messages = new Messages();
  const sdk = {
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
    createSdkMcpServer: options => ({ type: 'sdk', name: options.name, alwaysLoad: options.alwaysLoad }),
    query({ options, prompt }) {
      const child = state.child = options.spawnClaudeCodeProcess({ command: process.execPath, args: [program], cwd,
        env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' }, signal: controller.signal });
      let pending = '';
      child.stdout.on('data', data => {
        pending += data.toString();
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const message = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
          state.lines.push(message); messages.emit(message);
        }
      });
      child.on('error', error => state.errors.push(error));
      child.stdin.on('error', error => state.errors.push(error));
      child.once('close', () => { state.childClosed = true; messages.end(); });
      // Match SDK Query.streamInput: iterable exhaustion closes native stdin.
      state.feed = (async () => {
        try {
          for await (const message of prompt) await new Promise((resolve, reject) =>
            child.stdin.write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve()));
        } catch (error) { state.errors.push(error); }
        finally { state.feedFinished = true; child.stdin.end(); }
      })();
      if (initializationError) throw Error('fixture SDK initialization failed after spawn');
      return Object.assign(messages, {
        close() { state.closeCalls += 1; controller.abort(); messages.end(); },
        async interrupt() { messages.emit({ type: 'result', subtype: 'success', session_id: `fixture-${name}` }); }
      });
    }
  };
  const driver = new ClaudeRuntimeDriver({ config: { effectiveMcp: () => ({ enabled: false, servers: [] }) } },
    { userDataDir: cwd }, { queryFn: sdk.query, loadSdk: async () => sdk,
      resolveExecutable: async () => ({ ok: true, executable: process.execPath, packaged: false }) });
  const input = { sessionId: name, cwd, nativePermissions: true, systemPromptAppend: '', firstPromptPrefix: '',
    mode: 'default', planExecuting: false, permissionMode: 'acceptEdits', modeController: {}, hostTools: [],
    requestApproval: async () => ({ approved: true }), requestUserQuestion: async () => ({ kind: 'aborted' }),
    getPolicyState: () => ({ mode: 'default', planExecuting: false }), log: (level, text) => state.logs.push([level, text]) };
  return { state, driver, input, controller, marker, started,
    async connect() {
      const conn = await driver.connect(input), events = [];
      const pump = (async () => { for await (const event of conn.events) events.push(event); })();
      return { conn, events, pump };
    },
    async ready() { await until(() => state.lines.some(line => line.type === 'system'), `${name}: real CLI and descendant started`); },
    async assertReleased() {
      assert.equal(state.childClosed, true, `${name}: close waits for the owned child/container`);
      if (fs.existsSync(marker)) {
        const before = fs.readFileSync(marker, 'utf8'); await delay(90);
        assert.equal(fs.readFileSync(marker, 'utf8'), before, `${name}: descendant cannot survive container release`);
      }
    }
  };
}

function refuseReclamation() {
  if (process.platform === 'win32') {
    const original = WindowsJob.prototype.reclaim;
    WindowsJob.prototype.reclaim = async function () { throw Error('fixture container reclamation refused'); };
    return () => { WindowsJob.prototype.reclaim = original; };
  }
  const original = process.kill;
  process.kill = function (pid, signal) {
    if (pid < 0 && signal === 'SIGKILL') throw Error('fixture container reclamation refused');
    return original.call(process, pid, signal);
  };
  return () => { process.kill = original; };
}

let restore = () => {};
try {
  for (const name of ['natural-exit', 'concurrent-close', 'sdk-abort']) {
    console.log(`Claude owned process: ${name}`);
    const f = fixture(name), { conn, pump } = await f.connect();
    try {
      await f.ready();
      await conn.send(name);
      if (name === 'natural-exit') await until(() => f.state.childClosed, 'short-lived CLI closes with its descendant');
      if (name === 'sdk-abort') f.controller.abort();
      await Promise.all([conn.close(), conn.close(), conn.close()]);
      await pump; await f.state.feed; await f.assertReleased();
      assert.equal(f.state.closeCalls, 1, `${name}: concurrent close/SDK abort/stream end share one SDK close`);
      assert.equal(f.state.logs.some(([, text]) => text.includes('回收未确认')), false, `${name}: natural exit is not a cleanup failure`);
    } finally { await conn.close(); }
  }

  {
    console.log('Claude owned process: sdk-abort-startup');
    const f = fixture('sdk-abort-startup'); f.controller.abort();
    const { conn, pump } = await f.connect();
    await conn.close(); await pump; await f.state.feed;
    assert.equal(fs.existsSync(f.started), false, 'an already aborted SDK signal never activates the CLI');
    await f.assertReleased();
  }

  {
    console.log('Claude owned process: initialization-error');
    const f = fixture('initialization-error', { initializationError: true });
    await assert.rejects(f.driver.connect(f.input), /fixture SDK initialization failed after spawn/);
    await until(() => f.state.childClosed && f.state.feedFinished, 'initialization exception drains its owner and feed');
    assert.equal(fs.existsSync(f.started), false, 'initialization failure cancels the held CLI before activation');
    await f.assertReleased();
  }

  {
    console.log('Claude owned process: reclaim-failure');
    const f = fixture('reclaim-failure'), { conn, pump } = await f.connect();
    try {
      await f.ready(); await conn.send('keep working');
      restore = refuseReclamation();
      const failed = await Promise.allSettled([conn.close(), conn.close()]);
      console.log('Claude owned process: reclaim rejection observed', failed.map(result => result.status));
      for (const result of failed) {
        assert.equal(result.status, 'rejected');
        assert.match(result.reason.message, /Claude 引擎回收未确认.*fixture container reclamation refused/);
      }
      assert.equal(f.state.childClosed, false, 'failed reclamation must not synthesize native process exit');
      assert.equal(f.state.closeCalls, 0, 'failed reclamation retains the SDK instead of triggering another abort');
      await assert.rejects(conn.send('must not reuse failed owner'), /连接已中断/);
      restore(); restore = () => {};
      console.log('Claude owned process: restored native reclaim; retrying close');
      try { await conn.close(); }
      catch (error) { console.error('Claude owned process: retry rejected', error, f.state.errors.map(item => item.message)); throw error; }
      await pump; await f.state.feed; await f.assertReleased();
      assert.equal(f.state.closeCalls, 1, 'retry reclaims the retained owner without closing the SDK twice');
    } finally { restore(); restore = () => {}; await conn.close(); }
  }

  {
    console.log('Claude owned process: initialization-cleanup-failure');
    // An initialization exception has no returned connection for Host to close:
    // retain the startup cleanup failure instead of reporting ordinary connect failure.
    const f = fixture('initialization-cleanup-failure', { initializationError: true });
    restore = refuseReclamation();
    try {
      await assert.rejects(f.driver.connect(f.input), error => error instanceof ConnectionCleanupError && /回收未确认/.test(error.message));
    } finally { restore(); restore = () => {}; }
  }
  console.log(`Claude GUI owned process: ${process.platform} real CLI/descendants, natural exit, concurrent close, SDK abort and failed cleanup passed`);
} finally {
  restore();
  await shutdownControlledChildren();
  // Historical taskkill owners can leave descendants after their root exits.
  // Only these isolated fixture programs observe the private cleanup markers.
  for (const request of cleanupRequests) fs.writeFileSync(request, 'stop');
  await delay(100);
  const resolved = fs.realpathSync(folder), realScratch = fs.realpathSync(scratch);
  assert.equal(path.dirname(resolved), realScratch);
  assert.ok(path.basename(resolved).startsWith('claude-driver-owned-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
