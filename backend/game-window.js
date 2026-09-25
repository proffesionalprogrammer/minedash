// Holds the game back from opening its window for a moment on Windows — used
// so the crash auto-fix's relaunch shows Mahoraga's wheel first and the
// Minecraft window opens as the wheel finishes, instead of both at once.
//
// Minecraft logs "Backend library: LWJGL …" just before it creates its window,
// and GLFW only shows the window after the (slow) GL context is created. So
// when that line arrives, the JVM is suspended (NtSuspendProcess) for `holdMs`
// and then resumed; the window then opens normally, focus and all. Hiding the
// window after it appears instead flickers — it's always a frame late.
//
// A PowerShell helper is started as soon as the JVM spawns so its C# is
// compiled and waiting by the time the line shows up; it's told to pause over
// stdin and always resumes the game (try/finally). The script goes through a
// file in the temp dir because PowerShell can't read one from inside app.asar.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = String.raw`
param([int]$GamePid, [int]$HoldMs)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MineDashGamePause {
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);
}
"@
$h = [MineDashGamePause]::OpenProcess(0x0800, $false, $GamePid) # PROCESS_SUSPEND_RESUME
if ($h -eq [IntPtr]::Zero) { [Console]::Out.WriteLine('NOPROCESS'); exit }
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { exit }
  if ($line -eq 'PAUSE') { break }
}
if ([MineDashGamePause]::NtSuspendProcess($h) -ne 0) { [Console]::Out.WriteLine('FAILED'); exit }
try {
  [Console]::Out.WriteLine('PAUSED'); [Console]::Out.Flush()
  Start-Sleep -Milliseconds $HoldMs
} finally {
  [void][MineDashGamePause]::NtResumeProcess($h)
  [void][MineDashGamePause]::CloseHandle($h)
  [Console]::Out.WriteLine('RESUMED'); [Console]::Out.Flush()
}
`;

let scriptPath = null;
function ensureScript() {
  if (scriptPath && fs.existsSync(scriptPath)) return scriptPath;
  const p = path.join(os.tmpdir(), 'minedash-game-pause.ps1');
  fs.writeFileSync(p, SCRIPT, 'utf8');
  scriptPath = p;
  return p;
}

// Starts the helper for `pid` (Windows only; null elsewhere or on failure).
// Returns { pause(onPaused) → bool, stop() }:
//   pause() asks for the hold and calls onPaused() once the game is suspended;
//   it returns false when the helper isn't ready, so the caller can go ahead
//   without holding. stop() kills an idle helper — never one mid-hold, which
//   would leave the game suspended.
function prepareGamePause(pid, { holdMs, log } = {}) {
  if (process.platform !== 'win32' || !pid) return null;
  let child;
  try {
    child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', ensureScript(), '-GamePid', String(pid), '-HoldMs', String(holdMs),
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    log?.(`[game-pause] helper failed to start: ${err.message}\n`);
    return null;
  }
  let ready = false, requested = false, paused = false, running = true;
  let onPausedCb = null;
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === 'READY') ready = true;
      else if (line === 'PAUSED' && !paused) {
        paused = true;
        try { onPausedCb?.(); } catch { /* cosmetic */ }
      }
    }
  });
  child.stderr.on('data', (d) => log?.(`[game-pause] ${d}`));
  child.on('exit', () => { running = false; });
  child.on('error', (err) => { running = false; log?.(`[game-pause] ${err.message}\n`); });
  return {
    pause(onPaused) {
      if (!running || !ready || requested) return false;
      requested = true;
      onPausedCb = onPaused;
      try { child.stdin.write('PAUSE\n'); } catch { return false; }
      return true;
    },
    stop() {
      if (running && !requested) { try { child.kill(); } catch { /* gone */ } }
    },
  };
}

module.exports = { prepareGamePause };
