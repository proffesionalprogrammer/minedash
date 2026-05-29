import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Search, Plus, Loader2, Check, Box, Layers, Hammer, FlaskConical, Download, ScrollText,
} from 'lucide-react';

// CurseForge-style modal: "Install <project> — pick a profile to install into"
// Used for Mod / Resource Pack / Shader / Data Pack installs from the Browse
// tab, where the user hasn't picked a loader+version yet but the content
// needs a target instance.
//
// Behavior:
//   - Lists instances compatible with the hit (mods require matching loader
//     + MC version; loader-agnostic types match by MC version only)
//   - "Search for profile" filters the list by display name
//   - "+ New Profile" creates a fresh instance using the hit's first
//     compatible loader/MC pair
//   - "Install" button at the bottom-right is enabled when a profile is
//     selected and fires the actual install
//
// The install endpoint reuses LauncherContent's path — it already accepts
// ?instance=ID for cross-instance targeting and persists metadata through
// `enrichLauncherMeta`, so there's no new backend route.

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

// Content types that don't constrain by loader (any loader, including
// vanilla, can use them). Mods are the one type that DOES require a matching
// loader.
const LOADER_AGNOSTIC = new Set(['resourcepack', 'shader', 'datapack']);

// Modrinth's *search* hits don't carry a `loaders` array — the loader names
// (fabric/forge/neoforge/quilt) live inside `categories` / `display_categories`
// alongside the real category tags. (Only the full project endpoint has a
// dedicated `loaders` field, and Browse rows are search hits.) Read loaders
// from whichever the hit provides, else recover them from its categories.
// Without this every hit looks loader-less, so the "New Profile" suggestion
// collapses to vanilla no matter what loader the mod actually targets.
const KNOWN_LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];
function loadersForHit(hit) {
  if (Array.isArray(hit?.loaders) && hit.loaders.length) return hit.loaders;
  const cats = [
    ...(Array.isArray(hit?.categories) ? hit.categories : []),
    ...(Array.isArray(hit?.display_categories) ? hit.display_categories : []),
  ];
  return KNOWN_LOADERS.filter(l => cats.includes(l));
}

function compatibleInstances(allInstances, hit, type) {
  if (!hit) return [];
  const wantLoaders = new Set(loadersForHit(hit));
  const wantVersions = new Set(Array.isArray(hit.versions) ? hit.versions : []);
  const isLoaderAgnostic = LOADER_AGNOSTIC.has(type);
  return allInstances.filter(inst => {
    // Modpack-source instances are valid install targets too — they're just
    // a configured Forge/Fabric profile with extra mods, and adding a
    // resource pack / shader / extra mod on top is the whole point.
    const loaderOk = isLoaderAgnostic || wantLoaders.size === 0 || wantLoaders.has(inst.loader);
    const verOk    = wantVersions.size === 0 || wantVersions.has(inst.version);
    return loaderOk && verOk;
  });
}

