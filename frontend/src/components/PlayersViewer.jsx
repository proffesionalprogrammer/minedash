import { useState, useEffect, useCallback } from 'react';
import {
  Users, Shield, ShieldOff, UserX, Ban, MapPin, Copy, Check,
  Plus, Trash2, ListChecks, Wifi, WifiOff, Globe, AlertTriangle, Loader2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const API = 'http://localhost:3001';

function OnlinePlayersView({ serverId, socket, onError }) {
  const [players, setPlayers] = useState([]);
  const [actionLoading, setActionLoading] = useState({});
  const [copied, setCopied] = useState(null);

  useEffect(() => {
    fetch(`${API}/api/servers/${serverId}/stats`)
      .then(r => r.json())
      .then(data => { if (data.players) setPlayers(data.players); })
      .catch(() => {});
    const handle = (list) => setPlayers(list);
    socket.on(`players_update_${serverId}`, handle);
    return () => socket.off(`players_update_${serverId}`, handle);
  }, [serverId, socket]);

  const sendCommand = async (cmd, playerName) => {
    const key = `${cmd}-${playerName}`;
    setActionLoading(prev => ({ ...prev, [key]: true }));
    try {
      const res = await fetch(`${API}/api/servers/${serverId}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      });
      if (!res.ok) throw new Error('Failed to send command');
    } catch (err) {
      if (onError) onError(err.message);
    }
    setTimeout(() => setActionLoading(prev => ({ ...prev, [key]: false })), 1000);
  };

  const copyPlayerName = (name) => {
    navigator.clipboard.writeText(name);
    setCopied(name);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
      {players.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-[#555555] font-medium">
          <Users size={48} className="mb-4 opacity-30" />
          <p>No players online</p>
          <p className="text-sm mt-1">Players will appear here when they join</p>
        </div>
      ) : (
        <div className="space-y-2 p-2">
          {players.map((playerName) => (
            <div
              key={playerName}
              className="flex items-center justify-between p-4 bg-[#1E1E1E] border border-[#2D2D2D] rounded-2xl hover:border-[#555555] transition-colors group"
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl overflow-hidden border border-[#2D2D2D] flex-shrink-0 bg-[#111111]">
                  <img
                    src={`https://mc-heads.net/avatar/${playerName}/48`}
                    alt={playerName}
                    className="w-full h-full object-cover"
                    onError={(e) => { e.target.style.display = 'none'; }}
                  />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="font-bold text-[#FFFFFF] text-lg">{playerName}</h4>
                    <button
                      onClick={() => copyPlayerName(playerName)}
                      className="p-1 text-[#555555] hover:text-[#FFFFFF] transition-colors"
                      title="Copy name"
                    >
                      {copied === playerName ? <Check size={14} className="text-[#00AF5C]" /> : <Copy size={14} />}
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="w-2 h-2 rounded-full bg-[#00AF5C] animate-pulse-glow" />
                    <span className="text-xs text-[#A0A0A0]">Online</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => sendCommand(`op ${playerName}`, playerName)}
                  disabled={actionLoading[`op ${playerName}-${playerName}`]}
                  className="p-2.5 text-[#A0A0A0] hover:text-[#00AF5C] hover:bg-[#00AF5C]/10 rounded-xl transition-all"
                  title="Give OP"
                >
                  <Shield size={16} />
                </button>
                <button
                  onClick={() => sendCommand(`deop ${playerName}`, playerName)}
                  disabled={actionLoading[`deop ${playerName}-${playerName}`]}
                  className="p-2.5 text-[#A0A0A0] hover:text-amber-500 hover:bg-amber-500/10 rounded-xl transition-all"
                  title="Remove OP"
                >
                  <ShieldOff size={16} />
                </button>
                <button
                  onClick={() => sendCommand(`tp ${playerName} ~ ~ ~`, playerName)}
                  disabled={actionLoading[`tp ${playerName} ~ ~ ~-${playerName}`]}
                  className="p-2.5 text-[#A0A0A0] hover:text-cyan-400 hover:bg-cyan-400/10 rounded-xl transition-all"
                  title="Teleport to Spawn"
                >
                  <MapPin size={16} />
                </button>
                <button
                  onClick={() => sendCommand(`kick ${playerName}`, playerName)}
                  disabled={actionLoading[`kick ${playerName}-${playerName}`]}
                  className="p-2.5 text-[#A0A0A0] hover:text-[#FF5555] hover:bg-[#FF5555]/10 rounded-xl transition-all"
                  title="Kick Player"
                >
                  <UserX size={16} />
                </button>
                <button
                  onClick={() => sendCommand(`ban ${playerName}`, playerName)}
                  disabled={actionLoading[`ban ${playerName}-${playerName}`]}
                  className="p-2.5 text-[#A0A0A0] hover:text-[#FF5555] hover:bg-[#FF5555]/10 rounded-xl transition-all"
                  title="Ban Player"
                >
                  <Ban size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const LIST_TABS = [
  { key: 'whitelist',  label: 'Whitelist',  icon: Shield, addPlaceholder: 'Add player to whitelist' },
  { key: 'ops',        label: 'Operators',  icon: Shield, addPlaceholder: 'Add operator (gives /op level 4)' },
  { key: 'banned',     label: 'Banned',     icon: Ban,    addPlaceholder: 'Ban player by name' },
  { key: 'banned-ips', label: 'Banned IPs', icon: Globe,  addPlaceholder: 'Ban an IP address' },
];

function PlayerListsView({ serverId, onError }) {
  const [activeList, setActiveList] = useState('whitelist');
  const [data, setData] = useState({ whitelist: [], ops: [], banned: [], bannedIps: [], running: false });
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  const fetchLists = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/servers/${serverId}/player-lists`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to load player lists');
      setData(d);
    } catch (err) {
      if (onError) onError(err.message);
    } finally {
      setLoading(false);
    }
  }, [serverId, onError]);

  useEffect(() => { fetchLists(); }, [fetchLists]);

  // When the server is live, the file changes via console command — give it a
  // beat to flush, then re-read.
  const refreshSoon = useCallback(() => {
    setTimeout(fetchLists, 800);
  }, [fetchLists]);

  const handleAdd = async (e) => {
    e?.preventDefault?.();
    const name = newName.trim();
    if (!name || adding) return;
    setAdding(true);
    try {
      const res = await fetch(`${API}/api/servers/${serverId}/player-lists/${activeList}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to add entry');
      setNewName('');
      if (d.via === 'file') {
        // We already know the new entry — patch local state immediately.
        await fetchLists();
      } else {
        refreshSoon();
      }
    } catch (err) {
      if (onError) onError(err.message);
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (entryName) => {
    try {
      const res = await fetch(
        `${API}/api/servers/${serverId}/player-lists/${activeList}/${encodeURIComponent(entryName)}`,
        { method: 'DELETE' }
      );
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to remove entry');
      if (d.via === 'file') await fetchLists(); else refreshSoon();
    } catch (err) {
      if (onError) onError(err.message);
    }
  };

  const entries = activeList === 'banned-ips' ? data.bannedIps : data[activeList === 'banned' ? 'banned' : activeList];
  const tab = LIST_TABS.find(t => t.key === activeList);
  const isIp = activeList === 'banned-ips';

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Sub-tabs across the lists */}
      <div className="flex items-center gap-1 px-4 pt-3 pb-2 border-b border-[#2D2D2D] bg-[#1A1A1A]">
        {LIST_TABS.map(t => {
          const Icon = t.icon;
          const isActive = activeList === t.key;
          const count = t.key === 'banned-ips' ? data.bannedIps.length : (data[t.key === 'banned' ? 'banned' : t.key] || []).length;
          return (
            <button
              key={t.key}
              onClick={() => { setActiveList(t.key); setNewName(''); }}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-bold transition-colors ${
                isActive
                  ? 'bg-[#00AF5C]/10 text-[#00AF5C]'
                  : 'text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#2D2D2D]'
              }`}
            >
              <Icon size={14} />
              {t.label}
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full tabular-nums ${
                isActive ? 'bg-[#00AF5C]/15 text-[#00AF5C]' : 'bg-[#2D2D2D] text-[#A0A0A0]'
              }`}>{count}</span>
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-1.5 text-xs font-bold text-[#A0A0A0]">
          {data.running ? (
            <><Wifi size={13} className="text-[#00AF5C]" /> live</>
          ) : (
            <><WifiOff size={13} className="text-[#555555]" /> file</>
          )}
        </div>
      </div>

      {/* Add row */}
      <form onSubmit={handleAdd} className="flex items-center gap-2 px-4 py-3 border-b border-[#2D2D2D]">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={tab?.addPlaceholder || 'Add entry'}
          disabled={adding}
          className="flex-1 bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] rounded-xl px-3 py-2 text-sm text-[#FFFFFF] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 font-medium placeholder-[#555555] disabled:opacity-50"
        />
        <motion.button
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          type="submit"
          disabled={!newName.trim() || adding}
          className="flex items-center gap-1.5 px-4 py-2 bg-[#00AF5C] hover:bg-[#00964F] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-sm font-bold transition-colors"
        >
          {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Add
        </motion.button>
      </form>

      {/* Entries */}
      <div className="flex-1 overflow-y-auto p-3 custom-scrollbar">
        {loading ? (
          <div className="flex items-center justify-center h-full text-[#555555]">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-[#555555] font-medium">
            <ListChecks size={48} className="mb-4 opacity-30" />
            <p>No entries on this list</p>
            <p className="text-sm mt-1">Add one with the field above.</p>
          </div>
        ) : (
          <div className="space-y-2">
            <AnimatePresence initial={false}>
              {entries.map((entry, i) => {
                const display = isIp ? entry.ip : entry.name;
                const reason = entry.reason;
                return (
                  <motion.div
                    key={display + '-' + i}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -8 }}
                    transition={{ duration: 0.18, delay: Math.min(i * 0.03, 0.3) }}
                    className="flex items-center justify-between p-3 bg-[#1E1E1E] border border-[#2D2D2D] rounded-2xl hover:border-[#555555] transition-colors group"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {isIp ? (
                        <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-[#111111] border border-[#2D2D2D] flex-shrink-0">
                          <Globe size={16} className="text-[#A0A0A0]" />
                        </div>
                      ) : (
                        <div className="w-9 h-9 rounded-xl overflow-hidden border border-[#2D2D2D] flex-shrink-0 bg-[#111111]">
                          <img
                            src={`https://mc-heads.net/avatar/${display}/36`}
                            alt={display}
                            className="w-full h-full object-cover"
                            onError={(e) => { e.target.style.display = 'none'; }}
                          />
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="font-bold text-[#FFFFFF] text-sm truncate">{display}</div>
                        {reason && (
                          <div className="text-xs text-[#A0A0A0] truncate">{reason}</div>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => handleRemove(display)}
                      className="p-2 text-[#555555] hover:text-[#FF5555] hover:bg-[#FF5555]/10 rounded-xl transition-colors opacity-0 group-hover:opacity-100"
                      title="Remove"
                    >
                      <Trash2 size={15} />
                    </button>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </div>

      {!data.running && (
        <div className="flex items-start gap-2 px-4 py-2.5 border-t border-[#2D2D2D] bg-[#1A1A1A] text-xs text-[#A0A0A0]">
          <AlertTriangle size={13} className="text-amber-400 mt-0.5 flex-shrink-0" />
          <span>
            Server is offline — writing to the JSON file directly. Cracked names use an offline UUID,
            premium names are resolved via Mojang.
          </span>
        </div>
      )}
    </div>
  );
}

function PlayersViewer({ serverId, socket, onError }) {
  const [subview, setSubview] = useState('online'); // 'online' | 'lists'

  return (
    <div className="flex-1 bg-[#111111] rounded-2xl border border-[#2D2D2D] flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#2D2D2D] bg-[#1A1A1A]">
        <div className="flex items-center gap-3">
          <Users size={18} className="text-[#A0A0A0]" />
          <h3 className="font-bold text-[#FFFFFF]">Players</h3>
        </div>
        <div className="flex items-center gap-1 p-1 bg-[#111111] border border-[#2D2D2D] rounded-xl">
          {[
            { key: 'online', label: 'Online', icon: Users },
            { key: 'lists',  label: 'Lists',  icon: ListChecks },
          ].map(opt => {
            const Icon = opt.icon;
            const active = subview === opt.key;
            return (
              <button
                key={opt.key}
                onClick={() => setSubview(opt.key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                  active ? 'bg-[#00AF5C]/10 text-[#00AF5C]' : 'text-[#A0A0A0] hover:text-[#FFFFFF]'
                }`}
              >
                <Icon size={13} />
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {subview === 'online'
        ? <OnlinePlayersView serverId={serverId} socket={socket} onError={onError} />
        : <PlayerListsView serverId={serverId} onError={onError} />}
    </div>
  );
}

export default PlayersViewer;
