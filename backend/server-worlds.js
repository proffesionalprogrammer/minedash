// ─── Server worlds — list, import custom maps, switch, export ─────────────────
//
// The server-side counterpart to the launcher's Worlds panel. A dedicated
// server keeps its saves as top-level folders inside instances/<id>/ (not in a
// saves/ folder like a client), and which one is loaded is decided by
// `level-name` in server.properties. So "switching world" is: have the folder
// on disk, and point level-name at it.
//
// The reason this module exists rather than a handful of routes in index.js is
// the dimension-layout problem, which is the single thing that makes custom
// maps painful on a server:
//
//   Vanilla / Fabric / Forge / NeoForge store every dimension inside one folder
//     world/region, world/DIM-1/region, world/DIM1/region
//   Bukkit-family servers (Paper) split them into three sibling folders
//     world/region, world_nether/DIM-1/region, world_the_end/DIM1/region
//
// Almost every downloadable map ships in the vanilla layout. Drop one into a
// Paper server as-is and the overworld loads while the Nether and End silently
// generate fresh — the classic "my custom map lost its nether" bug. Importing
// converts the layout to whatever the target server actually reads, in both
// directions, so a map works on the server you put it on.
//
// Mirrors the init()/register() shape of launcher.js and connect.js.

const path = require('path');
const fs = require('fs-extra');
const multer = require('multer');
const zipStream = require('./zip-stream');
const archiver = require('archiver');
const nbtLite = require('./nbt-lite');

let INSTANCES_DIR = null;
let TEMP_DIR = null;     // under MineDash's data dir — see register()
let getServers = null;   // async () => servers[]
let isRunning = null;    // (serverId) => boolean
let io = null;

function init(deps) {
  INSTANCES_DIR = deps.INSTANCES_DIR;
  TEMP_DIR = deps.TEMP_DIR;
  getServers = deps.getServers;
  isRunning = deps.isRunning;
  io = deps.io;
}

// Bukkit splits a world's dimensions across sibling folders with these suffixes.
const NETHER_SUFFIX = '_nether';
const END_SUFFIX = '_the_end';
// Vanilla keeps them as subfolders with these names.
const NETHER_DIM = 'DIM-1';
const END_DIM = 'DIM1';

// Paper (and anything Bukkit-derived) uses the split layout. Everything else
// MineDash can create — vanilla, fabric, forge, neoforge — uses the nested one.
function usesBukkitLayout(serverType) {
  return String(serverType || '').toLowerCase() === 'paper';
}

// Reject a folder name that could escape the instance directory. Route params
// arrive URL-decoded, so ".." and "a/b" have to be caught here — the global
// app.param guard in index.js only covers :id / :filename and friends.
function safeChild(base, name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..') return null;
  if (/[\\/\0]/.test(name)) return null;
  const resolved = path.resolve(path.join(base, name));
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  return resolved;
}

async function dirSizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await fs.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try { total += (await fs.stat(p)).size; } catch {}
      }
    }
  }
  return total;
}

// ── World size cache ──────────────────────────────────────────────────────────
// Walking a multi-GB world (tens of thousands of region/entity/poi files) takes
// seconds, and GET /worlds used to do it for every world on every request. So
// sizes are cached per folder, keyed on that folder's level.dat mtime:
// Minecraft rewrites level.dat on every save, so a world that has been played
// since gets re-measured, and one that hasn't is answered instantly. A cache
// miss never blocks the listing — the size comes back null ("measuring"), the
// walk runs in the background, and `server_worlds_changed` tells the UI to
// re-read once it lands.
//
// In memory only: a restart re-measures once, which is fine.
const SIZE_TTL_MS = 10 * 60 * 1000; // a file dropped into a world without a save still shows up eventually
const sizeCache = new Map();         // absDir -> { stamp, sizeBytes, at }
const sizeInFlight = new Map();      // absDir -> Promise<number>

async function sizeStamp(dir) {
  // Dimension siblings carry their own level.dat on Bukkit; a sibling without
  // one (hand-copied) falls back to the folder's own mtime.
  try { return (await fs.stat(path.join(dir, 'level.dat'))).mtimeMs; } catch {}
  try { return (await fs.stat(dir)).mtimeMs; } catch { return 0; }
}

