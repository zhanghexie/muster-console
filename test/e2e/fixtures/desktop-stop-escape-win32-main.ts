import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, screen } from 'electron';
import koffi from 'koffi';
import { DesktopActivityRuntime } from '../../../src/main/desktop/desktopActivityRuntime';
import { DesktopIndicatorWindow } from '../../../src/main/desktop/desktopIndicatorWindow';
import { createPlatformIndicator } from '../../../src/main/desktop/platformIndicator';
import { WindowsEscapeMonitor, windowsEscapeScript } from '../../../src/main/desktop/windowsEscapeMonitor';
import { createWin32Input, performWin32Input } from '../../../src/main/desktop/win32Input';
import { TrackedWin32Input } from '../../../src/main/desktop/trackedWin32Input';
import { createWin32WindowApi, focusWin32Window } from '../../../src/main/desktop/win32Applications';
import { createWin32PointHitTest } from '../../../src/main/desktop/win32VisibleControl';

const data = process.env.MUSTER_TEST_USER_DATA;
if (!data || !path.isAbsolute(data) || process.platform !== 'win32') throw new Error('Windows fixture userData is required');
app.setPath('userData', data);
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const waitUntil = async (description: string, predicate: () => boolean | Promise<boolean>, limit = 6000): Promise<void> => {
  const until = Date.now() + limit;
  while (Date.now() < until) { if (await predicate()) return; await pause(25); }
  throw new Error(`Timed out waiting for ${description}`);
};
const hwnd = (win: BrowserWindow): bigint => {
  const native = win.getNativeWindowHandle();
  return native.length >= 8 ? native.readBigUInt64LE() : BigInt(native.readUInt32LE());
};

