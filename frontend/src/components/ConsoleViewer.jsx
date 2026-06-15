import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Terminal } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import CrashBanner from './console/CrashBanner';
import ConsoleSearchBar from './console/ConsoleSearchBar';
import { LogLine } from './console/LogLine';
import { detectLogLevel, buildSearchRegex } from './console/logFormat';
import { getSuggestions } from './console/mcCommands';

// Live console pane shown in the Overview tab.
//
// Responsibilities split between files:
//   • CrashBanner          — the dismissable red banner with the disable/fix CTAs.
//   • ConsoleSearchBar     — level chips + find-in-logs input + jump-to-match.
//   • LogLine              — per-line colour + match highlight rendering.
//   • mcCommands.js        — the vanilla command tree + autocomplete traversal.
//
// This file owns the socket subscription, the rolling 500-line buffer, the
// search/filter state, command history (Up/Down), and the recursive
// autocomplete dropdown.
function ConsoleViewer({ serverId, socket }) {
  const [logs, setLogs] = useState([]);
  const [command, setCommand] = useState('');
  const [sending, setSending] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [highlightedIdx, setHighlightedIdx] = useState(-1);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [commandHistory, setCommandHistory] = useState([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [crashBanner, setCrashBanner] = useState(null); // { type, message, tab, culprit?, culpritShort?, culpritJars? }

  // Search / filter
  const [searchQuery, setSearchQuery] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  // levelFilters: which levels to SHOW. Empty == show all.
  const [levelFilters, setLevelFilters] = useState(() => new Set());
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const bottomRef = useRef(null);
  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const suggestionsRef = useRef(null);
  const matchRefs = useRef(new Map()); // originalIdx -> DOM node, for the currently mounted matched lines

  useEffect(() => {
    setLogs([]);
    setCrashBanner(null);
    fetch(`http://localhost:3001/api/servers/${serverId}/logs`)
      .then(res => res.json())
      .then(history => { if (Array.isArray(history) && history.length > 0) setLogs(history); })
      .catch(err => console.error('Failed to fetch log history:', err));

    // Server startup floods hundreds of console chunks per second; rendering
    // a 500-line list per chunk locks up the UI. Buffer incoming lines and
    // flush at most ~12 times a second.
    let pending = [];
    let flushTimer = null;
    const flush = () => {
      flushTimer = null;
      const batch = pending;
      pending = [];
      setLogs(prev => {
        const next = prev.concat(batch);
        return next.length > 500 ? next.slice(next.length - 500) : next;
      });
    };

    const handleLog = (msg) => {
      // Auto-dismiss crash banner when server successfully starts again
      if (/Done \(/.test(msg)) setCrashBanner(null);
      pending.push(msg);
      if (!flushTimer) flushTimer = setTimeout(flush, 80);
    };

    const handleCrash = (data) => setCrashBanner(data);

    socket.on(`console_${serverId}`, handleLog);
    socket.on(`crash_detected_${serverId}`, handleCrash);
    return () => {
      socket.off(`console_${serverId}`, handleLog);
      socket.off(`crash_detected_${serverId}`, handleCrash);
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, [serverId, socket]);

  useEffect(() => {
    // While a search is active the user is reading the result — don't yank
    // them to the bottom when new log lines arrive.
    if (searchQuery) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, searchQuery]);

  // Build search regex + the list of currently-visible lines that match it.
  const searchRegex = useMemo(() => buildSearchRegex(searchQuery, useRegex), [searchQuery, useRegex]);
  const searchInvalid = !!searchQuery && useRegex && !searchRegex;

  const visibleLogs = useMemo(() => {
    const showAllLevels = levelFilters.size === 0;
    const items = [];
    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];
      if (!showAllLevels && !levelFilters.has(detectLogLevel(log))) continue;
      const isMatch = searchRegex ? searchRegex.test(log) : false;
      if (searchRegex && !isMatch) continue;
      items.push({ log, originalIdx: i, isMatch });
    }
    return items;
  }, [logs, levelFilters, searchRegex]);

  // OriginalIdx of every matched line, in display order. Used to look up the
  // DOM node for jump-to-match scrolling.
  const matchedOriginalIdxs = useMemo(
    () => (searchRegex ? visibleLogs.filter(v => v.isMatch).map(v => v.originalIdx) : []),
    [visibleLogs, searchRegex]
  );
  const matchCount = matchedOriginalIdxs.length;
  const safeMatchIdx = matchCount > 0 ? Math.min(currentMatchIdx, matchCount - 1) : 0;

  // When the matched set or selected index changes, scroll the current match
  // into view. No setState here — clamping happens via safeMatchIdx above.
  useEffect(() => {
    if (matchCount === 0) return;
    const originalIdx = matchedOriginalIdxs[safeMatchIdx];
    const node = matchRefs.current.get(originalIdx);
    if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [matchCount, safeMatchIdx, matchedOriginalIdxs]);

  const jumpToMatch = useCallback((direction) => {
    if (matchCount === 0) return;
    setCurrentMatchIdx((prev) => {
      const next = direction === 'next' ? prev + 1 : prev - 1;
      return (next + matchCount) % matchCount;
    });
  }, [matchCount]);

  const toggleLevel = (level) => {
    setLevelFilters((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level); else next.add(level);
      return next;
    });
  };

  const clearSearch = () => {
    setSearchQuery('');
    setCurrentMatchIdx(0);
    setUseRegex(false);
  };

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      jumpToMatch(e.shiftKey ? 'prev' : 'next');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      clearSearch();
    }
  };

  // Stable ref setter for LogLine — captures the DOM node into matchRefs so
  // we can scrollIntoView() it when the user steps through matches.
  const setLogLineRef = useCallback((originalIdx, el, isMatch) => {
    if (!isMatch) return;
    if (el) matchRefs.current.set(originalIdx, el);
    else matchRefs.current.delete(originalIdx);
  }, []);

  const updateSuggestions = useCallback((val) => {
    if (!val.trim()) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    const list = getSuggestions(val);
    setSuggestions(list);
    setHighlightedIdx(-1);
    setShowSuggestions(list.length > 0);
  }, []);

  const handleInputChange = (e) => {
    const val = e.target.value;
    setCommand(val);
    updateSuggestions(val);
    setHistoryIdx(-1);
  };

  // Select a suggestion — replaces the relevant part of the input and refocuses.
  const selectSuggestion = (s) => {
    setCommand(s.base + s.label + ' ');
    setSuggestions([]);
    setShowSuggestions(false);
    setHighlightedIdx(-1);
    // Trigger new suggestions for the next level after a tick
    setTimeout(() => {
      updateSuggestions(s.base + s.label + ' ');
      inputRef.current?.focus();
    }, 0);
  };

  const navigateHistory = (direction) => {
    if (commandHistory.length === 0) return;
    if (direction === 'up') {
      const next = historyIdx < commandHistory.length - 1 ? historyIdx + 1 : historyIdx;
      setHistoryIdx(next);
      setCommand(commandHistory[commandHistory.length - 1 - next] || '');
    } else {
      const next = historyIdx > 0 ? historyIdx - 1 : -1;
      setHistoryIdx(next);
      setCommand(next >= 0 ? commandHistory[commandHistory.length - 1 - next] : '');
    }
  };

  const handleKeyDown = (e) => {
    if (showSuggestions && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightedIdx(prev => Math.min(prev + 1, suggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (highlightedIdx > 0) setHighlightedIdx(prev => prev - 1);
        else if (highlightedIdx === 0) setHighlightedIdx(-1);
        else navigateHistory('up');
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        selectSuggestion(suggestions[highlightedIdx >= 0 ? highlightedIdx : 0]);
        return;
      }
      if (e.key === 'Enter' && highlightedIdx >= 0) {
        e.preventDefault();
        selectSuggestion(suggestions[highlightedIdx]);
        return;
      }
      if (e.key === 'Escape') {
        setShowSuggestions(false);
        setHighlightedIdx(-1);
        return;
      }
    } else {
      if (e.key === 'ArrowUp') { e.preventDefault(); navigateHistory('up'); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); navigateHistory('down'); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        // Attempt to show suggestions when Tab is pressed with no list visible
        const list = getSuggestions(command);
        if (list.length === 1) { selectSuggestion(list[0]); }
        else if (list.length > 1) { setSuggestions(list); setShowSuggestions(true); setHighlightedIdx(0); }
        return;
      }
    }
  };

  // Scroll highlighted suggestion into view
  useEffect(() => {
    if (highlightedIdx >= 0 && suggestionsRef.current) {
      suggestionsRef.current.children[highlightedIdx]?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIdx]);

  const handleSendCommand = async (e) => {
    e.preventDefault();
    if (!command.trim()) return;
    setCommandHistory(prev => [...prev, command.trim()]);
    setHistoryIdx(-1);
    setShowSuggestions(false);
    setSending(true);
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${serverId}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: command.trim().replace(/^\//, '') }),
      });
      if (!res.ok) throw new Error('Failed to send command');
      setCommand('');
    } catch (err) {
      console.error(err);
    }
    setSending(false);
  };

  return (
    <div className="flex-1 bg-[#111111] rounded-2xl border border-[#2D2D2D] flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#2D2D2D] bg-[#1A1A1A]">
        <Terminal size={16} className="text-[#A0A0A0]" />
        <span className="text-sm font-bold text-[#FFFFFF]">Live Console</span>

        <ConsoleSearchBar
          levelFilters={levelFilters}
          onToggleLevel={toggleLevel}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          useRegex={useRegex}
          setUseRegex={setUseRegex}
          searchInvalid={searchInvalid}
          matchCount={matchCount}
          currentMatchIdx={currentMatchIdx}
          onJump={jumpToMatch}
          onClear={clearSearch}
          onSearchKeyDown={handleSearchKeyDown}
          setCurrentMatchIdx={setCurrentMatchIdx}
        />
      </div>

      <CrashBanner
        crashBanner={crashBanner}
        serverId={serverId}
        onDismiss={() => setCrashBanner(null)}
      />

      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-sm text-[#CCCCCC] space-y-1 custom-scrollbar scroll-smooth"
      >
        {logs.length === 0 ? (
          <div className="text-[#555555] italic h-full flex items-center justify-center font-sans font-medium">
            No console output yet... Start the server to see logs!
          </div>
        ) : visibleLogs.length === 0 ? (
          <div className="text-[#555555] italic h-full flex items-center justify-center font-sans font-medium">
            {searchInvalid ? 'Invalid regex' : 'No log lines match the current filter.'}
          </div>
        ) : (
          visibleLogs.map(({ log, originalIdx, isMatch }) => (
            <LogLine
              key={originalIdx}
              log={log}
              originalIdx={originalIdx}
              isMatch={isMatch}
              isCurrent={isMatch && matchedOriginalIdxs[safeMatchIdx] === originalIdx}
              searchRegex={searchRegex}
              setRef={setLogLineRef}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Command input with recursive autocomplete */}
      <div className="relative border-t border-[#2D2D2D] bg-[#1A1A1A]">
        <AnimatePresence>
          {showSuggestions && suggestions.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 4, scaleY: 0.95 }}
              animate={{ opacity: 1, y: 0, scaleY: 1 }}
              exit={{ opacity: 0, y: 4, scaleY: 0.95 }}
              transition={{ duration: 0.12, ease: 'easeOut' }}
              style={{ transformOrigin: 'bottom' }}
              className="absolute bottom-full left-3 right-3 mb-1 bg-[#1A1A1A] border border-[#2D2D2D] rounded-xl shadow-[0_-8px_30px_rgba(0,0,0,0.5)] overflow-hidden z-50"
            >
              <div ref={suggestionsRef} className="max-h-52 overflow-y-auto custom-scrollbar">
                {suggestions.map((s, idx) => (
                  <button
                    key={s.label + idx}
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); selectSuggestion(s); }}
                    className={`w-full text-left px-3 py-2 flex items-center gap-3 transition-all outline-none ${
                      idx === highlightedIdx
                        ? 'bg-[#00AF5C]/10 text-[#FFFFFF]'
                        : 'text-[#A0A0A0] hover:bg-[#2D2D2D] hover:text-[#FFFFFF]'
                    }`}
                  >
                    <span className={`font-mono font-bold text-sm min-w-[120px] ${
                      idx === highlightedIdx ? 'text-[#00AF5C]' : 'text-[#CCCCCC]'
                    }`}>
                      {s.isCommand ? '/' : '›  '}{s.label}
                    </span>
                    <span className="text-xs text-[#555555] truncate">{s.desc}</span>
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <form onSubmit={handleSendCommand} className="flex gap-3 p-3">
          <input
            ref={inputRef}
            type="text"
            value={command}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onFocus={() => { if (command.trim()) updateSuggestions(command); }}
            onBlur={() => { setTimeout(() => setShowSuggestions(false), 150); }}
            placeholder="Type a command (e.g. /time set day)..."
            className="flex-1 bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] rounded-xl px-4 py-2 text-sm text-[#FFFFFF] outline-none font-mono placeholder-[#555555] transition-all focus:ring-2 focus:ring-[#00AF5C]/10"
            disabled={sending}
            autoComplete="off"
          />
          <button
            type="submit"
            disabled={sending || !command.trim()}
            className="px-5 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl font-bold text-sm transition-all disabled:opacity-50 active:scale-95"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

export default ConsoleViewer;