// Numeric Minecraft version comparison ("1.20.1" < "1.21"). Non-numeric parts
// coerce to 0 so it never throws on a snapshot tag.
function compareMcVersion(a, b) {
  const pa = String(a).split('.').map(n => Number(n) || 0);
  const pb = String(b).split('.').map(n => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Pick a sensible loader/MC pair for "New Profile" when the user has no
// compatible instance.
//   - loader: loader-agnostic types → vanilla; mods → a loader the user
//     filtered by (if the hit supports it), else first loader the hit lists.
//   - version: the highest version the user filtered by that the hit supports
//     (they narrowed Browse to it on purpose), else the latest release-shaped
//     version the hit supports.
// Without honoring the filter, a profile created after filtering to 1.20.1
// would be pinned to the mod's latest version (e.g. 1.21.x) and the mod
// wouldn't load.
function suggestedNewProfile(hit, type, preferredVersions = [], preferredLoaders = []) {
  if (!hit) return null;
  const hitLdrs     = loadersForHit(hit);
  const hitVersions = Array.isArray(hit.versions) ? hit.versions : [];

  let loader = 'vanilla';
  if (!LOADER_AGNOSTIC.has(type)) {
    const loaderOrder = ['fabric', 'forge', 'neoforge', 'quilt'];
    loader =
      preferredLoaders.find(l => hitLdrs.includes(l)) ||
      loaderOrder.find(l => hitLdrs.includes(l)) ||
      hitLdrs[0] ||
      'vanilla';
  }

  let version = null;
  const supportedPreferred = (preferredVersions || [])
    .filter(v => hitVersions.includes(v))
    .sort(compareMcVersion);
  if (supportedPreferred.length > 0) {
    version = supportedPreferred[supportedPreferred.length - 1];
  } else {
    for (let i = hitVersions.length - 1; i >= 0; i--) {
      if (/^1\.\d+(\.\d+)?$/.test(hitVersions[i])) { version = hitVersions[i]; break; }
    }
    if (!version) version = hitVersions[hitVersions.length - 1] || null;
  }
  return version ? { loader, version } : null;
}

export default function ProfilePickerModal({
  hit, type, onClose, onError,
  // Optional: install this exact version object instead of running the
  // "pick best" sort. Set by ProjectDetailModal when a user clicked Install
  // on a specific row in the Versions tab.
  forcedVersion,
  // Optional: instance to start pre-selected (used when the caller already
  // knows which profile the user came from, e.g. LauncherContent surface).
  defaultInstanceId,
  // Optional: the MC versions / loaders the user filtered Browse by. A new
  // profile created from here prefers these so it matches what the user was
  // looking at, instead of defaulting to the mod's latest version.
  filterVersions = [],
  filterLoaders = [],
}) {
  const [instances, setInstances] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [query, setQuery]         = useState('');
  const [selectedId, setSelectedId] = useState(defaultInstanceId || null);
  const [installing, setInstalling] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [busyCreating, setBusyCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('http://localhost:3001/api/launcher/instances');
        const d = await r.json();
        if (cancelled) return;
        setInstances(Array.isArray(d) ? d : []);
      } catch (err) {
        if (!cancelled) onError?.(err.message);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [onError]);

  const compatible = useMemo(() => compatibleInstances(instances, hit, type), [instances, hit, type]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return compatible;
    return compatible.filter(i => (i.displayName || '').toLowerCase().includes(q));
  }, [compatible, query]);
  // filterVersions/filterLoaders arrive as fresh arrays each render; key on
  // their contents so the memo only recomputes when the selection changes.
  const filterVersionsKey = filterVersions.join(',');
  const filterLoadersKey = filterLoaders.join(',');
  const suggestion = useMemo(
    () => suggestedNewProfile(hit, type, filterVersions, filterLoaders),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hit, type, filterVersionsKey, filterLoadersKey],
  );

  const handleCreateNew = async () => {
    if (!suggestion) return;
    const name = newName.trim() || `${hit.title || 'New'} profile`;
    setBusyCreating(true);
    try {
      const r = await fetch('http://localhost:3001/api/launcher/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          loader:      suggestion.loader,
          version:     suggestion.version,
          displayName: name,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to create profile');
      setInstances(prev => [...prev, d]);
      setSelectedId(d.id);
      setCreatingNew(false);
      setNewName('');
    } catch (err) {
      onError?.(err.message);
    }
    setBusyCreating(false);
  };

  const handleInstall = async () => {
    const inst = instances.find(i => i.id === selectedId);
    if (!inst || !hit) return;
    setInstalling(true);
    try {
      // Same flow LauncherContent uses — fetch versions for this instance's
      // loader+MC, pick best, POST to /install with ?instance=ID. If the
      // caller forced a specific version (Versions tab → Install this one),
      // skip the fetch + sort and use it directly.
      let best;
      if (forcedVersion) {
        best = forcedVersion;
      } else {
        const params = new URLSearchParams();
        params.set('gameVersion', inst.version);
        if (!LOADER_AGNOSTIC.has(type) && ['fabric', 'forge', 'neoforge'].includes(inst.loader)) {
          params.set('loader', inst.loader);
        }
        const vr = await fetch(`http://localhost:3001/api/modrinth/project/${hit.project_id}/versions?${params}`);
        const vs = await vr.json();
        if (!vr.ok || !Array.isArray(vs) || vs.length === 0) throw new Error('No compatible version found for this profile');
        vs.sort((a, b) => {
          const rank = { release: 0, beta: 1, alpha: 2 };
          return (rank[a.version_type] ?? 3) - (rank[b.version_type] ?? 3);
        });
        best = vs[0];
      }
      const file = (best.files || []).find(f => f.primary) || (best.files || [])[0];
      if (!file) throw new Error('No downloadable file');

      const endpoint = `http://localhost:3001/api/launcher/profiles/${inst.loader}/${encodeURIComponent(inst.version)}/install?instance=${encodeURIComponent(inst.id)}`;
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url:          file.url,
          filename:     file.filename,
          projectType:  type,
          projectId:    hit.project_id,
          iconUrl:      hit.icon_url || null,
          title:        hit.title || null,
          gameVersions: best.game_versions || [],
          loaders:      best.loaders       || [],
          dependencies: best.dependencies  || [],
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Install failed');
      onClose?.({ installedInto: inst });
    } catch (err) {
      onError?.(err.message);
    }
    setInstalling(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-[#000000]/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={() => !installing && onClose?.(null)}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 12 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.95, opacity: 0 }}
        transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
        onClick={e => e.stopPropagation()}
        className="bg-[#1A1A1A] border border-[#2D2D2D] rounded-3xl w-full max-w-md flex flex-col max-h-[80vh] overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-6 py-5 border-b border-[#2D2D2D]">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider font-bold text-[#555555]">Install</p>
            <h2 className="text-lg font-bold text-[#FFFFFF] truncate">{hit?.title || 'Project'}</h2>
          </div>
          <button
            onClick={() => !installing && onClose?.(null)}
            disabled={installing}
            className="p-2 rounded-xl text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#1E1E1E] transition-colors disabled:opacity-40"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="px-6 pt-4 pb-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555555]" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search for profile"
              className="w-full bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] rounded-xl pl-9 pr-3 py-2 text-sm text-[#FFFFFF] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[#555555]"
            />
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-6 py-3">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={18} className="text-[#00AF5C] animate-spin mr-2" />
              <span className="text-sm text-[#A0A0A0]">Loading profiles…</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center text-center py-10">
              <div className="p-3 bg-[#1E1E1E] rounded-2xl mb-3">
                <ScrollText size={28} className="text-[#A0A0A0]" />
              </div>
              <p className="text-sm font-bold text-[#FFFFFF]">
                {compatible.length === 0
                  ? 'No compatible profiles'
                  : 'No profiles match'}
              </p>
              <p className="text-xs text-[#A0A0A0] mt-1 max-w-xs">
                {compatible.length === 0
                  ? `Create a new profile to install this ${labelFor(type).toLowerCase()}.`
                  : 'Try a different search.'}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {filtered.map(inst => {
                const Icon = LOADER_ICONS[inst.loader] || Box;
                const on = selectedId === inst.id;
                return (
                  <button
                    key={inst.id}
                    onClick={() => setSelectedId(inst.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl transition-colors text-left ${
                      on
                        ? 'bg-[#00AF5C]/10 border border-[#00AF5C]/30'
                        : 'border border-transparent hover:bg-[#1E1E1E]'
                    }`}
                  >
                    <div className="w-9 h-9 rounded-lg bg-[#111111] border border-[#2D2D2D] flex-shrink-0 flex items-center justify-center overflow-hidden">
                      {inst.iconUrl
                        ? <img src={inst.iconUrl} alt="" className="w-full h-full object-cover" />
                        : <Icon size={16} className="text-[#00AF5C]" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-[#FFFFFF] truncate">{inst.displayName}</p>
                      <p className="text-[10px] text-[#A0A0A0] truncate">{LOADER_LABEL[inst.loader] || inst.loader} {inst.version}</p>
                    </div>
                    {on && <Check size={14} className="text-[#00AF5C] flex-shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* New Profile inline panel */}
        <AnimatePresence>
          {creatingNew && (
            <motion.div
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden border-t border-[#2D2D2D]"
            >
              <div className="px-6 py-3 bg-[#111111]">
                <p className="text-[10px] uppercase tracking-wider font-bold text-[#555555] mb-2">
                  New profile {suggestion ? `· ${LOADER_LABEL[suggestion.loader] || suggestion.loader} ${suggestion.version}` : ''}
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    autoFocus
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleCreateNew();
                      if (e.key === 'Escape') { setCreatingNew(false); setNewName(''); }
                    }}
                    placeholder={`${hit?.title || 'New'} profile`}
                    className="flex-1 bg-[#1A1A1A] border border-[#2D2D2D] focus:border-[#00AF5C] rounded-xl px-3 py-1.5 text-sm text-[#FFFFFF] outline-none focus:ring-2 focus:ring-[#00AF5C]/10 transition-all placeholder-[#555555]"
                  />
                  <button
                    onClick={handleCreateNew}
                    disabled={busyCreating || !suggestion}
                    className="flex items-center gap-1 px-3 py-1.5 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-xs font-bold disabled:opacity-50"
                  >
                    {busyCreating ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                    Create
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Footer actions */}
        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-[#2D2D2D]">
          <button
            onClick={() => { setCreatingNew(c => !c); setNewName(''); }}
            disabled={!suggestion || installing}
            title={suggestion ? `New ${LOADER_LABEL[suggestion.loader] || suggestion.loader} ${suggestion.version} profile` : 'No compatible loader/version available'}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#1E1E1E] rounded-xl transition-colors disabled:opacity-40"
          >
            <Plus size={14} />
            New Profile
          </button>
          <motion.button
            onClick={handleInstall}
            disabled={!selectedId || installing}
            whileTap={selectedId && !installing ? { scale: 0.97 } : {}}
            className="flex items-center gap-1.5 px-4 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {installing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {installing ? 'Installing…' : 'Install'}
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function labelFor(type) {
  switch (type) {
    case 'mod':          return 'Mod';
    case 'resourcepack': return 'Resource Pack';
    case 'shader':       return 'Shader';
    case 'datapack':     return 'Data Pack';
    default:             return 'Content';
  }
}
