// ─── Server file manager ──────────────────────────────────────────────────────
//
// Browse, edit, upload and download anything inside instances/<id>/. Every
// other panel in MineDash is a curated view of a few specific files (mods,
// properties, backups); this is the escape hatch for the long tail — ops.json,
// a mod's config/ TOML, banned-ips.json, a datapack's function files, the
// whitelist a plugin invented — without alt-tabbing to Explorer.
//
// Paths travel as a `?path=` query string, deliberately, rather than as route
// params: a file path contains slashes, which Express would split across
// params, and index.js's global app.param guard rejects any :filename holding a
// separator. Every path is funnelled through resolvePath() below, which is the
// single place traversal is checked.
//
// Mirrors the init()/register() shape of launcher.js and connect.js.

const path = require('path');
const fs = require('fs-extra');
const multer = require('multer');
const os = require('os');
const express = require('express');
const AdmZip = require('adm-zip');
const archiver = require('archiver');

let INSTANCES_DIR = null;
let getServers = null;  // async () => servers[]
let isRunning = null;   // (serverId) => boolean

function init(deps) {
  INSTANCES_DIR = deps.INSTANCES_DIR;
  getServers = deps.getServers;
  isRunning = deps.isRunning;
}

// Files a user editing by hand would only ever break, and which MineDash owns
// the lifecycle of. Hidden from listings so the panel reads as "your server's
// files" rather than MineDash's bookkeeping.
const HIDDEN_ENTRIES = new Set([
  '.mod-metadata.json',      // mods/ — icon + Modrinth project cache
  '.minedash-plugins.json',  // plugins/ — the Hangar equivalent
  '.minedash-modpacks.json', // per-modpack installed-file manifests
]);

// Extensions we'll open in the built-in text editor. Everything else is offered
// as a download instead — opening a 30 MB region file in a <textarea> helps
// nobody. Extension-based rather than content-sniffing because Minecraft config
// files are reliably named and sniffing UTF-8 is its own rabbit hole.
const TEXT_EXTENSIONS = new Set([
  '.txt', '.json', '.json5', '.jsonc', '.properties', '.yml', '.yaml', '.toml',
  '.cfg', '.conf', '.config', '.ini', '.log', '.md', '.mcmeta', '.mcfunction',
  '.snbt', '.js', '.ts', '.sh', '.bat', '.csv', '.xml', '.html', '.css', '.lang',
  '.nbt.txt', '.gitignore', '.env',
]);

// Cap what the editor will load. Above this the file is download-only: the
// editor sends the whole buffer back on save, so a huge file means a huge POST
// and a browser tab that janks while typing.
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

function isTextFile(name, sizeBytes) {
  if (sizeBytes > MAX_EDIT_BYTES) return false;
  const lower = name.toLowerCase();
  if (TEXT_EXTENSIONS.has(path.extname(lower))) return true;
  // Extension-less files Minecraft/Java servers actually ship.
  return ['eula.txt', 'ops.json', 'usercache.json', 'banned-players.json'].includes(lower);
}

// The one traversal check. `rel` is whatever the client sent; the result is
// guaranteed to sit inside the server's instance folder (or be the folder
// itself). Throws rather than returning null so a caller can't forget to check.
function resolvePath(serverPath, rel) {
  const raw = typeof rel === 'string' ? rel : '';
  // Normalise separators so a Windows-style path from the client behaves the
  // same as a POSIX one, then strip any leading separator — every path the
  // client sends is relative to the instance root.
  const normalized = path.normalize(raw.replace(/\\/g, '/')).replace(/^([\\/]+)/, '');
  const resolved = path.resolve(path.join(serverPath, normalized));
  const root = path.resolve(serverPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Refusing a path outside the server folder.');
  }
  return resolved;
}

// Relative, forward-slashed path for sending back to the client. The UI builds
// every subsequent request from these, so they must round-trip through
// resolvePath() unchanged.
function toRelative(serverPath, abs) {
  const rel = path.relative(path.resolve(serverPath), abs);
  return rel.split(path.sep).join('/');
}

async function listDir(serverPath, absDir) {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (HIDDEN_ENTRIES.has(e.name)) continue;
    const abs = path.join(absDir, e.name);
    let stat;
    try { stat = await fs.stat(abs); } catch { continue; } // broken symlink / vanished mid-listing
    const isDir = stat.isDirectory();
    out.push({
      name: e.name,
      path: toRelative(serverPath, abs),
      isDir,
      sizeBytes: isDir ? null : stat.size,
      modifiedAt: stat.mtimeMs,
      editable: !isDir && isTextFile(e.name, stat.size),
    });
  }
  // Folders first, then case-insensitive name — what every file manager does,
  // and what makes mods/ and config/ easy to find in a cluttered instance root.
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return out;
}

