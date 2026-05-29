import React, { useState, useEffect, useRef } from 'react';
import {
  Settings, MemoryStick, Monitor, Coffee, EyeOff, Eye, FlaskConical,
  Loader2, Sparkles, ChevronUp, ChevronDown, Compass, SlidersHorizontal,
  Users, DownloadCloud, Info, Image, Check,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import AccountManager from './AccountManager';

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
          type="button" tabIndex={-1} onClick={() => bump(step)} disabled={disabled}
          className="pointer-events-auto flex-1 px-1.5 flex items-center justify-center rounded-md text-[#555555] hover:text-[#00AF5C] hover:bg-[#00AF5C]/10 transition-colors disabled:hover:bg-transparent disabled:hover:text-[#555555]"
        >
          <ChevronUp size={10} strokeWidth={3} />
        </button>
        <button
          type="button" tabIndex={-1} onClick={() => bump(-step)} disabled={disabled}
          className="pointer-events-auto flex-1 px-1.5 flex items-center justify-center rounded-md text-[#555555] hover:text-[#00AF5C] hover:bg-[#00AF5C]/10 transition-colors disabled:hover:bg-transparent disabled:hover:text-[#555555]"
        >
          <ChevronDown size={10} strokeWidth={3} />
        </button>
      </div>
    </div>
  );
}

