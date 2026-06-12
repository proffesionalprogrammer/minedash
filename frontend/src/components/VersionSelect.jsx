import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ChevronDown, Check, HardDriveDownload, Loader2, Trash2, Search } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Tooltip from './Tooltip';

// Branded single-select dropdown for picking a Minecraft version.
// Installed entries get a tinted row + an "Installed" pill + a trash icon
// for deletion. Hovering an installed row reveals the delete button.
export default function VersionSelect({ value, onChange, options, installedSet, loading, disabled, onDelete }) {
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [search, setSearch] = useState('');
  const wrapperRef = useRef(null);
  const searchRef = useRef(null);
  const selectedRowRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => { if (!open) { setSearch(''); setConfirmDelete(null); } }, [open]);

  // When the dropdown opens, scroll the currently-selected version to the
  // centre of the list so the user can see newer versions above it and older
  // versions below — instead of always opening pinned to "latest" at the top.
  useEffect(() => {
    if (!open) return;
    // Wait one frame so the AnimatePresence enter animation has mounted the row.
    const raf = requestAnimationFrame(() => {
      const row = selectedRowRef.current;
      const list = listRef.current;
      if (!row || !list) return;
      const rowTop = row.offsetTop;
      const rowHeight = row.offsetHeight;
      const listHeight = list.clientHeight;
      list.scrollTop = Math.max(0, rowTop - (listHeight / 2) + (rowHeight / 2));
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const filteredOptions = useMemo(() =>
    search.trim() ? options.filter(v => v.toLowerCase().includes(search.trim().toLowerCase())) : options,
  [options, search]);

  const valueInstalled = installedSet?.has?.(value);
  const disabledState = disabled || (!loading && options.length === 0);

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        onClick={() => !disabledState && setOpen(v => !v)}
        disabled={disabledState}
        className={`w-full flex items-center justify-between gap-2 bg-[#111111] border rounded-xl px-3 py-2.5 text-sm font-medium text-[#FFFFFF] outline-none transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
          open
            ? 'border-[#00AF5C] ring-4 ring-[#00AF5C]/10'
            : 'border-[#2D2D2D] hover:border-[#555555]'
        }`}
      >
        <span className="flex items-center gap-2 min-w-0">
          {loading
            ? <Loader2 size={14} className="text-[#555555] animate-spin flex-shrink-0" />
            : valueInstalled
              ? <HardDriveDownload size={14} className="text-[#00AF5C] flex-shrink-0" />
              : <span className="w-3.5 h-3.5 flex-shrink-0" />}
          <span className="tabular-nums truncate">{value || (loading ? 'Loading…' : 'No versions')}</span>
          {valueInstalled && (
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#00AF5C] bg-[#00AF5C]/10 border border-[#00AF5C]/20 px-2 py-0.5 rounded-full flex-shrink-0">
              Installed
            </span>
          )}
        </span>
        <ChevronDown size={16} className={`text-[#A0A0A0] transition-transform duration-200 flex-shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="absolute left-0 right-0 mt-2 z-40 bg-[#1A1A1A] border border-[#2D2D2D] rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.5)] overflow-hidden"
          >
            <div className="px-2 pt-2 pb-1.5 border-b border-[#2D2D2D]">
              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#555555] pointer-events-none" />
                <input
                  ref={searchRef}
                  autoFocus
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search versions…"
                  className="w-full bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] rounded-lg pl-7 pr-3 py-1.5 text-xs text-[#FFFFFF] outline-none focus:ring-2 focus:ring-[#00AF5C]/10 transition-all placeholder-[#555555] font-medium"
                />
              </div>
            </div>
            <div ref={listRef} className="max-h-60 overflow-y-auto custom-scrollbar py-1">
              {filteredOptions.length === 0 ? (
                <div className="px-4 py-4 text-center text-xs text-[#555555]">
                  {options.length === 0 ? 'No versions to show.' : 'No matches.'}
                </div>
              ) : filteredOptions.map(v => {
                const isSelected = v === value;
                const isInstalled = installedSet?.has?.(v);
                const isConfirming = confirmDelete === v;
                return (
                  <div
                    key={v}
                    ref={isSelected ? selectedRowRef : null}
                    className={`group flex items-center justify-between gap-2 px-3 py-2 text-sm font-medium transition-colors ${
                      isSelected
                        ? 'bg-[#00AF5C]/15 text-[#00AF5C]'
                        : isInstalled
                          ? 'bg-[#00AF5C]/[0.04] text-[#FFFFFF] hover:bg-[#00AF5C]/10'
                          : 'text-[#A0A0A0] hover:bg-[#1E1E1E] hover:text-[#FFFFFF]'
                    }`}
                  >
                    <button
                      onClick={() => { onChange(v); setOpen(false); setSearch(''); }}
                      className="flex-1 flex items-center gap-2 min-w-0 text-left"
                    >
                      {isSelected
                        ? <Check size={14} className="text-[#00AF5C] flex-shrink-0" />
                        : isInstalled
                          ? <HardDriveDownload size={14} className="text-[#00AF5C] flex-shrink-0" />
                          : <span className="w-3.5 h-3.5 flex-shrink-0" />}
                      <span className="tabular-nums truncate">{v}</span>
                    </button>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {isInstalled && !isConfirming && (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-[#00AF5C] bg-[#00AF5C]/10 border border-[#00AF5C]/20 px-2 py-0.5 rounded-full">
                          Installed
                        </span>
                      )}
                      {isInstalled && onDelete && (
                        isConfirming ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => { onDelete(v); setConfirmDelete(null); }}
                              className="text-[10px] font-bold text-[#FF5555] hover:text-[#FF4444] bg-[#FF5555]/10 hover:bg-[#FF5555]/20 px-2 py-1 rounded-lg transition-all">
                              Confirm
                            </button>
                            <button
                              onClick={() => setConfirmDelete(null)}
                              className="text-[10px] font-bold text-[#A0A0A0] hover:text-[#FFFFFF] px-2 py-1 rounded-lg transition-all">
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <Tooltip content="Delete this installed version" align="end">
                            <button
                              onClick={() => setConfirmDelete(v)}
                              className="p-1.5 text-[#A0A0A0] hover:text-[#FF5555] hover:bg-[#FF5555]/10 rounded-lg transition-all opacity-0 group-hover:opacity-100">
                              <Trash2 size={14} />
                            </button>
                          </Tooltip>
                        )
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
