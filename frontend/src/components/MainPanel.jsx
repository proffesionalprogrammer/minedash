import React, { useState } from 'react';
import { Play, Square, RefreshCw, Cpu, Users, Settings, Trash2, Folder, Gamepad2, MoreVertical, Server, MemoryStick, Clock, Copy, Check, AlertTriangle, Loader2, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLaunchSession } from '../hooks/useLaunchSession';
import Tooltip from './Tooltip';
import ConsoleViewer from './ConsoleViewer';
import ModsViewer from './ModsViewer';
import PluginsViewer from './PluginsViewer';
import BackupsViewer from './BackupsViewer';
import OptionsViewer from './OptionsViewer';
import PlayersViewer from './PlayersViewer';
import NetworkPanel from './NetworkPanel';
import MapViewer from './MapViewer';
import ActivityTimeline from './ActivityTimeline';
import ScheduleViewer from './ScheduleViewer';
import ModalPortal from './ModalPortal';
import StatCard from './main/StatCard';
import { parseLogEvent, num, toMB, getUsageColor } from '../lib/logParse';

const HISTORY_LEN = 60;
function pushHistory(prev, sample) {
  if (!isFinite(sample)) return prev;
  const next = [...prev, sample];
  if (next.length > HISTORY_LEN) next.splice(0, next.length - HISTORY_LEN);
  return next;
}

