import { motion, AnimatePresence } from 'framer-motion';
import { Search, Regex, ChevronUp, ChevronDown, X } from 'lucide-react';
import Tooltip from '../Tooltip';

// Toolbar shown in the Live Console header — INFO/WARN/ERROR level chips,
// the find-in-logs input with regex toggle, and prev/next jump-to-match.
// All state is owned by ConsoleViewer (this is a controlled-component shell)
// so the same search state survives every level toggle without going through
// a reducer.
//
// Props:
//   • levelFilters       — Set<'INFO'|'WARN'|'ERROR'>; empty == show all
//   • onToggleLevel(lvl) — flip a level chip
//   • searchQuery / setSearchQuery
//   • useRegex   / setUseRegex
//   • searchInvalid      — true when regex mode is on and the pattern won't compile
//   • matchCount / currentMatchIdx
//   • onJump(direction)  — 'prev' | 'next'
//   • onClear            — reset query + regex
//   • onSearchKeyDown(e) — Enter (next), Shift+Enter (prev), Esc (clear)
export default function ConsoleSearchBar({
  levelFilters,
  onToggleLevel,
  searchQuery,
  setSearchQuery,
  useRegex,
  setUseRegex,
  searchInvalid,
  matchCount,
  currentMatchIdx,
  onJump,
  onClear,
  onSearchKeyDown,
  setCurrentMatchIdx,
}) {
  return (
    <div className="ml-auto flex items-center gap-2">
      {/* Level chips */}
      <div className="hidden sm:flex items-center gap-1">
        {[
          { key: 'INFO',  label: 'INFO',  color: 'text-[var(--c-log-text)]', activeBg: 'bg-[var(--c-log-text)]/10' },
          { key: 'WARN',  label: 'WARN',  color: 'text-amber-400', activeBg: 'bg-amber-500/10' },
          { key: 'ERROR', label: 'ERROR', color: 'text-[var(--c-danger)]', activeBg: 'bg-[var(--c-danger)]/10' },
        ].map(chip => {
          const active = levelFilters.has(chip.key);
          const anyActive = levelFilters.size > 0;
          return (
            <Tooltip key={chip.key} content={`Show only ${chip.label} lines`} side="bottom">
              <motion.button
                onClick={() => onToggleLevel(chip.key)}
                whileTap={{ scale: 0.9 }}
                className={`text-[10px] font-bold px-2 py-1 rounded-md transition-colors ${
                  active
                    ? `${chip.activeBg} ${chip.color}`
                    : anyActive
                      ? 'text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)]'
                      : `${chip.color} opacity-60 hover:opacity-100`
                }`}
              >
                {chip.label}
              </motion.button>
            </Tooltip>
          );
        })}
      </div>

      {/* Search input */}
      <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border ${
        searchInvalid
          ? 'border-[var(--c-danger)]/40 bg-[var(--c-danger)]/5'
          : searchQuery
            ? 'border-[#00AF5C]/40 bg-[#00AF5C]/5'
            : 'border-[var(--c-border)] bg-[var(--c-base)]'
      } transition-colors`}>
        <Search size={13} className={searchQuery ? 'text-[#00AF5C]' : 'text-[var(--c-text-muted)]'} />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => { setSearchQuery(e.target.value); setCurrentMatchIdx(0); }}
          onKeyDown={onSearchKeyDown}
          placeholder="Find in logs…"
          className="bg-transparent outline-none text-xs font-mono text-[var(--c-text-primary)] placeholder-[var(--c-text-muted)] w-32 sm:w-40"
        />
        <Tooltip content="Toggle regex" side="bottom">
          <button
            type="button"
            onClick={() => setUseRegex(v => !v)}
            className={`p-0.5 rounded transition-colors ${
              useRegex ? 'text-[#00AF5C] bg-[#00AF5C]/10' : 'text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)]'
            }`}
          >
            <Regex size={12} />
          </button>
        </Tooltip>
        <AnimatePresence initial={false}>
          {searchQuery && (
            <motion.div
              className="flex items-center gap-1.5 overflow-hidden"
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: 'auto' }}
              exit={{ opacity: 0, width: 0 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            >
              <motion.span
                key={`${currentMatchIdx}/${matchCount}`}
                initial={{ scale: 0.7, opacity: 0.4 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 600, damping: 30 }}
                className="text-[10px] font-bold tabular-nums text-[var(--c-text-secondary)] whitespace-nowrap"
              >
                {matchCount === 0 ? '0/0' : `${currentMatchIdx + 1}/${matchCount}`}
              </motion.span>
              <Tooltip content="Previous match (Shift+Enter)" side="bottom">
                <motion.button
                  type="button"
                  onClick={() => onJump('prev')}
                  disabled={matchCount === 0}
                  whileTap={{ scale: 0.85 }}
                  className="p-0.5 text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] disabled:opacity-30"
                >
                  <ChevronUp size={12} />
                </motion.button>
              </Tooltip>
              <Tooltip content="Next match (Enter)" side="bottom">
                <motion.button
                  type="button"
                  onClick={() => onJump('next')}
                  disabled={matchCount === 0}
                  whileTap={{ scale: 0.85 }}
                  className="p-0.5 text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] disabled:opacity-30"
                >
                  <ChevronDown size={12} />
                </motion.button>
              </Tooltip>
              <Tooltip content="Clear search (Esc)" side="bottom" align="end">
                <motion.button
                  type="button"
                  onClick={onClear}
                  whileHover={{ rotate: 90 }}
                  whileTap={{ scale: 0.85 }}
                  className="p-0.5 text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)]"
                >
                  <X size={12} />
                </motion.button>
              </Tooltip>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
