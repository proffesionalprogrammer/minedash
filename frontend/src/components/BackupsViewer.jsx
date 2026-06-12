import React, { useState, useEffect, useRef, useMemo, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Archive, Trash2, Download, Plus, RotateCcw, CheckCircle2, Clock, Shield, ChevronDown, Check, Search, Pin, PinOff, Pencil, HardDrive, X, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import ModalPortal from './ModalPortal';
import Tooltip from './Tooltip';

// ─── helpers ──────────────────────────────────────────────────
function relativeTime(ms) {
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  return `${Math.floor(mo / 12)} year${Math.floor(mo / 12) === 1 ? '' : 's'} ago`;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

// Strip auto-prefix / epoch / extension to make a system-named file readable.
// Custom-renamed backups keep their name.
function friendlyTitle(b) {
  const n = b.name;
  if (/^auto-backup-\d+\.zip$/.test(n)) return 'Auto Backup';
  if (/^backup-\d+\.zip$/.test(n)) return 'Manual Backup';
  return n.replace(/\.zip$/i, '');
}

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'largest', label: 'Largest first' },
  { value: 'smallest', label: 'Smallest first' },
  { value: 'name', label: 'Name (A → Z)' },
];

const INTERVAL_OPTIONS = [
  { value: 1, label: 'Every 1 hour' },
  { value: 3, label: 'Every 3 hours' },
  { value: 6, label: 'Every 6 hours' },
  { value: 12, label: 'Every 12 hours' },
  { value: 24, label: 'Every 24 hours' },
];

const RETENTION_OPTIONS = [
  { value: 3, label: 'Keep last 3' },
  { value: 5, label: 'Keep last 5' },
  { value: 10, label: 'Keep last 10' },
  { value: 20, label: 'Keep last 20' },
  { value: 0, label: 'Keep all' },
];

