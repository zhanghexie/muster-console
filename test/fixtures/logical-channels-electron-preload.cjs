const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  messaging: {
    status: () => ipcRenderer.invoke('messaging:status'),
    call: (channel, method, payload, requestId) => ipcRenderer.invoke('messaging:call', channel, method, payload, requestId),
    cancel: id => ipcRenderer.invoke('messaging:cancel', id)
  },
  agentApps: { snapshot: async () => ({ apps: [], connections: [], revision: 0 }) },
  app: { setChromeTheme: async () => ({ ok: true, material: 'solid' }) }
});
contextBridge.exposeInMainWorld('channelsFixture', {
  receive: (text, sender, chat) => ipcRenderer.invoke('channels-fixture:receive', text, sender, chat),
  evidence: () => ipcRenderer.invoke('channels-fixture:evidence')
});
