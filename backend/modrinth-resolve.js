// ─── Modrinth resolution helpers ───────────────────────────────────────────────
//
// Shared by the server (index.js: crash auto-installer, install-missing) and the
// launcher (launcher.js: client crash auto-fix, compatibility-checked updates).
// Moved here from index.js unchanged apart from taking { api, headers } — the
// server and the launcher send different User-Agents.
//
// A mod's in-game ID is NOT its Modrinth slug — see modIdQueryVariants. Every
// caller that turns an ID into a download must also verify the downloaded jar
// really declares that ID (mod-deps readJarModInfo).

const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');

// Pick the best version from a Modrinth /project/{id}/version response.
// Preference order: release > beta > alpha; within each type, newest by
// date_published. Older code only sorted by type and relied on Modrinth
// returning versions newest-first, which isn't reliable when query filters
// (game_versions, loaders) are applied — the API has been observed returning
// an older release in front of a newer one, so we don't let v82 win over v92.
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

// A mod's in-game ID is rarely its Modrinth slug. `athena` is a Paper *plugin*
// on Modrinth while the mod packs depend on is `athena-ctm`; `fusion` is an
// unrelated mod while the one packs depend on is `fusion-connected-textures`;
// `simplytooltips` 404s and Modrinth's search can't match the run-together form
// at all. So: generate query variants, never trust a bare slug hit, and verify
// the jar we downloaded really declares the ID we were asked for.

// 'simplytooltips' -> ['simplytooltips', 'simply tooltips', 'simply-tooltips'].
// Modrinth's search tokenizes on words, so a split form is what actually
// matches a project titled "Simply Tooltips".
function modIdQueryVariants(modId) {
  const base = String(modId).toLowerCase();
  const variants = new Set([base]);
  const spaced = base.replace(/[-_]+/g, ' ').trim();
  if (spaced !== base) { variants.add(spaced); variants.add(spaced.replace(/ +/g, '-')); }

  // Split a run-together id on known word boundaries. We can't segment
  // arbitrary text, so use a dictionary of words that actually show up in mod
  // names — enough to turn simplytooltips into "simply tooltips".
  const WORDS = [
    'simply', 'simple', 'just', 'enough', 'tooltips', 'tooltip', 'better', 'extra', 'more',
    'mod', 'menu', 'lib', 'library', 'core', 'api', 'utils', 'util', 'tweaks', 'craft',
    'items', 'item', 'blocks', 'block', 'world', 'gen', 'client', 'server', 'config',
    'inventory', 'storage', 'farmers', 'delight', 'create', 'sodium', 'fabric', 'forge',
  ];
  const segment = (str) => {
    if (!str) return [];
    for (const w of WORDS) {
      if (!str.startsWith(w)) continue;
      const rest = segment(str.slice(w.length));
      if (rest !== null) return [w, ...rest];
    }
    return null;
  };
  const parts = segment(base);
  if (parts && parts.length > 1) {
    variants.add(parts.join(' '));
    variants.add(parts.join('-'));
  }
  return [...variants];
}

// Does this Modrinth project plausibly answer the request? Slugs collide across
// project types and loaders (see athena / fusion above), so a candidate must at
// least be a mod that runs on our loader.
function projectMatchesTarget(project, loader, gameVersion) {
  if (!project) return false;
  if (project.project_type && project.project_type !== 'mod') return false;
  const loaders = project.loaders || [];
  if (loader && Array.isArray(loaders) && loaders.length > 0 && !loaders.includes(loader)) return false;
  const gvs = project.game_versions || [];
  if (gameVersion && Array.isArray(gvs) && gvs.length > 0 && !gvs.includes(gameVersion)) return false;
  return true;
}

