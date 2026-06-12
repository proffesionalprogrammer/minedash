import React, { useState, useEffect, useRef } from 'react';
import { Settings, MemoryStick, Monitor, Coffee, EyeOff, Eye, FlaskConical, HardDriveDownload, Loader2, Sparkles, ChevronUp, ChevronDown, Compass } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Tooltip from './Tooltip';

// Branded number input — replaces the OS-default spinner arrows (which render
// in light grey and clash with the dark theme) with stacked chevron buttons
// that match the rest of the kit. `step` defaults to 1.
function NumberInput({ value, onChange, min, step = 1, disabled }) {
  const clamp = (n) => (typeof min === 'number' && n < min ? min : n);
  const bump = (delta) => onChange(clamp(Number(value || 0) + delta));
  return (
    <div className={`relative w-full ${disabled ? 'opacity-40' : ''}`}>
      <input
        type="number" min={min} step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        className="branded-number w-full bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] rounded-xl pl-3 pr-8 py-2 text-sm text-[#FFFFFF] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all tabular-nums"
      />
      <div className="absolute right-1 top-1 bottom-1 flex flex-col gap-0.5 pointer-events-none">
        <button
          type="button"
          tabIndex={-1}
          onClick={() => bump(step)}
          disabled={disabled}
          className="pointer-events-auto flex-1 px-1.5 flex items-center justify-center rounded-md text-[#555555] hover:text-[#00AF5C] hover:bg-[#00AF5C]/10 transition-colors disabled:hover:bg-transparent disabled:hover:text-[#555555]"
        >
          <ChevronUp size={10} strokeWidth={3} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          onClick={() => bump(-step)}
          disabled={disabled}
          className="pointer-events-auto flex-1 px-1.5 flex items-center justify-center rounded-md text-[#555555] hover:text-[#00AF5C] hover:bg-[#00AF5C]/10 transition-colors disabled:hover:bg-transparent disabled:hover:text-[#555555]"
        >
          <ChevronDown size={10} strokeWidth={3} />
        </button>
      </div>
    </div>
  );
}

const DEFAULTS = {
  ramGb: 4,
  windowWidth: 925,
  windowHeight: 530,
  fullscreen: false,
  javaPath: '',
  afterLaunch: 'hide',
  showSnapshots: false,
  onlyInstalled: false,
};

