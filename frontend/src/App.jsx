import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { io } from 'socket.io-client';
import ServersList from './components/ServersList';
import TitleBar from './components/TitleBar';
import PlaySection from './components/PlaySection';
import AccountMenu from './components/AccountMenu';
import { useLaunchSession } from './hooks/useLaunchSession';
import { useModpackInstalls } from './hooks/useModpackInstalls';
import UpdateToast from './components/UpdateToast';
import BrowseInstallToast from './components/BrowseInstallToast';
import WhatsNewModal from './components/WhatsNewModal';
import Tooltip from './components/Tooltip';
import ConnectIndicator from './components/ConnectIndicator';
import { AlertCircle, X, Gamepad2, Server, Compass, Boxes, Settings } from 'lucide-react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';

// Heavy views and modals are code-split — only the Play view (the default
// landing screen) is in the main bundle. Each of these loads its chunk the
// first time it's rendered; Suspense fallbacks are null because chunks load
// from local disk in milliseconds.
const MainPanel = lazy(() => import('./components/MainPanel'));
const CreateServerModal = lazy(() => import('./components/CreateServerModal'));
const BrowseSection = lazy(() => import('./components/BrowseSection'));
const InstancesSection = lazy(() => import('./components/InstancesSection'));
const SettingsPage = lazy(() => import('./components/SettingsPage'));
const OnboardingTour = lazy(() => import('./components/OnboardingTour'));
const ProjectDetailModal = lazy(() => import('./components/ProjectDetailModal'));
const JoinSessionModal = lazy(() => import('./components/JoinSessionModal'));

const socket = io('http://localhost:3001');

const BASE_WIDTH = 1200;
const MIN_SCALE = 0.6;
// On high-DPI laptops (e.g. 1920x1080 + 150% Windows scaling, which presents as
// a 1280-wide CSS viewport with devicePixelRatio=1.5) the UI was rendering at
// 1:1 CSS pixels and then getting blown up 1.5x by the OS — making everything
// feel oversized. We counter-scale by a fraction of the DPR so the app keeps
// roughly the same physical density as it does on a 100%-scale display. dpr^0.45
// gives ~18% shrink at 150% scaling, ~10% at 125%, none at 100%.
const applyAppScale = () => {
  const dpr = window.devicePixelRatio || 1;
  const widthScale = Math.min(1, window.innerWidth / BASE_WIDTH);
  const dprScale = dpr > 1 ? 1 / Math.pow(dpr, 0.45) : 1;
  const scale = Math.max(MIN_SCALE, widthScale * dprScale);
  document.documentElement.style.setProperty('--app-scale', scale);
};

const TABS = {
  play:      { label: 'Launcher',  subtitle: 'Pick a loader, a version, hit Play.',            icon: Gamepad2 },
  browse:    { label: 'Browse',    subtitle: 'Discover modpacks, mods, and resource packs.',   icon: Compass  },
  instances: { label: 'Instances', subtitle: 'Your installed modpacks and profiles.',          icon: Boxes    },
  servers:   { label: 'Servers',   subtitle: 'Run Minecraft servers on this PC.',              icon: Server   },
  // Settings is a destination view but deliberately NOT in TAB_ORDER — it's
  // reached via the gear icon, not the inactive-pill row. It still needs a
  // TABS entry so the header title/icon/subtitle resolve when it's active.
  settings:  { label: 'Settings',  subtitle: 'Appearance, memory, Java, accounts, and updates.', icon: Settings },
};

// Order matters — the row of inactive tab pills renders in this order, so the
// active one is filtered out at render time and the rest keep their position.
const TAB_ORDER = ['play', 'browse', 'instances', 'servers'];

// Shared spring for the header's layout animation. The active title/subtitle
// block changes width between views; this drives both its resize and the slide
// of the divider + pill row so everything moves together rather than snapping.
const NAV_SPRING = { type: 'spring', stiffness: 380, damping: 32 };

