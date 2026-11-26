const { contextBridge, ipcRenderer } = require('electron');
const feedback = {};
for (const method of ['snapshot', 'createManual', 'update', 'updateText', 'reject', 'delete', 'restore', 'prepare', 'duplicate', 'submit', 'reconcile']) {
  feedback[method] = (...args) => ipcRenderer.invoke(`feedback:${method}`, ...args);
}
contextBridge.exposeInMainWorld('api', {
  feedback,
  shell: { openExternal: async () => ({ ok: true }) },
  updater: { getState: async () => ({ state: 'idle', currentVersion: 'test' }), check: async () => {}, install: async () => {}, revealInstaller: async () => true },
  on: (name, callback) => { const listener = (_event, payload) => callback(payload); ipcRenderer.on(name, listener); return () => ipcRenderer.removeListener(name, listener); },
  fixture: { propose: () => ipcRenderer.invoke('fixture:propose'), assess: () => ipcRenderer.invoke('fixture:assess'), issues: () => ipcRenderer.invoke('fixture:issues'), opened: () => ipcRenderer.invoke('fixture:opened'), submitOnGitHub: () => ipcRenderer.invoke('fixture:submitOnGitHub') }
});
