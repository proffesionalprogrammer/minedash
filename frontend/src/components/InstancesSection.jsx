import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Play, Search, Trash2, Boxes, Loader2, Check, X,
  Box, Layers, Hammer, FlaskConical, Download, Square,
  Settings2, ListChecks,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Select from './Select';
import SkinHead from './SkinHead';
import InstanceDetailModal from './InstanceDetailModal';
import ModalPortal from './ModalPortal';
import Tooltip from './Tooltip';
import LoaderGlyph from './LoaderGlyph';
import { TITLEBAR_OFFSET } from '../lib/titlebar';
import duskCover from '../assets/dusk.jpg';

// Loader → icon for cards that don't have a modpack icon. Same lucide set as
// PlaySection's loader tab strip so the visual language is consistent.
const LOADER_ICONS = {
  vanilla:  Box,
  fabric:   Layers,
  forge:    Hammer,
  neoforge: FlaskConical,
};

// Loaders that have a dedicated Modrinth glyph (LoaderGlyph). Anything not in
// this set (vanilla, unknown) falls back to its lucide LOADER_ICONS mark.
const GLYPH_LOADERS = new Set(['fabric', 'forge', 'neoforge', 'quilt']);

const LOADER_LABEL = {
  vanilla:  'Vanilla',
  fabric:   'Fabric',
  forge:    'Forge',
  neoforge: 'NeoForge',
};

const SORT_OPTIONS = [
  { value: 'recent',  label: 'Recently created' },
  { value: 'name',    label: 'Name (A→Z)'       },
  { value: 'loader',  label: 'Loader'           },
];

