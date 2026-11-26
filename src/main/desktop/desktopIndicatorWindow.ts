import { BrowserWindow, screen, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import type { DesktopIndicatorSnapshot } from '../../shared/desktopIndicator';
import { handle } from '../ipc/handle';

/** Host-only indicator: the untrusted renderer can request stop, never choose its target. */
export class DesktopIndicatorWindow {
  private window: BrowserWindow | undefined;
  private snapshot: DesktopIndicatorSnapshot | undefined;
  private ready: { revision: number; resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout } | undefined;
  private readonly closing = new WeakSet<BrowserWindow>();

  constructor(private readonly stop: () => Promise<void>, private readonly unavailable: (reason: string) => void,
    private readonly preloadPath: string, private readonly rendererPath: string, private readonly rendererUrl?: string) {}

  registerIpc(): void {
    handle('desktopIndicator:connect', event => { this.assertSender(event); return this.current(); });
    handle('desktopIndicator:ready', (event, revision: number) => {
      this.assertSender(event);
      if (!this.ready || this.ready.revision !== revision || this.current().revision !== revision) throw new Error('Desktop indicator revision changed');
      const pending = this.ready;
      this.ready = undefined;
      clearTimeout(pending.timer);
      try {
        this.window!.showInactive();
        if (!this.window!.isVisible()) throw new Error('Desktop indicator is not visible');
        pending.resolve();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        try { this.unavailable(failure.message); } finally { pending.reject(failure); }
      }
    });
    handle('desktopIndicator:stop', async (event, revision: number) => {
      this.assertSender(event);
      if (this.current().revision !== revision) throw new Error('Desktop indicator revision changed');
      await this.stop();
    });
  }

  /** Resolves after the indicator renderer has mounted its current state. */
  async show(snapshot: DesktopIndicatorSnapshot): Promise<void> {
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new Error('Invalid desktop indicator revision');
    if (this.snapshot && snapshot.revision <= this.snapshot.revision) throw new Error('Desktop indicator revision must increase');
    if (process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY)) {
      throw new Error('Desktop indicator cannot guarantee visibility on this Wayland session');
    }
    this.snapshot = snapshot;
    const win = this.window ?? this.createWindow();
    if (this.ready) { clearTimeout(this.ready.timer); this.ready.reject(new Error('Desktop indicator state superseded')); }
    const mounted = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.ready?.revision === snapshot.revision) this.ready = undefined;
        this.unavailable('Desktop indicator did not become ready');
        reject(new Error('Desktop indicator did not become ready'));
      }, 5000);
      timer.unref?.();
      this.ready = { revision: snapshot.revision, resolve, reject, timer };
    });
    if (win.webContents.isLoading()) {
      // The renderer subscribes before requesting its initial snapshot.
    } else win.webContents.send('desktopIndicator:changed', snapshot);
    return mounted;
  }

  close(): void {
    if (this.ready) { clearTimeout(this.ready.timer); this.ready.reject(new Error('Desktop indicator closed')); this.ready = undefined; }
    const win = this.window;
    this.window = undefined;
    this.snapshot = undefined;
    if (win && !win.isDestroyed()) { this.closing.add(win); win.destroy(); }
  }

  private current(): DesktopIndicatorSnapshot {
    if (!this.snapshot) throw new Error('Desktop indicator has no active run');
    return this.snapshot;
  }

  private assertSender(event: IpcMainInvokeEvent): void {
    const win = this.window;
    if (!win || win.isDestroyed() || !event?.sender || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error('Desktop indicator is unavailable');
    }
  }

  private createWindow(): BrowserWindow {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    if (!area || ![area.x, area.y, area.width, area.height].every(Number.isFinite) || area.width < 320 || area.height < 72) {
      throw new Error('The current display is too small for the desktop Stop control');
    }
    const width = Math.min(520, area.width - Math.min(24, area.width - 320));
    const x = Math.max(area.x, area.x + area.width - width - 12);
    const y = Math.min(area.y + 12, area.y + area.height - 72);
    const win = new BrowserWindow({ x, y, width, height: 72, minWidth: 320, minHeight: 72, show: false, frame: false,
      resizable: false, alwaysOnTop: true, skipTaskbar: true,
      webPreferences: { preload: this.preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    this.window = win;
    const failed = (reason: string) => {
      if (this.closing.has(win)) return;
      if (this.ready) { clearTimeout(this.ready.timer); this.ready.reject(new Error(reason)); this.ready = undefined; }
      this.unavailable(reason);
    };
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('render-process-gone', () => failed('Desktop indicator renderer exited'));
    win.webContents.on('did-fail-load', () => failed('Desktop indicator failed to load'));
    win.on('hide', () => failed('Desktop indicator window hidden'));
    win.on('minimize', () => failed('Desktop indicator window minimized'));
    win.on('closed', () => { if (this.window === win) this.window = undefined; failed('Desktop indicator window closed'); });
    const load = this.rendererUrl
      ? win.loadURL(new URL('desktop-indicator.html', this.rendererUrl.endsWith('/') ? this.rendererUrl : `${this.rendererUrl}/`).toString())
      : win.loadFile(path.join(this.rendererPath, 'desktop-indicator.html'));
    void load.catch(() => failed('Desktop indicator failed to load'));
    return win;
  }
}
