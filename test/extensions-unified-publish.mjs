/**
 * Regression for the single-host convergence: authoring → review → installation
 * must accept the current manifest contract (surface/domain/agent/permissions,
 * no schemaVersion) and register the published package in the source-layout
 * catalog. Reverting validateExtensionPackage to the retired validator (which
 * required views/tools/background and rejected surface/domain/agent) turns the
 * "published" assertion red. Old-shape packages must be rejected.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-unified-publish-'));
try {
  const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
  const { ExtensionAuthoringServices } = await import(pathToFileURL(compile('main/extensions/extensionAuthoringServices.ts')));
  const { ExtensionSourceLayout } = await import(pathToFileURL(compile('main/extensions/extensionSourceLayout.ts')));
  const { ExtensionPackageCatalog } = await import(pathToFileURL(compile('main/extensions/extensionPackageCatalog.ts')));
  const { validateExtensionManifest } = await import(pathToFileURL(compile('shared/extensionManifest.ts')));

  const userData = path.join(temp, 'profile');
  const project = path.join(temp, 'project');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const globalRoot = path.join(userData, 'extensions', 'global');
  const layout = new ExtensionSourceLayout({ userData, globalRoot });
  const catalog = new ExtensionPackageCatalog({ layout, file: path.join(userData, 'registry.json') });
  const workspace = { id: 'ws', name: 'WS', path: project, controlRoot: project, rootsRevision: 0, defaultRootId: 'root', openedAt: 0, roots: [{ id: 'root', path: project, label: 'Root' }] };
  let changed = 0;
  let review = async () => ({ approved: true });
  const services = new ExtensionAuthoringServices({ userData, catalog, sourceLayout: layout, workspaces: () => [workspace], review: request => review(request), changed: () => { changed++; } });

  const newManifest = {
    id: 'newpkg', name: 'New Package', scope: 'global',
    surface: { kind: 'sidebar', entry: 'ui/panel.html' },
    domain: { entry: 'domain.mjs', queries: ['items.list'], commands: [], events: [] },
    agent: { profile: 'scheduler-pi', skills: [], mcp: [] },
    data: { workspace: true, shared: false }, permissions: ['agent.state']
  };

  // (a) The current contract flows through create → write → submit → catalog.
  const draft = await services.createDraft({ workspaceId: 'ws', sourceRootId: 'root', extensionId: 'newpkg', scope: 'global', owner: 'tester' });
  await services.writeDraft('ws', draft.draftId, 'extension.json', Buffer.from(JSON.stringify(newManifest)), 'tester');
  await services.writeDraft('ws', draft.draftId, 'ui/panel.html', Buffer.from('<!doctype html><p>panel</p>'), 'tester');
  await services.writeDraft('ws', draft.draftId, 'domain.mjs', Buffer.from('export function createDomainRuntime() { return { getSnapshot: async () => ({ version: 1, state: {}, availableCommands: [], capturedAt: new Date().toISOString() }) }; }'), 'tester');
  const result = await services.submitDraft('ws', draft.draftId, 'tester');
  assert.equal(result.status, 'published', `current-contract package must publish, got ${JSON.stringify(result)}`);
  assert.match(result.fingerprint, /^package-extension:[a-f0-9]{64}$/);
  assert.ok(changed > 0, 'publishing must notify listeners');

  const record = catalog.get('global', 'newpkg');
  assert.ok(record, 'published package must be registered in the catalog');
  const discovered = await layout.discover({ scope: 'global', extensionId: 'newpkg' });
  assert.equal(record.fingerprint, discovered.fingerprint, 'catalog fingerprint must match a fresh source discovery');
  assert.equal(record.surfaceKind, 'sidebar');
  const installed = layout.resolve({ scope: 'global', extensionId: 'newpkg' }).directory;
  assert.ok(fs.existsSync(path.join(installed, 'extension.json')), 'package must be installed into the source layout the catalog scans');
  assert.ok(fs.existsSync(path.join(installed, 'domain.mjs')));
  const listing = await services.list('ws', 'root');
  assert.ok(listing.global.some(item => item.id === 'newpkg' && item.status === 'approved'), 'listing must surface the installed package');

  // A valid package installed outside the authoring flow has no review record.
  const installedPanel = path.join(installed, 'ui', 'panel.html');
  const originalPanel = await fs.promises.readFile(installedPanel);
  await fs.promises.writeFile(installedPanel, '<!doctype html><p>updated locally</p>');
  const unreviewed = (await services.list('ws', 'root')).global.find(item => item.id === 'newpkg');
  const managed = (await services.list('ws', 'root', 'installed')).global.find(item => item.id === 'newpkg');
  assert.equal(unreviewed.status, 'pending');
  assert.equal(managed.status, 'installed');
  assert.equal(managed.sourceKind, 'local');
  assert.equal(managed.fingerprint, unreviewed.fingerprint);
  await fs.promises.writeFile(installedPanel, originalPanel);

  // (b) Old-shape packages are rejected by the current validator and the chain.
  const oldShape = { id: 'oldpkg', name: 'Old', scope: 'global', schemaVersion: 1, views: [{ id: 'main', entry: 'panel.html', permissions: [] }], tools: [], data: { workspace: true, shared: false } };
  assert.equal(validateExtensionManifest(oldShape, 'oldpkg').ok, false, 'schemaVersion/views/tools must be rejected');
  assert.equal(validateExtensionManifest({ ...newManifest, background: { entry: 'domain.mjs' } }, 'newpkg').ok, false, 'removed background field must be rejected');

  const oldDraft = await services.createDraft({ workspaceId: 'ws', sourceRootId: 'root', extensionId: 'oldpkg', scope: 'global', owner: 'tester' });
  await services.writeDraft('ws', oldDraft.draftId, 'extension.json', Buffer.from(JSON.stringify(oldShape)), 'tester');
  await services.writeDraft('ws', oldDraft.draftId, 'panel.html', Buffer.from('<p>old</p>'), 'tester');
  await assert.rejects(() => services.submitDraft('ws', oldDraft.draftId, 'tester'), /未知字段|已移除/, 'old-shape package must not publish');
  assert.equal(catalog.get('global', 'oldpkg'), undefined, 'rejected package must not enter the catalog');

  // Edit exactly the version advertised by list; preserve unrelated on-disk edits.
  const input = { workspaceId: 'ws', sourceRootId: 'root', extensionId: 'newpkg', scope: 'global', owner: 'tester' };
  const listed = listing.global.find(pkg => pkg.id === 'newpkg');
  assert.equal(listed.fingerprint, result.fingerprint);
  const update = await services.createDraft({ ...input, expectedFingerprint: listed.fingerprint });
  await services.writeDraft('ws', update.draftId, 'ui/panel.html', Buffer.from('revision two'), 'tester');
  const external = path.join(installed, 'external.txt');
  fs.writeFileSync(external, 'concurrent edit');
  assert.equal((await services.submitDraft('ws', update.draftId, 'tester')).status, 'stale');
  assert.equal(fs.readFileSync(external, 'utf8'), 'concurrent edit');
  fs.unlinkSync(external);
  for (const name of ['data', 'cache', '.git']) {
    fs.mkdirSync(path.join(installed, name));
    fs.writeFileSync(path.join(installed, name, 'keep'), name);
  }
  assert.equal((await services.submitDraft('ws', update.draftId, 'tester')).status, 'published');
  assert.equal(fs.readFileSync(path.join(installed, 'ui/panel.html'), 'utf8'), 'revision two');

  const { publishExtensionPackageDirectory, captureExtensionPackage } = await import(pathToFileURL(compile('main/extensions/extensionPackageSnapshot.ts')));
  const snapshot = captureExtensionPackage(installed);
  await assert.rejects(publishExtensionPackageDirectory(installed, snapshot, { root: userData }), /already exists/);
  let moves = 0;
  await assert.rejects(publishExtensionPackageDirectory(installed, snapshot, {
    root: userData, expectedFingerprint: snapshot.fingerprint, privateRename(from, to) {
      if (++moves === 2) throw new Error('locked private directory');
      fs.renameSync(from, to);
    }
  }), /locked private directory/);
  assert.equal(captureExtensionPackage(installed).fingerprint, snapshot.fingerprint);
  for (const name of ['data', 'cache', '.git']) assert.equal(fs.readFileSync(path.join(installed, name, 'keep'), 'utf8'), name);
  assert.deepEqual(fs.readdirSync(globalRoot), ['newpkg']);
  const link = path.join(project, 'redirect'), elsewhere = path.join(temp, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(publishExtensionPackageDirectory(path.join(link, 'child', 'newpkg'), snapshot, { root: project }), /real directory/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);

  const competingDrafts = await Promise.all(['first editor', 'second editor'].map(async text => {
    const edit = await services.createDraft({ ...input, expectedFingerprint: snapshot.fingerprint });
    await services.writeDraft('ws', edit.draftId, 'ui/panel.html', Buffer.from(text), 'tester');
    return edit;
  }));
  const concurrent = await Promise.all(competingDrafts.map(edit => services.submitDraft('ws', edit.draftId, 'tester')));
  assert.deepEqual(concurrent.map(result => result.status).sort(), ['published', 'stale']);
  assert.equal(captureExtensionPackage(installed).fingerprint, concurrent.find(result => result.status === 'published').fingerprint);

  const { ExtensionAuthoringService } = await import(pathToFileURL(compile('main/extensions/extensionAuthoring.ts')));
  const author = new ExtensionAuthoringService(services, () => [workspace]);
  const rootCaller = { workspaceId: 'ws', sourceRootId: 'root', actor: 'tester' };
  async function createProject(caller, id) {
    const info = await author.execute(caller, { action: 'inspect' });
    const draft = await author.execute(caller, { action: 'create', params: { id, scope: 'project' } });
    const manifest = { ...newManifest, id, scope: 'project', project: info.projectBinding };
    for (const [file, text] of [['extension.json', JSON.stringify(manifest)], ['domain.mjs', 'export default {}'], ['ui/panel.html', id]]) {
      await author.execute(caller, { action: 'write', params: { draftId: draft.draftId, path: file, text } });
    }
    return author.execute(caller, { action: 'submit', params: { draftId: draft.draftId } });
  }
  assert.equal((await createProject(rootCaller, 'newpkg')).status, 'published', 'host-generated dot binding');
  const second = path.join(project, 'side');
  fs.mkdirSync(second);
  workspace.roots.push({ id: 'side', path: second, label: 'Side' });
  assert.equal((await createProject({ ...rootCaller, sourceRootId: 'side' }, 'sidepkg')).status, 'published');
  assert.ok(catalog.get('project', 'sidepkg', second));
  assert.deepEqual((await services.list('ws', 'root')).project.map(item => item.id), ['newpkg']);
  assert.deepEqual((await services.list('ws', 'side')).project.map(item => item.id), ['sidepkg']);
  await assert.rejects(author.execute(rootCaller, { action: 'retryReview', params: { id: 'newpkg' } }), /scope/);
  const projectFile = path.join(layout.project(project, 'newpkg').directory, 'ui', 'panel.html');
  fs.writeFileSync(projectFile, 'manually changed project');
  assert.equal((await services.list('ws', 'root')).project[0].status, 'pending');
  review = async () => ({ approved: false, reason: 'missing documentation' });
  const rejected = await author.execute(rootCaller, { action: 'retryReview', params: { id: 'newpkg', scope: 'project' } });
  assert.equal(rejected.status, 'rejected');
  const reviewed = await services.list('ws', 'root');
  assert.equal(reviewed.project[0].reason, 'missing documentation');
  assert.equal(reviewed.project[0].status, 'rejected');
  assert.equal(reviewed.global[0].status, 'approved');

  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  let reviewSignal;
  review = async request => { reviewSignal = request.signal; started.resolve(); await finish.promise; return { approved: true }; };
  const outstanding = services.retryReview('ws', 'root', 'newpkg', undefined, 'project');
  await started.promise;
  let stopped = false;
  const stopping = services.stop().then(() => { stopped = true; });
  assert.equal(reviewSignal.aborted, true);
  assert.equal((await outstanding).status, 'stale');
  assert.equal(stopped, false, 'shutdown waits for the accepted reviewer');
  await assert.rejects(services.retryReview('ws', 'root', 'newpkg'), /stopped/);
  finish.resolve();
  await stopping;
  assert.equal(stopped, true);

  console.log('extensions-unified-publish: ok');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
