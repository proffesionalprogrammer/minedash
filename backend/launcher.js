// MineDash launcher backend — Microsoft + offline accounts, mod sync, game launch.
// Mounted from backend/index.js via require('./launcher').register(...).
//
// To enable Microsoft sign-in, register an app at https://portal.azure.com
//   App type:   Public client / native
//   Redirect:   http://localhost
// Then paste the Application (client) ID into AZURE_CLIENT_ID below.

const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const AdmZip = require('adm-zip');
const archiver = require('archiver');
const multer = require('multer');
const { PNG } = require('pngjs');
const { Client } = require('minecraft-launcher-core');

// Why mclc downloads can't be hard-cancelled:
//   - minecraft-launcher-core uses the legacy `request` library and exposes no
//     cancel API of its own. We previously intercepted `request` and called
//     .abort() on every in-flight download when the user clicked Stop, but
//     mclc's handler.js pipes the request directly into `fs.createWriteStream`
//     with no error listener on the file stream — aborting the pipe makes the
//     write stream emit an unhandled 'error' and the entire backend process
//     exits. mclc also retries the download from its own error handler, so the
//     abort actively makes things worse rather than stopping anything.
//   - The pragmatic answer is: tell the user the truth in the UI ("Cancelling —
//     will stop after current file") and let the cancelledLaunches flag kill
//     the JVM the moment mclc's download phase completes. Not instant, but
//     honest and doesn't crash the backend.
const msmc = require('msmc');
const { Auth } = msmc;
const { ensureAuthlibInjector, fetchPrefetchMeta } = require('./authlib-injector');
// Shared managed-JDK pool (DATA_DIR/runtimes/jdk-{major}/). Required directly
// (not passed through init opts) so the forked launch worker — which loads
// this module without index.js — gets the same pool. Initialised in init().
const javaPool = require('./java-pool');
// Tiny dependency-free NBT reader used to surface a world's seed / game mode /
// last-played from its level.dat (Worlds panel). See backend/nbt-lite.js.
const nbtLite = require('./nbt-lite');

// ─── CONFIG ─────────────────────────────────────────────────────────
const AZURE_CLIENT_ID = ''; // ← fill in after registering the Azure app

// Ely.by — we use it ONLY for its public skin system (no Ely.by login/account).
// Offline accounts can opt into Ely.by skins; we resolve the Ely.by UUID by
// username here and launch with authlib-injector so the skin shows in-game on
// servers that support it (see backend/authlib-injector.js).
const ELYBY_AUTHSERVER = 'https://authserver.ely.by';
// The authlib-injector API root for Ely.by. We pass this FULL URL to the agent
// rather than the `ely.by` shorthand: the shorthand only works because the
// agent fetches https://ely.by and follows its X-Authlib-Injector-API-Location
// redirect header — but the prefetched-metadata flag we also pass short-circuits
// that discovery, leaving the root as the literal (wrong) https://ely.by, which
// makes every auth/session/skin call 404. The explicit root needs no redirect.
const ELYBY_API_ROOT = `${ELYBY_AUTHSERVER}/api/authlib-injector`;
const MODRINTH_API = 'https://api.modrinth.com/v2';
// Modrinth asks for a User-Agent with contact info so they can reach the
// project (not the end user) if it starts misbehaving. The repo URL is a
// project-level contact — it points at the source, not the user running it.
const MODRINTH_HEADERS = {
  'User-Agent': 'MineDash/1.0 (+https://github.com/proffesionalprogrammer/minedash)',
};

// ─── State (set by init()) ──────────────────────────────────────────
let DATA_DIR;
let INSTANCES_DIR;
let getJavaPath;
let getServers;
let io;
// Dep-crash plumbing shared from backend/index.js — used to auto-install
// missing client-side mods after a failed launch (the same pattern the
// server-restart loop uses).
let hasDependencyCrashFn = null;
let parseMissingModIdsFn = null;
let MODRINTH_LOOKUP_API = MODRINTH_API;
let MODRINTH_LOOKUP_HEADERS = MODRINTH_HEADERS;

const msSessions = new Map();       // sessionId -> { status, link?, account?, error?, server? }
// In parent (HTTP) mode: launchId -> { worker, jvmPid? } once the launch is forked.
// In worker mode: launchId -> mclc Client instance during the active run (used
// only by the in-worker code path for child-tracking and cancellation checks).
const activeLaunches = new Map();
// Parent-side flag set when the user clicks Stop. The worker is told via IPC,
// but the flag also gates the parent's own "did we hide the window to tray?"
// behaviour so it stays accurate even when the worker exits before we ask.
const cancelledLaunches = new Set();
const childMap = new Map();          // launchId -> game process (ChildProcess) after launch()
// Modpack-install cancellation registry. sessionId -> one of:
//   { launchId, cleanupInstanceId } — worker-backed Browse pre-install (cancel
//                                      kills the launch worker; the partial
//                                      instance is wiped on the worker's exit)
//   { token }                       — direct installModpackIntoProfile run
//                                      (cancel flips token.cancelled, the
//                                      download loop bails on its next check)
// Cleared when the install reaches a terminal state (done / error / cancelled).
const activeModpackInstalls = new Map();

// Pluggable side-effect hooks. The parent process keeps the defaults below
// (emit → socket.io, isCancelled → set lookup) so HTTP-mode launches behave
// the same as before. When this module is loaded inside a worker
// (`launcher-worker.js`), the worker overrides these so events go back to the
// parent over IPC and cancellation is driven by the parent's cancel message.
let _emit = (launchId, event, data) => {
  if (io) io.emit(`launcher_${launchId}`, { event, ...data });
};
let _isCancelled = (launchId) => cancelledLaunches.has(launchId);
let _clearCancel  = (launchId) => cancelledLaunches.delete(launchId);
let _trackChild   = () => {};
let _untrackChild = () => {};

function init(opts) {
  DATA_DIR = opts.DATA_DIR;
  INSTANCES_DIR = opts.INSTANCES_DIR;
  // Idempotent — the parent process already init'd the pool with the same dir
  // (RUNTIMES_DIR in index.js is DATA_DIR/runtimes); this matters in the
  // launch worker, where this init() is the only one that runs.
  javaPool.init(path.join(DATA_DIR, 'runtimes'));
  getJavaPath = opts.getJavaPath;
  getServers = opts.getServers;
  io = opts.io;
  if (opts.hasDependencyCrash) hasDependencyCrashFn = opts.hasDependencyCrash;
  if (opts.parseMissingModIds) parseMissingModIdsFn = opts.parseMissingModIds;
  if (opts.modrinthApi)        MODRINTH_LOOKUP_API = opts.modrinthApi;
  if (opts.modrinthHeaders)    MODRINTH_LOOKUP_HEADERS = opts.modrinthHeaders;
  // Worker-mode overrides. All optional — parent leaves them at default.
  if (opts.emit)         _emit         = opts.emit;
  if (opts.isCancelled)  _isCancelled  = opts.isCancelled;
  if (opts.clearCancel)  _clearCancel  = opts.clearCancel;
  if (opts.trackChild)   _trackChild   = opts.trackChild;
  if (opts.untrackChild) _untrackChild = opts.untrackChild;
  // Fire-and-forget — migration is idempotent and only writes if it finds dirs
  // missing from the registry. Errors are swallowed so a corrupt FS state can't
  // brick startup.
  migrateProfileDirsToRegistry().catch(() => {});
}

const accountsFile  = () => path.join(DATA_DIR, 'launcher-accounts.json');
const settingsFile  = () => path.join(DATA_DIR, 'launcher-settings.json');
const profilesFile  = () => path.join(DATA_DIR, 'launcher-profiles.json');
const clientsRoot   = () => path.join(DATA_DIR, 'launcher-clients');

// ─── Profile registry (multi-instance) ──────────────────────────────
// Each instance is an independent client profile (mods/, configs/, world dir
// for singleplayer, etc.) that the user can launch separately. Instance IDs
// double as the on-disk folder name under launcher-clients/, so a fresh
// install needs no rename and migration of an existing single-instance world
// is a no-op write.
//
// The "default" instance for a given loader+version uses the legacy folder
// name `${loader}-${version}` as its id, so the per-server Play button and
// existing endpoints keep working unchanged.

const LOADERS = ['vanilla', 'fabric', 'forge', 'neoforge'];

function defaultInstanceId(loader, version) {
  return `${loader}-${version}`;
}

function instanceDir(instanceId) {
  return path.join(clientsRoot(), instanceId);
}

// Stream-hash a file so 100+ MB modpack jars don't get pulled into RAM.
function fileSha1(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const s = fs.createReadStream(filePath);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// Ask Modrinth what project a file belongs to. Returns one of:
//   { status: 'hit',     hit: {iconUrl, title, projectId} } — found on Modrinth
//   { status: 'miss'   }                                   — confirmed not there (HTTP 404)
//   { status: 'retry'  }                                   — transient (429 / 5xx / network) — caller should NOT mark lookedUp
//
// Distinguishing these matters because Modrinth rate-limits at 300 req/min/IP.
// If we marked every failure as `lookedUp: true`, a brief 429 burst would
// permanently leave a batch of mods iconless until the user manually wiped
// `.minedash-launcher.json`.
async function modrinthLookupByHash(sha1) {
  try {
    const vr = await fetch(`${MODRINTH_API}/version_file/${sha1}?algorithm=sha1`, {
      headers: MODRINTH_HEADERS,
    });
    if (vr.status === 404) return { status: 'miss' };
    if (!vr.ok) return { status: 'retry' };
    const vd = await vr.json();
    const projectId = vd?.project_id;
    if (!projectId) return { status: 'miss' };
    // Pull version-level fields (the exact installed jar) so we can flag
    // wrong-version / wrong-loader installs without making a second roundtrip.
    const gameVersions = Array.isArray(vd?.game_versions) ? vd.game_versions : [];
    const loaders = Array.isArray(vd?.loaders) ? vd.loaders : [];
    const pr = await fetch(`${MODRINTH_API}/project/${projectId}`, { headers: MODRINTH_HEADERS });
    if (pr.status === 404) {
      // The version exists but its project was deleted — odd but treat as a
      // permanent miss so we don't retry forever.
      return { status: 'hit', hit: { iconUrl: null, title: null, projectId, gameVersions, loaders } };
    }
    if (!pr.ok) return { status: 'retry' };
    const pd = await pr.json();
    return {
      status: 'hit',
      hit: {
        iconUrl: pd?.icon_url || null,
        title: pd?.title || null,
        projectId,
        gameVersions,
        loaders,
      },
    };
  } catch {
    // Network error — transient, let the caller retry next time.
    return { status: 'retry' };
  }
}

// Pick the best version from a Modrinth /project/{id}/version response.
// Preference order: release > beta > alpha; within each type, newest by
// date_published. The bare type-only sort relied on Modrinth returning
// versions newest-first, which isn't reliable when game_versions / loaders
// filters are applied.
function pickBestModrinthVersion(versions) {
  if (!Array.isArray(versions) || versions.length === 0) return null;
  const typeRank = { release: 0, beta: 1, alpha: 2 };
  const sorted = [...versions].sort((a, b) => {
    const ta = typeRank[a.version_type] ?? 3;
    const tb = typeRank[b.version_type] ?? 3;
    if (ta !== tb) return ta - tb;
    const da = Date.parse(a.date_published || '') || 0;
    const db = Date.parse(b.date_published || '') || 0;
    return db - da; // newest first
  });
  return sorted[0];
}

// Recursively install required Modrinth dependencies into a launcher
// profile's mods/ folder. Mirrors backend/index.js's resolveAndInstallDeps
// but writes to .minedash-launcher.json (the launcher's metadata shape)
// rather than the server-side .minedash-mods.json shape.
//
// `meta` is mutated in-place; caller is responsible for writing it back to
// disk after this returns. Visited set guards against circular dep graphs.
async function resolveAndInstallLauncherDeps(depProjectIds, gameVersion, loader, modsPath, meta, visited, depth = 0) {
  if (depth > 4) return [];
  const installed = [];
  for (const projectId of depProjectIds) {
    if (visited.has(projectId)) continue;
    visited.add(projectId);

    const alreadyInstalled = Object.values(meta).some(m => m && m.projectId === projectId);
    if (alreadyInstalled) continue;

    try {
      const params = new URLSearchParams();
      if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));
      if (loader)      params.set('loaders',       JSON.stringify([loader]));
      const vRes = await fetch(`${MODRINTH_API}/project/${projectId}/version?${params}`, { headers: MODRINTH_HEADERS });
      if (!vRes.ok) continue;
      const versions = await vRes.json();
      if (!Array.isArray(versions) || versions.length === 0) continue;

      const best = pickBestModrinthVersion(versions);
      if (!best) continue;
      const file = (best.files || []).find(f => f.primary) || (best.files || [])[0];
      if (!file) continue;

      const dlRes = await fetch(file.url, { headers: MODRINTH_HEADERS });
      if (!dlRes.ok) continue;
      const buffer = Buffer.from(await dlRes.arrayBuffer());
      await fs.writeFile(path.join(modsPath, file.filename), buffer);

      let iconUrl = null;
      let title = file.filename;
      try {
        const pRes = await fetch(`${MODRINTH_API}/project/${projectId}`, { headers: MODRINTH_HEADERS });
        if (pRes.ok) { const p = await pRes.json(); iconUrl = p.icon_url || null; title = p.title || file.filename; }
      } catch (_) {}

      meta[file.filename] = {
        projectId,
        iconUrl,
        title,
        gameVersions: best.game_versions || [],
        loaders:      best.loaders       || [],
        lookedUp: true,
      };
      installed.push({ filename: file.filename, title });
      console.log(`[MineDash Launcher Deps] Installed dep: ${title} (${file.filename})`);

      const subDeps = (best.dependencies || [])
        .filter(d => d.dependency_type === 'required' && d.project_id)
        .map(d => d.project_id);
      if (subDeps.length > 0) {
        const sub = await resolveAndInstallLauncherDeps(subDeps, gameVersion, loader, modsPath, meta, visited, depth + 1);
        installed.push(...sub);
      }
    } catch (err) {
      console.error(`[MineDash Launcher Deps] Failed dep ${projectId}:`, err.message);
    }
  }
  return installed;
}

// Run async tasks with bounded concurrency. Default 4 in flight keeps a
// 300-mod first-load comfortably under Modrinth's 300 req/min/IP cap (each
// file is 2 requests, so peak throughput is ~8 req/s = 480/min, but real
// latency keeps it well below).
async function runWithConcurrency(tasks, limit) {
  const queue = tasks.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const job = queue.shift();
      if (job) await job();
    }
  });
  await Promise.all(workers);
}

// For any launcher-installed file without an iconUrl, hash it and ask Modrinth.
// Persists results to .minedash-launcher.json so subsequent listings are instant.
// Hits and confirmed misses (404) are cached with `lookedUp: true`; transient
// failures (429/5xx/network) are NOT cached, so the next listing retries them.
// Mutates `meta` in place. Concurrency is bounded so a big modpack doesn't
// burst-flood Modrinth into a per-IP rate limit.
async function enrichLauncherMeta(dir, files, meta) {
  const jobs = [];
  for (const f of files) {
    const existing = meta[f];
    // `lookedUp: true` is final. We used to also force a re-enrich whenever
    // gameVersions was missing — the idea was to backfill older metadata so
    // the wrong-version banner could fire. But that turned every Modrinth
    // 'miss' (CurseForge-only mods like FTB Quests, niche libraries, custom
    // builds) into a permanent re-check: every time the user opened Content
    // we'd re-SHA1 those files and re-hit Modrinth for a guaranteed 404.
    // A 200-CurseForge-mod Prominence install made that a 20-second open,
    // every open. The fix is to trust `lookedUp` regardless of which fields
    // are present. Users who upgraded from a pre-version-tracking build can
    // wipe `.minedash-launcher.json` to force a one-off re-enrichment if
    // they want the wrong-version warnings on old metadata.
    if (existing && (existing.iconUrl || existing.lookedUp)) continue;
    jobs.push(async () => {
      try {
        const sha1 = await fileSha1(path.join(dir, f));
        const res = await modrinthLookupByHash(sha1);
        if (res.status === 'hit') {
          meta[f] = {
            ...(existing || {}),
            iconUrl: res.hit.iconUrl || existing?.iconUrl || null,
            title:   res.hit.title   || existing?.title   || null,
            projectId: res.hit.projectId || existing?.projectId || null,
            gameVersions: res.hit.gameVersions || existing?.gameVersions || [],
            loaders: res.hit.loaders || existing?.loaders || [],
            lookedUp: true,
          };
        } else if (res.status === 'miss') {
          meta[f] = { ...(existing || {}), lookedUp: true };
        }
        // status === 'retry' → leave meta untouched, try again next listing.
      } catch {
        // Hashing failed (file vanished mid-listing, permission error, etc.)
        // — not a Modrinth issue, so safe to skip without marking lookedUp.
      }
    });
  }
  if (jobs.length === 0) return false;
  await runWithConcurrency(jobs, 4);
  try { await fs.writeJson(path.join(dir, '.minedash-launcher.json'), meta, { spaces: 2 }); } catch {}
  return true;
}

async function readProfileRegistry() {
  try {
    const d = await fs.readJson(profilesFile());
    if (d && Array.isArray(d.instances)) return d;
  } catch {}
  return { instances: [] };
}

async function writeProfileRegistry(data) {
  await fs.ensureDir(DATA_DIR);
  await fs.writeJson(profilesFile(), data, { spaces: 2 });
}

async function getInstance(instanceId) {
  const reg = await readProfileRegistry();
  return reg.instances.find(i => i.id === instanceId) || null;
}

// Remove an instance's on-disk profile folder and drop it from the registry.
// Used by DELETE /instances/:id and by the cancel-cleanup path when a Browse
// pre-install is aborted mid-download (the instance is registered up-front so
// the worker has an id to install into, so a cancel must unwind both).
async function removeInstanceCompletely(instanceId) {
  const dir = instanceDir(instanceId);
  if (await fs.pathExists(dir)) await fs.remove(dir);
  const reg = await readProfileRegistry();
  reg.instances = reg.instances.filter(i => i.id !== instanceId);
  await writeProfileRegistry(reg);
}

// Returns the instance ID for a per-server launcher profile, creating it on
// first launch. Each MineDash server gets its own isolated client profile so
// switching between servers doesn't smash their mod lists together. The ID is
// derived from the server's stable `id`, not its (mutable) display name, so a
// later rename of the server doesn't orphan the instance.
async function ensureServerInstance(server) {
  const id = `server-${server.id}`;
  const reg = await readProfileRegistry();
  let inst = reg.instances.find(i => i.id === id);
  if (!inst) {
    inst = {
      id,
      loader: server.type,
      version: server.version,
      // Show the server name in the instance dropdown so the user can tell
      // which one's which. The serverInstance flag lets the UI render a small
      // badge / hide the rename / link back to the server view if it wants to.
      displayName: server.name,
      createdAt: Date.now(),
      serverInstance: true,
      serverId: server.id,
    };
    reg.instances.push(inst);
    await writeProfileRegistry(reg);
  } else {
    // Keep the displayName, loader and version in sync with the server config
    // so the dropdown doesn't lie after the user renames or upgrades the server.
    let changed = false;
    if (inst.displayName !== server.name) { inst.displayName = server.name; changed = true; }
    if (inst.loader !== server.type)      { inst.loader = server.type;      changed = true; }
    if (inst.version !== server.version)  { inst.version = server.version;  changed = true; }
    if (!inst.serverInstance)             { inst.serverInstance = true;     inst.serverId = server.id; changed = true; }
    if (changed) await writeProfileRegistry(reg);
  }
  return id;
}

// Returns an instance object, creating a default one if no instance exists for
// this loader+version yet. Used to give every legacy launch a registry entry.
async function ensureDefaultInstance(loader, version) {
  const id = defaultInstanceId(loader, version);
  const reg = await readProfileRegistry();
  let inst = reg.instances.find(i => i.id === id);
  if (!inst) {
    inst = {
      id,
      loader,
      version,
      displayName: 'Default',
      createdAt: Date.now(),
      isDefault: true,
    };
    reg.instances.push(inst);
    await writeProfileRegistry(reg);
  }
  return inst;
}

// On init, walk launcher-clients/ and make sure every existing `${loader}-${version}`
// directory has a registry entry. New, UUID-named directories aren't touched —
// they were created through the new instance API and already have an entry.
async function migrateProfileDirsToRegistry() {
  const root = clientsRoot();
  if (!await fs.pathExists(root)) return;
  const reg = await readProfileRegistry();
  const known = new Set(reg.instances.map(i => i.id));
  const dirs = await fs.readdir(root);
  let changed = false;
  for (const d of dirs) {
    if (known.has(d)) continue;
    const m = d.match(/^(vanilla|fabric|forge|neoforge)-(.+)$/);
    if (!m) continue; // Skip non-legacy dirs (probably UUIDs already in registry)
    reg.instances.push({
      id: d,
      loader: m[1],
      version: m[2],
      displayName: 'Default',
      createdAt: Date.now(),
      isDefault: true,
    });
    changed = true;
  }
  if (changed) await writeProfileRegistry(reg);
}

const DEFAULT_SETTINGS = {
  ramGb: 4,                  // heap size for the game JVM
  windowWidth: 925,
  windowHeight: 530,
  fullscreen: false,
  javaPath: '',              // '' = auto (uses backend's getJavaPath)
  afterLaunch: 'hide',       // 'hide' | 'keep' — what MineDash does after Minecraft launches
  showSnapshots: false,      // include snapshots in the vanilla version list
  onlyInstalled: false,      // (client-side filter, persisted here for convenience)
  elybySkins: true,          // show Ely.by skins for offline accounts (cosmetic, display-only)
  theme: 'dark',             // UI colour theme — 'system' | 'light' | 'dark' | 'oled'
  lastLoader: '',            // last loader the user launched — restores the Play form on reopen
  lastVersion: '',           // last version the user launched
  lastInstanceId: '',        // last instance ID launched — narrower than lastLoader+lastVersion when multiple instances exist
  onboardingComplete: false, // first-run guided tour — true once the user finishes or skips it
  quitOnGameClose: false,    // quit MineDash entirely once the game window closes
  preLaunchCommand: '',      // shell command run before the game launches (non-zero exit aborts)
  postExitCommand: '',       // shell command run after the game exits
  gameEnv: [],               // user-defined env vars injected into the game JVM — [{ name, value }]
  // Game time — per-instance playtime tracking (recorded in forkLaunchWorker).
  recordPlaytime: true,      // accumulate play time per instance
  showPlaytime: true,        // show each instance's play time in the UI
  showTotalPlaytime: true,   // show the combined play time across instances
  durationsInHours: false,   // render durations as "2.5h" instead of "2h 30m"
  // Console — when the in-app launch log opens automatically.
  consoleShowOnLaunch: false, // open the console when the game launches
  consoleShowOnCrash: true,   // open the console when the game crashes / fails to launch
  consoleHideOnExit: false,   // close the console when the game exits cleanly
  // Tweaks — point LWJGL at system native libraries instead of the bundled ones.
  useSystemGlfw: false,
  glfwPath: '',
  useSystemOpenal: false,
  openalPath: '',
};

// Keys an instance may override from the global launcher settings (Prism-style
// per-instance overrides). Mirrors the validation in PUT /api/launcher/settings,
// but per-instance: each is optional, and a null value clears the override so
// the instance falls back to the global value. `ram`/`java` stay first-class
// fields on the instance, so they're deliberately NOT in this list.
const OVERRIDABLE_KEYS = [
  'windowWidth', 'windowHeight', 'fullscreen',
  'afterLaunch', 'quitOnGameClose',
  'consoleShowOnLaunch', 'consoleShowOnCrash', 'consoleHideOnExit',
  'preLaunchCommand', 'postExitCommand', 'gameEnv',
  'useSystemGlfw', 'glfwPath', 'useSystemOpenal', 'openalPath',
];

