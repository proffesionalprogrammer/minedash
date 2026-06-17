import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Settings2, ScrollText, X, Check, Loader2, Coffee, Globe, Play, RefreshCw,
  Copy, FileText, AlertTriangle, Package, Image as ImageIcon, Sparkles, Camera,
} from 'lucide-react';
import ModalPortal from './ModalPortal';
import Tooltip from './Tooltip';
import LoaderGlyph from './LoaderGlyph';
import LauncherContent from './LauncherContent';
import InstanceSettingsPanel from './instance/InstanceSettingsPanel';
import InstanceJavaPanel from './instance/InstanceJavaPanel';
import InstanceWorldsPanel from './instance/InstanceWorldsPanel';
import InstanceScreenshotsPanel from './instance/InstanceScreenshotsPanel';
import { TITLEBAR_OFFSET } from '../lib/titlebar';
import duskCover from '../assets/dusk.jpg';

const GLYPH_LOADERS = new Set(['fabric', 'forge', 'neoforge', 'quilt']);
const LOADER_LABEL = { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };

function humanBytes(n) {
  if (!n && n !== 0) return '';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}
function fmtTime(ms) {
  if (!ms) return '';
  try { return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

// Centered, two-pane management panel for a single launcher instance — a
// Prism-style left rail (Settings · Java · Mods · Resource Packs · Shaders ·
// Worlds · Screenshots · Logs) with a dedicated panel for each. Mods/Shaders
// are hidden for vanilla instances.
export default function InstanceDetailModal({
  inst: instProp, settings, onClose, onError, onSaved, onDeleted, onPlay, onJoinWorld,
  playDisabled, modpackInstalls, onOpenDetail,
}) {
  const [inst, setInst] = useState(instProp);
  const [section, setSection] = useState('settings');

  useEffect(() => { setInst(instProp); }, [instProp]);

  const isVanilla = inst.loader === 'vanilla';
  const loaderLabel = LOADER_LABEL[inst.loader] || inst.loader;

  const rail = [
    { key: 'settings', label: 'Settings', icon: Settings2 },
    { key: 'java', label: 'Java', icon: Coffee },
    ...(isVanilla ? [] : [{ key: 'mods', label: 'Mods', icon: Package }]),
    { key: 'resourcepack', label: 'Resource Packs', icon: ImageIcon },
    ...(isVanilla ? [] : [{ key: 'shader', label: 'Shaders', icon: Sparkles }]),
    { key: 'worlds', label: 'Worlds', icon: Globe },
    { key: 'screenshots', label: 'Screenshots', icon: Camera },
    { key: 'logs', label: 'Logs', icon: ScrollText },
  ];

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

  // Shared wrapper for the embedded LauncherContent panels (Mods / RP / Shaders).
  const contentPanel = (lockedType) => (
    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-5">
      <LauncherContent
        inModal
        lockedType={lockedType}
        loader={inst.loader}
        version={inst.version}
        instanceId={inst.id}
        onError={onError}
        modpackInstalls={modpackInstalls}
        onOpenDetail={onOpenDetail}
      />
    </div>
  );

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
          className="bg-[var(--c-surface-1)] border border-[var(--c-border)] rounded-3xl w-full max-w-4xl h-[min(680px,88vh)] flex flex-col overflow-hidden shadow-2xl shadow-black/50"
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
              <p className="text-xs text-[var(--c-text-secondary)] font-bold truncate">{loaderLabel} {inst.version}</p>
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
            <nav className="w-44 flex-shrink-0 border-r border-[var(--c-border)] p-3 flex flex-col gap-1 overflow-y-auto custom-scrollbar">
              {rail.map(item => (
                <RailItem key={item.key} icon={item.icon} label={item.label}
                  active={section === item.key} onClick={() => setSection(item.key)} />
              ))}
            </nav>
            <div className="flex-1 min-w-0 flex flex-col">
              {section === 'settings' && (
                <InstanceSettingsPanel inst={inst} settings={settings} patch={patch} onError={onError} onDeleted={onDeleted} />
              )}
              {section === 'java' && (
                <InstanceJavaPanel inst={inst} patch={patch} onError={onError} />
              )}
              {section === 'mods' && contentPanel('mod')}
              {section === 'resourcepack' && contentPanel('resourcepack')}
              {section === 'shader' && contentPanel('shader')}
              {section === 'worlds' && (
                <InstanceWorldsPanel inst={inst} onError={onError} onJoinWorld={onJoinWorld} />
              )}
              {section === 'screenshots' && (
                <InstanceScreenshotsPanel inst={inst} onError={onError} />
              )}
              {section === 'logs' && (
                <LogsPane inst={inst} onError={onError} />
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </ModalPortal>
  );
}

function RailItem({ icon: Icon, label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-bold transition-colors text-left ${
        active
          ? 'bg-[#00AF5C]/10 text-[#00AF5C]'
          : 'text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)]'
      }`}
    >
      <Icon size={16} className="flex-shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function LogsPane({ inst, onError }) {
  const [files, setFiles] = useState(null);
  const [active, setActive] = useState(null);
  const [content, setContent] = useState(null);
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
