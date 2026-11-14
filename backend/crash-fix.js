'use strict';

// ─── Crash auto-fix: everything after "the game/server crashed" ───────────────
//
// mod-compat.repairMods handles one family of crashes: the loader refusing to
// start because a mod is missing, the wrong version for another, or declared
// incompatible. Everything else (a mixin that can't find its target, a mod
// throwing during setup, a jar built for another loader, two copies of a mod,
// a corrupt jar or config, the wrong Java, running out of memory) used to end
// in a crash banner at best. This module reads the crash, decides what's
// wrong, and fixes what it safely can.
//
// "Safely" is the rule everything here obeys. A fix may:
//   - swap a mod for another version of itself (content stays, so worlds keep
//     their blocks) — newest first, betas included when no release works;
//     a version that already crashed is never put back (tried set);
//   - make lossless changes: drop a duplicate copy, disable a jar the loader
//     never loaded anyway (wrong loader), re-download a corrupt jar, move a
//     broken config aside (backed up), switch Java, raise the heap;
//   - disable a mod outright only when it's client-only (Modrinth says it has
//     no server side, so it adds nothing to a world) and no other installed
//     mod requires it (the dependency invariant in CLAUDE.md).
// Anything else — turning off a content mod would delete its blocks from the
// player's worlds — is reported in plain English instead of "fixed".
//
// Shared by the launcher (side 'client') and servers (side 'server').

const path = require('path');
const fs = require('fs-extra');
const yauzl = require('yauzl');
const modDeps = require('./mod-deps');
const modCompat = require('./mod-compat');
const resolve = require('./modrinth-resolve');
const { stripMcCodes } = require('./dep-crash');

// Mod IDs that are the game or the loader itself — never a culprit to swap.
const PLATFORM_IDS = new Set([
  'minecraft', 'java', 'forge', 'neoforge', 'fml', 'fabricloader', 'fabric-loader',
  'quilt_loader', 'mixinextras', 'mixinextras.neoforge', 'mixinextras.forge',
  'net.neoforged.fml.generated', 'javafml', 'lowcodefml', 'mcp',
]);

// Class prefixes that belong to the JVM, the game, the loader or common
// libraries. A stack frame in one of these says nothing about which mod broke.
const PLATFORM_CLASS_RE = /^(java|javax|jdk|sun|com\.sun|net\.minecraft|com\.mojang|net\.neoforged|net\.minecraftforge|cpw\.mods|net\.fabricmc|org\.quiltmc|org\.spongepowered|com\.llamalad7|org\.lwjgl|io\.netty|com\.google|org\.apache|org\.slf4j|org\.objectweb|it\.unimi|org\.joml|com\.electronwill|oshi|com\.ibm|org\.jline|net\.minecrell|org\.jspecify|com\.github\.oshi|org\.openjdk|kotlin|scala|moe\.yushi\.authlibinjector)\./;

const JAVA_CLASS_BASE = 44; // class file version 69 → Java 25

const isJar = (f) => /\.jar$/i.test(f) && !f.startsWith('.');

// ── Reading the crash ────────────────────────────────────────────────────────

// The part of the log that describes the crash: the crash report if there is
// one (up to its system-details walkthrough), else the tail of the log.
function crashSection(logText) {
  const text = stripMcCodes(String(logText || ''));
  const start = text.lastIndexOf('---- Minecraft Crash Report ----');
  if (start >= 0) {
    // FATAL lines just before the report name the real failure (mixin errors
    // are logged above the report, which then only says "critical error").
    const from = Math.max(0, start - 20000);
    const end = text.indexOf('A detailed walkthrough of the error', start);
    return text.slice(from, end > start ? end : start + 30000);
  }
  return text.slice(-30000);
}