// Small labelled toggle row reused across the General section.
function CheckRow({ checked, onChange, children }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer text-sm text-[#A0A0A0] hover:text-[#FFFFFF]">
      <span className="custom-checkbox-wrapper">
        <input type="checkbox" className="custom-checkbox" checked={checked} onChange={onChange} />
        <span className="custom-checkbox-visual" />
      </span>
      {children}
    </label>
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
  elybySkins: true,
};

const SECTIONS = [
  { key: 'general',  label: 'General',  icon: SlidersHorizontal },
  { key: 'java',     label: 'Java',     icon: Coffee },
  { key: 'accounts', label: 'Accounts', icon: Users },
  { key: 'updates',  label: 'Updates',  icon: DownloadCloud },
  { key: 'about',    label: 'About',    icon: Info },
];

// Card shell used by every settings group on the right pane.
function Group({ icon: Icon, title, hint, children }) {
  return (
    <div className="bg-[#1E1E1E] border border-[#2D2D2D] rounded-2xl p-5">
      <div className="flex items-center gap-2 mb-1">
        {Icon && <Icon size={16} className="text-[#00AF5C]" />}
        <h3 className="text-sm font-bold text-[#FFFFFF]">{title}</h3>
      </div>
      {hint && <p className="text-xs text-[#A0A0A0] mb-4">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </div>
  );
}

export default function SettingsPage({ settings, onChange, onError, accountProps }) {
  const [section, setSection] = useState('general');
  const [draft, setDraft] = useState(settings || DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [appVersion, setAppVersion] = useState(null);
  const saveTimer = useRef(null);

  useEffect(() => { if (settings) setDraft(settings); }, [settings]);
  useEffect(() => {
    const api = window.electronAPI;
    if (api?.getAppVersion) api.getAppVersion().then(v => setAppVersion(v)).catch(() => {});
  }, []);

  // Debounced auto-save: persist 350ms after the last edit so the user doesn't
  // need a Save button. (Matches the launcher's "live" feel — carried over
  // verbatim from the old SettingsMenu dropdown.)
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
  const versionLabel = appVersion ? `v${appVersion}` : (window.electronAPI ? '' : 'dev build');

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar">
      <div className="max-w-5xl mx-auto w-full px-6 md:px-10 py-8">
        <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-6">
          {/* Left rail */}
          <nav className="flex md:flex-col gap-1.5 flex-wrap md:sticky md:top-0 md:self-start">
            {SECTIONS.map(s => {
              const Icon = s.icon;
              const active = section === s.key;
              return (
                <button
                  key={s.key}
                  onClick={() => setSection(s.key)}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-bold transition-all text-left ${
                    active
                      ? 'bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/30'
                      : 'text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#1E1E1E] border border-transparent'
                  }`}
                >
                  <Icon size={16} className={active ? 'text-[#00AF5C]' : 'text-[#555555]'} />
                  {s.label}
                </button>
              );
            })}
            <AnimatePresence>
              {saving && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="flex items-center gap-1.5 px-3 py-2 text-[10px] uppercase tracking-wider font-bold text-[#555555]">
                  <Loader2 size={12} className="animate-spin" /> Saving
                </motion.div>
              )}
            </AnimatePresence>
          </nav>

          {/* Right pane */}
          <AnimatePresence mode="wait">
            <motion.div
              key={section}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18 }}
              className="space-y-5 min-w-0"
            >
              {section === 'general' && (
                <>
                  <Group icon={MemoryStick} title="Memory (RAM)" hint="How much RAM the launched game gets. Min == Max to avoid JVM heap-resize pauses.">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-[#A0A0A0]">Allocation</span>
                      <span className="text-xs font-bold text-[#00AF5C] tabular-nums">{draft.ramGb} GB</span>
                    </div>
                    <input
                      type="range" min={1} max={16} step={1}
                      value={draft.ramGb}
                      onChange={(e) => commit({ ...draft, ramGb: Number(e.target.value) })}
                      className="ram-slider w-full"
                      style={{ '--fill': `${ramPercent}%` }}
                    />
                    <div className="flex justify-between text-[10px] text-[#555555] mt-1 tabular-nums">
                      <span>1 GB</span><span>8 GB</span><span>16 GB</span>
                    </div>
                  </Group>

                  <Group icon={Monitor} title="Window size" hint="The initial Minecraft window dimensions.">
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                      <NumberInput min={320} value={draft.windowWidth}
                        onChange={(v) => commit({ ...draft, windowWidth: v })} disabled={draft.fullscreen} />
                      <span className="text-[#555555] text-xs font-bold">×</span>
                      <NumberInput min={240} value={draft.windowHeight}
                        onChange={(v) => commit({ ...draft, windowHeight: v })} disabled={draft.fullscreen} />
                    </div>
                    <div className="mt-3">
                      <CheckRow checked={draft.fullscreen} onChange={(e) => commit({ ...draft, fullscreen: e.target.checked })}>
                        Launch in fullscreen
                      </CheckRow>
                    </div>
                  </Group>

                  <Group icon={draft.afterLaunch === 'hide' ? EyeOff : Eye} title="After launch" hint="What MineDash does once the game window opens.">
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
                              active ? 'bg-[#00AF5C]/10 text-[#00AF5C] border-[#00AF5C]/30'
                                : 'bg-[#111111] text-[#A0A0A0] border-[#2D2D2D] hover:border-[#555555]'
                            }`}>
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </Group>

                  <Group icon={Image} title="Skins" hint="Cosmetic only — affects how player heads are displayed in MineDash, never how the game launches.">
                    <CheckRow checked={draft.elybySkins !== false}
                      onChange={(e) => commit({ ...draft, elybySkins: e.target.checked })}>
                      Use Ely.by skins for offline accounts
                    </CheckRow>
                  </Group>

                  <Group icon={FlaskConical} title="Version list" hint="Filters applied to the version picker in the Launcher.">
                    <div className="space-y-2.5">
                      <CheckRow checked={draft.showSnapshots} onChange={(e) => commit({ ...draft, showSnapshots: e.target.checked })}>
                        Show snapshots (vanilla only)
                      </CheckRow>
                      <CheckRow checked={draft.onlyInstalled} onChange={(e) => commit({ ...draft, onlyInstalled: e.target.checked })}>
                        Only show installed versions
                      </CheckRow>
                    </div>
                  </Group>

                  <Group icon={Compass} title="Onboarding">
                    <button
                      onClick={() => window.dispatchEvent(new CustomEvent('minedash-show-onboarding'))}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-[#111111] hover:bg-[#2D2D2D] border border-[#2D2D2D] hover:border-[#00AF5C]/40 rounded-xl text-xs font-bold text-[#A0A0A0] hover:text-[#FFFFFF] transition-colors">
                      <Compass size={14} className="text-[#00AF5C]" /> Replay onboarding tour
                    </button>
                  </Group>
                </>
              )}

              {section === 'java' && (
                <Group icon={Coffee} title="Java executable" hint="Leave blank to auto-detect. MineDash searches JAVA_HOME, PATH, the registry, and its managed runtimes pool.">
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
                        className="px-3 py-2 bg-[#111111] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#A0A0A0] hover:text-[#FFFFFF] rounded-xl text-xs font-bold transition-all">
                        Auto
                      </button>
                    )}
                  </div>
                </Group>
              )}

              {section === 'accounts' && (
                <AccountManager {...accountProps} />
              )}

              {section === 'updates' && (
                <>
                  <Group icon={DownloadCloud} title="Updates" hint="MineDash checks for updates on launch and downloads them in the background. You'll get a prompt to relaunch when one is ready — an in-progress launch or server is never interrupted.">
                    <div className="flex items-center gap-2 px-3 py-2.5 bg-[#111111] border border-[#2D2D2D] rounded-xl">
                      <Check size={14} className="text-[#00AF5C]" />
                      <span className="text-sm font-bold text-[#FFFFFF]">MineDash {versionLabel || '(current)'}</span>
                    </div>
                  </Group>
                  {window.electronAPI?.getAppVersion && (
                    <Group icon={Sparkles} title="Release notes">
                      <button
                        onClick={() => window.dispatchEvent(new CustomEvent('minedash-show-changelog'))}
                        className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-[#111111] hover:bg-[#2D2D2D] border border-[#2D2D2D] hover:border-[#00AF5C]/40 rounded-xl text-xs font-bold text-[#A0A0A0] hover:text-[#FFFFFF] transition-colors">
                        <Sparkles size={14} className="text-[#00AF5C]" /> What's new in this version
                      </button>
                    </Group>
                  )}
                </>
              )}

              {section === 'about' && (
                <Group icon={Info} title="About MineDash">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="p-2.5 bg-[#00AF5C]/10 rounded-2xl">
                      <Settings size={22} className="text-[#00AF5C]" />
                    </div>
                    <div>
                      <p className="text-lg font-black text-[#FFFFFF] leading-tight">MineDash</p>
                      <p className="text-xs text-[#A0A0A0] tabular-nums">{versionLabel || 'local build'}</p>
                    </div>
                  </div>
                  <p className="text-sm text-[#A0A0A0] leading-relaxed">
                    A local Minecraft server manager and launcher. Run servers on your own PC, manage
                    mods, backups and networking, and launch the game — all from one app.
                  </p>
                </Group>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