async function cachedDirSize(dir) {
  const hit = sizeCache.get(dir);
  if (!hit || Date.now() - hit.at > SIZE_TTL_MS) return null;
  return hit.stamp === await sizeStamp(dir) ? hit.sizeBytes : null;
}

// Measure `dir` once even if several listings ask at the same time.
function measureDirSize(dir) {
  if (sizeInFlight.has(dir)) return sizeInFlight.get(dir);
  const p = (async () => {
    const stamp = await sizeStamp(dir);
    const sizeBytes = await dirSizeBytes(dir);
    sizeCache.set(dir, { stamp, sizeBytes, at: Date.now() });
    return sizeBytes;
  })().finally(() => sizeInFlight.delete(dir));
  sizeInFlight.set(dir, p);
  return p;
}

// Forget every cached size at or under `prefix` — the Refresh button's way of
// forcing a re-measure of a server's worlds.
function forgetSizes(prefix) {
  const root = path.resolve(prefix);
  for (const key of sizeCache.keys()) {
    if (key === root || key.startsWith(root + path.sep)) sizeCache.delete(key);
  }
}

// Carry a world's cached sizes over a rename — the bytes didn't change.
function moveSizes(fromDir, toDir) {
  const hit = sizeCache.get(path.resolve(fromDir));
  if (!hit) return;
  sizeCache.delete(path.resolve(fromDir));
  sizeCache.set(path.resolve(toDir), hit);
}

// Windows (and default macOS) filesystems are case-insensitive: level-name=World
// loads the folder "world". Name comparisons that guard destructive actions
// (is this the active world?) have to agree with the filesystem, or deleting
// "world" slips past the "can't delete the active world" check.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
function sameWorldName(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return CASE_INSENSITIVE_FS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// ── server.properties: read/patch a single key ────────────────────────────────
// Deliberately line-based rather than a full parse-and-rewrite: the file carries
// user comments and ordering we have no business reshuffling just to change
// level-name.
//
// server.properties is a java.util.Properties file. Minecraft before ~1.20.2
// reads it as ISO-8859-1, so a raw UTF-8 "Château" comes back as "ChÃ¢teau" —
// a different folder, and the server silently generates a fresh world. \uXXXX
// escapes read correctly on every version, and Minecraft writes them itself
// when it re-saves the file, so both directions have to handle them.
function decodePropValue(v) {
  return v.replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_, hex, ch) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    return { t: '\t', n: '\n', r: '\r', f: '\f' }[ch] ?? ch;
  });
}
function encodePropValue(v) {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/^\s/, (c) => `\\${c}`) // Properties strips leading whitespace from values
    .replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

async function readLevelName(serverPath) {
  try {
    const raw = await fs.readFile(path.join(serverPath, 'server.properties'), 'utf8');
    const m = raw.match(/^level-name\s*[=:]\s*(.*)$/m);
    if (m) {
      const v = decodePropValue(m[1].trim());
      if (v) return v;
    }
  } catch {}
  return 'world';
}

async function writeLevelName(serverPath, name) {
  const propPath = path.join(serverPath, 'server.properties');
  const line = `level-name=${encodePropValue(name)}`;
  let lines = [];
  try {
    lines = (await fs.readFile(propPath, 'utf8')).split('\n');
  } catch {
    // No properties file yet (server never started). Create a minimal one —
    // Minecraft fills in every other default on first boot.
    await fs.writeFile(propPath, `${line}\n`);
    return;
  }
  let found = false;
  const out = lines.map((l) => {
    // Keep the line's own CR so a CRLF file doesn't end up with one LF line.
    if (/^level-name\s*[=:]/.test(l)) { found = true; return l.endsWith('\r') ? `${line}\r` : line; }
    return l;
  });
  if (!found) out.push(line);
  await fs.writeFile(propPath, out.join('\n'));
}

// ── Dimension layout conversion ───────────────────────────────────────────────
// Both directions are move-based and idempotent: a world already in the target
// layout comes out untouched. level.dat is *copied* into each split folder
// because Bukkit expects one per world folder; the overworld keeps the original.
//
// When BOTH layouts hold a copy of a dimension, neither is deleted. The usual
// way that happens is exactly the bug this module exists for: a map unzipped
// by hand into a Paper server, which then booted and generated a *fresh*
// world_nether beside the map's real world/DIM-1. We can't tell which copy the
// user wants, and guessing wrong destroys a hand-built Nether — so both stay on
// disk (the server ignores the one it doesn't read) and the conflict is
// reported back so the UI can say so.

