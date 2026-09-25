import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Plus, Loader2 } from 'lucide-react';
import ModalPortal from './ModalPortal';
import VersionSelect from './VersionSelect';
import { VanillaIcon, FabricIcon, ForgeIcon, NeoForgeIcon } from './LoaderIcons';
import { TITLEBAR_OFFSET } from '../lib/titlebar';

const LOADERS = [
  { key: 'vanilla',  label: 'Vanilla',  icon: VanillaIcon  },
  { key: 'fabric',   label: 'Fabric',   icon: FabricIcon   },
  { key: 'forge',    label: 'Forge',    icon: ForgeIcon    },
  { key: 'neoforge', label: 'NeoForge', icon: NeoForgeIcon },
];

// Create a launcher instance straight from the Instances tab — the same
// POST /api/launcher/instances the Play tab's "New" button uses, but with the
// loader + version picked here instead of inherited from the Play tab. Nothing
// is downloaded yet; the game files come down on first Play.
export default function NewInstanceModal({ settings, installedProfiles, onClose, onCreated, onError }) {
  const [name, setName] = useState('');
  const [loader, setLoader] = useState('vanilla');
  const [versions, setVersions] = useState([]);
  const [version, setVersion] = useState('');
  const [versionsLoading, setVersionsLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setVersionsLoading(true);
      try {
        const params = new URLSearchParams();
        if (loader === 'vanilla' && settings?.showSnapshots) params.set('includeSnapshots', '1');
        const qs = params.toString();
        const r = await fetch(`http://localhost:3001/api/versions/${loader}${qs ? '?' + qs : ''}`);
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok) throw new Error(d.error || 'Failed to load versions');
        setVersions(d);
        setVersion(prev => (prev && d.includes(prev)) ? prev : (d[0] || ''));
      } catch (err) {
        if (!cancelled) { setVersions([]); setVersion(''); onError?.(err.message); }
      }
      if (!cancelled) setVersionsLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loader, settings?.showSnapshots]);

  const installedSet = useMemo(() => {
    const s = new Set();
    for (const v of versions) if (installedProfiles?.has?.(`${loader}-${v}`)) s.add(v);
    return s;
  }, [versions, installedProfiles, loader]);

  const loaderLabel = LOADERS.find(l => l.key === loader)?.label || loader;
  const placeholder = version ? `${loaderLabel} ${version}` : 'My instance';
  const canCreate = !!version && !creating && !versionsLoading;

  const handleCreate = async () => {
    if (!canCreate) return;
    setCreating(true);
    try {
      const r = await fetch('http://localhost:3001/api/launcher/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loader, version, displayName: name.trim() || placeholder }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to create instance');
      onCreated?.(d);
    } catch (err) {
      onError?.(err.message);
      setCreating(false);
    }
  };

  return (
    <ModalPortal>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-center bg-[#000000]/80 backdrop-blur-sm p-4"
        style={{ top: TITLEBAR_OFFSET }}
        onClick={() => !creating && onClose?.()}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
          transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
          onClick={e => e.stopPropagation()}
          className="bg-[var(--c-surface-1)] border border-[var(--c-border)] rounded-3xl p-6 max-w-lg w-full"
        >
          <div className="flex items-center gap-3 mb-5">
            <div className="p-2 bg-[#00AF5C]/10 rounded-xl">
              <Plus size={18} className="text-[#00AF5C]" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-[var(--c-text-primary)]">New instance</h3>
              <p className="text-xs text-[var(--c-text-secondary)]">Game files download the first time you play it.</p>
            </div>
          </div>

          <label className="text-[10px] uppercase tracking-wider font-bold text-[var(--c-text-muted)] block mb-2">Name</label>
          <input
            type="text"
            autoFocus
            maxLength={60}
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape' && !creating) onClose?.(); }}
            placeholder={placeholder}
            className="w-full bg-[var(--c-base)] border border-[var(--c-border)] focus:border-[#00AF5C] rounded-xl px-3 py-2.5 text-sm text-[var(--c-text-primary)] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[var(--c-text-muted)] font-medium mb-5"
          />

          <label className="text-[10px] uppercase tracking-wider font-bold text-[var(--c-text-muted)] block mb-2">Loader</label>
          <div className="grid grid-cols-4 gap-2 mb-5">
            {LOADERS.map(({ key, label, icon: Icon }) => {
              const active = loader === key;
              return (
                <motion.button key={key}
                  onClick={() => setLoader(key)}
                  whileHover={{ y: -2 }}
                  whileTap={{ scale: 0.97 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  className={`flex flex-col items-center gap-1.5 px-2 py-3 rounded-2xl border transition-colors duration-200 ${
                    active
                      ? 'bg-[#00AF5C]/10 border-[#00AF5C]/30 text-[#00AF5C]'
                      : 'bg-[var(--c-surface-2)] border-[var(--c-border)] text-[var(--c-text-secondary)] hover:border-[var(--c-text-muted)]'
                  }`}>
                  <Icon size={18} />
                  <span className="text-xs font-bold">{label}</span>
                </motion.button>
              );
            })}
          </div>

          <label className="text-[10px] uppercase tracking-wider font-bold text-[var(--c-text-muted)] block mb-2">Version</label>
          <VersionSelect
            value={version}
            onChange={setVersion}
            options={versions}
            installedSet={installedSet}
            loading={versionsLoading}
          />

          <div className="flex items-center justify-end gap-2 border-t border-[var(--c-border)] pt-4 mt-6">
            <button
              onClick={onClose}
              disabled={creating}
              className="px-4 py-2 rounded-xl text-sm font-bold text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)] transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
            <motion.button
              onClick={handleCreate}
              disabled={!canCreate}
              whileHover={canCreate ? { scale: 1.03 } : {}}
              whileTap={canCreate ? { scale: 0.97 } : {}}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold bg-[#00AF5C] hover:bg-[#00964F] text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              Create
            </motion.button>
          </div>
        </motion.div>
      </motion.div>
    </ModalPortal>
  );
}
