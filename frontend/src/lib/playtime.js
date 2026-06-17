// Shared play-time formatting for the Game Time feature (Settings → Minecraft).
// Used by the instance grid (total) and the per-instance detail panel.

// Format an accumulated duration. `inHours` forces a single "2.5h" reading
// (the "Always show durations in hours" setting); otherwise it's the friendlier
// "2h 35m" / "45m" / "30s" form.
export function formatPlaytime(ms, inHours = false) {
  const n = Number(ms) || 0;
  if (n < 1000) return '0m';
  if (inHours) {
    const h = n / 3600000;
    return h < 0.05 ? '<0.1h' : `${h.toFixed(1)}h`;
  }
  const totalMin = Math.floor(n / 60000);
  if (totalMin < 1) return `${Math.floor(n / 1000)}s`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

// Relative "last played" label from an epoch-ms timestamp. Coarse on purpose —
// the exact minute doesn't matter, only the rough recency.
export function formatLastPlayed(ms) {
  const t = Number(ms) || 0;
  if (!t) return null;
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  try {
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return `${days}d ago`; }
}