function register(app) {
  const fileUpload = multer({
    dest: path.join(os.tmpdir(), 'minedash-server-files'),
    limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  });
  // The global express.json() is capped at the default 100 KB, which a chunky
  // config (a big Create or GregTech TOML) blows straight past on save.
  const jsonBody = express.json({ limit: '8mb' });

  const resolve = async (req, res) => {
    const { id } = req.params;
    const servers = await getServers();
    const cfg = servers.find(s => s.id === id);
    if (!cfg) { res.status(404).json({ error: 'Server not found' }); return null; }
    return { cfg, serverPath: path.join(INSTANCES_DIR, id) };
  };

  // Wrap a handler so a traversal rejection becomes a 400 rather than a 500.
  const withPath = (handler) => async (req, res) => {
    const ctx = await resolve(req, res);
    if (!ctx) return;
    let target;
    const rel = req.query.path ?? req.body?.path ?? '';
    try { target = resolvePath(ctx.serverPath, rel); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    return handler(req, res, { ...ctx, target, rel });
  };

  // ── Browse ──────────────────────────────────────────────────────────────────
  app.get('/api/servers/:id/files', withPath(async (req, res, { serverPath, target }) => {
    let stat;
    try { stat = await fs.stat(target); }
    catch { return res.status(404).json({ error: 'Path not found' }); }
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });

    res.json({
      path: toRelative(serverPath, target),
      entries: await listDir(serverPath, target),
      running: isRunning(req.params.id),
    });
  }));

  // ── Read a file into the editor ─────────────────────────────────────────────
  app.get('/api/servers/:id/files/content', withPath(async (req, res, { serverPath, target }) => {
    let stat;
    try { stat = await fs.stat(target); }
    catch { return res.status(404).json({ error: 'File not found' }); }
    if (stat.isDirectory()) return res.status(400).json({ error: 'That is a folder' });
    if (stat.size > MAX_EDIT_BYTES) {
      return res.status(413).json({
        error: `That file is ${(stat.size / (1024 * 1024)).toFixed(1)} MB — too big to edit here. Download it instead.`,
      });
    }
    const content = await fs.readFile(target, 'utf8');
    res.json({
      path: toRelative(serverPath, target),
      content,
      sizeBytes: stat.size,
      modifiedAt: stat.mtimeMs,
    });
  }));

  // ── Save an edited file ─────────────────────────────────────────────────────
  // Writes via a temp file in the same directory then renames, so a failed or
  // interrupted write can't leave a half-truncated server.properties behind —
  // which would be a server that won't boot.
  app.put('/api/servers/:id/files/content', jsonBody, withPath(async (req, res, { serverPath, target }) => {
    const content = req.body?.content;
    if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
    let stat;
    try { stat = await fs.stat(target); }
    catch { return res.status(404).json({ error: 'File not found' }); }
    if (stat.isDirectory()) return res.status(400).json({ error: 'That is a folder' });

    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.minedash-tmp`);
    try {
      await fs.writeFile(tmp, content, 'utf8');
      await fs.move(tmp, target, { overwrite: true });
    } catch (err) {
      await fs.remove(tmp).catch(() => {});
      return res.status(500).json({ error: `Save failed: ${err.message}` });
    }
    const after = await fs.stat(target);
    res.json({
      ok: true,
      path: toRelative(serverPath, target),
      sizeBytes: after.size,
      modifiedAt: after.mtimeMs,
      // The UI turns this into "restart to apply" rather than acting on it —
      // silently bouncing someone's server because they saved a file would be
      // a genuinely bad surprise.
      running: isRunning(req.params.id),
    });
  }));

  // ── Download (a file as-is, a folder as a zip) ───────────────────────────────
  app.get('/api/servers/:id/files/download', withPath(async (req, res, { target }) => {
    let stat;
    try { stat = await fs.stat(target); }
    catch { return res.status(404).json({ error: 'Path not found' }); }

    if (!stat.isDirectory()) return res.download(target, path.basename(target));

    res.attachment(`${path.basename(target) || 'server'}.zip`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => { try { res.destroy(err); } catch {} });
    archive.on('warning', () => {});
    archive.glob('**/*', { cwd: target, ignore: ['session.lock'], dot: true });
    archive.pipe(res);
    archive.finalize();
  }));

  // ── Upload into the current folder ──────────────────────────────────────────
  app.post('/api/servers/:id/files/upload', fileUpload.array('file', 50), withPath(async (req, res, { serverPath, target }) => {
    const files = req.files || [];
    const cleanup = async () => { for (const f of files) await fs.remove(f.path).catch(() => {}); };
    if (files.length === 0) return res.status(400).json({ error: 'No file uploaded' });

    let stat;
    try { stat = await fs.stat(target); }
    catch { await cleanup(); return res.status(404).json({ error: 'Folder not found' }); }
    if (!stat.isDirectory()) { await cleanup(); return res.status(400).json({ error: 'Upload target is not a folder' }); }

    // Per-file results rather than all-or-nothing: dropping ten files and being
    // told only that "the upload failed" is useless when one of them was bad.
    const uploaded = [];
    const failed = [];
    for (const f of files) {
      const name = path.basename(f.originalname || '');
      if (!name || name === '.' || name === '..') {
        failed.push({ filename: f.originalname || '(unnamed)', reason: 'Invalid filename' });
        await fs.remove(f.path).catch(() => {});
        continue;
      }
      try {
        const dest = resolvePath(serverPath, path.join(toRelative(serverPath, target), name));
        await fs.move(f.path, dest, { overwrite: true });
        uploaded.push(name);
      } catch (err) {
        failed.push({ filename: name, reason: err.message });
        await fs.remove(f.path).catch(() => {});
      }
    }
    res.status(failed.length > 0 && uploaded.length > 0 ? 207 : 200).json({ uploaded, failed });
  }));

  // ── New folder ──────────────────────────────────────────────────────────────
  app.post('/api/servers/:id/files/mkdir', jsonBody, withPath(async (req, res, { serverPath, target }) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (/[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') {
      return res.status(400).json({ error: 'That name contains characters a folder can\'t have.' });
    }
    const dest = path.join(target, name);
    if (await fs.pathExists(dest)) return res.status(409).json({ error: `"${name}" already exists.` });
    await fs.ensureDir(dest);
    res.json({ ok: true, path: toRelative(serverPath, dest) });
  }));

  // ── Rename ──────────────────────────────────────────────────────────────────
  app.post('/api/servers/:id/files/rename', jsonBody, withPath(async (req, res, { serverPath, target }) => {
    const newName = typeof req.body?.newName === 'string' ? req.body.newName.trim() : '';
    if (!newName) return res.status(400).json({ error: 'newName is required' });
    if (/[\\/:*?"<>|]/.test(newName) || newName === '.' || newName === '..') {
      return res.status(400).json({ error: 'That name contains characters a file can\'t have.' });
    }
    if (path.resolve(target) === path.resolve(path.join(INSTANCES_DIR, req.params.id))) {
      return res.status(400).json({ error: 'Rename the server from its Options tab, not here.' });
    }
    if (!await fs.pathExists(target)) return res.status(404).json({ error: 'Path not found' });

    const dest = path.join(path.dirname(target), newName);
    if (await fs.pathExists(dest)) return res.status(409).json({ error: `"${newName}" already exists.` });
    try { await fs.move(target, dest); }
    catch (err) { return res.status(500).json({ error: `Rename failed: ${err.message}` }); }
    res.json({ ok: true, path: toRelative(serverPath, dest) });
  }));

  // ── Delete ──────────────────────────────────────────────────────────────────
  app.delete('/api/servers/:id/files', withPath(async (req, res, { target }) => {
    if (path.resolve(target) === path.resolve(path.join(INSTANCES_DIR, req.params.id))) {
      return res.status(400).json({ error: 'That would delete the whole server. Use Options → Delete server.' });
    }
    if (!await fs.pathExists(target)) return res.status(404).json({ error: 'Path not found' });
    try { await fs.remove(target); }
    catch (err) {
      return res.status(500).json({
        error: `Delete failed: ${err.message}${isRunning(req.params.id) ? ' — the server is running and may be holding the file open.' : ''}`,
      });
    }
    res.json({ ok: true });
  }));

  // ── Extract a zip in place ──────────────────────────────────────────────────
  // The thing you otherwise have to leave the app for: a plugin bundle, a
  // config pack, a datapack collection that ships zipped.
  app.post('/api/servers/:id/files/extract', jsonBody, withPath(async (req, res, { serverPath, target }) => {
    if (!/\.zip$/i.test(target)) return res.status(400).json({ error: 'Only .zip files can be extracted.' });
    if (!await fs.pathExists(target)) return res.status(404).json({ error: 'File not found' });

    const destDir = path.dirname(target);
    let extracted = 0;
    try {
      const zip = new AdmZip(target);
      for (const entry of zip.getEntries()) {
        // Same zip-slip guard as the world importer: adm-zip only sanitises
        // inside its own extractAllTo, and this walks the entries by hand.
        const rel = path.normalize(entry.entryName.replace(/\\/g, '/')).replace(/^([\\/]+)/, '');
        let abs;
        try { abs = resolvePath(destDir, rel); }
        catch { return res.status(400).json({ error: `Refusing unsafe path in zip: ${entry.entryName}` }); }
        if (entry.isDirectory) { await fs.ensureDir(abs); continue; }
        await fs.ensureDir(path.dirname(abs));
        await fs.writeFile(abs, entry.getData());
        extracted++;
      }
    } catch (err) {
      return res.status(500).json({ error: `Extract failed: ${err.message}` });
    }
    res.json({ ok: true, extracted, path: toRelative(serverPath, destDir) });
  }));
}

module.exports = { init, register, resolvePath, isTextFile, MAX_EDIT_BYTES };
