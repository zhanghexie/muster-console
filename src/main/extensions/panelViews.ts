import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import type { AppContext } from '../context';
import type { ExtensionViewInstance, ExtensionRuntimeEvent } from '../../shared/extension';
import type { ExtensionBridgeCall } from '../../shared/extensions';
import { t } from '../../shared/i18n';
import { appendMainLog } from '../logs/mainLog';
import { describeExitCode } from '../../shared/crashContext';
import { MUSTER_APP_SCHEME } from '../../shared/protocolSchemes';

export type PanelPlacement = 'center' | 'left' | 'right' | 'window';
interface PanelViewIdentity {
  token: string; instanceId: string; generation: number; workspaceId: string; sourceRootId: string; extensionId: string; viewId: string;
  entry: string; permissions: readonly string[]; extension: { name: string };
}
type Frame<T extends PanelViewIdentity> = { instance: T; popup: BrowserWindow | null; appearance: Record<string, unknown> };

/** Embedded pages belong to renderer iframes. Only detached pages need a BrowserWindow. */
export class ExtensionPanelViews<T extends PanelViewIdentity = ExtensionViewInstance> {
  private frames = new Map<string, Frame<T>>();
  constructor(private ctx: AppContext, private bridge: (instance: T, call: ExtensionBridgeCall) => Promise<unknown>) {}
  create(instance: T): void { this.frames.set(instance.token, { instance, popup: null, appearance: {} }); }
  private find(senderId: number): Frame<T> {
    const frame = [...this.frames.values()].find(frame => frame.popup?.webContents.id === senderId);
    if (!frame) throw new Error(t('该页面未绑定扩展身份'));
    return frame;
  }
  /** sender 是否属于本实例的某个 popup（多套 panelViews 共存时的 IPC 路由判据）。 */
  ownsSender(senderId: number): boolean {
    return [...this.frames.values()].some(frame => frame.popup?.webContents.id === senderId);
  }
  init(senderId: number): Record<string, unknown> {
    const frame = this.find(senderId), instance = frame.instance;
    return { extId: instance.extensionId, extName: instance.extension.name, workspaceName: this.ctx.config.get().workspaces.find(ws => ws.id === instance.workspaceId)?.name || '', workspaceRoot: '', appVersion: '', permissions: instance.permissions, workspaceId: instance.workspaceId, extensionId: instance.extensionId, instanceId: instance.instanceId, generation: instance.generation, viewId: instance.viewId, ...('sourceRootId' in instance ? { sourceRootId: instance.sourceRootId } : {}), ...frame.appearance };
  }
  call(senderId: number, call: ExtensionBridgeCall): Promise<unknown> { return this.bridge(this.find(senderId).instance, call); }
  appearance(token: string, value: Record<string, unknown>): void {
    const frame = this.frames.get(token); if (!frame) return;
    frame.appearance = value; frame.popup?.webContents.send('extension:appearance', value);
  }
  place(token: string, placement: PanelPlacement): void {
    if (!['center', 'left', 'right', 'window'].includes(placement)) throw new Error(t('面板位置不合法'));
    const frame = this.frames.get(token); if (!frame) throw new Error(t('面板实例不存在'));
    if (placement !== 'window') { const popup = frame.popup; frame.popup = null; popup?.destroy(); return; }
    if (frame.popup) { frame.popup.show(); frame.popup.focus(); return; }
    const instance = frame.instance as PanelViewIdentity & { detachedAppWindow?: boolean };
    let popup: BrowserWindow;
    let load: () => Promise<void>;
    if (instance.detachedAppWindow) {
      // extension 独立窗口 = 完整应用窗口（主 preload + hash 进入扩展窗口模式）：
      // 面板 iframe 与 AI 侧栏作为整体进入窗口，会话事件经 aux 广播送达。
      popup = new BrowserWindow({ title: instance.extension.name, width: 1120, height: 780, minWidth: 520, minHeight: 360, show: false, autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
      this.ctx.auxRendererIds.add(popup.webContents.id);
      const params = new URLSearchParams({ token, workspaceId: instance.workspaceId, extensionId: instance.extensionId, viewId: instance.viewId, ...(instance.sourceRootId ? { sourceRootId: instance.sourceRootId } : {}) });
      const hash = `#extension-window?${params.toString()}`;
      load = async () => {
        const rendererUrl = process.env.ELECTRON_RENDERER_URL;
        if (rendererUrl) await popup.loadURL(`${rendererUrl}${hash}`);
        else await popup.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: hash.slice(1) });
      };
    } else {
      // 独立扩展窗口：muster-app 直载 + panel-preload 的 maHost 通道。
      popup = new BrowserWindow({ title: instance.extension.name, width: 1080, height: 760, minWidth: 360, minHeight: 280, show: false, autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'extensions', 'sdk', 'panel-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
      const prefix = `${MUSTER_APP_SCHEME}://${token}/`;
      popup.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(prefix)) event.preventDefault(); });
      popup.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
      load = () => popup.loadURL(prefix + instance.entry.split('/').map(encodeURIComponent).join('/'));
    }
    frame.popup = popup;
    const publish = (error: string): void => {
      if (this.frames.get(token) === frame && frame.popup === popup && !popup.isDestroyed())
        this.ctx.getWindow()?.webContents.send('workbench:panelError', { token, error });
    };
    popup.webContents.on('did-fail-load', (_event, code, description, _url, main) => { if (main && code !== -3) publish(description); });
    popup.webContents.on('render-process-gone', (_event, details) => {
      // toast 只在 UI 存活时可见且不持久——扩展面板崩溃同步落盘（此前无文件痕迹）
      appendMainLog(app.getPath('userData'), 'error', `[panel gone] ext=${instance.extension.name} reason=${details.reason} exitCode=${describeExitCode(details.exitCode)}`);
      publish(t('扩展页面退出：{{reason}}', { reason: details.reason }));
    });
    const returned = (): void => {
      this.ctx.auxRendererIds.delete(popup.webContents.id);
      if (this.frames.get(token) === frame && frame.popup === popup) {
        frame.popup = null; this.ctx.getWindow()?.webContents.send('workbench:panelReturned', { token });
      }
    };
    // close precedes failed-load callbacks; invalidate before cancellation is reported.
    popup.on('close', returned);
    popup.on('closed', returned);
    void load().then(() => { if (!popup.isDestroyed()) popup.show(); }).catch(error => publish(String(error)));
  }

  event(event: ExtensionRuntimeEvent): void {
    for (const frame of this.frames.values()) if (frame.instance.workspaceId === event.workspaceId && frame.instance.extensionId === event.extensionId && frame.instance.generation === event.generation && event.sourceRootId === frame.instance.sourceRootId) frame.popup?.webContents.send('extension:event', event);
  }
  release(token: string): void { const frame = this.frames.get(token); this.frames.delete(token); frame?.popup?.destroy(); }
  stop(): void { for (const token of this.frames.keys()) this.release(token); }
}
