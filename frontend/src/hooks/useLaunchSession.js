import { useState, useRef, useEffect } from 'react';

const STAGE_LABEL = {
  'assets':      'Downloading game assets',
  'assets-copy': 'Copying assets',
  'natives':     'Extracting native libraries',
  'classes':     'Downloading libraries',
  'classes-maven-custom': 'Downloading libraries',
  'classes-custom': 'Downloading libraries',
};
const labelForStage = (t) => !t ? 'Downloading…' : (STAGE_LABEL[t] || `Downloading ${t.replace(/-/g, ' ')}`);

// Each launch stage gets its own slice of the 0-99% band so the bar advances
// visibly across stages. Assets is the long pole — a fresh install pulls 3-5k
// files — so it owns the bulk of the bar (5-95%). Library / class downloads
// are quick and bursty, so they share a thin 2-5% strip up front. Bands are
// monotonically increasing — combined with Math.max on the setter, the bar
// never goes backward even if mclc fires events out of order.
const STAGE_BANDS = {
  'classes':              [2, 3],
  'classes-maven-custom': [3, 4],
  'classes-custom':       [4, 5],
  'assets':               [5, 95],
  'assets-copy':          [95, 97],
  'natives':              [97, 99],
};
const DEFAULT_BAND = [5, 99];

