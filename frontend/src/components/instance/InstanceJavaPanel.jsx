import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Coffee, Check, Loader2, Download, FolderCog, Sparkles } from 'lucide-react';
import ChoiceRow from '../JavaChoiceRow';

// Per-instance Java runtime picker, rendered inline as a detail-panel (the
// non-modal sibling of JavaRuntimeModal). Backed by GET /api/launcher/java and
// PATCH /api/launcher/instances/:id { java }. Choice values mirror the backend:
//   'auto' | 'jdk-<major>' | <absolute path>
export default function InstanceJavaPanel({ inst, patch, onError }) {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const initial = inst.java && inst.java.trim() ? inst.java.trim() : 'auto';
  const isCustomInitial = initial !== 'auto' && !/^jdk-\d+$/.test(initial);
  const [choice, setChoice] = useState(isCustomInitial ? 'custom' : initial);
  const [customPath, setCustomPath] = useState(isCustomInitial ? initial : '');

  // Re-seed when the instance prop changes (e.g. another panel saved).
  useEffect(() => {
    const init = inst.java && inst.java.trim() ? inst.java.trim() : 'auto';
    const custom = init !== 'auto' && !/^jdk-\d+$/.test(init);
    setChoice(custom ? 'custom' : init);
    setCustomPath(custom ? init : '');
  }, [inst.java]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`http://localhost:3001/api/launcher/java?version=${encodeURIComponent(inst.version)}`);
        const d = await r.json();
        if (alive && r.ok) setInfo(d);
      } catch { /* options degrade gracefully */ }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [inst.version]);

  const managedMajors = useMemo(() => new Set((info?.managed || []).map(m => m.major)), [info]);
  const pinOptions = useMemo(() => {
    const majors = new Set([...(info?.knownMajors || []), ...managedMajors]);
    return Array.from(majors).sort((a, b) => a - b);
  }, [info, managedMajors]);

  const currentValue = choice === 'custom' ? customPath.trim() : choice;
  const dirty = currentValue !== initial && !(choice === 'custom' && !customPath.trim());

  const handleSave = async () => {
    const value = choice === 'custom' ? customPath.trim() : choice;
    if (choice === 'custom' && !value) { onError?.('Enter the full path to java.exe, or pick another option.'); return; }
    setSaving(true);
    try { await patch({ java: value }); } catch (err) { onError?.(err.message); }
    setSaving(false);
  };

  const requiredBadge = (
    <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md bg-[#00AF5C]/15 text-[#00AF5C] border border-[#00AF5C]/30 flex-shrink-0">
      Matches {inst.version}
    </span>
  );
  const downloadBadge = (
    <span className="flex items-center gap-1 text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md bg-[var(--c-surface-1)] text-[var(--c-text-secondary)] border border-[var(--c-border)] flex-shrink-0">
      <Download size={9} /> Downloads on launch
    </span>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-3 px-5 pt-5 pb-3">
        <div className="p-2 bg-[#00AF5C]/10 rounded-xl"><Coffee size={18} className="text-[#00AF5C]" /></div>
        <div className="min-w-0">
          <h3 className="text-base font-bold text-[var(--c-text-primary)]">Java runtime</h3>
          <p className="text-xs text-[var(--c-text-secondary)] truncate">Minecraft {inst.version}</p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 size={18} className="text-[#00AF5C] animate-spin mr-2" />
          <span className="text-sm text-[var(--c-text-secondary)]">Checking installed runtimes…</span>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 space-y-1.5">
          <ChoiceRow
            active={choice === 'auto'} onSelect={() => setChoice('auto')} icon={Sparkles}
            title="Automatic (recommended)"
            subtitle={info?.required
              ? `Uses Java ${info.required} for Minecraft ${inst.version} — downloaded automatically if missing`
              : 'Picks the right Java for this Minecraft version automatically'} />
          {pinOptions.map(major => (
            <ChoiceRow
              key={major} active={choice === `jdk-${major}`} onSelect={() => setChoice(`jdk-${major}`)} icon={Coffee}
              title={`Java ${major}`}
              subtitle={managedMajors.has(major) ? (info?.managed || []).find(m => m.major === major)?.path : null}
              badge={<>{info?.required === major && requiredBadge}{!managedMajors.has(major) && downloadBadge}</>} />
          ))}
          {info?.system?.path && (
            <ChoiceRow active={choice === info.system.path} onSelect={() => setChoice(info.system.path)} icon={FolderCog}
              title={`System Java${info.system.major ? ` ${info.system.major}` : ''}`} subtitle={info.system.path} />
          )}
          <ChoiceRow active={choice === 'custom'} onSelect={() => setChoice('custom')} icon={FolderCog}
            title="Custom path" subtitle="Point at any java.exe yourself" />
          {choice === 'custom' && (
            <input type="text" autoFocus value={customPath} onChange={e => setCustomPath(e.target.value)}
              placeholder="C:\\Program Files\\Java\\jdk-21\\bin\\java.exe"
              className="w-full bg-[var(--c-base)] border border-[var(--c-border)] focus:border-[#00AF5C] rounded-xl px-3 py-2.5 text-sm text-[var(--c-text-primary)] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[var(--c-text-muted)] font-mono" />
          )}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-[var(--c-border)] p-4">
        <motion.button onClick={handleSave} disabled={saving || loading || !dirty} whileTap={{ scale: 0.97 }}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold bg-[#00AF5C] hover:bg-[#00964F] text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save
        </motion.button>
      </div>
    </div>
  );
}
