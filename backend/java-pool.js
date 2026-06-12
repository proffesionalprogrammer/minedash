// Managed Java pool — shared between the server backend (backend/index.js)
// and the launcher (backend/launcher.js, including when it runs inside the
// forked launcher-worker process). We download JDKs from Adoptium on demand
// into <runtimes>/jdk-{major}/ so every server AND every launcher instance can
// use the exact Java its MC version expects, without asking the user to
// install anything. The pool is per-MineDash-installation, shared across all
// servers and launcher profiles on this machine.
//
// This lives in its own module (rather than index.js) because the launch
// worker is a separate process that loads launcher.js directly — it can't
// reach functions defined inside index.js. Call init() with the runtimes
// directory before using any pool function.

const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { execSync } = require('child_process');

let RUNTIMES_DIR = null;

function init(runtimesDir) {
  RUNTIMES_DIR = runtimesDir;
}

function assertInit() {
  if (!RUNTIMES_DIR) throw new Error('java-pool used before init()');
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

function managedJdkRoot(major) {
  assertInit();
  return path.join(RUNTIMES_DIR, `jdk-${major}`);
}

function managedJavaPath(major) {
  return path.join(managedJdkRoot(major), 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
}

function findManagedJava(major) {
  const p = managedJavaPath(major);
  return fs.existsSync(p) ? p : null;
}

// Every JDK currently installed in the pool, sorted by major. Used by the
// launcher settings UI to offer "use Java N" choices without re-scanning.
function listManagedJavas() {
  assertInit();
  let entries = [];
  try { entries = fs.readdirSync(RUNTIMES_DIR); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const m = e.match(/^jdk-(\d+)$/);
    if (!m) continue;
    const major = parseInt(m[1], 10);
    const p = managedJavaPath(major);
    if (fs.existsSync(p)) out.push({ major, path: p });
  }
  return out.sort((a, b) => a.major - b.major);
}

// Read the major version of a specific java binary by shelling out to it.
// Returns null on any failure. Caches results so we don't shell out on every
// server start.
const _javaVersionCache = new Map();
function getJavaVersionForPath(javaPath) {
  if (_javaVersionCache.has(javaPath)) return _javaVersionCache.get(javaPath);
  try {
    const out = execSync(`"${javaPath}" -version 2>&1`, { encoding: 'utf8', timeout: 6000 });
    const m = out.match(/"(\d+)(?:\.(\d+))?/);
    if (!m) { _javaVersionCache.set(javaPath, null); return null; }
    const major = parseInt(m[1]);
    const v = major === 1 ? parseInt(m[2] || '0') : major;
    _javaVersionCache.set(javaPath, v);
    return v;
  } catch (_) {
    _javaVersionCache.set(javaPath, null);
    return null;
  }
}

// Adoptium asset metadata for a given major. Returns the .zip binary URL +
// filename. Throws on any API or network failure (callers wrap and log).
const ADOPTIUM_API = 'https://api.adoptium.net/v3';
async function fetchAdoptiumAsset(major) {
  const osName = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'mac' : 'linux');
  const arch = 'x64';
  const params = new URLSearchParams({
    architecture: arch,
    heap_size: 'normal',
    image_type: 'jdk',
    jvm_impl: 'hotspot',
    os: osName,
    page: '0',
    page_size: '1',
    sort_method: 'DEFAULT',
    sort_order: 'DESC',
    vendor: 'eclipse',
  });
  const res = await axios.get(`${ADOPTIUM_API}/assets/feature_releases/${major}/ga?${params}`, {
    timeout: 20000,
    headers: { 'User-Agent': 'MineDash/1.0 java-installer' },
  });
  const data = res.data;
  if (!Array.isArray(data) || data.length === 0) throw new Error('Adoptium returned no GA releases');
  const release = data[0];
  const binaries = release.binaries || [];
  // Prefer .zip — adm-zip can extract it without native deps. .tar.gz needs an
  // extra lib we don't currently bundle.
  const bin = binaries.find(b => b.package?.name?.toLowerCase().endsWith('.zip'))
           || binaries.find(b => b.package?.name?.toLowerCase().endsWith('.tar.gz'))
           || binaries.find(b => b.package?.link);
  if (!bin?.package?.link) throw new Error('No downloadable binary in Adoptium response');
  return {
    name: bin.package.name,
    link: bin.package.link,
    size: bin.package.size || 0,
    releaseName: release.release_name || `jdk-${major}`,
  };
}

// Download + extract the given JDK major into the runtimes pool. `onProgress`
// receives { phase, percent, downloaded?, total?, name? } as the install runs.
// Idempotent: if the JDK is already installed, returns the existing path.
async function ensureManagedJava(major, onProgress) {
  const existing = findManagedJava(major);
  if (existing) return existing;

  await fs.ensureDir(RUNTIMES_DIR);
  // PID-suffixed temp names so the backend process and a launch worker can't
  // clobber each other's half-written download of the same major.
  const tempZip = path.join(RUNTIMES_DIR, `jdk-${major}.${process.pid}.download`);
  const extractTmp = path.join(RUNTIMES_DIR, `jdk-${major}.${process.pid}.extract`);
  await fs.remove(tempZip).catch(() => {});
  await fs.remove(extractTmp).catch(() => {});

  onProgress?.({ phase: 'metadata', percent: 0 });
  const asset = await fetchAdoptiumAsset(major);

  onProgress?.({ phase: 'download', percent: 0, name: asset.name, total: asset.size });

  // Stream the download with progress events. adm-zip can't handle .tar.gz so
  // we error early on non-zip archives — the API normally returns .zip for
  // Windows, which is the platform MineDash targets.
  if (!asset.name.toLowerCase().endsWith('.zip')) {
    throw new Error(`Adoptium returned a ${path.extname(asset.name)} package, which MineDash can't extract on this platform`);
  }

  const dlRes = await axios.get(asset.link, {
    responseType: 'stream',
    maxRedirects: 10,
    timeout: 0, // big file — let the per-chunk progress show liveness instead
    headers: { 'User-Agent': 'MineDash/1.0 java-installer' },
  });
  const total = parseInt(dlRes.headers['content-length'] || asset.size || '0', 10);
  let downloaded = 0;
  let lastEmitPct = -1;
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(tempZip);
    dlRes.data.on('data', (chunk) => {
      downloaded += chunk.length;
      if (total > 0) {
        const pct = Math.min(99, Math.floor((downloaded / total) * 100));
        // Throttle to whole-percent updates so we don't flood the socket.
        if (pct !== lastEmitPct) {
          lastEmitPct = pct;
          onProgress?.({ phase: 'download', percent: pct, downloaded, total });
        }
      }
    });
    dlRes.data.pipe(w);
    w.on('finish', resolve);
    w.on('error', reject);
    dlRes.data.on('error', reject);
  });

  onProgress?.({ phase: 'extract', percent: 0 });
  await fs.ensureDir(extractTmp);
  try {
    const zip = new AdmZip(tempZip);
    zip.extractAllTo(extractTmp, true);
  } catch (err) {
    await fs.remove(tempZip).catch(() => {});
    await fs.remove(extractTmp).catch(() => {});
    throw new Error(`Failed to extract JDK zip: ${err.message}`);
  }

  // Adoptium zips have a single top-level dir like "jdk-21.0.7+6". Move that
  // to a stable name (`jdk-{major}/`) so future runs find it deterministically.
  const entries = await fs.readdir(extractTmp);
  const topDir = entries.find(e => {
    try { return fs.statSync(path.join(extractTmp, e)).isDirectory(); } catch { return false; }
  });
  if (!topDir) {
    await fs.remove(extractTmp).catch(() => {});
    await fs.remove(tempZip).catch(() => {});
    throw new Error('Extracted JDK has no top-level directory');
  }
  const finalDir = managedJdkRoot(major);
  // Another process may have finished installing the same major while we were
  // downloading — keep theirs, ours is identical.
  if (!findManagedJava(major)) {
    await fs.remove(finalDir).catch(() => {});
    await fs.move(path.join(extractTmp, topDir), finalDir);
  }
  await fs.remove(extractTmp).catch(() => {});
  await fs.remove(tempZip).catch(() => {});

  const finalJava = managedJavaPath(major);
  if (!fs.existsSync(finalJava)) {
    throw new Error(`Java binary not found after extract: ${finalJava}`);
  }
  // Drop any stale cached version for the managed path — managed install
  // doesn't change it, but the cache key is the path so this is just hygiene.
  _javaVersionCache.delete(finalJava);

  onProgress?.({ phase: 'done', percent: 100, path: finalJava });
  return finalJava;
}

// One install per (major) in flight at a time — block parallel sessions so we
// don't race extracting the same zip twice. Returns the same promise to all
// concurrent callers.
const _javaInstallInFlight = new Map(); // major -> Promise
function ensureManagedJavaSingleFlight(major, onProgress) {
  if (_javaInstallInFlight.has(major)) return _javaInstallInFlight.get(major);
  const p = ensureManagedJava(major, onProgress).finally(() => {
    _javaInstallInFlight.delete(major);
  });
  _javaInstallInFlight.set(major, p);
  return p;
}

module.exports = {
  init,
  RECOMMENDED_JAVA_MAJOR,
  requiredJavaMajor,
  managedJdkRoot,
  managedJavaPath,
  findManagedJava,
  listManagedJavas,
  getJavaVersionForPath,
  fetchAdoptiumAsset,
  ensureManagedJava,
  ensureManagedJavaSingleFlight,
};