// Slot-machine header title: when the view changes, each letter rolls downward
// into place with a left-to-right stagger — old letters spin out the bottom,
// new ones drop in from the top, like reels settling one by one. `popLayout`
// pulls the outgoing word out of flow so the incoming word defines the width
// immediately (the title block's `layout` spring animates that width change),
// and the overflow-hidden clip hides everything outside the single text line.
function RollingTitle({ text, viewKey }) {
  // Vertical-only clip: hides letters above/below the line as they roll, but
  // leaves the horizontal axis unbounded. `overflow-hidden` clips both axes,
  // which sliced the right-hand letters off the wider outgoing word when
  // shrinking to a shorter title (e.g. Instances → Browse) — the clip-path band
  // lets the outgoing word roll fully out of view instead of being cut.
  return (
    <span
      className="relative inline-block whitespace-nowrap align-bottom leading-tight"
      style={{ clipPath: 'inset(-0.05em -100vw 0 -100vw)' }}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={viewKey} className="inline-block">
          {Array.from(text).map((ch, i) => (
            <motion.span
              key={i}
              initial={{ y: '-115%' }}
              animate={{ y: '0%' }}
              exit={{ y: '115%' }}
              transition={{ type: 'spring', stiffness: 400, damping: 30, delay: i * 0.035 }}
              className="inline-block"
            >
              {ch === ' ' ? ' ' : ch}
            </motion.span>
          ))}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function AppHeader({ view, onChange, accountMenuProps }) {
  const active = TABS[view];
  const ActiveIcon = active.icon;
  const settingsActive = view === 'settings';

  return (
    <header className="flex items-center justify-between gap-4 px-6 md:px-10 py-4 bg-[var(--c-base)] border-b border-[var(--c-border)] flex-shrink-0 relative z-30">
      <LayoutGroup>
      <div className="flex items-center gap-4 min-w-0">
        {/* The active view's title/subtitle vary in width (e.g. Browse's copy is
            wider than Launcher's), so this block reflows when you switch tabs.
            `layout` animates that width change as a smooth spring; the direct
            children use `layout="position"` so their text/icon glide into place
            without getting stretched by the parent's resize. The divider and
            pill row below share the same spring, so the whole row slides
            together instead of the pills snapping sideways. */}
        <motion.div
          layout
          transition={NAV_SPRING}
          className="flex items-center gap-3 min-w-0"
        >
          <motion.div layout="position" className="p-2.5 bg-[#00AF5C]/10 rounded-2xl flex-shrink-0">
            <motion.span
              key={view}
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.2 }}
              className="inline-flex"
            >
              <ActiveIcon size={22} className="text-[#00AF5C]" />
            </motion.span>
          </motion.div>
          <motion.div layout="position" className="min-w-0">
            <h1 className="text-2xl font-black text-[var(--c-text-primary)] tracking-tight leading-tight">
              <RollingTitle text={active.label} viewKey={view} />
            </h1>
            <div className="overflow-hidden">
              <motion.p
                key={view}
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, delay: 0.08 }}
                className="text-xs text-[var(--c-text-secondary)] truncate"
              >
                {active.subtitle}
              </motion.p>
            </div>
          </motion.div>
        </motion.div>

        <motion.div layout="position" transition={NAV_SPRING} className="hidden sm:block w-px h-10 bg-[var(--c-border)]" />

        {/* All tabs render in TAB_ORDER and keep their position — the active one
            is just highlighted in place rather than promoted out of the row, so
            nothing reshuffles when you switch views. `layout="position"` lets the
            whole row glide when the title block to its left changes width. */}
        <motion.div layout="position" transition={NAV_SPRING} className="flex items-center gap-2">
          {TAB_ORDER.map(key => {
            const t = TABS[key];
            const Icon = t.icon;
            const isActive = key === view;
            return (
              <motion.button
                key={key}
                onClick={() => onChange(key)}
                aria-current={isActive ? 'page' : undefined}
                whileHover={isActive ? undefined : { scale: 1.05, y: -1 }}
                whileTap={{ scale: 0.95 }}
                transition={{ type: 'spring', stiffness: 400, damping: 22 }}
                className={`group relative flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-bold transition-colors overflow-hidden border ${
                  isActive
                    ? 'bg-[#00AF5C]/10 border-[#00AF5C]/30 text-[#00AF5C]'
                    : 'bg-[var(--c-surface-2)] border-[var(--c-border)] hover:border-[#00AF5C]/40 text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)]'
                }`}
              >
                {/* Soft brand-green shimmer that sweeps across on hover — inactive tabs only. */}
                {!isActive && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 -translate-x-full group-hover:translate-x-full bg-gradient-to-r from-transparent via-[#00AF5C]/15 to-transparent transition-transform duration-700 ease-out"
                  />
                )}
                <motion.span
                  initial={false}
                  whileHover={isActive ? undefined : { rotate: -8, scale: 1.15 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 18 }}
                  className="relative z-10 inline-flex"
                >
                  <Icon size={14} />
                </motion.span>
                <span className="relative z-10">{t.label}</span>
              </motion.button>
            );
          })}
        </motion.div>
      </div>
      </LayoutGroup>

      <div className="flex items-center gap-2 flex-shrink-0">
        <Tooltip content="Settings" side="bottom" align="end">
          <motion.button
            onClick={() => onChange(settingsActive ? 'play' : 'settings')}
            whileHover={{ scale: 1.05, rotate: 30 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: 'tween', duration: 0.08 }}
            className={`p-2.5 rounded-2xl border transition-all duration-200 ${
              settingsActive
                ? 'bg-[#00AF5C]/10 border-[#00AF5C]/30 text-[#00AF5C]'
                : 'bg-[var(--c-surface-2)] border-[var(--c-border)] text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:border-[var(--c-text-muted)]'
            }`}
          >
            <Settings size={18} />
          </motion.button>
        </Tooltip>
        <AccountMenu {...accountMenuProps} />
      </div>
    </header>
  );
}