// Stack frames in order: { module, cls } — `module` is the JPMS module the
// frame ran in (Forge/NeoForge print `TRANSFORMER/sodium@0.9.2/…`, which is
// the mod ID), `cls` the class name.
function stackFrames(section) {
  const out = [];
  const re = /^\s*at\s+(?:[A-Za-z]+\/)?(?:([a-z][a-z0-9_.-]*)@[^/\s]*\/)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\.[\w$<>]+\(/gm;
  let m;
  while ((m = re.exec(section)) !== null) out.push({ module: m[1] || null, cls: m[2] });
  return out;
}

// Mod IDs the crash names outright, strongest evidence first.
function namedCulprits(section) {
  const ids = [];
  const add = (id) => {
    const v = String(id || '').toLowerCase().replace(/^['"(]|['")]$/g, '');
    if (v && !PLATFORM_IDS.has(v) && !ids.includes(v)) ids.push(v);
  };
  const scan = (re) => { let m; while ((m = re.exec(section)) !== null) add(m[1]); };
  // Mixin: "Mixin apply for mod sodium failed …" / "Mixin [x.mixins.json:Y from mod sodium] … FAILED"
  scan(/Mixin apply (?:for mod|failed for mod) ([a-z0-9_.-]+) failed/gi);
  scan(/Mixin \[[^\]]*? from mod ([a-z0-9_.-]+)\][^\n]*FAILED/gi);
  // Fabric: "Could not execute entrypoint stage 'main' due to errors, provided by 'modid'"
  scan(/due to errors, provided by '([a-z0-9_.-]+)'/gi);
  // NeoForge/Forge: "Mod 'Name' (modid) encountered an error during the X event phase"
  scan(/\(([a-z0-9_.-]+)\) encountered an error during/gi);
  scan(/\(([a-z0-9_.-]+)\) has failed to load correctly/gi);
  scan(/-- Mod loading issue for: ([a-z0-9_.-]+) --/gi);
  // Forge crash reports: "Suspected Mod(s):\n\tName (modid), Version: …"
  let m;
  const sus = /Suspected Mods?:\s*\n((?:[ \t]+[^\n]*\n){1,8})/gi;
  while ((m = sus.exec(section)) !== null) {
    const r = /\(([a-z0-9_.-]+)\)/gi; let n;
    while ((n = r.exec(m[1])) !== null) add(n[1]);
  }
  return ids;
}

// Mod IDs whose code is in the failing stack: a mixin handler injected into a
// game class carries its mod ID ("handler$zdf000$sodium$…"), and Forge-style
// frames run in a module named after the mod.
function stackCulprits(section) {
  const ids = [];
  const add = (id) => { const v = String(id).toLowerCase(); if (!PLATFORM_IDS.has(v) && !ids.includes(v)) ids.push(v); };
  let m;
  const handler = /(?:handler|redirect|modify|wrap\w*|localvar)\$[a-z0-9]+\$([a-z][a-z0-9_]*)\$/gi;
  while ((m = handler.exec(section)) !== null) add(m[1]);
  for (const f of stackFrames(section)) if (f.module) add(f.module);
  return ids;
}

// Classes in the failing stack that aren't the game's or the loader's.
function stackModClasses(section) {
  const out = [];
  for (const f of stackFrames(section)) {
    if (f.module && PLATFORM_IDS.has(f.module)) continue;
    if (PLATFORM_CLASS_RE.test(f.cls)) continue;
    const top = f.cls.replace(/\$.*$/, '');
    if (!out.includes(top)) out.push(top);
    if (out.length >= 15) break;
  }
  return out;
}

/**
 * What went wrong. Returns findings, most specific first:
 *   { kind: 'java', needMajor }            a class needs a newer Java
 *   { kind: 'oom' }                        out of heap
 *   { kind: 'corrupt-jar' }                some jar can't be read (located later)
 *   { kind: 'duplicate' }                  two copies of a mod
 *   { kind: 'wrong-loader' }               a jar built for another loader
 *   { kind: 'config', files }              a config file failed to parse
 *   { kind: 'client-on-server' }           a client-only mod on a server
 *   { kind: 'mod', ids, classes }          a mod's code crashed (or its mixin)
 *   { kind: 'report', type, message }      known, not fixable here
 */
function diagnose(logText, { side = 'client' } = {}) {
  const all = stripMcCodes(String(logText || '').slice(-400000));
  const section = crashSection(all);
  const findings = [];

  const cv = /class file version (\d+)(?:\.\d+)?\)?,?\s*this version of the Java Runtime only recognizes class file versions up to (\d+)/i.exec(all);
  if (cv) findings.push({ kind: 'java', needMajor: parseInt(cv[1], 10) - JAVA_CLASS_BASE, haveMajor: parseInt(cv[2], 10) - JAVA_CLASS_BASE });

  if (/OutOfMemoryError: (?:Java heap space|GC overhead limit exceeded)/i.test(section)) findings.push({ kind: 'oom' });

  // `java.util.zip.ZipException`, not the `ensureOpenOrZipException(` stack
  // frame, and not "ZipFile closed" (NeoForge closing jars after a failed start).
  if (/zip END header not found|java\.util\.zip\.ZipException(?!: ZipFile closed)|Invalid or corrupt jarfile|error in opening zip file|zip file is empty|Invalid CEN header|is not a valid (?:mod )?(?:file|jar)/i.test(section)) {
    findings.push({ kind: 'corrupt-jar' });
  }

  if (/duplicate mods?|is provided by multiple|Found \d+ duplicate|DuplicateModsFoundException|ModFile .* conflicts with/i.test(section)) {
    findings.push({ kind: 'duplicate' });
  }

  if (/is (?:a|an) (?:Fabric|Quilt|Forge|NeoForge|LiteLoader|Bukkit) (?:mod|plugin)[^\n]*(?:cannot|can't|will not|won't) be loaded|Found (?:Fabric|Forge|NeoForge|Quilt) mod[^\n]*(?:not compatible|incompatible)|incompatible mod loader|built for (?:Fabric|Forge|NeoForge|Quilt)/i.test(section)) {
    findings.push({ kind: 'wrong-loader' });
  }

  const configFiles = [];
  {
    const re = /(?:Failed (?:loading|to load|to parse|to read) config(?:uration)?(?: file)?|ParsingException|Error loading config|Config file [^\n]*? is corrupt|Failed to load config)[^\n]*?((?:[A-Za-z]:)?[^\s'"()\[\]]*?(?:config|defaultconfigs|serverconfig)[\\/][^\s'"()\[\]]+\.(?:toml|json5?|cfg|properties|ya?ml|txt))/gi;
    let m;
    while ((m = re.exec(section)) !== null) if (!configFiles.includes(m[1])) configFiles.push(m[1]);
  }
  if (configFiles.length) findings.push({ kind: 'config', files: configFiles });

  if (side === 'server' && /for invalid dist DEDICATED_SERVER|in environment type SERVER|RuntimeDistCleaner|Attempted to load class net\/minecraft\/client/i.test(section)) {
    findings.push({ kind: 'client-on-server', ids: [...namedCulprits(section), ...stackCulprits(section)], classes: stackModClasses(section) });
  }

  const named = namedCulprits(section);
  const inStack = stackCulprits(section);
  const classes = stackModClasses(section);
  const isMixin = /Mixin apply|MixinTransformerError|InvalidInjectionException|Critical injection failure|MixinApplyError|InjectionError/i.test(section);
  // Code compiled against a different game/loader build than the one running.
  const isLinkage = /NoSuchMethodError|NoSuchFieldError|AbstractMethodError|IncompatibleClassChangeError|NoClassDefFoundError|ClassNotFoundException/.test(section);
  const crashed = /---- Minecraft Crash Report ----|Exception in thread|Encountered an unexpected exception|Failed to start the minecraft server|Exception caught during firing event|has failed to load correctly|encountered an error during|Could not execute entrypoint|ModLoadingException|Mixin apply|MixinTransformerError/i.test(section);
  if (crashed && (named.length || inStack.length || classes.length)) {
    findings.push({ kind: 'mod', ids: [...new Set([...named, ...inStack])], named, classes, mixin: isMixin, linkage: isLinkage });
  }

  // Known causes nothing here can fix — said plainly instead of a stack trace.
  if (/Address already in use|FAILED TO BIND TO PORT/i.test(section)) {
    findings.push({ kind: 'report', type: 'port', message: "The server's port is already in use — another server (or another copy of this one) is probably still running. Stop it, or change the port in Options." });
  }
  if (/Pixel format not accelerated|WGL: The driver does not appear to support OpenGL|GLFW error 6554[23]|Failed to create (?:the )?OpenGL context|Couldn't create OpenGL context|EXCEPTION_ACCESS_VIOLATION[\s\S]{0,4000}?(?:nvoglv|atio6axx|atioglxx|ig\d+icd|ig9icd|amdxx)/i.test(all)) {
    findings.push({ kind: 'report', type: 'graphics', message: 'Your graphics driver crashed or refused to start the game. Update your graphics driver (NVIDIA / AMD / Intel) and try again.' });
  }
  if (/Failed to (?:load|read) level\.dat|Exception reading .*level\.dat|Couldn't load chunk|Failed to read chunk|Corrupted chunk|RegionFile.*(?:corrupt|invalid)/i.test(section)) {
    findings.push({ kind: 'report', type: 'world', message: 'The world file looks damaged. Restore it from a backup (Backups tab for servers) before playing it again.' });
  }
  if (/You need to agree to the EULA/i.test(section)) {
    findings.push({ kind: 'report', type: 'eula', message: 'The server needs the Minecraft EULA accepted before it will start.' });
  }
  return findings;
}

// True when the log looks like the game/server actually crashed (as opposed
// to a normal quit) — the caller's cue to run fixCrash at all.
function looksLikeCrash(logText) {
  const t = String(logText || '').slice(-200000);
  return /---- Minecraft Crash Report ----|#@!@# Game crashed!|Exception in thread "(?:main|Render thread|Server thread)"|Encountered an unexpected exception|Failed to start (?:the minecraft server|FML)|MixinTransformerError|UnsupportedClassVersionError|OutOfMemoryError|ModLoadingException|Could not execute entrypoint/i.test(t);
}

// ── Mapping culprits to jars ─────────────────────────────────────────────────

// The enabled top-level jar that provides mod `id`: a jar declaring it as its
// own mod wins; otherwise a jar bundling it (jar-in-jar), but only if exactly
// one does — a library nested in five mods points at none of them.
function jarForModId(modsDir, loader, side, id) {
  const own = [];
  const nested = [];
  let files = [];
  try { files = fs.readdirSync(modsDir).filter(isJar); } catch (_) { return null; }
  for (const f of files) {
    const info = modDeps.readJarModInfo(path.join(modsDir, f), loader, { side });
    if (info.ownIds.includes(id)) own.push(f);
    else if (info.ids.includes(id)) nested.push(f);
  }
  if (own.length) return own[0];
  return nested.length === 1 ? nested[0] : null;
}

function listZipEntries(file, wanted) {
  return new Promise((resolveP) => {
    const hits = new Set();
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zf) => {
      if (err) return resolveP({ ok: false, hits });
      zf.on('entry', (e) => {
        if (wanted && wanted.has(e.fileName)) hits.add(e.fileName);
        zf.readEntry();
      });
      zf.on('end', () => resolveP({ ok: true, hits }));
      zf.on('error', () => resolveP({ ok: false, hits }));
      zf.readEntry();
    });
  });
}

// Which jar ships these classes (first class that's found wins).
async function jarForClasses(modsDir, classes) {
  if (!classes.length) return null;
  const wanted = new Map(classes.map((c, i) => [c.replace(/\./g, '/') + '.class', i]));
  const names = new Set(wanted.keys());
  let best = null;
  let files = [];
  try { files = (await fs.readdir(modsDir)).filter(isJar); } catch (_) { return null; }
  for (const f of files) {
    const { hits } = await listZipEntries(path.join(modsDir, f), names);
    for (const h of hits) {
      const rank = wanted.get(h);
      if (!best || rank < best.rank) best = { file: f, rank };
    }
    if (best && best.rank === 0) break;
  }
  return best ? best.file : null;
}

// Jars that aren't readable zips.
async function corruptJars(modsDir) {
  const bad = [];
  let files = [];
  try { files = (await fs.readdir(modsDir)).filter(isJar); } catch (_) { return bad; }
  for (const f of files) {
    const p = path.join(modsDir, f);
    let size = 0;
    try { size = (await fs.stat(p)).size; } catch (_) { continue; }
    if (size === 0) { bad.push(f); continue; }
    const { ok } = await listZipEntries(p, null);
    if (!ok) bad.push(f);
  }
  return bad;
}

// Groups of enabled top-level jars that are the same mod (same primary ID).
function duplicateGroups(modsDir, loader, side) {
  const byId = new Map();
  let files = [];
  try { files = fs.readdirSync(modsDir).filter(isJar); } catch (_) { return []; }
  for (const f of files) {
    const info = modDeps.readJarModInfo(path.join(modsDir, f), loader, { side });
    const id = info.ownIds[0];
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ file: f, version: info.versions[id] || null, flavor: info.flavor });
  }
  return [...byId.entries()].filter(([, list]) => list.length > 1).map(([id, list]) => ({ id, list }));
}

