// authlib-injector JAR management for Ely.by (and, later, other Yggdrasil
// providers). The injector is a Java agent that reroutes Minecraft's auth /
// skin calls to a custom Yggdrasil server (here: Ely.by). We download it on
// first need, verify its sha256, and cache it under the data dir.
//
// Resolution / freshness:
//   - JAR lives at  <DATA_DIR>/authlib-injector/authlib-injector.jar
//   - metadata (version, sha256, checkedAt) sits beside it in meta.json
//   - we re-check the live "latest" metadata at most once every 7 days; a fresh
//     cached JAR short-circuits the network entirely
//
// Failure policy (deliberate): if the live fetch fails but we already have a
// cached JAR, we use the cached one (an outage shouldn't block launches). Only
// when there is NO cached JAR *and* both the live metadata and the bundled
// fallback fail do we throw — the caller turns that into a clear "can't launch
// with Ely.by accounts" error rather than launching into a broken auth state.
//
// dns.setDefaultResultOrder('ipv4first') is set process-wide by whoever loads
// us (backend/index.js and launcher-worker.js both do it), so the yushi.moe
// fetches here inherit the IPv4 preference. Nothing to do in this module.

const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');

const LATEST_META_URL = 'https://authlib-injector.yushi.moe/artifact/latest.json';
const RECHECK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const META_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

// Known-good fallback, pinned in code, used only when the live metadata fetch
// fails AND there is no cached JAR. Always prefer the live metadata for the
// latest fixes — this is the brick-proofing escape hatch, not the default path.
// (Captured from latest.json on 2026-05-29 — build 55 / v1.2.7.)
const FALLBACK_META = {
  version: '1.2.7',
  download_url: 'https://authlib-injector.yushi.moe/artifact/55/authlib-injector-1.2.7.jar',
  sha256: 'eaf14bc5acffc7d885bd5bd5942b99f36d6299302beae356b2fc5807fe42652b',
};

const injectorDir = (dataDir) => path.join(dataDir, 'authlib-injector');
const jarPath = (dataDir) => path.join(injectorDir(dataDir), 'authlib-injector.jar');
const metaPath = (dataDir) => path.join(injectorDir(dataDir), 'meta.json');

async function sha256File(p) {
  const buf = await fs.readFile(p);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function fetchLatestMeta() {
  const r = await fetch(LATEST_META_URL, { signal: AbortSignal.timeout(META_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`authlib-injector metadata returned ${r.status}`);
  const d = await r.json();
  if (!d.download_url) throw new Error('authlib-injector metadata missing download_url');
  return { version: d.version, download_url: d.download_url, sha256: d.checksums?.sha256 || null };
}

// Stream the JAR to a .tmp file, verify sha256 (if known), then atomically
// rename into place and record the metadata. Throws on download / checksum
// failure (leaving any existing JAR untouched, since we never overwrite until
// the rename).
async function downloadAndVerify(dataDir, meta) {
  await fs.ensureDir(injectorDir(dataDir));
  const tmp = jarPath(dataDir) + '.tmp';
  try {
    const r = await fetch(meta.download_url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`authlib-injector download returned ${r.status}`);
    await fs.writeFile(tmp, Buffer.from(await r.arrayBuffer()));
    if (meta.sha256) {
      const got = await sha256File(tmp);
      if (got.toLowerCase() !== meta.sha256.toLowerCase()) {
        throw new Error(`authlib-injector checksum mismatch (expected ${meta.sha256}, got ${got})`);
      }
    }
    await fs.move(tmp, jarPath(dataDir), { overwrite: true });
    await fs.writeJson(metaPath(dataDir), {
      version: meta.version, sha256: meta.sha256, checkedAt: Date.now(),
    }, { spaces: 2 });
  } finally {
    if (await fs.pathExists(tmp)) { try { await fs.remove(tmp); } catch {} }
  }
}

// Ensure a usable authlib-injector JAR exists and return its absolute path.
// See module header for the freshness + failure policy.
async function ensureAuthlibInjector(dataDir) {
  const jar = jarPath(dataDir);
  const haveJar = await fs.pathExists(jar);

  let meta = null;
  try { meta = await fs.readJson(metaPath(dataDir)); } catch {}
  const fresh = meta && (Date.now() - (meta.checkedAt || 0) < RECHECK_MS);
  if (haveJar && fresh) return jar;

  // Either no JAR, or the cached metadata is stale — consult the live source.
  try {
    const latest = await fetchLatestMeta();
    if (haveJar && meta && meta.version === latest.version) {
      // Same version we already have — just refresh the check timestamp so we
      // don't re-hit the network for another 7 days.
      await fs.writeJson(metaPath(dataDir), { ...meta, checkedAt: Date.now() }, { spaces: 2 });
      return jar;
    }
    await downloadAndVerify(dataDir, latest);
    return jar;
  } catch (liveErr) {
    // Live recheck failed. If we already have a JAR, keep using it — an outage
    // shouldn't block a launch when we have a perfectly good cached copy.
    if (haveJar) return jar;
    // No JAR at all — try the pinned fallback as a last resort.
    try {
      await downloadAndVerify(dataDir, FALLBACK_META);
      return jar;
    } catch (fbErr) {
      throw new Error(
        "authlib-injector unavailable, can't launch with Ely.by accounts — " +
        'try again in a moment, or switch to a different account.',
      );
    }
  }
}

// Fetch Ely.by's authlib-injector API metadata and return it base64-encoded,
// ready to drop into -Dauthlibinjector.yggdrasil.prefetched=. Prefetching this
// lets the game skip the initial ALI metadata round-trip at startup. 10s
// timeout — the caller treats a timeout as a hard launch failure (a bad auth
// state in-game is far worse than a clear failure here).
async function fetchPrefetchMeta() {
  const r = await fetch('https://authserver.ely.by/api/authlib-injector', {
    signal: AbortSignal.timeout(META_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`Ely.by prefetch metadata returned ${r.status}`);
  const text = await r.text();
  return Buffer.from(text, 'utf8').toString('base64');
}

module.exports = { ensureAuthlibInjector, fetchPrefetchMeta, jarPath };
