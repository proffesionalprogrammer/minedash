// ─── Modrinth mod-update lookup ────────────────────────────────────────────────
//
// Shared by the server Mods tab (index.js) and the launcher's per-profile
// content panel (launcher.js). Both hash every jar and ask Modrinth's
// /version_files/update for the newest version matching the loader + game
// version.
//
// That endpoint answers "the newest version *that matches the filter*", which
// is not the same as "a newer version than the one installed". A beta build,
// or a jar tagged for a neighbouring MC version (1.20 on a 1.20.1 server),
// matches nothing newer than itself — so Modrinth hands back an OLDER release
// and "Update" would silently downgrade the mod. The installed version is
// looked up alongside (/version_files) and only strictly newer releases are
// kept.

function primaryFile(ver) {
  const files = ver?.files || [];
  return files.find(f => f.primary) || files[0] || null;
}

async function postJson(url, headers, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = new Error(`Modrinth update lookup failed (${r.status})`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// Resolves to { [sha1]: { version, file, installed } } for every jar with a
// real upgrade. `installed` is the Modrinth version of the local jar (null when
// unknown) — mod-compat needs it to judge release channel and "newer".
// Throws on a network error (no .status) or a non-2xx answer (.status set), so
// callers can tell "offline" from "Modrinth said no".
async function findModUpdates({ api, headers, hashes, loader, gameVersion }) {
  const [latest, installed] = await Promise.all([
    postJson(`${api}/version_files/update`, headers, {
      hashes, algorithm: 'sha1', loaders: [loader], game_versions: [gameVersion],
    }),
    // Best-effort: without it we fall back to the hash comparison alone.
    postJson(`${api}/version_files`, headers, { hashes, algorithm: 'sha1' }).catch(() => ({})),
  ]);

  const out = {};
  for (const [sha1, ver] of Object.entries(latest || {})) {
    const file = primaryFile(ver);
    // Modrinth echoes the installed version back when it's already the newest.
    if (!file || file.hashes?.sha1 === sha1) continue;
    const cur = installed?.[sha1];
    if (cur && cur.id === ver.id) continue;
    const curDate = Date.parse(cur?.date_published);
    const newDate = Date.parse(ver.date_published);
    if (Number.isFinite(curDate) && Number.isFinite(newDate) && newDate <= curDate) continue;
    out[sha1] = { version: ver, file, installed: cur || null };
  }
  return out;
}

module.exports = { findModUpdates, primaryFile };
