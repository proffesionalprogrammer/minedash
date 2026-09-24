// Mod version comparison + dependency-range evaluation, the way the loaders do it.
//
// Why this exists: a mod jar doesn't just say *which* mods it needs, it says
// *which versions* — and which versions of other mods it refuses to run beside.
// Sodium 0.8.14 declares `breaks: { iris: "<=1.10.7" }`; Iris 1.10.7 declares
// `depends: { sodium: ["0.8.x"] }`. Fabric enforces both at startup and shows
// "Incompatible mods found!". MineDash used to check only that an ID was
// present, so an update could install a Sodium the installed Iris can't load
// beside, and the crash auto-fix couldn't see the problem at all.
//
// Two dialects:
//   fabric / quilt — SemVer predicates: "*", ">=1.2", "<=1.10.7", "0.8.x",
//                    "~1.2", "^1.2", space-separated terms AND, an array OR.
//   forge / neoforge — Maven ranges: "[1.0,2.0)", "[1.2,)", "(,1.0]", "[1.0]",
//                    comma-joined ranges OR; a bare "1.0" matches anything
//                    (a Maven "recommended" version).
//
// Every check answers true / false / null. null means "can't tell" (a version
// string that isn't comparable, a predicate we don't understand) and callers
// must treat it as *satisfied* — acting on a guess would delete working mods.

// ── Fabric-style SemVer ───────────────────────────────────────────────────────

// "1.10.7+mc1.21.11" -> { nums: [1,10,7], pre: null }
// "0.8.15-beta.1+mc1.21.11" -> { nums: [0,8,15], pre: ['beta', '1'] }
// Build metadata (+...) never affects ordering, as in SemVer.
function parseSemver(v) {
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]*))?(?:\+.*)?$/.exec(String(v || '').trim());
  if (!m) return null;
  return {
    nums: m[1].split('.').map(Number),
    pre: m[2] === undefined ? null : m[2].split('.'),
  };
}

function comparePre(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;  // a release sorts after any pre-release of the same version
  if (!b) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const na = /^\d+$/.test(a[i]); const nb = /^\d+$/.test(b[i]);
    if (na && nb) { const d = Number(a[i]) - Number(b[i]); if (d) return Math.sign(d); continue; }
    if (na !== nb) return na ? -1 : 1; // numeric identifiers sort before words
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function compareSemver(a, b) {
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const d = (a.nums[i] || 0) - (b.nums[i] || 0);
    if (d) return Math.sign(d);
  }
  return comparePre(a.pre, b.pre);
}

// One predicate term against a parsed version. true / false / null.
function fabricTerm(term, ver) {
  const t = term.trim();
  if (!t || t === '*') return true;
  const m = /^(>=|<=|>|<|=|~|\^)?\s*(.+)$/.exec(t);
  if (!m) return null;
  const op = m[1] || '=';
  const raw = m[2];

  // X-ranges: "0.8.x", "1.x", "1.2.*" — the fixed leading components must match.
  const parts = raw.split(/[-+]/)[0].split('.');
  const wild = parts.findIndex(p => /^[xX*]$/.test(p));
  if (wild !== -1) {
    if (op !== '=') return null;
    const fixed = parts.slice(0, wild).map(Number);
    if (fixed.some(n => !Number.isFinite(n))) return null;
    return fixed.every((n, i) => (ver.nums[i] || 0) === n);
  }

  const base = parseSemver(raw);
  if (!base) return null;
  const c = compareSemver(ver, base);
  switch (op) {
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '<': return c < 0;
    case '=': return c === 0;
    // ~1.2.3: >=1.2.3, same major.minor. ~1: same major.
    case '~': return c >= 0 && base.nums.slice(0, Math.min(2, base.nums.length)).every((n, i) => (ver.nums[i] || 0) === n);
    // ^1.2.3: >=1.2.3, same major.
    case '^': return c >= 0 && (ver.nums[0] || 0) === base.nums[0];
    default: return null;
  }
}

// A whole Fabric/Quilt predicate: string (terms ANDed), array (OR), or Quilt's
// { any: [...] } / { all: [...] } objects.
function fabricSatisfies(version, pred) {
  if (pred == null) return true;
  if (Array.isArray(pred)) {
    if (pred.length === 0) return true;
    let unknown = false;
    for (const p of pred) {
      const r = fabricSatisfies(version, p);
      if (r === true) return true;
      if (r === null) unknown = true;
    }
    return unknown ? null : false;
  }
  if (typeof pred === 'object') {
    if (Array.isArray(pred.any)) return fabricSatisfies(version, pred.any);
    if (Array.isArray(pred.all)) {
      let unknown = false;
      for (const p of pred.all) {
        const r = fabricSatisfies(version, p);
        if (r === false) return false;
        if (r === null) unknown = true;
      }
      return unknown ? null : true;
    }
    return null;
  }
  const s = String(pred).trim();
  if (!s || s === '*') return true;
  const ver = parseSemver(version);
  if (!ver) return null; // Fabric only compares SemVer; anything else we can't judge
  let unknown = false;
  for (const term of s.split(/\s+/)) {
    const r = fabricTerm(term, ver);
    if (r === false) return false;
    if (r === null) unknown = true;
  }
  return unknown ? null : true;
}

