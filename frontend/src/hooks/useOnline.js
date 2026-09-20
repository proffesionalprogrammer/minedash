import { useEffect, useState } from 'react';

// Is the machine actually able to reach Modrinth / Hangar / Mojang?
//
// `navigator.onLine` alone is not enough — it only reports whether a network
// interface is up, so a PC with wifi but no route to the internet still says
// "online" and every browse panel fills with "Failed to fetch". The backend
// probes the real hosts and pushes `network_status`; this hook merges the two:
// the browser event gives an instant signal, the backend gives the truth.
//
// Optimistic default (`true`) on purpose: a brief unknown at boot must not
// flash the whole UI into offline mode.
export default function useOnline(socket) {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const readStatus = (recheck) => {
      fetch(`http://localhost:3001/api/connectivity${recheck ? '?recheck=1' : ''}`)
        .then(r => r.json())
        .then(d => { if (!cancelled && typeof d.online === 'boolean') setOnline(d.online); })
        // The backend itself being unreachable is a different problem (the app
        // is broken, not offline) — leave the last known value alone.
        .catch(() => {});
    };

    readStatus(false);

    // The browser noticing the interface dropped is instant and trustworthy in
    // that direction, so act on it immediately. Coming back only means an
    // interface exists, so ask the backend to confirm with a real probe.
    const goOffline = () => setOnline(false);
    const goOnline = () => readStatus(true);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);

    const onStatus = (d) => { if (d && typeof d.online === 'boolean') setOnline(d.online); };
    socket?.on('network_status', onStatus);

    return () => {
      cancelled = true;
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
      socket?.off('network_status', onStatus);
    };
  }, [socket]);

  return online;
}