// Manages a single launch attempt's UI state. Returns the phase/progress/status
// plus a `launch(body)` function that POSTs to /api/launcher/launch and
// subscribes to its progress events. Used by both the global Launcher tab and
// the per-server Play button.
export function useLaunchSession({ socket, settings, onProfilesChanged, onError }) {
  const [phase, setPhase] = useState('idle'); // idle | running | launched | cancelling | error
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [fileCount, setFileCount] = useState({ current: 0, total: 0 });
  // The instance this launch targets (when one was supplied). Lifted here with
  // the rest of the session so the Instances tab can paint progress on the
  // right card even after it unmounts/remounts on a tab switch — local card
  // state would otherwise forget which instance is running.
  const [instanceId, setInstanceId] = useState(null);
  // In-app launch console. `logs` is the raw stdout/stderr stream from the game
  // JVM (capped); `consoleOpen` drives the LaunchConsole modal and is toggled
  // automatically per the user's console settings (show-on-launch / -crash,
  // hide-on-exit). Logs survive `reset()` so a crash log stays readable after
  // the process exits — they're only cleared when the next launch starts.
  const [logs, setLogs] = useState([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const stageRef = useRef('');
  const handlerRef = useRef(null);
  const launchIdRef = useRef(null);
  const resetTimerRef = useRef(null);
  // Set when the user hits Stop before POST /launch has returned a launchId
  // (the backend does network prep — e.g. the Ely.by skins jar download —
  // before responding, so this window can last seconds). launch() fires the
  // DELETE as soon as the id arrives.
  const cancelRequestedRef = useRef(false);
  // Tracks whether *this launch* hid the window to tray — set on 'launched'
  // when the "After launching: hide" setting fires, cleared on close. We only
  // auto-show when we hid; otherwise we'd surprise users who minimised manually.
  const hidToTrayRef = useRef(false);
  // Set once the game actually launched, so the "Quit when the game closes"
  // setting only fires for a real game exit (not a cancelled download).
  const gameLaunchedRef = useRef(false);

  useEffect(() => () => {
    clearTimeout(resetTimerRef.current);
    if (handlerRef.current && launchIdRef.current && socket) {
      socket.off(`launcher_${launchIdRef.current}`, handlerRef.current);
    }
  }, [socket]);

  const reset = () => {
    setPhase('idle'); setProgress(0); setStatusText('');
    setFileCount({ current: 0, total: 0 });
    setInstanceId(null);
    if (handlerRef.current && launchIdRef.current && socket) {
      socket.off(`launcher_${launchIdRef.current}`, handlerRef.current);
    }
    handlerRef.current = null;
    launchIdRef.current = null;
  };

  // Stop an active download or kill the running game. Since the launch now
  // runs in a forked worker subprocess, the backend can SIGKILL it — mclc's
  // in-flight HTTP download is severed at the TCP layer and cancellation is
  // effectively instant (the parent gives the worker 2.5s to clean-kill any
  // sub-children like a NeoForge installer or the JVM, then escalates).
  const cancel = () => {
    const launchId = launchIdRef.current;
    setPhase('cancelling');
    setStatusText('Stopping…');
    if (!launchId) {
      // No launchId yet — the POST is still in flight. Just resetting here
      // would flip the UI to idle while the download carries on invisibly
      // until it finished and flipped the version to "Installed". Queue the
      // cancel instead; launch() sends the DELETE once the id arrives.
      cancelRequestedRef.current = true;
    } else {
      fetch(`http://localhost:3001/api/launcher/launch/${launchId}`, { method: 'DELETE' })
        .catch(() => {});
    }
    // Safety net in case the backend goes away without ever emitting close
    // (e.g. parent process crash). 10s is plenty — the normal path is well
    // under 3s end-to-end.
    clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(reset, 10000);
  };

  // `body` is forwarded as-is to /api/launcher/launch — supports
  //   { version, loader, instanceId?, syncFromServerId? }  (standalone)
  //   { joinServerId }                                      (per-server Play)
  const launch = async (body) => {
    if (phase !== 'idle') return;
    cancelRequestedRef.current = false;
    stageRef.current = '';
    setPhase('running');
    setProgress(2);
    setStatusText('Preparing…');
    setFileCount({ current: 0, total: 0 });
    setInstanceId(body?.instanceId ?? null);
    setLogs([]);
    setConsoleOpen(false);

    try {
      const r = await fetch('http://localhost:3001/api/launcher/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Launch failed');
      const launchId = d.launchId;
      launchIdRef.current = launchId;

      const handler = (payload) => {
        const { event } = payload;
        if (event === 'log') {
          // Append raw game output; cap at the last 4000 chunks so a long
          // session can't grow the buffer without bound.
          const line = payload.message;
          if (line != null) {
            setLogs(prev => {
              const next = prev.length >= 4000 ? prev.slice(prev.length - 3999) : prev.slice();
              next.push(String(line));
              return next;
            });
          }
        } else if (event === 'status') {
          setStatusText(payload.message || '');
        } else if (event === 'mod_sync') {
          setStatusText(`Syncing mods · ${payload.name}`);
        } else if (event === 'progress') {
          const total = payload.total || 0;
          const task = payload.task || 0;
          if (total > 0) {
            // Map this stage's file-completion to its band, so each stage
            // (libraries → assets → natives) shows real movement instead of
            // libraries finishing at 99% and leaving assets nowhere to climb.
            const [lo, hi] = STAGE_BANDS[payload.type] || DEFAULT_BAND;
            const pct = lo + Math.round((task / total) * (hi - lo));
            setProgress(p => Math.max(p, Math.min(99, pct)));
            setFileCount({ current: task, total });
          }
          if (payload.type && payload.type !== stageRef.current) {
            stageRef.current = payload.type;
            setStatusText(labelForStage(payload.type));
          }
        } else if (event === 'launched') {
          setProgress(100);
          setPhase('launched');
          setStatusText('Game running');
          gameLaunchedRef.current = true;
          if (settings?.consoleShowOnLaunch) setConsoleOpen(true);
          onProfilesChanged?.();
          if (settings?.afterLaunch === 'hide' && window.electronAPI?.windowControls) {
            // Prefer hideToTray when available (newer preload); fall back to
            // minimize for older builds that haven't reloaded the preload yet.
            const controls = window.electronAPI.windowControls;
            const hide = controls.hideToTray || controls.minimize;
            if (hide) {
              hidToTrayRef.current = true;
              setTimeout(() => hide(), 1500);
            }
          }
        } else if (event === 'error') {
          setPhase('error');
          setStatusText(payload.message || 'Launch failed.');
          if (settings?.consoleShowOnCrash) setConsoleOpen(true);
          onError?.(payload.message || 'Launch failed');
          clearTimeout(resetTimerRef.current);
          resetTimerRef.current = setTimeout(reset, 4000);
        } else if (event === 'close') {
          // Game (or cancelled launch) exited. If the user opted to quit
          // MineDash when the game closes, do that instead of restoring the
          // window — but only for a real game exit (not a cancelled download).
          const realExit = gameLaunchedRef.current && payload.code !== 'cancelled';
          if (realExit && settings?.quitOnGameClose && window.electronAPI?.quitApp) {
            try { window.electronAPI.quitApp(); } catch {}
            gameLaunchedRef.current = false;
            hidToTrayRef.current = false;
            reset();
            return;
          }
          // Console auto-behaviour: a non-zero exit after a real launch is a
          // crash → surface the log if show-on-crash is on; an clean exit hides
          // the console if hide-on-exit is on. Cancelled stops touch neither.
          if (realExit) {
            const crashed = typeof payload.code === 'number' && payload.code !== 0;
            if (crashed && settings?.consoleShowOnCrash) setConsoleOpen(true);
            else if (settings?.consoleHideOnExit) setConsoleOpen(false);
          }
          // Otherwise bring MineDash back into view if we hid it. Skip on
          // `code === 'cancelled'` so the user sees their already-visible
          // MineDash window stay put after they hit Stop.
          if (hidToTrayRef.current && payload.code !== 'cancelled') {
            const show = window.electronAPI?.windowControls?.showFromTray;
            if (show) try { show(); } catch {}
          }
          gameLaunchedRef.current = false;
          hidToTrayRef.current = false;
          reset();
        }
      };
      handlerRef.current = handler;
      socket.on(`launcher_${launchId}`, handler);

      // The user hit Stop while the POST was still in flight — fire the
      // queued cancel now that we know which launch to kill. The handler is
      // already subscribed, so the backend's `close { code: 'cancelled' }`
      // resets the UI through the normal path.
      if (cancelRequestedRef.current) {
        cancelRequestedRef.current = false;
        fetch(`http://localhost:3001/api/launcher/launch/${launchId}`, { method: 'DELETE' })
          .catch(() => {});
      }
    } catch (err) {
      cancelRequestedRef.current = false;
      onError?.(err.message);
      setPhase('idle');
      setProgress(0);
      setStatusText('');
    }
  };

  return {
    phase, progress, statusText, fileCount, instanceId, launch, cancel,
    logs, consoleOpen,
    openConsole: () => setConsoleOpen(true),
    closeConsole: () => setConsoleOpen(false),
  };
}
