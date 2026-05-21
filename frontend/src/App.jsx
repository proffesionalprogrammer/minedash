import React, { useState, useEffect, useCallback } from 'react';
import { io } from 'socket.io-client';
import ServersList from './components/ServersList';
import MainPanel from './components/MainPanel';
import CreateServerModal from './components/CreateServerModal';
import TitleBar from './components/TitleBar';
import JavaSetupModal from './components/JavaSetupModal';
import PlaySection from './components/PlaySection';
import AccountMenu from './components/AccountMenu';
import { useLaunchSession } from './hooks/useLaunchSession';
import SettingsMenu from './components/SettingsMenu';
import UpdateToast from './components/UpdateToast';
import WhatsNewModal from './components/WhatsNewModal';
import { AlertCircle, X, Gamepad2, Server } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

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
  play:    { label: 'Launcher', subtitle: 'Pick a loader, a version, hit Play.', icon: Gamepad2 },
  servers: { label: 'Servers',  subtitle: 'Run Minecraft servers on this PC.',  icon: Server   },
};

function AppHeader({ view, onChange, accountMenuProps, settingsMenuProps }) {
  const active = TABS[view];
  const inactiveKey = view === 'play' ? 'servers' : 'play';
  const inactive = TABS[inactiveKey];
  const ActiveIcon = active.icon;
  const InactiveIcon = inactive.icon;

  return (
    <header className="flex items-center justify-between gap-4 px-6 md:px-10 py-4 bg-[#111111] border-b border-[#2D2D2D] flex-shrink-0 relative z-30">
      <div className="flex items-center gap-4 min-w-0">
        <motion.div
          key={view}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.25 }}
          className="flex items-center gap-3 min-w-0"
        >
          <div className="p-2.5 bg-[#00AF5C]/10 rounded-2xl flex-shrink-0">
            <ActiveIcon size={22} className="text-[#00AF5C]" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-black text-[#FFFFFF] tracking-tight leading-tight">{active.label}</h1>
            <p className="text-xs text-[#A0A0A0] truncate">{active.subtitle}</p>
          </div>
        </motion.div>

        <div className="hidden sm:block w-px h-10 bg-[#2D2D2D]" />

        <motion.button
          onClick={() => onChange(inactiveKey)}
          whileHover={{ scale: 1.05, y: -1 }}
          whileTap={{ scale: 0.95 }}
          transition={{ type: 'spring', stiffness: 400, damping: 22 }}
          className="group relative flex items-center gap-2 px-3 py-2 bg-[#1E1E1E] border border-[#2D2D2D] hover:border-[#00AF5C]/40 rounded-xl text-sm font-bold text-[#A0A0A0] hover:text-[#FFFFFF] transition-colors overflow-hidden"
        >
          {/* Soft brand-green shimmer that sweeps across on hover. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 -translate-x-full group-hover:translate-x-full bg-gradient-to-r from-transparent via-[#00AF5C]/15 to-transparent transition-transform duration-700 ease-out"
          />
          <motion.span
            initial={false}
            whileHover={{ rotate: -8, scale: 1.15 }}
            transition={{ type: 'spring', stiffness: 500, damping: 18 }}
            className="relative z-10 inline-flex"
          >
            <InactiveIcon size={14} />
          </motion.span>
          <span className="relative z-10">{inactive.label}</span>
        </motion.button>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        <SettingsMenu {...settingsMenuProps} />
        <AccountMenu {...accountMenuProps} />
      </div>
    </header>
  );
}

function App() {
  const [servers, setServers] = useState([]);
  const [selectedServer, setSelectedServer] = useState(null);
  const [view, setView] = useState('play'); // 'play' | 'servers'
  const [playInitialServerId, setPlayInitialServerId] = useState(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [error, setError] = useState(null);
  const [systemStats, setSystemStats] = useState({ cpu: '0%', ram: '0 MB', ramTotal: '0 MB' });
  const [javaModal, setJavaModal] = useState(null);

  // Launcher accounts — lifted up so the header AccountMenu and PlaySection share state.
  const [accounts, setAccounts] = useState([]);
  const [activeAccountId, setActiveAccountId] = useState(null);
  const [microsoftConfigured, setMicrosoftConfigured] = useState(false);

  // Launcher settings — lifted so SettingsMenu and PlaySection share state.
  const [launcherSettings, setLauncherSettings] = useState(null);

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
      .then(d => setLauncherSettings(d))
      .catch(() => {});
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
    socket.on('system_stats', setSystemStats);
    socket.on('server_deleted', handleServerDeleted);

    const pollInterval = setInterval(() => {
      fetch('http://localhost:3001/api/servers')
        .then(r => r.json())
        .then(data => {
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
      socket.off('system_stats', setSystemStats);
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

  const checkJavaThenCreate = async () => {
    try {
      const res = await fetch('http://localhost:3001/api/java-status');
      const data = await res.json();
      if (data.ok) setIsCreateModalOpen(true);
      else setJavaModal({ version: data.version });
    } catch {
      setIsCreateModalOpen(true);
    }
  };

  const accountMenuProps = {
    accounts,
    activeAccountId,
    microsoftConfigured,
    onChanged: fetchAccounts,
    onError: showError,
  };

  const settingsMenuProps = {
    settings: launcherSettings,
    onChange: setLauncherSettings,
    onError: showError,
  };

  return (
    <div className="flex flex-col h-full bg-[#111111] text-[#FFFFFF] font-sans selection:bg-[#00AF5C]/20">
      <TitleBar />
      <AppHeader view={view} onChange={setView} accountMenuProps={accountMenuProps} settingsMenuProps={settingsMenuProps} />

      <main className="flex-1 flex flex-col overflow-hidden bg-[#111111] z-10 relative">
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
              />
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
              <MainPanel
                server={selectedServer}
                socket={socket}
                onError={showError}
                stats={systemStats}
                settings={launcherSettings}
                onProfilesChanged={fetchInstalledProfiles}
                onBack={() => setSelectedServer(null)}
              />
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
                onCreateClick={checkJavaThenCreate}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <AnimatePresence>
        {javaModal && (
          <JavaSetupModal
            installedVersion={javaModal.version}
            onClose={() => setJavaModal(null)}
            onProceedAnyway={() => { setJavaModal(null); setIsCreateModalOpen(true); }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isCreateModalOpen && (
          <CreateServerModal
            onClose={() => setIsCreateModalOpen(false)}
            onCreate={handleCreateServer}
            existingNames={servers.map(s => s.name.toLowerCase())}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: 50, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 20, x: '-50%' }}
            className="fixed bottom-6 left-1/2 z-50 flex items-center gap-3 px-4 py-3 bg-[#1E1E1E] text-[#FF5555] border border-[#FF5555]/30 rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.5)]"
          >
            <AlertCircle size={20} />
            <span className="font-bold text-sm">{error}</span>
            <button onClick={() => setError(null)} className="ml-2 text-[#FF5555] hover:text-[#FF3333]">
              <X size={16} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <UpdateToast />
      <WhatsNewModal />
    </div>
  );
}

export default App;
