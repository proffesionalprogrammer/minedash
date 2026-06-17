import React, { useEffect, useRef, useState } from 'react';
import { SquareTerminal, X, Copy, Check, Loader2, AlertCircle, Play } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import ModalPortal from './ModalPortal';
import { TITLEBAR_OFFSET } from '../lib/titlebar';

// In-app launch console — the live stdout/stderr stream from the game JVM.
// Driven entirely by useLaunchSession (logs + consoleOpen); opens automatically
// per the user's Settings → Minecraft → Console toggles, and can be dismissed.
// This is MineDash's analogue of Prism's separate console window.
export default function LaunchConsole({ open, logs, status, phase, onClose }) {
  const scrollRef = useRef(null);
  const stickRef = useRef(true); // auto-scroll only while the user is at the bottom
  const [copied, setCopied] = useState(false);

  const text = (logs || []).join('');

  // Keep pinned to the newest output unless the user scrolled up to read back.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [text, open]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable — no-op */ }
  };

  const isError = phase === 'error';
  const isRunning = phase === 'running' || phase === 'launched';

  return (
    <ModalPortal>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-x-0 bottom-0 bg-[#000000]/80 backdrop-blur-sm z-[120] flex items-center justify-center"
            style={{ top: TITLEBAR_OFFSET }}
            onClick={onClose}
          >
            <motion.div
              initial={{ scale: 0.94, opacity: 0, y: 8 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.94, opacity: 0, y: 8 }}
              transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
              className="bg-[var(--c-surface-1)] border border-[var(--c-border)] rounded-3xl w-full max-w-3xl shadow-2xl mx-4 max-h-[82vh] flex flex-col overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-[var(--c-border)]">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`p-2 rounded-xl ${isError ? 'bg-[var(--c-danger)]/10' : 'bg-[#00AF5C]/10'}`}>
                    {isError
                      ? <AlertCircle size={16} className="text-[var(--c-danger)]" />
                      : <SquareTerminal size={16} className="text-[#00AF5C]" />}
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-[var(--c-text-primary)] leading-tight">Game console</h3>
                    <p className="text-[11px] text-[var(--c-text-secondary)] truncate flex items-center gap-1.5">
                      {isRunning && <Loader2 size={10} className="animate-spin flex-shrink-0" />}
                      {phase === 'launched' && <Play size={9} className="text-[#00AF5C] flex-shrink-0" fill="currentColor" />}
                      <span className="truncate">{status || (isRunning ? 'Launching…' : 'Output')}</span>
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={copy}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-border)] transition-colors"
                  >
                    {copied ? <Check size={13} className="text-[#00AF5C]" /> : <Copy size={13} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    onClick={onClose}
                    className="p-1.5 text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-border)] rounded-lg transition-colors"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              {/* Log stream */}
              <div
                ref={scrollRef}
                onScroll={onScroll}
                className="flex-1 overflow-y-auto custom-scrollbar bg-[var(--c-base)] px-4 py-3"
              >
                {text.trim().length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-[var(--c-text-muted)]">
                    <Loader2 size={26} className="animate-spin mb-3 opacity-60" />
                    <p className="text-xs font-bold">Waiting for game output…</p>
                  </div>
                ) : (
                  <pre className="text-[11.5px] leading-relaxed font-mono text-[var(--c-text-secondary)] whitespace-pre-wrap break-words selection:bg-[#00AF5C]/30">
                    {text}
                  </pre>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </ModalPortal>
  );
}
