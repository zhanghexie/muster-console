import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopIndicatorSnapshot } from '../shared/desktopIndicator';

contextBridge.exposeInMainWorld('desktopIndicator', {
  connect: (): Promise<DesktopIndicatorSnapshot> => ipcRenderer.invoke('desktopIndicator:connect'),
  ready: (revision: number): Promise<void> => ipcRenderer.invoke('desktopIndicator:ready', revision),
  stop: (revision: number): Promise<void> => ipcRenderer.invoke('desktopIndicator:stop', revision),
  onChanged: (callback: (state: DesktopIndicatorSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: DesktopIndicatorSnapshot) => callback(state);
    ipcRenderer.on('desktopIndicator:changed', listener);
    return () => ipcRenderer.removeListener('desktopIndicator:changed', listener);
  }
});