async function main(): Promise<void> {
  await app.whenReady();
  const work = screen.getPrimaryDisplay().workArea;
  if (work.width < 850 || work.height < 400) throw new Error('Display work area is too small for separate test and indicator windows');
  const win = new BrowserWindow({ x: work.x + 20, y: work.y + 20, width: 360, height: 200, useContentSize: true,
    title: 'MetaAgent stop fixture', show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  const raw = createWin32Input(), api = createWin32WindowApi(), hit = createWin32PointHitTest();
  const user = koffi.load('user32.dll');
  const getAsyncKeyState = user.func('__stdcall', 'GetAsyncKeyState', 'int16', ['int32']);
  const pressed = (vk: number): boolean => (getAsyncKeyState(vk) & 0x8000) !== 0;
  let releasedF24 = 0, releaseCalls = 0, nativeEscapes = 0, monitorStarts = 0, monitorStops = 0;
  let monitorFailure = '';
  const tracked = new TrackedWin32Input({ move: (x, y) => raw.move(x, y), send: events => {
    raw.send(events);
    const event = events[0];
    if (event?.kind === 'key' && event.vk === 0x87 && ((event.flags ?? 0) & 2) !== 0) releasedF24++;
  } });
  let activity: DesktopActivityRuntime | undefined;
  let safetyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await win.loadURL('data:text/html,<title>MetaAgent stop fixture</title><p>Owned test window</p>');
    win.setTitle('MetaAgent stop fixture'); win.setAlwaysOnTop(true, 'screen-saver'); win.show(); win.focus();
    activity = new DesktopActivityRuntime({
      labels: { active: 'AI 正在操作电脑', stopping: '正在停止', unknown: '结果未知', escape: 'Esc 停止', stop: '停止', escapeUnavailable: '请点停止' },
      releaseAll: async () => { releaseCalls++; await tracked.releaseAll(); },
      createIndicator(stop, unavailable) {
        return createPlatformIndicator({ mainDir: path.resolve('out/main'), preloadPath: path.resolve('out/preload/desktopIndicator.js'),
          rendererPath: path.resolve('out/renderer'), stop, unavailable,
          createWindow: (onStop, onUnavailable, preload, renderer, url) => new DesktopIndicatorWindow(onStop, onUnavailable, preload, renderer, url) });
      },
      createEscapeMonitor(onEscape, onFailure) {
        const monitor = new WindowsEscapeMonitor(windowsEscapeScript(path.resolve('out/main')),
          () => { nativeEscapes++; onEscape(); }, reason => { monitorFailure = reason; onFailure(reason); });
        return { start: async () => { await monitor.start(); monitorStarts++; },
          stop: async () => { await monitor.stop(); monitorStops++; } };
      },
      reportMonitorFailure: reason => { monitorFailure = reason; }
    });
    const owner = 'stop-fixture', turn = 'stop-turn';
    activity.turns.noteUserInstruction(owner, 'fixture-instruction');
    activity.turns.begin(owner, turn, () => !win.isDestroyed(), true, 'fixture-instruction');
    await activity.turns.use(owner, turn, '受控停止测试', async () => {}, false);
    const indicator = BrowserWindow.getAllWindows().find(value => value !== win && value.isVisible());
    if (!indicator || !activity.isVisible() || monitorStarts !== 1 || monitorFailure) {
      throw new Error(`The real indicator or Windows Escape monitor did not start: ${monitorFailure}`);
    }
    await waitUntil('rendered Escape availability', async () => (await indicator.webContents.executeJavaScript('document.body.innerText')).includes('Esc 停止'));
    const ib = indicator.getBounds(), outer = win.getBounds();
    const choices = [{ x: work.x + 20, y: work.y + 20 }, { x: work.x + work.width - outer.width - 20, y: work.y + 20 },
      { x: work.x + 20, y: work.y + work.height - outer.height - 20 },
      { x: work.x + work.width - outer.width - 20, y: work.y + work.height - outer.height - 20 }];
    const pos = choices.find(p => p.x + outer.width <= ib.x || ib.x + ib.width <= p.x || p.y + outer.height <= ib.y || ib.y + ib.height <= p.y);
    if (!pos) throw new Error('No space for the test and indicator windows without overlap');
    win.setPosition(pos.x, pos.y); win.focus();
    focusWin32Window(api, hwnd(win), () => !win.isDestroyed() && win.isVisible());
    await waitUntil('owned test window foreground', () => BigInt(api.foreground() ?? 0) === hwnd(win));
    // Refuse to inject if the chosen keys or modifiers are already held by anyone.
    if ([0x1b, 0x87, 0x10, 0x11, 0x12, 0x5b, 0x5c].some(pressed)) throw new Error('A test key or modifier is already pressed; refusing synthetic input');
    if (process.env.MUSTER_FIXTURE_INSPECT === '1') {
      fs.writeFileSync(path.join(data!, 'indicator-active.png'), (await indicator.webContents.capturePage()).toPNG());
    }

    // Verify the OS accepted an injected Escape down/up while the real hook is ready.
    // No physical key or user key stream is synthesized, recorded, or inspected.
    let syntheticEscDown = false;
    try {
      raw.send([{ kind: 'key', vk: 0x1b, flags: 0 }]); syntheticEscDown = true;
      await waitUntil('injected Escape down', () => pressed(0x1b), 1500);
    } finally { if (syntheticEscDown) raw.send([{ kind: 'key', vk: 0x1b, flags: 2 }]); }
    await waitUntil('injected Escape release', () => !pressed(0x1b), 1500);
    await pause(400);
    if (nativeEscapes !== 0 || monitorFailure || !activity.isVisible() || !indicator.isVisible()) {
      throw new Error('Synthetic Escape stopped the active desktop run or the monitor failed');
    }
    if (await activity.turns.use(owner, turn, '受控停止测试', async () => 'still-active', false) !== 'still-active') {
      throw new Error('Synthetic Escape interrupted subsequent seat use');
    }

    let entered = false;
    let aborted = false, queuedEntered = false, activeSettled = false, queuedSettled = false;
    const active = activity.turns.use(owner, turn, '受控停止测试', async signal => {
      if (BigInt(api.foreground() ?? 0) !== hwnd(win)) throw new Error('Owned target lost foreground before test key');
      tracked.send([{ kind: 'key', vk: 0x87, flags: 0 }]); // F24, held only by this test.
      entered = true;
      await new Promise<void>((_resolve, reject) => {
        const fail = () => { aborted = true; reject(signal.reason ?? new Error('Desktop action aborted')); };
        if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
      });
    }).then(() => { activeSettled = true; return 'resolved'; }, () => { activeSettled = true; return 'rejected'; });
    await waitUntil('the in-flight action to start', () => entered || activeSettled);
    if (!entered) throw new Error('The in-flight action failed before it held the test key');
    // Avoid leaving a synthetic key held if an environmental failure stalls this fixture.
    safetyTimer = setTimeout(() => { void tracked.releaseAll().catch(error => console.error(error)); }, 8000);
    await waitUntil('owned F24 down', () => pressed(0x87), 1500);
    const queued = activity.turns.use(owner, turn, '受控停止测试', async () => { queuedEntered = true; })
      .then(() => { queuedSettled = true; return 'resolved'; }, () => { queuedSettled = true; return 'rejected'; });
    await pause(100);
    if (activeSettled || queuedSettled || queuedEntered || !pressed(0x87)) throw new Error('The active and queued actions were not both pending before stop');

    const button = await indicator.webContents.executeJavaScript(`(() => {const b=document.querySelector('button');
      if(!b||b.disabled)throw new Error('Stop button unavailable');const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    const bounds = indicator.getContentBounds();
    const point = screen.dipToScreenPoint({ x: Math.floor(bounds.x + button.x), y: Math.floor(bounds.y + button.y) });
    if (!hit(hwnd(indicator), 'fixture-indicator', point)) throw new Error('The stop button is obscured; refusing to inject a click');
    await performWin32Input(raw, { action: 'click', ...point });
    await waitUntil('both actions to settle', () => activeSettled && queuedSettled);
    const outcomes = await Promise.all([active, queued]);
    await waitUntil('the synthetic held key to be released', () => !pressed(0x87));
    await waitUntil('Windows Escape monitor shutdown', () => monitorStops === 1);
    if (!aborted || queuedEntered || outcomes.some(result => result !== 'rejected') || releasedF24 < 1 || releaseCalls < 1 || nativeEscapes !== 0 || monitorFailure) {
      throw new Error(`Stop did not safely interrupt and clean up: ${JSON.stringify({ aborted, queuedEntered, outcomes, releasedF24, releaseCalls, nativeEscapes, monitorFailure })}`);
    }
    await waitUntil('uncertain status in the real indicator', async () => {
      if (indicator.isDestroyed()) return false;
      return (await indicator.webContents.executeJavaScript('document.querySelector("[role=status]")?.textContent')) === '结果未知';
    });
    const disabled = await indicator.webContents.executeJavaScript('document.querySelector("button")?.disabled');
    if (disabled !== true) throw new Error('Stop button should be disabled while outcome is unknown');
    if (process.env.MUSTER_FIXTURE_INSPECT === '1') {
      fs.writeFileSync(path.join(data!, 'indicator-unknown.png'), (await indicator.webContents.capturePage()).toPNG());
      await pause(25000); // Bounded local visual inspection before cleanup.
    }
    console.log(`STOP_ESCAPE_WIN32_OK ${JSON.stringify({ indicator: true, syntheticEscapeAccepted: true, syntheticEscapeStopped: false,
      aborted, queuedEntered, outcomes, releasedF24, f24StillDown: pressed(0x87), monitorStarts, monitorStops, physicalEscapeTested: false })}`);
  } finally {
    if (safetyTimer) clearTimeout(safetyTimer);
    try { await activity?.dispose(); }
    finally {
      try { await tracked.releaseAll(); }
      finally { if (!win.isDestroyed()) win.destroy(); }
    }
  }
}

void main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