function MainPanel({ server, socket, onError, settings, onProfilesChanged, onBack, requestJavaGate, modpackInstalls, onOpenDetail }) {
  const joinSession = useLaunchSession({ socket, settings, onProfilesChanged, onError });
  const handleJoin = () => joinSession.launch({ joinServerId: server.id });
  const launcherSupported = ['vanilla', 'fabric', 'forge', 'neoforge'].includes(server.type);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('console');
  const [activityEvents, setActivityEvents] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [serverStats, setServerStats] = useState({ uptime: '0m', players: [] });
  const [storageSize, setStorageSize] = useState('0 MB');
  const [iconKey, setIconKey] = useState(Date.now());
  const [systemStats, setSystemStats] = useState({ cpu: '0%', ram: '0 MB', ramTotal: '0 MB' });
  const [serverMemStats, setServerMemStats] = useState({ ram: '0 MB', ramPercent: '0%', cpu: '0%' });
  const [toast, setToast] = useState(null);
  const [history, setHistory] = useState({ cpu: [], ram: [], storage: [] });
  const [addressCopied, setAddressCopied] = useState(false);
  const [showRestartModal, setShowRestartModal] = useState(false);
  const [radminIp, setRadminIp] = useState(null);
  const [serverPort, setServerPort] = useState('25565');
  const isOnline = server.status === 'online';

  // Pull Radmin VPN address (if installed) + server port for the header chip.
  React.useEffect(() => {
    let cancelled = false;
    fetch('http://localhost:3001/api/network')
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        const vpn = (data.addresses || []).find(a => a.isRadmin);
        setRadminIp(vpn ? vpn.ip : null);
      })
      .catch(() => {});
    fetch(`http://localhost:3001/api/servers/${server.id}/properties`)
      .then(r => r.json())
      .then(props => {
        if (cancelled) return;
        if (props && props['server-port']) setServerPort(String(props['server-port']));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [server.id]);

  const primaryAddress = radminIp ? `${radminIp}:${serverPort}` : null;

  const handleCopyAddress = async () => {
    if (!primaryAddress) return;
    try {
      await navigator.clipboard.writeText(primaryAddress);
      setAddressCopied(true);
      setTimeout(() => setAddressCopied(false), 1500);
    } catch (_) {}
  };

  const onRestartClick = () => {
    // Warn first if there are connected players, since restart kicks everyone.
    if (isOnline && serverStats.players?.length > 0) {
      setShowRestartModal(true);
    } else {
      handleRestart();
    }
  };

  // Always listen for console events to populate activity timeline regardless of active tab
  React.useEffect(() => {
    const handleLog = (data) => {
      const lines = data.split('\n').filter(Boolean);
      for (const line of lines) {
        const event = parseLogEvent(line);
        if (event) {
          setActivityEvents(prev => [...prev.slice(-200), { ...event, id: Date.now() + Math.random() }]);
        }
      }
    };
    socket.on(`console_${server.id}`, handleLog);
    return () => socket.off(`console_${server.id}`, handleLog);
  }, [server.id, socket]);

  // Sample each metric into history on update for sparklines
  React.useEffect(() => {
    setHistory(h => ({ ...h, cpu: pushHistory(h.cpu, num(systemStats.cpu)) }));
  }, [systemStats.cpu]);
  React.useEffect(() => {
    // Push 0 when offline so the line settles cleanly at the bottom instead of stalling.
    const sample = isOnline ? num(serverMemStats.ramPercent) : 0;
    setHistory(h => ({ ...h, ram: pushHistory(h.ram, sample) }));
  }, [serverMemStats.ramPercent, isOnline]);
  React.useEffect(() => {
    setHistory(h => ({ ...h, storage: pushHistory(h.storage, toMB(storageSize)) }));
  }, [storageSize]);

  // Always listen for system-wide stats + per-server stats
  React.useEffect(() => {
    const handleSystemStats = (data) => setSystemStats(data);
    const handleServerMem = (data) => setServerMemStats(data);

    socket.on('system_stats', handleSystemStats);
    socket.on(`server_memory_${server.id}`, handleServerMem);
    return () => {
      socket.off('system_stats', handleSystemStats);
      socket.off(`server_memory_${server.id}`, handleServerMem);
    };
  }, [socket, server.id]);

  React.useEffect(() => {
    let interval;
    if (isOnline) {
      const fetchServerStats = async () => {
        try {
          const res = await fetch(`http://localhost:3001/api/servers/${server.id}/stats`);
          const data = await res.json();
          if (res.ok) setServerStats(data);
        } catch (e) {
          // ignore
        }
      };

      fetchServerStats();
      interval = setInterval(fetchServerStats, 1000);

      socket.on(`players_update_${server.id}`, (players) => {
        setServerStats(prev => ({ ...prev, players }));
      });
    } else {
      setServerStats({ uptime: '0m', players: [] });
    }

    return () => {
      if (interval) clearInterval(interval);
      socket.off(`players_update_${server.id}`);
    };
  }, [server.id, isOnline, socket]);

  // Storage is a recursive disk walk on the backend — poll it gently, on its
  // own cadence, instead of riding the 1s stats loop.
  React.useEffect(() => {
    const fetchStorage = () => {
      fetch(`http://localhost:3001/api/servers/${server.id}/storage`)
        .then(r => r.json())
        .then(d => setStorageSize(d.size))
        .catch(() => {});
    };
    fetchStorage();
    const interval = setInterval(fetchStorage, 30000);
    return () => clearInterval(interval);
  }, [server.id, isOnline]);

  const handleStart = async () => {
    setLoading(true);
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${server.id}/start`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) return;
      if (data.code === 'java-version-mismatch' && requestJavaGate) {
        const proceed = await requestJavaGate({
          installedVersion: data.installedVersion,
          requiredMajor: data.requiredMajor,
          mcVersion: data.mcVersion,
        });
        if (!proceed) return;
        const retry = await fetch(
          `http://localhost:3001/api/servers/${server.id}/start?allowMismatch=true`,
          { method: 'POST' }
        );
        const retryData = await retry.json();
        if (!retry.ok) throw new Error(retryData.error || 'Failed to start server');
        return;
      }
      throw new Error(data.error || 'Failed to start server');
    } catch (err) {
      console.error(err);
      if (onError) onError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${server.id}/stop`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to stop server');
    } catch (err) {
      console.error(err);
      if (onError) onError(err.message);
    }
    setLoading(false);
  };

  const handleRestart = async () => {
    setLoading(true);
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${server.id}/restart`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to restart server');
    } catch (err) {
      console.error(err);
      if (onError) onError(err.message);
    }
    setLoading(false);
  };

  const handleDeleteServer = async () => {
    setLoading(true);
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${server.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete server');
      setShowDeleteModal(false);
      onBack();
    } catch (err) {
      console.error(err);
      if (onError) onError(err.message);
    }
    setLoading(false);
  };

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  // Determine the content tab label + visibility based on server type
  const serverType = server.type?.toLowerCase();
  const isVanilla = serverType === 'vanilla';
  const isPaper = serverType === 'paper';
  const contentTabLabel = isPaper ? 'Plugins' : 'Mods';

  const tabs = [
    { key: 'console', label: 'Overview' },
    { key: 'players', label: 'Players' },
    { key: 'activity', label: 'Activity' },
    // Vanilla has no mod/plugin support — hide the tab entirely
    ...(!isVanilla ? [{ key: 'mods', label: contentTabLabel }] : []),
    // Live world map (BlueMap) needs a loader/plugin platform — hidden on vanilla
    ...(!isVanilla ? [{ key: 'map', label: 'Map' }] : []),
    { key: 'backups', label: 'Backups' },
    { key: 'schedule', label: 'Schedule' },
    { key: 'network', label: 'Network' },
    { key: 'options', label: 'Options' },
  ];

  // Listen for tab-switch requests emitted by the crash banner "Fix it" button
  React.useEffect(() => {
    const handleSwitchTab = (e) => {
      const { tab } = e.detail || {};
      if (!tab) return;
      // Only switch to tabs that are currently visible
      if (tabs.some(t => t.key === tab)) {
        setActiveTab(tab);
      }
    };
    window.addEventListener('minedash-switch-tab', handleSwitchTab);
    return () => window.removeEventListener('minedash-switch-tab', handleSwitchTab);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  return (
    <div className="flex-1 flex flex-col min-h-0 p-8 overflow-y-auto z-10 relative">
      
      {/* Restart-with-players Confirmation Modal */}
      <AnimatePresence>
        {showRestartModal && (
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
                  <AlertTriangle size={20} className="text-amber-500" />
                </div>
                <h3 className="text-xl font-bold text-[#FFFFFF]">Restart with players online?</h3>
              </div>
              <p className="text-[#A0A0A0] text-sm mb-6 leading-relaxed">
                <span className="text-white font-bold">{serverStats.players?.length} player{serverStats.players?.length === 1 ? '' : 's'}</span> connected right now: <span className="text-white">{serverStats.players?.map(p => typeof p === 'string' ? p : p.name).join(', ')}</span>.
                Restarting will kick everyone for ~30–60 seconds.
              </p>
              <div className="flex justify-end gap-3 pt-4 border-t border-[#2D2D2D]">
                <button
                  onClick={() => setShowRestartModal(false)}
                  className="px-4 py-2 bg-[#111111] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#FFFFFF] rounded-xl text-sm font-bold transition-all duration-200 hover:scale-[1.02] active:scale-95"
                >
                  Cancel
                </button>
                <button
                  onClick={() => { setShowRestartModal(false); handleRestart(); }}
                  className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-xl text-sm font-bold transition-all duration-200 flex items-center gap-2 hover:scale-[1.02] active:scale-95"
                >
                  <RefreshCw size={16} /> Restart Anyway
                </button>
              </div>
            </motion.div>
          </motion.div>
          </ModalPortal>
        )}
      </AnimatePresence>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {showDeleteModal && (
          <ModalPortal>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#000000]/80 z-[100] flex items-center justify-center backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }} 
              animate={{ scale: 1, opacity: 1 }} 
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
              className="bg-[#1A1A1A] border border-[#2D2D2D] p-6 rounded-3xl w-full max-w-md shadow-2xl"
            >
              <h3 className="text-xl font-bold text-[#FFFFFF] mb-2">Delete Server</h3>
              <p className="text-[#A0A0A0] text-sm mb-6 leading-relaxed">
                Are you sure you want to permanently delete <span className="text-white font-bold">{server.name}</span>? 
                This will destroy all files, mods, and worlds. This action cannot be undone.
              </p>
              <div className="flex justify-end gap-3 pt-4 border-t border-[#2D2D2D]">
                <button 
                  onClick={() => setShowDeleteModal(false)}
                  className="px-4 py-2 bg-[#111111] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#FFFFFF] rounded-xl text-sm font-bold transition-all duration-200 hover:scale-[1.02] active:scale-95"
                >
                  Cancel
                </button>
                <button 
                  onClick={handleDeleteServer}
                  className="px-4 py-2 bg-[#FF5555] hover:bg-[#FF4444] text-white rounded-xl text-sm font-bold transition-all duration-200 flex items-center gap-2 hover:scale-[1.02] active:scale-95 hover:shadow-[0_4px_20px_rgba(255,85,85,0.3)]"
                >
                  <Trash2 size={16} /> Delete Permanently
                </button>
              </div>
            </motion.div>
          </motion.div>
          </ModalPortal>
        )}
      </AnimatePresence>

      <motion.div 
        initial={{ opacity: 0, y: 12 }} 
        animate={{ opacity: 1, y: 0 }} 
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="mb-6 flex-shrink-0"
      >
        <button 
          onClick={onBack} 
          className="text-[#00AF5C] hover:text-[#00964F] font-bold text-sm mb-4 flex items-center gap-1 transition-all duration-200 hover:gap-2 group"
        >
          <span className="transition-transform duration-200 group-hover:-translate-x-0.5">&larr;</span> All servers
        </button>

        <div className="flex items-start justify-between">
          <div className="flex items-center gap-6">
            <motion.div
              whileHover={{ scale: 1.05 }}
              transition={{ type: 'spring', stiffness: 400, damping: 25 }}
              className="w-24 h-24 bg-[#111111] rounded-2xl overflow-hidden border border-[#2D2D2D] flex-shrink-0 shadow-lg flex items-center justify-center"
            >
              <img
                src={`http://localhost:3001/api/servers/${server.id}/icon.png?t=${iconKey}`}
                alt="Icon"
                className="w-full h-full object-cover"
                onError={(e) => {
                  e.target.style.display = 'none';
                  e.target.nextSibling.style.display = 'block';
                }}
              />
              <Server className="text-[#555555] hidden" size={40} />
            </motion.div>
            
            <div className="flex flex-col gap-2">
              <h1 className="text-4xl font-black text-[#FFFFFF] tracking-tight">{server.name}</h1>
              
              <div className="flex items-center gap-4 text-sm font-medium text-[#A0A0A0]">
                <div className="flex items-center gap-1.5">
                  <span className="text-[#555555]"><Gamepad2 size={16}/></span>
                  Minecraft {server.version}
                </div>
                <div className="w-px h-3 bg-[#2D2D2D]"></div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[#555555]"><Settings size={16}/></span>
                  <span className="capitalize">{server.type} {server.version}</span>
                </div>
                {isOnline && (
                  <>
                    <div className="w-px h-3 bg-[#2D2D2D]"></div>
                    <div className="flex items-center gap-1.5 text-[#FFFFFF]">
                      <span className="text-[#555555]"><Clock size={16}/></span>
                      {serverStats.uptime}
                    </div>
                  </>
                )}
              </div>
              {/* Radmin VPN join address chip — click to copy */}
              {primaryAddress ? (
                <Tooltip content={addressCopied ? 'Copied!' : 'Click to copy Radmin VPN address'} side="bottom" align="start" className="mt-1 self-start">
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={handleCopyAddress}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold transition-all border ${addressCopied ? 'bg-[#00AF5C]/10 border-[#00AF5C]/30 text-[#00AF5C]' : 'bg-[#1A1A1A] border-[#2D2D2D] text-[#A0A0A0] hover:text-[#FFFFFF] hover:border-[#555555]'}`}
                  >
                    <span className="text-[#555555]">Radmin VPN:</span>
                    <span className="tabular-nums">{primaryAddress}</span>
                    {addressCopied ? <Check size={12} /> : <Copy size={12} className="opacity-60" />}
                  </motion.button>
                </Tooltip>
              ) : (
                <Tooltip content="Install and start Radmin VPN to share a joinable address." side="bottom" align="start" className="mt-1 self-start">
                  <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold border bg-[#1A1A1A] border-[#2D2D2D] text-[#555555]">
                    Radmin VPN: not detected
                  </span>
                </Tooltip>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Per-server Play — only shown once the server is actually online so
                we know we can join it. Doubles as an inline progress bar while
                the launcher downloads / installs / starts the game. */}
            {launcherSupported && isOnline && (
              <Tooltip content={
                joinSession.phase === 'idle'
                  ? 'Install client mods, launch Minecraft, and join this server'
                  : joinSession.fileCount?.total > 0 && joinSession.fileCount?.current > 0
                    ? `${joinSession.statusText} (${joinSession.fileCount.current} / ${joinSession.fileCount.total} files)`
                    : joinSession.statusText
              }>
              <motion.button
                whileHover={joinSession.phase === 'idle' ? { scale: 1.03 } : {}}
                whileTap={joinSession.phase === 'idle' ? { scale: 0.95 } : {}}
                onClick={handleJoin}
                disabled={joinSession.phase !== 'idle' && joinSession.phase !== 'launched'}
                className={`relative overflow-hidden flex items-center gap-2 px-4 py-2.5 border rounded-xl font-bold transition-colors duration-200 min-w-[140px] justify-center ${
                  joinSession.phase === 'launched'
                    ? 'border-[#00AF5C]/40 text-white'
                    : joinSession.phase === 'error'
                      ? 'border-[#FF5555]/40 text-white'
                      : joinSession.phase === 'running'
                        ? 'border-[#00AF5C]/40 text-white'
                        : 'bg-[#00AF5C]/10 hover:bg-[#00AF5C]/20 border-[#00AF5C]/20 text-[#00AF5C]'
                }`}
                style={joinSession.phase !== 'idle' ? {
                  background: joinSession.phase === 'error' ? '#7A2A2A'
                    : joinSession.phase === 'launched' ? '#00AF5C'
                    : '#1E1E1E',
                } : undefined}
              >
                {joinSession.phase !== 'idle' && (
                  <motion.div
                    initial={false}
                    animate={{ width: `${joinSession.progress}%` }}
                    transition={{ ease: [0.22, 1, 0.36, 1], duration: 0.5 }}
                    className="absolute inset-y-0 left-0 z-0"
                    style={{ background: joinSession.phase === 'error' ? '#FF5555' : '#00AF5C' }}
                  />
                )}
                <span className="relative z-10 flex items-center gap-2">
                  {joinSession.phase === 'launched' ? <Check size={16} />
                    : joinSession.phase === 'error' ? <AlertCircle size={16} />
                    : joinSession.phase === 'running' ? <Loader2 size={16} className="animate-spin" />
                    : <Play size={16} fill="currentColor" />}
                  <span>
                    {joinSession.phase === 'launched' ? 'Playing'
                      : joinSession.phase === 'error' ? 'Failed'
                      : joinSession.phase === 'running' ? `${joinSession.progress}%`
                      : 'Play'}
                  </span>
                </span>
              </motion.button>
              </Tooltip>
            )}
            {isOnline ? (
              <>
                <motion.button
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={handleStop}
                  disabled={loading}
                  className="flex items-center gap-2 px-5 py-2.5 bg-transparent hover:bg-[#2D2D2D] border border-transparent text-[#FFFFFF] rounded-xl font-bold transition-all duration-200 disabled:opacity-50"
                >
                  <Square size={16} />
                  <span>Stop</span>
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.03, boxShadow: '0 4px 20px rgba(0, 175, 92, 0.3)' }}
                  whileTap={{ scale: 0.95 }}
                  onClick={onRestartClick}
                  disabled={loading}
                  className="flex items-center gap-2 px-5 py-2.5 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl font-bold transition-all duration-200 shadow-sm disabled:opacity-50"
                >
                  <RefreshCw size={16} />
                  <span>Restart</span>
                </motion.button>
              </>
            ) : (
              <motion.button
                whileHover={{ scale: 1.03, boxShadow: '0 4px 20px rgba(0, 175, 92, 0.3)' }}
                whileTap={{ scale: 0.95 }}
                onClick={handleStart}
                disabled={loading}
                className="flex items-center gap-2 px-6 py-2.5 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl font-bold transition-all duration-200 shadow-sm disabled:opacity-50"
              >
                <Play size={16} fill="currentColor" />
                <span>Start Server</span>
              </motion.button>
            )}
            
            <div className="relative">
              <motion.button 
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.9 }}
                onClick={() => setShowSettings(!showSettings)} 
                className="p-2.5 bg-transparent hover:bg-[#2D2D2D] text-[#A0A0A0] hover:text-[#FFFFFF] rounded-xl transition-all duration-200"
              >
                <MoreVertical size={20} />
              </motion.button>
              <AnimatePresence>
                {showSettings && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowSettings(false)}></div>
                    <motion.div 
                      initial={{ opacity: 0, y: -4, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -4, scale: 0.95 }}
                      transition={{ duration: 0.15 }}
                      className="absolute right-0 mt-2 w-48 bg-[#1E1E1E] border border-[#2D2D2D] rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.5)] z-50 overflow-hidden"
                    >
                      <button 
                        onClick={() => {
                          setShowSettings(false);
                          setShowDeleteModal(true);
                        }} 
                        disabled={loading}
                        className="w-full text-left px-4 py-3 text-sm font-bold text-[#FF5555] hover:bg-[#FF5555]/10 flex items-center gap-2 transition-all duration-200 disabled:opacity-50"
                      >
                        <Trash2 size={16} /> Delete Server
                      </button>
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </motion.div>

      <motion.div 
        initial={{ opacity: 0, y: 8 }} 
        animate={{ opacity: 1, y: 0 }} 
        transition={{ duration: 0.4, delay: 0.1 }}
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6 flex-shrink-0"
      >
        <StatCard
          icon={<Cpu />}
          label="CPU usage"
          value={systemStats.cpu || '0%'}
          secondary="100%"
          color={getUsageColor(systemStats.cpu)}
          history={history.cpu}
        />
        <StatCard
          icon={<MemoryStick />}
          label="Memory usage"
          detail={isOnline ? (serverMemStats.ram || '0 MB') : '0 MB'}
          value={isOnline ? (serverMemStats.ramPercent || '0%') : '0%'}
          secondary="100%"
          color={isOnline ? getUsageColor(serverMemStats.ramPercent) : null}
          history={history.ram}
        />
        <StatCard
          icon={<Folder />}
          label="Storage usage"
          value={storageSize}
          history={history.storage}
          hint="Double-click to open instance folder"
          onDoubleClick={() => fetch(`http://localhost:3001/api/servers/${server.id}/open-folder`, { method: 'POST' }).catch(() => {})}
        />
        <StatCard
          icon={<Users />}
          label="Players online"
          value={isOnline ? `${serverStats.players.length}` : '0'}
        />
      </motion.div>

      <motion.div 
        initial={{ opacity: 0, y: 8 }} 
        animate={{ opacity: 1, y: 0 }} 
        transition={{ duration: 0.4, delay: 0.15 }}
        className="flex-1 flex flex-col min-h-[350px]"
      >
        {/* Animated Tabs */}
        <div className="flex items-center gap-1 mb-4 border-b border-[#2D2D2D] pb-px relative">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-3 font-bold text-sm transition-all duration-200 relative rounded-t-xl ${
                activeTab === tab.key 
                  ? 'text-[#00AF5C]' 
                  : 'text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#1E1E1E]'
              }`}
            >
              {tab.label}
              {activeTab === tab.key && (
                <motion.div
                  layoutId="activeTabIndicator"
                  className="absolute bottom-0 left-0 right-0 h-[3px] bg-[#00AF5C] rounded-t-full"
                  transition={{
                    type: 'spring',
                    stiffness: 500,
                    damping: 35,
                    mass: 0.8,
                  }}
                />
              )}
            </button>
          ))}
        </div>
        
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="flex-1 flex flex-col min-h-0"
          >
            {activeTab === 'console' && <ConsoleViewer serverId={server.id} socket={socket} />}
            {activeTab === 'players' && <PlayersViewer serverId={server.id} socket={socket} onError={onError} />}
            {activeTab === 'activity' && <ActivityTimeline events={activityEvents} />}
            {activeTab === 'mods' && isPaper && (
              <PluginsViewer serverId={server.id} serverVersion={server.version} onError={onError} />
            )}
            {activeTab === 'mods' && !isPaper && !isVanilla && (
              <ModsViewer serverId={server.id} serverVersion={server.version} serverType={server.type} socket={socket} onError={onError} modpackInstalls={modpackInstalls} onOpenDetail={onOpenDetail} />
            )}
            {activeTab === 'map' && !isVanilla && (
              <MapViewer serverId={server.id} server={server} socket={socket} onError={onError} />
            )}
            {activeTab === 'backups' && <BackupsViewer serverId={server.id} server={server} onError={onError} />}
            {activeTab === 'schedule' && <ScheduleViewer serverId={server.id} onError={onError} />}
            {activeTab === 'network' && <NetworkPanel serverId={server.id} server={server} socket={socket} />}
            {activeTab === 'options' && <OptionsViewer server={server} onError={onError} />}
          </motion.div>
        </AnimatePresence>
      </motion.div>

      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div 
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            transition={{ type: 'spring', duration: 0.4, bounce: 0.2 }}
            className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-3 bg-[#1E1E1E] border border-[#00AF5C]/30 text-[#FFFFFF] rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.5)]"
          >
            <div className="w-2 h-2 rounded-full bg-[#00AF5C] animate-pulse" />
            <span className="text-sm font-medium">{toast}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default MainPanel;
