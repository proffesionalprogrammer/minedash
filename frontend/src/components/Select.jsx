import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// Brand-styled single-select replacing the native <select>, which paints
// its option list with the OS-default blue highlight regardless of CSS.
//
// Props:
//   value     — currently selected key
//   onChange  — (newValue) => void
//   options   — [{ value, label }] | [string]  (strings are treated as both)
//   size      — 'sm' | 'md' (default 'sm')
//   className — extra classes for the trigger button
export default function Select({ value, onChange, options, size = 'sm', className = '' }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const normalized = options.map(o => typeof o === 'string' ? { value: o, label: o } : o);
  const current = normalized.find(o => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const padding = size === 'sm' ? 'px-3 py-2' : 'px-3 py-2.5';
  const textSize = size === 'sm' ? 'text-xs' : 'text-sm';

  return (
    <div className={`relative ${className}`} ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={`flex items-center justify-between gap-2 bg-[var(--c-surface-2)] hover:border-[var(--c-text-muted)] focus:border-[#00AF5C] border border-[var(--c-border)] rounded-xl ${padding} ${textSize} font-bold text-[var(--c-text-secondary)] outline-none transition-all cursor-pointer ${open ? 'border-[#00AF5C] ring-4 ring-[#00AF5C]/10' : ''}`}
      >
        {/* Render the label of the matched option only. Falling back to the raw
            `value` would leak internal IDs (e.g. "fabric-1.20.1") into the UI
            during the one-frame gap between a parent prop change and the
            parent's state-settling effect. Empty is safer than wrong. */}
        <span className="truncate">{current?.label || ''}</span>
        <ChevronDown size={14} className={`text-[var(--c-text-muted)] transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="absolute right-0 mt-2 z-40 min-w-full bg-[var(--c-surface-1)] border border-[var(--c-border)] rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.5)] overflow-hidden py-1"
          >
            {normalized.map(opt => {
              const selected = opt.value === value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => { onChange(opt.value); setOpen(false); }}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 ${textSize} font-medium text-left transition-colors whitespace-nowrap ${
                    selected
                      ? 'bg-[#00AF5C]/15 text-[#00AF5C]'
                      : 'text-[var(--c-text-secondary)] hover:bg-[var(--c-surface-2)] hover:text-[var(--c-text-primary)]'
                  }`}
                >
                  <span>{opt.label}</span>
                  {selected && <Check size={12} className="text-[#00AF5C] flex-shrink-0" />}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
