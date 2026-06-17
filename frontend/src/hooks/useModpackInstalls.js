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
  // Live mirror of `installs` so cancelInstall can read the current sessionId
  // synchronously. We must NOT read it out of a setInstalls updater's side
  // effect — React only runs that updater eagerly when its queue is empty, and
  // during an active install the constant progress events keep the queue full,
  // so the updater (and the sessionId assignment) is deferred past the point
  // where we fire the DELETE. That made Stop a no-op (the button flipped to
  // "Stopping…" but no cancel request was ever sent).
  const installsRef = useRef(installs);
  installsRef.current = installs;

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
    // Read the sessionId from the live mirror — synchronous and queue-independent
    // (see installsRef above for why we can't read it inside the updater).
    const entry = installsRef.current[key];
    const sessionId = entry && entry.sessionId;
    if (!sessionId) return;
    // Optimistically flip the button to "Stopping…". This update can be deferred
    // by React; that's fine — the DELETE below has already fired by then.
    setInstalls(prev => {
      const e = prev[key];
      if (!e || e.status === 'cancelling') return prev;
      return { ...prev, [key]: { ...e, status: 'cancelling' } };
    });
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
