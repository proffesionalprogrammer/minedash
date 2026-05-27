// Shared motion tokens so every animation in the app moves with the same
// rhythm. Snappy by default: short durations, ease-out entrances, and exits
// that run faster than entrances so the UI feels responsive, not floaty.

// Durations (seconds)
export const DUR = {
  fast: 0.15,   // micro-interactions (chips, icon swaps)
  base: 0.22,   // standard entrance (matches the top-level view transition)
  slow: 0.32,   // larger surfaces / modals
};

// Easing curves
export const EASE = {
  out: [0.22, 1, 0.36, 1],   // entrances — decelerate into place
  in: [0.4, 0, 1, 1],        // exits — accelerate away
  inOut: [0.4, 0, 0.2, 1],   // moves between two on-screen states
};

// Spring presets
export const springSnappy = { type: 'spring', stiffness: 500, damping: 32 };
export const springSoft = { type: 'spring', stiffness: 400, damping: 30 };

// ─── Reusable variants ────────────────────────────────────────────────────
export const fadeUp = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: DUR.base, ease: EASE.out } },
  exit: { opacity: 0, y: 6, transition: { duration: DUR.fast, ease: EASE.in } },
};

export const scaleIn = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1, transition: { duration: DUR.base, ease: EASE.out } },
  exit: { opacity: 0, scale: 0.97, transition: { duration: DUR.fast, ease: EASE.in } },
};

// Stagger a list/grid: spread <container variants={staggerContainer}> over
// children using <child variants={staggerItem}>.
export const staggerContainer = {
  animate: { transition: { staggerChildren: 0.04, delayChildren: 0.02 } },
};

export const staggerItem = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: springSoft },
};

// Modal building blocks — backdrop fades, panel scales from its center. Exit
// is quicker than enter so dismissing feels instant.
export const modalBackdrop = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: DUR.base } },
  exit: { opacity: 0, transition: { duration: DUR.fast } },
};

export const modalPanel = {
  initial: { opacity: 0, scale: 0.92, y: 8 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { type: 'spring', duration: DUR.slow, bounce: 0.18 } },
  exit: { opacity: 0, scale: 0.95, y: 4, transition: { duration: DUR.fast, ease: EASE.in } },
};
