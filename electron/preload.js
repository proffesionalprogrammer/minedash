const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,

  windowControls: {
    minimize:        () => ipcRenderer.send('window-minimize'),
    maximize:        () => ipcRenderer.send('window-maximize'),
    close:           () => ipcRenderer.send('window-close'),
    hideToTray:      () => ipcRenderer.send('window-hide-to-tray'),
    isMaximized:     () => ipcRenderer.invoke('window-is-maximized'),
    onMaximizeChange: (cb) => ipcRenderer.on('window-maximized', (_, val) => cb(val)),
  },
});
