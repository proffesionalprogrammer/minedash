// ─── Mod compatibility: vetted updates, update backups, crash repair ──────────
//
// The bug this exists for: the launcher offered Sodium 0.8.15-beta.1 as an
// update, the user took it, and Fabric refused to start — "Mod 'Sodium' is
// incompatible with version 1.10.7 or earlier of mod 'Iris'". Sodium's own
// fabric.mod.json says so (`breaks: { iris: "<=1.10.7" }`, from 0.8.14 on), but
// nothing read it: updates only asked Modrinth "what's newest", and the crash
// auto-fix only knew how to install *missing* mods — it dropped a second copy
// next to the broken one and relaunched into the same crash.
//
// So every change to a mods folder that MineDash makes on its own goes through
// here and is checked against the rest of the folder first (mod-deps
// analyzeModsDir): an update is only offered when its jar fits, stepping back
// to the newest version that does; the jar it replaces is kept so the update
// can be rolled back; and a crash is repaired by rolling back or swapping the
// offending jar, not by piling another one beside it.
//
// Shared by the launcher (client instances, side 'client') and the server
// (side 'server').

const path = require('path');
const fs = require('fs-extra');
const modDeps = require('./mod-deps');
const resolve = require('./modrinth-resolve');
const { runWithConcurrency } = require('./concurrency');

// What makes a change unacceptable:
//   - a wrong version or a declared break, anywhere in the folder;
//   - ANOTHER mod losing a dependency (the new version stopped providing an
//     ID something needs) — the invariant in CLAUDE.md: nothing may remove a
//     mod another mod requires.
// A new requirement of the changed jar itself (`newFile`) is fine: it's
// reported and installed. Without `newFile`, every 'missing' is non-blocking
// (used when scanning for conflicts to repair).
const blocking = (problems, newFile) => problems.filter(p =>
  p.type !== 'missing' || (newFile !== undefined && p.by !== newFile));

// ── Release channels ──────────────────────────────────────────────────────────
// Someone running a release shouldn't be moved to a beta by "Update"; someone
// who chose a beta can move to newer betas or a release.
const CHANNEL_RANK = { release: 0, beta: 1, alpha: 2 };
function channelAllowed(ver, installed) {
  const allowed = installed ? (CHANNEL_RANK[installed.version_type] ?? 0) : 0;
  return (CHANNEL_RANK[ver.version_type] ?? 2) <= allowed;
}

const dateOf = (v) => Date.parse(v?.date_published) || 0;

// Releases before pre-releases, newest first within each — the order to try
// replacement candidates in when repairing (a release that fits beats a beta).
function releasesFirst(versions) {
  return [...versions].sort((a, b) =>
    ((CHANNEL_RANK[a.version_type] ?? 3) - (CHANNEL_RANK[b.version_type] ?? 3)) || (dateOf(b) - dateOf(a)));
}

// ── Trying candidate versions ────────────────────────────────────────────────

/**
 * Walk `versions` in order and return the first whose jar fits the mods folder
 * as a replacement for `file` (or as a new jar when `file` is null):
 *   - it introduces no version/breaks problem that wasn't there before,
 *   - every problem key in `mustFix` is gone afterwards,
 *   - `accept(jarPath)` (optional) agrees — e.g. "this jar really is mod X".
 * Jars are downloaded into `cacheDir` (named by SHA1) so the update step can
 * reuse them. At most `maxDownloads` jars are fetched.
 *
 * Returns { version, file, jarPath, missing, rejected } — version null if none
 * fit. `rejected` lists [{ version, reason }] for the ones that didn't.
 */