async function toBukkitLayout(serverPath, name) {
  const worldDir = path.join(serverPath, name);
  const levelDat = path.join(worldDir, 'level.dat');
  const converted = [];
  const conflicts = [];
  for (const [dim, suffix] of [[NETHER_DIM, NETHER_SUFFIX], [END_DIM, END_SUFFIX]]) {
    const label = suffix === NETHER_SUFFIX ? 'nether' : 'end';
    const src = path.join(worldDir, dim);
    if (!(await fs.pathExists(src))) continue;
    const sibling = path.join(serverPath, `${name}${suffix}`);
    if (await fs.pathExists(path.join(sibling, dim))) { conflicts.push(label); continue; }
    await fs.ensureDir(sibling);
    await fs.move(src, path.join(sibling, dim));
    if (await fs.pathExists(levelDat)) {
      await fs.copy(levelDat, path.join(sibling, 'level.dat'), { overwrite: true }).catch(() => {});
    }
    converted.push(label);
  }
  return { converted, conflicts };
}

// What Bukkit keeps at the top of a dimension sibling besides the DIM folder.
// Once the dimension has moved out, a sibling holding only these is removed;
// one holding anything else is left alone rather than guessed at.
const SIBLING_BOOKKEEPING = new Set(['level.dat', 'level.dat_old', 'uid.dat', 'session.lock', 'paper-world.yml']);

async function toVanillaLayout(serverPath, name) {
  const worldDir = path.join(serverPath, name);
  const converted = [];
  const conflicts = [];
  for (const [dim, suffix] of [[NETHER_DIM, NETHER_SUFFIX], [END_DIM, END_SUFFIX]]) {
    const label = suffix === NETHER_SUFFIX ? 'nether' : 'end';
    const sibling = path.join(serverPath, `${name}${suffix}`);
    const src = path.join(sibling, dim);
    if (!(await fs.pathExists(src))) continue;
    const dest = path.join(worldDir, dim);
    if (await fs.pathExists(dest)) { conflicts.push(label); continue; }
    await fs.ensureDir(worldDir);
    await fs.move(src, dest);
    converted.push(label);
    const leftovers = await fs.readdir(sibling).catch(() => []);
    if (leftovers.every(f => SIBLING_BOOKKEEPING.has(f))) await fs.remove(sibling).catch(() => {});
  }
  return { converted, conflicts };
}

async function applyLayout(serverPath, name, serverType) {
  const bukkit = usesBukkitLayout(serverType);
  const result = bukkit ? await toBukkitLayout(serverPath, name) : await toVanillaLayout(serverPath, name);
  return { layout: bukkit ? 'bukkit' : 'vanilla', ...result };
}

// Every folder that belongs to `name` — the world itself plus any Bukkit
// dimension siblings. Used by delete / rename / duplicate / export so a world
// always moves as one unit.
async function worldParts(serverPath, name) {
  const parts = [{ dir: path.join(serverPath, name), suffix: '' }];
  for (const suffix of [NETHER_SUFFIX, END_SUFFIX]) {
    const p = path.join(serverPath, `${name}${suffix}`);
    if (await fs.pathExists(p)) parts.push({ dir: p, suffix });
  }
  return parts;
}