// Validate one override value. { ok:false } means malformed → the caller 400s.
function sanitizeOverrideValue(key, v) {
  switch (key) {
    case 'windowWidth':  return (typeof v === 'number' && v >= 320) ? { ok: true, value: Math.round(v) } : { ok: false };
    case 'windowHeight': return (typeof v === 'number' && v >= 240) ? { ok: true, value: Math.round(v) } : { ok: false };
    case 'fullscreen':
    case 'quitOnGameClose':
    case 'consoleShowOnLaunch':
    case 'consoleShowOnCrash':
    case 'consoleHideOnExit':
    case 'useSystemGlfw':
    case 'useSystemOpenal':
      return (typeof v === 'boolean') ? { ok: true, value: v } : { ok: false };
    case 'afterLaunch':
      return (['hide', 'keep'].includes(v)) ? { ok: true, value: v } : { ok: false };
    case 'preLaunchCommand':
    case 'postExitCommand':
      return (typeof v === 'string') ? { ok: true, value: v.slice(0, 4000) } : { ok: false };
    case 'glfwPath':
    case 'openalPath':
      return (typeof v === 'string') ? { ok: true, value: v.trim().slice(0, 1000) } : { ok: false };
    case 'gameEnv':
      if (!Array.isArray(v)) return { ok: false };
      return { ok: true, value: v
        .filter(e => e && typeof e.name === 'string' && e.name.trim())
        .slice(0, 100)
        .map(e => ({ name: e.name.trim().slice(0, 200), value: (e.value == null ? '' : String(e.value)).slice(0, 2000) })) };
    default:
      return { ok: false };
  }
}

// Overlay an instance's overrides onto the global settings for a launch. Only
// keys the instance explicitly set win; everything else stays the global value.
function mergeInstanceOverrides(global, overrides) {
  if (!overrides || typeof overrides !== 'object') return global;
  const out = { ...global };
  for (const key of OVERRIDABLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(overrides, key) && overrides[key] !== undefined) {
      out[key] = overrides[key];
    }
  }
  return out;
}

async function readAccounts() {
  try { return await fs.readJson(accountsFile()); }
  catch { return { activeAccountId: null, accounts: [] }; }
}
async function writeAccounts(data) {
  await fs.ensureDir(DATA_DIR);
  await fs.writeJson(accountsFile(), data, { spaces: 2 });
}

