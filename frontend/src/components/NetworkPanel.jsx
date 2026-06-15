import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Wifi, WifiOff, Copy, Check, Monitor, Gamepad2, RefreshCw, Zap, Loader2, X } from 'lucide-react';
import { staggerContainer, staggerItem } from '../lib/motion';
import Tooltip from './Tooltip';

const API = 'http://localhost:3001';

// MineDash Connect host sessions survive a Network-tab unmount (switching tabs
// inside MainPanel unmounts this component). Keyed by serverId so returning to
// the tab restores the live session instead of orphaning the tunnel. Only an
// explicit Stop tears the session down.
const hostSessions = {};

function NetworkPanel({ serverId, socket }) {
  const [addresses, setAddresses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(null);
  const [serverPort, setServerPort] = useState('25565');

  // ── MineDash Connect (direct P2P tunnel) host state ──
  // idle | gathering | awaiting-reply | connecting | connected | failed
  const [hostState, setHostState] = useState('idle');
  const [hostSessionId, setHostSessionId] = useState(null);
  const [inviteCode, setInviteCode] = useState('');
  const [replyInput, setReplyInput] = useState('');
  const [hostDetail, setHostDetail] = useState('');

  useEffect(() => {
    fetchNetworkInfo();
    fetchServerPort();
  }, [serverId]);

  // Restore an in-progress host session when remounting onto the Network tab.
  useEffect(() => {
    const saved = hostSessions[serverId];
    if (!saved) return;
    setHostSessionId(saved.sessionId);
    setInviteCode(saved.inviteCode);
    setHostState('connecting');
    fetch(`${API}/api/connect/${saved.sessionId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((st) => {
        if (st.status === 'connected') setHostState('connected');
        else if (st.status === 'failed') setHostState('failed');
        else if (st.status === 'connecting') setHostState('connecting');
        else setHostState('awaiting-reply');
      })
      .catch(() => {
        // Session gone (e.g. backend restarted) — reset to idle.
        delete hostSessions[serverId];
        setHostSessionId(null);
        setInviteCode('');
        setHostState('idle');
      });
  }, [serverId]);

  // Live status for the active host session.
  useEffect(() => {
    if (!hostSessionId || !socket) return;
    const channel = `connect_status_${hostSessionId}`;
    const handler = (p) => {
      if (p.state === 'connected') { setHostState('connected'); setHostDetail(''); }
      else if (p.state === 'connecting') setHostState('connecting');
      else if (p.state === 'failed') { setHostState('failed'); setHostDetail(p.detail || 'Connection failed.'); }
    };
    socket.on(channel, handler);
    return () => socket.off(channel, handler);
  }, [hostSessionId, socket]);

  const fetchNetworkInfo = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/network`);
      const data = await res.json();
      if (data.addresses) setAddresses(data.addresses);
    } catch (err) {
      console.error('Failed to fetch network info:', err);
    }
    setLoading(false);
  };

  const fetchServerPort = async () => {
    try {
      const res = await fetch(`${API}/api/servers/${serverId}/properties`);
      const props = await res.json();
      if (props['server-port']) setServerPort(props['server-port']);
    } catch {}
  };

  const copyText = (text, key) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const startHost = async () => {
    setHostState('gathering');
    setHostDetail('');
    setReplyInput('');
    try {
      const res = await fetch(`${API}/api/connect/host/${serverId}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start session');
      hostSessions[serverId] = { sessionId: data.sessionId, inviteCode: data.inviteCode };
      setHostSessionId(data.sessionId);
      setInviteCode(data.inviteCode);
      setHostState('awaiting-reply');
    } catch (e) {
      setHostState('idle');
      setHostDetail(e.message);
    }
  };

  const submitReply = async () => {
    const code = replyInput.trim();
    if (!code || !hostSessionId) return;
    setHostState('connecting');
    setHostDetail('');
    try {
      const res = await fetch(`${API}/api/connect/host/${hostSessionId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replyCode: code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Invalid reply code');
      // Success → wait for the socket 'connected' event.
    } catch (e) {
      setHostState('awaiting-reply');
      setHostDetail(e.message);
    }
  };

  const stopHost = async () => {
    const id = hostSessionId;
    delete hostSessions[serverId];
    setHostSessionId(null);
    setInviteCode('');
    setReplyInput('');
    setHostDetail('');
    setHostState('idle');
    if (id) { try { await fetch(`${API}/api/connect/${id}`, { method: 'DELETE' }); } catch {} }
  };

  const getAdapterLabel = (addr) => {
    if (addr.isRadmin) return 'Radmin VPN';
    if (addr.isHamachi) return 'Hamachi';
    return 'Local Network';
  };

  const vpnAddress = addresses.find(a => a.isRadmin || a.isHamachi);
  const lanAddresses = addresses.filter(a => !a.isRadmin && !a.isHamachi);

  return (
    <div className="flex-1 bg-[#111111] rounded-2xl border border-[#2D2D2D] flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#2D2D2D] bg-[#1A1A1A]">
        <div className="flex items-center gap-3">
          <Wifi size={18} className="text-[#A0A0A0]" />
          <h3 className="font-bold text-[#FFFFFF]">Connection Info</h3>
        </div>
        <Tooltip content="Refresh" align="end">
        <motion.button
          onClick={fetchNetworkInfo}
          whileTap={{ scale: 0.9 }}
          className="p-2 text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#2D2D2D] rounded-xl transition-all"
        >
          <motion.span
            className="block"
            animate={loading ? { rotate: 360 } : { rotate: 0 }}
            transition={loading ? { repeat: Infinity, duration: 0.8, ease: 'linear' } : { duration: 0.3, ease: 'easeOut' }}
          >
            <RefreshCw size={16} />
          </motion.span>
        </motion.button>
        </Tooltip>
      </div>

      <div className="flex-1 overflow-y-auto p-6 custom-scrollbar space-y-6">
        {loading ? (
          <div className="flex items-center justify-center h-full text-[#A0A0A0]">
            Loading network info...
          </div>
        ) : (
          <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-6">
            {/* ── MineDash Connect — direct P2P tunnel (no Radmin needed) ──── */}
            <motion.div variants={staggerItem} className="bg-[#1E1E1E] border border-[#2D2D2D] rounded-2xl p-6">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <Zap size={16} className="text-[#00AF5C]" />
                  <span className="text-xs font-bold text-[#00AF5C] uppercase tracking-wider">
                    MineDash Connect — Direct
                  </span>
                  <span className="px-1.5 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[9px] font-bold uppercase tracking-wider">
                    Beta
                  </span>
                </div>
                {hostState !== 'idle' && (
                  <button
                    onClick={stopHost}
                    className="flex items-center gap-1 text-xs font-bold text-[#FF5555] hover:text-[#FF4444] transition-colors"
                  >
                    <X size={14} /> Stop
                  </button>
                )}
              </div>
              <p className="text-sm text-[#A0A0A0] mb-4">
                Let a friend connect straight through MineDash — no Radmin, no router setup. They just need MineDash too.
                <span className="text-[#555555]"> Make sure this server is running first.</span>
              </p>

              {hostState === 'idle' && (
                <motion.button
                  onClick={startHost}
                  whileTap={{ scale: 0.97 }}
                  className="flex items-center gap-2 px-4 py-2.5 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl font-bold text-sm transition-all"
                >
                  <Zap size={16} /> Host a direct session
                </motion.button>
              )}

              {hostState === 'gathering' && (
                <div className="flex items-center gap-2 text-sm text-[#A0A0A0]">
                  <Loader2 size={16} className="animate-spin text-[#00AF5C]" /> Preparing your invite code…
                </div>
              )}

              {(hostState === 'awaiting-reply' || hostState === 'connecting') && (
                <div className="space-y-4">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-bold text-[#555555]">
                      1 · Send this invite code to your friend
                    </label>
                    <div className="flex items-stretch gap-2 mt-1.5">
                      <textarea
                        readOnly
                        value={inviteCode}
                        onFocus={(e) => e.target.select()}
                        className="flex-1 h-16 bg-[#111111] border border-[#2D2D2D] rounded-xl px-3 py-2 font-mono text-xs text-[#A0A0A0] resize-none custom-scrollbar outline-none"
                      />
                      <button
                        onClick={() => copyText(inviteCode, 'invite')}
                        className="px-4 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl font-bold text-sm transition-all active:scale-95 flex items-center gap-2 flex-shrink-0"
                      >
                        {copied === 'invite' ? <Check size={16} /> : <Copy size={16} />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider font-bold text-[#555555]">
                      2 · Paste their reply code here
                    </label>
                    <textarea
                      value={replyInput}
                      onChange={(e) => { setReplyInput(e.target.value); if (hostDetail) setHostDetail(''); }}
                      placeholder="Paste the reply code your friend sends back…"
                      className="w-full h-16 mt-1.5 bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] focus:ring-4 focus:ring-[#00AF5C]/10 rounded-xl px-3 py-2 font-mono text-xs text-[#FFFFFF] resize-none custom-scrollbar outline-none transition-all placeholder-[#555555]"
                    />
                    {hostDetail && <p className="text-xs text-[#FF5555] font-medium mt-1.5">{hostDetail}</p>}
                    <motion.button
                      onClick={submitReply}
                      disabled={!replyInput.trim() || hostState === 'connecting'}
                      whileTap={{ scale: 0.97 }}
                      className="flex items-center gap-2 px-4 py-2.5 mt-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl font-bold text-sm transition-all disabled:opacity-50"
                    >
                      {hostState === 'connecting'
                        ? <><Loader2 size={16} className="animate-spin" /> Connecting…</>
                        : <>Connect</>}
                    </motion.button>
                  </div>
                </div>
              )}

              {hostState === 'connected' && (
                <div className="bg-[#00AF5C]/5 border border-[#00AF5C]/20 rounded-xl p-4 flex items-center gap-3">
                  <div className="p-2 bg-[#00AF5C]/10 rounded-lg flex-shrink-0">
                    <Check size={16} className="text-[#00AF5C]" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-[#FFFFFF]">Friend connected</p>
                    <p className="text-xs text-[#A0A0A0]">The tunnel stays open while MineDash runs. Hit Stop to end it.</p>
                  </div>
                </div>
              )}

              {hostState === 'failed' && (
                <div className="space-y-3">
                  <div className="bg-[#FF5555]/5 border border-[#FF5555]/20 rounded-xl p-4 text-sm text-[#FF5555] font-medium">
                    {hostDetail || 'Could not connect directly.'}
                  </div>
                  <p className="text-xs text-[#A0A0A0]">
                    Direct connections fail on strict networks (e.g. mobile / CGNAT). Hit Stop and use the Radmin VPN option below instead.
                  </p>
                </div>
              )}
            </motion.div>

            {/* ── Radmin / Hamachi VPN ──────────────────────────────── */}
            {vpnAddress ? (
              <motion.div variants={staggerItem} className="bg-[#00AF5C]/5 border border-[#00AF5C]/20 rounded-2xl p-6">
                <div className="flex items-center gap-2 mb-1">
                  <Wifi size={16} className="text-[#00AF5C]" />
                  <span className="text-xs font-bold text-[#00AF5C] uppercase tracking-wider">
                    {getAdapterLabel(vpnAddress)} — Share this with friends
                  </span>
                </div>
                <div className="flex items-center gap-4 mt-3">
                  <div className="flex-1 bg-[#111111] border border-[#2D2D2D] rounded-xl px-5 py-3.5 font-mono text-xl text-[#FFFFFF] font-bold tracking-wide">
                    {vpnAddress.ip}:{serverPort}
                  </div>
                  <button
                    onClick={() => copyText(`${vpnAddress.ip}:${serverPort}`, 'vpn')}
                    className="px-5 py-3.5 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl font-bold transition-all active:scale-95 flex items-center gap-2 flex-shrink-0"
                  >
                    {copied === 'vpn' ? <><Check size={18} />Copied!</> : <><Copy size={18} />Copy</>}
                  </button>
                </div>
                <p className="text-xs text-[#A0A0A0] mt-3">
                  <span className="text-[#555555]">Adapter:</span> {vpnAddress.name}
                </p>
              </motion.div>
            ) : (
              <motion.div variants={staggerItem} className="bg-[#1E1E1E] border border-[#2D2D2D] rounded-2xl p-5">
                <div className="flex items-center gap-3 mb-2">
                  <WifiOff size={18} className="text-[#555555]" />
                  <span className="text-sm font-bold text-[#A0A0A0]">No VPN Detected</span>
                </div>
                <p className="text-sm text-[#555555]">
                  Radmin VPN or Hamachi is not running. Install Radmin VPN on both machines to play together.
                </p>
              </motion.div>
            )}

            {/* ── LAN Addresses ─────────────────────────────────────── */}
            {lanAddresses.length > 0 && (
              <motion.div variants={staggerItem}>
                <h4 className="text-xs font-bold text-[#A0A0A0] uppercase tracking-wider mb-3 px-1">
                  Local Network Addresses
                </h4>
                <motion.div className="space-y-2" variants={staggerContainer} initial="initial" animate="animate">
                  {lanAddresses.map((addr, i) => (
                    <motion.div
                      key={i}
                      variants={staggerItem}
                      whileHover={{ x: 2 }}
                      className="flex items-center justify-between p-4 bg-[#1E1E1E] border border-[#2D2D2D] rounded-2xl hover:border-[#555555] transition-colors group"
                    >
                      <div className="flex items-center gap-4">
                        <div className="p-2.5 bg-[#111111] rounded-xl border border-[#2D2D2D]">
                          <Monitor size={18} className="text-[#A0A0A0]" />
                        </div>
                        <div>
                          <span className="font-mono font-bold text-[#FFFFFF]">
                            {addr.ip}:{serverPort}
                          </span>
                          <p className="text-xs text-[#555555] mt-0.5">{addr.name}</p>
                        </div>
                      </div>
                      <Tooltip content="Copy address" align="end">
                        <button
                          onClick={() => copyText(`${addr.ip}:${serverPort}`, `lan-${i}`)}
                          className="p-2.5 text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#2D2D2D] rounded-xl transition-all opacity-0 group-hover:opacity-100"
                        >
                          {copied === `lan-${i}` ? (
                            <Check size={16} className="text-[#00AF5C]" />
                          ) : (
                            <Copy size={16} />
                          )}
                        </button>
                      </Tooltip>
                    </motion.div>
                  ))}
                </motion.div>
              </motion.div>
            )}

            {/* ── How to Connect ─────────────────────────────────────── */}
            <motion.div variants={staggerItem} className="bg-[#1E1E1E] border border-[#2D2D2D] rounded-2xl p-6">
              <h4 className="text-sm font-bold text-[#FFFFFF] mb-3 flex items-center gap-2">
                <Gamepad2 size={16} className="text-[#A0A0A0]" />
                How to Connect
              </h4>
              <ol className="space-y-2 text-sm text-[#A0A0A0]">
                <li className="flex items-start gap-2">
                  <span className="text-[#00AF5C] font-bold flex-shrink-0">1.</span>
                  Install <span className="text-[#FFFFFF] font-medium">Radmin VPN</span> on both machines (free) and join the same network
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[#00AF5C] font-bold flex-shrink-0">2.</span>
                  Copy the Radmin VPN address above and share it with your friends
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[#00AF5C] font-bold flex-shrink-0">3.</span>
                  In Minecraft, go to <span className="text-[#FFFFFF] font-medium">Multiplayer → Add Server</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[#00AF5C] font-bold flex-shrink-0">4.</span>
                  Paste the address and connect!
                </li>
              </ol>
            </motion.div>
          </motion.div>
        )}
      </div>
    </div>
  );
}

export default NetworkPanel;
