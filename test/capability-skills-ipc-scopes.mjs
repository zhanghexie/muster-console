/** Production capability IPC resolves management roots before shared source aliases. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinModules, createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { builtinHarnessFixtures } from './helpers/harness-fixtures.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryParent = fs.realpathSync(os.tmpdir());
const temporary = fs.mkdtempSync(path.join(temporaryParent, 'metaagent-skills-ipc-scopes-'));
const originalSandbox = process.env.MUSTER_SANDBOX;
const require = createRequire(import.meta.url);
let ctx;
let resetBridge;
try {
  process.env.MUSTER_SANDBOX = '1';
  const electron = path.join(temporary, 'node_modules', 'electron'); fs.mkdirSync(electron, { recursive: true });
  fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ type: 'module', main: 'index.mjs' }));
  fs.writeFileSync(path.join(electron, 'index.mjs'), `export const ipcMain={handle(){}}; export const dialog={}; export const app={getPath:()=>${JSON.stringify(path.join(temporary, 'isolated-userData'))},on(){}};`);
  const bundle = path.join(temporary, 'scopes.mjs');
  await require('esbuild').build({ stdin: { contents: `
export {registerCapabilityManagementIpc, capabilityWorkspaceForPath} from './src/main/ipc/capabilityManagement';
export {invokeIpcChannel} from './src/main/ipc/handle';
export {setSkillsManagementService} from './src/main/capabilityManagement/runtimeSkills';
export {applyLocaleSetting} from './src/shared/i18n';
`, resolveDir: root, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'isolated-mcp-and-sdk-boundaries', setup(build) {
      build.onLoad({ filter: /capabilityManagement[\\/]mcpManagement\.ts$/ }, () => ({ contents: 'export class McpManagementService { onChanged(){return ()=>{};} startObserving(){return ()=>{};} dispose(){} }', loader: 'ts' }));
      build.onLoad({ filter: /agent[\\/]skillsList\.ts$/ }, () => ({ contents: 'export const invalidateAgentSkills=()=>{};', loader: 'ts' }));
      build.onLoad({ filter: /drivers[\\/]acp[\\/]agents\.ts$/ }, () => ({ contents: 'export const getAcpPresets=()=>[];', loader: 'ts' }));
      build.onLoad({ filter: /runtime[\\/]availability\.ts$/ }, () => ({ contents: 'export const readRuntimeAvailability=async()=>({runtimes:[],acpAgents:[],checkedAt:0});', loader: 'ts' }));
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path === 'electron' || args.path.startsWith('node:') || builtinModules.includes(args.path)) return;
        return { path: import.meta.resolve(args.path), external: true };
      });
    } }] });
  const { registerCapabilityManagementIpc, capabilityWorkspaceForPath, invokeIpcChannel, setSkillsManagementService, applyLocaleSetting } = await import(pathToFileURL(bundle).href);
  applyLocaleSetting('zh-CN');
  resetBridge = () => setSkillsManagementService(undefined);
  const a = path.join(temporary, 'a'); const b = path.join(temporary, 'b'); const shared = path.join(temporary, 'shared');
  for (const folder of [a, b, shared]) fs.mkdirSync(folder);
  const workspace = (id, controlRoot, roots) => ({ id, name: id, path: controlRoot, controlRoot, defaultRootId: id,
    rootsRevision: 1, roots: roots.map((folder, index) => ({ id: index ? `${id}-${index}` : id, path: folder })) });
  // B's management root is also an ordinary source of the earlier workspace A.
  const workspaces = [workspace('a', a, [a, b, shared]), workspace('b', b, [b, shared])];
  ctx = { config: { get: () => ({ workspaces }), onChanged: () => () => {} }, runtimes: { list: builtinHarnessFixtures, onChanged: () => () => {} }, getWindow: () => undefined };
  registerCapabilityManagementIpc(ctx);
  const originalRealpath = fs.realpathSync.native;
  const resolutions = [];
  fs.realpathSync.native = function (file, ...args) { resolutions.push(path.resolve(String(file))); return originalRealpath.call(this, file, ...args); };
  try {
    assert.equal(capabilityWorkspaceForPath(a, workspaces)?.id, 'a');
    assert.equal(resolutions.length, 0, 'first exact management root needs no physical lookup');
    assert.equal(capabilityWorkspaceForPath(b, workspaces)?.id, 'b');
    assert.equal(resolutions.filter(file => file === b).length, 1, 'later exact root is not physically resolved twice');
    assert.ok(resolutions.includes(a), 'earlier management roots still participate in physical precedence');
    resolutions.length = 0;
    assert.equal(capabilityWorkspaceForPath(`${a}${path.sep}.${path.sep}`, workspaces)?.id, 'a');
    assert.ok(resolutions.length > 0, 'dot segments retain physical resolution rather than being normalized into the shortcut');
  } finally { fs.realpathSync.native = originalRealpath; }
  const aliasB = path.join(temporary, 'alias-b'), sharedAlias = path.join(temporary, 'shared-alias');
  fs.symlinkSync(b, aliasB, process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(shared, sharedAlias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(capabilityWorkspaceForPath(aliasB, workspaces)?.id, 'b', 'non-exact Junction aliases still use physical matching');
  assert.equal(capabilityWorkspaceForPath(sharedAlias, workspaces), undefined, 'shared-source ambiguity remains rejected through aliases');
  assert.equal(capabilityWorkspaceForPath(b, [workspace('earlier-alias', aliasB, [aliasB]), workspaces[1]])?.id, 'earlier-alias',
    'a later lexical match cannot bypass an earlier physical management alias');
  const scopeA = { kind: 'project', projectPath: a }; const scopeB = { kind: 'project', projectPath: b };
  const created = await invokeIpcChannel('capabilityManagement:createSkill', [{ scope: scopeB, name: 'only-workspace-b', body: 'B instructions' }]);
  assert.deepEqual(created.scope, scopeB, 'the exact B management root wins over the earlier A source alias');
  const asset = created.skills.find(skill => skill.name === 'only-workspace-b'); assert.ok(asset);
  assert.deepEqual(asset.scope, scopeB, 'project creation stays in the selected project scope');
  assert.equal(asset.filePath, path.join(b, '.agents', 'skills', 'only-workspace-b', 'SKILL.md'));
  assert.equal(fs.existsSync(path.join(shared, '.agents', 'skills', 'only-workspace-b')), false, 'project creation does not project a link into another source root');
  const own = await invokeIpcChannel('capabilityManagement:skillsList', [scopeB]);
  assert.ok(own.skills.some(skill => skill.id === asset.id));
  const elsewhere = await invokeIpcChannel('capabilityManagement:skillsList', [scopeA]);
  const visibleFromA = elsewhere.skills.find(skill => skill.id === asset.id);
  assert.ok(visibleFromA && visibleFromA.scope.kind === 'project' && visibleFromA.scope.projectPath === a && !visibleFromA.inherited && visibleFromA.filePath.includes(`${path.sep}b${path.sep}`),
    'A may observe the shared source under its own project scope');
  const projectDirectories = own.directories.filter(directory => !directory.custom && directory.scope.kind === 'project');
  assert.ok(projectDirectories.some(directory => directory.path === path.join(b, '.agents', 'skills')));
  assert.ok(projectDirectories.some(directory => directory.path === path.join(shared, '.agents', 'skills')));
  for (const directory of projectDirectories) assert.deepEqual(directory.scope, scopeB, 'all B sources use the selected B namespace');
  await assert.rejects(invokeIpcChannel('capabilityManagement:skillsList', [{ kind: 'project', projectPath: shared }]), /有效工作区/,
    'a shared source without an exact management root is ambiguous and must be rejected');
  process.stdout.write('capability skills IPC exact management scope, shared-source ambiguity and actual service isolation passed\n');
} finally {
  ctx?.mcpManagement?.dispose(); ctx?.skillsManagement?.dispose(); resetBridge?.();
  if (originalSandbox === undefined) delete process.env.MUSTER_SANDBOX;
  else process.env.MUSTER_SANDBOX = originalSandbox;
  assert.equal(path.dirname(temporary), temporaryParent);
  fs.rmSync(temporary, { recursive: true, force: true });
}