async function readSettings() {
  try {
    const d = await fs.readJson(settingsFile());
    return { ...DEFAULT_SETTINGS, ...d };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
async function writeSettings(s) {
  await fs.ensureDir(DATA_DIR);
  await fs.writeJson(settingsFile(), s, { spaces: 2 });
}

function stripAccount(a) {
  // Display-only DTO. NEVER include tokens (mcToken / accessToken /
  // clientToken) — they stay server-side in launcher-accounts.json.
  return {
    id: a.id,
    type: a.type,
    username: a.username,
    uuid: a.uuid,
    ...(a.type === 'offline' && a.elybySkins ? { elybySkins: true } : {}),
    // Public Ely.by id (not a secret) — lets the head avatar key its URL to the
    // resolved skin so a head first shown as Steve refreshes once the id exists.
    ...(a.elybyUuid ? { elybyUuid: a.elybyUuid } : {}),
    ...(a.lastUsedAt ? { lastUsedAt: a.lastUsedAt } : {}),
  };
}

// Standard Java offline UUID derivation (md5 of "OfflinePlayer:<name>"
// with version=3 and variant=10 nibbles forced).
function offlineUuid(name) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const h = md5.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

// ─── Ely.by skins (no account / no login) ───────────────────────────────────
// We only use Ely.by's PUBLIC skin system. Offline accounts can opt in; we
// resolve their Ely.by UUID by username and launch with authlib-injector so the
// skin renders in-game on servers that support it. No password/token is ever
// involved — Ely.by serves skins publicly by name.

// Normalise an un-hyphenated 32-char id into a hyphenated UUID. Ely.by returns
// ids without dashes (e.g. "ffb3378c…"); mclc / the game expect the hyphenated
// form. Already-hyphenated (or non-32-char) ids pass through unchanged.
function hyphenateUuid(id) {
  if (!id) return id;
  const h = id.replace(/-/g, '');
  if (h.length !== 32) return id;
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

// Resolve the Ely.by UUID for a username via Ely.by's Mojang-compatible
// name→profile endpoint. Returns a hyphenated UUID, or null if no Ely.by
// account owns that name (HTTP 204) or on any error. Used so an offline launch
// can present the Ely.by UUID — that's what lets authlib-injector resolve the
// player's skin textures for other players in-game.
async function resolveElyByUuid(username) {
  try {
    const r = await fetch(`${ELYBY_AUTHSERVER}/api/users/profiles/minecraft/${encodeURIComponent(username)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status !== 200) return null; // 204 = no such Ely.by account
    const d = await r.json().catch(() => null);
    return d?.id ? hyphenateUuid(d.id) : null;
  } catch {
    return null;
  }
}

// The authlib-injector JVM args, prepended to the JVM arg list so the agent is
// registered first. We pass the FULL Ely.by API root (not the `ely.by`
// shorthand) — see ELYBY_API_ROOT for why the shorthand breaks when combined
// with prefetched metadata. `prefetchB64` (the base64 prefetched ALI metadata)
// is included when available so the game skips the startup metadata round-trip.
// noShowServerName suppresses the "[authlib-injector] Ely.by" prefix the agent
// otherwise prints in MOTDs.
function buildElyByAgentArgs({ jarPath, prefetchB64 }) {
  const args = [`-javaagent:${jarPath}=${ELYBY_API_ROOT}`];
  if (prefetchB64) args.push(`-Dauthlibinjector.yggdrasil.prefetched=${prefetchB64}`);
  args.push('-Dauthlibinjector.noShowServerName');
  return args;
}

// Hard guardrail (risk callout #1/#2): the authlib-injector agent must appear in
// the JVM args iff we intended it to. A stray -javaagent silently breaks a
// Microsoft / premium launch; a missing one means a skins launch silently won't
// show skins. `expectAgent` is computed once at the call site (offline + skins
// on). Throws loud on any mismatch.
function assertAgentArgsGate(expectAgent, customArgs) {
  const hasAgent = (customArgs || []).some(a => typeof a === 'string' && a.includes('-javaagent') && /authlib-injector/i.test(a));
  if (hasAgent !== !!expectAgent) {
    throw new Error(
      `Launch builder bug: authlib-injector agent ${hasAgent ? 'present' : 'absent'} ` +
      `but expected ${expectAgent ? 'present' : 'absent'}. Refusing to launch.`,
    );
  }
}

// ─── Player head avatars ────────────────────────────────────────────────────
// In-memory cache only — heads are tiny (a 32px PNG is ~1 KB) and re-fetching
// on a cold start is cheap, so there's no point persisting them to disk and
// dealing with cache invalidation. Keyed by `${type}:${username}:${uuid}:${size}`.
const skinCache = new Map();          // key -> { buf, at }
// 10 minutes, not an hour — this TTL is the longest a changed skin (uploaded
// on ely.by / Mojang) can stay stale in MineDash without the user hitting the
// per-account Refresh button, and heads are ~1 KB so re-resolving is cheap.
const SKIN_TTL_MS = 10 * 60 * 1000;
const SKIN_CACHE_MAX = 300;

// Drop every cached head for a username (all types/sizes/uuids). Backs the
// refresh-skin endpoint so "I just changed my skin on ely.by" has a one-click
// fix instead of a wait-for-TTL. Keys are `${type}:${username}:…` and
// usernames can't contain ':' (offline names are [A-Za-z0-9_], Mojang names
// likewise), so splitting on ':' is safe.
function skinCachePurgeUser(username) {
  const want = String(username || '').toLowerCase();
  let purged = 0;
  for (const key of Array.from(skinCache.keys())) {
    if ((key.split(':')[1] || '').toLowerCase() === want) {
      skinCache.delete(key);
      purged++;
    }
  }
  return purged;
}

function skinCacheGet(key) {
  const e = skinCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > SKIN_TTL_MS) { skinCache.delete(key); return null; }
  return e.buf;
}
function skinCacheSet(key, buf) {
  if (skinCache.size >= SKIN_CACHE_MAX) {
    // Drop the oldest entry — Map preserves insertion order.
    const oldest = skinCache.keys().next().value;
    if (oldest !== undefined) skinCache.delete(oldest);
  }
  skinCache.set(key, { buf, at: Date.now() });
}

// Crop the 8×8 head face out of a Minecraft skin PNG and composite the hat /
// overlay layer on top, scaling the result up to `size`×`size` with
// nearest-neighbour (so the pixels stay crisp). Works for both modern 64×64
// and legacy 64×32 skins — the head (8,8) and hat (40,8) regions live in the
// top 32 rows of both. Returns a PNG buffer.
function cropSkinHead(skinBuffer, size) {
  const png = PNG.sync.read(skinBuffer); // normalised to RGBA
  const W = png.width;
  const sampleAt = (sx, sy) => {
    const i = (sy * W + sx) << 2;
    return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
  };
  const out = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ox = Math.floor((x * 8) / size); // 0..7 within the 8×8 face
      const oy = Math.floor((y * 8) / size);
      let [r, g, b, a] = sampleAt(8 + ox, 8 + oy);             // base head face
      const [hr, hg, hb, ha] = sampleAt(40 + ox, 8 + oy);      // hat / hair overlay
      if (ha > 0) {                                            // alpha-over composite
        const af = ha / 255;
        r = Math.round(hr * af + r * (1 - af));
        g = Math.round(hg * af + g * (1 - af));
        b = Math.round(hb * af + b * (1 - af));
        a = Math.max(a, ha);
      }
      const o = (y * size + x) << 2;
      out.data[o] = r; out.data[o + 1] = g; out.data[o + 2] = b; out.data[o + 3] = a || 255;
    }
  }
  return PNG.sync.write(out);
}

// Last-resort placeholder: a flat brand-muted square, generated in-process so a
// head always renders even if mc-heads and Ely.by are both unreachable.
function flatHead(size) {
  const out = new PNG({ width: size, height: size });
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 0x2D; out.data[i + 1] = 0x2D; out.data[i + 2] = 0x2D; out.data[i + 3] = 0xFF;
  }
  return PNG.sync.write(out);
}

// Steve fallback — proxy mc-heads' well-known MHF_Steve head at the requested
// size, falling back to the flat placeholder if that's unreachable too.
async function steveHead(size) {
  try {
    const r = await fetch(`https://mc-heads.net/avatar/MHF_Steve/${size}`);
    if (r.ok) return Buffer.from(await r.arrayBuffer());
  } catch {}
  return flatHead(size);
}

// Resolve the raw skin-texture URL for an Ely.by profile via the authlib
// sessionserver profile endpoint — the SAME source the in-game launch uses.
// We go through the UUID-keyed profile (not the username-keyed /skins/{name}
// route) on purpose: Ely.by's /skins route is CASE-SENSITIVE on the canonical
// name, so an offline account stored as "dream" 404s even though "Dream" owns a
// skin; the profile lookup is case-insensitive and always matches in-game.
// Returns the skin PNG URL, or null on any miss.
async function elyBySkinUrl({ elybyUuid, username }) {
  let id = elybyUuid || (username ? await resolveElyByUuid(username) : null);
  if (!id) return null;
  id = String(id).replace(/-/g, ''); // Ely.by's profile route wants the bare 32-char id
  const r = await fetch(`${ELYBY_API_ROOT}/sessionserver/session/minecraft/profile/${id}`);
  if (r.status !== 200) return null;
  const profile = await r.json();
  const tex = (profile.properties || []).find(p => p.name === 'textures');
  if (!tex?.value) return null;
  const decoded = JSON.parse(Buffer.from(tex.value, 'base64').toString('utf8'));
  return decoded?.textures?.SKIN?.url || null;
}

// Resolve a head avatar for an account by (type, username, uuid). Resolution
// order mirrors the launcher's account model:
//   microsoft → mc-heads avatar by Mojang UUID (already a rendered head)
//   offline   → crop the Ely.by skin IFF this account has Ely.by skins enabled
//   anything else / failure → Steve placeholder
// Never throws — on any error it degrades to Steve so the <img> never breaks.
async function resolveHead({ type, username, uuid, size, elybySkins, elybyUuid }) {
  try {
    if (type === 'microsoft' && uuid) {
      const r = await fetch(`https://mc-heads.net/avatar/${encodeURIComponent(uuid)}/${size}`);
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      return steveHead(size);
    }
    if (type === 'offline' && elybySkins && username) {
      const skinUrl = await elyBySkinUrl({ elybyUuid, username });
      if (skinUrl) {
        const r = await fetch(skinUrl);
        if (r.ok) {
          const skin = Buffer.from(await r.arrayBuffer());
          return cropSkinHead(skin, size);
        }
      }
      // No Ely.by skin for this name; fall through to Steve.
    }
  } catch {}
  return steveHead(size);
}

// Endpoint helper — given an :loader/:version route plus optional ?instance=ID,
// returns the profile directory to operate on. If ?instance is omitted the
// default instance for that loader+version is used (and created on first hit).
async function resolveProfileDir({ loader, version, instanceId }) {
  if (instanceId) {
    const inst = await getInstance(instanceId);
    if (!inst) throw Object.assign(new Error('Unknown instance ID'), { status: 404 });
    if (inst.loader !== loader || inst.version !== version) {
      throw Object.assign(new Error(`Instance ${instanceId} is ${inst.loader} ${inst.version}, not ${loader} ${version}`), { status: 400 });
    }
    return instanceDir(inst.id);
  }
  const inst = await ensureDefaultInstance(loader, version);
  return instanceDir(inst.id);
}

// ─── Routes ─────────────────────────────────────────────────────────
// Resolve a single child name inside a directory, rejecting separators and
// dot-walks so a crafted world/screenshot name can't escape the instance
// folder. Returns the absolute path, or null when the name is unsafe.
function safeChildPath(baseDir, name) {
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..'
      || name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  const p = path.join(baseDir, name);
  if (!path.resolve(p).startsWith(path.resolve(baseDir) + path.sep)) return null;
  return p;
}

// Recursive on-disk size of a directory. Worlds can hold thousands of region
// files, so this walks iteratively and swallows per-entry races (chunks being
// written while the game runs).
async function dirSizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries = [];
    try { entries = await fs.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      try {
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) total += (await fs.stat(p)).size;
      } catch {}
    }
  }
  return total;
}

// Figure out the loader version an instance actually has installed, for the
// .mrpack `dependencies` block. Primary source is the profile's versions/
// folder (written by the Fabric/NeoForge installers on first launch); Forge
// and Fabric fall back to their public meta APIs when the folder isn't there.
async function detectLoaderVersion(profileRoot, loader, mcVersion) {
  let entries = [];
  try { entries = await fs.readdir(path.join(profileRoot, 'versions')); } catch {}
  if (loader === 'fabric') {
    for (const e of entries) {
      const m = e.match(/^fabric-loader-([\d.]+)/);
      if (m) return m[1];
    }
    try {
      const r = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`);
      if (r.ok) {
        const d = await r.json();
        const stable = (d || []).find(x => x?.loader?.stable) || (d || [])[0];
        if (stable?.loader?.version) return stable.loader.version;
      }
    } catch {}
  } else if (loader === 'neoforge') {
    for (const e of entries) {
      const m = e.match(/^neoforge-(.+)$/);
      if (m) return m[1];
    }
  } else if (loader === 'forge') {
    for (const e of entries) {
      const m = e.match(/forge-([\d.]+)$/);
      if (m) return m[1];
    }
    try {
      const r = await fetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
      if (r.ok) {
        const d = await r.json();
        const v = d?.promos?.[`${mcVersion}-recommended`] || d?.promos?.[`${mcVersion}-latest`];
        if (v) return v;
      }
    } catch {}
  }
  return null;
}

// Map MineDash loader names to the dependency keys the Modrinth pack format
// expects in modrinth.index.json.
const MRPACK_LOADER_KEY = { fabric: 'fabric-loader', forge: 'forge', neoforge: 'neoforge' };

function register(app) {
  // ── Instance management ──────────────────────────────────────────
  // First-class instances — every profile is identified by its `id`. Multiple
  // instances can share the same loader+version, each with its own mods/configs.
  app.get('/api/launcher/instances', async (req, res) => {
    const reg = await readProfileRegistry();
    // Enrich modpack-source instances with their currently-installed pack
    // version. Lets the frontend compare against Modrinth's latest and offer
    // an "Update to vX.Y.Z" CTA without a per-instance roundtrip just to
    // figure out the local version. Cheap on warm boot since the file is
    // ~few KB and we only read it for browse-modpack instances.
    const enriched = await Promise.all(reg.instances.map(async (inst) => {
      if (inst.source !== 'browse-modpack' || !inst.modpackProjectId) return inst;
      try {
        const rec = await fs.readJson(path.join(instanceDir(inst.id), '.minedash-modpacks.json'));
        const entry = Object.values(rec || {}).find(e => e && e.projectId === inst.modpackProjectId);
        if (!entry) return inst;
        return {
          ...inst,
          currentModpackVersionId:     entry.versionId     || null,
          currentModpackVersionNumber: entry.versionNumber || null,
        };
      } catch {
        return inst;
      }
    }));
    res.json(enriched);
  });

  app.post('/api/launcher/instances', async (req, res) => {
    const { loader, version, displayName } = req.body || {};
    if (!LOADERS.includes(loader)) return res.status(400).json({ error: 'Invalid loader' });
    if (!version || typeof version !== 'string') return res.status(400).json({ error: 'Invalid version' });
    const name = (displayName && typeof displayName === 'string' ? displayName.trim() : '') || `${loader} ${version}`;
    if (name.length > 60) return res.status(400).json({ error: 'displayName too long (max 60 chars)' });

    const id = crypto.randomUUID();
    const inst = { id, loader, version, displayName: name, createdAt: Date.now() };
    const reg = await readProfileRegistry();
    reg.instances.push(inst);
    await writeProfileRegistry(reg);
    res.json(inst);
  });

  app.patch('/api/launcher/instances/:id', async (req, res) => {
    const { id } = req.params;
    const body = req.body || {};
    const { displayName, java } = body;
    const hasRam = Object.prototype.hasOwnProperty.call(body, 'ram');
    const hasOverrides = Object.prototype.hasOwnProperty.call(body, 'overrides');
    if (typeof displayName !== 'string' && typeof java !== 'string' && !hasRam && !hasOverrides) {
      return res.status(400).json({ error: 'Nothing to update — pass displayName, java, ram and/or overrides' });
    }
    let name = null;
    if (typeof displayName === 'string') {
      name = displayName.trim();
      if (!name) return res.status(400).json({ error: 'displayName cannot be empty' });
      if (name.length > 60) return res.status(400).json({ error: 'displayName too long' });
    }
    // Per-instance heap override. A number (GB) pins this instance's -Xmx/-Xms;
    // null (or 0) clears it so the instance inherits the global ramGb setting.
    let ramChoice; // undefined = no change
    if (hasRam) {
      const { ram } = body;
      if (ram === null || ram === 0) {
        ramChoice = null;
      } else if (typeof ram === 'number' && ram >= 1 && ram <= 64) {
        ramChoice = Math.round(ram);
      } else {
        return res.status(400).json({ error: 'ram must be a number between 1 and 64 (GB), or null to inherit the global default' });
      }
    }
    // Java choice: '' (inherit global setting), 'auto', 'jdk-<major>' (managed
    // pool — downloaded on demand at launch), or an absolute java(.exe) path.
    let javaChoice = null;
    if (typeof java === 'string') {
      javaChoice = java.trim();
      if (javaChoice.length > 400) return res.status(400).json({ error: 'java path too long' });
      const isKeyword = javaChoice === '' || javaChoice === 'auto' || /^jdk-\d+$/.test(javaChoice);
      if (!isKeyword && !path.isAbsolute(javaChoice)) {
        return res.status(400).json({ error: "java must be 'auto', 'jdk-<major>', or an absolute path" });
      }
    }

    // Per-instance setting overrides — a partial map of OVERRIDABLE_KEYS. A null
    // value (or a null `overrides` object) clears the override(s) so the
    // instance reverts to the global setting. Unknown keys are ignored;
    // malformed values 400.
    let overrideSet = null;   // keys → sanitised value
    let overrideUnset = null; // keys to delete
    if (hasOverrides) {
      const incoming = body.overrides;
      if (incoming === null) {
        overrideUnset = [...OVERRIDABLE_KEYS];
      } else if (typeof incoming === 'object' && !Array.isArray(incoming)) {
        overrideSet = {};
        overrideUnset = [];
        for (const [key, val] of Object.entries(incoming)) {
          if (!OVERRIDABLE_KEYS.includes(key)) continue;
          if (val === null) { overrideUnset.push(key); continue; }
          const r = sanitizeOverrideValue(key, val);
          if (!r.ok) return res.status(400).json({ error: `Invalid override value for "${key}"` });
          overrideSet[key] = r.value;
        }
      } else {
        return res.status(400).json({ error: 'overrides must be an object or null' });
      }
    }

    const reg = await readProfileRegistry();
    const inst = reg.instances.find(i => i.id === id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    if (name !== null) inst.displayName = name;
    if (javaChoice !== null) {
      if (javaChoice === '') delete inst.java;
      else inst.java = javaChoice;
    }
    if (ramChoice !== undefined) {
      if (ramChoice === null) delete inst.ram;
      else inst.ram = ramChoice;
    }
    if (overrideSet || overrideUnset) {
      const cur = (inst.overrides && typeof inst.overrides === 'object') ? { ...inst.overrides } : {};
      if (overrideUnset) for (const k of overrideUnset) delete cur[k];
      if (overrideSet) Object.assign(cur, overrideSet);
      if (Object.keys(cur).length === 0) delete inst.overrides;
      else inst.overrides = cur;
    }
    await writeProfileRegistry(reg);
    res.json(inst);
  });

  // Java pool overview for the launcher settings UI: what's installed in the
  // managed pool, what the system Java is, and (when ?version= is supplied)
  // which major that MC version needs — so the picker can mark the match.
  app.get('/api/launcher/java', async (req, res) => {
    const version = typeof req.query.version === 'string' ? req.query.version : null;
    const sysPath = (getJavaPath ? getJavaPath() : null) || null;
    const sysMajor = sysPath && sysPath !== 'java' ? javaPool.getJavaVersionForPath(sysPath) : null;
    res.json({
      managed: javaPool.listManagedJavas(),
      system: sysPath && sysPath !== 'java' ? { path: sysPath, major: sysMajor } : null,
      required: version ? await mojangRequiredJavaMajor(version) : null,
      // Majors worth offering in a manual picker — every bucket MC has ever
      // needed. Anything not in `managed` will download on first use.
      knownMajors: [8, 16, 17, 21, 25],
    });
  });

  app.delete('/api/launcher/instances/:id', async (req, res) => {
    const { id } = req.params;
    const reg = await readProfileRegistry();
    const inst = reg.instances.find(i => i.id === id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });

    // Refuse if the game is currently running from this profile — otherwise
    // the rmdir would fail mid-way on Windows (locked JARs) and we'd be left
    // with a half-deleted folder + a missing registry entry.
    for (const [, client] of activeLaunches) {
      try {
        if (client && client.options && client.options.root === instanceDir(id)) {
          return res.status(409).json({ error: 'This instance is currently running. Close Minecraft first.' });
        }
      } catch {}
    }

    // Allow deleting any instance, including defaults. If the user wipes the
    // default, ensureDefaultInstance() will recreate a fresh one on the next
    // launch (with empty mods/ etc.) — same effect as DELETE /profiles/:l/:v.
    const dir = instanceDir(id);
    try {
      if (await fs.pathExists(dir)) await fs.remove(dir);
    } catch (err) {
      // Don't update the registry if the on-disk dir couldn't be removed —
      // otherwise migrateProfileDirsToRegistry would re-add an entry for the
      // orphaned folder on the next startup and "deletion" would silently undo.
      return res.status(500).json({ error: `Could not remove profile folder: ${err.message}. Close any program holding files in it (Minecraft, file explorer, antivirus) and try again.` });
    }
    reg.instances = reg.instances.filter(i => i.id !== id);
    await writeProfileRegistry(reg);
    res.json({ ok: true });
  });

  // Open the on-disk profile folder for an instance in the OS file explorer.
  // Resolves the instance ID first so we don't accidentally let a malicious
  // payload pass a `..`-laced path through to explorer. If the directory
  // doesn't exist yet (instance was created but never launched), create it
  // so the user always lands on a real folder instead of a "not found" error.
  // Update a browse-installed modpack instance to a newer revision.
  // Body: { versionId? } — if omitted, picks the latest release for this
  // modpack project. Fetches the new .mrpack, diffs against the previous
  // revision's tracked file list, removes the gone files, installs the new
  // ones. Returns { sessionId } so the frontend can hook the existing
  // modpackInstalls progress tracker and surface a Toast.
  app.post('/api/launcher/instances/:id/modpack/update', async (req, res) => {
    const { id } = req.params;
    const { versionId } = req.body || {};

    const reg = await readProfileRegistry();
    const inst = reg.instances.find(i => i.id === id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    if (inst.source !== 'browse-modpack' || !inst.modpackProjectId) {
      return res.status(400).json({ error: 'Only browse-installed modpacks can be updated this way.' });
    }

    // Pick the target version. If the caller didn't specify, use the latest
    // release-shaped version compatible with this instance's loader.
    let chosen;
    try {
      const vUrl = `${MODRINTH_API}/project/${encodeURIComponent(inst.modpackProjectId)}/version`;
      const vRes = await fetch(vUrl, { headers: MODRINTH_HEADERS });
      if (!vRes.ok) return res.status(502).json({ error: `Modrinth /version returned ${vRes.status}` });
      const versions = await vRes.json();
      if (!Array.isArray(versions) || versions.length === 0) {
        return res.status(404).json({ error: 'No versions found for this project' });
      }
      chosen = versionId ? versions.find(v => v.id === versionId) : null;
      if (!chosen) chosen = pickBestModrinthVersion(versions);
      if (!chosen) return res.status(404).json({ error: 'Could not pick a version' });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Failed to resolve version' });
    }

    const file = (chosen.files || []).find(f => f.primary) || (chosen.files || [])[0];
    if (!file || !file.url) return res.status(400).json({ error: 'Modpack version has no downloadable file' });

    // Load previous tracked files so the installer can prune what's gone.
    let previousFiles = [];
    let previousIconUrl = inst.iconUrl || null;
    let previousTitle = inst.displayName;
    try {
      const rec = await fs.readJson(path.join(instanceDir(id), '.minedash-modpacks.json'));
      const prev = Object.values(rec || {}).find(e => e && e.projectId === inst.modpackProjectId);
      if (prev) {
        previousFiles = Array.isArray(prev.files) ? prev.files : [];
        previousIconUrl = prev.iconUrl || previousIconUrl;
        previousTitle = prev.title || previousTitle;
      }
    } catch {}

    const profileDir = instanceDir(id);
    const sessionId = crypto.randomUUID();
    const cancelToken = { cancelled: false };
    activeModpackInstalls.set(sessionId, { token: cancelToken });

    res.json({ ok: true, sessionId, versionId: chosen.id, versionNumber: chosen.version_number });

    installModpackIntoProfile({
      sessionId,
      profileDir,
      url: file.url,
      filename: file.filename || `${inst.modpackProjectId}.mrpack`,
      projectId: inst.modpackProjectId,
      iconUrl: previousIconUrl,
      title: previousTitle,
      versionId: chosen.id || null,
      versionNumber: chosen.version_number || null,
      previousFiles,
      cancelToken,
    })
      .then(summary => { activeModpackInstalls.delete(sessionId); emitModpack(sessionId, 'done', summary); })
      .catch(err => {
        activeModpackInstalls.delete(sessionId);
        if (err && err.cancelled) emitModpack(sessionId, 'cancelled', {});
        else emitModpack(sessionId, 'error', { message: err.message || String(err) });
      });
  });

  app.post('/api/launcher/instances/:id/open-folder', async (req, res) => {
    const { id } = req.params;
    const inst = await getInstance(id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    const dir = instanceDir(inst.id);
    try { await fs.ensureDir(dir); } catch {}
    const cmd = process.platform === 'win32'
      ? `explorer "${dir}"`
      : process.platform === 'darwin'
        ? `open "${dir}"`
        : `xdg-open "${dir}"`;
    exec(cmd);
    res.json({ ok: true, path: dir });
  });

  // ── Logs & crash reports ─────────────────────────────────────────
  // Surface the game's own logs/ and crash-reports/ for an instance so the
  // user can diagnose a failed launch or crash from inside MineDash instead of
  // digging through AppData. List endpoint returns metadata only (cheap); the
  // file endpoint streams a single file's text, tail-capped so a multi-MB
  // latest.log never balloons the response.
  const LOG_TAIL_BYTES = 512 * 1024; // ~last 512 KB is plenty for diagnosis

  app.get('/api/launcher/instances/:id/logs', async (req, res) => {
    const inst = await getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    const root = instanceDir(inst.id);
    const collect = async (sub, kind, exts) => {
      const dir = path.join(root, sub);
      let names = [];
      try { names = await fs.readdir(dir); } catch { return []; }
      const out = [];
      for (const name of names) {
        if (!exts.some(e => name.toLowerCase().endsWith(e))) continue;
        const p = safeChildPath(dir, name);
        if (!p) continue;
        try {
          const st = await fs.stat(p);
          if (!st.isFile()) continue;
          out.push({ name, kind, sizeBytes: st.size, mtime: st.mtimeMs });
        } catch {}
      }
      return out;
    };
    const logs = await collect('logs', 'log', ['.log', '.log.gz', '.txt']);
    const crashes = await collect('crash-reports', 'crash', ['.txt', '.log']);
    // latest.log first, then newest logs, then crash reports (newest first).
    logs.sort((a, b) => {
      if (a.name === 'latest.log') return -1;
      if (b.name === 'latest.log') return 1;
      return b.mtime - a.mtime;
    });
    crashes.sort((a, b) => b.mtime - a.mtime);
    res.json({ files: [...logs, ...crashes] });
  });

  app.get('/api/launcher/instances/:id/logs/file', async (req, res) => {
    const inst = await getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    const kind = req.query.kind === 'crash' ? 'crash-reports' : 'logs';
    const p = safeChildPath(path.join(instanceDir(inst.id), kind), String(req.query.name || ''));
    if (!p) return res.status(400).json({ error: 'Invalid log name' });
    // .gz logs (Minecraft rotates older ones) aren't human-readable as text —
    // we only serve plain .log/.txt; the list still shows .gz so the user knows
    // they exist on disk.
    if (p.toLowerCase().endsWith('.gz')) {
      return res.status(415).json({ error: 'This log is gzip-compressed. Open the folder to read it.' });
    }
    let st;
    try {
      st = await fs.stat(p);
      if (!st.isFile()) return res.status(404).json({ error: 'Log not found' });
    } catch {
      return res.status(404).json({ error: 'Log not found' });
    }
    const start = Math.max(0, st.size - LOG_TAIL_BYTES);
    const truncated = start > 0;
    // Stream just the tail so a multi-MB latest.log never lands wholesale in
    // memory. Collect into a buffer (the tail is bounded at LOG_TAIL_BYTES).
    const chunks = [];
    const stream = fs.createReadStream(p, { start });
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Could not read log' });
    });
    stream.on('end', () => {
      if (res.headersSent) return;
      res.json({
        name: path.basename(p),
        sizeBytes: st.size,
        truncated,
        content: Buffer.concat(chunks).toString('utf8'),
      });
    });
  });

  // ── Worlds (client-side saves) ───────────────────────────────────
  // List the singleplayer worlds in an instance's saves/ folder. A directory
  // counts as a world iff it has a level.dat — stray folders are skipped.
  app.get('/api/launcher/instances/:id/worlds', async (req, res) => {
    const inst = await getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    const savesDir = path.join(instanceDir(inst.id), 'saves');
    let entries = [];
    try { entries = await fs.readdir(savesDir); } catch { return res.json([]); }
    const out = [];
    for (const name of entries) {
      const dir = safeChildPath(savesDir, name);
      if (!dir) continue;
      try {
        if (!(await fs.stat(dir)).isDirectory()) continue;
        const levelPath = path.join(dir, 'level.dat');
        const levelStat = await fs.stat(levelPath).catch(() => null);
        if (!levelStat) continue;
        // Best-effort level.dat parse for game mode / seed / the in-file
        // LastPlayed. A corrupt or locked level.dat (game running) just leaves
        // these null — the world still lists, falling back to the file mtime.
        let summary = {};
        try { summary = nbtLite.summarizeLevelDat(await fs.readFile(levelPath)); } catch {}
        out.push({
          name,
          sizeBytes: await dirSizeBytes(dir),
          lastPlayed: typeof summary.lastPlayed === 'number' && summary.lastPlayed > 0
            ? summary.lastPlayed
            : levelStat.mtimeMs,
          hasIcon: await fs.pathExists(path.join(dir, 'icon.png')),
          gameMode: typeof summary.gameMode === 'number' ? summary.gameMode : null,
          seed: summary.seed || null,
          levelName: summary.levelName || null,
        });
      } catch {}
    }
    out.sort((a, b) => b.lastPlayed - a.lastPlayed);
    res.json(out);
  });

  // World thumbnail — the 64×64 icon.png Minecraft writes on first save.
  app.get('/api/launcher/instances/:id/worlds/:name/icon', async (req, res) => {
    const inst = await getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    const dir = safeChildPath(path.join(instanceDir(inst.id), 'saves'), req.params.name);
    if (!dir) return res.status(400).json({ error: 'Invalid world name' });
    const icon = path.join(dir, 'icon.png');
    if (!await fs.pathExists(icon)) return res.status(404).json({ error: 'No icon' });
    res.sendFile(icon);
  });

  // Duplicate a world in place ("<name> copy", "<name> copy 2", …). Skips
  // session.lock so the copy never carries a stale lock from a running game.
  app.post('/api/launcher/instances/:id/worlds/:name/duplicate', async (req, res) => {
    const inst = await getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    const savesDir = path.join(instanceDir(inst.id), 'saves');
    const src = safeChildPath(savesDir, req.params.name);
    if (!src || !await fs.pathExists(src)) return res.status(404).json({ error: 'World not found' });

    let copyName = `${req.params.name} copy`;
    for (let n = 2; await fs.pathExists(path.join(savesDir, copyName)); n++) {
      copyName = `${req.params.name} copy ${n}`;
    }
    try {
      await fs.copy(src, path.join(savesDir, copyName), {
        filter: (p) => path.basename(p) !== 'session.lock',
      });
    } catch (err) {
      return res.status(500).json({ error: `Copy failed: ${err.message}` });
    }
    res.json({ ok: true, name: copyName });
  });

  app.delete('/api/launcher/instances/:id/worlds/:name', async (req, res) => {
    const inst = await getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    const dir = safeChildPath(path.join(instanceDir(inst.id), 'saves'), req.params.name);
    if (!dir || !await fs.pathExists(dir)) return res.status(404).json({ error: 'World not found' });
    try {
      await fs.remove(dir);
    } catch (err) {
      return res.status(500).json({ error: `Delete failed: ${err.message}. If the game is running, close it first.` });
    }
    res.json({ ok: true });
  });

  // Rename a world folder. The folder name is what Minecraft lists; the in-file
  // LevelName is cosmetic and left untouched (Prism behaves the same — renaming
  // the folder is enough). Guards both ends against traversal, refuses to
  // clobber an existing world, and surfaces a friendly error if the game holds a
  // lock on the folder.
  app.post('/api/launcher/instances/:id/worlds/:name/rename', async (req, res) => {
    const inst = await getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    const savesDir = path.join(instanceDir(inst.id), 'saves');
    const src = safeChildPath(savesDir, req.params.name);
    if (!src || !await fs.pathExists(src)) return res.status(404).json({ error: 'World not found' });

    const newName = typeof req.body?.newName === 'string' ? req.body.newName.trim() : '';
    if (!newName) return res.status(400).json({ error: 'newName is required' });
    if (newName.length > 120) return res.status(400).json({ error: 'newName too long' });
    const dest = safeChildPath(savesDir, newName);
    if (!dest) return res.status(400).json({ error: 'Invalid world name (no slashes or special path characters)' });
    if (path.resolve(dest) === path.resolve(src)) return res.json({ ok: true, name: newName });
    if (await fs.pathExists(dest)) return res.status(409).json({ error: `A world named "${newName}" already exists.` });
    try {
      await fs.move(src, dest);
    } catch (err) {
      return res.status(500).json({ error: `Rename failed: ${err.message}. If the game is running, close it first.` });
    }
    res.json({ ok: true, name: newName });
  });

  // Open a world's datapacks folder (Worlds → Data Packs) in the OS file
  // explorer, creating saves/<name>/datapacks first so the user always lands on
  // a real folder. Per-world datapacks are the Minecraft-native location (the
  // profile-level datapacks/ folder is separate).
  app.post('/api/launcher/instances/:id/worlds/:name/open-datapacks', async (req, res) => {
    const inst = await getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    const worldDir = safeChildPath(path.join(instanceDir(inst.id), 'saves'), req.params.name);
    if (!worldDir || !await fs.pathExists(worldDir)) return res.status(404).json({ error: 'World not found' });
    const dpDir = path.join(worldDir, 'datapacks');
    try { await fs.ensureDir(dpDir); } catch {}
    const cmd = process.platform === 'win32'
      ? `explorer "${dpDir}"`
      : process.platform === 'darwin' ? `open "${dpDir}"` : `xdg-open "${dpDir}"`;
    exec(cmd);
    res.json({ ok: true, path: dpDir });
  });

  // Reset a world's icon — delete icon.png so Minecraft regenerates it from the
  // spawn view on the next load. No-op (still 200) if there's no icon.
  app.delete('/api/launcher/instances/:id/worlds/:name/icon', async (req, res) => {
    const inst = await getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    const dir = safeChildPath(path.join(instanceDir(inst.id), 'saves'), req.params.name);
    if (!dir || !await fs.pathExists(dir)) return res.status(404).json({ error: 'World not found' });
    try {
      const icon = path.join(dir, 'icon.png');
      if (await fs.pathExists(icon)) await fs.remove(icon);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: `Could not reset icon: ${err.message}` });
    }
  });

  // Import a world from a .zip (Worlds → Add). Accepts a zip whose level.dat is
  // either at the root or one folder deep, extracts it into saves/ under a
  // unique name, and skips session.lock so an imported copy never carries a
  // stale lock.
  const worldImportUpload = multer({
    dest: path.join(require('os').tmpdir(), 'minedash-world-imports'),
    limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // worlds can be large
  });
  app.post('/api/launcher/instances/:id/worlds/import', worldImportUpload.single('file'), async (req, res) => {
    const inst = await getInstance(req.params.id);
    if (!inst) {
      if (req.file) await fs.remove(req.file.path).catch(() => {});
      return res.status(404).json({ error: 'Instance not found' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!/\.zip$/i.test(req.file.originalname || '')) {
      await fs.remove(req.file.path).catch(() => {});
      return res.status(400).json({ error: 'World imports must be .zip files' });
    }

    const tmpExtract = `${req.file.path}-extracted`;
    try {
      const AdmZip = require('adm-zip');
      new AdmZip(req.file.path).extractAllTo(tmpExtract, true);

      // Locate the world root: either the extract dir itself (level.dat at zip
      // root) or a single subfolder containing level.dat.
      let worldRoot = null;
      let baseName = (req.file.originalname || 'world').replace(/\.zip$/i, '').trim() || 'world';
      if (await fs.pathExists(path.join(tmpExtract, 'level.dat'))) {
        worldRoot = tmpExtract;
      } else {
        for (const entry of await fs.readdir(tmpExtract)) {
          const sub = path.join(tmpExtract, entry);
          if ((await fs.stat(sub)).isDirectory() && await fs.pathExists(path.join(sub, 'level.dat'))) {
            worldRoot = sub;
            baseName = entry;
            break;
          }
        }
      }
      if (!worldRoot) {
        return res.status(400).json({ error: 'No level.dat found in the zip — that doesn\'t look like a Minecraft world.' });
      }

      const savesDir = path.join(instanceDir(inst.id), 'saves');
      await fs.ensureDir(savesDir);
      // Sanitise the folder name (strip path separators) then de-dupe.
      let safeBase = baseName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100) || 'world';
      let target = safeBase;
      for (let n = 2; await fs.pathExists(path.join(savesDir, target)); n++) target = `${safeBase} (${n})`;
      // Drop any session.lock the zip carried so the import never starts locked
      // (fs.move has no copy-style filter, so strip it first).
      await fs.remove(path.join(worldRoot, 'session.lock')).catch(() => {});
      await fs.move(worldRoot, path.join(savesDir, target), { overwrite: false });
      res.json({ ok: true, name: target });
    } catch (err) {
      res.status(500).json({ error: `Import failed: ${err.message}` });
    } finally {
      await fs.remove(req.file.path).catch(() => {});
      await fs.remove(tmpExtract).catch(() => {});
    }
  });

  // Download a world as a zip. Streams via archiver so a multi-GB world never
  // has to fit in memory. session.lock is excluded for the same reason as
  // duplicate.
  app.get('/api/launcher/instances/:id/worlds/:name/export', async (req, res) => {
    const inst = await getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    const dir = safeChildPath(path.join(instanceDir(inst.id), 'saves'), req.params.name);
    if (!dir || !await fs.pathExists(dir)) return res.status(404).json({ error: 'World not found' });

    res.attachment(`${req.params.name}.zip`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => { try { res.destroy(err); } catch {} });
    // Region files mid-write while the game runs — skip rather than abort.
    archive.on('warning', () => {});
    archive.glob('**/*', { cwd: dir, ignore: ['session.lock'], dot: true }, { prefix: req.params.name });
    archive.pipe(res);
    archive.finalize();
  });

  // ── Screenshots ──────────────────────────────────────────────────
  app.get('/api/launcher/instances/:id/screenshots', async (req, res) => {
    const inst = await getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    const dir = path.join(instanceDir(inst.id), 'screenshots');
    let entries = [];
    try { entries = await fs.readdir(dir); } catch { return res.json([]); }
    const out = [];
    for (const f of entries) {
      if (!/\.(png|jpe?g)$/i.test(f)) continue;
      const p = safeChildPath(dir, f);
      if (!p) continue;
      try {
        const st = await fs.stat(p);
        if (st.isFile()) out.push({ filename: f, sizeBytes: st.size, takenAt: st.mtimeMs });
      } catch {}
    }
    out.sort((a, b) => b.takenAt - a.takenAt);
    res.json(out);
  });

  app.get('/api/launcher/instances/:id/screenshots/:filename/file', async (req, res) => {
    const inst = await getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    const p = safeChildPath(path.join(instanceDir(inst.id), 'screenshots'), req.params.filename);
    if (!p || !await fs.pathExists(p)) return res.status(404).json({ error: 'Screenshot not found' });
    res.sendFile(p);
  });

  app.delete('/api/launcher/instances/:id/screenshots/:filename', async (req, res) => {
    const inst = await getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    const p = safeChildPath(path.join(instanceDir(inst.id), 'screenshots'), req.params.filename);
    if (!p || !await fs.pathExists(p)) return res.status(404).json({ error: 'Screenshot not found' });
    try { await fs.remove(p); } catch (err) { return res.status(500).json({ error: err.message }); }
    res.json({ ok: true });
  });

  // ── Instance export (.mrpack) ────────────────────────────────────
  // Packages an instance in the Modrinth modpack format so it can be shared
  // and re-imported (by MineDash, Prism, ATLauncher, …). Content files that
  // Modrinth recognises (bulk sha1 lookup) become `files[]` entries pointing
  // at Modrinth's CDN; everything else — unknown jars, configs, options.txt,
  // servers.dat — ships inside overrides/.
  app.get('/api/launcher/instances/:id/export', async (req, res) => {
    const inst = await getInstance(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    const { loader, version } = inst;
    const profileRoot = instanceDir(inst.id);

    // Loader version for the dependencies block — required by the format for
    // modded packs, so a modded instance that can't resolve one is an error.
    const dependencies = { minecraft: version };
    if (MRPACK_LOADER_KEY[loader]) {
      const lv = await detectLoaderVersion(profileRoot, loader, version);
      if (!lv) {
        return res.status(409).json({
          error: `Couldn't determine the installed ${loader} version. Launch this instance once, then export again.`,
        });
      }
      dependencies[MRPACK_LOADER_KEY[loader]] = lv;
    }

    // Preflight for the UI: ?check=1 validates the only hard failure mode
    // (unresolvable loader version) without hashing/zipping anything, so the
    // frontend can show a real error instead of a broken download.
    if (req.query.check === '1') return res.json({ ok: true });

    // Hash every content file, then ask Modrinth which it knows in ONE bulk
    // call. Hits get canonical CDN URLs + sha512 from the matching version
    // file; misses are shipped as overrides.
    const CONTENT_SUBDIRS = ['mods', 'resourcepacks', 'shaderpacks', 'datapacks'];
    const candidates = []; // { rel (zip path, forward slashes), abs, sha1 }
    for (const sub of CONTENT_SUBDIRS) {
      const dir = path.join(profileRoot, sub);
      let files = [];
      try { files = await fs.readdir(dir); } catch { continue; }
      for (const f of files) {
        if (f.startsWith('.') || !/\.(jar|zip)$/i.test(f)) continue;
        const abs = path.join(dir, f);
        try {
          if (!(await fs.stat(abs)).isFile()) continue;
          candidates.push({ rel: `${sub}/${f}`, abs, sha1: await fileSha1(abs) });
        } catch {}
      }
    }

    const bySha1 = new Map(candidates.map(c => [c.sha1, c]));
    let known = {};
    if (bySha1.size > 0) {
      try {
        const r = await fetch(`${MODRINTH_API}/version_files`, {
          method: 'POST',
          headers: { ...MODRINTH_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ hashes: Array.from(bySha1.keys()), algorithm: 'sha1' }),
        });
        if (r.ok) known = await r.json();
      } catch {} // Modrinth down → everything exports as overrides, still valid
    }

    const indexFiles = [];
    const overrideFiles = []; // { abs, rel }
    for (const c of candidates) {
      const ver = known[c.sha1];
      const vf = ver && (ver.files || []).find(x => x?.hashes?.sha1 === c.sha1);
      if (vf && vf.url && vf.hashes?.sha512) {
        indexFiles.push({
          path: c.rel,
          hashes: { sha1: vf.hashes.sha1, sha512: vf.hashes.sha512 },
          downloads: [vf.url],
          fileSize: vf.size || (await fs.stat(c.abs)).size,
        });
      } else {
        overrideFiles.push({ abs: c.abs, rel: c.rel });
      }
    }

    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: '1.0.0',
      name: inst.displayName || `${loader} ${version}`,
      summary: 'Exported from MineDash',
      files: indexFiles,
      dependencies,
    };

    const safeName = (inst.displayName || `${loader}-${version}`).replace(/[\\/:*?"<>|]/g, '_').trim() || 'instance';
    res.attachment(`${safeName}.mrpack`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => { try { res.destroy(err); } catch {} });
    archive.on('warning', () => {});
    archive.pipe(res);
    archive.append(JSON.stringify(index, null, 2), { name: 'modrinth.index.json' });
    for (const o of overrideFiles) archive.file(o.abs, { name: `overrides/${o.rel}` });
    // Config + a couple of root-level files worth carrying. The rest of the
    // profile root (versions/, libraries/, assets/, saves/, logs/…) is either
    // reinstallable or personal and stays out of the pack.
    if (await fs.pathExists(path.join(profileRoot, 'config'))) {
      archive.directory(path.join(profileRoot, 'config'), 'overrides/config');
    }
    for (const rootFile of ['options.txt', 'servers.dat']) {
      const p = path.join(profileRoot, rootFile);
      if (await fs.pathExists(p)) archive.file(p, { name: `overrides/${rootFile}` });
    }
    archive.finalize();
  });

  // Same as above but resolves by loader+version (uses the default instance,
  // creating it if needed). Keeps the URL nice for callers that don't have an
  // instance ID handy — e.g. the per-server Play button shares a profile via
  // loader+version conventions.
  app.post('/api/launcher/profiles/:loader/:version/open-folder', async (req, res) => {
    const { loader, version } = req.params;
    const instanceId = req.query.instance || null;
    if (!LOADERS.includes(loader)) return res.status(400).json({ error: 'Invalid loader' });
    let profileDir;
    try { profileDir = await resolveProfileDir({ loader, version, instanceId }); }
    catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
    try { await fs.ensureDir(profileDir); } catch {}
    const cmd = process.platform === 'win32'
      ? `explorer "${profileDir}"`
      : process.platform === 'darwin'
        ? `open "${profileDir}"`
        : `xdg-open "${profileDir}"`;
    exec(cmd);
    res.json({ ok: true, path: profileDir });
  });

  app.get('/api/launcher/settings', async (req, res) => {
    res.json(await readSettings());
  });

  app.put('/api/launcher/settings', async (req, res) => {
    const incoming = req.body || {};
    const current = await readSettings();
    const next = { ...current };

    // Sanitise each field — never trust the wire.
    if (typeof incoming.ramGb === 'number' && incoming.ramGb >= 1 && incoming.ramGb <= 64) next.ramGb = Math.round(incoming.ramGb);
    if (typeof incoming.windowWidth === 'number' && incoming.windowWidth >= 320) next.windowWidth = Math.round(incoming.windowWidth);
    if (typeof incoming.windowHeight === 'number' && incoming.windowHeight >= 240) next.windowHeight = Math.round(incoming.windowHeight);
    if (typeof incoming.fullscreen === 'boolean') next.fullscreen = incoming.fullscreen;
    if (typeof incoming.javaPath === 'string') next.javaPath = incoming.javaPath.trim();
    if (['hide', 'keep'].includes(incoming.afterLaunch)) next.afterLaunch = incoming.afterLaunch;
    if (typeof incoming.showSnapshots === 'boolean') next.showSnapshots = incoming.showSnapshots;
    if (typeof incoming.onlyInstalled === 'boolean') next.onlyInstalled = incoming.onlyInstalled;
    if (typeof incoming.elybySkins === 'boolean') next.elybySkins = incoming.elybySkins;
    if (typeof incoming.lastLoader === 'string' && ['vanilla','fabric','forge','neoforge',''].includes(incoming.lastLoader)) next.lastLoader = incoming.lastLoader;
    if (typeof incoming.lastVersion === 'string') next.lastVersion = incoming.lastVersion.trim();
    if (typeof incoming.lastInstanceId === 'string') next.lastInstanceId = incoming.lastInstanceId.trim();
    if (typeof incoming.onboardingComplete === 'boolean') next.onboardingComplete = incoming.onboardingComplete;
    if (['system', 'light', 'dark', 'oled'].includes(incoming.theme)) next.theme = incoming.theme;
    if (typeof incoming.quitOnGameClose === 'boolean') next.quitOnGameClose = incoming.quitOnGameClose;
    if (typeof incoming.preLaunchCommand === 'string') next.preLaunchCommand = incoming.preLaunchCommand.slice(0, 4000);
    if (typeof incoming.postExitCommand === 'string') next.postExitCommand = incoming.postExitCommand.slice(0, 4000);
    if (Array.isArray(incoming.gameEnv)) {
      // Keep only well-formed { name, value } pairs with a non-empty name.
      // Trim names, coerce values to strings, and cap the list so a malformed
      // client can't bloat the settings file or the launch environment.
      next.gameEnv = incoming.gameEnv
        .filter(e => e && typeof e.name === 'string' && e.name.trim())
        .slice(0, 100)
        .map(e => ({ name: e.name.trim().slice(0, 200), value: (e.value == null ? '' : String(e.value)).slice(0, 2000) }));
    }
    if (typeof incoming.recordPlaytime === 'boolean') next.recordPlaytime = incoming.recordPlaytime;
    if (typeof incoming.showPlaytime === 'boolean') next.showPlaytime = incoming.showPlaytime;
    if (typeof incoming.showTotalPlaytime === 'boolean') next.showTotalPlaytime = incoming.showTotalPlaytime;
    if (typeof incoming.durationsInHours === 'boolean') next.durationsInHours = incoming.durationsInHours;
    if (typeof incoming.consoleShowOnLaunch === 'boolean') next.consoleShowOnLaunch = incoming.consoleShowOnLaunch;
    if (typeof incoming.consoleShowOnCrash === 'boolean') next.consoleShowOnCrash = incoming.consoleShowOnCrash;
    if (typeof incoming.consoleHideOnExit === 'boolean') next.consoleHideOnExit = incoming.consoleHideOnExit;
    if (typeof incoming.useSystemGlfw === 'boolean') next.useSystemGlfw = incoming.useSystemGlfw;
    if (typeof incoming.glfwPath === 'string') next.glfwPath = incoming.glfwPath.trim().slice(0, 1000);
    if (typeof incoming.useSystemOpenal === 'boolean') next.useSystemOpenal = incoming.useSystemOpenal;
    if (typeof incoming.openalPath === 'string') next.openalPath = incoming.openalPath.trim().slice(0, 1000);

    await writeSettings(next);
    res.json(next);
  });

  // Install a Modrinth file (mod / resourcepack / shader) into a profile.
  // When `dependencies` (the chosen Modrinth version's deps array) is provided
  // and projectType is 'mod', required deps are auto-installed into the same
  // mods/ folder afterwards. Resource packs / shaders / datapacks don't have
  // meaningful Modrinth deps, so we skip the walk for those.
  app.post('/api/launcher/profiles/:loader/:version/install', async (req, res) => {
    const { loader, version } = req.params;
    const instanceId = req.query.instance || null;
    const { url, filename, projectType, projectId, iconUrl, title, gameVersions, loaders, dependencies } = req.body || {};
    if (!url || !filename) return res.status(400).json({ error: 'url and filename are required' });
    if (!LOADERS.includes(loader)) {
      return res.status(400).json({ error: 'Invalid loader' });
    }

    const SUBDIR = {
      mod:           'mods',
      resourcepack:  'resourcepacks',
      shader:        'shaderpacks',
      datapack:      'datapacks',
    };
    const subdir = SUBDIR[projectType];
    if (!subdir) {
      return res.status(400).json({ error: `Unsupported projectType: ${projectType}` });
    }

    let profileDir;
    try { profileDir = await resolveProfileDir({ loader, version, instanceId }); }
    catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
    const targetDir = path.join(profileDir, subdir);
    await fs.ensureDir(targetDir);
    const dest = path.join(targetDir, filename);

    try {
      const r = await fetch(url, { headers: MODRINTH_HEADERS });
      if (!r.ok) throw new Error(`Download failed (${r.status})`);
      const buf = Buffer.from(await r.arrayBuffer());
      await fs.writeFile(dest, buf);

      // Record metadata so the UI can show titles/icons later. We also stash
      // the version's gameVersions + loaders (when the client supplies them
      // from the Modrinth version object) so the wrong-version / wrong-loader
      // banner works on the very next /content listing — no SHA1 round-trip
      // needed. `lookedUp: true` short-circuits enrichLauncherMeta for the
      // same reason.
      const metaPath = path.join(targetDir, '.minedash-launcher.json');
      let meta = {};
      try { meta = await fs.readJson(metaPath); } catch {}
      meta[filename] = {
        projectId,
        iconUrl,
        title,
        gameVersions: Array.isArray(gameVersions) ? gameVersions : [],
        loaders:      Array.isArray(loaders)      ? loaders      : [],
        lookedUp: true,
        installedAt: Date.now(),
      };

      // Walk required deps for mods only — other content types don't pull
      // anything sensible from Modrinth's dependency graph. We honour an
      // explicit `dependencies` array from the frontend (no refetch), and
      // fall back to leaving the list empty if the caller didn't supply it.
      let installedDeps = [];
      if (projectType === 'mod' && Array.isArray(dependencies) && dependencies.length > 0) {
        const required = dependencies
          .filter(d => d && d.dependency_type === 'required' && d.project_id)
          .map(d => d.project_id);
        if (required.length > 0) {
          installedDeps = await resolveAndInstallLauncherDeps(
            required,
            version,
            ['fabric', 'forge', 'neoforge'].includes(loader) ? loader : null,
            targetDir,
            meta,
            new Set([projectId].filter(Boolean)),
          );
        }
      }

      await fs.writeJson(metaPath, meta, { spaces: 2 });

      res.json({
        ok: true,
        installed: filename,
        dependencies: installedDeps,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Install a Modrinth modpack from the top-level Browse view — the user
  // hasn't picked a loader or version, so we derive both from the modpack
  // version's metadata and create a fresh instance named after the pack. This
  // is the path that lets Browse feel like a launcher instead of a profile
  // editor: pick a pack, click Install, get a working profile.
  //
  // Returns { sessionId, instanceId, loader, version, displayName } immediately
  // so the frontend can hook the existing modpackInstalls progress tracker
  // and surface a "Play now" toast on completion.
  app.post('/api/launcher/browse/install-modpack', async (req, res) => {
    const { projectId, versionId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });

    try {
      // Fetch every version (no game-version/loader filter — we want the full
      // list to pick from). Modrinth returns oldest → newest by default.
      const vUrl = `https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version`;
      const vRes = await fetch(vUrl, { headers: { 'User-Agent': 'MineDash/1.0 (local server manager)' } });
      if (!vRes.ok) return res.status(502).json({ error: `Modrinth /version returned ${vRes.status}` });
      const versions = await vRes.json();
      if (!Array.isArray(versions) || versions.length === 0) {
        return res.status(404).json({ error: 'No versions found for this project' });
      }

      // Honour an explicit versionId if the frontend asked for one (version
      // picker UI in a future slice). Otherwise pick the best release.
      let chosen = versionId ? versions.find(v => v.id === versionId) : null;
      if (!chosen) chosen = pickBestModrinthVersion(versions);
      if (!chosen) return res.status(404).json({ error: 'Could not pick a version' });

      // Derive loader from version.loaders — modpack versions list exactly
      // one loader (forge / fabric / neoforge / quilt). Quilt is unsupported
      // by the install pipeline (see /install-modpack), so refuse early with
      // a clear error rather than discovering it mid-install.
      const loaderRaw = (chosen.loaders || []).find(l => ['fabric', 'forge', 'neoforge', 'quilt'].includes(l));
      if (!loaderRaw) return res.status(400).json({ error: 'Modpack version has no recognized loader' });
      if (loaderRaw === 'quilt') return res.status(400).json({ error: 'Quilt modpacks are not supported yet — only Fabric, Forge, and NeoForge.' });
      const loader = loaderRaw;

      // Derive Minecraft version — same heuristic as the BrowseSection chip:
      // newest release-shaped version (1.x or 1.x.y) the modpack supports.
      const gameVersions = Array.isArray(chosen.game_versions) ? chosen.game_versions : [];
      let mcVersion = null;
      for (let i = gameVersions.length - 1; i >= 0; i--) {
        if (/^1\.\d+(\.\d+)?$/.test(gameVersions[i])) { mcVersion = gameVersions[i]; break; }
      }
      if (!mcVersion) mcVersion = gameVersions[gameVersions.length - 1];
      if (!mcVersion) return res.status(400).json({ error: 'Modpack version does not declare a Minecraft version' });

      // Pick the primary file (the .mrpack itself — non-primary entries are
      // server jars or other auxiliaries we don't want here).
      const file = (chosen.files || []).find(f => f.primary) || (chosen.files || [])[0];
      if (!file || !file.url) return res.status(400).json({ error: 'Modpack version has no downloadable file' });

      // Build a unique display name. Modrinth gives us the pack title via the
      // request body (frontend already has it from the search hit) — fall
      // back to the version's friendly name if missing. Append " (2)" /
      // " (3)" if the user already has an instance with the same name.
      const wantedBase = (req.body?.displayName || chosen.name || `Modpack ${projectId}`).trim().slice(0, 60);
      const reg = await readProfileRegistry();
      const existing = new Set(reg.instances.map(i => (i.displayName || '').toLowerCase()));
      let displayName = wantedBase;
      let suffix = 2;
      while (existing.has(displayName.toLowerCase())) {
        displayName = `${wantedBase} (${suffix++})`;
        if (suffix > 99) { displayName = `${wantedBase} (${Date.now()})`; break; }
      }

      // Create the instance. New UUID id — the legacy `${loader}-${version}`
      // id is reserved for the default instance per loader+version, and we
      // explicitly want Browse-installed packs to be siblings of the default,
      // not replacements for it.
      const id = crypto.randomUUID();
      const inst = {
        id,
        loader,
        version: mcVersion,
        displayName,
        createdAt: Date.now(),
        // Mark the origin so a later "My Modpacks" surface can group these
        // visually as packs vs. hand-curated instances.
        source: 'browse-modpack',
        modpackProjectId: projectId,
        iconUrl: req.body?.iconUrl || null,
      };
      reg.instances.push(inst);
      await writeProfileRegistry(reg);

      const sessionId = crypto.randomUUID();

      res.json({
        ok: true,
        sessionId,
        instanceId: id,
        loader,
        version: mcVersion,
        displayName,
      });

      // Full pre-install: download the Minecraft client + loader FIRST, then
      // drop the modpack's mods/overrides on top, leaving a ready-to-play
      // instance. We reuse the launch worker's runLaunch in `prepareOnly` mode
      // (it installs everything mclc would at launch, then kills the JVM before
      // it shows a window) so this stays out-of-process and cancellable like a
      // real launch. Worker events are bridged onto modpack_install_<sessionId>
      // (see forkLaunchWorker) so the Browse install card shows the loader /
      // Minecraft / mod-download phases on one progress bar.
      const settings = await readSettings();
      const launchId = crypto.randomUUID();
      // Register for cancellation. The DELETE /modpack-install/:sessionId
      // handler looks the sessionId up here and kills the worker; cleanupInstanceId
      // tells the worker-exit handler to wipe the half-installed instance.
      activeModpackInstalls.set(sessionId, { launchId, cleanupInstanceId: id });
      forkLaunchWorker({
        launchId,
        modpackSessionId: sessionId,
        cleanupInstanceId: id,
        DATA_DIR,
        INSTANCES_DIR,
        discoveredJava: (getJavaPath ? getJavaPath() : null) || 'java',
        launchArgs: {
          launchId,
          instance: inst,
          // Offline synthetic identity — the JVM is killed the instant it
          // spawns, so the auth is never used for anything real. This keeps
          // pre-install working with no signed-in account and never touches
          // Microsoft token refresh.
          account: { type: 'offline', username: 'Player', uuid: crypto.randomUUID() },
          accountsDoc: { accounts: [], activeAccountId: null },
          syncServer: null,
          settings,
          prepareOnly: true,
          modpackInstall: {
            url: file.url,
            filename: file.filename || `${projectId}.mrpack`,
            projectId,
            iconUrl: req.body?.iconUrl || null,
            title: req.body?.title || displayName,
            versionId: chosen.id || null,
            versionNumber: chosen.version_number || null,
          },
        },
      });
    } catch (err) {
      console.error('browse/install-modpack error:', err);
      res.status(500).json({ error: err.message || 'Browse install failed' });
    }
  });

  // Install a .mrpack modpack into a profile. Returns a sessionId immediately
  // and streams progress over the socket channel `modpack_install_<sessionId>`
  // so the UI can show a filling progress bar — modpacks contain hundreds of
  // mods and a spinner-only "Installing…" feels frozen.
  app.post('/api/launcher/profiles/:loader/:version/install-modpack', async (req, res) => {
    const { loader, version } = req.params;
    const instanceId = req.query.instance || null;
    const { url, filename, projectId, iconUrl, title } = req.body || {};
    if (!url || !filename) return res.status(400).json({ error: 'url and filename are required' });
    if (!['fabric', 'forge', 'neoforge'].includes(loader)) {
      return res.status(400).json({ error: 'Modpacks require a Fabric/Forge/NeoForge profile.' });
    }

    let profileDir;
    try { profileDir = await resolveProfileDir({ loader, version, instanceId }); }
    catch (err) { return res.status(err.status || 500).json({ error: err.message }); }

    const sessionId = crypto.randomUUID();
    const cancelToken = { cancelled: false };
    activeModpackInstalls.set(sessionId, { token: cancelToken });
    res.json({ ok: true, sessionId });

    installModpackIntoProfile({ sessionId, profileDir, url, filename, projectId, iconUrl, title, cancelToken })
      .then(summary => { activeModpackInstalls.delete(sessionId); emitModpack(sessionId, 'done', summary); })
      .catch(err => {
        activeModpackInstalls.delete(sessionId);
        if (err && err.cancelled) emitModpack(sessionId, 'cancelled', {});
        else emitModpack(sessionId, 'error', { message: err.message || String(err) });
      });
  });

  // List launcher-installed content for a profile, grouped by type.
  app.get('/api/launcher/profiles/:loader/:version/content', async (req, res) => {
    const { loader, version } = req.params;
    const instanceId = req.query.instance || null;
    let profileDir;
    try { profileDir = await resolveProfileDir({ loader, version, instanceId }); }
    catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
    const result = { mod: [], resourcepack: [], shader: [], datapack: [], modpack: [] };
    const SUBDIR = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', datapack: 'datapacks' };
    // Modpacks aren't a content folder of their own — list anything we recorded
    // as an installed modpack so the UI can show them as "Installed".
    try {
      const recordPath = path.join(profileDir, '.minedash-modpacks.json');
      const record = await fs.readJson(recordPath);
      result.modpack = Object.entries(record).map(([k, v]) => ({ filename: k, ...(v || {}) }));
    } catch {}
    // Enrichment budget — we'd rather paint a snappy "Installed" list with
    // some icons missing than make the user stare at a spinner for 20s while
    // we SHA1-hash 500 jars and round-trip Modrinth for every one. Anything
    // not enriched within the budget continues running in the background so
    // the cache is warm the next time. After Fix #1 (lookedUp is final), the
    // first open of a fresh modpack is the only place this matters — every
    // subsequent open hits zero enrichment jobs and returns instantly.
    const ENRICH_BUDGET_MS = 1500;
    const deadline = Date.now() + ENRICH_BUDGET_MS;
    const backgroundEnrichments = [];

    for (const [type, sub] of Object.entries(SUBDIR)) {
      const dir = path.join(profileDir, sub);
      try {
        const files = await fs.readdir(dir);
        let meta = {};
        try { meta = await fs.readJson(path.join(dir, '.minedash-launcher.json')); } catch {}
        // Include disabled content (renamed `<file>.disabled`, Prism convention)
        // so the UI can list and re-enable it. Meta is keyed by the *enabled*
        // (base) name so a disable→enable round-trip keeps the icon/title.
        const contentFiles = files.filter(f => !f.startsWith('.') && /\.(jar|zip)(\.disabled)?$/i.test(f));
        const baseNameOf = (f) => f.replace(/\.disabled$/i, '');
        // Enrich only enabled files — disabled ones already carry meta keyed by
        // their base name from when they were installed (and their on-disk name
        // ends in `.disabled`, so hashing-by-base-name would miss anyway).
        const enrichTargets = contentFiles.filter(f => !/\.disabled$/i.test(f));
        // Kick off enrichment but only await up to the remaining budget. The
        // promise keeps running after we move on — its `meta` mutation and
        // writeJson finish out-of-band, so the next /content call sees a
        // warmer cache without us having blocked this response.
        const enrichPromise = enrichLauncherMeta(dir, enrichTargets, meta).catch(() => {});
        const remaining = deadline - Date.now();
        if (remaining > 0) {
          await Promise.race([
            enrichPromise,
            new Promise(resolve => setTimeout(resolve, remaining)),
          ]);
        } else {
          backgroundEnrichments.push(enrichPromise);
        }
        for (const f of contentFiles) {
          const baseName = baseNameOf(f);
          const enabled = f === baseName; // f had no `.disabled` suffix
          const m = meta[baseName] || {};
          // Compatibility checks only apply to mods (resource packs, shaders,
          // datapacks aren't loader-gated and tolerate version mismatches).
          let wrongVersion = false;
          let wrongLoader = false;
          if (type === 'mod') {
            if (Array.isArray(m.gameVersions) && m.gameVersions.length > 0 && version && !m.gameVersions.includes(version)) {
              wrongVersion = true;
            }
            if (Array.isArray(m.loaders) && m.loaders.length > 0 && ['fabric', 'forge', 'neoforge', 'quilt'].includes(loader)) {
              const realLoaders = m.loaders.filter(l => ['forge', 'neoforge', 'fabric', 'quilt'].includes(l));
              if (realLoaders.length > 0 && !realLoaders.includes(loader)) wrongLoader = true;
            }
          }
          // Resolve an installedAt timestamp. Files installed before MineDash
          // started tracking this fall back to the on-disk mtime, which is a
          // reasonable proxy — the file landed on disk at that time. Used by
          // the launcher Updates check so it knows what counts as "newer".
          let installedAt = m.installedAt;
          if (!installedAt) {
            try {
              const st = await fs.stat(path.join(dir, f));
              installedAt = st.mtimeMs;
            } catch {}
          }
          // `filename` is the real on-disk name (the target for delete/toggle);
          // `baseName` is the clean name to display (no `.disabled` suffix).
          result[type].push({ filename: f, baseName, enabled, ...m, installedAt, wrongVersion, wrongLoader });
        }
      } catch {}
    }
    // Background enrichments are intentionally NOT awaited — they finish on
    // their own timeline and update the on-disk cache for the next call.
    void backgroundEnrichments;
    res.json(result);
  });

  // For every mod marked wrongVersion / wrongLoader, look up a compatible Modrinth
  // version for the profile's MC + loader, delete the broken jar, and install the
  // replacement. Mirrors POST /api/servers/:id/mods/repair-versions for launcher
  // profiles. Only operates on mods/ (resource packs etc. aren't version-gated).
  app.post('/api/launcher/profiles/:loader/:version/content/repair-versions', async (req, res) => {
    const { loader, version } = req.params;
    const instanceId = req.query.instance || null;
    if (!['fabric', 'forge', 'neoforge', 'quilt'].includes(loader)) {
      return res.status(400).json({ error: 'Only modded loaders can have wrong-version mods' });
    }
    let profileDir;
    try { profileDir = await resolveProfileDir({ loader, version, instanceId }); }
    catch (err) { return res.status(err.status || 500).json({ error: err.message }); }

    const modsDir = path.join(profileDir, 'mods');
    if (!await fs.pathExists(modsDir)) return res.json({ repaired: [], failed: [] });

    const metaPath = path.join(modsDir, '.minedash-launcher.json');
    let meta = {};
    try { meta = await fs.readJson(metaPath); } catch {}

    const files = (await fs.readdir(modsDir)).filter(f => !f.startsWith('.') && /\.(jar|zip)$/i.test(f));
    await enrichLauncherMeta(modsDir, files, meta);

    const repaired = [];
    const failed = [];
    for (const f of files) {
      const m = meta[f] || {};
      const versionOk = !Array.isArray(m.gameVersions) || m.gameVersions.length === 0 || m.gameVersions.includes(version);
      const realLoaders = Array.isArray(m.loaders) ? m.loaders.filter(l => ['forge', 'neoforge', 'fabric', 'quilt'].includes(l)) : [];
      const loaderOk = realLoaders.length === 0 || realLoaders.includes(loader);
      if (versionOk && loaderOk) continue;
      if (!m.projectId) { failed.push({ filename: f, reason: 'Not on Modrinth — replace manually' }); continue; }

      try {
        const vParams = new URLSearchParams();
        vParams.set('game_versions', JSON.stringify([version]));
        vParams.set('loaders', JSON.stringify([loader]));
        const vRes = await fetch(`${MODRINTH_API}/project/${m.projectId}/version?${vParams}`, { headers: MODRINTH_HEADERS });
        if (!vRes.ok) { failed.push({ filename: f, reason: 'Modrinth lookup failed' }); continue; }
        const versions = await vRes.json();
        const best = pickBestModrinthVersion(versions);
        if (!best) { failed.push({ filename: f, reason: `No version compatible with ${loader} ${version}` }); continue; }
        const file = best.files.find(x => x.primary) || best.files[0];
        if (!file) { failed.push({ filename: f, reason: 'No primary file in version' }); continue; }
        if (file.filename === f) { failed.push({ filename: f, reason: 'Already on the correct version' }); continue; }

        const dlRes = await fetch(file.url, { headers: MODRINTH_HEADERS });
        if (!dlRes.ok) { failed.push({ filename: f, reason: `Download failed (${dlRes.status})` }); continue; }
        const buf = Buffer.from(await dlRes.arrayBuffer());

        await fs.remove(path.join(modsDir, f));
        await fs.writeFile(path.join(modsDir, file.filename), buf);
        delete meta[f];
        meta[file.filename] = {
          iconUrl: m.iconUrl || null,
          title: m.title || null,
          projectId: m.projectId,
          // gameVersions/loaders will be re-fetched on the next enrichment pass.
        };
        repaired.push({ from: f, to: file.filename, title: m.title || file.filename });
      } catch (err) {
        failed.push({ filename: f, reason: err.message });
      }
    }

    if (repaired.length > 0) {
      try { await fs.writeJson(metaPath, meta, { spaces: 2 }); } catch {}
    }
    res.json({ repaired, failed });
  });

  // ── Per-mod update check ─────────────────────────────────────────
  // Hash every installed mod and ask Modrinth — in ONE bulk call — what the
  // latest version for this loader + MC version is. A mod has an update when
  // the latest version's primary file hash differs from the local file's.
  app.post('/api/launcher/profiles/:loader/:version/content/check-updates', async (req, res) => {
    const { loader, version } = req.params;
    const instanceId = req.query.instance || null;
    if (!['fabric', 'forge', 'neoforge'].includes(loader)) {
      return res.json({ updates: [], checked: 0 });
    }
    let profileDir;
    try { profileDir = await resolveProfileDir({ loader, version, instanceId }); }
    catch (err) { return res.status(err.status || 500).json({ error: err.message }); }

    const modsDir = path.join(profileDir, 'mods');
    let files = [];
    try { files = (await fs.readdir(modsDir)).filter(f => !f.startsWith('.') && /\.jar$/i.test(f)); }
    catch { return res.json({ updates: [], checked: 0 }); }
    if (files.length === 0) return res.json({ updates: [], checked: 0 });

    let meta = {};
    try { meta = await fs.readJson(path.join(modsDir, '.minedash-launcher.json')); } catch {}

    const hashToFile = new Map();
    await runWithConcurrency(files.map(f => async () => {
      try { hashToFile.set(await fileSha1(path.join(modsDir, f)), f); } catch {}
    }), 8);
    if (hashToFile.size === 0) return res.json({ updates: [], checked: 0 });

    let latest;
    try {
      const r = await fetch(`${MODRINTH_API}/version_files/update`, {
        method: 'POST',
        headers: { ...MODRINTH_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hashes: Array.from(hashToFile.keys()),
          algorithm: 'sha1',
          loaders: [loader],
          game_versions: [version],
        }),
      });
      if (!r.ok) return res.status(502).json({ error: `Modrinth update lookup failed (${r.status})` });
      latest = await r.json();
    } catch (err) {
      return res.status(502).json({ error: `Modrinth unreachable: ${err.message}` });
    }

    const updates = [];
    for (const [sha1, ver] of Object.entries(latest || {})) {
      const filename = hashToFile.get(sha1);
      if (!filename || !ver) continue;
      const file = (ver.files || []).find(x => x.primary) || (ver.files || [])[0];
      if (!file || file.hashes?.sha1 === sha1) continue; // already on the latest
      const m = meta[filename] || {};
      updates.push({
        filename,
        title: m.title || filename,
        iconUrl: m.iconUrl || null,
        projectId: ver.project_id,
        versionId: ver.id,
        versionNumber: ver.version_number,
        newFilename: file.filename,
        datePublished: ver.date_published,
      });
    }
    updates.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    res.json({ updates, checked: hashToFile.size });
  });

  // Apply mod updates found by check-updates. Body: { updates: [{ filename,
  // versionId }] }. Downloads each new file, swaps it in for the old one, and
  // keeps every side-table consistent: the launcher manifest, the
  // client-extras list (so server-sync doesn't wipe the new jar), and any
  // modpack record that tracked the old path (so modpack delete/update flows
  // keep working after a per-mod update).
  app.post('/api/launcher/profiles/:loader/:version/content/update-mods', async (req, res) => {
    const { loader, version } = req.params;
    const instanceId = req.query.instance || null;
    const requested = Array.isArray(req.body?.updates) ? req.body.updates : [];
    if (requested.length === 0) return res.status(400).json({ error: 'No updates supplied' });
    let profileDir;
    try { profileDir = await resolveProfileDir({ loader, version, instanceId }); }
    catch (err) { return res.status(err.status || 500).json({ error: err.message }); }

    const modsDir = path.join(profileDir, 'mods');
    const metaPath = path.join(modsDir, '.minedash-launcher.json');
    let meta = {};
    try { meta = await fs.readJson(metaPath); } catch {}

    let extras = { files: [] };
    try { extras = await readClientExtras(profileDir); } catch {}
    const extrasSet = new Set(extras.files || []);

    const updated = [];
    const failed = [];
    for (const u of requested) {
      const oldName = typeof u?.filename === 'string' ? path.basename(u.filename) : '';
      const versionId = typeof u?.versionId === 'string' ? u.versionId : '';
      if (!oldName || !versionId || !/^[\w-]+$/.test(versionId)) {
        failed.push({ filename: oldName || '(unknown)', reason: 'Invalid update entry' });
        continue;
      }
      try {
        const vRes = await fetch(`${MODRINTH_API}/version/${versionId}`, { headers: MODRINTH_HEADERS });
        if (!vRes.ok) { failed.push({ filename: oldName, reason: `Version lookup failed (${vRes.status})` }); continue; }
        const ver = await vRes.json();
        const file = (ver.files || []).find(x => x.primary) || (ver.files || [])[0];
        if (!file?.url) { failed.push({ filename: oldName, reason: 'No downloadable file in version' }); continue; }

        const dlRes = await fetch(file.url, { headers: MODRINTH_HEADERS });
        if (!dlRes.ok) { failed.push({ filename: oldName, reason: `Download failed (${dlRes.status})` }); continue; }
        const buf = Buffer.from(await dlRes.arrayBuffer());

        const newName = path.basename(file.filename);
        await fs.writeFile(path.join(modsDir, newName), buf);
        if (newName !== oldName) await fs.remove(path.join(modsDir, oldName)).catch(() => {});

        const m = meta[oldName] || {};
        if (newName !== oldName) delete meta[oldName];
        meta[newName] = {
          ...m,
          projectId: ver.project_id || m.projectId || null,
          gameVersions: ver.game_versions || [],
          loaders: ver.loaders || [],
          lookedUp: true,
          installedAt: Date.now(),
        };
        if (extrasSet.has(oldName)) { extrasSet.delete(oldName); extrasSet.add(newName); }
        updated.push({ from: oldName, to: newName, title: m.title || newName, versionNumber: ver.version_number });
      } catch (err) {
        failed.push({ filename: oldName, reason: err.message });
      }
    }

    if (updated.length > 0) {
      try { await fs.writeJson(metaPath, meta, { spaces: 2 }); } catch {}
      try { await writeClientExtras(profileDir, { files: Array.from(extrasSet) }); } catch {}
      // Keep modpack file-tracking pointing at the renamed jars.
      try {
        const recordPath = path.join(profileDir, '.minedash-modpacks.json');
        const record = await fs.readJson(recordPath);
        let changed = false;
        for (const entry of Object.values(record || {})) {
          if (!entry || !Array.isArray(entry.files)) continue;
          for (const { from, to } of updated) {
            if (from === to) continue;
            const idx = entry.files.findIndex(p => p === `mods/${from}` || p === `mods\\${from}`);
            if (idx !== -1) { entry.files[idx] = `mods/${to}`; changed = true; }
          }
        }
        if (changed) await fs.writeJson(recordPath, record, { spaces: 2 });
      } catch {}
    }
    res.json({ updated, failed });
  });

  // Upload a manually-downloaded file (mod jar / resource pack zip / shader zip
  // / datapack zip) into the profile's content folder. Lets users install mods
  // that are only on CurseForge (e.g. FTB Quests) by downloading them by hand
  // and dropping them in here. 100 MB cap covers the chunky modpacks like
  // GregTech / Create patches without bloating disk usage.
  const launcherUpload = multer({
    dest: path.join(require('os').tmpdir(), 'minedash-launcher-uploads'),
    limits: { fileSize: 200 * 1024 * 1024 },
  });
  // `array('file', 50)` — accept multiple files appended under the same `file`
  // field name (what FormData does when you append more than once). Single-file
  // callers still work because `req.files` becomes a 1-element array.
  app.post('/api/launcher/profiles/:loader/:version/upload', launcherUpload.array('file', 50), async (req, res) => {
    const { loader, version } = req.params;
    const instanceId = req.query.instance || null;
    const projectType = req.query.type || 'mod';
    const SUBDIR = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', datapack: 'datapacks' };
    const subdir = SUBDIR[projectType];
    if (!subdir) return res.status(400).json({ error: `Unsupported type: ${projectType}` });
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'No file uploaded' });

    let profileDir;
    try { profileDir = await resolveProfileDir({ loader, version, instanceId }); }
    catch (err) {
      // Clean up any temp files multer wrote — they're orphans now.
      for (const f of files) await fs.remove(f.path).catch(() => {});
      return res.status(err.status || 500).json({ error: err.message });
    }

    const targetDir = path.join(profileDir, subdir);
    await fs.ensureDir(targetDir);

    // Per-file validation + move. We don't fail the whole batch on one bad
    // file — the user gets a per-file result so they can see e.g. "3 mods
    // installed, 1 rejected (not a .jar)". That's friendlier than telling
    // them to re-drop everything when only one file was wrong.
    const installed = [];
    const failed = [];
    let extras;
    try { extras = await readClientExtras(profileDir); } catch { extras = { files: [] }; }
    const extrasSet = new Set(extras.files || []);

    for (const f of files) {
      const name = f.originalname;
      const isJar = /\.jar$/i.test(name);
      const isZip = /\.zip$/i.test(name);
      if (projectType === 'mod' && !isJar) {
        failed.push({ filename: name, reason: 'Mods must be .jar files' });
        await fs.remove(f.path).catch(() => {});
        continue;
      }
      if (projectType !== 'mod' && !isZip) {
        failed.push({ filename: name, reason: `${projectType} files must be .zip` });
        await fs.remove(f.path).catch(() => {});
        continue;
      }
      try {
        await fs.move(f.path, path.join(targetDir, name), { overwrite: true });
        // Mark every successful upload as a client-extra so syncClientMods
        // (the per-server Play path) doesn't wipe these on the next launch
        // when the server's mods folder is the canonical source.
        extrasSet.add(name);
        installed.push(name);
      } catch (err) {
        failed.push({ filename: name, reason: err.message });
        await fs.remove(f.path).catch(() => {});
      }
    }

    if (installed.length > 0) {
      try { await writeClientExtras(profileDir, { files: Array.from(extrasSet) }); } catch {}
    }
    // 207 Multi-Status — partial success. Use 200 if everything landed.
    res.status(failed.length === 0 ? 200 : 207).json({ ok: failed.length === 0, installed, failed });
  });

  // Delete a single installed content file from a profile. Modpacks are
  // handled specially: there's no `modpacks/` folder — they're tracked in
  // `.minedash-modpacks.json` and the install dropped files scattered across
  // mods/, config/, resourcepacks/, etc. Delete removes every file the
  // install recorded plus the manifest entry.
  app.delete('/api/launcher/profiles/:loader/:version/content/:type/:filename', async (req, res) => {
    const { loader, version, type, filename } = req.params;
    const instanceId = req.query.instance || null;
    let profileDir;
    try { profileDir = await resolveProfileDir({ loader, version, instanceId }); }
    catch (err) { return res.status(err.status || 500).json({ error: err.message }); }

    if (type === 'modpack') {
      const recordPath = path.join(profileDir, '.minedash-modpacks.json');
      let record = {};
      try { record = await fs.readJson(recordPath); } catch {}
      const entry = record[filename];
      if (!entry) {
        // No manifest entry means the install never registered or the user
        // already removed it. Treat as already-deleted so the UI flips cleanly.
        return res.json({ ok: true, removed: 0 });
      }
      const files = Array.isArray(entry.files) ? entry.files : [];
      let removed = 0;
      const removedDirs = new Set();
      for (const rel of files) {
        // safeJoin: refuse to traverse out of the profile, in case an older
        // install recorded an absolute or `..`-laced path.
        const norm = String(rel).replace(/^[/\\]+/, '');
        if (!norm || norm.includes('..')) continue;
        const target = path.join(profileDir, norm);
        if (!target.startsWith(profileDir)) continue;
        try {
          if (await fs.pathExists(target)) {
            await fs.remove(target);
            removed++;
            removedDirs.add(path.dirname(target));
          }
        } catch {
          // Skip files we can't remove (locked by AV, in use) — the user can
          // delete them by hand. We still strip them from the manifest below
          // so the modpack disappears from the UI.
        }
      }
      // Walk up the directory tree pruning any directories the install left
      // behind that are now empty. Stop at the profile root — never delete
      // the profile itself or anything outside it.
      const sortedDirs = Array.from(removedDirs).sort((a, b) => b.length - a.length);
      for (const dir of sortedDirs) {
        let cur = dir;
        while (cur.startsWith(profileDir) && cur !== profileDir) {
          try {
            const entries = await fs.readdir(cur);
            if (entries.length === 0) {
              await fs.remove(cur);
              cur = path.dirname(cur);
            } else break;
          } catch { break; }
        }
      }
      delete record[filename];
      try { await fs.writeJson(recordPath, record, { spaces: 2 }); } catch {}
      return res.json({ ok: true, removed });
    }

    const SUBDIR = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', datapack: 'datapacks' };
    const sub = SUBDIR[type];
    if (!sub) return res.status(400).json({ error: 'Invalid content type' });
    const target = path.join(profileDir, sub, filename);
    try {
      if (await fs.pathExists(target)) await fs.remove(target);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Enable / disable a single content file by renaming `<file>` ⇄
  // `<file>.disabled` (Prism convention). mclc only loads `*.jar` from `mods/`,
  // so a `.disabled` file is ignored at launch — same effect as the server-side
  // mods toggle. Resource packs / shaders work the same way (the in-game list
  // skips `.disabled`). Returns the new on-disk filename + the resulting state.
  app.post('/api/launcher/profiles/:loader/:version/content/:type/:filename/toggle', async (req, res) => {
    const { loader, version, type, filename } = req.params;
    const instanceId = req.query.instance || null;
    const SUBDIR = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', datapack: 'datapacks' };
    const sub = SUBDIR[type];
    if (!sub) return res.status(400).json({ error: 'Invalid content type' });

    let profileDir;
    try { profileDir = await resolveProfileDir({ loader, version, instanceId }); }
    catch (err) { return res.status(err.status || 500).json({ error: err.message }); }

    const dir = path.join(profileDir, sub);
    const src = safeChildPath(dir, filename);
    if (!src) return res.status(400).json({ error: 'Invalid filename' });
    if (!await fs.pathExists(src)) return res.status(404).json({ error: 'File not found' });

    const isDisabled = /\.disabled$/i.test(filename);
    const newName = isDisabled ? filename.replace(/\.disabled$/i, '') : `${filename}.disabled`;
    const dest = safeChildPath(dir, newName);
    if (!dest) return res.status(400).json({ error: 'Invalid target filename' });
    if (await fs.pathExists(dest)) {
      return res.status(409).json({ error: `A file named "${newName}" already exists.` });
    }
    try {
      await fs.move(src, dest);
      res.json({ ok: true, enabled: isDisabled, newFilename: newName });
    } catch (err) {
      res.status(500).json({ error: `Could not ${isDisabled ? 'enable' : 'disable'} file: ${err.message}. If the game is running, close it first.` });
    }
  });

  // Delete a cached profile (loader + version) so the user can re-download it.
  // Removes the default instance for that loader+version. Use the instances
  // DELETE endpoint to remove a specific named instance.
  app.delete('/api/launcher/profiles/:loader/:version', async (req, res) => {
    const { loader, version } = req.params;
    if (!LOADERS.includes(loader)) {
      return res.status(400).json({ error: 'Invalid loader' });
    }
    const id = defaultInstanceId(loader, version);
    const profileDir = instanceDir(id);
    if (!await fs.pathExists(profileDir)) {
      return res.status(404).json({ error: 'Profile not installed' });
    }
    try {
      await fs.remove(profileDir);
      // Remove the default registry entry too — it'll be re-created the next
      // time someone launches this loader+version.
      const reg = await readProfileRegistry();
      reg.instances = reg.instances.filter(i => i.id !== id);
      await writeProfileRegistry(reg);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // List profiles that have been installed locally (used by the UI to mark
  // already-downloaded versions in the picker so the user can tell at a glance).
  app.get('/api/launcher/profiles', async (req, res) => {
    try {
      const root = clientsRoot();
      if (!await fs.pathExists(root)) return res.json([]);
      const dirs = await fs.readdir(root);
      const profiles = [];
      for (const d of dirs) {
        const m = d.match(/^(vanilla|fabric|forge|neoforge)-(.+)$/);
        if (!m) continue;
        // "Installed" = the profile has been launched at least once and the
        // version JSON / libraries folder is present.
        const versionsDir = path.join(root, d, 'versions');
        const libsDir = path.join(root, d, 'libraries');
        const hasContent = (await fs.pathExists(versionsDir)) || (await fs.pathExists(libsDir));
        if (hasContent) profiles.push({ loader: m[1], version: m[2] });
      }
      res.json(profiles);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/launcher/accounts', async (req, res) => {
    const d = await readAccounts();
    res.json({
      activeAccountId: d.activeAccountId,
      accounts: d.accounts.map(stripAccount),
      microsoftConfigured: !!AZURE_CLIENT_ID,
    });
  });

  // Start an MS device-style flow: open a localhost callback listener and
  // hand the user a sign-in link. They open it in their browser, complete
  // the OAuth flow, and the listener captures the auth code.
  app.post('/api/launcher/accounts/microsoft/start', async (req, res) => {
    if (!AZURE_CLIENT_ID) {
      return res.status(500).json({ error: 'Microsoft sign-in is not configured. Set AZURE_CLIENT_ID in backend/launcher.js.' });
    }
    const sessionId = crypto.randomUUID();
    msSessions.set(sessionId, { status: 'pending' });

    try {
      const auth = new Auth({
        client_id: AZURE_CLIENT_ID,
        redirect: 'http://localhost',
        prompt: 'select_account',
      });

      const handle = await auth.setServer(async (xbox) => {
        try {
          const mc = await xbox.getMinecraft();
          if (!mc.profile?.name) throw new Error('Account does not own Minecraft.');
          const accounts = await readAccounts();
          const account = {
            id: crypto.randomUUID(),
            type: 'microsoft',
            username: mc.profile.name,
            uuid: mc.profile.id,
            mcToken: mc.getToken(true),
          };
          accounts.accounts.push(account);
          accounts.activeAccountId = account.id;
          await writeAccounts(accounts);
          const session = msSessions.get(sessionId) || {};
          session.status = 'complete';
          session.account = stripAccount(account);
          msSessions.set(sessionId, session);
          if (session.server) { try { session.server.close(); } catch {} }
        } catch (err) {
          const session = msSessions.get(sessionId) || {};
          session.status = 'error';
          session.error = err.message || String(err);
          msSessions.set(sessionId, session);
        }
      });

      msSessions.set(sessionId, { status: 'pending', link: handle.link, server: handle.server });
      // Auto-expire pending session after 10 minutes.
      setTimeout(() => {
        const s = msSessions.get(sessionId);
        if (s && s.status === 'pending') {
          try { s.server?.close(); } catch {}
          msSessions.set(sessionId, { status: 'error', error: 'Sign-in timed out.' });
        }
      }, 10 * 60 * 1000);

      res.json({ sessionId, link: handle.link });
    } catch (err) {
      msSessions.delete(sessionId);
      res.status(500).json({ error: err.message || 'Failed to start sign-in' });
    }
  });

  app.get('/api/launcher/accounts/microsoft/poll/:sessionId', (req, res) => {
    const s = msSessions.get(req.params.sessionId);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    const { status, error, account, link } = s;
    res.json({ status, error, account, link });
  });

  app.post('/api/launcher/accounts/offline', async (req, res) => {
    const username = (req.body?.username || '').trim();
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3–16 characters: letters, digits, underscore.' });
    }
    const accounts = await readAccounts();
    if (accounts.accounts.some(a => a.type === 'offline' && a.username.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ error: 'An offline account with that username already exists.' });
    }
    // Per-account Ely.by skins toggle. Defaults to the global setting when the
    // body doesn't say (so the Add-Offline checkbox can pre-tick from settings).
    let elybySkins;
    if (typeof req.body?.elybySkins === 'boolean') elybySkins = req.body.elybySkins;
    else elybySkins = (await readSettings()).elybySkins !== false;

    const account = {
      id: crypto.randomUUID(),
      type: 'offline',
      username,
      uuid: offlineUuid(username),
      elybySkins,
      // Ely.by UUID for this name (null if no Ely.by account owns it). Used at
      // launch so in-game skins resolve. Only looked up when skins are enabled.
      elybyUuid: elybySkins ? await resolveElyByUuid(username) : null,
    };
    accounts.accounts.push(account);
    if (!accounts.activeAccountId) accounts.activeAccountId = account.id;
    await writeAccounts(accounts);
    res.json(stripAccount(account));
  });

  // Toggle Ely.by skins on an existing offline account (re-resolving the Ely.by
  // UUID when turning it on). PATCH is in the CORS method whitelist.
  app.patch('/api/launcher/accounts/:id', async (req, res) => {
    const accounts = await readAccounts();
    const account = accounts.accounts.find(a => a.id === req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.type !== 'offline') {
      return res.status(400).json({ error: 'Ely.by skins only apply to offline accounts.' });
    }
    if (typeof req.body?.elybySkins === 'boolean') {
      account.elybySkins = req.body.elybySkins;
      account.elybyUuid = account.elybySkins ? await resolveElyByUuid(account.username) : null;
    }
    await writeAccounts(accounts);
    res.json(stripAccount(account));
  });

  app.post('/api/launcher/accounts/:id/activate', async (req, res) => {
    const accounts = await readAccounts();
    if (!accounts.accounts.find(a => a.id === req.params.id)) {
      return res.status(404).json({ error: 'Account not found' });
    }
    accounts.activeAccountId = req.params.id;
    await writeAccounts(accounts);
    res.json({ activeAccountId: accounts.activeAccountId });
  });

  app.delete('/api/launcher/accounts/:id', async (req, res) => {
    const accounts = await readAccounts();
    accounts.accounts = accounts.accounts.filter(a => a.id !== req.params.id);
    if (accounts.activeAccountId === req.params.id) {
      accounts.activeAccountId = accounts.accounts[0]?.id || null;
    }
    await writeAccounts(accounts);
    res.json({ activeAccountId: accounts.activeAccountId });
  });

  // Player head avatar. Cosmetic only. Query params come straight off the
  // account object the frontend already has (type, uuid); username is the path
  // segment. For offline accounts we honour the global elybySkins toggle.
  app.get('/api/launcher/skins/:username/head', async (req, res) => {
    const username = req.params.username;
    let size = parseInt(req.query.size, 10);
    if (!Number.isFinite(size)) size = 32;
    size = Math.max(8, Math.min(512, size));
    const type = req.query.type || '';
    const uuid = req.query.uuid || '';

    // Per-account Ely.by-skins override: if there's an offline account with this
    // username, honour its own toggle; otherwise fall back to the global setting.
    // We also carry its pre-resolved Ely.by UUID so the head matches the in-game
    // skin regardless of the username's casing (see elyBySkinUrl).
    let elybySkins = true;
    let elybyUuid = null;
    if (type === 'offline') {
      try {
        const { accounts } = await readAccounts();
        const acct = accounts.find(a => a.type === 'offline' && a.username.toLowerCase() === username.toLowerCase());
        if (acct && typeof acct.elybySkins === 'boolean') elybySkins = acct.elybySkins;
        else elybySkins = (await readSettings()).elybySkins !== false;
        if (acct && acct.elybyUuid) elybyUuid = acct.elybyUuid;
      } catch { elybySkins = true; }
    }

    const key = `${type}:${username}:${uuid}:${size}:${elybySkins ? 1 : 0}:${elybyUuid || ''}`;
    let buf = skinCacheGet(key);
    if (!buf) {
      buf = await resolveHead({ type, username, uuid, size, elybySkins, elybyUuid });
      skinCacheSet(key, buf);
    }
    res.set('Content-Type', 'image/png');
    // no-cache (revalidate every load) rather than a max-age: the head URL is
    // stable (username+uuid), so any browser-side freshness window keeps a
    // just-changed skin stale everywhere until it expires — even after the
    // backend cache was purged via the refresh endpoint. The backend's
    // in-memory cache absorbs the refetches and it's all localhost anyway.
    res.set('Cache-Control', 'no-cache');
    res.send(buf);
  });

  // Force-refresh a player's head: drop every cached buffer for the username
  // so the next /head request re-resolves from Ely.by / mc-heads. Used by the
  // per-account Refresh button after the user changes their skin upstream.
  app.post('/api/launcher/skins/:username/refresh', (req, res) => {
    const purged = skinCachePurgeUser(req.params.username);
    res.json({ ok: true, purged });
  });

  // Launch the game. Either:
  //   { version, loader, instanceId?, syncFromServerId? }  — standalone
  //   { joinServerId }                                      — derived from a running MineDash server,
  //                                                           mods auto-synced and quickPlay set to localhost:port.
  //
  // If instanceId is omitted, the default instance for loader+version is used.
  app.post('/api/launcher/launch', async (req, res) => {
    const { joinServerId } = req.body || {};
    let { version, loader, instanceId, syncFromServerId } = req.body || {};
    // Optional singleplayer quick-play target (Worlds → Join): a world folder
    // name. Only honoured for standalone launches (not when joining a server,
    // which always quick-plays into the server host).
    let quickPlayWorld = typeof req.body?.quickPlayWorld === 'string' && req.body.quickPlayWorld.trim()
      ? req.body.quickPlayWorld.trim().slice(0, 260)
      : null;

    let quickPlayHost;
    if (joinServerId) {
      const servers = await getServers();
      const target = servers.find(s => s.id === joinServerId);
      if (!target) return res.status(404).json({ error: 'Server not found' });
      if (!LOADERS.includes(target.type)) {
        return res.status(400).json({ error: `Server uses ${target.type}, which the built-in launcher doesn't support yet.` });
      }
      loader = target.type;
      version = target.version;
      syncFromServerId = target.id;
      // Use (or create) an instance dedicated to this server, so each server's
      // mods land in their own isolated profile instead of clobbering the
      // shared default instance for this loader+version. The ID is deterministic
      // (`server-<serverId>`) so the same instance is picked up on every
      // subsequent Play, even if the user renames the server.
      instanceId = await ensureServerInstance(target);
      const port = await readServerPort(target.id);
      quickPlayHost = `localhost:${port}`;
    }

    if (!version) return res.status(400).json({ error: 'version is required' });
    if (!LOADERS.includes(loader)) {
      return res.status(400).json({ error: `loader must be one of ${LOADERS.join(', ')}` });
    }

    // Resolve instance — either the explicit one or the default for this loader+version.
    let instance;
    if (instanceId) {
      instance = await getInstance(instanceId);
      if (!instance) return res.status(404).json({ error: 'Unknown instance ID' });
      if (instance.loader !== loader || instance.version !== version) {
        return res.status(400).json({ error: `Instance ${instanceId} is ${instance.loader} ${instance.version}, not ${loader} ${version}` });
      }
    } else {
      instance = await ensureDefaultInstance(loader, version);
    }

    const accounts = await readAccounts();
    const account = accounts.accounts.find(a => a.id === accounts.activeAccountId);
    if (!account) return res.status(400).json({ error: 'No active account. Add one first.' });

    const settings = await readSettings();

    let syncServer = null;
    if (syncFromServerId) {
      const servers = await getServers();
      syncServer = servers.find(s => s.id === syncFromServerId) || null;
    }

    // Ely.by-skins prep happens HERE, in the parent, BEFORE we fork — so the
    // network bits (authlib-injector download, prefetch fetch, UUID lookup)
    // happen where we still have the toast/log pipeline and the worker's job
    // stays pure (download + spawn). Skins are cosmetic, so any failure here is
    // NON-fatal: we just skip the agent and launch normally (vanilla Steve).
    let elybyLaunch = null;
    const useElySkins = account.type === 'offline'
      && (typeof account.elybySkins === 'boolean' ? account.elybySkins : settings.elybySkins !== false);
    if (useElySkins) {
      try {
        const jarPath = await ensureAuthlibInjector(DATA_DIR);
        const prefetchB64 = await fetchPrefetchMeta();
        // The Ely.by UUID is what lets the skin resolve in-game. Prefer the one
        // captured at account-creation; resolve lazily if it's missing. Fall
        // back to the offline UUID (skin still shows in the launcher; in-game it
        // just won't resolve, which is the best we can do without an Ely.by name).
        let profileUuid = account.elybyUuid || await resolveElyByUuid(account.username);
        elybyLaunch = { jarPath, prefetchB64, profileUuid: profileUuid || account.uuid };
      } catch {
        elybyLaunch = null; // injector/prefetch unavailable — launch without skins
      }
    }

    // Track when this account was last used to play (display-only, surfaced in
    // Settings → Accounts). Best-effort persist.
    account.lastUsedAt = Date.now();
    try { await writeAccounts(accounts); } catch {}

    const launchId = crypto.randomUUID();
    res.json({ ok: true, launchId });

    // Remember what the user launched so the Play form reopens to the same
    // instance next time MineDash starts.
    try {
      const persisted = { ...settings, lastLoader: loader, lastVersion: version, lastInstanceId: instance.id };
      await writeSettings(persisted);
    } catch {}

    // The user may have hit Stop while we were between res.json and here (the
    // settings write above awaits, and the frontend can DELETE the moment it
    // reads the launchId off the response). The DELETE handler found no worker
    // to kill and left the cancel flag set — honour it now instead of forking
    // a worker the user already asked us to stop.
    if (cancelledLaunches.has(launchId)) {
      cancelledLaunches.delete(launchId);
      emit(launchId, 'close', { code: 'cancelled' });
      return;
    }

    // Fork a worker process to run the actual launch. Doing this out-of-process
    // means a SIGKILL on the worker terminates mclc's in-flight HTTP download
    // instantly — no more "Stopping — current file has to finish first" wait,
    // which mclc gives us no safe way to abort in-process. Events come back
    // over IPC and are forwarded onto the socket so the UI is unchanged.
    forkLaunchWorker({
      launchId,
      // The worker needs DATA_DIR/INSTANCES_DIR so its launcher.init mirrors
      // ours; we pre-resolve Java + sync server so the worker doesn't have to
      // re-read shared state.
      DATA_DIR,
      INSTANCES_DIR,
      discoveredJava: (getJavaPath ? getJavaPath() : null) || 'java',
      launchArgs: {
        launchId,
        instance,
        account,
        accountsDoc: accounts,
        syncServer,
        settings,
        quickPlayHost,
        quickPlayWorld,
        // Pre-resolved Ely.by skins bundle (jar path + prefetched metadata +
        // Ely.by UUID). Null unless this is an offline account with Ely.by skins
        // enabled — the worker only injects the agent when this is present.
        elybyLaunch,
      },
    });
  });

  // Cancel / stop an in-progress launch or running game.
  // With the worker-process refactor, cancellation is instant on the download
  // path: parent flips the cancel flag, sends an IPC `cancel` to the worker so
  // it can kill any sub-children (NeoForge installer / JVM) cleanly, then
  // SIGKILLs the worker after a short grace period so an unresponsive worker
  // can't keep eating CPU/bandwidth forever. The eventual `close` is emitted
  // from the worker's `exit` handler in forkLaunchWorker.
  app.delete('/api/launcher/launch/:launchId', (req, res) => {
    const { launchId } = req.params;
    cancelledLaunches.add(launchId);
    const entry = activeLaunches.get(launchId);
    const worker = entry && entry.worker;
    if (worker && !worker.killed) {
      // Polite first — give the worker a chance to taskkill /F /T its
      // children (so NeoForge JVMs / game JVMs don't become orphans) and
      // exit cleanly. If it doesn't exit within 2.5s, escalate.
      try { worker.send({ type: 'cancel' }); } catch {}
      setTimeout(() => {
        if (!worker.killed && activeLaunches.has(launchId)) {
          try { worker.kill('SIGKILL'); } catch {}
        }
      }, 2500);
    } else {
      // No live worker — either the launch already finished, or it hasn't
      // forked yet (the POST handler awaits between issuing the launchId and
      // forking). Emit close so the UI flips out of `cancelling`, but KEEP
      // the flag for a grace window so the pre-fork check in the launch
      // route still sees it — deleting it here was a race that let the
      // download proceed to completion after the user hit Stop. The timer
      // reaps the flag for launchIds that were already terminal.
      emit(launchId, 'close', { code: 'cancelled' });
      setTimeout(() => cancelledLaunches.delete(launchId), 30000);
    }
    res.json({ ok: true, queued: !!worker });
  });

  // Cancel an in-progress modpack install (Browse pre-install, install-into-
  // profile, or modpack update). Keyed by the sessionId the frontend tracks on
  // the `modpack_install_<sessionId>` channel. Two backends:
  //   - worker-backed (Browse pre-install): kill the launch worker exactly like
  //     a launch cancel; its exit handler wipes the partial instance and emits
  //     the `cancelled` event once the worker (and its file locks) is gone.
  //   - direct (install-into-profile / update): flip the cancel token so the
  //     download loop bails; its .catch emits `cancelled`.
  app.delete('/api/launcher/modpack-install/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const entry = activeModpackInstalls.get(sessionId);
    if (!entry) {
      // Nothing in flight (already finished, or never started). Still emit
      // `cancelled` so a UI sitting in a stale "cancelling" state resets.
      emitModpack(sessionId, 'cancelled', {});
      return res.json({ ok: true, found: false });
    }
    if (entry.launchId) {
      cancelledLaunches.add(entry.launchId);
      const lentry = activeLaunches.get(entry.launchId);
      const worker = lentry && lentry.worker;
      if (worker && !worker.killed) {
        try { worker.send({ type: 'cancel' }); } catch {}
        setTimeout(() => {
          if (!worker.killed && activeLaunches.has(entry.launchId)) {
            try { worker.kill('SIGKILL'); } catch {}
          }
        }, 2500);
      }
    } else if (entry.token) {
      entry.token.cancelled = true;
    }
    res.json({ ok: true, found: true });
  });
}

// Fork the worker subprocess and wire its IPC events back to the socket.
// `entry.worker` is the ChildProcess; we stash it under activeLaunches so the
// DELETE handler can find it. `entry.jvmPid` may be set later when the worker
// sends `jvm_started` — currently we let the worker handle JVM kill itself on
// cancel, but the field is here so the parent can SIGKILL the JVM directly if
// the worker becomes unresponsive.
// Accumulate play time onto an instance in the profile registry and stamp
// lastPlayed. Runs in the parent (which owns the registry); fired from the
// launch worker's launched→close window in forkLaunchWorker. Best-effort.
async function recordInstancePlaytime(instanceId, ms) {
  if (!instanceId || !(ms > 0)) return;
  try {
    const reg = await readProfileRegistry();
    const inst = reg.instances.find(i => i.id === instanceId);
    if (!inst) return;
    inst.playtimeMs = (inst.playtimeMs || 0) + ms;
    inst.lastPlayed = Date.now();
    await writeProfileRegistry(reg);
    if (io) io.emit('instances_changed');
  } catch (err) {
    console.warn('[launcher] recordPlaytime failed:', err.message);
  }
}

function forkLaunchWorker(payload) {
  const { fork } = require('child_process');
  const path = require('path');
  const workerPath = path.join(__dirname, 'launcher-worker.js');
  const worker = fork(workerPath, [], {
    // Pipe so we capture stdio in the parent's logs if the worker prints
    // anything outside of our IPC channel (panic, native crash, etc).
    silent: true,
  });

  activeLaunches.set(payload.launchId, { worker, cleanupInstanceId: payload.cleanupInstanceId || null });

  // Full pre-install runs through the same worker/runLaunch path (so it's
  // cancellable and out-of-process like a normal launch), but the Browse UI
  // tracks it on the `modpack_install_<sessionId>` socket channel. When a
  // modpackSessionId is present we translate the worker's launch events onto
  // that channel instead of `launcher_<launchId>` so the existing install card
  // lights up unchanged: status→status, progress→progress, close→done,
  // error→error, and everything else (log, launched, mod_sync) is dropped.
  const routeEvent = (launchId, event, data) => {
    if (!payload.modpackSessionId) { _emit(launchId, event, data); return; }
    if (event === 'status' || event === 'progress') {
      emitModpack(payload.modpackSessionId, event, data);
    } else if (event === 'close') {
      // A cancelled close (user clicked Stop) surfaces as a distinct `cancelled`
      // event so the UI tears the install card down quietly instead of flashing
      // a bogus "install complete" / Play-now toast.
      emitModpack(payload.modpackSessionId, data && data.code === 'cancelled' ? 'cancelled' : 'done', data);
    } else if (event === 'error') {
      emitModpack(payload.modpackSessionId, 'error', data);
    }
    // log / launched / mod_sync are noise for the install card — ignore.
  };

  worker.stdout?.on('data', (d) => process.stdout.write(`[launcher-worker ${payload.launchId.slice(0,8)}] ${d}`));
  worker.stderr?.on('data', (d) => process.stderr.write(`[launcher-worker ${payload.launchId.slice(0,8)}] ${d}`));

  worker.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'event') {
      // Generic event forwarding — { kind: 'event', launchId, event, ...data }
      const { kind, ...rest } = msg;
      const { launchId, event, ...data } = rest;
      // A cancelled close for a modpack pre-install is deferred to the worker's
      // exit handler: it must wipe the partial instance BEFORE the UI hears
      // `cancelled` (and refetches), otherwise the half-installed instance flashes
      // back as a broken card. Don't route it and don't mark it terminal here.
      const deferCancelClose = payload.modpackSessionId && event === 'close'
        && data && data.code === 'cancelled';
      // Game-time tracking (real game launches only — never modpack pre-installs).
      // Stamp a start on `launched`; on a genuine `close` (not cancel/prepare),
      // add the elapsed time to the instance, unless recording is disabled.
      if (!payload.modpackSessionId) {
        const entry = activeLaunches.get(payload.launchId);
        if (event === 'launched' && entry) {
          entry.playStart = Date.now();
        } else if (event === 'close' && entry && entry.playStart
            && data && data.code !== 'cancelled' && data.code !== 'prepared'
            && payload.launchArgs?.settings?.recordPlaytime !== false) {
          recordInstancePlaytime(payload.launchArgs?.instance?.id, Date.now() - entry.playStart);
          entry.playStart = null;
        }
      }
      // Track terminal events so the worker.on('exit') handler below doesn't
      // synthesize a second close/error after we already forwarded one. Same
      // launchId could get a "close" → IPC exit → exit handler racing.
      if (!deferCancelClose && (event === 'close' || event === 'error')) {
        const entry = activeLaunches.get(payload.launchId);
        if (entry) entry.terminalEmitted = true;
      }
      if (deferCancelClose) return;
      routeEvent(launchId, event, data);
    } else if (msg.kind === 'jvm_started') {
      const entry = activeLaunches.get(payload.launchId);
      if (entry) entry.jvmPid = msg.pid;
    } else if (msg.kind === 'persist_account') {
      // The worker refreshed the Microsoft token mid-launch and wants the
      // parent to persist it. Best-effort write; failures are logged.
      writeAccounts(msg.accountsDoc).catch(err =>
        console.warn('[launcher] persist_account failed:', err.message),
      );
    } else if (msg.kind === 'persist_settings') {
      writeSettings(msg.settings).catch(err =>
        console.warn('[launcher] persist_settings failed:', err.message),
      );
    }
  });

  worker.on('exit', async (code, signal) => {
    const wasCancelled = cancelledLaunches.has(payload.launchId);
    const entry = activeLaunches.get(payload.launchId);
    const alreadyEmittedTerminal = entry && entry.terminalEmitted;
    const cleanupInstanceId = entry && entry.cleanupInstanceId;
    activeLaunches.delete(payload.launchId);
    cancelledLaunches.delete(payload.launchId);
    if (payload.modpackSessionId) activeModpackInstalls.delete(payload.modpackSessionId);
    if (wasCancelled) {
      // Cancel path. The worker (and its file locks) is gone now, so wipe the
      // partially-installed instance the pre-install registered up-front before
      // telling the UI — otherwise the broken instance flashes back as a card.
      if (cleanupInstanceId) {
        try { await removeInstanceCompletely(cleanupInstanceId); }
        catch (e) { console.warn('[launcher] cancel cleanup failed:', e.message); }
      }
      // The close event was deferred until the worker actually died. Emit it now
      // so the UI flips back to idle (unless the worker already forwarded one).
      if (!alreadyEmittedTerminal) routeEvent(payload.launchId, 'close', { code: 'cancelled' });
      return;
    }
    if (alreadyEmittedTerminal) {
      // Worker forwarded its own close/error before exiting — nothing more
      // to do, the UI is already in the right state.
      return;
    }
    // If the worker died abnormally (signal kill or non-zero exit) without
    // a prior `close`/`error` IPC event, the UI would otherwise sit on a
    // running-state forever. Emit a synthetic error so it resets.
    if (code !== 0 && code !== null) {
      routeEvent(payload.launchId, 'error', {
        message: `Launcher worker exited unexpectedly (code ${code}${signal ? `, signal ${signal}` : ''})`,
      });
    } else if (signal && signal !== 'SIGTERM') {
      routeEvent(payload.launchId, 'error', {
        message: `Launcher worker was terminated (${signal})`,
      });
    }
  });

  worker.on('error', (err) => {
    activeLaunches.delete(payload.launchId);
    cancelledLaunches.delete(payload.launchId);
    if (payload.modpackSessionId) activeModpackInstalls.delete(payload.modpackSessionId);
    routeEvent(payload.launchId, 'error', { message: err.message || String(err) });
  });

  // Kick off the launch. Done after the listeners are attached so we don't
  // miss any synchronous early events the worker might emit (unlikely with
  // IPC, but cheap to be careful).
  try {
    worker.send({ type: 'init', payload });
  } catch (err) {
    activeLaunches.delete(payload.launchId);
    routeEvent(payload.launchId, 'error', { message: 'Failed to send init to worker: ' + err.message });
    try { worker.kill('SIGKILL'); } catch {}
  }
}

async function readServerPort(serverId) {
  try {
    const propsPath = path.join(INSTANCES_DIR, serverId, 'server.properties');
    const content = await fs.readFile(propsPath, 'utf8');
    const m = content.match(/^server-port\s*=\s*(\d+)/m);
    if (m) return parseInt(m[1], 10);
  } catch {}
  return 25565;
}

function emit(launchId, event, data = {}) {
  _emit(launchId, event, data);
}

function emitModpack(sessionId, event, data = {}) {
  if (io) io.emit(`modpack_install_${sessionId}`, { event, ...data });
}

// ─── Per-version Java resolution ─────────────────────────────────────
// The exact Java major a given MC version wants, straight from Mojang's
// version manifest (vJson.javaVersion.majorVersion) — covers snapshots and
// future versions without code changes. Falls back to the heuristic table in
// java-pool.js when offline. Cached per MC version for the process lifetime.
const MOJANG_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const _mojangJavaCache = new Map();
async function mojangRequiredJavaMajor(mcVersion) {
  if (_mojangJavaCache.has(mcVersion)) return _mojangJavaCache.get(mcVersion);
  try {
    const manRes = await fetch(MOJANG_MANIFEST_URL);
    if (manRes.ok) {
      const man = await manRes.json();
      const entry = (man.versions || []).find(v => v.id === mcVersion);
      if (entry && entry.url) {
        const vRes = await fetch(entry.url);
        if (vRes.ok) {
          const vJson = await vRes.json();
          const major = vJson?.javaVersion?.majorVersion;
          if (Number.isInteger(major) && major >= 8) {
            _mojangJavaCache.set(mcVersion, major);
            return major;
          }
        }
      }
    }
  } catch {}
  // Offline / unknown version — heuristic bucket. Not cached so a later launch
  // with network back gets Mojang's real answer.
  return javaPool.requiredJavaMajor(mcVersion);
}

// Pick the java executable for a launch. Order:
//   1. Per-instance choice — 'auto', 'jdk-<major>' (managed pool), or an
//      absolute path. A broken custom path falls through to auto with a log
//      line rather than failing the launch.
//   2. No instance choice → legacy global settings.javaPath if set.
//   3. Auto: required major from Mojang → managed pool hit → system Java iff
//      its major matches exactly → download the JDK from Adoptium into the
//      shared pool, streaming progress onto the launch channel.
async function resolveLauncherJava({ launchId, instance, settings, version }) {
  const log = (m) => emit(launchId, 'log', { message: `[java] ${m}\n` });
  const choice = (instance && typeof instance.java === 'string' ? instance.java.trim() : '');

  if (choice && choice !== 'auto' && !/^jdk-\d+$/.test(choice)) {
    if (fs.existsSync(choice)) { log(`Using this instance's custom Java: ${choice}`); return choice; }
    log(`Custom Java path not found (${choice}) — falling back to automatic selection.`);
  } else if (!choice) {
    // Instances that never picked anything keep honouring the old global
    // override so existing setups don't change behaviour underneath the user.
    const legacy = settings?.javaPath && settings.javaPath.trim();
    if (legacy) {
      if (fs.existsSync(legacy)) { log(`Using Java from launcher settings: ${legacy}`); return legacy; }
      log(`Configured Java path not found (${legacy}) — falling back to automatic selection.`);
    }
  }

  let major;
  const pooledPick = choice.match(/^jdk-(\d+)$/);
  if (pooledPick) {
    major = parseInt(pooledPick[1], 10);
    log(`Instance is pinned to Java ${major}.`);
  } else {
    major = await mojangRequiredJavaMajor(version);
    log(`Minecraft ${version} needs Java ${major}.`);
    // Auto mode may use the system Java, but only on an exact major match —
    // "newer is fine" is exactly what breaks older Forge versions.
    if (!javaPool.findManagedJava(major)) {
      const sys = getJavaPath ? getJavaPath() : null;
      if (sys && sys !== 'java' && javaPool.getJavaVersionForPath(sys) === major) {
        log(`Using system Java ${major}: ${sys}`);
        return sys;
      }
    }
  }

  const managed = javaPool.findManagedJava(major);
  if (managed) {
    log(`Using managed Java ${major}: ${managed}`);
    return managed;
  }

  emit(launchId, 'status', { message: `Downloading Java ${major}…` });
  let lastShown = -10;
  try {
    const installed = await javaPool.ensureManagedJavaSingleFlight(major, (p) => {
      if (p.phase === 'download' && typeof p.percent === 'number') {
        if (p.percent >= lastShown + 5) {
          lastShown = p.percent;
          emit(launchId, 'status', { message: `Downloading Java ${major}… ${p.percent}%` });
        }
      } else if (p.phase === 'extract') {
        emit(launchId, 'status', { message: `Installing Java ${major}…` });
      }
    });
    log(`Installed Java ${major} to ${installed}`);
    return installed;
  } catch (err) {
    // Download failed (offline?). A wrong-major system Java is still a better
    // bet than no Java at all — most version mismatches at least print a
    // readable error in the game log.
    const sys = getJavaPath ? getJavaPath() : null;
    if (sys && sys !== 'java') {
      log(`Java ${major} download failed (${err.message}) — trying system Java instead.`);
      return sys;
    }
    throw new Error(`Minecraft ${version} needs Java ${major}, which isn't installed, and the download failed: ${err.message}`);
  }
}

// ─── Custom launch hooks (Settings → Minecraft) ──────────────────────────────
// Prism-Launcher-style pre-launch / post-exit shell commands plus user-defined
// environment variables. The launch worker is a dedicated per-launch process,
// so the env we build here is isolated to this one launch. The INST_* tokens
// mirror Prism's substitution variables, exposed as env vars so existing
// scripts port over verbatim.
function buildHookEnv({ instance, profileRoot, javaPath, gameEnv }) {
  const env = { ...process.env };
  for (const e of (Array.isArray(gameEnv) ? gameEnv : [])) {
    if (e && typeof e.name === 'string' && e.name.trim()) {
      env[e.name.trim()] = e.value == null ? '' : String(e.value);
    }
  }
  env.INST_NAME = instance.displayName || instance.id || '';
  env.INST_ID = instance.id || '';
  env.INST_DIR = profileRoot;
  env.INST_MC_DIR = profileRoot;
  env.INST_JAVA = javaPath || '';
  return env;
}

// Run a user shell command (pre-launch / post-exit), streaming its output into
// the launch log. Resolves with the process exit code; rejects only when the
// shell itself can't spawn. The caller decides whether a non-zero exit is fatal
// (pre-launch aborts the launch, like Prism; post-exit is best-effort).
function runHookCommand({ cmd, env, launchId, label }) {
  return new Promise((resolve, reject) => {
    if (!cmd || !String(cmd).trim()) return resolve(0);
    emit(launchId, 'status', { message: `Running ${label}…` });
    emit(launchId, 'log', { message: `[${label}] $ ${cmd}\n` });
    const child = exec(String(cmd), { env, windowsHide: true });
    child.stdout?.on('data', (d) => emit(launchId, 'log', { message: String(d) }));
    child.stderr?.on('data', (d) => emit(launchId, 'log', { message: String(d) }));
    child.on('error', reject);
    child.on('close', (code) => {
      emit(launchId, 'log', { message: `[${label}] exited with code ${code == null ? 0 : code}\n` });
      resolve(code == null ? 0 : code);
    });
  });
}

async function runLaunch({ launchId, instance, account, accountsDoc, syncServer, settings, quickPlayHost, quickPlayWorld, depAttempted, prepareOnly, modpackInstall, elybyLaunch }) {
  const { loader, version, id: instanceId } = instance;
  const profileRoot = instanceDir(instanceId);
  await fs.ensureDir(profileRoot);
  activeLaunches.set(launchId, true);
  // Early bail if already cancelled before we even started — emit close so the
  // UI's 'cancelling' state knows we're done and resets to idle.
  if (_isCancelled(launchId)) {
    _clearCancel(launchId);
    activeLaunches.delete(launchId);
    emit(launchId, 'close', { code: 'cancelled' });
    return;
  }
  // Mod IDs we've already tried to auto-install for this launchId — prevents
  // an infinite retry loop if Modrinth doesn't have the mod or the install
  // doesn't satisfy the missing dep (e.g., wrong projectId match).
  const triedIds = depAttempted instanceof Set ? depAttempted : new Set();

  // Branch by account type. The ONLY place Ely.by skins touch the launch is the
  // offline path, gated on `elybyLaunch` (resolved in the parent before fork).
  // Microsoft is never given the authlib-injector agent — keeping the agent
  // concentrated to this one offline branch is what prevents a skins change from
  // ever touching a premium launch (risk callout #2).
  let authorization;
  let elybyAgentArgs = [];
  if (account.type === 'offline') {
    authorization = {
      access_token: '0',
      client_token: crypto.randomUUID(),
      // When launching with Ely.by skins, present the Ely.by UUID so the skin
      // resolves in-game (on servers that run authlib-injector). Otherwise the
      // standard offline (MD5) UUID.
      uuid: (elybyLaunch && elybyLaunch.profileUuid) || account.uuid,
      name: account.username,
      user_properties: '{}',
      meta: { type: 'mojang', demo: false },
    };
    if (elybyLaunch && elybyLaunch.jarPath) {
      elybyAgentArgs = buildElyByAgentArgs(elybyLaunch);
    }
  } else {
    emit(launchId, 'status', { message: 'Refreshing Microsoft session…' });
    try {
      const auth = new Auth({ client_id: AZURE_CLIENT_ID, redirect: 'http://localhost' });
      const mc = await msmc.mcTokenToolbox.fromToken(auth, account.mcToken, true);
      authorization = mc.mclc(true);
      account.mcToken = mc.getToken(true);
      await writeAccounts(accountsDoc);
    } catch (err) {
      throw new Error('Microsoft session expired. Re-add the account. (' + err.message + ')');
    }
  }

  // Optional: sync client mods from a MineDash server. Requires loader/version to match.
  if (syncServer) {
    if (syncServer.type !== loader || syncServer.version !== version) {
      emit(launchId, 'log', { message: `[mod sync] Server loader/version mismatch — skipped.` });
    } else {
      emit(launchId, 'status', { message: `Syncing client mods from ${syncServer.name}…` });
      await syncClientMods(launchId, syncServer, profileRoot);
    }
  }

  // Ship Ely.by skins to every modded client, no login required. CustomSkinLoader
  // resolves skins by username, so offline accounts render skins on offline-mode
  // servers (which the authlib-injector login path can't do). Runs after the mod
  // sync so the cleanup pass has already happened; it registers CSL in
  // client-extras so future syncs leave it alone. Best-effort — a failure here
  // must never block a launch.
  try {
    await ensureClientSkinMod({
      profileRoot, loader, version,
      onStatus: (m) => emit(launchId, 'status', { message: m }),
      onLog: (msg) => emit(launchId, 'log', { message: msg }),
    });
  } catch (err) {
    emit(launchId, 'log', { message: `[skins] CustomSkinLoader setup skipped: ${err.message}` });
  }

  // Resolve Java early — NeoForge needs it to run its headless installer.
  // Per-instance choice → managed pool matching the MC version (auto-downloads
  // the right JDK from Adoptium when missing) → system Java fallbacks.
  const javaPath = await resolveLauncherJava({ launchId, instance, settings, version });

  let versionCustom;
  let forgeInstaller;
  let neoForgeJvmArgs = null;
  if (loader === 'fabric') {
    emit(launchId, 'status', { message: 'Installing Fabric loader…' });
    versionCustom = await installFabricProfile(version, profileRoot);
  } else if (loader === 'forge') {
    emit(launchId, 'status', { message: 'Downloading Forge installer…' });
    forgeInstaller = await downloadForgeInstaller(version, profileRoot, launchId);
  } else if (loader === 'neoforge') {
    // MCLC's `opts.forge` path only knows about `net.minecraftforge:forge` libraries
    // — it silently mangles NeoForge's `net.neoforged:neoforge` JSON and the game
    // never launches. So we run NeoForge's own `--installClient` to produce a real
    // version JSON under `versions/neoforge-<x>/` and launch it like Fabric: as a
    // custom version (opts.version.custom), without setting opts.forge.
    emit(launchId, 'status', { message: 'Downloading NeoForge installer…' });
    const installerPath = await downloadNeoForgeInstaller(version, profileRoot, launchId);
    emit(launchId, 'status', { message: 'Installing NeoForge (this may take a minute)…' });
    versionCustom = await installNeoForgeClient(installerPath, profileRoot, javaPath, launchId);
    // MCLC's getLaunchOptions only processes arguments.game; it ignores
    // arguments.jvm entirely. NeoForge ships dozens of REQUIRED JVM args there
    // (-p modulepath, --add-opens, -DignoreList, -DlibraryDirectory…) without
    // which the BootstrapLauncher can't find its modules and FML aborts with
    // "Your NeoForge installation is corrupted". Parse them ourselves and feed
    // them in via opts.customArgs, which MCLC does concat into its JVM args.
    neoForgeJvmArgs = await buildNeoForgeJvmArgs(versionCustom, profileRoot);
  }

  emit(launchId, 'status', { message: 'Preparing Minecraft…' });

  const launcher = new Client();
  activeLaunches.set(launchId, launcher);

  // Per-instance heap override wins over the global ramGb setting; fall back
  // to the global default when this instance has no explicit allocation.
  const ramGb = (instance && typeof instance.ram === 'number' && instance.ram >= 1)
    ? instance.ram
    : (settings?.ramGb || 4);
  const ramStr = String(ramGb) + 'G';
  // Per-instance overrides win over the global launcher settings for everything
  // the launch pipeline reads below (window, Tweaks native libs, pre/post-launch
  // commands, env vars). Computed once here so the normal launch and the
  // dep-crash retry (both call runLaunch with the same instance+settings) stay
  // consistent. The frontend-consumed keys (console/afterLaunch/quitOnGameClose)
  // are merged client-side instead — they never reach this worker.
  const effSettings = mergeInstanceOverrides(settings, instance?.overrides);
  const opts = {
    authorization,
    root: profileRoot,
    version: { number: version, type: 'release' },
    memory: { max: ramStr, min: ramStr },
    javaPath,
    window: {
      width:  String(effSettings?.windowWidth  || 925),
      height: String(effSettings?.windowHeight || 530),
      fullscreen: !!effSettings?.fullscreen,
    },
  };
  if (versionCustom) opts.version.custom = versionCustom;
  if (forgeInstaller) opts.forge = forgeInstaller;
  // Tweaks → system native libraries. LWJGL3 (MC 1.13+) reads these system
  // properties to load a specific GLFW / OpenAL binary instead of the one mclc
  // extracted from the natives jar. Advanced opt-in (Settings → Minecraft →
  // Tweaks); only added when the toggle is on AND a path is provided.
  const nativeLibArgs = [];
  if (effSettings?.useSystemGlfw && effSettings.glfwPath && effSettings.glfwPath.trim()) {
    nativeLibArgs.push(`-Dorg.lwjgl.glfw.libname=${effSettings.glfwPath.trim()}`);
  }
  if (effSettings?.useSystemOpenal && effSettings.openalPath && effSettings.openalPath.trim()) {
    nativeLibArgs.push(`-Dorg.lwjgl.openal.libname=${effSettings.openalPath.trim()}`);
  }
  // customArgs gets the Ely.by authlib-injector agent (if any) PLUS NeoForge's
  // required JVM args (if any) PLUS any system-native-lib overrides. mclc concats
  // opts.customArgs into the JVM args. The agent is prepended so it registers
  // ahead of NeoForge's module path.
  const customArgs = [...elybyAgentArgs, ...(neoForgeJvmArgs || []), ...nativeLibArgs];
  if (customArgs.length > 0) opts.customArgs = customArgs;
  // Guardrail: the authlib-injector agent must appear iff we resolved an Ely.by
  // skins bundle for this (offline) launch. Throws loud otherwise so a builder
  // bug can never silently break a Microsoft launch (risk callouts #1 & #2).
  assertAgentArgsGate(elybyAgentArgs.length > 0, opts.customArgs);
  // Diagnostic: surface the resolved Ely.by-skins state into the launch log so
  // we can confirm (a) the agent is actually injected and (b) which UUID the
  // game is launched with. The [authlib-injector] banner that follows in the
  // game's own stdout confirms the agent initialised against Ely.by.
  emit(launchId, 'log', {
    message: `[minedash] Ely.by agent: ${elybyAgentArgs.length ? 'INJECTED' : 'not injected'}; ` +
      `launch uuid=${authorization.uuid}; jvm agent args=${JSON.stringify(elybyAgentArgs)}\n`,
  });
  if (quickPlayHost) {
    opts.quickPlay = { type: 'multiplayer', identifier: quickPlayHost };
  } else if (quickPlayWorld) {
    // Launch straight into a singleplayer world (Worlds → Join). mclc passes
    // --quickPlaySingleplayer <folder>; ignored by MC versions older than 1.20.
    opts.quickPlay = { type: 'singleplayer', identifier: quickPlayWorld };
  }

  // Buffer game output so we can scan it for dep-crash signatures on close.
  // Capped at ~200 KB to keep memory steady on long sessions.
  let logBuffer = '';
  const appendLogBuf = (s) => {
    logBuffer += s;
    if (logBuffer.length > 200_000) logBuffer = logBuffer.slice(-100_000);
  };

  launcher.on('debug', (m) => {
    const s = String(m);
    appendLogBuf(s);
    emit(launchId, 'log', { message: s });
  });
  launcher.on('data',  (m) => {
    const s = String(m);
    appendLogBuf(s);
    emit(launchId, 'log', { message: s });
  });
  launcher.on('progress', (p) => emit(launchId, 'progress', { type: p.type, task: p.task, total: p.total }));
  // Intentionally NOT forwarding `download-status` (per-file events) to the UI —
  // they fire ~100 events/sec with long filenames and just produce visual noise.
  launcher.on('close', async (code) => {
    // Prepare-only launches kill the JVM the instant it spawns (we only wanted
    // the downloads), and emit their own terminal event after the modpack
    // install runs. So ignore mclc's close here — running dep-crash recovery or
    // emitting a second close would corrupt the prepare flow.
    if (prepareOnly) return;
    const tracked = childMap.get(launchId);
    if (tracked) _untrackChild(tracked);
    childMap.delete(launchId);
    // If the user cancelled, the cancel endpoint set the flag but didn't emit
    // close — emit it now that mclc has actually finished and the JVM child
    // (if any) has exited. This is what flips the UI out of 'cancelling'.
    if (_isCancelled(launchId)) {
      _clearCancel(launchId);
      activeLaunches.delete(launchId);
      emit(launchId, 'close', { code: 'cancelled' });
      return;
    }
    // Try to recover from a dep-crash before signalling close: if the game
    // exited because of "Mod X requires Y", install Y from Modrinth and retry.
    try {
      if (hasDependencyCrashFn && hasDependencyCrashFn(logBuffer)) {
        const allMissing = (parseMissingModIdsFn ? parseMissingModIdsFn(logBuffer) : []);
        const newOnes = allMissing.filter(id => !triedIds.has(id));
        if (newOnes.length > 0) {
          emit(launchId, 'status', { message: `Missing client mods detected: ${newOnes.join(', ')}. Installing…` });
          const installed = await installMissingClientMods({
            profileRoot, loader, version,
            missingIds: newOnes,
            onLog: (msg) => emit(launchId, 'log', { message: msg }),
          });
          newOnes.forEach(id => triedIds.add(id));
          if (installed.length > 0) {
            emit(launchId, 'status', { message: `Installed ${installed.length} mod(s) (${installed.map(i => i.title).join(', ')}). Restarting…` });
            activeLaunches.delete(launchId);
            // Restart with the same launchId so the UI stays on this session.
            // Pass syncServer:null — re-syncing from the server would wipe the
            // client-only deps we just installed.
            runLaunch({
              launchId, instance, account, accountsDoc,
              syncServer: null, settings, quickPlayHost, quickPlayWorld,
              depAttempted: triedIds, elybyLaunch,
            }).catch(err => emit(launchId, 'error', { message: err.message || String(err) }));
            return;
          }
        }
      }
    } catch (err) {
      emit(launchId, 'log', { message: `[Auto-install ERR] ${err.message || err}` });
    }
    // Post-exit command — runs after the game has actually exited (not on cancel
    // or a dep-crash retry, both of which returned above). Best-effort: a failure
    // here is logged but never blocks the close signal.
    if (effSettings?.postExitCommand && effSettings.postExitCommand.trim()) {
      try {
        const env = buildHookEnv({ instance, profileRoot, javaPath, gameEnv: effSettings?.gameEnv });
        await runHookCommand({ cmd: effSettings.postExitCommand, env, launchId, label: 'post-exit command' });
      } catch (err) {
        emit(launchId, 'log', { message: `[post-exit command] failed: ${err.message || err}\n` });
      }
    }
    emit(launchId, 'close', { code });
    activeLaunches.delete(launchId);
  });

  try {
    // User-defined env vars + Prism-style INST_* tokens, shared by the launch
    // hooks below and the game JVM. Injecting them onto this worker's
    // process.env means the mclc-spawned child inherits them (the worker is
    // dedicated to this one launch, so it's safe to mutate the env here).
    const hookEnv = buildHookEnv({ instance, profileRoot, javaPath, gameEnv: effSettings?.gameEnv });
    for (const e of (Array.isArray(effSettings?.gameEnv) ? effSettings.gameEnv : [])) {
      if (e && typeof e.name === 'string' && e.name.trim()) {
        process.env[e.name.trim()] = e.value == null ? '' : String(e.value);
      }
    }
    // Pre-launch command — skipped for prepare-only Browse installs (those never
    // start the game). A non-zero exit aborts the launch, matching Prism.
    if (!prepareOnly && effSettings?.preLaunchCommand && effSettings.preLaunchCommand.trim()) {
      const code = await runHookCommand({ cmd: effSettings.preLaunchCommand, env: hookEnv, launchId, label: 'pre-launch command' });
      if (code !== 0) throw new Error(`Pre-launch command failed (exit code ${code}) — launch aborted.`);
    }

    const child = await launcher.launch(opts);
    if (!child) throw new Error('Launcher returned no process.');
    // Catch the case where Stop was clicked while mclc was still downloading.
    // mclc has no abort mechanism, so the download had to finish — but the JVM
    // has only just spawned, so we kill it before it shows a window and emit
    // close so the UI can flip out of its 'cancelling' state.
    if (_isCancelled(launchId)) {
      try { child.kill('SIGTERM'); } catch {}
      _clearCancel(launchId);
      activeLaunches.delete(launchId);
      emit(launchId, 'close', { code: 'cancelled' });
      return;
    }

    // Full pre-install path: by here mclc has finished downloading the vanilla
    // client, libraries, natives and assets, and the loader install already ran
    // above — so the instance is now playable. We only wanted the downloads, so
    // kill the JVM before it paints a window, then (optionally) drop the
    // modpack's mods/overrides on top. We emit our own terminal event; the
    // mclc 'close' handler is a no-op under prepareOnly.
    if (prepareOnly) {
      try {
        if (process.platform === 'win32' && child.pid) {
          exec(`taskkill /F /T /PID ${child.pid}`, () => {});
        } else {
          child.kill('SIGKILL');
        }
      } catch {}
      try {
        if (modpackInstall && modpackInstall.url) {
          await installModpackIntoProfile({
            profileDir: profileRoot,
            ...modpackInstall,
            emitEvent: (event, data) => emit(launchId, event, data),
          });
        }
        emit(launchId, 'close', { code: 'prepared' });
      } catch (err) {
        emit(launchId, 'error', { message: err.message || String(err) });
      } finally {
        activeLaunches.delete(launchId);
      }
      return;
    }

    childMap.set(launchId, child);
    _trackChild(child);
    emit(launchId, 'launched', {});
  } catch (err) {
    activeLaunches.delete(launchId);
    // If the user cancelled, swallow whatever mclc threw and emit a clean
    // cancelled-close instead.
    if (_isCancelled(launchId)) {
      _clearCancel(launchId);
      emit(launchId, 'close', { code: 'cancelled' });
      return;
    }
    throw err;
  }
}

// Path to the per-profile manifest of mods that were installed for client-only
// reasons (auto-dep-installer, manual content browser). These are NOT mirrored
// from a server's mods folder and must survive the syncClientMods cleanup step.
function clientExtrasPath(profileRoot) {
  return path.join(profileRoot, '.minedash-client-extras.json');
}
async function readClientExtras(profileRoot) {
  try { return await fs.readJson(clientExtrasPath(profileRoot)); }
  catch { return { files: [] }; }
}
async function writeClientExtras(profileRoot, data) {
  try { await fs.writeJson(clientExtrasPath(profileRoot), data, { spaces: 2 }); } catch {}
}

// Sync the client's mods folder to match the server's exactly, by copying JARs
// directly from disk. This guarantees byte-identical mods on both sides — no
// "mismatched mod channel list" — regardless of whether the user opened the
// Mods tab (which is what populates Modrinth project IDs in .minedash-mods.json).
//
// Files listed in .minedash-client-extras.json are preserved during cleanup —
// they're client-only deps (like fancymenu requires melody) that the server
// will never have but the client absolutely needs.
async function syncClientMods(launchId, server, profileRoot) {
  if (server.type === 'vanilla') return;
  const sourceModsDir = path.join(INSTANCES_DIR, server.id, 'mods');
  if (!await fs.pathExists(sourceModsDir)) return;

  const targetModsDir = path.join(profileRoot, 'mods');
  await fs.ensureDir(targetModsDir);

  const sourceEntries = await fs.readdir(sourceModsDir);
  const sourceJars = sourceEntries.filter(f => f.endsWith('.jar')); // skip .disabled, .json, dot-files
  const sourceJarSet = new Set(sourceJars);

  const total = sourceJars.length;
  let current = 0;
  emit(launchId, 'status', { message: total === 0 ? 'No mods to sync' : `Syncing mods (0 / ${total})` });

  for (const jar of sourceJars) {
    current++;
    const src = path.join(sourceModsDir, jar);
    const dst = path.join(targetModsDir, jar);
    emit(launchId, 'status', { message: `Syncing mods (${current} / ${total})` });
    emit(launchId, 'mod_sync', { name: jar });

    try {
      // Skip when the destination already matches by size — copying every JAR
      // every launch would waste seconds on big modpacks. Size is a good-enough
      // signal: the server's mods folder is the canonical version and JARs are
      // immutable once written, so size collisions across different builds are
      // negligible.
      let needsCopy = true;
      if (await fs.pathExists(dst)) {
        const [srcStat, dstStat] = await Promise.all([fs.stat(src), fs.stat(dst)]);
        if (srcStat.size === dstStat.size) needsCopy = false;
      }
      if (needsCopy) {
        await fs.copy(src, dst, { overwrite: true });
      }
    } catch (err) {
      emit(launchId, 'mod_skip', { name: jar, reason: err.message });
    }
  }

  // Push any client-only mods the modpack importer stashed (mods we filtered
  // out of the server because they'd crash a dedicated JVM) into the client
  // profile, and remember them in client-extras so the cleanup below leaves
  // them alone.
  const extras = await readClientExtras(profileRoot);
  const extrasSet = new Set(extras.files || []);
  const stashDir = path.join(INSTANCES_DIR, server.id, '.minedash-client-mods');
  if (await fs.pathExists(stashDir)) {
    try {
      const stashed = (await fs.readdir(stashDir)).filter(f => f.endsWith('.jar'));
      const stashTotal = stashed.length;
      let stashCurrent = 0;
      for (const jar of stashed) {
        stashCurrent++;
        const src = path.join(stashDir, jar);
        const dst = path.join(targetModsDir, jar);
        emit(launchId, 'status', { message: `Installing client-only mods (${stashCurrent} / ${stashTotal})` });
        emit(launchId, 'mod_sync', { name: jar });
        try {
          let needsCopy = true;
          if (await fs.pathExists(dst)) {
            const [srcStat, dstStat] = await Promise.all([fs.stat(src), fs.stat(dst)]);
            if (srcStat.size === dstStat.size) needsCopy = false;
          }
          if (needsCopy) await fs.copy(src, dst, { overwrite: true });
          extrasSet.add(jar);
        } catch (err) {
          emit(launchId, 'mod_skip', { name: jar, reason: err.message });
        }
      }
      if (stashTotal > 0) {
        await writeClientExtras(profileRoot, { files: Array.from(extrasSet) });
      }
    } catch (err) {
      emit(launchId, 'log', { message: `[client-mods stash] read failed: ${err.message}` });
    }
  }

  // Remove any JAR in the client mods folder that no longer exists on the
  // server — except files we tagged as client-extras (which now includes any
  // stashed client-only mods we just installed).
  try {
    const present = await fs.readdir(targetModsDir);
    for (const f of present) {
      if (!f.endsWith('.jar')) continue;
      if (sourceJarSet.has(f)) continue;
      if (extrasSet.has(f)) continue;
      await fs.remove(path.join(targetModsDir, f));
    }
  } catch {}
}

// After a dep-crash, install the missing mods from Modrinth into the client
// profile's mods/ folder and record each install in .minedash-client-extras.json
// so subsequent syncClientMods runs don't wipe them.
async function installMissingClientMods({ profileRoot, loader, version, missingIds, onLog }) {
  if (!Array.isArray(missingIds) || missingIds.length === 0) return [];
  const targetDir = path.join(profileRoot, 'mods');
  await fs.ensureDir(targetDir);

  // 'fabric' as a dep ID on Fabric means Fabric API (a real Modrinth project),
  // not the Fabric loader itself. Same remapping the server-side installer uses.
  const MOD_ID_REMAP = { fabric: 'fabric-api' };
  const installed = [];
  const extras = await readClientExtras(profileRoot);
  const extrasFiles = new Set(extras.files || []);

  for (const rawId of missingIds) {
    const lookupId = MOD_ID_REMAP[rawId] || rawId;
    onLog?.(`[client-dep] Searching Modrinth for '${lookupId}'…\n`);
    try {
      // Strategy 1: direct slug lookup
      let project = null;
      const slugRes = await fetch(`${MODRINTH_LOOKUP_API}/project/${lookupId}`, { headers: MODRINTH_LOOKUP_HEADERS });
      if (slugRes.ok) project = await slugRes.json();

      // Strategy 2: search and pick the closest match
      if (!project) {
        const facets = [['project_type:mod']];
        if (version) facets.push([`versions:${version}`]);
        if (loader)  facets.push([`categories:${loader}`]);
        const params = new URLSearchParams({ query: lookupId, limit: '5', facets: JSON.stringify(facets) });
        const sRes = await fetch(`${MODRINTH_LOOKUP_API}/search?${params}`, { headers: MODRINTH_LOOKUP_HEADERS });
        if (sRes.ok) {
          const data = await sRes.json();
          const hit = (data.hits || []).find(h =>
            h.slug === lookupId || h.slug.includes(lookupId) || lookupId.includes(h.slug)
          ) || data.hits?.[0];
          if (hit) project = { id: hit.project_id, icon_url: hit.icon_url, title: hit.title };
        }
      }
      if (!project) { onLog?.(`[client-dep] Could not find '${lookupId}' on Modrinth.\n`); continue; }

      const vParams = new URLSearchParams();
      if (version) vParams.set('game_versions', JSON.stringify([version]));
      if (loader)  vParams.set('loaders',       JSON.stringify([loader]));
      const vRes = await fetch(`${MODRINTH_LOOKUP_API}/project/${project.id}/version?${vParams}`, { headers: MODRINTH_LOOKUP_HEADERS });
      if (!vRes.ok) { onLog?.(`[client-dep] No compatible version for '${lookupId}'.\n`); continue; }
      const versions = await vRes.json();
      if (!Array.isArray(versions) || versions.length === 0) {
        onLog?.(`[client-dep] No version of '${lookupId}' for ${loader} ${version}.\n`);
        continue;
      }
      const best = pickBestModrinthVersion(versions);
      if (!best) continue;
      const file = best.files.find(f => f.primary) || best.files[0];
      if (!file) continue;

      const dlRes = await fetch(file.url, { headers: MODRINTH_LOOKUP_HEADERS });
      if (!dlRes.ok) { onLog?.(`[client-dep] Download failed for '${lookupId}'.\n`); continue; }
      await fs.writeFile(path.join(targetDir, file.filename), Buffer.from(await dlRes.arrayBuffer()));
      extrasFiles.add(file.filename);
      installed.push({ id: rawId, filename: file.filename, title: project.title || lookupId });
      onLog?.(`[client-dep] ✓ Installed ${project.title || lookupId} (${file.filename})\n`);
    } catch (err) {
      onLog?.(`[client-dep] Error installing '${rawId}': ${err.message || err}\n`);
    }
  }

  if (installed.length > 0) {
    await writeClientExtras(profileRoot, { files: Array.from(extrasFiles) });
  }
  return installed;
}

// Ely.by skins for EVERYONE, no login required.
//
// The authlib-injector path (elybyLaunch) only renders a skin when the server
// already knows the player's real Ely.by UUID — which never happens for no-login
// offline accounts on an offline-mode server (the username-derived UUID is
// unknown to Ely.by). CustomSkinLoader sidesteps that entirely: it's a
// client-side mod that fetches skins BY USERNAME from Ely.by, so every player
// renders every other player's skin regardless of UUID or login. We ship it into
// every modded client profile at launch and register it in client-extras so
// syncClientMods' cleanup leaves it in place.
// Minimal but complete CustomSkinLoader config. Notes from reading CSL's source
// (config/Config.java, loader/JsonAPILoader.java, loader/MojangAPILoader.java):
//   - `loadlist` is the only field that must be set; every other setting falls
//     back to CSL's own `= true` field defaults, and CSL normalizes/rewrites this
//     file (adding version/buildNumber) on first launch. So we omit `version`
//     (it's a String, not an int) and the boolean toggles.
//   - ElyByAPI is a JsonAPILoader: it BAILS if `root` is empty, and the hardcoded
//     Ely.by root only applies to CSL's auto-generated default profile — not to a
//     loadlist entry we write. So `root` MUST be set explicitly here.
//   - MojangAPI auto-fills its api/session roots in init(), so name+type suffice.
const CUSTOM_SKIN_LOADER_CONFIG = {
  loadlist: [
    { name: 'ElyBy', type: 'ElyByAPI', root: 'http://skinsystem.ely.by/textures/' }, // resolves <root><username>
    { name: 'Mojang', type: 'MojangAPI' }, // fallback so premium accounts still resolve
  ],
};

// Loaders CustomSkinLoader publishes for on Modrinth. Quilt is served by the
// Fabric jar; forge/neoforge by the Universal/ForgeV3 jar.
const SKIN_MOD_LOADERS = new Set(['fabric', 'quilt', 'forge', 'neoforge']);

async function ensureClientSkinMod({ profileRoot, loader, version, onStatus, onLog }) {
  if (!loader || !SKIN_MOD_LOADERS.has(loader)) return; // vanilla has no mod loader
  const targetDir = path.join(profileRoot, 'mods');
  await fs.ensureDir(targetDir);

  // Resolve the right CustomSkinLoader build for this loader + MC version.
  const vParams = new URLSearchParams();
  if (version) vParams.set('game_versions', JSON.stringify([version]));
  vParams.set('loaders', JSON.stringify([loader]));
  const vRes = await fetch(`${MODRINTH_LOOKUP_API}/project/customskinloader/version?${vParams}`, { headers: MODRINTH_LOOKUP_HEADERS });
  if (!vRes.ok) throw new Error(`Modrinth returned ${vRes.status}`);
  const versions = await vRes.json();
  if (!Array.isArray(versions) || versions.length === 0) {
    onLog?.(`[skins] No CustomSkinLoader build for ${loader} ${version}.\n`);
    return;
  }
  const best = pickBestModrinthVersion(versions);
  const file = best && (best.files.find(f => f.primary) || best.files[0]);
  if (!file) return;

  const extras = await readClientExtras(profileRoot);
  const extrasFiles = new Set(extras.files || []);
  const beforeExtras = JSON.stringify(Array.from(extrasFiles));

  // Drop any stale CustomSkinLoader jar of a different version — two copies
  // loading at once crashes the game. Remove the file and its extras entry.
  for (const f of await fs.readdir(targetDir)) {
    if (/^CustomSkinLoader.*\.jar$/i.test(f) && f !== file.filename) {
      try { await fs.remove(path.join(targetDir, f)); } catch {}
      extrasFiles.delete(f);
    }
  }

  const dst = path.join(targetDir, file.filename);
  if (!await fs.pathExists(dst)) {
    onStatus?.('Installing skins support (CustomSkinLoader)…');
    const dlRes = await fetch(file.url, { headers: MODRINTH_LOOKUP_HEADERS });
    if (!dlRes.ok) throw new Error(`download failed (${dlRes.status})`);
    await fs.writeFile(dst, Buffer.from(await dlRes.arrayBuffer()));
    onLog?.(`[skins] ✓ Installed ${file.filename}\n`);
  }

  // Keep it out of syncClientMods' cleanup crosshairs.
  extrasFiles.add(file.filename);
  if (JSON.stringify(Array.from(extrasFiles)) !== beforeExtras) {
    await writeClientExtras(profileRoot, { files: Array.from(extrasFiles) });
  }

  // Point CustomSkinLoader at Ely.by (name-based). Write once; don't clobber a
  // user's hand-edited config on later launches.
  const cfgPath = path.join(profileRoot, 'CustomSkinLoader', 'CustomSkinLoader.json');
  if (!await fs.pathExists(cfgPath)) {
    await fs.ensureDir(path.dirname(cfgPath));
    await fs.writeJson(cfgPath, CUSTOM_SKIN_LOADER_CONFIG, { spaces: 2 });
    onLog?.(`[skins] Wrote Ely.by CustomSkinLoader config.\n`);
  }
}

async function installFabricProfile(mcVersion, profileRoot) {
  const r = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`);
  if (!r.ok) throw new Error(`Fabric meta returned ${r.status}`);
  const loaders = await r.json();
  if (!Array.isArray(loaders) || loaders.length === 0) {
    throw new Error('No Fabric loader available for Minecraft ' + mcVersion);
  }
  const pick = loaders.find(l => l.loader?.stable) || loaders[0];
  const loaderVersion = pick.loader.version;
  const profileName = `fabric-loader-${loaderVersion}-${mcVersion}`;

  const versionsDir = path.join(profileRoot, 'versions', profileName);
  const jsonPath = path.join(versionsDir, `${profileName}.json`);
  if (!await fs.pathExists(jsonPath)) {
    const pr = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVersion}/profile/json`);
    if (!pr.ok) throw new Error(`Fabric profile JSON returned ${pr.status}`);
    const profileJson = await pr.json();
    await fs.ensureDir(versionsDir);
    await fs.writeJson(jsonPath, profileJson);
  }
  return profileName;
}

