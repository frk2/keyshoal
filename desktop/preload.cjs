const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('keyshoal', Object.freeze({
  call: (action, ...args) => ipcRenderer.invoke('vault:call', action, ...args),
  onChanged: callback => { ipcRenderer.on('vault:changed', () => callback()); }
}));
