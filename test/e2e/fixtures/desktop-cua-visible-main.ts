import path from 'node:path';
import { app, BrowserWindow, desktopCapturer, nativeImage, powerMonitor, screen } from 'electron';
import { DesktopActivityRuntime } from '../../../src/main/desktop/desktopActivityRuntime';
import { DesktopIndicatorWindow } from '../../../src/main/desktop/desktopIndicatorWindow';
import { ElectronDisplayRegistry } from '../../../src/main/desktop/displayRegistry';
import { captureDisplay } from '../../../src/main/desktop/displayCapture';
import { DesktopCaptureArtifacts } from '../../../src/main/desktop/captureArtifacts';
import { prepareSessionCaptureDirectory } from '../../../src/main/desktop/sessionCaptureAccess';
import { decodeDesktopPng } from '../../../src/main/desktop/pngDecoder';
import { Win32ControlRuntime } from '../../../src/main/desktop/win32ControlRuntime';
import { CuaSemanticRuntime } from '../../../src/main/desktop/cuaSemanticRuntime';
import { createCuaVisibleAction } from '../../../src/main/desktop/cuaVisibleAction';
import { createVisibleActionRuntime } from '../../../src/main/desktop/visibleActionFactory';
import { DesktopActionIdempotency } from '../../../src/main/desktop/actionIdempotency';
import { VisibleActionDispatcher } from '../../../src/main/desktop/visibleActionDispatcher';
import { resolveCuaDriverPath } from '../../../src/main/desktop/cuaDriverPath';
import type { DesktopDeliveryLease } from '../../../src/main/desktop/desktopTurns';
import type { VisibleAcknowledgementOutcome } from '../../../src/main/desktop/visibleActionCoordinator';

const data = process.env.MUSTER_TEST_USER_DATA;
if (!data || !path.isAbsolute(data) || process.platform !== 'win32') throw new Error('Windows fixture userData is required');
app.setPath('userData', data);
app.commandLine.appendSwitch('force-renderer-accessibility');

