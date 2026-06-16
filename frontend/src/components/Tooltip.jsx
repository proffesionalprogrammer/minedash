import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';

// Brand-styled tooltip — replaces the native browser `title="..."` rendering,
// which paints a yellow-on-black bubble that clashes with the dark UI.
//
// The bubble is portal-rendered into #root (same reasoning as ModalPortal: it
// inherits the --app-scale transform) so it escapes overflow-hidden cards,
// scroll containers, and per-row stacking contexts — an in-place absolute
// bubble gets clipped by rounded cards and painted under sibling rows.
//
// Wrap the trigger:
//   <Tooltip content="Install client mods, launch Minecraft, …">
//     <button>…</button>
//   </Tooltip>
//
// Props:
//   content   — tooltip body (string or node). Falsy / empty → renders bare children.
//   side      — 'top' | 'bottom' (default 'top')
//   align     — 'start' | 'center' | 'end' (default 'center')
//   delay     — ms to wait before showing (default 250)
//   className — extra classes on the trigger wrapper
export default function Tooltip({ children, content, side = 'top', align = 'center', delay = 250, className = '' }) {
  // Viewport-anchored coords in #root's pre-scale space; null = hidden.
  const [pos, setPos] = useState(null);
  const timerRef = useRef(null);
  const anchorRef = useRef(null);

  // The bubble doesn't track its trigger after opening, so drop it the moment
  // anything scrolls or the window resizes rather than letting it drift.
  useEffect(() => {
    if (!pos) return;
    const drop = () => setPos(null);
    window.addEventListener('scroll', drop, true);
    window.addEventListener('resize', drop);
    return () => {
      window.removeEventListener('scroll', drop, true);
      window.removeEventListener('resize', drop);
    };
  }, [pos]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  if (!content) return <>{children}</>;

  const show = () => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // getBoundingClientRect returns post-scale visual coords; fixed-position
      // descendants of the transformed #root resolve in its pre-scale space.
      const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-scale')) || 1;
      setPos({
        x: (align === 'start' ? r.left : align === 'end' ? r.right : r.left + r.width / 2) / scale,
        y: (side === 'top' ? r.top - 8 : r.bottom + 8) / scale,
      });
    }, delay);
  };
  const hide = () => {
    clearTimeout(timerRef.current);
    setPos(null);
  };

  // Static anchor alignment on the inner span — the outer motion.span owns
  // `transform` for the enter/exit animation, so the two can't share one element.
  const anchorClass = [
    align === 'center' ? '-translate-x-1/2' : align === 'end' ? '-translate-x-full' : '',
    side === 'top' ? '-translate-y-full' : '',
  ].join(' ');
  // Sentence-length hints wrap into a capped-width bubble instead of one huge line.
  const isLong = typeof content === 'string' && content.length > 42;
  const wrapClass = isLong ? 'whitespace-normal w-max max-w-[280px]' : 'whitespace-nowrap';

  const portalTarget = typeof document !== 'undefined' ? (document.getElementById('root') || document.body) : null;

  return (
    <span
      ref={anchorRef}
      className={`relative inline-flex ${className}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {portalTarget && createPortal(
        <AnimatePresence>
          {pos && (
            <motion.span
              role="tooltip"
              initial={{ opacity: 0, y: side === 'top' ? 4 : -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: side === 'top' ? 4 : -4 }}
              transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
              className="pointer-events-none fixed z-[100] block"
              style={{ left: pos.x, top: pos.y }}
            >
              <span className={`block ${anchorClass} ${wrapClass} px-2.5 py-1.5 bg-[var(--c-surface-1)] border border-[var(--c-border)] text-[var(--c-text-primary)] text-xs font-bold rounded-lg shadow-[0_8px_30px_rgba(0,0,0,0.5)]`}>
                {content}
              </span>
            </motion.span>
          )}
        </AnimatePresence>,
        portalTarget
      )}
    </span>
  );
}
