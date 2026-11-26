/** Removed workspaces release their SQLite handle only after in-flight work settles. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const tempRoot = fs.realpathSync(os.tmpdir());
const folder = fs.mkdtempSync(path.join(tempRoot, 'agent-app-release-'));
if (path.dirname(fs.realpathSync(folder)) !== tempRoot) throw new Error('Unexpected test directory');
let client, releaseFeed;
try {
  const worker = path.join(folder, 'service-worker.cjs'), clientFile = path.join(folder, 'service-client.cjs');
  for (const [source, outfile] of [['serviceWorker.ts', worker], ['serviceClient.ts', clientFile]]) {
    buildSync({ entryPoints: [path.join(root, 'src/main/agentApps', source)], outfile, bundle: true, platform: 'node', format: 'cjs', external: ['sharp'],
      banner: { js: `var require=require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});` }, logLevel: 'silent' });
  }
  const { AgentAppsServiceClient } = createRequire(import.meta.url)(clientFile);
  let workspaces = ['one', 'two'];
  let startedFeed;
  const started = new Promise(resolve => { startedFeed = resolve; });
  const options = { root: path.join(folder, 'data'), workspaces: () => workspaces, emit() {}, encrypt: value => value, decrypt: value => value,
    confirmSend: async () => true, deliver: async () => ({}), connectors: {
      feed: () => new Promise(resolve => { releaseFeed = resolve; startedFeed(); }), sync: async () => ({ records: [], cursor: {} }),
      send: async () => ({ messageId: 'unused' }), test: async () => {}, listFeishuChats: async () => ({ chats: [] })
    } };
  client = new AgentAppsServiceClient(worker, options);
  await client.start();
  const actor = { kind: 'human', runId: 'release-test' };
  const task = (await client.execute('one', { appId: 'tasks', commandId: 'create', params: { values: { title: 'preserved' } } }, actor)).record;
  const feed = (await client.execute('one', { appId: 'rss', commandId: 'subscribe', params: { values: { title: 'Feed', url: 'https://example.test/feed' } } }, actor)).record;
  const pending = client.execute('one', { appId: 'rss', commandId: 'sync', params: { id: feed.id } }, actor);
  const failed = assert.rejects(pending, /workspace.*unavailable/i);
  await started;
  const db = path.join(options.root, `${createHash('sha256').update('one').digest('hex')}.sqlite`);
  assert.ok(fs.existsSync(db + '-wal'), 'fixture holds an open WAL handle');
  workspaces = ['two'];
  await client.snapshot('two');
  assert.ok(fs.existsSync(db + '-wal'), 'the database stays open while an operation still needs it');
  releaseFeed([]); releaseFeed = undefined;
  await failed;
  const until = Date.now() + 3000;
  while (fs.existsSync(db + '-wal') && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(db + '-wal'), false, 'the removed workspace releases its database after the operation finishes');
  workspaces = ['one', 'two'];
  assert.equal((await client.query('one', { appId: 'tasks', id: task.id })).record.values.title, 'preserved');
  let startedAgain;
  const again = new Promise(resolve => { startedAgain = resolve; });
  options.connectors.feed = () => new Promise(resolve => { releaseFeed = resolve; startedAgain(); });
  const resumed = client.execute('one', { appId: 'rss', commandId: 'sync', params: { id: feed.id } }, actor);
  await again;
  workspaces = ['two']; await client.snapshot('two');
  workspaces = ['one', 'two']; await client.snapshot('one');
  releaseFeed([]); releaseFeed = undefined;
  await resumed;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(fs.existsSync(db + '-wal'), 'an old retirement cannot close a workspace added back while work was in flight');
  console.log('agent app workspace removal: in-flight work settles before SQLite closes and data remains available');
} finally {
  releaseFeed?.([]);
  if (client) await client.stop();
  fs.rmSync(folder, { recursive: true, force: true });
}
