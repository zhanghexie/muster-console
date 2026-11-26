import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-domain-runtime-'));
const compile = createSharedCompiler(repo, path.join(repo, '.tmp', 'extensions-runtime-compile'));
const { ExtensionRuntime } = await import(pathToFileURL(compile('main/extensions/extensionRuntime.ts')).href);
const { extensionAgentToolsForSession } = await import(pathToFileURL(compile('main/extensions/extensionAgentToolset.ts')).href);
const pkg = path.join(tmp, 'bookshelf');
fs.mkdirSync(path.join(pkg, 'agent', 'skills'), { recursive: true });
fs.writeFileSync(path.join(pkg, 'system.md'), '当前状态由 DomainRuntime 提供。');
fs.writeFileSync(path.join(pkg, 'agent', 'skills', 'bookshelf.md'), '# 书架技能');

const manifest = {
  id: 'bookshelf',
  name: '书架',
  scope: 'global',
  surface: { kind: 'sidebar', entry: 'ui/panel.html' },
  domain: { entry: 'domain/runtime.mjs', queries: ['books.list'], commands: ['books.sort'], commandDefs: [{ id: 'books.sort', title: '整理书架', permission: 'dangerous', parameters: { type: 'object', additionalProperties: false, properties: { by: { type: 'string' } }, required: ['by'] } }], events: ['state.changed'] },
  agent: { profile: 'scheduler-pi', systemPrompt: 'system.md', skills: ['agent/skills/bookshelf.md'], mcp: [] },
  data: { workspace: true, shared: false },
  permissions: ['agent.state', 'agent.commands']
};

let closed = false;
const listeners = new Set();
const runtime = {
  async getSnapshot(context) { return { version: 1, state: { books: ['a'] }, availableCommands: ['books.sort'], capturedAt: new Date().toISOString(), selection: context.identity.surfaceId }; },
  async query(name) { return { name, books: ['a'] }; },
  async execute(name, args) { return { ok: true, version: 2, result: { name, args } }; },
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  close() { closed = true; }
};

const domains = new (await import(pathToFileURL(compile('main/extensions/extensionDomainRegistry.ts')).href)).ExtensionDomainRegistry();
domains.register('bookshelf', { create: () => runtime });
const resources = new (await import(pathToFileURL(compile('main/extensions/extensionAgentResources.ts')).href)).ExtensionAgentResourceManager();
const extension = new ExtensionRuntime({
  identity: { extensionId: 'bookshelf', extensionInstanceId: 'bookshelf:ws', workspaceId: 'ws', sourceRootId: 'root', packageFingerprint: 'package-extension:test', surfaceId: 'main' },
  manifest,
  packageRoot: pkg,
  sessionId: 'agent-1',
  domains,
  resources
});

fs.writeFileSync(path.join(pkg, 'agent', 'skills', 'template.txt'), 'example');
const opened = await extension.open();
assert.equal(opened.domain, runtime);
assert.equal(opened.resources.sessionId, 'agent-1');
assert.match(extension.agentPrompt(), /当前状态由 DomainRuntime/);
const tools = extensionAgentToolsForSession(extension, manifest, {
  extensionId: 'bookshelf', extensionInstanceId: 'bookshelf:ws', workspaceId: 'ws', sourceRootId: 'root', packageFingerprint: 'package-extension:test', surfaceId: 'main'
});
assert.deepEqual(tools.map(tool => tool.id), ['ext.bookshelf.state.snapshot', 'ext.bookshelf.query.books.list', 'ext.bookshelf.command.books.sort', 'ext.bookshelf.agent.skill.read']);
const snapshotTool = tools.find(tool => tool.id === 'ext.bookshelf.state.snapshot');
const queryTool = tools.find(tool => tool.id === 'ext.bookshelf.query.books.list');
const commandTool = tools.find(tool => tool.id === 'ext.bookshelf.command.books.sort');
const skillTool = tools.find(tool => tool.id === 'ext.bookshelf.agent.skill.read');
assert.ok(snapshotTool && queryTool && commandTool && skillTool);
assert.equal(snapshotTool.permissionClass, 'read');
assert.equal(commandTool.permissionClass, 'dynamic');
assert.deepEqual(commandTool.parameters.required, ['by']);
assert.match(await snapshotTool.execute({}, { sessionId: 'agent-1', cwd: pkg }), /"books"/);
assert.match(await queryTool.execute({}, { sessionId: 'agent-1', cwd: pkg }), /"books"/);
assert.match(await commandTool.execute({ by: 'type' }, { sessionId: 'agent-1', cwd: pkg }), /"books.sort"/);
assert.equal(await extension.readSkill('agent/skills/bookshelf.md', 'template.txt'), 'example');
await assert.rejects(() => extension.readSkill('agent/skills/bookshelf.md', '../system.md'));
assert.equal(JSON.parse(await skillTool.execute({ path: 'agent/skills/bookshelf.md' }, { sessionId: 'agent-1', cwd: pkg })).skillRoot, path.join(fs.realpathSync(pkg), 'agent', 'skills'));
assert.match(await skillTool.execute({ path: 'agent/skills/bookshelf.md' }, { sessionId: 'agent-1', cwd: pkg }), /书架技能/);
assert.deepEqual((await extension.query('books.list', {}, { actor: 'agent', requestId: 'q1', signal: new AbortController().signal })).books, ['a']);
assert.deepEqual((await extension.execute('books.sort', { by: 'type' }, { actor: 'human', requestId: 'c1', signal: new AbortController().signal })).result.args, { by: 'type' });
assert.deepEqual((await extension.execute('books.sort', { by: 'type', expectedVersion: 1 }, { actor: 'human', requestId: 'c2', signal: new AbortController().signal })).result.args, { by: 'type' });
await assert.rejects(() => extension.query('books.unknown', {}, { actor: 'human', requestId: 'q2', signal: new AbortController().signal }), /not declared/);
await assert.rejects(() => extension.execute('books.sort', {}, { actor: 'human', requestId: 'c3', signal: new AbortController().signal }), /Invalid parameters/);
const annotated = await snapshotTool.execute({}, { sessionId: 'agent-1', cwd: pkg });
assert.match(annotated, /"humanActivitySinceAgent"/, 'agent snapshot annotates human commands since the previous snapshot');
assert.match(annotated, /"books\.sort"/);
assert.match(annotated, /"count":2/);
assert.doesNotMatch(await snapshotTool.execute({}, { sessionId: 'agent-1', cwd: pkg }), /humanActivitySinceAgent/, 'annotation is consumed by the first snapshot that takes it');
const seen = [];
const stop = extension.subscribe(event => seen.push(event));
listeners.forEach(listener => listener({ type: 'state.changed', extensionId: 'bookshelf', extensionInstanceId: 'bookshelf:ws', workspaceId: 'ws', version: 2, requestId: 'e1', actor: 'agent' }));
stop();
assert.equal(seen.length, 1);
await extension.close();
assert.equal(closed, true);
assert.equal(resources.get('agent-1'), undefined);
assert.throws(() => extension.agentPrompt(), /closed/);
console.log('extensions-runtime: ok');


