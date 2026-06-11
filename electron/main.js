const { app, BrowserWindow, shell, ipcMain, screen, Tray, Menu, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { fork } = require('child_process');

const isDev = !app.isPackaged;
let backendProcess = null;
let mainWindow = null;
let tray = null;
// Update-poll timer is created when the window is focused and cleared when it
// blurs / hides. Per-minute polling while the user is actively in the app gets
// new releases in front of them within ~60s of going live; the focus gate
// avoids waking the network every minute while MineDash is tray-hidden.
let updatePollTimer = null;
const UPDATE_POLL_INTERVAL_MS = 60 * 1000;

// ─── Single-instance lock ────────────────────────────────────────────────────
// MineDash must be a singleton: a second copy would fork its own backend on the
// same port 3001 (the listen would fail) and confuse the user with a duplicate
// window. If we don't hold the lock, another instance is already running —
// quit immediately and let that instance surface itself via 'second-instance'.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  // Fired in the primary instance when the user launches MineDash again
  // (or hits a shortcut). Restore + show + focus the existing window instead
  // of letting a duplicate spawn.
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });
}

// Render at 100% regardless of Windows display scaling — otherwise the UI
// inherits the OS scale factor and overflows on 125% / 150% laptop screens.
app.commandLine.appendSwitch('force-device-scale-factor', '1');

// ─── Log file (packaged only) ──────────────────────────────────────────────────
function getLogPath() {
  return path.join(app.getPath('userData'), 'minedash-main.log');
}
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  process.stdout.write(line);
  if (app.isPackaged) {
    try { fs.appendFileSync(getLogPath(), line); } catch (_) {}
  }
}

// ─── Resource Paths ────────────────────────────────────────────────────────────
function getResourcePath(...parts) {
  return app.isPackaged
    ? path.join(process.resourcesPath, ...parts)
    : path.join(__dirname, '..', ...parts);
}

// ─── Backend Launcher ──────────────────────────────────────────────────────────
function startBackend() {
  // In packaged builds the backend lives inside app.asar (huge install-time
  // speedup: NSIS unpacks one archive instead of thousands of small files).
  // Electron's fork() can require from asar because the forked process is
  // also an Electron child with the asar fs patches loaded.
  const backendEntry = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'backend', 'index.js')
    : path.join(__dirname, '..', 'backend', 'index.js');
  // cwd must be a real directory on disk — asar paths are virtual and
  // setting them as cwd fails. The backend doesn't rely on cwd (everything
  // resolves through MINEDASH_DATA_DIR), so userData is fine.
  const userDataDir = app.getPath('userData');
  const backendCwd = userDataDir;

  log('[Electron] Starting backend at:', backendEntry);
  log('[Electron] Backend cwd:', backendCwd);
  log('[Electron] User data dir:', userDataDir);
  log('[Electron] Entry exists:', fs.existsSync(backendEntry));

  backendProcess = fork(backendEntry, [], {
    cwd: backendCwd,
    env: {
      ...process.env,
      MINEDASH_DATA_DIR: userDataDir,
      MINEDASH_ELECTRON: 'true',
    },
    silent: true, // capture stdout/stderr so we can log them
  });

  backendProcess.stdout.on('data', (d) => log('[Backend]', d.toString().trimEnd()));
  backendProcess.stderr.on('data', (d) => log('[Backend ERR]', d.toString().trimEnd()));

  backendProcess.on('error', (err) => {
    log('[Electron] Backend process error:', err.message);
  });

  backendProcess.on('exit', (code, signal) => {
    log(`[Electron] Backend exited — code: ${code}, signal: ${signal}`);
    backendProcess = null;
  });
}

// ─── Backend Ready Check ───────────────────────────────────────────────────────
function waitForBackend(retries = 30, delay = 500) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get('http://localhost:3001/api/servers', (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (retries-- <= 0) {
          reject(new Error('Backend failed to start within timeout'));
        } else {
          setTimeout(attempt, delay);
        }
      });
      req.setTimeout(400, () => {
        req.destroy();
        if (retries-- <= 0) {
          reject(new Error('Backend timed out'));
        } else {
          setTimeout(attempt, delay);
        }
      });
    };
    attempt();
  });
}

