import React, { useState, useEffect, useRef } from 'react';
import {
  Settings, MemoryStick, Monitor, Coffee, FlaskConical,
  Loader2, Sparkles, ChevronUp, ChevronDown, Compass, SlidersHorizontal,
  Users, DownloadCloud, Info, Image, Check, HardDrive, FolderOpen,
  AlertTriangle, RotateCcw, RefreshCw, FolderCog,
  Palette, Sun, Moon, Contrast,
  Gamepad2, Terminal, Braces, Maximize2, Plus, X, Trash2,
  Wrench, Clock, SquareTerminal,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSystemRam } from '../hooks/useSystemRam';
import AccountManager from './AccountManager';
import ChoiceRow from './JavaChoiceRow';

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
        className="branded-number w-full bg-[var(--c-base)] border border-[var(--c-border)] focus:border-[#00AF5C] rounded-xl pl-3 pr-8 py-2 text-sm text-[var(--c-text-primary)] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all tabular-nums"
      />
      <div className="absolute right-1 top-1 bottom-1 flex flex-col gap-0.5 pointer-events-none">
        <button
          type="button" tabIndex={-1} onClick={() => bump(step)} disabled={disabled}
          className="pointer-events-auto flex-1 px-1.5 flex items-center justify-center rounded-md text-[var(--c-text-muted)] hover:text-[#00AF5C] hover:bg-[#00AF5C]/10 transition-colors disabled:hover:bg-transparent disabled:hover:text-[var(--c-text-muted)]"
        >
          <ChevronUp size={10} strokeWidth={3} />
        </button>
        <button
          type="button" tabIndex={-1} onClick={() => bump(-step)} disabled={disabled}
          className="pointer-events-auto flex-1 px-1.5 flex items-center justify-center rounded-md text-[var(--c-text-muted)] hover:text-[#00AF5C] hover:bg-[#00AF5C]/10 transition-colors disabled:hover:bg-transparent disabled:hover:text-[var(--c-text-muted)]"
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
    <label className="flex items-center gap-2 cursor-pointer text-sm text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)]">
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
  theme: 'dark',
  quitOnGameClose: false,
  preLaunchCommand: '',
  postExitCommand: '',
  gameEnv: [],
  recordPlaytime: true,
  showPlaytime: true,
  showTotalPlaytime: true,
  durationsInHours: false,
  consoleShowOnLaunch: false,
  consoleShowOnCrash: true,
  consoleHideOnExit: false,
  useSystemGlfw: false,
  glfwPath: '',
  useSystemOpenal: false,
  openalPath: '',
};

const SECTIONS = [
  { key: 'general',    label: 'General',    icon: SlidersHorizontal },
  { key: 'minecraft',  label: 'Minecraft',  icon: Gamepad2 },
  { key: 'appearance', label: 'Appearance', icon: Palette },
  { key: 'java',       label: 'Java',       icon: Coffee },
  { key: 'storage',    label: 'Storage',    icon: HardDrive },
  { key: 'accounts',   label: 'Accounts',   icon: Users },
  { key: 'updates',    label: 'Updates',    icon: DownloadCloud },
  { key: 'about',      label: 'About',      icon: Info },
];

// Settings → Appearance. Colour-theme picker. Each card renders a static
// mini-mockup in that theme's OWN palette (literal hexes on purpose) so the
// swatches read correctly no matter which theme is currently applied.
const DARK_SWATCH  = { bg: '#111111', card: '#1E1E1E', line: '#2D2D2D' };
const LIGHT_SWATCH = { bg: '#EBEBEB', card: '#FFFFFF', line: '#C4C4C8' };
const OLED_SWATCH  = { bg: '#000000', card: '#141414', line: '#262626' };

const THEME_OPTIONS = [
  { key: 'system', label: 'Sync with system', icon: Monitor },               // no swatch => split preview
  { key: 'light',  label: 'Light',            icon: Sun,      swatch: LIGHT_SWATCH },
  { key: 'dark',   label: 'Dark',             icon: Moon,     swatch: DARK_SWATCH },
  { key: 'oled',   label: 'OLED',             icon: Contrast, swatch: OLED_SWATCH },
];

