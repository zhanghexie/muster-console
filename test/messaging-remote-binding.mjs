import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-remote-pairing-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
const { RemoteBindingService } = await import(pathToFileURL(compile('main/messaging/remoteBindingService.ts')).href);
let sequence = 0;
function input(overrides = {}) {
  return { channelKey: 'weixin', botId: 'test-bot', conversationId: 'private-user', senderId: 'user',
    conversationType: 'direct', addressed: true, senderIsBot: false, messageId: `m-${++sequence}`, text: '接入', ...overrides };
}
function fixture(dispatch, releaseAuthorization) {
  const file = path.join(fs.mkdtempSync(path.join(temp, 'case-')), 'bindings.json');
  const calls = [];
  let now = 1_800_000_000_000;
  const service = new RemoteBindingService({ file, now: () => now, releaseAuthorization, dispatch: dispatch ?? (async event => {
    calls.push(event); return { text: 'workbench-answer' };
  }) });
  return { file, service, calls, advance: amount => { now += amount; } };
}
function begin(service, channel = 'weixin', botId = 'test-bot') {
  const response = service.manage(channel, 'remote.begin', { botId });
  assert.equal(response.ok, true);
  assert.match(response.value.binding.code, /^\d{6}$/);
  return response.value.binding.code;
}
async function pair(service, overrides = {}) {
  const message = input(overrides);
  const code = begin(service, message.channelKey, message.botId);
  const result = await service.handle({ ...message, text: `接入 ${code}` });
  assert.match(result.text, /绑定成功/);
  return message;
}