function App() {
  const [servers, setServers] = useState([]);
  const [selectedServer, setSelectedServer] = useState(null);
  const [view, setView] = useState('play'); // 'play' | 'servers'
  const [playInitialServerId] = useState(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isJoinModalOpen, setIsJoinModalOpen] = useState(false);
  // Friend tunnel (MineDash Connect, join side). Lifted out of JoinSessionModal
  // so the connection survives closing that window — the friend MUST leave it to
  // reach the Launcher and start the game. Only an explicit Disconnect ends it.
  // Shape: { sessionId, localPort } | null.
  const [connectSession, setConnectSession] = useState(null);
  const [error, setError] = useState(null);
  // Last servers payload from the 3s poll — used to skip identical updates so
  // the whole tree doesn't re-render when nothing changed.
  const lastServersJsonRef = useRef('');

  // MineDash Connect (friend tunnel) — store the live session when the modal
  // reports it connected; keep it alive after the modal closes.
  const handleFriendConnected = useCallback((s) => setConnectSession(s), []);
  const disconnectFriend = useCallback(async () => {
    const id = connectSession?.sessionId;
    setConnectSession(null);
    if (id) { try { await fetch('http://localhost:3001/api/connect/' + id, { method: 'DELETE' }); } catch {} }
  }, [connectSession?.sessionId]);

  // Keep the tunnel's status live even while the Join window is closed so the
  // floating indicator reflects drops and clears itself.
  useEffect(() => {
    const id = connectSession?.sessionId;
    if (!id) return;
    const channel = `connect_status_${id}`;
    const handler = (p) => {
      if (p.state === 'connected') setConnectSession((s) => (s ? { ...s, localPort: p.localPort } : s));
      else if (p.state === 'failed') { setConnectSession(null); setError('MineDash Connect: the connection to your friend dropped.'); }
      else if (p.state === 'closed') setConnectSession(null);
    };
    socket.on(channel, handler);
    return () => socket.off(channel, handler);
  }, [connectSession?.sessionId]);

  // Launcher accounts — lifted up so the header AccountMenu and PlaySection share state.
  const [accounts, setAccounts] = useState([]);
  const [activeAccountId, setActiveAccountId] = useState(null);
  const [microsoftConfigured, setMicrosoftConfigured] = useState(false);

  // Launcher settings — lifted so SettingsPage and PlaySection share state.
  const [launcherSettings, setLauncherSettings] = useState(null);

  // First-run onboarding tour. We show it the first time the settings file
  // loads with onboardingComplete === false, and any time the user re-triggers
  // it from Settings via the `minedash-show-onboarding` custom event.
  const [showOnboarding, setShowOnboarding] = useState(false);

  // Cached set of installed `${loader}-${version}` profiles — lifted up so
  // switching to Servers and back doesn't make the launcher "forget" them.
  const [installedProfiles, setInstalledProfiles] = useState(new Set());
  const fetchInstalledProfiles = useCallback(async () => {
    try {
      const r = await fetch('http://localhost:3001/api/launcher/profiles');
      const d = await r.json();
      if (r.ok && Array.isArray(d)) {
        setInstalledProfiles(new Set(d.map(p => `${p.loader}-${p.version}`)));
      }
    } catch {}
  }, []);
  useEffect(() => { fetchInstalledProfiles(); }, [fetchInstalledProfiles]);

  const showError = useCallback((msg) => {
    setError(msg);
    setTimeout(() => setError(null), 5000);
  }, []);

  // Launch session lifted here so navigating to Servers and back preserves
  // download progress. The hook lives as long as App does (entire session).
  const launchSession = useLaunchSession({
    socket,
    settings: launcherSettings,
    onProfilesChanged: fetchInstalledProfiles,
    onError: showError,
  });

  // Modpack-install tracker — lifted so a 500-mod install survives the user
  // tab-switching away (and back) while it runs. ModrinthBrowser and
  // LauncherContent both register their installs here and read progress back
  // via key, so the progress bar rehydrates immediately on remount.
  const modpackInstalls = useModpackInstalls(socket);

  // Post-Browse-install jump: when a modpack install initiated from the Browse
  // tab completes, we surface a "Play now" toast and (on click) navigate the
  // user to the Launcher tab pre-selecting the new instance. PlaySection picks
  // up `pendingLauncherSelection` and pushes its loader/version/instanceId
  // through to its local state.
  const [pendingLauncherSelection, setPendingLauncherSelection] = useState(null);
  // Multi-toast stack — modpack install completions AND server-install
  // progress toasts can coexist (e.g. user clicks Install as server, then
  // clicks Install on a modpack while the server is still building). Each
  // toast carries its own `kind` + `phase` so the component can render
  // appropriately.
  const [installToasts, setInstallToasts] = useState([]);
  // Bumped whenever a Browse install finishes — PlaySection useEffect's on
  // this re-fetch the instance list so the newly-created instance shows up
  // in the dropdown even if the user was already on the Launcher tab.
  const [instancesRefreshKey, setInstancesRefreshKey] = useState(0);

  // ProjectDetailModal — opened from any of three surfaces (Browse, Launcher
  // content, server-side ModrinthBrowser). Hosted at App level so the modal
  // outlives tab navigation while it's open and isn't clipped by any
  // animated section wrapper.
  const [detailModal, setDetailModal] = useState(null);
  const openDetail = useCallback((opts) => setDetailModal(opts), []);
  const closeDetail = useCallback(() => setDetailModal(null), []);
  // Track sessionIds we've already toasted for so a render of `installs`
  // doesn't re-fire the toast for an already-handled completion.
  const toastedSessions = useRef(new Set());
  // AbortControllers for in-flight "install as server" downloads, keyed by
  // toast id. The download + upload run browser-side (see beginServerInstall),
  // so aborting the controller is how we cancel them.
  const serverInstallAborts = useRef({});

  const upsertToast = useCallback((toast) => {
    setInstallToasts(prev => {
      const i = prev.findIndex(t => t.id === toast.id);
      if (i === -1) return [...prev, toast];
      const next = prev.slice();
      next[i] = { ...next[i], ...toast };
      return next;
    });
  }, []);

  const removeToast = useCallback((id) => {
    setInstallToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // Watch the modpack install map for browse-source entries reaching done /
  // error. Done → toast + refresh; error is left to the per-row install entry
  // to surface inside BrowseSection.
  useEffect(() => {
    const installs = modpackInstalls.installs;
    for (const [key, entry] of Object.entries(installs)) {
      if (!key.startsWith('browse:')) continue;
      if (entry?.source !== 'browse') continue;
      if (!entry.sessionId) continue;
      if (toastedSessions.current.has(entry.sessionId)) continue;

      // A cancelled install left a partial instance the backend just deleted —
      // refetch so it drops out of the list, but show no "complete" toast.
      if (entry.status === 'cancelled') {
        toastedSessions.current.add(entry.sessionId);
        fetchInstalledProfiles();
        setInstancesRefreshKey(k => k + 1);
        continue;
      }

      if (entry?.status !== 'done') continue;
      toastedSessions.current.add(entry.sessionId);

      fetchInstalledProfiles();
      setInstancesRefreshKey(k => k + 1);
      upsertToast({
        id: `modpack-${entry.sessionId}`,
        kind: 'modpack',
        phase: 'done',
        title: entry.title || 'Modpack',
        loader: entry.loader,
        version: entry.version,
        instanceId: entry.instanceId,
        iconUrl: entry.iconUrl || null,
        autoDismissAfter: 10_000,
      });
    }
  }, [modpackInstalls.installs, fetchInstalledProfiles, upsertToast]);

  // Auto-dismiss timer per toast. Each toast carries its own
  // `autoDismissAfter` (ms) and `phase` — only terminal phases get a timer
  // since an in-flight 'downloading'/'creating' toast should stay until the
  // flow finishes or the user explicitly dismisses.
  useEffect(() => {
    const timers = [];
    for (const toast of installToasts) {
      if (!toast.autoDismissAfter) continue;
      if (toast.phase === 'downloading' || toast.phase === 'creating') continue;
      const t = setTimeout(() => removeToast(toast.id), toast.autoDismissAfter);
      timers.push(t);
    }
    return () => { for (const t of timers) clearTimeout(t); };
  }, [installToasts, removeToast]);

  const handleBrowseToastPlay = useCallback((toast) => {
    if (!toast) return;
    setPendingLauncherSelection({
      loader: toast.loader,
      version: toast.version,
      instanceId: toast.instanceId,
    });
    setView('play');
    removeToast(toast.id);
  }, [removeToast]);

  const handleGoToServers = useCallback((toast) => {
    setView('servers');
    if (toast) removeToast(toast.id);
  }, [removeToast]);

  // Server-install pipeline — lifted from BrowseSection so it survives the
  // user navigating to a different tab while the download is in flight. The
  // toast shows progress (downloading → creating → done/error) and persists
  // across view changes; on done it offers "Open Servers" to jump straight
  // to the new server card.
  const beginServerInstall = useCallback(async (hit) => {
    const toastId = `server-${hit.project_id}-${Date.now()}`;
    const controller = new AbortController();
    serverInstallAborts.current[toastId] = controller;
    upsertToast({
      id: toastId,
      kind: 'server',
      phase: 'downloading',
      title: hit.title,
      iconUrl: hit.icon_url || null,
    });
    try {
      const vr = await fetch(`http://localhost:3001/api/modrinth/project/${hit.project_id}/versions`, { signal: controller.signal });
      const vs = await vr.json();
      if (!vr.ok || !Array.isArray(vs) || vs.length === 0) throw new Error('No version found for this modpack');
      vs.sort((a, b) => {
        const rank = { release: 0, beta: 1, alpha: 2 };
        return (rank[a.version_type] ?? 3) - (rank[b.version_type] ?? 3);
      });
      const best = vs[0];
      const file = (best.files || []).find(f => f.primary) || (best.files || [])[0];
      if (!file?.url) throw new Error('Modpack version has no downloadable file');

      const dl = await fetch(file.url, { signal: controller.signal });
      if (!dl.ok) throw new Error(`Modpack download failed (${dl.status})`);
      const blob = await dl.blob();
      upsertToast({ id: toastId, phase: 'creating' });

      const fd = new FormData();
      fd.append('mrpack', new File([blob], file.filename || `${hit.project_id}.mrpack`));
      fd.append('name', hit.title);
      fd.append('ram', '4');

      const cr = await fetch('http://localhost:3001/api/servers/from-modpack', {
        method: 'POST',
        body: fd,
        signal: controller.signal,
      });
      const cd = await cr.json();
      if (!cr.ok) throw new Error(cd.error || 'Server create failed');

      upsertToast({
        id: toastId,
        phase: 'done',
        autoDismissAfter: 12_000,
      });
    } catch (err) {
      // User-initiated cancel: the toast is already removed by the cancel
      // handler, so don't flip it into an error state.
      if (err.name === 'AbortError') return;
      upsertToast({
        id: toastId,
        phase: 'error',
        error: err.message,
        autoDismissAfter: 8_000,
      });
    } finally {
      delete serverInstallAborts.current[toastId];
    }
  }, [upsertToast]);

  // Cancel an in-flight "install as server" download/upload. Aborts the fetch
  // chain (which rejects beginServerInstall's await) and clears the toast.
  const cancelServerInstall = useCallback((toastId) => {
    const controller = serverInstallAborts.current[toastId];
    if (controller) {
      try { controller.abort(); } catch {}
      delete serverInstallAborts.current[toastId];
    }
    removeToast(toastId);
  }, [removeToast]);

  const fetchAccounts = useCallback(async () => {
    try {
      const r = await fetch('http://localhost:3001/api/launcher/accounts');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load accounts');
      setAccounts(d.accounts || []);
      setActiveAccountId(d.activeAccountId);
      setMicrosoftConfigured(!!d.microsoftConfigured);
    } catch (err) { showError(err.message); }
  }, [showError]);

  useEffect(() => {
    applyAppScale();
    window.addEventListener('resize', applyAppScale);
    // Catch DPR changes when the window moves to a different-scale monitor.
    // resolution media queries don't fire reliably for arbitrary DPR transitions,
    // so re-arm a query for the current DPR on every change.
    let mql = null;
    const armDprListener = () => {
      if (mql) mql.removeEventListener('change', onDprChange);
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mql.addEventListener('change', onDprChange);
    };
    const onDprChange = () => { applyAppScale(); armDprListener(); };
    armDprListener();
    return () => {
      window.removeEventListener('resize', applyAppScale);
      if (mql) mql.removeEventListener('change', onDprChange);
    };
  }, []);

  useEffect(() => { fetchAccounts(); }, [fetchAccounts]);

  useEffect(() => {
    fetch('http://localhost:3001/api/launcher/settings')
      .then(r => r.json())
      .then(d => {
        setLauncherSettings(d);
        // Auto-show the welcome tour the first time a user runs MineDash.
        // We key off the persisted flag so it never re-appears after they
        // finish or skip it (unless re-triggered from Settings).
        if (d && d.onboardingComplete === false) setShowOnboarding(true);
      })
      .catch(() => {});
  }, []);

  // Apply the selected colour theme to <html data-theme>. 'system' tracks the
  // OS preference live via matchMedia. The preference is mirrored to
  // localStorage so main.jsx can paint the right theme before React mounts.
  useEffect(() => {
    const pref = launcherSettings?.theme || 'dark';
    try { localStorage.setItem('minedash-theme', pref); } catch { /* private mode */ }
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const resolved = pref === 'system' ? (mq.matches ? 'light' : 'dark') : pref;
      document.documentElement.setAttribute('data-theme', resolved);
    };
    apply();
    if (pref === 'system') {
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [launcherSettings?.theme]);

  // Settings menu fires this when the user clicks "Replay onboarding tour".
  useEffect(() => {
    const handler = () => setShowOnboarding(true);
    window.addEventListener('minedash-show-onboarding', handler);
    return () => window.removeEventListener('minedash-show-onboarding', handler);
  }, []);

  // Persist completion to launcher-settings.json so the tour doesn't reappear.
  // Both finish and skip flow through here — we don't distinguish the two.
  const handleOnboardingComplete = useCallback(async () => {
    try {
      const r = await fetch('http://localhost:3001/api/launcher/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onboardingComplete: true }),
      });
      const updated = await r.json();
      if (r.ok) setLauncherSettings(updated);
    } catch {
      // Best-effort — if the PUT fails the user can dismiss again next launch.
    }
  }, []);

  useEffect(() => {
    fetchServers();

    const handleServerCreated = (newServer) => {
      setServers((prev) => [...prev, newServer]);
    };

    const handleStatusChange = ({ id, status }) => {
      setServers((prev) => prev.map((s) => (s.id === id ? { ...s, status } : s)));
      setSelectedServer((prev) => (prev && prev.id === id ? { ...prev, status } : prev));
    };

    const handleServerUpdated = (updatedServer) => {
      setServers((prev) => prev.map((s) => (s.id === updatedServer.id ? { ...updatedServer, status: s.status } : s)));
      setSelectedServer((prev) => (prev && prev.id === updatedServer.id ? { ...updatedServer, status: prev.status } : prev));
    };

    const handleServerDeleted = (id) => {
      setServers((prev) => prev.filter(s => s.id !== id));
      setSelectedServer((prev) => (prev && prev.id === id ? null : prev));
    };

    socket.on('server_created', handleServerCreated);
    socket.on('server_status_change', handleStatusChange);
    socket.on('server_updated', handleServerUpdated);
    socket.on('server_deleted', handleServerDeleted);

    const pollInterval = setInterval(() => {
      fetch('http://localhost:3001/api/servers')
        .then(r => r.json())
        .then(data => {
          const json = JSON.stringify(data);
          if (json === lastServersJsonRef.current) return;
          lastServersJsonRef.current = json;
          setServers(data);
          setSelectedServer(prev => {
            if (!prev) return prev;
            const updated = data.find(s => s.id === prev.id);
            if (updated && updated.status !== prev.status) {
              return { ...prev, status: updated.status };
            }
            return prev;
          });
        })
        .catch(() => {});
    }, 3000);

    return () => {
      socket.off('server_created', handleServerCreated);
      socket.off('server_status_change', handleStatusChange);
      socket.off('server_updated', handleServerUpdated);
      socket.off('server_deleted', handleServerDeleted);
      clearInterval(pollInterval);
    };
  }, []);

  const fetchServers = async () => {
    try {
      const res = await fetch('http://localhost:3001/api/servers');
      const data = await res.json();
      setServers(data);
    } catch (err) {
      console.error('Error fetching servers:', err);
      showError('Failed to fetch servers from backend.');
    }
  };

  const handleCreateServer = async (serverData) => {
    try {
      const res = await fetch('http://localhost:3001/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(serverData),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create server');
      setIsCreateModalOpen(false);
      setSelectedServer(data);
    } catch (err) {
      console.error('Error creating server:', err);
      showError(err.message);
      throw err;
    }
  };

  const accountMenuProps = {
    accounts,
    activeAccountId,
    microsoftConfigured,
    elybySkinsDefault: launcherSettings?.elybySkins !== false,
    onChanged: fetchAccounts,
    onError: showError,
  };

  return (
    <div className="flex flex-col h-full bg-[var(--c-base)] text-[var(--c-text-primary)] font-sans selection:bg-[#00AF5C]/20">
      <TitleBar />
      <AppHeader view={view} onChange={setView} accountMenuProps={accountMenuProps} />

      <main className="flex-1 flex flex-col overflow-hidden bg-[var(--c-base)] z-10 relative">
        <AnimatePresence mode="wait">
          {view === 'play' ? (
            <motion.div
              key="play"
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="flex-1 flex flex-col overflow-hidden"
            >
              <PlaySection
                servers={servers}
                socket={socket}
                initialServerId={playInitialServerId}
                accounts={accounts}
                activeAccountId={activeAccountId}
                settings={launcherSettings}
                installedProfiles={installedProfiles}
                onProfilesChanged={fetchInstalledProfiles}
                onError={showError}
                launchSession={launchSession}
                modpackInstalls={modpackInstalls}
                launcherSelection={pendingLauncherSelection}
                onSelectionConsumed={() => setPendingLauncherSelection(null)}
                instancesRefreshKey={instancesRefreshKey}
                onOpenDetail={openDetail}
              />
            </motion.div>
          ) : view === 'browse' ? (
            <motion.div
              key="browse"
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="flex-1 flex flex-col overflow-hidden"
            >
              <Suspense fallback={null}>
                <BrowseSection
                  socket={socket}
                  onError={showError}
                  modpackInstalls={modpackInstalls}
                  onProfilesChanged={fetchInstalledProfiles}
                  onInstallAsServer={beginServerInstall}
                  onOpenDetail={openDetail}
                />
              </Suspense>
            </motion.div>
          ) : view === 'instances' ? (
            <motion.div
              key="instances"
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="flex-1 flex flex-col overflow-hidden"
            >
              <Suspense fallback={null}>
                <InstancesSection
                  accounts={accounts}
                  activeAccountId={activeAccountId}
                  launchSession={launchSession}
                  modpackInstalls={modpackInstalls}
                  instancesRefreshKey={instancesRefreshKey}
                  onError={showError}
                />
              </Suspense>
            </motion.div>
          ) : view === 'settings' ? (
            <motion.div
              key="settings"
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="flex-1 flex flex-col overflow-hidden"
            >
              <Suspense fallback={null}>
                <SettingsPage
                  settings={launcherSettings}
                  onChange={setLauncherSettings}
                  onError={showError}
                  accountProps={accountMenuProps}
                  socket={socket}
                />
              </Suspense>
            </motion.div>
          ) : selectedServer ? (
            <motion.div
              key={`mainpanel-${selectedServer.id}`}
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="flex-1 flex flex-col overflow-hidden"
            >
              <Suspense fallback={null}>
                <MainPanel
                  server={selectedServer}
                  socket={socket}
                  onError={showError}
                  settings={launcherSettings}
                  onProfilesChanged={fetchInstalledProfiles}
                  onBack={() => setSelectedServer(null)}
                  modpackInstalls={modpackInstalls}
                  onOpenDetail={openDetail}
                />
              </Suspense>
            </motion.div>
          ) : (
            <motion.div
              key="serverslist"
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="flex-1 flex flex-col overflow-hidden"
            >
              <ServersList
                servers={servers}
                onSelect={setSelectedServer}
                onCreateClick={() => setIsCreateModalOpen(true)}
                onJoinClick={() => setIsJoinModalOpen(true)}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <AnimatePresence>
        {isCreateModalOpen && (
          <Suspense fallback={null}>
            <CreateServerModal
              onClose={() => setIsCreateModalOpen(false)}
              onCreate={handleCreateServer}
              existingNames={servers.map(s => s.name.toLowerCase())}
            />
          </Suspense>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isJoinModalOpen && (
          <Suspense fallback={null}>
            <JoinSessionModal
              socket={socket}
              connectSession={connectSession}
              onConnected={handleFriendConnected}
              onDisconnect={disconnectFriend}
              onClose={() => setIsJoinModalOpen(false)}
            />
          </Suspense>
        )}
      </AnimatePresence>

      {/* Live friend tunnel — visible while the Join window is closed so the
          friend knows the connection is up (and can end it) while they play. */}
      <AnimatePresence>
        {connectSession && !isJoinModalOpen && (
          <ConnectIndicator localPort={connectSession.localPort} onDisconnect={disconnectFriend} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: 50, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 20, x: '-50%' }}
            className="fixed bottom-6 left-1/2 z-50 flex items-center gap-3 px-4 py-3 bg-[var(--c-surface-2)] text-[var(--c-danger)] border border-[var(--c-danger)]/30 rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.5)]"
          >
            <AlertCircle size={20} />
            <span className="font-bold text-sm">{error}</span>
            <button onClick={() => setError(null)} className="ml-2 text-[var(--c-danger)] hover:text-[#FF3333]">
              <X size={16} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {detailModal && (
          <Suspense key={detailModal.projectId} fallback={null}>
          <ProjectDetailModal
            projectId={detailModal.projectId}
            type={detailModal.type}
            seedHit={detailModal.seedHit}
            loaderContext={detailModal.loaderContext}
            versionContext={detailModal.versionContext}
            defaultInstanceId={detailModal.defaultInstanceId}
            serverContext={detailModal.serverContext}
            onServerInstall={detailModal.onServerInstall}
            modpackInstalls={modpackInstalls}
            onInstallAsServer={beginServerInstall}
            onProfilesChanged={fetchInstalledProfiles}
            onError={showError}
            onClose={closeDetail}
          />
          </Suspense>
        )}
      </AnimatePresence>

      <UpdateToast />
      <BrowseInstallToast
        toasts={installToasts}
        onPlay={handleBrowseToastPlay}
        onDismiss={removeToast}
        onCancel={cancelServerInstall}
        onGoToServers={handleGoToServers}
      />
      <WhatsNewModal />

      {/* First-run guided tour — auto-shows for new users, re-triggerable from Settings */}
      {showOnboarding && (
        <Suspense fallback={null}>
          <OnboardingTour
            onClose={() => setShowOnboarding(false)}
            onComplete={handleOnboardingComplete}
          />
        </Suspense>
      )}
    </div>
  );
}

export default App;
