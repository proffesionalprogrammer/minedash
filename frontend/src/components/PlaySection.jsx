import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Box, Layers, Hammer, FlaskConical, AlertCircle, Download, Plus, X, Pencil, Trash2, Check, FolderOpen } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import VersionSelect from './VersionSelect';
import PlayProgressButton from './PlayProgressButton';
import ContentBrowserModal from './ContentBrowserModal';
import Tooltip from './Tooltip';
import Select from './Select';

const LOADERS = [
  { key: 'vanilla',  label: 'Vanilla',  icon: Box          },
  { key: 'fabric',   label: 'Fabric',   icon: Layers       },
  { key: 'forge',    label: 'Forge',    icon: Hammer       },
  { key: 'neoforge', label: 'NeoForge', icon: FlaskConical },
];

export default function PlaySection({ servers, socket, initialServerId, accounts, activeAccountId, settings, installedProfiles, onProfilesChanged, onError, launchSession, modpackInstalls }) {
  const [loader, setLoader] = useState('vanilla');
  const [versions, setVersions] = useState([]);
  const [version, setVersion] = useState('');
  const [versionsLoading, setVersionsLoading] = useState(false);

  const installed = installedProfiles || new Set();
  const installedSet = useMemo(() => {
    const s = new Set();
    for (const v of versions) {
      if (installed.has(`${loader}-${v}`)) s.add(v);
    }
    return s;
  }, [versions, installed, loader]);

  const [contentOpen, setContentOpen] = useState(false);
  // First-class instances — each loader+version can have multiple isolated profiles
  // (e.g. "Default", "Create Pack", "Lite"). instances[] holds the full registry;
  // we filter to the active loader+version for display.
  const [instances, setInstances] = useState([]);
  const [instanceId, setInstanceId] = useState('');
  const [showNewInstance, setShowNewInstance] = useState(false);
  const [newInstanceName, setNewInstanceName] = useState('');
  const [renamingId, setRenamingId] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');

  // Launch session is lifted to App.jsx so it survives navigating to Servers
  // and back. Destructure with safe defaults so the component renders cleanly
  // if the prop somehow arrives undefined during hot-reload.
  const {
    phase = 'idle',
    progress = 0,
    statusText = '',
    fileCount = { current: 0, total: 0 },
    launch,
    cancel,
  } = launchSession || {};

  const fetchInstances = useCallback(async () => {
    try {
      const r = await fetch('http://localhost:3001/api/launcher/instances');
      if (!r.ok) return;
      const d = await r.json();
      setInstances(Array.isArray(d) ? d : []);
    } catch {}
  }, []);

  useEffect(() => { fetchInstances(); }, [fetchInstances]);

  useEffect(() => {
    if (!initialServerId) return;
    const s = servers.find(x => x.id === initialServerId);
    if (!s) return;
    if (LOADERS.some(l => l.key === s.type)) {
      setLoader(s.type);
      setVersion(s.version);
    }
  }, [initialServerId, servers]);

  // Restore the last-played loader+version exactly once, on first arrival of
  // `settings`. Server-driven entry (initialServerId) and any subsequent manual
  // edits win — we don't want a stale launcher-settings entry to overwrite the
  // user's current selection mid-session.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    if (initialServerId) { restoredRef.current = true; return; }
    if (!settings) return;
    if (settings.lastLoader && LOADERS.some(l => l.key === settings.lastLoader)) {
      setLoader(settings.lastLoader);
    }
    if (settings.lastVersion) {
      // The versions-fetch effect below validates this against the live list:
      // if it's not available for the loader, it falls back to d[0].
      setVersion(settings.lastVersion);
    }
    restoredRef.current = true;
  }, [settings, initialServerId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setVersionsLoading(true);
      try {
        const params = new URLSearchParams();
        if (loader === 'vanilla' && settings?.showSnapshots) params.set('includeSnapshots', '1');
        const url = `http://localhost:3001/api/versions/${loader}${params.toString() ? '?' + params : ''}`;
        const r = await fetch(url);
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok) throw new Error(d.error || 'Failed to load versions');
        setVersions(d);
        setVersion(prev => (prev && d.includes(prev)) ? prev : (d[0] || ''));
      } catch (err) {
        if (!cancelled) onError?.(err.message);
      }
      if (!cancelled) setVersionsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [loader, settings?.showSnapshots]);

  const visibleVersions = useMemo(() => {
    if (!settings?.onlyInstalled) return versions;
    return versions.filter(v => installed.has(`${loader}-${v}`));
  }, [versions, installed, loader, settings?.onlyInstalled]);

  // Instances available for the current loader+version selection.
  const visibleInstances = useMemo(
    () => instances.filter(i => i.loader === loader && i.version === version),
    [instances, loader, version],
  );

  // Synchronously-derived display ID for the Select. The effect below settles
  // `instanceId` to a valid value asynchronously, which leaves a one-frame gap
  // after the user swaps loader/version where the stale ID (e.g. "fabric-1.20.1")
  // would render as the Select label. Falling back here keeps the dropdown
  // honest every frame.
  const safeInstanceId = useMemo(() => {
    if (visibleInstances.some(i => i.id === instanceId)) return instanceId;
    const def = visibleInstances.find(i => i.isDefault);
    return (def || visibleInstances[0])?.id || '';
  }, [visibleInstances, instanceId]);

  // Whenever the loader/version selection changes, pick a sensible default
  // instance: the last-played one if it matches, otherwise the default
  // instance (the one with isDefault), otherwise the first available.
  useEffect(() => {
    if (!version) return;
    const matching = instances.filter(i => i.loader === loader && i.version === version);
    if (matching.length === 0) {
      setInstanceId('');
      return;
    }
    // Honour current selection if still valid
    if (matching.some(i => i.id === instanceId)) return;
    // Honour saved lastInstanceId if it matches loader+version
    const lastMatch = settings?.lastInstanceId
      ? matching.find(i => i.id === settings.lastInstanceId)
      : null;
    if (lastMatch) { setInstanceId(lastMatch.id); return; }
    // Fall back to the default instance, otherwise the first match
    const def = matching.find(i => i.isDefault);
    setInstanceId((def || matching[0]).id);
  }, [loader, version, instances, settings?.lastInstanceId, instanceId]);

  const activeAccount = accounts?.find(a => a.id === activeAccountId);
  const idle = phase === 'idle';
  const canLaunch = !!activeAccount && !!version && idle;

  const handleDeleteProfile = async (v) => {
    try {
      const r = await fetch(`http://localhost:3001/api/launcher/profiles/${loader}/${encodeURIComponent(v)}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to delete');
      onProfilesChanged?.();
      fetchInstances();
    } catch (err) {
      onError?.(err.message);
    }
  };

  const handleCreateInstance = async () => {
    const name = newInstanceName.trim();
    if (!name || !loader || !version) return;
    try {
      const r = await fetch('http://localhost:3001/api/launcher/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loader, version, displayName: name }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to create instance');
      await fetchInstances();
      setInstanceId(d.id);
      setNewInstanceName('');
      setShowNewInstance(false);
    } catch (err) {
      onError?.(err.message);
    }
  };

  const handleRenameInstance = async () => {
    const name = renameDraft.trim();
    if (!name || !renamingId) return;
    try {
      const r = await fetch(`http://localhost:3001/api/launcher/instances/${renamingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: name }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to rename');
      await fetchInstances();
      setRenamingId(null);
      setRenameDraft('');
    } catch (err) {
      onError?.(err.message);
    }
  };

  const handleDeleteInstance = async (id) => {
    try {
      const r = await fetch(`http://localhost:3001/api/launcher/instances/${id}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to delete');
      await fetchInstances();
      onProfilesChanged?.();
    } catch (err) {
      onError?.(err.message);
    }
  };

  // Use the derived safe ID so the rename / open-folder / delete buttons
  // immediately retarget the correct instance after a loader/version swap
  // (rather than briefly pointing at the stale Fabric instance from a frame ago).
  const currentInstance = visibleInstances.find(i => i.id === safeInstanceId);
  const handleLaunch = () => {
    launch?.({ version, loader, instanceId: instanceId || undefined });
    // If the user just deleted the default and clicked Play with no instance
    // selected, the backend will lazily recreate the default — refresh the
    // list so the dropdown reflects it.
    setTimeout(() => { fetchInstances(); }, 500);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#111111] px-6 md:px-12 py-8 overflow-y-auto custom-scrollbar">
      <div className="max-w-3xl mx-auto w-full space-y-6">

        <div className="bg-[#1A1A1A] border border-[#2D2D2D] rounded-3xl p-6">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-[#00AF5C]/10 rounded-xl"><Box size={18} className="text-[#00AF5C]" /></div>
              <h2 className="text-lg font-bold text-[#FFFFFF]">Profile</h2>
            </div>
            <Tooltip content={version ? 'Browse and install mods, resource packs, shaders…' : 'Pick a version first'}>
            <motion.button
              onClick={() => setContentOpen(true)}
              disabled={!version}
              whileHover={version ? { scale: 1.03 } : {}}
              whileTap={version ? { scale: 0.97 } : {}}
              className="flex items-center gap-2 px-3 py-1.5 bg-[#1E1E1E] hover:bg-[#2D2D2D] border border-[#2D2D2D] hover:border-[#00AF5C]/40 rounded-xl text-xs font-bold text-[#A0A0A0] hover:text-[#FFFFFF] transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
              <Download size={14} />
              Content
            </motion.button>
            </Tooltip>
          </div>

          <label className="text-[10px] uppercase tracking-wider font-bold text-[#555555] block mb-2">Loader</label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5">
            {LOADERS.map(({ key, label, icon: Icon }) => {
              const active = loader === key;
              return (
                <motion.button key={key}
                  onClick={() => setLoader(key)}
                  whileHover={{ y: -2 }}
                  whileTap={{ scale: 0.97 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  className={`flex flex-col items-center gap-1.5 px-3 py-3 rounded-2xl border transition-colors duration-200 ${
                    active
                      ? 'bg-[#00AF5C]/10 border-[#00AF5C]/30 text-[#00AF5C]'
                      : 'bg-[#1E1E1E] border-[#2D2D2D] text-[#A0A0A0] hover:border-[#555555]'
                  }`}>
                  <Icon size={18} />
                  <span className="text-xs font-bold">{label}</span>
                </motion.button>
              );
            })}
          </div>

          <label className="text-[10px] uppercase tracking-wider font-bold text-[#555555] block mb-2">Version</label>
          <VersionSelect
            value={version}
            onChange={setVersion}
            options={visibleVersions}
            installedSet={installedSet}
            loading={versionsLoading}
            onDelete={handleDeleteProfile}
          />

          {/* Instance picker — multiple isolated profiles per loader+version. */}
          <label className="text-[10px] uppercase tracking-wider font-bold text-[#555555] block mt-5 mb-2">Instance</label>
          <div className="flex items-stretch gap-2">
            {visibleInstances.length > 0 && (
              <Select
                value={safeInstanceId}
                onChange={setInstanceId}
                options={visibleInstances.map(i => ({ value: i.id, label: i.displayName }))}
                size="md"
                className="flex-1 min-w-0"
              />
            )}
            <Tooltip content="Create a new isolated instance of this version" className="flex-shrink-0">
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => { setShowNewInstance(true); setNewInstanceName(''); }}
                disabled={!version}
                className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 bg-[#1E1E1E] hover:bg-[#2D2D2D] border border-[#2D2D2D] hover:border-[#00AF5C]/40 rounded-xl text-xs font-bold text-[#A0A0A0] hover:text-[#FFFFFF] transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                <Plus size={14} /> New
              </motion.button>
            </Tooltip>
            {currentInstance && (
              <>
                <Tooltip content="Open this instance's folder in your file explorer" className="flex-shrink-0">
                  <motion.button
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => {
                      fetch(`http://localhost:3001/api/launcher/instances/${encodeURIComponent(currentInstance.id)}/open-folder`, { method: 'POST' }).catch(() => {});
                    }}
                    className="flex-shrink-0 p-2 bg-[#1E1E1E] hover:bg-[#2D2D2D] border border-[#2D2D2D] rounded-xl text-[#A0A0A0] hover:text-[#FFFFFF] transition-colors">
                    <FolderOpen size={14} />
                  </motion.button>
                </Tooltip>
                <Tooltip content="Rename this instance" className="flex-shrink-0">
                  <motion.button
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => { setRenamingId(currentInstance.id); setRenameDraft(currentInstance.displayName); }}
                    className="flex-shrink-0 p-2 bg-[#1E1E1E] hover:bg-[#2D2D2D] border border-[#2D2D2D] rounded-xl text-[#A0A0A0] hover:text-[#FFFFFF] transition-colors">
                    <Pencil size={14} />
                  </motion.button>
                </Tooltip>
                <Tooltip content="Delete this instance (the on-disk profile is removed)" className="flex-shrink-0">
                  <motion.button
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => handleDeleteInstance(currentInstance.id)}
                    className="flex-shrink-0 p-2 bg-[#1E1E1E] hover:bg-[#FF5555]/10 border border-[#2D2D2D] hover:border-[#FF5555]/40 rounded-xl text-[#A0A0A0] hover:text-[#FF5555] transition-colors">
                    <Trash2 size={14} />
                  </motion.button>
                </Tooltip>
              </>
            )}
          </div>

          <AnimatePresence>
            {showNewInstance && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                className="overflow-hidden">
                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="text"
                    autoFocus
                    value={newInstanceName}
                    onChange={e => setNewInstanceName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleCreateInstance(); if (e.key === 'Escape') setShowNewInstance(false); }}
                    placeholder={`Name your ${loader} ${version} instance…`}
                    className="flex-1 bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] rounded-xl px-3 py-2 text-sm text-[#FFFFFF] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[#555555] font-medium"
                  />
                  <motion.button
                    whileTap={{ scale: 0.97 }}
                    onClick={handleCreateInstance}
                    disabled={!newInstanceName.trim()}
                    className="flex items-center gap-1.5 px-3 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-xs font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                    <Check size={14} /> Create
                  </motion.button>
                  <motion.button
                    whileTap={{ scale: 0.97 }}
                    onClick={() => setShowNewInstance(false)}
                    className="p-2 bg-[#1E1E1E] hover:bg-[#2D2D2D] border border-[#2D2D2D] rounded-xl text-[#A0A0A0] hover:text-[#FFFFFF] transition-colors">
                    <X size={14} />
                  </motion.button>
                </div>
              </motion.div>
            )}
            {renamingId && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                className="overflow-hidden">
                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="text"
                    autoFocus
                    value={renameDraft}
                    onChange={e => setRenameDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleRenameInstance(); if (e.key === 'Escape') setRenamingId(null); }}
                    className="flex-1 bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] rounded-xl px-3 py-2 text-sm text-[#FFFFFF] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all font-medium"
                  />
                  <motion.button
                    whileTap={{ scale: 0.97 }}
                    onClick={handleRenameInstance}
                    disabled={!renameDraft.trim()}
                    className="flex items-center gap-1.5 px-3 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-xs font-bold transition-all disabled:opacity-40">
                    <Check size={14} /> Save
                  </motion.button>
                  <motion.button
                    whileTap={{ scale: 0.97 }}
                    onClick={() => setRenamingId(null)}
                    className="p-2 bg-[#1E1E1E] hover:bg-[#2D2D2D] border border-[#2D2D2D] rounded-xl text-[#A0A0A0] hover:text-[#FFFFFF] transition-colors">
                    <X size={14} />
                  </motion.button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {!activeAccount && (
          <div className="flex items-start gap-2 px-4 py-3 bg-amber-500/10 border border-amber-500/20 rounded-2xl text-sm text-amber-400">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            <span>Add an account from the menu in the top right to start playing.</span>
          </div>
        )}

        <PlayProgressButton
          phase={phase}
          progress={progress}
          statusText={statusText}
          fileCount={fileCount}
          idleLabel={activeAccount ? `Play as ${activeAccount.username}` : 'Play'}
          disabled={(!canLaunch && phase !== 'running') || phase === 'cancelling'}
          onClick={phase === 'running' ? cancel : (phase === 'cancelling' ? () => {} : handleLaunch)}
        />
      </div>

      <AnimatePresence>
        {contentOpen && version && (
          <ContentBrowserModal
            loader={loader}
            version={version}
            instanceId={instanceId || undefined}
            instanceName={currentInstance?.displayName}
            socket={socket}
            onClose={() => setContentOpen(false)}
            onError={onError}
            modpackInstalls={modpackInstalls}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
