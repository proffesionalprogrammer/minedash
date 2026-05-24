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
      } else if (payload.event === 'done' || payload.event === 'error') {
        socket.off(channel, handler);
        delete handlersRef.current[sessionId];
        const isError = payload.event === 'error';
        setInstalls(prev => {
          if (!prev[key]) return prev;
          return {
            ...prev,
            [key]: {
              ...prev[key],
              status: isError ? 'error' : 'done',
              task: prev[key].total || prev[key].task,
              errorMessage: isError ? payload.message : undefined,
              summary: isError ? undefined : payload,
            },
          };
        });
        // Brief hold so callers can react to the terminal state, then clear.
        // Error stays longer than success so the user has a chance to read it.
        setTimeout(() => {
          setInstalls(prev => {
            if (!prev[key]) return prev;
            const n = { ...prev };
            delete n[key];
            return n;
          });
        }, isError ? 4500 : 1200);
      }
    };
    handlersRef.current[sessionId] = { key, handler };
    socket.on(channel, handler);
  }, [socket]);

  // On unmount (or socket swap), drop every listener so we don't leak.
  useEffect(() => () => {
    if (!socket) return;
    for (const sid of Object.keys(handlersRef.current)) {
      socket.off(`modpack_install_${sid}`, handlersRef.current[sid].handler);
    }
    handlersRef.current = {};
  }, [socket]);

  return { installs, trackInstall };
}
