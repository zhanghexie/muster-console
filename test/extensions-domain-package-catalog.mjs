import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-domain-catalog-'));
const compile = createSharedCompiler(repo, path.join(repo, '.tmp', 'extensions-package-catalog-compile'));
const { ExtensionSourceLayout } = await import(pathToFileURL(compile('main/extensions/extensionSourceLayout.ts')).href);
const { ExtensionPackageCatalog } = await import(pathToFileURL(compile('main/extensions/extensionPackageCatalog.ts')).href);
const globalRoot = path.join(tmp, 'extensions', 'global');
const source = path.join(globalRoot, 'bookshelf');
fs.mkdirSync(path.join(source, 'ui'), { recursive: true });
fs.writeFileSync(path.join(source, 'extension.json'), JSON.stringify({
  id: 'bookshelf', name: 'Bookshelf', version: '0.1.0', scope: 'global',
  surface: { kind: 'sidebar', entry: 'ui/panel.html' },
  domain: { entry: 'domain.mjs', queries: ['books.list'], commands: [], events: ['state.changed'] },
  agent: { profile: 'scheduler-pi', skills: [], mcp: [] }, data: { workspace: true, shared: false }, permissions: ['data', 'agent.state']
}));
fs.writeFileSync(path.join(source, 'ui', 'panel.html'), '<!doctype html>');
fs.writeFileSync(path.join(source, 'domain.mjs'), 'export default {};');
const toolbar = path.join(globalRoot, 'quick-note');
fs.mkdirSync(toolbar, { recursive: true });
fs.writeFileSync(path.join(toolbar, 'extension.json'), JSON.stringify({ id: 'quick-note', name: 'Quick Note', scope: 'global', surface: { kind: 'toolbar', command: 'quick-note' }, commandEntry: 'commands.mjs', commands: [{ id: 'quick-note', title: 'Quick Note', handler: 'quick-note' }], data: { workspace: true, shared: false }, permissions: ['data'] }));
fs.writeFileSync(path.join(toolbar, 'commands.mjs'), 'export default { execute: async () => ({ ok: true }) };');
fs.mkdirSync(path.join(toolbar, 'ui'), { recursive: true });
fs.writeFileSync(path.join(toolbar, 'ui', 'panel.html'), '<!doctype html>');
fs.mkdirSync(path.join(globalRoot, 'broken'), { recursive: true });
fs.writeFileSync(path.join(globalRoot, 'broken', 'extension.json'), '{}');const projectA = path.join(tmp, 'project-a');
const projectB = path.join(tmp, 'project-b');
for (const root of [projectA, projectB]) {
  const project = path.join(root, '.muster', 'extensions', 'bookshelf');
  fs.mkdirSync(path.join(project, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(project, 'extension.json'), JSON.stringify({
    id: 'bookshelf', name: path.basename(root), version: '0.2.0', scope: 'project', project: { kind: 'relative', path: 'bookshelf' },
    surface: { kind: 'sidebar', entry: 'ui/panel.html' },
    domain: { entry: 'domain.mjs', queries: ['books.list'], commands: [], events: ['state.changed'] },
    agent: { profile: 'scheduler-pi', skills: [], mcp: [] }, data: { workspace: true, shared: false }, permissions: ['data', 'agent.state']
  }));
  fs.writeFileSync(path.join(project, 'ui', 'panel.html'), '<!doctype html>');
  fs.writeFileSync(path.join(project, 'domain.mjs'), 'export default {};');
}

const layout = new ExtensionSourceLayout({ userData: tmp, globalRoot });
const file = path.join(tmp, 'registry.json');
const catalog = new ExtensionPackageCatalog({ layout, file });
const scan = await catalog.syncGlobal();
assert.equal(scan.packages.length, 2);
assert.equal(scan.errors.length, 1);
const record = catalog.get('global', 'bookshelf');
assert.ok(record);
assert.equal(record.scope, 'global');
assert.equal(record.surfaceKind, 'sidebar');
assert.equal(catalog.list('global').length, 2);
assert.equal(catalog.get('global', 'quick-note')?.surfaceKind, 'toolbar');
assert.equal((await catalog.setEnabled({ scope: 'global', extensionId: 'quick-note', enabled: false })).enabled, false);
assert.equal(catalog.get('global', 'quick-note')?.enabled, false);
fs.rmSync(toolbar, { recursive: true, force: true });
await catalog.syncGlobal();
assert.equal(catalog.get('global', 'quick-note'), undefined);
const reloaded = new ExtensionPackageCatalog({ layout, file });for (const root of [projectA, projectB]) for (const pkg of (await reloaded.scanProject(root)).packages) await reloaded.register(pkg);
assert.equal(reloaded.list('project').length, 2);
assert.notEqual(reloaded.get('project', 'bookshelf', projectA)?.directory, reloaded.get('project', 'bookshelf', projectB)?.directory);
const projectFingerprint = reloaded.get('project', 'bookshelf', projectA).fingerprint;
const projectBinding = reloaded.bindInstance({ workspaceId: 'ws', extensionId: 'bookshelf', extensionInstanceId: 'project-a', surfaceId: 'main', scope: 'project', sourceRootId: 'root-a', controlRoot: projectA, packageFingerprint: projectFingerprint });
assert.equal(projectBinding.directory, path.join(projectA, '.muster', 'extensions', 'bookshelf'));
fs.rmSync(path.join(projectA, '.muster', 'extensions', 'bookshelf'), { recursive: true, force: true });
const projectSync = await reloaded.syncProject(projectA);
assert.equal(projectSync.packages.length, 0);
assert.equal(reloaded.get('project', 'bookshelf', projectA), undefined);
assert.ok(reloaded.get('project', 'bookshelf', projectB));
const binding = reloaded.bindInstance({ workspaceId: 'ws', extensionId: 'bookshelf', extensionInstanceId: 'i1', surfaceId: 'main', scope: 'global', packageFingerprint: record.fingerprint });
assert.equal(binding.directory, source);
assert.equal(binding.packageFingerprint, record.fingerprint);
assert.equal(reloaded.getBinding({ workspaceId: 'ws', extensionId: 'bookshelf', extensionInstanceId: 'i1', surfaceId: 'main' })?.directory, source);
assert.throws(() => reloaded.bindInstance({ workspaceId: 'ws', extensionId: 'bookshelf', extensionInstanceId: 'i2', surfaceId: 'main', scope: 'global', packageFingerprint: 'package-extension:' + '0'.repeat(64) }), /not registered/);
assert.equal(fs.existsSync(path.join(tmp, 'workspaces')), false);
console.log('extensions-package-catalog: ok');