// Download the Forge installer JAR for the given MC version (using the recommended
// Forge build from the promotions feed). Returns the absolute path so MCLC can run it.
async function downloadForgeInstaller(mcVersion, profileRoot, launchId) {
  const promoR = await fetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
  if (!promoR.ok) throw new Error(`Forge promotions returned ${promoR.status}`);
  const promos = (await promoR.json()).promos || {};
  const forgeVer = promos[`${mcVersion}-recommended`] || promos[`${mcVersion}-latest`];
  if (!forgeVer) throw new Error(`No Forge build for Minecraft ${mcVersion}`);

  const full = `${mcVersion}-${forgeVer}`;
  const cacheDir = path.join(profileRoot, 'forge-installers');
  await fs.ensureDir(cacheDir);
  const dest = path.join(cacheDir, `forge-${full}-installer.jar`);
  if (await fs.pathExists(dest)) return dest;

  emit(launchId, 'status', { message: `Downloading Forge ${forgeVer}…` });
  const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Forge installer download failed (${r.status}). URL: ${url}`);
  await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
  return dest;
}

// Download the NeoForge installer JAR. NeoForge versions are derived from MC versions:
// MC 1.21.1 → NeoForge 21.1.x (latest with that prefix), MC 1.20 → 20.0.x, etc.
async function downloadNeoForgeInstaller(mcVersion, profileRoot, launchId) {
  const m = mcVersion.match(/^1\.(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`Unsupported MC version for NeoForge: ${mcVersion}`);
  const major = m[1];
  const minor = m[2] || '0';
  const neoPrefix = `${major}.${minor}`;

  const listR = await fetch('https://maven.neoforged.net/api/maven/details/releases/net/neoforged/neoforge');
  if (!listR.ok) throw new Error(`NeoForge maven returned ${listR.status}`);
  const files = (await listR.json()).files || [];
  // Prefer stable releases over betas (e.g. "21.1.50" beats "21.1.49-beta"), then
  // newest semver. The naive split-by-dot-and-Number-cast trick produces NaN for
  // any segment containing a dash (every beta does), which makes Array.sort
  // unstable — so the picked version was effectively random.
  const isStable = (name) => !/[a-zA-Z]/.test(name);
  const semverParts = (name) => name
    .split('.')
    .map(seg => parseInt(seg, 10))   // "49-beta" → 49 (good enough for ordering)
    .map(n => Number.isFinite(n) ? n : 0);
  const matching = files
    .filter(f => f.type === 'DIRECTORY' && f.name.startsWith(neoPrefix + '.'))
    .map(f => f.name)
    .sort((a, b) => {
      const stableDelta = (isStable(b) ? 1 : 0) - (isStable(a) ? 1 : 0);
      if (stableDelta !== 0) return stableDelta;
      const pa = semverParts(a);
      const pb = semverParts(b);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pb[i] || 0) - (pa[i] || 0);
        if (d !== 0) return d;
      }
      return 0;
    });
  const neoVer = matching[0];
  if (!neoVer) throw new Error(`No NeoForge build for Minecraft ${mcVersion}`);

  const cacheDir = path.join(profileRoot, 'forge-installers');
  await fs.ensureDir(cacheDir);
  const dest = path.join(cacheDir, `neoforge-${neoVer}-installer.jar`);
  if (await fs.pathExists(dest)) return dest;

  emit(launchId, 'status', { message: `Downloading NeoForge ${neoVer}…` });
  const url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${neoVer}/neoforge-${neoVer}-installer.jar`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`NeoForge installer download failed (${r.status}). URL: ${url}`);
  await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
  return dest;
}

