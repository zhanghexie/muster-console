/** Real generic config IPC must not bypass the dedicated workspace removal/revision guards. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-config-ipc-'));
const output = path.join(fixture, 'compiled');
const compile = createSharedCompiler(project, output);
const shim = (name, source) => {
  const dir = path.join(output, 'node_modules', name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.mjs' }));
  fs.writeFileSync(path.join(dir, 'index.mjs'), source);
};
shim('electron', `
export const app = { getPath: () => ${JSON.stringify(fixture)}, getAppPath: () => ${JSON.stringify(project)}, getName: () => 'test', on() {} };
export const ipcMain = { handle() {}, on() {} }; export const dialog = {};
export const shell = {}; export const protocol = {}; export const session = { defaultSession: {} };
export const nativeImage = {}; export class BrowserWindow {} export class WebContentsView {} export class Notification {}
`);
shim('playwright-core', 'export const chromium = {}; export default { chromium };');
// Workspace activation now loads the real snapshot service. Resolve its CJS
// diff dependency from this checkout, even when the bundle lives in OS temp.
shim('unidiff', `import { createRequire } from 'node:module'; export default createRequire(${JSON.stringify(import.meta.url)})('unidiff');`);
// devSandbox contains project source templates. Use syntax-aware bundling, not regex import rewriting.
const bundle = path.join(output, 'workspace-ipc.mjs');
const require = createRequire(import.meta.url);
require('esbuild').buildSync({
  stdin: { contents: "export { registerWorkspaceIpc } from './src/main/ipc/workspaces'; export { invokeIpcChannel } from './src/main/ipc/handle';",
    resolveDir: project, loader: 'ts' },
  outfile: bundle, platform: 'node', format: 'esm', bundle: true, packages: 'external', logLevel: 'silent'
});
const { registerWorkspaceIpc, invokeIpcChannel } = await import(pathToFileURL(bundle));
const { WorkspaceService } = await import(pathToFileURL(compile('main/workspaces.ts')));
const a = path.join(fixture, 'a'); const b = path.join(fixture, 'b'); fs.mkdirSync(a); fs.mkdirSync(b);
let cfg = { activeWorkspaceId: 'multi', workspace: a, locale: 'zh-CN', workspaces: [{ id: 'multi', name: 'Multi',
  path: a, controlRoot: a, rootsRevision: 3, defaultRootId: 'a', roots: [{ id: 'a', path: a }, { id: 'b', path: b }] }] };
let writes = 0; let invalidations = 0;
const config = { get: () => cfg, update: patch => {
  if (patch.worktreeStorageRoot && !path.isAbsolute(patch.worktreeStorageRoot)) throw new Error('absolute storage path required');
  writes++; cfg = { ...cfg, ...patch }; return cfg;
} };
let parameterRefreshes = 0;
const agentSessions = {
  validateParameterProfiles: async profiles => structuredClone(profiles),
  refreshModelParameters: async () => { parameterRefreshes++; },
  // Models the old mutating call so the regression fails before the IPC fix.
  saveParameterProfiles: async profiles => { config.update({ modelParameterProfiles: profiles }); return { ok: true, profiles }; }
};
const workspaces = new WorkspaceService(config); workspaces.setRootRemovalGuard(() => 'running task uses b');
let extensionRefreshes = 0;
registerWorkspaceIpc({ config, workspaces, agentSessions, sessions: { list: () => [] }, extensionSystem: { refresh: () => { extensionRefreshes++; } }, getWindow: () => null }, { invalidatePiSession: () => { invalidations++; } }, () => {});
const original = structuredClone(cfg);
const patches = [
  { workspaces: [{ ...cfg.workspaces[0], roots: [{ id: 'a', path: a }] }] },
  { workspaces: [{ ...cfg.workspaces[0], defaultRootId: 'b', path: b }] },
  { workspaces: [{ ...cfg.workspaces[0], controlRoot: b }] },
  { workspaces: [{ ...cfg.workspaces[0], rootsRevision: 999 }] },
  { workspaces: [] }, { workspaces: [{ ...cfg.workspaces[0], id: 'replacement' }] },
  { workspaces: undefined }, { activeWorkspaceId: 'missing' }, { workspace: b }
];
for (const patch of patches) {
  await assert.rejects(invokeIpcChannel('config:update', [{ frameEffects: true, ...patch }]), /workspaces API/);
  assert.deepEqual(cfg, original, 'rejected mixed settings write has no partial effects');
}
assert.equal(writes, 0); assert.equal(invalidations, 0);
const blocked = await invokeIpcChannel('workspaces:update', ['multi', {
  roots: [{ id: 'a', path: a }], expectedRootsRevision: 3
}]);
assert.equal(blocked.ok, false); assert.equal(blocked.message, 'running task uses b');
assert.deepEqual(cfg, original); assert.equal(fs.statSync(b).isDirectory(), true);
assert.equal(extensionRefreshes, 0, 'a rejected project update does not disturb extension instances');
console.log('ok: generic IPC cannot remove/replace roots, relocate management, forge version or switch ownership');

for (const [key, value] of Object.entries({ workerRoutingDefault: { revision: 1, tiers: [] },
  workerRoutingByWorkspace: { multi: { revision: 1, tiers: [] } }, workerRoutingWorkspaceRevisions: { multi: 1 } })) {
  await assert.rejects(invokeIpcChannel('config:update', [{ frameEffects: true, [key]: value }]), /Use Worker routing settings/);
  assert.deepEqual(cfg, original, `${key} cannot be changed through a generic mixed settings write`);
}
assert.equal(writes, 0);

const result = await invokeIpcChannel('config:update', [{ frameEffects: true,
  workspace: original.workspace, activeWorkspaceId: original.activeWorkspaceId, workspaces: structuredClone(original.workspaces) }]);
assert.equal(result.frameEffects, true); assert.equal(writes, 1); assert.equal(invalidations, 1);
assert.deepEqual(result.workspaces, original.workspaces);
console.log('ok: unchanged workspace snapshots and ordinary settings remain compatible');

const profiles = [{ runtimeId: 'budget-cli', parameters: { reasoning: { defaultValue: '8192' } } }];
const beforeMixed = structuredClone(cfg);
await assert.rejects(invokeIpcChannel('config:update', [{ modelParameterProfiles: profiles, worktreeStorageRoot: 'relative-storage' }]), /absolute storage/);
assert.deepEqual(cfg, beforeMixed, 'a rejected mixed config update must not persist model parameter profiles');
assert.equal(writes, 1); assert.equal(parameterRefreshes, 0);
const parameterResult = await invokeIpcChannel('config:update', [{ modelParameterProfiles: profiles, frameEffects: false }]);
assert.deepEqual(parameterResult.modelParameterProfiles, profiles);
assert.equal(parameterResult.frameEffects, false); assert.equal(writes, 2, 'profiles and other settings commit once');
assert.equal(parameterRefreshes, 1);
console.log('ok: model parameter validation is read-only until the complete config patch commits');
const beforeProviderSave = invalidations;
const llm = { providers: [{ id: 'relay', name: 'Relay', baseUrl: 'https://relay.example.test/v1', apiKey: 'fixture',
  models: [{ id: 'model', reasoning: true }], compat: { supportsDeveloperRole: false } }], activeProviderId: 'relay', activeModelId: 'model' };
await invokeIpcChannel('config:update', [{ llm }]);
assert.equal(invalidations, beforeProviderSave, 'provider changes must not dispose a running scheduler turn');
await invokeIpcChannel('config:update', [{ ...structuredClone(cfg), llm: { ...llm, providers: [{ ...llm.providers[0], compat: { supportsDeveloperRole: true } }] } }]);
assert.equal(invalidations, beforeProviderSave, 'saving the whole settings form with only provider changes also preserves the current turn');
assert.equal(cfg.llm.providers[0].compat.supportsDeveloperRole, true);
const renamed = await invokeIpcChannel('workspaces:update', ['multi', { name: 'Renamed' }]);
assert.equal(renamed.ok, true); assert.equal(extensionRefreshes, 0, 'a cosmetic rename does not cancel reviews');
const c = path.join(fixture, 'c'); fs.mkdirSync(c);
const changed = await invokeIpcChannel('workspaces:update', ['multi', { roots: [...cfg.workspaces[0].roots, { id: 'c', path: c }], expectedRootsRevision: cfg.workspaces[0].rootsRevision }]);
assert.equal(changed.ok, true); assert.equal(extensionRefreshes, 1, 'a successful root change immediately refreshes extension instances');
console.log('workspace-config-ipc: OK');
