import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, desktopCapturer, nativeImage, powerMonitor, screen } from 'electron';
import type { AppContext } from '../../../src/main/context';
import { DesktopActivityRuntime } from '../../../src/main/desktop/desktopActivityRuntime';
import { DesktopIndicatorWindow } from '../../../src/main/desktop/desktopIndicatorWindow';
import { ElectronDisplayRegistry } from '../../../src/main/desktop/displayRegistry';
import { DesktopScreenRuntime } from '../../../src/main/desktop/screenRuntime';
import { stageDesktopCaptureImage, withDesktopCaptureImageScope } from '../../../src/main/desktop/captureImageScope';
import { DesktopCaptureArtifacts } from '../../../src/main/desktop/captureArtifacts';
import { prepareSessionCaptureDirectory } from '../../../src/main/desktop/sessionCaptureAccess';
import { decodeDesktopPng } from '../../../src/main/desktop/pngDecoder';
import { Win32TargetRegistry } from '../../../src/main/desktop/win32TargetRegistry';
import { Win32VisibleControl, createWin32PointHitTest, type Win32VisibleRequest } from '../../../src/main/desktop/win32VisibleControl';
import { TrackedWin32Input } from '../../../src/main/desktop/trackedWin32Input';
import { createWin32Input } from '../../../src/main/desktop/win32Input';
import { normalizeWin32Keys } from '../../../src/main/desktop/win32KeyNames';
import { CuaTransport } from '../../../src/main/desktop/cuaTransport';
import { resolveCuaDriverPath } from '../../../src/main/desktop/cuaDriverPath';
import { createWin32WindowApi } from '../../../src/main/desktop/win32Applications';
import { createVisibleActionRuntime } from '../../../src/main/desktop/visibleActionFactory';
import { DesktopActionIdempotency } from '../../../src/main/desktop/actionIdempotency';
import { VisibleActionDispatcher } from '../../../src/main/desktop/visibleActionDispatcher';
import { IdempotentVisibleDispatcher } from '../../../src/main/desktop/idempotentVisibleDispatcher';
import type { VisibleAcknowledgementOutcome } from '../../../src/main/desktop/visibleActionCoordinator';

const data = process.env.MUSTER_TEST_USER_DATA;
if (!data || !path.isAbsolute(data) || process.platform !== 'win32') throw new Error('Windows fixture userData is required');
app.setPath('userData', data);

