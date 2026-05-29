// MineDash launcher worker.
//
// Forked by backend/launcher.js's POST /api/launcher/launch handler. Runs the
// entire launch sequence (Microsoft token refresh, Fabric/Forge/NeoForge install,
// mclc asset/library downloads, JVM spawn, log buffering, dep-crash retry loop)
// in its own Node process so a SIGKILL on this PID terminates the in-flight
// download stream instantly.
//
// Why this exists at all: mclc has no abort API for its downloads. Calling
// `.abort()` on the underlying `request` instances crashes the parent (its
// internal pipe to fs.createWriteStream has no error listener and the unhandled
// error event takes down the whole Node process). Running launch out-of-process
// is the only safe way to interrupt mclc mid-download — when the parent kills
// this worker, the OS reaps mclc's HTTP connections cleanly and we're done.
//
// Protocol (IPC):
//   Parent → worker:
//     { type: 'init', payload: { launchId, DATA_DIR, INSTANCES_DIR,
//                                discoveredJava, launchArgs } }
//     { type: 'cancel' }
//
//   Worker → parent:
//     { kind: 'event', launchId, event, ...data }   — forwarded to socket
//     { kind: 'jvm_started', pid }                  — parent can SIGKILL the JVM
//     { kind: 'persist_account', accountsDoc }      — parent writes the refreshed
//                                                     MS token to accounts.json
//     { kind: 'persist_settings', settings }        — parent writes settings.json

// Prefer IPv4 for every outbound HTTP call in this worker process. The parent
// (backend/index.js) sets this globally, but `dns.setDefaultResultOrder` is
// process-local — forked workers don't inherit it. Without this, NeoForge's
// maven.neoforged.net fetches go to AAAA records that time out on residential
// networks, producing "failed to fetch" the moment the user clicks Play.
require('dns').setDefaultResultOrder('ipv4first');

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Diagnostic log file. Tee'd from the game's stdout/stderr + our own status
// lines so a launch can be inspected after the fact — the UI currently shows
// only high-level status, not raw output (notably the [authlib-injector] banner
// we need to confirm Ely.by skins loaded). Truncated at the start of each
// launch. Path is set in startLaunch once we know DATA_DIR.
let logFile = null;
function appendLogFile(s) {
  if (!logFile) return;
  try { fs.appendFileSync(logFile, s.endsWith('\n') ? s : s + '\n'); } catch {}
}

// Children we've spawned (NeoForge installer, the game JVM). Tracked so the
// `cancel` IPC handler can kill them before the worker exits — otherwise
// they'd be orphaned, and on Windows the JVM in particular would keep its
// window open after we're gone.
const trackedChildren = new Set();
let cancelled = false;

function killChild(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      // taskkill /F /T blows away the entire process tree rooted at the PID
      // (mclc spawns Java which on Windows may itself spawn helper procs).
      // Plain child.kill() on Windows only signals the top process and any
      // children become orphans with no parent to clean them up.
      exec(`taskkill /F /T /PID ${child.pid}`, () => {});
    } else {
      // Try graceful first; SIGKILL'd by the parent if we don't exit in time.
      try { child.kill('SIGTERM'); } catch {}
      // 1s later, hard kill if still alive.
      setTimeout(() => { try { if (!child.killed) child.kill('SIGKILL'); } catch {} }, 1000);
    }
  } catch {}
}

function doCancel() {
  if (cancelled) return;
  cancelled = true;
  for (const c of Array.from(trackedChildren)) killChild(c);
  trackedChildren.clear();
  // Give the kill commands a beat to land before we exit so the parent gets
  // a clean exit code instead of a SIGKILL. The parent has its own 2.5s
  // safety net if this drags.
  setTimeout(() => process.exit(0), 400);
}