// Jars with mod metadata for some other loader but none for this one.
function wrongLoaderJars(modsDir, loader, side) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(modsDir).filter(isJar); } catch (_) { return out; }
  for (const f of files) {
    const info = modDeps.readJarModInfo(path.join(modsDir, f), loader, { side });
    if (!info.flavor && info.ownIds.length > 0) out.push(f);
  }
  return out;
}

// Files some OTHER enabled mod hard-requires (for `side`).
function requiredByOthers(modsDir, loader, side) {
  let files = [];
  try { files = fs.readdirSync(modsDir).filter(isJar); } catch (_) { return new Set(); }
  const infos = files.map(f => ({ f, info: modDeps.readJarModInfo(path.join(modsDir, f), loader, { side }) }));
  const keep = new Set();
  for (const { f, info } of infos) {
    for (const other of infos) {
      if (other.f === f) continue;
      if (other.info.requires.some(r => info.ids.includes(r))) { keep.add(f); break; }
    }
  }
  return keep;
}

// ── Fixing ──────────────────────────────────────────────────────────────────

const dateOf = (v) => Date.parse(v?.date_published) || 0;
const CHANNEL_RANK = { release: 0, beta: 1, alpha: 2 };

// Order to try other versions of a crashing mod: newer than the installed one
// first (releases, then betas/alphas — the fix for a mod-vs-loader skew is
// usually only in a pre-release), then older releases.
function candidateOrder(versions, installed) {
  const t = installed ? dateOf(installed) : 0;
  const byChannelThenNew = (a, b) =>
    ((CHANNEL_RANK[a.version_type] ?? 3) - (CHANNEL_RANK[b.version_type] ?? 3)) || (dateOf(b) - dateOf(a));
  const newer = versions.filter(v => !installed || dateOf(v) > t).sort(byChannelThenNew);
  const older = installed ? versions.filter(v => dateOf(v) <= t && v.version_type === 'release').sort((a, b) => dateOf(b) - dateOf(a)) : [];
  return [...newer, ...older];
}

