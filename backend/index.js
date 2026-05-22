// Prefer IPv4 for every outbound HTTP call in this process (axios + native
// fetch + http.request all use dns.lookup). Several upstream hosts publish
// AAAA records that time out from residential networks (notably
// maven.neoforged.net), which previously broke NeoForge install + the
// version list. Setting this globally keeps every current and future
// call protected.
require('dns').setDefaultResultOrder('ipv4first');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const { spawn, exec, execSync } = require('child_process');
const osu = require('node-os-utils');
const multer = require('multer');
const extract = require('extract-zip');
const AdmZip = require('adm-zip');
const archiver = require('archiver');
const axios = require('axios');
const os = require('os');
const net = require('net');
const pidusage = require('pidusage');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// Allow all origins, including null (file:// in packaged Electron app)
const corsOptions = {
  origin: (origin, callback) => callback(null, true),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
};

const io = new Server(server, {
  cors: corsOptions,
});

app.use(cors(corsOptions));
app.use(express.json());

// ─── Data Directory (supports packaged Electron via MINEDASH_DATA_DIR) ─────────
// In development:  data lives in backend/ alongside the source
// In production:   Electron passes userData path (e.g. AppData\Roaming\MineDash)
const DATA_DIR = process.env.MINEDASH_DATA_DIR || __dirname;

// Set up multer for file uploads
const upload = multer({ dest: path.join(DATA_DIR, 'temp_uploads') });

// System Stats Interval
function getCpuUsage() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) {
      total += cpu.times[type];
    }
    idle += cpu.times.idle;
  }
  return { idle, total };
}

let lastCpu = getCpuUsage();

setInterval(async () => {
  try {
    const currentCpu = getCpuUsage();
    const idleDiff = currentCpu.idle - lastCpu.idle;
    const totalDiff = currentCpu.total - lastCpu.total;
    const usage = totalDiff === 0 ? 0 : 100 - Math.round((100 * idleDiff) / totalDiff);
    lastCpu = currentCpu;

    const totalMem = os.totalmem() / (1024 * 1024);
    const freeMem = os.freemem() / (1024 * 1024);
    const usedMem = totalMem - freeMem;
    
    io.emit('system_stats', {
      cpu: usage + '%',
      ram: Math.round(usedMem) + ' MB',
      ramTotal: Math.round(totalMem) + ' MB'
    });

    // Emit per-server memory stats using pidusage
    // Prefer the discovered Java PID over the spawned process PID
    for (const id in activeProcesses) {
      const proc = activeProcesses[id];
      if (proc && proc.pid) {
        const targetPid = serverJavaPids[id] || proc.pid;
        try {
          const stats = await pidusage(targetPid);
          const memMB = Math.round(stats.memory / (1024 * 1024));
          const memPercent = ((stats.memory / os.totalmem()) * 100).toFixed(1);
          const cpuPercent = Math.round(stats.cpu);
          io.emit(`server_memory_${id}`, {
            ram: memMB + ' MB',
            ramPercent: memPercent + '%',
            cpu: cpuPercent + '%'
          });
        } catch (e) {
          // Process may have just exited, emit 0
          io.emit(`server_memory_${id}`, { ram: '0 MB', ramPercent: '0%', cpu: '0%' });
        }
      }
    }
  } catch (err) {
    console.error("Stats Error:", err);
  }
}, 2000);

const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');
const INSTANCES_DIR = path.join(DATA_DIR, 'instances');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

// Ensure dirs exist
fs.ensureDirSync(INSTANCES_DIR);
fs.ensureDirSync(BACKUPS_DIR);

// ─── Java Discovery ───────────────────────────────────────────────────────────
let _javaExe = null;
function getJavaPath() {
  if (_javaExe) return _javaExe;

  const isWin = process.platform === 'win32';
  const exe = isWin ? 'java.exe' : 'java';

  const found = (p) => {
    console.log(`[MineDash] Java found: ${p}`);
    _javaExe = p;
    return p;
  };

  // 1. JAVA_HOME env var
  if (process.env.JAVA_HOME) {
    const p = path.join(process.env.JAVA_HOME, 'bin', exe);
    if (fs.existsSync(p)) return found(p);
  }

  // 2. System PATH via where/which
  try {
    const out = execSync(isWin ? 'where java' : 'which java', { encoding: 'utf8', timeout: 3000 });
    const p = out.trim().split('\n')[0].trim();
    if (p && fs.existsSync(p)) return found(p);
  } catch (_) {}

  if (isWin) {
    // 3. Windows Registry — covers Oracle, Adoptium, Microsoft, Azul, Corretto
    try {
      const ps = `powershell -NoProfile -Command "$r = @('HKLM:\\SOFTWARE\\JavaSoft\\Java Runtime Environment','HKLM:\\SOFTWARE\\JavaSoft\\Java Development Kit','HKLM:\\SOFTWARE\\JavaSoft\\JRE','HKLM:\\SOFTWARE\\JavaSoft\\JDK'); foreach ($k in $r) { if (Test-Path $k) { $cv = (Get-ItemProperty $k -EA SilentlyContinue).CurrentVersion; if ($cv) { $jh = (Get-ItemProperty ($k+'\\\\'+$cv) -EA SilentlyContinue).JavaHome; if ($jh -and (Test-Path ($jh+'\\\\bin\\\\java.exe'))) { Write-Output ($jh+'\\\\bin\\\\java.exe'); exit } } } }"`;
      const out = execSync(ps, { encoding: 'utf8', timeout: 6000 }).trim();
      if (out && fs.existsSync(out)) return found(out);
    } catch (_) {}

    // 4. Minecraft launcher bundled runtimes (very common for MC users)
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const mcBase = path.join(appdata, '.minecraft', 'runtime');
    const mcRuntimes = [
      'java-runtime-gamma', 'java-runtime-delta', 'java-runtime-beta',
      'java-runtime-alpha', 'jre-legacy',
    ];
    for (const rt of mcRuntimes) {
      const p = path.join(mcBase, rt, 'windows-x64', rt, 'bin', exe);
      if (fs.existsSync(p)) return found(p);
      // Some builds use windows-x86
      const p86 = path.join(mcBase, rt, 'windows-x86', rt, 'bin', exe);
      if (fs.existsSync(p86)) return found(p86);
    }

    // 5. Common install roots (Oracle, Adoptium, Microsoft, Corretto, Azul, Scoop…)
    const roots = [
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Amazon Corretto',
      'C:\\Program Files\\Azul Systems',
      'C:\\Program Files\\Eclipse Foundation',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files (x86)\\Java',
      path.join(os.homedir(), 'scoop', 'apps'),          // Scoop
      'C:\\ProgramData\\scoop\\apps',                     // Scoop (global)
      'C:\\ProgramData\\chocolatey\\lib',                 // Chocolatey
    ];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      const subs = fs.readdirSync(root).sort().reverse(); // newest first
      for (const sub of subs) {
        // Standard layout: <root>\<version>\bin\java.exe
        const p = path.join(root, sub, 'bin', exe);
        if (fs.existsSync(p)) return found(p);
        // Scoop layout: <root>\<name>\current\bin\java.exe
        const pScoop = path.join(root, sub, 'current', 'bin', exe);
        if (fs.existsSync(pScoop)) return found(pScoop);
      }
    }

    // 6. PowerShell broad scan of Program Files (depth-limited, last resort)
    try {
      const ps = `powershell -NoProfile -Command "Get-ChildItem -Path 'C:\\Program Files','C:\\Program Files (x86)' -Filter java.exe -Recurse -ErrorAction SilentlyContinue -Depth 5 | Select-Object -First 1 -ExpandProperty FullName"`;
      const out = execSync(ps, { encoding: 'utf8', timeout: 10000 }).trim();
      if (out && fs.existsSync(out)) return found(out);
    } catch (_) {}

  } else {
    // Linux / macOS
    for (const p of [
      '/usr/bin/java', '/usr/local/bin/java',
      '/opt/java/bin/java', '/opt/jdk/bin/java',
      '/usr/lib/jvm/default/bin/java',
    ]) {
      if (fs.existsSync(p)) return found(p);
    }
    // update-alternatives symlink
    try {
      const out = execSync('readlink -f /usr/bin/java', { encoding: 'utf8', timeout: 3000 }).trim();
      if (out && fs.existsSync(out)) return found(out);
    } catch (_) {}
  }

  console.warn('[MineDash] Java not found anywhere — install Java 17+ and set JAVA_HOME');
  return (_javaExe = 'java');
}

// ─── Java Version Check ────────────────────────────────────────────────────────
function getJavaVersion() {
  try {
    const javaPath = getJavaPath();
    // java -version prints to stderr
    const out = require('child_process').execSync(
      `"${javaPath}" -version 2>&1`,
      { encoding: 'utf8', timeout: 6000 }
    );
    // "openjdk version "21.0.1" ..." or "java version "1.8.0_391""
    const m = out.match(/"(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    const major = parseInt(m[1]);
    // Pre-9 versioning: 1.8 → 8
    return major === 1 ? parseInt(m[2] || '0') : major;
  } catch (_) {
    return null;
  }
}

// Minimum Java major version Mojang/Paper/Fabric/Forge/NeoForge require to
// boot a given MC version. Snapshot strings (24w..., 25w..., 1.x-rc#, 1.x-pre#)
// fall through to the closest release bucket via the explicit checks below.
const RECOMMENDED_JAVA_MAJOR = 25;
function requiredJavaMajor(mcVersion) {
  if (!mcVersion || typeof mcVersion !== 'string') return RECOMMENDED_JAVA_MAJOR;
  const v = mcVersion.trim();

  // Snapshots like 25w12a — the year tells us the era. 24w+ are 1.21.x; 25w+ are 1.21.6+/1.22.
  const snap = v.match(/^(\d{2})w\d/);
  if (snap) {
    const year = parseInt(snap[1], 10);
    if (year >= 25) return 25;
    if (year >= 24) return 21;
    return 17;
  }

  // Parse "1.MAJOR(.MINOR)" — pre/rc tags share the surrounding release bucket.
  const m = v.match(/^1\.(\d+)(?:\.(\d+))?/);
  if (!m) return RECOMMENDED_JAVA_MAJOR;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2] || '0', 10);

  if (major <= 16) return 8;
  if (major === 17) return 16;
  if (major < 20) return 17;                            // 1.18, 1.19
  if (major === 20 && minor <= 4) return 17;            // 1.20 – 1.20.4
  if (major === 20) return 21;                          // 1.20.5+
  if (major === 21 && minor <= 5) return 21;            // 1.21 – 1.21.5
  return 25;                                            // 1.21.6+ and beyond
}

app.get('/api/java-status', (req, res) => {
  const version = getJavaVersion();
  const requestedMc = typeof req.query.version === 'string' ? req.query.version : null;
  const requiredMajor = requestedMc ? requiredJavaMajor(requestedMc) : RECOMMENDED_JAVA_MAJOR;
  res.json({
    version,
    requiredMajor,
    recommended: RECOMMENDED_JAVA_MAJOR,
    mcVersion: requestedMc,
    ok: version !== null && version >= requiredMajor,
  });
});

// Version cache (10-minute TTL)
const versionCache = {};
const VERSION_CACHE_TTL = 10 * 60 * 1000;
// temp_uploads must live under the writable data dir — when packaged the
// backend code is inside app.asar (read-only) and writes to __dirname fail.
fs.ensureDirSync(path.join(DATA_DIR, 'temp_uploads'));

// In-memory process tracking
const activeProcesses = {};
const activeLogs = {};
const serverStates = {}; // Stores startTime, players array, etc.
const serverJavaPids = {}; // Maps server id -> actual Java process PID
const allChildProcesses = new Set(); // Every spawned child proc, for clean shutdown

// Auto-backup interval handles (serverId → NodeJS interval)
const autoBackupIntervals = {};


// ─── Crash Pattern Definitions ────────────────────────────────────────────────
const CRASH_PATTERNS = [
  {
    test: (t) => /java\.lang\.OutOfMemoryError/i.test(t),
    type: 'oom',
    message: 'Your server ran out of memory. Increase the Max RAM allocation in server settings.',
    tab: 'options',
  },
  {
    test: (t) => /Address already in use/i.test(t),
    type: 'port',
    message: 'Port 25565 is already in use by another program or server. Change the port in Server Options.',
    tab: 'options',
  },
  {
    test: (t) => /UnsupportedClassVersionError|class file version \d+\.\d+/i.test(t),
    type: 'java',
    message: 'Your Java version is too old for this server. Please update Java.',
    tab: null,
  },
  {
    // Broad mod version mismatch — but NOT the missing dep crash (that's handled separately)
    test: (t) =>
      /incompatible mod set|ModLoadingException|Failed to create mod instance|forge\.fml\.ModLoadingException/i.test(t) &&
      !/Missing or unsupported mandatory dep|LoadingFailedException/i.test(t),
    type: 'version',
    message: 'A mod version mismatch was detected. Check that all mods are compatible with your Minecraft version.',
    tab: 'mods',
  },
];

function detectCrash(logText) {
  for (const pattern of CRASH_PATTERNS) {
    if (pattern.test(logText)) return { type: pattern.type, message: pattern.message, tab: pattern.tab };
  }
  return null;
}

// ─── Scheduled Tasks Engine ───────────────────────────────────────────────────
// Per-server tasks shaped { id, name, type: 'backup'|'restart'|'command', command?, schedule: { days[], hour, minute }, enabled }.
// One global ticker checks every minute. lastFireKey prevents duplicate firing within the same minute.
const taskLastFireKey = {}; // taskId -> "YYYY-M-D-H-M"

async function runScheduledTask(serverId, task) {
  try {
    if (task.type === 'backup') {
      await createAutoBackup(serverId);
      io.emit(`console_${serverId}`, `[Scheduled] Backup "${task.name}" triggered.\n`);
    } else if (task.type === 'restart') {
      io.emit(`console_${serverId}`, `[Scheduled] Restart "${task.name}" triggered.\n`);
      const proc = activeProcesses[serverId];
      if (proc) {
        proc.stdin.write('stop\n');
        // Wait for shutdown, then start again (mirror the /restart endpoint pattern at a distance — best-effort).
        const waitStop = new Promise((resolve) => {
          const check = setInterval(() => {
            if (!activeProcesses[serverId]) { clearInterval(check); resolve(); }
          }, 500);
          setTimeout(() => { clearInterval(check); resolve(); }, 60000);
        });
        await waitStop;
      }
      // Start (will be a no-op if the server doesn't exist / was deleted)
      const servers = await getServers();
      const cfg = servers.find(s => s.id === serverId);
      if (cfg) startProcess(serverId, cfg, path.join(INSTANCES_DIR, serverId));
    } else if (task.type === 'command') {
      const proc = activeProcesses[serverId];
      if (proc && task.command) {
        proc.stdin.write(task.command.replace(/^\//, '') + '\n');
        io.emit(`console_${serverId}`, `[Scheduled] Ran "${task.command}" (${task.name})\n`);
      }
    }
  } catch (err) {
    console.error(`[MineDash Schedule] Task ${task.id} failed:`, err.message);
  }
}

function checkScheduledTasks() {
  const now = new Date();
  const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  const dow = now.getDay();
  getServers().then(servers => {
    for (const server of servers) {
      const tasks = server.scheduledTasks || [];
      for (const task of tasks) {
        if (!task.enabled) continue;
        const sch = task.schedule || {};
        if (sch.hour !== now.getHours() || sch.minute !== now.getMinutes()) continue;
        if (Array.isArray(sch.days) && sch.days.length > 0 && !sch.days.includes(dow)) continue;
        if (taskLastFireKey[task.id] === key) continue;
        taskLastFireKey[task.id] = key;
        runScheduledTask(server.id, task);
      }
    }
  }).catch(() => {});
}

// Tick at the top of every minute, aligned for predictability.
function startScheduleEngine() {
  const align = () => {
    const ms = (60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds();
    setTimeout(() => {
      checkScheduledTasks();
      setInterval(checkScheduledTasks, 60 * 1000);
    }, ms);
  };
  align();
}
startScheduleEngine();

// ─── Auto-Backup Helpers ──────────────────────────────────────────────────────
async function createAutoBackup(serverId) {
  const serverBackupsDir = path.join(BACKUPS_DIR, serverId);
  const serverPath = path.join(INSTANCES_DIR, serverId);
  await fs.ensureDir(serverBackupsDir);

  const backupName = `auto-backup-${Date.now()}.zip`;
  const backupPath = path.join(serverBackupsDir, backupName);
  const mcProcess = activeProcesses[serverId];
  const isRunning = !!mcProcess;

  try {
    if (isRunning) {
      mcProcess.stdin.write('save-off\n');
      mcProcess.stdin.write('save-all flush\n');
      io.emit(`console_${serverId}`, '[Backup] Auto-backup: flushing world data...\n');
      await new Promise(resolve => setTimeout(resolve, 2500));
    }

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(backupPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      // Same as the manual backup: session.lock is a JVM FileLock that can't be
      // read while the server is running, so archiver throws EBUSY/EPERM and the
      // whole zip fails. Skip it (regenerated automatically on next start).
      archive.on('warning', (err) => { if (err.code !== 'ENOENT') reject(err); });
      archive.pipe(output);
      archive.glob('**', {
        cwd: serverPath,
        dot: true,
        ignore: ['session.lock', '**/session.lock'],
      });
      archive.finalize();
    });

    if (isRunning) mcProcess.stdin.write('save-on\n');
    io.emit(`console_${serverId}`, `[Backup] Auto-backup created: ${backupName}\n`);

    // Enforce retention — delete oldest backups beyond keepLastNBackups
    const servers = await getServers();
    const config = servers.find(s => s.id === serverId);
    if (config && config.keepLastNBackups > 0) {
      const pinned = new Set(config.pinnedBackups || []);
      const files = await fs.readdir(serverBackupsDir);
      const sorted = files
        .filter(f => f.endsWith('.zip') && !pinned.has(f))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(serverBackupsDir, f)).mtime }))
        .sort((a, b) => b.mtime - a.mtime); // newest first
      for (const old of sorted.slice(config.keepLastNBackups)) {
        await fs.remove(path.join(serverBackupsDir, old.name));
        console.log(`[MineDash Backup] Pruned old backup: ${old.name}`);
      }
    }
  } catch (err) {
    if (isRunning) { try { mcProcess.stdin.write('save-on\n'); } catch (_) {} }
    await fs.remove(backupPath).catch(() => {});
    console.error(`[MineDash Backup] Auto-backup failed for ${serverId}:`, err.message);
  }
}

