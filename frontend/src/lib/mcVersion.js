// A full Minecraft release id: the classic "1.21.11" shape, or the yearly
// numbering Mojang switched to in 2026 ("26.1", "26.1.2", "26.3"). Snapshots,
// pre-releases and RCs don't match. Mirrors backend/mc-version.js.
export function isReleaseVersion(v) {
  if (typeof v !== 'string') return false;
  if (/^1\.\d+(\.\d+)?$/.test(v)) return true;
  const m = v.match(/^(\d{2})\.\d+(\.\d+)?$/);
  return !!m && Number(m[1]) >= 26;
}
