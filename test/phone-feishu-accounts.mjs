import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
const root = path.resolve(import.meta.dirname, '..');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-feishu-accounts-'));
const target = path.join(folder, 'accounts.cjs');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async check => { for (let i = 0; i < 100 && !check(); i++) await new Promise(done => setTimeout(done, 2)); assert.ok(check(), 'bounded async condition'); };
try {
  buildSync({ stdin: { contents: "export * from './src/main/agentApps/feishuAccounts.ts'; export { applyLocaleSetting } from './src/shared/i18n/index.ts';", resolveDir: root, sourcefile: 'phone-accounts-test.ts' }, outfile: target, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { PhoneFeishuAccounts, phoneFeishuAppBound, phoneFeishuProfile, applyLocaleSetting } = createRequire(import.meta.url)(target);
  const first = phoneFeishuProfile('one'), second = phoneFeishuProfile('two');
  assert.match(first, /^muster-phone-[a-f0-9]{24}$/); assert.notEqual(first, second); assert.equal(first, phoneFeishuProfile('one'));
  const profileReads = [];
  const run = async (_args, options) => {
    profileReads.push(options.profile);
    return options.profile === 'metaagent' ? { code: 0, stdout: JSON.stringify({ available: true, appId: 'cli_dispatch' }), stderr: '' } : { code: 3, stdout: JSON.stringify({ ok: false, error: { subtype: 'not_configured' } }), stderr: '' };
  };
  assert.equal(await phoneFeishuAppBound(run, first), false, 'configured scheduler app must not connect the phone');
  assert.deepEqual(profileReads, [first]);
  assert.equal(await phoneFeishuAppBound(async () => ({ code: 0, stdout: '{"available":true}', stderr: '' }), first), false, 'CLI availability alone is not an app binding');
  const authResult = value => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
  await assert.rejects(phoneFeishuAppBound(async () => authResult({ appId: 'cli_phone', available: true }), first), /无法读取.*凭据/, 'a public app ID must not bypass missing host credentials');
  await assert.rejects(phoneFeishuAppBound(async () => authResult({ appId: 'cli_phone', identities: { bot: { available: false }, user: { available: true } } }), first), /无法读取.*凭据/, 'a user login cannot substitute for this phone robot');
  assert.equal(await phoneFeishuAppBound(async (args, options) => {
    assert.deepEqual(args, ['auth', 'status', '--json']); assert.equal(options.profile, first);
    return authResult({ appId: 'cli_phone', identities: { bot: { available: true } } });
  }, first), true);
  await assert.rejects(phoneFeishuAppBound(async () => ({ code: -2, stdout: '', stderr: '' }), first), /超时/);
  await assert.rejects(phoneFeishuAppBound(async () => ({ code: 2, stdout: '{"ok":false,"error":{"message":"密钥环未解锁"}}', stderr: '' }), first), /密钥环/);

  const bound = new Set(), events = [], attempts = [], probes = [];
  let qrWork = async () => 'data:image/png;base64,fixture';
  let emitUrl = true;
  const options = {
    available: () => true,
    probe: async profile => { probes.push(profile); return bound.has(profile); },
    start: (profile, onUrl) => {
      const result = deferred(), attempt = { profile, onUrl, finish: result.resolve, cancelled: 0 };
      attempts.push(attempt);
      if (emitUrl) queueMicrotask(() => onUrl(`https://open.feishu.cn/page/cli?attempt=${attempts.length}`));
      const cancel = () => { attempt.cancelled++; result.resolve({ ok: false, error: 'cancelled old attempt' }); };
      return { promise: result.promise, cancel, stopAndWait: async () => { cancel(); await result.promise; } };
    },
    qr: url => qrWork(url), emit: status => events.push(status), urlTimeoutMs: 30, authTimeoutMs: 2000
  };
  const accounts = new PhoneFeishuAccounts(options);
  assert.equal((await accounts.get('one')).appBound, false);
  assert.equal((await accounts.start('one')).ok, true);
  assert.equal(attempts[0].profile, first);
  assert.ok((await accounts.get('one')).onboarding.qrDataUrl);
  assert.equal((await accounts.start('one')).ok, false, 'double-click does not create two apps');
  assert.equal(attempts.length, 1);
  bound.add(first); attempts[0].finish({ ok: true });
  await until(() => events.some(event => event.workspaceId === 'one' && event.appBound && !event.onboarding));
  assert.equal((await accounts.get('two')).appBound, false);
  assert.equal((await new PhoneFeishuAccounts(options).get('one')).appBound, true, 'restart probes dedicated credentials');
  assert.ok(probes.every(profile => profile !== 'metaagent'));

  // Cancel while QR rendering is pending, immediately retry, then complete the stale render.
  const lateQr = deferred(); qrWork = () => lateQr.promise;
  const old = accounts.start('two'); await until(() => events.some(e => e.workspaceId === 'two' && e.onboarding));
  accounts.cancel('two'); qrWork = async () => 'new-qr';
  const next = await accounts.start('two'); assert.equal(next.qrDataUrl, 'new-qr');
  lateQr.resolve('old-qr'); assert.equal((await old).ok, false);
  assert.equal((await accounts.get('two')).onboarding.qrDataUrl, 'new-qr', 'stale cancellation/completion never overwrites the retry');
  assert.equal(attempts[1].cancelled, 1);
  attempts.at(-1).finish({ ok: true });
  await until(() => events.some(e => e.workspaceId === 'two' && /尚未保存/.test(e.lastError || '')));
  assert.equal((await accounts.get('two')).appBound, false, 'exit 0 without saved dedicated credentials is not success');

  emitUrl = false;
  const timeout = await accounts.start('timeout'); assert.equal(timeout.ok, false); assert.match(timeout.error, /二维码/);
  assert.equal(attempts.at(-1).cancelled, 1);
  const early = accounts.start('early'); await until(() => attempts.at(-1).profile === phoneFeishuProfile('early'));
  attempts.at(-1).finish({ ok: false, error: '网络不可用' }); assert.match((await early).error, /网络不可用/);
  emitUrl = true;
  await accounts.start('left'); await accounts.start('right'); accounts.cancel('left');
  assert.ok((await accounts.get('right')).onboarding, 'cancelling one workspace leaves the other scan alive');
  accounts.stop();
  assert.equal(attempts.at(-1).cancelled, 1);
  assert.ok(attempts.every(a => a.profile.startsWith('muster-phone-')));
  const unavailable = new PhoneFeishuAccounts({ ...options, available: () => false });
  assert.equal((await unavailable.get('missing')).cliReady, false);
  assert.match((await unavailable.start('missing')).error, /未安装/);
  try {
    applyLocaleSetting('en');
    assert.match((await unavailable.start('missing')).error, /Feishu component is not installed/i, 'host error follows UI locale');
    await assert.rejects(phoneFeishuAppBound(async () => ({ code: -2, stdout: '', stderr: '' }), first), /timed out/i);
  } finally { applyLocaleSetting('zh-CN'); }
  // Legacy explicit pairing remains compatible; normal setup no longer issues codes.
  const streams = [], saved = new Map(), received = [], receivedFields = [];
  const bindingOptions = { ...options, probe: async () => true,
    listen: (profile, onLine, onExit, onReady) => { const stream = { profile, onLine, onExit, onReady, stops: 0 }; streams.push(stream); return { stop: () => { stream.stops++; }, stopAndWait: async () => { stream.stops++; } }; },
    loadChats: ws => saved.get(ws) ?? [], saveChat: (ws, chat) => saved.set(ws, [...(saved.get(ws) ?? []), chat]),
    receive: (ws, values, _conversation, fields) => { received.push({ ws, values }); receivedFields.push(fields); }, botId: async () => 'ou_phone'
  };
  const pairing = new PhoneFeishuAccounts(bindingOptions);
  const initial = await pairing.beginBinding('one');
  assert.match(initial.binding.code, /^\d{6}$/);
  assert.equal(streams[0].profile, first);
  assert.equal(initial.binding.ready, false, 'do not show a usable code before the event consumer is ready');
  streams[0].onReady();
  assert.equal((await pairing.get('one')).binding.ready, true);
  assert.equal((await pairing.get('one')).binding.code, initial.binding.code, 'reopening must not silently replace the displayed code');
  const renewed = await pairing.beginBinding('one');
  assert.notEqual(renewed.binding.code, initial.binding.code);
  assert.equal(streams.length, 1, 'refresh changes the code without stopping/restarting the live daemon');
  const event = { message_id: 'om_pair', sender_id: 'ou_person', sender_type: 'user', chat_id: 'oc_private', chat_type: 'p2p', message_type: 'text', content: renewed.binding.code };
  for (const value of [null, [], { ...event, content: initial.binding.code }, { ...event, sender_type: 'bot' }, { ...event, chat_type: 'group' }, { ...event, message_type: 'post' }, { ...event, content: `message ${event.content}` }, { ...event, chat_id: 'invalid' }]) streams[0].onLine(JSON.stringify(value));
  assert.equal(saved.size, 0, 'invalid/old/group codes must not authorize chats');
  const other = await pairing.beginBinding('two');
  streams[1].onLine(JSON.stringify(event));
  assert.equal(saved.size, 0, 'another phone profile cannot consume this code');
  await until(() => received.length > 0); await new Promise(done => setTimeout(done, 5));
  const beforePairingMessages = received.length;
  streams[0].onLine(JSON.stringify(event)); streams[0].onLine(JSON.stringify(event));
  await until(() => saved.get('one')?.length === 1);
  assert.equal(saved.get('one').length, 1, 'the code is consumed once, including duplicate deliveries');
  assert.equal(received.length, beforePairingMessages, 'a redelivered pairing message must not become an inbox message after auto-connecting');
  assert.equal((await pairing.get('one')).binding, null);
  assert.equal((await pairing.get('one')).pairedChat.chatId, 'oc_private');
  assert.equal((await pairing.get('one')).pairedChat.namePlaceholder, 'feishu-paired', 'the host-generated pairing name carries provenance');
  let finishSave, delayedStream;
  const delayedPairing = new PhoneFeishuAccounts({ ...bindingOptions, saveChat: async () => new Promise(resolve => { finishSave = resolve; }), listen: (_profile, onLine, _onExit, onReady) => { delayedStream = { onLine, onReady }; return { stop() {}, stopAndWait: async () => {} }; } });
  const delayed = await delayedPairing.beginBinding('delayed'); delayedStream.onReady();
  delayedStream.onLine(JSON.stringify({ ...event, message_id: 'om_delayed', content: delayed.binding.code }));
  await until(() => typeof finishSave === 'function');
  assert.ok((await delayedPairing.get('delayed', false)).binding, 'pairing must remain pending until storage confirms');
  finishSave();
  await until(() => events.some(status => status.workspaceId === 'delayed' && status.pairedChat?.chatId === 'oc_private'));
  delayedPairing.stop();
  let failedSaveStream;
  const failedPairing = new PhoneFeishuAccounts({ ...bindingOptions, saveChat: async () => { throw new Error('storage unavailable'); }, listen: (_profile, onLine, _onExit, onReady) => { failedSaveStream = { onLine, onReady }; return { stop() {}, stopAndWait: async () => {} }; } });
  const failed = await failedPairing.beginBinding('failed-save'); failedSaveStream.onReady();
  failedSaveStream.onLine(JSON.stringify({ ...event, message_id: 'om_failed', content: failed.binding.code }));
  await until(() => events.some(status => status.workspaceId === 'failed-save' && /storage unavailable/.test(status.pairingError ?? '')));
  assert.equal((await failedPairing.get('failed-save', false)).pairedChat, undefined, 'failed storage cannot report pairing success');
  failedPairing.stop();
  const restored = new PhoneFeishuAccounts(bindingOptions);
  assert.equal((await restored.get('one', false)).binding, undefined, 'saved private chats do not need another first-use code');
  assert.ok((await pairing.get('two')).binding);
  streams[1].onExit(2, '缺少消息事件订阅');
  streams[1].onReady();
  assert.equal((await pairing.get('two')).binding.code, other.binding.code, 'a disconnect preserves the code until its original expiry');
  assert.equal((await pairing.get('two')).binding.ready, false);
  assert.match((await pairing.get('two')).pairingError, /缺少消息事件订阅/);
  assert.equal(streams.length, 2, 'reading status does not silently retry or erase a stream failure');
  const retried = await pairing.beginBinding('two'); assert.ok(retried.binding); assert.equal(streams.length, 3);
  streams[1].onLine(JSON.stringify({ ...event, content: retried.binding.code }));
  assert.equal(saved.has('two'), false, 'late events from the exited stream are ignored');
  const expiring = new PhoneFeishuAccounts({ ...bindingOptions, bindingTimeoutMs: 15 });
  const expiringCode = await expiring.beginBinding('expires'); const expiryStream = streams.at(-1);
  await new Promise(done => setTimeout(done, 25));
  expiryStream.onLine(JSON.stringify({ ...event, content: expiringCode.binding.code }));
  assert.equal(saved.has('expires'), false); assert.match((await expiring.get('expires')).pairingError, /过期/);
  pairing.stop(); expiring.stop(); restored.stop();
  assert.equal(streams[0].stops, 1); assert.equal(streams[2].stops, 1);
  streams[0].onLine(JSON.stringify(event)); assert.equal(saved.get('one').length, 1);
  const live = new PhoneFeishuAccounts(bindingOptions), receiving = live.ensureReceiving('live');
  await until(() => streams.at(-1).profile === phoneFeishuProfile('live'));
  const liveStream = streams.at(-1); liveStream.onReady(); await receiving;
  assert.equal((await live.get('live', false)).binding, undefined, 'receiving an existing account does not generate a pairing code');
  liveStream.onLine(JSON.stringify({ ...event, message_id: 'om_live', content: 'hello', create_time: '1792768000000' }));
  await until(() => received.at(-1)?.values.messageId === 'om_live');
  assert.deepEqual(received.at(-1), { ws: 'live', values: { messageId: 'om_live', chatId: 'oc_private', sender: '对方', body: 'hello', date: new Date(1792768000000).toISOString(), mine: false, status: 'received' } });
  assert.deepEqual(receivedFields.at(-1), { sender: 'message-peer' });
  liveStream.onLine(JSON.stringify({ ...event, message_id: 'om_real_name', sender_name: '对方', content: 'hello' }));
  await until(() => received.at(-1)?.values.messageId === 'om_real_name');
  assert.equal(receivedFields.at(-1), undefined, 'a real sender named like a fallback remains unmarked');
  live.stop();

  // The same code becomes usable after a transient failure; no user regeneration is needed.
  const recover = new PhoneFeishuAccounts({ ...bindingOptions, reconnectDelaysMs: [5] });
  const recovering = await recover.beginBinding('recover'), failedStream = streams.at(-1), beforeRetry = streams.length;
  failedStream.onExit(3, 'connection reset');
  await until(() => streams.length === beforeRetry + 1);
  const recoveredStream = streams.at(-1);
  failedStream.onReady();
  assert.equal((await recover.get('recover')).binding.ready, false, 'an old stream cannot mark the new stream ready');
  recoveredStream.onReady();
  const recovered = await recover.get('recover');
  assert.equal(recovered.binding.code, recovering.binding.code);
  assert.equal(recovered.binding.expiresAt, recovering.binding.expiresAt, 'reconnect never extends a pairing grant');
  assert.equal(recovered.binding.ready, true); assert.equal(recovered.pairingError, undefined);
  recoveredStream.onLine(JSON.stringify({ ...event, message_id: 'om_recover', content: recovering.binding.code }));
  await until(() => saved.get('recover')?.length === 1);
  assert.equal(saved.get('recover').length, 1, 'the original code pairs after reconnect');
  recoveredStream.onExit(3, 'offline again'); recover.stop();
  const stoppedCount = streams.length;
  await new Promise(done => setTimeout(done, 15));
  assert.equal(streams.length, stoppedCount, 'shutdown cancels pending reconnects');

  // Persistent failures are bounded, and receive callers wait through a successful retry.
  const bounded = new PhoneFeishuAccounts({ ...bindingOptions, reconnectDelaysMs: [5] });
  await bounded.get('bounded'); const firstFailure = streams.at(-1), boundedCount = streams.length;
  firstFailure.onExit(3, 'unavailable'); await until(() => streams.length === boundedCount + 1);
  streams.at(-1).onExit(3, 'unavailable');
  await new Promise(done => setTimeout(done, 15));
  assert.equal(streams.length, boundedCount + 1); assert.match((await bounded.get('bounded')).pairingError, /请重试连接/);
  bounded.stop();
  const expiredRetry = new PhoneFeishuAccounts({ ...bindingOptions, bindingTimeoutMs: 10, reconnectDelaysMs: [20] });
  const expiredOriginal = await expiredRetry.beginBinding('expired-retry'), expiryRetryCount = streams.length;
  streams.at(-1).onExit(3, 'temporary disconnect');
  await until(() => streams.length === expiryRetryCount + 1);
  streams.at(-1).onReady();
  const expiredRecovered = await expiredRetry.get('expired-retry');
  assert.equal(expiredRecovered.binding, null); assert.match(expiredRecovered.pairingError, /过期/, 'reconnect must not erase expiry or silently mint a new code');
  streams.at(-1).onLine(JSON.stringify({ ...event, message_id: 'om_expired', content: expiredOriginal.binding.code }));
  assert.equal(saved.has('expired-retry'), false); expiredRetry.stop();
  const resume = new PhoneFeishuAccounts({ ...bindingOptions, reconnectDelaysMs: [5] });
  const pendingReceive = resume.ensureReceiving('resume');
  await until(() => streams.at(-1).profile === phoneFeishuProfile('resume'));
  const resumeCount = streams.length; streams.at(-1).onExit(3, 'temporary disconnect');
  await until(() => streams.length === resumeCount + 1); streams.at(-1).onReady(); await pendingReceive;
  resume.stop();
  // A fresh configured robot receives its first private chat without a binding code,
  // and group discovery checks the bot's exact open_id, not merely any @ mention.
  const automaticMessages = [], identities = [];
  const automatic = new PhoneFeishuAccounts({ ...bindingOptions,
    botId: async profile => { identities.push(profile); return 'ou_phone'; },
    receive: (ws, values, conversation) => automaticMessages.push({ ws, values, conversation })
  });
  const connected = await automatic.get('automatic'), automaticStream = streams.at(-1);
  assert.equal(connected.binding, undefined); assert.equal(connected.pairedChat, undefined);
  automaticStream.onReady(); assert.equal((await automatic.get('automatic')).receiving, true);
  automaticStream.onLine(JSON.stringify({ ...event, message_id: 'om_first', content: '不需要授权码' }));
  automaticStream.onLine(JSON.stringify({ ...event, message_id: 'om_quiet_group', chat_type: 'group' }));
  automaticStream.onLine(JSON.stringify({ ...event, message_id: 'om_other_mention', chat_type: 'group', mentions: [{ id: 'ou_other' }] }));
  automaticStream.onLine(JSON.stringify({ ...event, message_id: 'om_our_mention', chat_type: 'group', mentions: [{ id: 'ou_phone' }], content: '@手机 你好' }));
  await until(() => automaticMessages.length === 2);
  assert.deepEqual(automaticMessages.map(m => m.values.messageId), ['om_first', 'om_our_mention']);
  assert.equal(automaticMessages[0].conversation.type, 'p2p'); assert.equal(automaticMessages[1].conversation.mentionedBot, true);
  assert.deepEqual(identities, [phoneFeishuProfile('automatic')], 'bot identity is profile-specific and cached');
  assert.equal(saved.has('automatic'), false, 'normal incoming messages never use the pairing path');
  automatic.stop(); automaticStream.onLine(JSON.stringify({ ...event, message_id: 'om_after_stop' }));
  await new Promise(done => setTimeout(done, 5)); assert.equal(automaticMessages.length, 2);
  const acceptedRemote = [], acceptedInbox = [];
  const multiplexed = new PhoneFeishuAccounts({ ...bindingOptions, reconnectDelaysMs: [],
    receiveRemote: async (ws, input) => { acceptedRemote.push({ ws, input }); return input.text === '/status'; },
    receive: (ws, values) => acceptedInbox.push({ ws, values })
  });
  await multiplexed.get('multiplexed');
  const sharedStream = streams.at(-1); sharedStream.onReady();
  assert.equal(multiplexed.isReceiving('multiplexed'), true);
  sharedStream.onLine(JSON.stringify({ ...event, message_id: 'om_wrong_at', chat_type: 'group', mentions: [{ id: 'ou_other' }], content: '/status' }));
  sharedStream.onLine(JSON.stringify({ ...event, message_id: 'om_command', chat_type: 'group', mentions: [{ id: 'ou_phone', key: '@_user_1', name: 'Phone' }], content: '@_user_1 /status' }));
  sharedStream.onLine(JSON.stringify({ ...event, message_id: 'om_normal', content: 'Normal inbox' }));
  await until(() => acceptedInbox.length === 1);
  assert.deepEqual(acceptedRemote.map(({ ws, input }) => [ws, input.messageId, input.text]), [['multiplexed', 'om_command', '/status'], ['multiplexed', 'om_normal', 'Normal inbox']]);
  assert.equal(acceptedRemote[0].input.senderId, 'ou_person');
  assert.equal(acceptedRemote[0].input.conversationId, 'oc_private');
  assert.equal(acceptedInbox[0].values.messageId, 'om_normal', 'the remote command did not also enter the old inbox');
  sharedStream.onExit(3, 'disconnected');
  assert.equal(multiplexed.isReceiving('multiplexed'), false);
  assert.equal(acceptedRemote[0].input.signal.aborted, true);
  await multiplexed.stopAndWait();
  const identityLookup = deferred(), queuedMessages = [];
  const queued = new PhoneFeishuAccounts({ ...bindingOptions, reconnectDelaysMs: [],
    botId: () => identityLookup.promise, receive: (_ws, values) => queuedMessages.push(values)
  });
  await queued.get('queued'); const queuedStream = streams.at(-1);
  queuedStream.onLine(JSON.stringify({ ...event, message_id: 'om_before_disconnect', chat_type: 'group', mentions: [{ id: 'ou_phone' }] }));
  queuedStream.onExit(3, 'disconnected after delivery');
  identityLookup.resolve('ou_phone');
  await until(() => queuedMessages.length === 1);
  assert.equal(queuedMessages[0].messageId, 'om_before_disconnect', 'disconnect must not discard an event already accepted before bot identity resolved');
  queued.stop();
  const released = deferred();
  const retained = new PhoneFeishuAccounts({ ...bindingOptions,
    listen: () => ({ stop() {}, stopAndWait: () => released.promise }) });
  await retained.get('retained');
  let drained = false;
  const draining = retained.stopAndWait().then(() => { drained = true; });
  await new Promise(done => setImmediate(done));
  assert.equal(drained, false, 'phone shutdown retains a stream until its process close');
  await assert.rejects(retained.get('late'), /stopping/, 'closed account owner cannot create a new receiver');
  released.resolve(); await draining;
  let attemptsToClose = 0;
  const retryClose = new PhoneFeishuAccounts({ ...bindingOptions,
    listen: () => ({ stop() {}, stopAndWait: async () => { if (++attemptsToClose === 1) throw Error('fixture daemon stop denied'); } }) });
  await retryClose.get('retry-close');
  await assert.rejects(retryClose.stopAndWait(), /Phone Feishu shutdown failed/);
  await retryClose.stopAndWait();
  assert.equal(attemptsToClose, 2, 'failed stream owner is retained and a successful retry clears its error');
  console.log('phone-feishu-accounts: dedicated profiles, saved-auth proof, cancellation, retry, timeout, workspace isolation and stream drain passed');
} finally {
  const resolved = path.resolve(folder); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(resolved, { recursive: true, force: true });
}