function startAutoBackupInterval(serverId, config) {
  stopAutoBackupInterval(serverId); // clear any existing interval
  if (!config.autoBackup || !config.backupIntervalHours) return;

  const ms = Number(config.backupIntervalHours) * 60 * 60 * 1000;
  autoBackupIntervals[serverId] = setInterval(() => {
    createAutoBackup(serverId).catch(err =>
      console.error('[MineDash Backup] Interval error:', err.message)
    );
  }, ms);
  console.log(`[MineDash Backup] Auto-backup active for ${serverId}: every ${config.backupIntervalHours}h, keep last ${config.keepLastNBackups || '∞'}`);
}

function stopAutoBackupInterval(serverId) {
  if (autoBackupIntervals[serverId]) {
    clearInterval(autoBackupIntervals[serverId]);
    delete autoBackupIntervals[serverId];
  }
}


async function getServerPort(serverId) {
  try {
    const propsPath = path.join(INSTANCES_DIR, serverId, 'server.properties');
    const content = await fs.readFile(propsPath, 'utf8');
    const match = content.match(/^server-port\s*=\s*(\d+)/m);
    if (match) return parseInt(match[1]);
  } catch (_) {}
  return 25565;
}


// Get all descendant PIDs of a given parent (recursive tree walk)
function getAllDescendantPids(parentPid) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      exec(`pgrep -P ${parentPid}`, (err, stdout) => {
        if (!err && stdout.trim()) {
          const childPids = stdout.trim().split('\n').map(p => parseInt(p.trim())).filter(p => !isNaN(p));
          // Recurse for each child
          Promise.all(childPids.map(pid => getAllDescendantPids(pid)))
            .then(grandchildren => {
              resolve([...childPids, ...grandchildren.flat()]);
            });
        } else {
          resolve([]);
        }
      });
      return;
    }

    // Windows: Get direct children via PowerShell
    const psCmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${parentPid} } | Select-Object ProcessId, Name, WorkingSetSize | ConvertTo-Json"`;
    exec(psCmd, (err, stdout) => {
      if (err || !stdout.trim()) { resolve([]); return; }
      try {
        const parsed = JSON.parse(stdout.trim());
        const children = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        const childPids = children.map(c => ({
          pid: c.ProcessId,
          name: (c.Name || '').toLowerCase(),
          memBytes: c.WorkingSetSize || 0
        }));

        // Recurse into children
        Promise.all(childPids.map(c => getAllDescendantPids(c.pid)))
          .then(grandchildren => {
            const allDescendants = [...childPids, ...grandchildren.flat()];
            resolve(allDescendants);
          });
      } catch (e) {
        resolve([]);
      }
    });
  });
}

// Find the heaviest java.exe descendant of a process
function findHeaviestJavaDescendant(parentPid) {
  return new Promise(async (resolve) => {
    const descendants = await getAllDescendantPids(parentPid);
    console.log(`[MineDash PID] All descendants of PID ${parentPid}:`, 
      descendants.map(d => typeof d === 'object' ? `${d.name}(${d.pid}, ${Math.round((d.memBytes||0)/1024/1024)}MB)` : d).join(', ') || 'none');

    // Filter for java processes and pick the one with most memory
    const javaProcs = descendants.filter(d => 
      typeof d === 'object' && d.name && (d.name.includes('java') || d.name.includes('javaw'))
    );

    if (javaProcs.length === 0) {
      resolve(null);
      return;
    }

    // Sort by memory descending, pick the heaviest
    javaProcs.sort((a, b) => (b.memBytes || 0) - (a.memBytes || 0));
    const best = javaProcs[0];
    console.log(`[MineDash PID] Heaviest Java descendant: ${best.name} PID=${best.pid} (${Math.round((best.memBytes||0)/1024/1024)} MB)`);
    resolve(best.pid);
  });
}

// Fallback: Find java.exe processes whose command line references this server's directory
function findJavaByServerDir(serverPath) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null);
      return;
    }
    const serverDirName = path.basename(serverPath);
    const psCmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='java.exe'\\" | Select-Object ProcessId, CommandLine, WorkingSetSize | ConvertTo-Json"`;
    exec(psCmd, (err, stdout) => {
      if (err || !stdout.trim()) { resolve(null); return; }
      try {
        const parsed = JSON.parse(stdout.trim());
        const procs = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        // Find the java process whose command line contains our server directory name
        const matching = procs.filter(p => (p.CommandLine || '').includes(serverDirName));
        if (matching.length > 0) {
          // Pick the heaviest match
          matching.sort((a, b) => (b.WorkingSetSize || 0) - (a.WorkingSetSize || 0));
          console.log(`[MineDash PID] Found Java by server dir '${serverDirName}': PID=${matching[0].ProcessId} (${Math.round((matching[0].WorkingSetSize||0)/1024/1024)} MB)`);
          resolve(matching[0].ProcessId);
          return;
        }
      } catch (e) { /* ignore */ }
      resolve(null);
    });
  });
}

// Periodically discover Java PIDs for running servers
function discoverJavaPid(id, parentPid, serverPath) {
  let attempts = 0;
  const maxAttempts = 30; // Try for 60 seconds
  console.log(`[MineDash PID] Starting Java PID discovery for server ${id} (parent PID: ${parentPid})`);

  const tryDiscover = async () => {
    attempts++;
    if (serverJavaPids[id] || attempts > maxAttempts || !activeProcesses[id]) {
      if (!serverJavaPids[id] && attempts > maxAttempts) {
        console.log(`[MineDash PID] Gave up finding Java PID for server ${id} after ${maxAttempts} attempts`);
      }
      clearInterval(intervalHandle);
      return;
    }

    // Method 1: Walk the process tree from parent, find the heaviest java descendant
    let javaPid = await findHeaviestJavaDescendant(parentPid);

    // Method 2: If tree walk failed, search by server directory in command lines
    if (!javaPid && serverPath) {
      javaPid = await findJavaByServerDir(serverPath);
    }

    if (javaPid) {
      serverJavaPids[id] = javaPid;
      console.log(`[MineDash PID] ✓ Resolved Java PID ${javaPid} for server ${id} (attempt ${attempts})`);
      clearInterval(intervalHandle);
    } else {
      console.log(`[MineDash PID] Attempt ${attempts}/${maxAttempts}: No Java PID found yet for ${id}`);
    }
  };

  // First attempt immediately
  setTimeout(tryDiscover, 1000);
  const intervalHandle = setInterval(tryDiscover, 3000);
}

// Debug endpoint to inspect PID state
app.get('/api/debug/pids', (req, res) => {
  const info = {};
  for (const id in activeProcesses) {
    const proc = activeProcesses[id];
    info[id] = {
      spawnedPid: proc ? proc.pid : null,
      javaPid: serverJavaPids[id] || null,
      usingPid: serverJavaPids[id] || (proc ? proc.pid : null),
    };
  }
  res.json(info);
});

// Helper to read servers
async function getServers() {
  try {
    const data = await fs.readFile(SERVERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.writeFile(SERVERS_FILE, JSON.stringify([]));
      return [];
    }
    throw error;
  }
}

async function saveServers(servers) {
  await fs.writeFile(SERVERS_FILE, JSON.stringify(servers, null, 2));
}

// Download official Mojang vanilla server JAR
async function downloadVanilla(version, destPath) {
  try {
    console.log(`Downloading Vanilla ${version} from Mojang...`);
    const manifestRes = await axios.get('https://launchermeta.mojang.com/mc/game/version_manifest.json');
    const entry = manifestRes.data.versions.find(v => v.id === version);
    if (!entry) {
      console.error(`Vanilla version ${version} not found in Mojang manifest`);
      return false;
    }
    const verRes = await axios.get(entry.url);
    const serverUrl = verRes.data.downloads?.server?.url;
    if (!serverUrl) {
      console.error(`No server download available for vanilla ${version}`);
      return false;
    }
    const response = await axios({ url: serverUrl, method: 'GET', responseType: 'stream' });
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(true));
      writer.on('error', reject);
    });
  } catch (err) {
    console.error(`Failed to download Vanilla ${version}:`, err.message);
    return false;
  }
}

// Download Paper Jar helper
async function downloadPaper(version, destPath) {
  try {
    console.log(`Downloading Paper for version ${version}...`);
    const buildsRes = await axios.get(`https://api.papermc.io/v2/projects/paper/versions/${version}`);
    const latestBuild = buildsRes.data.builds[buildsRes.data.builds.length - 1];
    const jarName = `paper-${version}-${latestBuild}.jar`;
    const downloadUrl = `https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${latestBuild}/downloads/${jarName}`;
    
    const response = await axios({
      url: downloadUrl,
      method: 'GET',
      responseType: 'stream'
    });
    
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(true));
      writer.on('error', reject);
    });
  } catch (error) {
    console.error(`Failed to download Paper ${version}:`, error.message);
    return false; // Fallback to dummy
  }
}

// Fabric Installer
async function installFabric(id, version, serverPath, appendLog) {
  try {
    appendLog(`[MineDash] Fetching latest Fabric installer for ${version}...\n`);
    const loaderRes = await axios.get(`https://meta.fabricmc.net/v2/versions/loader/${version}`);
    if (!loaderRes.data || loaderRes.data.length === 0) {
      appendLog(`[MineDash] Error: No Fabric version found for ${version}\n`);
      return false;
    }
    const loaderVersion = loaderRes.data[0].loader.version;
    const installerVersion = '1.0.1'; // Can be fetched dynamically, but 1.0.1 is standard fallback if latest endpoint fails. Actually let's fetch latest installer.
    const instRes = await axios.get('https://meta.fabricmc.net/v2/versions/installer');
    const latestInst = instRes.data[0].version;

    const downloadUrl = `https://meta.fabricmc.net/v2/versions/loader/${version}/${loaderVersion}/${latestInst}/server/jar`;
    appendLog(`[MineDash] Downloading Fabric Server JAR...\n`);
    
    const response = await axios({ url: downloadUrl, method: 'GET', responseType: 'stream' });
    const destPath = path.join(serverPath, 'server.jar');
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    
    appendLog(`[MineDash] Fabric installed successfully!\n`);
    return true;
  } catch (err) {
    appendLog(`[MineDash] Fabric installation failed: ${err.message}\n`);
    return false;
  }
}

// Forge Installer
async function installForge(id, serverConfig, serverPath, appendLog) {
  try {
    appendLog(`[MineDash] Fetching latest Forge installer for ${serverConfig.version}...\n`);

    const promoRes = await axios.get('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
    const promos = promoRes.data.promos || {};

    const mcVersion = serverConfig.version;
    const forgeVersion = promos[`${mcVersion}-recommended`] || promos[`${mcVersion}-latest`];

    if (!forgeVersion) {
      appendLog(`[MineDash] Error: No Forge version found for Minecraft ${mcVersion}\n`);
      return false;
    }

    const fullVersion = `${mcVersion}-${forgeVersion}`;
    const downloadUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${fullVersion}/forge-${fullVersion}-installer.jar`;

    appendLog(`[MineDash] Downloading Forge Installer ${fullVersion}...\n`);

    const installerPath = path.join(serverPath, 'forge-installer.jar');
    const response = await axios({ url: downloadUrl, method: 'GET', responseType: 'stream' });
    const writer = fs.createWriteStream(installerPath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    appendLog(`[MineDash] Running Forge Installer... This may take a moment.\n`);

    await new Promise((resolve, reject) => {
      const instProc = spawn(getJavaPath(), ['-jar', 'forge-installer.jar', '--installServer'], { cwd: serverPath });
      allChildProcesses.add(instProc);
      instProc.on('exit', () => allChildProcesses.delete(instProc));
      instProc.stdout.on('data', d => appendLog(d.toString()));
      instProc.stderr.on('data', d => appendLog(d.toString()));
      instProc.on('exit', code => {
        if (code === 0) resolve();
        else reject(new Error(`Forge installer exited with code ${code}`));
      });
    });

    // Newer Forge (1.17+) creates user_jvm_args.txt — apply RAM settings
    const argsPath = path.join(serverPath, 'user_jvm_args.txt');
    if (fs.existsSync(argsPath)) {
      appendLog(`[MineDash] Applying RAM settings to user_jvm_args.txt...\n`);
      const argsContent = fs.readFileSync(argsPath, 'utf8');
      fs.writeFileSync(argsPath, argsContent + `\n-Xms${serverConfig.minRam}\n-Xmx${serverConfig.maxRam}\n`);
    }

    // Remove pause from run.bat so the process closes cleanly
    const runBatPath = path.join(serverPath, 'run.bat');
    if (fs.existsSync(runBatPath)) {
      let batContent = fs.readFileSync(runBatPath, 'utf8');
      batContent = batContent.replace(/^pause\s*$/gm, '');
      fs.writeFileSync(runBatPath, batContent);
    }

    // Older Forge (pre-1.17) produces a forge jar directly — rename to server.jar
    const runShPath = path.join(serverPath, 'run.sh');
    if (!fs.existsSync(runBatPath) && !fs.existsSync(runShPath)) {
      const files = fs.readdirSync(serverPath);
      const forgeJar = files.find(f => f.startsWith('forge-') && f.endsWith('.jar') && !f.includes('installer'));
      if (forgeJar) {
        appendLog(`[MineDash] Renaming ${forgeJar} to server.jar...\n`);
        fs.renameSync(path.join(serverPath, forgeJar), path.join(serverPath, 'server.jar'));
      }
    }

    appendLog(`[MineDash] Forge installed successfully!\n`);
    return true;
  } catch (err) {
    appendLog(`[MineDash] Forge installation failed: ${err.message}\n`);
    return false;
  }
}

// NeoForge Installer
async function installNeoForge(id, serverConfig, serverPath, appendLog) {
  try {
    appendLog(`[MineDash] Fetching latest NeoForge installer for ${serverConfig.version}...\n`);
    const metaRes = await axios.get('https://maven.neoforged.net/api/maven/details/releases/net/neoforged/neoforge', { family: 4, timeout: 60000 });
    
    // MC 1.21.1 -> Prefix 21.1.
    const parts = serverConfig.version.split('.');
    const nfPrefix = `${parts[1]}.${parts[2] || '0'}.`;
    
    let targetVersion = null;
    const files = metaRes.data.files || [];
    // Sort reverse to get latest
    for (let i = files.length - 1; i >= 0; i--) {
      if (files[i].type === 'DIRECTORY' && files[i].name.startsWith(nfPrefix)) {
        targetVersion = files[i].name;
        break;
      }
    }
    
    if (!targetVersion) {
      appendLog(`[MineDash] Error: No NeoForge version found for ${serverConfig.version}\n`);
      return false;
    }

    appendLog(`[MineDash] Downloading NeoForge Installer ${targetVersion}...\n`);
    const downloadUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${targetVersion}/neoforge-${targetVersion}-installer.jar`;
    
    const installerPath = path.join(serverPath, 'neoforge-installer.jar');
    const response = await axios({ url: downloadUrl, method: 'GET', responseType: 'stream', family: 4 });
    const writer = fs.createWriteStream(installerPath);
    response.data.pipe(writer);
    
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    appendLog(`[MineDash] Running NeoForge Installer... This may take a moment.\n`);
    
    await new Promise((resolve, reject) => {
      const instProc = spawn(getJavaPath(), ['-jar', 'neoforge-installer.jar', '--installServer'], { cwd: serverPath });
      allChildProcesses.add(instProc);
      instProc.on('exit', () => allChildProcesses.delete(instProc));
      instProc.stdout.on('data', d => appendLog(d.toString()));
      instProc.stderr.on('data', d => appendLog(d.toString()));
      instProc.on('exit', code => {
        if (code === 0) resolve();
        else reject(new Error(`Installer exited with code ${code}`));
      });
    });

    appendLog(`[MineDash] Applying user RAM settings to user_jvm_args.txt...\n`);
    const argsPath = path.join(serverPath, 'user_jvm_args.txt');
    if (fs.existsSync(argsPath)) {
      const argsContent = fs.readFileSync(argsPath, 'utf8');
      const newContent = argsContent 
        + `\n-Xms${serverConfig.minRam}\n-Xmx${serverConfig.maxRam}\n`;
      fs.writeFileSync(argsPath, newContent);
    }

    // Remove pause from run.bat so it closes correctly
    const runBatPath = path.join(serverPath, 'run.bat');
    if (fs.existsSync(runBatPath)) {
      let batContent = fs.readFileSync(runBatPath, 'utf8');
      batContent = batContent.replace(/^pause\s*$/gm, '');
      fs.writeFileSync(runBatPath, batContent);
    }

    appendLog(`[MineDash] NeoForge installed successfully!\n`);
    return true;
  } catch (err) {
    appendLog(`[MineDash] NeoForge installation failed: ${err.message}\n`);
    return false;
  }
}

// ======== Version API ========
async function fetchVersionsForType(type, opts = {}) {
  const { includeSnapshots = false } = opts;
  const cacheKey = type === 'vanilla' && includeSnapshots ? 'vanilla-all' : type;
  const cached = versionCache[cacheKey];
  if (cached && (Date.now() - cached.timestamp < VERSION_CACHE_TTL)) {
    return cached.data;
  }

  let versions = [];
  try {
    if (type === 'vanilla') {
      const res = await axios.get('https://launchermeta.mojang.com/mc/game/version_manifest.json');
      // Manifest is already newest-first. Optionally include snapshots/old beta+alpha.
      versions = res.data.versions
        .filter(v => includeSnapshots ? true : v.type === 'release')
        .map(v => v.id);
    } else if (type === 'paper') {
      const res = await axios.get('https://api.papermc.io/v2/projects/paper');
      versions = (res.data.versions || [])
        .filter(v => /^\d+\.\d+(\.\d+)?$/.test(v))
        .reverse(); // newest first
    } else if (type === 'fabric') {
      const res = await axios.get('https://meta.fabricmc.net/v2/versions/game');
      // Only stable versions starting with 1. (excludes snapshot numbering like 26.x)
      versions = res.data
        .filter(v => v.stable && v.version.startsWith('1.'))
        .map(v => v.version);
    } else if (type === 'forge') {
      const res = await axios.get('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
      const promos = res.data.promos || {};
      const versionSet = new Set();
      for (const key of Object.keys(promos)) {
        const mcVer = key.split('-')[0];
        // Only include proper MC versions (1.x.x format)
        if (mcVer && /^1\.\d+(\.\d+)?$/.test(mcVer)) {
          versionSet.add(mcVer);
        }
      }
      versions = Array.from(versionSet).sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const diff = (pb[i] || 0) - (pa[i] || 0);
          if (diff !== 0) return diff;
        }
        return 0;
      });
    } else if (type === 'neoforge') {
      // maven.neoforged.net publishes AAAA records, but its IPv6 endpoints time out
      // from many residential networks. Force IPv4 so the request doesn't hang.
      const res = await axios.get('https://maven.neoforged.net/api/maven/details/releases/net/neoforged/neoforge', { family: 4, timeout: 60000 });
      const files = res.data.files || [];
      const versionSet = new Set();
      for (const f of files) {
        if (f.type === 'DIRECTORY') {
          // NeoForge version like 21.1.77 maps to MC 1.21.1
          // NeoForge started at MC 1.20.x so major must be >= 20
          const parts = f.name.split('.');
          if (parts.length >= 2) {
            const major = parseInt(parts[0]);
            const minor = parseInt(parts[1]);
            if (!isNaN(major) && !isNaN(minor) && major >= 20) {
              const mcVer = minor === 0 ? `1.${major}` : `1.${major}.${minor}`;
              versionSet.add(mcVer);
            }
          }
        }
      }
      versions = Array.from(versionSet).sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const diff = (pb[i] || 0) - (pa[i] || 0);
          if (diff !== 0) return diff;
        }
        return 0;
      });
    }
  } catch (err) {
    console.error(`Failed to fetch versions for ${type}:`, err.message);
    // Re-throw so the route returns a visible 500 instead of silently serving []
    // and (more importantly) so we don't cache the empty result for 10 minutes.
    throw err;
  }

  // Don't cache empty results — a transient API failure would lock us into an
  // empty list for the full TTL even after the upstream recovers.
  if (versions.length > 0) {
    versionCache[cacheKey] = { data: versions, timestamp: Date.now() };
  }
  return versions;
}