// A directory is a world when it holds a level.dat. Dimension siblings hold one
// too, which is why they're filtered out by name against the set of real worlds.
//
// `onSizesReady` (optional) is called once, after any sizes that weren't cached
// have been measured in the background. Worlds whose size isn't known yet come
// back with sizeBytes: null and sizePending: true.
async function listWorlds(serverPath, { onSizesReady } = {}) {
  let entries = [];
  try { entries = await fs.readdir(serverPath, { withFileTypes: true }); } catch { return []; }

  const candidates = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (await fs.pathExists(path.join(serverPath, e.name, 'level.dat'))) candidates.push(e.name);
  }
  const candidateSet = new Set(candidates);

  // Drop "<world>_nether" / "<world>_the_end" when "<world>" is itself a world —
  // they're that world's dimensions, not separate saves. A standalone folder
  // that merely ends in _nether with no matching parent stays listed.
  const roots = candidates.filter((n) => {
    for (const suffix of [NETHER_SUFFIX, END_SUFFIX]) {
      if (n.endsWith(suffix) && candidateSet.has(n.slice(0, -suffix.length))) return false;
    }
    return true;
  });

  const out = [];
  const pending = [];
  for (const name of roots) {
    const dir = path.join(serverPath, name);
    try {
      const levelPath = path.join(dir, 'level.dat');
      const levelStat = await fs.stat(levelPath);
      let summary = {};
      // A corrupt or in-use level.dat just leaves these null — the world still
      // lists, falling back to the file mtime.
      try { summary = nbtLite.summarizeLevelDat(await fs.readFile(levelPath)); } catch {}

      const parts = await worldParts(serverPath, name);
      let sizeBytes = 0;
      for (const p of parts) {
        const dirKey = path.resolve(p.dir);
        const cached = await cachedDirSize(dirKey);
        if (cached == null) { pending.push(dirKey); sizeBytes = null; }
        else if (sizeBytes != null) sizeBytes += cached;
      }

      out.push({
        name,
        sizeBytes,
        sizePending: sizeBytes == null,
        lastPlayed: typeof summary.lastPlayed === 'number' && summary.lastPlayed > 0
          ? summary.lastPlayed
          : levelStat.mtimeMs,
        hasIcon: await fs.pathExists(path.join(dir, 'icon.png')),
        gameMode: typeof summary.gameMode === 'number' ? summary.gameMode : null,
        seed: summary.seed || null,
        levelName: summary.levelName || null,
        hasNether: parts.some(p => p.suffix === NETHER_SUFFIX) || await fs.pathExists(path.join(dir, NETHER_DIM)),
        hasEnd: parts.some(p => p.suffix === END_SUFFIX) || await fs.pathExists(path.join(dir, END_DIM)),
      });
    } catch {}
  }
  out.sort((a, b) => b.lastPlayed - a.lastPlayed);

  if (pending.length > 0) {
    // One at a time: these are disk-bound walks, and running several in
    // parallel on a spinning disk is slower than running them in sequence.
    (async () => {
      for (const dir of pending) await measureDirSize(dir).catch(() => {});
      onSizesReady?.();
    })();
  }
  return out;
}

// `onProgress(doneBytes, totalBytes)` is called as bytes are written. The
// archive is streamed from disk (never loaded into memory) and every entry is
// checked before anything is written — see zip-stream.js.
async function extractZip(zipPath, destDir, onProgress) {
  await zipStream.extractZip(zipPath, destDir, { onProgress });
}

// Find the world root inside an extracted zip: the extract dir itself (level.dat
// at the zip root) or the shallowest folder holding one. Maps are packaged
// every which way — "Map/level.dat" is most common, but "Map v1.2/Map/level.dat"
// (a readme beside the world) is common enough that one level isn't enough.
const WORLD_SEARCH_DEPTH = 3;
async function findWorldRoot(extractDir, fallbackName) {
  if (await fs.pathExists(path.join(extractDir, 'level.dat'))) {
    return { root: extractDir, baseName: fallbackName };
  }
  let level = [extractDir];
  for (let depth = 1; depth <= WORLD_SEARCH_DEPTH && level.length; depth++) {
    const next = [];
    const hits = [];
    for (const dir of level) {
      let entries = [];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name === '__MACOSX') continue;
        const sub = path.join(dir, e.name);
        if (await fs.pathExists(path.join(sub, 'level.dat'))) hits.push({ root: sub, baseName: e.name });
        else next.push(sub);
      }
    }
    // A Bukkit-layout map has level.dat in world_nether / world_the_end too;
    // the overworld is the one that isn't a dimension sibling.
    const main = hits.find(h => !h.baseName.endsWith(NETHER_SUFFIX) && !h.baseName.endsWith(END_SUFFIX));
    if (main || hits[0]) return main || hits[0];
    level = next;
  }
  return null;
}

function sanitizeWorldName(raw) {
  return (raw || 'world')
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_') // control chars would inject lines into server.properties
    .slice(0, 100)
    .replace(/^[\s.]+/, '')                      // a leading dot hides the folder from listWorlds
    .replace(/[\s.]+$/, '')                      // Windows silently drops trailing dots/spaces
    || 'world';
}