// Emit helper — forwards events to the parent over IPC. Mirrors the shape
// the parent's _emit hook expects, so it can socket.io.emit() unchanged.
//
// We also use this to detect when the launch has reached a terminal state.
// `runLaunch` resolves the moment the JVM is *spawned*, not when it closes —
// so the worker can't just `await launcher.runLaunch(...)` and exit. Instead
// we exit when we forward the real `close` (or `error`) event up to the
// parent, which happens after mclc's close handler fires OR after a clean
// cancellation path runs. A short post-emit delay lets IPC flush.
let terminalScheduled = false;
function emit(launchId, event, data = {}) {
  if (process.send) {
    try { process.send({ kind: 'event', launchId, event, ...data }); } catch {}
  }
  // Tee anything human-readable into the diagnostic log file.
  if ((event === 'log' || event === 'status' || event === 'error') && data.message) {
    appendLogFile(event === 'log' ? data.message : `[${event}] ${data.message}`);
  }
  if ((event === 'close' || event === 'error') && !terminalScheduled) {
    terminalScheduled = true;
    setTimeout(() => process.exit(0), 200);
  }
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'cancel') {
    doCancel();
    return;
  }
  if (msg.type !== 'init') return;
  startLaunch(msg.payload).catch(err => {
    if (!process.send) return;
    try {
      process.send({
        kind: 'event',
        launchId: msg.payload?.launchArgs?.launchId,
        event: 'error',
        message: err.message || String(err),
      });
    } catch {}
    process.exit(1);
  });
});

// Unhandled errors in the worker should NOT take down the parent. Log to
// stderr (the parent pipes it into its console) and exit with a non-zero
// code so the parent's `worker.on('exit')` reports it to the UI.
process.on('uncaughtException', (err) => {
  console.error('[launcher-worker] uncaughtException:', err);
  process.exit(2);
});
process.on('unhandledRejection', (err) => {
  console.error('[launcher-worker] unhandledRejection:', err);
  process.exit(3);
});

async function startLaunch(payload) {
  const { launchId, DATA_DIR, INSTANCES_DIR, discoveredJava, launchArgs } = payload;

  // Open a fresh diagnostic log for this launch. Single rolling file (not
  // per-launchId) so it's trivial to find: <DATA_DIR>/launcher-last.log.
  try {
    logFile = path.join(DATA_DIR, 'launcher-last.log');
    const acct = launchArgs?.account || {};
    fs.writeFileSync(logFile,
      `=== MineDash launch ${new Date().toISOString()} ===\n` +
      `instance=${launchArgs?.instance?.id} loader=${launchArgs?.instance?.loader} version=${launchArgs?.instance?.version}\n` +
      `account type=${acct.type} username=${acct.username} elybySkins=${acct.elybySkins} elybyUuid=${acct.elybyUuid}\n` +
      `elybyLaunch=${launchArgs?.elybyLaunch ? `present (profileUuid=${launchArgs.elybyLaunch.profileUuid})` : 'null (agent will NOT be injected)'}\n\n`,
    );
  } catch { logFile = null; }

  // Load the launcher module inside the worker and init it with the
  // worker-mode hooks. Events go back to the parent via IPC, cancel is
  // driven by the `cancelled` local flag, and any subprocess we spawn
  // (NeoForge installer / JVM) is auto-tracked for cancel-kill.
  const launcher = require('./launcher');
  const depCrash = require('./dep-crash');
  launcher.init({
    DATA_DIR,
    INSTANCES_DIR,
    getJavaPath: () => discoveredJava || 'java',
    // syncServer is pre-resolved by the parent and passed in launchArgs, so
    // the worker never has to read servers.json. Returning [] keeps any
    // helper that calls getServers() defensively from crashing.
    getServers: async () => [],
    io: null,
    emit,
    isCancelled: () => cancelled,
    clearCancel: () => { cancelled = false; },
    trackChild: (c) => { if (c) trackedChildren.add(c); },
    untrackChild: (c) => { if (c) trackedChildren.delete(c); },
    // Re-share the dep-crash auto-installer plumbing so a failed launch with
    // missing client mods still triggers the same Modrinth install + retry
    // the in-process path used before the worker refactor.
    hasDependencyCrash: depCrash.hasDependencyCrash,
    parseMissingModIds: depCrash.parseMissingModIds,
  });

  // Hand off to the launcher's existing runLaunch. It returns when the JVM
  // *starts* (not when it exits), so don't exit the worker here — that would
  // kill the game! The actual exit happens inside emit() when we see the
  // terminal `close`/`error` event flow through. The catch below handles
  // pre-launch failures (token refresh / installer / etc.).
  try {
    await launcher.runLaunch(launchArgs);
  } catch (err) {
    emit(launchId, 'error', { message: err.message || String(err) });
  }
}
