// Parse a single console line into an ActivityTimeline-friendly event,
// or null if the line isn't interesting. The MainPanel listens to every
// console line (regardless of active tab) so the Activity tab is always
// populated; this is the dispatch table that turns raw log strings into
// {type, message, time, player?} objects.
export function parseLogEvent(line) {
  const timeMatch = line.match(/\[(\d{2}:\d{2}:\d{2})\]/);
  const time = timeMatch ? timeMatch[1] : null;

  if (/joined the game/.test(line)) {
    const player = line.match(/:\s*(\S+)\s+joined/)?.[1];
    return { type: 'join', message: `${player || 'A player'} joined the game`, time, player };
  }
  if (/left the game/.test(line)) {
    const player = line.match(/:\s*(\S+)\s+left/)?.[1];
    return { type: 'leave', message: `${player || 'A player'} left the game`, time, player };
  }
  // Anchor to INFO lines so JVM descriptors (<init>/<clinit> in DEBUG/WARN/ERROR) are ignored.
  // .*? skips anything between the log level and <player>, handling vanilla, Forge module
  // prefixes, and the 1.19+ [Not Secure] prefix that breaks a tight ]: <player> match.
  const chatMatch = line.match(/INFO.*?<([a-zA-Z0-9_]{2,16})>\s+(.+)/);
  if (chatMatch) {
    return { type: 'chat', message: `${chatMatch[1]}: ${chatMatch[2]}`, time, player: chatMatch[1] };
  }
  // Console dashboard command (emitted by backend when sent via MineDash UI)
  if (/\[Console\] Ran command:/.test(line)) {
    const cmd = line.replace(/.*\[Console\] Ran command:\s*/, '').trim();
    return { type: 'command', message: `Console: ${cmd}`, time };
  }
  // Forge/1.19+ in-game player command — logged as [playerName: result] at end of line.
  // e.g. [minecraft/MinecraftServer]: [produke: Set the time to 13000]
  // The closing ] must be at the end so module names like [minecraft/Commands]: never match.
  const ingameCmdMatch = line.match(/\]:\s*\[([a-zA-Z0-9_]{2,16}):\s*(.+?)\]\s*$/);
  if (ingameCmdMatch) {
    return { type: 'command', message: `${ingameCmdMatch[1]}: ${ingameCmdMatch[2].trim()}`, time };
  }
  // Vanilla/older format fallback: playerName[x/y/z] issued server command: /cmd
  if (/issued server command:/.test(line)) {
    const match = line.match(/\]:\s*([a-zA-Z0-9_]{2,16})(?:\[[^\]]*\])?\s+issued server command:\s*(.+)/);
    if (match) return { type: 'command', message: `${match[1]}: ${match[2].trim()}`, time };
  }
  if (/Done \(/.test(line)) {
    const doneMatch = line.match(/Done \((.+?)\)/);
    return { type: 'started', message: `Server started${doneMatch ? ` in ${doneMatch[1]}` : ''}`, time };
  }
  // Only fire on the definitive backend exit log — "Stopping server" is Minecraft's own
  // pre-exit message and fires first, which would cause a duplicate stopped event.
  if (/Server process exited/.test(line)) {
    return { type: 'stopped', message: 'Server stopped', time };
  }
  if (/\[MineDash\]/.test(line)) {
    const msg = line.replace(/.*\[MineDash\]\s*/, '');
    return { type: 'system', message: msg, time };
  }
  if (/Auto-Restart/.test(line)) {
    return { type: 'restart', message: 'Server auto-restarting', time };
  }
  return null;
}

// Pull a number out of strings like "23%", "512 MB", "3.4 GB". Returns NaN if none.
export function num(val) {
  if (typeof val === 'number') return val;
  if (typeof val !== 'string') return NaN;
  const m = val.match(/(-?\d+(\.\d+)?)/);
  return m ? parseFloat(m[1]) : NaN;
}

// Convert "512 MB" / "3.4 GB" / "1.2 TB" to MB for trend comparison.
export function toMB(val) {
  if (typeof val !== 'string') return NaN;
  const n = num(val);
  if (isNaN(n)) return NaN;
  if (/TB/i.test(val)) return n * 1024 * 1024;
  if (/GB/i.test(val)) return n * 1024;
  if (/KB/i.test(val)) return n / 1024;
  return n; // assume MB
}

// Colour for a "XX%" usage value — green calm, amber elevated, red critical.
export function getUsageColor(percentStr) {
  const pct = parseFloat(percentStr);
  if (isNaN(pct)) return null;
  if (pct >= 80) return '#FF5555';
  if (pct >= 50) return '#F59E0B';
  return '#00AF5C';
}
