const { app, BrowserWindow, shell, ipcMain, screen, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { fork } = require('child_process');

const isDev = !app.isPackaged;
let backendProcess = null;
let mainWindow = null;
let tray = null;

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
function setupAutoUpdater() {
  // No-op until a GitHub release channel is configured
}


// ─── Window Control IPC ────────────────────────────────────────────────────────
ipcMain.on('window-minimize',    () => mainWindow?.minimize());
ipcMain.on('window-maximize',    () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());
ipcMain.on('window-close',       () => mainWindow?.close());
ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized() ?? false);

// Hide MineDash to the system tray. Called from useLaunchSession when the
// user's "After launching" setting is 'hide' — keeping the backend alive
// (servers, scheduled tasks) while the game owns the screen.
ipcMain.on('window-hide-to-tray', () => {
  if (!mainWindow) return;
  ensureTray();
  mainWindow.hide();
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