async function firstCompatibleVersion({
  modsDir, loader, side, file, versions, cacheDir, headers,
  mustFix = [], accept = null, maxDownloads = 8,
}) {
  const before = modDeps.analyzeModsDir(modsDir, loader, { side });
  const rejected = [];
  let downloads = 0;
  for (const ver of versions) {
    const f = resolve.primaryFile(ver);
    if (!f?.url) continue;
    if (downloads >= maxDownloads) break;
    downloads++;
    const jarPath = path.join(cacheDir, `${f.hashes?.sha1 || ver.id}.jar`);
    try { await resolve.downloadVersionFile(f, jarPath, { headers, cacheDir }); }
    catch (err) { rejected.push({ version: ver, reason: err.message }); continue; }

    if (accept && !accept(jarPath)) { rejected.push({ version: ver, reason: 'not the mod that was asked for' }); continue; }

    const entry = { file: path.basename(f.filename), path: jarPath };
    const after = modDeps.analyzeModsDir(modsDir, loader, file
      ? { side, replace: { [file]: entry } }
      : { side, add: [entry] });
    const introduced = modDeps.introducedProblems(before, after);
    const bad = blocking(introduced, entry.file);
    const unfixed = after.filter(p => mustFix.includes(p.key));
    if (bad.length === 0 && unfixed.length === 0) {
      return { version: ver, file: f, jarPath, missing: introduced.filter(p => p.type === 'missing'), rejected };
    }
    rejected.push({ version: ver, reason: modDeps.describeProblem(bad[0] || unfixed[0]) });
  }
  return { version: null, file: null, jarPath: null, missing: [], rejected };
}

// ── Vetting update candidates (the "Check updates" step) ─────────────────────

/**
 * For each candidate from findModUpdates, find the newest version that is
 * allowed on this mod's release channel AND fits beside the installed mods.
 * `candidates`: [{ filename, newest, installed }] (Modrinth version objects;
 * `installed` may be null when Modrinth doesn't know the local jar's version).
 *
 * Returns [{ filename, offer: version|null, file, heldBack: [{ versionNumber,
 * reason }], reason }] — `offer` null means no newer version works right now,
 * and `reason` says why (for the UI).
 */
async function vetUpdates({ modsDir, loader, side, gameVersion, candidates, cacheDir, api, headers }) {
  await fs.ensureDir(cacheDir);
  const out = [];
  await runWithConcurrency(candidates.map(c => async () => {
    const { filename, newest, installed } = c;
    const disabled = filename.toLowerCase().endsWith('.disabled');
    const heldBack = [];

    // Newer than what's installed, allowed on its channel, newest first.
    const eligible = (v) => v && v.id !== installed?.id && channelAllowed(v, installed)
      && (!installed || dateOf(v) > dateOf(installed));

    // A disabled jar isn't loaded, so it can't conflict with anything.
    if (disabled) {
      if (eligible(newest)) out.push({ filename, offer: newest, file: resolve.primaryFile(newest), heldBack, reason: null });
      else out.push({ filename, offer: null, heldBack, reason: null, skip: true });
      return;
    }

    let list = eligible(newest) ? [newest] : [];
    if (!eligible(newest) && newest) heldBack.push({ versionNumber: newest.version_number, reason: `it's a ${newest.version_type} build` });
    let result = list.length ? await firstCompatibleVersion({ modsDir, loader, side, file: filename, versions: list, cacheDir, headers, maxDownloads: 1 }) : null;
    if (result?.version) { out.push({ filename, offer: result.version, file: result.file, heldBack, reason: null }); return; }
    for (const r of result?.rejected || []) heldBack.push({ versionNumber: r.version.version_number, reason: r.reason });

    // The newest didn't fit (or isn't on this channel): step back through the
    // project's other newer versions. Only possible when we know which version
    // is installed — otherwise "newer" is unknowable.
    if (installed) {
      const all = await resolve.projectVersions(newest.project_id, loader, gameVersion, { api, headers });
      list = all.filter(v => eligible(v) && v.id !== newest.id);
      result = await firstCompatibleVersion({ modsDir, loader, side, file: filename, versions: list, cacheDir, headers, maxDownloads: 6 });
      for (const r of result.rejected) heldBack.push({ versionNumber: r.version.version_number, reason: r.reason });
      if (result.version) { out.push({ filename, offer: result.version, file: result.file, heldBack, reason: null }); return; }
    }
    const firstReal = heldBack.find(h => !/build$/.test(h.reason));
    out.push({ filename, offer: null, heldBack, reason: firstReal?.reason || null, skip: !firstReal });
  }), 3);
  return out;
}

