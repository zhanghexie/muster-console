const { contextBridge, ipcRenderer, webUtils } = require('electron');
window.addEventListener('mousedown', event => { if (event.button === 1 && event.isTrusted) { event.preventDefault(); void ipcRenderer.invoke('extension:panelMiddleClick'); } }, true);
contextBridge.exposeInMainWorld('maHost', Object.freeze({
  init: () => ipcRenderer.invoke('extension:panelInit'),
  call: call => ipcRenderer.invoke('extension:panelCall', call),
  pathForFile: async file => { const reply = await ipcRenderer.invoke('extension:panelFileAccess'); if (!reply.ok) throw new Error(reply.error); return webUtils.getPathForFile(file); },
  subscribe: listener => {
    const event = (_event, value) => listener({ __ma: true, type: 'event', topic: value.topic, value: value.value, generation: value.generation });
    const appearance = (_event, value) => listener({ __ma: true, type: 'appearance', ...value });
    ipcRenderer.on('extension:event', event); ipcRenderer.on('extension:appearance', appearance);
    return () => { ipcRenderer.removeListener('extension:event', event); ipcRenderer.removeListener('extension:appearance', appearance); };
  }
}));
