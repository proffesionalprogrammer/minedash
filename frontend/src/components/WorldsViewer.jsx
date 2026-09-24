import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Globe, Loader2, Trash2, Copy, FileDown, Check, Play, Pencil, X,
  Upload, RefreshCw, KeyRound, AlertTriangle, Flame, Sparkles, ImageOff,
} from 'lucide-react';
import ModalPortal from './ModalPortal';
import Tooltip from './Tooltip';

const GAME_MODE = { 0: 'Survival', 1: 'Creative', 2: 'Adventure', 3: 'Spectator' };
const IMPORT_PHASE = { upload: 'Uploading', extract: 'Extracting', install: 'Adding world', convert: 'Converting dimensions' };

function humanBytes(n) {
  if (!n && n !== 0) return '';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(0) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}
function fmtDate(ms) {
  if (!ms) return '';
  try { return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return ''; }
}

// The server-side Worlds tab. A dedicated server's saves are top-level folders
// in its instance directory and `level-name` in server.properties picks the one
// it loads — so "switch world" here is a pointer move, not a copy, and every
// world stays on disk until it's explicitly deleted.
//
// The reason this tab exists at all is custom maps: previously the only way to
// run a downloaded map on a MineDash server was to unzip it into the instance
// folder by hand and edit server.properties. Import does both, and converts the
// map's dimension layout to whatever the server actually reads (see
// backend/server-worlds.js — vanilla nests DIM-1/DIM1 inside the world folder,
// Paper wants them in <world>_nether / <world>_the_end siblings).
function WorldsViewer({ serverId, serverStatus, socket, onError }) {
  const [data, setData] = useState(null);       // { worlds, active, layout, running } | null while loading
  const [busy, setBusy] = useState(null);        // world name with an action in flight
  const [importing, setImporting] = useState(null); // null | { phase, pct|null, name } — see importZip
  const [pendingDelete, setPendingDelete] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [seedCopied, setSeedCopied] = useState(null);
  const [notice, setNotice] = useState(null);    // { kind, text } — import/convert results
  const fileRef = useRef(null);

  const base = `http://localhost:3001/api/servers/${serverId}`;
  const running = !!data?.running;

  // Only the newest request may land: a mutation's own refetch and the socket
  // event it triggers race, and an older answer arriving last would roll the
  // list back.
  const fetchSeq = useRef(0);
  const fetchWorlds = useCallback(async ({ refresh = false } = {}) => {
    const seq = ++fetchSeq.current;
    try {
      const r = await fetch(`${base}/worlds${refresh ? '?refresh=1' : ''}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load worlds');
      if (seq === fetchSeq.current) setData(d);
    } catch (err) {
      if (seq !== fetchSeq.current) return;
      onError?.(err.message);
      setData({ worlds: [], active: null, layout: 'vanilla', running: false });
    }
  }, [base, onError]);

  // Re-read on start/stop too: `running` gates every mutation button, and a
  // value fetched once at mount goes stale the moment the server changes state.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount; setState lands asynchronously in the promise
  useEffect(() => { fetchWorlds(); }, [fetchWorlds, serverStatus]);

  // The backend announces every world mutation (from this tab, another window,
  // or a background size measurement finishing) — re-read when it's ours.
  useEffect(() => {
    if (!socket) return;
    const onChanged = (e) => { if (e?.serverId === serverId) fetchWorlds(); };
    socket.on('server_worlds_changed', onChanged);
    return () => socket.off('server_worlds_changed', onChanged);
  }, [socket, serverId, fetchWorlds]);

  // One wrapper for every per-world mutation: they all take a world name, set
  // the busy flag, surface an error the same way, and re-read the list after.
  const act = async (name, fn) => {
    setBusy(name);
    try { await fn(); await fetchWorlds(); }
    catch (err) { onError?.(err.message); }
    setBusy(null);
  };

  const post = async (url, body) => {
    const r = await fetch(url, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Request failed');
    return d;
  };

  // The backend never deletes a dimension when both layouts hold a copy (that
  // copy is usually a hand-built Nether) — it reports the conflict instead.
  const conflictText = (conflicts) => conflicts?.length
    ? ` Heads up: this world has two copies of its ${conflicts.join(' and ')} — the server will use the one in its own layout. Check the Files tab if that's the wrong one.`
    : '';

  const handleActivate = (name) => act(name, async () => {
    const d = await post(`${base}/worlds/${encodeURIComponent(name)}/activate`);
    setNotice({
      kind: d.conflicts?.length ? 'warn' : 'ok',
      text: (d.converted?.length
        ? `Now loading "${name}" — its ${d.converted.join(' and ')} were moved into the layout this server reads.`
        : `The server will load "${name}" the next time it starts.`) + conflictText(d.conflicts),
    });
  });

  const handleDuplicate = (name) => act(name, () => post(`${base}/worlds/${encodeURIComponent(name)}/duplicate`));

  const handleDelete = (name) => act(name, async () => {
    const r = await fetch(`${base}/worlds/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Delete failed');
    setPendingDelete(null);
  });

  // Enter commits, then the input's blur fires too (when focus moves, or as it
  // unmounts); Escape cancels, then blur fires. This ref makes sure only the
  // first of those decides, so Escape can't commit and Enter can't send the
  // rename twice (the second one 404s against the old name).
  const renameSettled = useRef(false);
  const startRename = (name) => { renameSettled.current = false; setRenaming(name); setRenameValue(name); };
  const cancelRename = () => { renameSettled.current = true; setRenaming(null); };
  const commitRename = (name) => {
    if (renameSettled.current) return;
    renameSettled.current = true;
    const next = renameValue.trim();
    setRenaming(null);
    if (!next || next === name) return;
    return act(name, () => post(`${base}/worlds/${encodeURIComponent(name)}/rename`, { newName: next }));
  };

  const handleCopySeed = async (w) => {
    if (w.seed == null) { onError?.('No seed recorded for this world.'); return; }
    try {
      await navigator.clipboard.writeText(String(w.seed));
      setSeedCopied(w.name);
      setTimeout(() => setSeedCopied(s => (s === w.name ? null : s)), 1500);
    } catch { onError?.('Clipboard unavailable.'); }
  };

  // `activate` decides between the header's "Import map" (just add it) and the
  // drop-zone / primary action (add it and switch to it). Importing without
  // switching matters when you're staging a map for later.
  //
  // XHR rather than fetch because fetch has no upload progress, and a 1 GB map
  // is minutes of upload on its own. After the upload the backend reports its
  // own phases (extract → install → convert) on world_import_<serverId>.
  const importZip = async (file, activate) => {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) { onError?.('World imports must be .zip files.'); return; }
    const importId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setImporting({ phase: 'upload', pct: 0, name: file.name });
    setNotice(null);

    const onPhase = (e) => {
      if (!e || e.importId !== importId) return;
      if (e.phase === 'extract') {
        setImporting(p => p && { ...p, phase: 'extract', pct: e.total > 0 ? Math.round((e.done / e.total) * 100) : null });
      } else if (e.phase === 'install' || e.phase === 'convert') {
        setImporting(p => p && { ...p, phase: e.phase, pct: null });
      }
    };
    socket?.on(`world_import_${serverId}`, onPhase);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const qs = new URLSearchParams({ importId, ...(activate ? { activate: '1' } : {}) });
      const d = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${base}/worlds/import?${qs}`);
        xhr.upload.onprogress = (ev) => {
          if (!ev.lengthComputable) return;
          const pct = Math.round((ev.loaded / ev.total) * 100);
          setImporting(p => p && (p.phase === 'upload' ? { ...p, pct } : p));
        };
        // Once the body is sent the server takes over; say so instead of
        // sitting on "100%" while it extracts.
        xhr.upload.onload = () => setImporting(p => p && (p.phase === 'upload' ? { ...p, phase: 'extract', pct: null } : p));
        xhr.onload = () => {
          let body = {};
          try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON error page */ }
          if (xhr.status >= 200 && xhr.status < 300) resolve(body);
          else reject(new Error(body.error || `Import failed (${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error('Import failed — the connection to MineDash dropped.'));
        xhr.send(fd);
      });
      const bits = [`Imported "${d.name}"`];
      if (d.converted?.length) {
        bits.push(`converted its ${d.converted.join(' and ')} to the ${d.layout === 'bukkit' ? 'Paper' : 'vanilla'} layout`);
      }
      if (d.activated) bits.push('and set it as the world the server loads');
      setNotice({ kind: d.conflicts?.length ? 'warn' : 'ok', text: bits.join(', ') + '.' + conflictText(d.conflicts) });
      await fetchWorlds();
    } catch (err) { onError?.(err.message); }
    socket?.off(`world_import_${serverId}`, onPhase);
    setImporting(null);
  };

  // ── Drag-and-drop ───────────────────────────────────────────────────────────
  // Counter rather than a boolean: onDragLeave fires as the cursor crosses child
  // elements, so a bool makes the overlay flicker.
  const [dragDepth, setDragDepth] = useState(0);
  const canDrop = !running && !importing;
  const dragActive = dragDepth > 0 && canDrop;
  const handleDragEnter = (e) => {
    if (!canDrop || !e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault(); setDragDepth(d => d + 1);
  };
  const handleDragOver = (e) => {
    if (!canDrop || !e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  };
  const handleDragLeave = (e) => { e.preventDefault(); setDragDepth(d => Math.max(0, d - 1)); };
  const handleDrop = async (e) => {
    if (!canDrop) return;
    e.preventDefault(); setDragDepth(0);
    const file = e.dataTransfer?.files?.[0];
    // A dropped map is almost always one you want to play right away.
    if (file) await importZip(file, true);
  };

  const worlds = data?.worlds || [];

  return (
    <div
      className="flex-1 bg-[var(--c-base)] rounded-2xl border border-[var(--c-border)] flex flex-col overflow-hidden relative"
      onDragEnter={handleDragEnter} onDragOver={handleDragOver}
      onDragLeave={handleDragLeave} onDrop={handleDrop}
    >
      <AnimatePresence>
        {dragActive && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}
            className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-[#00AF5C]/10 backdrop-blur-sm border-2 border-dashed border-[#00AF5C] rounded-2xl pointer-events-none">
            <Upload size={36} className="text-[#00AF5C] mb-2" />
            <p className="text-sm font-bold text-white">Drop a world .zip</p>
            <p className="text-xs text-[var(--c-text-secondary)] mt-1">It'll be imported and set as this server's world</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete confirmation */}
      <AnimatePresence>
        {pendingDelete && (
          <ModalPortal>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 bg-[#000000]/80 z-[100] flex items-center justify-center backdrop-blur-sm">
              <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
                transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
                className="bg-[var(--c-surface-1)] border border-[var(--c-border)] p-6 rounded-3xl w-full max-w-md shadow-2xl mx-4">
                <div className="flex items-center gap-3 mb-4">
                  <div className="p-2 bg-[var(--c-danger)]/10 rounded-xl"><Trash2 size={18} className="text-[var(--c-danger)]" /></div>
                  <h3 className="text-xl font-bold text-[var(--c-text-primary)]">Delete world</h3>
                </div>
                <p className="text-[var(--c-text-secondary)] text-sm mb-6 leading-relaxed">
                  Permanently delete <span className="text-white font-bold">{pendingDelete}</span> and everything in it —
                  builds, chests, player data? This can't be undone. Export it first if you might want it back.
                </p>
                <div className="flex justify-end gap-3 pt-4 border-t border-[var(--c-border)]">
                  <button onClick={() => setPendingDelete(null)}
                    className="px-4 py-2 bg-[var(--c-base)] hover:bg-[var(--c-border)] border border-[var(--c-border)] text-[var(--c-text-primary)] rounded-xl text-sm font-bold transition-all duration-200">
                    Cancel
                  </button>
                  <button onClick={() => handleDelete(pendingDelete)}
                    className="px-4 py-2 bg-[var(--c-danger)] hover:bg-[var(--c-danger-hover)] text-white rounded-xl text-sm font-bold transition-all duration-200 flex items-center gap-2">
                    <Trash2 size={16} /> Delete world
                  </button>
                </div>
              </motion.div>
            </motion.div>
          </ModalPortal>
        )}
      </AnimatePresence>

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--c-border)] bg-[var(--c-surface-1)]">
        <div className="flex items-center gap-3 min-w-0">
          <Globe size={18} className="text-[var(--c-text-secondary)]" />
          <h3 className="font-bold text-[var(--c-text-primary)]">Worlds</h3>
          <span className="text-xs font-bold bg-[var(--c-surface-2)] text-[var(--c-text-secondary)] px-2.5 py-1 rounded-full border border-[var(--c-border)]">
            {data === null ? '…' : worlds.length}
          </span>
          {data?.layout === 'bukkit' && (
            <Tooltip content="Paper keeps the Nether and End in separate folders. Imported maps are converted to match." side="bottom">
              <span className="text-[10px] uppercase tracking-wider font-bold text-[var(--c-text-muted)] border border-[var(--c-border)] rounded-lg px-2 py-1">
                Paper layout
              </span>
            </Tooltip>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input type="file" ref={fileRef} accept=".zip" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; importZip(f, false); }} />
          <Tooltip content="Refresh (re-measures world sizes)" side="bottom" align="end">
            <button onClick={() => fetchWorlds({ refresh: true })}
              className="p-2 rounded-lg text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)] transition-colors">
              <RefreshCw size={14} />
            </button>
          </Tooltip>
          <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
            onClick={() => fileRef.current?.click()} disabled={importing || running}
            className="flex items-center gap-2 px-4 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl font-bold text-sm transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed">
            {importing ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            <span>{importing ? 'Importing…' : 'Import map'}</span>
          </motion.button>
        </div>
      </div>

      {/* Running warning — every mutation here is refused server-side while the
          JVM holds the world files open, so say why up front. */}
      {running && (
        <div className="mx-4 mt-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl flex items-center gap-3">
          <div className="p-2 bg-amber-500/15 rounded-xl flex-shrink-0">
            <AlertTriangle size={18} className="text-amber-400" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-white">The server is running</p>
            <p className="text-xs text-[var(--c-text-secondary)] mt-0.5">
              Stop it to import, switch, rename or delete a world — Minecraft holds these files open while it's up.
            </p>
          </div>
        </div>
      )}

      {/* Import progress. The upload is measured by the browser; extract is
          measured by the backend in uncompressed bytes; install/convert are
          quick moves with no meaningful percentage. */}
      <AnimatePresence>
        {importing && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="mx-4 mt-3 p-3 rounded-2xl border bg-[var(--c-surface-2)] border-[var(--c-border)]">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-[#00AF5C]/15 rounded-xl flex-shrink-0">
                <Loader2 size={18} className="text-[#00AF5C] animate-spin" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-[var(--c-text-primary)] truncate">
                  {IMPORT_PHASE[importing.phase] || 'Importing'} <span className="font-mono text-[var(--c-text-secondary)]">{importing.name}</span>
                </p>
                <div className="mt-2 h-1.5 rounded-full bg-[var(--c-border)] overflow-hidden">
                  {importing.pct != null ? (
                    // Keyed by phase so extract starts from empty instead of
                    // springing back down from the upload's 100%.
                    <motion.div key={importing.phase} className="h-full bg-[#00AF5C] rounded-full"
                      initial={{ width: 0 }} animate={{ width: `${importing.pct}%` }}
                      transition={{ type: 'spring', stiffness: 400, damping: 30 }} />
                  ) : (
                    <motion.div className="h-full w-1/3 bg-[#00AF5C] rounded-full"
                      animate={{ x: ['-100%', '300%'] }} transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }} />
                  )}
                </div>
              </div>
              {importing.pct != null && (
                <span className="text-sm font-bold text-[var(--c-text-primary)] tabular-nums flex-shrink-0">{importing.pct}%</span>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Import / activate result */}
      <AnimatePresence>
        {notice && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className={`mx-4 mt-3 p-3 rounded-2xl flex items-center gap-3 border ${
              notice.kind === 'warn' ? 'bg-amber-500/10 border-amber-500/30' : 'bg-[#00AF5C]/10 border-[#00AF5C]/30'
            }`}>
            {notice.kind === 'warn'
              ? <div className="p-2 bg-amber-500/15 rounded-xl flex-shrink-0"><AlertTriangle size={18} className="text-amber-400" /></div>
              : <div className="p-2 bg-[#00AF5C]/15 rounded-xl flex-shrink-0"><Check size={18} className="text-[#00AF5C]" /></div>}
            <p className="text-sm font-bold text-white flex-1 min-w-0">{notice.text}</p>
            <button onClick={() => setNotice(null)} className="p-1.5 rounded-lg text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] transition-colors">
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4">
        {data === null ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={18} className="text-[#00AF5C] animate-spin mr-2" />
            <span className="text-sm text-[var(--c-text-secondary)]">Loading worlds…</span>
          </div>
        ) : worlds.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-[var(--c-text-muted)]">
            <Globe size={32} className="mb-3 opacity-30" />
            <p className="text-sm font-bold text-[var(--c-text-secondary)]">No worlds yet</p>
            <p className="text-xs mt-1 max-w-sm text-center">
              Start the server once to generate one, or drop a downloaded map .zip anywhere on this panel.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {worlds.map((w, idx) => {
              const isBusy = busy === w.name;
              return (
                <motion.div key={w.name}
                  initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(idx * 0.03, 0.3), duration: 0.18 }}
                  className={`group flex items-center gap-4 p-4 rounded-2xl border transition-colors ${
                    w.active
                      ? 'bg-[#00AF5C]/5 border-[#00AF5C]/30'
                      : 'bg-[var(--c-surface-2)] border-[var(--c-border)] hover:border-[var(--c-text-muted)]'
                  }`}>
                  <div className="w-14 h-14 rounded-xl overflow-hidden bg-[var(--c-base)] border border-[var(--c-border)] flex-shrink-0 flex items-center justify-center">
                    {w.hasIcon
                      ? <img src={`${base}/worlds/${encodeURIComponent(w.name)}/icon`} alt="" className="w-full h-full object-cover" draggable={false} />
                      : <ImageOff size={18} className="text-[var(--c-text-muted)]" />}
                  </div>

                  <div className="flex-1 min-w-0">
                    {renaming === w.name ? (
                      <input autoFocus value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(w.name);
                          else if (e.key === 'Escape') cancelRename();
                        }}
                        onBlur={() => commitRename(w.name)}
                        className="w-full max-w-xs bg-[var(--c-base)] border border-[#00AF5C] rounded-lg px-2.5 py-1.5 text-sm font-bold text-[var(--c-text-primary)] outline-none" />
                    ) : (
                      <div className="flex items-center gap-2 min-w-0">
                        <p className="font-bold text-[var(--c-text-primary)] truncate">{w.name}</p>
                        {w.active && (
                          <span className="flex-shrink-0 text-[10px] uppercase tracking-wider font-bold text-[#00AF5C] bg-[#00AF5C]/10 border border-[#00AF5C]/20 rounded-lg px-2 py-0.5">
                            Active
                          </span>
                        )}
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      {w.gameMode != null && GAME_MODE[w.gameMode] && (
                        <span className="text-[10px] font-bold text-[var(--c-text-secondary)] bg-[var(--c-base)] border border-[var(--c-border)] rounded-lg px-2 py-0.5">
                          {GAME_MODE[w.gameMode]}
                        </span>
                      )}
                      {w.hasNether && (
                        <Tooltip content="This world has a Nether" side="bottom">
                          <span className="flex items-center gap-1 text-[10px] font-bold text-[var(--c-text-secondary)] bg-[var(--c-base)] border border-[var(--c-border)] rounded-lg px-2 py-0.5">
                            <Flame size={10} /> Nether
                          </span>
                        </Tooltip>
                      )}
                      {w.hasEnd && (
                        <Tooltip content="This world has an End" side="bottom">
                          <span className="flex items-center gap-1 text-[10px] font-bold text-[var(--c-text-secondary)] bg-[var(--c-base)] border border-[var(--c-border)] rounded-lg px-2 py-0.5">
                            <Sparkles size={10} /> End
                          </span>
                        </Tooltip>
                      )}
                      {w.sizePending ? (
                        <Tooltip content="Measuring this world's size in the background" side="bottom">
                          <span className="flex items-center gap-1 text-[11px] text-[var(--c-text-muted)]">
                            <Loader2 size={10} className="animate-spin" /> Measuring…
                          </span>
                        </Tooltip>
                      ) : (
                        <span className="text-[11px] text-[var(--c-text-muted)] tabular-nums">{humanBytes(w.sizeBytes)}</span>
                      )}
                      {w.lastPlayed > 0 && (
                        <span className="text-[11px] text-[var(--c-text-muted)]">· {fmtDate(w.lastPlayed)}</span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    {isBusy && <Loader2 size={16} className="text-[#00AF5C] animate-spin mr-1" />}
                    {!w.active && (
                      <Tooltip content={running ? 'Stop the server first' : 'Make this the world the server loads'} side="bottom" align="end">
                        <motion.button whileTap={{ scale: 0.97 }}
                          onClick={() => handleActivate(w.name)} disabled={isBusy || running}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#00AF5C]/10 hover:bg-[#00AF5C]/20 text-[#00AF5C] border border-[#00AF5C]/20 rounded-xl text-xs font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                          <Play size={13} /> Use this world
                        </motion.button>
                      </Tooltip>
                    )}
                    <Tooltip content={w.seed != null ? (seedCopied === w.name ? 'Copied!' : 'Copy seed') : 'No seed recorded'} side="bottom" align="end">
                      <button onClick={() => handleCopySeed(w)} disabled={w.seed == null}
                        className="p-2 rounded-lg text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-base)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                        {seedCopied === w.name ? <Check size={14} className="text-[#00AF5C]" /> : <KeyRound size={14} />}
                      </button>
                    </Tooltip>
                    <Tooltip content="Download as .zip" side="bottom" align="end">
                      <a href={`${base}/worlds/${encodeURIComponent(w.name)}/export`} download
                        className="p-2 rounded-lg text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-base)] transition-colors block">
                        <FileDown size={14} />
                      </a>
                    </Tooltip>
                    <Tooltip content={running ? 'Stop the server first' : 'Rename'} side="bottom" align="end">
                      <button onClick={() => startRename(w.name)} disabled={isBusy || running}
                        className="p-2 rounded-lg text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-base)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                        <Pencil size={14} />
                      </button>
                    </Tooltip>
                    <Tooltip content={running ? 'Stop the server first' : 'Duplicate'} side="bottom" align="end">
                      <button onClick={() => handleDuplicate(w.name)} disabled={isBusy || running}
                        className="p-2 rounded-lg text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-base)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                        <Copy size={14} />
                      </button>
                    </Tooltip>
                    <Tooltip content={w.active ? 'Switch to another world first' : running ? 'Stop the server first' : 'Delete'} side="bottom" align="end">
                      <button onClick={() => setPendingDelete(w.name)} disabled={isBusy || running || w.active}
                        className="p-2 rounded-lg text-[var(--c-text-muted)] hover:text-[var(--c-danger)] hover:bg-[var(--c-base)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                        <Trash2 size={14} />
                      </button>
                    </Tooltip>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default WorldsViewer;
