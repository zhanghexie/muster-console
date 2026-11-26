import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { SlackConfigStore } from '../src/main/messaging/dsh-im/src/channels/slack/config-store.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-messaging-host-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const compile = createSharedCompiler(root, temp);
const { MessagingHost } = await import(pathToFileURL(compile('main/messaging/messagingHost.ts')).href);

const credentials = {
  async resolve() { return undefined; },
  async describe() { return { configured: false }; },
  async set() { throw new Error('empty host cannot store credentials'); },
  async unset() { throw new Error('empty host cannot remove credentials'); }
};
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function ready(host) {
  while (host.status().state === 'initializing') await setImmediate();
  assert.equal(host.status().state, 'ready');
}

test('Channels registers account management for all supported providers in an empty deployment', { timeout: 10_000 }, async () => {
  const dataDir = path.join(temp, 'unconfigured');
  const diagnostics = [];
  const host = new MessagingHost({
    dataDir, credentials,
    createOfficeHarness() { throw new Error('No Office account is configured'); },
    onDiagnostic: event => diagnostics.push(event),
    runtimeLoader: () => import('../src/main/messaging/dsh-im/channel-runtime.mjs')
  });
  try {
    host.start();
    await ready(host);
    assert.equal(diagnostics.filter(event => event.code === 'startup-failed').length, 0, JSON.stringify(diagnostics));
    const expected = ['feishu', 'weixin', 'wecom', 'wecom-app', 'dingtalk', 'qq', 'slack', 'telegram',
      'discord', 'whatsapp', 'imessage', 'matrix', 'email', 'office'];
    assert.deepEqual(host.status().channels.map(channel => channel.key), expected);
    for (const channel of host.status().channels) {
      if (!channel.supported) {
        assert.equal(channel.key, 'imessage');
        assert.equal((await host.invoke(channel.key, 'connection.status')).error.code, 'macos-required');
        continue;
      }
      const result = await host.invoke(channel.key, 'connection.status');
      assert.equal(result.ok, true, `${channel.key}: ${JSON.stringify(result)}`);
    }
    for (const retired of ['dsh-im-delivery', 'dsh-im-delivery-sync', 'dsh-im-settings', 'dsh-im-language']) {
      assert.equal((await host.invoke(retired, 'connection.status')).error.code, 'unknown-channel');
    }
  } finally {
    await host.stopAndWait();
  }
});

test('legacy Slack credential references load from the original account directory', async () => {
  const platformId = 'fixture-team:fixture-user';
  const digest = createHash('sha256').update(platformId).digest('hex').slice(0, 24);
  const directory = path.join(temp, 'legacy-accounts', 'integrations', 'dsh-slack');
  fs.mkdirSync(directory, { recursive: true });
  const configFile = path.join(directory, 'config.json');
  const bot = {
    platformId, botId: 'slack_' + digest, name: 'Fixture account',
    botTokenRef: 'DSH_SLACK_BOT_TOKEN_' + digest.toUpperCase(),
    appTokenRef: 'DSH_SLACK_APP_TOKEN_' + digest.toUpperCase(),
  };
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, bots: [bot] }));
  const store = await new SlackConfigStore(configFile).load();
  const loaded = store.get(bot.botId);
  assert.equal(loaded?.botTokenRef, bot.botTokenRef);
  assert.equal(loaded?.appTokenRef, bot.appTokenRef);
});

test('only macOS registers iMessage while Windows and Linux retain the account catalog', async () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const registered = [];
    const host = new MessagingHost({
      dataDir: path.join(temp, 'platform-' + platform), credentials, platform,
      runtimeLoader: async () => ({ createRuntime: () => ({
        async install(channel, ctx) {
          registered.push(channel);
          return ctx.registerChannel(channel, async () => ({ ok: true, value: {} }));
        }
      }) }),
    });
    try {
      host.start();
      await ready(host);
      assert.equal(registered.includes('imessage'), platform === 'darwin');
      assert.equal(registered.length, platform === 'darwin' ? 14 : 13);
      const result = await host.invoke('imessage', 'connection.status');
      assert.equal(result.ok, platform === 'darwin');
      if (!result.ok) assert.equal(result.error.code, 'macos-required');
    } finally { await host.stopAndWait(); }
  }
});

test('host close starts provider release and waits for accepted management requests and cleanup retries', async () => {
  const inHandling = deferred();
  const release = deferred();
  const slowClose = deferred();
  let routeRegistered;
  let closeAttempts = 0;
  let requestsCancelled = false;
  const diagnostics = [];
  const host = new MessagingHost({
    dataDir: path.join(temp, 'fixture'), credentials, platform: 'win32',
    onDiagnostic: value => diagnostics.push(value),
    runtimeLoader: async () => ({
      createRuntime: () => ({
        async install(channel, ctx) {
          if (channel !== 'telegram') return;
          ctx.logger('telegram').warn('[dsh-telegram] {"referenceId":"IM-CONN-12345678","reason":"timeout","message":"fixture-secret"}');
          ctx.effect(() => async () => {
            closeAttempts++;
            release.resolve();
            if (closeAttempts === 1) throw new Error('fixture-secret');
            await slowClose.promise;
          });
          routeRegistered = true;
          return ctx.registerChannel(channel, async (_method, payload, signal) => {
            signal.addEventListener('abort', () => { requestsCancelled = true; });
            inHandling.resolve();
            await release.promise;
            return { ok: true, value: payload };
          });
        }
      })
    })
  });
  host.start();
  host.start();
  await ready(host);
  assert.equal(routeRegistered, true);
  assert.deepEqual(diagnostics, [{
    channel: 'telegram', code: 'provider-warning', referenceId: 'IM-CONN-12345678', reason: 'timeout'
  }]);
  assert.equal(host.status().channels.find(channel => channel.key === 'imessage').supported, false);
  const request = host.invoke('telegram', 'provision.begin');
  await inHandling.promise;
  host.stopAdmission();
  assert.equal(requestsCancelled, true);
  assert.equal((await host.invoke('telegram', 'connection.status')).error.code, 'cancelled');
  const stopping = host.stopAndWait();
  assert.equal(host.stopAndWait(), stopping);
  await assert.rejects(stopping, { message: 'IM provider shutdown failed' });
  assert.equal((await request).ok, true);
  let closed = false;
  const retry = host.stopAndWait().then(() => { closed = true; });
  await setImmediate();
  assert.equal(closeAttempts, 2);
  assert.equal(closed, false);
  slowClose.resolve();
  await retry;
});

