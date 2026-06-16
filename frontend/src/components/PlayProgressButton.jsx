import React, { useState } from 'react';
import { Play, Check, AlertCircle, Loader2, Square } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// Big primary launch button that doubles as a horizontal progress bar.
// `phase` drives the visuals: idle | running | cancelling | launched | error.
//
// During `running`, hovering reveals a stop affordance — the fill turns red,
// a Square icon replaces the spinner, and the label reads "Stop download".
// Clicking while running calls `onClick` which PlaySection wires to `cancel`.
// During `cancelling` the button is locked while the backend tears down
// the in-flight downloads and emits the final close event.
export default function PlayProgressButton({
  phase = 'idle',
  progress = 0,
  statusText = '',
  fileCount = { current: 0, total: 0 },
  idleLabel = 'Play',
  disabled = false,
  onClick,
  size = 'lg',
  leading = null,   // optional node (e.g. a SkinHead) shown before the icon while idle
}) {
  const [stopHovered, setStopHovered] = useState(false);
  const idle       = phase === 'idle';
  const running    = phase === 'running';
  const cancelling = phase === 'cancelling';
  const showStop = running && stopHovered;

  const runningStatus = statusText || 'Starting…';
  // Only surface the counter once at least one file has been processed —
  // showing "(0 / N files)" at the very start of a stage is noisy and conveys
  // nothing the spinner doesn't already imply.
  const runningLabel = running && fileCount.total > 0 && fileCount.current > 0
    ? `${runningStatus} (${fileCount.current} / ${fileCount.total} files)`
    : runningStatus;

  const label =
    cancelling           ? (statusText || 'Cancelling…') :
    showStop             ? 'Stop download' :
    phase === 'launched' ? 'Game running' :
    phase === 'error'    ? (statusText || 'Failed') :
    running              ? runningLabel :
    idleLabel;

  const Icon =
    cancelling           ? Loader2 :
    showStop             ? Square :
    phase === 'launched' ? Check :
    phase === 'error'    ? AlertCircle :
    running              ? Loader2 :
    Play;

  const trackColor =
    phase === 'error'    ? '#7A2A2A' :
    phase === 'launched' ? '#00AF5C' :
    cancelling           ? '#1E1E1E' :
    '#1E1E1E';

  const sizing = size === 'sm'
    ? { padX: 'px-4', padY: 'py-2', text: 'text-sm', iconPx: 16 }
    : { padX: 'px-6', padY: 'py-4', text: 'text-lg', iconPx: 20 };

  return (
    <motion.button
      onClick={onClick}
      disabled={disabled || cancelling}
      onMouseEnter={() => running && setStopHovered(true)}
      onMouseLeave={() => setStopHovered(false)}
      whileHover={!disabled && idle ? { scale: 1.01 } : {}}
      whileTap={!disabled && (idle || running) ? { scale: 0.99 } : {}}
      className={`relative w-full overflow-hidden rounded-2xl border transition-colors duration-200 disabled:cursor-not-allowed ${
        idle
          ? 'bg-[#00AF5C] hover:bg-[#00964F] border-transparent text-white shadow-[0_4px_20px_rgba(0,175,92,0.25)] disabled:opacity-40'
          : phase === 'error'
            ? 'border-[var(--c-danger)]/40'
            : cancelling
              ? 'border-amber-500/40'
              : showStop
                ? 'border-[var(--c-danger)]/40 cursor-pointer'
                : 'border-[#00AF5C]/40'
      }`}
      style={!idle ? { background: trackColor } : undefined}
    >
      {/* Progress fill — turns red when hovering to stop, amber while cancelling */}
      {!idle && (
        <motion.div
          initial={false}
          animate={{ width: `${progress}%` }}
          transition={{ ease: [0.22, 1, 0.36, 1], duration: 0.5 }}
          className="absolute inset-y-0 left-0 z-0"
          style={{
            background: cancelling ? '#A06000' : (showStop ? '#CC3333' : (phase === 'error' ? '#FF5555' : '#00AF5C')),
            transition: 'background 0.25s ease',
          }}
        />
      )}

      {/* Danger vignette overlay on stop-hover */}
      <AnimatePresence>
        {showStop && (
          <motion.div
            key="stop-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 z-[5] bg-[var(--c-danger)]/10 pointer-events-none"
          />
        )}
      </AnimatePresence>

      <div className={`relative z-10 flex items-center justify-center gap-3 ${sizing.padX} ${sizing.padY}`}>
        {idle && leading}
        <Icon
          size={sizing.iconPx}
          className={(cancelling || (running && !showStop)) ? 'animate-spin' : ''}
          fill={idle ? 'currentColor' : 'none'}
        />
        <span className={`${sizing.text} font-bold tracking-tight text-white`}>{label}</span>
        {running && !showStop && progress > 0 && (
          <span className="tabular-nums text-sm font-bold text-white/80">{progress}%</span>
        )}
      </div>
    </motion.button>
  );
}
