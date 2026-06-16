import React, { useState, useEffect, useRef } from 'react';
import { X, Server as ServerIcon, Cpu, Zap, Box, ChevronDown, Search, Loader2, Check, Pickaxe, Hammer, Layers, Wrench } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import ModalPortal from './ModalPortal';
import { TITLEBAR_OFFSET } from '../lib/titlebar';
import { useSystemRam } from '../hooks/useSystemRam';

// ─── Small option dropdown (no icons) ─────────────────────────────
function OptionDropdown({ value, onChange, options }) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef(null);
  const selected = options.find(o => String(o.value) === String(value));

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setIsOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full bg-[var(--c-base)] border ${isOpen ? 'border-[#00AF5C] ring-2 ring-[#00AF5C]/20' : 'border-[var(--c-border)] hover:border-[var(--c-text-muted)]'} rounded-xl px-3 py-2 text-left flex items-center justify-between text-sm text-[var(--c-text-primary)] font-medium transition-all outline-none`}
      >
        <span>{selected?.label ?? value}</span>
        <ChevronDown size={14} className={`text-[var(--c-text-muted)] transition-transform flex-shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.13, ease: 'easeOut' }}
            className="absolute z-50 w-full mt-1.5 bg-[var(--c-surface-1)] border border-[var(--c-border)] rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.5)] overflow-hidden py-1"
          >
            {options.map(opt => {
              const isSel = String(opt.value) === String(value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => { onChange(opt.value); setIsOpen(false); }}
                  className={`w-full text-left px-3 py-2 text-sm font-medium flex items-center justify-between transition-colors ${isSel ? 'bg-[#00AF5C]/10 text-[#00AF5C]' : 'text-[var(--c-text-secondary)] hover:bg-[var(--c-border)] hover:text-[var(--c-text-primary)]'}`}
                >
                  <span>{opt.label}</span>
                  {isSel && <Check size={13} />}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const RAM_MIN = 1;
const RAM_MAX_FALLBACK = 32; // used until the system's real total RAM is fetched

// Paper MC icon — a simplified paper/scroll SVG rendered as a React component
function PaperIcon({ size = 16, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="13" y2="17" />
    </svg>
  );
}

const SERVER_TYPES = [
  { value: 'vanilla', label: 'Vanilla', icon: Pickaxe, desc: 'Pure Minecraft experience' },
  { value: 'paper', label: 'Paper', icon: PaperIcon, desc: 'High-performance + plugins' },
  { value: 'forge', label: 'Forge', icon: Hammer, desc: 'Classic mod loader' },
  { value: 'fabric', label: 'Fabric', icon: Layers, desc: 'Lightweight & modern' },
  { value: 'neoforge', label: 'NeoForge', icon: Wrench, desc: 'Next-gen Forge fork' },
];

// ─── Custom Dropdown ───────────────────────────────────────────
function CustomDropdown({ value, onChange, options }) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);
  const selected = options.find(o => o.value === value);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') { setIsOpen(false); return; }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsOpen(!isOpen); return; }
    if (!isOpen) return;
    const currentIdx = options.findIndex(o => o.value === value);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(currentIdx + 1, options.length - 1);
      onChange(options[next].value);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = Math.max(currentIdx - 1, 0);
      onChange(options[prev].value);
    }
  };

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        className={`w-full bg-[var(--c-base)] border ${isOpen ? 'border-[#00AF5C] ring-4 ring-[#00AF5C]/10' : 'border-[var(--c-border)] hover:border-[var(--c-text-muted)]'} rounded-2xl px-4 py-3 text-left flex items-center gap-3 transition-all outline-none`}
      >
        {selected && (
          <>
            <div className="p-1.5 bg-[#00AF5C]/10 rounded-lg flex-shrink-0">
              <selected.icon size={16} className="text-[#00AF5C]" />
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-[var(--c-text-primary)] font-medium">{selected.label}</span>
            </div>
          </>
        )}
        <ChevronDown size={16} className={`text-[var(--c-text-muted)] transition-transform duration-200 flex-shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute z-50 w-full mt-2 bg-[var(--c-surface-1)] border border-[var(--c-border)] rounded-2xl shadow-[0_12px_40px_rgba(0,0,0,0.6)] overflow-hidden"
          >
            {options.map((option) => {
              const Icon = option.icon;
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => { onChange(option.value); setIsOpen(false); }}
                  className={`w-full text-left px-4 py-3 flex items-center gap-3 transition-all outline-none ${
                    isSelected
                      ? 'bg-[#00AF5C]/10 text-[var(--c-text-primary)]'
                      : 'text-[var(--c-text-secondary)] hover:bg-[var(--c-border)] hover:text-[var(--c-text-primary)]'
                  }`}
                >
                  <div className={`p-1.5 rounded-lg flex-shrink-0 ${isSelected ? 'bg-[#00AF5C]/20' : 'bg-[var(--c-base)]'}`}>
                    <Icon size={16} className={isSelected ? 'text-[#00AF5C]' : 'text-[var(--c-text-muted)]'} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{option.label}</div>
                    <div className="text-xs text-[var(--c-text-muted)] mt-0.5">{option.desc}</div>
                  </div>
                  {isSelected && <Check size={16} className="text-[#00AF5C] flex-shrink-0" />}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Version Autocomplete ──────────────────────────────────────
function VersionAutocomplete({ value, onChange, serverType }) {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState(value || '');
  const [highlightedIdx, setHighlightedIdx] = useState(-1);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const containerRef = useRef(null);

  // Fetch versions when server type changes
  useEffect(() => {
    setLoading(true);
    setVersions([]);
    setSearch('');
    onChange('');
    setHighlightedIdx(-1);

    fetch(`http://localhost:3001/api/versions/${serverType}`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          setVersions(data);
          // Auto-select first version
          if (data.length > 0) {
            setSearch(data[0]);
            onChange(data[0]);
          }
        }
      })
      .catch(() => setVersions([]))
      .finally(() => setLoading(false));
  }, [serverType]);

  const filteredVersions = versions.filter(v =>
    v.toLowerCase().includes(search.toLowerCase())
  );

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIdx >= 0 && listRef.current) {
      const items = listRef.current.children;
      if (items[highlightedIdx]) {
        items[highlightedIdx].scrollIntoView({ block: 'nearest' });
      }
    }
  }, [highlightedIdx]);

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIsOpen(true);
      setHighlightedIdx(prev => Math.min(prev + 1, filteredVersions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIdx(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedIdx >= 0 && filteredVersions[highlightedIdx]) {
        selectVersion(filteredVersions[highlightedIdx]);
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  const selectVersion = (ver) => {
    setSearch(ver);
    onChange(ver);
    setIsOpen(false);
    setHighlightedIdx(-1);
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            onChange(e.target.value);
            setIsOpen(true);
            setHighlightedIdx(-1);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={loading ? 'Loading versions...' : 'Search versions...'}
          className="w-full bg-[var(--c-base)] border border-[var(--c-border)] focus:border-[#00AF5C] rounded-2xl pl-4 pr-10 py-3 text-[var(--c-text-primary)] outline-none transition-all focus:ring-4 focus:ring-[#00AF5C]/10 font-medium placeholder-[var(--c-text-muted)]"
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          {loading ? (
            <Loader2 size={16} className="text-[#00AF5C] animate-spin" />
          ) : (
            <Search size={16} className="text-[var(--c-text-muted)]" />
          )}
        </div>
      </div>

      <AnimatePresence>
        {isOpen && !loading && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute z-50 w-full mt-2 bg-[var(--c-surface-1)] border border-[var(--c-border)] rounded-2xl shadow-[0_12px_40px_rgba(0,0,0,0.6)] overflow-hidden"
          >
            <div ref={listRef} className="max-h-48 overflow-y-auto custom-scrollbar">
              {filteredVersions.length > 0 ? (
                filteredVersions.map((ver, idx) => (
                  <button
                    key={ver}
                    type="button"
                    onClick={() => selectVersion(ver)}
                    className={`w-full text-left px-4 py-2.5 text-sm font-medium transition-all outline-none flex items-center justify-between ${
                      ver === value
                        ? 'bg-[#00AF5C]/10 text-[#00AF5C]'
                        : idx === highlightedIdx
                        ? 'bg-[var(--c-border)] text-[var(--c-text-primary)]'
                        : 'text-[var(--c-text-secondary)] hover:bg-[var(--c-border)] hover:text-[var(--c-text-primary)]'
                    }`}
                  >
                    <span>{ver}</span>
                    {ver === value && <Check size={14} className="text-[#00AF5C]" />}
                  </button>
                ))
              ) : (
                <div className="px-4 py-6 text-center text-sm text-[var(--c-text-muted)]">
                  No versions found for this server type.
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Create Server Modal ───────────────────────────────────────
function CreateServerModal({ onClose, onCreate, existingNames = [], requestJavaGate }) {
  const [formData, setFormData] = useState({
    name: '',
    type: 'vanilla',
    version: '',
    ram: 4, // single value — Xms and Xmx are set to the same number
    autoRestart: false,
    autoBackup: false,
    backupIntervalHours: 6,
    keepLastNBackups: 5,
  });
  const [submitting, setSubmitting] = useState(false);
  const [nameError, setNameError] = useState('');
  const [backupPanelOverflow, setBackupPanelOverflow] = useState('hidden');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.name.trim() || !formData.version || submitting) return;

    if (existingNames.includes(formData.name.trim().toLowerCase())) {
      setNameError('A server with this name already exists.');
      return;
    }

    setSubmitting(true);
    try {
      // Java gate runs only now (after the user picked a version) instead of
      // before the modal opens — so a 1.20.4 server on Java 21 doesn't get
      // walled off by a Java-25 check it doesn't actually need.
      if (requestJavaGate) {
        try {
          const res = await fetch(
            `http://localhost:3001/api/java-status?version=${encodeURIComponent(formData.version)}`
          );
          const status = await res.json();
          if (!status.ok) {
            const proceed = await requestJavaGate({
              installedVersion: status.version,
              requiredMajor: status.requiredMajor,
              mcVersion: formData.version,
            });
            if (!proceed) {
              setSubmitting(false);
              return;
            }
          }
        } catch {
          // If java-status itself fails (e.g. backend hiccup) don't block — let
          // the start-time check catch a real mismatch later.
        }
      }

      await onCreate({
        name: formData.name.trim(),
        type: formData.type,
        version: formData.version,
        minRam: formData.ram + 'G',
        maxRam: formData.ram + 'G',
        autoRestart: formData.autoRestart,
        autoBackup: formData.autoBackup,
        backupIntervalHours: formData.backupIntervalHours,
        keepLastNBackups: formData.keepLastNBackups,
      });
    } catch {
      // error already shown by App.jsx via showError
    } finally {
      setSubmitting(false);
    }
  };

  const handleRamChange = (val) => {
    setFormData(prev => ({ ...prev, ram: parseInt(val) }));
  };

  const ramMax = useSystemRam(RAM_MAX_FALLBACK);
  const ramPercent = ((formData.ram - RAM_MIN) / (ramMax - RAM_MIN)) * 100;

  const fieldVariants = {
    hidden: { opacity: 0, y: 10 },
    visible: (i) => ({
      opacity: 1,
      y: 0,
      transition: { delay: i * 0.05, duration: 0.3, ease: 'easeOut' }
    })
  };

  return (
    <ModalPortal>
    <div className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-center px-4" style={{ top: TITLEBAR_OFFSET }}>
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 bg-[#000000]/70 backdrop-blur-sm"
        onClick={onClose}
      />
      
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ type: 'spring', duration: 0.5, bounce: 0.15 }}
        className="relative w-full max-w-xl bg-[var(--c-surface-2)] border border-[var(--c-border)] rounded-3xl shadow-[0_20px_60px_rgba(0,0,0,0.5)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-8 py-6 border-b border-[var(--c-border)]">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-[#00AF5C]/10 text-[#00AF5C] rounded-xl">
              <ServerIcon size={24} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-[var(--c-text-primary)]">Create New Server</h2>
              <p className="text-sm font-medium text-[var(--c-text-secondary)]">Configure your local instance</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-border)] rounded-xl transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          {/* Server Name */}
          <motion.div
            custom={0}
            variants={fieldVariants}
            initial="hidden"
            animate="visible"
            className="space-y-2"
          >
            <label className="text-sm font-bold text-[var(--c-text-primary)]">Server Name</label>
            <input
              type="text"
              required
              placeholder="e.g. Create SMP, Survival 1.20..."
              value={formData.name}
              onChange={(e) => {
                setFormData({ ...formData, name: e.target.value });
                if (nameError) setNameError('');
              }}
              disabled={submitting}
              className={`w-full bg-[var(--c-base)] border ${nameError ? 'border-[var(--c-danger)] focus:border-[var(--c-danger)] focus:ring-[var(--c-danger)]/10' : 'border-[var(--c-border)] focus:border-[#00AF5C] focus:ring-[#00AF5C]/10'} rounded-2xl px-4 py-3 text-[var(--c-text-primary)] outline-none transition-all focus:ring-4 font-medium placeholder-[var(--c-text-muted)] disabled:opacity-50`}
            />
            {nameError && (
              <p className="text-xs text-[var(--c-danger)] font-medium mt-1">{nameError}</p>
            )}
          </motion.div>

          {/* Server Type & Version */}
          <motion.div
            custom={1}
            variants={fieldVariants}
            initial="hidden"
            animate="visible"
            className="grid grid-cols-2 gap-6"
          >
            <div className="space-y-2">
              <label className="text-sm font-bold text-[var(--c-text-primary)] flex items-center gap-2">
                <Box size={16} className="text-[var(--c-text-secondary)]" />
                Server Type
              </label>
              <CustomDropdown
                value={formData.type}
                onChange={(type) => setFormData(prev => ({ ...prev, type }))}
                options={SERVER_TYPES}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-bold text-[var(--c-text-primary)] flex items-center gap-2">
                <Zap size={16} className="text-[var(--c-text-secondary)]" />
                Version
              </label>
              <VersionAutocomplete
                value={formData.version}
                onChange={(version) => setFormData(prev => ({ ...prev, version }))}
                serverType={formData.type}
              />
            </div>
          </motion.div>

          {/* RAM Slider — single value, applied to both Xms and Xmx */}
          <motion.div
            custom={2}
            variants={fieldVariants}
            initial="hidden"
            animate="visible"
            className="space-y-3"
          >
            <div className="flex items-center justify-between">
              <label className="text-sm font-bold text-[var(--c-text-primary)] flex items-center gap-2">
                <Cpu size={16} className="text-[var(--c-text-secondary)]" />
                Memory
              </label>
              <span className="text-sm font-bold text-[#00AF5C] bg-[#00AF5C]/10 px-3 py-1 rounded-lg tabular-nums">{formData.ram} GB</span>
            </div>
            <input
              type="range"
              min={RAM_MIN}
              max={ramMax}
              step={1}
              value={formData.ram}
              onChange={(e) => handleRamChange(e.target.value)}
              style={{ '--fill': `${ramPercent}%` }}
              className="w-full ram-slider"
            />
            <div className="flex justify-between text-xs text-[var(--c-text-muted)] px-0.5">
              <span>{RAM_MIN} GB</span>
              <span>{ramMax} GB</span>
            </div>
          </motion.div>

          {/* Auto-Restart */}
          <motion.div
            custom={3}
            variants={fieldVariants}
            initial="hidden"
            animate="visible"
            className="space-y-4 border-t border-[var(--c-border)] pt-4"
          >
            <div className="flex items-center gap-3">
              <label className="custom-checkbox-wrapper">
                <input
                  type="checkbox"
                  id="autoRestart"
                  checked={formData.autoRestart}
                  onChange={(e) => setFormData({ ...formData, autoRestart: e.target.checked })}
                  className="custom-checkbox"
                />
                <span className="custom-checkbox-visual" />
              </label>
              <label htmlFor="autoRestart" className="text-sm font-bold text-[var(--c-text-primary)] cursor-pointer select-none">
                Auto-Restart Server on Crash
              </label>
            </div>

            {/* Auto-Backup */}
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <label className="custom-checkbox-wrapper">
                  <input
                    type="checkbox"
                    id="autoBackup"
                    checked={formData.autoBackup}
                    onChange={(e) => setFormData({ ...formData, autoBackup: e.target.checked })}
                    className="custom-checkbox"
                  />
                  <span className="custom-checkbox-visual" />
                </label>
                <label htmlFor="autoBackup" className="text-sm font-bold text-[var(--c-text-primary)] cursor-pointer select-none">
                  Auto-Backup World
                </label>
              </div>

              <AnimatePresence>
                {formData.autoBackup && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: 'easeInOut' }}
                    onAnimationStart={() => setBackupPanelOverflow('hidden')}
                    onAnimationComplete={(def) => {
                      if (def?.height === 'auto') setBackupPanelOverflow('visible');
                    }}
                    style={{ overflow: backupPanelOverflow }}
                    className="grid grid-cols-2 gap-4 pl-7"
                  >
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-[var(--c-text-secondary)]">Backup every</label>
                      <OptionDropdown
                        value={formData.backupIntervalHours}
                        onChange={(v) => setFormData({ ...formData, backupIntervalHours: Number(v) })}
                        options={[
                          { value: 1, label: '1 hour' },
                          { value: 2, label: '2 hours' },
                          { value: 6, label: '6 hours' },
                          { value: 12, label: '12 hours' },
                          { value: 24, label: '24 hours' },
                        ]}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-[var(--c-text-secondary)]">Keep last</label>
                      <OptionDropdown
                        value={formData.keepLastNBackups}
                        onChange={(v) => setFormData({ ...formData, keepLastNBackups: Number(v) })}
                        options={[
                          { value: 3, label: '3 backups' },
                          { value: 5, label: '5 backups' },
                          { value: 10, label: '10 backups' },
                          { value: 0, label: 'All backups' },
                        ]}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>

          {/* Actions */}
          <motion.div
            custom={4}
            variants={fieldVariants}
            initial="hidden"
            animate="visible"
            className="pt-4 flex justify-end gap-3 border-t border-[var(--c-border)] mt-6"
          >
            <button
              type="button"
              onClick={onClose}
              className="px-6 py-2.5 text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-border)] rounded-2xl font-bold transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!formData.name.trim() || !formData.version || submitting}
              className="px-8 py-2.5 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-2xl font-bold transition-all duration-200 shadow-[0_4px_12px_rgba(0,175,92,0.2)] hover:shadow-[0_4px_20px_rgba(0,175,92,0.35)] hover:scale-[1.02] active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 disabled:hover:scale-100 flex items-center gap-2"
            >
              {submitting && <Loader2 size={16} className="animate-spin" />}
              {submitting ? 'Creating...' : 'Create Server'}
            </button>
          </motion.div>
        </form>
      </motion.div>
    </div>
    </ModalPortal>
  );
}

export default CreateServerModal;
