// Small formatting helpers shared by VersionRow and ProjectDetailModal.
// Plain JS module (no components) so component files keep fast-refresh.

export const LOADER_LABELS = {
  fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt',
  paper: 'Paper', spigot: 'Spigot', bukkit: 'Bukkit',
  iris: 'Iris', optifine: 'OptiFine', canvas: 'Canvas',
  minecraft: 'Minecraft',
};

export function fmt(n) {
  if (n == null) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

export function fmtBytes(b) {
  if (b == null || !Number.isFinite(b)) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const sec = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (sec < 60)  return sec + 's ago';
  const min = Math.round(sec / 60);
  if (min < 60)  return min + 'm ago';
  const hr = Math.round(min / 60);
  if (hr < 24)   return hr + 'h ago';
  const day = Math.round(hr / 24);
  if (day < 30)  return day + 'd ago';
  const mo = Math.round(day / 30);
  if (mo < 12)   return mo + 'mo ago';
  return Math.round(mo / 12) + 'y ago';
}

export function fmtDateAbs(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
