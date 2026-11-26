import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-domain-host-'));
const compile = createSharedCompiler(repo, path.join(repo, '.tmp', 'extensions-host-compile'));
const workerFile = compile('main/extensions/extensionRuntimeWorker.ts');
const { ExtensionSourceLayout } = await import(pathToFileURL(compile('main/extensions/extensionSourceLayout.ts')));
const { ExtensionPackageCatalog } = await import(pathToFileURL(compile('main/extensions/extensionPackageCatalog.ts')));
const { ExtensionWorkspaceActivationStore } = await import(pathToFileURL(compile('main/extensions/extensionWorkspaceActivation.ts')));
const { ExtensionHost } = await import(pathToFileURL(compile('main/extensions/extensionHost.ts')));
const { ExtensionDevelopmentTrustStore } = await import(pathToFileURL(compile('main/extensions/extensionDevelopmentTrust.ts')));
const root = path.join(tmp, 'extensions', 'global');
const pkg = path.join(root, 'bookshelf');
fs.mkdirSync(path.join(pkg, 'ui'), { recursive: true });
fs.writeFileSync(path.join(pkg, 'extension.json'), JSON.stringify({
  id: 'bookshelf', name: '书架', scope: 'global', surface: { kind: 'sidebar', entry: 'ui/panel.html' },
  domain: { entry: 'domain.mjs', queries: ['books.list'], commands: ['books.sort'], commandDefs: [{ id: 'books.sort', title: '排序', permission: 'dangerous' }], events: ['state.changed'] },
  agent: { profile: 'scheduler-pi', skills: [], mcp: [] }, data: { workspace: true, shared: false }, permissions: ['agent.state', 'agent.commands', 'project.tasks']
}));
fs.writeFileSync(path.join(pkg, 'ui', 'panel.html'), '<!doctype html>');
fs.mkdirSync(path.join(pkg, 'data'));
fs.writeFileSync(path.join(pkg, 'data', 'fixture.txt'), 'not part of the reviewed package');
fs.writeFileSync(path.join(pkg, 'domain.mjs'), 'export function createDomainRuntime() { return { getSnapshot: async () => ({ version: 1, state: {}, availableCommands: [], capturedAt: new Date().toISOString() }), query: async () => ({}), execute: async () => ({ ok: true, version: 1 }), subscribe: () => () => {}, close: () => {} }; }');
const toolbar = path.join(root, 'quick-note');
fs.mkdirSync(toolbar, { recursive: true });
fs.writeFileSync(path.join(toolbar, 'extension.json'), JSON.stringify({
  id: 'quick-note', name: 'Quick Note', scope: 'global', surface: { kind: 'toolbar', command: 'open' }, commandEntry: 'commands.mjs',
  commands: [{ id: 'open', title: 'Open', handler: 'open' }], data: { workspace: true, shared: false }, permissions: ['data']
}));
fs.writeFileSync(path.join(toolbar, 'commands.mjs'), 'export default async () => ({ execute: async ({ command, context }) => ({ command, workspaceId: context.workspaceId }) });');
const layout = new ExtensionSourceLayout({ userData: tmp, globalRoot: root });
const catalog = new ExtensionPackageCatalog({ layout, file: path.join(tmp, 'registry.json') });
for (const packageInfo of (await catalog.scanGlobal()).packages) await catalog.register(packageInfo);
const trust = new ExtensionDevelopmentTrustStore(tmp);
const activation = new ExtensionWorkspaceActivationStore(path.join(tmp, 'workspace-activation.json'));
const activationCheck = input => activation.isEnabled(input, catalog.get(input.scope, input.extensionId, input.controlRoot)?.enabled ?? true);
const calls = [];
let confirmations = 0;
const agent = {
  extensionDomains: { register() {} },
  async openPanel(identity, manifest) { return (await this.openExtension(identity, manifest)).sessionId; },
  async openExtension(identity, manifest) { calls.push(['open', identity, manifest.id]); return { sessionId: 'agent-1' }; },
  async releaseExtension(identity) { calls.push(['release', identity.extensionId]); },
  async closeExtension(identity) { calls.push(['close', identity.extensionId]); },
  history() { return { messages: [] }; },
  async extensionSnapshot() { calls.push(['snapshot']); return { version: 1 }; },
  async extensionQuery(_identity, _manifest, _session, name) { calls.push(['query', name]); return { name }; },
  async extensionCommand(_identity, _manifest, _session, name) { calls.push(['command', name]); return { ok: true, version: 2 }; }
};
const host = new ExtensionHost(catalog, agent, trust, async () => { confirmations += 1; return true; }, undefined, undefined, undefined, workerFile, undefined, undefined, undefined, undefined, undefined, undefined, activationCheck);
assert.equal((await host.developmentTrustStatus({ scope: 'global', extensionId: 'bookshelf' })).trusted, false);
await assert.rejects(() => host.open({ workspaceId: 'ws', extensionId: 'bookshelf' }), /请在扩展管理中启用此扩展/);
assert.equal((await host.trustDevelopment({ scope: 'global', extensionId: 'bookshelf', mode: 'trusted-once' })).trusted, true);
assert.equal((await host.trustDevelopment({ scope: 'global', extensionId: 'quick-note', mode: 'trusted-once' })).trusted, true);
let finishPreparation;
host.setPackagePreparation(new Promise(resolve => { finishPreparation = resolve; }));
let opened = false;
const opening = host.open({ workspaceId: 'ws', extensionId: 'bookshelf' }).then(view => { opened = true; return view; });
await new Promise(resolve => setImmediate(resolve));
assert.equal(opened, false, 'opening must wait until bundled packages have finished installing');
assert.equal(calls.some(call => call[0] === 'open'), false, 'no runtime may bind a partially copied package');
finishPreparation();
const view = await opening;
assert.equal(view.developmentTrust.trusted, true);
assert.equal(view.entry, 'ui/panel.html');
await activation.set({ workspaceId: 'ws', scope: 'global', extensionId: 'bookshelf' }, false);
await assert.rejects(() => host.call(view.token, 'domain.snapshot'), /disabled in this workspace/);
assert.equal((await host.resource(new Request(`muster-app://${view.token}/ui/panel.html`))).status, 409);
await activation.set({ workspaceId: 'ws', scope: 'global', extensionId: 'bookshelf' }, true);
const panelResponse = await host.resource(new Request(`muster-app://${view.token}/ui/panel.html`));
assert.equal(panelResponse.status, 200);
assert.equal((await host.resource(new Request(`muster-app://${view.token}/data/fixture.txt`))).status, 404);
assert.match(panelResponse.headers.get('content-security-policy') || '', /media-src[^;]*127\.0\.0\.1/);
assert.match(panelResponse.headers.get('content-security-policy') || '', /font-src[^;]*https:\/\/www\.oppo\.com/);
assert.equal((await host.resource(new Request(`muster-app://${view.token}/%`))).status, 400, 'malformed resource escapes must return a client error');
// HTML 交付注入中键/焦点/选区中继：guest 文档事件进不了宿主 document，靠 postMessage 回传
{
  const { injectExtensionPanelChrome } = await import(pathToFileURL(compile('shared/panelRelay.ts')).href);
  const relayed = await (await host.resource(new Request(`muster-app://${view.token}/ui/panel.html`))).text();
  assert.ok(relayed.includes('middleClick') && relayed.includes('panelSelection'), '扩展面板 HTML 必须携带面板事件中继');
  const bare = fs.readFileSync(path.join(pkg, 'ui', 'panel.html'), 'utf8');
  assert.equal(relayed, injectExtensionPanelChrome(bare), '中继注入不改变面板源码其余内容');
}
assert.deepEqual(await host.runToolbar({ workspaceId: 'ws', extensionId: 'quick-note' }), { command: 'open', workspaceId: 'ws' });
assert.deepEqual(await host.runToolbar({ workspaceId: 'ws-2', extensionId: 'quick-note' }), { command: 'open', workspaceId: 'ws-2' }, 'toolbar runtime must not leak the first workspace identity');
await catalog.setEnabled({ scope: 'global', extensionId: 'quick-note', enabled: false });
await assert.rejects(() => host.runToolbar({ workspaceId: 'ws', extensionId: 'quick-note' }), /disabled/);
await catalog.setEnabled({ scope: 'global', extensionId: 'quick-note', enabled: true });
assert.deepEqual(await host.call(view.token, 'domain.snapshot'), { version: 1 });
assert.deepEqual(await host.call(view.token, 'domain.query', ['books.list', {}]), { name: 'books.list' });
assert.deepEqual(await host.call(view.token, 'domain.command', ['books.sort', {}]), { ok: true, version: 2 });
assert.equal(confirmations, 1);