// Drop cached update jars older than a day — the cache only has to bridge
// "Check updates" and "Update".
async function pruneCache(cacheDir, maxAgeMs = 24 * 60 * 60 * 1000) {
  let names = [];
  try { names = await fs.readdir(cacheDir); } catch { return; }
  const now = Date.now();
  for (const n of names) {
    const p = path.join(cacheDir, n);
    try { if (now - (await fs.stat(p)).mtimeMs > maxAgeMs) await fs.remove(p); } catch {}
  }
}

// ── Update backups ────────────────────────────────────────────────────────────
// The jar an update replaces is moved into `backupDir` rather than deleted, and
// backups.json maps the new filename to it. That's what lets a crash caused by
// an update be undone exactly — the known-good jar, not a best guess from
// Modrinth. One level deep per mod: updating again drops the older backup.

const MANIFEST = 'backups.json';
async function readBackups(backupDir) {
  try { return await fs.readJson(path.join(backupDir, MANIFEST)); } catch { return {}; }
}
async function writeBackups(backupDir, manifest) {
  await fs.ensureDir(backupDir);
  await fs.writeJson(path.join(backupDir, MANIFEST), manifest, { spaces: 2 });
}

/**
 * Put `newJarPath` in place as `newName`, keeping `oldName` as a backup.
 * The new jar is moved in before anything is lost; a same-named update works.
 */
async function replaceWithBackup({ modsDir, backupDir, oldName, newName, newJarPath, reason = 'update' }) {
  const manifest = await readBackups(backupDir);
  await fs.ensureDir(backupDir);
  const stored = `${Date.now()}-${oldName}`;
  const oldPath = path.join(modsDir, oldName);
  if (await fs.pathExists(oldPath)) {
    await fs.move(oldPath, path.join(backupDir, stored), { overwrite: true });
  }
  try {
    await fs.move(newJarPath, path.join(modsDir, newName), { overwrite: true });
  } catch (err) {
    // Put the old jar back rather than leave the mod missing.
    await fs.move(path.join(backupDir, stored), oldPath, { overwrite: true }).catch(() => {});
    throw err;
  }
  // The jar we just replaced may itself have been an update; keep only the
  // most recent previous version per mod.
  const prior = manifest[oldName];
  if (prior && prior.file !== stored) await fs.remove(path.join(backupDir, prior.file)).catch(() => {});
  delete manifest[oldName];
  manifest[newName] = { previous: oldName, file: stored, at: Date.now(), reason };
  await writeBackups(backupDir, manifest);
}

// The backup that `current` replaced, as an analyzeJars entry, or null.
async function backupFor(backupDir, current) {
  const entry = (await readBackups(backupDir))[current];
  if (!entry) return null;
  const p = path.join(backupDir, entry.file);
  return (await fs.pathExists(p)) ? { file: entry.previous, path: p, entry } : null;
}

// Undo the update that produced `current`: the backed-up jar goes back under
// its old name and `current` is removed. Returns { restored, removed } or null.
async function rollback({ modsDir, backupDir, current }) {
  const b = await backupFor(backupDir, current);
  if (!b) return null;
  const manifest = await readBackups(backupDir);
  const curPath = path.join(modsDir, current);
  const aside = path.join(backupDir, `.rollback-${Date.now()}-${current}`);
  if (await fs.pathExists(curPath)) await fs.move(curPath, aside, { overwrite: true });
  try {
    await fs.move(b.path, path.join(modsDir, b.file), { overwrite: true });
  } catch (err) {
    await fs.move(aside, curPath, { overwrite: true }).catch(() => {});
    throw err;
  }
  await fs.remove(aside).catch(() => {});
  delete manifest[current];
  await writeBackups(backupDir, manifest);
  return { restored: b.file, removed: current };
}

