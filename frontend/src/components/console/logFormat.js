// Pure log-formatting helpers shared by ConsoleViewer and LogLine. Kept in a
// non-component module so LogLine.jsx only exports a component (React Fast
// Refresh requires component files to export components exclusively).

// Detect the log level of a single line. Vanilla / Paper / Fabric / Forge
// all converge on the "[HH:MM:SS] [Thread/LEVEL]" prefix or include the bare
// word ERROR / WARN in the message body.
export function detectLogLevel(line) {
  if (/\bERROR\b|\bFATAL\b|Exception|Traceback/.test(line)) return 'ERROR';
  if (/\bWARN\b/.test(line)) return 'WARN';
  return 'INFO';
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Build the search RegExp. Returns null if the input is empty, or if regex
// mode is on and the pattern doesn't compile. No `g` flag — the global state
// would force every consumer to reset lastIndex. Build a fresh `g` regex
// locally in highlightMatches() instead.
export function buildSearchRegex(query, useRegex) {
  if (!query) return null;
  try {
    return new RegExp(useRegex ? query : escapeRegex(query), 'i');
  } catch {
    return null;
  }
}
