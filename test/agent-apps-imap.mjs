import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-apps-imap-'));
const root = path.resolve(import.meta.dirname, '..');
const configs = [];
let service;
let mode = 'messages', verified = 0, closed = 0, smtpClosed = 0;
let mailboxUids = [1, 2];
const unsafe = 'EXAMINE Unsafe Login. Please contact kefu@188.com for help';
globalThis.__imapFixture = {
  ImapFlow: class extends EventEmitter {
    constructor(options) { super(); configs.push(options); }
    async connect() {}
    async mailboxOpen(mailbox, options) {
      assert.equal(mailbox, 'INBOX'); assert.equal(options.readOnly, true);
      if (mode === 'rejected') throw Object.assign(new Error('Command failed'), { responseText: unsafe });
      if (mode === 'false-open') return false;
      return { path: mailbox, uidValidity: mode === 'missing-validity' ? undefined : 123n, uidNext: ['missing-next', 'status-fallback', 'missing-next-search-failed'].includes(mode) ? undefined : mode === 'empty' ? 1 : 3 };
    }
    async status() { return mode === 'status-fallback' ? { uidValidity: 123n, uidNext: 3 } : false; }
    async search(query, options) { assert.equal(options.uid, true); assert.ok(query.all === true || typeof query.uid === 'string'); return ['false-search', 'missing-next-search-failed'].includes(mode) ? false : mailboxUids; }
    async fetchOne(uid, query) {
      if (mode === 'placeholders') return query.envelope
        ? { envelope: uid === '1' ? { messageId: 'm1' } : { subject: '无主题', messageId: 'm2' }, size: uid === '1' ? 3 * 1024 * 1024 : 100 }
        : { source: Buffer.from('Subject: literal\r\n\r\n邮件较大，正文未下载（上限 2 MB）') };
      return query.envelope ? { envelope: { subject: `mail ${uid}`, messageId: `m${uid}` }, size: 100 } : { source: Buffer.from(`Subject: mail ${uid}\r\n\r\nfixture body`) };
    }
    close() { closed++; }
  },
  createTransport: () => ({ verify: async () => { verified++; }, close: () => { smtpClosed++; } })
};
try {
  const outfile = path.join(folder, 'fixture.cjs');
  await build({ stdin: { contents: `
    export { createAppConnectors } from './src/main/agentApps/connectors';
    export { AgentAppsService } from './src/main/agentApps/service';
  `, resolveDir: root, loader: 'ts' }, outfile, platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent', plugins: [{
    name: 'mail-server-fixtures', setup(api) {
      api.onResolve({ filter: /^(imapflow|nodemailer)$/ }, args => ({ path: args.path, namespace: 'mail-fixture' }));
      api.onLoad({ filter: /.*/, namespace: 'mail-fixture' }, args => ({ contents: args.path === 'imapflow' ? 'export const ImapFlow = globalThis.__imapFixture.ImapFlow;' : 'export default { createTransport: globalThis.__imapFixture.createTransport };' }));
    }
  }] });
  const { createAppConnectors, AgentAppsService } = createRequire(import.meta.url)(outfile);
  const connectors = createAppConnectors(async () => { throw Error('unexpected CLI call'); });
  const account = { kind: 'imap-smtp', id: 'netease', name: 'fixture', address: 'test@163.com', user: 'test@163.com', imapHost: 'imap.163.com', imapPort: 993, imapTls: 'tls', smtpHost: 'smtp.163.com', smtpPort: 465, smtpTls: 'tls', mailbox: 'INBOX', enabled: true, grants: { mail: ['mail.read'] } };
  const secret = { password: 'fixture-app-password' };
  for (const host of ['imap.163.com', 'imap.126.com', 'imap.yeah.net']) {
    await connectors.test({ ...account, imapHost: host }, secret);
    assert.deepEqual(configs.at(-1).clientInfo, { name: 'muster-console', version: '0.1' }, 'both test and sync identify the workbench');
    assert.equal(configs.at(-1).secure, true); assert.equal(configs.at(-1).logger, false);
  }
  const initial = await connectors.sync(account, secret, {});
  assert.equal(initial.records.length, 2); assert.deepEqual(initial.cursor, { validity: '123', uid: 2 });
  mode = 'placeholders';
  const placeholderMail = await connectors.sync(account, secret, {});
  assert.deepEqual(placeholderMail.placeholderFields, [{ subject: 'mail-no-subject', body: 'mail-body-omitted' }, null]);
  assert.equal(placeholderMail.records[0].subject, placeholderMail.records[1].subject, 'real subjects can equal the host fallback');
  mode = 'messages';
  assert.equal(configs.at(-1).clientInfo.name, 'muster-console');
  await connectors.sync({ ...account, imapTls: 'starttls', imapPort: 143 }, secret, initial.cursor);
  assert.equal(configs.at(-1).doSTARTTLS, true);
  for (const scenario of ['rejected', 'false-open', 'missing-validity']) {
    mode = scenario;
    const beforeVerified = verified, beforeClosed = closed, beforeSmtpClosed = smtpClosed;
    await assert.rejects(connectors.sync(account, secret, {}), scenario === 'rejected' ? /Unsafe Login/ : /EXAMINE failed/);
    await assert.rejects(connectors.test(account, secret), /EXAMINE failed/);
    assert.equal(verified, beforeVerified, 'IMAP rejection must not reach SMTP verification');
    assert.equal(closed, beforeClosed + 2); assert.equal(smtpClosed, beforeSmtpClosed + 1);
  }
  mode = 'false-search';
  await assert.rejects(connectors.sync(account, secret, {}), /SEARCH failed/, 'SEARCH false must not masquerade as zero new mail');
  mode = 'status-fallback';
  assert.equal((await connectors.sync(account, secret, {})).records.length, 2, 'missing EXAMINE UIDNEXT is recovered with STATUS, not assumed empty');
  mode = 'missing-next';
  assert.deepEqual((await connectors.sync(account, secret, {})).cursor, { validity: '123', uid: 2 }, 'missing EXAMINE and STATUS UIDNEXT enumerates actual UIDs');
  assert.deepEqual(await connectors.sync(account, secret, { validity: '123', uid: 2 }), { records: [], cursor: { validity: '123', uid: 2 } }, 'UIDNEXT-less incremental sync preserves its cursor without duplicating old messages');
  mailboxUids = Array.from({ length: 100 }, (_, index) => index + 1);
  const recent = await connectors.sync(account, secret, {});
  assert.equal(recent.records.length, 50); assert.equal(recent.records[0].uid, '123:51'); assert.equal(recent.cursor.uid, 100);
  mailboxUids = [1, 2];
  mode = 'missing-next-search-failed';
  await assert.rejects(connectors.sync(account, secret, {}), /SEARCH failed/);
  mode = 'empty';
  assert.deepEqual(await connectors.sync(account, secret, {}), { records: [], cursor: { validity: '123', uid: 0 } }, 'a valid empty mailbox is still successful');
  service = new AgentAppsService({ root: path.join(folder, 'data'), workspaces: () => ['one'], emit() {}, connectors,
    encrypt: text => Buffer.from(text).toString('base64'), decrypt: text => Buffer.from(text, 'base64').toString(),
    confirmSend: async () => false, deliver: async () => ({ muted: true }) });
  service.saveConnection('one', { ...account, password: secret.password });
  const sync = () => service.execute('one', { appId: 'mail', commandId: 'sync', params: { accountId: account.id } }, { kind: 'agent', runId: 'fixture' });
  mode = 'messages'; assert.equal((await sync()).count, 2);
  const before = structuredClone(service.store.read('one').connections[0]);
  mode = 'rejected'; await assert.rejects(sync(), /Unsafe Login/);
  const failed = service.store.read('one');
  assert.deepEqual(failed.connections[0].cursors, before.cursors, 'failed sync never advances its cursor');
  assert.equal(failed.connections[0].lastSyncAt, before.lastSyncAt);
  assert.match(service.snapshot('one').connections[0].lastError, /Unsafe Login/);
  assert.equal(failed.operations.at(-1).phase, 'failed'); assert.equal(failed.records.mail.length, 2);
  mode = 'messages'; assert.equal((await sync()).count, 0);
  assert.equal(service.snapshot('one').connections[0].lastError, undefined, 'successful recovery clears the visible error');
  console.log('agent apps IMAP: client ID, EXAMINE/SEARCH failures, cursor preservation and error recovery passed');
} finally {
  service?.store.close?.();
  delete globalThis.__imapFixture;
  const resolved = path.resolve(folder); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
}
