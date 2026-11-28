import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, desktopCapturer, nativeImage, powerMonitor, screen } from 'electron';
import { runAsAgentSession, runAsGuiExecutionTurn } from '../../../src/main/agent/agentScope';
import { executeTool } from '../../../src/main/capabilities/executor';
import type { AppContext } from '../../../src/main/context';
import { resolveCuaDriverPath } from '../../../src/main/desktop/cuaDriverPath';
import { CuaTransport } from '../../../src/main/desktop/cuaTransport';
import { DesktopIndicatorWindow } from '../../../src/main/desktop/desktopIndicatorWindow';
import { ElectronDisplayRegistry } from '../../../src/main/desktop/displayRegistry';
import { createIdempotentDesktopComposition } from '../../../src/main/desktop/idempotentDesktopComposition';
import { createMacDesktopHost } from '../../../src/main/desktop/macDesktopHost';
import { readMacWindow } from '../../../src/main/desktop/macInventory';
import { MacWindowIdentity } from '../../../src/main/desktop/macWindowIdentity';
import { createMacWindowNative } from '../../../src/main/desktop/macWindowNative';
import { DesktopScreenRuntime } from '../../../src/main/desktop/screenRuntime';
import { sourcePathKey } from '../../../src/main/workspacePaths';

const data = process.env.MUSTER_TEST_USER_DATA;
if (!data || !path.isAbsolute(data) || process.platform !== 'darwin') throw new Error('macOS fixture userData is required');
const isTarget = process.argv.includes('--mac-desktop-fixture-target');
const targetData = path.join(data, 'target');
if (isTarget) fs.mkdirSync(targetData, { recursive: true });
app.setPath('userData', isTarget ? targetData : data);

async function runTarget() {
  await app.whenReady();
  const work = screen.getPrimaryDisplay().workArea;
  const title = `Muster desktop fixture ${process.pid}`;
  const window = new BrowserWindow({ x: Math.round(work.x + (work.width - 380) / 2), y: Math.round(work.y + (work.height - 220) / 2),
    width: 380, height: 220, show: false, title });
  await window.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0"><input id="field" style="position:absolute;left:40px;top:65px;width:220px;height:40px" onclick="window.clicks=(window.clicks||0)+1" aria-label="Fixture input"></body>'));
  window.setTitle(title);
  window.show();
  const commands = createInterface({ input: process.stdin });
  process.stdout.write(JSON.stringify({ title, nativeId: Number(window.getMediaSourceId().split(':')[1]), bounds: window.getContentBounds() }) + '\n');
  for await (const command of commands) {
    if (command === 'quit') break;
    if (command === 'move') {
      const bounds = window.getBounds();
      window.setBounds({ ...bounds, x: bounds.x + 30, y: bounds.y + 20, width: bounds.width + 30 });
      await delay(250);
    }
    const state = await window.webContents.executeJavaScript('({ clicks: window.clicks || 0, value: document.getElementById("field").value })');
    process.stdout.write(JSON.stringify({ ...state, focused: window.isFocused(), bounds: window.getBounds(), contentBounds: window.getContentBounds() }) + '\n');
  }
  app.exit(0);
}

