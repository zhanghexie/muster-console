import { contextBridge, ipcRenderer } from 'electron';
if (process.isMainFrame) contextBridge.exposeInMainWorld('demoReplay', {
  next: () => ipcRenderer.invoke('demo:read'),
  appearance: (value: import('../shared/demoReplay').DemoChrome) => ipcRenderer.send('demo:appearance', value)
});
