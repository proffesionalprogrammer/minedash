import { useState, useRef, useEffect, useCallback } from 'react';

// App-level tracker for modpack-install sessions. Each install gets a stable
// `key` (caller-chosen — e.g. `server:abc:projectId` for the server-side
// browser, `instance:xyz:projectId` for the launcher's content browser) and
// the hook stores progress under that key. Because the hook lives in App and
// the socket listener is attached here, the install keeps running and the
// progress keeps updating even when the user navigates away from the tab —
// when they come back, the component reads the latest state from `installs`
// and rehydrates its progress bar immediately.
//
// Auto-clears entries shortly after completion so a finished install doesn't
// linger in the UI as a "stuck at 100%" state forever.
export function useModpackInstalls(socket) {
  const [installs, setInstalls] = useState({});
  // sessionId -> { key, handler }. We need the mapping to detach the listener
  // and to dedupe a `trackInstall` call for a session we're already tracking
  // (e.g. a component remounting and re-firing the same install accidentally).
  const handlersRef = useRef({});

  const trackInstall = useCallback((sessionId, key, meta = {}) => {
    if (!socket || !sessionId || !key) return;
    // Idempotent — if we're already tracking this session, leave it alone.
    if (handlersRef.current[sessionId]) return;

    setInstalls(prev => ({
      ...prev,
      [key]: { task: 0, total: 0, statusText: 'Starting…', status: 'running', sessionId, ...meta },
    }));

    const channel = `modpack_install_${sessionId}`;
    const handler = (payload) => {
      if (payload.event === 'status') {
        setInstalls(prev => {
          if (!prev[key]) return prev;
          return { ...prev, [key]: { ...prev[key], statusText: payload.message } };
        });
      } else if (payload.event === 'progress') {
        setInstalls(prev => {
          if (!prev[key]) return prev;
          return { ...prev, [key]: { ...prev[key], task: payload.task, total: payload.total } };
        });
      } else if (payload.event === 'done' || payload.event === 'error' || payload.event === 'cancelled') {
        socket.off(channel, handler);
        delete handlersRef.current[sessionId];
        const isError = payload.event === 'error';
        const isCancelled = payload.event === 'cancelled';
        const status = isError ? 'error' : isCancelled ? 'cancelled' : 'done';
        setInstalls(prev => {
          if (!prev[key]) return prev;
          return {
            ...prev,
            [key]: {
              ...prev[key],
              status,
              task: prev[key].total || prev[key].task,
              errorMessage: isError ? payload.message : undefined,
              summary: isError ? undefined : payload,
            },
          };
        });
        // Brief hold so callers can react to the terminal state, then clear.
        // Error stays longest (user reads it); cancel clears fast since the user
        // already knows they stopped it.
        const holdMs = isError ? 4500 : isCancelled ? 600 : 1200;
        setTimeout(() => {
          setInstalls(prev => {
            if (!prev[key]) return prev;
            const n = { ...prev };
            delete n[key];
            return n;
          });
        }, holdMs);
      }
    };
    handlersRef.current[sessionId] = { key, handler };
    socket.on(channel, handler);
  }, [socket]);

  // Cancel an in-flight install by its tracking key. Looks up the sessionId we
  // stashed when tracking started and asks the backend to stop it; the actual
  // teardown of the entry happens when the resulting `cancelled` socket event
  // arrives (above). Optimistically flips the entry to `cancelling` so the
  // button can show progress immediately. No-op if the entry already finished.
  const cancelInstall = useCallback((key) => {
    let sessionId;
    setInstalls(prev => {
      const entry = prev[key];
      if (!entry || !entry.sessionId) return prev;
      sessionId = entry.sessionId;
      if (entry.status === 'cancelling') return prev;
      return { ...prev, [key]: { ...entry, status: 'cancelling' } };
    });
    if (!sessionId) return;
    fetch(`http://localhost:3001/api/launcher/modpack-install/${sessionId}`, { method: 'DELETE' })
      .catch(() => { /* the cancelled/terminal event still clears the entry */ });
  }, []);

  // On unmount (or socket swap), drop every listener so we don't leak.
  useEffect(() => () => {
    if (!socket) return;
    for (const sid of Object.keys(handlersRef.current)) {
      socket.off(`modpack_install_${sid}`, handlersRef.current[sid].handler);
    }
    handlersRef.current = {};
  }, [socket]);

  return { installs, trackInstall, cancelInstall };
}
