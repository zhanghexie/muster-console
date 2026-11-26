import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const project = process.cwd();
fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
const root = fs.mkdtempSync(path.join(project, '.tmp', 'worktree-scan-'));
const workspace = path.join(root, 'workspace');
const copy = path.join(workspace, '.worktrees', 'task');
fs.mkdirSync(copy, { recursive: true });
fs.writeFileSync(path.join(workspace, 'original.txt'), 'source');
fs.writeFileSync(path.join(copy, 'duplicate.txt'), 'copy');
const compile = createSharedCompiler(project, path.join(root, 'compiled'));
const { listDir } = await import(pathToFileURL(compile('main/workspaceFs.ts')).href);
const { listWorkspaceFiles } = await import(pathToFileURL(compile('main/workspaceFiles.ts')).href);
const { WorkspaceFsWatcher } = await import(pathToFileURL(compile('main/workspaceFsWatcher.ts')).href);
assert.equal((await listDir(workspace)).some(e => e.name === '.worktrees'), false);
assert.deepEqual((await listWorkspaceFiles(workspace)).map(e => e.path), ['original.txt']);
// Explicitly opening a task root still works; filtering applies to discovery from its parent.
assert.deepEqual((await listWorkspaceFiles(copy)).map(e => e.path), ['duplicate.txt']);

const observed = [];
const watcher = new WorkspaceFsWatcher({ config: { get: () => ({ workspaces: [{ id: 'test', path: workspace }] }) }, getWindow: () => null });
watcher.onChanged = (_id, paths) => observed.push(...paths);
try {
  watcher.ensure('test');
  fs.appendFileSync(path.join(copy, 'duplicate.txt'), 'updated');
  fs.appendFileSync(path.join(workspace, 'original.txt'), 'updated');
  const deadline = Date.now() + 5000;
  while (!observed.includes('original.txt') && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.equal(observed.includes('original.txt'), true, 'Positive control: workspace change must be delivered');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(observed.some(p => p.includes('.worktrees')), false, 'Task copies must not reach event consumers');
} finally { watcher.stopAll(); }
console.log('ok: file tree, @ references and real fs watcher exclude task copies; explicit task root stays usable');
