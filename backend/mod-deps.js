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
// Used by backend/index.js only. Zero new npm deps — adm-zip is already a root
// dependency (see CLAUDE.md: backend deps must live in the ROOT package.json).

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

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

function readFabricJson(text) {
  const json = JSON.parse(text);
  const ids = [];
  if (json.id) ids.push(String(json.id).toLowerCase());
  for (const p of json.provides || []) ids.push(String(p).toLowerCase());
  const requires = Object.keys(json.depends || {}).map(k => k.toLowerCase());
  return { ids, requires };
}

function readQuiltJson(text) {
  const json = JSON.parse(text);
  const ql = json.quilt_loader || {};
  const ids = [];
  if (ql.id) ids.push(String(ql.id).toLowerCase());
  for (const p of ql.provides || []) {
    ids.push(String(typeof p === 'string' ? p : p.id || '').toLowerCase());
  }
  const requires = [];
  for (const d of ql.depends || []) {
    if (typeof d === 'string') { requires.push(d.toLowerCase()); continue; }
    if (d && d.id && !d.optional) requires.push(String(d.id).toLowerCase());
  }
  return { ids: ids.filter(Boolean), requires };
}

// Pull ids/requires out of an already-open zip, keeping each loader's metadata
// separate. A "universal" jar ships fabric.mod.json AND quilt.mod.json AND
// META-INF/mods.toml at once; only the running loader's file applies, so
// merging them invents dependencies (Moog's Structures appears to need
// quilt_resource_loader on a Fabric server, which it does not). `depth` guards
// jar-in-jar recursion.
function readFromZip(zip, depth) {
  const ids = new Set();
  const perLoader = { fabric: null, quilt: null, forge: null };

  const tryEntry = (name, fn) => {
    const e = zip.getEntry(name);
    if (!e) return null;
    try { return fn(e.getData().toString('utf8')); } catch (_) { return null; }
  };

  const fabric = tryEntry('fabric.mod.json', readFabricJson);
  if (fabric) perLoader.fabric = fabric;
  const quilt = tryEntry('quilt.mod.json', readQuiltJson);
  if (quilt) perLoader.quilt = quilt;

  for (const tomlName of ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']) {
    const entry = zip.getEntry(tomlName);
    if (!entry) continue;
    const res = { ids: [], requires: [] };
    try {
      const toml = parseModsToml(entry.getData().toString('utf8'));
      const own = new Set();
      for (const mod of toml.mods) if (mod.modId) own.add(String(mod.modId).toLowerCase());
      res.ids = [...own];
      for (const [owner, deps] of Object.entries(toml.dependencies)) {
        // Only honour dependency blocks belonging to a mod this jar actually
        // ships (or the wildcard form), so a stale block can't invent deps.
        if (owner !== '*' && !own.has(owner.toLowerCase())) continue;
        for (const dep of deps) {
          if (!dep.modId) continue;
          // side = "CLIENT" deps are not validated on a dedicated server.
          if (typeof dep.side === 'string' && dep.side.toUpperCase() === 'CLIENT') continue;
          if (!isMandatoryForgeDep(dep)) continue;
          res.requires.push(String(dep.modId).toLowerCase());
        }
      }
    } catch (_) { continue; }
    // neoforge.mods.toml wins when both exist — it's the newer of the two and
    // the one a NeoForge server reads.
    if (!perLoader.forge) perLoader.forge = res;
  }

  for (const res of Object.values(perLoader)) {
    if (res) for (const i of res.ids) ids.add(i);
  }

  // Jar-in-jar: a bundled nested mod satisfies a dependency without a separate
  // file on disk, so its ids count as provided. Depth 1 covers real-world packs.
  if (depth < 1) {
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const n = entry.entryName;
      if (!/^META-INF\/(jarjar|jars)\/.+\.jar$/i.test(n)) continue;
      try {
        const nested = readFromZip(new AdmZip(entry.getData()), depth + 1);
        for (const i of nested.ids) ids.add(i);
        // Nested requirements are the nested mod's problem and are usually
        // satisfied by the parent; don't propagate them as top-level needs.
      } catch (_) { /* ignore */ }
    }
  }

  return { ids: [...ids], perLoader };
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

function requiresForLoader(perLoader, loader) {
  const order = LOADER_PREFERENCE[loader] || ['fabric', 'quilt', 'forge'];
  for (const key of order) {
    if (perLoader[key]) return perLoader[key].requires || [];
  }
  return [];
}

/**
 * Read a jar's declared mod IDs and the dependencies that are mandatory on
 * `loader` ('fabric' | 'quilt' | 'forge' | 'neoforge'; omit to take whatever
 * metadata the jar ships first).
 * Returns { ids: string[], requires: string[] } — empty arrays for a jar we
 * can't parse (never throws; an unreadable jar must not break a server start).
 */
function readJarModInfo(jarPath, loader) {
  let stat;
  try { stat = fs.statSync(jarPath); } catch (_) { return { ids: [], requires: [] }; }

  let raw;
  const hit = jarCache.get(jarPath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    raw = hit.raw;
  } else {
    raw = { ids: [], perLoader: {} };
    try { raw = readFromZip(new AdmZip(jarPath), 0); } catch (_) { /* not a readable zip */ }
    jarCache.set(jarPath, { mtimeMs: stat.mtimeMs, size: stat.size, raw });
  }

  return { ids: raw.ids, requires: requiresForLoader(raw.perLoader, loader) };
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

module.exports = {
  BUILTIN_MOD_IDS,
  readJarModInfo,
  scanModsDir,
  protectedModFiles,
  missingModIds,
  parseModsToml,
};
