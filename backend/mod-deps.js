// Mod dependency graph — reads what a jar *is* and what it *needs*.
//
// Why this exists: Modrinth's `server_side: unsupported` means "this mod has no
// server-side function", NOT "this mod must not be on the server". Loader
// libraries like Athena (athena-ctm), Fusion (fusion-connected-textures) and
// Simply Tooltips are flagged unsupported, yet packs' server mods declare them
// as *mandatory* dependencies — and Forge/NeoForge validate mods.toml deps on a
// dedicated server too. Strip them and the server refuses to boot ("Missing or
// unsupported mandatory dependencies"). That's the Slime Adventures bug.
//
// So before anything removes a jar as "client-only", we ask this module whether
// some other installed mod requires it. Required mods are never stripped.
//
// It also reads versions, version ranges and `breaks` (analyzeJars), so an
// update can be checked against the rest of the folder before it lands — see
// mod-compat.js. Used by index.js, launcher.js and mod-compat.js.
//
// Zero new npm deps — adm-zip is already a root
// dependency (see CLAUDE.md: backend deps must live in the ROOT package.json).

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { satisfies, describePredicate } = require('./mod-versions');

// Mod IDs provided by the platform itself — never "missing", never installable.
const BUILTIN_MOD_IDS = new Set([
  'minecraft', 'java', 'forge', 'neoforge', 'fml', 'fabric-loader', 'fabricloader',
  'quilt_loader', 'quilt_base', 'quilted_fabric_api', 'mcp', 'client', 'server',
]);

// path -> { mtimeMs, size, info }. Reading a few hundred jars costs ~a second;
// servers start often, and the mods tab polls, so cache on file identity.
const jarCache = new Map();

// Cut a trailing `#` comment, ignoring one inside a quoted string.
function stripTomlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#') return line.slice(0, i);
  }
  return line;
}

/**
 * Minimal TOML reader for mods.toml / neoforge.mods.toml.
 *
 * We only need two shapes, so a full TOML parser would be dead weight:
 *   [[mods]]              -> modId = "examplemod"
 *   [[dependencies.examplemod]] -> modId = "athena", mandatory = true / type = "required"
 *
 * Returns { mods: [{modId}], dependencies: { <owner>: [{modId, mandatory}] } }.
 */
