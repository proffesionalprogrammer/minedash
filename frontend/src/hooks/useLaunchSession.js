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
  const [phase, setPhase] = useState('idle'); // idle | running | launched | error
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [fileCount, setFileCount] = useState({ current: 0, total: 0 });
  const stageRef = useRef('');
  const handlerRef = useRef(null);
  const launchIdRef = useRef(null);
  const resetTimerRef = useRef(null);

  useEffect(() => () => {
    clearTimeout(resetTimerRef.current);
    if (handlerRef.current && launchIdRef.current && socket) {
      socket.off(`launcher_${launchIdRef.current}`, handlerRef.current);
    }
  }, [socket]);

  const reset = () => {
    setPhase('idle'); setProgress(0); setStatusText('');
    setFileCount({ current: 0, total: 0 });
    if (handlerRef.current && launchIdRef.current && socket) {
      socket.off(`launcher_${launchIdRef.current}`, handlerRef.current);
    }
    handlerRef.current = null;
    launchIdRef.current = null;
  };

  // Stop an active download or kill the running game. Resets the UI immediately
  // (fire-and-forget to the backend so the button snaps back without waiting).
  const cancel = () => {
    const launchId = launchIdRef.current;
    reset(); // drop the listener and go back to idle right away
    if (launchId) {
      fetch(`http://localhost:3001/api/launcher/launch/${launchId}`, { method: 'DELETE' })
        .catch(() => {});
    }
  };

  // `body` is forwarded as-is to /api/launcher/launch — supports
  //   { version, loader, instanceId?, syncFromServerId? }  (standalone)
  //   { joinServerId }                                      (per-server Play)
  const launch = async (body) => {
    if (phase !== 'idle') return;
    stageRef.current = '';
    setPhase('running');
    setProgress(2);
    setStatusText('Preparing…');
    setFileCount({ current: 0, total: 0 });

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
        if (event === 'status') {
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
          onProfilesChanged?.();
          if (settings?.afterLaunch === 'hide' && window.electronAPI?.windowControls) {
            // Prefer hideToTray when available (newer preload); fall back to
            // minimize for older builds that haven't reloaded the preload yet.
            const controls = window.electronAPI.windowControls;
            const hide = controls.hideToTray || controls.minimize;
            if (hide) setTimeout(() => hide(), 1500);
          }
        } else if (event === 'error') {
          setPhase('error');
          setStatusText(payload.message || 'Launch failed.');
          onError?.(payload.message || 'Launch failed');
          clearTimeout(resetTimerRef.current);
          resetTimerRef.current = setTimeout(reset, 4000);
        } else if (event === 'close') {
          reset();
        }
      };
      handlerRef.current = handler;
      socket.on(`launcher_${launchId}`, handler);
    } catch (err) {
      onError?.(err.message);
      setPhase('idle');
      setProgress(0);
      setStatusText('');
    }
  };

  return { phase, progress, statusText, fileCount, launch, cancel };
}
