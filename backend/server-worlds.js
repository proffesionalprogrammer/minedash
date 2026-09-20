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
const os = require('os');
const AdmZip = require('adm-zip');
const archiver = require('archiver');
const nbtLite = require('./nbt-lite');

let INSTANCES_DIR = null;
let getServers = null;   // async () => servers[]
let isRunning = null;    // (serverId) => boolean
let io = null;

function init(deps) {
  INSTANCES_DIR = deps.INSTANCES_DIR;
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

// ── server.properties: read/patch a single key ────────────────────────────────
// Deliberately line-based rather than a full parse-and-rewrite: the file carries
// user comments and ordering we have no business reshuffling just to change
// level-name.
async function readLevelName(serverPath) {
  try {
    const raw = await fs.readFile(path.join(serverPath, 'server.properties'), 'utf8');
    const m = raw.match(/^level-name\s*=\s*(.*)$/m);
    if (m) {
      const v = m[1].trim();
      if (v) return v;
    }
  } catch {}
  return 'world';
}

async function writeLevelName(serverPath, name) {
  const propPath = path.join(serverPath, 'server.properties');
  let lines = [];
  try {
    lines = (await fs.readFile(propPath, 'utf8')).split('\n');
  } catch {
    // No properties file yet (server never started). Create a minimal one —
    // Minecraft fills in every other default on first boot.
    await fs.writeFile(propPath, `level-name=${name}\n`);
    return;
  }
  let found = false;
  const out = lines.map((line) => {
    if (/^level-name\s*=/.test(line)) { found = true; return `level-name=${name}`; }
    return line;
  });
  if (!found) out.push(`level-name=${name}`);
  await fs.writeFile(propPath, out.join('\n'));
}

// ── Dimension layout conversion ───────────────────────────────────────────────
// Both directions are move-based and idempotent: a world already in the target
// layout comes out untouched. level.dat is *copied* into each split folder
// because Bukkit expects one per world folder; the overworld keeps the original.

async function toBukkitLayout(serverPath, name) {
  const worldDir = path.join(serverPath, name);
  const levelDat = path.join(worldDir, 'level.dat');
  const moved = [];
  for (const [dim, suffix] of [[NETHER_DIM, NETHER_SUFFIX], [END_DIM, END_SUFFIX]]) {
    const src = path.join(worldDir, dim);
    if (!(await fs.pathExists(src))) continue;
    const sibling = path.join(serverPath, `${name}${suffix}`);
    // A sibling already holding this dimension means the map shipped both
    // layouts (rare, but it happens with repacked maps) — trust the sibling and
    // drop the nested copy rather than merging two region sets.
    if (await fs.pathExists(path.join(sibling, dim))) {
      await fs.remove(src).catch(() => {});
      continue;
    }
    await fs.ensureDir(sibling);
    await fs.move(src, path.join(sibling, dim), { overwrite: true });
    if (await fs.pathExists(levelDat)) {
      await fs.copy(levelDat, path.join(sibling, 'level.dat'), { overwrite: true }).catch(() => {});
    }
    moved.push(suffix === NETHER_SUFFIX ? 'nether' : 'end');
  }
  return moved;
}

async function toVanillaLayout(serverPath, name) {
  const worldDir = path.join(serverPath, name);
  const moved = [];
  for (const [dim, suffix] of [[NETHER_DIM, NETHER_SUFFIX], [END_DIM, END_SUFFIX]]) {
    const sibling = path.join(serverPath, `${name}${suffix}`);
    const src = path.join(sibling, dim);
    if (!(await fs.pathExists(src))) continue;
    const dest = path.join(worldDir, dim);
    if (await fs.pathExists(dest)) {
      await fs.remove(sibling).catch(() => {});
      continue;
    }
    await fs.ensureDir(worldDir);
    await fs.move(src, dest, { overwrite: true });
    await fs.remove(sibling).catch(() => {});
    moved.push(suffix === NETHER_SUFFIX ? 'nether' : 'end');
  }
  return moved;
}

async function applyLayout(serverPath, name, serverType) {
  return usesBukkitLayout(serverType)
    ? { layout: 'bukkit', converted: await toBukkitLayout(serverPath, name) }
    : { layout: 'vanilla', converted: await toVanillaLayout(serverPath, name) };
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
async function listWorlds(serverPath) {
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
      for (const p of parts) sizeBytes += await dirSizeBytes(p.dir);

      out.push({
        name,
        sizeBytes,
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
  return out;
}

// Turn a zip entry path into a safe relative path, or null if it tries to
// escape. adm-zip sanitises on extractAllTo, but this module extracts entries
// itself so the check has to live here.
function safeEntryPath(entryName) {
  const normalized = path.normalize(entryName.replace(/\\/g, '/')).replace(/^([\\/]+)/, '');
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) return null;
  return normalized;
}

async function extractZip(zipPath, destDir) {
  const zip = new AdmZip(zipPath);
  for (const entry of zip.getEntries()) {
    const rel = safeEntryPath(entry.entryName);
    if (rel === null) throw new Error(`Refusing unsafe path in zip: ${entry.entryName}`);
    const target = path.join(destDir, rel);
    if (entry.isDirectory) {
      await fs.ensureDir(target);
      continue;
    }
    await fs.ensureDir(path.dirname(target));
    await fs.writeFile(target, entry.getData());
  }
}

// Find the world root inside an extracted zip: either the extract dir itself
// (level.dat at the zip root) or a single subfolder holding one. Maps are
// packaged both ways and the second is more common.
async function findWorldRoot(extractDir, fallbackName) {
  if (await fs.pathExists(path.join(extractDir, 'level.dat'))) {
    return { root: extractDir, baseName: fallbackName };
  }
  let entries = [];
  try { entries = await fs.readdir(extractDir); } catch { return null; }
  for (const entry of entries) {
    const sub = path.join(extractDir, entry);
    try {
      if ((await fs.stat(sub)).isDirectory() && await fs.pathExists(path.join(sub, 'level.dat'))) {
        return { root: sub, baseName: entry };
      }
    } catch {}
  }
  return null;
}

function sanitizeWorldName(raw) {
  return (raw || 'world').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+$/, '').slice(0, 100) || 'world';
}

async function uniqueWorldName(serverPath, base) {
  let target = base;
  for (let n = 2; await fs.pathExists(path.join(serverPath, target)); n++) target = `${base} (${n})`;
  return target;
}

function register(app) {
  const worldUpload = multer({
    dest: path.join(os.tmpdir(), 'minedash-server-worlds'),
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

  app.get('/api/servers/:id/worlds', async (req, res) => {
    const ctx = await resolve(req, res);
    if (!ctx) return;
    const worlds = await listWorlds(ctx.serverPath);
    const active = await readLevelName(ctx.serverPath);
    res.json({
      worlds: worlds.map(w => ({ ...w, active: w.name === active })),
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
    const { converted } = await applyLayout(ctx.serverPath, req.params.name, ctx.cfg.type);
    await writeLevelName(ctx.serverPath, req.params.name);
    res.json({ ok: true, active: req.params.name, converted });
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

    const tmpExtract = `${req.file.path}-extracted`;
    try {
      await extractZip(req.file.path, tmpExtract);
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
        const src = path.join(path.dirname(found.root), `${found.baseName}${suffix}`);
        if (await fs.pathExists(src)) {
          await fs.move(src, path.join(ctx.serverPath, `${target}${suffix}`), { overwrite: true }).catch(() => {});
        }
      }

      const { layout, converted } = await applyLayout(ctx.serverPath, target, ctx.cfg.type);

      let activated = false;
      if (req.query.activate === '1' || req.body?.activate === '1') {
        await writeLevelName(ctx.serverPath, target);
        activated = true;
      }
      if (io) io.emit('server_worlds_changed', { serverId: req.params.id });
      res.json({ ok: true, name: target, layout, converted, activated });
    } catch (err) {
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
    if (await fs.pathExists(path.join(ctx.serverPath, newName))) {
      return res.status(409).json({ error: `A world named "${newName}" already exists.` });
    }

    const parts = await worldParts(ctx.serverPath, req.params.name);
    try {
      for (const p of parts) {
        await fs.move(p.dir, path.join(ctx.serverPath, `${newName}${p.suffix}`), { overwrite: false });
      }
    } catch (err) {
      return res.status(500).json({ error: `Rename failed: ${err.message}` });
    }
    if (await readLevelName(ctx.serverPath) === req.params.name) {
      await writeLevelName(ctx.serverPath, newName);
    }
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
    res.json({ ok: true, name: copyName });
  });

  app.delete('/api/servers/:id/worlds/:name', async (req, res) => {
    const ctx = await resolve(req, res, { requireStopped: true });
    if (!ctx) return;
    const dir = safeChild(ctx.serverPath, req.params.name);
    if (!dir || !await fs.pathExists(dir)) return res.status(404).json({ error: 'World not found' });
    if (await readLevelName(ctx.serverPath) === req.params.name) {
      return res.status(409).json({
        error: 'That world is the one the server loads. Switch to another world first, then delete it.',
      });
    }
    const parts = await worldParts(ctx.serverPath, req.params.name);
    try {
      for (const p of parts) await fs.remove(p.dir);
    } catch (err) {
      return res.status(500).json({ error: `Delete failed: ${err.message}` });
    }
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
  readLevelName,
  writeLevelName,
  toBukkitLayout,
  toVanillaLayout,
  usesBukkitLayout,
};
