import React, { useState, useEffect, useRef } from 'react';
import { Loader2, Check, AlertCircle, X, Package, Play } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import ModalPortal from './ModalPortal';
import { TITLEBAR_OFFSET } from '../lib/titlebar';

export default function LaunchProgress({ socket, launchId, onClose }) {
  const [status, setStatus] = useState('Preparing…');
  const [mods, setMods] = useState({});      // name -> { status, version, reason }
  const [errorMsg, setErrorMsg] = useState(null);
  const [launched, setLaunched] = useState(false);
  const [closed, setClosed] = useState(null); // { code }
  const modListRef = useRef(null);

  useEffect(() => {
    if (!socket || !launchId) return;
    const handler = (payload) => {
      const { event } = payload;
      if (event === 'status') setStatus(payload.message);
      else if (event === 'mod_sync') {
        setMods(prev => ({ ...prev, [payload.name]: { status: payload.status, version: payload.version } }));
      } else if (event === 'mod_skip') {
        setMods(prev => ({ ...prev, [payload.name]: { status: 'skipped', reason: payload.reason } }));
      } else if (event === 'error') {
        setErrorMsg(payload.message || 'Launch failed.');
      } else if (event === 'launched') {
        setLaunched(true);
        setStatus('Minecraft launched.');
      } else if (event === 'close') {
        setClosed({ code: payload.code });
      }
    };
    socket.on(`launcher_${launchId}`, handler);
    return () => socket.off(`launcher_${launchId}`, handler);
  }, [socket, launchId]);

  // Auto-scroll mod list to bottom as items arrive
  useEffect(() => {
    if (modListRef.current) modListRef.current.scrollTop = modListRef.current.scrollHeight;
  }, [mods]);

  const modEntries = Object.entries(mods);

  const dismissable = errorMsg || launched || closed;

  return (
    <ModalPortal>
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-x-0 bottom-0 bg-[#000000]/80 backdrop-blur-sm z-[100] flex items-center justify-center"
      style={{ top: TITLEBAR_OFFSET }}
      onClick={() => dismissable && onClose?.()}>
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
        transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
        className="bg-[#1A1A1A] border border-[#2D2D2D] rounded-3xl w-full max-w-lg shadow-2xl mx-4 max-h-[80vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#2D2D2D]">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`p-2 rounded-xl ${errorMsg ? 'bg-[#FF5555]/10' : launched ? 'bg-[#00AF5C]/10' : 'bg-[#2D2D2D]'}`}>
              {errorMsg ? <AlertCircle size={18} className="text-[#FF5555]" />
                : launched ? <Check size={18} className="text-[#00AF5C]" />
                : <Loader2 size={18} className="text-[#A0A0A0] animate-spin" />}
            </div>
            <div className="min-w-0">
              <h3 className="text-lg font-bold text-[#FFFFFF] truncate">
                {errorMsg ? 'Launch failed' : launched ? 'Launched' : 'Launching Minecraft'}
              </h3>
              <p className="text-xs text-[#A0A0A0] truncate">{errorMsg || status}</p>
            </div>
          </div>
          {dismissable && (
            <button onClick={onClose}
              className="p-2 text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#2D2D2D] rounded-xl transition-all">
              <X size={18} />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar p-4" ref={modListRef}>
          {modEntries.length === 0 ? (
            <div className="flex flex-col items-center py-12 text-[#555555]">
              {errorMsg ? <AlertCircle size={32} className="mb-3 opacity-50 text-[#FF5555]" />
                : launched ? <Check size={32} className="mb-3 opacity-50 text-[#00AF5C]" />
                : <Loader2 size={32} className="mb-3 animate-spin opacity-50" />}
              <p className="text-sm">{errorMsg || (launched ? 'Game launched.' : status)}</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {modEntries.map(([name, m]) => (
                <div key={name}
                  className="flex items-center gap-3 px-3 py-2 bg-[#1E1E1E] border border-[#2D2D2D] rounded-xl">
                  <div className="flex-shrink-0">
                    {m.status === 'done' || m.status === 'cached' ? <Check size={14} className="text-[#00AF5C]" />
                      : m.status === 'skipped' ? <AlertCircle size={14} className="text-amber-400" />
                      : <Loader2 size={14} className="animate-spin text-[#A0A0A0]" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-[#FFFFFF] truncate">{name}</p>
                    {m.version && <p className="text-[10px] text-[#555555]">v{m.version} · {m.status}</p>}
                    {m.reason && <p className="text-[10px] text-amber-400/80">Skipped: {m.reason}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {launched && !closed && (
          <div className="px-6 py-3 border-t border-[#2D2D2D] flex items-center gap-2 text-xs text-[#A0A0A0]">
            <Play size={12} className="text-[#00AF5C]" fill="currentColor" />
            <span>Minecraft is running in a separate process. You can close this window.</span>
          </div>
        )}
        {closed && (
          <div className="px-6 py-3 border-t border-[#2D2D2D] text-xs text-[#A0A0A0]">
            Game process exited (code {closed.code}).
          </div>
        )}
      </motion.div>
    </motion.div>
    </ModalPortal>
  );
}