app.get('/api/versions/:type', async (req, res) => {
  const { type } = req.params;
  const validTypes = ['vanilla', 'paper', 'forge', 'fabric', 'neoforge'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: 'Invalid server type' });
  }
  try {
    const includeSnapshots = req.query.includeSnapshots === '1' || req.query.includeSnapshots === 'true';
    const versions = await fetchVersionsForType(type, { includeSnapshots });
    res.json(versions);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch versions' });
  }
});

// API Routes
app.get('/api/servers', async (req, res) => {
  const servers = await getServers();
  const mapped = servers.map(s => ({
    ...s,
    status: activeProcesses[s.id] ? 'online' : 'offline'
  }));
  res.json(mapped);
});

app.post('/api/servers', async (req, res) => {
  const { name, version, type, minRam, maxRam, autoRestart, autoBackup, backupIntervalHours, keepLastNBackups } = req.body;

  const existing = await getServers();
  if (existing.some(s => s.name.toLowerCase() === name.trim().toLowerCase())) {
    return res.status(400).json({ error: `A server named "${name}" already exists.` });
  }

  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now();
  
  const serverPath = path.join(INSTANCES_DIR, id);
  await fs.ensureDir(serverPath);
  await fs.ensureDir(path.join(serverPath, 'mods'));
  await fs.ensureDir(path.join(serverPath, 'config'));
  
  // Auto accept EULA and disable online mode
  await fs.writeFile(path.join(serverPath, 'eula.txt'), 'eula=true\n');
  await fs.writeFile(
    path.join(serverPath, 'server.properties'), 
    'online-mode=false\nenforce-secure-profile=false\n'
  );

  if (type === 'vanilla') {
    const ok = await downloadVanilla(version, path.join(serverPath, 'server.jar'));
    if (!ok) {
      await fs.remove(serverPath).catch(() => {});
      return res.status(500).json({ error: `Failed to download vanilla ${version}. Check that the version exists and retry.` });
    }
  } else if (type === 'paper') {
    // Paper uses plugins/ instead of mods/
    await fs.ensureDir(path.join(serverPath, 'plugins'));
    const ok = await downloadPaper(version, path.join(serverPath, 'server.jar'));
    if (!ok) {
      await fs.remove(serverPath).catch(() => {});
      return res.status(500).json({ error: `Failed to download Paper ${version}. Check that the version exists and retry.` });
    }
  }

  const newServer = {
    id,
    name,
    version,
    type,
    minRam: minRam || '2G',
    maxRam: maxRam || '4G',
    autoRestart: autoRestart || false,
    autoBackup: autoBackup || false,
    backupIntervalHours: backupIntervalHours ? Number(backupIntervalHours) : 6,
    keepLastNBackups: keepLastNBackups ? Number(keepLastNBackups) : 5,
    status: 'offline'
  };

  const servers = await getServers();
  servers.push(newServer);
  await saveServers(servers);

  io.emit('server_created', newServer);
  res.json(newServer);
});

// ─── Modpack import (.mrpack) ────────────────────────────────────────────────
// Reusable multer instance scoped to mrpack uploads (16 MB max — index + small overrides).
const mrpackUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024 }, // 64MB for fat modpacks-with-configs
});

function detectModpackType(deps = {}) {
  if (deps['neoforge']) return { type: 'neoforge', loaderVersion: deps['neoforge'] };
  if (deps['forge']) return { type: 'forge', loaderVersion: deps['forge'] };
  if (deps['fabric-loader']) return { type: 'fabric', loaderVersion: deps['fabric-loader'] };
  if (deps['quilt-loader']) return null; // Unsupported — caller decides what to do
  return null;
}

// Known client-only mod filename patterns. We use these to skip mods that
// would crash a dedicated server during `.mrpack` import. Patterns match the
// *start* of the filename (case-insensitive) followed by a non-alphanumeric
// boundary, so e.g. `oculus-1.7.0.jar` matches but `oculus-server-extras.jar`
// (hypothetical, doesn't exist) wouldn't be a false negative because we still
// catch the underscore/dot/dash boundary.
//
// This list isn't exhaustive — it covers the well-known offenders that show
// up in 90% of "modpack server crash" reports. Pure-rendering / pure-UI mods
// are the safest bets; mods with optional server-side functionality (JEI,
// JourneyMap, etc.) are intentionally NOT in here because some packs legit
// want them on the server side.
const CLIENT_ONLY_MOD_PATTERNS = [
  // Shaders / OpenGL rendering — load native client libs, no server use
  /^(oculus|iris)([-_.]|$)/i,
  /^(optifine|optifabric)([-_.]|$)/i,
  /^(sodium|rubidium|embeddium|magnesium|indium|nvidium)([-_.]|$)/i,
  /^reese[s']?[-_]sodium/i,
  /^sodium[-_]?(extra|extras|options)/i,
  /^iris[-_]flywheel/i,
  // Pure visual / UI / animation
  /^(modmenu|mod[-_]menu)([-_.]|$)/i,
  /^continuity([-_.]|$)/i,
  /^animatica([-_.]|$)/i,
  /^lambdabettergrass/i,
  /^lambdynamiclights/i,
  /^(distant[-_]?horizons|distanthorizons)([-_.]|$)/i,
  /^3dskinlayers/i,
  /^waveycapes/i,
  /^chat[-_]?heads/i,
  /^particle[-_]?rain/i,
  /^physics[-_]?mod/i,
  /^visuality([-_.]|$)/i,
  /^entity[-_]?culling/i,
  /^better[-_]?clouds/i,
  /^betterf3/i,
  /^bobby([-_.]|$)/i,
  /^borderless[-_]?mining/i,
  /^citresewn/i,
  /^particular([-_.]|$)/i,
  // Inventory/UI overlays
  /^inventory[-_]?profiles[-_]?next/i,
  /^invmove([-_.]|$)/i,
  /^controlling([-_.]|$)/i,
  /^zoomify([-_.]|$)/i,
  /^smooth[-_]?swapping/i,
  /^enhanced[-_]?visuals/i,
  /^item[-_]?physic/i,
  // Maps / minimaps — Xaero's render in-client only; the server has no use for them
  /^xaeros?[-_]?(world)?map/i,
  /^xaeros?[-_]?minimap/i,
  /^journeymap([-_.]|$)/i,
  // Skins / chat / input
  /^customskinloader/i,
  /^je[-_]?characters/i,
  /^jei[-_]?characters/i,
  // First-person / camera
  /^firstperson([-_.]|$)/i,
  /^first[-_]?person[-_]?model/i,
  /^better[-_]?third[-_]?person/i,
];

function isClientOnlyModFilename(name) {
  if (!name) return false;
  // Strip any number of leading bracketed tags (`[Embeddium]`, `[Xaero's]`,
  // `[????]` from localized packs, etc.) plus surrounding whitespace before
  // matching, since our patterns are start-anchored. Without this, a jar
  // named "[??] sodiumextras-1.0.7.jar" sneaks past the deny-list and
  // crashes the dedicated server.
  let cleaned = name;
  while (true) {
    const stripped = cleaned.replace(/^\s*\[[^\]]*\]\s*/, '');
    if (stripped === cleaned) break;
    cleaned = stripped;
  }
  return CLIENT_ONLY_MOD_PATTERNS.some(re => re.test(cleaned));
}

// Per-server stash of mods we filtered out as client-only during modpack
// import. The launcher's syncClientMods reads from here so the user's client
// instance ends up with the FULL modpack (server mods + the client-side bits
// we kept out of the server) when they hit Play.
function clientModsStashDir(serverDir) {
  return path.join(serverDir, '.minedash-client-mods');
}

// Try every mirror in `urls[]` and save to <serverDir>/.minedash-client-mods/<basename>.
// Swallows errors — a missing client-only mod isn't fatal to a server import.
async function stashClientModFromUrls(serverDir, relPath, urls) {
  try {
    const base = path.basename(String(relPath || '').replace(/\\/g, '/'));
    if (!base || !/\.jar$/i.test(base)) return false;
    const dest = path.join(clientModsStashDir(serverDir), base);
    await fs.ensureDir(path.dirname(dest));
    await downloadFromAny(urls, dest);
    return true;
  } catch (e) {
    console.warn('[client-mods stash] failed to download', relPath, '-', e.message);
    return false;
  }
}

// Stash a client-only mod jar that lived inside overrides/ in the .mrpack
// (raw zip entry, no remote URL to fetch).
async function stashClientModFromZipEntry(serverDir, entry, relPath) {
  try {
    const base = path.basename(String(relPath || '').replace(/\\/g, '/'));
    if (!base || !/\.jar$/i.test(base)) return false;
    const dest = path.join(clientModsStashDir(serverDir), base);
    await fs.ensureDir(path.dirname(dest));
    await fs.writeFile(dest, entry.getData());
    return true;
  } catch (e) {
    console.warn('[client-mods stash] failed to extract', relPath, '-', e.message);
    return false;
  }
}

// Reject paths that try to escape the server directory.
function safeJoin(base, rel) {
  const normalized = path.normalize(rel).replace(/^([\\/]+)/, '');
  const joined = path.join(base, normalized);
  const resolved = path.resolve(joined);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) {
    throw new Error(`Refusing unsafe path: ${rel}`);
  }
  return resolved;
}

async function downloadToFile(url, destPath) {
  await fs.ensureDir(path.dirname(destPath));
  // Some CDNs (notably CurseForge mirrors used by Modrinth modpacks) reject the default
  // axios UA. Also stream large files instead of buffering in memory.
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout: 180000,
    maxRedirects: 10,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    headers: {
      'User-Agent': 'MineDash/1.0 (+https://github.com/anthropics) modpack-importer',
      'Accept': '*/*',
    },
    validateStatus: (s) => s >= 200 && s < 300,
  });
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(destPath);
    res.data.pipe(w);
    w.on('finish', resolve);
    w.on('error', reject);
    res.data.on('error', reject);
  });
}

// Try downloads[0]; on failure fall through to the rest.
async function downloadFromAny(urls, destPath) {
  const errors = [];
  for (const url of urls) {
    try {
      await downloadToFile(url, destPath);
      return;
    } catch (e) {
      const code = e.response?.status ? `HTTP ${e.response.status}` : e.code || 'ERR';
      errors.push(`${code} from ${new URL(url).host}`);
      await fs.remove(destPath).catch(() => {});
    }
  }
  throw new Error(errors.join('; ') || 'no download URLs');
}

