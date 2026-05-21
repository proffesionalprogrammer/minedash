import React, { useState, useEffect } from 'react';
import { Users, Shield, ShieldOff, UserX, Ban, MapPin, Copy, Check } from 'lucide-react';

function PlayersViewer({ serverId, socket, onError }) {
  const [players, setPlayers] = useState([]);
  const [actionLoading, setActionLoading] = useState({});
  const [copied, setCopied] = useState(null);

  useEffect(() => {
    // Fetch initial players from stats endpoint
    fetch(`http://localhost:3001/api/servers/${serverId}/stats`)
      .then(r => r.json())
      .then(data => {
        if (data.players) setPlayers(data.players);
      })
      .catch(() => {});

    // Listen for live updates
    const handlePlayersUpdate = (playerList) => {
      setPlayers(playerList);
    };

    socket.on(`players_update_${serverId}`, handlePlayersUpdate);

    return () => {
      socket.off(`players_update_${serverId}`, handlePlayersUpdate);
    };
  }, [serverId, socket]);

  const sendCommand = async (cmd, playerName) => {
    setActionLoading(prev => ({ ...prev, [`${cmd}-${playerName}`]: true }));
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${serverId}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd })
      });
      if (!res.ok) throw new Error('Failed to send command');
    } catch (err) {
      if (onError) onError(err.message);
    }
    setTimeout(() => {
      setActionLoading(prev => ({ ...prev, [`${cmd}-${playerName}`]: false }));
    }, 1000);
  };

  const copyPlayerName = (name) => {
    navigator.clipboard.writeText(name);
    setCopied(name);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="flex-1 bg-[#111111] rounded-2xl border border-[#2D2D2D] flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#2D2D2D] bg-[#1A1A1A]">
        <div className="flex items-center gap-3">
          <Users size={18} className="text-[#A0A0A0]" />
          <h3 className="font-bold text-[#FFFFFF]">Online Players</h3>
          <span className="text-xs font-bold bg-[#00AF5C]/10 text-[#00AF5C] px-2.5 py-1 rounded-full">
            {players.length}
          </span>
        </div>
      </div>
      
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
                  {/* Player avatar from mc-heads */}
                  <div className="w-12 h-12 rounded-xl overflow-hidden border border-[#2D2D2D] flex-shrink-0 bg-[#111111]">
                    <img
                      src={`https://mc-heads.net/avatar/${playerName}/48`}
                      alt={playerName}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        e.target.style.display = 'none';
                      }}
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
                        {copied === playerName ? (
                          <Check size={14} className="text-[#00AF5C]" />
                        ) : (
                          <Copy size={14} />
                        )}
                      </button>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="w-2 h-2 rounded-full bg-[#00AF5C] animate-pulse" />
                      <span className="text-xs text-[#A0A0A0]">Online</span>
                    </div>
                  </div>
                </div>

                {/* Quick actions */}
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
    </div>
  );
}

export default PlayersViewer;
