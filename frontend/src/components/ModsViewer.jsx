import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Package, Trash2, Search, Upload, Download, Globe, FolderOpen, Layers, Database, Check, CheckSquare, Square, ToggleLeft, ToggleRight, Loader2, AlertTriangle, Monitor, Wrench } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import ModrinthBrowser from './ModrinthBrowser';
import ModalPortal from './ModalPortal';

function ModsViewer({ serverId, serverVersion, serverType, socket, onError, modpackInstalls }) {
  const [viewMode, setViewMode] = useState('installed');
  const [mods, setMods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [toggling, setToggling] = useState({});
  const [statusFilter, setStatusFilter] = useState('all');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [modpackFile, setModpackFile] = useState(null);
  const fileInputRef = useRef(null);

  const [exporting, setExporting] = useState(false);

  // Cleanup-action state for the "Issues detected" banner.
  const [cleaning, setCleaning] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [cleanResult, setCleanResult] = useState(null); // { moved: string[] } | null
  const [repairResult, setRepairResult] = useState(null); // { repaired, failed } | null

  // Multi-select state
  const [multiSelect, setMultiSelect] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const longPressTimer = useRef(null);
  const longPressFired = useRef(false);

  useEffect(() => { fetchMods(); }, [serverId]);

  // ESC exits multi-select
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && multiSelect) exitMultiSelect();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [multiSelect]);

  const exitMultiSelect = () => {
    setMultiSelect(false);
    setSelected(new Set());
  };

  const fetchMods = async () => {
    setLoading(true);
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${serverId}/mods`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch mods');
      setMods(data);
    } catch (err) {
      console.error(err);
      if (onError) onError(err.message);
    }
    setLoading(false);
  };

  // ── Long-press handlers ────────────────────────────────────────────────────
  const startLongPress = useCallback((modName) => {
    longPressFired.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      setMultiSelect(true);
      setSelected(new Set([modName]));
    }, 450);
  }, []);

  const cancelLongPress = useCallback(() => {
    clearTimeout(longPressTimer.current);
  }, []);

  const handleCardClick = (mod) => {
    if (!multiSelect) return;
    // Prevent a normal click right after the long-press fires from toggling back
    if (longPressFired.current) { longPressFired.current = false; return; }
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(mod.name)) next.delete(mod.name);
      else next.add(mod.name);
      return next;
    });
  };

  // ── Selection helpers ──────────────────────────────────────────────────────
  const handleSelectAll = () => {
    if (selected.size === filteredMods.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filteredMods.map(m => m.name)));
    }
  };

  // ── Bulk actions ───────────────────────────────────────────────────────────
  const handleBulkEnable = async () => {
    const targets = filteredMods.filter(m => selected.has(m.name) && !m.enabled);
    await Promise.all(targets.map(m =>
      fetch(`http://localhost:3001/api/servers/${serverId}/mods/${encodeURIComponent(m.name)}/toggle`, { method: 'POST' })
    ));
    exitMultiSelect();
    fetchMods();
  };

  const handleBulkDisable = async () => {
    const targets = filteredMods.filter(m => selected.has(m.name) && m.enabled);
    await Promise.all(targets.map(m =>
      fetch(`http://localhost:3001/api/servers/${serverId}/mods/${encodeURIComponent(m.name)}/toggle`, { method: 'POST' })
    ));
    exitMultiSelect();
    fetchMods();
  };

  const handleBulkDelete = async () => {
    await Promise.all([...selected].map(name =>
      fetch(`http://localhost:3001/api/servers/${serverId}/mods/${encodeURIComponent(name)}`, { method: 'DELETE' })
    ));
    setBulkDeleteConfirm(false);
    exitMultiSelect();
    fetchMods();
  };

  // ── Single-mod actions ─────────────────────────────────────────────────────
  const handleToggle = async (mod) => {
    const originalName = mod.name;
    setToggling(prev => ({ ...prev, [originalName]: true }));
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${serverId}/mods/${encodeURIComponent(originalName)}/toggle`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to toggle mod');
      setMods(prev => prev.map(m => m.name === originalName
        ? { ...m, name: data.newName, displayName: data.newName.replace('.disabled', ''), enabled: data.enabled }
        : m
      ));
    } catch (err) {
      console.error(err);
      if (onError) onError(err.message);
    }
    setToggling(prev => { const next = { ...prev }; delete next[originalName]; return next; });
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${serverId}/mods/${encodeURIComponent(deleteTarget)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete mod');
      setMods(mods.filter(m => m.name !== deleteTarget));
    } catch (err) {
      console.error(err);
      if (onError) onError(err.message);
    }
    setDeleteTarget(null);
  };

  // ── Bulk repair actions ────────────────────────────────────────────────────
  const handleCleanClientOnly = async () => {
    if (cleaning) return;
    setCleaning(true);
    setCleanResult(null);
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${serverId}/mods/clean-client-only`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to clean client mods');
      setCleanResult(data);
      fetchMods();
    } catch (err) {
      if (onError) onError(err.message);
    }
    setCleaning(false);
  };

  const handleRepairVersions = async () => {
    if (repairing) return;
    setRepairing(true);
    setRepairResult(null);
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${serverId}/mods/repair-versions`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to repair mod versions');
      setRepairResult(data);
      fetchMods();
    } catch (err) {
      if (onError) onError(err.message);
    }
    setRepairing(false);
  };

  const handleExportZip = () => {
    if (exporting || mods.length === 0) return;
    setExporting(true);
    // Trigger browser download — set a short window then reset state
    window.location.href = `http://localhost:3001/api/servers/${serverId}/mods/export-zip`;
    setTimeout(() => setExporting(false), 2500);
  };

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    // Single zip → still ask whether to extract as a modpack. For anything
    // else (jars, or multiple files), batch-upload them straight into mods/.
    if (files.length === 1 && files[0].name.endsWith('.zip')) {
      setModpackFile(files[0]);
      return;
    }
    uploadFiles(files);
  };

  // Single-file upload kept for the modpack-extract path, which the backend
  // refuses to do for more than one file (overrides would interleave).
  const uploadFile = async (file, isModpack) => {
    const formData = new FormData();
    formData.append('modFile', file);
    if (isModpack) formData.append('isModpack', 'true');
    try {
      setLoading(true);
      const res = await fetch(`http://localhost:3001/api/servers/${serverId}/mods/upload`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      fetchMods();
    } catch (err) {
      console.error(err);
      if (onError) onError(err.message);
      setLoading(false);
    }
  };

  // Multi-file upload — used by the file picker (when more than one is
  // selected) AND by the drag-and-drop overlay. Sends all files in one
  // request; the backend reports per-file success/failure so a single bad
  // file doesn't fail the whole batch.
  const uploadFiles = async (fileList) => {
    const list = Array.from(fileList || []).filter(Boolean);
    if (list.length === 0) return;
    const formData = new FormData();
    for (const f of list) formData.append('modFile', f);
    try {
      setLoading(true);
      const res = await fetch(`http://localhost:3001/api/servers/${serverId}/mods/upload`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok && res.status !== 207) throw new Error(data.error || 'Upload failed');
      if (Array.isArray(data.failed) && data.failed.length > 0) {
        const f = data.failed[0];
        if (onError) onError(`${f.filename}: ${f.reason}${data.failed.length > 1 ? ` (+${data.failed.length - 1} more)` : ''}`);
      }
      fetchMods();
    } catch (err) {
      console.error(err);
      if (onError) onError(err.message);
      setLoading(false);
    }
  };

  // ── Drag-and-drop on the panel — works whether the user is on the
  // Installed view, Browse, or anywhere else within ModsViewer. Counter-based
  // depth tracking (rather than a bool) keeps the overlay from flickering as
  // the cursor passes over child elements.
  const [dragDepth, setDragDepth] = useState(0);
  const dragActive = dragDepth > 0;
  const handleDragEnter = (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    setDragDepth(d => d + 1);
  };
  const handleDragOver = (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const handleDragLeave = (e) => {
    e.preventDefault();
    setDragDepth(d => Math.max(0, d - 1));
  };
  const handleDrop = async (e) => {
    e.preventDefault();
    setDragDepth(0);
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    // Single .zip → treat as a modpack candidate (existing behaviour).
    // Anything else → multi-upload straight into mods/.
    if (files.length === 1 && files[0].name.endsWith('.zip')) {
      setModpackFile(files[0]);
      return;
    }
    await uploadFiles(files);
  };

  const filteredMods = mods.filter(m => {
    const matchesSearch = (m.displayName || m.name).toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || (statusFilter === 'enabled' ? m.enabled : !m.enabled);
    return matchesSearch && matchesStatus;
  });

  const enabledCount = mods.filter(m => m.enabled).length;
  const disabledCount = mods.filter(m => !m.enabled).length;
  const canEnableSelected = filteredMods.some(m => selected.has(m.name) && !m.enabled);
  const canDisableSelected = filteredMods.some(m => selected.has(m.name) && m.enabled);
  const clientOnlyCount = mods.filter(m => m.clientOnly).length;
  const wrongVersionCount = mods.filter(m => (m.wrongVersion || m.wrongLoader) && !m.clientOnly).length;

  return (
    <div
      className="flex-1 bg-[#111111] rounded-2xl border border-[#2D2D2D] flex flex-col overflow-hidden relative"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay — same shape as the launcher's so the experience is
          consistent across launcher and server panels. */}
      <AnimatePresence>
        {dragActive && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-[#00AF5C]/10 backdrop-blur-sm border-2 border-dashed border-[#00AF5C] rounded-2xl pointer-events-none"
          >
            <Upload size={36} className="text-[#00AF5C] mb-2" />
            <p className="text-sm font-bold text-white">Drop to upload</p>
            <p className="text-xs text-[#A0A0A0] mt-1">.jar mods · single .zip modpack · multiple files OK</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Single Delete Confirmation */}
      <AnimatePresence>
        {deleteTarget && (
          <ModalPortal>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#000000]/80 z-[100] flex items-center justify-center backdrop-blur-sm">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
              className="bg-[#1A1A1A] border border-[#2D2D2D] p-6 rounded-3xl w-full max-w-md shadow-2xl mx-4">
              <h3 className="text-xl font-bold text-[#FFFFFF] mb-2">Delete Mod</h3>
              <p className="text-[#A0A0A0] text-sm mb-6 leading-relaxed">
                Are you sure you want to permanently delete <span className="text-white font-bold">{deleteTarget}</span>? This action cannot be undone.
              </p>
              <div className="flex justify-end gap-3 pt-4 border-t border-[#2D2D2D]">
                <button onClick={() => setDeleteTarget(null)}
                  className="px-4 py-2 bg-[#111111] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#FFFFFF] rounded-xl text-sm font-bold transition-all duration-200">
                  Cancel
                </button>
                <button onClick={confirmDelete}
                  className="px-4 py-2 bg-[#FF5555] hover:bg-[#FF4444] text-white rounded-xl text-sm font-bold transition-all duration-200 flex items-center gap-2">
                  <Trash2 size={16} /> Delete
                </button>
              </div>
            </motion.div>
          </motion.div>
          </ModalPortal>
        )}
      </AnimatePresence>

      {/* Bulk Delete Confirmation */}
      <AnimatePresence>
        {bulkDeleteConfirm && (
          <ModalPortal>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#000000]/80 z-[100] flex items-center justify-center backdrop-blur-sm">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
              className="bg-[#1A1A1A] border border-[#2D2D2D] p-6 rounded-3xl w-full max-w-md shadow-2xl mx-4">
              <h3 className="text-xl font-bold text-[#FFFFFF] mb-2">Delete {selected.size} Mod{selected.size !== 1 ? 's' : ''}</h3>
              <p className="text-[#A0A0A0] text-sm mb-6 leading-relaxed">
                Permanently delete <span className="text-white font-bold">{selected.size}</span> selected mod{selected.size !== 1 ? 's' : ''}? This cannot be undone.
              </p>
              <div className="flex justify-end gap-3 pt-4 border-t border-[#2D2D2D]">
                <button onClick={() => setBulkDeleteConfirm(false)}
                  className="px-4 py-2 bg-[#111111] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#FFFFFF] rounded-xl text-sm font-bold transition-all duration-200">
                  Cancel
                </button>
                <button onClick={handleBulkDelete}
                  className="px-4 py-2 bg-[#FF5555] hover:bg-[#FF4444] text-white rounded-xl text-sm font-bold transition-all duration-200 flex items-center gap-2">
                  <Trash2 size={16} /> Delete All
                </button>
              </div>
            </motion.div>
          </motion.div>
          </ModalPortal>
        )}
      </AnimatePresence>

      {/* Modpack Extraction Modal */}
      <AnimatePresence>
        {modpackFile && (
          <ModalPortal>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#000000]/80 z-[100] flex items-center justify-center backdrop-blur-sm">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
              className="bg-[#1A1A1A] border border-[#2D2D2D] p-6 rounded-3xl w-full max-w-md shadow-2xl mx-4">
              <h3 className="text-xl font-bold text-[#FFFFFF] mb-2">Extract Modpack</h3>
              <p className="text-[#A0A0A0] text-sm mb-6 leading-relaxed">
                You selected <span className="text-white font-bold">{modpackFile.name}</span>. Do you want to extract this as a modpack?
              </p>
              <div className="flex justify-end gap-3 pt-4 border-t border-[#2D2D2D]">
                <button onClick={() => { uploadFile(modpackFile, false); setModpackFile(null); }}
                  className="px-4 py-2 bg-[#111111] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#FFFFFF] rounded-xl text-sm font-bold transition-all duration-200">
                  Upload as Mod
                </button>
                <button onClick={() => setModpackFile(null)}
                  className="px-4 py-2 bg-[#111111] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#FFFFFF] rounded-xl text-sm font-bold transition-all duration-200">
                  Cancel
                </button>
                <button onClick={() => { uploadFile(modpackFile, true); setModpackFile(null); }}
                  className="px-4 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-sm font-bold transition-all duration-200 flex items-center gap-2">
                  Extract Modpack
                </button>
              </div>
            </motion.div>
          </motion.div>
          </ModalPortal>
        )}
      </AnimatePresence>

      {/* Tabs */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-[#2D2D2D] bg-[#1A1A1A]">
        <div className="flex items-center gap-1">
          <button onClick={() => { setViewMode('installed'); exitMultiSelect(); }}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-bold rounded-xl transition-all duration-200 ${
              viewMode === 'installed'
                ? 'bg-[#1E1E1E] text-[#FFFFFF] border border-[#2D2D2D]'
                : 'text-[#A0A0A0] hover:text-[#FFFFFF] border border-transparent hover:bg-[#1E1E1E]'
            }`}>
            <FolderOpen size={16} />
            Installed
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${viewMode === 'installed' ? 'bg-[#00AF5C]/10 text-[#00AF5C]' : 'bg-[#2D2D2D] text-[#555555]'}`}>
              {mods.length}
            </span>
          </button>
          <button onClick={() => { setViewMode('browse'); exitMultiSelect(); }}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-bold rounded-xl transition-all duration-200 ${
              viewMode === 'browse'
                ? 'bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/20'
                : 'text-[#A0A0A0] hover:text-[#FFFFFF] border border-transparent hover:bg-[#1E1E1E]'
            }`}>
            <Globe size={16} />
            Browse Mods
          </button>
          <button onClick={() => { setViewMode('modpacks'); exitMultiSelect(); }}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-bold rounded-xl transition-all duration-200 ${
              viewMode === 'modpacks'
                ? 'bg-violet-500/10 text-violet-400 border border-violet-500/20'
                : 'text-[#A0A0A0] hover:text-[#FFFFFF] border border-transparent hover:bg-[#1E1E1E]'
            }`}>
            <Layers size={16} />
            Modpacks
          </button>
          <button onClick={() => { setViewMode('datapacks'); exitMultiSelect(); }}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-bold rounded-xl transition-all duration-200 ${
              viewMode === 'datapacks'
                ? 'bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/20'
                : 'text-[#A0A0A0] hover:text-[#FFFFFF] border border-transparent hover:bg-[#1E1E1E]'
            }`}>
            <Database size={16} />
            Data Packs
          </button>
        </div>

        {viewMode === 'installed' && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 border-r border-[#2D2D2D] pr-3">
              {[
                { key: 'all', label: 'All', count: mods.length },
                { key: 'enabled', label: 'Enabled', count: enabledCount },
                { key: 'disabled', label: 'Disabled', count: disabledCount },
              ].map(f => (
                <button key={f.key} onClick={() => setStatusFilter(f.key)}
                  className={`px-2.5 py-1.5 text-xs font-bold rounded-lg transition-all duration-200 flex items-center gap-1.5 ${
                    statusFilter === f.key ? 'bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/20' : 'text-[#555555] hover:text-[#A0A0A0] border border-transparent hover:border-[#2D2D2D]'
                  }`}>
                  {f.label}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${statusFilter === f.key ? 'bg-[#00AF5C]/20 text-[#00AF5C]' : 'bg-[#2D2D2D] text-[#555555]'}`}>{f.count}</span>
                </button>
              ))}
            </div>
            <input type="file" ref={fileInputRef} className="hidden" multiple accept=".jar,.zip" onChange={handleFileSelect} />
            <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
              onClick={handleExportZip}
              disabled={exporting || mods.length === 0}
              title={mods.length === 0 ? 'No mods to export' : 'Download all mods as a ZIP'}
              className="flex items-center gap-2 px-4 py-2 bg-[#1E1E1E] hover:bg-[#2D2D2D] text-[#FFFFFF] border border-[#2D2D2D] rounded-xl font-bold text-sm transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed">
              {exporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
              <span>{exporting ? 'Exporting...' : 'Download ZIP'}</span>
            </motion.button>
            <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 bg-[#1E1E1E] hover:bg-[#2D2D2D] text-[#FFFFFF] border border-[#2D2D2D] rounded-xl font-bold text-sm transition-all duration-200">
              <Upload size={16} />
              <span>Upload</span>
            </motion.button>
          </div>
        )}
      </div>

      {/* Content */}
      {viewMode === 'browse' ? (
        <div className="flex-1 overflow-hidden p-4 flex flex-col">
          <ModrinthBrowser serverId={serverId} serverVersion={serverVersion} serverType={serverType} socket={socket} onInstalled={fetchMods} projectType="mod" modpackInstalls={modpackInstalls} />
        </div>
      ) : viewMode === 'modpacks' ? (
        <div className="flex-1 overflow-hidden p-4 flex flex-col">
          <ModrinthBrowser serverId={serverId} serverVersion={serverVersion} serverType={serverType} socket={socket} onInstalled={fetchMods} projectType="modpack" modpackInstalls={modpackInstalls} />
        </div>
      ) : viewMode === 'datapacks' ? (
        <div className="flex-1 overflow-hidden p-4 flex flex-col">
          <ModrinthBrowser serverId={serverId} serverVersion={serverVersion} serverType={serverType} socket={socket} onInstalled={fetchMods} projectType="datapack" modpackInstalls={modpackInstalls} />
        </div>
      ) : (
        <>
          {/* Issues banner — only when there's something to act on */}
          {(clientOnlyCount > 0 || wrongVersionCount > 0) && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="mx-4 mt-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl flex items-center gap-3"
            >
              <div className="p-2 bg-amber-500/15 rounded-xl flex-shrink-0">
                <AlertTriangle size={18} className="text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-white">
                  {clientOnlyCount > 0 && (
                    <>{clientOnlyCount} client-only mod{clientOnlyCount !== 1 ? 's' : ''} would crash the server</>
                  )}
                  {clientOnlyCount > 0 && wrongVersionCount > 0 && <span className="text-[#A0A0A0]"> · </span>}
                  {wrongVersionCount > 0 && (
                    <>{wrongVersionCount} mod{wrongVersionCount !== 1 ? 's are' : ' is'} on the wrong version/loader</>
                  )}
                </p>
                <p className="text-xs text-[#A0A0A0] mt-0.5">
                  {clientOnlyCount > 0 && 'Client-only mods will be moved to the client stash.'}
                  {clientOnlyCount > 0 && wrongVersionCount > 0 && ' '}
                  {wrongVersionCount > 0 && 'Wrong-version mods will be replaced with a compatible build from Modrinth.'}
                </p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {clientOnlyCount > 0 && (
                  <motion.button
                    whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                    onClick={handleCleanClientOnly}
                    disabled={cleaning}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 border border-amber-500/30 rounded-xl text-xs font-bold transition-all disabled:opacity-50"
                  >
                    {cleaning ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}
                    {cleaning ? 'Cleaning…' : 'Clean client mods'}
                  </motion.button>
                )}
                {wrongVersionCount > 0 && (
                  <motion.button
                    whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                    onClick={handleRepairVersions}
                    disabled={repairing}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-[#00AF5C]/15 hover:bg-[#00AF5C]/25 text-[#00AF5C] border border-[#00AF5C]/30 rounded-xl text-xs font-bold transition-all disabled:opacity-50"
                  >
                    {repairing ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />}
                    {repairing ? 'Repairing…' : 'Repair versions'}
                  </motion.button>
                )}
              </div>
            </motion.div>
          )}

          {/* Result toast (from a recently-completed clean / repair) */}
          {cleanResult && cleanResult.moved && (
            <div className="mx-4 mt-2 px-3 py-2 text-xs text-[#A0A0A0] bg-[#1E1E1E] border border-[#2D2D2D] rounded-xl">
              {cleanResult.moved.length === 0
                ? 'No client-only mods to move — your mods folder is clean.'
                : `Moved ${cleanResult.moved.length} client-only mod(s) into the client stash.`}
            </div>
          )}
          {repairResult && (
            <div className="mx-4 mt-2 px-3 py-2 text-xs text-[#A0A0A0] bg-[#1E1E1E] border border-[#2D2D2D] rounded-xl">
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

          {/* Search bar */}
          <div className="px-6 py-3 border-b border-[#2D2D2D]">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A0A0A0]" />
              <input type="text" placeholder="Search installed mods..." value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] rounded-xl text-sm text-[#FFFFFF] outline-none transition-all duration-300 placeholder-[#555555] focus:ring-4 focus:ring-[#00AF5C]/10"
              />
            </div>
            {!multiSelect && mods.length > 0 && (
              <p className="text-[10px] text-[#555555] mt-1.5 pl-1">Long-press a mod to select multiple</p>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
            {loading ? (
              <div className="flex items-center justify-center h-full text-[#A0A0A0] font-medium">
                <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}>
                  <Package size={20} className="mr-3" />
                </motion.div>
                Loading mods...
              </div>
            ) : filteredMods.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-[#555555] font-medium">
                <Package size={48} className="mb-4 opacity-30" />
                <p>No mods found.</p>
                {searchQuery && <p className="text-sm mt-1">Try adjusting your search query.</p>}
              </div>
            ) : (
              <div className="space-y-2 p-2 pb-20">
                {filteredMods.map((mod, idx) => {
                  const isSelected = selected.has(mod.name);
                  return (
                    <motion.div
                      key={mod.name}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.03, duration: 0.3 }}
                      onMouseDown={() => startLongPress(mod.name)}
                      onMouseUp={() => { cancelLongPress(); handleCardClick(mod); }}
                      onMouseLeave={cancelLongPress}
                      onTouchStart={() => startLongPress(mod.name)}
                      onTouchEnd={() => { cancelLongPress(); handleCardClick(mod); }}
                      className={`flex items-center justify-between p-4 rounded-2xl border transition-all duration-200 group select-none cursor-pointer
                        ${multiSelect
                          ? isSelected
                            ? 'bg-[#00AF5C]/5 border-[#00AF5C]/40'
                            : 'bg-[#1E1E1E] border-[#2D2D2D]'
                          : 'bg-[#1E1E1E] border-[#2D2D2D] hover:border-[#555555]'}
                        ${!mod.enabled ? 'opacity-60' : ''}
                      `}
                    >
                      <div className="flex items-center gap-4 min-w-0 flex-1">
                        {/* Icon / checkbox */}
                        <div className="relative flex-shrink-0">
                          <div className={`w-12 h-12 rounded-xl border border-[#2D2D2D] overflow-hidden bg-[#111111] flex items-center justify-center transition-all duration-300 ${!multiSelect ? 'group-hover:scale-110' : ''}`}>
                            {mod.iconUrl
                              ? <img src={mod.iconUrl} alt="" className="w-full h-full object-cover" onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }} />
                              : null}
                            <div className={`w-full h-full items-center justify-center ${mod.iconUrl ? 'hidden' : 'flex'} ${mod.enabled ? 'text-[#00AF5C]' : 'text-[#555555]'}`}>
                              <Package size={20} />
                            </div>
                          </div>
                          {/* Checkbox overlay in multi-select mode */}
                          <AnimatePresence>
                            {multiSelect && (
                              <motion.div
                                initial={{ opacity: 0, scale: 0.7 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.7 }}
                                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                                className={`absolute inset-0 rounded-xl flex items-center justify-center border-2 transition-colors duration-200 ${
                                  isSelected ? 'bg-[#00AF5C] border-[#00AF5C]' : 'bg-[#000000]/30 border-[#555555]'
                                }`}
                              >
                                {isSelected && <Check size={18} className="text-white" strokeWidth={3} />}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>

                        <div className="min-w-0">
                          <div className="flex items-center gap-2 min-w-0 flex-wrap">
                            <h4 className="font-bold text-[#FFFFFF] truncate">{mod.displayName || mod.name}</h4>
                            {mod.clientOnly && (
                              <span title="Client-only — will crash a dedicated server"
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-bold bg-amber-500/15 text-amber-400 border border-amber-500/30 rounded-md flex-shrink-0">
                                <Monitor size={10} /> Client
                              </span>
                            )}
                            {!mod.clientOnly && mod.wrongVersion && (
                              <span title="This mod's jar doesn't list this server's Minecraft version as supported"
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-bold bg-[#FF5555]/15 text-[#FF5555] border border-[#FF5555]/30 rounded-md flex-shrink-0">
                                <AlertTriangle size={10} /> Wrong version
                              </span>
                            )}
                            {!mod.clientOnly && !mod.wrongVersion && mod.wrongLoader && (
                              <span title="This jar is built for a different mod loader than the server"
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-bold bg-[#FF5555]/15 text-[#FF5555] border border-[#FF5555]/30 rounded-md flex-shrink-0">
                                <AlertTriangle size={10} /> Wrong loader
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-[#A0A0A0] mt-1">{mod.size}</p>
                        </div>
                      </div>

                      {/* Per-card actions — hidden in multi-select mode */}
                      {!multiSelect && (
                        <div className="flex items-center gap-3 flex-shrink-0">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleToggle(mod); }}
                            disabled={!!toggling[mod.name]}
                            className={`w-12 h-7 rounded-full relative transition-all duration-300 flex-shrink-0 ${mod.enabled ? 'bg-[#00AF5C] shadow-[0_0_12px_rgba(0,175,92,0.3)]' : 'bg-[#333333]'} ${toggling[mod.name] ? 'opacity-50' : 'hover:shadow-lg'}`}
                            title={mod.enabled ? 'Disable mod' : 'Enable mod'}
                          >
                            <motion.div
                              className="absolute top-1 w-5 h-5 bg-white rounded-full shadow-md"
                              animate={{ left: mod.enabled ? '24px' : '4px' }}
                              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                            />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setDeleteTarget(mod.name); }}
                            className="p-2 text-[#A0A0A0] hover:text-[#FF5555] hover:bg-[#FF5555]/10 rounded-xl transition-all duration-200 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:scale-110"
                            title="Delete Mod"
                          >
                            <Trash2 size={18} />
                          </button>
                        </div>
                      )}
                    </motion.div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Multi-select action bar */}
          <AnimatePresence>
            {multiSelect && (
              <motion.div
                initial={{ y: 80, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 80, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                className="absolute bottom-3 left-3 right-3 bg-[#1A1A1A] border border-[#2D2D2D] rounded-2xl px-4 py-3 flex items-center justify-between shadow-[0_8px_30px_rgba(0,0,0,0.5)] z-20"
              >
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleSelectAll}
                    className="flex items-center gap-1.5 text-xs font-bold text-[#A0A0A0] hover:text-[#FFFFFF] transition-colors"
                  >
                    {selected.size === filteredMods.length
                      ? <><CheckSquare size={14} className="text-[#00AF5C]" /> Deselect all</>
                      : <><Square size={14} /> Select all</>
                    }
                  </button>
                  <div className="w-px h-4 bg-[#2D2D2D]" />
                  <span className="text-sm font-bold text-[#FFFFFF]">
                    {selected.size} selected
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleBulkEnable}
                    disabled={!canEnableSelected}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-[#00AF5C]/10 hover:bg-[#00AF5C]/20 text-[#00AF5C] border border-[#00AF5C]/20 rounded-xl text-xs font-bold transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ToggleRight size={14} /> Enable
                  </button>
                  <button
                    onClick={handleBulkDisable}
                    disabled={!canDisableSelected}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-[#111111] hover:bg-[#2D2D2D] text-[#A0A0A0] border border-[#2D2D2D] rounded-xl text-xs font-bold transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ToggleLeft size={14} /> Disable
                  </button>
                  <button
                    onClick={() => setBulkDeleteConfirm(true)}
                    disabled={selected.size === 0}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-[#FF5555]/10 hover:bg-[#FF5555]/20 text-[#FF5555] border border-[#FF5555]/20 rounded-xl text-xs font-bold transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                  <div className="w-px h-4 bg-[#2D2D2D]" />
                  <button
                    onClick={exitMultiSelect}
                    className="px-3 py-1.5 text-xs font-bold text-[#555555] hover:text-[#A0A0A0] transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
}

export default ModsViewer;
