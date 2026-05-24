import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Search, Download, Heart, Loader2, Check, AlertCircle, Box, Image as ImageIcon, Sparkles, Trash2, Package, Layers, Database, RefreshCw, FolderOpen, Globe, CheckSquare, Square, X, AlertTriangle, Wrench, Upload, ChevronLeft, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Select from './Select';

const TYPES = [
  { key: 'mod',          label: 'Mods',           icon: Box        },
  { key: 'resourcepack', label: 'Resource Packs', icon: ImageIcon  },
  { key: 'shader',       label: 'Shaders',        icon: Sparkles   },
  { key: 'modpack',      label: 'Modpacks',       icon: Layers     },
  { key: 'datapack',     label: 'Data Packs',     icon: Database   },
];

function fmt(n) {
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
  return String(n);
}

// Browse and install client-side content (mods / resource packs / shaders)
// into a launcher profile. Trimmed-down counterpart of ModrinthBrowser that
// targets a `${loader}-${version}` profile directory instead of a server.
export default function LauncherContent({ loader, version, instanceId, socket, onError, inModal, modpackInstalls }) {
  // Suffix appended to every profile-scoped API call so it targets the right
  // instance. Empty string when the caller didn't pick one — the backend then
  // resolves to the default instance for this loader+version.
  const instanceQuery = instanceId ? `?instance=${encodeURIComponent(instanceId)}` : '';
  // Initial type derived from loader — vanilla profiles can't browse mods, so
  // start them on resource packs. Picking the right value at mount time avoids
  // a race where the first (mod) search resolves after the snap-to-valid one
  // and leaves stale mod results in the resource-pack tab.
  const [type, setType] = useState(() => loader === 'vanilla' ? 'resourcepack' : 'mod');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState({});
  const [installedFiles, setInstalledFiles] = useState({ mod: [], resourcepack: [], shader: [], modpack: [], datapack: [] });
  const [versionPickerOpen, setVersionPickerOpen] = useState({});
  const [projectVersionsList, setProjectVersionsList] = useState({});
  const [loadingVersionPicker, setLoadingVersionPicker] = useState({});
  const [installedFilter, setInstalledFilter] = useState('');
  const [view, setView] = useState('browse'); // 'browse' | 'installed'
  // Sort + pagination — mirrors the server-side ModrinthBrowser so users get
  // the same controls in both places.
  const [sortIndex, setSortIndex] = useState('relevance');
  const [page, setPage] = useState(0);
  const [totalHits, setTotalHits] = useState(0);
  const LIMIT = 20;
  // Per-project modpack install progress lives in the App-level
  // useModpackInstalls hook so it survives this component unmounting (the
  // modal closing, the user switching to a different launcher tab, etc.).
  const installsMap = modpackInstalls?.installs || {};
  // Stable scope key — uses the instance ID when provided, else the
  // loader+version pair (which uniquely identifies the default instance).
  const scopeKey = instanceId || `${loader}-${version}`;
  const installKey = (pid) => `instance:${scopeKey}:${pid}`;
  // Manual-upload UI state — local error/notice so this control doesn't have
  // to compete with onError toasts for things like "wrong extension".
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);
  const searchTimeout = useRef(null);

  // Vanilla profiles can't load mods, modpacks, or shaders — hide those tabs entirely.
  // Resource packs and data packs remain accessible.
  const visibleTypes = useMemo(
    () => TYPES.filter(t => loader !== 'vanilla' || !['mod', 'modpack', 'shader'].includes(t.key)),
    [loader],
  );

  // If the currently-selected type isn't visible for this loader, snap to the first visible one.
  useEffect(() => {
    if (!visibleTypes.some(t => t.key === type)) {
      setType(visibleTypes[0]?.key || 'resourcepack');
    }
  }, [visibleTypes, type]);

  const supportsLoader = true; // hidden tabs replace the previous "unsupported loader" gate
  const showDatapackHint = type === 'datapack';

  const fetchInstalled = async () => {
    if (!loader || !version) return;
    try {
      const r = await fetch(`http://localhost:3001/api/launcher/profiles/${loader}/${encodeURIComponent(version)}/content${instanceQuery}`);
      const d = await r.json();
      if (r.ok) setInstalledFiles(d);
    } catch {}
  };
  useEffect(() => { fetchInstalled(); }, [loader, version, instanceId]);

  // Watch for modpack installs in our scope that just hit terminal state and
  // refetch the installed list so the UI flips Install → Installed without
  // requiring the user to re-open the tab. Dedup with a ref so we don't
  // refetch twice for the same session.
  const reactedSessions = useRef(new Set());
  useEffect(() => {
    for (const key of Object.keys(installsMap)) {
      if (!key.startsWith(`instance:${scopeKey}:`)) continue;
      const entry = installsMap[key];
      if (!entry?.sessionId) continue;
      if (entry.status !== 'done' && entry.status !== 'error') continue;
      if (reactedSessions.current.has(entry.sessionId)) continue;
      reactedSessions.current.add(entry.sessionId);
      if (entry.status === 'done') fetchInstalled();
      else if (entry.errorMessage) onError?.(entry.errorMessage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installsMap, scopeKey]);

  const search = async (q, p = 0, sort = sortIndex, attempt = 0) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        query: q,
        limit: String(LIMIT),
        offset: String(p * LIMIT),
      });
      params.set('projectType', type);
      params.set('gameVersion', version);
      params.set('sort', sort);
      // Loader filter only applies to mods and modpacks. Resource packs, shaders, and datapacks are loader-agnostic.
      if ((type === 'mod' || type === 'modpack') && ['fabric', 'forge', 'neoforge'].includes(loader)) {
        params.set('loader', loader);
      }
      const r = await fetch(`http://localhost:3001/api/modrinth/search?${params}`);
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Backend returned non-JSON — is the dev backend up to date?');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Search failed');
      setResults(d.hits || []);
      setTotalHits(d.total_hits || 0);
    } catch (err) {
      // The proxy occasionally fails during the initial /content enrichment
      // burst on a big modpack (Modrinth's rate limit pushes back). Silently
      // retry once after a short delay before showing the user an error —
      // the second attempt almost always succeeds, and avoids the "you have
      // to type something to retrigger search" UX the previous build had.
      if (attempt === 0) {
        setTimeout(() => search(q, p, sort, 1), 1500);
        return; // leave loading=true; the retry will flip it
      }
      onError?.(err.message); setResults([]); setTotalHits(0);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!version) return;
    setResults([]);
    setPage(0);
    search(query, 0, sortIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, loader, version, sortIndex]);

  const handleQuery = (val) => {
    setQuery(val);
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => { setPage(0); search(val, 0, sortIndex); }, 400);
  };

  const handlePageChange = (p) => { setPage(p); search(query, p, sortIndex); };
  const totalPages = Math.ceil(totalHits / LIMIT);

  // Manual upload — for mods/packs you can't get from Modrinth (CurseForge-only
  // mods like FTB Quests, or anything you downloaded by hand). Only valid for
  // the four real content types — there's no "upload a modpack" path, since a
  // .mrpack would need the full extractor flow.
  const canUpload = ['mod', 'resourcepack', 'shader', 'datapack'].includes(type);
  const handleUploadClick = () => fileInputRef.current?.click();

  // Shared upload path — used by the file-picker button AND the drag/drop
  // target. Accepts a FileList or array; uploads them all in one request so
  // the user sees a single progress state and the backend writes them as a
  // batch (partial-success reporting per file).
  const uploadFiles = async (fileList) => {
    const list = Array.from(fileList || []).filter(Boolean);
    if (list.length === 0) return;
    if (!version) {
      onError?.('Pick a version first');
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      for (const f of list) fd.append('file', f);
      const params = new URLSearchParams();
      if (instanceId) params.set('instance', instanceId);
      params.set('type', type);
      const r = await fetch(`http://localhost:3001/api/launcher/profiles/${loader}/${encodeURIComponent(version)}/upload?${params}`, {
        method: 'POST',
        body: fd,
      });
      const d = await r.json();
      // 207 (multi-status) is still "ok" — some files landed, some didn't.
      if (!r.ok && r.status !== 207) throw new Error(d.error || 'Upload failed');
      if (Array.isArray(d.failed) && d.failed.length > 0) {
        // Surface only the first failure so the toast doesn't get huge; the
        // user can drag-drop again with just the offenders if they want.
        const f = d.failed[0];
        onError?.(`${f.filename}: ${f.reason}${d.failed.length > 1 ? ` (+${d.failed.length - 1} more)` : ''}`);
      }
      await fetchInstalled();
      setView('installed');
    } catch (err) {
      onError?.(err.message);
    }
    setUploading(false);
  };

  const handleFileChange = async (e) => {
    const files = e.target.files;
    e.target.value = '';
    await uploadFiles(files);
  };

  // ── Drag-and-drop target ─────────────────────────────────────────────────
  // Use a counter rather than a boolean for the drag overlay — onDragLeave
  // fires when the cursor crosses child elements (e.g. a search input inside
  // the panel), so naively toggling a boolean makes the overlay flicker.
  const [dragDepth, setDragDepth] = useState(0);
  const dragActive = dragDepth > 0;
  const handleDragEnter = (e) => {
    if (!canUpload || !version) return;
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    setDragDepth(d => d + 1);
  };
  const handleDragOver = (e) => {
    if (!canUpload || !version) return;
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const handleDragLeave = (e) => {
    if (!canUpload || !version) return;
    e.preventDefault();
    setDragDepth(d => Math.max(0, d - 1));
  };
  const handleDrop = async (e) => {
    if (!canUpload || !version) return;
    e.preventDefault();
    setDragDepth(0);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) await uploadFiles(files);
  };

  const installedSet = useMemo(() => {
    const list = installedFiles[type] || [];
    const byProjectId = new Set();
    for (const f of list) if (f.projectId) byProjectId.add(f.projectId);
    return byProjectId;
  }, [installedFiles, type]);

  const handleInstall = async (project) => {
    setInstalling(p => ({ ...p, [project.project_id]: true }));
    try {
      const params = new URLSearchParams();
      params.set('gameVersion', version);
      if ((type === 'mod' || type === 'modpack') && ['fabric', 'forge', 'neoforge'].includes(loader)) {
        params.set('loader', loader);
      }
      const vr = await fetch(`http://localhost:3001/api/modrinth/project/${project.project_id}/versions?${params}`);
      const vct = vr.headers.get('content-type') || '';
      if (!vct.includes('application/json')) throw new Error('Backend returned non-JSON — is the dev backend up to date?');
      const vs = await vr.json();
      if (!vr.ok || !Array.isArray(vs) || vs.length === 0) throw new Error('No compatible version found');
      vs.sort((a, b) => {
        const p = { release: 0, beta: 1, alpha: 2 };
        return (p[a.version_type] ?? 3) - (p[b.version_type] ?? 3);
      });
      const best = vs[0];
      const file = best.files.find(f => f.primary) || best.files[0];
      if (!file) throw new Error('No downloadable file');

      const endpoint = type === 'modpack'
        ? `http://localhost:3001/api/launcher/profiles/${loader}/${encodeURIComponent(version)}/install-modpack${instanceQuery}`
        : `http://localhost:3001/api/launcher/profiles/${loader}/${encodeURIComponent(version)}/install${instanceQuery}`;

      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: file.url,
          filename: file.filename,
          projectType: type,
          projectId: project.project_id,
          iconUrl: project.icon_url || null,
          title: project.title || null,
          // Bundle the version's compatibility fields so the backend can
          // populate wrong-version/wrong-loader metadata immediately,
          // skipping the SHA1 + Modrinth roundtrip on the next listing.
          gameVersions: best.game_versions || [],
          loaders:      best.loaders       || [],
        }),
      });
      const ict = r.headers.get('content-type') || '';
      if (!ict.includes('application/json')) {
        throw new Error('Backend returned non-JSON. If you upgraded, fully close MineDash and reopen it.');
      }
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Install failed');

      // Modpack installs return a sessionId and run async — register the
      // tracker so the button can show a filling progress bar AND the bar
      // survives the modal closing or the user navigating away mid-install.
      // Completion-side effects (refetchInstalled, onError) are handled by
      // the dedicated useEffect that watches installsMap above.
      if (type === 'modpack' && d.sessionId && modpackInstalls?.trackInstall) {
        modpackInstalls.trackInstall(d.sessionId, installKey(project.project_id), {
          projectId: project.project_id,
          title: project.title,
        });
      } else {
        fetchInstalled();
      }
    } catch (err) {
      onError?.(err.message);
    }
    setInstalling(p => ({ ...p, [project.project_id]: false }));
  };

  const handleDelete = async (filename) => {
    try {
      const r = await fetch(`http://localhost:3001/api/launcher/profiles/${loader}/${encodeURIComponent(version)}/content/${type}/${encodeURIComponent(filename)}${instanceQuery}`, {
        method: 'DELETE',
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Delete failed');
      fetchInstalled();
    } catch (err) {
      onError?.(err.message);
    }
  };

  const handleChangeVersionOpen = async (project) => {
    const pid = project.project_id;
    if (versionPickerOpen[pid]) {
      setVersionPickerOpen(p => ({ ...p, [pid]: false }));
      return;
    }
    if (!projectVersionsList[pid]) {
      setLoadingVersionPicker(p => ({ ...p, [pid]: true }));
      try {
        const params = new URLSearchParams();
        params.set('gameVersion', version);
        if ((type === 'mod' || type === 'modpack') && ['fabric', 'forge', 'neoforge'].includes(loader)) {
          params.set('loader', loader);
        }
        const vr = await fetch(`http://localhost:3001/api/modrinth/project/${pid}/versions?${params}`);
        const vs = await vr.json();
        if (vr.ok && Array.isArray(vs)) setProjectVersionsList(p => ({ ...p, [pid]: vs }));
      } catch {}
      setLoadingVersionPicker(p => ({ ...p, [pid]: false }));
    }
    setVersionPickerOpen(p => ({ ...p, [pid]: true }));
  };

  const handleChangeVersion = async (project, modVersion) => {
    setVersionPickerOpen(p => ({ ...p, [project.project_id]: false }));
    setInstalling(p => ({ ...p, [project.project_id]: true }));
    try {
      const currentFile = (installedFiles[type] || []).find(f => f.projectId === project.project_id);
      if (currentFile) {
        await fetch(`http://localhost:3001/api/launcher/profiles/${loader}/${encodeURIComponent(version)}/content/${type}/${encodeURIComponent(currentFile.filename)}${instanceQuery}`, { method: 'DELETE' });
      }
      const file = modVersion.files.find(f => f.primary) || modVersion.files[0];
      if (!file) throw new Error('No downloadable file');
      const endpoint = type === 'modpack'
        ? `http://localhost:3001/api/launcher/profiles/${loader}/${encodeURIComponent(version)}/install-modpack${instanceQuery}`
        : `http://localhost:3001/api/launcher/profiles/${loader}/${encodeURIComponent(version)}/install${instanceQuery}`;
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: file.url,
          filename: file.filename,
          projectType: type,
          projectId: project.project_id,
          iconUrl: project.icon_url || null,
          title: project.title || null,
          gameVersions: modVersion.game_versions || [],
          loaders:      modVersion.loaders       || [],
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Install failed');
      fetchInstalled();
    } catch (err) {
      onError?.(err.message);
    }
    setInstalling(p => ({ ...p, [project.project_id]: false }));
  };

  // Repair-versions state for the mod tab. The banner only renders for mods —
  // resource packs / shaders / datapacks don't have a loader-or-version gate.
  const [repairing, setRepairing] = useState(false);
  const [repairResult, setRepairResult] = useState(null);

  const handleRepairVersions = async () => {
    if (repairing) return;
    setRepairing(true);
    setRepairResult(null);
    try {
      const r = await fetch(`http://localhost:3001/api/launcher/profiles/${loader}/${encodeURIComponent(version)}/content/repair-versions${instanceQuery}`, {
        method: 'POST',
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Repair failed');
      setRepairResult(d);
      fetchInstalled();
    } catch (err) {
      onError?.(err.message);
    }
    setRepairing(false);
  };

  const installedList = installedFiles[type] || [];
  const wrongVersionCount = type === 'mod'
    ? installedList.filter(f => f.wrongVersion || f.wrongLoader).length
    : 0;

  // When rendered inside the modal we drop the outer card chrome — the modal
  // already provides framing, padding, and header.
  const Wrapper = inModal ? 'div' : 'div';
  const wrapperClass = inModal ? '' : 'bg-[#1A1A1A] border border-[#2D2D2D] rounded-3xl p-6';

  return (
    <Wrapper
      className={`relative ${wrapperClass}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay — covers the panel while files are over it so the
          drop zone is unambiguous. Pointer-events-none on the inner content
          keeps the drop event firing on the wrapper itself. */}
      <AnimatePresence>
        {dragActive && canUpload && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-[#00AF5C]/10 backdrop-blur-sm border-2 border-dashed border-[#00AF5C] rounded-3xl pointer-events-none"
          >
            <Upload size={36} className="text-[#00AF5C] mb-2" />
            <p className="text-sm font-bold text-white">Drop to upload</p>
            <p className="text-xs text-[#A0A0A0] mt-1">
              {type === 'mod' ? '.jar files' : '.zip files'} into this {TYPES.find(t => t.key === type)?.label.toLowerCase() || 'folder'} profile
            </p>
          </motion.div>
        )}
      </AnimatePresence>
      {!inModal && (
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-[#00AF5C]/10 rounded-xl"><Download size={18} className="text-[#00AF5C]" /></div>
          <div>
            <h2 className="text-lg font-bold text-[#FFFFFF]">Content</h2>
            <p className="text-xs text-[#A0A0A0]">Browse Modrinth and install into this profile.</p>
          </div>
        </div>
      )}

      {/* Type tabs */}
      <div className="flex flex-wrap items-center gap-1.5 mb-4">
        {visibleTypes.map(({ key, label, icon: Icon }) => {
          const active = type === key;
          return (
            <motion.button key={key}
              onClick={() => setType(key)}
              whileTap={{ scale: 0.97 }}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold transition-colors duration-150 ${
                active
                  ? 'bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/20'
                  : 'text-[#A0A0A0] hover:text-[#FFFFFF] border border-transparent hover:bg-[#1E1E1E]'
              }`}>
              <Icon size={14} />
              {label}
            </motion.button>
          );
        })}
      </div>

      {/* Sub-tabs: Browse Modrinth vs. show what's already installed in the profile.
          Mirrors the server-side ModsViewer pattern so users have a consistent mental
          model for "what's on disk" vs. "what's online". */}
      <div className="flex items-center gap-1.5 mb-3 border-b border-[#2D2D2D] pb-3">
        <motion.button
          onClick={() => setView('browse')}
          whileTap={{ scale: 0.97 }}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors duration-150 ${
            view === 'browse'
              ? 'bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/20'
              : 'text-[#A0A0A0] hover:text-[#FFFFFF] border border-transparent hover:bg-[#1E1E1E]'
          }`}>
          <Globe size={14} /> Browse
        </motion.button>
        <motion.button
          onClick={() => setView('installed')}
          whileTap={{ scale: 0.97 }}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors duration-150 ${
            view === 'installed'
              ? 'bg-[#1E1E1E] text-[#FFFFFF] border border-[#2D2D2D]'
              : 'text-[#A0A0A0] hover:text-[#FFFFFF] border border-transparent hover:bg-[#1E1E1E]'
          }`}>
          <FolderOpen size={14} /> Installed
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${view === 'installed' ? 'bg-[#00AF5C]/10 text-[#00AF5C]' : 'bg-[#2D2D2D] text-[#555555]'}`}>
            {installedList.length}
          </span>
        </motion.button>
      </div>

      {showDatapackHint && view === 'browse' && (
        <div className="flex items-start gap-2 px-3 py-2 mb-3 bg-[#00AF5C]/10 border border-[#00AF5C]/20 rounded-xl text-xs text-[#A0A0A0]">
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5 text-[#00AF5C]" />
          <span>Data packs are installed into the profile's <span className="font-mono text-[#FFFFFF]">datapacks/</span> folder. Drop them into a world's <span className="font-mono text-[#FFFFFF]">datapacks/</span> directory in-game to activate.</span>
        </div>
      )}

      {/* Hidden file input for the manual-upload button; rendered once so it persists
          across the browse/installed view swap below. `multiple` lets the user pick
          several jars/zips at once — drag-and-drop on the panel is the other path. */}
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        multiple
        accept={type === 'mod' ? '.jar' : '.zip'}
        onChange={handleFileChange}
      />

      {view === 'installed' ? (
        <>
          {wrongVersionCount > 0 && (
            <motion.div
              initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
              className="mb-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl flex items-center gap-3"
            >
              <div className="p-2 bg-amber-500/15 rounded-xl flex-shrink-0">
                <AlertTriangle size={18} className="text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-white">
                  {wrongVersionCount} mod{wrongVersionCount !== 1 ? 's are' : ' is'} on the wrong version or loader
                </p>
                <p className="text-xs text-[#A0A0A0] mt-0.5">
                  These will crash Minecraft. Replace with a compatible Modrinth build.
                </p>
              </div>
              <motion.button
                whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                onClick={handleRepairVersions}
                disabled={repairing}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[#00AF5C]/15 hover:bg-[#00AF5C]/25 text-[#00AF5C] border border-[#00AF5C]/30 rounded-xl text-xs font-bold transition-all disabled:opacity-50 flex-shrink-0"
              >
                {repairing ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />}
                {repairing ? 'Repairing…' : 'Repair versions'}
              </motion.button>
            </motion.div>
          )}
          {repairResult && (
            <div className="mb-3 px-3 py-2 text-xs text-[#A0A0A0] bg-[#1E1E1E] border border-[#2D2D2D] rounded-xl">
              {repairResult.repaired?.length > 0 && (
                <p className="text-[#00AF5C] font-bold">Replaced {repairResult.repaired.length} mod(s) with compatible versions.</p>
              )}
              {repairResult.failed?.length > 0 && (
                <p className="mt-1 text-[#FF5555]">
                  {repairResult.failed.length} couldn't be repaired:{' '}
                  {repairResult.failed.slice(0, 3).map(f => f.filename).join(', ')}
                  {repairResult.failed.length > 3 && ` (+${repairResult.failed.length - 3})`}
                </p>
              )}
              {repairResult.repaired?.length === 0 && repairResult.failed?.length === 0 && (
                <p>No incompatible mods to repair.</p>
              )}
            </div>
          )}
          <InstalledTabView
            items={installedList}
            typeLabel={TYPES.find(t => t.key === type)?.label.toLowerCase() || 'items'}
            filter={installedFilter}
            onFilterChange={setInstalledFilter}
            onDelete={handleDelete}
            contentType={type}
          />
        </>
      ) : (
      <>
      {/* Search + sort + manual upload. Sort and Upload mirror the controls on
          the server-side Mods tab so the launcher and server feel consistent. */}
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-0">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555555]" />
          <input
            type="text"
            value={query}
            onChange={e => handleQuery(e.target.value)}
            placeholder={`Search ${TYPES.find(t => t.key === type).label.toLowerCase()}…`}
            disabled={!supportsLoader}
            className="w-full bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] rounded-xl pl-10 pr-3 py-2.5 text-sm text-[#FFFFFF] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[#555555] font-medium disabled:opacity-40"
          />
        </div>
        <Select
          value={sortIndex}
          onChange={setSortIndex}
          options={[
            { value: 'relevance', label: 'Relevance' },
            { value: 'downloads', label: 'Downloads' },
            { value: 'newest',    label: 'Newest'    },
            { value: 'updated',   label: 'Updated'   },
          ]}
          className="flex-shrink-0"
        />
        {canUpload && (
          <motion.button
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            onClick={handleUploadClick}
            disabled={uploading || !version}
            title={`Upload a ${type === 'mod' ? '.jar mod' : '.zip ' + (TYPES.find(t => t.key === type)?.label || 'pack')} you downloaded yourself`}
            className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 bg-[#1E1E1E] hover:bg-[#2D2D2D] border border-[#2D2D2D] hover:border-[#00AF5C]/40 rounded-xl text-xs font-bold text-[#A0A0A0] hover:text-[#FFFFFF] transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {uploading ? 'Uploading…' : 'Upload'}
          </motion.button>
        )}
      </div>

      {/* Results */}
      <div className="max-h-[420px] overflow-y-auto custom-scrollbar -mr-2 pr-2">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={20} className="text-[#00AF5C] animate-spin mr-2" />
            <span className="text-sm text-[#A0A0A0]">Searching…</span>
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center py-12 text-[#555555]">
            <Search size={32} className="mb-3 opacity-30" />
            <p className="text-sm">No results</p>
          </div>
        ) : (
          <div className="space-y-2">
            {results.map((p, idx) => {
              const isInstalled = installedSet.has(p.project_id);
              const isInstalling = !!installing[p.project_id];
              return (
                <motion.div key={p.project_id}
                  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(idx * 0.02, 0.2), duration: 0.2 }}
                  className="bg-[#1E1E1E] border border-[#2D2D2D] rounded-2xl hover:border-[#555555] transition-colors overflow-hidden">
                  <div className="flex items-center gap-3 p-3">
                    <div className="w-10 h-10 rounded-xl overflow-hidden bg-[#111111] border border-[#2D2D2D] flex-shrink-0 flex items-center justify-center">
                      {p.icon_url
                        ? <img src={p.icon_url} alt="" className="w-full h-full object-cover" />
                        : <span className="text-[#00AF5C] font-black">{p.title?.[0] || '?'}</span>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h4 className="font-bold text-sm text-[#FFFFFF] truncate">{p.title}</h4>
                        <span className="text-[10px] text-[#555555] flex-shrink-0">by {p.author}</span>
                      </div>
                      <p className="text-xs text-[#A0A0A0] line-clamp-1">{p.description}</p>
                      <div className="flex items-center gap-3 text-[10px] text-[#555555] mt-1">
                        <span className="flex items-center gap-1"><Download size={10} />{fmt(p.downloads)}</span>
                        <span className="flex items-center gap-1"><Heart size={10} />{fmt(p.follows)}</span>
                      </div>
                    </div>
                    <div className="flex-shrink-0">
                      {isInstalled ? (
                        <div className="flex flex-col items-end gap-1">
                          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/20 rounded-xl text-xs font-bold">
                            <Check size={14} /> Installed
                          </div>
                          <button
                            onClick={() => handleChangeVersionOpen(p)}
                            className="flex items-center gap-1 text-[10px] font-bold text-[#555555] hover:text-[#00AF5C] transition-colors pr-1">
                            {loadingVersionPicker[p.project_id]
                              ? <Loader2 size={10} className="animate-spin" />
                              : <RefreshCw size={10} className={versionPickerOpen[p.project_id] ? 'text-[#00AF5C]' : ''} />}
                            Change version
                          </button>
                        </div>
                      ) : (
                        (() => {
                          const mp = type === 'modpack' ? installsMap[installKey(p.project_id)] : null;
                          const isModpackInstalling = type === 'modpack' && mp && mp.status !== 'error';
                          if (isModpackInstalling) {
                            const pct = mp.status === 'done' ? 100
                              : (mp.total > 0 ? Math.min(99, Math.round((mp.task / mp.total) * 100)) : 0);
                            return (
                              <div
                                title={`${mp.statusText || 'Installing…'}${mp.total ? ` (${mp.task} / ${mp.total} files)` : ''}`}
                                className="relative overflow-hidden flex items-center gap-1.5 px-3 py-1.5 border border-[#00AF5C]/40 rounded-xl text-xs font-bold text-white min-w-[120px] justify-center"
                                style={{ background: '#1E1E1E' }}
                              >
                                <motion.div
                                  initial={false}
                                  animate={{ width: `${pct}%` }}
                                  transition={{ ease: [0.22, 1, 0.36, 1], duration: 0.4 }}
                                  className="absolute inset-y-0 left-0 z-0"
                                  style={{ background: '#00AF5C' }}
                                />
                                <span className="relative z-10 flex items-center gap-1.5">
                                  <Loader2 size={12} className="animate-spin" />
                                  <span className="tabular-nums">{pct}%</span>
                                </span>
                              </div>
                            );
                          }
                          return (
                            <motion.button
                              onClick={() => handleInstall(p)}
                              disabled={isInstalling || !supportsLoader}
                              whileHover={{ scale: 1.03 }}
                              whileTap={{ scale: 0.97 }}
                              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-xs font-bold transition-all disabled:opacity-40">
                              {isInstalling ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                              {isInstalling ? 'Installing…' : 'Install'}
                            </motion.button>
                          );
                        })()
                      )}
                    </div>
                  </div>
                  <AnimatePresence>
                    {versionPickerOpen[p.project_id] && projectVersionsList[p.project_id] && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden border-t border-[#2D2D2D]">
                        <div className="px-3 py-2 max-h-40 overflow-y-auto custom-scrollbar">
                          <p className="text-[10px] uppercase tracking-wider font-bold text-[#555555] mb-1.5">Select version to install</p>
                          {projectVersionsList[p.project_id].map(ver => (
                            <button
                              key={ver.id}
                              onClick={() => handleChangeVersion(p, ver)}
                              className="w-full text-left flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-xs font-medium text-[#A0A0A0] hover:bg-[#111111] hover:text-[#FFFFFF] transition-colors">
                              <span className="truncate tabular-nums">{ver.version_number}</span>
                              <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                                ver.version_type === 'release' ? 'bg-[#00AF5C]/10 text-[#00AF5C]' :
                                ver.version_type === 'beta' ? 'bg-amber-500/10 text-amber-400' :
                                'bg-[#2D2D2D] text-[#555555]'
                              }`}>{ver.version_type}</span>
                            </button>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-[#2D2D2D]">
          <span className="text-xs text-[#555555]">{totalHits.toLocaleString()} results • Page {page+1} of {totalPages}</span>
          <div className="flex gap-2">
            <button onClick={() => handlePageChange(page-1)} disabled={page===0} className="p-2 bg-[#1E1E1E] border border-[#2D2D2D] rounded-xl text-[#A0A0A0] hover:text-[#FFFFFF] transition-all disabled:opacity-30"><ChevronLeft size={16}/></button>
            <button onClick={() => handlePageChange(page+1)} disabled={page>=totalPages-1} className="p-2 bg-[#1E1E1E] border border-[#2D2D2D] rounded-xl text-[#A0A0A0] hover:text-[#FFFFFF] transition-all disabled:opacity-30"><ChevronRight size={16}/></button>
          </div>
        </div>
      )}
      </>
      )}
    </Wrapper>
  );
}

