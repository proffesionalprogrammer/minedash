import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Coffee, Check, Loader2, Download, FolderCog, Sparkles } from 'lucide-react';
import ModalPortal from './ModalPortal';
import ChoiceRow from './JavaChoiceRow';
import { TITLEBAR_OFFSET } from '../lib/titlebar';

// Per-instance Java runtime picker. Backed by GET /api/launcher/java (managed
// pool + system Java + the required major for this instance's MC version) and
// PATCH /api/launcher/instances/:id { java }.
//
// Choice values mirror the backend contract:
//   'auto'        — resolve from the MC version, download from Adoptium if missing
//   'jdk-<major>' — pin to a pooled JDK (downloaded on first launch if absent)
//   <abs path>    — custom java(.exe)
export default function JavaRuntimeModal({ inst, onClose, onSaved, onError }) {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // '' (never chosen) renders as auto — that's what the backend does at launch
  // for instances without an explicit pick (modulo the legacy global path).
  const initial = inst.java && inst.java.trim() ? inst.java.trim() : 'auto';
  const isCustomInitial = initial !== 'auto' && !/^jdk-\d+$/.test(initial);
  const [choice, setChoice] = useState(isCustomInitial ? 'custom' : initial);
  const [customPath, setCustomPath] = useState(isCustomInitial ? initial : '');

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`http://localhost:3001/api/launcher/java?version=${encodeURIComponent(inst.version)}`);
        const d = await r.json();
        if (r.ok) setInfo(d);
      } catch { /* options below degrade gracefully */ }
      setLoading(false);
    })();
  }, [inst.version]);

  const managedMajors = useMemo(() => new Set((info?.managed || []).map(m => m.major)), [info]);
  const pinOptions = useMemo(() => {
    const majors = new Set([...(info?.knownMajors || []), ...managedMajors]);
    return Array.from(majors).sort((a, b) => a - b);
  }, [info, managedMajors]);

  const handleSave = async () => {
    const value = choice === 'custom' ? customPath.trim() : choice;
    if (choice === 'custom' && !value) {
      onError?.('Enter the full path to java.exe, or pick another option.');
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`http://localhost:3001/api/launcher/instances/${inst.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ java: value }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to save Java choice');
      onSaved?.(d);
      onClose?.();
    } catch (err) {
      onError?.(err.message);
    }
    setSaving(false);
  };

  const requiredBadge = (
    <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md bg-[#00AF5C]/15 text-[#00AF5C] border border-[#00AF5C]/30 flex-shrink-0">
      Matches {inst.version}
    </span>
  );
  const downloadBadge = (
    <span className="flex items-center gap-1 text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md bg-[#1A1A1A] text-[#A0A0A0] border border-[#2D2D2D] flex-shrink-0">
      <Download size={9} /> Downloads on launch
    </span>
  );

  return (
    <ModalPortal>
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-x-0 bottom-0 bg-[#000000]/80 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      style={{ top: TITLEBAR_OFFSET }}
      onClick={() => !saving && onClose?.()}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
        transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
        onClick={e => e.stopPropagation()}
        className="bg-[#1A1A1A] border border-[#2D2D2D] rounded-3xl p-6 max-w-lg w-full"
      >
        <div className="flex items-center gap-3 mb-1">
          <div className="p-2 bg-[#00AF5C]/10 rounded-xl">
            <Coffee size={18} className="text-[#00AF5C]" />
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-[#FFFFFF]">Java runtime</h3>
            <p className="text-xs text-[#A0A0A0] truncate">{inst.displayName} · Minecraft {inst.version}</p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={18} className="text-[#00AF5C] animate-spin mr-2" />
            <span className="text-sm text-[#A0A0A0]">Checking installed runtimes…</span>
          </div>
        ) : (
          <div className="mt-4 space-y-1.5 max-h-[50vh] overflow-y-auto custom-scrollbar -mr-2 pr-2">
            <ChoiceRow
              active={choice === 'auto'}
              onSelect={() => setChoice('auto')}
              icon={Sparkles}
              title="Automatic (recommended)"
              subtitle={info?.required
                ? `Uses Java ${info.required} for Minecraft ${inst.version} — downloaded automatically if missing`
                : 'Picks the right Java for this Minecraft version automatically'}
            />
            {pinOptions.map(major => (
              <ChoiceRow
                key={major}
                active={choice === `jdk-${major}`}
                onSelect={() => setChoice(`jdk-${major}`)}
                icon={Coffee}
                title={`Java ${major}`}
                subtitle={managedMajors.has(major)
                  ? (info?.managed || []).find(m => m.major === major)?.path
                  : null}
                badge={
                  <>
                    {info?.required === major && requiredBadge}
                    {!managedMajors.has(major) && downloadBadge}
                  </>
                }
              />
            ))}
            {info?.system?.path && (
              <ChoiceRow
                active={choice === info.system.path}
                onSelect={() => setChoice(info.system.path)}
                icon={FolderCog}
                title={`System Java${info.system.major ? ` ${info.system.major}` : ''}`}
                subtitle={info.system.path}
              />
            )}
            <ChoiceRow
              active={choice === 'custom'}
              onSelect={() => setChoice('custom')}
              icon={FolderCog}
              title="Custom path"
              subtitle="Point at any java.exe yourself"
            />
            {choice === 'custom' && (
              <input
                type="text"
                autoFocus
                value={customPath}
                onChange={e => setCustomPath(e.target.value)}
                placeholder="C:\\Program Files\\Java\\jdk-21\\bin\\java.exe"
                className="w-full bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] rounded-xl px-3 py-2.5 text-sm text-[#FFFFFF] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[#555555] font-mono"
              />
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-[#2D2D2D] pt-4 mt-4">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 rounded-xl text-sm font-bold text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#1E1E1E] transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <motion.button
            onClick={handleSave}
            disabled={saving || loading}
            whileHover={{ scale: saving ? 1 : 1.03 }}
            whileTap={{ scale: saving ? 1 : 0.97 }}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold bg-[#00AF5C] hover:bg-[#00964F] text-white transition-colors disabled:opacity-60"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            Save
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
    </ModalPortal>
  );
}
