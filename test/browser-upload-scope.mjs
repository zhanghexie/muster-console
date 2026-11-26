import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-upload-scope-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { resolveUploadFiles, snapshotUploadFiles, cleanupAbandonedUploadSnapshots } = await import(pathToFileURL(compile('main/browser/uploadFiles.ts')));
  const { sourcePathKey } = await import(pathToFileURL(compile('main/workspacePaths.ts')));
  const { uploadScope } = await import(pathToFileURL(compile('main/browser/uploadScope.ts')));
  const { runAsAgentSession, runAsAgentWorkspace, runAsSchedulerTool } = await import(pathToFileURL(compile('main/agent/agentScope.ts')));
  const { safetyRisk, operationFingerprint } = await import(pathToFileURL(compile('main/safety/policy.ts')));
  const allowed = path.join(temp, 'allowed'), outside = path.join(temp, 'outside');
  fs.mkdirSync(allowed); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(allowed, 'a.txt'), 'allowed');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  const dirs = [{ path: allowed, physicalPath: sourcePathKey(allowed) }];
  const config = { activeWorkspaceId: 'w', workspaces: [{ id: 'w', path: allowed }] };
  const captured = { workspaceId: 'w', cwd: allowed, controlRoot: allowed, controlPhysicalPath: sourcePathKey(allowed),
    roots: [], readableDirectories: dirs };
  const session = { workspaceId: 'w', archived: false, runtime: 'gui' };
  let sessionToken = {};
  let guiScope = captured, cliLease;
  const ctx = { config: { get: () => config }, agentSessions: { getWorkspaceContext: id => id === 'session' ? captured : undefined },
    sessions: { peek: id => id === 'session' ? session : undefined,
      sessionScopeToken: id => id === 'session' && !session.archived ? sessionToken : undefined,
      isChatRuntime: runtime => runtime === 'gui', getCliWorkspaceContext: () => cliLease } };
  ctx.agentSessions.getWorkspaceContext = id => id === 'session' ? guiScope : undefined;
  assert.throws(() => uploadScope(ctx), /authenticated/);
  await runAsAgentSession('session', async () => {
    assert.equal(uploadScope(ctx).cwd, allowed);
    assert.throws(() => uploadScope(ctx, 'other'), /caller session/);
    const scope = uploadScope(ctx);
    session.archived = true;
    assert.throws(() => scope.assertCurrent(), /no longer current/);
    sessionToken = {}; session.archived = false;
    assert.throws(() => scope.assertCurrent(), /no longer current/, 'archive followed by restore cannot revive a captured scope');
    assert.doesNotThrow(() => uploadScope(ctx).assertCurrent());
  });
  await runAsAgentSession('unknown', async () => assert.throws(() => uploadScope(ctx), /caller session/));
  session.runtime = 'cli';
  guiScope = { ...captured, cwd: outside, readableDirectories: [{ path: outside, physicalPath: sourcePathKey(outside) }] };
  cliLease = { workspaceContext: captured };
  await runAsAgentSession('session', async () => {
    const scope = uploadScope(ctx);
    assert.equal(scope.cwd, allowed, 'CLI must use its launch-time lease, never a freshly reconstructed GUI scope');
    assert.deepEqual(scope.dirs, dirs);
    cliLease = { workspaceContext: captured };
    assert.throws(() => scope.assertCurrent(), /no longer current/, 'a replacement CLI process invalidates the old scope');
    cliLease = undefined;
    assert.throws(() => uploadScope(ctx), /caller session/, 'missing CLI lease fails closed');
  });
  session.runtime = 'gui'; guiScope = captured;
  const guiEntry = { turnWorkspaceContext: captured };
  ctx.agentSessions.entries = new Map([['session', guiEntry]]);
  await runAsAgentSession('session', async () => {
    const scope = uploadScope(ctx);
    guiEntry.turnWorkspaceContext = { ...captured };
    assert.throws(() => scope.assertCurrent(), /no longer current/, 'a new GUI turn cannot revive an old scope');
  });
  await runAsAgentWorkspace('w', () => runAsSchedulerTool(async () => {
    const scope = uploadScope(ctx);
    assert.equal(scope.cwd, allowed);
    assert.throws(() => uploadScope(ctx, 'other'), /authenticated/);
    config.workspaces[0].rootsRevision = 1;
    assert.throws(() => scope.assertCurrent(), /scope changed/);
    delete config.workspaces[0].rootsRevision;
  }));
  assert.deepEqual(resolveUploadFiles(['a.txt'], allowed, dirs), [fs.realpathSync.native(path.join(allowed, 'a.txt'))]);
  assert.deepEqual(resolveUploadFiles([], allowed, dirs), []);
  assert.throws(() => resolveUploadFiles(['../outside/secret.txt'], allowed, dirs), /outside/);
  assert.throws(() => resolveUploadFiles([path.join(outside, 'secret.txt')], allowed, dirs), /outside/);
  assert.throws(() => resolveUploadFiles(['.'], allowed, dirs), /not a readable file/);
  assert.throws(() => resolveUploadFiles(['missing.txt'], allowed, dirs));
  assert.throws(() => resolveUploadFiles([''], allowed, dirs), /non-empty/);
  assert.throws(() => resolveUploadFiles('a.txt', allowed, dirs), /array/);
  assert.throws(() => resolveUploadFiles(['a.txt'], allowed, [{ path: allowed, physicalPath: sourcePathKey(outside) }]), /stale/);
  const alias = path.join(allowed, 'outside-alias');
  try { fs.symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { throw new Error(`Cannot create fixture directory link: ${error.message}`); }
  assert.throws(() => resolveUploadFiles([path.join(alias, 'secret.txt')], allowed, dirs), /outside/);
  const snapshot = await snapshotUploadFiles(['a.txt', 'a.txt'], allowed, dirs);
  assert.equal(snapshot.paths.length, 2);
  assert.equal(snapshot.objects[0].size, 7);
  assert.match(snapshot.objects[0].sha256, /^[a-f0-9]{64}$/);
  const operation = { action: 'browser.fileAssignment', workspaceId: 'w', source: 'catalog', dangerous: true,
    args: { tabId: 'b', target: '#file', documentUrl: 'https://site/', frameUrl: 'https://frame/', files: snapshot.objects } };
  assert.equal(safetyRisk(operation), 'high');
  assert.notEqual(operationFingerprint(operation), operationFingerprint({ ...operation, args: { ...operation.args, frameUrl: 'https://other/' } }));
  assert.notEqual(operationFingerprint(operation), operationFingerprint({ ...operation, args: { ...operation.args,
    files: [{ ...snapshot.objects[0], sha256: 'different' }] } }));
  assert.equal(path.basename(snapshot.paths[0]), 'a.txt');
  fs.writeFileSync(path.join(allowed, 'a.txt'), 'changed later');
  assert.equal(fs.readFileSync(snapshot.paths[0], 'utf8'), 'allowed');
  assert.equal(fs.readFileSync(snapshot.paths[1], 'utf8'), 'allowed');
  await snapshot.cleanup();
  assert.equal(fs.existsSync(snapshot.paths[0]), false);
  const large = path.join(allowed, 'large.bin');
  const largeFd = fs.openSync(large, 'w');
  try { fs.ftruncateSync(largeFd, 50 * 1024 * 1024); } finally { fs.closeSync(largeFd); }
  await assert.rejects(snapshotUploadFiles(['large.bin'], allowed, dirs), /less than 50 MiB/);
  const abandoned = path.join(temp, 'muster-upload-11-abc123');
  const live = path.join(temp, 'muster-upload-12-def456');
  const unowned = path.join(temp, 'muster-upload-13-ghi789');
  for (const dir of [abandoned, live, unowned]) {
    fs.mkdirSync(dir);
    if (dir !== unowned) fs.writeFileSync(path.join(dir, '.owner'), 'muster-upload-snapshot-v1');
    fs.utimesSync(dir, new Date(1000), new Date(1000));
  }
  await cleanupAbandonedUploadSnapshots(1000 + 25 * 60 * 60 * 1000, temp, pid => pid === 12);
  assert.equal(fs.existsSync(abandoned), false, 'old snapshot from dead process is reclaimed');
  assert.equal(fs.existsSync(live), true, 'live process snapshot remains');
  assert.equal(fs.existsSync(unowned), true, 'unowned similarly named directory remains');
  console.log('browser upload: caller read scope, stale roots and link escape checks passed');
} finally {
  const resolved = fs.realpathSync(temp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('browser-upload-scope-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