async function fetchProject(projectId, { api, headers }) {
  try {
    const r = await fetch(`${api}/project/${encodeURIComponent(projectId)}`, { headers });
    return r.ok ? await r.json() : null;
  } catch (_) { return null; }
}

/**
 * Fix what diagnose() found. Returns { actions: [{ text }], report: [string] }
 * — `actions` non-empty means something changed and the caller should
 * relaunch / restart; `report` are plain-English lines for what couldn't be
 * fixed automatically.
 *
 * ctx: { modsDir, root, backupDir, cacheDir, loader, side, gameVersion, api,
 *        headers, tried: Set, log(msg), hooks }
 * hooks: projectFor(file) -> { projectId, version } | null
 *        onReplaced({ from, to, version })   (also used for disable/rename)
 *        javaMajor() -> number | null        Java the crashed run used
 *        useJava(major) -> Promise<bool>     switch to Java `major`
 *        raiseRam() -> Promise<string|null>  bump the heap; returns e.g. "6 GB"
 *        stashClientMod(file) -> Promise<bool>   (servers) move to the client stash
 *        onDisabled(file, to)                after a jar is renamed to .disabled
 *        versionOfJar(path) -> Modrinth version | null   (by SHA1)
 *        pinLoader(cutoffMs) -> Promise<string|null>  hold the loader at the
 *                                            newest build published before
 *                                            cutoffMs (older than the current
 *                                            one); returns the build or null
 *        unpinLoader() -> Promise            release that hold again
 */