app.post('/api/servers/from-modpack', mrpackUpload.single('mrpack'), async (req, res) => {
  let serverPath = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'No .mrpack file uploaded' });
    const userName = (req.body && req.body.name) ? String(req.body.name).trim() : '';
    // RAM (GB) from FormData; default 4 GB. Clamp to a sane range.
    const ramGB = Math.max(1, Math.min(32, parseInt(req.body?.ram, 10) || 4));

    // Parse the .mrpack (it's a zip)
    let zip;
    try {
      zip = new AdmZip(req.file.buffer);
    } catch (e) {
      return res.status(400).json({ error: 'Uploaded file is not a valid .mrpack (zip)' });
    }
    const indexEntry = zip.getEntry('modrinth.index.json');
    if (!indexEntry) return res.status(400).json({ error: 'modrinth.index.json missing — not a valid Modrinth modpack' });

    let index;
    try {
      index = JSON.parse(indexEntry.getData().toString('utf8'));
    } catch (e) {
      return res.status(400).json({ error: 'Could not parse modrinth.index.json' });
    }

    const mcVersion = index.dependencies && index.dependencies.minecraft;
    if (!mcVersion) return res.status(400).json({ error: 'Modpack does not declare a Minecraft version' });

    const detected = detectModpackType(index.dependencies);
    if (!detected) {
      return res.status(400).json({
        error: index.dependencies && index.dependencies['quilt-loader']
          ? 'Quilt modpacks are not supported yet — only Fabric, Forge, and NeoForge.'
          : 'Unsupported modpack: no recognized loader in dependencies.',
      });
    }

    const finalName = userName || index.name || `Modpack ${Date.now()}`;
    const existing = await getServers();
    if (existing.some(s => s.name.toLowerCase() === finalName.toLowerCase())) {
      return res.status(400).json({ error: `A server named "${finalName}" already exists.` });
    }

    const id = finalName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now();
    serverPath = path.join(INSTANCES_DIR, id);
    await fs.ensureDir(serverPath);
    await fs.ensureDir(path.join(serverPath, 'mods'));
    await fs.ensureDir(path.join(serverPath, 'config'));

    await fs.writeFile(path.join(serverPath, 'eula.txt'), 'eula=true\n');
    await fs.writeFile(path.join(serverPath, 'server.properties'), 'online-mode=false\nenforce-secure-profile=false\n');

    // Download declared files. The previous filter only excluded the explicit
    // `env.server === 'unsupported'` case, but a lot of packs in the wild
    // either:
    //   1. Mark client-only mods as env.server: 'optional' / 'required' by
    //      mistake, so the unsupported-only check lets them through.
    //   2. Ship pure client mods (Oculus, Iris, Sodium, Rubidium…) inside
    //      `overrides/mods/` with no env metadata at all — see the override
    //      extractor below for that branch.
    // The rule here is: if a file's env shows it's client-required and the
    // server doesn't require it, it's a client mod — skip it. Plus we also
    // run filenames through `isClientOnlyModFilename` as a belt-and-braces
    // catch for packs that lied about env entirely.
    const files = Array.isArray(index.files) ? index.files : [];
    const skippedClient = [];
    // Stash client-only files (with download URLs) so syncClientMods can later
    // push them into the user's client profile when they hit Play.
    const clientOnlyFiles = [];
    const downloadable = files.filter(f => {
      if (!f || !Array.isArray(f.downloads) || f.downloads.length === 0) return false;
      const env = f.env || {};
      if (env.server === 'unsupported') {
        // env.server=unsupported with env.client=required means it's a real client mod.
        if (env.client === 'required') clientOnlyFiles.push(f);
        return false;
      }
      // env.client === 'required' && env.server !== 'required' means the mod
      // is client-side-required, not server-side-required → client-only.
      if (env.client === 'required' && env.server !== 'required') {
        skippedClient.push(f.path);
        clientOnlyFiles.push(f);
        return false;
      }
      // Filename heuristic for the cases where env is lying or absent. Only
      // applies under mods/ — we don't want to skip a legitimately-named file
      // in config/ or resourcepacks/.
      const rel = String(f.path || '').replace(/\\/g, '/');
      if (rel.startsWith('mods/') && isClientOnlyModFilename(path.basename(rel))) {
        skippedClient.push(f.path);
        clientOnlyFiles.push(f);
        return false;
      }
      return true;
    });

    let downloaded = 0;
    let failed = [];
    // Modrinth lists multiple mirrors in downloads[] — try all of them before giving up.
    for (const f of downloadable) {
      try {
        const dest = safeJoin(serverPath, f.path);
        await downloadFromAny(f.downloads, dest);
        downloaded++;
      } catch (e) {
        failed.push({ path: f.path, error: e.message });
      }
    }

    // Stash client-only mods so the launcher can later push the full modpack
    // (server + client bits) into the user's client profile.
    let clientStashed = 0;
    for (const f of clientOnlyFiles) {
      if (await stashClientModFromUrls(serverPath, f.path, f.downloads)) clientStashed++;
    }

    // Extract overrides/ (and server-overrides/) into the server directory.
    // We deliberately ignore client-overrides/. Inside overrides/mods/ we
    // also run the filename deny-list because that's where most "Oculus is
    // crashing my server" reports come from — pack authors drop Oculus.jar
    // into overrides/mods/ and the dedicated server explodes the moment it
    // tries to load it. Those filtered jars get stashed for the client.
    const overrideRoots = ['overrides', 'server-overrides'];
    for (const root of overrideRoots) {
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        if (!entry.entryName.startsWith(root + '/')) continue;
        const rel = entry.entryName.slice(root.length + 1);
        if (!rel) continue;
        const relNorm = rel.replace(/\\/g, '/');
        if (relNorm.startsWith('mods/') && isClientOnlyModFilename(path.basename(relNorm))) {
          skippedClient.push(entry.entryName);
          if (await stashClientModFromZipEntry(serverPath, entry, relNorm)) clientStashed++;
          continue;
        }
        try {
          const dest = safeJoin(serverPath, rel);
          await fs.ensureDir(path.dirname(dest));
          await fs.writeFile(dest, entry.getData());
        } catch (e) {
          failed.push({ path: entry.entryName, error: e.message });
        }
      }
    }

    // Also extract client-overrides/mods/ jars to the stash so the launcher
    // gets configs/mods the pack author meant only for the client side.
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      if (!entry.entryName.startsWith('client-overrides/')) continue;
      const rel = entry.entryName.slice('client-overrides/'.length);
      const relNorm = rel.replace(/\\/g, '/');
      if (!relNorm.startsWith('mods/')) continue;
      if (await stashClientModFromZipEntry(serverPath, entry, relNorm)) clientStashed++;
    }

    const newServer = {
      id,
      name: finalName,
      version: mcVersion,
      type: detected.type,
      minRam: `${ramGB}G`,
      maxRam: `${ramGB}G`,
      autoRestart: false,
      autoBackup: false,
      backupIntervalHours: 6,
      keepLastNBackups: 5,
      status: 'offline',
    };

    const servers = await getServers();
    servers.push(newServer);
    await saveServers(servers);

    io.emit('server_created', newServer);
    res.json({
      server: newServer,
      summary: {
        modpackName: index.name || 'Unknown',
        modpackVersion: index.versionId || '',
        type: detected.type,
        mcVersion,
        loaderVersion: detected.loaderVersion,
        downloaded,
        attempted: downloadable.length,
        failed,
        // Tell the UI which mods we deliberately skipped because they would
        // crash a dedicated server (Oculus, Iris, Sodium and friends). Lets
        // the user see "we did this for you, not a bug" rather than wondering
        // why some files from the pack didn't show up.
        skippedClientOnly: skippedClient,
        // How many of those skipped mods we stashed for client-side install
        // when the user hits Play.
        clientModsStashed: clientStashed,
      },
    });
  } catch (err) {
    console.error('[MineDash Modpack] Import failed:', err);
    if (serverPath) await fs.remove(serverPath).catch(() => {});
    res.status(500).json({ error: err.message || 'Failed to import modpack' });
  }
});

// ─── Clone an existing server ────────────────────────────────────────────────
app.post('/api/servers/:id/clone', async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'New name is required' });

    const servers = await getServers();
    const source = servers.find(s => s.id === id);
    if (!source) return res.status(404).json({ error: 'Source server not found' });

    const cleanName = name.trim();
    if (servers.some(s => s.name.toLowerCase() === cleanName.toLowerCase())) {
      return res.status(400).json({ error: `A server named "${cleanName}" already exists.` });
    }
    // Refuse to clone a running server — JVM holds file locks on world data
    if (activeProcesses[id]) {
      return res.status(409).json({ error: 'Stop the source server before cloning to avoid corrupted world data.' });
    }

    const newId = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now();
    const srcDir = path.join(INSTANCES_DIR, id);
    const dstDir = path.join(INSTANCES_DIR, newId);

    if (!await fs.pathExists(srcDir)) return res.status(404).json({ error: 'Source server files not found' });

    // Copy instance dir, skipping transient/runtime files that would just bloat the clone.
    const skip = new Set(['logs', 'crash-reports', 'session.lock']);
    await fs.copy(srcDir, dstDir, {
      filter: (src) => {
        const rel = path.relative(srcDir, src);
        if (!rel) return true;
        const top = rel.split(path.sep)[0];
        if (skip.has(top)) return false;
        if (rel.endsWith('session.lock')) return false;
        return true;
      },
    });

    const newServer = {
      ...source,
      id: newId,
      name: cleanName,
      status: 'offline',
      customUrl: '', // don't inherit — would collide with the source
      pinnedBackups: [], // pins are per-instance, fresh start
      // Re-id scheduled tasks so fire-tracking doesn't conflate with the source
      scheduledTasks: (source.scheduledTasks || []).map(t => ({
        ...t,
        id: 'task-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      })),
    };

    servers.push(newServer);
    await saveServers(servers);

    io.emit('server_created', newServer);
    res.json(newServer);
  } catch (err) {
    console.error('[MineDash Clone] Failed:', err);
    res.status(500).json({ error: err.message || 'Failed to clone server' });
  }
});

// ─── Console-based dependency auto-installer ─────────────────────────────────

// Strip Minecraft color/formatting codes (§0, §a, §r, §n, etc.)
function stripMcCodes(text) {
  return text.replace(/[§§][0-9a-fklmnorA-FKLMNOR]/g, '');
}

// Parse server crash output for missing mod IDs.
// Returns an array of mod ID strings to look up on Modrinth.
function parseMissingModIds(logText) {
  const clean = stripMcCodes(logText);
  const missing = new Set();
  let m;

  // MOST RELIABLE — Forge/NeoForge structured dep report:
  // "Mod ID: 'architectury', Requested by: 'exposure_expanded', ..., Actual version: '[MISSING]'"
  const forgeStructured = /Mod ID:\s*'([^']+)'[^,\n]*,\s*Requested by:[^\n]*Actual version:\s*'\[MISSING\]'/gi;
  while ((m = forgeStructured.exec(clean)) !== null) missing.add(m[1].toLowerCase());

  // Forge/NeoForge prose message: "Currently, <modid> is ... not installed"
  const forge1 = /Currently,\s+(\S+)\s+is\s+(?:\S+\s+)*?not installed/gi;
  while ((m = forge1.exec(clean)) !== null) missing.add(m[1].toLowerCase());

  // Forge/NeoForge: "Mod X requires <modid> <semver>" inside a loading-errors block
  if (/LoadingFailedException|loading errors encountered|Missing or unsupported mandatory/i.test(clean)) {
    const forge2 = /Mod\s+\S+\s+requires\s+([a-z][a-z0-9_-]*)\s+\d/gi;
    while ((m = forge2.exec(clean)) !== null) missing.add(m[1].toLowerCase());
  }

  // Fabric: "requires mod '<modid>'" or "requires version X of mod '<modid>'"
  const fabric = /requires(?:\s+version\s+\S+\s+of)?\s+mod\s+'([^']+)'/gi;
  while ((m = fabric.exec(clean)) !== null) missing.add(m[1].toLowerCase());

  // Fabric (newer loader): structured dep report — "HARD_DEP_NO_CANDIDATE <mod> <ver> {depends <depid> @"
  const fabricHardDep = /HARD_DEP(?:_NO_CANDIDATE)?\s+\S+\s+\S+\s+\{depends\s+([a-z][a-z0-9_-]*)\s+@/gi;
  while ((m = fabricHardDep.exec(clean)) !== null) missing.add(m[1].toLowerCase());

  // Fabric (newer loader): "requires any version of <modid>, which is missing"
  const fabricAnyVersion = /requires\s+any\s+version\s+of\s+([a-z][a-z0-9_-]*),\s+which\s+is\s+missing/gi;
  while ((m = fabricAnyVersion.exec(clean)) !== null) missing.add(m[1].toLowerCase());

  // Filter out tokens that are clearly not mod IDs
  // NOTE: 'fabric' is intentionally kept — on Fabric servers it means Fabric API (a real mod), not the loader
  for (const skip of ['minecraft', 'forge', 'neoforge', 'above', 'or', 'and', 'the', 'a', 'is', 'not', 'null', 'unknown']) {
    missing.delete(skip);
  }

  return Array.from(missing);
}

// Returns true if the log text indicates a dependency crash (regardless of exit code).
// Forge exits with code 0 even on dep failures, so we can't rely on code alone.
function hasDependencyCrash(logText) {
  return /Missing or unsupported mandatory dep|LoadingFailedException|Actual version:\s*'\[MISSING\]'|Incompatible mods found|Mod resolution failed/i.test(logText);
}

// Search Modrinth for a mod by its in-game mod ID and install the best compatible version.
async function findAndInstallMissingDeps(missingModIds, serverConfig, serverPath, appendLog) {
  const modsPath = path.join(serverPath, 'mods');
  await fs.ensureDir(modsPath);
  const meta = await readModMetadata(modsPath);

  const loaderMap = { forge: 'forge', neoforge: 'neoforge', fabric: 'fabric', quilt: 'quilt' };
  const loader = loaderMap[serverConfig.type] || '';
  const gameVersion = serverConfig.version;
  const installed = [];

  // 'fabric' as a dependency means Fabric API (a real mod), not the Fabric loader — remap to its Modrinth slug
  const MOD_ID_REMAP = { fabric: 'fabric-api' };

  for (const modId of missingModIds) {
    const lookupId = MOD_ID_REMAP[modId] || modId;

    // Skip if already present (check metadata projectId, metadata keys, and filenames)
    const alreadyInMeta = Object.values(meta).some(m =>
      m.projectId === lookupId || (m.title || '').toLowerCase() === lookupId
    ) || Object.keys(meta).some(k => k.toLowerCase().replace(/[-_]/g, '').includes(lookupId.replace(/[-_]/g, '')));
    if (alreadyInMeta) continue;

    try {
      const files = await fs.readdir(modsPath);
      if (files.some(f => f.toLowerCase().replace(/[-_]/g, '').includes(lookupId.replace(/[-_]/g, '')))) continue;
    } catch (_) {}

    appendLog(`[MineDash] Searching Modrinth for missing mod '${lookupId}'...\n`);

    try {
      // Strategy 1: exact slug lookup
      let project = null;
      const slugRes = await fetch(`${MODRINTH_API}/project/${lookupId}`, { headers: MODRINTH_HEADERS });
      if (slugRes.ok) project = await slugRes.json();

      // Strategy 2: search by name and pick the closest slug match
      if (!project) {
        const facets = [['project_type:mod']];
        if (gameVersion) facets.push([`versions:${gameVersion}`]);
        if (loader) facets.push([`categories:${loader}`]);
        const params = new URLSearchParams({ query: lookupId, limit: '5', facets: JSON.stringify(facets) });
        const sRes = await fetch(`${MODRINTH_API}/search?${params}`, { headers: MODRINTH_HEADERS });
        if (sRes.ok) {
          const data = await sRes.json();
          const hit = (data.hits || []).find(h =>
            h.slug === lookupId || h.slug.includes(lookupId) || lookupId.includes(h.slug)
          ) || data.hits?.[0];
          if (hit) project = { id: hit.project_id, icon_url: hit.icon_url, title: hit.title };
        }
      }

      if (!project) { appendLog(`[MineDash] Could not find '${lookupId}' on Modrinth.\n`); continue; }

      // Fetch compatible versions
      const vParams = new URLSearchParams();
      if (gameVersion) vParams.set('game_versions', JSON.stringify([gameVersion]));
      if (loader) vParams.set('loaders', JSON.stringify([loader]));
      const vRes = await fetch(`${MODRINTH_API}/project/${project.id}/version?${vParams}`, { headers: MODRINTH_HEADERS });
      if (!vRes.ok) { appendLog(`[MineDash] No compatible version found for '${lookupId}'.\n`); continue; }
      const versions = await vRes.json();
      if (!Array.isArray(versions) || versions.length === 0) {
        appendLog(`[MineDash] No compatible version of '${lookupId}' for ${loader} ${gameVersion}.\n`);
        continue;
      }

      const sorted = [...versions].sort((a, b) => {
        const p = { release: 0, beta: 1, alpha: 2 };
        return (p[a.version_type] || 3) - (p[b.version_type] || 3);
      });
      const best = sorted[0];
      const file = best.files.find(f => f.primary) || best.files[0];
      if (!file) continue;

      const dlRes = await fetch(file.url, { headers: MODRINTH_HEADERS });
      if (!dlRes.ok) { appendLog(`[MineDash] Download failed for '${lookupId}'.\n`); continue; }

      await fs.writeFile(path.join(modsPath, file.filename), Buffer.from(await dlRes.arrayBuffer()));
      meta[file.filename] = { iconUrl: project.icon_url || null, title: project.title || lookupId, projectId: project.id };
      installed.push({ filename: file.filename, title: project.title || lookupId });
      appendLog(`[MineDash] ✓ Auto-installed: ${project.title || lookupId} (${file.filename})\n`);

      // Recurse into this dep's own required deps
      const subDeps = (best.dependencies || [])
        .filter(d => d.dependency_type === 'required' && d.project_id)
        .map(d => d.project_id);
      if (subDeps.length > 0) {
        const sub = await resolveAndInstallDeps(subDeps, gameVersion, loader, modsPath, meta, new Set([project.id]));
        installed.push(...sub);
      }
    } catch (err) {
      appendLog(`[MineDash] Error while installing '${modId}': ${err.message}\n`);
    }
  }

  if (installed.length > 0) await writeModMetadata(modsPath, meta);
  return installed;
}

// Track which mod IDs we've already attempted per server so we don't loop forever
const depInstallHistory = {};
// Server IDs currently being deleted — the async exit handler checks this so it
// doesn't auto-install deps into / auto-restart a server whose files are about
// to be wiped, or worse, get re-created mid-deletion.
const deletingServers = new Set();

