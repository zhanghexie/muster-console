import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopIndicatorSnapshot } from '../../../src/shared/desktopIndicator';

const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), last: null as any,
  area: { x: -1200, y: 40, width: 900, height: 700 } }));
vi.mock('../../../src/main/ipc/handle', () => ({ handle: (channel: string, fn: (...args: any[]) => any) => state.handlers.set(channel, fn) }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeContents extends EventEmitter {
    mainFrame = {};
    isLoading = () => false;
    send = vi.fn();
    setWindowOpenHandler = vi.fn();
  }
  class FakeWindow extends EventEmitter {
    webContents = new FakeContents();
    destroyed = false;
    visible = false;
    showInactive = vi.fn(() => { this.visible = true; });
    isVisible = () => this.visible;
    isDestroyed = () => this.destroyed;
    loadURL = async () => {};
    loadFile = async () => {};
    destroy = () => { this.destroyed = true; this.emit('closed'); };
    constructor(public options: Record<string, unknown>) { super(); state.last = this; }
  }
  return { BrowserWindow: FakeWindow, screen: { getCursorScreenPoint: () => ({ x: -500, y: 300 }),
    getDisplayNearestPoint: () => ({ workArea: state.area }) } };
});

it('fails readiness and notifies the host if the window cannot become visible', async () => {
  const unavailable = vi.fn();
  const indicator = new DesktopIndicatorWindow(async () => {}, unavailable, 'preload', 'renderer');
  indicator.registerIpc();
  const shown = indicator.show({ revision: 1, state: 'active', escapeAvailable: false,
    labels: { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' } });
  const win = state.last, event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  expect(win.options).toMatchObject({ x: -832, y: 52, width: 520, height: 72, show: false });
  win.showInactive = vi.fn();
  state.handlers.get('desktopIndicator:ready')!(event, 1);
  await expect(shown).rejects.toThrow(/not visible/);
  expect(unavailable).toHaveBeenCalledWith(expect.stringMatching(/not visible/));
  indicator.close();
});
import { DesktopIndicatorWindow } from '../../../src/main/desktop/desktopIndicatorWindow';

afterEach(() => { state.handlers.clear(); state.last = null; state.area = { x: -1200, y: 40, width: 900, height: 700 }; });

it('keeps a narrow stop control on the selected work area and rejects displays that cannot fit it', async () => {
  state.area = { x: 100, y: -100, width: 330, height: 80 };
  const indicator = new DesktopIndicatorWindow(async () => {}, vi.fn(), 'preload', 'renderer');
  indicator.registerIpc();
  const shown = indicator.show({ revision: 1, state: 'active', escapeAvailable: false,
    labels: { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' } });
  const win = state.last, event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  expect(win.options).toMatchObject({ x: 100, y: -92, width: 320, height: 72 });
  state.handlers.get('desktopIndicator:ready')!(event, 1);
  await shown;
  indicator.close();
  state.area.width = 319;
  const tiny = new DesktopIndicatorWindow(async () => {}, vi.fn(), 'preload', 'renderer');
  await expect(tiny.show({ revision: 1, state: 'active', escapeAvailable: false,
    labels: { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' } }))
    .rejects.toThrow(/too small/);
  tiny.close();
});

it('accepts readiness and stop only from the current indicator main frame and revision', async () => {
  const stop = vi.fn(async () => {}), unavailable = vi.fn();
  const indicator = new DesktopIndicatorWindow(stop, unavailable, 'preload', 'renderer');
  indicator.registerIpc();
  const snapshot: DesktopIndicatorSnapshot = { revision: 1, state: 'active', escapeAvailable: true,
    labels: { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' } };
  const shown = indicator.show(snapshot);
  const win = state.last, event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const connect = state.handlers.get('desktopIndicator:connect')!;
  const ready = state.handlers.get('desktopIndicator:ready')!;
  const stopHandler = state.handlers.get('desktopIndicator:stop')!;
  expect(() => connect(null)).toThrow(/unavailable/);
  expect(() => connect({ sender: win.webContents, senderFrame: {} })).toThrow(/unavailable/);
  expect(connect(event)).toEqual(snapshot);
  expect(() => ready(event, 2)).toThrow(/revision/);
  ready(event, 1);
  await shown;
  expect(win.showInactive).toHaveBeenCalledOnce();
  await expect(stopHandler(event, 2)).rejects.toThrow(/revision/);
  await stopHandler(event, 1);
  expect(stop).toHaveBeenCalledOnce();
  indicator.close();
  expect(unavailable).not.toHaveBeenCalled();
  expect(() => connect(event)).toThrow(/unavailable/);
});

it.each(['hide', 'minimize'])('marks desktop use unavailable when the indicator receives %s', async eventName => {
  const unavailable = vi.fn();
  const indicator = new DesktopIndicatorWindow(async () => {}, unavailable, 'preload', 'renderer');
  indicator.registerIpc();
  const shown = indicator.show({ revision: 1, state: 'active', escapeAvailable: false,
    labels: { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' } });
  const win = state.last, event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  state.handlers.get('desktopIndicator:ready')!(event, 1);
  await shown;
  win.emit(eventName);
  expect(unavailable).toHaveBeenCalledWith(expect.stringMatching(/indicator.*(hidden|minimized)/i));
  indicator.close();
});