// Run the NeoForge installer in headless --installClient mode against the
// profile root. The installer drops a `versions/neoforge-<ver>/neoforge-<ver>.json`
// (plus libraries/) which MCLC can launch as a custom version — same shape as
// Fabric. Returns the version id (folder name) to pass as opts.version.custom.
//
// The installer also needs `launcher_profiles.json` to exist in the target dir
// (it refuses to install without one), so we stub a minimal file if missing.
async function installNeoForgeClient(installerPath, profileRoot, javaPath, launchId) {
  // Derive the expected version id from the installer filename:
  // "neoforge-21.1.50-installer.jar" → "neoforge-21.1.50"
  const installerName = path.basename(installerPath);
  const m = installerName.match(/^neoforge-(.+)-installer\.jar$/);
  if (!m) throw new Error(`Unexpected NeoForge installer filename: ${installerName}`);
  const versionId = `neoforge-${m[1]}`;

  const versionJsonPath = path.join(profileRoot, 'versions', versionId, `${versionId}.json`);

  // Cache: if a previous run already produced the version JSON, skip the installer
  // (it's slow and re-downloads MC + libraries on each invocation).
  if (await fs.pathExists(versionJsonPath)) return versionId;

  // The installer refuses to start without launcher_profiles.json — stub it.
  const lpPath = path.join(profileRoot, 'launcher_profiles.json');
  if (!await fs.pathExists(lpPath)) {
    await fs.writeJson(lpPath, { profiles: {}, settings: {}, version: 3 });
  }

  const java = javaPath || 'java';
  await new Promise((resolve, reject) => {
    const proc = spawn(java, ['-jar', installerPath, '--installClient', profileRoot], {
      cwd: profileRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Track so a cancel can SIGKILL it from the parent process if we're in
    // worker mode. Untrack on natural exit so the parent doesn't keep a dead
    // PID around.
    _trackChild(proc);
    proc.stdout.on('data', d => emit(launchId, 'log', { message: `[NeoForge installer] ${d}` }));
    proc.stderr.on('data', d => emit(launchId, 'log', { message: `[NeoForge installer] ${d}` }));
    proc.on('error', (err) => { _untrackChild(proc); reject(err); });
    proc.on('exit', code => {
      _untrackChild(proc);
      if (code === 0) resolve();
      else reject(new Error(`NeoForge installer exited with code ${code}`));
    });
  });

  if (!await fs.pathExists(versionJsonPath)) {
    throw new Error(`NeoForge installer finished but ${versionId}.json was not produced at ${versionJsonPath}`);
  }
  return versionId;
}

// Read the NeoForge version JSON and produce the JVM arguments NeoForge expects
// from a launcher (-p modulepath, --add-opens, -DignoreList, -DlibraryDirectory…),
// with rules filtered for the current OS and ${library_directory}/etc. placeholders
// substituted. The result is meant for `opts.customArgs` so MCLC concatenates it
// into the JVM command line.
//
// MCLC's getLaunchOptions only processes arguments.game; it never reads
// arguments.jvm. Without these args BootstrapLauncher can't find its modules and
// NeoForge fails with "Your NeoForge installation is corrupted".
async function buildNeoForgeJvmArgs(versionId, profileRoot) {
  const versionJsonPath = path.join(profileRoot, 'versions', versionId, `${versionId}.json`);
  let json;
  try { json = await fs.readJson(versionJsonPath); }
  catch { return []; }
  const jvmArgs = json?.arguments?.jvm;
  if (!Array.isArray(jvmArgs)) return [];

  const libraryDir = path.resolve(path.join(profileRoot, 'libraries'));
  const sep = process.platform === 'win32' ? ';' : ':';
  const osName = process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin' ? 'osx' : 'linux';

  const substitute = (s) => String(s)
    .replaceAll('${library_directory}', libraryDir)
    .replaceAll('${classpath_separator}', sep)
    .replaceAll('${version_name}', versionId)
    .replaceAll('${primary_jar_name}', `${versionId}.jar`);

  // Each `os` rule object can match by name, version regex, or arch.
  // We support the `name` check (the only one NeoForge actually uses today).
  const rulesAllow = (rules) => {
    if (!Array.isArray(rules) || rules.length === 0) return true;
    let allowed = false;
    for (const rule of rules) {
      const matches = !rule.os || !rule.os.name || rule.os.name === osName;
      if (rule.action === 'allow') allowed = matches ? true : allowed;
      else if (rule.action === 'disallow' && matches) return false;
    }
    return allowed;
  };

  const out = [];
  for (const entry of jvmArgs) {
    if (typeof entry === 'string') {
      out.push(substitute(entry));
    } else if (entry && typeof entry === 'object') {
      if (!rulesAllow(entry.rules)) continue;
      const value = entry.value;
      if (Array.isArray(value)) for (const v of value) out.push(substitute(v));
      else if (typeof value === 'string') out.push(substitute(value));
    }
  }
  return out;
}

// Download a Modrinth `.mrpack` file and extract its contents into the given
// profile directory. Skips files marked client-unsupported. Drops overrides/
// and client-overrides/ on top of the profile.
//
// Emits progress events via emitModpack(sessionId, …) when a sessionId is set:
//   - status   { message }      — phase change ("Downloading modpack", "Extracting overrides", …)
//   - progress { task, total }  — files completed so far
async function installModpackIntoProfile({ sessionId, profileDir, url, filename, projectId, iconUrl, title, versionId, versionNumber, previousFiles, emitEvent, cancelToken }) {
  await fs.ensureDir(profileDir);

  // Bail point for user-initiated cancellation. The download loop checks this
  // between files so a cancel stops within one file rather than after the whole
  // pack. Throws a tagged error the caller routes to a `cancelled` event.
  const bailIfCancelled = () => {
    if (cancelToken?.cancelled) {
      const e = new Error('Install cancelled');
      e.cancelled = true;
      throw e;
    }
  };

  // Progress sink. The normal (in-process) callers stream over the
  // `modpack_install_<sessionId>` socket channel via emitModpack. When this
  // runs inside the launcher worker (full pre-install path), io is null there,
  // so the caller passes `emitEvent` to route status/progress out over IPC and
  // the parent bridges them onto the same socket channel. Either way the
  // frontend's useModpackInstalls hook sees identical events.
  const emitFn = typeof emitEvent === 'function'
    ? emitEvent
    : (event, data) => { if (sessionId) emitModpack(sessionId, event, data); };

  const tempDir = path.join(profileDir, '.modpack-tmp');
  await fs.ensureDir(tempDir);
  const mrpackPath = path.join(tempDir, filename);

  try {
    emitFn('status', { message: 'Downloading modpack…' });
    const r = await fetch(url, { headers: MODRINTH_HEADERS });
    if (!r.ok) throw new Error(`Modpack download failed (${r.status})`);
    await fs.writeFile(mrpackPath, Buffer.from(await r.arrayBuffer()));

    const zip = new AdmZip(mrpackPath);
    const indexEntry = zip.getEntry('modrinth.index.json');
    if (!indexEntry) throw new Error('Invalid .mrpack — missing modrinth.index.json');
    const index = JSON.parse(indexEntry.getData().toString('utf8'));

    const installedFiles = [];
    // All relative paths (mods + overrides) the modpack writes into the profile.
    // Persisted on the install record so a later "delete modpack" can actually
    // remove every file the pack dropped — without this list there's no way to
    // tell a modpack mod from a manually-installed one and "delete" would
    // either be a no-op or a destructive nuke of the whole profile.
    const trackedPaths = [];
    const failed = [];

    // Pre-filter the file list so the progress total reflects what we'll actually download.
    const eligible = (index.files || []).filter(f => {
      const env = f.env || {};
      if (env.client === 'unsupported') return false;
      if (!f.downloads || f.downloads.length === 0) return false;
      const rel = String(f.path || '').replace(/^[/\\]+/, '');
      if (!rel || rel.includes('..')) return false;
      const target = path.join(profileDir, rel);
      return target.startsWith(profileDir);
    });

    // Count overrides so they're included in the total — for large packs they
    // matter (configs, scripts, resourcepacks bundled inside the .mrpack).
    const overrideEntries = zip.getEntries().filter(entry => {
      const name = entry.entryName.replace(/\\/g, '/');
      if (entry.isDirectory) return false;
      if (!name.startsWith('overrides/') && !name.startsWith('client-overrides/')) return false;
      const stripPrefix = name.startsWith('overrides/') ? 'overrides/' : 'client-overrides/';
      const rel = name.slice(stripPrefix.length);
      if (!rel || rel.includes('..')) return false;
      const out = path.join(profileDir, rel);
      return out.startsWith(profileDir);
    });

    const total = eligible.length + overrideEntries.length;
    let done = 0;
    emitFn('status', { message: 'Downloading mods…' });
    emitFn('progress', { task: 0, total });

    // Download each eligible file.
    for (const f of eligible) {
      bailIfCancelled();
      const targetRel = String(f.path).replace(/^[/\\]+/, '');
      const target = path.join(profileDir, targetRel);
      await fs.ensureDir(path.dirname(target));

      let ok = false;
      for (const dl of f.downloads) {
        try {
          const resp = await fetch(dl, { headers: MODRINTH_HEADERS });
          if (!resp.ok) continue;
          await fs.writeFile(target, Buffer.from(await resp.arrayBuffer()));
          ok = true;
          break;
        } catch {}
      }
      if (ok) {
        installedFiles.push(targetRel);
        trackedPaths.push(targetRel);
      } else failed.push(targetRel);
      done++;
      emitFn('progress', { task: done, total });
    }

    // Extract overrides/ and client-overrides/ on top of the profile.
    if (overrideEntries.length > 0) {
      emitFn('status', { message: 'Extracting overrides…' });
    }
    for (const entry of overrideEntries) {
      bailIfCancelled();
      const name = entry.entryName.replace(/\\/g, '/');
      const stripPrefix = name.startsWith('overrides/') ? 'overrides/' : 'client-overrides/';
      const rel = name.slice(stripPrefix.length);
      const out = path.join(profileDir, rel);
      await fs.ensureDir(path.dirname(out));
      await fs.writeFile(out, entry.getData());
      // Track every override path too — these are configs/scripts/resourcepacks
      // the modpack brought along, and a real "uninstall" needs to wipe them.
      trackedPaths.push(rel);
      done++;
      emitFn('progress', { task: done, total });
    }

    // Before recording the new install, clean up files from a previous version
    // of the same modpack that aren't part of this revision. Without this,
    // updating Better MC v22.0 → v22.1 would leave the v22.0 mod jars sitting
    // alongside the v22.1 ones — duplicate JARs cause mod loaders to crash.
    if (Array.isArray(previousFiles) && previousFiles.length > 0) {
      emitFn('status', { message: 'Cleaning previous version…' });
      const keep = new Set(trackedPaths);
      const toRemove = previousFiles.filter(p => p && !keep.has(p));
      for (const rel of toRemove) {
        if (!rel || rel.includes('..')) continue;
        const target = path.join(profileDir, rel);
        if (!target.startsWith(profileDir)) continue;
        try {
          await fs.remove(target);
          // Walk up pruning empty directories (matches the DELETE handler's
          // shape so an update leaves no orphaned folders).
          let dir = path.dirname(target);
          while (dir.startsWith(profileDir) && dir !== profileDir) {
            try {
              const entries = await fs.readdir(dir);
              if (entries.length > 0) break;
              await fs.rmdir(dir);
              dir = path.dirname(dir);
            } catch { break; }
          }
        } catch {}
      }
    }

    // Record the install so the UI can show it as "Installed".
    // `files` is the full list of relative paths the modpack wrote — used by
    // the DELETE handler to clean the profile when the user removes the pack.
    // `versionId` + `versionNumber` let the Instances tab compare against
    // Modrinth's latest and offer an "Update to vX.Y.Z" CTA.
    const recordPath = path.join(profileDir, '.minedash-modpacks.json');
    let record = {};
    try { record = await fs.readJson(recordPath); } catch {}
    // If the prior install lived under a different .mrpack filename (a new
    // revision usually does), drop the stale entry pointing at the old name
    // so the registry doesn't show two records for the same projectId.
    if (Array.isArray(previousFiles) && previousFiles.length > 0) {
      for (const k of Object.keys(record)) {
        if (record[k]?.projectId === projectId && k !== filename) delete record[k];
      }
    }
    record[filename] = {
      projectId,
      iconUrl,
      title,
      versionId:     versionId     || null,
      versionNumber: versionNumber || null,
      installedAt: Date.now(),
      files: trackedPaths,
    };
    await fs.writeJson(recordPath, record, { spaces: 2 });

    return { installed: installedFiles.length, failed };
  } finally {
    try { await fs.remove(tempDir); } catch {}
  }
}

// True while any launch worker or modpack install is alive — used by the
// storage-move endpoint to refuse relocating folders that have open file
// handles under them.
function isBusy() {
  return activeLaunches.size > 0 || activeModpackInstalls.size > 0;
}

module.exports = {
  init, register, runLaunch, isBusy,
  // Pure helpers exported for the launch-args snapshot test (backend/test/).
  buildElyByAgentArgs, assertAgentArgsGate, hyphenateUuid, offlineUuid,
};
