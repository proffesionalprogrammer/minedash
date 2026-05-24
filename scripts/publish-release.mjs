// One-shot publisher for the current MineDash release. Retries each step until
// the flaky route to GitHub holds for one full request. Idempotent — safe to
// re-run if an upload stalls partway through.
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';

const REPO = 'proffesionalprogrammer/minedash-releases';
const TAG = 'v1.0.9';
const NAME = '1.0.9';
const NOTES =
  "MineDash 1.0.9 — Content tab now opens instantly even on a 500-mod modpack " +
  "(was 20s every open because Modrinth 'miss' entries were re-checked forever; " +
  "lookedUp is final now and first opens get a 1.5s enrichment budget with the " +
  "rest finishing in the background). Launch runs in a forked subprocess so Stop " +
  "is genuinely instant during downloads. Drag-and-drop multi-upload on both the " +
  "launcher Content tab and the server Mods tab. Manual mod upload in the launcher " +
  "for CurseForge-only mods like FTB Quests. Per-server launcher instance (no more " +
  "different servers smashing each other's mod lists). Modpack install progress " +
  "survives tab switches. Sort + pagination in the launcher Content tab. Modpack " +
  "importer filters dozens more client-only mods (ColorWheel, FancyMenu, Konkrete, " +
  "Forge Config Screen, Configured, EMF/ETF, sound physics, Xaero Map Plus, Free " +
  "Cam, Replay Mod, and more) out of dedicated servers.";
const ASSETS = [
  'dist-electron/MineDash-Setup-1.0.9.exe',
  'dist-electron/MineDash-Setup-1.0.9.exe.blockmap',
  'dist-electron/latest.yml',
];

const TOKEN = execSync('gh auth token', { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf });
      });
    });
    r.on('error', reject);
    r.setTimeout(45000, () => r.destroy(new Error('timeout')));
    if (body) {
      if (Buffer.isBuffer(body)) r.write(body);
      else r.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    r.end();
  });
}

async function withRetry(label, fn, { tries = 30, delay = 3000 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      process.stdout.write(`[${label}] attempt ${i}/${tries}... `);
      const r = await fn();
      console.log('OK');
      return r;
    } catch (e) {
      lastErr = e;
      console.log(`FAIL (${e.message})`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'User-Agent': 'minedash-release-script',
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function getRelease() {
  const r = await req({
    method: 'GET',
    hostname: 'api.github.com',
    path: `/repos/${REPO}/releases/tags/${TAG}`,
    headers,
  });
  if (r.status === 404) return null;
  if (r.status >= 200 && r.status < 300) return JSON.parse(r.body.toString());
  throw new Error(`GET release status=${r.status} body=${r.body.toString().slice(0, 200)}`);
}

async function createRelease() {
  const r = await req(
    {
      method: 'POST',
      hostname: 'api.github.com',
      path: `/repos/${REPO}/releases`,
      headers: { ...headers, 'Content-Type': 'application/json' },
    },
    { tag_name: TAG, name: NAME, body: NOTES, draft: false, prerelease: false }
  );
  if (r.status === 201) return JSON.parse(r.body.toString());
  // Race: another attempt may have created it
  if (r.status === 422) return await getRelease();
  throw new Error(`POST release status=${r.status} body=${r.body.toString().slice(0, 300)}`);
}

async function uploadAsset(release, assetPath) {
  const name = path.basename(assetPath);
  const existing = (release.assets || []).find((a) => a.name === name);
  if (existing) {
    console.log(`[asset ${name}] already uploaded (id=${existing.id})`);
    return existing;
  }
  const buf = fs.readFileSync(assetPath);
  const uploadHost = 'uploads.github.com';
  const uploadPath = `/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  const ct = name.endsWith('.yml')
    ? 'text/yaml'
    : name.endsWith('.blockmap')
    ? 'application/octet-stream'
    : 'application/octet-stream';
  const r = await req(
    {
      method: 'POST',
      hostname: uploadHost,
      path: uploadPath,
      headers: {
        ...headers,
        'Content-Type': ct,
        'Content-Length': buf.length,
      },
    },
    buf
  );
  if (r.status === 201) return JSON.parse(r.body.toString());
  throw new Error(`upload ${name} status=${r.status} body=${r.body.toString().slice(0, 300)}`);
}

(async () => {
  let release = await withRetry('get-release', getRelease);
  if (!release) {
    release = await withRetry('create-release', createRelease);
  } else {
    console.log(`Existing release id=${release.id}`);
  }
  for (const a of ASSETS) {
    await withRetry(`upload ${path.basename(a)}`, () => uploadAsset(release, a), { tries: 30, delay: 5000 });
    // Refresh release so subsequent existence checks see the new asset
    release = await withRetry('refresh', getRelease);
  }
  console.log('\nDONE. Release:', release.html_url);
})().catch((e) => {
  console.error('\nFATAL:', e.message);
  process.exit(1);
});
