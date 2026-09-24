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
const crypto = require('crypto');

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
  // path.extname() treats a leading dot as part of the name, so dotfiles like
  // .gitignore / .env are matched on the whole name instead.
  return TEXT_EXTENSIONS.has(path.extname(lower)) || TEXT_EXTENSIONS.has(lower);
}

// Windows and macOS filesystems are case-insensitive, so "Config" and "config"
// are the same entry there — a case-only rename must not read as a collision.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
function samePath(a, b) {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return CASE_INSENSITIVE_FS ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
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

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// An uploaded file's name, reduced to a bare basename, or null if unusable.
function uploadName(raw) {
  const name = path.basename(String(raw || '').replace(/\\/g, '/'));
  if (!name || name === '.' || name === '..') return null;
  return name;
}

// "server.properties" -> "server (2).properties". Dotfiles (".env") keep the
// whole name as the stem; path.extname would otherwise call it all extension.
function numberedName(name, n) {
  const ext = name.startsWith('.') && name.indexOf('.', 1) === -1 ? '' : path.extname(name);
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
}

// Which of `names` already exist in `dir`. Case-insensitive filesystems make
// "Server.properties" clash with "server.properties", and stat agrees with the
// filesystem, so no extra folding is needed here.
async function existingNames(dir, names) {
  const out = [];
  for (const n of names) {
    let st = null;
    try { st = await fs.stat(path.join(dir, n)); } catch {}
    if (st) out.push({ name: n, isDir: st.isDirectory() });
  }
  return out;
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
  // Also drops any multer temp files if the request is rejected before the
  // handler runs — otherwise an upload to a bad path leaks them in os.tmpdir().
  const withPath = (handler) => async (req, res) => {
    const dropUploads = async () => {
      for (const f of req.files || []) await fs.remove(f.path).catch(() => {});
    };
    const ctx = await resolve(req, res);
    if (!ctx) { await dropUploads(); return; }
    let target;
    const rel = req.query.path ?? req.body?.path ?? '';
    try { target = resolvePath(ctx.serverPath, rel); }
    catch (err) { await dropUploads(); return res.status(400).json({ error: err.message }); }
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
    if (!isTextFile(path.basename(target), stat.size)) {
      return res.status(415).json({ error: "That file type can't be edited here. Download it instead." });
    }
    const raw = await fs.readFile(target);
    const content = raw.toString('utf8');
    // A lossy decode (Latin-1 lang file, a binary with a .txt name) would come
    // back full of U+FFFD, and saving it would write those over the original
    // bytes. Refuse up front instead.
    if (!Buffer.from(content, 'utf8').equals(raw)) {
      return res.status(415).json({ error: "That file isn't UTF-8 text, so editing it here would corrupt it. Download it instead." });
    }
    res.json({
      path: toRelative(serverPath, target),
      content,
      sizeBytes: stat.size,
      modifiedAt: stat.mtimeMs,
      // Sent back on save so a touched-but-unchanged file (a running server
      // rewrites ops.json with identical bytes all the time) isn't a conflict.
      hash: sha1(raw),
    });
  }));

  // ── Save an edited file ─────────────────────────────────────────────────────
  // Writes via a temp file in the same directory then renames, so a failed or
  // interrupted write can't leave a half-truncated server.properties behind —
  // which would be a server that won't boot.
  //
  // Body: { content, expectedModifiedAt?, expectedHash?, force? }. A running
  // server rewrites ops.json, whitelist.json, server.properties and friends on
  // its own, so the file on disk may have moved on since the editor loaded it.
  // When `expectedModifiedAt` no longer matches, the save is refused with 409
  // unless the bytes are still the ones the editor loaded (`expectedHash`) —
  // a rewrite with identical content is not a conflict. `force` overwrites.
  app.put('/api/servers/:id/files/content', jsonBody, withPath(async (req, res, { serverPath, target }) => {
    const content = req.body?.content;
    if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
    let stat;
    try { stat = await fs.stat(target); }
    catch { return res.status(404).json({ error: 'File not found' }); }
    if (stat.isDirectory()) return res.status(400).json({ error: 'That is a folder' });
    if (!isTextFile(path.basename(target), 0)) {
      return res.status(415).json({ error: "That file type can't be edited here." });
    }

    const expectedAt = Number(req.body?.expectedModifiedAt);
    // mtimeMs round-trips through JSON exactly; the slack only absorbs
    // filesystems that report sub-millisecond noise between stat calls.
    if (req.body?.force !== true && req.body?.expectedModifiedAt != null
        && Number.isFinite(expectedAt) && Math.abs(stat.mtimeMs - expectedAt) > 1) {
      const expectedHash = typeof req.body?.expectedHash === 'string' ? req.body.expectedHash : null;
      const unchanged = expectedHash && sha1(await fs.readFile(target)) === expectedHash;
      if (!unchanged) {
        return res.status(409).json({
          error: `${path.basename(target)} changed on disk since you opened it.`,
          conflict: true,
          modifiedAt: stat.mtimeMs,
          running: isRunning(req.params.id),
        });
      }
    }

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
      hash: sha1(Buffer.from(content, 'utf8')),
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
    // session.lock sits inside each world folder, not just at the root; a running
    // server holds an OS lock on it and reading it would abort the whole zip.
    archive.glob('**/*', { cwd: target, ignore: ['session.lock', '**/session.lock'], dot: true });
    archive.pipe(res);
    archive.finalize();
  }));

  // ── Upload into the current folder ──────────────────────────────────────────
  // Which of these names are already taken in the folder? The UI asks this
  // before uploading so a clash can be settled (Replace / Keep both) without
  // sending a multi-GB drop twice. Body: { names: string[] }.
  app.post('/api/servers/:id/files/conflicts', jsonBody, withPath(async (req, res, { target }) => {
    const names = (Array.isArray(req.body?.names) ? req.body.names : []).map(uploadName).filter(Boolean);
    let stat;
    try { stat = await fs.stat(target); }
    catch { return res.status(404).json({ error: 'Folder not found' }); }
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a folder' });
    res.json({ conflicts: await existingNames(target, [...new Set(names)]) });
  }));

  // `?onConflict=` decides what happens to a name that already exists:
  //   ask (default) — nothing is written; 409 with `conflicts[]` so the UI can
  //                   ask. Silently replacing was how a dropped
  //                   server.properties wiped the real one.
  //   replace       — overwrite files. Never a folder: fs.move would delete the
  //                   whole folder (a world!) to put one file in its place.
  //   keep-both     — the upload lands as "name (2).ext".
  app.post('/api/servers/:id/files/upload', fileUpload.array('file', 50), withPath(async (req, res, { serverPath, target }) => {
    const files = req.files || [];
    const cleanup = async () => { for (const f of files) await fs.remove(f.path).catch(() => {}); };
    if (files.length === 0) return res.status(400).json({ error: 'No file uploaded' });
    const mode = ['replace', 'keep-both'].includes(req.query.onConflict) ? req.query.onConflict : 'ask';

    let stat;
    try { stat = await fs.stat(target); }
    catch { await cleanup(); return res.status(404).json({ error: 'Folder not found' }); }
    if (!stat.isDirectory()) { await cleanup(); return res.status(400).json({ error: 'Upload target is not a folder' }); }

    if (mode === 'ask') {
      const names = [...new Set(files.map(f => uploadName(f.originalname)).filter(Boolean))];
      const conflicts = await existingNames(target, names);
      if (conflicts.length > 0) {
        await cleanup();
        return res.status(409).json({
          error: conflicts.length === 1
            ? `"${conflicts[0].name}" already exists in this folder.`
            : `${conflicts.length} files already exist in this folder.`,
          conflicts,
        });
      }
    }

    // Per-file results rather than all-or-nothing: dropping ten files and being
    // told only that "the upload failed" is useless when one of them was bad.
    const uploaded = [];
    const failed = [];
    const claimed = new Set(); // names this batch has already written (keep-both)
    const fold = (n) => (CASE_INSENSITIVE_FS ? n.toLowerCase() : n);
    for (const f of files) {
      const name = uploadName(f.originalname);
      if (!name) {
        failed.push({ filename: f.originalname || '(unnamed)', reason: 'Invalid filename' });
        await fs.remove(f.path).catch(() => {});
        continue;
      }
      try {
        let finalName = name;
        if (mode === 'keep-both') {
          for (let n = 2; claimed.has(fold(finalName)) || await fs.pathExists(path.join(target, finalName)); n++) {
            finalName = numberedName(name, n);
          }
        }
        const dest = resolvePath(serverPath, path.join(toRelative(serverPath, target), finalName));
        const existing = await fs.stat(dest).catch(() => null);
        if (existing?.isDirectory()) throw new Error('A folder with that name is already here');
        // Appeared since the check above, or a duplicate name within the batch.
        if (existing && mode === 'ask') throw new Error('Already exists');
        await fs.move(f.path, dest, { overwrite: mode === 'replace' });
        claimed.add(fold(finalName));
        uploaded.push(finalName);
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
    // On a case-insensitive filesystem "Config" -> "config" finds itself here;
    // that's a rename, not a collision.
    if (!samePath(dest, target) && await fs.pathExists(dest)) {
      return res.status(409).json({ error: `"${newName}" already exists.` });
    }
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
      // Same zip-slip guard as the world importer: adm-zip only sanitises
      // inside its own extractAllTo, and this walks the entries by hand. Every
      // entry is checked before anything is written, so one bad path can't
      // leave a half-extracted archive behind.
      const planned = [];
      for (const entry of zip.getEntries()) {
        const rel = path.normalize(entry.entryName.replace(/\\/g, '/')).replace(/^([\\/]+)/, '');
        try { planned.push({ entry, abs: resolvePath(destDir, rel) }); }
        catch { return res.status(400).json({ error: `Refusing unsafe path in zip: ${entry.entryName}` }); }
      }
      for (const { entry, abs } of planned) {
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

module.exports = { init, register, resolvePath, isTextFile, numberedName, MAX_EDIT_BYTES };
