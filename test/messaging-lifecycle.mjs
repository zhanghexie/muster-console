import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'messaging-lifecycle-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const compile = createSharedCompiler(fileURLToPath(new URL('..', import.meta.url)), temp);
const { ChannelRegistry } = await import(pathToFileURL(compile('main/messaging/channelRegistry.ts')).href);
const { MessagingChannelManager } = await import(pathToFileURL(compile('main/messaging/manager.ts')).href);
const { ConnectionSupervisor } = await import(pathToFileURL(compile('main/messaging/connectionSupervisor.ts')).href);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const secret = 'synthetic-private-platform-error';
const account = (botId, channelKey = 'test') => ({
  channelKey, botId, enabled: true, displayName: 'Fixture',
  credentialRef: { provider: 'test-provider', id: 'private-credential-reference' }
});
const message = ({ channelKey, botId }) => ({
  channelKey, botId, conversationId: 'chat', messageId: 'message', conversationType: 'group',
  senderId: 'user', senderIsBot: false, plainText: 'hello', addressed: true
});
const descriptor = channelKey => ({
  channelKey, displayName: 'Fake channel', connection: 'local',
  inbound: ['text'], outbound: ['text'], defaultTriggers: { direct: 'allowlist', group: 'mention' }, limits: {}
});
const unavailable = { status: 'not-admitted', code: 'stale-connection' };
const receive = async () => ({ status: 'ignored', reason: 'unbound' });

test('default manager starts and disposes with an empty registry', async () => {
  const manager = new MessagingChannelManager(new ChannelRegistry());
  manager.start();
  assert.deepEqual(manager.snapshot(), { channels: [], accounts: [] });
  const dispose = manager.stopAndWait();
  await dispose;
  assert.equal(manager.stopAndWait(), dispose, 'the root scope reuses the domain drain');
});

test('a failed account does not delay a healthy channel or expose credential and platform text', async () => {
  const channels = new ChannelRegistry();
  let badCloses = 0;
  let goodStarts = 0;
  const bad = account('same-account');
  const good = account('same-account', 'other-channel');
  const disabled = { ...account('disabled', 'other-channel'), enabled: false };
  channels.register({
    descriptor: descriptor(bad.channelKey),
    createConnection: () => ({
      async start() { throw new Error(secret); },
      close() { badCloses++; }
    })
  });
  channels.register({
    descriptor: descriptor(good.channelKey),
    createConnection: () => ({ start() { goodStarts++; }, close() {} })
  });
  const manager = new MessagingChannelManager(channels);
  manager.registerAccount(bad);
  manager.registerAccount(good);
  manager.registerAccount(disabled);
  assert.throws(() => manager.registerAccount(bad), /messaging-account-duplicate/);
  manager.start();
  const badStart = manager.startAccount(bad);
  assert.equal(manager.startAccount(bad), badStart);
  const rejected = assert.rejects(badStart, error => error.message === 'connection-start-failed' && error.cause === undefined);
  await manager.startAccount(good);
  await rejected;
  await assert.rejects(manager.startAccount(disabled), /messaging-account-disabled/);
  const snapshot = manager.snapshot();
  assert.equal(badCloses, 1);
  assert.equal(goodStarts, 1);
  assert.deepEqual(snapshot.accounts.map(({ enabled, state, diagnostic }) => [enabled, state, diagnostic]), [
    [true, 'failed', { phase: 'start', code: 'connection-start-failed' }],
    [true, 'online', undefined],
    [false, 'idle', undefined]
  ]);
  assert.doesNotMatch(inspect(snapshot), /credential|synthetic-private-platform-error/);
  await manager.stopAndWait();
  assert.equal(badCloses, 1);
});

test('shutdown before startup runs prevents adapter creation', async () => {
  let constructed = false;
  const supervisor = new ConnectionSupervisor(account('queued'), () => {
    constructed = true;
    throw new Error(secret);
  }, receive);
  const startup = assert.rejects(supervisor.start(), /connection-admission-closed/);
  await supervisor.stopAndWait();
  await startup;
  assert.equal(constructed, false);
  assert.equal(supervisor.snapshot().state, 'stopped');
});

test('shutdown cancels a starting generation and awaits both real transport barriers', async () => {
  const owner = account('slow');
  const enteredStart = deferred();
  const enteredClose = deferred();
  const actualStartup = deferred();
  const actualClose = deferred();
  let context;
  let nestedStop;
  let closeCalls = 0;
  const supervisor = new ConnectionSupervisor(owner, captured => {
    context = captured;
    return {
      async start() {
        enteredStart.resolve();
        await enteredClose.promise;
        await actualStartup.promise;
      },
      close() {
        closeCalls++;
        enteredClose.resolve();
        return actualClose.promise;
      }
    };
  }, receive);
  const startup = assert.rejects(supervisor.start(), /connection-admission-closed/);
  await enteredStart.promise;
  context.signal.addEventListener('abort', () => { nestedStop = supervisor.stopAndWait(); }, { once: true });
  let stopped = false;
  const stop = supervisor.stopAndWait();
  const completedStop = stop.then(() => { stopped = true; });
  assert.equal(context.signal.aborted, true);
  assert.equal(nestedStop, stop);
  await enteredClose.promise;
  actualClose.resolve();
  await setImmediate();
  assert.equal(stopped, false, 'a real close that unblocks startup must still join the startup barrier');
  assert.deepEqual(await context.receive(message(owner)), unavailable);
  actualStartup.resolve();
  await Promise.all([startup, completedStop]);
  assert.equal(closeCalls, 1);
  assert.equal(supervisor.snapshot().state, 'stopped');
});

