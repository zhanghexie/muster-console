import assert from 'node:assert/strict';
import { prepareCodexTui } from '../src/main/runtime/builtins/scripts/_codex-native.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition, message) => {
  for (let count = 0; count < 200; count++) {
    if (condition()) return;
    await pause(10);
  }
  throw new Error(message);
};

let notification;
let status = 'active';
let snapshotThread = 'thread-one';
let holdRead;
let releaseRead;
const rpc = {
  onNotification(listener) { notification = listener; },
  async request(method) {
    if (method === 'thread/loaded/list') return { data: ['thread-one'] };
    if (method === 'thread/read') {
      const captured = status;
      if (holdRead) await new Promise(resolve => { releaseRead = resolve; });
      return { thread: { id: snapshotThread, status: { type: captured } } };
    }
    return {};
  },
  notify() {}, dispose() {},
};
const launch = await prepareCodexTui({ mode: 'start', sessionId: 'codex-pending-fixture', cwd: '.', extraArgs: [], WebSocket: class {}, env: {} },
  () => { throw Error('unexpected legacy fallback'); }, {
    probeCli: async () => '--remote-auth-token-env --ws-token-sha256', allocatePort: async () => 12345,
    startOwner: () => ({ child: { pid: 123 }, assertAlive() {}, dispose() {} }),
    openRpc: async () => rpc, launchCli: () => ({ command: 'fixture', args: [] }), monitorIntervalMs: 20,
  });
try {
  assert.equal(typeof launch.onActivity, 'function', 'activity is delivered without an HTTP token');
  const seen = [];
  const stop = launch.onActivity((kind, event) => seen.push({ kind, event }));
  launch.onSessionId(() => {});
  await until(() => seen.some(item => item.kind === 'active'), 'missing native active snapshot');
  status = 'idle';
  await until(() => seen.some(item => item.kind === 'idle'), 'missing native idle snapshot after lost turn/completed');
  assert.ok(seen.every(item => item.event === 'codex-turn'));
  holdRead = true;
  await until(() => !!releaseRead, 'missing delayed snapshot');
  notification('turn/started', { threadId: 'thread-one', turn: { id: 'new-turn' } });
  await until(() => seen.at(-1)?.kind === 'active', 'missing fresh turn notification');
  status = 'active';
  holdRead = false;
  releaseRead();
  await pause(40);
  assert.equal(seen.at(-1).kind, 'active', 'a stale idle snapshot must not end a newer turn');
  snapshotThread = 'other-thread'; status = 'idle';
  await pause(60);
  assert.equal(seen.at(-1).kind, 'active', 'a different thread cannot determine this session state');
  snapshotThread = 'thread-one'; status = 'active'; holdRead = true; releaseRead = undefined;
  await until(() => !!releaseRead, 'missing snapshot before unsubscribe');
  stop();
  const count = seen.length;
  status = 'idle'; holdRead = false;
  const next = [];
  const stopNext = launch.onActivity((kind, event) => next.push({ kind, event }));
  await until(() => next.at(-1)?.kind === 'idle', 'new subscriber must receive the current snapshot');
  releaseRead();
  await pause(50);
  assert.equal(seen.length, count, 'unsubscribed listeners receive no later activity');
  assert.equal(next.at(-1).kind, 'idle', 'an old subscription cannot overwrite the new monitor');
  stopNext();
} finally { launch.dispose(); }
console.log('ok: Codex native activity survives HTTP failure and missed notifications');
