import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { build, buildSync } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const mailbox = { kind: 'imap-smtp', id: 'inbox', name: 'Earlier mail', imapHost: 'IMAP.Example.test.', imapPort: 993, imapTls: 'tls',
  address: 'fixture@example.test', user: 'ExactLogin', mailbox: 'inbox', smtpHost: 'smtp.example.test', smtpPort: 465, smtpTls: 'tls',
  password: 'fixture-password', enabled: true, grants: { mail: ['mail.read'] } };
const equivalent = { imapHost: 'imap.example.test', imapPort: 993, user: 'ExactLogin', mailbox: 'INBOX' };

test('the worker keeps the stored legacy IMAP target exclusive and disable waits for the last active receive lease', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-imap-owner-'));
  const started = deferred(), physicallyClosed = deferred();
  let client;
  t.after(async () => { physicallyClosed.resolve(); await client?.stop(); fs.rmSync(folder, { recursive: true, force: true }); });
  const worker = path.join(folder, 'service-worker.cjs'), bundle = path.join(folder, 'client.cjs');
  const common = { bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', external: ['sharp'],
    banner: { js: `var require=require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});` } };
  buildSync({ ...common, outfile: worker, entryPoints: [path.join(root, 'src/main/agentApps/serviceWorker.ts')] });
  buildSync({ ...common, outfile: bundle, stdin: { resolveDir: root, contents: `
    export { AgentAppsServiceClient } from './src/main/agentApps/serviceClient';
    export { ImapConsumerArbiter, legacyImapOwner } from './src/main/messaging/imapConsumerArbiter';
  ` } });
  const { AgentAppsServiceClient, ImapConsumerArbiter, legacyImapOwner } = require(bundle);
  const arbiter = new ImapConsumerArbiter();
  const owner = (ws, target) => legacyImapOwner(ws, target.id);
  const saved = { root: path.join(folder, 'agent-apps'), workspaces: () => ['ws', 'other'], emit() {}, encrypt: value => Buffer.from(value).toString('base64'),
    decrypt: value => Buffer.from(value, 'base64').toString(), confirmSend: async () => false, deliver: async () => ({ muted: true }),
    claimImapConsumer: (ws, target) => arbiter.claim(target, owner(ws, target)),
    connectors: { feed: async () => [], listFeishuChats: async () => ({ chats: [] }), send: async () => ({ messageId: 'unused' }),
      test: async (target, _secret, ws) => { const release = arbiter.claim(target, owner(ws, target)); release(); },
      sync: async (target, _secret, cursor, _signal, ws) => {
        const release = arbiter.claim(target, owner(ws, target));
        started.resolve();
        try { await physicallyClosed.promise; return { records: [], cursor }; } finally { release(); }
      }
    }
  };
  const open = () => new AgentAppsServiceClient(worker, saved);
  const expectConflict = (target = equivalent) => assert.throws(() => arbiter.claim(target, 'dsh:email'), { code: 'imap-mailbox-in-use' });
  client = open();
  await client.saveConnection('ws', mailbox);
  expectConflict();
  const alternativeOwners = [arbiter.claim({ ...equivalent, user: 'exactlogin' }, 'dsh:other-user'),
    arbiter.claim({ ...equivalent, imapPort: 143 }, 'dsh:other-port'), arbiter.claim({ ...equivalent, mailbox: 'Work' }, 'dsh:custom-folder'),
    arbiter.claim({ ...equivalent, mailbox: 'work' }, 'dsh:distinct-case-folder'), arbiter.claim({ ...equivalent, imapHost: 'other.example.test' }, 'dsh:distinct-host')];
  for (const release of alternativeOwners) release();
  const before = (await client.snapshot('ws')).connections[0];
  await assert.rejects(client.saveConnection('other', { ...mailbox, address: 'alias@example.test' }), /imap-mailbox-in-use/);
  assert.equal((await client.snapshot('other')).connections.length, 0);
  await client.stop();
  const proofOfRelease = arbiter.claim(equivalent, 'dsh:stop-test'); proofOfRelease(); proofOfRelease();

  client = open(); // Existing enabled mailbox is reserved before any background tick or vendor connection.
  await client.prepareImapReservations();
  expectConflict();
  const sync = client.execute('ws', { appId: 'mail', commandId: 'sync', params: { accountId: mailbox.id } }, { kind: 'human', runId: 'fixture' });
  void sync.catch(() => {});
  await started.promise;
  const { password: _password, ...same } = mailbox;
  const disabled = await client.saveConnection('ws', { ...same, expectedRevision: before.revision, enabled: false });
  expectConflict();
  physicallyClosed.resolve();
  await assert.rejects(sync, /unavailable|changed/i);
  const releaseSdk = arbiter.claim(equivalent, 'dsh:email');
  await assert.rejects(client.saveConnection('ws', { ...same, expectedRevision: disabled.revision }, true), /imap-mailbox-in-use/);
  await assert.rejects(client.saveConnection('ws', { ...same, expectedRevision: disabled.revision }), /imap-mailbox-in-use/);
  await assert.rejects(client.testConnection('ws', mailbox.id), /imap-mailbox-in-use/);
  assert.equal((await client.snapshot('ws')).connections[0].enabled, false);
  releaseSdk();
  await client.saveConnection('ws', { ...same, expectedRevision: disabled.revision });
  expectConflict();
});