function MiniMock({ swatch }) {
  return (
    <div className="h-full w-full flex items-center gap-2 px-2.5" style={{ background: swatch.bg }}>
      <div className="w-6 h-6 rounded-md flex-shrink-0" style={{ background: swatch.card }} />
      <div className="flex-1 space-y-1.5 min-w-0">
        <div className="h-2 rounded-full" style={{ background: swatch.card, width: '100%' }} />
        <div className="h-2 rounded-full" style={{ background: swatch.line, width: '66%' }} />
      </div>
    </div>
  );
}

function ThemeCard({ option, active, onSelect }) {
  const { label, icon: Icon, swatch } = option;
  return (
    <button
      onClick={onSelect}
      className={`group relative rounded-xl overflow-hidden border-2 text-left transition-all ${
        active ? 'border-[#00AF5C]' : 'border-[var(--c-border)] hover:border-[var(--c-text-muted)]'
      }`}
    >
      <div className="h-16">
        {swatch ? (
          <MiniMock swatch={swatch} />
        ) : (
          // "Sync with system": show dark + light side by side.
          <div className="grid grid-cols-2 h-full">
            <MiniMock swatch={DARK_SWATCH} />
            <MiniMock swatch={LIGHT_SWATCH} />
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 px-3 py-2.5 border-t border-[var(--c-border)] bg-[var(--c-surface-2)]">
        <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
          active ? 'border-[#00AF5C]' : 'border-[var(--c-text-muted)]'
        }`}>
          {active && <span className="w-2 h-2 rounded-full bg-[#00AF5C]" />}
        </span>
        <span className={`text-xs font-bold truncate ${active ? 'text-[var(--c-text-primary)]' : 'text-[var(--c-text-secondary)]'}`}>
          {label}
        </span>
        <Icon size={13} className="ml-auto flex-shrink-0 text-[var(--c-text-muted)]" />
      </div>
    </button>
  );
}

function AppearanceSection({ draft, commit }) {
  const current = draft.theme || 'dark';
  return (
    <Group icon={Palette} title="Color theme"
      hint="Choose how MineDash looks. “Sync with system” follows your operating system's light/dark setting and updates automatically.">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {THEME_OPTIONS.map(opt => (
          <ThemeCard
            key={opt.key}
            option={opt}
            active={current === opt.key}
            onSelect={() => commit({ ...draft, theme: opt.key })}
          />
        ))}
      </div>
    </Group>
  );
}

// Settings → Storage. Lets the user move all MineDash data (server instances,
// launcher game files, backups, managed Java runtimes) to another folder or
// drive. The backend does the move live and reports progress on the
// `storage_migration` socket channel; a restart applies the new paths.
function StorageSection({ socket, onError }) {
  const [loc, setLoc] = useState(null);        // { current, default, isCustom, migrating, pendingRestart }
  const [pathInput, setPathInput] = useState('');
  const [moving, setMoving] = useState(false);
  const [progress, setProgress] = useState(null); // { item, index, total }
  const [pendingRestart, setPendingRestart] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await fetch('http://localhost:3001/api/storage-location');
      const d = await r.json();
      setLoc(d);
      setPathInput(d.current);
      setMoving(!!d.migrating);
      setPendingRestart(d.pendingRestart || null);
    } catch { /* backend unreachable — leave the section in its loading state */ }
  };
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!socket) return;
    const handler = (p) => {
      if (p.event === 'progress') {
        setMoving(true);
        setProgress(p);
      } else if (p.event === 'done') {
        setMoving(false);
        setProgress(null);
        setPendingRestart(p.dataDir);
      } else if (p.event === 'error') {
        setMoving(false);
        setProgress(null);
        onError?.(`Storage move failed: ${p.message}`);
        load();
      }
    };
    socket.on('storage_migration', handler);
    return () => socket.off('storage_migration', handler);
  }, [socket, onError]);

  const startMove = async (dir) => {
    setBusy(true);
    try {
      const r = await fetch('http://localhost:3001/api/storage-location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataDir: dir }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to move data');
      setMoving(true);
      setProgress(null);
    } catch (err) {
      onError?.(err.message);
    }
    setBusy(false);
  };

  const browse = async () => {
    try {
      const p = await window.electronAPI.selectFolder();
      if (p) setPathInput(p);
    } catch { /* dialog dismissed or IPC unavailable — keep the typed path */ }
  };

  const restart = () => {
    if (window.electronAPI?.relaunchApp) window.electronAPI.relaunchApp();
  };

  if (!loc) {
    return (
      <Group icon={HardDrive} title="Storage location">
        <div className="flex items-center gap-2 text-xs text-[var(--c-text-muted)] font-bold">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      </Group>
    );
  }

  const dirty = pathInput.trim() !== '' && pathInput.trim() !== loc.current;

  return (
    <>
      <Group icon={HardDrive} title="Storage location"
        hint="Where MineDash keeps everything it downloads — game files, server instances, backups and managed Java runtimes. Move it to another drive if C: is filling up.">
        <div className="space-y-3">
          <div>
            <label className="text-xs font-bold text-[var(--c-text-secondary)] block mb-1.5">Data folder</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                disabled={moving || !!pendingRestart}
                placeholder={loc.default}
                spellCheck={false}
                className="flex-1 min-w-0 bg-[var(--c-base)] border border-[var(--c-border)] focus:border-[#00AF5C] rounded-xl px-3 py-2 text-sm text-[var(--c-text-primary)] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[var(--c-text-muted)] font-mono disabled:opacity-50"
              />
              {window.electronAPI?.selectFolder && (
                <button onClick={browse} disabled={moving || !!pendingRestart}
                  className="flex items-center gap-1.5 px-3 py-2 bg-[var(--c-base)] hover:bg-[var(--c-border)] border border-[var(--c-border)] hover:border-[var(--c-text-muted)] text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] rounded-xl text-xs font-bold transition-all disabled:opacity-50">
                  <FolderOpen size={14} /> Browse
                </button>
              )}
            </div>
            {loc.isCustom && (
              <p className="text-[11px] text-[var(--c-text-muted)] mt-1.5 font-medium">
                Default: <span className="font-mono">{loc.default}</span>
              </p>
            )}
          </div>

          {!moving && !pendingRestart && (
            <>
              <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-500/10 border border-amber-500/20 rounded-xl">
                <AlertTriangle size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-[11px] text-amber-400 leading-snug font-medium">
                  All servers must be stopped before moving. Everything is moved to the new
                  folder (this can take a while for large modpacks), then MineDash needs a restart.
                </p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => startMove(pathInput.trim())} disabled={!dirty || busy}
                  className="flex items-center gap-2 px-4 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-xs font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <HardDrive size={14} />}
                  Move data here
                </button>
                {loc.isCustom && (
                  <button onClick={() => startMove('')} disabled={busy}
                    className="flex items-center gap-2 px-4 py-2 bg-[var(--c-base)] hover:bg-[var(--c-border)] border border-[var(--c-border)] hover:border-[var(--c-text-muted)] text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] rounded-xl text-xs font-bold transition-all disabled:opacity-40">
                    <RotateCcw size={14} /> Move back to default
                  </button>
                )}
              </div>
            </>
          )}

          {moving && (
            <div className="px-3 py-3 bg-[var(--c-base)] border border-[var(--c-border)] rounded-xl">
              <div className="flex items-center gap-2 text-xs font-bold text-[var(--c-text-primary)]">
                <Loader2 size={14} className="animate-spin text-[#00AF5C]" />
                Moving data…
              </div>
              {progress && (
                <p className="text-[11px] text-[var(--c-text-secondary)] mt-1.5 font-medium tabular-nums">
                  {progress.index + 1} / {progress.total} · <span className="font-mono">{progress.item}</span>
                </p>
              )}
              <p className="text-[11px] text-[var(--c-text-muted)] mt-1.5 font-medium">
                Don't close MineDash while files are moving.
              </p>
            </div>
          )}

          {!moving && pendingRestart && (
            <div className="px-3 py-3 bg-[#00AF5C]/10 border border-[#00AF5C]/20 rounded-xl">
              <div className="flex items-center gap-2 text-xs font-bold text-[#00AF5C]">
                <Check size={14} /> Data moved
              </div>
              <p className="text-[11px] text-[var(--c-text-secondary)] mt-1.5 font-medium leading-snug">
                New location: <span className="font-mono">{pendingRestart}</span>
              </p>
              {window.electronAPI?.relaunchApp ? (
                <button onClick={restart}
                  className="flex items-center gap-2 px-4 py-2 mt-2.5 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-xs font-bold transition-all">
                  <RefreshCw size={14} /> Restart MineDash to apply
                </button>
              ) : (
                <p className="text-[11px] text-amber-400 mt-2 font-bold">
                  Restart the backend to apply the new location.
                </p>
              )}
            </div>
          )}
        </div>
      </Group>
    </>
  );
}

// Card shell used by every settings group on the right pane.
function Group({ icon: Icon, title, hint, children }) {
  return (
    <div className="bg-[var(--c-surface-2)] border border-[var(--c-border)] rounded-2xl p-5">
      <div className="flex items-center gap-2 mb-1">
        {Icon && <Icon size={16} className="text-[#00AF5C]" />}
        <h3 className="text-sm font-bold text-[var(--c-text-primary)]">{title}</h3>
      </div>
      {hint && <p className="text-xs text-[var(--c-text-secondary)] mb-4">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </div>
  );
}

// Settings → Java. The launcher's default Java for game launches (each instance
// can still override it from its own Java runtime picker). Mirrors the look of
// JavaRuntimeModal's row picker, but every non-auto choice is a real absolute
// path — the global override is stored as a literal path string and resolved by
// fs.existsSync at launch (see resolveLauncherJava), so it can't represent a
// "download-on-launch" major the way the per-instance picker can.
function JavaSection({ draft, commit }) {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  // Lets the Custom row stay selected (and its input shown) while the path is
  // still empty, before any auto/managed/system choice would otherwise win.
  const [customClicked, setCustomClicked] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('http://localhost:3001/api/launcher/java');
        const d = await r.json();
        if (r.ok) setInfo(d);
      } catch { /* options below degrade gracefully */ }
      setLoading(false);
    })();
  }, []);

  const current = (draft.javaPath || '').trim();
  const managed = info?.managed || [];
  const sys = info?.system?.path ? info.system : null;
  const isManaged = managed.some(m => m.path === current);
  const isSystem = sys && sys.path === current;
  const inferCustom = !!current && !isManaged && !isSystem;
  const selected = customClicked || inferCustom ? 'custom' : (!current ? 'auto' : current);

  const pick = (value) => { setCustomClicked(false); commit({ ...draft, javaPath: value }); };

  return (
    <Group icon={Coffee} title="Java runtime"
      hint="The default Java used to launch the game. Each instance can override this from its own Java runtime settings.">
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-[var(--c-text-muted)] font-bold">
          <Loader2 size={12} className="animate-spin" /> Checking installed runtimes…
        </div>
      ) : (
        <div className="space-y-1.5">
          <ChoiceRow
            active={selected === 'auto'}
            onSelect={() => pick('')}
            icon={Sparkles}
            title="Automatic (recommended)"
            subtitle="Detects Java from JAVA_HOME, PATH, the registry and MineDash's managed runtimes"
          />
          {managed.map(m => (
            <ChoiceRow
              key={m.path}
              active={selected === m.path}
              onSelect={() => pick(m.path)}
              icon={Coffee}
              title={`Java ${m.major}`}
              subtitle={m.path}
              badge={
                <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md bg-[var(--c-surface-1)] text-[var(--c-text-secondary)] border border-[var(--c-border)] flex-shrink-0">
                  Managed
                </span>
              }
            />
          ))}
          {sys && (
            <ChoiceRow
              active={selected === sys.path}
              onSelect={() => pick(sys.path)}
              icon={FolderCog}
              title={`System Java${sys.major ? ` ${sys.major}` : ''}`}
              subtitle={sys.path}
            />
          )}
          <ChoiceRow
            active={selected === 'custom'}
            onSelect={() => setCustomClicked(true)}
            icon={FolderCog}
            title="Custom path"
            subtitle="Point at any java.exe yourself"
          />
          {selected === 'custom' && (
            <input
              type="text"
              autoFocus
              value={draft.javaPath}
              onChange={(e) => commit({ ...draft, javaPath: e.target.value })}
              placeholder="C:\\Program Files\\Java\\jdk-21\\bin\\java.exe"
              className="w-full bg-[var(--c-base)] border border-[var(--c-border)] focus:border-[#00AF5C] rounded-xl px-3 py-2.5 text-sm text-[var(--c-text-primary)] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[var(--c-text-muted)] font-mono"
            />
          )}
        </div>
      )}
    </Group>
  );
}

// ─── Settings → Minecraft ────────────────────────────────────────────────────
// Prism-Launcher-style game settings, grouped into the same three tabs Prism
// uses (Game Window · Custom Commands · Environment Variables). Everything here
// feeds the launch worker (backend/launcher.js → runLaunch): window dims, the
// hide/quit launcher behavior, the pre-launch / post-exit shell hooks, and the
// per-launch environment variables injected into the game JVM.

const MC_TABS = [
  { key: 'general',  label: 'General',     icon: SlidersHorizontal },
  { key: 'tweaks',   label: 'Tweaks',      icon: Wrench },
  { key: 'commands', label: 'Commands',    icon: Terminal },
  { key: 'env',      label: 'Environment', icon: Braces },
];

// Monospace command / path input used by the Custom Commands tab.
function MonoInput({ value, onChange, placeholder }) {
  return (
    <input
      type="text"
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      className="w-full bg-[var(--c-base)] border border-[var(--c-border)] focus:border-[#00AF5C] rounded-xl px-3 py-2.5 text-sm text-[var(--c-text-primary)] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[var(--c-text-muted)] font-mono"
    />
  );
}

function GeneralPanel({ draft, commit }) {
  return (
    <>
      <Group icon={Maximize2} title="Window size" hint="The initial Minecraft window dimensions.">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <NumberInput min={320} value={draft.windowWidth}
            onChange={(v) => commit({ ...draft, windowWidth: v })} disabled={draft.fullscreen} />
          <span className="text-[var(--c-text-muted)] text-xs font-bold">×</span>
          <NumberInput min={240} value={draft.windowHeight}
            onChange={(v) => commit({ ...draft, windowHeight: v })} disabled={draft.fullscreen} />
        </div>
        <div className="mt-3">
          <CheckRow checked={draft.fullscreen} onChange={(e) => commit({ ...draft, fullscreen: e.target.checked })}>
            Launch in fullscreen
          </CheckRow>
        </div>
      </Group>

      <Group icon={Monitor} title="Launcher behavior" hint="What MineDash does around the game session.">
        <div className="space-y-2.5">
          <CheckRow
            checked={draft.afterLaunch === 'hide'}
            onChange={(e) => commit({ ...draft, afterLaunch: e.target.checked ? 'hide' : 'keep' })}>
            Hide MineDash to the tray when the game opens
          </CheckRow>
          <CheckRow
            checked={!!draft.quitOnGameClose}
            onChange={(e) => commit({ ...draft, quitOnGameClose: e.target.checked })}>
            Quit MineDash when the game closes
          </CheckRow>
        </div>
      </Group>

      <Group icon={SquareTerminal} title="Console window"
        hint="MineDash streams the game's live output to an in-app console. Choose when it opens on its own.">
        <div className="space-y-2.5">
          <CheckRow checked={!!draft.consoleShowOnLaunch}
            onChange={(e) => commit({ ...draft, consoleShowOnLaunch: e.target.checked })}>
            Show the console when the game launches
          </CheckRow>
          <CheckRow checked={draft.consoleShowOnCrash !== false}
            onChange={(e) => commit({ ...draft, consoleShowOnCrash: e.target.checked })}>
            Show the console when the game crashes
          </CheckRow>
          <CheckRow checked={!!draft.consoleHideOnExit}
            onChange={(e) => commit({ ...draft, consoleHideOnExit: e.target.checked })}>
            Hide the console when the game exits
          </CheckRow>
        </div>
      </Group>

      <Group icon={Clock} title="Game time" hint="Track how long you spend in each instance.">
        <div className="space-y-2.5">
          <CheckRow checked={draft.recordPlaytime !== false}
            onChange={(e) => commit({ ...draft, recordPlaytime: e.target.checked })}>
            Record time spent playing instances
          </CheckRow>
          <CheckRow checked={draft.showPlaytime !== false}
            onChange={(e) => commit({ ...draft, showPlaytime: e.target.checked })}>
            Show time spent on each instance
          </CheckRow>
          <CheckRow checked={draft.showTotalPlaytime !== false}
            onChange={(e) => commit({ ...draft, showTotalPlaytime: e.target.checked })}>
            Show the total time played across instances
          </CheckRow>
          <CheckRow checked={!!draft.durationsInHours}
            onChange={(e) => commit({ ...draft, durationsInHours: e.target.checked })}>
            Always show durations in hours
          </CheckRow>
        </div>
      </Group>
    </>
  );
}

function TweaksPanel({ draft, commit }) {
  return (
    <Group icon={Wrench} title="Native libraries"
      hint="Point the game at your system's GLFW / OpenAL libraries instead of the ones MineDash bundles. Advanced — only set this if you know you need it (e.g. a Linux/Wayland GLFW fix or a custom audio driver).">
      <div className="space-y-4">
        <div className="space-y-2.5">
          <CheckRow checked={!!draft.useSystemGlfw}
            onChange={(e) => commit({ ...draft, useSystemGlfw: e.target.checked })}>
            Use system installation of GLFW
          </CheckRow>
          {draft.useSystemGlfw && (
            <MonoInput value={draft.glfwPath}
              onChange={(v) => commit({ ...draft, glfwPath: v })}
              placeholder="Path to glfw library file (e.g. C:\\Windows\\System32\\glfw.dll)" />
          )}
        </div>
        <div className="space-y-2.5">
          <CheckRow checked={!!draft.useSystemOpenal}
            onChange={(e) => commit({ ...draft, useSystemOpenal: e.target.checked })}>
            Use system installation of OpenAL
          </CheckRow>
          {draft.useSystemOpenal && (
            <MonoInput value={draft.openalPath}
              onChange={(v) => commit({ ...draft, openalPath: v })}
              placeholder="Path to OpenAL library file (e.g. OpenAL32.dll)" />
          )}
        </div>
      </div>
    </Group>
  );
}

function CustomCommandsPanel({ draft, commit }) {
  const VARS = [
    ['$INST_NAME',   'Instance name'],
    ['$INST_ID',     'Instance ID (folder name)'],
    ['$INST_DIR',    'Absolute path of the instance'],
    ['$INST_MC_DIR', 'Absolute path of the .minecraft folder'],
    ['$INST_JAVA',   'Java binary used to launch'],
  ];
  return (
    <>
      <Group icon={Terminal} title="Pre-launch command"
        hint="Runs in your system shell before the game starts. A non-zero exit code cancels the launch.">
        <MonoInput value={draft.preLaunchCommand}
          onChange={(v) => commit({ ...draft, preLaunchCommand: v })}
          placeholder="e.g. python sync-mods.py" />
      </Group>

      <Group icon={Terminal} title="Post-exit command"
        hint="Runs once the game window closes — handy for cleanup or backups.">
        <MonoInput value={draft.postExitCommand}
          onChange={(v) => commit({ ...draft, postExitCommand: v })}
          placeholder="e.g. python backup-world.py" />
      </Group>

      <Group icon={Info} title="Available variables"
        hint="Both commands are run with these environment variables set:">
        <div className="space-y-1.5">
          {VARS.map(([name, desc]) => (
            <div key={name} className="flex items-center gap-3 text-xs">
              <code className="font-mono font-bold text-[#00AF5C] bg-[#00AF5C]/10 border border-[#00AF5C]/20 rounded-md px-1.5 py-0.5 whitespace-nowrap">{name}</code>
              <span className="text-[var(--c-text-secondary)]">{desc}</span>
            </div>
          ))}
        </div>
      </Group>
    </>
  );
}

function EnvVarsPanel({ draft, commit }) {
  // Local working copy so a half-typed row (empty name) doesn't vanish when the
  // backend filters unnamed rows out on save. Seeded once on mount — this panel
  // owns env editing while it's open.
  const [rows, setRows] = useState(() =>
    (Array.isArray(draft.gameEnv) ? draft.gameEnv : []).map(e => ({ name: e?.name || '', value: e?.value || '' }))
  );

  // Persist only well-formed rows (non-empty name); keep empties locally so the
  // user can type a name after adding the row.
  const persist = (next) =>
    commit({ ...draft, gameEnv: next.filter(r => r.name.trim()).map(r => ({ name: r.name.trim(), value: r.value })) });

  const update = (i, key, val) => {
    const next = rows.map((r, idx) => (idx === i ? { ...r, [key]: val } : r));
    setRows(next); persist(next);
  };
  const add = () => setRows([...rows, { name: '', value: '' }]); // unnamed → not persisted yet
  const remove = (i) => { const next = rows.filter((_, idx) => idx !== i); setRows(next); persist(next); };
  const clearAll = () => { setRows([]); persist([]); };

  return (
    <Group icon={Braces} title="Environment variables"
      hint="Passed to the game's Java process when it launches. Useful for things like __GL_THREADED_OPTIMIZATIONS or MESA_GL_VERSION_OVERRIDE.">
      {rows.length > 0 && (
        <div className="space-y-2 mb-3">
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2 px-1">
            <span className="text-[10px] uppercase tracking-wider font-bold text-[var(--c-text-muted)]">Name</span>
            <span className="text-[10px] uppercase tracking-wider font-bold text-[var(--c-text-muted)]">Value</span>
            <span className="w-8" />
          </div>
          {rows.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
              <input
                type="text" value={row.name} onChange={(e) => update(i, 'name', e.target.value)}
                placeholder="NAME" spellCheck={false}
                className="w-full bg-[var(--c-base)] border border-[var(--c-border)] focus:border-[#00AF5C] rounded-xl px-3 py-2 text-sm text-[var(--c-text-primary)] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[var(--c-text-muted)] font-mono"
              />
              <input
                type="text" value={row.value} onChange={(e) => update(i, 'value', e.target.value)}
                placeholder="value" spellCheck={false}
                className="w-full bg-[var(--c-base)] border border-[var(--c-border)] focus:border-[#00AF5C] rounded-xl px-3 py-2 text-sm text-[var(--c-text-primary)] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[var(--c-text-muted)] font-mono"
              />
              <button
                onClick={() => remove(i)} title="Remove"
                className="w-8 h-8 flex items-center justify-center rounded-xl text-[var(--c-text-muted)] hover:text-[var(--c-danger)] hover:bg-[var(--c-danger)]/10 transition-colors">
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      {rows.length === 0 && (
        <p className="text-xs text-[var(--c-text-muted)] mb-3 italic">No environment variables set.</p>
      )}

      <div className="flex gap-2">
        <button onClick={add}
          className="flex items-center gap-1.5 px-3 py-2 bg-[#00AF5C]/10 hover:bg-[#00AF5C]/15 border border-[#00AF5C]/30 text-[#00AF5C] rounded-xl text-xs font-bold transition-colors">
          <Plus size={14} /> Add variable
        </button>
        {rows.length > 0 && (
          <button onClick={clearAll}
            className="flex items-center gap-1.5 px-3 py-2 bg-[var(--c-base)] hover:bg-[var(--c-border)] border border-[var(--c-border)] hover:border-[var(--c-text-muted)] text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] rounded-xl text-xs font-bold transition-colors">
            <Trash2 size={14} /> Clear all
          </button>
        )}
      </div>
    </Group>
  );
}

function MinecraftSection({ draft, commit }) {
  const [tab, setTab] = useState('general');
  return (
    <div className="space-y-5">
      {/* Prism-style tab bar */}
      <div className="flex gap-1.5 p-1 bg-[var(--c-surface-2)] border border-[var(--c-border)] rounded-2xl">
        {MC_TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`relative flex-1 min-w-0 flex items-center justify-center gap-1.5 px-2 py-2 rounded-xl text-xs font-bold transition-colors ${
                active ? 'text-[#00AF5C]' : 'text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)]'
              }`}>
              {active && (
                <motion.span layoutId="mcTabIndicator"
                  className="absolute inset-0 rounded-xl bg-[#00AF5C]/10 border border-[#00AF5C]/30"
                  transition={{ type: 'spring', stiffness: 400, damping: 30 }} />
              )}
              <Icon size={14} className="relative z-10 flex-shrink-0" />
              <span className="relative z-10 truncate">{t.label}</span>
            </button>
          );
        })}
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={tab}
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.16 }}
          className="space-y-5">
          {tab === 'general'  && <GeneralPanel draft={draft} commit={commit} />}
          {tab === 'tweaks'   && <TweaksPanel draft={draft} commit={commit} />}
          {tab === 'commands' && <CustomCommandsPanel draft={draft} commit={commit} />}
          {tab === 'env'      && <EnvVarsPanel draft={draft} commit={commit} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

export default function SettingsPage({ settings, onChange, onError, accountProps, socket }) {
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

  const ramMax = useSystemRam(16);
  const ramPercent = Math.round(((draft.ramGb - 1) / (ramMax - 1)) * 100);
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
                      : 'text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)] border border-transparent'
                  }`}
                >
                  <Icon size={16} className={active ? 'text-[#00AF5C]' : 'text-[var(--c-text-muted)]'} />
                  {s.label}
                </button>
              );
            })}
            <AnimatePresence>
              {saving && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="flex items-center gap-1.5 px-3 py-2 text-[10px] uppercase tracking-wider font-bold text-[var(--c-text-muted)]">
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
                      <span className="text-xs font-bold text-[var(--c-text-secondary)]">Allocation</span>
                      <span className="text-xs font-bold text-[#00AF5C] tabular-nums">{draft.ramGb} GB</span>
                    </div>
                    <input
                      type="range" min={1} max={ramMax} step={1}
                      value={draft.ramGb}
                      onChange={(e) => commit({ ...draft, ramGb: Number(e.target.value) })}
                      className="ram-slider w-full"
                      style={{ '--fill': `${ramPercent}%` }}
                    />
                    <div className="flex justify-between text-[10px] text-[var(--c-text-muted)] mt-1 tabular-nums">
                      <span>1 GB</span><span>{Math.round(ramMax / 2)} GB</span><span>{ramMax} GB</span>
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
                      className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-[var(--c-base)] hover:bg-[var(--c-border)] border border-[var(--c-border)] hover:border-[#00AF5C]/40 rounded-xl text-xs font-bold text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] transition-colors">
                      <Compass size={14} className="text-[#00AF5C]" /> Replay onboarding tour
                    </button>
                  </Group>
                </>
              )}

              {section === 'minecraft' && (
                <MinecraftSection draft={draft} commit={commit} />
              )}

              {section === 'appearance' && (
                <AppearanceSection draft={draft} commit={commit} />
              )}

              {section === 'java' && (
                <JavaSection draft={draft} commit={commit} />
              )}

              {section === 'storage' && (
                <StorageSection socket={socket} onError={onError} />
              )}

              {section === 'accounts' && (
                <AccountManager {...accountProps} />
              )}

              {section === 'updates' && (
                <>
                  <Group icon={DownloadCloud} title="Updates" hint="MineDash checks for updates on launch and downloads them in the background. You'll get a prompt to relaunch when one is ready — an in-progress launch or server is never interrupted.">
                    <div className="flex items-center gap-2 px-3 py-2.5 bg-[var(--c-base)] border border-[var(--c-border)] rounded-xl">
                      <Check size={14} className="text-[#00AF5C]" />
                      <span className="text-sm font-bold text-[var(--c-text-primary)]">MineDash {versionLabel || '(current)'}</span>
                    </div>
                  </Group>
                  {window.electronAPI?.getAppVersion && (
                    <Group icon={Sparkles} title="Release notes">
                      <button
                        onClick={() => window.dispatchEvent(new CustomEvent('minedash-show-changelog'))}
                        className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-[var(--c-base)] hover:bg-[var(--c-border)] border border-[var(--c-border)] hover:border-[#00AF5C]/40 rounded-xl text-xs font-bold text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] transition-colors">
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
                      <p className="text-lg font-black text-[var(--c-text-primary)] leading-tight">MineDash</p>
                      <p className="text-xs text-[var(--c-text-secondary)] tabular-nums">{versionLabel || 'local build'}</p>
                    </div>
                  </div>
                  <p className="text-sm text-[var(--c-text-secondary)] leading-relaxed">
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
