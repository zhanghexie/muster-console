/** Production app-server driver: terminal events wait for resource-container release. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp/codex-driver-lifecycle-'));
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { CodexRuntimeDriver } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/driver.ts')));
const { createCodexAppServerClient } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/appServerTransport.ts')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(fn, label) {
  const deadline = Date.now() + 12000;
  while (!fn()) { assert.ok(Date.now() < deadline, label); await sleep(5); }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A spawn that fails before the OS assigns a PID. `spawnOwnedProcess` then rejects
// its `spawned` promise, and performReclaim still confirms the (never-started)
// container as released because there is no PID to own.
const deniedSpawn = message => {
  const child = new EventEmitter();
  child.pid = undefined; child.exitCode = null; child.signalCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => true; child.killed = false;
  queueMicrotask(() => {
    child.emit('error', new Error(message));
    child.emit('exit', null, null);
    child.stdout.end(); child.stderr.end();
  });
  return child;
};
const ctx = { config: { effectiveMcp: () => ({ enabled: false, servers: [] }) } };
const input = (id, overrides = {}) => ({ sessionId: id, cwd: tmp, resumeToken: `thread-${id}`,
  systemPromptAppend: '', mode: 'default', planExecuting: false, hostTools: [], modeController: {},
  getTurnId: () => 'host-turn', getPolicyState: () => ({ mode: 'default', planExecuting: false }), requestApproval: async () => ({ approved: true }), log() {}, ...overrides });
const connections = [];
const cleanupHooks = [];
const sends = [];
const fakeEnds = [];
function collect(conn, onEvent) {
  connections.push(conn);
  const events = [];
  void (async () => { for await (const event of conn.events) { events.push(event); onEvent?.(event); } })();
  return events;
}
function send(conn, text, authority) { const promise = conn.send(text, undefined, undefined, authority); sends.push(promise); return promise; }
const flag = (id, n, kind) => path.join(tmp, `${kind}-${id}-${n}`);
const release = (id, n) => fs.writeFileSync(flag(id, n, 'release'), 'ok');
const pidOf = (id, n) => Number(fs.readFileSync(flag(id, n, 'pid'), 'utf8'));

// Descendants deliberately outlive CLI completion and retain inherited handles.
fs.writeFileSync(path.join(tmp, 'tree-child.cjs'), `
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const id = process.env.LIFECYCLE_CASE;
fs.writeFileSync('tree-child-' + id, String(process.pid));
spawn(process.execPath, ['-e', "require('node:fs').writeFileSync('tree-grand-' + process.env.LIFECYCLE_CASE, String(process.pid)); setTimeout(()=>{},15000)"], {stdio:'inherit',windowsHide:true});
setTimeout(()=>{},15000);
`);

const hostMcpScript = path.join(tmp, 'unused-mcp-shim.mjs');
fs.writeFileSync(hostMcpScript, ''); // The RPC fixture confirms MCP without running the shim.

// A gated worker reports an assignment denial before launching the CLI.
fs.writeFileSync(path.join(tmp, 'gated-worker.mjs'), `
import readline from 'node:readline';
const nl = String.fromCharCode(10);
const send = m => process.stdout.write(JSON.stringify(m) + nl);
readline.createInterface({ input: process.stdin }).on('line', line => {
  let req; try { req = JSON.parse(line); } catch { return; }
  if (req.type === 'identity-challenge') send({ type: 'identity-response', nonce: req.nonce });
  else if (req.type === 'run-app-server') send({ type: 'app-error', error: 'fixture assignment denied' });
});
send({ type: 'ready' });
`);

// The real app-server transport launches this Node fixture as its native child.
fs.writeFileSync(path.join(tmp, 'app-server'), `
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const id = process.env.LIFECYCLE_CASE;
const countFile = 'count-' + id;
const n = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : 0) + 1;
fs.writeFileSync(countFile, String(n));
fs.writeFileSync('pid-' + id + '-' + n, String(process.pid));
const threadId = 'thread-' + id;
const continuationId = threadId + '-continuation';
const recovering = id.startsWith('writer-recovery');
const supportsAttachment = id.startsWith('writer-recovery-hidden');
const stagingId = supportsAttachment ? threadId + '-staging' : continuationId;
const turnId = 'turn-' + n;
const writer = 'writer-' + id;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const emit = event => console.log(JSON.stringify(event));
setTimeout(() => process.exit(2), 15000).unref();
let tools = {};
rl.on('line', line => {
  const request = JSON.parse(line);
  const { method, params } = request;
  if (request.id == null) return;
  const answer = result => emit({ id: request.id, result });
  const error = (message, code = -32603) => emit({ id: request.id, error: { code, message } });
  if (method === 'initialize') return answer({ codexHome: process.env.CODEX_HOME });
  if (method === 'permissionProfile/list') return answer({ data: [], nextCursor: null });
  const configure = () => { tools = Object.fromEntries((params.config['mcp_servers.muster'].enabled_tools ?? []).map(name => [name, {}])); };
  if (method === 'thread/start' || method === 'thread/resume') {
    fs.writeFileSync('resume-' + id + '-' + n, params.threadId ?? '<new>');
    if (id === 'external-busy') return error('thread-store conflict: thread ' + threadId + ' already has an active writer');
    if (recovering && params.threadId === threadId) {
      return error('thread-store conflict: thread ' + threadId + ' already has an active writer', -32600);
    }
    if (recovering && [continuationId, stagingId].includes(params.threadId)) {
      configure();
      return answer({ thread: { id: params.threadId }, cwd: params.cwd });
    }
    if (fs.existsSync(writer) && !alive(Number(fs.readFileSync(writer, 'utf8')))) fs.unlinkSync(writer);
    try { fs.writeFileSync(writer, String(process.pid), { flag: 'wx' }); }
    catch { return error('thread-store conflict: thread ' + threadId + ' already has an active writer'); }
    configure();
    return answer({ thread: { id: threadId }, cwd: params.cwd });
  }
  if (recovering && method === 'thread/turns/list') {
    const status = id === 'writer-recovery-running' ? 'inProgress' : 'completed';
    const checkpoint = id === 'writer-recovery-wrong-history' && params.threadId === continuationId ? 'wrong-turn' : 'saved-turn';
    return answer({ data: [{ id: checkpoint, status }] });
  }
  if (recovering && method === 'thread/fork') {
    if (params.attachToSource) {
      fs.writeFileSync('attached-' + id + '-' + n, JSON.stringify({ threadId: params.threadId, lastTurnId: params.lastTurnId }));
      if (id === 'writer-recovery-hidden-attachment-refused') return error('fixture attachment unavailable', -32600);
      return answer({ thread: { id: continuationId, forkedFromId: stagingId, attachedToThreadId: stagingId, ephemeral: false }, cwd: params.cwd });
    }
    fs.writeFileSync('fork-' + id + '-' + n, JSON.stringify(params));
    configure();
    return answer({ thread: { id: stagingId, forkedFromId: threadId, ephemeral: false,
      ...(supportsAttachment ? { historyMode: 'paginated', attachedToThreadId: null } : {}) }, cwd: params.cwd });
  }
  if (supportsAttachment && method === 'thread/goal/get') return answer({ goal: id === 'writer-recovery-hidden-goal' ? { status: 'active' } : null });
  if (recovering && method === 'thread/archive') {
    fs.appendFileSync('archive-' + id + '-' + n, params.threadId + '\\n');
    if (id === 'writer-recovery-hidden-archive-refused') return error('fixture archive denied', -32600);
    return answer({});
  }
  if (method === 'mcpServerStatus/list') return answer({ data: [{ name: 'muster', runtimeStatus: 'connected', tools }] });
  if (method !== 'turn/start') return answer({});
  fs.writeFileSync('submitted-' + id + '-' + n, JSON.stringify(params));
  const actualThread = params.threadId;
  answer({ turn: { id: turnId } });
  if (id.startsWith('tree-') && n === 1) require('node:child_process').spawn(process.execPath, ['tree-child.cjs'], { stdio: 'inherit', windowsHide: true });
  emit({ method: 'item/completed', params: { threadId: actualThread, turnId, item: { id: 'a', type: 'agentMessage', text: 'stream-' + n } } });
  fs.writeFileSync('terminal-' + id + '-' + n, 'ok');
  if (n === 1 && ['tail-error', 'tree-crash', 'eof-stuck', 'abort-stuck'].includes(id)) {
    if (id === 'abort-stuck') process.on('SIGTERM', () => {});
    if (id === 'tail-error') {
      const poll = setInterval(() => {
        if (!fs.existsSync('release-' + id + '-' + n)) return;
        clearInterval(poll);
        console.error('fixture tail failed');
        process.exit(1);
      }, 5);
    }
    return;
  }
  const failed = id === 'failed-event';
  emit({ method: 'turn/completed', params: { threadId: actualThread, turn: { id: turnId,
    status: failed ? 'failed' : 'completed', ...(failed ? { error: { message: 'fixture turn failed' } } : {}) } } });
});
`);

async function realConnection(id, onEvent, limits = {}) {
  const workerDir = path.join(root, 'src/main/agentSession/drivers/codex/worker');
  const gated = ['completion', 'queued', 'failed-event', 'tree-normal'].includes(id);
  const terminate = gated ? async () => {
    const n = Number(fs.readFileSync(path.join(tmp, 'count-' + id), 'utf8'));
    await until(() => fs.existsSync(flag(id, n, 'release')), 'test released the owner');
  } : undefined;
  const driver = new CodexRuntimeDriver(ctx, { userDataDir: tmp }, {
    resolveExecutable: async () => ({ ok: true, executable: process.execPath, packaged: false }),
    hostMcpScript,
    createAppServerClient: options => createCodexAppServerClient({
      ...options, env: { ...options.env, CODEX_HOME: path.join(tmp, 'home'), LIFECYCLE_CASE: id }
    }, { workerPath: path.join(workerDir, 'native-worker.mjs'), jobPath: path.join(workerDir, 'windows-job.ps1'), terminate, ...limits })
  });
  const conn = await driver.connect(input(id));
  return { conn, events: collect(conn, onEvent) };
}
async function ready(id, n, events) {
  await until(() => fs.existsSync(flag(id, n, 'terminal')) && events.some(e => e.type === 'text-delta' && e.delta === `stream-${n}`), 'live stream before terminal');
  // Drain queued promise continuations while the child is deterministically held alive.
  await sleep(20);
}

function fakeDriver() {
  const runs = [];
  const resumed = [];
  const driver = new CodexRuntimeDriver(ctx, { userDataDir: tmp }, { resolveExecutable: async () => ({ ok: true, packaged: false }),
    hostMcpScript,
    createClient: () => ({
      startThread: () => { throw new Error('unexpected new thread'); },
      resumeThread: id => {
        resumed.push(id);
        return { id, async runStreamed(_text, { signal }) {
          const end = deferred();
          fakeEnds.push(end);
          const run = { signal, end };
          runs.push(run);
          return { events: (async function* () {
            yield { type: 'thread.started', thread_id: id };
            yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
            await end.promise;
            if (signal.aborted) throw new Error('fixture aborted after drain');
          })() };
        } };
      }
    })
  });
  return { driver, runs, resumed };
}

const cases = {
  async windows_assignment_failure() {
    const jobPath = path.join(tmp, 'deny-job.ps1');
    // Full opened-challenge-v1 handshake so the owner can walk
    // opened -> assign -> ready -> reclaim -> released. The gated worker
    // (workerPath) refuses to launch the CLI and reports the denial itself,
    // leaving a genuinely empty container that can be safely released.
    fs.writeFileSync(jobPath, `# MUSTER_WINDOWS_JOB_PROTOCOL=opened-challenge-v1
[Console]::Out.WriteLine('{"type":"opened"}')
$command = [Console]::In.ReadLine()
if ($command -ne 'assign') { return }
[Console]::Out.WriteLine('{"type":"ready"}')
while ($null -ne ($command = [Console]::In.ReadLine())) {
  if ($command -ne 'reclaim') { continue }
  [Console]::Out.WriteLine('{"type":"released"}')
  break
}`);
    const id = 'assignment-denied';
    const {conn, events} = await realConnection(id, undefined, {jobPath,
      workerPath: path.join(tmp, 'gated-worker.mjs')});
    await assert.rejects(send(conn, 'first'), { message: /assignment denied/, delivery: 'not-submitted' });
    assert.equal(fs.existsSync(flag(id, 1, 'pid')), false, 'CLI must never launch before job assignment');
    assert.equal(events.filter(e => e.type === 'execution').at(-1).state.process, 'released', 'gated worker can safely release without descendants');
  },
  async windows_tree_normal() {
    const id = 'tree-normal';
    const {conn, events} = await realConnection(id, undefined, {completionMs: 3000});
    const first = send(conn, 'first'); await ready(id, 1, events);
    await until(() => fs.existsSync(path.join(tmp, 'tree-grand-' + id)), 'grandchild started inside job');
    const pids = ['tree-child-', 'tree-grand-'].map(prefix => Number(fs.readFileSync(path.join(tmp, prefix + id), 'utf8')));
    assert.ok(pids.every(alive), 'real descendants are alive before cleanup');
    release(id, 1);
    await Promise.race([first, sleep(5000).then(() => { throw new Error('tree recovery exceeded budget'); })]);
    assert.ok(pids.every(pid => !alive(pid)), 'job emptied, including descendants, before terminal');
    const next = send(conn, 'next'); await ready(id, 2, events); release(id, 2); await next;
  },
  async windows_tree_failure_after_worker_exit() {
    const id = 'tree-crash';
    let worker; let deny = true;
    cleanupHooks.push(() => { deny = false; });
    const {conn, events} = await realConnection(id, undefined, {completionMs: 3000, abortMs: 100,
      spawnProcess: (...args) => (worker = spawn(...args)),
      terminate: async () => { if (deny) throw new Error('fixture Windows job access denied'); }
    });
    const first = send(conn, 'first'); await ready(id, 1, events);
    await until(() => fs.existsSync(path.join(tmp, 'tree-grand-' + id)), 'grandchild started');
    const pids = [pidOf(id, 1), ...['tree-child-', 'tree-grand-'].map(prefix => Number(fs.readFileSync(path.join(tmp, prefix + id), 'utf8')))];
    assert.ok(pids.every(alive), 'native CLI descendants started inside job');
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `[System.Diagnostics.Process]::GetProcessById(${worker.pid}).Kill()`], {windowsHide:true});
    await until(() => events.some(e => e.type === 'execution' && e.state.process === 'reclaim_failed'), 'failure after worker exit');
    assert.equal(alive(worker.pid), false);
    // Some Windows hosts also terminate descendants on root death. Neither outcome is a Job-empty acknowledgement.
    await assert.rejects(conn.send('unsafe'), /尚未结束/);
    assert.equal(events.some(e => e.type === 'turn-complete'), false);
    // The denied reclaim is published as reclaim_failed; the abort call itself
    // must not be awaited as a success (the owner still holds the writer).
    await conn.abort().catch(() => {});
    deny = false; await conn.abort().catch(() => {}); await first;
    assert.ok(pids.every(pid => !alive(pid)), 'retry reclaims job even though worker PID is gone');
    const next = send(conn, 'next'); await ready(id, 2, events); release(id, 2); await next;
  },
  async spawn_failure() {
    const { conn, events } = await realConnection('spawn-failed', undefined, { spawnProcess: () => deniedSpawn('fixture spawn denied') });
    for (const prompt of ['first', 'second']) {
      await assert.rejects(send(conn, prompt), { message: /spawn denied/, delivery: 'not-submitted' });
      assert.equal(events.filter(e => e.type === 'execution').at(-1).state.process, 'released',
        'spawn failure does not retain a phantom writer');
    }
  },
  async eof_without_terminal() {
    const id = 'eof-stuck';
    let closeOutput;
    const { conn, events } = await realConnection(id, undefined, { completionMs: 80, abortMs: 50, spawnProcess: (...args) => {
      const child = spawn(...args);
      if (!closeOutput) {
        const pipe = new PassThrough();
        const output = child.stdout;
        output.pipe(pipe, { end: false });
        closeOutput = () => { output.unpipe(pipe); pipe.end(); };
        Object.defineProperty(child, 'stdout', { value: pipe });
      }
      return child;
    } });
    const first = send(conn, 'first');
    const failed = assert.rejects(first, { message: /输出提前结束/, delivery: 'unknown' });
    void failed.catch(() => {});
    await ready(id, 1, events);
    closeOutput();
    await failed;
    assert.equal(alive(pidOf(id, 1)), false);
    assert.equal(events.filter(e => e.type === 'execution').at(-1).state.result, 'failed');
    const next = send(conn, 'continue'); await ready(id, 2, events); release(id, 2); await next;
    assert.equal(events.filter(e => e.type === 'turn-complete').length, 1);
  },
  async reclaim_failure_retry() {
    const id = 'reclaim-failed';
    let deny = true;
    const { conn, events } = await realConnection(id, undefined, { completionMs: 80, abortMs: 30,
      terminate: async child => { if (deny) throw new Error('fixture access denied'); child.kill('SIGKILL'); } });
    const first = send(conn, 'first'); await ready(id, 1, events);
    await until(() => events.some(e => e.type === 'execution' && e.state.process === 'reclaim_failed'), 'visible reclaim failure');
    assert.equal(alive(pidOf(id, 1)), true);
    assert.equal(events.some(e => e.type === 'turn-complete' || e.type === 'error'), false, 'no false terminal while writer lives');
    await assert.rejects(conn.send('unsafe'), /尚未结束/);
    // The first reclaim is denied and reported as reclaim_failed; keep the
    // writer leased and retry below rather than awaiting this as a success.
    await conn.abort().catch(() => {});
    assert.equal(alive(pidOf(id, 1)), true);
    deny = false;
    await conn.abort().catch(() => {}); await first;
    assert.equal(alive(pidOf(id, 1)), false);
    assert.equal(events.filter(e => e.type === 'turn-complete').length, 1);
    const next = send(conn, 'continue'); await ready(id, 2, events); release(id, 2); await next;
    assert.equal(events.filter(e => e.type === 'turn-complete').length, 2);
    const states = events.filter(e => e.type === 'execution').map(e => e.state);
    const firstId = states[0].id;
    assert.ok(states.filter(s => s.id === firstId).every((s, i, a) => i === 0 || s.revision > a[i - 1].revision));
    assert.equal(states.filter(s => s.id === firstId).at(-1).process, 'released');
  },
  async completion_reclaim() {
    const id = 'completion-reclaim';
    const { conn, events } = await realConnection(id, undefined, { completionMs: 100 });
    const first = send(conn, 'first'); await ready(id, 1, events);
    await until(() => events.some(e => e.type === 'turn-complete'), 'completed turn must reclaim the native process');
    await first;
    assert.equal(alive(pidOf(id, 1)), false, 'writer must exit before Host is unlocked');
    assert.ok(events.some(e => e.type === 'execution' && e.state.process === 'draining' && e.state.result === 'completed'));
    assert.ok(events.some(e => e.type === 'execution' && e.state.process === 'reclaiming'));
    assert.equal(events.filter(e => e.type === 'error').length, 0);
    const next = send(conn, 'continue'); await ready(id, 2, events); release(id, 2); await next;
    assert.equal(fs.readFileSync(flag(id, 2, 'resume'), 'utf8'), 'thread-' + id);
    assert.equal(events.filter(e => e.type === 'turn-complete').length, 2);
  },
  async abort_stuck() {
    const id = 'abort-stuck';
    const { conn, events } = await realConnection(id, undefined, { abortMs: 100, completionMs: 100 });
    const first = send(conn, 'first'); await ready(id, 1, events);
    await sleep(150);
    assert.equal(alive(pidOf(id, 1)), true, 'quiet active turn has no completion timeout');
    const stopping = conn.abort(); let stopped = false; stopping.then(() => { stopped = true; });
    await until(() => stopped, 'stop fallback must recover'); await first;
    assert.equal(alive(pidOf(id, 1)), false);
    assert.equal(events.filter(e => e.type === 'error').length, 0);
    const next = send(conn, 'continue'); await ready(id, 2, events); release(id, 2); await next;
    assert.equal(events.filter(e => e.type === 'turn-complete').length, 2);
  },
  async inherited_pipe() {
    const id = 'inherited-pipe';
    let spawns = 0;
    const { conn, events } = await realConnection(id, undefined, { completionMs: 100, spawnProcess: (...args) => {
      const child = spawn(...args);
      if (++spawns === 1) {
        const retained = new PassThrough();
        child.stdout.pipe(retained, { end: false });
        Object.defineProperty(child, 'stdout', { value: retained });
      }
      return child;
    } });
    const first = send(conn, 'first'); await ready(id, 1, events);
    await until(() => events.some(e => e.type === 'turn-complete'), 'inherited stdout must not hold the writer lease');
    await first;
    assert.equal(alive(pidOf(id, 1)), false);
    const next = send(conn, 'continue'); await ready(id, 2, events); release(id, 2); await next;
    assert.equal(events.filter(e => e.type === 'turn-complete').length, 2);
  },
  async completion() {
    const id = 'completion'; const { conn, events } = await realConnection(id);
    const first = send(conn, 'first'); await ready(id, 1, events);
    assert.equal(events.some(e => e.type === 'turn-complete' || e.type === 'error'), false, 'no Host terminal before app-server exits');
    await assert.rejects(conn.send('premature second'), /尚未结束/, 'same connection still owns its writer');
    release(id, 1); await first;
    assert.equal(alive(pidOf(id, 1)), false, 'writer exited before Host terminal');
    const second = send(conn, 'second'); await ready(id, 2, events); release(id, 2); await second;
    assert.equal(events.filter(e => e.type === 'turn-complete').length, 2);
    assert.equal(events.filter(e => e.type === 'error').length, 0);
    assert.deepEqual(events.filter(e => e.type === 'text-delta').map(e => e.delta), ['stream-1', 'stream-2'], 'per-turn item IDs do not share stream state');
  },
  async queued() {
    const id = 'queued'; let next;
    let conn;
    const collected = await realConnection(id, e => { if (e.type === 'turn-complete' && !next) next = send(conn, 'queued next'); });
    conn = collected.conn; const events = collected.events;
    const first = send(conn, 'first'); await ready(id, 1, events);
    assert.equal(next, undefined, 'Host drain cannot launch before writer release');
    release(id, 1); await first;
    await until(() => next !== undefined, 'queued send'); await ready(id, 2, events);
    assert.equal(alive(pidOf(id, 1)), false); release(id, 2); await next;
    assert.equal(events.filter(e => e.type === 'turn-complete').length, 2);
    assert.equal(events.filter(e => e.type === 'error').length, 0);
  },
  async tail_error() {
    const id = 'tail-error'; const { conn, events } = await realConnection(id);
    const first = send(conn, 'first');
    const failed = assert.rejects(first, { message: /fixture tail failed/, delivery: 'unknown' });
    void failed.catch(() => {});
    await ready(id, 1, events);
    assert.equal(events.some(e => e.type === 'turn-complete'), false, 'success cannot precede a failed exit');
    release(id, 1);
    await failed;
    const second = send(conn, 'second'); await ready(id, 2, events); release(id, 2); await second;
    assert.equal(events.filter(e => e.type === 'turn-complete').length, 1, 'old exit cannot end new turn');
  },
  async failed_event() {
    const id = 'failed-event'; const { conn, events } = await realConnection(id);
    const first = send(conn, 'first'); await ready(id, 1, events);
    assert.equal(events.some(e => e.type === 'error'), false, 'turn.failed also waits for process exit');
    release(id, 1); await first;
    assert.match(events.find(e => e.type === 'error').message, /fixture turn failed/);
    assert.equal(alive(pidOf(id, 1)), false);
  },
  async abort() {
    const id = 'abort'; const { conn, events } = await realConnection(id);
    const first = send(conn, 'first'); await ready(id, 1, events);
    await conn.abort(); await first;
    assert.equal(alive(pidOf(id, 1)), false, 'AbortController is retained until exit, including after turn.completed');
    assert.equal(events.filter(e => e.type === 'error').length, 0);
    const next = send(conn, 'after abort'); await ready(id, 2, events); release(id, 2); await next;
    assert.equal(events.filter(e => e.type === 'turn-complete').length, 2);
  },
  async close_and_reconnect() {
    const fake = fakeDriver();
    const old = await fake.driver.connect(input('shared-writer')); collect(old);
    const first = send(old, 'old'); await until(() => fake.runs.length === 1, 'old run');
    const closing = old.close(); let closed = false; closing.then(() => { closed = true; });
    const next = await fake.driver.connect(input('shared-writer')); collect(next);
    const second = send(next, 'new');
    await sleep(20);
    assert.equal(fake.runs[0].signal.aborted, true);
    assert.equal(closed, false, 'close waits for drain');
    assert.equal(fake.runs.length, 1, 'new connection cannot resume the old active writer');
    fake.runs[0].end.resolve(); await closing; await first;
    await until(() => fake.runs.length === 2, 'new run after release');
    fake.runs[1].end.resolve(); await second;
  },
  async cancel_waiter() {
    const fake = fakeDriver();
    const owner = await fake.driver.connect(input('waiting-writer')); collect(owner);
    const first = send(owner, 'owner'); await until(() => fake.runs.length === 1, 'owner run');
    const waiter = await fake.driver.connect(input('waiting-writer')); collect(waiter);
    const waiting = send(waiter, 'waiter'); await sleep(20);
    await waiter.abort(); await waiting;
    assert.equal(fake.runs.length, 1, 'aborting a waiter does not spawn another turn');
    assert.equal(fake.runs[0].signal.aborted, false, 'waiter cannot abort owner');
    fake.runs[0].end.resolve(); await first;
  },
  async separate_homes() {
    const fake = fakeDriver();
    const savedHome = process.env.CODEX_HOME;
    let a, b;
    try {
      process.env.CODEX_HOME = path.join(tmp, 'home-a');
      a = await fake.driver.connect(input('same-id')); collect(a);
      process.env.CODEX_HOME = path.join(tmp, 'home-b');
      b = await fake.driver.connect(input('same-id')); collect(b);
    } finally {
      if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome;
    }
    const first = send(a, 'home a'); const second = send(b, 'home b');
    await until(() => fake.runs.length === 2, 'separate homes run independently');
    fake.runs.forEach(run => run.end.resolve()); await Promise.all([first, second]);
  },
  async external_busy() {
    const id = 'external-busy'; const { conn, events } = await realConnection(id);
    for (const prompt of ['first', 'retry']) {
      await assert.rejects(send(conn, prompt), { message: /already has an active writer/, delivery: 'not-submitted' });
    }
    assert.ok(events.filter(e => e.type === 'resume-token').length === 0, 'external conflict never clears/replaces resume token');
    assert.equal(fs.readFileSync(flag(id, 2, 'resume'), 'utf8'), 'thread-external-busy', 'second attempt keeps the original resume ID');
  },
  async writer_recovery() {
    const id = 'writer-recovery';
    const source = 'thread-' + id, target = source + '-continuation';
    const { conn, events } = await realConnection(id);
    const commits = [];
    await send(conn, 'continue here', { async commitNativeContinuation(from, to) {
      assert.equal(fs.existsSync(flag(id, 1, 'submitted')), false, 'persist the new binding before turn/start');
      commits.push([from, to]);
    } });
    const fork = JSON.parse(fs.readFileSync(flag(id, 1, 'fork'), 'utf8'));
    assert.equal(fork.threadId, source);
    assert.equal(fork.lastTurnId, 'saved-turn');
    assert.equal(fork.deferGoalContinuation, true);
    assert.deepEqual(commits, [[source, target]]);
    const submitted = JSON.parse(fs.readFileSync(flag(id, 1, 'submitted'), 'utf8'));
    assert.equal(submitted.threadId, target);
    assert.equal(submitted.input[0].text, 'continue here');
    assert.ok(events.some(event => event.type === 'text-delta' && event.delta === 'stream-1'));
    await send(conn, 'follow-up');
    assert.equal(fs.readFileSync(flag(id, 2, 'resume'), 'utf8'), target);
    assert.equal(fs.existsSync(flag(id, 2, 'fork')), false);
  },
  async writer_recovery_rejects_unconfirmed_history() {
    for (const name of ['running', 'wrong-history']) {
      const id = 'writer-recovery-' + name;
      const { conn, events } = await realConnection(id);
      let committed = false;
      await assert.rejects(send(conn, 'hold this message', {
        async commitNativeContinuation() { committed = true; }
      }), { delivery: 'not-submitted' });
      assert.equal(committed, false);
      assert.equal(fs.existsSync(flag(id, 1, 'submitted')), false);
      assert.equal(events.some(event => event.type === 'resume-token'), false);
      assert.equal(fs.existsSync(flag(id, 1, 'fork')), name === 'wrong-history');
      if (name === 'wrong-history') assert.equal(fs.readFileSync(flag(id, 2, 'archive'), 'utf8').trim(), 'thread-' + id + '-continuation');
    }
  },
  async writer_recovery_hides_continuation() {
    const id = 'writer-recovery-hidden';
    const source = 'thread-' + id;
    const { conn } = await realConnection(id);
    const commits = [];
    await send(conn, 'continue here', { async commitNativeContinuation(from, to) {
      assert.equal(fs.readFileSync(flag(id, 1, 'archive'), 'utf8').trim(), source + '-staging');
      assert.equal(fs.existsSync(flag(id, 1, 'submitted')), false);
      commits.push([from, to]);
    } });
    assert.deepEqual(commits, [[source, source + '-continuation']]);
    assert.deepEqual(JSON.parse(fs.readFileSync(flag(id, 1, 'attached'), 'utf8')), { threadId: source + '-staging', lastTurnId: 'saved-turn' });
    assert.equal(JSON.parse(fs.readFileSync(flag(id, 1, 'submitted'), 'utf8')).threadId, source + '-continuation');
    await send(conn, 'follow-up');
    assert.equal(fs.readFileSync(flag(id, 2, 'resume'), 'utf8'), source + '-continuation');
  },
  async writer_recovery_preserves_delivery_when_hiding_unavailable() {
    for (const scenario of ['goal', 'attachment-refused', 'archive-refused']) {
      const id = 'writer-recovery-hidden-' + scenario;
      const source = 'thread-' + id;
      const { conn } = await realConnection(id);
      const expected = source + (scenario === 'archive-refused' ? '-continuation' : '-staging');
      const commits = [];
      await send(conn, 'continue safely', { async commitNativeContinuation(from, to) { commits.push([from, to]); } });
      assert.deepEqual(commits, [[source, expected]]);
      assert.equal(fs.existsSync(flag(id, 1, 'attached')), scenario !== 'goal');
      assert.equal(fs.existsSync(flag(id, 1, 'archive')), scenario === 'archive-refused');
      assert.equal(JSON.parse(fs.readFileSync(flag(id, 1, 'submitted'), 'utf8')).threadId, expected);
    }
  },
  async writer_recovery_requires_durable_binding() {
    const id = 'writer-recovery-commit-failed';
    const { conn, events } = await realConnection(id);
    await assert.rejects(send(conn, 'hold this message', {
      async commitNativeContinuation() { throw new Error('fixture registry write failed'); }
    }), { message: /fixture registry write failed/, delivery: 'not-submitted' });
    assert.equal(fs.existsSync(flag(id, 1, 'submitted')), false);
    assert.equal(events.some(event => event.type === 'resume-token'), false);
    assert.equal(fs.readFileSync(flag(id, 2, 'archive'), 'utf8').trim(), 'thread-' + id + '-continuation');
    await assert.rejects(send(conn, 'try the same original thread'), { message: /active writer/, delivery: 'not-submitted' });
    assert.equal(fs.readFileSync(flag(id, 3, 'resume'), 'utf8'), 'thread-' + id);
  },
  async writer_recovery_cancel_keeps_original_binding() {
    const id = 'writer-recovery-cancelled-bind';
    const { conn, events } = await realConnection(id);
    const committing = deferred(), cancelCommit = deferred();
    const attempt = send(conn, 'cancel before the new binding is saved', {
      async commitNativeContinuation() {
        committing.resolve();
        await cancelCommit.promise;
        throw new Error('fixture binding cancelled');
      }
    });
    await committing.promise;
    const cancellation = conn.abort();
    cancelCommit.resolve();
    await Promise.all([attempt, cancellation]);
    assert.equal(fs.existsSync(flag(id, 1, 'submitted')), false);
    assert.equal(events.some(event => event.type === 'resume-token'), false, 'an aborted unbound fork cannot replace the original ID');
    assert.equal(fs.readFileSync(flag(id, 2, 'archive'), 'utf8').trim(), 'thread-' + id + '-continuation');
    await assert.rejects(send(conn, 'retry the original'), { message: /active writer/, delivery: 'not-submitted' });
    assert.equal(fs.readFileSync(flag(id, 3, 'resume'), 'utf8'), 'thread-' + id);
  },
  async writer_recovery_exit_waits_for_binding() {
    const id = 'writer-recovery-process-exit';
    const continuation = 'thread-' + id + '-continuation';
    const { conn, events } = await realConnection(id);
    const committing = deferred(), finishCommit = deferred();
    const attempt = assert.rejects(send(conn, 'the native process stops during the registry write', {
      async commitNativeContinuation() {
        committing.resolve();
        await finishCommit.promise;
      }
    }), { delivery: 'not-submitted' });
    await committing.promise;
    try {
      process.kill(pidOf(id, 1), 'SIGKILL');
      await until(() => events.some(event => event.type === 'execution' && event.state.process === 'released'), 'owner released');
      assert.equal(fs.existsSync(flag(id, 2, 'archive')), false);
    } finally { finishCommit.resolve(); }
    await attempt;
    assert.equal(fs.existsSync(flag(id, 2, 'archive')), false, 'the durable continuation must stay available');
    assert.equal(fs.existsSync(flag(id, 1, 'submitted')), false);
    await send(conn, 'resume the new binding');
    assert.equal(fs.readFileSync(flag(id, 2, 'resume'), 'utf8'), continuation);
  }
};

const cwdBefore = process.cwd();
try {
  process.chdir(tmp);
  const selected = process.argv[2] ? [[process.argv[2], cases[process.argv[2]]]] : Object.entries(cases);
  for (const [name, run] of selected) {
    assert.ok(run, 'known case');
    if (name.startsWith('windows_') && process.platform !== 'win32') { console.log(`skip ${name} (Windows only)`); continue; }
    try { await run(); console.log(`ok ${name}`); } catch (error) { console.error(name, error); throw error; }
  }
} finally {
  for (const cleanup of cleanupHooks) cleanup();
  // Release every controlled tail first, including those started by the pre-fix driver.
  for (const name of fs.readdirSync(tmp)) if (/^pid-/.test(name)) fs.writeFileSync(path.join(tmp, name.replace(/^pid-/, 'release-')), 'cleanup');
  for (const end of fakeEnds) end.resolve();
  // Lifecycle cases deliberately leave denied reclaims; a close that reports
  // the already-published failure must not become an unhandled rejection.
  for (const conn of connections) await conn.close().catch(() => {});
  await Promise.allSettled(sends);
  process.chdir(cwdBefore);
  assert.ok(path.resolve(tmp).startsWith(path.resolve(root, '.tmp') + path.sep));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