test('the bundled defaults require the configured sender instead of inferring owners or command access', async () => {
  const { initialAccessPolicyFor, accessPolicyProvider } = await import(
    '../src/main/messaging/dsh-im/adapters/host/channels/shared/access-policy-production.mjs'
  );
  const { evaluateAccessPolicy } = await import('../src/main/messaging/dsh-im/src/channels/shared/access-policy.mjs');
  const denied = initialAccessPolicyFor('feishu', { ownerOpenIds: ['*', 'authenticated-owner'] });
  assert.equal(evaluateAccessPolicy(denied, { conversationType: 'direct', senderIds: 'authenticated-owner' }).allowed, false);
  assert.equal(accessPolicyProvider({ accessPolicyFor: () => denied }, 'bot').isPrivileged('authenticated-owner', 'direct'), false);
  const explicit = initialAccessPolicyFor('telegram', { allowedUsers: ['configured-user'] });
  const origin = { conversationType: 'direct', senderIds: 'configured-user' };
  assert.equal(evaluateAccessPolicy(explicit, origin).allowed, true);
  assert.equal(evaluateAccessPolicy(explicit, { ...origin, isCommand: true }).allowed, false);
  assert.equal(evaluateAccessPolicy(explicit, { ...origin, conversationType: 'group' }).allowed, false);
});

test('the Feishu compatibility disconnect revokes the exact account before removing credentials', async () => {
  const operations = [];
  const host = new MessagingHost({
    dataDir: path.join(temp, 'logical-feishu'), credentials,
    beforeAccountRemoval: (channel, botId, deleting) => operations.push(['revoke', channel, botId, deleting]),
    runtimeLoader: async () => ({ createRuntime: () => ({
      async install(channel, ctx) {
        if (channel !== 'feishu') return;
        return ctx.registerChannel(channel, async (method, payload) => {
          operations.push([method, payload]);
          const value = method === 'connection.status' ? { bots: [{ botId: 'first-bot' }, { botId: 'other-bot' }] } : {};
          return { ok: true, value };
        });
      }
    }) })
  });
  try {
    host.start(); await ready(host);
    assert.equal((await host.invoke('feishu', 'connection.disconnect', { removeCredentials: true })).ok, true);
    assert.deepEqual(operations, [
      ['connection.status', {}], ['revoke', 'feishu', 'first-bot', true], ['bot.delete', { botId: 'first-bot', confirm: true }]
    ]);
  } finally { await host.stopAndWait(); }
});

test('Slack and Discord socket disposal waits for the close event', async () => {
  const { closeSocketAndWait } = await import('../src/main/messaging/dsh-im/src/channels/shared/muster-socket-close.mjs');
  const socket = new EventTarget();
  socket.readyState = 1;
  socket.close = () => { socket.readyState = 2; };
  let completed = false;
  const closing = closeSocketAndWait(socket).then(() => { completed = true; });
  await setImmediate();
  assert.equal(socket.readyState, 2);
  assert.equal(completed, false);
  socket.readyState = 3;
  socket.dispatchEvent(new Event('close'));
  await closing;
  assert.equal(completed, true);
});

test('the upstream TokenBot controller stops a pending runtime and retains failed cleanup for retry', async () => {
  const { TokenBotController } = await import('../src/main/messaging/dsh-im/src/channels/shared/token-bot-controller.mjs');
  const entered = deferred();
  const started = deferred();
  let stops = 0;
  const controller = new TokenBotController({
    descriptor: { key: 'test', label: 'Test', connectionLabel: 'connection' },
    credentials: { ...credentials, async resolve() { return { value: 'synthetic-token' }; } },
    configStore: {
      list: () => [{ botId: 'bot', tokenRef: 'fixture' }],
      save() {},
      remove() {}
    },
    inspectToken() {},
    deriveIdentity() {},
    maskPlatformId() {},
    createRuntime: async () => ({
      async start() { entered.resolve(); await started.promise; },
      stop() {
        stops++;
        started.resolve();
        if (stops === 1) throw new Error('unconfirmed fixture close');
      }
    })
  });
  const initialization = controller.initialize();
  await entered.promise;
  await assert.rejects(controller.close(), { message: 'IM bot cleanup failed' });
  await initialization;
  assert.equal(stops, 1);
  await controller.close();
  assert.equal(stops, 2);
});
