import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-results-'));
let log;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
  const load = p => import(pathToFileURL(compile(p)).href);
  const { EventLog } = await load('main/awareness/eventLog.ts');
  const { EventRouter } = await load('main/awareness/eventRouter.ts');
  const { RuntimeAwarenessStore } = await load('main/awareness/store.ts');
  const { awarenessHost } = await load('main/capabilities/hosts/awareness.ts');
  const { projectResourceToolResult: project } = await load('shared/resourceToolResult.ts');
  log = new EventLog(path.join(tmp, 'db'));
  const router = new EventRouter(log, async () => {});
  const sessions = [{ id: 'a', workspaceId: 'w' }, { id: 'b', workspaceId: 'w' }];
  const ctx = { eventRouter: router, awareness: new RuntimeAwarenessStore(path.join(tmp, 'awareness')),
    sessions: { get: id => sessions.find(s => s.id === id) },
    workspaces: { list: () => [{ id: 'w', path: tmp }] }, resolveBubbleWorkspaceId: () => 'w',
    ui: { confirm: async () => ({ confirmed: true }) } };
  const call = (name, args = {}) => awarenessHost[name](ctx, { __actorSessionId: 'a', ...args });

  // Both subscription stores return the new record, but do not repeat it or unrelated records.
  const factsRaw = call('events.subscribe', { kinds: ['session.phase'] });
  const eventsRaw = call('events.subscribe', { source: 'file' });
  const facts = project('host.events.subscribe', {}, factsRaw);
  const events = project('host.events.subscribe', {}, eventsRaw);
  assert.equal(facts.ok, true);
  assert.equal(events.ok, true);
  assert.equal(facts.subscription.query.kinds[0], 'session.phase');
  assert.equal(events.subscription.source, 'file');
  assert.deepEqual(Object.keys(facts).sort(), ['ok', 'subscription']);
  assert.deepEqual(Object.keys(events).sort(), ['ok', 'subscription']);
  assert.ok(Array.isArray(factsRaw.subscriptions), 'the original host contract is not mutated');
  assert.ok(Array.isArray(eventsRaw.subscriptions), 'the original host contract is not mutated');
  const listed = call('events.list').subscriptions;
  assert.deepEqual(new Set(listed.map(s => s.id)), new Set([facts.subscription.id, events.subscription.id]));
  assert.ok(JSON.stringify(events).length < JSON.stringify({ ...events, subscriptions: listed }).length);

  const factsRemovedRaw = call('events.unsubscribe', { id: facts.subscription.id });
  const eventsRemovedRaw = call('events.unsubscribe', { id: events.subscription.id });
  const factsRemoved = project('host.events.unsubscribe', {}, factsRemovedRaw);
  const eventsRemoved = project('host.events.unsubscribe', {}, eventsRemovedRaw);
  assert.deepEqual(factsRemoved, { ok: true, id: facts.subscription.id });
  assert.deepEqual(eventsRemoved, { ok: true, id: events.subscription.id });
  assert.ok(Array.isArray(factsRemovedRaw.subscriptions));
  assert.deepEqual(call('events.list').subscriptions, []);
  assert.throws(() => call('events.unsubscribe', { id: facts.subscription.id }), /订阅不存在/);

  // Approval permits a write for another subject, not reading that subject's other subscriptions.
  const delegatedRaw = await call('events.subscribe', { source: 'file', subject: 'b' });
  const delegated = project('host.events.subscribe', {}, delegatedRaw);
  assert.equal(delegated.subscription.subject, 'b');
  assert.deepEqual(Object.keys(delegated).sort(), ['ok', 'subscription']);
  assert.throws(() => call('events.list', { subject: 'b' }), /another session/);

  // A changed shape, a failure, and another tool are not silently projected.
  for (const [name, value] of [
    ['host.events.subscribe', { ok: false, subscription: {}, subscriptions: ['diagnostic'] }],
    ['host.events.subscribe', { ok: true, subscriptions: ['diagnostic'] }],
    ['host.events.unsubscribe', { ok: true, subscriptions: ['diagnostic'] }],
    ['host.events.list', { ok: true, subscription: {}, subscriptions: ['diagnostic'] }]
  ]) assert.strictEqual(project(name, {}, value), value);
  assert.deepEqual(project('host.events.subscribe', {}, { ok: true, subscription: { id: 's' },
    subscriptions: [], warning: 'keep' }), { ok: true, subscription: { id: 's' }, warning: 'keep' });

  router.stop();
  log.close();
  log = undefined;
} finally {
  log?.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
}
console.log('event-subscription-results: ok');
