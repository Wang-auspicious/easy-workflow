const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', Object.freeze({ info: () => ipcRenderer.invoke('desktop:info'), browserBounds: (bounds) => ipcRenderer.invoke('desktop:browser-bounds', bounds) }));