async function fixCrash(findings, ctx) {
  const { modsDir, root, backupDir, cacheDir, loader, side, gameVersion, api, headers, tried, hooks = {} } = ctx;
  const log = ctx.log || (() => {});
  const actions = [];
  const report = [];
  const once = (key) => { if (tried.has(key)) return false; tried.add(key); return true; };
  const hasModLoader = !!loader && loader !== 'vanilla' && loader !== 'paper';
  const L = { neoforge: 'NeoForge', forge: 'Forge', fabric: 'Fabric', quilt: 'Quilt' }[loader] || loader;
  await fs.ensureDir(cacheDir).catch(() => {});

  const disableJar = async (file, why) => {
    const to = `${file}.disabled`;
    await fs.move(path.join(modsDir, file), path.join(modsDir, to), { overwrite: true });
    // Metadata is keyed by the base name in both the launcher and servers, so a
    // `.disabled` jar keeps its entry — nothing to rename.
    await hooks.onDisabled?.(file, to);
    actions.push({ text: `turned off ${file} (${why})` });
    log(`[auto-fix] Turned off ${file} — ${why}. Turn it back on in the Mods list if you want it.\n`);
  };

  for (const f of findings) {
    // ── Java too old for a class ──
    if (f.kind === 'java') {
      const major = f.needMajor;
      if (major > 0 && hooks.useJava && once(`crash|java|${major}`)) {
        log(`[auto-fix] Something here needs Java ${major} — switching to it…\n`);
        if (await hooks.useJava(major)) actions.push({ text: `switched to Java ${major}` });
        else report.push(`A mod needs Java ${major}, and MineDash couldn't set it up. Install Java ${major} and pick it in the Java settings.`);
      }
      continue;
    }

    // ── Out of memory ──
    if (f.kind === 'oom') {
      const n = [...tried].filter(k => k.startsWith('crash|oom|')).length;
      if (hooks.raiseRam && n < 2 && once(`crash|oom|${n}`)) {
        const to = await hooks.raiseRam();
        if (to) { actions.push({ text: `gave it more memory (${to})` }); log(`[auto-fix] Ran out of memory — raised the memory limit to ${to}.\n`); }
        else report.push("It ran out of memory, and there's no more RAM to give it. Close other programs or remove some mods.");
      } else if (n >= 2) {
        report.push('It keeps running out of memory even after raising the limit. A mod may be leaking memory — try removing recently added mods.');
      }
      continue;
    }

    if (!hasModLoader && f.kind !== 'report') continue;

    // ── Corrupt jars: re-download the same version, never guess ──
    if (f.kind === 'corrupt-jar') {
      for (const file of await corruptJars(modsDir)) {
        if (!once(`crash|corrupt|${file}`)) continue;
        const proj = await hooks.projectFor?.(file);
        let fixed = false;
        if (proj?.projectId) {
          const versions = await resolve.projectVersions(proj.projectId, loader, gameVersion, { api, headers });
          const same = versions.find(v => (v.files || []).some(x => x.filename === file)) || null;
          const pf = same && (same.files.find(x => x.filename === file) || resolve.primaryFile(same));
          if (pf?.url) {
            try {
              const tmp = path.join(cacheDir, `redownload-${Date.now()}-${file}`);
              await resolve.downloadVersionFile(pf, tmp, { headers });
              await fs.move(tmp, path.join(modsDir, file), { overwrite: true });
              actions.push({ text: `re-downloaded ${file} (the file was damaged)` });
              log(`[auto-fix] ${file} was damaged — downloaded it again.\n`);
              fixed = true;
            } catch (err) { log(`[auto-fix] Couldn't re-download ${file}: ${err.message}\n`); }
          }
        }
        if (!fixed) report.push(`${file} is damaged (not a valid jar). Delete it and install it again.`);
      }
      continue;
    }

    // ── Two copies of one mod: keep the newest ──
    if (f.kind === 'duplicate') {
      for (const { id, list } of duplicateGroups(modsDir, loader, side)) {
        if (!once(`crash|dup|${id}`)) continue;
        const flavor = list[0].flavor;
        const sorted = [...list].sort((a, b) => {
          const c = (a.version && b.version) ? require('./mod-versions').compareVersions(b.version, a.version, flavor) : null;
          if (c) return c;
          try { return fs.statSync(path.join(modsDir, b.file)).mtimeMs - fs.statSync(path.join(modsDir, a.file)).mtimeMs; } catch (_) { return 0; }
        });
        for (const extra of sorted.slice(1)) {
          await fs.ensureDir(backupDir);
          await fs.move(path.join(modsDir, extra.file), path.join(backupDir, `${Date.now()}-${extra.file}`), { overwrite: true });
          actions.push({ text: `removed the extra copy ${extra.file} (kept ${sorted[0].file})` });
          log(`[auto-fix] Two copies of ${id} — kept ${sorted[0].file}, moved ${extra.file} to the backup folder.\n`);
        }
      }
      continue;
    }

    // ── Jars for another loader: they never loaded here, so turning them off loses nothing ──
    if (f.kind === 'wrong-loader') {
      for (const file of wrongLoaderJars(modsDir, loader, side)) {
        if (!once(`crash|wl|${file}`)) continue;
        await disableJar(file, `it's made for a different mod loader, not ${L}`);
      }
      continue;
    }

    // ── Broken config: move it aside so the mod writes a fresh default ──
    if (f.kind === 'config') {
      for (const raw of f.files) {
        const abs = path.isAbsolute(raw) ? raw : path.join(root, raw);
        const rel = path.relative(root, abs);
        if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // never touch files outside the instance
        if (!once(`crash|cfg|${rel}`)) continue;
        if (!await fs.pathExists(abs)) continue;
        const dest = path.join(root, '.minedash-config-backup', `${Date.now()}-${rel.replace(/[\\/]/g, '__')}`);
        await fs.ensureDir(path.dirname(dest));
        await fs.move(abs, dest, { overwrite: true });
        actions.push({ text: `reset the broken config ${rel}` });
        log(`[auto-fix] ${rel} couldn't be read — moved it aside (kept in .minedash-config-backup) so the mod writes a fresh one.\n`);
      }
      continue;
    }

    // ── A mod crashed (or a client-only mod on a server) ──
    if (f.kind === 'mod' || f.kind === 'client-on-server') {
      // Strongest culprit only — one change per crash.
      let file = null;
      let modId = null;
      for (const id of f.ids) {
        file = jarForModId(modsDir, loader, side, id);
        if (file) { modId = id; break; }
      }
      if (!file) {
        file = await jarForClasses(modsDir, f.classes || []);
        if (file) modId = modDeps.readJarModInfo(path.join(modsDir, file), loader, { side }).ownIds[0] || file;
      }
      if (!file) {
        if (f.named?.length) report.push(`The crash names ${f.named.join(', ')}, but MineDash couldn't find which file that is.`);
        continue;
      }
      // Reads after a mod's name: "Sodium doesn't work with this … build".
      const why = f.kind === 'client-on-server' ? "is client-only and can't run on a server"
        : (f.mixin || f.linkage) ? `doesn't work with this Minecraft/${L} build` : 'crashed the game';
      // Counted per mod, not per file — every swap changes the filename.
      const attempts = [...tried].filter(k => k.startsWith(`crash|mod|${modId}|`)).length;
      const proj = await hooks.projectFor?.(file);
      // The version that's installed now just crashed: never put it back.
      if (proj?.version?.id) tried.add(`badver|${proj.version.id}`);

      if (f.kind === 'client-on-server' && hooks.stashClientMod) {
        // Only when Modrinth agrees it's client-only — a content mod with a
        // client-class bug would take its blocks out of the world with it.
        const project = proj?.projectId ? await fetchProject(proj.projectId, { api, headers }) : null;
        const protectedSet = requiredByOthers(modsDir, loader, side);
        if (project?.server_side === 'unsupported' && !protectedSet.has(file) && once(`crash|stash|${file}`)) {
          if (await hooks.stashClientMod(file)) {
            actions.push({ text: `moved ${file} out of the server (client-only mod)` });
            log(`[auto-fix] ${file} is client-only — moved it to .minedash-client-mods so the server can start.\n`);
            continue;
          }
        }
      }

      // 1. Roll back an update MineDash made — unless the jar it would bring
      // back is a version that already crashed here.
      if (once(`crash|rb|${file}`)) {
        const b = await modCompat.backupFor(backupDir, file);
        const backupVer = b && hooks.versionOfJar ? await hooks.versionOfJar(b.path) : null;
        if (b && !(backupVer?.id && tried.has(`badver|${backupVer.id}`))) {
          const r = await modCompat.rollback({ modsDir, backupDir, current: file });
          if (r) {
            await hooks.onReplaced?.({ from: r.removed, to: r.restored, version: null, rolledBack: true });
            actions.push({ text: `rolled ${r.removed} back to ${r.restored} (the update ${why})` });
            log(`[auto-fix] ${r.removed} ${why} — rolled it back to ${r.restored}.\n`);
            continue;
          }
        }
      }

      // 2. Another version of the same mod.
      if (proj?.projectId && attempts < 4) {
        tried.add(`crash|mod|${modId}|${attempts}`);
        const versions = (await resolve.projectVersions(proj.projectId, loader, gameVersion, { api, headers }))
          .filter(v => v.id !== proj.version?.id && !tried.has(`badver|${v.id}`));
        const ordered = candidateOrder(versions, proj.version);
        if (ordered.length) {
          log(`[auto-fix] ${file} ${why} — looking for a version that works…\n`);
          const found = await modCompat.firstCompatibleVersion({
            modsDir, loader, side, file, versions: ordered, cacheDir, headers, maxDownloads: 4,
          });
          if (found.version) {
            const newName = path.basename(found.file.filename);
            const staging = path.join(modsDir, `.${newName}.minedash-tmp`);
            await fs.copy(found.jarPath, staging, { overwrite: true });
            await modCompat.replaceWithBackup({ modsDir, backupDir, oldName: file, newName, newJarPath: staging, reason: 'crash-fix' });
            await hooks.onReplaced?.({ from: file, to: newName, version: found.version });
            const channel = found.version.version_type && found.version.version_type !== 'release' ? ` (${found.version.version_type})` : '';
            actions.push({ text: `${file} → ${newName}${channel} (the old version ${why})` });
            log(`[auto-fix] Replaced ${file} with ${newName}${channel}.\n`);
            continue;
          }
        }
      }

      // 3. The mod is fine but the loader moved on: a mixin that can't find its
      // target, or a method that no longer exists, after a loader update. A
      // mod version was built against a loader that existed when it came out,
      // so hold the loader at the newest build from before that date. Once per
      // mod — and if the same mod still crashes on the older build, the loader
      // wasn't the problem (two mods' mixins clashing look the same), so the
      // hold is released rather than leaving the instance on an old build.
      if (hooks.pinLoader && (f.mixin || f.linkage)) {
        const pinKey = `crash|pin|${modId}`;
        const cutoff = dateOf(proj?.version) || null;
        if (!tried.has(pinKey) && cutoff && [...tried].filter(k => /^crash\|pin\|[^|]+$/.test(k)).length < 2) {
          tried.add(pinKey);
          const build = await hooks.pinLoader(cutoff);
          if (build) {
            actions.push({ text: `held ${L} back to ${build} (${file} doesn't work with the newest ${L} yet)` });
            log(`[auto-fix] ${file} doesn't work with the newest ${L} build — using ${L} ${build} for this instance until it catches up.\n`);
            continue;
          }
        } else if (tried.has(pinKey) && once(`${pinKey}|undone`) && hooks.unpinLoader) {
          await hooks.unpinLoader();
          log(`[auto-fix] Holding ${L} back didn't help ${file} — back to the newest ${L} build.\n`);
        }
      }

      // 4. Turn it off — only when that can't cost the player anything.
      const protectedSet = requiredByOthers(modsDir, loader, side);
      const project = proj?.projectId ? await fetchProject(proj.projectId, { api, headers }) : null;
      const clientOnly = project && project.server_side === 'unsupported';
      if (side === 'client' && clientOnly && !protectedSet.has(file) && once(`crash|disable|${file}`)) {
        await disableJar(file, `it ${why}, and no version of it works here yet`);
        continue;
      }
      const title = project?.title || file;
      if (protectedSet.has(file)) {
        report.push(`${title} ${why}, and other mods need it, so MineDash left it in place. Check for an update to ${title} or the mods that depend on it.`);
      } else {
        report.push(`${title} ${why}, and no other version of it works here. MineDash didn't turn it off because it may add blocks or items to your worlds — turn it off in the Mods list if you're OK with that.`);
      }
      continue;
    }

    if (f.kind === 'report') report.push(f.message);
  }

  return { actions, report: [...new Set(report)] };
}

// The process ended because of a crash — not a normal quit that happened to
// log an exception earlier in the session. A non-zero exit, or a crash report /
// loader failure at the end of the log (Forge can exit 0 on a failed start).
function endedInCrash(code, logText) {
  if (!looksLikeCrash(logText)) return false;
  if (typeof code === 'number' && code !== 0) return true;
  const tail = String(logText || '').slice(-60000);
  return /---- Minecraft Crash Report ----|#@!@# Game crashed!|Failed to start (?:the minecraft server|FML)|Could not execute entrypoint/i.test(tail);
}

module.exports = {
  endedInCrash,
  diagnose,
  fixCrash,
  looksLikeCrash,
  // exported for tests / reuse
  crashSection,
  namedCulprits,
  stackCulprits,
  stackModClasses,
  jarForModId,
  jarForClasses,
  corruptJars,
  duplicateGroups,
  wrongLoaderJars,
  candidateOrder,
};
