import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Map as MapIcon, Globe, Copy, Check, ExternalLink, RefreshCw,
  Loader2, Play, RotateCw, AlertTriangle, Ban, Info, X,
} from 'lucide-react';
import Tooltip from './Tooltip';

const HINT_KEY = 'minedash-bluemap-hint-dismissed';

const API = 'http://localhost:3001';

// BlueMap-backed live world map. MineDash installs BlueMap for the server, points
// its integrated webserver at a per-server port, and this component embeds that in
// an iframe once the server (and BlueMap's webserver) are up.
function MapViewer({ serverId, server, onError }) {
  const [status, setStatus] = useState(null); // { supported, enabled, port, running }
  const [loading, setLoading] = useState(true);
  const [enabling, setEnabling] = useState(false);
  const [busy, setBusy] = useState(false);     // start/restart in flight
  const [mapReady, setMapReady] = useState(false);
  const [addresses, setAddresses] = useState([]);
  const [copied, setCopied] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [hintDismissed, setHintDismissed] = useState(() => {
    try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; }
  });
  const justEnabledRef = useRef(false);
  const refreshTimers = useRef([]);

  const isOnline = server.status === 'online';
  const port = status?.port;

  const dismissHint = () => {
    setHintDismissed(true);
    try { localStorage.setItem(HINT_KEY, '1'); } catch (_) {}
  };

  const fetchStatus = async () => {
    try {
      const res = await fetch(`${API}/api/servers/${serverId}/map/status`);
      const data = await res.json();
      setStatus(data);
    } catch (_) {
      onError?.('Failed to load map status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    setMapReady(false);
    fetchStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  // Pull the host's LAN / VPN addresses so we can offer shareable map links.
  useEffect(() => {
    if (!status?.enabled) return;
    fetch(`${API}/api/network`)
      .then(r => r.json())
      .then(d => setAddresses(d.addresses || []))
      .catch(() => {});
  }, [status?.enabled]);

  // While enabled + online, poll BlueMap's webserver until it answers, then embed.
  useEffect(() => {
    if (!status?.enabled || !isOnline || !port) { setMapReady(false); return; }
    let cancelled = false;
    let timer;
    const ping = async () => {
      try {
        await fetch(`http://localhost:${port}/`, { mode: 'no-cors' });
        if (!cancelled) setMapReady(true);
      } catch (_) {
        if (!cancelled) timer = setTimeout(ping, 3000);
      }
    };
    ping();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [status?.enabled, isOnline, port]);

  // After a fresh enable, BlueMap's webserver is up immediately but the world
  // render runs in the background — the embed loads black until tiles exist and
  // the web app re-fetches them. Auto-reload the embed a couple of times so the
  // first render appears without the user clicking reload. Scoped to the
  // just-enabled session so it never resets the view on an already-rendered map.
  useEffect(() => {
    if (!mapReady || !justEnabledRef.current) return;
    justEnabledRef.current = false;
    refreshTimers.current = [45000, 90000].map(ms =>
      setTimeout(() => setReloadKey(k => k + 1), ms)
    );
    return () => { refreshTimers.current.forEach(clearTimeout); refreshTimers.current = []; };
  }, [mapReady]);

  const handleEnable = async () => {
    setEnabling(true);
    try {
      const res = await fetch(`${API}/api/servers/${serverId}/map/enable`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to enable the map');
      justEnabledRef.current = true; // arm the post-render auto-refresh
      await fetchStatus();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setEnabling(false);
    }
  };

  const handleStartOrRestart = async () => {
    setBusy(true);
    try {
      const ep = isOnline ? 'restart' : 'start';
      const res = await fetch(`${API}/api/servers/${serverId}/${ep}`, { method: 'POST' });
      if (!res.ok) throw new Error();
    } catch (_) {
      onError?.(`Failed to ${isOnline ? 'restart' : 'start'} the server`);
    } finally {
      setBusy(false);
    }
  };

  const copyText = (text, key) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1800);
  };

  const openInBrowser = () => { if (port) window.open(`http://localhost:${port}`, '_blank'); };

  const shell = (children) => (
    <div className="flex-1 bg-[#111111] rounded-2xl border border-[#2D2D2D] flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#2D2D2D] bg-[#1A1A1A]">
        <div className="flex items-center gap-3">
          <MapIcon size={18} className="text-[#A0A0A0]" />
          <h3 className="font-bold text-[#FFFFFF]">Live World Map</h3>
        </div>
        {status?.enabled && isOnline && mapReady && (
          <div className="flex items-center gap-1">
            <Tooltip content="Reload map" align="end">
              <button
                onClick={() => setReloadKey(k => k + 1)}
                className="p-2 text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#2D2D2D] rounded-xl transition-all"
              >
                <RefreshCw size={16} />
              </button>
            </Tooltip>
            <Tooltip content="Open in browser" align="end">
              <button
                onClick={openInBrowser}
                className="p-2 text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#2D2D2D] rounded-xl transition-all"
              >
                <ExternalLink size={16} />
              </button>
            </Tooltip>
          </div>
        )}
      </div>
      {children}
    </div>
  );

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading) {
    return shell(
      <div className="flex-1 flex items-center justify-center text-[#A0A0A0] gap-2">
        <Loader2 size={18} className="animate-spin" /> Loading map…
      </div>
    );
  }

  // ── Unsupported (vanilla) ───────────────────────────────────────────────────
  if (!status?.supported) {
    return shell(
      <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-3">
        <div className="p-4 bg-[#2D2D2D]/40 rounded-2xl">
          <Ban size={28} className="text-[#555555]" />
        </div>
        <h4 className="font-bold text-[#FFFFFF]">Not available on vanilla servers</h4>
        <p className="text-sm text-[#A0A0A0] max-w-md">
          The live map runs on BlueMap, which needs a mod loader or plugin platform.
          Create a Paper, Fabric, Forge, or NeoForge server to use it.
        </p>
      </div>
    );
  }

  // ── Not yet enabled — install CTA ───────────────────────────────────────────
  if (!status.enabled) {
    return shell(
      <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-4">
        <div className="p-4 bg-[#00AF5C]/10 rounded-2xl">
          <Globe size={30} className="text-[#00AF5C]" />
        </div>
        <h4 className="text-lg font-bold text-[#FFFFFF]">Enable the Live World Map</h4>
        <p className="text-sm text-[#A0A0A0] max-w-md">
          MineDash will install <span className="text-[#FFFFFF] font-medium">BlueMap</span> and
          render an explorable 3D map of your world with live player markers — viewable right here
          and shareable with friends.
        </p>
        <motion.button
          onClick={handleEnable}
          disabled={enabling}
          whileHover={enabling ? {} : { scale: 1.03 }}
          whileTap={enabling ? {} : { scale: 0.97 }}
          className="px-6 py-3 bg-[#00AF5C] hover:bg-[#00964F] disabled:opacity-60 text-white rounded-2xl font-bold transition-colors flex items-center gap-2"
        >
          {enabling
            ? <><Loader2 size={18} className="animate-spin" /> Installing BlueMap…</>
            : <><Globe size={18} /> Enable Live Map</>}
        </motion.button>
        <p className="text-xs text-[#555555] max-w-md flex items-start gap-1.5 mt-1">
          <AlertTriangle size={13} className="text-[#555555] mt-0.5 flex-shrink-0" />
          On first render BlueMap downloads Minecraft textures from Mojang to build the 3D models.
          This may use noticeable CPU and disk while the map generates.
        </p>
      </div>
    );
  }

  // ── Enabled but server offline ──────────────────────────────────────────────
  if (!isOnline) {
    return shell(
      <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-4">
        <div className="p-4 bg-[#2D2D2D]/40 rounded-2xl">
          <Play size={28} className="text-[#555555]" />
        </div>
        <h4 className="font-bold text-[#FFFFFF]">Start the server to view the map</h4>
        <p className="text-sm text-[#A0A0A0] max-w-md">
          The live map is enabled. Start the server and BlueMap will begin serving the map on
          port <span className="font-mono text-[#FFFFFF]">{port}</span>.
        </p>
        <motion.button
          onClick={handleStartOrRestart}
          disabled={busy}
          whileHover={busy ? {} : { scale: 1.03 }}
          whileTap={busy ? {} : { scale: 0.97 }}
          className="px-6 py-3 bg-[#00AF5C] hover:bg-[#00964F] disabled:opacity-60 text-white rounded-2xl font-bold transition-colors flex items-center gap-2"
        >
          {busy ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} />}
          Start server
        </motion.button>
      </div>
    );
  }

  // ── Online but BlueMap webserver not up yet ─────────────────────────────────
  if (!mapReady) {
    return shell(
      <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-3">
        <Loader2 size={26} className="text-[#00AF5C] animate-spin" />
        <h4 className="font-bold text-[#FFFFFF]">Waiting for the map…</h4>
        <p className="text-sm text-[#A0A0A0] max-w-md">
          BlueMap is starting its webserver on port <span className="font-mono text-[#FFFFFF]">{port}</span>.
          The map can look <span className="text-[#FFFFFF]">black for a minute</span> while it renders —
          it builds in the background and fills in as you explore the world. It'll refresh on its own.
        </p>
        <button
          onClick={handleStartOrRestart}
          disabled={busy}
          className="mt-1 px-4 py-2 text-sm bg-[#1E1E1E] border border-[#2D2D2D] hover:border-[#555555] disabled:opacity-60 text-[#A0A0A0] hover:text-[#FFFFFF] rounded-xl font-bold transition-all flex items-center gap-2"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />}
          Restart server
        </button>
      </div>
    );
  }

  // ── Live map ────────────────────────────────────────────────────────────────
  const vpn = addresses.find(a => a.isRadmin || a.isHamachi);
  const lan = addresses.find(a => !a.isRadmin && !a.isHamachi);
  const shares = [
    lan && { label: 'LAN', url: `http://${lan.ip}:${port}`, key: 'lan' },
    vpn && { label: vpn.isRadmin ? 'Radmin VPN' : 'Hamachi', url: `http://${vpn.ip}:${port}`, key: 'vpn' },
  ].filter(Boolean);

  return shell(
    <>
      {shares.length > 0 && (
        <div className="flex items-center gap-2 px-6 py-2.5 border-b border-[#2D2D2D] bg-[#1A1A1A] overflow-x-auto">
          <span className="text-[10px] uppercase tracking-wider font-bold text-[#555555] flex-shrink-0">
            Share map
          </span>
          {shares.map(s => (
            <button
              key={s.key}
              onClick={() => copyText(s.url, s.key)}
              className="flex items-center gap-2 px-3 py-1.5 bg-[#111111] border border-[#2D2D2D] hover:border-[#555555] rounded-xl transition-colors flex-shrink-0 group"
            >
              <span className="text-[10px] font-bold text-[#00AF5C] uppercase tracking-wide">{s.label}</span>
              <span className="font-mono text-xs text-[#A0A0A0] group-hover:text-[#FFFFFF]">{s.url}</span>
              {copied === s.key
                ? <Check size={13} className="text-[#00AF5C]" />
                : <Copy size={13} className="text-[#555555] group-hover:text-[#A0A0A0]" />}
            </button>
          ))}
        </div>
      )}
      <AnimatePresence>
        {!hintDismissed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-b border-[#00AF5C]/20 bg-[#00AF5C]/5"
          >
            <div className="flex items-start gap-2.5 px-6 py-2.5">
              <Info size={15} className="text-[#00AF5C] mt-0.5 flex-shrink-0" />
              <p className="text-xs text-[#A0A0A0] flex-1">
                New or freshly-enabled world? The map can be <span className="text-[#FFFFFF]">black for a minute</span> while
                BlueMap renders in the background — it fills in as you explore. Hit
                <RefreshCw size={11} className="inline mx-1 -mt-0.5 text-[#A0A0A0]" />
                reload above if it looks empty.
              </p>
              <button
                onClick={dismissHint}
                className="p-1 text-[#555555] hover:text-[#FFFFFF] hover:bg-[#2D2D2D] rounded-lg transition-all flex-shrink-0"
              >
                <X size={14} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex-1 bg-[#111111] min-h-0">
        <iframe
          key={reloadKey}
          title="Live World Map"
          src={`http://localhost:${port}`}
          className="w-full h-full border-0"
        />
      </div>
    </>
  );
}

export default MapViewer;
