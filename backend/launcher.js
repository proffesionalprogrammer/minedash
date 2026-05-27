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
const multer = require('multer');
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

// ─── CONFIG ─────────────────────────────────────────────────────────
const AZURE_CLIENT_ID = ''; // ← fill in after registering the Azure app
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
  lastLoader: '',            // last loader the user launched — restores the Play form on reopen
  lastVersion: '',           // last version the user launched
  lastInstanceId: '',        // last instance ID launched — narrower than lastLoader+lastVersion when multiple instances exist
  onboardingComplete: false, // first-run guided tour — true once the user finishes or skips it
};

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
  return { id: a.id, type: a.type, username: a.username, uuid: a.uuid };
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
function register(app) {
  // ── Instance management ──────────────────────────────────────────
  // First-class instances — every profile is identified by its `id`. Multiple
  // instances can share the same loader+version, each with its own mods/configs.
  app.get('/api/launcher/instances', async (req, res) => {
    const reg = await readProfileRegistry();
    res.json(reg.instances);
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
    const { displayName } = req.body || {};
    if (typeof displayName !== 'string') return res.status(400).json({ error: 'displayName is required' });
    const name = displayName.trim();
    if (!name) return res.status(400).json({ error: 'displayName cannot be empty' });
    if (name.length > 60) return res.status(400).json({ error: 'displayName too long' });

    const reg = await readProfileRegistry();
    const inst = reg.instances.find(i => i.id === id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });
    inst.displayName = name;
    await writeProfileRegistry(reg);
    res.json(inst);
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
    if (typeof incoming.lastLoader === 'string' && ['vanilla','fabric','forge','neoforge',''].includes(incoming.lastLoader)) next.lastLoader = incoming.lastLoader;
    if (typeof incoming.lastVersion === 'string') next.lastVersion = incoming.lastVersion.trim();
    if (typeof incoming.lastInstanceId === 'string') next.lastInstanceId = incoming.lastInstanceId.trim();
    if (typeof incoming.onboardingComplete === 'boolean') next.onboardingComplete = incoming.onboardingComplete;

    await writeSettings(next);
    res.json(next);
  });

  // Install a Modrinth file (mod / resourcepack / shader) into a profile.
  app.post('/api/launcher/profiles/:loader/:version/install', async (req, res) => {
    const { loader, version } = req.params;
    const instanceId = req.query.instance || null;
    const { url, filename, projectType, projectId, iconUrl, title, gameVersions, loaders } = req.body || {};
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
      };
      await fs.writeJson(metaPath, meta, { spaces: 2 });

      res.json({ ok: true, installed: filename });
    } catch (err) {
      res.status(500).json({ error: err.message });
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
    res.json({ ok: true, sessionId });

    installModpackIntoProfile({ sessionId, profileDir, url, filename, projectId, iconUrl, title })
      .then(summary => emitModpack(sessionId, 'done', summary))
      .catch(err => emitModpack(sessionId, 'error', { message: err.message || String(err) }));
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
        const contentFiles = files.filter(f => !f.startsWith('.') && /\.(jar|zip)$/i.test(f));
        // Kick off enrichment but only await up to the remaining budget. The
        // promise keeps running after we move on — its `meta` mutation and
        // writeJson finish out-of-band, so the next /content call sees a
        // warmer cache without us having blocked this response.
        const enrichPromise = enrichLauncherMeta(dir, contentFiles, meta).catch(() => {});
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
          const m = meta[f] || {};
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
          result[type].push({ filename: f, ...m, wrongVersion, wrongLoader });
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
    const account = {
      id: crypto.randomUUID(),
      type: 'offline',
      username,
      uuid: offlineUuid(username),
    };
    accounts.accounts.push(account);
    if (!accounts.activeAccountId) accounts.activeAccountId = account.id;
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

  // Launch the game. Either:
  //   { version, loader, instanceId?, syncFromServerId? }  — standalone
  //   { joinServerId }                                      — derived from a running MineDash server,
  //                                                           mods auto-synced and quickPlay set to localhost:port.
  //
  // If instanceId is omitted, the default instance for loader+version is used.
  app.post('/api/launcher/launch', async (req, res) => {
    const { joinServerId } = req.body || {};
    let { version, loader, instanceId, syncFromServerId } = req.body || {};

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

    const launchId = crypto.randomUUID();
    res.json({ ok: true, launchId });

    // Remember what the user launched so the Play form reopens to the same
    // instance next time MineDash starts.
    try {
      const persisted = { ...settings, lastLoader: loader, lastVersion: version, lastInstanceId: instance.id };
      await writeSettings(persisted);
    } catch {}

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
      // No live worker — nothing to kill, but the UI still needs to flip out
      // of `cancelling` state. Emit close directly.
      emit(launchId, 'close', { code: 'cancelled' });
      cancelledLaunches.delete(launchId);
    }
    res.json({ ok: true, queued: !!worker });
  });
}

