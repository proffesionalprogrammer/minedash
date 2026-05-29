import React, { useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Play, Search, FolderOpen, Pencil, Trash2, Boxes, Loader2, Check, X,
  Box, Layers, Hammer, FlaskConical, MoreVertical, Download, Square,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Select from './Select';
import SkinHead from './SkinHead';

// Loader → icon for cards that don't have a modpack icon. Same lucide set as
// PlaySection's loader tab strip so the visual language is consistent.
const LOADER_ICONS = {
  vanilla:  Box,
  fabric:   Layers,
  forge:    Hammer,
  neoforge: FlaskConical,
};

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
  const [renamingId, setRenamingId]   = useState(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);
  const [busyId, setBusyId] = useState(null);
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

  const handleRename = async (id) => {
    const name = renameDraft.trim();
    if (!name) return;
    setBusyId(id);
    try {
      const r = await fetch(`http://localhost:3001/api/launcher/instances/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: name }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to rename');
      setInstances(prev => prev.map(i => i.id === id ? { ...i, displayName: d.displayName || name } : i));
      setRenamingId(null);
      setRenameDraft('');
    } catch (err) {
      onError?.(err.message);
    }
    setBusyId(null);
  };

  const handleDelete = async (id) => {
    setBusyId(id);
    try {
      const r = await fetch(`http://localhost:3001/api/launcher/instances/${id}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Failed to delete');
      setInstances(prev => prev.filter(i => i.id !== id));
      setPendingDelete(null);
    } catch (err) {
      onError?.(err.message);
    }
    setBusyId(null);
  };

  const handleOpenFolder = async (id) => {
    try {
      await fetch(`http://localhost:3001/api/launcher/instances/${id}/open-folder`, { method: 'POST' });
    } catch (err) {
      onError?.(err.message);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#111111] px-6 md:px-10 py-6 overflow-hidden">
      <div className="max-w-6xl mx-auto w-full flex flex-col flex-1 min-h-0">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 mb-5">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-[#00AF5C]/10 rounded-2xl">
              <Boxes size={20} className="text-[#00AF5C]" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-[#FFFFFF]">My Instances</h2>
              <p className="text-xs text-[#A0A0A0]">
                {loading
                  ? 'Loading…'
                  : `${Math.max(0, instances.length - installingInstanceIds.size)} installed${liveInstalls.length > 0 ? ` · ${liveInstalls.length} downloading` : ''}`}
              </p>
            </div>
          </div>
        </div>

        {/* Search + sort */}
        <div className="flex items-center gap-2 mb-4">
          <div className="relative flex-1 min-w-0">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555555]" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search instances…"
              className="w-full bg-[#1A1A1A] border border-[#2D2D2D] focus:border-[#00AF5C] rounded-xl pl-10 pr-3 py-2.5 text-sm text-[#FFFFFF] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[#555555] font-medium"
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
              <span className="text-sm text-[#A0A0A0]">Loading instances…</span>
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
                  renaming={renamingId === inst.id}
                  renameDraft={renameDraft}
                  pendingDelete={pendingDelete === inst.id}
                  packUpdate={packUpdates[inst.id] || null}
                  onUpdatePack={() => handleUpdatePack(inst)}
                  launching={launchingId === inst.id}
                  launchPhase={launchPhase}
                  launchProgress={launchProgress}
                  launchStatus={launchStatus}
                  playDisabled={launchPhase !== 'idle' && launchingId !== inst.id}
                  onCancelLaunch={cancelLaunch}
                  onPlay={() => handlePlay(inst)}
                  onOpenFolder={() => handleOpenFolder(inst.id)}
                  onStartRename={() => { setRenamingId(inst.id); setRenameDraft(inst.displayName || ''); }}
                  onRenameDraft={setRenameDraft}
                  onSubmitRename={() => handleRename(inst.id)}
                  onCancelRename={() => { setRenamingId(null); setRenameDraft(''); }}
                  onAskDelete={() => setPendingDelete(inst.id)}
                  onConfirmDelete={() => handleDelete(inst.id)}
                  onCancelDelete={() => setPendingDelete(null)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ hasQuery }) {
  return (
    <div className="flex flex-col items-center py-20 text-[#555555]">
      <div className="p-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-3xl mb-4">
        <Boxes size={36} className="text-[#555555]" />
      </div>
      {hasQuery ? (
        <>
          <p className="text-sm font-bold text-[#A0A0A0]">No instances match</p>
          <p className="text-xs mt-1">Try a different search.</p>
        </>
      ) : (
        <>
          <p className="text-sm font-bold text-[#A0A0A0]">No instances yet</p>
          <p className="text-xs mt-1 max-w-xs text-center">
            Head to <span className="font-bold text-[#FFFFFF]">Browse</span> and install a modpack, or create one from the <span className="font-bold text-[#FFFFFF]">Launcher</span> tab.
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
      className="bg-[#1A1A1A] border border-[#00AF5C]/30 rounded-2xl overflow-hidden flex flex-col"
    >
      <div className="group/icon aspect-square bg-[#111111] flex items-center justify-center relative overflow-hidden">
        {entry.iconUrl
          ? <img src={entry.iconUrl} alt="" className="w-full h-full object-cover opacity-60" />
          : <Download size={36} className="text-[#00AF5C]/50" />}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-[#1A1A1A] flex items-end justify-center pb-3">
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
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-[#1E1E1E] text-[#A0A0A0] hover:text-[#FF5555] border border-[#2D2D2D] hover:border-[#FF5555]/40 transition-colors disabled:opacity-60"
          >
            <Square size={12} fill="currentColor" />
            {cancelling ? 'Stopping…' : 'Cancel'}
          </motion.button>
        </div>
      </div>
      <div className="p-3">
        <p className="text-sm font-bold text-[#FFFFFF] truncate">{entry.title || 'Installing modpack…'}</p>
        <p className="text-[10px] text-[#00AF5C] font-bold truncate mt-0.5">
          {cancelling ? 'Cancelling…' : (entry.statusText || 'Starting…')}
        </p>
        <div className="mt-2 h-1 bg-[#2D2D2D] rounded-full overflow-hidden">
          <motion.div
            initial={false}
            animate={{ width: `${pct}%` }}
            transition={{ ease: [0.22, 1, 0.36, 1], duration: 0.4 }}
            className="h-full bg-[#00AF5C]"
          />
        </div>
        <p className="text-[10px] text-[#A0A0A0] tabular-nums mt-1">
          {entry.total > 0 ? `${entry.task.toLocaleString()} / ${entry.total.toLocaleString()} files` : 'Preparing…'}
        </p>
      </div>
    </motion.div>
  );
}

function InstanceCard({
  inst, index, activeAccount, busy, renaming, renameDraft, pendingDelete,
  packUpdate, onUpdatePack,
  launching, launchPhase, launchProgress, launchStatus, playDisabled, onCancelLaunch,
  onPlay, onOpenFolder, onStartRename, onRenameDraft, onSubmitRename, onCancelRename,
  onAskDelete, onConfirmDelete, onCancelDelete,
}) {
  const LoaderIcon = LOADER_ICONS[inst.loader] || Box;
  const loaderLabel = LOADER_LABEL[inst.loader] || inst.loader;
  const isModpack = inst.source === 'browse-modpack';
  const isServerInstance = !!inst.serverInstance;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.02, 0.2), duration: 0.2 }}
      whileHover={{ y: -3 }}
      className="group relative bg-[#1A1A1A] border border-[#2D2D2D] hover:border-[#00AF5C]/40 rounded-2xl overflow-hidden flex flex-col transition-colors"
    >
      {/* Icon area */}
      <div className="aspect-square bg-[#111111] flex items-center justify-center relative overflow-hidden">
        {inst.iconUrl ? (
          <img src={inst.iconUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <LoaderIcon size={56} className="text-[#00AF5C]/70" strokeWidth={1.5} />
        )}

        {/* Source badge in the corner. Server instances get their own badge
            so a user with both kinds doesn't confuse a pack with a
            server-managed profile. */}
        {(isModpack || isServerInstance) && (
          <span className={`absolute top-2 left-2 text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md border ${
            isServerInstance
              ? 'bg-[#1A1A1A]/80 text-[#A0A0A0] border-[#2D2D2D]'
              : 'bg-[#00AF5C]/15 text-[#00AF5C] border-[#00AF5C]/30'
          }`}>
            {isServerInstance ? 'Server' : 'Modpack'}
          </span>
        )}
        {packUpdate && (
          <button
            onClick={(e) => { e.stopPropagation(); onUpdatePack?.(); }}
            disabled={busy}
            title={`Modpack update available: ${packUpdate.availableVersionNumber}`}
            className="absolute top-2 right-2 z-10 flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold px-1.5 py-1 rounded-md border bg-amber-500/20 text-amber-300 border-amber-500/40 hover:bg-amber-500/30 transition-colors disabled:opacity-60"
          >
            {busy ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
            v{packUpdate.availableVersionNumber}
          </button>
        )}

        {/* Launch progress overlay — replaces the play button while this
            instance is launching. Shows the live status + a fill bar and a
            Stop control so the user can cancel an in-flight download. */}
        {launching ? (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-[#000000]/80 backdrop-blur-sm p-3 text-center">
            {launchPhase === 'launched' ? (
              <>
                <Play size={22} className="text-[#00AF5C]" fill="currentColor" />
                <p className="text-xs font-bold text-[#FFFFFF]">Game running</p>
              </>
            ) : (
              <>
                <Loader2 size={22} className="text-[#00AF5C] animate-spin" />
                <p className="text-[11px] font-bold text-[#FFFFFF] line-clamp-2 leading-tight">
                  {launchStatus || 'Preparing…'}
                </p>
                <div className="w-3/4 h-1 bg-[#2D2D2D] rounded-full overflow-hidden">
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
                  className="mt-1 flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold bg-[#1E1E1E] text-[#A0A0A0] hover:text-[#FF5555] border border-[#2D2D2D] hover:border-[#FF5555]/40 transition-colors disabled:opacity-50"
                >
                  <Square size={10} fill="currentColor" />
                  {launchPhase === 'cancelling' ? 'Stopping…' : 'Stop'}
                </button>
              </>
            )}
          </div>
        ) : (
          /* Hover play button — centered, big, brand green. */
          <motion.button
            onClick={onPlay}
            disabled={playDisabled}
            whileHover={playDisabled ? {} : { scale: 1.05 }}
            whileTap={playDisabled ? {} : { scale: 0.95 }}
            title={playDisabled ? 'Another instance is launching…' : 'Play'}
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
        {renaming ? (
          <div className="flex items-center gap-1">
            <input
              type="text"
              autoFocus
              value={renameDraft}
              onChange={e => onRenameDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') onSubmitRename();
                if (e.key === 'Escape') onCancelRename();
              }}
              className="flex-1 min-w-0 bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] rounded-lg px-2 py-1 text-sm text-[#FFFFFF] outline-none focus:ring-2 focus:ring-[#00AF5C]/10 transition-all"
            />
            <button onClick={onSubmitRename} disabled={busy} className="p-1.5 rounded-lg bg-[#00AF5C] text-white disabled:opacity-50">
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            </button>
            <button onClick={onCancelRename} className="p-1.5 rounded-lg bg-[#1E1E1E] text-[#A0A0A0] hover:text-[#FFFFFF]">
              <X size={12} />
            </button>
          </div>
        ) : (
          <p className="text-sm font-bold text-[#FFFFFF] truncate" title={inst.displayName}>
            {inst.displayName}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-[10px] text-[#A0A0A0] font-bold truncate">
            <LoaderIcon size={10} />
            {loaderLabel} {inst.version}
          </span>
          {!renaming && (
            <KebabMenu
              onOpenFolder={onOpenFolder}
              onStartRename={onStartRename}
              onAskDelete={onAskDelete}
            />
          )}
        </div>
      </div>

      {/* Delete confirm overlay — local to the card so we don't fire a modal
          for a "did the user really mean that" prompt. Mirrors BackupsViewer's
          pattern in feel. */}
      <AnimatePresence>
        {pendingDelete && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-[#1A1A1A]/95 backdrop-blur-sm p-3 text-center"
          >
            <Trash2 size={20} className="text-[#FF5555]" />
            <p className="text-sm font-bold text-[#FFFFFF]">Delete this instance?</p>
            <p className="text-[10px] text-[#A0A0A0]">The on-disk profile (mods, worlds) will be removed.</p>
            <div className="flex items-center gap-2 mt-1">
              <button onClick={onCancelDelete} className="px-3 py-1.5 rounded-lg text-xs font-bold text-[#A0A0A0] hover:text-[#FFFFFF] bg-[#1E1E1E]">
                Cancel
              </button>
              <motion.button
                onClick={onConfirmDelete}
                whileTap={{ scale: 0.97 }}
                disabled={busy}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold bg-[#FF5555] hover:bg-[#FF4444] text-white disabled:opacity-50"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                Delete
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// Kebab "more actions" menu. The dropdown is rendered in a portal anchored to
// the trigger's viewport rect rather than inside the card — the card is
// `overflow-hidden` (for its rounded image corners), which would otherwise clip
// the menu, and a stacked grid means an in-card menu can hide behind the next
// row. Fixed positioning sidesteps both.
function KebabMenu({ onOpenFolder, onStartRename, onAskDelete }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  const MENU_W = 160;
  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // Right-align the menu to the button, clamped into the viewport.
    const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
    setCoords({ top: r.bottom + 4, left });
  };

  useLayoutEffect(() => { if (open) place(); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onScrollOrResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onScrollOrResize);
    // Capture-phase scroll so a scroll in any ancestor closes the menu (its
    // anchored position would otherwise drift away from the button).
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        className="p-1 rounded-md text-[#555555] hover:text-[#FFFFFF] hover:bg-[#2D2D2D] transition-colors"
        aria-label="More actions"
      >
        <MoreVertical size={14} />
      </button>
      {open && createPortal(
        <motion.div
          ref={menuRef}
          initial={{ opacity: 0, y: -4, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.12 }}
          style={{ position: 'fixed', top: coords.top, left: coords.left, width: MENU_W }}
          className="z-[100] bg-[#1A1A1A] border border-[#2D2D2D] rounded-xl shadow-xl shadow-black/40 overflow-hidden"
        >
          <MenuRow icon={FolderOpen} label="Open folder" onClick={() => { setOpen(false); onOpenFolder(); }} />
          <MenuRow icon={Pencil}     label="Rename"      onClick={() => { setOpen(false); onStartRename(); }} />
          <MenuRow icon={Trash2}     label="Delete"      onClick={() => { setOpen(false); onAskDelete(); }} danger />
        </motion.div>,
        document.body,
      )}
    </>
  );
}

function MenuRow({ icon: Icon, label, onClick, danger }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-bold transition-colors ${
        danger
          ? 'text-[#FF5555] hover:bg-[#FF5555]/10'
          : 'text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#1E1E1E]'
      }`}
    >
      <Icon size={12} />
      {label}
    </button>
  );
}
