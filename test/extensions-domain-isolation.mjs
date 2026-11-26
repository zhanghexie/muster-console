import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-domain-isolation-'));
const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
const workerFile = compile('main/extensions/extensionRuntimeWorker.ts');
const { ExtensionIsolatedDomainRuntime, ExtensionIsolatedCommandRuntime, resolveExtensionRuntimeWorkerPath } = await import(pathToFileURL(compile('main/extensions/extensionIsolatedRuntime.ts')));
const bundledExtensions = path.join(temp, 'out', 'main', 'extensions');
const bundledWorker = path.join(bundledExtensions, 'sdk', 'extension-runtime-worker.mjs');
fs.mkdirSync(path.dirname(bundledWorker), { recursive: true });
fs.writeFileSync(bundledWorker, '');
assert.equal(resolveExtensionRuntimeWorkerPath(bundledExtensions), bundledWorker, 'default worker path must match the bundled extensions/sdk layout');
const pkg = path.join(temp, 'pkg');
fs.mkdirSync(pkg, { recursive: true });
fs.writeFileSync(path.join(pkg, 'domain.mjs'), `export function createDomainRuntime({ identity, broker }) {
  let version = 0;
  const listeners = new Set();
  return {
    async getSnapshot() { return { version, state: { isolated: true }, availableCommands: ['bump'], capturedAt: new Date().toISOString() }; },
    async query(name, args, context) {
      if (name === 'worker-cancel') {
        const controller = new AbortController();
        try {
          await broker('llm.chatStream', [name], { ...context, signal: controller.signal }, () => controller.abort());
          return 'unexpected completion';
        } catch (error) { return error.name; }
      }
      if (name === 'stream' || name === 'cancel-stream') {
        const deltas = [];
        const result = await broker('llm.chatStream', [name], context, delta => deltas.push(delta));
        return { deltas, result };
      }
      return name === 'models' ? await broker('models.list', [], { requestId: 'broker-query' }) : { name, isolated: true };
    },
    async execute(name, args, context) { version += 1; const event = { type: 'state.changed', extensionId: identity.extensionId, extensionInstanceId: identity.extensionInstanceId, workspaceId: identity.workspaceId, version, requestId: context.requestId, actor: context.actor, payload: args }; listeners.forEach(listener => listener(event)); return { ok: true, version, result: { name, args } }; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() {}
  };
}`);
fs.writeFileSync(path.join(pkg, 'command.mjs'), `export default async function createCommandRuntime() { return { execute: async ({ command, args, context }) => ({ command, args, workspaceId: context.workspaceId }) }; }`);
const identity = { extensionId: 'isolated', extensionInstanceId: 'isolated:ws:main', workspaceId: 'ws', packageFingerprint: 'package-extension:' + 'a'.repeat(64), surfaceId: 'main' };
const manifest = { id: 'isolated', name: 'Isolated', scope: 'global', surface: { kind: 'sidebar', entry: 'panel.html' }, domain: { entry: 'domain.mjs', queries: ['state'], commands: ['bump'], events: ['state.changed'] }, agent: { profile: 'scheduler-pi', skills: [], mcp: [] }, data: { workspace: true, shared: false }, permissions: ['agent.state', 'agent.commands'] };
const events = [];
let streamStarted, streamAborted;
let localStreamAborted;
const localAborted = new Promise(resolve => { localStreamAborted = resolve; });
const started = new Promise(resolve => { streamStarted = resolve; });
const aborted = new Promise(resolve => { streamAborted = resolve; });
const domain = new ExtensionIsolatedDomainRuntime({ identity, manifest, packageRoot: pkg, entry: 'domain.mjs', workerFile, broker: async (method, args, context, onDelta) => {
  if (method !== 'llm.chatStream') return { method, args, fromHost: true };
  onDelta('第'); onDelta('一段');
  if (args[0] === 'cancel-stream' || args[0] === 'worker-cancel') {
    if (args[0] === 'cancel-stream') streamStarted();
    await new Promise((resolve, reject) => context.signal.addEventListener('abort', () => { args[0] === 'worker-cancel' ? localStreamAborted() : streamAborted(); reject(new DOMException('Aborted', 'AbortError')); }, { once: true }));
  }
  return { text: '第一段' };
} });
const stop = domain.subscribe(event => events.push(event));
assert.deepEqual((await domain.getSnapshot({ identity, manifest, actor: 'human', requestId: 's1', signal: new AbortController().signal })).state, { isolated: true });
assert.deepEqual(await domain.query('state', {}, { identity, manifest, actor: 'human', requestId: 'q1', signal: new AbortController().signal }), { name: 'state', isolated: true });
assert.deepEqual(await domain.query('models', {}, { identity, manifest, actor: 'human', requestId: 'q2', signal: new AbortController().signal }), { method: 'models.list', args: [], fromHost: true });
assert.deepEqual(await domain.query('stream', {}, { identity, manifest, actor: 'human', requestId: 'q3', signal: new AbortController().signal }), { deltas: ['第', '一段'], result: { text: '第一段' } }, 'worker broker must deliver ordered deltas before completion');
const cancel = new AbortController();
const cancelled = domain.query('cancel-stream', {}, { identity, manifest, actor: 'human', requestId: 'q4', signal: cancel.signal });
const rejection = assert.rejects(cancelled, /abort/i);
await started; cancel.abort(); await rejection;
await Promise.race([aborted, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('stream cancellation did not reach host')), 3000); timer.unref(); })]);
assert.equal(await domain.query('worker-cancel', {}, { identity, manifest, actor: 'human', requestId: 'q5', signal: new AbortController().signal }), 'AbortError');
await Promise.race([localAborted, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('worker-originated broker cancellation did not reach host')), 3000); timer.unref(); })]);
assert.equal((await domain.execute('bump', { value: 1 }, { identity, manifest, actor: 'agent', requestId: 'e1', signal: new AbortController().signal })).version, 1);
assert.equal(events.length, 1);
stop();
await domain.close();

const commandManifest = { ...manifest, surface: { kind: 'toolbar', command: 'open' }, domain: undefined, agent: undefined, commands: [{ id: 'open', title: 'Open', handler: 'open' }], commandEntry: 'command.mjs' };
const command = new ExtensionIsolatedCommandRuntime({ identity: { ...identity, surfaceId: 'toolbar' }, manifest: commandManifest, packageRoot: pkg, entry: 'command.mjs', workerFile });
assert.deepEqual(await command.execute({ command: 'open', args: { ok: true }, context: { workspaceId: 'ws', extensionId: 'isolated', scope: 'global', requestId: 'c1', signal: new AbortController().signal } }), { command: 'open', args: { ok: true }, workspaceId: 'ws' });
await command.close();
console.log('extensions-isolation: ok');


