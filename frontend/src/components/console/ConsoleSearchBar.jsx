import { Search, Regex, ChevronUp, ChevronDown, X } from 'lucide-react';

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
          { key: 'INFO',  label: 'INFO',  color: 'text-[#CCCCCC]', activeBg: 'bg-[#CCCCCC]/10' },
          { key: 'WARN',  label: 'WARN',  color: 'text-amber-400', activeBg: 'bg-amber-500/10' },
          { key: 'ERROR', label: 'ERROR', color: 'text-[#FF5555]', activeBg: 'bg-[#FF5555]/10' },
        ].map(chip => {
          const active = levelFilters.has(chip.key);
          const anyActive = levelFilters.size > 0;
          return (
            <button
              key={chip.key}
              onClick={() => onToggleLevel(chip.key)}
              title={`Show only ${chip.label} lines`}
              className={`text-[10px] font-bold px-2 py-1 rounded-md transition-colors ${
                active
                  ? `${chip.activeBg} ${chip.color}`
                  : anyActive
                    ? 'text-[#555555] hover:text-[#A0A0A0]'
                    : `${chip.color} opacity-60 hover:opacity-100`
              }`}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {/* Search input */}
      <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border ${
        searchInvalid
          ? 'border-[#FF5555]/40 bg-[#FF5555]/5'
          : searchQuery
            ? 'border-[#00AF5C]/40 bg-[#00AF5C]/5'
            : 'border-[#2D2D2D] bg-[#111111]'
      } transition-colors`}>
        <Search size={13} className={searchQuery ? 'text-[#00AF5C]' : 'text-[#555555]'} />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => { setSearchQuery(e.target.value); setCurrentMatchIdx(0); }}
          onKeyDown={onSearchKeyDown}
          placeholder="Find in logs…"
          className="bg-transparent outline-none text-xs font-mono text-[#FFFFFF] placeholder-[#555555] w-32 sm:w-40"
        />
        <button
          type="button"
          onClick={() => setUseRegex(v => !v)}
          title="Toggle regex"
          className={`p-0.5 rounded transition-colors ${
            useRegex ? 'text-[#00AF5C] bg-[#00AF5C]/10' : 'text-[#555555] hover:text-[#A0A0A0]'
          }`}
        >
          <Regex size={12} />
        </button>
        {searchQuery && (
          <>
            <span className="text-[10px] font-bold tabular-nums text-[#A0A0A0]">
              {matchCount === 0 ? '0/0' : `${currentMatchIdx + 1}/${matchCount}`}
            </span>
            <button
              type="button"
              onClick={() => onJump('prev')}
              disabled={matchCount === 0}
              title="Previous match (Shift+Enter)"
              className="p-0.5 text-[#A0A0A0] hover:text-[#FFFFFF] disabled:opacity-30"
            >
              <ChevronUp size={12} />
            </button>
            <button
              type="button"
              onClick={() => onJump('next')}
              disabled={matchCount === 0}
              title="Next match (Enter)"
              className="p-0.5 text-[#A0A0A0] hover:text-[#FFFFFF] disabled:opacity-30"
            >
              <ChevronDown size={12} />
            </button>
            <button
              type="button"
              onClick={onClear}
              title="Clear search (Esc)"
              className="p-0.5 text-[#555555] hover:text-[#FFFFFF]"
            >
              <X size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
