/** Real preload API + EventEmitter: many UI subscribers share one native listener. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { buildSync } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const { outputFiles } = buildSync({
  entryPoints: [path.join(root, 'src/preload/index.ts')],
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false
});
const ipc = new EventEmitter();
let api;
const electron = {
  ipcRenderer: ipc,
  webUtils: {},
  contextBridge: { exposeInMainWorld(name, value) { if (name === 'api') api = value; } }
};
const module = { exports: {} };
new Function('require', 'exports', 'module', outputFiles[0].text)(specifier => {
  assert.equal(specifier, 'electron', 'preload runtime imports stay bundled');
  return electron;
}, module.exports, module);
assert.ok(api);
assert.equal(api.feishu, undefined, 'the retired bridge API is not exposed');
assert.equal(typeof api.messaging.call, 'function', 'Channel management remains available');
assert.throws(() => api.on('feishu:status', () => {}), /未知事件频道/);

const channel = 'capabilityManagement:changed';
const payload = { kind: 'skills', revision: 7 };
const nativeEvent = { sender: 'must not reach UI callbacks' };

// The reported trigger: opening many composers must not reach the native limit.
const calls = Array.from({ length: 24 }, () => []);
const off = calls.map(received => api.on(channel, (...args) => received.push(args)));
assert.equal(ipc.listenerCount(channel), 1, '24 UI subscribers share one native listener');
ipc.emit(channel, nativeEvent, payload);
for (const received of calls) assert.deepEqual(received, [[payload]], 'deliver payload once, without IPC event');

off[0](); off[0]();
ipc.emit(channel, nativeEvent, payload);
assert.equal(calls[0].length, 1, 'unsubscribe is independent and idempotent');
for (const received of calls.slice(1)) assert.equal(received.length, 2);
assert.equal(ipc.listenerCount(channel), 1);
off.slice(1).forEach(stop => stop());
assert.equal(ipc.listenerCount(channel), 0, 'last subscriber releases the native listener');

// Repeated setup/cleanup, including stale cleanup after a new subscription.
for (let round = 0; round < 30; round++) {
  let count = 0;
  const stop = api.on(channel, () => count++);
  off[0]();
  assert.equal(ipc.listenerCount(channel), 1);
  ipc.emit(channel, nativeEvent, payload);
  assert.equal(count, 1);
  stop();
  assert.equal(ipc.listenerCount(channel), 0, 'remount cycles do not accumulate listeners');
}

// Reusing a callback still creates distinct subscriptions, as EventEmitter.on does.
let duplicateCalls = 0;
const sameCallback = () => duplicateCalls++;
const stopA = api.on(channel, sameCallback);
const stopB = api.on(channel, sameCallback);
ipc.emit(channel, nativeEvent, payload);
assert.equal(duplicateCalls, 2);
stopA();
ipc.emit(channel, nativeEvent, payload);
assert.equal(duplicateCalls, 3);
stopB();

// Independent channels and allowlist validation remain intact.
let otherCalls = 0;
const stopOther = api.on('runtimes:changed', () => otherCalls++);
const stopCapability = api.on(channel, () => {});
ipc.emit(channel, nativeEvent, payload);
assert.equal(otherCalls, 0);
stopCapability();
assert.equal(ipc.listenerCount('runtimes:changed'), 1);
ipc.emit('runtimes:changed', nativeEvent, {});
assert.equal(otherCalls, 1);
stopOther();
assert.throws(() => api.on('unknown:event', () => {}), /未知事件频道/);
assert.equal(ipc.listenerCount('unknown:event'), 0);

// Preserve EventEmitter dispatch ordering: snapshot before callbacks mutate subscriptions.
const order = [];
let stopSecond;
let stopAdded;
const stopFirst = api.on(channel, () => {
  order.push('first');
  stopSecond();
  stopAdded ??= api.on(channel, () => order.push('added'));
});
stopSecond = api.on(channel, () => order.push('second'));
ipc.emit(channel, nativeEvent, payload);
assert.deepEqual(order, ['first', 'second']);
order.length = 0;
ipc.emit(channel, nativeEvent, payload);
assert.deepEqual(order, ['first', 'added']);
stopFirst(); stopSecond(); stopAdded();
assert.deepEqual(ipc.eventNames(), [], 'all channels are released');

console.log('preload-event-subscriptions: passed (fan-out, cleanup, remount, duplicates, allowlist, ordering)');
