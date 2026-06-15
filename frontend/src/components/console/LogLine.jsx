// Per-line log rendering: pick a colour class, optionally wrap matches in
// <mark>, and let ConsoleViewer attach a ref so the active match can be
// scrolled into view.
import { memo } from 'react';

function colorClassForLog(log) {
  if (log.includes('[MineDash]') || log.includes('[Auto-Restart]') || log.includes('[Console]')) return 'text-[#00AF5C]';
  if (log.includes('ERROR') || log.includes('Exception') || log.includes('FATAL') || log.includes('Traceback')) return 'text-[#FF5555]';
  if (log.includes('WARN')) return 'text-amber-400';
  if (/joined the game/.test(log)) return 'text-cyan-400';
  if (/left the game/.test(log)) return 'text-orange-400';
  if (/<[a-zA-Z0-9_]+>/.test(log)) return 'text-violet-400';
  if (/Server process exited/.test(log)) return 'text-[#FF5555] font-bold';
  if (/Done \(/.test(log)) return 'text-[#00AF5C] font-bold';
  if (log.includes('INFO')) return 'text-[#CCCCCC]';
  return 'text-[#A0A0A0]';
}

// Split a line on the search regex and wrap every match in a highlight span.
// Takes a non-global regex (see buildSearchRegex) and constructs a fresh
// global version locally — keeps the input regex pristine so callers can
// share it without lastIndex side-effects.
function highlightMatches(line, regex) {
  const g = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  const out = [];
  let last = 0;
  let m;
  let k = 0;
  while ((m = g.exec(line)) !== null) {
    if (m.index > last) out.push(line.slice(last, m.index));
    out.push(
      <mark key={k++} className="bg-amber-400/40 text-[#FFFFFF] rounded-sm px-0.5">
        {m[0]}
      </mark>
    );
    last = m.index + m[0].length;
    if (m[0].length === 0) g.lastIndex += 1;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

// Single rendered line. ConsoleViewer wires the `setRef` callback so it can
// scroll the current match into view when the user clicks prev/next.
// Memoized — while the log buffer is still filling, appended lines leave
// existing lines' props untouched, so they skip re-rendering entirely.
export const LogLine = memo(function LogLine({ log, originalIdx, isMatch, isCurrent, searchRegex, setRef }) {
  const colorClass = colorClassForLog(log);
  return (
    <div
      ref={(el) => setRef(originalIdx, el, isMatch)}
      className={`break-words whitespace-pre-wrap leading-relaxed ${
        isCurrent ? 'bg-[#00AF5C]/10 rounded px-1 -mx-1 ring-1 ring-[#00AF5C]/30' : ''
      }`}
    >
      <span className={colorClass}>
        {searchRegex ? highlightMatches(log, searchRegex) : log}
      </span>
    </div>
  );
});
