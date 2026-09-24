// ─── Streaming zip extraction ─────────────────────────────────────────────────
//
// adm-zip reads the whole archive into memory before it hands out a single
// entry, so importing a 1 GB map cost 1 GB+ of RAM and anything past ~2 GB
// (Node's Buffer ceiling) failed outright. yauzl reads the central directory
// and then streams each entry straight from disk to disk, so memory stays flat
// whatever the archive size.
//
// Two passes over the central directory, which is cheap (no file data is read):
//   1. plan — every entry's path is checked (zip-slip, symlinks) and sized
//      before anything is written, so one bad entry can't leave a
//      half-extracted archive behind;
//   2. extract — entries are piped to disk, reporting uncompressed bytes as
//      they are written so one huge region file moves the bar as it should.

const path = require('path');
const fs = require('fs-extra');
const { pipeline } = require('stream/promises');
const yauzl = require('yauzl');

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    // strictFileNames:false turns Windows-style backslashes into slashes
    // instead of rejecting the whole archive — plenty of maps are zipped that way.
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false, strictFileNames: false }, (err, zf) => {
      if (err) reject(err); else resolve(zf);
    });
  });
}

// Walk every entry, awaiting `onEntry` for each one before reading the next.
async function forEachEntry(zipPath, onEntry) {
  const zf = await openZip(zipPath);
  try {
    await new Promise((resolve, reject) => {
      zf.on('error', reject);
      zf.on('end', resolve);
      zf.on('entry', (entry) => {
        // Wrapped so a synchronous throw rejects too, rather than escaping
        // into yauzl's event loop and taking the whole backend down.
        Promise.resolve().then(() => onEntry(entry, zf)).then(() => zf.readEntry(), reject);
      });
      zf.readEntry();
    });
  } finally {
    zf.close();
  }
}

function openEntryStream(zf, entry) {
  return new Promise((resolve, reject) => {
    zf.openReadStream(entry, (err, stream) => { if (err) reject(err); else resolve(stream); });
  });
}

// A zip entry name as a safe relative path, or null if it tries to escape.
function safeEntryPath(entryName) {
  const normalized = path.normalize(String(entryName).replace(/\\/g, '/')).replace(/^([\\/]+)/, '');
  if (!normalized || normalized === '.') return '';
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) return null;
  if (/^[a-zA-Z]:/.test(normalized)) return null; // "C:foo" is drive-relative on Windows
  return normalized;
}

const isDirEntry = (entry) => /\/$/.test(entry.fileName);
const isSymlinkEntry = (entry) => ((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK;

/**
 * List entries without extracting: [{ name, rel, isDir, size }].
 * Throws on an unsafe path or a symlink entry.
 */
async function planZip(zipPath, { resolveTarget } = {}) {
  const planned = [];
  await forEachEntry(zipPath, (entry) => {
    const rel = safeEntryPath(entry.fileName);
    if (rel === null) throw new Error(`Refusing unsafe path in zip: ${entry.fileName}`);
    if (isSymlinkEntry(entry)) throw new Error(`Refusing symbolic link in zip: ${entry.fileName}`);
    if (rel === '') return;
    const item = { name: entry.fileName, rel, isDir: isDirEntry(entry), size: entry.uncompressedSize || 0 };
    // Callers with their own traversal rules (the Files tab's resolvePath)
    // get a say too; a throw here aborts before anything is written.
    if (resolveTarget) item.target = resolveTarget(rel);
    planned.push(item);
  });
  return planned;
}

/**
 * Extract `zipPath` into `destDir`, streaming. Every entry is validated first.
 *   onProgress(doneBytes, totalBytes) — throttling is the caller's business.
 *   shouldWrite(item) — return false to leave an entry out (conflict handling).
 *   targetFor(item) — override where an entry lands (defaults to destDir/rel).
 * Returns { files, bytes } for what was written.
 */
async function extractZip(zipPath, destDir, { onProgress, shouldWrite, targetFor, plan } = {}) {
  const planned = plan || await planZip(zipPath);
  const byName = new Map(planned.map(p => [p.name, p]));
  let total = 0;
  for (const p of planned) if (!p.isDir && (!shouldWrite || shouldWrite(p))) total += p.size;

  let done = 0;
  let files = 0;
  onProgress?.(0, total);
  await fs.ensureDir(destDir);
  await forEachEntry(zipPath, async (entry, zf) => {
    const item = byName.get(entry.fileName);
    if (!item) return;
    if (shouldWrite && !shouldWrite(item)) return;
    const target = targetFor ? targetFor(item) : (item.target || path.join(destDir, item.rel));
    if (item.isDir) { await fs.ensureDir(target); return; }
    await fs.ensureDir(path.dirname(target));
    const stream = await openEntryStream(zf, entry);
    stream.on('data', (chunk) => { done += chunk.length; onProgress?.(done, total); });
    await pipeline(stream, fs.createWriteStream(target));
    files++;
  });
  onProgress?.(total, total);
  return { files, bytes: done };
}

module.exports = { planZip, extractZip, safeEntryPath };
