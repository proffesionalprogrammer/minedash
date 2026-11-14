'use strict';

// Minecraft release-version shapes, in one place.
//
// Until 1.21.11 every release was `1.MAJOR(.MINOR)`. From 2026 Mojang numbers
// releases by year: `26.1`, `26.1.1`, `26.2`, `26.3`, … Code that assumed a
// leading `1.` hid every 26.x version (Fabric, Forge lists) or invented
// versions that don't exist (NeoForge 26.3.0.x was mapped to "1.26.3", which
// Modrinth has no mods for and Mojang's manifest has no entry for).

const LEGACY_RE = /^1\.(\d+)(?:\.(\d+))?$/;
const YEARLY_RE = /^(\d{2})\.(\d+)(?:\.(\d+))?$/;
const FIRST_YEARLY = 26;

// A full release id (no snapshots, pre-releases or RCs).
function isReleaseVersion(v) {
  if (typeof v !== 'string') return false;
  if (LEGACY_RE.test(v)) return true;
  const m = v.match(YEARLY_RE);
  return !!m && parseInt(m[1], 10) >= FIRST_YEARLY;
}

// Newest-first comparator for release ids. 26.x sorts above 1.x naturally
// because the first segment is compared numerically.
function compareVersionsDesc(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Repairs a version id that older MineDash builds produced from a NeoForge
// 26.x version: "1.26.3" → "26.3", "1.26.1.1" → "26.1.1". No real release was
// ever numbered 1.22+, so anything 1.26+ is one of those.
function normalizeMcVersion(v) {
  if (typeof v !== 'string') return v;
  const m = v.match(/^1\.(\d+)((?:\.\d+)*)$/);
  if (m && parseInt(m[1], 10) >= FIRST_YEARLY) return `${m[1]}${m[2]}`;
  return v;
}

// NeoForge version → Minecraft version.
//   21.1.77        → 1.21.1     (legacy: MAJOR.MINOR.build)
//   20.4.237       → 1.20.4
//   21.0.x         → 1.21
//   26.3.0.103     → 26.3       (yearly: YEAR.DROP.PATCH.build)
//   26.1.1.12-beta → 26.1.1
// Returns null for names that aren't NeoForge release directories.
function neoforgeToMc(neoVersion) {
  const parts = String(neoVersion).split('-')[0].split('.');
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  if (major >= FIRST_YEARLY) {
    if (parts.length < 4) return null;
    const patch = parseInt(parts[2], 10);
    if (!Number.isFinite(patch)) return null;
    return patch === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
  }
  if (major < 20) return null;
  return minor === 0 ? `1.${major}` : `1.${major}.${minor}`;
}

// Minecraft version → the prefix (with trailing dot) of the NeoForge versions
// built for it. Null when the version isn't one NeoForge supports.
function mcToNeoforgePrefix(mcVersion) {
  const v = normalizeMcVersion(mcVersion);
  let m = typeof v === 'string' && v.match(LEGACY_RE);
  if (m) return `${m[1]}.${m[2] || '0'}.`;
  m = typeof v === 'string' && v.match(YEARLY_RE);
  if (m && parseInt(m[1], 10) >= FIRST_YEARLY) return `${m[1]}.${m[2]}.${m[3] || '0'}.`;
  return null;
}

module.exports = {
  isReleaseVersion,
  compareVersionsDesc,
  normalizeMcVersion,
  neoforgeToMc,
  mcToNeoforgePrefix,
};