export default function SettingsMenu({ settings, onChange, onError }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(settings || DEFAULTS);
  const [saving, setSaving] = useState(false);
  // App version pulled from Electron via preload. In dev mode (no electronAPI)
  // we just show "dev build" — there's no meaningful package version there.
  const [appVersion, setAppVersion] = useState(null);
  const wrapperRef = useRef(null);
  const saveTimer = useRef(null);

  useEffect(() => { if (settings) setDraft(settings); }, [settings]);
  useEffect(() => {
    const api = window.electronAPI;
    if (api?.getAppVersion) {
      api.getAppVersion().then(v => setAppVersion(v)).catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Debounced auto-save: persist 350ms after the last edit so the user
  // doesn't need a Save button. (Matches the kit's "live" feel.)
  const commit = (next) => {
    setDraft(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        const r = await fetch('http://localhost:3001/api/launcher/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Failed to save settings');
        onChange?.(d);
      } catch (err) {
        onError?.(err.message);
      }
      setSaving(false);
    }, 350);
  };

  const ramPercent = Math.round(((draft.ramGb - 1) / (16 - 1)) * 100);

  return (
    <div className="relative" ref={wrapperRef}>
      <Tooltip content="Settings" side="bottom" align="end">
        <motion.button
          onClick={() => setOpen(v => !v)}
          animate={{ rotate: open ? 45 : 0 }}
          whileHover={{ scale: 1.05, rotate: open ? 45 : 30 }}
          whileTap={{ scale: 0.95 }}
          transition={{ type: 'tween', duration: 0.08 }}
          className={`p-2.5 rounded-2xl border transition-all duration-200 ${
            open
              ? 'bg-[#00AF5C]/10 border-[#00AF5C]/30 text-[#00AF5C]'
              : 'bg-[#1E1E1E] border-[#2D2D2D] text-[#A0A0A0] hover:text-[#FFFFFF] hover:border-[#555555]'
          }`}
        >
          <Settings size={18} />
        </motion.button>
      </Tooltip>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ type: 'spring', duration: 0.25, bounce: 0.15 }}
            className="absolute right-0 mt-2 w-[min(440px,calc(100vw-2rem))] z-50 bg-[#1A1A1A] border border-[#2D2D2D] rounded-3xl shadow-[0_8px_30px_rgba(0,0,0,0.5)] overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#2D2D2D]">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-[#00AF5C]/10 rounded-xl"><Settings size={16} className="text-[#00AF5C]" /></div>
                <h3 className="text-base font-bold text-[#FFFFFF]">Settings</h3>
              </div>
              <AnimatePresence>
                {saving && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-[#555555]">
                    <Loader2 size={12} className="animate-spin" /> Saving
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="px-5 py-4 space-y-5 max-h-[70vh] overflow-y-auto custom-scrollbar">
              {/* RAM slider */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <MemoryStick size={14} className="text-[#00AF5C]" />
                    <label className="text-xs font-bold text-[#FFFFFF]">Memory (RAM)</label>
                  </div>
                  <span className="text-xs font-bold text-[#00AF5C] tabular-nums">{draft.ramGb} GB</span>
                </div>
                <input
                  type="range"
                  min={1} max={16} step={1}
                  value={draft.ramGb}
                  onChange={(e) => commit({ ...draft, ramGb: Number(e.target.value) })}
                  className="ram-slider w-full"
                  style={{ '--fill': `${ramPercent}%` }}
                />
                <div className="flex justify-between text-[10px] text-[#555555] mt-1 tabular-nums">
                  <span>1 GB</span><span>8 GB</span><span>16 GB</span>
                </div>
              </div>

              {/* Window size */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Monitor size={14} className="text-[#A0A0A0]" />
                  <label className="text-xs font-bold text-[#FFFFFF]">Window size</label>
                </div>
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                  <NumberInput
                    min={320}
                    value={draft.windowWidth}
                    onChange={(v) => commit({ ...draft, windowWidth: v })}
                    disabled={draft.fullscreen}
                  />
                  <span className="text-[#555555] text-xs font-bold">×</span>
                  <NumberInput
                    min={240}
                    value={draft.windowHeight}
                    onChange={(v) => commit({ ...draft, windowHeight: v })}
                    disabled={draft.fullscreen}
                  />
                </div>
                <label className="flex items-center gap-2 mt-2 cursor-pointer text-xs text-[#A0A0A0] hover:text-[#FFFFFF]">
                  <span className="custom-checkbox-wrapper">
                    <input type="checkbox" className="custom-checkbox"
                      checked={draft.fullscreen}
                      onChange={(e) => commit({ ...draft, fullscreen: e.target.checked })} />
                    <span className="custom-checkbox-visual" />
                  </span>
                  Launch in fullscreen
                </label>
              </div>

              {/* Java path */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Coffee size={14} className="text-[#A0A0A0]" />
                  <label className="text-xs font-bold text-[#FFFFFF]">Java executable</label>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Auto (use detected Java)"
                    value={draft.javaPath}
                    onChange={(e) => commit({ ...draft, javaPath: e.target.value })}
                    className="flex-1 bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] rounded-xl px-3 py-2 text-sm text-[#FFFFFF] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[#555555] font-mono"
                  />
                  {draft.javaPath && (
                    <button onClick={() => commit({ ...draft, javaPath: '' })}
                      className="px-3 py-2 bg-[#1E1E1E] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#A0A0A0] hover:text-[#FFFFFF] rounded-xl text-xs font-bold transition-all">
                      Auto
                    </button>
                  )}
                </div>
                <p className="text-[10px] text-[#555555] mt-1">Leave blank to auto-detect.</p>
              </div>

              {/* After launch */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  {draft.afterLaunch === 'hide' ? <EyeOff size={14} className="text-[#A0A0A0]" /> : <Eye size={14} className="text-[#A0A0A0]" />}
                  <label className="text-xs font-bold text-[#FFFFFF]">After launch</label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { key: 'hide', label: 'Hide MineDash' },
                    { key: 'keep', label: 'Keep open' },
                  ].map(opt => {
                    const active = draft.afterLaunch === opt.key;
                    return (
                      <button key={opt.key}
                        onClick={() => commit({ ...draft, afterLaunch: opt.key })}
                        className={`px-3 py-2 rounded-xl text-xs font-bold transition-all border ${
                          active
                            ? 'bg-[#00AF5C]/10 text-[#00AF5C] border-[#00AF5C]/30'
                            : 'bg-[#1E1E1E] text-[#A0A0A0] border-[#2D2D2D] hover:border-[#555555]'
                        }`}>
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Version list filters */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <FlaskConical size={14} className="text-[#A0A0A0]" />
                  <label className="text-xs font-bold text-[#FFFFFF]">Version list</label>
                </div>
                <label className="flex items-center gap-2 cursor-pointer text-xs text-[#A0A0A0] hover:text-[#FFFFFF]">
                  <span className="custom-checkbox-wrapper">
                    <input type="checkbox" className="custom-checkbox"
                      checked={draft.showSnapshots}
                      onChange={(e) => commit({ ...draft, showSnapshots: e.target.checked })} />
                    <span className="custom-checkbox-visual" />
                  </span>
                  Show snapshots (vanilla only)
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-xs text-[#A0A0A0] hover:text-[#FFFFFF]">
                  <span className="custom-checkbox-wrapper">
                    <input type="checkbox" className="custom-checkbox"
                      checked={draft.onlyInstalled}
                      onChange={(e) => commit({ ...draft, onlyInstalled: e.target.checked })} />
                    <span className="custom-checkbox-visual" />
                  </span>
                  Only show installed versions
                </label>
              </div>

              {/* "What's new" — re-opens the changelog popup on demand. Useful
                  for anyone who missed it (in particular the v1.0.2 cohort —
                  the popup itself shipped in v1.0.2, so upgrading from v1.0.1
                  triggered the fresh-install silent-skip path). */}
              {window.electronAPI?.getAppVersion && (
                <button
                  onClick={() => window.dispatchEvent(new CustomEvent('minedash-show-changelog'))}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-[#1E1E1E] hover:bg-[#2D2D2D] border border-[#2D2D2D] hover:border-[#00AF5C]/40 rounded-xl text-xs font-bold text-[#A0A0A0] hover:text-[#FFFFFF] transition-colors">
                  <Sparkles size={14} className="text-[#00AF5C]" />
                  What's new in this version
                </button>
              )}

              {/* Replay the first-run onboarding tour. App.jsx listens for
                  this custom event and flips showOnboarding back on. */}
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('minedash-show-onboarding'))}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-[#1E1E1E] hover:bg-[#2D2D2D] border border-[#2D2D2D] hover:border-[#00AF5C]/40 rounded-xl text-xs font-bold text-[#A0A0A0] hover:text-[#FFFFFF] transition-colors">
                <Compass size={14} className="text-[#00AF5C]" />
                Replay onboarding tour
              </button>

              {/* Version footer — small gray line so the user can tell what
                  build they're on without digging through About menus.
                  Mirrors VS Code / Discord conventions. */}
              <div className="border-t border-[#2D2D2D] pt-3 mt-1">
                <p className="text-[10px] uppercase tracking-wider font-bold text-[#555555] text-center">
                  MineDash {appVersion ? `v${appVersion}` : (window.electronAPI ? '' : 'dev build')}
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