// Panel requests inherit the panel lifetime. Closing a panel must abort in-flight
// LLM, command and domain requests instead of leaving them detached from the UI.
const waitForPanelAbort = (label, signal) => new Promise((_, reject) => {
  if (signal.aborted) { reject(new Error(`${label} aborted`)); return; }
  signal.addEventListener('abort', () => reject(new Error(`${label} aborted`)), { once: true });
});
const cancellationAgent = {
  ...agent,
  async extensionCommand(_identity, _manifest, _session, _name, _args, signal) { return waitForPanelAbort('domain', signal); }
};
const cancellationHost = new ExtensionHost(catalog, cancellationAgent, trust, async () => true,
  async (_identity, _name, _args, signal) => waitForPanelAbort('command', signal),
  async (_identity, _messages, _options, signal) => waitForPanelAbort('llm', signal),
  undefined, workerFile, undefined, undefined, undefined, undefined, undefined, undefined, activationCheck);
for (const [method, args, message] of [
  ['llm.chat', [{ role: 'user', content: 'cancel' }, {}], 'llm aborted'],
  ['commands.execute', ['books.sort', {}], 'command aborted'],
  ['domain.command', ['books.sort', {}], 'domain aborted']
]) {
  const cancellationView = await cancellationHost.open({ workspaceId: 'ws', extensionId: 'bookshelf' });
  const pending = cancellationHost.call(cancellationView.token, method, args);
  await new Promise(resolve => setImmediate(resolve));
  await cancellationHost.close(cancellationView.token);
  await assert.rejects(pending, new RegExp(message));
}
assert.deepEqual(await host.call(view.token, 'agent.release'), { ok: true });
assert.deepEqual(await host.call(view.token, 'agent.open'), { sessionId: 'agent-1' });
const projectTask = { id: 'task-1', workspaceId: 'ws', sourceRoot: { rootId: 'root' }, meta: {
  extensionTask: 'bookshelf', extensionScope: 'global', extensionFingerprint: view.identity.packageFingerprint, extensionSurface: 'main'
} };
agent.domainOwner = async () => 'agent-1';
{
  const project = fs.mkdtempSync(path.join(tmp, 'project-'));
  const checkout = fs.mkdtempSync(path.join(tmp, 'checkout-'));
  const secondRoot = fs.mkdtempSync(path.join(tmp, 'second-source-'));
  const sourceRoot = { rootId: 'root', path: project, cwd: project };
  const sidebar = { id: 'agent-1', workspaceId: 'ws', hidden: true, sourceRoot, meta: {
    extensionId: 'bookshelf', extensionAgent: 'true', extensionInstanceId: view.identity.extensionInstanceId
  } };
  const isolated = { ...projectTask, sourceRoot, cwd: checkout, worktreePath: checkout };
  const selected = [], events = [], pages = [], previewFiles = [];
  const sessions = new Map([sidebar, isolated].map(task => [task.id, task]));
  const roots = [{ id: 'root', path: project }, { id: 'second', path: secondRoot }];
  const config = { activeWorkspaceId: 'ws', workspaces: [{ id: 'ws', path: project, roots, controlRoot: project, defaultRootId: 'root' }] };
  const mappings = [];
  const context = {
    browser: { createTab: (...args) => pages.push(args) },
    config: { get: () => config }, extensionSystem: { authoringServices: { mappings: { list: () => mappings } }, management: { rootId: () => 'root', rootPath: (_ws, id) => roots.find(root => root.id === id).path } },
    sessions: { get: id => sessions.get(id), select: id => selected.push(id) },
    getWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } })
  };
  const { extensionSidebarTaskRef } = await import(pathToFileURL(compile('main/extensions/extensionSidebarTaskRef.ts')));
  const oldSidebar = { ...sidebar, id: 'before-restart' };
  const savedRef = extensionSidebarTaskRef(oldSidebar, view.identity, 'global');
  assert.ok(savedRef?.startsWith('sidebar:'));
  const artifactAgent = { ...agent, openExtension: async () => ({ sessionId: sidebar.id }), closeExtension: async () => {} };
  const artifacts = new ExtensionHost(catalog, artifactAgent, trust, undefined, undefined, undefined, undefined, workerFile, context, undefined, undefined, { projectPreviewUrl: async file => { previewFiles.push(file); return 'muster-export://preview/deck.html'; } });
  const panel = await artifacts.open({ workspaceId: 'ws', extensionId: 'bookshelf' });
  for (const dir of [checkout, project]) fs.writeFileSync(path.join(dir, 'deck.html'), 'deck');
  await artifacts.call(panel.token, 'tasks.preview', [isolated.id, 'deck.html']);
  await artifacts.call(panel.token, 'tasks.preview', [sidebar.id, 'deck.html']);
  assert.deepEqual(previewFiles, [checkout, project].map(dir => path.join(dir, 'deck.html')));
  assert.deepEqual(pages[0], ['muster-export://preview/deck.html', { workspaceId: 'ws', scope: 'workspace' }, { panelUserOpen: true }]);
  assert.equal(events.length, 0);
  assert.equal(sessions.has(oldSidebar.id), false);
  await assert.rejects(() => artifacts.call(panel.token, 'tasks.preview', [oldSidebar.id, 'deck.html']), /TASK_SESSION_MISSING/);
  await artifacts.call(panel.token, 'tasks.preview', [savedRef, 'deck.html']);
  assert.equal(previewFiles.at(-1), path.join(project, 'deck.html'));
  assert.deepEqual(await artifacts.call(panel.token, 'tasks.open', [savedRef]), { sessionId: sidebar.id, sidebar: true });
  const otherRef = extensionSidebarTaskRef({ ...oldSidebar, sourceRoot: { ...sourceRoot, path: secondRoot } }, view.identity, 'global');
  await assert.rejects(() => artifacts.call(panel.token, 'tasks.preview', [otherRef, 'deck.html']), /所属的项目/);
  fs.writeFileSync(path.join(project, 'notes.md'), 'notes');
  await artifacts.call(panel.token, 'tasks.preview', [sidebar.id, 'notes.md']);
  assert.equal(events[0][1].path, path.join(project, 'notes.md'));
  assert.deepEqual(await artifacts.call(panel.token, 'tasks.open', [sidebar.id]), { sessionId: sidebar.id, sidebar: true });
  await artifacts.call(panel.token, 'tasks.open', [isolated.id]);
  assert.deepEqual(selected, [isolated.id]);
  const otherRootTask = { ...projectTask, id: 'task-2', sourceRoot: { rootId: 'second', path: secondRoot, cwd: secondRoot } };
  sessions.set(otherRootTask.id, otherRootTask);
  fs.writeFileSync(path.join(secondRoot, 'deck.html'), 'second deck');
  await artifacts.call(panel.token, 'tasks.preview', [otherRootTask.id, 'deck.html']);
  assert.equal(previewFiles.at(-1), path.join(secondRoot, 'deck.html'));
  await artifacts.call(panel.token, 'tasks.open', [otherRootTask.id]);
  assert.deepEqual(selected, [isolated.id, otherRootTask.id]);
  fs.unlinkSync(path.join(checkout, 'deck.html'));
  await assert.rejects(() => artifacts.call(panel.token, 'tasks.preview', [isolated.id, 'deck.html']), /ENOENT/);
  await assert.rejects(() => artifacts.call(panel.token, 'tasks.preview', [isolated.id, '../deck.html']), /invalid workspace relative path/);
  sessions.set(isolated.id, { ...isolated, cwd: undefined });
  await assert.rejects(() => artifacts.call(panel.token, 'tasks.preview', [isolated.id, 'deck.html']), /任务目录不可用/);
  sessions.set('previous-session', { ...sidebar, id: 'previous-session' });
  await artifacts.call(panel.token, 'tasks.preview', ['previous-session', 'deck.html']);
  await assert.rejects(() => artifacts.call(panel.token, 'tasks.open', ['previous-session']), /原项目任务不可用/);
  for (const other of [{ ...sidebar, meta: { ...sidebar.meta, extensionInstanceId: 'another' } },
    { ...isolated, workspaceId: 'other' }, { ...isolated, sourceRoot: { ...sourceRoot, path: secondRoot } }, { ...isolated, meta: { ...isolated.meta, extensionScope: 'project' } }]) {
    sessions.set(other.id, other);
    for (const method of ['tasks.open', 'tasks.preview']) await assert.rejects(() => artifacts.call(panel.token, method, [other.id, 'deck.html']), /原项目任务不可用/);
  }
  await artifacts.close(panel.token);
  const projectPackage = layout.project(project, 'project-bookshelf').directory;
  fs.mkdirSync(path.dirname(projectPackage), { recursive: true });
  fs.cpSync(pkg, projectPackage, { recursive: true });
  const projectManifest = JSON.parse(fs.readFileSync(path.join(pkg, 'extension.json'), 'utf8'));
  fs.writeFileSync(path.join(projectPackage, 'extension.json'), JSON.stringify({ ...projectManifest, id: 'project-bookshelf', scope: 'project', project: { kind: 'mapped', key: 'books' } }));
  await artifacts.trustDevelopment({ extensionId: 'project-bookshelf', controlRoot: project, scope: 'project', mode: 'trusted-once' });
  await assert.rejects(artifacts.open({ workspaceId: 'ws', extensionId: 'project-bookshelf', scope: 'project', sourceRootId: 'root', controlRoot: project }), /mapping/);
  mappings.push({ workspaceId: 'ws', key: 'books', rootId: 'root', realPath: fs.realpathSync(project) });
  const projectPanel = await artifacts.open({ workspaceId: 'ws', extensionId: 'project-bookshelf', scope: 'project', sourceRootId: 'root', controlRoot: project });
  sessions.set(otherRootTask.id, { ...otherRootTask, meta: { extensionTask: 'project-bookshelf', extensionScope: 'project' } });
  for (const method of ['tasks.open', 'tasks.preview']) await assert.rejects(() => artifacts.call(projectPanel.token, method, [otherRootTask.id, 'deck.html']), /原项目任务不可用/);
  await artifacts.close(projectPanel.token);
}
agent.extensionPromptForSession = () => 'skill prompt';
agent.extensionToolsForSession = () => [{ id: 'ext.bookshelf.query.books.list', execute: async (_args, ctx) => ctx.sessionId }];
const dialogs = [];
// A draft request has only a window and a project resolver. It cannot create a session.
host.appContext = { config: { get: () => ({ activeWorkspaceId: 'ws' }) }, getWindow: () => ({
  isDestroyed: () => false, isFocused: () => true, webContents: { send: (...args) => dialogs.push(args) }
}), extensionSystem: { management: { rootId: () => 'root', rootPath: () => root } }, agentSessions: {
  async send(sessionId, text) { dialogs.push(['agent.send', sessionId, text]); }
} };
assert.deepEqual(await host.call(view.token, 'agent.send', ['hello from panel']), { ok: true });
assert.deepEqual(dialogs.at(-1), ['agent.send', 'agent-1', 'hello from panel']);
assert.deepEqual(await host.call(view.token, 'tasks.create', ['Create', '/skill:example Build a deck']), { opened: true });
assert.equal(dialogs.length, 2);
const [dialogEvent, seed] = dialogs.at(-1);
assert.equal(dialogEvent, 'extensionSurface:newTask');
assert.equal(seed.title, 'Create');
assert.equal(seed.draft, '/skill:example Build a deck');
assert.equal(seed.projectPath, root);
assert.equal((await host.taskLaunchMeta(seed.source, 'ws', 'root', 'pi')).extensionTask, 'bookshelf');
await assert.rejects(() => host.taskLaunchMeta(seed.source, 'other', 'root', 'pi'), /项目/);
await assert.rejects(() => host.taskLaunchMeta(seed.source, 'ws', 'root', 'claude-code'), /GUI/);
const taskResources = await host.projectTaskResources(projectTask);
assert.equal(taskResources.prompt, 'skill prompt');
assert.equal(await taskResources.tools[0].execute({}, {}), 'task-1');
await catalog.setEnabled({ scope: 'global', extensionId: 'bookshelf', enabled: false });
await assert.rejects(() => taskResources.tools[0].execute({}, {}), /停用/);
await catalog.setEnabled({ scope: 'global', extensionId: 'bookshelf', enabled: true });
fs.appendFileSync(path.join(pkg, 'ui', 'panel.html'), '<!-- changed -->');
await new Promise(resolve => setTimeout(resolve, 100));
assert.equal((await host.resource(new Request(`muster-app://${view.token}/ui/panel.html`))).status, 409);
await assert.rejects(() => host.call(view.token, 'domain.snapshot'), /package changed/);
await assert.rejects(() => taskResources.tools[0].execute({}, {}), /扩展已变更或停用/);
assert.equal((await host.trustDevelopment({ scope: 'global', extensionId: 'bookshelf', mode: 'trusted-persistent' })).trusted, true);
await assert.rejects(() => host.taskLaunchMeta(seed.source, 'ws', 'root', 'pi'), /更新/);
assert.equal(await taskResources.tools[0].execute({}, {}), 'task-1', 'explicitly trusted updated package can continue earlier work');
const reloaded = await host.reload(view.token);
assert.equal(reloaded.token, view.token, 'reload preserves the visible panel identity');
assert.notEqual(reloaded.identity.packageFingerprint, view.identity.packageFingerprint, 'reload binds the changed package fingerprint');
assert.equal(reloaded.developmentTrust.trusted, true, 'persistent development trust survives a package fingerprint change');
assert.equal(host.ownsView(reloaded.token), true, 'open views are owned by the host (panel placement routing)');
assert.equal(host.panelViews, undefined, 'test host has no AppContext, so popup windows are unavailable');
assert.throws(() => host.place(reloaded.token, 'window'), /unavailable/);
await host.close(reloaded.token);
assert.equal(host.ownsView(reloaded.token), false, 'closing a view releases ownership');
assert.equal((await host.revokeDevelopment({ scope: 'global', extensionId: 'bookshelf' })).trusted, false);
assert.deepEqual(calls.map(item => item[0]), ['open', 'snapshot', 'query', 'command', 'open', 'close', 'open', 'close', 'open', 'close', 'release', 'open', 'open', 'close']);
await host.closeAll();
console.log('extensions-host: ok');



