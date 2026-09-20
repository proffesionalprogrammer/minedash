// CHANGELOG.md parsing, shared by the "What's new" popup (one version) and the
// Settings → Updates history view (every version).
//
// The file is copied into the bundle at build time (see frontend/package.json's
// dev/build scripts), so it's fetched from the app's own origin — no network.

/** Fetch the bundled CHANGELOG.md. Returns its text, or null if unavailable. */
export async function fetchChangelog() {
  try {
    const r = await fetch('CHANGELOG.md', { cache: 'no-cache' });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

/**
 * Pull out the `## v1.0.2 — …` section for one version. Returns that section's
 * body as raw markdown (heading stripped), or null when the version isn't in
 * the file. `version` is escaped so dotted versions don't break the regex.
 */
export function extractSection(text, version) {
  const v = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^##\\s+v${v}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s+v|\\Z)`, 'm');
  const m = String(text).match(re);
  if (!m) return null;
  return stripRules(m[1]);
}

/**
 * Split the whole file into its release sections, newest first (file order).
 * Each entry: { version, date, body } — `date` is whatever followed the em
 * dash in the heading, or '' when the heading omits it.
 */
export function parseChangelog(text) {
  const releases = [];
  if (!text) return releases;

  // `## v1.3.1 — 2026-06-18`, tolerating an en/em dash, a hyphen, or no date.
  const headingRe = /^##\s+v(\d[^\s—–-]*)\s*(?:[—–-]\s*(.*))?$/gm;
  const heads = [];
  let m;
  while ((m = headingRe.exec(text)) !== null) {
    heads.push({ version: m[1].trim(), date: (m[2] || '').trim(), start: m.index + m[0].length });
  }
  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? text.lastIndexOf('\n##', heads[i + 1].start) : text.length;
    releases.push({
      version: heads[i].version,
      date: heads[i].date,
      body: stripRules(text.slice(heads[i].start, end)),
    });
  }
  return releases;
}

// Drop the `---` separators between sections and trim the surrounding blanks.
function stripRules(body) {
  return String(body).replace(/^\s*---\s*$/gm, '').trim();
}