function BackupSelect({ value, options, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [coords, setCoords] = useState(null);
  const selected = options.find(o => String(o.value) === String(value));

  // Position the portal'd menu under the trigger. Recompute on scroll/resize so
  // it stays anchored if a parent scroll container moves.
  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) return;
    const compute = () => {
      if (!triggerRef.current) return;
      const r = triggerRef.current.getBoundingClientRect();
      setCoords({ top: r.bottom + 6, left: r.left, width: r.width });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => {
      if (triggerRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setIsOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  return (
    <div className="relative min-w-[150px]">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full bg-[#111111] border ${isOpen ? 'border-[#00AF5C] ring-2 ring-[#00AF5C]/20' : 'border-[#2D2D2D] hover:border-[#555555]'} rounded-xl px-3 py-2 text-left flex items-center justify-between gap-2 text-sm text-[#FFFFFF] font-medium transition-all outline-none`}
      >
        <span>{selected?.label ?? value}</span>
        <ChevronDown size={14} className={`text-[#555555] transition-transform flex-shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && coords && createPortal(
        <AnimatePresence>
          <motion.div
            ref={menuRef}
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.13, ease: 'easeOut' }}
            style={{ position: 'fixed', top: coords.top, left: coords.left, width: coords.width, zIndex: 9999 }}
            className="bg-[#1A1A1A] border border-[#2D2D2D] rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.5)] overflow-hidden py-1"
          >
            {options.map(opt => {
              const isSel = String(opt.value) === String(value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => { onChange(opt.value); setIsOpen(false); }}
                  className={`w-full text-left px-3 py-2 text-sm font-medium flex items-center justify-between transition-colors ${isSel ? 'bg-[#00AF5C]/10 text-[#00AF5C]' : 'text-[#A0A0A0] hover:bg-[#2D2D2D] hover:text-[#FFFFFF]'}`}
                >
                  <span>{opt.label}</span>
                  {isSel && <Check size={13} />}
                </button>
              );
            })}
          </motion.div>
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
}

function BackupsViewer({ serverId, server, onError }) {
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [restoreTarget, setRestoreTarget] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [toast, setToast] = useState(null);

  // Auto-backup settings state (initialized from server prop)
  const [autoBackup, setAutoBackup] = useState(server?.autoBackup || false);
  const [backupIntervalHours, setBackupIntervalHours] = useState(server?.backupIntervalHours || 6);
  const [keepLastNBackups, setKeepLastNBackups] = useState(server?.keepLastNBackups ?? 5);
  const [savingSettings, setSavingSettings] = useState(false);
  const [panelOverflow, setPanelOverflow] = useState('hidden');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('newest');
  const [renameTarget, setRenameTarget] = useState(null); // backup name
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState('');

  useEffect(() => {
    fetchBackups();
  }, [serverId]);

  const fetchBackups = async () => {
    setLoading(true);
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${serverId}/backups`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch backups');
      setBackups(data.sort((a, b) => new Date(b.date) - new Date(a.date)));
    } catch (err) {
      console.error(err);
      if (onError) onError(err.message);
    }
    setLoading(false);
  };

  const saveAutoBackupSettings = async (newAutoBackup, newInterval, newKeep) => {
    setSavingSettings(true);
    try {
      await fetch(`http://localhost:3001/api/servers/${serverId}/backup-settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoBackup: newAutoBackup,
          backupIntervalHours: newInterval,
          keepLastNBackups: newKeep,
        }),
      });
    } catch (err) {
      if (onError) onError(err.message);
    }
    setSavingSettings(false);
  };

  const handleToggleAutoBackup = (val) => {
    setAutoBackup(val);
    saveAutoBackupSettings(val, backupIntervalHours, keepLastNBackups);
  };

  const handleIntervalChange = (val) => {
    setBackupIntervalHours(val);
    saveAutoBackupSettings(autoBackup, val, keepLastNBackups);
  };

  const handleRetentionChange = (val) => {
    setKeepLastNBackups(val);
    saveAutoBackupSettings(autoBackup, backupIntervalHours, val);
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${serverId}/backups`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create backup');
      await fetchBackups();
      setToast('Backup created');
      setTimeout(() => setToast(null), 3000);
    } catch (err) {
      console.error(err);
      if (onError) onError(err.message);
    }
    setCreating(false);
  };

  const handleTogglePin = async (backup) => {
    // Optimistic update
    const nextPinned = !backup.pinned;
    setBackups(prev => prev.map(b => b.name === backup.name ? { ...b, pinned: nextPinned } : b));
    try {
      const res = await fetch(
        `http://localhost:3001/api/servers/${serverId}/backups/${encodeURIComponent(backup.name)}/pin`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: nextPinned }) }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update pin');
      }
    } catch (err) {
      // Revert on failure
      setBackups(prev => prev.map(b => b.name === backup.name ? { ...b, pinned: !nextPinned } : b));
      if (onError) onError(err.message);
    }
  };

  const openRename = (backup) => {
    setRenameTarget(backup.name);
    // Pre-fill with friendly title (no .zip), so user types a clean label
    const base = /^(auto-)?backup-\d+\.zip$/.test(backup.name)
      ? ''
      : backup.name.replace(/\.zip$/i, '');
    setRenameValue(base);
    setRenameError('');
  };

  const confirmRename = async () => {
    if (!renameTarget) return;
    const val = renameValue.trim();
    if (!val) { setRenameError('Name cannot be empty.'); return; }
    if (/[\\/:*?"<>|]/.test(val)) { setRenameError('Name contains invalid characters.'); return; }
    setRenaming(true);
    try {
      const res = await fetch(
        `http://localhost:3001/api/servers/${serverId}/backups/${encodeURIComponent(renameTarget)}/rename`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newName: val }) }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to rename backup');
      await fetchBackups();
      setRenameTarget(null);
      setToast('Backup renamed');
      setTimeout(() => setToast(null), 3000);
    } catch (err) {
      setRenameError(err.message);
    }
    setRenaming(false);
  };

  const handleDownload = (backupName) => {
    const url = `http://localhost:3001/api/servers/${serverId}/backups/${encodeURIComponent(backupName)}/download`;
    const a = document.createElement('a');
    a.href = url;
    a.download = backupName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const confirmRestore = async () => {
    if (!restoreTarget) return;
    setRestoring(true);
    try {
      const res = await fetch(
        `http://localhost:3001/api/servers/${serverId}/backups/${encodeURIComponent(restoreTarget)}/restore`,
        { method: 'POST' }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to restore backup');
      setRestoreTarget(null);
      setToast('Backup restored successfully!');
      setTimeout(() => setToast(null), 4000);
    } catch (err) {
      console.error(err);
      if (onError) onError(err.message);
    }
    setRestoring(false);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${serverId}/backups/${encodeURIComponent(deleteTarget)}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete backup');
      setBackups(backups.filter(b => b.name !== deleteTarget));
    } catch (err) {
      console.error(err);
      if (onError) onError(err.message);
    }
    setDeleteTarget(null);
  };

  const visibleBackups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? backups.filter(b => b.name.toLowerCase().includes(q) || friendlyTitle(b).toLowerCase().includes(q))
      : backups;
    const sorted = [...filtered].sort((a, b) => {
      // Pinned always rise to the top within the chosen sort
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      switch (sortBy) {
        case 'oldest': return new Date(a.date) - new Date(b.date);
        case 'largest': return (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
        case 'smallest': return (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0);
        case 'name': return a.name.localeCompare(b.name);
        case 'newest':
        default: return new Date(b.date) - new Date(a.date);
      }
    });
    return sorted;
  }, [backups, search, sortBy]);

  const stats = useMemo(() => {
    const totalBytes = backups.reduce((s, b) => s + (b.sizeBytes ?? 0), 0);
    const newest = backups.reduce((max, b) => {
      const t = new Date(b.date).getTime();
      return t > max ? t : max;
    }, 0);
    return {
      count: backups.length,
      totalBytes,
      lastBackupMs: newest || null,
      pinnedCount: backups.filter(b => b.pinned).length,
    };
  }, [backups]);

  return (
    <div className="flex-1 bg-[#111111] rounded-2xl border border-[#2D2D2D] flex flex-col overflow-hidden relative">
      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {deleteTarget && (
          <ModalPortal>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#000000]/80 z-[100] flex items-center justify-center backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
              className="bg-[#1A1A1A] border border-[#2D2D2D] p-6 rounded-3xl w-full max-w-md shadow-2xl mx-4"
            >
              <h3 className="text-xl font-bold text-[#FFFFFF] mb-2">Delete Backup</h3>
              <p className="text-[#A0A0A0] text-sm mb-6 leading-relaxed">
                Are you sure you want to permanently delete <span className="text-white font-bold">{deleteTarget}</span>? This action cannot be undone.
              </p>
              <div className="flex justify-end gap-3 pt-4 border-t border-[#2D2D2D]">
                <button onClick={() => setDeleteTarget(null)} className="px-4 py-2 bg-[#111111] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#FFFFFF] rounded-xl text-sm font-bold transition-all duration-200 hover:scale-[1.02] active:scale-95">Cancel</button>
                <button onClick={confirmDelete} className="px-4 py-2 bg-[#FF5555] hover:bg-[#FF4444] text-white rounded-xl text-sm font-bold transition-all duration-200 flex items-center gap-2 hover:scale-[1.02] active:scale-95">
                  <Trash2 size={16} /> Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
          </ModalPortal>
        )}
      </AnimatePresence>

      {/* Restore Confirmation Modal */}
      <AnimatePresence>
        {restoreTarget && (
          <ModalPortal>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#000000]/80 z-[100] flex items-center justify-center backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
              className="bg-[#1A1A1A] border border-[#2D2D2D] p-6 rounded-3xl w-full max-w-md shadow-2xl mx-4"
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2.5 bg-amber-500/10 rounded-xl">
                  <RotateCcw size={20} className="text-amber-500" />
                </div>
                <h3 className="text-xl font-bold text-[#FFFFFF]">Restore Backup</h3>
              </div>
              <p className="text-[#A0A0A0] text-sm mb-6 leading-relaxed">
                This will <span className="text-white font-bold">replace all current server files</span> with the backup{' '}
                <span className="text-white font-bold">{restoreTarget}</span>. If the server is running, it will be stopped and restarted automatically. This action cannot be undone.
              </p>
              <div className="flex justify-end gap-3 pt-4 border-t border-[#2D2D2D]">
                <button onClick={() => setRestoreTarget(null)} disabled={restoring} className="px-4 py-2 bg-[#111111] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#FFFFFF] rounded-xl text-sm font-bold transition-all duration-200 disabled:opacity-50 hover:scale-[1.02] active:scale-95">Cancel</button>
                <button onClick={confirmRestore} disabled={restoring} className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-xl text-sm font-bold transition-all duration-200 flex items-center gap-2 disabled:opacity-50 hover:scale-[1.02] active:scale-95">
                  <RotateCcw size={16} className={restoring ? 'animate-spin' : ''} />
                  {restoring ? 'Restoring...' : 'Restore Backup'}
                </button>
              </div>
            </motion.div>
          </motion.div>
          </ModalPortal>
        )}
      </AnimatePresence>

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#2D2D2D] bg-[#1A1A1A]">
        <h3 className="font-bold text-[#FFFFFF]">Server Backups</h3>
        <motion.button
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          onClick={handleCreate}
          disabled={creating}
          className="flex items-center gap-2 px-4 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl font-bold text-sm transition-colors disabled:opacity-50"
        >
          {creating ? <Archive size={16} className="animate-spin" /> : <Plus size={16} />}
          <span>{creating ? 'Zipping...' : 'Create Backup'}</span>
        </motion.button>
      </div>

      {/* Auto-backup settings panel */}
      <div className="border-b border-[#2D2D2D] bg-[#161616]">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[#00AF5C]/10 rounded-xl">
              <Shield size={16} className="text-[#00AF5C]" />
            </div>
            <div>
              <p className="text-sm font-bold text-[#FFFFFF]">Auto-backup World</p>
              <p className="text-xs text-[#555555]">Automatically back up your world on a schedule</p>
            </div>
          </div>
          {/* Toggle switch */}
          <button
            onClick={() => handleToggleAutoBackup(!autoBackup)}
            disabled={savingSettings}
            className={`relative w-12 h-6 rounded-full transition-colors duration-300 disabled:opacity-50 flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-[#00AF5C]/50 ${
              autoBackup ? 'bg-[#00AF5C]' : 'bg-[#2D2D2D]'
            }`}
          >
            <motion.div
              className="absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm"
              animate={{ left: autoBackup ? '1.5rem' : '0.25rem' }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            />
          </button>
        </div>

        {/* Animated settings — expand on enable, collapse on disable */}
        <AnimatePresence initial={false}>
          {autoBackup && (
            <motion.div
              key="autobackup-settings"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}
              style={{ overflow: panelOverflow }}
              onAnimationStart={() => setPanelOverflow('hidden')}
              onAnimationComplete={(def) => {
                if (def?.height === 'auto') setPanelOverflow('visible');
              }}
            >
              <div className="px-6 pb-5 flex flex-wrap items-center gap-4 border-t border-[#2D2D2D] pt-4">
                <div className="flex items-center gap-3">
                  <Clock size={14} className="text-[#555555]" />
                  <span className="text-sm font-medium text-[#A0A0A0]">Frequency</span>
                  <BackupSelect
                    value={backupIntervalHours}
                    options={INTERVAL_OPTIONS}
                    onChange={handleIntervalChange}
                  />
                </div>
                <div className="w-px h-4 bg-[#2D2D2D] hidden sm:block" />
                <div className="flex items-center gap-3">
                  <Archive size={14} className="text-[#555555]" />
                  <span className="text-sm font-medium text-[#A0A0A0]">Retention</span>
                  <BackupSelect
                    value={keepLastNBackups}
                    options={RETENTION_OPTIONS}
                    onChange={handleRetentionChange}
                  />
                </div>
                {savingSettings && (
                  <span className="text-xs text-[#555555] ml-auto">Saving…</span>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Stats strip */}
      {!loading && backups.length > 0 && (
        <div className="grid grid-cols-3 gap-px bg-[#2D2D2D] border-b border-[#2D2D2D]">
          <div className="bg-[#111111] px-6 py-3 flex items-center gap-3">
            <div className="p-2 bg-[#00AF5C]/10 rounded-lg">
              <Archive size={14} className="text-[#00AF5C]" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wider text-[#555555] font-bold">Backups</p>
              <p className="text-sm font-bold text-[#FFFFFF] tabular-nums truncate">
                {stats.count}{stats.pinnedCount > 0 && <span className="text-[#A0A0A0] font-medium"> · {stats.pinnedCount} pinned</span>}
              </p>
            </div>
          </div>
          <div className="bg-[#111111] px-6 py-3 flex items-center gap-3">
            <div className="p-2 bg-[#00AF5C]/10 rounded-lg">
              <HardDrive size={14} className="text-[#00AF5C]" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wider text-[#555555] font-bold">Total size</p>
              <p className="text-sm font-bold text-[#FFFFFF] tabular-nums truncate">{formatBytes(stats.totalBytes)}</p>
            </div>
          </div>
          <div className="bg-[#111111] px-6 py-3 flex items-center gap-3">
            <div className="p-2 bg-[#00AF5C]/10 rounded-lg">
              <Clock size={14} className="text-[#00AF5C]" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wider text-[#555555] font-bold">Last backup</p>
              <Tooltip content={stats.lastBackupMs ? new Date(stats.lastBackupMs).toLocaleString() : ''} align="start" className="w-full min-w-0">
                <p className="text-sm font-bold text-[#FFFFFF] truncate w-full">
                  {stats.lastBackupMs ? relativeTime(stats.lastBackupMs) : '—'}
                </p>
              </Tooltip>
            </div>
          </div>
        </div>
      )}

      {/* Search + sort */}
      {!loading && backups.length > 0 && (
        <div className="flex items-center gap-3 px-6 py-3 border-b border-[#2D2D2D] bg-[#161616]">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555555] pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search backups..."
              className="w-full bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] focus:ring-2 focus:ring-[#00AF5C]/20 rounded-xl pl-9 pr-3 py-2 text-sm text-[#FFFFFF] outline-none transition-all placeholder-[#555555] font-medium"
            />
          </div>
          <BackupSelect
            value={sortBy}
            options={SORT_OPTIONS}
            onChange={(v) => setSortBy(v)}
          />
        </div>
      )}

      {/* Backup list */}
      <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
        {loading ? (
          <div className="flex items-center justify-center h-full text-[#A0A0A0] font-medium">
            Loading backups...
          </div>
        ) : backups.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-6 text-center">
            <div className="p-5 bg-[#00AF5C]/5 rounded-3xl mb-5 border border-[#00AF5C]/10">
              <Sparkles size={40} className="text-[#00AF5C]" />
            </div>
            <h4 className="text-base font-bold text-[#FFFFFF] mb-1">No backups yet</h4>
            <p className="text-sm text-[#A0A0A0] max-w-xs">Create your first backup to keep your world safe — or flip on auto-backup above and forget about it.</p>
            <motion.button
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              onClick={handleCreate}
              disabled={creating}
              className="mt-5 flex items-center gap-2 px-5 py-2.5 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl font-bold text-sm transition-colors disabled:opacity-50"
            >
              {creating ? <Archive size={16} className="animate-spin" /> : <Plus size={16} />}
              <span>{creating ? 'Zipping...' : 'Create First Backup'}</span>
            </motion.button>
          </div>
        ) : visibleBackups.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-[#555555] font-medium px-6 text-center">
            <Search size={36} className="mb-3 opacity-30" />
            <p>No backups match "{search}".</p>
            <button onClick={() => setSearch('')} className="text-xs mt-2 text-[#00AF5C] hover:underline font-bold">Clear search</button>
          </div>
        ) : (
          <div className="space-y-2 p-2">
            {visibleBackups.map((backup, i) => {
              const isAuto = backup.type === 'auto';
              const dateMs = backup.dateMs || new Date(backup.date).getTime();
              return (
                <motion.div
                  key={backup.name}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.03, 0.3), duration: 0.25 }}
                  className={`flex items-center justify-between p-4 bg-[#1E1E1E] border rounded-2xl hover:border-[#555555] transition-all duration-200 group ${backup.pinned ? 'border-[#00AF5C]/40 bg-[#00AF5C]/[0.03]' : 'border-[#2D2D2D]'}`}
                >
                  <div className="flex items-center gap-4 min-w-0 flex-1">
                    <div className={`p-3 rounded-xl border ${backup.pinned ? 'bg-[#00AF5C]/10 text-[#00AF5C] border-[#00AF5C]/30' : 'bg-[#111111] text-[#A0A0A0] border-[#2D2D2D]'}`}>
                      <Archive size={20} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="font-bold text-[#FFFFFF] truncate">{friendlyTitle(backup)}</h4>
                        <span className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-md ${isAuto ? 'bg-[#A0A0A0]/10 text-[#A0A0A0]' : 'bg-[#00AF5C]/10 text-[#00AF5C]'}`}>
                          {isAuto ? 'Auto' : 'Manual'}
                        </span>
                        {backup.pinned && (
                          <span className="text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-400 flex items-center gap-1">
                            <Pin size={10} /> Pinned
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-[#A0A0A0] mt-1 truncate">
                        {backup.size} · {relativeTime(dateMs)} · <span className="text-[#555555]">{new Date(dateMs).toLocaleString()}</span>
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 ml-2">
                    <Tooltip content={backup.pinned ? 'Unpin (allow auto-cleanup)' : 'Pin (protect from auto-cleanup)'}>
                      <button
                        onClick={() => handleTogglePin(backup)}
                        className={`p-2 rounded-xl transition-all duration-200 hover:scale-110 ${backup.pinned ? 'text-amber-400 hover:bg-amber-500/10' : 'text-[#555555] opacity-0 group-hover:opacity-100 hover:text-amber-400 hover:bg-amber-500/10'}`}
                      >
                        {backup.pinned ? <Pin size={18} /> : <PinOff size={18} />}
                      </button>
                    </Tooltip>
                    <Tooltip content="Rename">
                      <button
                        onClick={() => openRename(backup)}
                        className="p-2 text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#2D2D2D] rounded-xl transition-all duration-200 hover:scale-110 opacity-60 group-hover:opacity-100"
                      >
                        <Pencil size={18} />
                      </button>
                    </Tooltip>
                    <Tooltip content="Restore Backup">
                      <button
                        onClick={() => setRestoreTarget(backup.name)}
                        className="p-2 text-[#A0A0A0] hover:text-amber-500 hover:bg-amber-500/10 rounded-xl transition-all duration-200 hover:scale-110 opacity-60 group-hover:opacity-100"
                      >
                        <RotateCcw size={18} />
                      </button>
                    </Tooltip>
                    <Tooltip content="Download Backup">
                      <button
                        onClick={() => handleDownload(backup.name)}
                        className="p-2 text-[#A0A0A0] hover:text-[#00AF5C] hover:bg-[#00AF5C]/10 rounded-xl transition-all duration-200 hover:scale-110 opacity-60 group-hover:opacity-100"
                      >
                        <Download size={18} />
                      </button>
                    </Tooltip>
                    <Tooltip content="Delete Backup" align="end">
                      <button
                        onClick={() => setDeleteTarget(backup.name)}
                        className="p-2 text-[#A0A0A0] hover:text-[#FF5555] hover:bg-[#FF5555]/10 rounded-xl transition-all duration-200 hover:scale-110 opacity-60 group-hover:opacity-100"
                      >
                        <Trash2 size={18} />
                      </button>
                    </Tooltip>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>

      {/* Rename modal */}
      <AnimatePresence>
        {renameTarget && (
          <ModalPortal>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#000000]/80 z-[100] flex items-center justify-center backdrop-blur-sm"
            onClick={() => !renaming && setRenameTarget(null)}
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.92, opacity: 0 }}
              transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
              className="bg-[#1A1A1A] border border-[#2D2D2D] p-6 rounded-3xl w-full max-w-md shadow-2xl mx-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-[#00AF5C]/10 rounded-xl">
                    <Pencil size={16} className="text-[#00AF5C]" />
                  </div>
                  <h3 className="text-lg font-bold text-[#FFFFFF]">Rename Backup</h3>
                </div>
                <button
                  onClick={() => !renaming && setRenameTarget(null)}
                  className="p-1.5 text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#2D2D2D] rounded-lg transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
              <p className="text-xs text-[#A0A0A0] mb-4">Give this backup a memorable label like "pre-1.21-update" or "before-mod-install".</p>
              <input
                autoFocus
                type="text"
                value={renameValue}
                onChange={(e) => { setRenameValue(e.target.value); if (renameError) setRenameError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') confirmRename(); if (e.key === 'Escape') setRenameTarget(null); }}
                placeholder="my-special-backup"
                disabled={renaming}
                className={`w-full bg-[#111111] border ${renameError ? 'border-[#FF5555] focus:border-[#FF5555] focus:ring-[#FF5555]/10' : 'border-[#2D2D2D] focus:border-[#00AF5C] focus:ring-[#00AF5C]/10'} rounded-xl px-3 py-2.5 text-sm text-[#FFFFFF] outline-none transition-all focus:ring-4 font-medium placeholder-[#555555]`}
              />
              <p className="text-[10px] text-[#555555] mt-1.5">.zip is added automatically</p>
              {renameError && <p className="text-xs text-[#FF5555] font-medium mt-2">{renameError}</p>}
              <div className="flex justify-end gap-3 pt-5 mt-5 border-t border-[#2D2D2D]">
                <button
                  onClick={() => setRenameTarget(null)}
                  disabled={renaming}
                  className="px-4 py-2 bg-[#111111] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#FFFFFF] rounded-xl text-sm font-bold transition-all duration-200 disabled:opacity-50 hover:scale-[1.02] active:scale-95"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmRename}
                  disabled={renaming || !renameValue.trim()}
                  className="px-4 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-sm font-bold transition-all duration-200 flex items-center gap-2 disabled:opacity-50 hover:scale-[1.02] active:scale-95"
                >
                  {renaming && <RotateCcw size={14} className="animate-spin" />}
                  {renaming ? 'Renaming...' : 'Rename'}
                </button>
              </div>
            </motion.div>
          </motion.div>
          </ModalPortal>
        )}
      </AnimatePresence>

      {/* Success toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={{ type: 'spring', duration: 0.4, bounce: 0.2 }}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 px-5 py-3 bg-[#1E1E1E] border border-[#00AF5C]/30 text-[#FFFFFF] rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.5)] z-50 whitespace-nowrap"
          >
            <CheckCircle2 size={18} className="text-[#00AF5C] flex-shrink-0" />
            <span className="text-sm font-medium">{toast}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default BackupsViewer;
