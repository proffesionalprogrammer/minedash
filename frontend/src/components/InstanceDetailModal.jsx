import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Settings2, ScrollText, X, Check, Loader2, Cpu, Coffee, Globe, FolderOpen,
  FileDown, Trash2, Play, RefreshCw, Copy, FileText, AlertTriangle, ChevronRight,
} from 'lucide-react';
import ModalPortal from './ModalPortal';
import Tooltip from './Tooltip';
import LoaderGlyph from './LoaderGlyph';
import JavaRuntimeModal from './JavaRuntimeModal';
import InstanceWorldsModal from './InstanceWorldsModal';
import { useSystemRam } from '../hooks/useSystemRam';
import { TITLEBAR_OFFSET } from '../lib/titlebar';
import duskCover from '../assets/dusk.jpg';

const GLYPH_LOADERS = new Set(['fabric', 'forge', 'neoforge', 'quilt']);
const LOADER_LABEL = { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };
const RAM_MIN = 1;
const RAM_MAX_FALLBACK = 16;

function humanBytes(n) {
  if (!n && n !== 0) return '';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

function fmtTime(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString(undefined, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch { return ''; }
}

function javaSummary(java) {
  const v = (java || '').trim();
  if (!v || v === 'auto') return 'Automatic';
  const m = /^jdk-(\d+)$/.exec(v);
  if (m) return `Java ${m[1]} (managed)`;
  return 'Custom path';
}

// Centered, two-pane management panel for a single launcher instance. This is
// the one home for everything that used to crowd the card's kebab — rename,
// per-instance memory, Java, worlds, folder/export/delete — plus a Logs viewer
// (logs/ + crash-reports/). Opening it from a card declutters the grid: the
// card stays just art + Play + a single "Manage" affordance.
export default function InstanceDetailModal({ inst: instProp, onClose, onError, onSaved, onDeleted, onPlay, playDisabled }) {
  const [inst, setInst] = useState(instProp);
  const [section, setSection] = useState('settings'); // 'settings' | 'logs'
  const [javaOpen, setJavaOpen] = useState(false);
  const [worldsOpen, setWorldsOpen] = useState(false);

  // Keep local copy in sync if the parent pushes an update (e.g. modpack refresh).
  useEffect(() => { setInst(instProp); }, [instProp]);

  const loaderLabel = LOADER_LABEL[inst.loader] || inst.loader;
  const patch = async (body) => {
    const r = await fetch(`http://localhost:3001/api/launcher/instances/${inst.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed to save');
    setInst(prev => ({ ...prev, ...d }));
    onSaved?.(d);
    return d;
  };

  return (
    <ModalPortal>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-x-0 bottom-0 bg-[#000000]/80 backdrop-blur-sm flex items-center justify-center z-50 p-4"
        style={{ top: TITLEBAR_OFFSET }}
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.92, opacity: 0 }}
          transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
          onClick={e => e.stopPropagation()}
          className="bg-[var(--c-surface-1)] border border-[var(--c-border)] rounded-3xl w-full max-w-3xl h-[min(620px,82vh)] flex flex-col overflow-hidden shadow-2xl shadow-black/50"
        >
          {/* Header */}
          <div className="flex items-center gap-3 p-5 border-b border-[var(--c-border)]">
            <div className="w-12 h-12 rounded-xl overflow-hidden flex-shrink-0 bg-[var(--c-base)] relative">
              <img src={inst.iconUrl || duskCover} alt="" className="w-full h-full object-cover" />
              <span className="absolute bottom-0.5 right-0.5 flex items-center justify-center w-5 h-5 rounded-md bg-[var(--c-surface-1)]/90 border border-[var(--c-border)]">
                {GLYPH_LOADERS.has(inst.loader)
                  ? <LoaderGlyph loader={inst.loader} size={12} />
                  : <Settings2 size={11} className="text-[var(--c-text-secondary)]" />}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-lg font-bold text-[var(--c-text-primary)] truncate">{inst.displayName}</h3>
              <p className="text-xs text-[var(--c-text-secondary)] font-bold truncate">
                {loaderLabel} {inst.version}
              </p>
            </div>
            {onPlay && (
              <motion.button
                onClick={onPlay}
                disabled={playDisabled}
                whileHover={playDisabled ? {} : { scale: 1.04 }}
                whileTap={playDisabled ? {} : { scale: 0.97 }}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold bg-[#00AF5C] hover:bg-[#00964F] text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Play size={15} fill="currentColor" /> Play
              </motion.button>
            )}
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)] transition-colors"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>

          {/* Body: left rail + content */}
          <div className="flex-1 min-h-0 flex">
            <nav className="w-44 flex-shrink-0 border-r border-[var(--c-border)] p-3 flex flex-col gap-1">
              <RailItem icon={Settings2} label="Settings" active={section === 'settings'} onClick={() => setSection('settings')} />
              <RailItem icon={ScrollText} label="Logs" active={section === 'logs'} onClick={() => setSection('logs')} />
            </nav>
            <div className="flex-1 min-w-0 flex flex-col">
              {section === 'settings' ? (
                <SettingsPane
                  inst={inst}
                  patch={patch}
                  onError={onError}
                  onOpenJava={() => setJavaOpen(true)}
                  onOpenWorlds={() => setWorldsOpen(true)}
                  onDeleted={onDeleted}
                />
              ) : (
                <LogsPane inst={inst} onError={onError} />
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>

      <AnimatePresence>
        {javaOpen && (
          <JavaRuntimeModal
            key="detail-java"
            inst={inst}
            onClose={() => setJavaOpen(false)}
            onError={onError}
            onSaved={(updated) => { setInst(prev => ({ ...prev, ...updated })); onSaved?.(updated); }}
          />
        )}
        {worldsOpen && (
          <InstanceWorldsModal
            key="detail-worlds"
            inst={inst}
            onClose={() => setWorldsOpen(false)}
            onError={onError}
          />
        )}
      </AnimatePresence>
    </ModalPortal>
  );
}

function RailItem({ icon: Icon, label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-bold transition-colors ${
        active
          ? 'bg-[#00AF5C]/10 text-[#00AF5C]'
          : 'text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)]'
      }`}
    >
      <Icon size={16} />
      {label}
    </button>
  );
}

function SettingsPane({ inst, patch, onError, onOpenJava, onOpenWorlds, onDeleted }) {
  const ramMax = useSystemRam(RAM_MAX_FALLBACK);
  const [name, setName] = useState(inst.displayName || '');
  const [savingName, setSavingName] = useState(false);

  // Per-instance RAM. `custom` off = inherit the global default; on = pin `ram`.
  const [custom, setCustom] = useState(typeof inst.ram === 'number' && inst.ram >= 1);
  const [ram, setRam] = useState(typeof inst.ram === 'number' && inst.ram >= 1 ? inst.ram : 4);
  const [savingRam, setSavingRam] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => { setName(inst.displayName || ''); }, [inst.displayName]);

  const nameDirty = name.trim() && name.trim() !== (inst.displayName || '');
  const savedRam = typeof inst.ram === 'number' && inst.ram >= 1 ? inst.ram : null;
  const ramDirty = custom ? ram !== savedRam : savedRam !== null;
  const ramPercent = ramMax > RAM_MIN ? ((ram - RAM_MIN) / (ramMax - RAM_MIN)) * 100 : 0;

  const saveName = async () => {
    if (!nameDirty) return;
    setSavingName(true);
    try { await patch({ displayName: name.trim() }); }
    catch (err) { onError?.(err.message); }
    setSavingName(false);
  };

  const saveRam = async () => {
    setSavingRam(true);
    try { await patch({ ram: custom ? ram : null }); }
    catch (err) { onError?.(err.message); }
    setSavingRam(false);
  };

  const handleOpenFolder = async () => {
    try { await fetch(`http://localhost:3001/api/launcher/instances/${inst.id}/open-folder`, { method: 'POST' }); }
    catch (err) { onError?.(err.message); }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const url = `http://localhost:3001/api/launcher/instances/${encodeURIComponent(inst.id)}/export`;
      const r = await fetch(`${url}?check=1`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Export failed');
      const a = document.createElement('a');
      a.href = url; a.download = '';
      document.body.appendChild(a); a.click(); a.remove();
    } catch (err) { onError?.(err.message); }
    setExporting(false);
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const r = await fetch(`http://localhost:3001/api/launcher/instances/${inst.id}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Failed to delete');
      onDeleted?.(inst.id);
    } catch (err) {
      onError?.(err.message);
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-5 space-y-6">
      {/* Name */}
      <Field label="Display name">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={name}
            maxLength={60}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') saveName(); }}
            className="flex-1 min-w-0 bg-[var(--c-base)] border border-[var(--c-border)] focus:border-[#00AF5C] rounded-xl px-3 py-2.5 text-sm font-bold text-[var(--c-text-primary)] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all"
          />
          <motion.button
            onClick={saveName}
            disabled={!nameDirty || savingName}
            whileTap={{ scale: 0.97 }}
            className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-sm font-bold bg-[#00AF5C] hover:bg-[#00964F] text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {savingName ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            Save
          </motion.button>
        </div>
      </Field>

      {/* Memory */}
      <Field
        label="Memory"
        icon={Cpu}
        action={
          <ToggleChip
            on={custom}
            onLabel="Custom"
            offLabel="Global default"
            onToggle={() => setCustom(c => !c)}
          />
        }
      >
        {custom ? (
          <div className="space-y-3 pt-1">
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--c-text-secondary)] font-bold">Allocate to this instance</span>
              <span className="text-sm font-bold text-[#00AF5C] bg-[#00AF5C]/10 px-3 py-1 rounded-lg tabular-nums">{ram} GB</span>
            </div>
            <input
              type="range"
              min={RAM_MIN}
              max={ramMax}
              step={1}
              value={ram}
              onChange={e => setRam(Number(e.target.value))}
              style={{ '--fill': `${ramPercent}%` }}
              className="w-full ram-slider"
            />
            <div className="flex justify-between text-xs text-[var(--c-text-muted)] px-0.5">
              <span>{RAM_MIN} GB</span>
              <span>{ramMax} GB</span>
            </div>
          </div>
        ) : (
          <p className="text-xs text-[var(--c-text-secondary)] pt-1">
            Uses the global memory amount from <span className="font-bold text-[var(--c-text-primary)]">Settings</span>. Turn on <span className="font-bold text-[var(--c-text-primary)]">Custom</span> to give this instance its own heap.
          </p>
        )}
        {ramDirty && (
          <div className="flex justify-end pt-1">
            <motion.button
              onClick={saveRam}
              disabled={savingRam}
              whileTap={{ scale: 0.97 }}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold bg-[#00AF5C] hover:bg-[#00964F] text-white transition-colors disabled:opacity-50"
            >
              {savingRam ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              Save memory
            </motion.button>
          </div>
        )}
      </Field>

      {/* Java + Worlds — open their dedicated panels */}
      <Field label="Runtime & content">
        <div className="space-y-2">
          <LinkRow icon={Coffee} title="Java runtime" subtitle={javaSummary(inst.java)} onClick={onOpenJava} />
          <LinkRow icon={Globe} title="Worlds & screenshots" subtitle="Manage saves and screenshots" onClick={onOpenWorlds} />
        </div>
      </Field>

      {/* Files */}
      <Field label="Files">
        <div className="flex flex-wrap gap-2">
          <SecondaryButton icon={FolderOpen} label="Open folder" onClick={handleOpenFolder} />
          <SecondaryButton icon={FileDown} label="Export as .mrpack" onClick={handleExport} busy={exporting} />
        </div>
      </Field>

      {/* Danger zone */}
      <div className="border-t border-[var(--c-border)] pt-5">
        {confirmDelete ? (
          <div className="bg-[var(--c-danger)]/10 border border-[var(--c-danger)]/30 rounded-2xl p-4">
            <p className="text-sm font-bold text-[var(--c-text-primary)]">Delete this instance?</p>
            <p className="text-xs text-[var(--c-text-secondary)] mt-1">The on-disk profile (mods, worlds, configs) will be permanently removed.</p>
            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="px-3 py-2 rounded-xl text-xs font-bold text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] bg-[var(--c-surface-2)] transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <motion.button
                onClick={handleDelete}
                disabled={deleting}
                whileTap={{ scale: 0.97 }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold bg-[var(--c-danger)] hover:bg-[var(--c-danger-hover)] text-white transition-colors disabled:opacity-50"
              >
                {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                Delete instance
              </motion.button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-sm font-bold text-[var(--c-danger)] hover:bg-[var(--c-danger)]/10 border border-[var(--c-danger)]/30 transition-colors"
          >
            <Trash2 size={15} /> Delete instance
          </button>
        )}
      </div>
    </div>
  );
}

function LogsPane({ inst, onError }) {
  const [files, setFiles] = useState(null);     // null = loading
  const [active, setActive] = useState(null);   // { name, kind }
  const [content, setContent] = useState(null); // { content, truncated, sizeBytes }
  const [loadingFile, setLoadingFile] = useState(false);
  const [copied, setCopied] = useState(false);
  const preRef = useRef(null);
  const base = `http://localhost:3001/api/launcher/instances/${encodeURIComponent(inst.id)}`;

  const fetchList = async () => {
    setFiles(null);
    try {
      const r = await fetch(`${base}/logs`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load logs');
      const list = Array.isArray(d.files) ? d.files : [];
      setFiles(list);
      // Auto-open the first (latest.log, or newest) readable file.
      const first = list.find(f => !f.name.toLowerCase().endsWith('.gz')) || list[0] || null;
      if (first) openFile(first);
      else { setActive(null); setContent(null); }
    } catch (err) { onError?.(err.message); setFiles([]); }
  };

  const openFile = async (f) => {
    setActive({ name: f.name, kind: f.kind });
    setLoadingFile(true);
    setContent(null);
    try {
      const r = await fetch(`${base}/logs/file?kind=${f.kind}&name=${encodeURIComponent(f.name)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to read log');
      setContent(d);
    } catch (err) { onError?.(err.message); setContent({ content: '', error: true }); }
    setLoadingFile(false);
  };

  useEffect(() => {
    fetchList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst.id]);

  // Jump to the bottom (newest lines) whenever a fresh file finishes loading.
  useEffect(() => {
    if (content && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [content]);

  const handleCopy = async () => {
    if (!content?.content) return;
    try {
      await navigator.clipboard.writeText(content.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable — no-op */ }
  };

  return (
    <div className="flex-1 min-h-0 flex">
      {/* File list */}
      <div className="w-52 flex-shrink-0 border-r border-[var(--c-border)] flex flex-col">
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--c-border)]">
          <span className="text-[10px] uppercase tracking-wider font-bold text-[var(--c-text-muted)]">Log files</span>
          <Tooltip content="Refresh" side="bottom" align="end">
            <button onClick={fetchList} className="p-1 rounded-md text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)] transition-colors">
              <RefreshCw size={13} />
            </button>
          </Tooltip>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-2 space-y-1">
          {files === null ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={16} className="text-[#00AF5C] animate-spin" />
            </div>
          ) : files.length === 0 ? (
            <div className="text-center py-8 px-2">
              <ScrollText size={24} className="text-[var(--c-text-muted)] mx-auto mb-2" />
              <p className="text-xs font-bold text-[var(--c-text-secondary)]">No logs yet</p>
              <p className="text-[10px] text-[var(--c-text-muted)] mt-1">Launch the game once to generate logs.</p>
            </div>
          ) : (
            files.map(f => (
              <button
                key={`${f.kind}:${f.name}`}
                onClick={() => openFile(f)}
                className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors ${
                  active?.name === f.name && active?.kind === f.kind
                    ? 'bg-[#00AF5C]/10 border border-[#00AF5C]/30'
                    : 'border border-transparent hover:bg-[var(--c-surface-2)]'
                }`}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  {f.kind === 'crash'
                    ? <AlertTriangle size={12} className="text-amber-400 flex-shrink-0" />
                    : <FileText size={12} className="text-[var(--c-text-muted)] flex-shrink-0" />}
                  <span className={`text-xs font-bold truncate ${active?.name === f.name && active?.kind === f.kind ? 'text-[#00AF5C]' : 'text-[var(--c-text-primary)]'}`}>
                    {f.name}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 pl-[18px] text-[10px] text-[var(--c-text-muted)] tabular-nums">
                  <span>{humanBytes(f.sizeBytes)}</span>
                  <span>·</span>
                  <span className="truncate">{fmtTime(f.mtime)}</span>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 flex flex-col">
        {active ? (
          <>
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--c-border)]">
              <span className="text-xs font-bold text-[var(--c-text-secondary)] truncate flex items-center gap-1.5">
                {active.kind === 'crash' ? <AlertTriangle size={12} className="text-amber-400" /> : <FileText size={12} />}
                {active.name}
                {content?.truncated && (
                  <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md bg-[var(--c-surface-2)] text-[var(--c-text-muted)] border border-[var(--c-border)]">
                    last 512 KB
                  </span>
                )}
              </span>
              <button
                onClick={handleCopy}
                disabled={!content?.content}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] bg-[var(--c-surface-2)] transition-colors disabled:opacity-40"
              >
                {copied ? <Check size={12} className="text-[#00AF5C]" /> : <Copy size={12} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div ref={preRef} className="flex-1 min-h-0 overflow-auto custom-scrollbar bg-[var(--c-base)]">
              {loadingFile ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 size={18} className="text-[#00AF5C] animate-spin" />
                </div>
              ) : (
                <pre className="text-[11px] leading-relaxed text-[var(--c-text-secondary)] font-mono whitespace-pre-wrap break-words p-4 selection:bg-[#00AF5C]/30">
                  {content?.content || (content?.error ? '' : '(empty)')}
                </pre>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-[var(--c-text-muted)] p-6">
            <ScrollText size={28} className="mb-2" />
            <p className="text-sm font-bold text-[var(--c-text-secondary)]">Select a log to view</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, icon: Icon, action, children }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs uppercase tracking-wider font-bold text-[var(--c-text-muted)] flex items-center gap-1.5">
          {Icon && <Icon size={13} />}
          {label}
        </label>
        {action}
      </div>
      {children}
    </div>
  );
}

function LinkRow({ icon: Icon, title, subtitle, onClick }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-[var(--c-surface-2)] hover:bg-[var(--c-border)] border border-[var(--c-border)] transition-colors text-left group"
    >
      <span className="p-1.5 rounded-lg bg-[#00AF5C]/10 text-[#00AF5C]"><Icon size={15} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-[var(--c-text-primary)] truncate">{title}</span>
        <span className="block text-xs text-[var(--c-text-secondary)] truncate">{subtitle}</span>
      </span>
      <ChevronRight size={16} className="text-[var(--c-text-muted)] group-hover:text-[var(--c-text-secondary)] flex-shrink-0" />
    </button>
  );
}

function SecondaryButton({ icon: Icon, label, onClick, busy }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-sm font-bold text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] bg-[var(--c-surface-2)] hover:bg-[var(--c-border)] border border-[var(--c-border)] transition-colors disabled:opacity-50"
    >
      {busy ? <Loader2 size={15} className="animate-spin" /> : <Icon size={15} />}
      {label}
    </button>
  );
}

function ToggleChip({ on, onLabel, offLabel, onToggle }) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-1.5 text-xs font-bold transition-colors"
    >
      <span className={`relative w-9 h-5 rounded-full transition-colors ${on ? 'bg-[#00AF5C]' : 'bg-[var(--c-border)]'}`}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
      <span className={on ? 'text-[#00AF5C]' : 'text-[var(--c-text-secondary)]'}>{on ? onLabel : offLabel}</span>
    </button>
  );
}
