import React, { useState, useEffect } from 'react';
import { User, Trash2, Check, Loader2, ExternalLink, X, ShieldCheck, UserCircle2, AlertCircle, Image, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import SkinHead from './SkinHead';
import ModalPortal from './ModalPortal';
import { TITLEBAR_OFFSET } from '../lib/titlebar';

// Compact relative time for the "last used" line. Returns '' for no timestamp.
function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`;
}

export default function AccountManager({ accounts, activeAccountId, microsoftConfigured, elybySkinsDefault = true, onChanged, onError }) {
  const [offlineOpen, setOfflineOpen] = useState(false);
  const [offlineName, setOfflineName] = useState('');
  const [offlineSkins, setOfflineSkins] = useState(elybySkinsDefault);
  const [offlineBusy, setOfflineBusy] = useState(false);
  const [offlineErr, setOfflineErr] = useState('');
  // Which offline account's per-account skins toggle is mid-PATCH (disables it).
  const [skinToggleBusy, setSkinToggleBusy] = useState(null);
  // Per-account cache-bust values: bumping one forces that account's SkinHead
  // to re-fetch after a skin refresh (the backend cache is purged first).
  const [skinBust, setSkinBust] = useState({});
  const [skinRefreshBusy, setSkinRefreshBusy] = useState(null);

  // Purge the backend's cached head for this username, then bump the bust
  // value so the <img> re-fetches immediately. Lets the user pull in a skin
  // they just changed on ely.by (or Mojang) without waiting out the cache.
  const handleRefreshSkin = async (account) => {
    setSkinRefreshBusy(account.id);
    try {
      await fetch(`http://localhost:3001/api/launcher/skins/${encodeURIComponent(account.username)}/refresh`, { method: 'POST' });
      setSkinBust(prev => ({ ...prev, [account.id]: Date.now() }));
    } catch (err) {
      onError?.(err.message);
    }
    setSkinRefreshBusy(null);
  };

  const openOffline = () => { setOfflineName(''); setOfflineErr(''); setOfflineSkins(elybySkinsDefault); setOfflineOpen(true); };

  const handleToggleAccountSkins = async (id, next) => {
    setSkinToggleBusy(id);
    try {
      const r = await fetch(`http://localhost:3001/api/launcher/accounts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ elybySkins: next }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to update skins setting');
      onChanged?.();
    } catch (err) {
      onError?.(err.message);
    }
    setSkinToggleBusy(null);
  };

  const [msSession, setMsSession] = useState(null); // { id, link, status, error }
  const [msStarting, setMsStarting] = useState(false);

  // Poll a pending Microsoft sign-in until it completes or errors.
  useEffect(() => {
    if (!msSession?.id || msSession.status !== 'pending') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`http://localhost:3001/api/launcher/accounts/microsoft/poll/${msSession.id}`);
        const d = await r.json();
        if (cancelled) return;
        if (d.status && d.status !== 'pending') {
          setMsSession(s => ({ ...s, status: d.status, error: d.error }));
          if (d.status === 'complete') onChanged?.();
        }
      } catch {}
    };
    const handle = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(handle); };
  }, [msSession?.id, msSession?.status, onChanged]);

  const handleAddMicrosoft = async () => {
    setMsStarting(true);
    try {
      const r = await fetch('http://localhost:3001/api/launcher/accounts/microsoft/start', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to start sign-in');
      setMsSession({ id: d.sessionId, link: d.link, status: 'pending' });
      window.open(d.link, '_blank', 'noopener,noreferrer');
    } catch (err) {
      onError?.(err.message);
    }
    setMsStarting(false);
  };

  const handleAddOffline = async () => {
    setOfflineErr('');
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(offlineName.trim())) {
      setOfflineErr('3–16 characters: letters, digits, underscore.');
      return;
    }
    setOfflineBusy(true);
    try {
      const r = await fetch('http://localhost:3001/api/launcher/accounts/offline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: offlineName.trim(), elybySkins: offlineSkins }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to add account');
      setOfflineOpen(false);
      setOfflineName('');
      onChanged?.();
    } catch (err) {
      setOfflineErr(err.message);
    }
    setOfflineBusy(false);
  };

  const handleActivate = async (id) => {
    try {
      const r = await fetch(`http://localhost:3001/api/launcher/accounts/${id}/activate`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed');
      onChanged?.();
    } catch (err) {
      onError?.(err.message);
    }
  };

  const handleDelete = async (id) => {
    try {
      const r = await fetch(`http://localhost:3001/api/launcher/accounts/${id}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed');
      onChanged?.();
    } catch (err) {
      onError?.(err.message);
    }
  };

  return (
    <div className="bg-[#1A1A1A] border border-[#2D2D2D] rounded-3xl p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[#00AF5C]/10 rounded-xl"><User size={18} className="text-[#00AF5C]" /></div>
          <h2 className="text-lg font-bold text-[#FFFFFF]">Accounts</h2>
        </div>
        <div className="flex items-center gap-2">
          {microsoftConfigured && (
            <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
              onClick={handleAddMicrosoft}
              disabled={msStarting}
              className="flex items-center gap-2 px-3 py-2 bg-[#1E1E1E] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#FFFFFF] rounded-xl text-xs font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed">
              {msStarting ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              Add Microsoft
            </motion.button>
          )}
          <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
            onClick={openOffline}
            className="flex items-center gap-2 px-3 py-2 bg-[#1E1E1E] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#FFFFFF] rounded-xl text-xs font-bold transition-all">
            <UserCircle2 size={14} /> Add Offline
          </motion.button>
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="flex flex-col items-center py-8 text-[#555555]">
          <User size={32} className="mb-3 opacity-30" />
          <p className="text-sm font-bold">No accounts yet</p>
          <p className="text-xs mt-1">{microsoftConfigured ? 'Add Microsoft for online play, or Offline for LAN/cracked.' : 'Add an offline account to start playing.'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map(a => {
            const active = a.id === activeAccountId;
            return (
              <div key={a.id}
                className={`flex items-center gap-3 p-3 rounded-2xl border transition-all ${active ? 'bg-[#00AF5C]/5 border-[#00AF5C]/30' : 'bg-[#1E1E1E] border-[#2D2D2D] hover:border-[#555555]'}`}>
                <SkinHead username={a.username} uuid={a.uuid} type={a.type} elybySkins={a.elybySkins} elybyUuid={a.elybyUuid} bust={skinBust[a.id]} size={40} rounded="rounded-xl" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-sm text-[#FFFFFF] truncate">{a.username}</span>
                    {active && <span className="text-[10px] font-bold uppercase tracking-wider text-[#00AF5C]">Active</span>}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-[#555555] uppercase tracking-wider font-bold">{a.type}</span>
                    {a.lastUsedAt && (
                      <span className="text-[10px] text-[#555555] font-bold">· Last used {timeAgo(a.lastUsedAt)}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button onClick={() => handleRefreshSkin(a)}
                    disabled={skinRefreshBusy === a.id}
                    title="Refresh skin — re-fetch the head if you changed your skin"
                    className="p-2 text-[#A0A0A0] hover:text-[#00AF5C] hover:bg-[#00AF5C]/10 rounded-lg transition-all disabled:opacity-50">
                    <RefreshCw size={14} className={skinRefreshBusy === a.id ? 'animate-spin' : ''} />
                  </button>
                  {a.type === 'offline' && (
                    <button onClick={() => handleToggleAccountSkins(a.id, !a.elybySkins)}
                      disabled={skinToggleBusy === a.id}
                      title={a.elybySkins ? 'Ely.by skins on — click to turn off' : 'Ely.by skins off — click to turn on'}
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all disabled:opacity-50 ${
                        a.elybySkins ? 'text-[#00AF5C] bg-[#00AF5C]/10' : 'text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#2D2D2D]'
                      }`}>
                      {skinToggleBusy === a.id ? <Loader2 size={12} className="animate-spin" /> : <Image size={12} />}
                      Skin
                    </button>
                  )}
                  {!active && (
                    <button onClick={() => handleActivate(a.id)}
                      className="px-3 py-1.5 text-xs font-bold text-[#A0A0A0] hover:text-[#00AF5C] hover:bg-[#00AF5C]/10 rounded-lg transition-all">
                      Use
                    </button>
                  )}
                  <button onClick={() => handleDelete(a.id)} title="Remove account"
                    className="p-2 text-[#A0A0A0] hover:text-[#FF5555] hover:bg-[#FF5555]/10 rounded-lg transition-all">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Microsoft sign-in modal */}
      <AnimatePresence>
        {msSession && (
          <ModalPortal>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-x-0 bottom-0 bg-[#000000]/80 backdrop-blur-sm z-[100] flex items-center justify-center"
            style={{ top: TITLEBAR_OFFSET }}
            onClick={() => msSession.status !== 'pending' && setMsSession(null)}>
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
              className="bg-[#1A1A1A] border border-[#2D2D2D] p-6 rounded-3xl w-full max-w-md shadow-2xl mx-4"
              onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-[#00AF5C]/10 rounded-xl"><ShieldCheck size={18} className="text-[#00AF5C]" /></div>
                  <h3 className="text-lg font-bold text-[#FFFFFF]">Microsoft Sign-In</h3>
                </div>
                <button onClick={() => setMsSession(null)}
                  className="p-2 text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#2D2D2D] rounded-xl transition-all">
                  <X size={18} />
                </button>
              </div>
              {msSession.status === 'pending' && (
                <>
                  <p className="text-sm text-[#A0A0A0] mb-4 leading-relaxed">
                    A browser tab opened for sign-in. After you finish, this window will update automatically.
                  </p>
                  <a href={msSession.link} target="_blank" rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-[#1E1E1E] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#FFFFFF] rounded-xl text-sm font-bold transition-all mb-3">
                    <ExternalLink size={14} /> Open sign-in page again
                  </a>
                  <div className="flex items-center justify-center gap-2 text-xs text-[#555555]">
                    <Loader2 size={12} className="animate-spin" /> Waiting for sign-in to complete…
                  </div>
                </>
              )}
              {msSession.status === 'complete' && (
                <>
                  <div className="flex items-center gap-2 px-3 py-2 mb-4 bg-[#00AF5C]/10 border border-[#00AF5C]/20 rounded-xl text-sm text-[#00AF5C] font-bold">
                    <Check size={16} /> Signed in successfully.
                  </div>
                  <button onClick={() => setMsSession(null)}
                    className="w-full px-4 py-2.5 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-sm font-bold transition-all">
                    Done
                  </button>
                </>
              )}
              {msSession.status === 'error' && (
                <>
                  <div className="flex items-start gap-2 px-3 py-2 mb-4 bg-[#FF5555]/10 border border-[#FF5555]/20 rounded-xl text-sm text-[#FF5555]">
                    <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
                    <span>{msSession.error || 'Sign-in failed.'}</span>
                  </div>
                  <button onClick={() => setMsSession(null)}
                    className="w-full px-4 py-2.5 bg-[#1E1E1E] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#FFFFFF] rounded-xl text-sm font-bold transition-all">
                    Close
                  </button>
                </>
              )}
            </motion.div>
          </motion.div>
          </ModalPortal>
        )}
      </AnimatePresence>

      {/* Offline username modal */}
      <AnimatePresence>
        {offlineOpen && (
          <ModalPortal>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-x-0 bottom-0 bg-[#000000]/80 backdrop-blur-sm z-[100] flex items-center justify-center"
            style={{ top: TITLEBAR_OFFSET }}
            onClick={() => !offlineBusy && setOfflineOpen(false)}>
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
              className="bg-[#1A1A1A] border border-[#2D2D2D] p-6 rounded-3xl w-full max-w-md shadow-2xl mx-4"
              onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-[#2D2D2D] rounded-xl"><UserCircle2 size={18} className="text-[#A0A0A0]" /></div>
                  <h3 className="text-lg font-bold text-[#FFFFFF]">Offline Account</h3>
                </div>
                <button onClick={() => !offlineBusy && setOfflineOpen(false)}
                  className="p-2 text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#2D2D2D] rounded-xl transition-all">
                  <X size={18} />
                </button>
              </div>
              <p className="text-sm text-[#A0A0A0] mb-4 leading-relaxed">
                Use any Minecraft username. This works for LAN play and offline-mode servers, but won't authenticate against premium servers.
              </p>
              <label className="text-xs font-bold text-[#A0A0A0] block mb-1.5">Username</label>
              <input type="text" autoFocus value={offlineName}
                onChange={e => { setOfflineName(e.target.value); if (offlineErr) setOfflineErr(''); }}
                onKeyDown={e => { if (e.key === 'Enter') handleAddOffline(); if (e.key === 'Escape') setOfflineOpen(false); }}
                placeholder="Steve"
                disabled={offlineBusy}
                className={`w-full bg-[#111111] border ${offlineErr ? 'border-[#FF5555] focus:ring-[#FF5555]/10' : 'border-[#2D2D2D] focus:border-[#00AF5C] focus:ring-[#00AF5C]/10'} rounded-xl px-3 py-2.5 text-sm text-[#FFFFFF] outline-none focus:ring-4 transition-all font-medium`} />
              {offlineErr && <p className="text-xs text-[#FF5555] font-medium mt-2">{offlineErr}</p>}

              <label className="flex items-start gap-2.5 mt-4 cursor-pointer group">
                <span className="custom-checkbox-wrapper mt-0.5">
                  <input type="checkbox" className="custom-checkbox" checked={offlineSkins}
                    onChange={e => setOfflineSkins(e.target.checked)} disabled={offlineBusy} />
                  <span className="custom-checkbox-visual" />
                </span>
                <span className="min-w-0">
                  <span className="text-sm font-bold text-[#FFFFFF] group-hover:text-[#FFFFFF]">Use Ely.by skins</span>
                  <span className="block text-[11px] text-[#A0A0A0] leading-snug mt-0.5">
                    Shows the skin uploaded to the free Ely.by account with this username — in MineDash, and in-game on servers that support it. No Ely.by login needed.
                  </span>
                </span>
              </label>

              <div className="flex justify-end gap-3 pt-5 mt-5 border-t border-[#2D2D2D]">
                <button onClick={() => setOfflineOpen(false)} disabled={offlineBusy}
                  className="px-4 py-2 bg-[#111111] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#FFFFFF] rounded-xl text-sm font-bold transition-all disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={handleAddOffline} disabled={offlineBusy || !offlineName.trim()}
                  className="px-4 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-sm font-bold transition-all flex items-center gap-2 disabled:opacity-50">
                  {offlineBusy && <Loader2 size={14} className="animate-spin" />}
                  Add account
                </button>
              </div>
            </motion.div>
          </motion.div>
          </ModalPortal>
        )}
      </AnimatePresence>

    </div>
  );
}