// ── Crash repair ─────────────────────────────────────────────────────────────

/**
 * Fix what the loader refused to start with. Called after a crash the log
 * identifies as a dependency/compatibility failure. For each conflict (a mod
 * needing another at a different version, or declaring it breaks another):
 *   1. roll back whichever side MineDash updated (its backup is known-good),
 *   2. otherwise swap the *other* side for a version that fits (for "needs Y
 *      1.x" that's a Y in range; for "breaks Y <= 1.2" a newer Y),
 *   3. otherwise swap the declaring mod for a version that fits.
 * Missing mods are installed through the validated resolver. Every candidate is
 * checked against the whole folder first; a jar that's swapped out is kept as
 * a backup, never deleted.
 *
 * `tried` (a Set) persists across relaunches so the same problem is never
 * "fixed" twice in a loop. `hooks` lets the caller keep its own bookkeeping in
 * step: projectFor(filename) -> { projectId, version } | null,
 * onReplaced({ from, to, version, project }), onAdded({ file, version, project }).
 *
 * `conflicts: false` only installs missing mods (used after an update, where
 * pre-existing conflicts aren't ours to touch); `missing: false` only fixes
 * conflicts (the server keeps its own missing-mod installer).
 *
 * Returns [{ text }] — one line per action taken. Empty means nothing could be
 * done, and the caller should not relaunch.
 */
