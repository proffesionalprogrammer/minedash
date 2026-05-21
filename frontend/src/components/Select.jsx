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
        className={`flex items-center justify-between gap-2 bg-[#1E1E1E] hover:border-[#555555] focus:border-[#00AF5C] border border-[#2D2D2D] rounded-xl ${padding} ${textSize} font-bold text-[#A0A0A0] outline-none transition-all cursor-pointer ${open ? 'border-[#00AF5C] ring-4 ring-[#00AF5C]/10' : ''}`}
      >
        <span className="truncate">{current?.label || value}</span>
        <ChevronDown size={14} className={`text-[#555555] transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="absolute right-0 mt-2 z-40 min-w-full bg-[#1A1A1A] border border-[#2D2D2D] rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.5)] overflow-hidden py-1"
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
                      : 'text-[#A0A0A0] hover:bg-[#1E1E1E] hover:text-[#FFFFFF]'
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
