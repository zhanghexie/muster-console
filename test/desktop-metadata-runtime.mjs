import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-metadata-runtime-'));
try {
  const compile = createSharedCompiler(process.cwd(), temp);
  const { DesktopMetadataRuntime } = await import(pathToFileURL(compile('main/desktop/metadataRuntime.ts')));
  const rows = [];
  let current = true, disposed = false, closed = false, release;
  const actor = { sessionId: 'worker', taskId: 'read-id', isCurrent: () => current };
  const registry = { refresh: () => ({ surfaces: [], omitted: 0 }), dispose: () => { disposed = true; } };
  const audit = { append: row => { rows.push(row); }, close: () => { closed = true; } };
  const windows = { runtime: 'windows', observations: [], complete: true, omitted: 0, limitations: [], capabilities: {} };
  const service = new DesktopMetadataRuntime(registry, () => new Promise(resolve => { release = resolve; }), audit);
  const pending = service.list(actor); release(windows);
  assert.equal((await pending).windows.ok, true);
  assert.deepEqual(rows.map(row => [row.action, row.stage, row.result]), [['list', 'read', 'allowed']]);
  const stale = service.list(actor); current = false; release(windows);
  await assert.rejects(stale, /no longer current/);
  assert.equal(rows.at(-1).result, 'failed');
  current = true;
  const brokenAudit = new DesktopMetadataRuntime(registry, async () => windows, { append: () => { throw new Error('audit unavailable'); }, close() {} });
  await assert.rejects(brokenAudit.list(actor), /audit could not be recorded/);
  const partial = new DesktopMetadataRuntime(registry, async () => { throw new Error('Wayland unavailable'); }, audit);
  assert.deepEqual((await partial.list(actor)).windows, { ok: false, error: 'Wayland unavailable' });
  assert.equal(rows.at(-1).result, 'allowed');
  const { listDesktop, desktopHost } = await import(pathToFileURL(compile('main/capabilities/hosts/desktop.ts')));
  const { runAsAgentSession, runAsAgentWorkspace, runAsSchedulerTool } = await import(pathToFileURL(compile('main/agent/agentScope.ts')));
  const { sourcePathKey } = await import(pathToFileURL(compile('main/workspacePaths.ts')));
  const workspacePath = path.join(temp, 'workspace'); fs.mkdirSync(workspacePath);
  const workspace = { id: 'workspace', name: 'Workspace', path: workspacePath, rootsRevision: 1,
    defaultRootId: 'root', controlRoot: workspacePath, roots: [{ id: 'root', path: workspacePath }] };
  const session = { workspaceId: 'workspace', archived: false }, token = {};
  const scope = { workspaceId: 'workspace', cwd: workspacePath, roots: [{ rootId: 'root', path: workspacePath }],
    controlPhysicalPath: sourcePathKey(workspacePath), readableDirectories: [{ path: workspacePath, physicalPath: sourcePathKey(workspacePath) }] };
  const runtime = new DesktopMetadataRuntime(registry, async () => windows, audit);
  const ctx = { config: { get: () => ({ activeWorkspaceId: 'workspace', workspaces: [workspace] }) },
    sessions: { peek: id => id === 'worker' ? session : undefined, sessionScopeToken: () => token, isChatRuntime: () => true },
    agentSessions: { getWorkspaceContext: () => scope }, desktopMetadata: () => runtime };
  await assert.rejects(listDesktop(ctx), /authenticated workspace/);
  await runAsAgentSession('worker', async () => {
    const listed = await listDesktop(ctx);
    if (process.platform === 'win32') {
      assert.equal(listed.capabilities.capture.available, false, 'unwired capture is unavailable');
      const connected = await listDesktop({ ...ctx, desktopScreen: () => ({}), desktopControl: () => ({}) });
      assert.equal(connected.capabilities.capture.available, true, 'wired Windows capture is available');
      assert.equal(connected.capabilities.foregroundInput.available, true);
      assert.equal(connected.capabilities.activate.available, true);
      assert.equal(connected.capabilities.semanticRead.available, false);
      assert.equal(connected.capabilities.backgroundInput.available, false);
    }
  });
  assert.equal(rows.at(-1).sessionId, 'worker');
  assert.match(rows.at(-1).taskId, /^metadata:/);
  const countBeforeUnsupported = rows.length;
  await runAsAgentSession('worker', async () => {
    for (const action of ['act', 'focus', 'launch']) {
      const args = action === 'act' ? { requestId: 'fixture', surfaceId: 'display', action: 'click', target: { windowId: 'window' } }
        : action === 'focus' ? { requestId: 'fixture', surfaceId: 'window' } : { requestId: 'fixture', appId: 'fixture.exe' };
      if (process.platform === 'win32') await assert.rejects(desktopHost[`desktop.${action}`](ctx, args), /backend is unavailable/);
      else {
        const result = await desktopHost[`desktop.${action}`](ctx, args);
        assert.equal(result.ok, false); assert.equal(result.code, 'capability_unsupported');
        assert.equal(result.action, action);
      }
    }
  });
  assert.equal(rows.length, countBeforeUnsupported, 'unsupported operations do not capture or dispatch');
  await runAsAgentWorkspace('workspace', () => runAsSchedulerTool(async () => { await listDesktop(ctx); }));
  assert.equal(rows.at(-1).sessionId, 'orchestrator:workspace');
  const longText = '\\'.repeat(1000), limitations = [longText, longText, longText, 'metadata_only_not_actionable'];
  const huge = { displays: { omitted: 0, surfaces: Array.from({ length: 18 }, (_, i) => ({ surfaceId: `display-${i}`,
    surfaceGeneration: 'generation', geometryRevision: 'geometry', title: longText, bounds: { x: 0, y: 0, width: 100, height: 100 },
    scaleFactor: 1, rotation: 0, coordinateSpace: 'electron-dip' })) }, windows: { ok: true, data: {
    runtime: 'windows', complete: true, omitted: 0, limitations, capabilities: {}, observations: Array.from({ length: 25 }, (_, i) => ({
      observationId: `window-${i}`, title: longText, appLabel: longText, pid: 42, coordinateSpace: 'win32-screen-caller-dpi',
      bounds: { x: 0, y: 0, width: 100, height: 100 }, limitations })) } } };
  const largeCtx = { ...ctx, desktopMetadata: () => ({ list: async () => huge }) };
  await runAsAgentSession('worker', async () => {
    const first = await listDesktop(largeCtx, { limit: 10 });
    assert.ok(JSON.stringify({ ok: true, result: first }).length <= 10_500);
    assert.ok(first.windows.ok); assert.equal(first.windows.data.observations[0].titleTruncated, true);
    assert.equal(first.windows.data.observations[0].limitationsTruncated, true);
    assert.ok(first.windows.data.observations[0].limitations.includes('metadata_only_not_actionable'));
    assert.ok(first.windows.data.nextOffset > 0); assert.ok(first.displays.nextOffset > 0);
    const second = await listDesktop(largeCtx, { limit: 10, windowOffset: first.windows.data.nextOffset, displayOffset: first.displays.nextOffset });
    assert.notEqual(second.windows.data.observations[0].observationId, first.windows.data.observations[0].observationId);
    await assert.rejects(listDesktop(largeCtx, { limit: 11 }), /Invalid desktop metadata page/);
  });
  session.archived = true;
  await runAsAgentSession('worker', async () => { await assert.rejects(listDesktop(ctx), /caller session read scope/); });
  const shutdownPending = service.list(actor);
  service.close(); release(windows);
  await assert.rejects(shutdownPending, /abort/i);
  await assert.rejects(service.list(actor), /abort/i);
  assert.equal(disposed, true); assert.equal(closed, true);
  console.log('desktop metadata runtime: audited disclosure, stale caller, audit failure and partial inventory passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
