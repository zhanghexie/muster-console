import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const project = process.cwd(); fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'preparation-settings-'));
const compile = createSharedCompiler(project, path.join(fixture, 'compiled'));
const { readWorktreePreparation: read, saveWorktreePreparation: save } = await import(pathToFileURL(compile('main/git/worktreePreparationSettings.ts')).href);
const { repositoryPreparations, preparationsForSelections } = await import(pathToFileURL(compile('shared/worktreePreparation.ts')).href);
const queue = await import(pathToFileURL(compile('main/tasks/delegateQueue.ts')).href);
try {
  const [a, b] = ['a', 'b'].map(name => path.join(fixture, name)); for (const folder of [a, b]) fs.mkdirSync(folder);
  const workspace = { id: 'ws', path: a, controlRoot: a, roots: [{ id: 'a', path: a }, { id: 'b', path: b }], defaultRootId: 'a', rootsRevision: 1 };
  const config = { workspaces: [workspace], activeWorkspaceId: 'other' };
  const first = read(config, 'ws'); const file = path.join(a, '.muster/workspace.json');
  const cfg = JSON.parse(fs.readFileSync(file)); cfg.git.selectedRepo = 'preserve'; cfg.custom = { untouched: true }; fs.writeFileSync(file, JSON.stringify(cfg));
  const current = read(config, 'ws');
  const commands = ['node -e "throw Error(\'must not run while saving\')"'];
  const recipes = [{ rootId: 'b', relativePath: '', commands: ['echo b\necho second line'] }, { rootId: 'b', relativePath: 'Plugins/Same', commands: ['echo plugin'] }];
  const saved = save(config, { ...current, commands, recipes });
  assert.deepEqual(saved.recipes, recipes); assert.deepEqual(saved.commands, commands);
  const written = JSON.parse(fs.readFileSync(file)); assert.equal(written.git.selectedRepo, 'preserve'); assert.deepEqual(written.custom, { untouched: true });
  assert.throws(() => save(config, { ...first, commands: [], recipes: [] }), /scope changed/, 'stale recipe version cannot overwrite');
  assert.deepEqual(preparationsForSelections(repositoryPreparations(recipes), [{ rootId: 'a', relativePath: '' }]), []);
  assert.deepEqual(preparationsForSelections(recipes, [{ rootId: 'b', relativePath: 'Plugins/Same' }]), [recipes[1]]);
  const exclusions = [{ rootId: 'b', relativePath: 'Plugins' }];
  assert.deepEqual(preparationsForSelections(recipes, [{ rootId: 'b', relativePath: '' }], exclusions), [recipes[0]], 'automatic isolation never provisions an excluded repository');
  assert.deepEqual(preparationsForSelections(recipes, [{ rootId: 'b', relativePath: '', repoSet: ['Plugins/Same'] }], exclusions), recipes, 'explicit members override exclusion for preparation too');
  assert.deepEqual(preparationsForSelections(recipes, [{ rootId: 'b', relativePath: 'Plugins/Same' }], exclusions), [recipes[1]], 'explicit selected root remains provisioned');
  assert.throws(() => repositoryPreparations([{ ...recipes[0], relativePath: '../outside' }]), /path/);
  assert.throws(() => repositoryPreparations([recipes[0], recipes[0]]), /duplicate/);
  const before = fs.readFileSync(file);
  assert.throws(() => save(config, { ...saved, recipes: [{ rootId: 'removed', relativePath: '', commands: [] }] }), /root|source/i);
  assert.deepEqual(fs.readFileSync(file), before);
  workspace.defaultRootId = 'b'; workspace.roots.reverse(); workspace.rootsRevision++;
  assert.throws(() => save(config, { ...saved, commands: [], recipes: [] }), /scope changed/); assert.deepEqual(fs.readFileSync(file), before);
  fs.writeFileSync(file, '{ broken configuration'); const corrupt = fs.readFileSync(file);
  assert.throws(() => read(config, 'ws'), /JSON|configuration|parse/i, 'invalid existing configuration must not reset');
  assert.deepEqual(fs.readFileSync(file), corrupt);
  queue.resetDelegateQueueForTests();
  assert.throws(() => queue.enqueueDelegate({ config: { get: () => config }, sessions: { listByWorkspace: () => [] } }, 'ws', { isolate: false, task: 'must not queue' }), /JSON|parse/i);
  assert.equal(queue.listDelegateQueue('ws').length, 0, 'failed configuration read cannot leave a queued task after reporting failure');
  for (const invalid of [null, [], 12, { git: null }, { git: [] }, { git: 'invalid' }]) {
    const bytes = JSON.stringify(invalid); fs.writeFileSync(file, bytes);
    assert.throws(() => read(config, 'ws'), /configuration/i);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
  fs.writeFileSync(file, before);
  const originalRead = fs.readFileSync;
  const denied = Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
  try {
    fs.readFileSync = function (target, ...args) {
      if (path.resolve(String(target)) === path.resolve(file)) throw denied;
      return originalRead.call(this, target, ...args);
    };
    assert.throws(() => read(config, 'ws'), error => error === denied);
    assert.throws(() => save(config, saved), error => error === denied);
  } finally { fs.readFileSync = originalRead; }
  assert.deepEqual(fs.readFileSync(file), before);
  console.log('worktree-preparation: scoped persistence, opaque multiline commands, stale version/root guard and corruption preservation passed');
} finally {
  queue.resetDelegateQueueForTests();
  const absolute = path.resolve(fixture), parent = path.resolve(project, '.tmp');
  assert.ok(absolute.startsWith(parent + path.sep)); fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