// Full-area "Installed" view: a vertical scrollable list of every item in this
// profile/type with icon, title, filename, and delete. Filterable when the
// list gets dense. Mirrors ModsViewer's installed tab in feel.
//
// Long-press (~500 ms) on any row flips the view into multi-select mode —
// checkboxes appear, every subsequent click toggles selection, and a
// header bar offers Select All / Clear / Delete selected.
function InstalledTabView({ items, typeLabel, filter, onFilterChange, onDelete, contentType }) {
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const pressTimer = useRef(null);
  const pressTriggered = useRef(false);

  // Drop selection state when the type changes or the underlying list shrinks.
  useEffect(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, [contentType]);
  useEffect(() => {
    setSelected(prev => {
      const present = new Set(items.map(i => i.filename));
      const next = new Set();
      for (const f of prev) if (present.has(f)) next.add(f);
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  const q = filter.trim().toLowerCase();
  const filtered = !q
    ? items
    : items.filter(f => (f.title || f.filename || '').toLowerCase().includes(q));

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  const toggleOne = (filename) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename); else next.add(filename);
      return next;
    });
  };

  const visibleFilenames = filtered.map(f => f.filename);
  const allVisibleSelected = visibleFilenames.length > 0 && visibleFilenames.every(f => selected.has(f));
  const toggleSelectAll = () => {
    setSelected(prev => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const f of visibleFilenames) next.delete(f);
        return next;
      }
      const next = new Set(prev);
      for (const f of visibleFilenames) next.add(f);
      return next;
    });
  };

  // Long-press: mousedown starts a timer; if it fires (500 ms) we enter
  // select mode and mark the pressed row as selected. Movement, pointer-up,
  // or pointer-leave cancels the timer.
  const startPress = (filename) => {
    pressTriggered.current = false;
    clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => {
      pressTriggered.current = true;
      setSelectMode(true);
      setSelected(prev => {
        const next = new Set(prev);
        next.add(filename);
        return next;
      });
    }, 500);
  };
  const cancelPress = () => { clearTimeout(pressTimer.current); };
  useEffect(() => () => clearTimeout(pressTimer.current), []);

  const handleRowClick = (filename) => {
    // Suppress the click that ends the long-press itself — the press handler
    // already added this row to the selection.
    if (pressTriggered.current) { pressTriggered.current = false; return; }
    if (selectMode) toggleOne(filename);
  };

  const handleBulkDelete = async () => {
    setBulkDeleting(true);
    // Serial delete — the backend doesn't have a bulk endpoint and parallel
    // deletes on the same .minedash-launcher.json metadata file race each
    // other. Sequential is fast enough for the click-and-delete use case.
    for (const filename of selected) {
      try { await onDelete(filename); } catch {}
    }
    setBulkDeleting(false);
    setConfirmBulkDelete(false);
    exitSelectMode();
  };

  if (!items || items.length === 0) {
    return (
      <div className="flex flex-col items-center py-16 text-[#555555]">
        <FolderOpen size={32} className="mb-3 opacity-30" />
        <p className="text-sm">No {typeLabel} installed yet</p>
        <p className="text-xs mt-1 text-[#555555]">Switch to <span className="font-bold text-[#A0A0A0]">Browse</span> to add some.</p>
      </div>
    );
  }

  return (
    <div>
      <AnimatePresence initial={false} mode="wait">
        {selectMode ? (
          <motion.div
            key="select-bar"
            initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="flex items-center gap-2 mb-3 px-3 py-2 bg-[#00AF5C]/10 border border-[#00AF5C]/20 rounded-xl">
            <button
              onClick={exitSelectMode}
              className="p-1.5 rounded-lg text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#1E1E1E] transition-colors"
              aria-label="Exit selection">
              <X size={14} />
            </button>
            <span className="text-xs font-bold text-[#FFFFFF] tabular-nums">
              {selected.size} selected
            </span>
            <div className="flex-1" />
            <motion.button
              onClick={toggleSelectAll}
              whileTap={{ scale: 0.97 }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-[#00AF5C] hover:bg-[#00AF5C]/10 transition-colors">
              {allVisibleSelected ? <Square size={14} /> : <CheckSquare size={14} />}
              {allVisibleSelected ? 'Deselect all' : 'Select all'}
            </motion.button>
            <motion.button
              onClick={() => setConfirmBulkDelete(true)}
              disabled={selected.size === 0}
              whileHover={{ scale: selected.size === 0 ? 1 : 1.03 }}
              whileTap={{ scale: selected.size === 0 ? 1 : 0.97 }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-[#FF5555] hover:bg-[#FF4444] text-white transition-colors disabled:opacity-40">
              <Trash2 size={14} />
              Delete
            </motion.button>
          </motion.div>
        ) : (
          <motion.div
            key="filter-bar"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="relative mb-3">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555555]" />
            <input
              type="text"
              value={filter}
              onChange={e => onFilterChange(e.target.value)}
              placeholder={`Filter installed ${typeLabel}…`}
              className="w-full bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] rounded-xl pl-10 pr-3 py-2.5 text-sm text-[#FFFFFF] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[#555555] font-medium"
            />
          </motion.div>
        )}
      </AnimatePresence>

      {!selectMode && (
        <p className="text-[10px] text-[#555555] mb-2 px-1">
          Tip: press and hold an item to select multiple.
        </p>
      )}

      <div className="max-h-[420px] overflow-y-auto custom-scrollbar -mr-2 pr-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center py-12 text-[#555555]">
            <Search size={32} className="mb-3 opacity-30" />
            <p className="text-sm">No installed {typeLabel} match "{filter}"</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {filtered.map((f, idx) => {
              const isSelected = selected.has(f.filename);
              return (
              <motion.div key={f.filename}
                initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(idx * 0.02, 0.15), duration: 0.18 }}
                onMouseDown={() => startPress(f.filename)}
                onMouseUp={cancelPress}
                onMouseLeave={cancelPress}
                onTouchStart={() => startPress(f.filename)}
                onTouchEnd={cancelPress}
                onTouchMove={cancelPress}
                onClick={() => handleRowClick(f.filename)}
                className={`group flex items-center gap-3 px-3 py-2 bg-[#1E1E1E] border rounded-xl transition-colors select-none ${
                  isSelected
                    ? 'border-[#00AF5C] bg-[#00AF5C]/10'
                    : 'border-[#2D2D2D] hover:border-[#555555]'
                } ${selectMode ? 'cursor-pointer' : ''}`}>
                {selectMode && (
                  <div className={`w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 transition-colors ${
                    isSelected ? 'bg-[#00AF5C] text-white' : 'bg-[#111111] border border-[#2D2D2D]'
                  }`}>
                    {isSelected && <Check size={12} />}
                  </div>
                )}
                <div className="w-9 h-9 rounded-lg overflow-hidden bg-[#111111] border border-[#2D2D2D] flex-shrink-0 flex items-center justify-center">
                  {f.iconUrl
                    ? <img src={f.iconUrl} alt="" className="w-full h-full object-cover" draggable={false} />
                    : <Package size={16} className="text-[#00AF5C]" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    <p className="text-sm font-bold text-[#FFFFFF] truncate">{f.title || f.filename}</p>
                    {f.wrongVersion && (
                      <span title="This mod's jar doesn't list this profile's Minecraft version as supported"
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-bold bg-[#FF5555]/15 text-[#FF5555] border border-[#FF5555]/30 rounded-md flex-shrink-0">
                        <AlertTriangle size={10} /> Wrong version
                      </span>
                    )}
                    {!f.wrongVersion && f.wrongLoader && (
                      <span title="This jar is built for a different mod loader than the profile"
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-bold bg-[#FF5555]/15 text-[#FF5555] border border-[#FF5555]/30 rounded-md flex-shrink-0">
                        <AlertTriangle size={10} /> Wrong loader
                      </span>
                    )}
                  </div>
                  {f.title && f.title !== f.filename && (
                    <p className="text-[10px] text-[#555555] truncate font-mono">{f.filename}</p>
                  )}
                </div>
                {!selectMode && (
                  <button onClick={(e) => { e.stopPropagation(); onDelete(f.filename); }}
                    className="p-2 text-[#A0A0A0] hover:text-[#FF5555] hover:bg-[#FF5555]/10 rounded-lg transition-all opacity-0 group-hover:opacity-100 focus:opacity-100 flex-shrink-0"
                    aria-label="Remove">
                    <Trash2 size={14} />
                  </button>
                )}
              </motion.div>
              );
            })}
          </div>
        )}
      </div>

      <AnimatePresence>
        {confirmBulkDelete && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#000000]/80 backdrop-blur-sm flex items-center justify-center z-50 p-4"
            onClick={() => !bulkDeleting && setConfirmBulkDelete(false)}>
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
              onClick={e => e.stopPropagation()}
              className="bg-[#1A1A1A] border border-[#2D2D2D] rounded-3xl p-6 max-w-md w-full">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-[#FF5555]/10 rounded-xl">
                  <Trash2 size={18} className="text-[#FF5555]" />
                </div>
                <h3 className="text-lg font-bold text-[#FFFFFF]">Delete {selected.size} {typeLabel}?</h3>
              </div>
              <p className="text-sm text-[#A0A0A0] mb-5">
                The selected files will be removed from this profile. This can't be undone.
              </p>
              <div className="flex items-center justify-end gap-2 border-t border-[#2D2D2D] pt-4">
                <button
                  onClick={() => setConfirmBulkDelete(false)}
                  disabled={bulkDeleting}
                  className="px-4 py-2 rounded-xl text-sm font-bold text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#1E1E1E] transition-colors disabled:opacity-40">
                  Cancel
                </button>
                <motion.button
                  onClick={handleBulkDelete}
                  disabled={bulkDeleting}
                  whileHover={{ scale: bulkDeleting ? 1 : 1.03 }}
                  whileTap={{ scale: bulkDeleting ? 1 : 0.97 }}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold bg-[#FF5555] hover:bg-[#FF4444] text-white transition-colors disabled:opacity-60">
                  {bulkDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  {bulkDeleting ? 'Deleting…' : 'Delete'}
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