// Fork the worker subprocess and wire its IPC events back to the socket.
// `entry.worker` is the ChildProcess; we stash it under activeLaunches so the
// DELETE handler can find it. `entry.jvmPid` may be set later when the worker
// sends `jvm_started` — currently we let the worker handle JVM kill itself on
// cancel, but the field is here so the parent can SIGKILL the JVM directly if
// the worker becomes unresponsive.
function forkLaunchWorker(payload) {
  const { fork } = require('child_process');
  const path = require('path');
  const workerPath = path.join(__dirname, 'launcher-worker.js');
  const worker = fork(workerPath, [], {
    // Pipe so we capture stdio in the parent's logs if the worker prints
    // anything outside of our IPC channel (panic, native crash, etc).
    silent: true,
  });

  activeLaunches.set(payload.launchId, { worker });

  worker.stdout?.on('data', (d) => process.stdout.write(`[launcher-worker ${payload.launchId.slice(0,8)}] ${d}`));
  worker.stderr?.on('data', (d) => process.stderr.write(`[launcher-worker ${payload.launchId.slice(0,8)}] ${d}`));

  worker.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'event') {
      // Generic event forwarding — { kind: 'event', launchId, event, ...data }
      const { kind, ...rest } = msg;
      const { launchId, event, ...data } = rest;
      // Track terminal events so the worker.on('exit') handler below doesn't
      // synthesize a second close/error after we already forwarded one. Same
      // launchId could get a "close" → IPC exit → exit handler racing.
      if (event === 'close' || event === 'error') {
        const entry = activeLaunches.get(payload.launchId);
        if (entry) entry.terminalEmitted = true;
      }
      _emit(launchId, event, data);
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

  worker.on('exit', (code, signal) => {
    const wasCancelled = cancelledLaunches.has(payload.launchId);
    const entry = activeLaunches.get(payload.launchId);
    const alreadyEmittedTerminal = entry && entry.terminalEmitted;
    activeLaunches.delete(payload.launchId);
    cancelledLaunches.delete(payload.launchId);
    if (alreadyEmittedTerminal) {
      // Worker forwarded its own close/error before exiting — nothing more
      // to do, the UI is already in the right state.
      return;
    }
    if (wasCancelled) {
      // Cancel path — the close event was deferred until the worker actually
      // died. Emit it now so the UI flips back to idle.
      _emit(payload.launchId, 'close', { code: 'cancelled' });
      return;
    }
    // If the worker died abnormally (signal kill or non-zero exit) without
    // a prior `close`/`error` IPC event, the UI would otherwise sit on a
    // running-state forever. Emit a synthetic error so it resets.
    if (code !== 0 && code !== null) {
      _emit(payload.launchId, 'error', {
        message: `Launcher worker exited unexpectedly (code ${code}${signal ? `, signal ${signal}` : ''})`,
      });
    } else if (signal && signal !== 'SIGTERM') {
      _emit(payload.launchId, 'error', {
        message: `Launcher worker was terminated (${signal})`,
      });
    }
  });

  worker.on('error', (err) => {
    activeLaunches.delete(payload.launchId);
    cancelledLaunches.delete(payload.launchId);
    _emit(payload.launchId, 'error', { message: err.message || String(err) });
  });

  // Kick off the launch. Done after the listeners are attached so we don't
  // miss any synchronous early events the worker might emit (unlikely with
  // IPC, but cheap to be careful).
  try {
    worker.send({ type: 'init', payload });
  } catch (err) {
    activeLaunches.delete(payload.launchId);
    _emit(payload.launchId, 'error', { message: 'Failed to send init to worker: ' + err.message });
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

async function runLaunch({ launchId, instance, account, accountsDoc, syncServer, settings, quickPlayHost, depAttempted }) {
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

  let authorization;
  if (account.type === 'offline') {
    authorization = {
      access_token: '0',
      client_token: crypto.randomUUID(),
      uuid: account.uuid,
      name: account.username,
      user_properties: '{}',
      meta: { type: 'mojang', demo: false },
    };
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

  // Resolve Java path early — NeoForge needs it to run its headless installer.
  // Explicit setting wins, else fall back to backend discovery.
  let javaPath = settings?.javaPath && settings.javaPath.trim();
  if (!javaPath) {
    const discovered = getJavaPath ? getJavaPath() : null;
    javaPath = discovered && discovered !== 'java' ? discovered : undefined;
  }

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

  const ramStr = String(settings?.ramGb || 4) + 'G';
  const opts = {
    authorization,
    root: profileRoot,
    version: { number: version, type: 'release' },
    memory: { max: ramStr, min: ramStr },
    javaPath,
    window: {
      width:  String(settings?.windowWidth  || 925),
      height: String(settings?.windowHeight || 530),
      fullscreen: !!settings?.fullscreen,
    },
  };
  if (versionCustom) opts.version.custom = versionCustom;
  if (forgeInstaller) opts.forge = forgeInstaller;
  if (neoForgeJvmArgs && neoForgeJvmArgs.length > 0) opts.customArgs = neoForgeJvmArgs;
  if (quickPlayHost) {
    opts.quickPlay = { type: 'multiplayer', identifier: quickPlayHost };
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
              syncServer: null, settings, quickPlayHost,
              depAttempted: triedIds,
            }).catch(err => emit(launchId, 'error', { message: err.message || String(err) }));
            return;
          }
        }
      }
    } catch (err) {
      emit(launchId, 'log', { message: `[Auto-install ERR] ${err.message || err}` });
    }
    emit(launchId, 'close', { code });
    activeLaunches.delete(launchId);
  });

  try {
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
async function installModpackIntoProfile({ sessionId, profileDir, url, filename, projectId, iconUrl, title }) {
  await fs.ensureDir(profileDir);

  const tempDir = path.join(profileDir, '.modpack-tmp');
  await fs.ensureDir(tempDir);
  const mrpackPath = path.join(tempDir, filename);

  try {
    if (sessionId) emitModpack(sessionId, 'status', { message: 'Downloading modpack…' });
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
    if (sessionId) emitModpack(sessionId, 'status', { message: 'Downloading mods…' });
    if (sessionId) emitModpack(sessionId, 'progress', { task: 0, total });

    // Download each eligible file.
    for (const f of eligible) {
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
      if (sessionId) emitModpack(sessionId, 'progress', { task: done, total });
    }

    // Extract overrides/ and client-overrides/ on top of the profile.
    if (sessionId && overrideEntries.length > 0) {
      emitModpack(sessionId, 'status', { message: 'Extracting overrides…' });
    }
    for (const entry of overrideEntries) {
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
      if (sessionId) emitModpack(sessionId, 'progress', { task: done, total });
    }

    // Record the install so the UI can show it as "Installed".
    // `files` is the full list of relative paths the modpack wrote — used by
    // the DELETE handler to clean the profile when the user removes the pack.
    const recordPath = path.join(profileDir, '.minedash-modpacks.json');
    let record = {};
    try { record = await fs.readJson(recordPath); } catch {}
    record[filename] = {
      projectId,
      iconUrl,
      title,
      installedAt: Date.now(),
      files: trackedPaths,
    };
    await fs.writeJson(recordPath, record, { spaces: 2 });

    return { installed: installedFiles.length, failed };
  } finally {
    try { await fs.remove(tempDir); } catch {}
  }
}

module.exports = { init, register, runLaunch };