async function main(userData: string) {
  await app.whenReady();
  const primary = screen.getPrimaryDisplay(), work = primary.workArea;
  const other = new BrowserWindow({ x: work.x + 30, y: work.y + 70, width: 220, height: 165, show: false, title: 'Second fixture' });
  const sessionId = 'mac-desktop-fixture', workspaceId = 'workspace', desktopTurnId = 'fixture-desktop-turn';
  const physicalPath = sourcePathKey(userData);
  const workspace = { id: workspaceId, name: 'Fixture', path: userData, rootsRevision: 1, controlRoot: userData,
    defaultRootId: 'root', roots: [{ id: 'root', path: userData }] };
  const session = { name: 'Fixture', workspaceId, archived: false }, token = {};
  let current = true;
  const registry = new ElectronDisplayRegistry(screen, powerMonitor);
  const driverPath = () => resolveCuaDriverPath({ platform: 'darwin', arch: process.arch, isPackaged: false, appPath: process.cwd(), resourcesPath: process.resourcesPath });
  const host = createMacDesktopHost({ composition: createIdempotentDesktopComposition(path.join(userData, 'receipts')),
    labels: { active: 'Desktop fixture', stopping: 'Stopping', unknown: 'Unknown', escape: 'Escape', stop: 'Stop', escapeUnavailable: 'Click Stop' },
    createIndicator(stop, unavailable) {
      const indicator = new DesktopIndicatorWindow(stop, unavailable, path.resolve('out/preload/desktopIndicator.js'), path.resolve('out/renderer'));
      indicator.registerIpc();
      return indicator;
    }, driverPath, reportStopError: error => { console.error('MAC_DESKTOP_FIXTURE_CLEANUP', error); } });
  const ctx = { ...host, config: { get: () => ({ activeWorkspaceId: workspaceId, workspaces: [workspace] }) },
    sessions: { get: () => session, peek: () => session, sessionScopeToken: () => token, isChatRuntime: () => true },
    agentSessions: { getWorkspaceContext: () => ({ workspaceId, cwd: userData, roots: [{ rootId: 'root', path: userData }],
      controlPhysicalPath: physicalPath, readableDirectories: [{ path: userData, physicalPath }] }) },
    desktopWorkerTask: () => ({ epochs: { capture: () => ({ generation: 1, isCurrent: () => current }) } }),
    desktopMetadata: () => ({ displayRegistry: () => registry }) };
  const screenRuntime = new DesktopScreenRuntime(ctx as unknown as AppContext, userData, registry,
    { confirm: async () => { throw new Error('Unexpected desktop confirmation'); } }, options => desktopCapturer.getSources(options),
    png => nativeImage.createFromBuffer(png), host.visibilityEpoch);
  const toolContext = { ...ctx, desktopScreen: () => screenRuntime } as unknown as AppContext;
  const turn = { sessionId, turnId: 'fixture-turn', desktopTurnId, isCurrent: () => current, isDesktopCurrent: () => current };
  const call = (action: string, params: object) => runAsGuiExecutionTurn(turn, () => runAsAgentSession(sessionId,
    () => executeTool(toolContext, 'desktop.run', JSON.stringify({ action, params }))));
  const success = async (action: string, params: { action?: string; requestId?: string; [key: string]: unknown }) => {
    const frame = await call(action, params);
    assert.equal(frame.ok, true, `${action} ${params.requestId ?? ''}: ${frame.error ?? frame.code}`);
    return frame.result as any;
  };
  const target = spawn(process.execPath, [process.argv[1]!, '--mac-desktop-fixture-target'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const targetExited = once(target, 'exit');
  const output = createInterface({ input: target.stdout });
  const replies = output[Symbol.asyncIterator]();
  const readTarget = async () => {
    const response = await replies.next();
    assert.ok(!response.done, 'Fixture target exited before its state was read');
    return JSON.parse(response.value);
  };
  const targetState = () => { target.stdin.write('state\n'); return readTarget(); };
  try {
    const { title, nativeId } = await readTarget();
    await other.loadURL('about:blank');
    other.show(); other.focus();
    const status = host.desktopMac.status();
    const setupMessage = `The real Electron process needs the pinned driver and macOS grants. ${JSON.stringify(status)}`;
    assert.deepEqual(status.permissions, { accessibility: true, screenRecording: true }, setupMessage);
    assert.ok(!status.driverError && !status.targetError && !status.sessionError, setupMessage);
    const observed = readMacWindow(nativeId);
    assert.ok(observed?.onScreen, 'The native window inventory must include the fixture');
    let canResolveWindow = true;
    try {
      MacWindowIdentity.acquire(createMacWindowNative(host.desktopMac.permissions), observed.pid, observed.windowId).close();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('Accessibility window mapping is unavailable')) throw error;
      canResolveWindow = false;
    }
    host.desktopTurns().begin(sessionId, desktopTurnId, () => current);
    const apps = await success('list', { view: 'applications', limit: 2 });
    assert.ok(apps.applications.total > 0);
    assert.ok(apps.applications.apps.some((item: { appId?: string }) => item.appId));
    const missingApp = await call('launch', { appId: 'invalid.muster-desktop-fixture.application', requestId: 'missing-app' });
    assert.equal(missingApp.ok, false);
    assert.equal(missingApp.code, status.screenLocked ? 'screen_locked' : 'app_not_installed', missingApp.error);
    const surface = registry.refresh().surfaces.find(item => item.bounds.x === primary.bounds.x && item.bounds.y === primary.bounds.y);
    assert.ok(surface);
    const captureFixture = async () => {
      let image = await success('look', { surfaceId: surface.surfaceId });
      const findWindow = () => image.windows?.find((row: { title: string }) => row.title === title);
      let selected = findWindow();
      while (canResolveWindow && !status.screenLocked && !selected && Number.isSafeInteger(image.windowsNextOffset)) {
        image = await success('look', { surfaceId: surface.surfaceId, windowOffset: image.windowsNextOffset });
        selected = findWindow();
      }
      return { image, selected };
    };
    let { image, selected } = await captureFixture();
    assert.ok(image.width > 0 && image.height > 0 && fs.existsSync(image.path));
    const summary = `capture=${image.width}x${image.height} displays=${screen.getAllDisplays().length} scale=${primary.scaleFactor} apps`;
    if (!canResolveWindow || status.screenLocked) {
      assert.ok(!selected && image.windowsComplete === false);
      if (status.screenLocked) assert.equal(image.windowsCode, 'screen_locked');
      else assert.ok(image.windowsUnavailable > 0);
      const unsupported = await call('focus', { surfaceId: String(nativeId), requestId: 'unverified-window' });
      assert.equal(unsupported.ok, false);
      if (status.screenLocked) assert.equal(unsupported.code, 'screen_locked');
      const driver = new CuaTransport(driverPath(), process.env, undefined, { embedded: true });
      try {
        await driver.connect();
        const result = await driver.call('get_window_state', { pid: observed.pid, window_id: nativeId,
          include_screenshot: false, tree_format: 'elements', max_elements: 10 }, AbortSignal.timeout(5000)) as {
          isError?: boolean; structuredContent?: { element_count?: number; degraded_reason?: string } };
        const treeStatus = result.structuredContent?.degraded_reason?.split(':')[0] ?? (result.isError ? 'error' : result.structuredContent?.element_count ?? 'unknown');
        if (status.screenLocked) assert.equal(treeStatus, 'screen_locked');
        console.log(`MAC_DESKTOP_FIXTURE_OK ${summary} nativeIdentity=unavailable driverTree=${treeStatus} locked=${status.screenLocked}`);
      } finally { await driver.close(); }
      return;
    }
    assert.ok(selected, `Fixture window was not selectable (returned ${image.windows?.length}, unavailable ${image.windowsUnavailable}, ${image.windowsError ?? ''})`);
    const focus = await success('focus', { surfaceId: selected.windowId, requestId: 'focus-1' });
    assert.equal(focus.effect, 'confirmed');
    assert.equal((await targetState()).focused, true);
    await delay(600); // Let AppKit finish animating the foreground window before taking its new capture.
    ({ image, selected } = await captureFixture());
    assert.ok(selected, 'Focused fixture should be selectable in a fresh screenshot');
    const captureWindow = async () => {
      let listed = await success('list', { view: 'windows', limit: 10 });
      const find = () => listed.windows.find((row: { title: string }) => row.title === title);
      while (!find() && Number.isSafeInteger(listed.nextOffset)) listed = await success('list', { view: 'windows', limit: 10, windowOffset: listed.nextOffset });
      const chosen = find();
      assert.ok(chosen, 'Cua window list must contain the fixture');
      const windowImage = await success('look', { mode: 'both', windowId: chosen.windowId });
      assert.equal(windowImage.coordinateSpace, 'window-pixel-v1');
      assert.equal(windowImage.captureId, windowImage.artifactId);
      assert.ok(fs.existsSync(windowImage.path));
      assert.ok(windowImage.semantic.elements.length > 0, 'The window capture includes its semantic tree');
      const { bounds, contentBounds } = await targetState();
      const x = (contentBounds.x - bounds.x + 100) * windowImage.width / bounds.width;
      const y = (contentBounds.y - bounds.y + 85) * windowImage.height / bounds.height;
      return { windowId: chosen.windowId, captureId: windowImage.captureId, x, y };
    };
    const windowTarget = await captureWindow();
    const click = { requestId: 'click-1', action: 'click', target: windowTarget };
    const clickReceipt = await success('act', click);
    assert.deepEqual(await success('act', click), clickReceipt);
    assert.equal((await targetState()).clicks, 1);
    await success('act', { requestId: 'double-click-1', action: 'double_click', target: await captureWindow() });
    assert.equal((await targetState()).clicks, 3);
    const act = (action: string, requestId: string, target: object) => success('act',
      { surfaceId: surface.surfaceId, action, requestId, target: { windowId: selected.windowId, ...target } });
    await act('type', 'type-1', { text: 'Muster中42' });
    assert.equal((await targetState()).value, 'Muster中42');
    await act('key', 'key-1', { keys: ['Command', 'KeyA'] });
    await act('type', 'type-2', { text: '替换' });
    assert.equal((await targetState()).value, '替换');
    const semantic = await success('look', { surfaceId: surface.surfaceId, mode: 'semantic', windowId: selected.windowId });
    assert.ok(semantic.semantic.elements.some((element: { label?: string }) => element.label?.includes('Fixture input')));
    const staleTarget = await captureWindow();
    const boundsBeforeMove = readMacWindow(nativeId)?.bounds;
    target.stdin.write('move\n');
    await readTarget();
    await delay(300);
    assert.notDeepEqual(readMacWindow(nativeId)?.bounds, boundsBeforeMove, 'The fixture must actually change geometry before attempting a stale click');
    const stale = await call('act', { requestId: 'after-move', action: 'click', target: staleTarget });
    assert.equal(stale.ok, false, 'A relocated window must require a new screenshot');
    assert.equal((await targetState()).clicks, 3);
    const indicator = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/desktop-indicator.html'));
    assert.ok(indicator && indicator.isVisible());
    const closed = once(indicator, 'closed');
    // Closing this window removes its renderer context before IPC can reply.
    await indicator.webContents.executeJavaScript('document.querySelector("button").click()').catch(() => undefined);
    await closed;
    const stopped = await call('act', { ...click, requestId: 'after-stop' });
    assert.equal(stopped.ok, false);
    assert.equal((await targetState()).clicks, 3);
    host.desktopTurns().end(sessionId, desktopTurnId);
    assert.ok(!BrowserWindow.getAllWindows().filter(candidate => candidate !== other).some(candidate => candidate.isFocused()));
    console.log(`MAC_DESKTOP_FIXTURE_OK ${summary} missing-app focus window-capture click double-click replay unicode chord semantic stale-window stop`);
  } finally {
    current = false;
    target.stdin.end('quit\n');
    await targetExited;
    output.close();
    try { await host.close(); }
    finally { screenRuntime.close(); registry.dispose(); other.destroy(); }
  }
}

void (isTarget ? runTarget() : main(data)).then(() => app.exit(0), error => { console.error('MAC_DESKTOP_FIXTURE_FAILURE', error); app.exit(1); });