function parseModsToml(text) {
  const out = { mods: [], dependencies: {} };
  let table = null;      // 'mods' | { dep: '<owner>' } | null
  let current = null;     // the object rows are being written into

  for (const rawLine of String(text).split(/\r?\n/)) {
    // Real-world mods.toml files write `[[mods]] #mandatory` and
    // `modId = "fusion" #mandatory`, so strip trailing comments — but only a
    // `#` that sits outside a quoted string, or URLs with fragments get cut.
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    // [[mods]] / [[dependencies.owner]] — array-of-tables: start a new entry.
    let m = line.match(/^\[\[\s*([^\]]+?)\s*\]\]$/);
    if (m) {
      const header = m[1].replace(/["']/g, '');
      if (header === 'mods') {
        current = {};
        out.mods.push(current);
        table = 'mods';
      } else if (header.startsWith('dependencies.') || header === 'dependencies') {
        const owner = header.slice('dependencies.'.length) || '*';
        if (!out.dependencies[owner]) out.dependencies[owner] = [];
        current = {};
        out.dependencies[owner].push(current);
        table = 'dep';
      } else {
        current = null;
        table = null;
      }
      continue;
    }

    // [table] — plain table header; we don't consume any of these, but they end
    // whatever array-of-tables entry we were filling.
    if (/^\[[^\[]/.test(line)) { current = null; table = null; continue; }
    if (!current) continue;

    m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1); // unquote
    else if (value === 'true') value = true;
    else if (value === 'false') value = false;
    current[key] = value;
    void table;
  }
  return out;
}

// Normalize the many ways a jar can spell a dependency's optionality.
function isMandatoryForgeDep(dep) {
  if (dep.mandatory === false || dep.mandatory === 'false') return false;
  if (typeof dep.type === 'string') {
    const t = dep.type.toLowerCase();
    // NeoForge 1.21+ uses type = "required" | "optional" | "incompatible" | "discouraged"
    if (t !== 'required') return false;
    return true;
  }
  // Forge's classic form: mandatory = true (default when absent is false, but
  // in practice packs always write it; treat an explicit true as required).
  return dep.mandatory === true || dep.mandatory === 'true';
}

// Each reader returns the same shape for its loader:
//   { flavor, ids, versions: {id: version}, deps: [{ id, range, kind, side }] }
// kind: 'required' | 'breaks'. `range` is the loader's own predicate (a Fabric
// SemVer predicate or a Maven range — see mod-versions.js). `side` is only set
// by mods.toml ('CLIENT' / 'SERVER' / 'BOTH').
function readFabricJson(text) {
  const json = JSON.parse(text);
  const ids = [];
  const versions = {};
  const version = json.version != null ? String(json.version) : null;
  if (json.id) ids.push(String(json.id).toLowerCase());
  for (const p of json.provides || []) ids.push(String(p).toLowerCase());
  for (const id of ids) if (version) versions[id] = version;
  const deps = [];
  for (const [k, range] of Object.entries(json.depends || {})) deps.push({ id: k.toLowerCase(), range, kind: 'required' });
  for (const [k, range] of Object.entries(json.breaks || {})) deps.push({ id: k.toLowerCase(), range, kind: 'breaks' });
  return { flavor: 'fabric', ids, versions, deps };
}

function readQuiltJson(text) {
  const json = JSON.parse(text);
  const ql = json.quilt_loader || {};
  const ids = [];
  const versions = {};
  const version = ql.version != null ? String(ql.version) : null;
  if (ql.id) ids.push(String(ql.id).toLowerCase());
  for (const p of ql.provides || []) {
    const pid = String(typeof p === 'string' ? p : p.id || '').toLowerCase();
    if (!pid) continue;
    ids.push(pid);
    if (typeof p === 'object' && p.version) versions[pid] = String(p.version);
  }
  for (const id of ids) if (version && !versions[id]) versions[id] = version;
  const deps = [];
  for (const d of ql.depends || []) {
    if (typeof d === 'string') { deps.push({ id: d.toLowerCase(), range: null, kind: 'required' }); continue; }
    if (d && d.id && !d.optional) deps.push({ id: String(d.id).toLowerCase(), range: d.versions ?? null, kind: 'required' });
  }
  for (const d of ql.breaks || []) {
    if (typeof d === 'string') { deps.push({ id: d.toLowerCase(), range: null, kind: 'breaks' }); continue; }
    if (d && d.id) deps.push({ id: String(d.id).toLowerCase(), range: d.versions ?? null, kind: 'breaks' });
  }
  return { flavor: 'quilt', ids: ids.filter(Boolean), versions, deps };
}

// mods.toml writes `version = "${file.jarVersion}"`, which the loader fills in
// from the jar manifest's Implementation-Version.
function manifestVersion(zip) {
  const e = zip.getEntry('META-INF/MANIFEST.MF');
  if (!e) return null;
  try {
    const m = /^Implementation-Version:\s*(.+)$/mi.exec(e.getData().toString('utf8'));
    return m ? m[1].trim() : null;
  } catch (_) { return null; }
}

function readModsToml(text, zip) {
  const toml = parseModsToml(text);
  const ids = [];
  const versions = {};
  for (const mod of toml.mods) {
    if (!mod.modId) continue;
    const id = String(mod.modId).toLowerCase();
    ids.push(id);
    let v = mod.version != null ? String(mod.version) : null;
    if (v && /\$\{file\.jarVersion\}/.test(v)) v = manifestVersion(zip);
    if (v && !/\$\{/.test(v)) versions[id] = v;
  }
  const own = new Set(ids);
  const deps = [];
  for (const [owner, list] of Object.entries(toml.dependencies)) {
    // Only honour dependency blocks belonging to a mod this jar actually
    // ships (or the wildcard form), so a stale block can't invent deps.
    if (owner !== '*' && !own.has(owner.toLowerCase())) continue;
    for (const dep of list) {
      if (!dep.modId) continue;
      const side = typeof dep.side === 'string' ? dep.side.toUpperCase() : 'BOTH';
      const type = typeof dep.type === 'string' ? dep.type.toLowerCase() : null;
      const base = { id: String(dep.modId).toLowerCase(), range: dep.versionRange ?? null, side };
      // NeoForge 1.20.2+ spells "these can't coexist" as type = "incompatible".
      if (type === 'incompatible') deps.push({ ...base, kind: 'breaks' });
      else if (isMandatoryForgeDep(dep)) deps.push({ ...base, kind: 'required' });
    }
  }
  return { flavor: 'forge', ids, versions, deps };
}

// Pull metadata out of an already-open zip, keeping each loader's file
// separate. A "universal" jar ships fabric.mod.json AND quilt.mod.json AND
// META-INF/mods.toml at once; only the running loader's file applies, so
// merging them invents dependencies (Moog's Structures appears to need
// quilt_resource_loader on a Fabric server, which it does not). `depth` guards
// jar-in-jar recursion.
function readFromZip(zip, depth) {
  const ids = new Set();
  const nestedVersions = {};
  const perLoader = { fabric: null, quilt: null, forge: null };

  const tryEntry = (name, fn) => {
    const e = zip.getEntry(name);
    if (!e) return null;
    try { return fn(e.getData().toString('utf8')); } catch (_) { return null; }
  };

  perLoader.fabric = tryEntry('fabric.mod.json', readFabricJson);
  perLoader.quilt = tryEntry('quilt.mod.json', readQuiltJson);
  // neoforge.mods.toml wins when both exist — it's the newer of the two and
  // the one a NeoForge server reads.
  perLoader.forge = tryEntry('META-INF/neoforge.mods.toml', (t) => readModsToml(t, zip))
    || tryEntry('META-INF/mods.toml', (t) => readModsToml(t, zip));

  for (const res of Object.values(perLoader)) {
    if (res) for (const i of res.ids) ids.add(i);
  }

  // Jar-in-jar: a bundled nested mod satisfies a dependency without a separate
  // file on disk, so its ids (and versions) count as provided. Depth 1 covers
  // real-world packs.
  if (depth < 1) {
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const n = entry.entryName;
      if (!/^META-INF\/(jarjar|jars)\/.+\.jar$/i.test(n)) continue;
      try {
        const nested = readFromZip(new AdmZip(entry.getData()), depth + 1);
        for (const i of nested.ids) ids.add(i);
        for (const res of Object.values(nested.perLoader)) {
          if (res) for (const [id, v] of Object.entries(res.versions)) nestedVersions[id] = nestedVersions[id] || v;
        }
        // Nested requirements are the nested mod's problem and are usually
        // satisfied by the parent; don't propagate them as top-level needs.
      } catch (_) { /* ignore */ }
    }
  }

  return { ids: [...ids], perLoader, nestedVersions };
}

// The metadata that actually applies on `loader`, falling back through related
// loaders when the jar doesn't ship that one's file. With no loader given we
// take the first available, which is how a lone jar outside a server reads.
const LOADER_PREFERENCE = {
  fabric: ['fabric', 'quilt'],
  quilt: ['quilt', 'fabric'],
  forge: ['forge'],
  neoforge: ['forge'],
};

function metaForLoader(perLoader, loader) {
  const order = LOADER_PREFERENCE[loader] || ['fabric', 'quilt', 'forge'];
  for (const key of order) if (perLoader[key]) return perLoader[key];
  return null;
}

/**
 * Read a jar's declared mod IDs and what it needs on `loader` ('fabric' |
 * 'quilt' | 'forge' | 'neoforge'; omit to take whatever metadata the jar ships
 * first). `side` is 'server' (default — a dedicated server skips mods.toml
 * deps marked side = "CLIENT") or 'client' (a launcher instance, where those
 * deps apply).
 *
 * Returns {
 *   ids: string[], requires: string[],            // the original contract
 *   flavor: 'fabric'|'quilt'|'forge'|null,        // dialect of the ranges below
 *   versions: { id: version },                    // incl. jar-in-jar mods
 *   ranges: { id: predicate },                    // version limits on requires
 *   breaks: { id: predicate },                    // mods it refuses to run beside
 * }
 * Empty for a jar we can't parse — never throws; an unreadable jar must not
 * break a server start.
 */
function readJarModInfo(jarPath, loader, { side = 'server' } = {}) {
  const empty = { ids: [], requires: [], flavor: null, versions: {}, ranges: {}, breaks: {} };
  let stat;
  try { stat = fs.statSync(jarPath); } catch (_) { return empty; }

  let raw;
  const hit = jarCache.get(jarPath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    raw = hit.raw;
  } else {
    raw = { ids: [], perLoader: {}, nestedVersions: {} };
    try { raw = readFromZip(new AdmZip(jarPath), 0); } catch (_) { /* not a readable zip */ }
    jarCache.set(jarPath, { mtimeMs: stat.mtimeMs, size: stat.size, raw });
  }

  const meta = metaForLoader(raw.perLoader, loader);
  const out = { ...empty, ids: raw.ids, versions: { ...raw.nestedVersions } };
  if (!meta) return out;
  out.flavor = meta.flavor;
  Object.assign(out.versions, meta.versions);
  const requires = new Set();
  for (const d of meta.deps) {
    // A dedicated server doesn't validate client-side mods.toml deps.
    if (side === 'server' && d.side === 'CLIENT') continue;
    if (side === 'client' && d.side === 'SERVER') continue;
    if (d.kind === 'required') {
      requires.add(d.id);
      if (d.range != null) out.ranges[d.id] = d.range;
    } else {
      out.breaks[d.id] = d.range;
    }
  }
  out.requires = [...requires];
  return out;
}

const isJar = (f) => /\.jar(\.disabled)?$/i.test(f);

/**
 * Scan a mods folder for the given loader ('fabric' | 'quilt' | 'forge' |
 * 'neoforge'). Passing the loader matters: a universal jar ships metadata for
 * several loaders and only the running one's dependencies are enforced.
 * Returns {
 *   byFile:   { <filename>: {ids, requires} },
 *   provided: Set<modId>,              // ids available from enabled jars
 *   required: Map<modId, string[]>,    // modId -> filenames that demand it
 * }
 * Disabled jars (.disabled) contribute neither: a disabled mod isn't loaded, so
 * it can't require anything and can't satisfy anything.
 */
function scanModsDir(modsDir, loader) {
  const byFile = {};
  const provided = new Set();
  const required = new Map();

  let files = [];
  try { files = fs.readdirSync(modsDir).filter(isJar); } catch (_) { return { byFile, provided, required }; }

  for (const f of files) {
    const info = readJarModInfo(path.join(modsDir, f), loader);
    byFile[f] = info;
    if (f.toLowerCase().endsWith('.disabled')) continue;
    for (const id of info.ids) provided.add(id);
    for (const r of info.requires) {
      if (BUILTIN_MOD_IDS.has(r)) continue;
      if (!required.has(r)) required.set(r, []);
      required.get(r).push(f);
    }
  }
  return { byFile, provided, required };
}

/**
 * Filenames in `modsDir` that some OTHER enabled mod hard-requires.
 * These must survive every client-only filter — removing one is what makes a
 * modpack server unbootable.
 */
function protectedModFiles(modsDir, loader) {
  const { byFile, required } = scanModsDir(modsDir, loader);
  const keep = new Set();
  for (const [file, info] of Object.entries(byFile)) {
    if (file.toLowerCase().endsWith('.disabled')) continue;
    for (const id of info.ids) {
      const demanders = required.get(id);
      if (!demanders) continue;
      // Ignore a jar that only "requires" its own id (self-reference in a
      // multi-mod jar) — something else must want it.
      if (demanders.some(d => d !== file)) { keep.add(file); break; }
    }
  }
  return keep;
}

/** Mod IDs that installed mods demand but nothing on disk provides. */
function missingModIds(modsDir, loader) {
  const { provided, required } = scanModsDir(modsDir, loader);
  const missing = [];
  for (const [id, demanders] of required) {
    if (provided.has(id) || BUILTIN_MOD_IDS.has(id)) continue;
    missing.push({ id, requiredBy: demanders });
  }
  return missing;
}

/**
 * Missing mandatory dependencies declared by the given jars only — e.g. the
 * jars an update just wrote. A dependency that was already missing before
 * isn't news from *this* change. Returns [{ id, requiredBy: filenames[] }].
 */
function missingDepsOf(modsDir, loader, filenames) {
  const touched = new Set(filenames);
  return missingModIds(modsDir, loader)
    .map(({ id, requiredBy }) => ({ id, requiredBy: requiredBy.filter(f => touched.has(f)) }))
    .filter(d => d.requiredBy.length > 0);
}

/**
 * Mod IDs that `oldName` provides, some *other* enabled mod requires, and that
 * neither the replacement jar at `newJarPath` nor any other enabled jar would
 * still provide. Replacing the old jar would break those mods — so a caller
 * must not remove it. `newJarPath` can be a temp file (anything not named
 * *.jar is invisible to scanModsDir). Returns [{ id, requiredBy: filenames[] }].
 */
function idsLostByReplacing(modsDir, loader, oldName, newJarPath) {
  const oldInfo = readJarModInfo(path.join(modsDir, oldName), loader);
  if (oldInfo.ids.length === 0) return [];
  const newIds = new Set(readJarModInfo(newJarPath, loader).ids);
  const { byFile, required } = scanModsDir(modsDir, loader);
  const elsewhere = new Set();
  for (const [f, info] of Object.entries(byFile)) {
    if (f === oldName || f.toLowerCase().endsWith('.disabled')) continue;
    for (const i of info.ids) elsewhere.add(i);
  }
  return oldInfo.ids
    .filter(i => !newIds.has(i) && !elsewhere.has(i))
    .map(i => ({ id: i, requiredBy: (required.get(i) || []).filter(f => f !== oldName) }))
    .filter(x => x.requiredBy.length > 0);
}

// ── Whole-set analysis ────────────────────────────────────────────────────────
// Presence alone isn't enough: Fabric refuses to start when a present mod is
// the wrong version (Iris needs Sodium 0.8.x) or when one mod declares it
// breaks another (Sodium 0.8.14 breaks Iris <= 1.10.7). This checks a set of
// jars the way the loader will, so an update can be vetted *before* it lands
// and a crash can be traced to the jar that caused it.

const isAnyRange = (r) => r == null || r === '*' || (Array.isArray(r) && r.length === 1 && r[0] === '*');

/**
 * Loader-level problems in a set of *enabled* jars. `entries` is
 * [{ file, path }] — `path` may point anywhere (a temp download standing in for
 * the jar it would replace). Returns [{
 *   type: 'missing' | 'version' | 'breaks',
 *   key,                       // stable across filename changes: type|byId|id
 *   by, byId, byVersion,       // the jar that declares the requirement / break
 *   id, range,                 // the mod it's about and the declared predicate
 *   haveFile, have,            // what's installed for `id` (not for 'missing')
 * }]
 */
function analyzeJars(entries, loader, { side = 'server' } = {}) {
  const jars = entries.map(e => ({ ...e, info: readJarModInfo(e.path, loader, { side }) }));
  const provided = new Map(); // id -> { file, version }
  for (const j of jars) {
    for (const id of j.info.ids) {
      if (!provided.has(id)) provided.set(id, { file: j.file, version: j.info.versions[id] ?? null });
    }
  }
  const problems = [];
  const push = (p) => problems.push({ ...p, key: `${p.type}|${p.byId}|${p.id}` });
  for (const j of jars) {
    const byId = j.info.ids[0] || j.file;
    const base = { by: j.file, byId, byVersion: j.info.versions[byId] ?? null };
    for (const id of j.info.requires) {
      if (BUILTIN_MOD_IDS.has(id)) continue;
      const p = provided.get(id);
      if (!p) { push({ ...base, type: 'missing', id, range: j.info.ranges[id] ?? null }); continue; }
      if (p.file === j.file) continue;
      const range = j.info.ranges[id];
      if (isAnyRange(range)) continue;
      if (satisfies(p.version, range, j.info.flavor) === false) {
        push({ ...base, type: 'version', id, range, haveFile: p.file, have: p.version });
      }
    }
    for (const [id, range] of Object.entries(j.info.breaks)) {
      if (BUILTIN_MOD_IDS.has(id)) continue;
      const p = provided.get(id);
      if (!p || p.file === j.file) continue;
      if (isAnyRange(range) || satisfies(p.version, range, j.info.flavor) === true) {
        push({ ...base, type: 'breaks', id, range, haveFile: p.file, have: p.version });
      }
    }
  }
  return problems;
}

// Enabled top-level jars of a mods folder as analyzeJars entries.
function listEnabledJars(modsDir) {
  let files = [];
  try { files = fs.readdirSync(modsDir).filter(f => /\.jar$/i.test(f) && !f.startsWith('.')); } catch (_) {}
  return files.map(file => ({ file, path: path.join(modsDir, file) }));
}

/**
 * analyzeJars over a mods folder, optionally with changes applied virtually:
 * `replace` maps an installed filename to { file, path } of the jar that would
 * take its place (or null to remove it); `add` lists extra { file, path } jars.
 */
function analyzeModsDir(modsDir, loader, { side = 'server', replace = {}, add = [] } = {}) {
  const entries = [];
  for (const e of listEnabledJars(modsDir)) {
    if (!(e.file in replace)) { entries.push(e); continue; }
    if (replace[e.file]) entries.push(replace[e.file]);
  }
  entries.push(...add);
  return analyzeJars(entries, loader, { side });
}

// Problems in `after` that weren't already in `before` — what a change caused.
function introducedProblems(before, after) {
  const seen = new Set(before.map(p => p.key));
  return after.filter(p => !seen.has(p.key));
}

// One line a person can act on.
function describeProblem(p) {
  const who = p.byVersion ? `${p.byId} ${p.byVersion}` : p.byId;
  const have = p.have ? `${p.id} ${p.have}` : p.id;
  if (p.type === 'missing') return `${who} needs ${p.id}, which isn't installed`;
  if (p.type === 'version') return `${who} needs ${p.id} ${describePredicate(p.range)}, but ${have} is installed`;
  return `${who} doesn't work with ${have}`;
}

module.exports = {
  analyzeJars,
  analyzeModsDir,
  listEnabledJars,
  introducedProblems,
  describeProblem,
  BUILTIN_MOD_IDS,
  readJarModInfo,
  scanModsDir,
  protectedModFiles,
  missingModIds,
  missingDepsOf,
  idsLostByReplacing,
  parseModsToml,
};
