import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compile = createSharedCompiler(repo, path.join(repo, '.tmp', 'extensions-source-layout-compile'));
const { ExtensionSourceLayout, extensionGlobalSourceDirectory } = await import(pathToFileURL(compile('main/extensions/extensionSourceLayout.ts')));

const layout = new ExtensionSourceLayout({ userData: path.join('C:', 'Users', 'tester', 'AppData', 'Muster') });
const global = layout.global('daily-report');
assert.equal(global.copiedPerWorkspace, false);
assert.equal(global.directory, path.resolve('C:', 'Users', 'tester', 'AppData', 'Muster', 'extensions', 'global', 'daily-report'));

const project = layout.project(path.join('D:', 'Workspace'), 'project-tool');
assert.equal(project.copiedPerWorkspace, true);
assert.equal(project.directory, path.resolve('D:', 'Workspace', '.muster', 'extensions', 'project-tool'));
assert.deepEqual(layout.resolve({ scope: 'global', extensionId: 'daily-report', controlRoot: path.join('D:', 'Workspace') }), global);
assert.throws(() => layout.resolve({ scope: 'project', extensionId: 'project-tool' }), /control root/);
assert.throws(() => layout.global('../outside'), /Invalid extension id/);
assert.equal(extensionGlobalSourceDirectory('/profile', 'bookshelf', '/global-extensions'), path.resolve('/global-extensions/bookshelf'));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-source-layout-'));
try {
  const source = path.join(temp, 'extensions', 'global', 'bookshelf');
  fs.mkdirSync(path.join(source, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(source, 'extension.json'), JSON.stringify({
    id: 'bookshelf',
    name: 'Bookshelf',
    scope: 'global',
    surface: { kind: 'sidebar', entry: 'ui/panel.html' },
    domain: { entry: 'domain.mjs', queries: ['books.list'], commands: [], events: ['state.changed'] },
    agent: { profile: 'scheduler-pi', skills: [], mcp: [] },
    data: { workspace: true, shared: false },
    permissions: ['data', 'agent.state']
  }));
  fs.writeFileSync(path.join(source, 'ui', 'panel.html'), '<!doctype html>');
  fs.writeFileSync(path.join(source, 'domain.mjs'), 'export default {};');
  const discovered = await new ExtensionSourceLayout({ userData: temp, globalRoot: path.join(temp, 'extensions', 'global') }).discover({ scope: 'global', extensionId: 'bookshelf' });
  assert.equal(discovered.manifest.id, 'bookshelf');
  assert.match(discovered.fingerprint, /^package-extension:[a-f0-9]{64}$/);
  assert.deepEqual(discovered.files, ['domain.mjs', 'extension.json', 'ui/panel.html']);
  fs.writeFileSync(path.join(source, 'extension.json'), JSON.stringify({
    id: 'bookshelf',
    name: 'Bookshelf',
    scope: 'project',
    project: { kind: 'relative', path: 'bookshelf' },
    surface: { kind: 'sidebar', entry: 'ui/panel.html' },
    domain: { entry: 'domain.mjs', queries: ['books.list'], commands: [], events: ['state.changed'] },
    agent: { profile: 'scheduler-pi', skills: [], mcp: [] },
    data: { workspace: true, shared: false },
    permissions: ['data', 'agent.state']
  }));
  await assert.rejects(() => new ExtensionSourceLayout({ userData: temp, globalRoot: path.join(temp, 'extensions', 'global') }).discover({ scope: 'global', extensionId: 'bookshelf' }), /scope/);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

console.log('extensions-source-layout: ok');



