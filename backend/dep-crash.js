// Shared dep-crash detection + missing-mod parsing.
// Used by:
//   - backend/index.js  — for server-side launch crashes (Java mc server)
//   - backend/launcher-worker.js — for client-side launch crashes (the launcher's
//     mclc-spawned JVM), so the launcher can also auto-install missing deps
//
// Both call sites scan the JVM's stdout/stderr after the process exits and
// pass any extracted mod IDs to a Modrinth lookup that downloads the missing
// jars and retries the launch.

// Strip Minecraft color/formatting codes (§0, §a, §r, §n, etc.) so the
// regexes can match prose that may have been color-coded in-game.
function stripMcCodes(text) {
  return text.replace(/[§§][0-9a-fklmnorA-FKLMNOR]/g, '');
}

// Parse server crash output for missing mod IDs.
// Returns an array of mod ID strings to look up on Modrinth.
function parseMissingModIds(logText) {
  const clean = stripMcCodes(logText);
  const missing = new Set();
  let m;

  // MOST RELIABLE — Forge/NeoForge structured dep report:
  // "Mod ID: 'architectury', Requested by: 'exposure_expanded', ..., Actual version: '[MISSING]'"
  const forgeStructured = /Mod ID:\s*'([^']+)'[^,\n]*,\s*Requested by:[^\n]*Actual version:\s*'\[MISSING\]'/gi;
  while ((m = forgeStructured.exec(clean)) !== null) missing.add(m[1].toLowerCase());

  // Forge/NeoForge prose message: "Currently, <modid> is ... not installed"
  const forge1 = /Currently,\s+(\S+)\s+is\s+(?:\S+\s+)*?not installed/gi;
  while ((m = forge1.exec(clean)) !== null) missing.add(m[1].toLowerCase());

  // Forge/NeoForge: "Mod X requires <modid> <semver>" inside a loading-errors block
  if (/LoadingFailedException|loading errors encountered|Missing or unsupported mandatory/i.test(clean)) {
    const forge2 = /Mod\s+\S+\s+requires\s+([a-z][a-z0-9_-]*)\s+\d/gi;
    while ((m = forge2.exec(clean)) !== null) missing.add(m[1].toLowerCase());
  }

  // Fabric: "requires mod '<modid>'" or "requires version X of mod '<modid>'"
  const fabric = /requires(?:\s+version\s+\S+\s+of)?\s+mod\s+'([^']+)'/gi;
  while ((m = fabric.exec(clean)) !== null) missing.add(m[1].toLowerCase());

  // Fabric (newer loader): structured dep report — "HARD_DEP_NO_CANDIDATE <mod> <ver> {depends <depid> @"
  const fabricHardDep = /HARD_DEP(?:_NO_CANDIDATE)?\s+\S+\s+\S+\s+\{depends\s+([a-z][a-z0-9_-]*)\s+@/gi;
  while ((m = fabricHardDep.exec(clean)) !== null) missing.add(m[1].toLowerCase());

  // Fabric (newer loader): "requires any version of <modid>, which is missing"
  const fabricAnyVersion = /requires\s+any\s+version\s+of\s+([a-z][a-z0-9_-]*),\s+which\s+is\s+missing/gi;
  while ((m = fabricAnyVersion.exec(clean)) !== null) missing.add(m[1].toLowerCase());

  // Filter out tokens that are clearly not mod IDs
  // NOTE: 'fabric' is intentionally kept — on Fabric servers it means Fabric API (a real mod), not the loader
  for (const skip of ['minecraft', 'forge', 'neoforge', 'above', 'or', 'and', 'the', 'a', 'is', 'not', 'null', 'unknown']) {
    missing.delete(skip);
  }

  return Array.from(missing);
}

// Returns true if the log text indicates a dependency crash (regardless of exit code).
// Forge exits with code 0 even on dep failures, so we can't rely on code alone.
function hasDependencyCrash(logText) {
  return /Missing or unsupported mandatory dep|LoadingFailedException|Actual version:\s*'\[MISSING\]'|Incompatible mods found|Mod resolution failed/i.test(logText);
}

module.exports = { stripMcCodes, parseMissingModIds, hasDependencyCrash };
