import React, { useState, useEffect, useRef } from 'react';
import { User, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import AccountManager from './AccountManager';
import SkinHead from './SkinHead';

export default function AccountMenu({ accounts, activeAccountId, microsoftConfigured, onChanged, onError }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const active = accounts.find(a => a.id === activeAccountId);

  return (
    <div className="relative" ref={wrapperRef}>
      <motion.button
        onClick={() => setOpen(v => !v)}
        whileHover={{ scale: 1.03 }}
        whileTap={{ scale: 0.97 }}
        className={`flex items-center gap-2 pl-2 pr-3 py-2 rounded-2xl border transition-all duration-200 ${
          active
            ? 'bg-[#1E1E1E] border-[#2D2D2D] hover:border-[#555555]'
            : 'bg-[#00AF5C]/10 border-[#00AF5C]/30 hover:bg-[#00AF5C]/15'
        }`}
      >
        {active ? (
          <SkinHead username={active.username} uuid={active.uuid} type={active.type} size={28} rounded="rounded-lg" />
        ) : (
          <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 bg-[#00AF5C]/20 text-[#00AF5C]">
            <User size={14} />
          </div>
        )}
        <span className="text-sm font-bold text-[#FFFFFF] max-w-[120px] truncate">
          {active ? active.username : 'Sign in'}
        </span>
        <ChevronDown size={14} className={`text-[#A0A0A0] transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ type: 'spring', duration: 0.25, bounce: 0.15 }}
            className="absolute right-0 mt-2 w-[min(420px,calc(100vw-2rem))] z-50"
          >
            <AccountManager
              accounts={accounts}
              activeAccountId={activeAccountId}
              microsoftConfigured={microsoftConfigured}
              onChanged={onChanged}
              onError={onError}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
