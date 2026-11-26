import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compile = createSharedCompiler(repo, path.join(repo, '.tmp', 'extensions-domain-registry-compile'));
const { ExtensionDomainRegistry } = await import(pathToFileURL(compile('main/extensions/extensionDomainRegistry.ts')));

const manifest = {
  id: 'bookshelf',
  name: '书架',
  scope: 'global',
  surface: { kind: 'sidebar', entry: 'ui/panel.html' },
  domain: { entry: 'domain/runtime.mjs', queries: ['books.list'], commands: ['books.move'], events: ['state.changed'] },
  agent: { profile: 'scheduler-pi', skills: [], mcp: [] },
  data: { workspace: true, shared: false },
  permissions: ['agent.state', 'agent.commands']
};
const identity = { extensionId: 'bookshelf', extensionInstanceId: 'bookshelf:ws-a', workspaceId: 'ws-a', packageFingerprint: 'package-extension:test', surfaceId: 'main' };
const registry = new ExtensionDomainRegistry();
const events = [];
let closed = 0;
let executions = 0;
registry.register('bookshelf', {
  create() {
    const listeners = new Set();
    return {
      async getSnapshot() { return { version: 1, state: { books: ['a'] }, availableCommands: ['books.move'], capturedAt: new Date().toISOString() }; },
      async query(name) { assert.equal(name, 'books.list'); return { books: ['a'] }; },
      async execute(name) { executions += 1; assert.equal(name, 'books.move'); const event = { type: 'state.changed', extensionId: 'bookshelf', extensionInstanceId: identity.extensionInstanceId, workspaceId: identity.workspaceId, version: 2, requestId: 'r1', actor: 'agent' }; listeners.forEach(listener => listener(event)); return { ok: true, version: 2, result: { moved: true } }; },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      close() { closed += 1; }
    };
  }
});
const context = { identity, manifest, actor: 'agent', requestId: 'r1', signal: new AbortController().signal };
const first = await registry.open(identity, manifest);
assert.equal(await registry.open(identity, manifest), first);
assert.deepEqual(await registry.snapshot(identity, context).then(result => result.state), { books: ['a'] });
assert.deepEqual(await registry.query(identity, 'books.list', {}, context), { books: ['a'] });
const unsubscribe = registry.subscribe(identity, event => events.push(event));
assert.equal((await registry.execute(identity, 'books.move', { id: 'a' }, context)).version, 2);
assert.equal((await registry.execute(identity, 'books.move', { id: 'a' }, context)).version, 2);
assert.equal(executions, 1);
await assert.rejects(() => registry.execute(identity, 'books.move', { id: 'a' }, { ...context, requestId: 'r2', expectedVersion: 1 }), /version conflict/);
assert.equal(events.length, 1);
unsubscribe();
await registry.close(identity);
assert.equal(closed, 1);
assert.throws(() => registry.require(identity), /not open/);
await assert.rejects(() => registry.open({ ...identity, extensionId: 'toolbar' }, { ...manifest, id: 'toolbar', surface: { kind: 'toolbar', command: 'open' }, domain: undefined, agent: undefined }), /sidebar manifest/);

// Concurrent writes with the same expectedVersion must be serialized at the
// registry boundary.  The second writer reaches its version check only after
// the first writer has committed its result.
const queued = new ExtensionDomainRegistry();
let releaseFirst;
let markFirstEntered;
const firstEntered = new Promise(resolve => { markFirstEntered = resolve; });
let queuedExecutions = 0;
queued.register('bookshelf', {
  create() {
    let version = 0;
    return {
      async getSnapshot() { return { version, state: {}, availableCommands: [], capturedAt: new Date().toISOString() }; },
      async query() { return {}; },
      async execute() {
        queuedExecutions += 1;
        if (queuedExecutions === 1) { markFirstEntered(); await new Promise(resolve => { releaseFirst = resolve; }); }
        version += 1;
        return { ok: true, version };
      },
      subscribe() { return () => {}; },
      close() {}
    };
  }
}, 'package-extension:test');
await queued.open(identity, manifest);
const firstWrite = queued.execute(identity, 'books.move', {}, { ...context, requestId: 'q1', expectedVersion: 0 });
await firstEntered;
const secondWrite = queued.execute(identity, 'books.move', {}, { ...context, requestId: 'q2', expectedVersion: 0 });
releaseFirst();
assert.equal((await firstWrite).version, 1);
await assert.rejects(() => secondWrite, /version conflict/);
assert.equal(queuedExecutions, 1, 'conflicting queued command must not reach runtime');