// A name is free only if its dimension siblings are free too — otherwise a
// stray "<name>_nether" from an older world gets adopted (or merged into).
async function nameTaken(serverPath, name) {
  for (const suffix of ['', NETHER_SUFFIX, END_SUFFIX]) {
    if (await fs.pathExists(path.join(serverPath, `${name}${suffix}`))) return true;
  }
  return false;
}

async function uniqueWorldName(serverPath, base) {
  let target = base;
  for (let n = 2; await nameTaken(serverPath, target); n++) target = `${base} (${n})`;
  return target;
}

function register(app) {
  // The upload and its extraction live in MineDash's own data dir, not the OS
  // temp folder: that's often on another drive (C: while MineDash stores on
  // D:), which made the final move into the instance a full multi-GB copy
  // with no progress. On the same volume the move is a rename.
  const worldUpload = multer({
    dest: path.join(TEMP_DIR, 'server-worlds'),
    limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // adventure maps routinely run to a GB+
  });

  // Resolve the server + its folder, or answer the request and return null.
  const resolve = async (req, res, { requireStopped = false } = {}) => {
    const { id } = req.params;
    const servers = await getServers();
    const cfg = servers.find(s => s.id === id);
    if (!cfg) { res.status(404).json({ error: 'Server not found' }); return null; }
    if (requireStopped && isRunning(id)) {
      res.status(409).json({ error: 'Stop the server first — its world files are locked while it runs.' });
      return null;
    }
    return { cfg, serverPath: path.join(INSTANCES_DIR, id) };
  };

  // Tell every open Worlds tab for this server to re-read. Emitted after each
  // mutation (so a second window, or the Files tab moving a folder, stays in
  // step) and when background size measuring finishes.
  const worldsChanged = (serverId, reason) => {
    if (io) io.emit('server_worlds_changed', { serverId, reason });
  };

  app.get('/api/servers/:id/worlds', async (req, res) => {
    const ctx = await resolve(req, res);
    if (!ctx) return;
    // The Refresh button re-measures — the only way to pick up bytes added to
    // a world without the server ever saving it (a region file copied in).
    if (req.query.refresh === '1') forgetSizes(ctx.serverPath);
    const worlds = await listWorlds(ctx.serverPath, {
      onSizesReady: () => worldsChanged(req.params.id, 'sizes'),
    });
    const active = await readLevelName(ctx.serverPath);
    res.json({
      worlds: worlds.map(w => ({ ...w, active: sameWorldName(w.name, active) })),
      active,
      layout: usesBukkitLayout(ctx.cfg.type) ? 'bukkit' : 'vanilla',
      running: isRunning(req.params.id),
    });
  });

  app.get('/api/servers/:id/worlds/:name/icon', async (req, res) => {
    const ctx = await resolve(req, res);
    if (!ctx) return;
    const dir = safeChild(ctx.serverPath, req.params.name);
    if (!dir) return res.status(400).json({ error: 'Invalid world name' });
    const icon = path.join(dir, 'icon.png');
    if (!await fs.pathExists(icon)) return res.status(404).json({ error: 'No icon' });
    res.sendFile(icon);
  });

  // Point level-name at an existing world. This is the whole "switch world"
  // operation — the folders are already on disk, only the pointer moves. The
  // layout is re-checked on the way in because a world imported while the
  // server was a different type (or copied in by hand) may not match.
  app.post('/api/servers/:id/worlds/:name/activate', async (req, res) => {
    const ctx = await resolve(req, res, { requireStopped: true });
    if (!ctx) return;
    const dir = safeChild(ctx.serverPath, req.params.name);
    if (!dir || !await fs.pathExists(path.join(dir, 'level.dat'))) {
      return res.status(404).json({ error: 'World not found' });
    }
    const { converted, conflicts } = await applyLayout(ctx.serverPath, req.params.name, ctx.cfg.type);
    await writeLevelName(ctx.serverPath, req.params.name);
    worldsChanged(req.params.id, 'activate');
    res.json({ ok: true, active: req.params.name, converted, conflicts });
  });

  // Import a map .zip. `activate=1` switches the server to it immediately,
  // which is what the UI's "Import and use" does — the common case for someone
  // who just downloaded an adventure map.
  app.post('/api/servers/:id/worlds/import', worldUpload.single('file'), async (req, res) => {
    const cleanup = async () => { if (req.file) await fs.remove(req.file.path).catch(() => {}); };
    const ctx = await resolve(req, res, { requireStopped: true });
    if (!ctx) { await cleanup(); return; }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!/\.zip$/i.test(req.file.originalname || '')) {
      await cleanup();
      return res.status(400).json({ error: 'World imports must be .zip files' });
    }

    // Progress for the phases after the upload (which the browser reports on
    // its own). Throttled — a map can hold 20k entries and each is an event.
    // `importId` (from the client) lets a tab ignore another tab's import.
    const importId = typeof req.query.importId === 'string' ? req.query.importId.slice(0, 64) : null;
    let lastEmit = 0;
    const progress = (phase, extra = {}, force = false) => {
      if (!io) return;
      const now = Date.now();
      if (!force && now - lastEmit < 150) return;
      lastEmit = now;
      io.emit(`world_import_${req.params.id}`, { importId, phase, ...extra });
    };

    const tmpExtract = `${req.file.path}-extracted`;
    try {
      await extractZip(req.file.path, tmpExtract, (done, total) => {
        progress('extract', { done, total }, done === total);
      });
      progress('install', {}, true);
      const found = await findWorldRoot(tmpExtract, (req.file.originalname || 'world').replace(/\.zip$/i, ''));
      if (!found) {
        return res.status(400).json({
          error: "No level.dat found in the zip — that doesn't look like a Minecraft world.",
        });
      }

      const base = sanitizeWorldName(found.baseName);
      const target = await uniqueWorldName(ctx.serverPath, base);
      // A session.lock carried in from the zip would make the server think
      // another process holds the world.
      await fs.remove(path.join(found.root, 'session.lock')).catch(() => {});
      await fs.move(found.root, path.join(ctx.serverPath, target), { overwrite: false });

      // Maps that ship the Bukkit layout put the dimensions in siblings of the
      // world root, which are siblings of `found.root` too — carry them over
      // before converting, otherwise the nether/end are left in the temp dir.
      for (const suffix of [NETHER_SUFFIX, END_SUFFIX]) {
        if (found.root === tmpExtract) break; // level.dat at the zip root: no siblings possible
        const src = path.join(path.dirname(found.root), `${found.baseName}${suffix}`);
        if (await fs.pathExists(src)) {
          await fs.move(src, path.join(ctx.serverPath, `${target}${suffix}`), { overwrite: true }).catch(() => {});
        }
      }

      progress('convert', {}, true);
      const { layout, converted, conflicts } = await applyLayout(ctx.serverPath, target, ctx.cfg.type);

      let activated = false;
      if (req.query.activate === '1' || req.body?.activate === '1') {
        await writeLevelName(ctx.serverPath, target);
        activated = true;
      }
      progress('done', {}, true);
      worldsChanged(req.params.id, 'import');
      res.json({ ok: true, name: target, layout, converted, conflicts, activated });
    } catch (err) {
      progress('error', { error: err.message }, true);
      res.status(500).json({ error: `Import failed: ${err.message}` });
    } finally {
      await cleanup();
      await fs.remove(tmpExtract).catch(() => {});
    }
  });

  // Rename every folder belonging to the world, and follow it with level-name
  // if it was the active one — otherwise the server would boot into a freshly
  // generated world under the old name.
  app.post('/api/servers/:id/worlds/:name/rename', async (req, res) => {
    const ctx = await resolve(req, res, { requireStopped: true });
    if (!ctx) return;
    const src = safeChild(ctx.serverPath, req.params.name);
    if (!src || !await fs.pathExists(src)) return res.status(404).json({ error: 'World not found' });

    const raw = typeof req.body?.newName === 'string' ? req.body.newName.trim() : '';
    if (!raw) return res.status(400).json({ error: 'newName is required' });
    if (raw.length > 100) return res.status(400).json({ error: 'newName too long' });
    const newName = sanitizeWorldName(raw);
    if (!safeChild(ctx.serverPath, newName)) return res.status(400).json({ error: 'Invalid world name' });
    if (newName === req.params.name) return res.json({ ok: true, name: newName });
    // A case-only rename ("world" -> "World") finds itself on a case-insensitive
    // filesystem; that's not a collision. Otherwise every destination part must
    // be free up front — discovering a taken "<new>_nether" halfway through
    // would leave the world split across two names.
    if (!sameWorldName(newName, req.params.name) && await nameTaken(ctx.serverPath, newName)) {
      return res.status(409).json({ error: `A world named "${newName}" already exists.` });
    }

    const parts = await worldParts(ctx.serverPath, req.params.name);
    const done = [];
    try {
      for (const p of parts) {
        const dest = path.join(ctx.serverPath, `${newName}${p.suffix}`);
        await fs.move(p.dir, dest);
        done.push({ from: p.dir, to: dest });
        moveSizes(p.dir, dest);
      }
    } catch (err) {
      // Put back whatever already moved, so the world stays in one piece under
      // its old name (which level-name still points at).
      for (const m of done.reverse()) {
        await fs.move(m.to, m.from).then(() => moveSizes(m.to, m.from)).catch(() => {});
      }
      return res.status(500).json({ error: `Rename failed: ${err.message}` });
    }
    if (sameWorldName(await readLevelName(ctx.serverPath), req.params.name)) {
      await writeLevelName(ctx.serverPath, newName);
    }
    worldsChanged(req.params.id, 'rename');
    res.json({ ok: true, name: newName });
  });

  app.post('/api/servers/:id/worlds/:name/duplicate', async (req, res) => {
    const ctx = await resolve(req, res, { requireStopped: true });
    if (!ctx) return;
    const src = safeChild(ctx.serverPath, req.params.name);
    if (!src || !await fs.pathExists(src)) return res.status(404).json({ error: 'World not found' });

    const copyName = await uniqueWorldName(ctx.serverPath, `${req.params.name} copy`);
    const parts = await worldParts(ctx.serverPath, req.params.name);
    try {
      for (const p of parts) {
        await fs.copy(p.dir, path.join(ctx.serverPath, `${copyName}${p.suffix}`), {
          filter: (f) => path.basename(f) !== 'session.lock',
        });
      }
    } catch (err) {
      return res.status(500).json({ error: `Copy failed: ${err.message}` });
    }
    worldsChanged(req.params.id, 'duplicate');
    res.json({ ok: true, name: copyName });
  });

  app.delete('/api/servers/:id/worlds/:name', async (req, res) => {
    const ctx = await resolve(req, res, { requireStopped: true });
    if (!ctx) return;
    const dir = safeChild(ctx.serverPath, req.params.name);
    if (!dir || !await fs.pathExists(dir)) return res.status(404).json({ error: 'World not found' });
    if (sameWorldName(await readLevelName(ctx.serverPath), req.params.name)) {
      return res.status(409).json({
        error: 'That world is the one the server loads. Switch to another world first, then delete it.',
      });
    }
    const parts = await worldParts(ctx.serverPath, req.params.name);
    try {
      for (const p of parts) { await fs.remove(p.dir); sizeCache.delete(path.resolve(p.dir)); }
    } catch (err) {
      // Part of the world may already be gone; the listing should say so.
      worldsChanged(req.params.id, 'delete');
      return res.status(500).json({ error: `Delete failed: ${err.message}` });
    }
    worldsChanged(req.params.id, 'delete');
    res.json({ ok: true });
  });

  // Stream the world (and its dimension siblings) out as a zip. archiver keeps
  // this constant-memory, which matters — server worlds get very large.
  app.get('/api/servers/:id/worlds/:name/export', async (req, res) => {
    const ctx = await resolve(req, res);
    if (!ctx) return;
    const dir = safeChild(ctx.serverPath, req.params.name);
    if (!dir || !await fs.pathExists(dir)) return res.status(404).json({ error: 'World not found' });

    const parts = await worldParts(ctx.serverPath, req.params.name);
    res.attachment(`${req.params.name}.zip`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => { try { res.destroy(err); } catch {} });
    // Region files can be mid-write if the server is up — skip rather than abort.
    archive.on('warning', () => {});
    for (const p of parts) {
      archive.glob('**/*', { cwd: p.dir, ignore: ['session.lock'], dot: true },
        { prefix: `${req.params.name}${p.suffix}` });
    }
    archive.pipe(res);
    archive.finalize();
  });
}

module.exports = {
  init,
  register,
  // exported for tests / reuse
  listWorlds,
  forgetSizes,
  readLevelName,
  writeLevelName,
  toBukkitLayout,
  toVanillaLayout,
  usesBukkitLayout,
};