const html = `<!doctype html><meta charset="utf-8"><title>Visible screen test</title>
  <style>body{margin:0;background:#133b76;font:16px sans-serif} #mark{position:absolute;left:10px;top:10px;width:70px;height:32px;background:#19cb71}
  button{position:absolute;left:55px;top:75px;width:180px;height:40px} input{position:absolute;left:55px;top:135px;width:220px;height:35px}</style>
  <div id="mark"></div><button id="go" onwheel="this.dataset.scrolled='yes'">Run fixture</button><input id="field" autofocus aria-label="Fixture input">`;
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function main(): Promise<void> {
  await app.whenReady();
  const work = screen.getPrimaryDisplay().workArea;
  if (work.width < 850 || work.height < 400) throw new Error('Display work area is too small for the separate fixture and indicator windows');
  const title = `MetaAgent Screen Visible Fixture ${process.pid}`;
  const win = new BrowserWindow({ x: work.x + 20, y: work.y + 20, width: 380, height: 220, useContentSize: true,
    title, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  let activity: DesktopActivityRuntime | undefined;
  let registry: ElectronDisplayRegistry | undefined;
  let captureHost: DesktopScreenRuntime | undefined;
  let sourceControl: Win32TargetRegistry | undefined;
  let actionRuntime: ReturnType<typeof createVisibleActionRuntime> | undefined;
  let receipts: DesktopActionIdempotency | undefined;
  let frame: Awaited<ReturnType<DesktopScreenRuntime['look']>> | undefined;
  const actor = { sessionId: 'screen-fixture', taskId: 'screen-fixture-task', turnId: 'screen-fixture-turn',
    isCurrent: () => !win.isDestroyed() };
  let approvalCalls = 0;
  const unexpectedApproval = async (): Promise<never> => { approvalCalls++; throw new Error('Unexpected legacy approval callback'); };
  try {
    await win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
    win.setTitle(title);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.show(); win.focus();
    const tracked = new TrackedWin32Input(createWin32Input());
    activity = new DesktopActivityRuntime({
      labels: { active: 'AI 正在操作电脑', stopping: '正在停止', unknown: '结果未知', escape: 'Esc 停止', stop: '停止', escapeUnavailable: '请点停止' },
      releaseAll: () => tracked.releaseAll(),
      createIndicator(stop, unavailable) {
        const indicator = new DesktopIndicatorWindow(stop, unavailable, path.resolve('out/preload/desktopIndicator.js'), path.resolve('out/renderer'));
        indicator.registerIpc();
        return indicator;
      }
    });
    activity.turns.noteUserInstruction(actor.sessionId, 'fixture-instruction');
    activity.turns.begin(actor.sessionId, actor.turnId, actor.isCurrent, true, 'fixture-instruction');
    // Starting a read-only seat shows the actual indicator before the screenshot.
    await activity.turns.use(actor.sessionId, actor.turnId, '受控测试窗口', async () => {}, false);
    const indicator = BrowserWindow.getAllWindows().find(value => value !== win && value.isVisible());
    if (!indicator || !activity.isVisible()) throw new Error('The real desktop indicator did not become visible');
    const indicatorText = await indicator.webContents.executeJavaScript('document.body.innerText');
    if (typeof indicatorText !== 'string' || !indicatorText.includes('AI 正在操作电脑') || !indicatorText.includes('停止')) {
      throw new Error('The real desktop indicator did not render its active status and stop control');
    }
    if (process.env.MUSTER_FIXTURE_CUA_DISCOVERY === '1') {
      const binary = resolveCuaDriverPath({ appPath: process.cwd(), resourcesPath: data!, isPackaged: false,
        platform: process.platform, arch: process.arch });
      const driver = new CuaTransport(binary);
      await driver.connect();
      try {
        const result = await driver.call('list_apps', {}) as { isError?: unknown; structuredContent?: unknown };
        if (result.isError || !result.structuredContent || typeof result.structuredContent !== 'object') throw new Error('Cua app discovery failed');
        const known = new Set(['apps', 'applications', 'items', 'data', 'result', 'count', 'total', 'complete', 'truncated',
          'name', 'label', 'pid', 'id', 'app_id', 'bundle_id', 'bundle_identifier', 'running', 'active', 'kind', 'launch_path',
          'executable', 'last_used', 'windows', 'error', 'omitted']);
        const structure = (value: unknown, depth = 0): unknown => {
          if (depth > 2) return typeof value;
          if (Array.isArray(value)) return { type: 'array', item: value.length ? structure(value[0], depth + 1) : 'empty' };
          if (value && typeof value === 'object') {
            const entries = Object.entries(value);
            return { ...Object.fromEntries(entries.filter(([key]) => known.has(key)).slice(0, 30)
              .map(([key, item]) => [key, structure(item, depth + 1)])), unknownFields: entries.filter(([key]) => !known.has(key)).length };
          }
          return value === null ? 'null' : typeof value;
        };
        console.log(`CUA_DISCOVERY_STRUCTURE ${JSON.stringify(structure(result.structuredContent))}`);
      } finally { await driver.close(); }
    }
    // Keep the real indicator and test window separate; never cover the stop control.
    const ib = indicator.getBounds();
    const positions = [{ x: work.x + 20, y: work.y + 20 }, { x: work.x + work.width - 410, y: work.y + 20 },
      { x: work.x + 20, y: work.y + work.height - 280 }, { x: work.x + work.width - 410, y: work.y + work.height - 280 }];
    const outer = win.getBounds();
    const position = positions.find(p => p.x + outer.width <= work.x + work.width && p.y + outer.height <= work.y + work.height &&
      (p.x + outer.width <= ib.x || ib.x + ib.width <= p.x || p.y + outer.height <= ib.y || ib.y + ib.height <= p.y));
    if (!position) throw new Error('No space for an unobstructed fixture and indicator');
    win.setPosition(position.x, position.y); win.focus();
    await pause(350);

    registry = new ElectronDisplayRegistry(screen, powerMonitor);
    const content = win.getContentBounds();
    const display = registry.refresh().surfaces.find(item => content.x >= item.bounds.x && content.y >= item.bounds.y &&
      content.x + content.width <= item.bounds.x + item.bounds.width && content.y + content.height <= item.bounds.y + item.bounds.height);
    if (!display || display.rotation !== 0) throw new Error('Fixture is not fully on one unrotated registered display');
    const target = registry.captureTarget(actor.taskId, display.surfaceId);
    const hit = createWin32PointHitTest();
    const native = win.getNativeWindowHandle();
    const hwnd = native.length >= 8 ? native.readBigUInt64LE() : BigInt(native.readUInt32LE());
    // Verify sampled points belong to our own window before persisting any pixels.
    for (const fx of [0.05, 0.25, 0.5, 0.75, 0.95]) for (const fy of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const point = screen.dipToScreenPoint({ x: Math.floor(content.x + content.width * fx), y: Math.floor(content.y + content.height * fy) });
      if (!hit(hwnd, 'fixture-owned', point)) throw new Error('The fixture window is obscured; no desktop screenshot was saved');
    }
    // Save only the interior of the owned window. desktopCapturer still samples all displays in memory.
    const scale = display.scaleFactor;
    const region = { x: Math.ceil((content.x - display.bounds.x + 8) * scale), y: Math.ceil((content.y - display.bounds.y + 8) * scale),
      width: Math.floor((content.width - 16) * scale), height: Math.floor((content.height - 16) * scale) };
    let sourceReads = 0;
    captureHost = new DesktopScreenRuntime({ sessions: { get: () => ({ name: 'Fixture' }) } } as unknown as AppContext,
      data!, registry, { confirm: unexpectedApproval }, options => { sourceReads++; return desktopCapturer.getSources(options); },
      png => nativeImage.createFromBuffer(png), () => activity!.visibilityEpoch());
    frame = await activity.turns.use(actor.sessionId, actor.turnId, '受控测试窗口',
      signal => captureHost!.look(actor, display.surfaceId, 60000, signal, region), false);
    const relative = path.relative(data!, frame.path);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(frame.path) || sourceReads !== 1 || approvalCalls !== 0 ||
        frame.authorizationCurrent() !== true || !activity.isVisible()) throw new Error('Visible screenshot or its workspace-only artifact failed');
    const deliveredImage = await withDesktopCaptureImageScope(async () => {
      const current = () => frame!.authorizationCurrent() && activity!.isVisible();
      const data = await captureHost!.imageBytes(actor, frame!.artifactId, current);
      stageDesktopCaptureImage(data, current);
    });
    if (!deliveredImage.image || deliveredImage.image.mimeType !== 'image/png' ||
        !Buffer.from(deliveredImage.image.data, 'base64').equals(fs.readFileSync(frame.path))) {
      throw new Error('The image block did not contain the actual authorized screenshot');
    }
    const actualXScale = frame.sourceSize.width / display.bounds.width, actualYScale = frame.sourceSize.height / display.bounds.height;
    if (Math.abs(actualXScale - scale) > 0.03 || Math.abs(actualYScale - scale) > 0.03) {
      throw new Error('Capture source scale differs from the registered display; this fixture cannot safely map the crop');
    }
    const capturePoint = (x: number, y: number) => {
      const point = { x: Math.floor((content.x + x - display.bounds.x) * actualXScale) - frame!.region.x,
        y: Math.floor((content.y + y - display.bounds.y) * actualYScale) - frame!.region.y };
      if (point.x < 0 || point.y < 0 || point.x >= frame!.width || point.y >= frame!.height) throw new Error('Fixture point is outside the captured crop');
      return point;
    };
    const image = nativeImage.createFromPath(frame.path);
    const mark = capturePoint(35, 25), bitmap = image.toBitmap();
    const index = (mark.y * frame.width + mark.x) * 4;
    if (image.isEmpty() || Math.abs(bitmap[index] - 0x71) > 12 || Math.abs(bitmap[index + 1] - 0xcb) > 12 ||
        Math.abs(bitmap[index + 2] - 0x19) > 12) throw new Error('The actual captured pixels do not contain the owned fixture marker');
    if (process.env.MUSTER_FIXTURE_INSPECT === '1') {
      fs.copyFileSync(frame.path, path.join(data!, 'owned-capture.png'));
      fs.writeFileSync(path.join(data!, 'indicator.png'), (await indicator.webContents.capturePage()).toPNG());
      await pause(25000); // Optional, bounded local visual inspection before cleanup.
    }

    sourceControl = new Win32TargetRegistry(p => screen.screenToDipPoint(p));
    let offset: number | null = 0, windowId: string | undefined;
    do {
      const page = sourceControl.register(actor, frame, target, () => registry!.isCurrent(target) && frame!.authorizationCurrent(), offset);
      windowId = page.windows.find(item => item.title === title)?.windowId;
      offset = page.nextOffset;
    } while (!windowId && offset !== null);
    if (!windowId || sourceControl.visibleTarget(actor, windowId).window.pid !== process.pid) throw new Error('The screenshot did not issue an owned window reference');
    const localReceipts = process.env.MUSTER_FIXTURE_LOCAL_RECEIPTS === '1';
    if (!localReceipts) actionRuntime = createVisibleActionRuntime(path.join(data!, 'outbox.sqlite'), path.join(data!, 'locks'));
    receipts = new DesktopActionIdempotency(path.join(data!, 'receipts'));
    const dispatcher = localReceipts ? new IdempotentVisibleDispatcher(receipts) : new VisibleActionDispatcher(receipts, actionRuntime!.coordinator);
    const control = new Win32VisibleControl({ dispatcher, input: tracked, windowApi: createWin32WindowApi(),
      resolveTarget: (owner, id) => sourceControl!.visibleTarget(owner, id), dipToPhysical: p => screen.dipToScreenPoint(p) });
    let unknown = false, simulatedReceipts = 0;
    const act = async (id: string, request: Omit<Win32VisibleRequest, 'windowId'>): Promise<void> => {
      let acknowledgement: ((deliveryId: string) => Promise<VisibleAcknowledgementOutcome>) | undefined;
      const result = await activity!.turns.use(actor.sessionId, actor.turnId, '受控测试窗口', (signal, lease) => {
        const epoch = activity!.visibilityEpoch();
        if (epoch === undefined || !indicator.isVisible()) throw new Error('The real indicator disappeared before input');
        return control.act(actor, { ...request, windowId: windowId! }, id, { lease, indicatorEpoch: epoch,
          isIndicatorCurrent: value => activity!.visibilityEpoch() === value,
          isTargetCurrent: () => sourceControl!.visibleTarget(actor, windowId!).isCurrent(), isPointOnTarget: hit,
          onUnknown() { unknown = true; void activity!.stop().catch(error => console.error(error)); },
          stageDelivery(_invocation, _value, callback) { acknowledgement = callback; } }, signal);
      });
      if (result.outcome !== 'dispatched' || result.value.effect !== 'unverifiable' || !acknowledgement || unknown) {
        throw new Error(`Visible fixture action failed: ${JSON.stringify(result)}`);
      }
      if (localReceipts) {
        if ((await acknowledgement(`fixture-${id}`)).outcome !== 'unknown') throw new Error('Local receipt must not invent engine delivery');
      } else {
        // This is deliberately a fixture acknowledgement, not a real engine delivery event.
        if ((await acknowledgement(`fixture-${id}`)).outcome !== 'acknowledged') throw new Error('Simulated fixture acknowledgement failed');
        simulatedReceipts++;
      }
    };
    const center = async (id: string): Promise<{ x: number; y: number }> => win.webContents.executeJavaScript(
      `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    const button = await center('go');
    await act('fixture-scroll', { action: 'scroll', delta: 120, ...capturePoint(button.x, button.y) });
    await act('fixture-focus', { action: 'focus' });
    await act('fixture-type', { action: 'type', text: 'Fixture中123' });
    await act('fixture-select-all', { action: 'key', keys: normalizeWin32Keys(['Control', 'KeyA']) });
    await act('fixture-replace', { action: 'type', text: 'Named中456' });
    const readback = await win.webContents.executeJavaScript('({scrolled:document.getElementById("go").dataset.scrolled,value:document.getElementById("field").value})');
    const legacyWriterCreated = fs.existsSync(path.join(data!, 'desktop', 'action-receipts.sqlite'));
    if (readback.scrolled !== 'yes' || readback.value !== 'Named中456' || approvalCalls !== 0 || simulatedReceipts !== (localReceipts ? 0 : 5) || legacyWriterCreated) {
      throw new Error(`Independent fixture readback failed: ${JSON.stringify(readback)}`);
    }
    console.log(`SCREEN_WIN32_VISIBLE_OK ${JSON.stringify({ captured: [frame.width, frame.height], source: [frame.sourceSize.width, frame.sourceSize.height],
      scale, marker: true, imageBlock: true, indicator: true, scrolled: readback.scrolled, value: readback.value, approvalCalls, legacyWriterCreated,
      receiptMode: localReceipts ? 'local-dedup-no-delivery-claim' : 'fixture-acknowledgement', simulatedReceipts })}`);
  } finally {
    if (frame && fs.existsSync(frame.path)) {
      const artifacts = new DesktopCaptureArtifacts(prepareSessionCaptureDirectory(data!, actor.sessionId), decodeDesktopPng);
      await artifacts.remove(actor.taskId, frame.artifactId);
      if (fs.existsSync(frame.path)) throw new Error('Fixture screenshot cleanup failed');
    }
    await activity?.dispose();
    receipts?.close(); actionRuntime?.close(); sourceControl?.close(); captureHost?.close(); registry?.dispose();
    if (!win.isDestroyed()) win.destroy();
  }
}

void main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