test('the main IMAP connector waits for Node socket close and retains ownership on failed cleanup until retry', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-imap-close-'));
  const accepted = new Set();
  const server = net.createServer(socket => { accepted.add(socket); socket.once('close', () => accepted.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    for (const socket of accepted) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(folder, { recursive: true, force: true });
    delete globalThis.__imapOwnershipFixture;
  });
  const socketClosed = deferred();
  let fail = true, opened = 0, closed = false;
  globalThis.__imapOwnershipFixture = class extends EventEmitter {
    constructor(options) { super(); this.options = options; }
    async connect() {
      opened++;
      await new Promise((resolve, reject) => {
        this.socket = this.options.transport.connect({ host: this.options.host, port: this.options.port, secure: false }, resolve);
        this.socket.once('close', () => { closed = true; socketClosed.resolve(); });
        this.socket.once('error', reject);
      });
    }
    async mailboxOpen() { return { path: 'INBOX', uidValidity: 1n, uidNext: 1 }; }
    close() { if (fail) { fail = false; throw new Error('synthetic cleanup failure'); } this.socket?.destroy(); }
  };
  const bundle = path.join(folder, 'connector.cjs');
  await build({ bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', outfile: bundle,
    stdin: { resolveDir: root, contents: `export { createAppConnectors } from './src/main/agentApps/connectors'; export { ImapConsumerArbiter } from './src/main/messaging/imapConsumerArbiter';` },
    plugins: [{ name: 'no-provider-network', setup(api) {
      api.onResolve({ filter: /^imapflow$/ }, args => ({ path: args.path, namespace: 'synthetic-imap' }));
      api.onLoad({ filter: /.*/, namespace: 'synthetic-imap' }, () => ({ contents: 'export const ImapFlow = globalThis.__imapOwnershipFixture;' }));
    } }]
  });
  const { createAppConnectors, ImapConsumerArbiter } = require(bundle);
  const arbiter = new ImapConsumerArbiter();
  const target = { ...mailbox, imapHost: '127.0.0.1', imapPort: server.address().port };
  const connectors = createAppConnectors(async () => { throw new Error('unexpected CLI'); }, undefined, (config, owner) => {
    const release = arbiter.claim(config, owner);
    return () => { assert.equal(closed, true, 'lease released before the socket close event'); release(); };
  });
  await assert.rejects(connectors.sync(target, { password: 'synthetic' }, {}, undefined, 'ws'), /imap-mailbox-close-unconfirmed/);
  await socketClosed.promise;
  assert.equal(opened, 1);
  assert.throws(() => arbiter.claim(target, 'dsh:email'), /imap-mailbox-in-use/);
  await connectors.closeImap();
  arbiter.claim(target, 'dsh:email')();
});