test('connected WeChat first message gives onboarding, pair persists, then uses the existing workbench', async () => {
  const { service, file, calls } = fixture();
  assert.match((await service.handle(input())).text, /设置 → Channels.*添加此聊天为来源.*设置 → 远程访问 → 远程输入.*启用远程输入.*生成绑定码/);
  assert.equal(calls.length, 0, 'transport login alone grants no workbench authority');
  assert.equal(fs.existsSync(file), false);
  await pair(service);
  const status = service.manage('weixin', 'remote.status', { botId: 'test-bot' }).value;
  assert.equal(status.ready, true);
  assert.equal(status.binding, null);
  assert.equal(status.boundUsers.length, 1);
  const event = input({ text: '列出当前工作区' });
  assert.equal((await service.handle(event)).text, 'workbench-answer');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, event.text);
  assert.equal((await service.handle(event)).text, '', 'transport retries cannot execute twice');
  assert.equal(calls.length, 1);
  const reopened = new RemoteBindingService({ file, dispatch: async () => ({ text: 'restored-answer' }) });
  assert.equal((await reopened.handle(input({ text: '状态' }))).text, 'restored-answer');
  assert.equal(fs.readFileSync(file, 'utf8').includes('expiresAt'), false, 'codes are not persisted');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('global source pairing persists access without persisting a target or admitting siblings', async () => {
  const { service, file, calls } = fixture();
  const source = { provider: 'weixin', botId: 'test-bot', conversationId: 'private-user', conversationType: 'direct' };
  const scope = { id: 'global-source-grant', source };
  const code = service.manageScope(scope, 'remote.begin').binding.code;
  const paired = await service.handle(input({ text: code }), scope);
  assert.match(paired.text, /绑定成功.*\/ws.*\/s.*\/bind.*\/unbind/);
  const status = service.manageScope(scope, 'remote.status');
  const bindingId = status.boundUsers[0].id;
  assert.equal(status.binding, null);
  assert.equal(service.intent(input({ text: '/ws 2' }), scope), 'control');
  assert.equal(service.intent(input({ text: '/ws 2', senderId: 'other-user' }), scope), 'none');
  assert.equal(service.intent(input({ text: '/ws 2', threadId: 'other-thread' }), scope), 'none');
  assert.equal(service.intent(input({ text: '/ws 2' }), { ...scope, id: 'another-grant' }), 'none');
  assert.equal((await service.handle(input({ text: '/ws 2' }), scope)).text, 'workbench-answer');
  assert.equal(calls[0].authorizationId, bindingId);
  const [saved] = JSON.parse(fs.readFileSync(file, 'utf8')).bindings;
  assert.equal(saved.scopeId, scope.id);
  assert.equal(saved.target, undefined);
  assert.equal(saved.workspaceId, undefined);
  const released = [];
  const reopened = new RemoteBindingService({ file, dispatch: async event => ({ text: event.authorizationId }),
    releaseAuthorization: id => released.push(id) });
  assert.deepEqual(await reopened.handle(input({ text: '恢复授权后读取帮助' }), scope), { text: bindingId });
  reopened.revokeScope(scope);
  assert.deepEqual(released, [bindingId]);
  assert.equal(reopened.intent(input({ text: '/ws 2' }), scope), 'none');
});

test('a failed revocation write cancels pending work while retaining the live authorization route', async () => {
  const scope = { id: 'durable-grant', source: { provider: 'weixin', botId: 'test-bot', conversationId: 'private-user', conversationType: 'direct' } };
  const accepted = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const released = [];
  const { file, service } = fixture(async event => {
    accepted.resolve(event.signal);
    await finish.promise;
    return { text: 'late result' };
  }, id => released.push(id));
  const code = service.manageScope(scope, 'remote.begin').binding.code;
  await service.handle(input({ text: code }), scope);
  const running = service.handle(input({ text: 'existing request' }), scope);
  const signal = await accepted.promise;
  try {
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    assert.throws(() => service.revokeScope(scope));
    assert.equal(signal.aborted, true);
    assert.deepEqual(released, []);
    assert.equal(service.manageScope(scope, 'remote.status').ready, true);
  } finally { finish.resolve(); }
  assert.deepEqual(await running, { text: '' });
});

test('authorization is exact to account, sender, conversation, thread and group mention', async () => {
  const { service, calls } = fixture();
  await pair(service);
  for (const overrides of [
    { channelKey: 'telegram' }, { botId: 'different-bot' }, { senderId: 'stranger' },
    { conversationId: 'public-group', conversationType: 'group' }, { threadId: 'another-thread' }
  ]) assert.match((await service.handle(input({ text: 'read secrets', ...overrides }))).text, /尚未绑定/);
  assert.equal(calls.length, 0);
  const code = begin(service);
  assert.equal((await service.handle(input({ text: code, senderIsBot: true }))).text, '');
  assert.equal((await service.handle(input({ text: code, conversationType: 'group', addressed: false }))).text, '');
  assert.equal(service.manage('weixin', 'remote.status', { botId: 'test-bot' }).value.binding.code, code);
});

test('codes expire, rotate, cannot cross bots, are single use and stop guessing after ten failures', async () => {
  const { service, advance, calls } = fixture();
  const old = begin(service);
  advance(600_001);
  assert.match((await service.handle(input({ text: old }))).text, /已失效/);
  let next = begin(service);
  while (next === old) next = begin(service);
  advance(60_001);
  assert.match((await service.handle(input({ text: old }))).text, /不正确/);
  assert.match((await service.handle(input({ botId: 'other-bot', text: next }))).text, /失效/);
  assert.match((await service.handle(input({ text: next }))).text, /绑定成功/);
  assert.match((await service.handle(input({ senderId: 'stranger', text: next }))).text, /失效/);
  const valid = begin(service);
  const wrong = valid === '000000' ? '000001' : '000000';
  for (let n = 0; n < 10; n++) await service.handle(input({ senderId: 'attacker', text: wrong }));
  assert.equal(service.manage('weixin', 'remote.status', { botId: 'test-bot' }).value.binding, null);
  assert.equal(calls.length, 0);
});

test('revoking a user cancels their pending turn and cannot deliver its late answer', async () => {
  let entered, release, signal;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const { service } = fixture(async event => { signal = event.signal; entered(); await waiting; return { text: 'private-late-answer' }; });
  await pair(service);
  const running = service.handle(input({ text: 'run long task' }));
  await started;
  const bindingId = service.manage('weixin', 'remote.status', { botId: 'test-bot' }).value.boundUsers[0].id;
  assert.equal(service.manage('telegram', 'remote.revoke', { botId: 'test-bot', bindingId }).ok, false);
  assert.equal(signal.aborted, false);
  assert.equal(service.manage('weixin', 'remote.revoke', { botId: 'test-bot', bindingId }).ok, true);
  assert.equal(signal.aborted, true);
  release();
  assert.equal((await running).text, '');
  assert.match((await service.handle(input({ text: 'next' }))).text, /尚未绑定/);
});

test('removing an account removes persisted grants and outstanding pairing codes', async () => {
  const { service, file } = fixture();
  await pair(service);
  begin(service);
  service.revokeAccount('weixin', 'test-bot');
  assert.equal(service.manage('weixin', 'remote.status', { botId: 'test-bot' }).value.ready, false);
  assert.equal(service.manage('weixin', 'remote.status', { botId: 'test-bot' }).value.binding, null);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).bindings.length, 0);
});

