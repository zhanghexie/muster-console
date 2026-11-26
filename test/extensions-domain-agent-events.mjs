import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compile = createSharedCompiler(repo, path.join(repo, '.tmp', 'extensions-agent-events-compile'));
const { ExtensionAgentService } = await import(pathToFileURL(compile('main/extensions/extensionAgentService.ts')).href);
const { extensionDomainInstanceKey } = await import(pathToFileURL(compile('shared/extensionDomain.ts')).href);

let nudgeCalls = 0;
const ctx = {
  agentSessions: {
    onPush() { return () => {}; },
    async injectHostNudge() { nudgeCalls += 1; return { ok: true }; }
  }
};
const service = new ExtensionAgentService(ctx, os.tmpdir(), {});
const identity = { extensionId: 'bookshelf', extensionInstanceId: 'ws:bookshelf:main', workspaceId: 'ws', packageFingerprint: 'package-extension:' + 'a'.repeat(64), surfaceId: 'main' };
const events = [];
service.extensionBindings.set(extensionDomainInstanceKey(identity), {
  sessionId: 'session-1',
  identity,
  manifest: {},
  runtime: { subscribe(listener) { events.push(listener); return () => {}; } }
});
const stop = service.extensionSubscribe(identity, event => events.push(event));
events[0]({ type: 'state.changed', extensionId: 'bookshelf', extensionInstanceId: identity.extensionInstanceId, workspaceId: 'ws', version: 2, requestId: 'req-1', actor: 'human', payload: { changed: true } });
await new Promise(resolve => setImmediate(resolve));
assert.equal(nudgeCalls, 0, 'domain events must not become automatic Agent messages');
assert.equal(events.length, 2, 'the renderer listener still receives the domain event');
stop();
console.log('extensions-agent-events: ok');



