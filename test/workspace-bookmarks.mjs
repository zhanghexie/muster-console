import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-bookmarks-'));
const compile = createSharedCompiler(path.resolve(import.meta.dirname, '..'), path.join(tmp, 'compiled'));
try {
  const { WorkspaceBookmarksStore } = await import(pathToFileURL(compile('main/metaAgent/workspaceBookmarks.ts')).href);
  const { patchWorkspaceFile } = await import(pathToFileURL(compile('main/metaAgent/workspaceFile.ts')).href);
  const store = new WorkspaceBookmarksStore();
  const owner = () => {};
  const layout = { version: 1, tabs: [], selected: {}, panel: 'browser', collapsed: false };
  const tree = [{ id: 'folder', label: 'Sources', children: [
    { id: 'one', label: 'Reference', url: 'https://example.test/', dateAdded: 12, description: 'Notes', favicon: 'data:image/png;base64,ZmFrZQ==' }
  ] }];
  const workspace = async (id, rightWorkspace) => {
    const root = path.join(tmp, id), dir = path.join(root, '.muster');
    await fs.mkdir(dir, { recursive: true });
    const config = path.join(dir, 'workspace.json');
    const bookmarks = path.join(dir, 'bookmarks.json');
    await fs.writeFile(config, JSON.stringify({ hVirtualScreen: true, rightWorkspace }), 'utf8');
    return { root, config, bookmarks };
  };
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  const a = await workspace('a', { ...layout, bookmarks: tree, bookmarkDefaultsVersion: 1 });
  const b = await workspace('b', { ...layout, bookmarks: [], bookmarkDefaultsVersion: 1 });
  const missingDefaults = await workspace('fresh', undefined);
  assert.equal((await store.read(missingDefaults.root, owner)).snapshot.bookmarkDefaultsVersion, 1);
  assert.equal((await read(missingDefaults.bookmarks)).bookmarks.length, 4);

  let checks = 0;
  await assert.rejects(store.read(a.root, () => {
    if (++checks === 4) throw new Error('cancel before publish');
  }), /cancel before publish/);
  assert.deepEqual((await read(a.config)).rightWorkspace.bookmarks, tree);
  await assert.rejects(fs.stat(a.bookmarks), { code: 'ENOENT' });

  checks = 0;
  const interrupted = await store.read(a.root, () => {
    if (++checks === 4) patchWorkspaceFile(a.root, { rightWorkspace: { ...layout, collapsed: true } });
    if (checks === 5) throw new Error('interrupt cleanup');
  });
  assert.equal(interrupted.cleanupError, 'interrupt cleanup');
  assert.deepEqual((await read(a.bookmarks)).bookmarks, tree);
  assert.deepEqual((await read(a.config)).rightWorkspace.bookmarks, tree);

  const reopened = new WorkspaceBookmarksStore();
  assert.deepEqual((await reopened.read(a.root, owner)).snapshot.bookmarks, tree);
  assert.equal((await read(a.bookmarks)).migratedLegacy, undefined);
  const configAfter = await read(a.config);
  assert.deepEqual(configAfter.rightWorkspace, { ...layout, collapsed: true });
  assert.equal(configAfter.hVirtualScreen, true);
  assert.deepEqual((await reopened.read(b.root, owner)).snapshot.bookmarks, []);
  assert.equal((await read(b.bookmarks)).bookmarkDefaultsVersion, 1);

  const diskBeforeTab = await fs.readFile(a.bookmarks, 'utf8');
  patchWorkspaceFile(a.root, { rightWorkspace: { ...layout, panel: 'files', bookmarks: tree } });
  assert.equal(await fs.readFile(a.bookmarks, 'utf8'), diskBeforeTab);
  assert.equal((await read(a.config)).rightWorkspace.bookmarks, undefined);
  const configBeforeEdits = await fs.readFile(a.config, 'utf8');
  const [renamed, added] = await Promise.all([
    reopened.change(a.root, owner, { kind: 'update', id: 'one', label: 'Renamed' }),
    reopened.change(a.root, owner, { kind: 'add', parentId: 'folder', node: { id: 'two', label: 'Next', url: 'https://two.test/' } })
  ]);
  assert.equal(renamed.bookmarks[0].children[0].label, 'Renamed');
  assert.deepEqual(added.bookmarks[0].children.map(node => node.label), ['Renamed', 'Next']);
  assert.equal(await fs.readFile(a.config, 'utf8'), configBeforeEdits);
  assert.deepEqual((await reopened.read(b.root, owner)).snapshot.bookmarks, []);
  // Windows file watchers/indexers can briefly lock the destination during replacement.
  const rename = fs.rename;
  let renameCalls = 0;
  fs.rename = async (from, to) => {
    if (to === a.bookmarks && ++renameCalls === 1) throw Object.assign(new Error('transient lock'), { code: 'EPERM' });
    return rename(from, to);
  };
  try {
    await reopened.change(a.root, owner, { kind: 'remove', ids: ['folder'] });
  } finally {
    fs.rename = rename;
  }
  assert.ok(renameCalls >= 2);
  assert.deepEqual((await new WorkspaceBookmarksStore().read(a.root, owner)).snapshot.bookmarks, []);

  const malformed = await workspace('malformed', { ...layout, bookmarks: tree, bookmarkDefaultsVersion: 1 });
  await fs.writeFile(malformed.bookmarks, '{bad JSON');
  await assert.rejects(reopened.read(malformed.root, owner), SyntaxError);
  await assert.rejects(reopened.change(malformed.root, owner, { kind: 'remove', ids: ['folder'] }), SyntaxError);
  assert.equal(await fs.readFile(malformed.bookmarks, 'utf8'), '{bad JSON');
  assert.deepEqual((await read(malformed.config)).rightWorkspace.bookmarks, tree);
  console.log('workspace bookmarks: verified migration, interrupted cleanup, dedicated writes, queued edits and empty restoration');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