// ── Maven (Forge / NeoForge) ──────────────────────────────────────────────────

const QUALIFIER_RANK = { alpha: 1, a: 1, beta: 2, b: 2, milestone: 3, m: 3, rc: 4, cr: 4, snapshot: 5, '': 6, ga: 6, final: 6, release: 6, sp: 7 };

// Rough ComparableVersion: "1.20.1-47.2.0" -> [1,20,1,47,2,0]; "2.0-beta3" ->
// [2,0,'beta',3]. Trailing zeros / release qualifiers don't matter (1.0 == 1.0.0).
function mavenItems(v) {
  const items = [];
  for (const chunk of String(v).toLowerCase().split(/[.\-_+]/)) {
    for (const piece of chunk.match(/\d+|[a-z]+/g) || []) {
      items.push(/^\d+$/.test(piece) ? Number(piece) : piece);
    }
  }
  while (items.length && (items[items.length - 1] === 0 || QUALIFIER_RANK[items[items.length - 1]] === 6)) items.pop();
  return items;
}

function mavenCompare(a, b) {
  const x = mavenItems(a); const y = mavenItems(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i]; const q = y[i];
    if (p === q) continue;
    const rank = (it) => (it === undefined ? 6 : typeof it === 'number' ? null : (QUALIFIER_RANK[it] ?? 8));
    if (typeof p === 'number' && typeof q === 'number') return Math.sign(p - q);
    // A missing item pads as 0, so "2.0-beta3" vs "2.0" moves on to the qualifier.
    if (typeof p === 'number' && q === undefined) { if (p === 0) continue; return 1; }
    if (typeof q === 'number' && p === undefined) { if (q === 0) continue; return -1; }
    if (typeof p === 'number') return 1;   // 1.0.1 > 1.0-beta
    if (typeof q === 'number') return -1;
    const d = rank(p) - rank(q);
    if (d) return Math.sign(d);
    if (p !== q) return String(p) < String(q) ? -1 : 1;
  }
  return 0;
}

function mavenSatisfies(version, spec) {
  if (spec == null) return true;
  const s = String(spec).trim();
  if (!s || s === '*') return true;
  if (!/^[\[(]/.test(s)) return true; // bare "1.0" is a recommendation, not a limit
  if (!version || /\$\{/.test(version)) return null; // unresolved ${file.jarVersion}
  const re = /([\[(])\s*([^,\])]*?)\s*(?:,\s*([^\])]*?)\s*)?([\])])/g;
  let m; let matched = false; let any = false;
  while ((m = re.exec(s)) !== null) {
    any = true;
    const [, open, lo, hi, close] = m;
    const exact = !s.slice(m.index, re.lastIndex).includes(',');
    if (exact) { if (mavenCompare(version, lo) === 0) matched = true; continue; }
    const loOk = !lo || (open === '[' ? mavenCompare(version, lo) >= 0 : mavenCompare(version, lo) > 0);
    const hiOk = !hi || (close === ']' ? mavenCompare(version, hi) <= 0 : mavenCompare(version, hi) < 0);
    if (loOk && hiOk) matched = true;
  }
  return any ? matched : null;
}

// ── Public API ────────────────────────────────────────────────────────────────

// `flavor` is the metadata dialect the predicate came from: 'fabric' | 'quilt'
// | 'forge'. Returns true / false / null (unknown — treat as satisfied).
function satisfies(version, predicate, flavor) {
  if (version == null) return null;
  return flavor === 'forge' ? mavenSatisfies(version, predicate) : fabricSatisfies(version, predicate);
}

// -1 / 0 / 1, or null when the two can't be ordered.
function compareVersions(a, b, flavor) {
  if (flavor === 'forge') return mavenCompare(a, b);
  const pa = parseSemver(a); const pb = parseSemver(b);
  return pa && pb ? compareSemver(pa, pb) : null;
}

// Short human form of a predicate for messages: ["0.8.x"] -> "0.8.x".
function describePredicate(pred) {
  if (pred == null) return 'any version';
  if (Array.isArray(pred)) return pred.map(describePredicate).join(' or ');
  if (typeof pred === 'object') return JSON.stringify(pred);
  return String(pred).trim() || 'any version';
}

module.exports = { satisfies, compareVersions, describePredicate, parseSemver, mavenCompare };
