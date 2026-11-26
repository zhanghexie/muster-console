import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compile = createSharedCompiler(repo, path.join(repo, '.tmp', 'extensions-host-structure-compile'));
const { ExtensionHostPanelLifecycle } = await import(pathToFileURL(compile('main/extensions/extensionHostPanelLifecycle.ts')));
const { ExtensionHostDomainFactoryRegistry } = await import(pathToFileURL(compile('main/extensions/extensionHostDomainFactories.ts')));
const { handleExtensionMediaBridge } = await import(pathToFileURL(compile('main/extensions/extensionHostMedia.ts')));
const { handleExtensionTaskBridge } = await import(pathToFileURL(compile('main/extensions/extensionHostTasks.ts')));

const hostSource = fs.readFileSync(path.join(repo, 'src', 'main', 'extensions', 'extensionHost.ts'), 'utf8');
assert.match(hostSource, /handleExtensionMediaBridge\(method/);
assert.doesNotMatch(hostSource, /if \(method === 'media\.import'\)/, 'media dispatch remains owned by the extracted bridge');
assert.match(hostSource, /handleExtensionTaskBridge\(\{/);
assert.doesNotMatch(hostSource, /if \(method\.startsWith\('tasks\\.'\)\)/, 'task dispatch remains owned by the extracted bridge');

let picked = new Set();
const calls = [];
let current = true;
let active = true;
const bridgeContext = (method, args = []) => ({
  owner: 'ws:panel', token: 'panel', workspaceId: 'ws', args,
  permissions: ['files', 'media', 'exports'], pickedFiles: picked,
  pickFiles: async () => ['/tmp/selected.png'],
  setPickedFiles: files => { picked = new Set(files); },
  mediaStore: {
    importFile: async (...input) => { calls.push(['import', ...input]); return { assetId: 'asset-1' }; },
    url: async (...input) => { calls.push(['url', ...input]); return { assetId: input[1] }; },
    retain: async (...input) => { calls.push(['retain', ...input]); return { assetId: input[1] }; },
    release: async (...input) => { calls.push(['release', ...input]); },
  },
  htmlThumbnails: { html: async (...input) => { calls.push(['thumbnail', ...input]); return { dataUrl: 'data:' }; } },
  exportService: {
    create: async (...input) => { calls.push(['create', ...input]); return { exportId: 'export-1' }; },
    previewUrl: async (...input) => { calls.push(['preview', ...input]); return 'muster-export://export-1/index.html'; },
    reveal: async (...input) => { calls.push(['reveal', ...input]); return { ok: true }; },
  },
  browser: { createTab: (...input) => calls.push(['tab', ...input]) },
  isViewCurrent: () => current,
  isActiveWorkspace: () => active,
  requirePermission: permission => { if (!['files', 'media', 'exports'].includes(permission)) throw new Error(`unexpected permission ${permission}`); },
});

assert.deepEqual((await handleExtensionMediaBridge('files.pick', bridgeContext('files.pick'))).value, ['/tmp/selected.png']);
assert.deepEqual((await handleExtensionMediaBridge('files.pathAccess', bridgeContext('files.pathAccess'))).value, ['/tmp/selected.png']);
await assert.rejects(() => handleExtensionMediaBridge('media.import', bridgeContext('media.import', ['/tmp/not-picked.png'])), /必须先由宿主文件选择器授权/);
assert.deepEqual((await handleExtensionMediaBridge('media.import', bridgeContext('media.import', ['/tmp/selected.png', 'copy.png', 'image/png']))).value, { assetId: 'asset-1' });
assert.deepEqual((await handleExtensionMediaBridge('media.release', bridgeContext('media.release', ['asset-1']))).value, true);
assert.deepEqual((await handleExtensionMediaBridge('exports.create', bridgeContext('exports.create', [{ files: [], title: 'Deck' }]))).value, { exportId: 'export-1' });
current = false;
await assert.rejects(() => handleExtensionMediaBridge('exports.preview', bridgeContext('exports.preview', ['export-1', 'index.html'])), /面板已关闭或工作区已切换/);
current = true; active = true;
assert.deepEqual((await handleExtensionMediaBridge('exports.preview', bridgeContext('exports.preview', ['export-1', 'index.html']))).value, { ok: true });
assert.equal(calls.at(-1)[0], 'tab');
assert.equal((await handleExtensionMediaBridge('domain.query', bridgeContext('domain.query'))).handled, false);

const taskEvents = [];
const taskController = new AbortController();
const taskContext = (method, args = [], signal = taskController.signal) => ({
  token: 'panel', owner: 'ws:panel', method, args, signal,
  view: {
    identity: { extensionId: 'bookshelf', extensionInstanceId: 'ws:bookshelf:main', workspaceId: 'ws', packageFingerprint: 'fingerprint', surfaceId: 'main' },
    binding: { workspaceId: 'ws', extensionId: 'bookshelf', extensionInstanceId: 'ws:bookshelf:main', surfaceId: 'main', scope: 'global', packageFingerprint: 'fingerprint', directory: '/tmp/bookshelf' },
    manifest: { id: 'bookshelf', name: 'Bookshelf', scope: 'global', surface: { kind: 'sidebar', entry: 'ui/panel.html' }, permissions: ['project.tasks'], agent: { profile: 'scheduler-pi', skills: ['skills/deck/SKILL.md'], mcp: [] } },
    sessionId: 'session-1', developmentTrust: { subject: { extensionId: 'bookshelf', scope: 'global', directory: '/tmp/bookshelf', fingerprint: 'fingerprint' } }
  },
  appContext: {
    config: { get: () => ({ activeWorkspaceId: 'ws' }) },
    extensionSystem: { management: { rootId: () => 'root', rootPath: () => '/tmp/project' } },
    getWindow: () => ({ isDestroyed: () => false, isFocused: () => false, focus() {}, webContents: { send: (...event) => taskEvents.push(event) } }),
    sessions: { get: () => undefined, select: async () => {} }
  },
  catalog: { get: () => ({ enabled: true }) },
  htmlThumbnails: { file: async () => ({ dataUrl: 'data:' }) },
  isViewCurrent: () => true,
  assertCurrent() {},
  requirePermission(permission) { assert.equal(permission, 'project.tasks'); }
});
assert.deepEqual((await handleExtensionTaskBridge(taskContext('tasks.create', ['Create', 'Draft']))).value, { opened: true });
assert.equal(taskEvents[0][0], 'extensionSurface:newTask');
assert.deepEqual(taskEvents[0][1].source.skillNames, ['deck']);
taskController.abort();
await assert.rejects(() => handleExtensionTaskBridge(taskContext('tasks.create', ['Create', 'Draft'])), /aborted|cancelled/i);

const lifecycle = new ExtensionHostPanelLifecycle();
lifecycle.open('panel');
const child = lifecycle.childSignal('panel');
let aborted = false;
child.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
lifecycle.setStream('panel', 'stream', child.controller);
assert.equal(lifecycle.stream('panel', 'stream'), child.controller);
lifecycle.close('panel');
assert.equal(aborted, true, 'closing a panel aborts child requests and streams');
assert.equal(lifecycle.stream('panel', 'stream'), undefined);
assert.throws(() => lifecycle.childSignal('panel'), /closed/);

const registry = new ExtensionHostDomainFactoryRegistry();
const disposed = [];
registry.add('bookshelf:fingerprint-a', () => disposed.push('a'));
registry.add('bookshelf:fingerprint-b', () => disposed.push('b'));
registry.add('other:fingerprint-a', () => disposed.push('other'));
assert.equal(registry.has('bookshelf:fingerprint-a'), true);
registry.unregister('bookshelf');
assert.deepEqual(disposed, ['a', 'b']);
assert.equal(registry.has('other:fingerprint-a'), true);
registry.unregister();
assert.deepEqual(disposed, ['a', 'b', 'other']);

console.log('extensions-host-structure: ok');