test('startup timeout signals cancellation yet leaves closure pending until the adapter releases', async () => {
  const enteredStart = deferred();
  const released = deferred();
  let suppliedSignal;
  let starts = 0;
  let closeCalls = 0;
  const supervisor = new ConnectionSupervisor(account('timeout'), ({ signal }) => {
    suppliedSignal = signal;
    return {
      start() {
        starts++;
        enteredStart.resolve();
      },
      close() {
        closeCalls++;
        return released.promise;
      }
    };
  }, receive, 0);
  // A start that settles synchronously is ready before the deadline timer fires.
  await supervisor.start();
  await enteredStart.promise;
  await setTimeout(5);
  assert.equal(closeCalls, 0);
  assert.equal(suppliedSignal.aborted, false);
  const stop = supervisor.stopAndWait();
  released.resolve();
  await stop;
  assert.equal(starts, 1);

  const enteredLaggingClose = deferred();
  const laggingStartup = deferred();
  const laggingClose = deferred();
  let signalAfterTimeout;
  const lagging = new ConnectionSupervisor(account('lagging'), ({ signal }) => {
    signalAfterTimeout = signal;
    return {
      start: () => laggingStartup.promise,
      close: () => {
        laggingStartup.resolve();
        enteredLaggingClose.resolve();
        return laggingClose.promise;
      }
    };
  }, receive, 0);
  let startupSettled = false;
  const failure = assert.rejects(lagging.start(), /connection-start-timeout/).then(() => { startupSettled = true; });
  await Promise.all([enteredLaggingClose.promise, setTimeout(10)]);
  assert.equal(signalAfterTimeout.aborted, true);
  assert.equal(startupSettled, false);
  assert.deepEqual(lagging.snapshot(), {
    state: 'failed', diagnostic: { phase: 'start', code: 'connection-start-timeout' }
  });
  laggingClose.resolve();
  await failure;
  await lagging.stopAndWait();
});

test('a replacement waits for old close and rejects stale or mismatched messages', async () => {
  const owner = account('replacement');
  const released = deferred();
  const attempts = [];
  const routed = [];
  const supervisor = new ConnectionSupervisor(owner, context => {
    const waits = attempts.length === 0;
    attempts.push(context);
    return { start() {}, close: () => waits ? released.promise : undefined };
  }, async incoming => {
    routed.push(incoming);
    return { status: 'accepted', requestId: 'request', turnId: 'turn' };
  });
  await supervisor.start();
  const first = attempts[0];
  first.disconnected();
  const replacement = supervisor.start();
  await setImmediate();
  assert.equal(attempts.length, 1);
  assert.equal(first.signal.aborted, true);
  assert.deepEqual(await first.receive(message(owner)), unavailable);
  released.resolve();
  await replacement;
  const second = attempts[1];
  assert.ok(second.generation > first.generation);
  first.disconnected();
  assert.equal(supervisor.snapshot().state, 'online');
  assert.deepEqual(await second.receive(message(account('other'))), { status: 'not-admitted', code: 'account-mismatch' });
  assert.equal((await second.receive(message(owner))).status, 'accepted');
  assert.equal(routed.length, 1);
  await supervisor.stopAndWait();
});

test('the admission gate retains online output handles, drains accepted work and retries failed close', async () => {
  const channels = new ChannelRegistry();
  const contexts = new Map();
  const closeCounts = new Map();
  const blocked = deferred();
  const released = deferred();
  let routerAdmission = true;
  let routerDrains = 0;
  channels.register({
    descriptor: descriptor('test'),
    createConnection: ({ botId }, context) => {
      contexts.set(botId, context);
      return {
        start() {},
        close() {
          const calls = (closeCounts.get(botId) ?? 0) + 1;
          closeCounts.set(botId, calls);
          if (botId === 'bad' && calls === 1) throw new Error(secret);
          if (botId === 'healthy') return blocked.promise;
        }
      };
    }
  });
  const manager = new MessagingChannelManager(channels, {
    async accept() {
      assert.equal(routerAdmission, true);
      await released.promise;
      return { status: 'accepted', requestId: 'request', turnId: 'turn' };
    },
    stopAdmission() { routerAdmission = false; },
    stopAndWait() { routerDrains++; return released.promise; }
  });
  const bad = account('bad');
  const healthy = account('healthy');
  manager.registerAccount(bad);
  manager.registerAccount(healthy);
  manager.start();
  await Promise.all([manager.startAccount(bad), manager.startAccount(healthy)]);
  const active = contexts.get(healthy.botId);
  const accepted = active.receive(message(healthy));
  manager.stopAdmission();
  assert.equal(active.signal.aborted, false);
  assert.deepEqual(await active.receive(message(healthy)), unavailable);
  await assert.rejects(manager.startAccount(bad), /messaging-admission-closed/);
  assert.throws(() => manager.registerAccount(account('late')), /messaging-admission-closed/);

  let finished = false;
  const stop = manager.stopAndWait();
  assert.equal(stop, manager.stopAndWait());
  const failure = assert.rejects(stop, error => {
    assert.match(inspect(error), /connection-close-failed/);
    assert.doesNotMatch(inspect(error), /synthetic-private-platform-error/);
    return true;
  }).then(() => { finished = true; });
  await setImmediate();
  assert.equal(closeCounts.size, 0);
  released.resolve();
  assert.equal((await accepted).status, 'accepted');
  await setImmediate();
  assert.equal(closeCounts.get('bad'), 1);
  assert.equal(closeCounts.get('healthy'), 1);
  assert.equal(finished, false, 'one close failure cannot bypass an independent in-flight close');
  blocked.resolve();
  await failure;
  const retry = manager.stopAndWait();
  await retry;
  assert.equal(manager.stopAndWait(), retry);
  assert.equal(closeCounts.get('bad'), 2);
  assert.equal(closeCounts.get('healthy'), 1);
  assert.equal(routerDrains, 1);
});
