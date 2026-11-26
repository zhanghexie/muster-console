const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('materialDemo', {
  getState: () => ipcRenderer.invoke('material-demo:state'),
  setOptions: patch => ipcRenderer.invoke('material-demo:options', patch),
  minimize: () => ipcRenderer.send('material-demo:window', 'minimize'),
  maximize: () => ipcRenderer.send('material-demo:window', 'maximize'),
  close: () => ipcRenderer.send('material-demo:window', 'close')
});