test('only existing desktop-managed accounts can issue binding codes; cancellation is rechecked after snapshot', async () => {
  const { service } = fixture();
  const signal = new AbortController();
  const call = snapshot => service.manageAccount('weixin', 'remote.begin', { botId: 'test-bot' }, signal.signal, snapshot);
  assert.equal((await call(async () => ({ ok: true, value: { bots: [] } }))).ok, false);
  assert.equal((await call(async () => ({ ok: false }))).ok, false);
  assert.equal((await call(async () => ({ ok: true, value: { bots: [{ botId: 'test-bot' }] } }))).ok, true);
  assert.equal((await call(async () => {
    signal.abort(); return { ok: true, value: { bots: [{ botId: 'test-bot' }] } };
  })).error.code, 'cancelled');
});

test('corrupt or unwritable binding storage does not grant, overwrite or pretend success', async () => {
  for (const contents of ['{broken', '{"version":2,"bindings":[]}']) {
    const { service, file, calls } = fixture();
    fs.writeFileSync(file, contents);
    assert.equal(service.manage('weixin', 'remote.begin', { botId: 'test-bot' }).ok, false);
    assert.match((await service.handle(input())).text, /无法读取或保存/);
    assert.equal(fs.readFileSync(file, 'utf8'), contents);
    assert.equal(calls.length, 0);
  }
  const { service, file } = fixture();
  const code = begin(service);
  fs.mkdirSync(file);
  assert.match((await service.handle(input({ text: code }))).text, /无法读取或保存/);
  assert.equal(service.manage('weixin', 'remote.status', { botId: 'test-bot' }).value.ready, false);
});

test('email From headers never grant authority and shutdown stops admission', async () => {
  const { service, calls } = fixture();
  const denied = service.manage('email', 'remote.begin', { botId: 'test-bot' }).error;
  assert.equal(denied.code, 'remote-sender-unverifiable');
  assert.match(denied.message, /Channels 收件和回复.*无法证明操作者身份/);
  assert.equal((await service.handle(input({ channelKey: 'email' }))).text, denied.message);
  await pair(service);
  service.stopAdmission();
  assert.equal((await service.handle(input())).text, '');
  assert.equal(service.manage('weixin', 'remote.begin', { botId: 'test-bot' }).error.code, 'cancelled');
  assert.equal(calls.length, 0);
});

test('durable admission prevents repeated commands and PTY tasks after host restart', async () => {
  const { service, file, calls } = fixture();
  const pairing = await pair(service);
  const command = input({ text: '/new' });
  const task = input({ text: 'write the terminal command' });
  await service.handle(command);
  await service.handle(task);
  assert.equal(calls.length, 2);
  const reopened = new RemoteBindingService({ file, dispatch: async () => assert.fail('durable receipt must stop replay') });
  for (const event of [command, task, pairing]) assert.match((await reopened.handle(event)).text, /此前已受理/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).receipts.length, 3);
});

test('revocation remains effective throughout final delivery and progress has the authorization signal', async () => {
  let entered, release, deliverySignal, progressSignal;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const { service } = fixture(async event => {
    await event.onProgress('received');
    return { text: 'result', image: { filePath: '/synthetic/terminal.png', mimeType: 'image/png' } };
  });
  await pair(service);
  const sent = [];
  const request = service.handle(input({ text: 'terminal task',
    async onProgress(text, signal) { progressSignal = signal; sent.push(text); },
    async deliver(result, signal) {
      deliverySignal = signal;
      sent.push(result.text);
      entered();
      await pending;
      if (!signal.aborted) sent.push(result.image.filePath);
    }
  }));
  await started;
  const bindingId = service.manage('weixin', 'remote.status', { botId: 'test-bot' }).value.boundUsers[0].id;
  assert.equal(service.manage('weixin', 'remote.revoke', { botId: 'test-bot', bindingId }).ok, true);
  assert.equal(deliverySignal.aborted, true);
  assert.equal(progressSignal, deliverySignal);
  release();
  assert.equal((await request).text, '');
  assert.deepEqual(sent, ['received', 'result']);
});

test('re-pairing creates a new host route owner rather than inheriting a former terminal binding', async () => {
  const { service, calls } = fixture();
  await pair(service);
  await service.handle(input({ text: '/bind 2' }));
  const bindingId = service.manage('weixin', 'remote.status', { botId: 'test-bot' }).value.boundUsers[0].id;
  assert.equal(calls[0].authorizationId, bindingId);
  service.manage('weixin', 'remote.revoke', { botId: 'test-bot', bindingId });
  await pair(service);
  await service.handle(input({ text: 'new work' }));
  assert.notEqual(calls[1].authorizationId, calls[0].authorizationId);
});
