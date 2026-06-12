import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Wifi, WifiOff, Copy, Check, Monitor, Gamepad2, RefreshCw } from 'lucide-react';
import { staggerContainer, staggerItem } from '../lib/motion';
import Tooltip from './Tooltip';

function NetworkPanel({ serverId, server, socket }) {
  const [addresses, setAddresses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(null);
  const [serverPort, setServerPort] = useState('25565');

  useEffect(() => {
    fetchNetworkInfo();
    fetchServerPort();
  }, [serverId]);

  const fetchNetworkInfo = async () => {
    setLoading(true);
    try {
      const res = await fetch('http://localhost:3001/api/network');
      const data = await res.json();
      if (data.addresses) setAddresses(data.addresses);
    } catch (err) {
      console.error('Failed to fetch network info:', err);
    }
    setLoading(false);
  };

  const fetchServerPort = async () => {
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${serverId}/properties`);
      const props = await res.json();
      if (props['server-port']) setServerPort(props['server-port']);
    } catch {}
  };

  const copyText = (text, key) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
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