async function repairMods({
  modsDir, backupDir, cacheDir, loader, side, gameVersion, api, headers,
  extraMissingIds = [], tried = new Set(), log = () => {}, hooks = {}, conflicts = true, missing = true,
}) {
  await fs.ensureDir(cacheDir);
  const actions = [];
  const analyze = () => modDeps.analyzeModsDir(modsDir, loader, { side });

  const describeFix = (from, to) => `${from} → ${to}`;

  // Apply a candidate jar in place of `oldName` (keeping a backup).
  const swapIn = async (oldName, found, why) => {
    const newName = path.basename(found.file.filename);
    const staging = path.join(modsDir, `.${newName}.minedash-tmp`);
    await fs.copy(found.jarPath, staging, { overwrite: true });
    await replaceWithBackup({ modsDir, backupDir, oldName, newName, newJarPath: staging, reason: 'crash-repair' });
    await hooks.onReplaced?.({ from: oldName, to: newName, version: found.version });
    actions.push({ text: `${describeFix(oldName, newName)} (${why})` });
    log(`[auto-fix] Replaced ${oldName} with ${newName} — ${why}\n`);
  };

  const tryRollback = async (file, p) => {
    const b = await backupFor(backupDir, file);
    if (!b) return false;
    const after = modDeps.analyzeModsDir(modsDir, loader, { side, replace: { [file]: { file: b.file, path: b.path } } });
    const introduced = blocking(modDeps.introducedProblems(analyze(), after), b.file);
    if (introduced.length || after.some(q => q.key === p.key)) return false;
    const r = await rollback({ modsDir, backupDir, current: file });
    if (!r) return false;
    await hooks.onReplaced?.({ from: r.removed, to: r.restored, version: null, rolledBack: true });
    actions.push({ text: `rolled ${r.removed} back to ${r.restored} (${modDeps.describeProblem(p)})` });
    log(`[auto-fix] Rolled back ${r.removed} to ${r.restored} — ${modDeps.describeProblem(p)}\n`);
    return true;
  };

  const tryReplace = async (file, p, { newerOnly }) => {
    const proj = await hooks.projectFor?.(file);
    if (!proj?.projectId) return false;
    let versions = await resolve.projectVersions(proj.projectId, loader, gameVersion, { api, headers });
    versions = versions.filter(v => v.id !== proj.version?.id);
    if (newerOnly && proj.version) versions = versions.filter(v => dateOf(v) > dateOf(proj.version));
    if (!versions.length) return false;
    const found = await firstCompatibleVersion({
      modsDir, loader, side, file, versions: releasesFirst(versions), cacheDir, headers,
      mustFix: [p.key], maxDownloads: 10,
    });
    if (!found.version) return false;
    await swapIn(file, found, modDeps.describeProblem(p));
    return true;
  };

  // 1–3: conflicts, most specific fix first. Re-analyse after each change —
  // one swap can clear (or cause) others.
  for (let pass = 0; conflicts && pass < 4; pass++) {
    const conflict = blocking(analyze()).find(p => !tried.has(p.key));
    if (!conflict) break;
    tried.add(conflict.key);
    log(`[auto-fix] ${modDeps.describeProblem(conflict)}\n`);
    const A = conflict.by;       // declares the requirement / the break
    const B = conflict.haveFile; // the mod it's about
    const fixed = await tryRollback(A, conflict)
      || await tryRollback(B, conflict)
      || await tryReplace(B, conflict, { newerOnly: conflict.type === 'breaks' })
      || await tryReplace(A, conflict, { newerOnly: false });
    if (!fixed) log(`[auto-fix] No compatible version found on Modrinth for this — fix it by hand.\n`);
  }

  // 4: missing mods. The loader's own report (extraMissingIds) is only trusted
  // for IDs nothing on disk provides — a present-but-wrong-version mod is a
  // conflict, handled above, not something to install a second copy of.
  const MOD_ID_REMAP = { fabric: 'fabric-api' };
  for (let pass = 0; missing && pass < 3; pass++) {
    const provided = new Set();
    for (const e of modDeps.listEnabledJars(modsDir)) for (const id of modDeps.readJarModInfo(e.path, loader, { side }).ids) provided.add(id);
    const missing = new Set(analyze().filter(p => p.type === 'missing').map(p => p.id));
    for (const id of extraMissingIds) if (!provided.has(id) && !modDeps.BUILTIN_MOD_IDS.has(id)) missing.add(id);
    const todo = [...missing].filter(id => !tried.has(`install|${id}`));
    if (!todo.length) break;
    for (const id of todo) {
      tried.add(`install|${id}`);
      const lookupId = MOD_ID_REMAP[id] || id;
      log(`[auto-fix] Looking for '${lookupId}' on Modrinth…\n`);
      const candidates = await resolve.findModrinthCandidates(lookupId, loader, gameVersion, { api, headers });
      let done = false;
      for (const { project } of candidates) {
        const versions = releasesFirst(await resolve.projectVersions(project.id, loader, gameVersion, { api, headers }));
        if (!versions.length) continue;
        const found = await firstCompatibleVersion({
          modsDir, loader, side, file: null, versions, cacheDir, headers, maxDownloads: 3,
          // Two unrelated projects share a name all the time — only a jar that
          // really declares the ID counts.
          accept: (jar) => {
            const ids = modDeps.readJarModInfo(jar, loader, { side }).ids;
            return ids.length === 0 || ids.includes(id) || ids.includes(lookupId);
          },
        });
        if (!found.version) continue;
        const name = path.basename(found.file.filename);
        await fs.copy(found.jarPath, path.join(modsDir, name), { overwrite: true });
        await hooks.onAdded?.({ file: name, version: found.version, project });
        actions.push({ text: `installed ${project.title || lookupId} (${name})` });
        log(`[auto-fix] ✓ Installed ${project.title || lookupId} (${name})\n`);
        done = true;
        break;
      }
      if (!done) log(`[auto-fix] Couldn't find a compatible '${lookupId}' for ${loader} ${gameVersion}.\n`);
    }
  }
  return actions;
}

module.exports = {
  channelAllowed,
  firstCompatibleVersion,
  vetUpdates,
  pruneCache,
  replaceWithBackup,
  readBackups,
  backupFor,
  rollback,
  repairMods,
  blocking,
};