// A rejected queue segment must not poison the next command.
const failed = new ExtensionDomainRegistry();
let failNext = true;
let recovered = 0;
failed.register('bookshelf', {
  create() {
    return {
      async getSnapshot() { return { version: recovered, state: {}, availableCommands: [], capturedAt: new Date().toISOString() }; },
      async query() { return {}; },
      async execute() { if (failNext) { failNext = false; throw new Error('expected failure'); } recovered += 1; return { ok: true, version: recovered }; },
      subscribe() { return () => {}; }
    };
  }
}, 'package-extension:test');
await failed.open(identity, manifest);
await assert.rejects(() => failed.execute(identity, 'books.move', {}, { ...context, requestId: 'f1' }), /expected failure/);
assert.equal((await failed.execute(identity, 'books.move', {}, { ...context, requestId: 'f2' })).version, 1);

// Aborting while waiting in the queue prevents runtime execution.
const cancelled = new ExtensionDomainRegistry();
let cancelExecutions = 0;
let unblock;
let markCancelEntered;
const cancelEntered = new Promise(resolve => { markCancelEntered = resolve; });
cancelled.register('bookshelf', {
  create() {
    return {
      async getSnapshot() { return { version: 0, state: {}, availableCommands: [], capturedAt: new Date().toISOString() }; },
      async query() { return {}; },
      async execute() { cancelExecutions += 1; markCancelEntered(); await new Promise(resolve => { unblock = resolve; }); return { ok: true, version: 1 }; },
      subscribe() { return () => {}; }
    };
  }
}, 'package-extension:test');
await cancelled.open(identity, manifest);
const controller = new AbortController();
const running = cancelled.execute(identity, 'books.move', {}, { ...context, requestId: 'c1' });
const waiting = cancelled.execute(identity, 'books.move', {}, { ...context, requestId: 'c2', signal: controller.signal });
controller.abort();
await cancelEntered;
unblock();
await running;
await assert.rejects(() => waiting, /aborted|AbortError/);
assert.equal(cancelExecutions, 1);

// Human command activity is aggregated per instance and only taken by the
// Agent-facing snapshot path; agent commands never count as human activity.
const activity = new ExtensionDomainRegistry();
activity.register('bookshelf', {
  create() {
    let version = 0;
    return {
      async getSnapshot() { return { version, state: {}, availableCommands: [], capturedAt: new Date().toISOString() }; },
      async query() { return {}; },
      async execute() { version += 1; return { ok: true, version }; },
      subscribe() { return () => {}; },
      close() {}
    };
  }
}, 'package-extension:test');
await activity.open(identity, manifest);
assert.equal(activity.takeHumanActivity(identity), undefined, 'no human activity before any human command');
const humanContext = { ...context, actor: 'human' };
await activity.execute(identity, 'books.move', {}, { ...humanContext, requestId: 'h1' });
await activity.execute(identity, 'books.move', {}, { ...humanContext, requestId: 'h2' });
await activity.execute(identity, 'books.move', {}, { ...context, requestId: 'a1' }, );
const firstTake = activity.takeHumanActivity(identity);
assert.equal(firstTake.commands.length, 1);
assert.equal(firstTake.commands[0].name, 'books.move');
assert.equal(firstTake.commands[0].count, 2, 'agent commands must not count as human activity');
assert.equal(typeof firstTake.lastAt, 'number');
assert.equal(activity.takeHumanActivity(identity), undefined, 'taking clears the accumulated activity');
await activity.execute(identity, 'books.move', {}, { ...humanContext, requestId: 'h3' });
assert.equal(activity.takeHumanActivity(identity).commands[0].count, 1, 'activity accumulates again after a take');
await activity.close(identity);
assert.equal(activity.takeHumanActivity(identity), undefined, 'close discards pending activity');
console.log('extensions-domain-registry: ok');