// "My Modpacks" home — grid of installed instances. Each card is an instance
// from /api/launcher/instances. Source: 'browse-modpack' instances surface
// their pack icon and a small "Modpack" badge; hand-curated instances fall
// back to the loader icon centered in the icon slot.
//
// Interactions:
//   - Hover-Play button → launches the instance in place via the shared
//     launchSession, with progress shown on the card itself (no tab switch)
//   - Kebab → Open folder / Rename / Delete (existing /api/launcher/instances
//     endpoints; no new backend work needed)
//   - Search filter + sort dropdown above the grid
//   - For browse-installed modpacks: a one-time Modrinth lookup compares the
//     installed version against the latest release and surfaces an
//     "Update to vX.Y.Z" CTA on the card. Click → updates via the
//     /modpack/update endpoint with full progress in the toast stack.
export default function InstancesSection({
  onError, instancesRefreshKey, modpackInstalls,
  accounts, activeAccountId, launchSession,
}) {
  const [instances, setInstances] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [query, setQuery]         = useState('');
  const [sort, setSort]           = useState('recent');
  const [busyId, setBusyId] = useState(null);
  // The instance whose centered detail/management panel is open (null = none).
  const [detailInst, setDetailInst] = useState(null);
  // Multi-select: entered via long-press on a card or the "Select" toolbar
  // button. `selectedIds` holds the chosen instance ids while active.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  // Modpack update availability — keyed by instance id. Populated lazily
  // once per instance on first render. Holds `{ availableVersionId,
  // availableVersionNumber }` only when the latest Modrinth version differs
  // from the locally-installed one.
  const [packUpdates, setPackUpdates] = useState({});
  const updateChecksFired = useRef(new Set());

  // In-place launch. launchSession is a single shared session (one launch at a
  // time, lifted to App), so we track which instance *we* kicked off here to
  // paint progress on the right card. Cleared when the session returns to idle.
  const {
    phase: launchPhase = 'idle',
    progress: launchProgress = 0,
    statusText: launchStatus = '',
    instanceId: sessionLaunchingId = null,
    launch,
    cancel: cancelLaunch,
  } = launchSession || {};
  // Which card is launching is derived from the shared session — not local
  // state — so it survives this tab unmounting/remounting on a tab switch
  // (and reflects launches kicked off from the Play tab too). Null while idle.
  const launchingId = launchPhase !== 'idle' ? sessionLaunchingId : null;
  const activeAccount = accounts?.find(a => a.id === activeAccountId);

  const handlePlay = (inst) => {
    if (!activeAccount) {
      onError?.('Add an account from the menu in the top right to start playing.');
      return;
    }
    if (launchPhase !== 'idle') return; // a launch is already in flight
    launch?.({ loader: inst.loader, version: inst.version, instanceId: inst.id });
  };

  const fetchInstances = async () => {
    setLoading(true);
    try {
      const r = await fetch('http://localhost:3001/api/launcher/instances');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load instances');
      setInstances(Array.isArray(d) ? d : []);
    } catch (err) {
      onError?.(err.message);
    }
    setLoading(false);
  };

  useEffect(() => { fetchInstances(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Lazy update-check for browse-installed modpacks. Each instance is
  // checked once per session — we cache the result keyed by instance id +
  // currentModpackVersionId so a re-check fires when the user actually
  // updates and the local version changes.
  useEffect(() => {
    const candidates = instances.filter(
      i => i.source === 'browse-modpack'
        && i.modpackProjectId
        && i.currentModpackVersionId
    );
    for (const inst of candidates) {
      const key = `${inst.id}::${inst.currentModpackVersionId}`;
      if (updateChecksFired.current.has(key)) continue;
      updateChecksFired.current.add(key);
      (async () => {
        try {
          const params = new URLSearchParams();
          if (['fabric','forge','neoforge'].includes(inst.loader)) params.set('loader', inst.loader);
          if (inst.version) params.set('gameVersion', inst.version);
          const r = await fetch(`http://localhost:3001/api/modrinth/project/${inst.modpackProjectId}/versions?${params}`);
          if (!r.ok) return;
          const vs = await r.json();
          if (!Array.isArray(vs) || vs.length === 0) return;
          vs.sort((a, b) => {
            const ra = { release: 0, beta: 1, alpha: 2 }[a.version_type] ?? 3;
            const rb = { release: 0, beta: 1, alpha: 2 }[b.version_type] ?? 3;
            if (ra !== rb) return ra - rb;
            return (Date.parse(b.date_published || '') || 0) - (Date.parse(a.date_published || '') || 0);
          });
          const latest = vs[0];
          if (latest && latest.id !== inst.currentModpackVersionId) {
            setPackUpdates(p => ({
              ...p,
              [inst.id]: {
                availableVersionId:     latest.id,
                availableVersionNumber: latest.version_number,
                availablePublished:     latest.date_published,
              },
            }));
          }
        } catch { /* best-effort — silent on network errors */ }
      })();
    }
  }, [instances]);

  const handleUpdatePack = async (inst) => {
    if (busyId === inst.id) return;
    const target = packUpdates[inst.id];
    if (!target) return;
    setBusyId(inst.id);
    try {
      const r = await fetch(`http://localhost:3001/api/launcher/instances/${inst.id}/modpack/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId: target.availableVersionId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Update failed');
      if (d.sessionId && modpackInstalls?.trackInstall) {
        modpackInstalls.trackInstall(d.sessionId, `browse:${inst.modpackProjectId}`, {
          source: 'browse',
          loader: inst.loader,
          version: inst.version,
          instanceId: inst.id,
          title: inst.displayName,
          iconUrl: inst.iconUrl || null,
        });
      }
      // Clear the local "update available" chip — once the install lands
      // the instances refetch (driven by App's `done`-toast effect) will
      // re-populate with the new version number.
      setPackUpdates(p => {
        const next = { ...p };
        delete next[inst.id];
        return next;
      });
    } catch (err) {
      onError?.(err.message);
    }
    setBusyId(null);
  };
  // Refetch when App signals an external change (e.g. a Browse install just
  // created a new instance and we want it to appear without a manual reload).
  useEffect(() => {
    if (instancesRefreshKey == null) return;
    fetchInstances();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instancesRefreshKey]);

  // In-flight modpack installs that BrowseSection initiated — we surface a
  // skeleton-style card while a pack is downloading so the user sees their
  // future instance taking shape. Keyed off `browse:${projectId}`.
  const liveInstalls = useMemo(() => {
    const out = [];
    for (const [key, entry] of Object.entries(modpackInstalls?.installs || {})) {
      if (!key.startsWith('browse:')) continue;
      if (entry?.status === 'done') continue; // real instance already in list
      out.push({ key, entry });
    }
    return out;
  }, [modpackInstalls]);

  // The backend registers the real instance the moment a Browse install starts
  // (so it has an id for the prepare-only worker), which means the registry
  // already contains the instance while its InstallingCard is still on screen.
  // Without this, the user sees TWO cards for one pack during download — the
  // skeleton and the freshly-registered real card — collapsing to one when the
  // install finishes. Hide the real card for any instance that has an in-flight
  // install so only the InstallingCard (with its progress bar) shows.
  const installingInstanceIds = useMemo(() => {
    const s = new Set();
    for (const { entry } of liveInstalls) {
      if (entry?.instanceId) s.add(entry.instanceId);
    }
    return s;
  }, [liveInstalls]);

  // Apply filter + sort. Memoised so re-renders from busy state don't redo
  // the sort on every keystroke.
  const visibleInstances = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = q
      ? instances.filter(i => (i.displayName || '').toLowerCase().includes(q)
                            || (i.loader     || '').toLowerCase().includes(q)
                            || (i.version    || '').toLowerCase().includes(q))
      : instances.slice();
    // Drop instances whose install is still in flight — their InstallingCard
    // is already on screen, so showing the registry card too would duplicate.
    if (installingInstanceIds.size > 0) {
      list = list.filter(i => !installingInstanceIds.has(i.id));
    }
    if (sort === 'name') {
      list.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
    } else if (sort === 'loader') {
      list.sort((a, b) => {
        const al = a.loader || '';
        const bl = b.loader || '';
        if (al !== bl) return al.localeCompare(bl);
        return (a.displayName || '').localeCompare(b.displayName || '');
      });
    } else {
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
    return list;
  }, [instances, query, sort, installingInstanceIds]);

  // Detail-panel callbacks. The panel owns rename/RAM/Java/worlds/folder/export/
  // delete now — the parent just keeps its `instances` list (and the open
  // panel's copy) in sync with what the panel saved or removed.
  const applyInstanceUpdate = (updated) => {
    if (!updated || !updated.id) return;
    setInstances(prev => prev.map(i => i.id === updated.id ? { ...i, ...updated } : i));
    setDetailInst(prev => (prev && prev.id === updated.id ? { ...prev, ...updated } : prev));
  };
  const removeInstance = (id) => {
    setInstances(prev => prev.filter(i => i.id !== id));
    setDetailInst(prev => (prev && prev.id === id ? null : prev));
    setSelectedIds(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev); next.delete(id); return next;
    });
  };

  // ── Multi-select ──────────────────────────────────────────────────
  const enterSelect = (id) => {
    setSelectMode(true);
    setSelectedIds(new Set(id ? [id] : []));
  };
  const exitSelect = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setConfirmBulkDelete(false);
  };
  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectAllVisible = () => setSelectedIds(new Set(visibleInstances.map(i => i.id)));

  // Esc exits selection mode (when no modal is sitting on top).
  useEffect(() => {
    if (!selectMode) return;
    const onKey = (e) => { if (e.key === 'Escape' && !detailInst) exitSelect(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectMode, detailInst]);

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkBusy(true);
    const failed = [];
    for (const id of ids) {
      try {
        const r = await fetch(`http://localhost:3001/api/launcher/instances/${id}`, { method: 'DELETE' });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d.error || 'Failed to delete');
        }
        setInstances(prev => prev.filter(i => i.id !== id));
      } catch (err) {
        const inst = instances.find(i => i.id === id);
        failed.push(inst?.displayName || id);
        onError?.(`Couldn't delete ${inst?.displayName || 'an instance'}: ${err.message}`);
      }
    }
    setBulkBusy(false);
    if (failed.length === 0) exitSelect();
    else { setConfirmBulkDelete(false); setSelectedIds(new Set(instances.filter(i => failed.includes(i.displayName)).map(i => i.id))); }
  };

  const selectedCount = selectedIds.size;

  return (
    <div className="relative flex-1 flex flex-col h-full bg-[var(--c-base)] px-6 md:px-10 py-6 overflow-hidden">
      <div className="max-w-6xl mx-auto w-full flex flex-col flex-1 min-h-0">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 mb-5">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-[#00AF5C]/10 rounded-2xl">
              <Boxes size={20} className="text-[#00AF5C]" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-[var(--c-text-primary)]">My Instances</h2>
              <p className="text-xs text-[var(--c-text-secondary)]">
                {loading
                  ? 'Loading…'
                  : `${Math.max(0, instances.length - installingInstanceIds.size)} installed${liveInstalls.length > 0 ? ` · ${liveInstalls.length} downloading` : ''}`}
              </p>
            </div>
          </div>
          {!loading && visibleInstances.length > 0 && (
            selectMode ? (
              <button
                onClick={exitSelect}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-bold text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] bg-[var(--c-surface-1)] hover:bg-[var(--c-surface-2)] border border-[var(--c-border)] transition-colors"
              >
                <X size={15} /> Cancel
              </button>
            ) : (
              <Tooltip content="Select multiple — or long-press a card" side="bottom" align="end">
                <button
                  onClick={() => enterSelect(null)}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-bold text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] bg-[var(--c-surface-1)] hover:bg-[var(--c-surface-2)] border border-[var(--c-border)] transition-colors"
                >
                  <ListChecks size={15} /> Select
                </button>
              </Tooltip>
            )
          )}
        </div>

        {/* Search + sort */}
        <div className="flex items-center gap-2 mb-4">
          <div className="relative flex-1 min-w-0">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--c-text-muted)]" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search instances…"
              className="w-full bg-[var(--c-surface-1)] border border-[var(--c-border)] focus:border-[#00AF5C] rounded-xl pl-10 pr-3 py-2.5 text-sm text-[var(--c-text-primary)] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[var(--c-text-muted)] font-medium"
            />
          </div>
          <Select value={sort} onChange={setSort} options={SORT_OPTIONS} className="flex-shrink-0" />
        </div>

        {/* Grid — pt-1 gives the cards' hover-lift (y: -3) headroom so the top
            row's border isn't shaved off by the scroll container's top edge. */}
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar -mr-2 pr-2 pt-1">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={20} className="text-[#00AF5C] animate-spin mr-2" />
              <span className="text-sm text-[var(--c-text-secondary)]">Loading instances…</span>
            </div>
          ) : visibleInstances.length === 0 && liveInstalls.length === 0 ? (
            <EmptyState hasQuery={!!query.trim()} />
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {liveInstalls.map(({ key, entry }) => (
                <InstallingCard
                  key={key}
                  entry={entry}
                  onCancel={() => modpackInstalls?.cancelInstall?.(key)}
                />
              ))}
              {visibleInstances.map((inst, idx) => (
                <InstanceCard
                  key={inst.id}
                  inst={inst}
                  index={idx}
                  activeAccount={activeAccount}
                  busy={busyId === inst.id}
                  packUpdate={packUpdates[inst.id] || null}
                  onUpdatePack={() => handleUpdatePack(inst)}
                  launching={launchingId === inst.id}
                  launchPhase={launchPhase}
                  launchProgress={launchProgress}
                  launchStatus={launchStatus}
                  playDisabled={launchPhase !== 'idle' && launchingId !== inst.id}
                  onCancelLaunch={cancelLaunch}
                  onPlay={() => handlePlay(inst)}
                  onManage={() => setDetailInst(inst)}
                  selectMode={selectMode}
                  selected={selectedIds.has(inst.id)}
                  onToggleSelect={() => toggleSelect(inst.id)}
                  onLongPress={() => enterSelect(inst.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Floating multi-select action bar */}
      <AnimatePresence>
        {selectMode && (
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ type: 'spring', stiffness: 400, damping: 32 }}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 bg-[var(--c-surface-1)] border border-[var(--c-border)] rounded-2xl shadow-2xl shadow-black/50 px-3 py-2.5"
          >
            <span className="text-sm font-bold text-[var(--c-text-primary)] tabular-nums px-2">
              {selectedCount} selected
            </span>
            <span className="w-px h-6 bg-[var(--c-border)]" />
            <button
              onClick={selectAllVisible}
              className="px-3 py-2 rounded-xl text-sm font-bold text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)] transition-colors"
            >
              Select all
            </button>
            <motion.button
              onClick={() => setConfirmBulkDelete(true)}
              disabled={selectedCount === 0}
              whileTap={selectedCount === 0 ? {} : { scale: 0.97 }}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-bold bg-[var(--c-danger)] hover:bg-[var(--c-danger-hover)] text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Trash2 size={15} /> Delete
            </motion.button>
            <button
              onClick={exitSelect}
              className="p-2 rounded-xl text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)] transition-colors"
              aria-label="Exit selection"
            >
              <X size={16} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bulk-delete confirm */}
      <AnimatePresence>
        {confirmBulkDelete && (
          <ModalPortal>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-center bg-[#000000]/80 backdrop-blur-sm p-4"
            style={{ top: TITLEBAR_OFFSET }}
            onClick={() => !bulkBusy && setConfirmBulkDelete(false)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
              onClick={e => e.stopPropagation()}
              className="bg-[var(--c-surface-1)] border border-[var(--c-border)] rounded-3xl p-6 max-w-md w-full"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 bg-[var(--c-danger)]/10 rounded-xl">
                  <Trash2 size={18} className="text-[var(--c-danger)]" />
                </div>
                <h3 className="text-lg font-bold text-[var(--c-text-primary)]">
                  Delete {selectedCount} instance{selectedCount === 1 ? '' : 's'}?
                </h3>
              </div>
              <p className="text-sm text-[var(--c-text-secondary)]">
                Each instance's on-disk profile (mods, worlds, configs) will be permanently removed. Running instances are skipped.
              </p>
              <div className="flex items-center justify-end gap-2 border-t border-[var(--c-border)] pt-4 mt-5">
                <button
                  onClick={() => setConfirmBulkDelete(false)}
                  disabled={bulkBusy}
                  className="px-4 py-2 rounded-xl text-sm font-bold text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)] transition-colors disabled:opacity-40"
                >
                  Cancel
                </button>
                <motion.button
                  onClick={handleBulkDelete}
                  disabled={bulkBusy}
                  whileTap={{ scale: 0.97 }}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold bg-[var(--c-danger)] hover:bg-[var(--c-danger-hover)] text-white transition-colors disabled:opacity-60"
                >
                  {bulkBusy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  Delete {selectedCount}
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
          </ModalPortal>
        )}
      </AnimatePresence>

      {/* Per-instance detail / management panel */}
      <AnimatePresence>
        {detailInst && (
          <InstanceDetailModal
            key="detail-modal"
            inst={detailInst}
            onClose={() => setDetailInst(null)}
            onError={onError}
            onSaved={applyInstanceUpdate}
            onDeleted={removeInstance}
            onPlay={() => { handlePlay(detailInst); setDetailInst(null); }}
            playDisabled={launchPhase !== 'idle'}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function EmptyState({ hasQuery }) {
  return (
    <div className="flex flex-col items-center py-20 text-[var(--c-text-muted)]">
      <div className="p-4 bg-[var(--c-surface-1)] border border-[var(--c-border)] rounded-3xl mb-4">
        <Boxes size={36} className="text-[var(--c-text-muted)]" />
      </div>
      {hasQuery ? (
        <>
          <p className="text-sm font-bold text-[var(--c-text-secondary)]">No instances match</p>
          <p className="text-xs mt-1">Try a different search.</p>
        </>
      ) : (
        <>
          <p className="text-sm font-bold text-[var(--c-text-secondary)]">No instances yet</p>
          <p className="text-xs mt-1 max-w-xs text-center">
            Head to <span className="font-bold text-[var(--c-text-primary)]">Browse</span> and install a modpack, or create one from the <span className="font-bold text-[var(--c-text-primary)]">Launcher</span> tab.
          </p>
        </>
      )}
    </div>
  );
}

// Skeleton card representing a Browse install still in flight. Reads its
// progress from the modpackInstalls entry so the user sees mod-by-mod
// progress without leaving the Instances tab.
function InstallingCard({ entry, onCancel }) {
  const cancelling = entry.status === 'cancelling';
  const pct = entry.status === 'done' ? 100
    : (entry.total > 0 ? Math.min(99, Math.round((entry.task / entry.total) * 100)) : 0);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-[var(--c-surface-1)] border border-[#00AF5C]/30 rounded-2xl overflow-hidden flex flex-col"
    >
      <div className="group/icon aspect-square bg-[var(--c-base)] flex items-center justify-center relative overflow-hidden">
        {entry.iconUrl
          ? <img src={entry.iconUrl} alt="" className="w-full h-full object-cover opacity-60" />
          : <Download size={36} className="text-[#00AF5C]/50" />}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-[var(--c-surface-1)] flex items-end justify-center pb-3">
          <Loader2 size={20} className="text-[#00AF5C] animate-spin" />
        </div>
        {/* Cancel overlay — appears on hover so the download can be stopped
            mid-flight. Always visible while cancelling so the user gets feedback. */}
        <div className={`absolute inset-0 flex items-center justify-center bg-[#000000]/60 transition-opacity ${
          cancelling ? 'opacity-100' : 'opacity-0 group-hover/icon:opacity-100'
        }`}>
          <motion.button
            onClick={(e) => { e.stopPropagation(); onCancel?.(); }}
            disabled={cancelling}
            whileHover={cancelling ? {} : { scale: 1.05 }}
            whileTap={cancelling ? {} : { scale: 0.95 }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-[var(--c-surface-2)] text-[var(--c-text-secondary)] hover:text-[var(--c-danger)] border border-[var(--c-border)] hover:border-[var(--c-danger)]/40 transition-colors disabled:opacity-60"
          >
            <Square size={12} fill="currentColor" />
            {cancelling ? 'Stopping…' : 'Cancel'}
          </motion.button>
        </div>
      </div>
      <div className="p-3">
        <p className="text-sm font-bold text-[var(--c-text-primary)] truncate">{entry.title || 'Installing modpack…'}</p>
        <p className="text-[10px] text-[#00AF5C] font-bold truncate mt-0.5">
          {cancelling ? 'Cancelling…' : (entry.statusText || 'Starting…')}
        </p>
        <div className="mt-2 h-1 bg-[var(--c-border)] rounded-full overflow-hidden">
          <motion.div
            initial={false}
            animate={{ width: `${pct}%` }}
            transition={{ ease: [0.22, 1, 0.36, 1], duration: 0.4 }}
            className="h-full bg-[#00AF5C]"
          />
        </div>
        <p className="text-[10px] text-[var(--c-text-secondary)] tabular-nums mt-1">
          {entry.total > 0 ? `${entry.task.toLocaleString()} / ${entry.total.toLocaleString()} files` : 'Preparing…'}
        </p>
      </div>
    </motion.div>
  );
}

function InstanceCard({
  inst, index, activeAccount, busy,
  packUpdate, onUpdatePack,
  launching, launchPhase, launchProgress, launchStatus, playDisabled, onCancelLaunch,
  onPlay, onManage,
  selectMode, selected, onToggleSelect, onLongPress,
}) {
  const LoaderIcon = LOADER_ICONS[inst.loader] || Box;
  const loaderLabel = LOADER_LABEL[inst.loader] || inst.loader;
  const isModpack = inst.source === 'browse-modpack';
  const isServerInstance = !!inst.serverInstance;

  // Long-press → enter multi-select. Arm a timer on pointer-down; a move past a
  // small threshold (a scroll/drag, not a press) or an early release cancels
  // it. When it fires we flag the synthetic click that follows so it doesn't
  // immediately toggle the just-selected card straight back off.
  const lpTimer = useRef(null);
  const lpStart = useRef(null);
  const lpFired = useRef(false);
  const clearLp = () => { if (lpTimer.current) { clearTimeout(lpTimer.current); lpTimer.current = null; } };

  const handlePointerDown = (e) => {
    if (selectMode) return;                          // already selecting
    if (e.button != null && e.button !== 0) return;  // primary button / touch only
    lpStart.current = { x: e.clientX, y: e.clientY };
    lpFired.current = false;
    clearLp();
    lpTimer.current = setTimeout(() => { lpFired.current = true; onLongPress?.(); }, 450);
  };
  const handlePointerMove = (e) => {
    if (!lpStart.current) return;
    if (Math.abs(e.clientX - lpStart.current.x) > 8 || Math.abs(e.clientY - lpStart.current.y) > 8) clearLp();
  };
  const handlePointerEnd = () => { clearLp(); lpStart.current = null; };

  const handleCardClick = () => {
    if (lpFired.current) { lpFired.current = false; return; } // swallow post-longpress click
    if (selectMode) onToggleSelect?.();
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.02, 0.2), duration: 0.2 }}
      whileHover={selectMode ? {} : { y: -3 }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerLeave={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onClick={handleCardClick}
      className={`group relative bg-[var(--c-surface-1)] border rounded-2xl overflow-hidden flex flex-col transition-colors ${
        selectMode ? 'cursor-pointer select-none ' : ''
      }${
        selected
          ? 'border-[#00AF5C] ring-2 ring-[#00AF5C]/40'
          : 'border-[var(--c-border)] hover:border-[#00AF5C]/40'
      }`}
    >
      {/* Icon / cover area. Modpacks ship their own cover art (inst.iconUrl);
          hand-made and server instances fall back to the shared dusk cover so
          every card reads as a real instance rather than a bare loader glyph. */}
      <div className="aspect-square bg-[var(--c-base)] flex items-center justify-center relative overflow-hidden">
        <img
          src={inst.iconUrl || duskCover}
          alt=""
          className="w-full h-full object-cover"
        />

        {/* Selection checkbox — shown only in multi-select mode, top-left where
            the source badge would otherwise sit. */}
        {selectMode && (
          <div className="absolute top-2 left-2 z-30">
            <span className={`flex items-center justify-center w-6 h-6 rounded-full border-2 transition-colors ${
              selected
                ? 'bg-[#00AF5C] border-[#00AF5C] text-white'
                : 'bg-[#000000]/40 border-white/70 backdrop-blur-sm text-transparent'
            }`}>
              <Check size={14} strokeWidth={3} />
            </span>
          </div>
        )}

        {/* Source badge in the corner. Server instances get their own badge
            so a user with both kinds doesn't confuse a pack with a
            server-managed profile. Hidden while selecting (checkbox takes over). */}
        {!selectMode && (isModpack || isServerInstance) && (
          <span className={`absolute top-2 left-2 text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md border ${
            isServerInstance
              ? 'bg-[var(--c-surface-1)]/80 text-[var(--c-text-secondary)] border-[var(--c-border)]'
              : 'bg-[#00AF5C]/15 text-[#00AF5C] border-[#00AF5C]/30'
          }`}>
            {isServerInstance ? 'Server' : 'Modpack'}
          </span>
        )}

        {/* Top-right corner controls: the optional "update available" pill plus
            the loader glyph badge so Forge/Fabric/NeoForge is identifiable at a
            glance (same Modrinth marks as the Browse filter rail). Loaders
            without a dedicated glyph (vanilla) fall back to their lucide icon.
            The update pill is suppressed while selecting so a tap can't fire an
            update instead of toggling the card. */}
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1.5">
          {packUpdate && !selectMode && (
            <Tooltip content="Modpack update available" side="bottom" align="end">
              <button
                onClick={(e) => { e.stopPropagation(); onUpdatePack?.(); }}
                disabled={busy}
                className="flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold px-1.5 py-1 rounded-md border bg-amber-500/20 text-amber-300 border-amber-500/40 hover:bg-amber-500/30 transition-colors disabled:opacity-60"
              >
                {busy ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
                v{packUpdate.availableVersionNumber}
              </button>
            </Tooltip>
          )}
          <Tooltip content={`${loaderLabel}${inst.version ? ` ${inst.version}` : ''}`} side="bottom" align="end">
            <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--c-surface-1)]/85 border border-[var(--c-border)] backdrop-blur-sm shadow-sm shadow-black/30">
              {GLYPH_LOADERS.has(inst.loader)
                ? <LoaderGlyph loader={inst.loader} size={16} />
                : <LoaderIcon size={15} className="text-[var(--c-text-secondary)]" strokeWidth={2} />}
            </span>
          </Tooltip>
        </div>

        {/* Launch progress overlay — replaces the play button while this
            instance is launching. Shows the live status + a fill bar and a
            Stop control so the user can cancel an in-flight download. */}
        {launching ? (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-[#000000]/80 backdrop-blur-sm p-3 text-center">
            {launchPhase === 'launched' ? (
              <>
                <Play size={22} className="text-[#00AF5C]" fill="currentColor" />
                <p className="text-xs font-bold text-[var(--c-text-primary)]">Game running</p>
              </>
            ) : (
              <>
                <Loader2 size={22} className="text-[#00AF5C] animate-spin" />
                <p className="text-[11px] font-bold text-[var(--c-text-primary)] line-clamp-2 leading-tight">
                  {launchStatus || 'Preparing…'}
                </p>
                <div className="w-3/4 h-1 bg-[var(--c-border)] rounded-full overflow-hidden">
                  <motion.div
                    initial={false}
                    animate={{ width: `${launchProgress}%` }}
                    transition={{ ease: [0.22, 1, 0.36, 1], duration: 0.4 }}
                    className="h-full bg-[#00AF5C]"
                  />
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); onCancelLaunch?.(); }}
                  disabled={launchPhase === 'cancelling'}
                  className="mt-1 flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold bg-[var(--c-surface-2)] text-[var(--c-text-secondary)] hover:text-[var(--c-danger)] border border-[var(--c-border)] hover:border-[var(--c-danger)]/40 transition-colors disabled:opacity-50"
                >
                  <Square size={10} fill="currentColor" />
                  {launchPhase === 'cancelling' ? 'Stopping…' : 'Stop'}
                </button>
              </>
            )}
          </div>
        ) : selectMode ? null : (
          /* Hover play button — centered, big, brand green. */
          <motion.button
            onClick={(e) => { e.stopPropagation(); onPlay?.(); }}
            disabled={playDisabled}
            whileHover={playDisabled ? {} : { scale: 1.05 }}
            whileTap={playDisabled ? {} : { scale: 0.95 }}
            className={`absolute inset-0 flex items-center justify-center bg-[#000000]/60 transition-opacity ${
              playDisabled ? 'opacity-0 cursor-not-allowed' : 'opacity-0 group-hover:opacity-100'
            }`}
          >
            <div className="flex flex-col items-center gap-2">
              <span className="flex items-center justify-center w-14 h-14 rounded-full bg-[#00AF5C] text-white shadow-lg shadow-[#00AF5C]/40">
                <Play size={22} className="ml-0.5" fill="currentColor" />
              </span>
              {activeAccount && (
                <span className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-[#000000]/50 text-[11px] font-bold text-white">
                  <SkinHead username={activeAccount.username} uuid={activeAccount.uuid} type={activeAccount.type} size={16} rounded="rounded" />
                  Play as {activeAccount.username}
                </span>
              )}
            </div>
          </motion.button>
        )}
      </div>

      {/* Card body */}
      <div className="p-3 flex flex-col gap-1 flex-1">
        <Tooltip content={inst.displayName} align="start" className="w-full min-w-0">
          <p className="text-sm font-bold text-[var(--c-text-primary)] truncate w-full">
            {inst.displayName}
          </p>
        </Tooltip>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-[10px] text-[var(--c-text-secondary)] font-bold truncate">
            <LoaderIcon size={10} />
            {loaderLabel} {inst.version}
          </span>
          {!selectMode && (
            <Tooltip content="Manage instance" side="top" align="end">
              <button
                onClick={(e) => { e.stopPropagation(); onManage?.(); }}
                className="p-1 rounded-md text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-border)] transition-colors"
                aria-label="Manage instance"
              >
                <Settings2 size={14} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </motion.div>
  );
}
