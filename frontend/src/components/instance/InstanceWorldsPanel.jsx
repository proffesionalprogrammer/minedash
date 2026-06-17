import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Globe, Loader2, Trash2, Copy, FileDown, Check, X, Play, Pencil,
  ImageOff, KeyRound, Database, Plus, RefreshCw,
} from 'lucide-react';
import Tooltip from '../Tooltip';

const GAME_MODE = { 0: 'Survival', 1: 'Creative', 2: 'Adventure', 3: 'Spectator' };

function humanBytes(n) {
  if (!n && n !== 0) return '';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}
function fmtDate(ms) {
  if (!ms) return '';
  try { return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return ''; }
}
function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url; a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
}

// Full Worlds panel for a launcher instance (Prism-style): list each
// singleplayer save with game mode / last-played / size, and per-row actions —
// Join (quick-play), Rename, Copy, Export, Copy Seed, Data Packs, Reset Icon,
// Delete — plus Import (.zip) in the header.
export default function InstanceWorldsPanel({ inst, onError, onJoinWorld }) {
  const [worlds, setWorlds] = useState(null);   // null = loading
  const [busy, setBusy] = useState(null);        // world name with an action in flight
  const [pendingDelete, setPendingDelete] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [seedCopied, setSeedCopied] = useState(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);

  const base = `http://localhost:3001/api/launcher/instances/${encodeURIComponent(inst.id)}`;

  const fetchWorlds = async () => {
    try {
      const r = await fetch(`${base}/worlds`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load worlds');
      setWorlds(Array.isArray(d) ? d : []);
    } catch (err) { onError?.(err.message); setWorlds([]); }
  };
  useEffect(() => { fetchWorlds(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [inst.id]);

  const handleDuplicate = async (name) => {
    setBusy(name);
    try {
      const r = await fetch(`${base}/worlds/${encodeURIComponent(name)}/duplicate`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Duplicate failed');
      await fetchWorlds();
    } catch (err) { onError?.(err.message); }
    setBusy(null);
  };
  const handleDelete = async (name) => {
    setBusy(name);
    try {
      const r = await fetch(`${base}/worlds/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Delete failed');
      setPendingDelete(null);
      await fetchWorlds();
    } catch (err) { onError?.(err.message); }
    setBusy(null);
  };
  const startRename = (name) => { setRenaming(name); setRenameValue(name); };
  const commitRename = async (name) => {
    const next = renameValue.trim();
    if (!next || next === name) { setRenaming(null); return; }
    setBusy(name);
    try {
      const r = await fetch(`${base}/worlds/${encodeURIComponent(name)}/rename`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName: next }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Rename failed');
      setRenaming(null);
      await fetchWorlds();
    } catch (err) { onError?.(err.message); }
    setBusy(null);
  };
  const handleResetIcon = async (name) => {
    setBusy(name);
    try {
      const r = await fetch(`${base}/worlds/${encodeURIComponent(name)}/icon`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Reset icon failed');
      await fetchWorlds();
    } catch (err) { onError?.(err.message); }
    setBusy(null);
  };
  const handleCopySeed = async (w) => {
    if (w.seed == null) { onError?.('No seed found for this world.'); return; }
    try {
      await navigator.clipboard.writeText(String(w.seed));
      setSeedCopied(w.name);
      setTimeout(() => setSeedCopied(s => (s === w.name ? null : s)), 1500);
    } catch { onError?.('Clipboard unavailable.'); }
  };
  const handleOpenDatapacks = async (name) => {
    try { await fetch(`${base}/worlds/${encodeURIComponent(name)}/open-datapacks`, { method: 'POST' }); }
    catch (err) { onError?.(err.message); }
  };
  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`${base}/worlds/import`, { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Import failed');
      await fetchWorlds();
    } catch (err) { onError?.(err.message); }
    setImporting(false);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <input type="file" ref={fileRef} accept=".zip" className="hidden" onChange={handleImport} />
      <div className="flex items-center justify-between px-5 pt-5 pb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="p-2 bg-[#00AF5C]/10 rounded-xl"><Globe size={16} className="text-[#00AF5C]" /></div>
          <div className="min-w-0">
            <h3 className="text-base font-bold text-[var(--c-text-primary)]">Worlds</h3>
            <p className="text-[11px] text-[var(--c-text-secondary)]">{worlds === null ? 'Loading…' : `${worlds.length} singleplayer world${worlds.length === 1 ? '' : 's'}`}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Tooltip content="Refresh" side="bottom" align="end">
            <button onClick={fetchWorlds} className="p-2 rounded-lg text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)] transition-colors">
              <RefreshCw size={14} />
            </button>
          </Tooltip>
          <motion.button onClick={() => fileRef.current?.click()} disabled={importing} whileTap={{ scale: 0.97 }}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold bg-[var(--c-surface-2)] hover:bg-[var(--c-border)] border border-[var(--c-border)] text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] transition-colors disabled:opacity-50">
            {importing ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Import .zip
          </motion.button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 pb-5">
        {worlds === null ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={18} className="text-[#00AF5C] animate-spin mr-2" />
            <span className="text-sm text-[var(--c-text-secondary)]">Loading worlds…</span>
          </div>
        ) : worlds.length === 0 ? (
          <div className="flex flex-col items-center py-14 text-[var(--c-text-muted)]">
            <Globe size={32} className="mb-3 opacity-30" />
            <p className="text-sm font-bold text-[var(--c-text-secondary)]">No worlds yet</p>
            <p className="text-xs mt-1 max-w-xs text-center">Create one in-game, or import a world .zip with the button above.</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {worlds.map((w, idx) => (
              <motion.div key={w.name}
                initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(idx * 0.03, 0.3), duration: 0.18 }}
                className="group flex items-center gap-3 px-3 py-2.5 bg-[var(--c-surface-2)] border border-[var(--c-border)] hover:border-[var(--c-text-muted)] rounded-xl transition-colors">
                <div className="w-11 h-11 rounded-lg overflow-hidden bg-[var(--c-base)] border border-[var(--c-border)] flex-shrink-0 flex items-center justify-center">
                  {w.hasIcon
                    ? <img src={`${base}/worlds/${encodeURIComponent(w.name)}/icon?t=${w.lastPlayed || 0}`} alt="" className="w-full h-full object-cover" draggable={false} />
                    : <Globe size={16} className="text-[#00AF5C]" />}
                </div>

                <div className="flex-1 min-w-0">
                  {renaming === w.name ? (
                    <div className="flex items-center gap-1.5">
                      <input autoFocus value={renameValue} maxLength={120}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') commitRename(w.name); else if (e.key === 'Escape') setRenaming(null); }}
                        className="flex-1 min-w-0 bg-[var(--c-base)] border border-[#00AF5C] rounded-lg px-2 py-1 text-sm font-bold text-[var(--c-text-primary)] outline-none" />
                      <button onClick={() => commitRename(w.name)} disabled={busy === w.name}
                        className="p-1.5 rounded-lg bg-[#00AF5C] hover:bg-[#00964F] text-white disabled:opacity-50">
                        {busy === w.name ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                      </button>
                      <button onClick={() => setRenaming(null)} className="p-1.5 rounded-lg bg-[var(--c-surface-1)] border border-[var(--c-border)] text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)]">
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 min-w-0">
                        <p className="text-sm font-bold text-[var(--c-text-primary)] truncate">{w.name}</p>
                        {typeof w.gameMode === 'number' && GAME_MODE[w.gameMode] && (
                          <span className="text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md bg-[var(--c-border)] text-[var(--c-text-secondary)] flex-shrink-0">
                            {GAME_MODE[w.gameMode]}
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] text-[var(--c-text-muted)] tabular-nums truncate">
                        {humanBytes(w.sizeBytes)}{w.lastPlayed ? ` · last played ${fmtDate(w.lastPlayed)}` : ''}{w.seed != null ? ` · seed ${w.seed}` : ''}
                      </p>
                    </>
                  )}
                </div>

                {pendingDelete === w.name ? (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className="text-[10px] font-bold text-[var(--c-danger)]">Delete forever?</span>
                    <button onClick={() => handleDelete(w.name)} disabled={busy === w.name}
                      className="p-1.5 rounded-lg bg-[var(--c-danger)] hover:bg-[var(--c-danger-hover)] text-white disabled:opacity-50">
                      {busy === w.name ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                    </button>
                    <button onClick={() => setPendingDelete(null)} className="p-1.5 rounded-lg bg-[var(--c-surface-1)] border border-[var(--c-border)] text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)]">
                      <X size={12} />
                    </button>
                  </div>
                ) : renaming === w.name ? null : (
                  <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    {onJoinWorld && (
                      <IconBtn title="Play this world" onClick={() => onJoinWorld(w.name)}><Play size={14} /></IconBtn>
                    )}
                    <IconBtn title={seedCopied === w.name ? 'Seed copied' : 'Copy seed'} onClick={() => handleCopySeed(w)} disabled={w.seed == null}>
                      {seedCopied === w.name ? <Check size={14} className="text-[#00AF5C]" /> : <KeyRound size={14} />}
                    </IconBtn>
                    <IconBtn title="Data packs folder" onClick={() => handleOpenDatapacks(w.name)}><Database size={14} /></IconBtn>
                    <IconBtn title="Rename" onClick={() => startRename(w.name)}><Pencil size={14} /></IconBtn>
                    <IconBtn title="Download as zip" onClick={() => triggerDownload(`${base}/worlds/${encodeURIComponent(w.name)}/export`)}><FileDown size={14} /></IconBtn>
                    <IconBtn title="Duplicate" onClick={() => handleDuplicate(w.name)} disabled={busy === w.name}>
                      {busy === w.name ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
                    </IconBtn>
                    <IconBtn title="Reset icon" onClick={() => handleResetIcon(w.name)} disabled={!w.hasIcon || busy === w.name}><ImageOff size={14} /></IconBtn>
                    <IconBtn title="Delete" danger onClick={() => setPendingDelete(w.name)}><Trash2 size={14} /></IconBtn>
                  </div>
                )}
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function IconBtn({ title, onClick, disabled, danger, children }) {
  return (
    <Tooltip content={title}>
      <button onClick={onClick} disabled={disabled}
        className={`p-1.5 rounded-lg transition-all disabled:opacity-40 ${
          danger
            ? 'text-[var(--c-text-secondary)] hover:text-[var(--c-danger)] hover:bg-[var(--c-danger)]/10'
            : 'text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-border)]'
        }`}>
        {children}
      </button>
    </Tooltip>
  );
}
