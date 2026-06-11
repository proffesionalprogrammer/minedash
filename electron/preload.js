const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,

  // Renderer asks the main process for the running app version. Single source
  // of truth (package.json via electron-builder) so renderer and updater agree.
  getAppVersion: () => ipcRenderer.invoke('app-get-version'),

  // Native folder picker (Settings → Storage). Resolves to a path or null.
  selectFolder: () => ipcRenderer.invoke('dialog-select-folder'),

  // Restart MineDash entirely — applies a moved data folder.
  relaunchApp: () => ipcRenderer.send('app-relaunch'),

  windowControls: {
    minimize:        () => ipcRenderer.send('window-minimize'),
    maximize:        () => ipcRenderer.send('window-maximize'),
    close:           () => ipcRenderer.send('window-close'),
    hideToTray:      () => ipcRenderer.send('window-hide-to-tray'),
    showFromTray:    () => ipcRenderer.send('window-show-from-tray'),
    isMaximized:     () => ipcRenderer.invoke('window-is-maximized'),
    onMaximizeChange: (cb) => ipcRenderer.on('window-maximized', (_, val) => cb(val)),
  },

  // Auto-updater bridge. The main process drives electron-updater; the
  // renderer subscribes here to drive the "Update ready" toast and request
  // the relaunch when the user clicks it.
  updater: {
    onUpdateAvailable:   (cb) => ipcRenderer.on('updater-update-available',   (_, info) => cb(info)),
    onDownloadProgress:  (cb) => ipcRenderer.on('updater-download-progress',  (_, info) => cb(info)),
    onUpdateDownloaded:  (cb) => ipcRenderer.on('updater-update-downloaded',  (_, info) => cb(info)),
    quitAndInstall:      () => ipcRenderer.send('updater-quit-and-install'),
  },
});
