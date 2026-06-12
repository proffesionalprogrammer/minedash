import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// Brand-styled tooltip — replaces the native browser `title="..."` rendering,
// which paints a yellow-on-black bubble that clashes with the dark UI.
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
  const [open, setOpen] = useState(false);
  const timerRef = useRef(null);

  if (!content) return <>{children}</>;

  const show = () => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    clearTimeout(timerRef.current);
    setOpen(false);
  };

  const sideClass = side === 'top'
    ? 'bottom-full mb-2'
    : 'top-full mt-2';
  // Sentence-length hints wrap into a capped-width bubble instead of one huge line.
  const isLong = typeof content === 'string' && content.length > 42;
  const wrapClass = isLong ? 'whitespace-normal w-max max-w-[280px]' : 'whitespace-nowrap';
  const alignClass =
    align === 'start' ? 'left-0'
    : align === 'end' ? 'right-0'
    : 'left-1/2 -translate-x-1/2';

  return (
    <span
      className={`relative inline-flex ${className}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      <AnimatePresence>
        {open && (
          <motion.span
            role="tooltip"
            initial={{ opacity: 0, y: side === 'top' ? 4 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: side === 'top' ? 4 : -4 }}
            transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
            className={`pointer-events-none absolute z-50 ${sideClass} ${alignClass} ${wrapClass} px-2.5 py-1.5 bg-[#1A1A1A] border border-[#2D2D2D] text-[#FFFFFF] text-xs font-bold rounded-lg shadow-[0_8px_30px_rgba(0,0,0,0.5)]`}
          >
            {content}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
