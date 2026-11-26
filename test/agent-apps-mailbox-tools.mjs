import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-apps-mailbox-'));
const services = [];
try {
  const outfile = path.join(folder, 'fixture.cjs');
  buildSync({ stdin: { contents: `
    export { agentAppsHost } from './src/main/capabilities/hosts/agentApps';
    export { AGENT_APP_TOOL_DEFS } from './src/main/capabilities/catalog/agentApps';
    export { runAsAgentWorkspace, runAsSchedulerTool } from './src/main/agent/agentScope';
    export { AgentAppsService } from './src/main/agentApps/service';
    export { prepareMailboxConnection } from './src/main/agentApps/mailboxConfiguration';
    export { applyLocaleSetting } from './src/shared/i18n';
  `, resolveDir: root, loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { agentAppsHost, AGENT_APP_TOOL_DEFS, runAsAgentWorkspace, runAsSchedulerTool, AgentAppsService, prepareMailboxConnection, applyLocaleSetting } = createRequire(import.meta.url)(outfile);
  const createService = options => { const service = new AgentAppsService(options); services.push(service); return service; };
  const actions = AGENT_APP_TOOL_DEFS[0].parameters.properties.action.enum;
  assert.ok(actions.includes('saveMailbox') && actions.includes('testMailbox'), 'actions must be discoverable');
  let tests = 0, sends = 0, confirms = 0, testedSecret, failedTest = false;
  const options = {
    root: path.join(folder, 'data'), workspaces: () => ['one', 'two'], emit() {},
    encrypt: value => `cipher:${Buffer.from(value).toString('base64')}`,
    decrypt: value => Buffer.from(value.slice(7), 'base64').toString(),
    confirmSend: async () => { confirms++; return false; }, deliver: async () => ({}),
    connectors: {
      test: async (connection, secret) => { tests++; testedSecret = secret; assert.equal(connection.kind, 'imap-smtp'); if (failedTest) throw Error('IMAP authentication failed'); },
      send: async () => { sends++; throw Error('unexpected send'); }
    }
  };
  let service = createService(options);
  let reviewAllowed = true, reviewed = [], duringReview;
  const safety = { authorize: async operation => { reviewed.push(operation); if (duringReview) { const run = duringReview; duringReview = undefined; run(); } return { allowed: reviewAllowed, requestId: 'test-review', risk: 'high', reason: reviewAllowed ? 'allowed' : 'denied' }; } };
  let confirmation;
  const ui = { confirm: async (...args) => { confirmation = args; return { confirmed: false }; } };
  const invoke = (args, ws = 'one') => runAsAgentWorkspace(ws, () => runAsSchedulerTool(async () => agentAppsHost['apps.run']({ agentApps: service, safety, ui }, args)));
  const save = params => invoke({ action: 'saveMailbox', params });
  const base = { id: 'ai-mail', address: 'ai@example.com', imapHost: 'imap.example.com', smtpHost: 'smtp.example.com', password: 'fixture-imap-secret' };
  assert.throws(() => agentAppsHost['apps.run']({ agentApps: service }, { action: 'saveMailbox', params: base }), /bound scheduler/);
  await assert.rejects(runAsAgentWorkspace('one', async () => agentAppsHost['apps.run']({ agentApps: service }, { action: 'saveMailbox', params: base })), /bound scheduler/);
  await assert.rejects(invoke({ action: 'saveMailbox', params: base }, 'missing'), /workspace is unavailable/);
  await assert.rejects(save({ ...base, workspaceId: 'two' }), /Unknown mailbox parameter/);
  await assert.rejects(save({ ...base, encryptedSecret: 'fake' }), /Unknown mailbox parameter/);
  await assert.rejects(save({ ...base, password: undefined }), /password.*required/);
  await assert.rejects(save({ ...base, imapHost: undefined }), /imapHost is required/);
  await assert.rejects(save({ ...base, imapPort: '993' }), /integer/);
  await assert.rejects(save({ ...base, smtpPort: 0 }), /Invalid server port/);
  await assert.rejects(save({ ...base, smtpTls: 'none' }), /TLS/);
  await assert.rejects(save({ ...base, enabled: 'false' }), /boolean/);
  await assert.rejects(save({ ...base, grants: { mail: ['messages.send'] } }), /mail.read/);
  await assert.rejects(save({ ...base, grants: { tasks: ['mail.read'] } }), /Invalid account grant/);
  reviewAllowed = false;
  const reviewsBeforeDenied = reviewed.length;
  await assert.rejects(save(base), /denied/);
  assert.equal(reviewed.length, reviewsBeforeDenied + 1);
  assert.equal(service.snapshot('one').connections.length, 0, 'denied configuration has no connection or jobs');
  assert.equal(service.store.read('one').jobs.length, 0);
  reviewAllowed = true;
  const beforeCreateReview = reviewed.length;
  const created = await save(base);
  assert.equal(reviewed.length, beforeCreateReview + 1);
  assert.equal(reviewed.at(-1).action, 'apps.saveMailbox');
  assert.equal(reviewed.at(-1).dangerous, true);
  const signal = new AbortController().signal;
  applyLocaleSetting('en');
  try {
    assert.equal(await reviewed.at(-1).humanConfirm('审批代理需要人工确认：原始理由', signal), false);
    assert.deepEqual(confirmation, ['Configure mailbox connection', 'The approval agent requires human confirmation: 原始理由', { dangerous: true, signal }]);
  } finally { applyLocaleSetting('zh-CN'); }
  assert.equal(created.revision, 1);
  assert.equal(created.name, base.address); assert.equal(created.user, base.address);
  assert.equal(created.imapPort, 993); assert.equal(created.smtpPort, 465);
  assert.equal(created.mailbox, 'INBOX'); assert.equal(created.notify, 'wake');
  assert.equal(created.enabled, true); assert.deepEqual(created.grants, { mail: ['mail.read'] });
  assert.equal(service.store.read('one').jobs[0].enabled, true);
  assert.equal(service.snapshot('two').connections.length, 0);
  assert.deepEqual(await invoke({ action: 'testMailbox', params: { id: base.id } }), { ok: true });
  assert.equal(testedSecret.password, base.password); assert.equal(tests, 1); assert.equal(sends, 0);
  await assert.rejects(invoke({ action: 'testMailbox', params: { id: base.id } }, 'two'), /not found/);
  await assert.rejects(save({ id: base.id, name: 'stale' }), /expectedRevision/);
  await assert.rejects(save({ id: base.id, expectedRevision: 2, name: 'stale' }), /changed/);
  await assert.rejects(save({ id: base.id, expectedRevision: 1, user: 'another@example.com' }), /连接目标不能更换/);
  await assert.rejects(save({ id: 'deleted-mail', expectedRevision: 1 }), /not found/);
  const beforeGrantReview = reviewed.length;
  const changed = await save({ id: base.id, expectedRevision: 1, smtpPassword: 'fixture-smtp-secret', smtpTls: 'starttls', smtpPort: 587, grants: { mail: ['mail.read', 'mail.send'] } });
  assert.equal(reviewed.length, beforeGrantReview + 1, 'one combined credential and grant change is reviewed once');
  assert.equal(changed.revision, 2); assert.equal(changed.imapHost, base.imapHost);
  await invoke({ action: 'testMailbox', params: { id: base.id } });
  assert.deepEqual(testedSecret, { password: base.password, smtpPassword: 'fixture-smtp-secret' }, 'SMTP-only credential update preserves IMAP');
  await save({ id: base.id, expectedRevision: 2, password: 'replacement-imap-secret' });
  await invoke({ action: 'testMailbox', params: { id: base.id } });
  assert.deepEqual(testedSecret, { password: 'replacement-imap-secret', smtpPassword: 'fixture-smtp-secret' }, 'IMAP update preserves a separate SMTP password');
  // Compatibility safety callback fixture denies this send; account grants never replace the send gate.
  const draft = await invoke({ action: 'call', appId: 'mail', commandId: 'create', params: { values: { accountId: base.id, to: 'other@example.com', subject: 'test', body: 'test' } } });
  await assert.rejects(invoke({ action: 'call', appId: 'mail', commandId: 'send', params: { id: draft.record.id, expectedRevision: draft.record.revision }, requestId: 'mailbox-tool-test' }), /cancelled/);
  assert.equal(confirms, 1); assert.equal(sends, 0);
  const beforePreferenceChange = reviewed.length;
  const disabled = await save({ id: base.id, expectedRevision: 3, enabled: false, notify: 'mute' });
  assert.equal(reviewed.length, beforePreferenceChange, 'routine disable/notification preference does not invoke reviewer');
  assert.deepEqual(disabled.grants, changed.grants); assert.equal(disabled.revision, 4);
  assert.equal(service.store.read('one').jobs[0].enabled, false);
  service = createService(options);
  assert.equal(service.snapshot('one').connections[0].enabled, false, 'configuration survives restart');
  failedTest = true;
  await assert.rejects(invoke({ action: 'testMailbox', params: { id: base.id } }), /authentication failed/);
  assert.equal(service.snapshot('one').connections[0].lastError, 'IMAP authentication failed');
  failedTest = false; await invoke({ action: 'testMailbox', params: { id: base.id } });
  assert.equal(service.snapshot('one').connections[0].lastError, undefined);
  const listed = JSON.stringify(await invoke({ action: 'list' }));
  assert.ok(!/secret|cipher:|encryptedSecret|passwordEnv/.test(listed), 'public results and operation history contain no credentials');
  for (const file of fs.readdirSync(options.root)) assert.ok(!/fixture-imap-secret|replacement-imap-secret|fixture-smtp-secret/.test(fs.readFileSync(path.join(options.root, file), 'utf8')), 'app storage contains encrypted credentials only');
  service.saveConnection('one', { kind: 'feishu', id: 'chat', name: 'chat', chatId: 'oc_fixture', identity: 'user', enabled: false, grants: {} });
  await assert.rejects(save({ id: 'chat', expectedRevision: 1 }), /not an IMAP/);
  await assert.rejects(invoke({ action: 'testMailbox', params: { id: 'chat' } }), /not found/);
  // The reviewed target cannot change while the independent reviewer runs.
  const raceBase = { ...base, id: 'raced-mail' };
  duringReview = () => service.saveConnection('one', prepareMailboxConnection(raceBase, service.snapshot('one').connections));
  await assert.rejects(save(raceBase), /changed during safety review/);
  const raceExisting = service.snapshot('one').connections.find(c => c.id === 'raced-mail');
  assert.equal(raceExisting.revision, 1, 'new-id race does not overwrite another creator');
  duringReview = () => service.saveConnection('one', prepareMailboxConnection({ id: raceBase.id, expectedRevision: 1, name: 'Concurrent rename' }, service.snapshot('one').connections));
  await assert.rejects(save({ id: raceBase.id, expectedRevision: 1, password: 'another-secret' }), /changed during safety review/);
  assert.equal(service.snapshot('one').connections.find(c => c.id === raceBase.id).name, 'Concurrent rename');
  duringReview = () => service.store.transact('one', state => {
    const connection = state.connections.find(c => c.id === raceBase.id);
    connection.lastSyncAt = Date.now(); connection.lastError = 'Temporary network failure';
  });
  const afterBackgroundSync = await save({ id: raceBase.id, expectedRevision: 2, password: 'reviewed-secret' });
  assert.equal(afterBackgroundSync.revision, 3, 'unrelated background synchronization status does not invalidate reviewed configuration');
  // Environment references work on every platform and keep the secret out of tool arguments.
  const envParams = { ...base, password: undefined, passwordEnv: 'APP_TEST_MAIL_PASSWORD', smtpTls: 'starttls', imapTls: 'starttls' };
  const prepared = prepareMailboxConnection(envParams, [], { APP_TEST_MAIL_PASSWORD: 'env-fixture-secret' });
  assert.equal(prepared.password, 'env-fixture-secret'); assert.equal(prepared.passwordEnv, undefined);
  assert.equal(prepared.imapPort, 143); assert.equal(prepared.smtpPort, 587);
  assert.throws(() => prepareMailboxConnection(envParams, [], {}), /not set/);
  assert.throws(() => prepareMailboxConnection({ ...envParams, password: 'literal' }, [], {}), /either/);
  assert.throws(() => prepareMailboxConnection({ ...envParams, passwordEnv: 'bad-name' }, [], {}), /Invalid/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(runAsAgentWorkspace('one', () => runAsSchedulerTool(async () => agentAppsHost['apps.run']({ agentApps: service }, { action: 'saveMailbox', params: base }, { signal: aborted.signal }))), /abort/i);
  console.log('agent apps mailbox tools: passed');
} finally {
  for (const service of services) service.store.close?.();
  fs.rmSync(folder, { recursive: true, force: true });
}