// Start Server Loop
function startProcess(id, serverConfig, serverPath) {
  const jarPath = path.join(serverPath, 'server.jar');
  const batPath = path.join(serverPath, 'run.bat');
  const shPath = path.join(serverPath, 'run.sh');

  const hasJar = fs.existsSync(jarPath);
  const hasBat = fs.existsSync(batPath);
  const hasSh = fs.existsSync(shPath);

  let mcProcess;

  activeLogs[id] = activeLogs[id] || [];
  serverStates[id] = {
    startTime: Date.now(),
    players: []
  };

  // Migrate any leftover client-only mod jars out of the mods folder into the
  // per-server stash. Runs every start so servers imported before the
  // deny-list was updated self-heal, and so jars dropped into mods/ by hand
  // (e.g. via the file browser) don't crash the JVM. Vanilla has no mods/.
  if (serverConfig.type !== 'vanilla') {
    try {
      const modsDir = path.join(serverPath, 'mods');
      if (fs.existsSync(modsDir)) {
        const stashDir = path.join(serverPath, '.minedash-client-mods');
        const moved = [];
        for (const f of fs.readdirSync(modsDir)) {
          if (!f.endsWith('.jar')) continue;
          if (!isClientOnlyModFilename(f)) continue;
          try {
            fs.mkdirSync(stashDir, { recursive: true });
            fs.renameSync(path.join(modsDir, f), path.join(stashDir, f));
            moved.push(f);
          } catch (e) {
            console.warn(`[client-mods cleanup] couldn't move ${f}:`, e.message);
          }
        }
        if (moved.length) {
          const line = `[MineDash] Moved ${moved.length} client-only mod(s) out of mods/ to keep the dedicated server from crashing: ${moved.join(', ')}\n`;
          activeLogs[id].push(line);
          io.emit(`console_${id}`, line);
        }
      }
    } catch (e) {
      console.warn('[client-mods cleanup] scan failed:', e.message);
    }
  }

  const appendLog = (text) => {
    if (!activeLogs[id]) activeLogs[id] = [];
    activeLogs[id].push(text);
    if (activeLogs[id].length > 500) activeLogs[id].shift();
    io.emit(`console_${id}`, text);

    const joinMatch = text.match(/:\s+([a-zA-Z0-9_]{3,16})\s+joined the game/);
    if (joinMatch) {
      const pName = joinMatch[1];
      if (!serverStates[id].players.includes(pName)) {
        serverStates[id].players.push(pName);
        io.emit(`players_update_${id}`, serverStates[id].players);
      }
    }

    const leaveMatch = text.match(/:\s+([a-zA-Z0-9_]{3,16})\s+left the game/);
    if (leaveMatch) {
      const pName = leaveMatch[1];
      serverStates[id].players = serverStates[id].players.filter(p => p !== pName);
      io.emit(`players_update_${id}`, serverStates[id].players);
    }
  };

  io.emit('server_status_change', { id, status: 'online' });

  // Auto-Installer hooks
  if (!hasJar && !hasBat && !hasSh) {
    if (serverConfig.type === 'neoforge') {
      const dummyProc = spawn('node', ['-e', 'setInterval(()=>{}, 1000)']); // keep alive dummy
      activeProcesses[id] = dummyProc;
      installNeoForge(id, serverConfig, serverPath, appendLog).then((success) => {
        dummyProc.kill();
        delete activeProcesses[id];
        if (success) {
           startProcess(id, serverConfig, serverPath);
        } else {
           activeProcesses[id] = spawn('node', ['-e', 'setTimeout(() => process.exit(1), 5000)']);
        }
      });
      return;
    } else if (serverConfig.type === 'fabric') {
      const dummyProc = spawn('node', ['-e', 'setInterval(()=>{}, 1000)']); // keep alive dummy
      activeProcesses[id] = dummyProc;
      installFabric(id, serverConfig.version, serverPath, appendLog).then((success) => {
        dummyProc.kill();
        delete activeProcesses[id];
        if (success) {
           startProcess(id, serverConfig, serverPath);
        } else {
           activeProcesses[id] = spawn('node', ['-e', 'setTimeout(() => process.exit(1), 5000)']);
        }
      });
      return;
    } else if (serverConfig.type === 'forge') {
      const dummyProc = spawn('node', ['-e', 'setInterval(()=>{}, 1000)']); // keep alive dummy
      activeProcesses[id] = dummyProc;
      installForge(id, serverConfig, serverPath, appendLog).then((success) => {
        dummyProc.kill();
        delete activeProcesses[id];
        if (success) {
          startProcess(id, serverConfig, serverPath);
        } else {
          activeProcesses[id] = spawn('node', ['-e', 'setTimeout(() => process.exit(1), 5000)']);
        }
      });
      return;
    }
  }

  if (hasBat && process.platform === 'win32') {
    mcProcess = spawn('cmd.exe', ['/c', 'run.bat'], { cwd: serverPath });
  } else if (hasSh && process.platform !== 'win32') {
    mcProcess = spawn('sh', ['run.sh'], { cwd: serverPath });
  } else if (hasJar) {
    mcProcess = spawn(getJavaPath(), [
      `-Xms${serverConfig.minRam}`,
      `-Xmx${serverConfig.maxRam}`,
      '-jar',
      'server.jar',
      'nogui'
    ], { cwd: serverPath });
  } else {
    // Dummy fallback
    appendLog(`[MineDash] No server files found for ${id}, starting dummy process.\n`);
    const dummyScript = `
      console.log('Starting dummy server...');
      console.log('Loading libraries, please wait...');
      setTimeout(() => console.log('Done (1.2s)! For help, type "help"'), 2000);
      let ticks = 0;
      setInterval(() => {
        ticks++;
        if (ticks % 10 === 0) console.log('Dummy server tick: ' + ticks);
      }, 1000);
      process.stdin.on('data', data => {
        const cmd = data.toString().trim();
        console.log('<CONSOLE> issued server command: ' + cmd);
        if (cmd === 'stop') {
          console.log('Stopping server');
          console.log('Saving chunks for level \\'ServerLevel\\'...');
          setTimeout(() => process.exit(0), 1000);
        }
      });
    `;
    const dummyPath = path.join(serverPath, 'dummy.js');
    fs.writeFileSync(dummyPath, dummyScript);
    mcProcess = spawn('node', ['dummy.js'], { cwd: serverPath });
  }

  activeProcesses[id] = mcProcess;

  // Discover the actual JVM process PID
  // IMPORTANT: On Windows, java.exe is a launcher shim (~1MB) that spawns the
  // real JVM as a child process. So even "direct" java spawns need child PID discovery.
  // We must ALWAYS walk the process tree to find the real JVM.
  if (hasJar || hasBat || hasSh) {
    console.log(`[MineDash PID] Spawned process PID ${mcProcess.pid} for server ${id}, will discover real JVM child...`);
    discoverJavaPid(id, mcProcess.pid, serverPath);
  } else {
    // Dummy/fallback process — not Java, just monitor the spawned process directly
    console.log(`[MineDash PID] Non-Java process PID ${mcProcess.pid} for server ${id}`);
  }

  mcProcess.on('error', (err) => {
    appendLog(`[MineDash] Failed to start server process: ${err.message}\n`);
    if (err.code === 'ENOENT') {
      appendLog(`[MineDash] Java was not found. Make sure Java is installed and on your system PATH.\n`);
    }
    delete activeProcesses[id];
    delete serverStates[id];
    io.emit('server_status_change', { id, status: 'offline' });
  });

  mcProcess.stdout.on('data', (data) => {
    appendLog(data.toString());
  });

  mcProcess.stderr.on('data', (data) => {
    appendLog(data.toString());
  });

  mcProcess.on('exit', async (code) => {
    delete activeProcesses[id];
    delete serverStates[id];
    delete serverJavaPids[id];
    appendLog(`\n[Server process exited with code ${code}]\n`);
    io.emit('server_status_change', { id, status: 'offline' });

    // If the server is being deleted, skip everything below — dep auto-install
    // would re-create files in a folder that's about to be wiped, and the
    // auto-restart timer would resurrect a deleted server.
    if (deletingServers.has(id)) {
      stopAutoBackupInterval(id);
      return;
    }

    // ── Dependency crash detection ─────────────────────────────────────────
    // NOTE: Forge exits with code 0 even on dep failures, so check log content too.
    const logText = (activeLogs[id] || []).join('');
    if (code !== 0 || hasDependencyCrash(logText)) {
      const allMissing = parseMissingModIds(logText);

      // Filter out IDs we've already tried for this server (avoid infinite loop)
      if (!depInstallHistory[id]) depInstallHistory[id] = new Set();
      const toInstall = allMissing.filter(mid => !depInstallHistory[id].has(mid));

      if (toInstall.length > 0) {
        toInstall.forEach(mid => depInstallHistory[id].add(mid));
        appendLog(`\n[MineDash] Missing mods detected: ${toInstall.join(', ')}\n`);
        appendLog('[MineDash] Auto-installing missing dependencies...\n');

        const installed = await findAndInstallMissingDeps(toInstall, serverConfig, serverPath, appendLog);

        if (installed.length > 0) {
          appendLog(`[MineDash] Installed ${installed.length} mod(s): ${installed.map(m => m.title).join(', ')}\n`);
          appendLog('[MineDash] Restarting server...\n');
          setTimeout(() => { if (!activeProcesses[id]) startProcess(id, serverConfig, serverPath); }, 3000);
          return; // Skip normal auto-restart — we're handling it
        } else {
          appendLog('[MineDash] Could not find the missing mods on Modrinth. Please install them manually.\n');
        }
      }
    } else if (code === 0 && !hasDependencyCrash(logText)) {
      // Clean successful run — reset dep history so future restarts start fresh
      delete depInstallHistory[id];
    }
    // ──────────────────────────────────────────────────────────────────────

    // Stop auto-backup interval when server exits
    stopAutoBackupInterval(id);

    // ── Plain-English crash detection (only if dep installer didn't handle it) ─
    if (code !== 0 && !hasDependencyCrash(logText)) {
      const crash = detectCrash(logText);
      if (crash) {
        io.emit(`crash_detected_${id}`, crash);
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    // Normal auto-restart logic
    const servers = await getServers();
    const config = servers.find(s => s.id === id);
    if (config && config.autoRestart && code !== 0) {
      io.emit(`console_${id}`, `\n[Auto-Restart] Server crashed. Restarting in 5 seconds...\n`);
      setTimeout(() => {
        if (!activeProcesses[id]) {
          startProcess(id, config, serverPath);
        }
      }, 5000);
    }
  });

  return mcProcess;
}

app.post('/api/servers/:id/start', async (req, res) => {
  const { id } = req.params;
  if (activeProcesses[id]) {
    return res.status(400).json({ error: 'Server is already running' });
  }

  const servers = await getServers();
  const serverConfig = servers.find(s => s.id === id);
  if (!serverConfig) return res.status(404).json({ error: 'Server not found' });

  // Java version gate — surface a structured error so the frontend can route
  // through JavaSetupModal instead of letting the JVM crash with
  // UnsupportedClassVersionError mid-boot. `allowMismatch=true` (query or body)
  // is the same "I know what I'm doing" escape hatch the modal exposes.
  const allowMismatch = req.query.allowMismatch === 'true' || req.body?.allowMismatch === true;
  if (!allowMismatch) {
    const installedMajor = getJavaVersion();
    const requiredMajor = requiredJavaMajor(serverConfig.version);
    if (installedMajor !== null && installedMajor < requiredMajor) {
      return res.status(409).json({
        error: `Server "${serverConfig.name}" needs Java ${requiredMajor} or newer (you have Java ${installedMajor}).`,
        code: 'java-version-mismatch',
        installedVersion: installedMajor,
        requiredMajor,
        mcVersion: serverConfig.version,
      });
    }
  }

  const serverPath = path.join(INSTANCES_DIR, id);
  await fs.ensureDir(serverPath);

  startProcess(id, serverConfig, serverPath);

  // Start auto-backup interval if configured
  startAutoBackupInterval(id, serverConfig);

  res.json({ message: 'Server started' });
});

app.post('/api/servers/:id/stop', async (req, res) => {
  const { id } = req.params;
  const mcProcess = activeProcesses[id];
  if (!mcProcess) return res.status(400).json({ error: 'Server is not running' });

  mcProcess.stdin.write('stop\n');
  res.json({ message: 'Stop command sent' });
});

app.post('/api/servers/:id/restart', async (req, res) => {
  const { id } = req.params;
  const mcProcess = activeProcesses[id];
  if (!mcProcess) return res.status(400).json({ error: 'Server is not running' });

  mcProcess.stdin.write('stop\n');
  
  const servers = await getServers();
  const config = servers.find(s => s.id === id);
  const serverPath = path.join(INSTANCES_DIR, id);
  
  // Wait for it to exit then start again
  const checkInterval = setInterval(() => {
    if (!activeProcesses[id]) {
      clearInterval(checkInterval);
      if (config) {
        startProcess(id, config, serverPath);
      }
    }
  }, 1000);
  
  res.json({ message: 'Restart command sent' });
});

app.delete('/api/servers/:id', async (req, res) => {
  const { id } = req.params;

  // Mark as deleting BEFORE killing the process so the async exit handler
  // (which fires after kill) skips dep auto-install and auto-restart logic.
  deletingServers.add(id);
  // Stop the auto-backup interval explicitly — when the server isn't running
  // there's no exit handler to clean it up.
  stopAutoBackupInterval(id);

  if (activeProcesses[id]) {
    activeProcesses[id].kill('SIGKILL');
    delete activeProcesses[id];
  }
  delete depInstallHistory[id];

  let servers = await getServers();
  const serverExists = servers.find(s => s.id === id);
  if (!serverExists) {
    deletingServers.delete(id);
    return res.status(404).json({ error: 'Server not found' });
  }

  servers = servers.filter(s => s.id !== id);
  await saveServers(servers);

  const serverPath = path.join(INSTANCES_DIR, id);
  try {
    await fs.remove(serverPath);
  } catch (err) {
    console.error('Failed to delete server files:', err);
  }

  io.emit('server_deleted', id);
  res.json({ message: 'Server deleted' });
  // Release the flag once the response is sent — the exit handler has had
  // plenty of time to fire by now.
  deletingServers.delete(id);
});

// Logs Endpoint
app.get('/api/servers/:id/logs', (req, res) => {
  const { id } = req.params;
  res.json(activeLogs[id] || []);
});

// Stats Endpoint for a specific server (uptime, players)
app.get('/api/servers/:id/stats', (req, res) => {
  const { id } = req.params;
  const state = serverStates[id];
  if (!state) return res.json({ uptime: '0s', players: [] });

  const diffMs = Date.now() - state.startTime;
  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  let uptimeStr = `${minutes}m ${seconds}s`;
  if (hours > 0) uptimeStr = `${hours}h ${minutes}m ${seconds}s`;

  res.json({
    uptime: uptimeStr,
    players: state.players
  });
});

// Player Command endpoint
app.post('/api/servers/:id/command', async (req, res) => {
  const { id } = req.params;
  const { command } = req.body;
  const mcProcess = activeProcesses[id];

  if (!mcProcess) return res.status(400).json({ error: 'Server is offline' });

  io.emit(`console_${id}`, `[Console] Ran command: /${command}\n`);
  mcProcess.stdin.write(command + '\n');
  res.json({ message: 'Command sent' });
});

// ─── Player Lists ────────────────────────────────────────────────────────────
// whitelist.json / ops.json / banned-players.json / banned-ips.json — written
// by the server itself when running; we either send the matching console
// command (live) or modify the JSON file directly (offline). For offline-mode
// player adds we ask Mojang for the UUID; if a player is unknown to Mojang we
// fall back to the offline UUID derivation so cracked names still work.

const PLAYER_LIST_FILES = {
  whitelist: 'whitelist.json',
  ops: 'ops.json',
  banned: 'banned-players.json',
  'banned-ips': 'banned-ips.json',
};

async function readPlayerListFile(serverPath, file) {
  try {
    const p = path.join(serverPath, file);
    if (!(await fs.pathExists(p))) return [];
    const txt = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

async function writePlayerListFile(serverPath, file, list) {
  const p = path.join(serverPath, file);
  await fs.writeFile(p, JSON.stringify(list, null, 2));
}

function offlineUuid(name) {
  // Same derivation Minecraft uses for offline-mode players: md5 of
  // "OfflinePlayer:<name>", with version/variant nibbles fixed to mark it as
  // a type-3 UUID. Mirrors UUID.nameUUIDFromBytes(...) in the vanilla code.
  const md5 = crypto.createHash('md5').update('OfflinePlayer:' + name).digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const hex = md5.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function resolveMojangProfile(name) {
  try {
    const r = await axios.get(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, {
      timeout: 5000,
      headers: { 'User-Agent': 'MineDash/1.0' },
    });
    const id = r.data?.id;
    const canonical = r.data?.name || name;
    if (!id) return null;
    const dashed = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
    return { uuid: dashed, name: canonical };
  } catch (_) {
    return null;
  }
}

app.get('/api/servers/:id/player-lists', async (req, res) => {
  const serverPath = path.join(INSTANCES_DIR, req.params.id);
  try {
    const [whitelist, ops, banned, bannedIps] = await Promise.all([
      readPlayerListFile(serverPath, PLAYER_LIST_FILES.whitelist),
      readPlayerListFile(serverPath, PLAYER_LIST_FILES.ops),
      readPlayerListFile(serverPath, PLAYER_LIST_FILES.banned),
      readPlayerListFile(serverPath, PLAYER_LIST_FILES['banned-ips']),
    ]);
    res.json({ whitelist, ops, banned, bannedIps, running: !!activeProcesses[req.params.id] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/servers/:id/player-lists/:list', async (req, res) => {
  const { id, list } = req.params;
  const { name, reason } = req.body || {};
  if (!PLAYER_LIST_FILES[list]) return res.status(400).json({ error: 'Unknown list' });
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name (or IP) is required' });
  }
  const trimmed = name.trim();

  const mcProcess = activeProcesses[id];
  if (mcProcess) {
    // Live server: send the matching command. The server rewrites the file
    // itself and any UUID lookups happen inside Minecraft.
    let cmd;
    if (list === 'whitelist') cmd = `whitelist add ${trimmed}`;
    else if (list === 'ops') cmd = `op ${trimmed}`;
    else if (list === 'banned') cmd = `ban ${trimmed}${reason ? ' ' + reason : ''}`;
    else if (list === 'banned-ips') cmd = `ban-ip ${trimmed}${reason ? ' ' + reason : ''}`;
    io.emit(`console_${id}`, `[MineDash] /${cmd}\n`);
    mcProcess.stdin.write(cmd + '\n');
    return res.json({ message: 'Command sent', via: 'command' });
  }

  // Offline server: modify the JSON file directly.
  const serverPath = path.join(INSTANCES_DIR, id);
  await fs.ensureDir(serverPath);
  const file = PLAYER_LIST_FILES[list];
  const current = await readPlayerListFile(serverPath, file);

  let entry;
  if (list === 'banned-ips') {
    if (current.some(e => e.ip?.toLowerCase() === trimmed.toLowerCase())) {
      return res.status(409).json({ error: `${trimmed} is already banned` });
    }
    entry = {
      ip: trimmed,
      created: new Date().toISOString().replace(/\.\d{3}Z$/, ' +0000'),
      source: 'MineDash',
      expires: 'forever',
      reason: reason || 'Banned by an operator.',
    };
  } else {
    const profile = (await resolveMojangProfile(trimmed)) || { uuid: offlineUuid(trimmed), name: trimmed };
    if (current.some(e => e.uuid === profile.uuid || e.name?.toLowerCase() === profile.name.toLowerCase())) {
      return res.status(409).json({ error: `${profile.name} is already on this list` });
    }
    if (list === 'whitelist') {
      entry = { uuid: profile.uuid, name: profile.name };
    } else if (list === 'ops') {
      entry = { uuid: profile.uuid, name: profile.name, level: 4, bypassesPlayerLimit: false };
    } else {
      entry = {
        uuid: profile.uuid,
        name: profile.name,
        created: new Date().toISOString().replace(/\.\d{3}Z$/, ' +0000'),
        source: 'MineDash',
        expires: 'forever',
        reason: reason || 'Banned by an operator.',
      };
    }
  }

  current.push(entry);
  await writePlayerListFile(serverPath, file, current);
  res.json({ message: 'Entry added', via: 'file', entry });
});

app.delete('/api/servers/:id/player-lists/:list/:name', async (req, res) => {
  const { id, list, name } = req.params;
  if (!PLAYER_LIST_FILES[list]) return res.status(400).json({ error: 'Unknown list' });
  const trimmed = decodeURIComponent(name).trim();

  const mcProcess = activeProcesses[id];
  if (mcProcess) {
    let cmd;
    if (list === 'whitelist') cmd = `whitelist remove ${trimmed}`;
    else if (list === 'ops') cmd = `deop ${trimmed}`;
    else if (list === 'banned') cmd = `pardon ${trimmed}`;
    else if (list === 'banned-ips') cmd = `pardon-ip ${trimmed}`;
    io.emit(`console_${id}`, `[MineDash] /${cmd}\n`);
    mcProcess.stdin.write(cmd + '\n');
    return res.json({ message: 'Command sent', via: 'command' });
  }

  const serverPath = path.join(INSTANCES_DIR, id);
  const file = PLAYER_LIST_FILES[list];
  const current = await readPlayerListFile(serverPath, file);
  const before = current.length;
  const filtered = list === 'banned-ips'
    ? current.filter(e => e.ip?.toLowerCase() !== trimmed.toLowerCase())
    : current.filter(e => e.name?.toLowerCase() !== trimmed.toLowerCase() && e.uuid !== trimmed);
  if (filtered.length === before) {
    return res.status(404).json({ error: 'Entry not found' });
  }
  await writePlayerListFile(serverPath, file, filtered);
  res.json({ message: 'Entry removed', via: 'file' });
});

// Mod metadata helpers — keyed by filename (without .disabled suffix)
const MOD_META_FILE = '.mod-metadata.json';
async function readModMetadata(modsPath) {
  try {
    const p = path.join(modsPath, MOD_META_FILE);
    if (await fs.pathExists(p)) return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch (_) {}
  return {};
}
async function writeModMetadata(modsPath, meta) {
  await fs.writeFile(path.join(modsPath, MOD_META_FILE), JSON.stringify(meta, null, 2));
}

// SHA1 of a file, streamed (so we don't load 100 MB jars into RAM).
async function fileSha1(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const s = fs.createReadStream(filePath);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// Look up a mod on Modrinth by file hash. Returns { iconUrl, title, projectId } or null.
async function lookupModrinthByHash(sha1) {
  try {
    const headers = { 'User-Agent': 'MineDash/1.0 mod-icon-resolver' };
    const versionRes = await axios.get(`https://api.modrinth.com/v2/version_file/${sha1}`, {
      params: { algorithm: 'sha1' },
      headers,
      timeout: 8000,
    });
    const projectId = versionRes.data?.project_id;
    if (!projectId) return null;
    const projRes = await axios.get(`https://api.modrinth.com/v2/project/${projectId}`, {
      headers,
      timeout: 8000,
    });
    return {
      iconUrl: projRes.data?.icon_url || null,
      title: projRes.data?.title || null,
      projectId,
    };
  } catch (_) {
    return null;
  }
}

// For any jar without metadata, hash it and ask Modrinth. Persist results to .minedash-mods.json
// so subsequent GETs are instant. `lookedUp: true` is set on misses too, to skip re-querying.
async function enrichModMetadata(modsPath, meta, jarFiles) {
  const tasks = [];
  for (const f of jarFiles) {
    const base = f.replace(/\.disabled$/, '');
    const existing = meta[base];
    if (existing && (existing.iconUrl || existing.lookedUp)) continue;
    tasks.push((async () => {
      try {
        const sha1 = await fileSha1(path.join(modsPath, f));
        const info = await lookupModrinthByHash(sha1);
        meta[base] = {
          ...(existing || {}),
          iconUrl: info?.iconUrl || null,
          title: info?.title || existing?.title || null,
          projectId: info?.projectId || existing?.projectId || null,
          lookedUp: true,
        };
      } catch (_) {
        meta[base] = { ...(existing || {}), lookedUp: true };
      }
    })());
  }
  if (tasks.length === 0) return false;
  await Promise.allSettled(tasks);
  try { await writeModMetadata(modsPath, meta); } catch (_) {}
  return true;
}

// Mods Endpoints
app.get('/api/servers/:id/mods', async (req, res) => {
  const { id } = req.params;
  const modsPath = path.join(INSTANCES_DIR, id, 'mods');

  try {
    await fs.ensureDir(modsPath);
    const meta = await readModMetadata(modsPath);
    const files = await fs.readdir(modsPath);
    const jarFiles = files.filter(f => f.endsWith('.jar') || f.endsWith('.zip') || f.endsWith('.jar.disabled'));

    // Fill in missing icons/titles by hashing jars and asking Modrinth.
    // Cached permanently in .minedash-mods.json so this only runs once per mod.
    await enrichModMetadata(modsPath, meta, jarFiles);

    const mods = jarFiles.map(f => {
      const stats = fs.statSync(path.join(modsPath, f));
      const isDisabled = f.endsWith('.disabled');
      const baseKey = isDisabled ? f.replace(/\.disabled$/, '') : f;
      const m = meta[baseKey] || {};
      return {
        name: f,
        displayName: m.title || (isDisabled ? f.replace('.disabled', '') : f),
        enabled: !isDisabled,
        size: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
        iconUrl: m.iconUrl || null,
      };
    });
    res.json(mods);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read mods' });
  }
});

// Stream the entire mods folder as a ZIP download
app.get('/api/servers/:id/mods/export-zip', async (req, res) => {
  const { id } = req.params;
  const modsPath = path.join(INSTANCES_DIR, id, 'mods');
  try {
    if (!await fs.pathExists(modsPath)) {
      return res.status(404).json({ error: 'Mods folder not found' });
    }
    const servers = await getServers();
    const server = servers.find(s => s.id === id);
    const safeName = (server?.name || 'server').replace(/[^a-zA-Z0-9_-]+/g, '_');
    const filename = `${safeName}-mods.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      console.error('Mods ZIP export error:', err);
      try { res.status(500).end(); } catch (_) {}
    });
    archive.pipe(res);

    const files = await fs.readdir(modsPath);
    for (const f of files) {
      if (f.endsWith('.jar') || f.endsWith('.jar.disabled')) {
        archive.file(path.join(modsPath, f), { name: f });
      }
    }
    archive.finalize();
  } catch (error) {
    console.error('Mods ZIP export error:', error);
    res.status(500).json({ error: 'Failed to export mods' });
  }
});

// List installed plugins for a Paper server
app.get('/api/servers/:id/plugins', async (req, res) => {
  const { id } = req.params;
  const pluginsPath = path.join(INSTANCES_DIR, id, 'plugins');
  try {
    await fs.ensureDir(pluginsPath);
    const metaPath = path.join(pluginsPath, '.minedash-plugins.json');
    let meta = {};
    try { meta = await fs.readJson(metaPath); } catch (_) {}
    const files = await fs.readdir(pluginsPath);
    const plugins = files.filter(f => f.endsWith('.jar')).map(f => {
      const stats = fs.statSync(path.join(pluginsPath, f));
      const m = meta[f] || {};
      return {
        name: f,
        displayName: m.title || f,
        slug: m.slug || null,
        iconUrl: m.iconUrl || null,
        enabled: m.enabled !== false,
        size: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
      };
    });
    res.json(plugins);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read plugins' });
  }
});

// Toggle mod enabled/disabled
app.post('/api/servers/:id/mods/:modName/toggle', async (req, res) => {
  const { id, modName } = req.params;
  const modsPath = path.join(INSTANCES_DIR, id, 'mods');
  const currentPath = path.join(modsPath, modName);
  
  try {
    if (!await fs.pathExists(currentPath)) {
      return res.status(404).json({ error: 'Mod not found' });
    }
    
    let newName;
    if (modName.endsWith('.disabled')) {
      newName = modName.replace('.disabled', '');
    } else {
      newName = modName + '.disabled';
    }
    
    const newPath = path.join(modsPath, newName);
    await fs.rename(currentPath, newPath);
    res.json({ message: 'Mod toggled', newName, enabled: !newName.endsWith('.disabled') });
  } catch (error) {
    res.status(500).json({ error: 'Failed to toggle mod' });
  }
});

app.delete('/api/servers/:id/mods/:modName', async (req, res) => {
  const { id, modName } = req.params;
  const modPath = path.join(INSTANCES_DIR, id, 'mods', modName);
  
  try {
    if (await fs.pathExists(modPath)) {
      await fs.remove(modPath);
      res.json({ message: 'Mod deleted' });
    } else {
      res.status(404).json({ error: 'Mod not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete mod' });
  }
});

app.post('/api/servers/:id/mods/upload', upload.single('modFile'), async (req, res) => {
  const { id } = req.params;
  const serverPath = path.join(INSTANCES_DIR, id);
  const modsPath = path.join(serverPath, 'mods');
  
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    await fs.ensureDir(modsPath);
    const destPath = path.join(modsPath, req.file.originalname);
    
    // If it's a modpack zip, extract it into root server dir
    if (req.file.originalname.endsWith('.zip') && req.body.isModpack === 'true') {
      await extract(req.file.path, { dir: serverPath });
      await fs.remove(req.file.path);
      return res.json({ message: 'Modpack extracted successfully' });
    } else {
      // Just a normal mod jar/zip
      await fs.move(req.file.path, destPath, { overwrite: true });
      res.json({ message: 'Mod uploaded successfully' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Backups Endpoints
app.get('/api/servers/:id/backups', async (req, res) => {
  const { id } = req.params;
  const serverBackupsDir = path.join(BACKUPS_DIR, id);

  try {
    await fs.ensureDir(serverBackupsDir);
    const servers = await getServers();
    const cfg = servers.find(s => s.id === id);
    const pinned = new Set((cfg && cfg.pinnedBackups) || []);

    const files = await fs.readdir(serverBackupsDir);
    const backups = files.filter(f => f.endsWith('.zip')).map(f => {
      const stats = fs.statSync(path.join(serverBackupsDir, f));
      const isAuto = f.startsWith('auto-backup-');
      return {
        name: f,
        size: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
        sizeBytes: stats.size,
        date: stats.mtime,
        dateMs: stats.mtime.getTime(),
        type: isAuto ? 'auto' : 'manual',
        pinned: pinned.has(f),
      };
    });
    res.json(backups);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read backups' });
  }
});

// Toggle pin (protect from auto-cleanup pruning)
app.post('/api/servers/:id/backups/:backupName/pin', async (req, res) => {
  try {
    const { id, backupName } = req.params;
    const { pinned } = req.body;
    const servers = await getServers();
    const idx = servers.findIndex(s => s.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Server not found' });

    const backupPath = path.join(BACKUPS_DIR, id, backupName);
    if (!await fs.pathExists(backupPath)) return res.status(404).json({ error: 'Backup not found' });

    const current = new Set(servers[idx].pinnedBackups || []);
    if (pinned) current.add(backupName); else current.delete(backupName);
    servers[idx].pinnedBackups = [...current];
    await saveServers(servers);
    io.emit('server_updated', servers[idx]);
    res.json({ pinned: !!pinned });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename a backup file. Keeps pinnedBackups in sync.
app.post('/api/servers/:id/backups/:backupName/rename', async (req, res) => {
  try {
    const { id, backupName } = req.params;
    const { newName } = req.body;

    if (typeof newName !== 'string' || !newName.trim()) {
      return res.status(400).json({ error: 'newName is required' });
    }
    // Sanitize: strip path separators, illegal Windows chars; force .zip
    let safe = newName.trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ');
    if (!safe.toLowerCase().endsWith('.zip')) safe += '.zip';
    if (safe.length === 0 || safe === '.zip') {
      return res.status(400).json({ error: 'Invalid backup name' });
    }
    if (safe === backupName) return res.json({ name: safe });

    const dir = path.join(BACKUPS_DIR, id);
    const oldPath = path.join(dir, backupName);
    const newPath = path.join(dir, safe);

    if (!await fs.pathExists(oldPath)) return res.status(404).json({ error: 'Backup not found' });
    if (await fs.pathExists(newPath)) return res.status(409).json({ error: 'A backup with that name already exists' });

    await fs.move(oldPath, newPath);

    // Keep pinnedBackups in sync if the renamed file was pinned
    const servers = await getServers();
    const idx = servers.findIndex(s => s.id === id);
    if (idx !== -1) {
      const pinned = servers[idx].pinnedBackups || [];
      if (pinned.includes(backupName)) {
        servers[idx].pinnedBackups = pinned.map(n => n === backupName ? safe : n);
        await saveServers(servers);
        io.emit('server_updated', servers[idx]);
      }
    }

    res.json({ name: safe });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/servers/:id/backups', async (req, res) => {
  const { id } = req.params;
  const serverPath = path.join(INSTANCES_DIR, id);
  const serverBackupsDir = path.join(BACKUPS_DIR, id);

  if (!fs.existsSync(serverPath)) return res.status(404).json({ error: 'Server not found' });

  await fs.ensureDir(serverBackupsDir);
  const backupName = `backup-${Date.now()}.zip`;
  const backupPath = path.join(serverBackupsDir, backupName);

  const mcProcess = activeProcesses[id];
  const isRunning = !!mcProcess;

  try {
    if (isRunning) {
      // Tell Minecraft to pause auto-saving and flush all pending writes to disk.
      // This releases write locks on world files so the archiver can read them.
      mcProcess.stdin.write('save-off\n');
      mcProcess.stdin.write('save-all flush\n');
      io.emit(`console_${id}`, `[Backup] Flushing world data before backup...\n`);
      await new Promise(resolve => setTimeout(resolve, 2500));
    }

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(backupPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', resolve);
      archive.on('error', reject);
      archive.on('warning', (err) => { if (err.code !== 'ENOENT') reject(err); });

      archive.pipe(output);

      // Use glob instead of directory() so we can exclude files that the JVM keeps
      // exclusively locked on Windows regardless of save-off/save-all.
      // session.lock is a Java FileLock — no other process can open it for reading
      // while the server is running. It is regenerated automatically on next start
      // and is not needed for a working restore.
      archive.glob('**', {
        cwd: serverPath,
        dot: true,          // include hidden files (.mod-metadata.json etc.)
        ignore: [
          'session.lock',
          '**/session.lock', // world/session.lock, world/DIM-1/session.lock, etc.
        ],
      });

      archive.finalize();
    });

    if (isRunning) {
      mcProcess.stdin.write('save-on\n');
      io.emit(`console_${id}`, `[Backup] Auto-save re-enabled.\n`);
    }

    io.emit(`console_${id}`, `\n[Backup] Successfully created ${backupName}\n`);
    res.json({ message: 'Backup created', name: backupName });
  } catch (err) {
    console.error('Backup failed:', err);
    // Always re-enable saving even on failure
    if (isRunning) mcProcess.stdin.write('save-on\n');
    await fs.remove(backupPath).catch(() => {});
    res.status(500).json({ error: `Failed to create backup: ${err.message}` });
  }
});

app.delete('/api/servers/:id/backups/:backupName', async (req, res) => {
  const { id, backupName } = req.params;
  const backupPath = path.join(BACKUPS_DIR, id, backupName);
  
  try {
    if (await fs.pathExists(backupPath)) {
      await fs.remove(backupPath);
      res.json({ message: 'Backup deleted' });
    } else {
      res.status(404).json({ error: 'Backup not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete backup' });
  }
});

// Backup Download Endpoint
app.get('/api/servers/:id/backups/:backupName/download', async (req, res) => {
  const { id, backupName } = req.params;
  const backupPath = path.join(BACKUPS_DIR, id, backupName);
  
  try {
    if (await fs.pathExists(backupPath)) {
      res.setHeader('Content-Disposition', `attachment; filename="${backupName}"`);
      res.setHeader('Content-Type', 'application/zip');
      const readStream = fs.createReadStream(backupPath);
      readStream.pipe(res);
    } else {
      res.status(404).json({ error: 'Backup not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to download backup' });
  }
});

// Backup Restore Endpoint
app.post('/api/servers/:id/backups/:backupName/restore', async (req, res) => {
  const { id, backupName } = req.params;
  const backupPath = path.join(BACKUPS_DIR, id, backupName);
  const serverPath = path.join(INSTANCES_DIR, id);
  
  try {
    if (!await fs.pathExists(backupPath)) {
      return res.status(404).json({ error: 'Backup not found' });
    }

    // Stop server if running
    const wasRunning = !!activeProcesses[id];
    if (wasRunning) {
      activeProcesses[id].stdin.write('stop\n');
      await new Promise((resolve) => {
        const check = setInterval(() => {
          if (!activeProcesses[id]) {
            clearInterval(check);
            resolve();
          }
        }, 500);
        setTimeout(() => { clearInterval(check); resolve(); }, 30000);
      });
    }

    io.emit(`console_${id}`, `\n[MineDash] Restoring backup ${backupName}...\n`);

    // Extract into a temp directory first so the server directory is only
    // cleared after we know the zip is intact and fully extracted.
    // If extraction fails the original server directory is left untouched.
    const tmpDir = serverPath + '_restore_tmp';
    await fs.remove(tmpDir); // clean up any leftover from a previous failed restore
    await fs.ensureDir(tmpDir);
    try {
      await extract(backupPath, { dir: tmpDir });
    } catch (extractErr) {
      await fs.remove(tmpDir).catch(() => {});
      throw extractErr; // re-throw so the outer catch sends the error response
    }

    // Extraction succeeded — now it is safe to clear and repopulate
    await fs.emptyDir(serverPath);
    await fs.copy(tmpDir, serverPath, { overwrite: true });
    await fs.remove(tmpDir).catch(() => {});

    io.emit(`console_${id}`, `[MineDash] Backup restored successfully!\n`);

    // Restart server if it was running before
    if (wasRunning) {
      const servers = await getServers();
      const config = servers.find(s => s.id === id);
      if (config) {
        io.emit(`console_${id}`, `[MineDash] Restarting server...\n`);
        setTimeout(() => startProcess(id, config, serverPath), 2000);
      }
    }

    res.json({ message: 'Backup restored successfully', wasRunning });
  } catch (error) {
    console.error('Restore failed:', error);
    io.emit(`console_${id}`, `[MineDash] Restore failed: ${error.message}\n`);
    res.status(500).json({ error: 'Failed to restore backup' });
  }
});

// Network Info Endpoint (for Radmin VPN / LAN hosting)
app.get('/api/network', (req, res) => {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        addresses.push({
          name: name,
          ip: addr.address,
          netmask: addr.netmask,
          isRadmin: name.toLowerCase().includes('radmin') || name.toLowerCase().includes('vpn'),
          isHamachi: name.toLowerCase().includes('hamachi'),
        });
      }
    }
  }
  
  addresses.sort((a, b) => {
    if (a.isRadmin && !b.isRadmin) return -1;
    if (!a.isRadmin && b.isRadmin) return 1;
    if (a.isHamachi && !b.isHamachi) return -1;
    if (!a.isHamachi && b.isHamachi) return 1;
    return 0;
  });
  
  res.json({ addresses });
});

async function getFolderSize(dir) {
  let size = 0;
  try {
    const files = await fs.readdir(dir, { withFileTypes: true });
    for (const file of files) {
      if (file.name === 'dummy.js') continue;
      const p = path.join(dir, file.name);
      if (file.isDirectory()) {
        size += await getFolderSize(p);
      } else {
        const stats = await fs.stat(p);
        size += stats.size;
      }
    }
  } catch (err) {
    // Ignore errors for unreadable files
  }
  return size;
}

// Storage Endpoint
app.get('/api/servers/:id/storage', async (req, res) => {
  const { id } = req.params;
  const serverPath = path.join(INSTANCES_DIR, id);
  if (!fs.existsSync(serverPath)) return res.json({ size: '0 MB' });
  const sizeBytes = await getFolderSize(serverPath);
  res.json({ size: (sizeBytes / (1024 * 1024)).toFixed(2) + ' MB' });
});

// Properties Endpoints
app.get('/api/servers/:id/properties', async (req, res) => {
  const { id } = req.params;
  const propPath = path.join(INSTANCES_DIR, id, 'server.properties');
  try {
    if (!fs.existsSync(propPath)) return res.json({});
    const content = await fs.readFile(propPath, 'utf8');
    const props = {};
    content.split('\n').forEach(line => {
      line = line.trim();
      if (line && !line.startsWith('#')) {
        const [k, ...v] = line.split('=');
        props[k] = v.join('=');
      }
    });
    res.json(props);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read properties' });
  }
});

app.put('/api/servers/:id/properties', async (req, res) => {
  const { id } = req.params;
  const newProps = req.body;
  const propPath = path.join(INSTANCES_DIR, id, 'server.properties');
  try {
    let props = {};
    let content = '';
    if (fs.existsSync(propPath)) {
      content = await fs.readFile(propPath, 'utf8');
    }
    const lines = content.split('\n');
    const outputLines = [];
    const existingKeys = new Set();

    for (let line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const key = trimmed.split('=')[0];
        existingKeys.add(key);
        if (newProps[key] !== undefined) {
          outputLines.push(`${key}=${newProps[key]}`);
        } else {
          outputLines.push(line);
        }
      } else {
        if (line || outputLines.length > 0) outputLines.push(line);
      }
    }
    
    for (const key in newProps) {
      if (!existingKeys.has(key)) {
        outputLines.push(`${key}=${newProps[key]}`);
      }
    }

    await fs.writeFile(propPath, outputLines.join('\n'));
    res.json({ message: 'Properties updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write properties' });
  }
});

// Regenerate world — deletes world folders and optionally sets a new seed
app.post('/api/servers/:id/regenerate-world', async (req, res) => {
  const { id } = req.params;
  const { seed } = req.body;

  if (activeProcesses[id]) {
    return res.status(409).json({ error: 'Stop the server before regenerating the world.' });
  }

  const serverPath = path.join(INSTANCES_DIR, id);
  const propPath = path.join(serverPath, 'server.properties');

  // Read level-name from server.properties (default: world)
  let levelName = 'world';
  let propsContent = '';
  let propLines = [];
  try {
    propsContent = await fs.readFile(propPath, 'utf8');
    propLines = propsContent.split('\n');
    const match = propsContent.match(/^level-name\s*=\s*(.+)$/m);
    if (match) levelName = match[1].trim();
  } catch {}

  // Update level-seed in server.properties (write new value, add line if missing)
  try {
    const seedValue = (seed || '').trim();
    let seedFound = false;
    const updated = propLines.map(line => {
      if (line.match(/^level-seed\s*=/)) { seedFound = true; return `level-seed=${seedValue}`; }
      return line;
    });
    if (!seedFound) updated.push(`level-seed=${seedValue}`);
    await fs.writeFile(propPath, updated.join('\n'));
  } catch {}

  // Delete world folders (vanilla stores all dims in one folder; Bukkit splits them)
  const foldersToDelete = [levelName, `${levelName}_nether`, `${levelName}_the_end`];
  for (const folder of foldersToDelete) {
    const p = path.join(serverPath, folder);
    try { if (await fs.pathExists(p)) await fs.remove(p); } catch {}
  }

  res.json({ success: true });
});

// General Settings Endpoint
app.put('/api/servers/:id/general', async (req, res) => {
  const { id } = req.params;
  const { name, customUrl, minRam, maxRam } = req.body;
  const servers = await getServers();
  const index = servers.findIndex(s => s.id === id);
  if (index === -1) return res.status(404).json({ error: 'Server not found' });

  if (name) servers[index].name = name;
  if (customUrl !== undefined) servers[index].customUrl = customUrl;
  if (minRam) servers[index].minRam = minRam;
  if (maxRam) servers[index].maxRam = maxRam;
  
  await saveServers(servers);
  const emitData = { ...servers[index], status: activeProcesses[id] ? 'online' : 'offline' };
  io.emit('server_updated', emitData);
  res.json({ message: 'Settings updated' });
});

// Icon Serve Endpoint
app.get('/api/servers/:id/icon.png', async (req, res) => {
  const { id } = req.params;
  const iconPath = path.join(INSTANCES_DIR, id, 'server-icon.png');
  
  try {
    if (await fs.pathExists(iconPath)) {
      res.sendFile(iconPath);
    } else {
      // Return a default 1x1 transparent PNG to avoid 404 errors
      res.status(404).end();
    }
  } catch (err) {
    res.status(500).end();
  }
});

// Icon Upload Endpoint
app.post('/api/servers/:id/icon', upload.single('icon'), async (req, res) => {
  const { id } = req.params;
  const serverPath = path.join(INSTANCES_DIR, id);
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  
  try {
    await fs.ensureDir(serverPath);
    const destPath = path.join(serverPath, 'server-icon.png');
    await fs.move(req.file.path, destPath, { overwrite: true });
    res.json({ message: 'Icon updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Icon upload failed' });
  }
});

// ─── Modrinth API Proxy ─────────────────────────────────────────
const MODRINTH_API = 'https://api.modrinth.com/v2';
const MODRINTH_HEADERS = { 'User-Agent': 'MineDash/1.0 (local server manager)' };

// Search mods on Modrinth
app.get('/api/modrinth/search', async (req, res) => {
  try {
    const { query, limit, offset, gameVersion, loader, category, projectType, sort } = req.query;
    const facets = [[`project_type:${projectType || 'mod'}`]];
    if (gameVersion) facets.push([`versions:${gameVersion}`]);
    if (loader) facets.push([`categories:${loader}`]);
    if (category) facets.push([`categories:${category}`]);

    const ALLOWED_SORTS = ['relevance', 'downloads', 'newest', 'updated'];
    const sortIndex = ALLOWED_SORTS.includes(sort) ? sort : 'relevance';

    const params = new URLSearchParams({
      query: query || '',
      limit: limit || '20',
      offset: offset || '0',
      index: sortIndex,
      facets: JSON.stringify(facets)
    });

    const response = await fetch(`${MODRINTH_API}/search?${params}`, { headers: MODRINTH_HEADERS });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Modrinth search error:', error);
    res.status(500).json({ error: 'Failed to search Modrinth' });
  }
});

// Get versions of a specific project filtered by game version + loader
app.get('/api/modrinth/project/:id/versions', async (req, res) => {
  try {
    const { id } = req.params;
    const { gameVersion, loader } = req.query;
    const params = new URLSearchParams();
    if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));
    if (loader) params.set('loaders', JSON.stringify([loader]));

    const response = await fetch(`${MODRINTH_API}/project/${id}/version?${params}`, { headers: MODRINTH_HEADERS });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Modrinth versions error:', error);
    res.status(500).json({ error: 'Failed to get project versions' });
  }
});

// Recursively fetch and install required Modrinth dependencies.
// `meta` is the live metadata object — caller must write it to disk after this returns.
async function resolveAndInstallDeps(depProjectIds, gameVersion, loader, modsPath, meta, visited, depth = 0) {
  if (depth > 4) return []; // Guard against pathological dep trees
  const installed = [];

  for (const projectId of depProjectIds) {
    if (visited.has(projectId)) continue;
    visited.add(projectId);

    // Skip if already installed (tracked via projectId in metadata)
    const alreadyInstalled = Object.values(meta).some(m => m.projectId === projectId);
    if (alreadyInstalled) continue;

    try {
      // Fetch compatible versions from Modrinth
      const params = new URLSearchParams();
      if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));
      if (loader) params.set('loaders', JSON.stringify([loader]));
      const vRes = await fetch(`${MODRINTH_API}/project/${projectId}/version?${params}`, { headers: MODRINTH_HEADERS });
      if (!vRes.ok) continue;
      const versions = await vRes.json();
      if (!Array.isArray(versions) || versions.length === 0) continue;

      // Prefer release > beta > alpha
      const sorted = [...versions].sort((a, b) => {
        const p = { release: 0, beta: 1, alpha: 2 };
        return (p[a.version_type] || 3) - (p[b.version_type] || 3);
      });
      const best = sorted[0];
      const file = best.files.find(f => f.primary) || best.files[0];
      if (!file) continue;

      // Download the dep file
      const dlRes = await fetch(file.url, { headers: MODRINTH_HEADERS });
      if (!dlRes.ok) continue;
      const buffer = Buffer.from(await dlRes.arrayBuffer());
      await fs.writeFile(path.join(modsPath, file.filename), buffer);

      // Fetch project info for icon + title
      let iconUrl = null, title = file.filename;
      try {
        const pRes = await fetch(`${MODRINTH_API}/project/${projectId}`, { headers: MODRINTH_HEADERS });
        if (pRes.ok) { const p = await pRes.json(); iconUrl = p.icon_url || null; title = p.title || file.filename; }
      } catch (_) {}

      meta[file.filename] = { iconUrl, title, projectId };
      installed.push({ filename: file.filename, title });
      console.log(`[MineDash Deps] Auto-installed dep: ${title} (${file.filename})`);

      // Recurse on this dep's own required dependencies
      const subDeps = (best.dependencies || [])
        .filter(d => d.dependency_type === 'required' && d.project_id)
        .map(d => d.project_id);
      if (subDeps.length > 0) {
        const sub = await resolveAndInstallDeps(subDeps, gameVersion, loader, modsPath, meta, visited, depth + 1);
        installed.push(...sub);
      }
    } catch (err) {
      console.error(`[MineDash Deps] Failed to install dep ${projectId}:`, err.message);
    }
  }
  return installed;
}

// Download and install a mod from Modrinth directly into server's mods folder
app.post('/api/servers/:serverId/mods/install-modrinth', async (req, res) => {
  const { serverId } = req.params;
  const { url, filename, iconUrl, title, projectId, gameVersion, loader, dependencies, serverSide, force } = req.body;

  if (!url || !filename) return res.status(400).json({ error: 'url and filename are required' });

  // Block client-only mods unless explicitly overridden. NeoForge/Forge dedicated servers
  // crash during mod construction the moment a client-only mod touches a client-only class
  // (e.g. net.minecraft.client.gui.screens.Screen), so a "client-only on a server" mistake
  // takes down the entire server, not just the offending mod.
  if (serverSide === 'unsupported' && !force) {
    return res.status(409).json({
      error: `${title || filename} is marked client-only by its author. Installing it on a dedicated server will likely crash on startup.`,
      clientOnly: true,
    });
  }

  const modsPath = path.join(INSTANCES_DIR, serverId, 'mods');
  const destPath = path.join(modsPath, filename);

  try {
    await fs.ensureDir(modsPath);

    // Download the primary mod file
    const response = await fetch(url, { headers: MODRINTH_HEADERS });
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(destPath, buffer);

    // Persist metadata and resolve required dependencies
    const meta = await readModMetadata(modsPath);
    meta[filename] = { iconUrl: iconUrl || null, title: title || null, projectId: projectId || null };

    let depsInstalled = [];
    if (Array.isArray(dependencies) && dependencies.length > 0) {
      const visited = new Set([projectId].filter(Boolean));
      depsInstalled = await resolveAndInstallDeps(dependencies, gameVersion, loader, modsPath, meta, visited);
    }

    await writeModMetadata(modsPath, meta);
    res.json({ message: 'Mod installed', filename, depsInstalled });
  } catch (error) {
    console.error('Modrinth install error:', error);
    res.status(500).json({ error: 'Failed to install mod: ' + error.message });
  }
});

// ── Datapacks ──────────────────────────────────────────────────────────────────

app.get('/api/servers/:serverId/datapacks', async (req, res) => {
  const datapacksPath = path.join(INSTANCES_DIR, req.params.serverId, 'world', 'datapacks');
  try {
    await fs.ensureDir(datapacksPath);
    const files = await fs.readdir(datapacksPath);
    const result = await Promise.all(
      files.filter(f => f.endsWith('.zip')).map(async name => {
        try {
          const { size } = await fs.stat(path.join(datapacksPath, name));
          const mb = size / 1048576;
          return { name, size: mb < 1 ? (size / 1024).toFixed(1) + ' KB' : mb.toFixed(1) + ' MB' };
        } catch { return { name, size: '?' }; }
      })
    );
    res.json(result);
  } catch { res.json([]); }
});

app.post('/api/servers/:serverId/datapacks/install-modrinth', async (req, res) => {
  const { url, filename, iconUrl, title, projectId } = req.body;
  if (!url || !filename) return res.status(400).json({ error: 'url and filename are required' });
  // .jar files are Fabric mods, not valid datapacks — redirect to mods/ folder
  const isJar = filename.toLowerCase().endsWith('.jar');
  const destDir = isJar
    ? path.join(INSTANCES_DIR, req.params.serverId, 'mods')
    : path.join(INSTANCES_DIR, req.params.serverId, 'world', 'datapacks');
  try {
    await fs.ensureDir(destDir);
    const response = await fetch(url, { headers: MODRINTH_HEADERS });
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    await fs.writeFile(path.join(destDir, filename), Buffer.from(await response.arrayBuffer()));
    res.json({ message: isJar ? 'Installed to mods (jar-based datapack)' : 'Datapack installed', filename, installedToMods: isJar });
  } catch (error) {
    res.status(500).json({ error: 'Failed to install datapack: ' + error.message });
  }
});

app.delete('/api/servers/:serverId/datapacks/:filename', async (req, res) => {
  const filePath = path.join(INSTANCES_DIR, req.params.serverId, 'world', 'datapacks', req.params.filename);
  try {
    await fs.remove(filePath);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete datapack: ' + error.message });
  }
});

app.post('/api/servers/:serverId/open-folder', async (req, res) => {
  const serverPath = path.join(INSTANCES_DIR, req.params.serverId);
  if (!await fs.pathExists(serverPath)) return res.status(404).json({ error: 'Folder not found' });
  const cmd = process.platform === 'win32'
    ? `explorer "${serverPath}"`
    : process.platform === 'darwin'
      ? `open "${serverPath}"`
      : `xdg-open "${serverPath}"`;
  exec(cmd);
  res.json({ success: true });
});

// ───────────────────────────────────────────────────────────────────────────────

// Install a modpack from Modrinth — downloads .mrpack, parses manifest, installs all mods
app.post('/api/servers/:serverId/modpack/install-modrinth', async (req, res) => {
  const { serverId } = req.params;
  const { url, filename } = req.body;

  if (!url || !filename) return res.status(400).json({ error: 'url and filename are required' });

  const serverDir = path.join(INSTANCES_DIR, serverId);
  const modsPath = path.join(serverDir, 'mods');
  const tempPath = path.join(serverDir, '_temp_modpack.mrpack');

  try {
    await fs.ensureDir(modsPath);

    // 1. Download the .mrpack file
    const response = await fetch(url, { headers: MODRINTH_HEADERS });
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(tempPath, buffer);

    // 2. Read the zip and parse the manifest
    const zip = new AdmZip(tempPath);
    const manifestEntry = zip.getEntry('modrinth.index.json');
    if (!manifestEntry) throw new Error('Invalid modpack: no modrinth.index.json found');

    const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    const files = manifest.files || [];

    // 3. Download all mod files from the manifest.
    // Use downloadFromAny so we try every mirror in f.downloads[] (Modrinth lists
    // multiple) rather than giving up the moment the first CDN URL 404s, and
    // safeJoin to block traversal entries like "../../../etc/passwd".
    // Same client-mod filtering rules as POST /api/servers/from-modpack —
    // see that endpoint for the full rationale. The short version: env-flag
    // check covers the common-correct case, the filename deny-list catches
    // packs that mis-tag client mods OR ship them in overrides/mods/.
    let installed = 0;
    let failed = 0;
    let skippedClient = 0;
    let clientStashed = 0;
    // Stash a client-only mod and bump the counter — silent on failure (per-mod
    // failure shouldn't fail the whole modpack install).
    const stash = async (file, relPath) => {
      if (await stashClientModFromUrls(serverDir, relPath, file.downloads)) clientStashed++;
    };
    for (const file of files) {
      if (!Array.isArray(file.downloads) || file.downloads.length === 0) { failed++; continue; }
      const env = file.env || {};
      if (env.server === 'unsupported') {
        if (env.client === 'required') await stash(file, file.path);
        continue;
      }
      if (env.client === 'required' && env.server !== 'required') {
        skippedClient++;
        await stash(file, file.path);
        continue;
      }
      const rel = String(file.path || '').replace(/\\/g, '/');
      if (rel.startsWith('mods/') && isClientOnlyModFilename(path.basename(rel))) {
        skippedClient++;
        await stash(file, file.path);
        continue;
      }

      let destFile;
      try {
        destFile = safeJoin(serverDir, file.path);
      } catch (e) {
        console.error(`Refusing unsafe modpack path: ${file.path}`);
        failed++; continue;
      }

      try {
        await downloadFromAny(file.downloads, destFile);
        installed++;
      } catch (e) {
        console.error(`Failed to download ${file.path}:`, e.message);
        failed++;
      }
    }

    // 4. Extract overrides (config files, etc.) — safeJoin to block traversal.
    // overrides/mods/ also goes through the client-mod deny-list because the
    // Oculus-jar-in-overrides case is the #1 cause of dedicated-server crashes
    // after a modpack install.
    const overrideEntries = zip.getEntries().filter(e =>
      e.entryName.startsWith('overrides/') || e.entryName.startsWith('server-overrides/')
    );
    for (const entry of overrideEntries) {
      if (entry.isDirectory) continue;
      const relativePath = entry.entryName.replace(/^(overrides|server-overrides)\//, '');
      if (!relativePath) continue;
      const relNorm = relativePath.replace(/\\/g, '/');
      if (relNorm.startsWith('mods/') && isClientOnlyModFilename(path.basename(relNorm))) {
        skippedClient++;
        if (await stashClientModFromZipEntry(serverDir, entry, relNorm)) clientStashed++;
        continue;
      }
      let destFile;
      try { destFile = safeJoin(serverDir, relativePath); }
      catch { continue; }
      await fs.ensureDir(path.dirname(destFile));
      await fs.writeFile(destFile, entry.getData());
    }

    // Also pull anything under client-overrides/mods/ into the stash so the
    // client gets the configs/jars the pack author meant only for that side.
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      if (!entry.entryName.startsWith('client-overrides/')) continue;
      const rel = entry.entryName.slice('client-overrides/'.length);
      const relNorm = rel.replace(/\\/g, '/');
      if (!relNorm.startsWith('mods/')) continue;
      if (await stashClientModFromZipEntry(serverDir, entry, relNorm)) clientStashed++;
    }

    // 5. Cleanup temp file
    await fs.remove(tempPath);

    res.json({
      message: 'Modpack installed',
      installed,
      failed,
      total: files.length,
      // How many client-only mods we filtered out so the user gets a "we did
      // this on purpose" signal rather than wondering why the count's short.
      skippedClientOnly: skippedClient,
      // Of those, how many we successfully stashed for client-side install.
      clientModsStashed: clientStashed,
    });
  } catch (error) {
    console.error('Modpack install error:', error);
    await fs.remove(tempPath).catch(() => {});
    res.status(500).json({ error: 'Failed to install modpack: ' + error.message });
  }
});

// Shutdown Endpoint
app.post('/api/shutdown', (req, res) => {
  res.json({ message: 'Shutting down...' });
  setTimeout(() => {
    const isWin = process.platform === 'win32';

    const killPid = (pid) => {
      if (!pid) return;
      try {
        if (isWin) {
          // /T kills the full process tree rooted at pid, not just the direct process
          exec(`taskkill /F /T /PID ${pid}`, () => {});
        } else {
          try { process.kill(-pid, 'SIGKILL'); } catch (_) { process.kill(pid, 'SIGKILL'); }
        }
      } catch (_) {}
    };

    // Kill Minecraft server wrapper processes (cmd.exe / sh / java direct)
    for (const id in activeProcesses) {
      if (activeProcesses[id]) killPid(activeProcesses[id].pid);
    }

    // Kill actual JVM processes discovered via process-tree walking
    for (const id in serverJavaPids) {
      killPid(serverJavaPids[id]);
    }

    // Kill any other tracked child processes (installer procs, etc.)
    for (const proc of allChildProcesses) {
      if (proc && proc.pid) killPid(proc.pid);
    }

    // Kill the frontend dev server (Vite on port 5173)
    if (isWin) {
      exec('netstat -aon', (err, stdout) => {
        if (!err && stdout) {
          for (const line of stdout.split('\n')) {
            if (line.includes(':5173') && line.includes('LISTENING')) {
              const pid = line.trim().split(/\s+/).pop();
              if (/^\d+$/.test(pid)) exec(`taskkill /F /T /PID ${pid}`, () => {});
            }
          }
        }
      });
    } else {
      exec('fuser -k 5173/tcp 2>/dev/null; true', () => {});
    }

    // Allow signals to propagate, then exit the backend process itself
    setTimeout(() => process.exit(0), 800);
  }, 300);
});

// ─── Hangar API Proxy (Paper plugins) ────────────────────────────────────────
const HANGAR_API = 'https://hangar.papermc.io/api/v1';
const HANGAR_HEADERS = { 'User-Agent': 'MineDash/1.0 (local server manager)' };

// Search plugins on Hangar
app.get('/api/hangar/search', async (req, res) => {
  try {
    const { query, limit, offset, gameVersion, category } = req.query;
    const params = new URLSearchParams({
      query: query || '',
      limit: limit || '20',
      offset: offset || '0',
      sort: 'downloads',
    });
    if (gameVersion) {
      params.set('platform', 'PAPER');
      params.set('platformVersion', gameVersion);
    }
    if (category) params.set('category', category);

    const response = await axios.get(`${HANGAR_API}/projects?${params}`, { headers: HANGAR_HEADERS, timeout: 15000 });
    res.json(response.data);
  } catch (err) {
    console.error('Hangar search error:', err.message);
    res.status(500).json({ error: `Failed to search Hangar: ${err.message}` });
  }
});

// Get versions for a Hangar project
app.get('/api/hangar/project/:slug/versions', async (req, res) => {
  try {
    const { slug } = req.params;
    const { gameVersion } = req.query;
    const params = new URLSearchParams({ limit: '10', offset: '0' });
    if (gameVersion) params.set('platformVersion', gameVersion);

    const response = await axios.get(
      `${HANGAR_API}/projects/${encodeURIComponent(slug)}/versions?${params}`,
      { headers: HANGAR_HEADERS }
    );
    res.json(response.data);
  } catch (err) {
    console.error('Hangar versions error:', err.message);
    res.status(500).json({ error: 'Failed to get plugin versions' });
  }
});

// Download and install a plugin from Hangar into the server's plugins/ folder
app.post('/api/servers/:serverId/plugins/install-hangar', async (req, res) => {
  const { serverId } = req.params;
  const { downloadUrl, filename, title, slug, iconUrl } = req.body;

  if (!downloadUrl || !filename) {
    return res.status(400).json({ error: 'downloadUrl and filename are required' });
  }

  const servers = await getServers();
  const serverConfig = servers.find(s => s.id === serverId);
  if (!serverConfig) return res.status(404).json({ error: 'Server not found' });

  const pluginsPath = path.join(INSTANCES_DIR, serverId, 'plugins');
  await fs.ensureDir(pluginsPath);

  try {
    const response = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      headers: HANGAR_HEADERS,
      timeout: 120000,
    });
    const buffer = Buffer.from(response.data);
    const destPath = path.join(pluginsPath, filename);
    await fs.writeFile(destPath, buffer);

    // Store plugin metadata (mirrors the mod metadata system)
    const metaPath = path.join(pluginsPath, '.minedash-plugins.json');
    let meta = {};
    try { meta = await fs.readJson(metaPath); } catch (_) {}
    meta[filename] = { title: title || filename, slug, iconUrl: iconUrl || null, enabled: true };
    await fs.writeJson(metaPath, meta, { spaces: 2 });

    console.log(`[MineDash] Installed plugin: ${filename}`);
    res.json({ message: `Installed ${filename}` });
  } catch (err) {
    console.error('Plugin install error:', err.message);
    res.status(500).json({ error: `Failed to install plugin: ${err.message}` });
  }
});


// ─── Update server config (autoBackup, backupIntervalHours, keepLastNBackups, usePlayit) ─
// Piggyback on the existing general settings endpoint pattern
app.patch('/api/servers/:id/backup-settings', async (req, res) => {
  try {
    const { id } = req.params;
    const { autoBackup, backupIntervalHours, keepLastNBackups } = req.body;

    const servers = await getServers();
    const idx = servers.findIndex(s => s.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Server not found' });

    if (autoBackup !== undefined) servers[idx].autoBackup = autoBackup;
    if (backupIntervalHours !== undefined) servers[idx].backupIntervalHours = Number(backupIntervalHours);
    if (keepLastNBackups !== undefined) servers[idx].keepLastNBackups = Number(keepLastNBackups);

    await saveServers(servers);

    // Restart backup interval if server is running
    if (activeProcesses[id]) {
      startAutoBackupInterval(id, servers[idx]);
    }

    io.emit('server_updated', servers[idx]);
    res.json(servers[idx]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Scheduled Tasks CRUD ─────────────────────────────────────────────────────
app.get('/api/servers/:id/scheduled-tasks', async (req, res) => {
  try {
    const servers = await getServers();
    const cfg = servers.find(s => s.id === req.params.id);
    if (!cfg) return res.status(404).json({ error: 'Server not found' });
    res.json(cfg.scheduledTasks || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/servers/:id/scheduled-tasks', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type, command, schedule, enabled } = req.body || {};

    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!['backup', 'restart', 'command'].includes(type)) return res.status(400).json({ error: 'Invalid task type' });
    if (type === 'command' && (!command || !command.trim())) return res.status(400).json({ error: 'Command is required for command tasks' });
    const sch = schedule || {};
    if (!Number.isInteger(sch.hour) || sch.hour < 0 || sch.hour > 23) return res.status(400).json({ error: 'Invalid hour' });
    if (!Number.isInteger(sch.minute) || sch.minute < 0 || sch.minute > 59) return res.status(400).json({ error: 'Invalid minute' });
    if (sch.days && (!Array.isArray(sch.days) || sch.days.some(d => !Number.isInteger(d) || d < 0 || d > 6))) return res.status(400).json({ error: 'Invalid days' });

    const servers = await getServers();
    const idx = servers.findIndex(s => s.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Server not found' });

    const newTask = {
      id: 'task-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      name: name.trim(),
      type,
      command: type === 'command' ? command.trim() : undefined,
      schedule: { days: sch.days || [], hour: sch.hour, minute: sch.minute },
      enabled: enabled !== false,
    };
    servers[idx].scheduledTasks = [...(servers[idx].scheduledTasks || []), newTask];
    await saveServers(servers);
    io.emit('server_updated', servers[idx]);
    res.json(newTask);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/servers/:id/scheduled-tasks/:taskId', async (req, res) => {
  try {
    const { id, taskId } = req.params;
    const servers = await getServers();
    const idx = servers.findIndex(s => s.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Server not found' });
    const tasks = servers[idx].scheduledTasks || [];
    const tIdx = tasks.findIndex(t => t.id === taskId);
    if (tIdx === -1) return res.status(404).json({ error: 'Task not found' });

    const patch = req.body || {};
    const updated = { ...tasks[tIdx] };
    if (patch.name !== undefined) updated.name = String(patch.name).trim();
    if (patch.enabled !== undefined) updated.enabled = !!patch.enabled;
    if (patch.command !== undefined) updated.command = String(patch.command);
    if (patch.schedule !== undefined) {
      const sch = patch.schedule;
      if (Number.isInteger(sch.hour)) updated.schedule.hour = sch.hour;
      if (Number.isInteger(sch.minute)) updated.schedule.minute = sch.minute;
      if (Array.isArray(sch.days)) updated.schedule.days = sch.days;
    }
    tasks[tIdx] = updated;
    servers[idx].scheduledTasks = tasks;
    await saveServers(servers);
    io.emit('server_updated', servers[idx]);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/servers/:id/scheduled-tasks/:taskId', async (req, res) => {
  try {
    const { id, taskId } = req.params;
    const servers = await getServers();
    const idx = servers.findIndex(s => s.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Server not found' });
    const before = (servers[idx].scheduledTasks || []).length;
    servers[idx].scheduledTasks = (servers[idx].scheduledTasks || []).filter(t => t.id !== taskId);
    if (servers[idx].scheduledTasks.length === before) return res.status(404).json({ error: 'Task not found' });
    await saveServers(servers);
    io.emit('server_updated', servers[idx]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Launcher (Microsoft + offline accounts, mod sync, game launch) ────────────
const launcher = require('./launcher');
launcher.init({
  DATA_DIR,
  INSTANCES_DIR,
  getJavaPath,
  getServers,
  io,
  // Share the dep-crash plumbing so the launcher can auto-install missing
  // client-side mods after a failed launch, the same way the server side does
  // after a failed server start.
  hasDependencyCrash,
  parseMissingModIds,
  modrinthApi: MODRINTH_API,
  modrinthHeaders: MODRINTH_HEADERS,
});
launcher.register(app);

const PORT = 3001;
server.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
