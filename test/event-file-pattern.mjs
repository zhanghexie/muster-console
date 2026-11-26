import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'event-file-pattern-'));
let log;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
  const load = p => import(pathToFileURL(compile(p)).href);
  const { EventLog } = await load('main/awareness/eventLog.ts');
  const { EventRouter, matchesFilePattern } = await load('main/awareness/eventRouter.ts');
  const { awarenessHost } = await load('main/capabilities/hosts/awareness.ts');
  const { FACTS_SHARE_EVENTS_TOOL_DEFS } = await load('main/capabilities/catalog/factsShareEvents.ts');
  const { assertToolArguments } = await load('main/capabilities/schemaValidation.ts');
  const dir = path.join(tmp, 'data'); fs.mkdirSync(dir);
  const old = new DatabaseSync(path.join(dir, 'event-log.sqlite'));
  old.exec(`CREATE TABLE subscriptions (id TEXT PRIMARY KEY, subject TEXT NOT NULL, workspace_id TEXT NOT NULL,
    source TEXT NOT NULL, types TEXT NOT NULL, scope TEXT NOT NULL, mode TEXT NOT NULL, rate_limit INTEGER NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER, start_cursor INTEGER NOT NULL, cursor INTEGER NOT NULL, launch_task_id TEXT, config_key TEXT);
    INSERT INTO subscriptions VALUES ('old', 'legacy', 'w', 'file', '[]', '', 'instant', 20, 1, NULL, 0, 0, NULL, NULL);`);
  old.close();
  log = new EventLog(dir);
  assert.equal(log.subscriptions('legacy')[0].pathPattern, undefined, 'old subscriptions migrate unchanged');
  log.unsubscribe('old', 'legacy');
  const delivered = [];
  const router = new EventRouter(log, async (_sub, event) => { delivered.push(event.id); });
  const ctx = { eventRouter: router, awareness: { listSubscriptions: () => [] }, sessions: { get: id => id === 'a' ? { id, workspaceId: 'w' } : undefined },
    workspaces: { list: () => [{ id: 'w', path: tmp }] }, resolveBubbleWorkspaceId: () => 'w' };
  const call = (name, args) => awarenessHost[name](ctx, { __actorSessionId: 'a', ...args });
  const args = { source: 'file', scope: 'root', path: 'src/**/*.ts' };
  assertToolArguments(FACTS_SHARE_EVENTS_TOOL_DEFS.find(x => x.name === 'events.subscribe').parameters, args, 'events.subscribe');
  const sub = call('events.subscribe', args).subscription;
  assert.equal(sub.pathPattern, args.path);
  assert.throws(() => call('events.subscribe', { source: 'gitlab', path: 'src/**' }), /path requires/);
  assert.throws(() => call('events.subscribe', { source: 'file', q: 'ignored' }), /Fact query filters/);
  assert.equal(matchesFilePattern('src/**/*.ts', 'src/a.ts'), true);
  assert.equal(matchesFilePattern('src/**/*.ts', 'src/dir/a.ts'), true);
  assert.equal(matchesFilePattern('src/*.ts', 'src/dir/a.ts'), false);
  assert.equal(matchesFilePattern('src/**/*.ts', 'src\\dir\\a.ts'), true);
  const event = (file, workspaceId = 'w') => log.append({ source: 'file', type: 'changed', scope: 'root', workspaceId, receivedAt: Date.now(), summary: file, payload: JSON.stringify({ path: file }) }).event;
  const good = event('src/a.ts'), nested = event('src/dir/a.ts'), bad = event('docs/a.md'), other = event('src/other.ts', 'other');
  const listed = call('events.list', { subscriptionId: sub.id }).events;
  assert.deepEqual(listed.map(e => e.id), [good.id, nested.id]);
  assert.ok(call('events.read', { id: good.id }).text.includes('src/a.ts'));
  assert.throws(() => call('events.read', { id: bad.id }), /not authorized/);
  assert.throws(() => call('events.read', { id: other.id }), /not authorized/);
  await router.replay();
  assert.deepEqual(delivered, [good.id, nested.id], 'delivery and listing share the same filter');
  const cursor = log.subscriptions('a')[0].cursor;
  log.close(); log = new EventLog(dir);
  assert.equal(log.subscriptions('a')[0].pathPattern, args.path, 'filter survives restart');
  assert.equal(log.subscriptions('a')[0].cursor, cursor, 'cursor survives restart');
  console.log('event file pattern: migration, filtering, permissions, replay and restart passed');
} finally { log?.close(); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); }
