import { motion, AnimatePresence } from 'framer-motion';
import { Play, X, Check, Loader2, AlertTriangle, Server } from 'lucide-react';

// Bottom-right toast for Browse-initiated installs. Used for both modpack
// installs (kind: 'modpack', phase: 'done') and server installs (kind:
// 'server', phase: 'downloading' | 'creating' | 'done' | 'error') — the
// server flow is in-flight tracking, so the toast persists across tab
// switches and morphs through phases. Stacks vertically when both kinds
// are visible at once.
//
// Accepts an array of toasts so multiple completions don't fight for the
// corner. Each toast renders independently with its own callbacks.
export default function BrowseInstallToast({ toasts = [], onPlay, onDismiss, onCancel, onGoToServers }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 items-end pointer-events-none">
      <AnimatePresence>
        {toasts.map(toast => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 16, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 380, damping: 28 }}
            className={`w-[360px] bg-[#1A1A1A] border rounded-2xl shadow-2xl shadow-black/60 overflow-hidden pointer-events-auto ${
              toast.phase === 'error' ? 'border-[#FF5555]/30' : 'border-[#00AF5C]/30'
            }`}
          >
            {renderToastBody(toast, { onPlay, onDismiss, onCancel, onGoToServers })}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function renderToastBody(toast, { onPlay, onDismiss, onCancel, onGoToServers }) {
  const phase = toast.phase || 'done';
  const isError = phase === 'error';
  const inFlight = phase === 'downloading' || phase === 'creating';

  const headerLabel = (() => {
    if (toast.kind === 'server') {
      if (phase === 'downloading') return 'Downloading modpack';
      if (phase === 'creating')    return 'Creating server';
      if (phase === 'done')        return 'Server created';
      if (phase === 'error')       return 'Server install failed';
    }
    if (phase === 'error') return 'Install failed';
    return 'Install complete';
  })();

  const HeaderIcon = (() => {
    if (isError) return AlertTriangle;
    if (inFlight) return Loader2;
    if (toast.kind === 'server') return Server;
    return Check;
  })();

  const accent = isError ? 'text-[#FF5555]' : 'text-[#00AF5C]';

  return (
    <>
      <div className="flex items-center gap-3 p-4">
        <div className="w-12 h-12 rounded-xl overflow-hidden bg-[#111111] border border-[#2D2D2D] flex-shrink-0 flex items-center justify-center">
          {toast.iconUrl
            ? <img src={toast.iconUrl} alt="" className="w-full h-full object-cover" />
            : <HeaderIcon size={20} className={`${accent} ${inFlight ? 'animate-spin' : ''}`} />}
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-xs font-bold uppercase tracking-wider ${accent}`}>{headerLabel}</p>
          <p className="text-sm font-bold text-[#FFFFFF] truncate">{toast.title}</p>
          {toast.kind === 'modpack' && phase === 'done' && (
            <p className="text-[10px] text-[#A0A0A0] truncate">{toast.loader} {toast.version}</p>
          )}
          {toast.kind === 'server' && inFlight && (
            <p className="text-[10px] text-[#A0A0A0] truncate">
              {phase === 'downloading' ? 'Pulling .mrpack from Modrinth…' : 'Extracting and creating server…'}
            </p>
          )}
          {isError && toast.error && (
            <p className="text-[10px] text-[#A0A0A0] truncate" title={toast.error}>{toast.error}</p>
          )}
        </div>
        <button
          onClick={() => (inFlight ? onCancel?.(toast.id) : onDismiss?.(toast.id))}
          className="p-1.5 rounded-lg text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#1E1E1E] transition-colors flex-shrink-0"
          aria-label={inFlight ? 'Cancel' : 'Dismiss'}
          title={inFlight ? 'Cancel install' : 'Dismiss'}
        >
          <X size={14} />
        </button>
      </div>

      {inFlight && (
        <div className="h-0.5 bg-[#2D2D2D] overflow-hidden">
          <motion.div
            className="h-full bg-[#00AF5C]"
            initial={{ x: '-100%' }}
            animate={{ x: '100%' }}
            transition={{ repeat: Infinity, duration: 1.4, ease: 'linear' }}
            style={{ width: '40%' }}
          />
        </div>
      )}

      {/* Cancel row — while a server install is still downloading/creating, give
          the user an explicit Stop so they don't have to wait out a big pack. */}
      {toast.kind === 'server' && inFlight && (
        <div className="flex border-t border-[#2D2D2D]">
          <motion.button
            onClick={() => onCancel?.(toast.id)}
            whileTap={{ scale: 0.97 }}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 text-[#A0A0A0] hover:text-[#FF5555] hover:bg-[#FF5555]/10 text-sm font-bold transition-colors"
          >
            <X size={14} />
            Cancel
          </motion.button>
        </div>
      )}

      {/* Action row — only when the install is in a terminal state and has a
          relevant follow-up (Play or Go to Servers). */}
      {toast.kind === 'modpack' && phase === 'done' && (
        <div className="flex border-t border-[#2D2D2D]">
          <motion.button
            onClick={() => onPlay?.(toast)}
            whileTap={{ scale: 0.97 }}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-[#00AF5C]/10 hover:bg-[#00AF5C]/20 text-[#00AF5C] text-sm font-bold transition-colors"
          >
            <Play size={14} />
            Play now
          </motion.button>
        </div>
      )}
      {toast.kind === 'server' && phase === 'done' && (
        <div className="flex border-t border-[#2D2D2D]">
          <motion.button
            onClick={() => onGoToServers?.(toast)}
            whileTap={{ scale: 0.97 }}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-[#00AF5C]/10 hover:bg-[#00AF5C]/20 text-[#00AF5C] text-sm font-bold transition-colors"
          >
            <Server size={14} />
            Open Servers
          </motion.button>
        </div>
      )}
    </>
  );
}

