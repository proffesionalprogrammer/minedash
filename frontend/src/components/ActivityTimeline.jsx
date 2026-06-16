import React, { useState } from 'react';
import { UserPlus, UserMinus, MessageSquare, CheckCircle2, XCircle, RotateCcw, Clock, Terminal } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const EVENT_TYPES = {
  join:    { icon: UserPlus,     color: 'text-cyan-400',     bg: 'bg-cyan-400/10',     border: 'border-cyan-400/20',     label: 'Joined'  },
  leave:   { icon: UserMinus,    color: 'text-orange-400',   bg: 'bg-orange-400/10',   border: 'border-orange-400/20',   label: 'Left'    },
  chat:    { icon: MessageSquare,color: 'text-violet-400',   bg: 'bg-violet-400/10',   border: 'border-violet-400/20',   label: 'Chat'    },
  started: { icon: CheckCircle2, color: 'text-[#00AF5C]',    bg: 'bg-[#00AF5C]/10',    border: 'border-[#00AF5C]/20',    label: 'Started' },
  stopped: { icon: XCircle,      color: 'text-[var(--c-danger)]',    bg: 'bg-[var(--c-danger)]/10',    border: 'border-[var(--c-danger)]/20',    label: 'Stopped' },
  restart: { icon: RotateCcw,    color: 'text-amber-400',    bg: 'bg-amber-400/10',    border: 'border-amber-400/20',    label: 'Restart' },
  command: { icon: Terminal,      color: 'text-sky-400',      bg: 'bg-sky-400/10',      border: 'border-sky-400/20',      label: 'Command' },
  system:  { icon: Clock,        color: 'text-[var(--c-text-secondary)]',    bg: 'bg-[var(--c-text-secondary)]/10',    border: 'border-[var(--c-text-secondary)]/20',    label: 'System'  },
};

function ActivityTimeline({ events = [] }) {
  const [filter, setFilter] = useState('all');

  const filters = ['all', 'join', 'leave', 'chat', 'command', 'system'];
  const filteredEvents = filter === 'all' ? events : events.filter(e => e.type === filter);

  return (
    <div className="flex-1 bg-[var(--c-base)] rounded-2xl border border-[var(--c-border)] flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--c-border)] bg-[var(--c-surface-1)]">
        <div className="flex items-center gap-3">
          <Clock size={18} className="text-[var(--c-text-secondary)]" />
          <h3 className="font-bold text-[var(--c-text-primary)]">Activity Timeline</h3>
          <span className="text-xs font-bold bg-[var(--c-surface-2)] text-[var(--c-text-secondary)] px-2.5 py-1 rounded-full border border-[var(--c-border)]">
            {filteredEvents.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {filters.map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all duration-200 capitalize ${
                filter === f
                  ? 'bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/20'
                  : 'text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)] border border-transparent hover:border-[var(--c-border)]'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
        {filteredEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-[var(--c-text-muted)]">
            <Clock size={48} className="mb-4 opacity-30" />
            <p className="font-medium">No events yet</p>
            <p className="text-sm mt-1">Events will appear here as they happen</p>
          </div>
        ) : (
          <div className="relative">
            {/* Timeline line — sits behind icons, clipped so it doesn't extend past first/last icon center */}
            <div className="absolute left-[23px] top-5 bottom-5 w-[2px] bg-[var(--c-border)] rounded-full" />

            <div className="space-y-1">
              <AnimatePresence initial={false}>
                {[...filteredEvents].reverse().map((event) => {
                  const config = EVENT_TYPES[event.type] || EVENT_TYPES.system;
                  const Icon = config.icon;
                  return (
                    <motion.div
                      key={event.id}
                      initial={{ opacity: 0, x: -12 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 12 }}
                      transition={{ duration: 0.25 }}
                      className="flex items-start gap-4 relative pl-1"
                    >
                      {/* Outer ring matches panel background — covers the line so it doesn't bleed into the icon */}
                      <div className="w-10 h-10 rounded-xl bg-[var(--c-base)] flex items-center justify-center flex-shrink-0 z-10">
                        <div className={`w-8 h-8 rounded-xl ${config.bg} border ${config.border} flex items-center justify-center`}>
                          <Icon size={16} className={config.color} />
                        </div>
                      </div>
                      <div className="flex-1 py-2 min-w-0">
                        <p className="text-sm text-[var(--c-text-primary)] font-medium truncate">{event.message}</p>
                        {event.time && (
                          <p className="text-xs text-[var(--c-text-muted)] mt-0.5 tabular-nums">{event.time}</p>
                        )}
                      </div>
                      <span className={`text-xs font-bold px-2 py-1 rounded-lg flex-shrink-0 mt-2 ${config.bg} ${config.color} border ${config.border}`}>
                        {config.label}
                      </span>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ActivityTimeline;