async function main(): Promise<void> {
  await app.whenReady();
  const work = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({ x: work.x + 30, y: work.y + 30, width: 400, height: 240,
    title: 'MetaAgent Cua Visible Fixture', webPreferences: { sandbox: true } });
  let activity: DesktopActivityRuntime | undefined;
  let semantic: CuaSemanticRuntime | undefined;
  let control: Win32ControlRuntime | undefined;
  let registry: ElectronDisplayRegistry | undefined;
  let actionRuntime: ReturnType<typeof createVisibleActionRuntime> | undefined;
  let receipts: DesktopActionIdempotency | undefined;
  try {
    await win.loadURL('data:text/html,' + encodeURIComponent('<title>MetaAgent Cua Visible Fixture</title><button id="go" onclick="this.textContent=\'Completed\'">Run test</button>'));
    win.setTitle('MetaAgent Cua Visible Fixture');
    win.focus();
    await new Promise(resolve => setTimeout(resolve, 300));
    const owner = 'fixture', task = 'fixture-task';
    const actor = { sessionId: owner, taskId: task, turnId: 'turn', isCurrent: () => !win.isDestroyed() };
    registry = new ElectronDisplayRegistry(screen, powerMonitor);
    const display = registry.refresh().surfaces.find(item => {
      const bounds = win.getBounds();
      return bounds.x >= item.bounds.x && bounds.y >= item.bounds.y &&
        bounds.x < item.bounds.x + item.bounds.width && bounds.y < item.bounds.y + item.bounds.height;
    });
    if (!display) throw new Error('Fixture display unavailable');
    const captureTarget = registry.captureTarget(task, display.surfaceId);
    const registryCurrent = () => registry!.isCurrent(captureTarget);
    const artifacts = new DesktopCaptureArtifacts(prepareSessionCaptureDirectory(data!, owner), decodeDesktopPng);
    const frame = await captureDisplay({ getSources: options => desktopCapturer.getSources(options),
      normalizePng: png => nativeImage.createFromBuffer(png), confirmAllDisplays: async () => true,
      audit: async () => {}, artifacts }, captureTarget, registryCurrent, 60_000);
    const unexpectedConfirmation = async (): Promise<never> => { throw new Error('Unexpected host approval prompt'); };
    control = new Win32ControlRuntime(data!, { confirm: unexpectedConfirmation, confirmWithReceipt: unexpectedConfirmation },
      point => screen.dipToScreenPoint(point), point => screen.screenToDipPoint(point));
    let offset: number | null = 0, windowId: string | undefined;
    do {
      const page = control.register(actor, frame, captureTarget, registryCurrent, offset);
      windowId = page.windows.find(item => item.title === 'MetaAgent Cua Visible Fixture')?.windowId;
      offset = page.nextOffset;
    } while (!windowId && offset !== null);
    if (!windowId) throw new Error('Fixture window was not selected');

    activity = new DesktopActivityRuntime({
      labels: { active: 'AI 正在操作电脑', stopping: '正在停止', unknown: '结果未知', escape: 'Esc 停止', stop: '停止', escapeUnavailable: '请点停止' },
      releaseAll: () => control!.releaseAll(),
      createIndicator(stop, unavailable) {
        const indicator = new DesktopIndicatorWindow(stop, unavailable, path.resolve('out/preload/desktopIndicator.js'), path.resolve('out/renderer'));
        indicator.registerIpc();
        return indicator;
      }
    });
    actionRuntime = createVisibleActionRuntime(path.join(data!, 'outbox.sqlite'), path.join(data!, 'locks'));
    receipts = new DesktopActionIdempotency(path.join(data!, 'receipts'));
    const dispatcher = new VisibleActionDispatcher(receipts, actionRuntime.coordinator);
    let lease: DesktopDeliveryLease | undefined;
    let acknowledge: ((deliveryId: string) => Promise<VisibleAcknowledgementOutcome>) | undefined;
    const persisted = createCuaVisibleAction(dispatcher, request => {
      if (!lease) throw new Error('Fixture delivery lease is unavailable');
      const target = control!.semanticTarget(request.actor, request.hostWindowId);
      const indicatorEpoch = activity!.visibilityEpoch();
      if (indicatorEpoch === undefined) throw new Error('Fixture indicator is unavailable');
      return { lease, indicatorEpoch, isIndicatorCurrent: epoch => activity!.visibilityEpoch() === epoch,
        isTargetCurrent: target.isCurrent, stageDelivery(_id, _value, callback) { acknowledge = callback; } };
    });
    const binary = resolveCuaDriverPath({ appPath: process.cwd(), resourcesPath: process.resourcesPath, isPackaged: false,
      platform: process.platform, arch: process.arch });
    semantic = new CuaSemanticRuntime({ binary, resolveTarget: (current, selected) => control!.semanticTarget(current, selected), runPersistedAction: persisted });
    activity.turns.noteUserInstruction(owner, 'fixture-user-message');
    activity.turns.begin(owner, 'turn', actor.isCurrent, true, 'fixture-user-message');
    let page = await activity.turns.use(owner, 'turn', '受控测试窗口', signal => semantic!.observe(actor, windowId!, signal), false);
    let button = page.elements.find(element => element.label === 'Run test');
    while (!button && page.nextOffset !== null) {
      page = await semantic.page(actor, page.snapshotId, page.nextOffset);
      button = page.elements.find(element => element.label === 'Run test');
    }
    if (!button?.ref) throw new Error('Fixture semantic button was not found');
    if (!activity.isVisible()) throw new Error('Fixture indicator was not visible before input');
    const result = await activity.turns.use(owner, 'turn', '受控测试窗口', (signal, delivery) => {
      lease = delivery;
      return semantic!.act(actor, { snapshotId: page.snapshotId, ref: button!.ref!, requestId: 'fixture-click', action: 'click', delivery: 'foreground' }, signal);
    });
    if (result.outcome !== 'dispatched' || !result.ok) throw new Error(`Fixture semantic action failed: ${JSON.stringify(result)}`);
    let text = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      text = await win.webContents.executeJavaScript('document.getElementById("go").textContent');
      if (text === 'Completed') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (text !== 'Completed') throw new Error('Fixture button did not change after semantic click');
    if (!acknowledge || (await acknowledge('fixture-delivery')).outcome !== 'acknowledged') throw new Error('Fixture delivery confirmation failed');
    console.log(`CUA_VISIBLE_ELECTRON_OK ${JSON.stringify({ effect: result.effect, fixture: text, indicator: true })}`);
  } finally {
    await semantic?.close();
    await activity?.dispose();
    receipts?.close(); actionRuntime?.close(); control?.close(); registry?.dispose();
    if (!win.isDestroyed()) win.destroy();
  }
}

void main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
