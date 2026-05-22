import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Search, Download, Heart, Loader2, Check, AlertCircle, ChevronLeft, ChevronRight, X, Tag } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Select from './Select';
import ModalPortal from './ModalPortal';

const CATEGORIES = [
  'adventure','decoration','economy','equipment','food','game-mechanics',
  'library','magic','management','mobs','optimization','storage',
  'technology','transportation','utility','worldgen',
];

function fmt(n) {
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
  return n.toString();
}
function fmtDate(d) {
  const days = Math.floor((Date.now()-new Date(d))/(864e5));
  if (days===0) return 'Today'; if (days===1) return 'Yesterday';
  if (days<30) return days+' days ago'; if (days<365) return Math.floor(days/30)+' months ago';
  return Math.floor(days/365)+' years ago';
}
function fmtBytes(b) {
  if (b<1024) return b+' B'; if (b<1048576) return (b/1024).toFixed(1)+' KB';
  return (b/1048576).toFixed(1)+' MB';
}

const TYPE_COLORS = {
  release: 'bg-[#00AF5C]/10 text-[#00AF5C] border-[#00AF5C]/20',
  beta: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  alpha: 'bg-[#FF5555]/10 text-[#FF5555] border-[#FF5555]/20',
};

export default function ModrinthBrowser({ serverId, serverVersion, serverType, onInstalled, projectType = 'mod' }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [totalHits, setTotalHits] = useState(0);
  const [page, setPage] = useState(0);
  const [category, setCategory] = useState('');
  const [sortIndex, setSortIndex] = useState('relevance');
  const [installing, setInstalling] = useState({});
  const [installed, setInstalled] = useState({});
  const [installedFiles, setInstalledFiles] = useState([]);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [versionModal, setVersionModal] = useState(null);
  const [versions, setVersions] = useState([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionFilter, setVersionFilter] = useState('all');
  // When the backend refuses a client-only mod, stash the install args here and surface
  // a confirm dialog. Resolving the promise retries the same call with force=true.
  const [clientOnlyConfirm, setClientOnlyConfirm] = useState(null);
  const searchTimeout = useRef(null);
  const LIMIT = 20;

  const isDatapack = projectType === 'datapack';

  const getLoader = () => {
    if (isDatapack) return ''; // datapacks are loader-agnostic
    const t = (serverType||'').toLowerCase();
    if (['fabric','forge','neoforge','quilt'].includes(t)) return t;
    if (['paper','spigot','bukkit'].includes(t)) return 'bukkit';
    if (t==='purpur') return 'purpur';
    return '';
  };

  const searchMods = useCallback(async (q, p=0, cat='', sort='relevance') => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({ query: q, limit: LIMIT.toString(), offset: (p*LIMIT).toString() });
      if (serverVersion) params.set('gameVersion', serverVersion);
      const loader = getLoader();
      if (loader) params.set('loader', loader);
      if (cat) params.set('category', cat);
      if (projectType === 'modpack') params.set('projectType', 'modpack');
      if (projectType === 'datapack') params.set('projectType', 'datapack');
      if (sort) params.set('sort', sort);

      const res = await fetch(`http://localhost:3001/api/modrinth/search?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');
      setResults(data.hits || []);
      setTotalHits(data.total_hits || 0);
    } catch (err) { setError(err.message); setResults([]); }
    setLoading(false);
  }, [serverVersion, serverType, projectType]);

  // Fetch installed mod/datapack filenames to cross-reference
  const fetchInstalledFiles = useCallback(async () => {
    try {
      const endpoint = isDatapack
        ? `http://localhost:3001/api/servers/${serverId}/datapacks`
        : `http://localhost:3001/api/servers/${serverId}/mods`;
      const res = await fetch(endpoint);
      const data = await res.json();
      if (res.ok && Array.isArray(data)) {
        setInstalledFiles(data.map(m => (m.name || '').toLowerCase()));
      }
    } catch {}
  }, [serverId, isDatapack]);

  useEffect(() => { fetchInstalledFiles(); }, [fetchInstalledFiles]);
  useEffect(() => { setPage(0); searchMods(query, 0, category, sortIndex); }, [searchMods, sortIndex]);

  // Cross-reference search results with installed files
  useEffect(() => {
    if (installedFiles.length > 0 && results.length > 0) {
      const map = {};
      results.forEach(mod => {
        const slug = (mod.slug || '').toLowerCase();
        const title = (mod.title || '').toLowerCase().replace(/\s+/g, '');
        if (installedFiles.some(f => f.includes(slug) || (title && f.includes(title)))) {
          map[mod.project_id] = true;
        }
      });
      if (Object.keys(map).length > 0) {
        setInstalled(prev => ({ ...prev, ...map }));
      }
    }
  }, [installedFiles, results]);

  const handleQueryChange = (val) => {
    setQuery(val);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => { setPage(0); searchMods(val, 0, category, sortIndex); }, 400);
  };
  const handleCategoryChange = (cat) => { const c = cat===category?'':cat; setCategory(c); setPage(0); searchMods(query, 0, c, sortIndex); };
  const handlePageChange = (p) => { setPage(p); searchMods(query, p, category, sortIndex); };
  const showToast = (msg, isError=false) => { setToast({msg,isError}); setTimeout(()=>setToast(null), 4000); };

  // One-click install: get versions filtered by game version, pick best release
  const handleInstall = async (project) => {
    setInstalling(prev => ({ ...prev, [project.project_id]: true }));
    try {
      const params = new URLSearchParams();
      if (serverVersion) params.set('gameVersion', serverVersion);
      const loader = getLoader();
      if (loader) params.set('loader', loader);

      const res = await fetch(`http://localhost:3001/api/modrinth/project/${project.project_id}/versions?${params}`);
      const vs = await res.json();
      if (!res.ok || !Array.isArray(vs) || vs.length === 0) throw new Error('No compatible version found');

      // Prefer release > beta > alpha
      const sorted = [...vs].sort((a,b) => {
        const p = {release:0,beta:1,alpha:2};
        return (p[a.version_type]||3) - (p[b.version_type]||3);
      });
      const best = sorted[0];
      const file = best.files.find(f=>f.primary) || best.files[0];
      if (!file) throw new Error('No downloadable file');

      if (projectType === 'modpack') {
        // Modpack install
        const r = await fetch(`http://localhost:3001/api/servers/${serverId}/modpack/install-modrinth`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ url: file.url, filename: file.filename }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Install failed');
        setInstalled(prev => ({...prev, [project.project_id]: true}));
        showToast(`${project.title} installed! ${d.installed} mods added.`);
      } else if (isDatapack) {
        // Datapack install — goes into world/datapacks/
        const r = await fetch(`http://localhost:3001/api/servers/${serverId}/datapacks/install-modrinth`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({
            url: file.url,
            filename: file.filename,
            iconUrl: project.icon_url || null,
            title: project.title || null,
            projectId: project.project_id,
          }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Install failed');
        setInstalled(prev => ({...prev, [project.project_id]: true}));
        showToast(`${project.title} installed to world/datapacks!`);
      } else {
        // Single mod install — pass dep info so backend can auto-resolve required deps
        const requiredDeps = (best.dependencies || [])
          .filter(d => d.dependency_type === 'required' && d.project_id)
          .map(d => d.project_id);
        const body = {
          url: file.url,
          filename: file.filename,
          iconUrl: project.icon_url || null,
          title: project.title || null,
          projectId: project.project_id,
          gameVersion: serverVersion,
          loader: getLoader(),
          dependencies: requiredDeps,
          serverSide: project.server_side,
        };
        const r = await fetch(`http://localhost:3001/api/servers/${serverId}/mods/install-modrinth`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify(body),
        });
        const d = await r.json();
        if (r.status === 409 && d.clientOnly) {
          setClientOnlyConfirm({ title: project.title, body, version: best.version_number, projectId: project.project_id });
          setInstalling(prev => ({...prev, [project.project_id]: false}));
          return;
        }
        if (!r.ok) throw new Error(d.error || 'Install failed');
        setInstalled(prev => ({...prev, [project.project_id]: true}));
        const depMsg = d.depsInstalled?.length > 0 ? ` + ${d.depsInstalled.length} dependenc${d.depsInstalled.length === 1 ? 'y' : 'ies'} auto-installed` : '';
        showToast(`${project.title} v${best.version_number} installed!${depMsg}`);
      }
      if (onInstalled) onInstalled();
      fetchInstalledFiles();
    } catch (err) { showToast(err.message, true); }
    setInstalling(prev => ({...prev, [project.project_id]: false}));
  };

  // Retry an install after the user acknowledged the client-only warning.
  const confirmClientOnly = async () => {
    if (!clientOnlyConfirm) return;
    const { body, projectId, title, version } = clientOnlyConfirm;
    setClientOnlyConfirm(null);
    setInstalling(prev => ({...prev, [projectId]: true}));
    try {
      const r = await fetch(`http://localhost:3001/api/servers/${serverId}/mods/install-modrinth`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ ...body, force: true }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Install failed');
      setInstalled(prev => ({...prev, [projectId]: true}));
      const depMsg = d.depsInstalled?.length > 0 ? ` + ${d.depsInstalled.length} dep${d.depsInstalled.length === 1 ? '' : 's'} auto-installed` : '';
      showToast(`${title} v${version} installed!${depMsg}`);
      if (onInstalled) onInstalled();
      fetchInstalledFiles();
      setVersionModal(null);
    } catch (err) { showToast(err.message, true); }
    setInstalling(prev => ({...prev, [projectId]: false}));
  };

  // Open version picker (for "Change version")
  const openVersions = async (project) => {
    setVersionModal(project); setVersionsLoading(true); setVersionFilter('all');
    try {
      const params = new URLSearchParams();
      const loader = getLoader();
      if (loader) params.set('loader', loader);
      // Don't filter by game version so user can see everything
      const res = await fetch(`http://localhost:3001/api/modrinth/project/${project.project_id}/versions?${params}`);
      const vs = await res.json();
      if (!res.ok) throw new Error('Failed');
      setVersions(vs);
    } catch (err) { showToast('Failed to load versions', true); setVersionModal(null); }
    setVersionsLoading(false);
  };

  const installVersion = async (version) => {
    const file = version.files.find(f=>f.primary) || version.files[0];
    if (!file) return showToast('No file found', true);
    setInstalling(prev => ({...prev, [version.id]: true}));
    try {
      const requiredDeps = (version.dependencies || [])
        .filter(d => d.dependency_type === 'required' && d.project_id)
        .map(d => d.project_id);
      const body = {
        url: file.url,
        filename: file.filename,
        iconUrl: versionModal?.icon_url || null,
        title: versionModal?.title || null,
        projectId: versionModal?.project_id || null,
        gameVersion: serverVersion,
        loader: getLoader(),
        dependencies: requiredDeps,
        serverSide: versionModal?.server_side,
      };
      const r = await fetch(`http://localhost:3001/api/servers/${serverId}/mods/install-modrinth`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (r.status === 409 && d.clientOnly) {
        setClientOnlyConfirm({ title: versionModal?.title, body, version: version.version_number, projectId: versionModal?.project_id });
        setInstalling(prev => ({...prev, [version.id]: false}));
        return;
      }
      if (!r.ok) throw new Error(d.error || 'Install failed');
      setInstalled(prev => ({...prev, [versionModal.project_id]: true}));
      const depMsg = d.depsInstalled?.length > 0 ? ` + ${d.depsInstalled.length} dep${d.depsInstalled.length === 1 ? '' : 's'} auto-installed` : '';
      showToast(`${versionModal.title} v${version.version_number} installed!${depMsg}`);
      if (onInstalled) onInstalled();
      setVersionModal(null);
    } catch (err) { showToast(err.message, true); }
    setInstalling(prev => ({...prev, [version.id]: false}));
  };

  const totalPages = Math.ceil(totalHits / LIMIT);
  const filteredVs = versions.filter(v => versionFilter==='all' || v.version_type===versionFilter);
  const isModpack = projectType === 'modpack';
  const typeLabel = isModpack ? 'modpacks' : isDatapack ? 'data packs' : 'mods';
  const searchPlaceholder = isModpack ? 'Search modpacks...' : isDatapack ? 'Search data packs...' : 'Search mods...';

  return (
    <div className="flex flex-col h-full relative">
      {/* Version Picker Modal */}
      <AnimatePresence>
        {versionModal && (
          <ModalPortal>
          <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
            className="fixed inset-0 bg-[#000000]/80 z-[100] flex items-center justify-center backdrop-blur-sm"
            onClick={()=>setVersionModal(null)}>
            <motion.div initial={{scale:0.9,opacity:0}} animate={{scale:1,opacity:1}} exit={{scale:0.9,opacity:0}}
              transition={{type:'spring',duration:0.4,bounce:0.15}}
              className="bg-[#1A1A1A] border border-[#2D2D2D] rounded-3xl w-full max-w-2xl shadow-2xl mx-4 max-h-[80vh] flex flex-col overflow-hidden"
              onClick={e=>e.stopPropagation()}>
              <div className="flex items-center justify-between px-6 py-4 border-b border-[#2D2D2D]">
                <div className="flex items-center gap-3 min-w-0">
                  {versionModal.icon_url && <img src={versionModal.icon_url} alt="" className="w-10 h-10 rounded-xl object-cover flex-shrink-0"/>}
                  <div className="min-w-0">
                    <h3 className="text-lg font-bold text-[#FFFFFF] truncate">{versionModal.title}</h3>
                    <p className="text-xs text-[#555555]">Select a version to install</p>
                  </div>
                </div>
                <button onClick={()=>setVersionModal(null)} className="p-2 text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#2D2D2D] rounded-xl transition-all"><X size={20}/></button>
              </div>
              <div className="flex items-center gap-2 px-6 py-3 border-b border-[#2D2D2D]">
                {['all','release','beta','alpha'].map(t=>(
                  <button key={t} onClick={()=>setVersionFilter(t)}
                    className={`px-3 py-1.5 text-xs font-bold rounded-lg capitalize transition-all ${versionFilter===t?'bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/20':'text-[#555555] hover:text-[#A0A0A0] border border-transparent hover:border-[#2D2D2D]'}`}>
                    {t}
                  </button>
                ))}
                {serverVersion && <span className="ml-auto text-[10px] text-[#555555]">Your server: {serverVersion}</span>}
              </div>
              <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-2">
                {versionsLoading ? (
                  <div className="flex items-center justify-center py-12"><Loader2 size={20} className="animate-spin text-[#00AF5C] mr-3"/><span className="text-[#A0A0A0] text-sm">Loading...</span></div>
                ) : filteredVs.length===0 ? (
                  <div className="flex flex-col items-center py-12 text-[#555555]"><Tag size={32} className="mb-3 opacity-30"/><p className="text-sm">No versions found</p></div>
                ) : filteredVs.map(v => {
                  const tc = TYPE_COLORS[v.version_type]||TYPE_COLORS.release;
                  const f = v.files.find(x=>x.primary)||v.files[0];
                  const compat = serverVersion && v.game_versions.includes(serverVersion);
                  return (
                    <div key={v.id} className={`flex items-center gap-4 p-3 rounded-xl border transition-all hover:border-[#555555] ${compat?'bg-[#1E1E1E] border-[#2D2D2D]':'bg-[#1E1E1E]/50 border-[#2D2D2D]/50'}`}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="font-bold text-sm text-[#FFFFFF]">{v.version_number}</span>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${tc} uppercase`}>{v.version_type}</span>
                          {compat && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">Compatible</span>}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-[#555555]">
                          <span>MC {v.game_versions.slice(0,3).join(', ')}{v.game_versions.length>3?` +${v.game_versions.length-3}`:''}</span>
                          {f && <span>{fmtBytes(f.size)}</span>}
                          <span>{fmt(v.downloads)} downloads</span>
                        </div>
                      </div>
                      <motion.button whileHover={{scale:1.05}} whileTap={{scale:0.95}} onClick={()=>installVersion(v)} disabled={!!installing[v.id]}
                        className="flex items-center gap-1.5 px-3 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-xs font-bold transition-all disabled:opacity-50 flex-shrink-0">
                        {installing[v.id]?<Loader2 size={14} className="animate-spin"/>:<Download size={14}/>}
                        {installing[v.id]?'Installing...':'Install'}
                      </motion.button>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          </motion.div>
          </ModalPortal>
        )}
      </AnimatePresence>

      {/* Client-only confirm */}
      <AnimatePresence>
        {clientOnlyConfirm && (
          <ModalPortal>
            <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
              className="fixed inset-0 bg-[#000000]/80 z-[110] flex items-center justify-center backdrop-blur-sm"
              onClick={()=>setClientOnlyConfirm(null)}>
              <motion.div initial={{scale:0.9,opacity:0}} animate={{scale:1,opacity:1}} exit={{scale:0.9,opacity:0}}
                transition={{type:'spring',duration:0.4,bounce:0.15}}
                className="bg-[#1A1A1A] border border-[#2D2D2D] rounded-3xl w-full max-w-md shadow-2xl mx-4 p-6"
                onClick={e=>e.stopPropagation()}>
                <div className="flex items-center gap-3 mb-4">
                  <div className="bg-amber-500/10 p-2 rounded-xl"><AlertCircle size={20} className="text-amber-400"/></div>
                  <h3 className="text-lg font-bold text-[#FFFFFF]">Client-only mod</h3>
                </div>
                <p className="text-sm text-[#A0A0A0] mb-2 font-medium">
                  <span className="text-[#FFFFFF] font-bold">{clientOnlyConfirm.title}</span> is marked client-only by its author.
                </p>
                <p className="text-sm text-[#A0A0A0] mb-6 font-medium">
                  Installing it on a dedicated server will likely crash the whole server on startup the moment the mod tries to load a client-only class. Install anyway?
                </p>
                <div className="flex gap-2 border-t border-[#2D2D2D] pt-4">
                  <button onClick={()=>setClientOnlyConfirm(null)}
                    className="flex-1 px-4 py-2.5 bg-[#2D2D2D] hover:bg-[#3D3D3D] text-[#FFFFFF] rounded-xl text-sm font-bold transition-all">
                    Cancel
                  </button>
                  <button onClick={confirmClientOnly}
                    className="flex-1 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-[#111111] rounded-xl text-sm font-bold transition-all">
                    Install anyway
                  </button>
                </div>
              </motion.div>
            </motion.div>
          </ModalPortal>
        )}
      </AnimatePresence>

      {/* Search */}
      <div className="flex items-center gap-3 mb-3">
        <div className="relative flex-1">
          <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#555555]"/>
          <input type="text" placeholder={searchPlaceholder} value={query} onChange={e=>handleQueryChange(e.target.value)}
            className="w-full pl-12 pr-4 py-2.5 bg-[#1E1E1E] border border-[#2D2D2D] focus:border-[#00AF5C] rounded-xl text-sm text-[#FFFFFF] outline-none transition-all placeholder-[#555555] focus:ring-4 focus:ring-[#00AF5C]/10 font-medium"/>
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
        {serverVersion && <span className="text-xs font-bold bg-[#1E1E1E] text-[#A0A0A0] px-3 py-2 rounded-xl border border-[#2D2D2D] whitespace-nowrap flex-shrink-0 capitalize">{serverType} {serverVersion}</span>}
      </div>

      {/* Categories (only for mods) */}
      {!isModpack && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {CATEGORIES.map(cat=>(
            <button key={cat} onClick={()=>handleCategoryChange(cat)}
              className={`px-2.5 py-1 text-xs font-bold rounded-lg capitalize transition-all ${category===cat?'bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/20':'text-[#555555] hover:text-[#A0A0A0] border border-[#2D2D2D] hover:border-[#555555] bg-[#1E1E1E]'}`}>
              {cat.replace('-',' ')}
            </button>
          ))}
        </div>
      )}

      {/* Results */}
      <div className="flex-1 overflow-y-auto custom-scrollbar -mr-2 pr-2">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={24} className="text-[#00AF5C] animate-spin"/><span className="ml-3 text-[#A0A0A0] font-medium">Searching...</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center py-20 text-[#FF5555]"><AlertCircle size={32} className="mb-3"/><p className="font-bold">Search failed</p><p className="text-sm text-[#A0A0A0] mt-1">{error}</p></div>
        ) : results.length===0 ? (
          <div className="flex flex-col items-center py-20 text-[#555555]"><Search size={48} className="mb-4 opacity-30"/><p className="font-bold">No {typeLabel} found</p></div>
        ) : (
          <div className="space-y-2">
            {results.map((mod,idx)=>(
              <motion.div key={mod.project_id} initial={{opacity:0,y:6}} animate={{opacity:1,y:0}} transition={{delay:idx*0.03,duration:0.25}}
                className="flex gap-4 p-4 bg-[#1E1E1E] border border-[#2D2D2D] rounded-2xl hover:border-[#555555] transition-all group">
                <div className="w-12 h-12 rounded-xl overflow-hidden bg-[#111111] border border-[#2D2D2D] flex-shrink-0 flex items-center justify-center">
                  {mod.icon_url ? <img src={mod.icon_url} alt="" className="w-full h-full object-cover"/> :
                    <div className="w-full h-full bg-gradient-to-br from-[#00AF5C]/20 to-[#00AF5C]/5 flex items-center justify-center text-[#00AF5C] text-lg font-black">{mod.title?.[0]||'?'}</div>}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <h4 className="font-bold text-[#FFFFFF] text-sm truncate">{mod.title}</h4>
                    <span className="text-xs text-[#555555] flex-shrink-0">by {mod.author}</span>
                  </div>
                  <p className="text-xs text-[#A0A0A0] line-clamp-1 mb-1.5">{mod.description}</p>
                  <div className="flex items-center gap-3 text-xs text-[#555555]">
                    <span className="flex items-center gap-1"><Download size={11}/>{fmt(mod.downloads)}</span>
                    <span className="flex items-center gap-1"><Heart size={11}/>{fmt(mod.follows)}</span>
                    <span>{fmtDate(mod.date_modified)}</span>
                  </div>
                </div>
                <div className="flex items-center flex-shrink-0">
                  {installed[mod.project_id] ? (
                    <div className="flex flex-col items-end gap-1">
                      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[#00AF5C]/10 text-[#00AF5C] rounded-xl text-xs font-bold border border-[#00AF5C]/20"><Check size={14}/>Installed</div>
                      {!isModpack && <button onClick={()=>openVersions(mod)} className="text-[10px] text-[#555555] hover:text-[#00AF5C] transition-colors font-medium">Change version</button>}
                    </div>
                  ) : (
                    <motion.button whileHover={{scale:1.03}} whileTap={{scale:0.97}} onClick={()=>handleInstall(mod)} disabled={!!installing[mod.project_id]}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-xs font-bold transition-all disabled:opacity-50 hover:shadow-[0_4px_15px_rgba(0,175,92,0.25)]">
                      {installing[mod.project_id]?<><Loader2 size={14} className="animate-spin"/>Installing...</>:<><Download size={14}/>Install</>}
                    </motion.button>
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {totalPages>1 && (
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-[#2D2D2D]">
          <span className="text-xs text-[#555555]">{totalHits.toLocaleString()} results • Page {page+1} of {totalPages}</span>
          <div className="flex gap-2">
            <button onClick={()=>handlePageChange(page-1)} disabled={page===0} className="p-2 bg-[#1E1E1E] border border-[#2D2D2D] rounded-xl text-[#A0A0A0] hover:text-[#FFFFFF] transition-all disabled:opacity-30"><ChevronLeft size={16}/></button>
            <button onClick={()=>handlePageChange(page+1)} disabled={page>=totalPages-1} className="p-2 bg-[#1E1E1E] border border-[#2D2D2D] rounded-xl text-[#A0A0A0] hover:text-[#FFFFFF] transition-all disabled:opacity-30"><ChevronRight size={16}/></button>
          </div>
        </div>
      )}

      <AnimatePresence>
        {toast && (
          <motion.div initial={{opacity:0,y:20}} animate={{opacity:1,y:0}} exit={{opacity:0,y:10}}
            className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-3 rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.5)] border ${toast.isError?'bg-[#1E1E1E] border-[#FF5555]/30 text-[#FF5555]':'bg-[#1E1E1E] border-[#00AF5C]/30 text-[#FFFFFF]'}`}>
            {toast.isError?<AlertCircle size={16}/>:<div className="w-2 h-2 rounded-full bg-[#00AF5C] animate-pulse"/>}
            <span className="text-sm font-medium">{toast.msg}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
