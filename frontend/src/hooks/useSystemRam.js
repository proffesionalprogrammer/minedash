import { useState, useEffect } from 'react';

// Total physical RAM (in whole GB) on the user's machine, fetched once from the
// backend. The RAM sliders (server create/options + launcher settings) use this
// as their max so a user can allocate up to everything they actually have
// instead of bumping into a hardcoded cap.
//
// The fetched value is cached at module scope so the four sliders that use this
// hook don't each hit the endpoint, and so a freshly-mounted slider gets the
// known value synchronously on its first render.
let cachedGb = null;

export function useSystemRam(fallbackGb = 16) {
  const [totalGb, setTotalGb] = useState(cachedGb ?? fallbackGb);

  useEffect(() => {
    if (cachedGb !== null) return;
    let cancelled = false;
    fetch('http://localhost:3001/api/system/ram')
      .then((r) => r.json())
      .then((d) => {
        // Floor at 2 GB — keeps the slider usable (and the `/(max-1)` percent
        // math safe) on the rare machine that reports an absurdly small total.
        const gb = Math.max(2, Math.round(Number(d?.totalGb)));
        if (!cancelled && Number.isFinite(gb)) {
          cachedGb = gb;
          setTotalGb(gb);
        }
      })
      .catch(() => { /* keep the fallback on any failure */ });
    return () => { cancelled = true; };
  }, []);

  return totalGb;
}
