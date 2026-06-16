import { useState } from 'react';
import { motion } from 'framer-motion';
import { Zap, Copy, Check, X } from 'lucide-react';

// Persistent floating chip shown while a MineDash Connect (friend/join) tunnel
// is live. It lives at the app root — NOT inside JoinSessionModal — so the
// friend can close that window, go to the Launcher, and start the game while
// the tunnel stays up. Only Disconnect (here or in the modal) ends the session.
export default function ConnectIndicator({ localPort, onDisconnect }) {
  const [copied, setCopied] = useState(false);
  const address = `127.0.0.1:${localPort}`;

  const copy = () => {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      className="fixed bottom-6 left-6 z-40 flex items-center gap-3 px-4 py-3 bg-[var(--c-surface-1)] border border-[#00AF5C]/30 rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.5)]"
    >
      <div className="p-1.5 bg-[#00AF5C]/10 rounded-lg flex-shrink-0">
        <Zap size={16} className="text-[#00AF5C]" />
      </div>
      <div className="leading-tight">
        <p className="text-xs font-bold text-[var(--c-text-primary)]">Connected to friend</p>
        <button
          onClick={copy}
          className="flex items-center gap-1.5 font-mono text-xs text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] transition-colors"
          title="Copy address"
        >
          {address}
          {copied ? <Check size={11} className="text-[#00AF5C]" /> : <Copy size={11} />}
        </button>
      </div>
      <button
        onClick={onDisconnect}
        className="ml-1 px-2.5 py-1.5 bg-[var(--c-danger)]/10 hover:bg-[var(--c-danger)]/20 border border-[var(--c-danger)]/20 text-[var(--c-danger)] rounded-lg text-xs font-bold transition-all flex items-center gap-1 flex-shrink-0"
      >
        <X size={12} /> Disconnect
      </button>
    </motion.div>
  );
}