// Collect candidate projects for one missing mod ID, best guess first.
async function findModrinthCandidates(modId, loader, gameVersion, { api, headers }) {
  const candidates = [];
  const seen = new Set();
  const push = (p, score) => {
    if (!p || !p.id || seen.has(p.id)) return;
    seen.add(p.id);
    candidates.push({ project: p, score });
  };

  // The slug IS sometimes right — but only counts when it's a mod for our
  // loader. Skipping this check is what made 'athena' resolve to a Paper plugin
  // and stop the search dead ("Could not find the missing mods on Modrinth").
  try {
    const r = await fetch(`${api}/project/${encodeURIComponent(modId)}`, { headers });
    if (r.ok) {
      const p = await r.json();
      if (projectMatchesTarget(p, loader, gameVersion)) push(p, 100);
    }
  } catch (_) {}

  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(modId);

  for (const query of modIdQueryVariants(modId)) {
    const facets = [['project_type:mod']];
    if (gameVersion) facets.push([`versions:${gameVersion}`]);
    if (loader) facets.push([`categories:${loader}`]);
    const params = new URLSearchParams({ query, limit: '10', facets: JSON.stringify(facets) });
    try {
      const r = await fetch(`${api}/search?${params}`, { headers });
      if (!r.ok) continue;
      const data = await r.json();
      for (const h of data.hits || []) {
        const slug = norm(h.slug);
        const title = norm(h.title);
        let score = 0;
        if (slug === target || title === target) score = 90;
        else if (slug.startsWith(target) || target.startsWith(slug)) score = 70;   // athena -> athena-ctm
        else if (title.startsWith(target) || target.startsWith(title)) score = 65;  // simplytooltips -> Simply Tooltips
        else if (slug.includes(target) || title.includes(target)) score = 40;
        else continue;
        push({ id: h.project_id, slug: h.slug, title: h.title, icon_url: h.icon_url }, score);
      }
    } catch (_) {}
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 6);
}

// Every version of a project for this loader + game version, newest first.
// Returns [] on any failure — callers treat "no candidates" as "can't fix".
async function projectVersions(projectId, loader, gameVersion, { api, headers }) {
  const params = new URLSearchParams();
  if (loader) params.set('loaders', JSON.stringify([loader]));
  if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));
  try {
    const r = await fetch(`${api}/project/${encodeURIComponent(projectId)}/version?${params}`, { headers });
    if (!r.ok) return [];
    const list = await r.json();
    if (!Array.isArray(list)) return [];
    return list.sort((a, b) => (Date.parse(b.date_published) || 0) - (Date.parse(a.date_published) || 0));
  } catch (_) { return []; }
}

// The Modrinth version a local jar is, by SHA1 — null when Modrinth doesn't
// know the file (CurseForge-only, hand-built).
async function versionForSha1(sha1, { api, headers }) {
  try {
    const r = await fetch(`${api}/version_file/${sha1}?algorithm=sha1`, { headers });
    return r.ok ? await r.json() : null;
  } catch (_) { return null; }
}

function primaryFile(ver) {
  const files = ver?.files || [];
  return files.find(f => f.primary) || files[0] || null;
}

const sha1Of = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// Download a version's file to `dest` (temp-then-rename), verifying the SHA1
// Modrinth publishes. With `cacheDir`, a jar already fetched (e.g. during the
// update check) is reused instead of downloaded again. Throws on failure.
async function downloadVersionFile(file, dest, { headers, cacheDir = null }) {
  const expected = file.hashes?.sha1 || null;
  const cached = cacheDir && expected ? path.join(cacheDir, `${expected}.jar`) : null;
  if (cached && await fs.pathExists(cached)) {
    const buf = await fs.readFile(cached);
    if (sha1Of(buf) === expected) {
      if (path.resolve(cached) !== path.resolve(dest)) await fs.copy(cached, dest, { overwrite: true });
      return dest;
    }
    await fs.remove(cached).catch(() => {});
  }
  const r = await fetch(file.url, { headers });
  if (!r.ok) throw new Error(`Download failed (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (expected && sha1Of(buf) !== expected) throw new Error('Downloaded file failed its checksum');
  await fs.ensureDir(path.dirname(dest));
  const tmp = `${dest}.part`;
  await fs.writeFile(tmp, buf);
  await fs.move(tmp, dest, { overwrite: true });
  if (cached && path.resolve(cached) !== path.resolve(dest)) {
    await fs.ensureDir(cacheDir);
    await fs.copy(dest, cached, { overwrite: true }).catch(() => {});
  }
  return dest;
}

module.exports = {
  pickBestModrinthVersion,
  modIdQueryVariants,
  projectMatchesTarget,
  findModrinthCandidates,
  projectVersions,
  versionForSha1,
  primaryFile,
  downloadVersionFile,
  sha1Of,
};