// ─── Window ────────────────────────────────────────────────────────────────────
async function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const winW = Math.min(1400, Math.round(sw * 0.88));
  const winH = Math.min(900,  Math.round(sh * 0.88));

  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    minWidth: 800,
    minHeight: 560,
    backgroundColor: '#111111',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  mainWindow.on('maximize',   () => mainWindow?.webContents.send('window-maximized', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window-maximized', false));

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    const indexPath = getResourcePath('renderer', 'index.html');
    mainWindow.loadFile(indexPath);
  }

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── Auto Updater ──────────────────────────────────────────────────────────────
// Reads releases from proffesionalprogrammer/minedash-releases (public). The
// publish config in package.json generates app-update.yml at build time so
// electron-updater knows where to look. No GitHub token is needed at runtime
// because the releases repo is public — only the CI workflow needs a token
// (to *write* releases).
//
// Flow: on launch, check the releases feed. If a newer version exists, download
// the installer in the background. When it's ready, emit `updater-update-downloaded`
// to the renderer so a toast can ask the user to relaunch — quitAndInstall()
// runs the new installer which swaps the binary and restarts.
function setupAutoUpdater() {
  if (isDev) return;

  autoUpdater.logger = {
    info:  (m) => log('[Updater]', m),
    warn:  (m) => log('[Updater WARN]', m),
    error: (m) => log('[Updater ERR]', m),
    debug: () => {},
  };
  autoUpdater.autoDownload = true;
  // Don't surprise-install on quit — we wait for the user to click the toast
  // so an in-progress task (e.g. Minecraft launching) doesn't get killed.
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    log('[Updater] Update available:', info?.version);
    mainWindow?.webContents.send('updater-update-available', { version: info?.version });
  });
  autoUpdater.on('update-not-available', () => {
    // Quiet — checking is a background concern, no UI noise.
  });
  autoUpdater.on('download-progress', (p) => {
    mainWindow?.webContents.send('updater-download-progress', {
      percent: p?.percent || 0,
      bytesPerSecond: p?.bytesPerSecond || 0,
      transferred: p?.transferred || 0,
      total: p?.total || 0,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    log('[Updater] Update downloaded:', info?.version);
    mainWindow?.webContents.send('updater-update-downloaded', { version: info?.version });
  });
  autoUpdater.on('error', (err) => {
    // Common harmless errors at runtime:
    //  - 404 on first install when no release exists yet
    //  - net::ERR_INTERNET_DISCONNECTED when offline
    // Surface them in the log but don't pop UI for them.
    log('[Updater] Error:', err?.message || String(err));
  });

  autoUpdater.checkForUpdates().catch((err) => {
    log('[Updater] Initial check failed:', err?.message || String(err));
  });

  // Focused-only polling. We start a 1-minute interval as soon as the window
  // is focused and tear it down on blur/hide so a backgrounded MineDash isn't
  // generating idle network chatter. Re-checking when focus returns picks up
  // any release that landed during the away period.
  const startPolling = () => {
    if (updatePollTimer) return;
    updatePollTimer = setInterval(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        log('[Updater] Poll failed:', err?.message || String(err));
      });
    }, UPDATE_POLL_INTERVAL_MS);
  };
  const stopPolling = () => {
    if (!updatePollTimer) return;
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  };
  if (mainWindow?.isFocused()) startPolling();
  mainWindow?.on('focus', () => {
    // Also do an immediate check on focus — if the user came back after lunch
    // they shouldn't wait another full minute to find out about a release.
    autoUpdater.checkForUpdates().catch(() => {});
    startPolling();
  });
  mainWindow?.on('blur', stopPolling);
  mainWindow?.on('hide', stopPolling);
  mainWindow?.on('show', () => { if (mainWindow.isFocused()) startPolling(); });
}

// Renderer asks us to quit and run the installer. The installer swaps the
// binary and relaunches into the new version.
ipcMain.on('updater-quit-and-install', () => {
  autoUpdater.quitAndInstall();
});


// ─── Window Control IPC ────────────────────────────────────────────────────────
ipcMain.on('window-minimize',    () => mainWindow?.minimize());
ipcMain.on('window-maximize',    () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());
ipcMain.on('window-close',       () => mainWindow?.close());
ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized() ?? false);

// Renderer asks what version of MineDash is running so it can display it in
// Settings and decide whether to show the "What's new" popup. Source of truth
// is package.json (electron-builder bakes its `version` field into the app).
ipcMain.handle('app-get-version', () => app.getVersion());

// Native folder picker — used by Settings → Storage to choose where game and
// server files live. Returns the absolute path, or null if the user cancelled.
ipcMain.handle('dialog-select-folder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose MineDash data folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Full app relaunch — needed after the data folder moves, since the backend
// computes every path at boot. before-quit kills the backend cleanly.
ipcMain.on('app-relaunch', () => {
  app.relaunch();
  app.quit();
});

// Hide MineDash to the system tray. Called from useLaunchSession when the
// user's "After launching" setting is 'hide' — keeping the backend alive
// (servers, scheduled tasks) while the game owns the screen.
ipcMain.on('window-hide-to-tray', () => {
  if (!mainWindow) return;
  ensureTray();
  mainWindow.hide();
});

// Restore the window from tray. useLaunchSession fires this on the game's
// 'close' event so the user gets MineDash back automatically once Minecraft
// exits, instead of leaving them to hunt for the tray icon.
ipcMain.on('window-show-from-tray', () => {
  if (!mainWindow) return;
  showFromTray();
});

// ─── System Tray ───────────────────────────────────────────────────────────────
function ensureTray() {
  if (tray) return;
  // `__dirname` resolves into app.asar in packaged builds, but the Tray
  // constructor reads through the asar fs patches just fine — no need to
  // unpack the icon.
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  try {
    tray = new Tray(iconPath);
  } catch (err) {
    log('[Electron] Tray init failed:', err.message);
    return;
  }
  tray.setToolTip('MineDash');
  const menu = Menu.buildFromTemplate([
    { label: 'Show MineDash', click: showFromTray },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  // Single click (Windows convention) restores the window. On macOS the
  // context menu opens on click anyway, so this is a no-op there.
  tray.on('click', showFromTray);
}

function showFromTray() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ─── App Lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // If we lost the single-instance race, app.quit() is already in flight —
  // don't fork a backend that would fight for port 3001.
  if (!gotInstanceLock) return;
  // Log the running version up front so the auto-update flow is debuggable
  // from the log file alone — if the toast misfires you can grep this line to
  // see which version actually got loaded vs. what's on the releases feed.
  log(`[Electron] MineDash ${app.getVersion()} starting`);
  startBackend();

  try {
    await waitForBackend();
    log('[Electron] Backend is ready');
  } catch (err) {
    log('[Electron] WARNING:', err.message, '— showing window anyway');
  }

  await createWindow();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (backendProcess) {
    backendProcess.kill('SIGTERM');
    backendProcess = null;
  }
});
