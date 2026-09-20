import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Folder, FileText, FileCode, FileArchive, FileImage, File as FileIcon,
  Loader2, Trash2, Pencil, Download, Upload, RefreshCw, FolderPlus, Home,
  ChevronRight, Save, X, AlertTriangle, PackageOpen, Search, CornerLeftUp,
} from 'lucide-react';
import ModalPortal from './ModalPortal';
import Tooltip from './Tooltip';

function humanBytes(n) {
  if (n == null) return '';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}
function fmtWhen(ms) {
  if (!ms) return '';
  try {
    const d = new Date(ms);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
      + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

const CODE_EXT = new Set(['.json', '.json5', '.toml', '.yml', '.yaml', '.cfg', '.conf', '.ini', '.properties', '.mcmeta', '.mcfunction', '.snbt', '.xml', '.js', '.ts', '.sh', '.bat']);
const ARCHIVE_EXT = new Set(['.zip', '.jar', '.gz', '.tar', '.rar', '.7z']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico']);

function entryIcon(entry) {
  if (entry.isDir) return <Folder size={16} className="text-[#00AF5C]" />;
  const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
  if (ARCHIVE_EXT.has(ext)) return <FileArchive size={16} className="text-amber-400" />;
  if (IMAGE_EXT.has(ext)) return <FileImage size={16} className="text-violet-400" />;
  if (CODE_EXT.has(ext)) return <FileCode size={16} className="text-[var(--c-text-secondary)]" />;
  if (entry.editable) return <FileText size={16} className="text-[var(--c-text-secondary)]" />;
  return <FileIcon size={16} className="text-[var(--c-text-muted)]" />;
}

// Server file manager. Every other panel in MineDash is a curated view of a few
// known files; this is the escape hatch for the long tail — ops.json, a mod's
// config TOML, a plugin's own yml — so you don't have to leave the app to touch
// them.
//
// Paths are relative to the instance folder and travel as `?path=` query
// strings; the backend (backend/server-files.js) funnels every one through a
// single traversal check.
function FilesViewer({ serverId, onError }) {
  const [cwd, setCwd] = useState('');
  const [data, setData] = useState(null);       // { entries, running } | null while loading
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(null);        // entry path with an action in flight
  const [uploading, setUploading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  // Editor state. `editor.dirty` drives the save bar; closing with unsaved
  // changes asks first, because losing a hand-edited config is a real cost.
  const [editor, setEditor] = useState(null);    // { path, name, content, original, saving }
  const [confirmClose, setConfirmClose] = useState(false);

  const fileRef = useRef(null);
  const base = `http://localhost:3001/api/servers/${serverId}`;

  const fetchDir = useCallback(async (dir) => {
    try {
      const r = await fetch(`${base}/files?path=${encodeURIComponent(dir)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to read folder');
      setData(d);
    } catch (err) {
      onError?.(err.message);
      setData({ path: dir, entries: [], running: false });
    }
  }, [base, onError]);

  // The listing carries the path it's for, so "still loading" is derived by
  // comparing it to the folder we want rather than blanking state in an effect
  // (which the repo's ESLint flags as set-state-in-effect).
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-navigate; setState lands asynchronously in the promise
  useEffect(() => { fetchDir(cwd); }, [cwd, fetchDir]);
  const loading = data === null || data.path !== cwd;

  const refresh = () => fetchDir(cwd);

  const req = async (url, opts) => {
    const r = await fetch(url, opts);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Request failed');
    return d;
  };
  const json = (body) => ({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  const act = async (key, fn) => {
    setBusy(key);
    try { await fn(); await refresh(); }
    catch (err) { onError?.(err.message); }
    setBusy(null);
  };

  const openEntry = async (entry) => {
    if (entry.isDir) { setCwd(entry.path); setFilter(''); return; }
    if (!entry.editable) return;
    setBusy(entry.path);
    try {
      const d = await req(`${base}/files/content?path=${encodeURIComponent(entry.path)}`);
      setEditor({ path: entry.path, name: entry.name, content: d.content, original: d.content, saving: false });
    } catch (err) { onError?.(err.message); }
    setBusy(null);
  };

  const saveEditor = async () => {
    if (!editor) return;
    setEditor(e => ({ ...e, saving: true }));
    try {
      await req(`${base}/files/content?path=${encodeURIComponent(editor.path)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editor.content }),
      });
      setEditor(e => ({ ...e, original: e.content, saving: false }));
      await refresh();
    } catch (err) {
      onError?.(err.message);
      setEditor(e => ({ ...e, saving: false }));
    }
  };

  const closeEditor = () => {
    if (editor && editor.content !== editor.original) { setConfirmClose(true); return; }
    setEditor(null);
  };

  const uploadFiles = async (list) => {
    const files = Array.from(list || []);
    if (files.length === 0) return;
    setUploading(true);
    try {
      const fd = new FormData();
      for (const f of files) fd.append('file', f);
      const r = await fetch(`${base}/files/upload?path=${encodeURIComponent(cwd)}`, { method: 'POST', body: fd });
      const d = await r.json().catch(() => ({}));
      // 207 means some landed and some didn't — still a partial success.
      if (!r.ok && r.status !== 207) throw new Error(d.error || 'Upload failed');
      if (d.failed?.length > 0) {
        const f = d.failed[0];
        onError?.(`${f.filename}: ${f.reason}${d.failed.length > 1 ? ` (+${d.failed.length - 1} more)` : ''}`);
      }
      await refresh();
    } catch (err) { onError?.(err.message); }
    setUploading(false);
  };

  // ── Drag-and-drop into the current folder ───────────────────────────────────
  const [dragDepth, setDragDepth] = useState(0);
  const dragActive = dragDepth > 0 && !uploading;
  const handleDragEnter = (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault(); setDragDepth(d => d + 1);
  };
  const handleDragOver = (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  };
  const handleDragLeave = (e) => { e.preventDefault(); setDragDepth(d => Math.max(0, d - 1)); };
  const handleDrop = async (e) => {
    e.preventDefault(); setDragDepth(0);
    await uploadFiles(e.dataTransfer?.files);
  };

  // Ctrl/Cmd-S saves from inside the editor — muscle memory for anyone who got
  // here by way of a text editor, which is everyone.
  useEffect(() => {
    if (!editor) return;
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveEditor(); }
      else if (e.key === 'Escape' && !confirmClose) { e.preventDefault(); closeEditor(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, confirmClose]);

  const segments = cwd ? cwd.split('/') : [];
  const entries = (data?.entries || []).filter(e =>
    !filter || e.name.toLowerCase().includes(filter.toLowerCase()));
  const dirty = editor && editor.content !== editor.original;

  return (
    <div
      className="flex-1 bg-[var(--c-base)] rounded-2xl border border-[var(--c-border)] flex flex-col overflow-hidden relative"
      onDragEnter={handleDragEnter} onDragOver={handleDragOver}
      onDragLeave={handleDragLeave} onDrop={handleDrop}
    >
      <AnimatePresence>
        {dragActive && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}
            className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-[#00AF5C]/10 backdrop-blur-sm border-2 border-dashed border-[#00AF5C] rounded-2xl pointer-events-none">
            <Upload size={36} className="text-[#00AF5C] mb-2" />
            <p className="text-sm font-bold text-white">Drop to upload</p>
            <p className="text-xs text-[var(--c-text-secondary)] mt-1 font-mono">
              into /{cwd || ''}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete confirmation */}
      <AnimatePresence>
        {pendingDelete && (
          <ModalPortal>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 bg-[#000000]/80 z-[100] flex items-center justify-center backdrop-blur-sm">
              <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
                transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
                className="bg-[var(--c-surface-1)] border border-[var(--c-border)] p-6 rounded-3xl w-full max-w-md shadow-2xl mx-4">
                <div className="flex items-center gap-3 mb-4">
                  <div className="p-2 bg-[var(--c-danger)]/10 rounded-xl"><Trash2 size={18} className="text-[var(--c-danger)]" /></div>
                  <h3 className="text-xl font-bold text-[var(--c-text-primary)]">
                    Delete {pendingDelete.isDir ? 'folder' : 'file'}
                  </h3>
                </div>
                <p className="text-[var(--c-text-secondary)] text-sm mb-6 leading-relaxed">
                  Permanently delete <span className="text-white font-bold font-mono">{pendingDelete.name}</span>
                  {pendingDelete.isDir ? ' and everything inside it' : ''}? This can't be undone.
                </p>
                <div className="flex justify-end gap-3 pt-4 border-t border-[var(--c-border)]">
                  <button onClick={() => setPendingDelete(null)}
                    className="px-4 py-2 bg-[var(--c-base)] hover:bg-[var(--c-border)] border border-[var(--c-border)] text-[var(--c-text-primary)] rounded-xl text-sm font-bold transition-all duration-200">
                    Cancel
                  </button>
                  <button onClick={() => {
                    const t = pendingDelete;
                    setPendingDelete(null);
                    act(t.path, () => req(`${base}/files?path=${encodeURIComponent(t.path)}`, { method: 'DELETE' }));
                  }}
                    className="px-4 py-2 bg-[var(--c-danger)] hover:bg-[var(--c-danger-hover)] text-white rounded-xl text-sm font-bold transition-all duration-200 flex items-center gap-2">
                    <Trash2 size={16} /> Delete
                  </button>
                </div>
              </motion.div>
            </motion.div>
          </ModalPortal>
        )}
      </AnimatePresence>

      {/* Unsaved-changes confirmation */}
      <AnimatePresence>
        {confirmClose && (
          <ModalPortal>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 bg-[#000000]/80 z-[110] flex items-center justify-center backdrop-blur-sm">
              <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
                transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
                className="bg-[var(--c-surface-1)] border border-[var(--c-border)] p-6 rounded-3xl w-full max-w-md shadow-2xl mx-4">
                <div className="flex items-center gap-3 mb-4">
                  <div className="p-2 bg-amber-500/10 rounded-xl"><AlertTriangle size={18} className="text-amber-400" /></div>
                  <h3 className="text-xl font-bold text-[var(--c-text-primary)]">Discard changes?</h3>
                </div>
                <p className="text-[var(--c-text-secondary)] text-sm mb-6 leading-relaxed">
                  You've edited <span className="text-white font-bold font-mono">{editor?.name}</span> without saving.
                </p>
                <div className="flex justify-end gap-3 pt-4 border-t border-[var(--c-border)]">
                  <button onClick={() => setConfirmClose(false)}
                    className="px-4 py-2 bg-[var(--c-base)] hover:bg-[var(--c-border)] border border-[var(--c-border)] text-[var(--c-text-primary)] rounded-xl text-sm font-bold transition-all duration-200">
                    Keep editing
                  </button>
                  <button onClick={() => { setConfirmClose(false); setEditor(null); }}
                    className="px-4 py-2 bg-[var(--c-danger)] hover:bg-[var(--c-danger-hover)] text-white rounded-xl text-sm font-bold transition-all duration-200">
                    Discard
                  </button>
                </div>
              </motion.div>
            </motion.div>
          </ModalPortal>
        )}
      </AnimatePresence>

      {/* Header: breadcrumbs + actions */}
      <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-[var(--c-border)] bg-[var(--c-surface-1)]">
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <button onClick={() => setCwd('')}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-sm font-bold transition-colors ${
              cwd ? 'text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)]' : 'text-[var(--c-text-primary)]'
            }`}>
            <Home size={14} /> Server files
          </button>
          {segments.map((seg, i) => {
            const target = segments.slice(0, i + 1).join('/');
            const last = i === segments.length - 1;
            return (
              <React.Fragment key={target}>
                <ChevronRight size={13} className="text-[var(--c-text-muted)] flex-shrink-0" />
                <button onClick={() => setCwd(target)} disabled={last}
                  className={`px-2 py-1 rounded-lg text-sm font-bold truncate max-w-[16rem] transition-colors ${
                    last ? 'text-[var(--c-text-primary)]' : 'text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)]'
                  }`}>
                  {seg}
                </button>
              </React.Fragment>
            );
          })}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--c-text-muted)] pointer-events-none" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…"
              className="w-40 bg-[var(--c-base)] border border-[var(--c-border)] rounded-xl pl-9 pr-3 py-2 text-sm text-[var(--c-text-primary)] placeholder:text-[var(--c-text-muted)] outline-none focus:border-[#00AF5C] focus:ring-4 focus:ring-[#00AF5C]/10 transition-all" />
          </div>
          <input type="file" ref={fileRef} multiple className="hidden"
            onChange={(e) => { const f = e.target.files; e.target.value = ''; uploadFiles(f); }} />
          <Tooltip content="Refresh" side="bottom" align="end">
            <button onClick={refresh}
              className="p-2 rounded-lg text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)] transition-colors">
              <RefreshCw size={14} />
            </button>
          </Tooltip>
          <Tooltip content="New folder" side="bottom" align="end">
            <button onClick={() => { setCreatingFolder(true); setNewFolderName(''); }}
              className="p-2 rounded-lg text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)] transition-colors">
              <FolderPlus size={14} />
            </button>
          </Tooltip>
          <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
            onClick={() => fileRef.current?.click()} disabled={uploading}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--c-surface-2)] hover:bg-[var(--c-border)] text-[var(--c-text-primary)] border border-[var(--c-border)] rounded-xl font-bold text-sm transition-all duration-200 disabled:opacity-40">
            {uploading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            <span>{uploading ? 'Uploading…' : 'Upload'}</span>
          </motion.button>
        </div>
      </div>

      {/* Running notice — files can be edited live, but the server won't see it
          until it restarts, and it may overwrite what you wrote on shutdown. */}
      {data?.running && (
        <div className="mx-4 mt-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl flex items-center gap-3">
          <div className="p-2 bg-amber-500/15 rounded-xl flex-shrink-0">
            <AlertTriangle size={18} className="text-amber-400" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-white">The server is running</p>
            <p className="text-xs text-[var(--c-text-secondary)] mt-0.5">
              You can still edit files, but the server won't pick up changes until it restarts — and it may
              overwrite files it owns (like server.properties) when it shuts down.
            </p>
          </div>
        </div>
      )}

      {/* Listing */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={18} className="text-[#00AF5C] animate-spin mr-2" />
            <span className="text-sm text-[var(--c-text-secondary)]">Loading…</span>
          </div>
        ) : (
          <div className="p-2">
            {/* New-folder row, inline at the top so it appears where it'll land */}
            {creatingFolder && (
              <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-[#00AF5C] bg-[var(--c-surface-2)] mb-1">
                <Folder size={16} className="text-[#00AF5C] flex-shrink-0" />
                <input autoFocus value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setCreatingFolder(false);
                    else if (e.key === 'Enter') {
                      const name = newFolderName.trim();
                      setCreatingFolder(false);
                      if (name) act(name, () => req(`${base}/files/mkdir?path=${encodeURIComponent(cwd)}`, json({ name })));
                    }
                  }}
                  onBlur={() => setCreatingFolder(false)}
                  placeholder="New folder name"
                  className="flex-1 bg-transparent text-sm font-bold text-[var(--c-text-primary)] placeholder:text-[var(--c-text-muted)] outline-none" />
              </div>
            )}

            {cwd && (
              <button onClick={() => setCwd(segments.slice(0, -1).join('/'))}
                className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-left hover:bg-[var(--c-surface-2)] transition-colors">
                <CornerLeftUp size={16} className="text-[var(--c-text-muted)] flex-shrink-0" />
                <span className="text-sm font-bold text-[var(--c-text-secondary)]">..</span>
              </button>
            )}

            {entries.length === 0 && !creatingFolder ? (
              <div className="flex flex-col items-center py-16 text-[var(--c-text-muted)]">
                <Folder size={32} className="mb-3 opacity-30" />
                <p className="text-sm font-bold text-[var(--c-text-secondary)]">
                  {filter ? 'Nothing matches that filter' : 'This folder is empty'}
                </p>
                {!filter && <p className="text-xs mt-1">Drop files anywhere on this panel to upload them here.</p>}
              </div>
            ) : entries.map((e, idx) => {
              const isBusy = busy === e.path;
              const isZip = !e.isDir && /\.zip$/i.test(e.name);
              return (
                <motion.div key={e.path}
                  initial={{ opacity: 0, y: 2 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(idx * 0.015, 0.3), duration: 0.15 }}
                  className="group flex items-center gap-3 px-4 py-2.5 rounded-xl hover:bg-[var(--c-surface-2)] transition-colors">
                  <div className="flex-shrink-0">{entryIcon(e)}</div>

                  {renaming === e.path ? (
                    <input autoFocus value={renameValue}
                      onChange={(ev) => setRenameValue(ev.target.value)}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Escape') setRenaming(null);
                        else if (ev.key === 'Enter') {
                          const next = renameValue.trim();
                          setRenaming(null);
                          if (next && next !== e.name) {
                            act(e.path, () => req(`${base}/files/rename?path=${encodeURIComponent(e.path)}`, json({ newName: next })));
                          }
                        }
                      }}
                      onBlur={() => setRenaming(null)}
                      className="flex-1 bg-[var(--c-base)] border border-[#00AF5C] rounded-lg px-2.5 py-1 text-sm font-bold text-[var(--c-text-primary)] outline-none" />
                  ) : (
                    <button onClick={() => openEntry(e)} disabled={!e.isDir && !e.editable}
                      className={`flex-1 min-w-0 text-left text-sm font-bold truncate transition-colors ${
                        e.isDir || e.editable
                          ? 'text-[var(--c-text-primary)] hover:text-[#00AF5C] cursor-pointer'
                          : 'text-[var(--c-text-secondary)] cursor-default'
                      }`}>
                      {e.name}
                    </button>
                  )}

                  <span className="text-xs text-[var(--c-text-muted)] tabular-nums w-20 text-right flex-shrink-0">
                    {e.isDir ? '' : humanBytes(e.sizeBytes)}
                  </span>
                  <span className="text-xs text-[var(--c-text-muted)] w-36 text-right flex-shrink-0 hidden lg:block">
                    {fmtWhen(e.modifiedAt)}
                  </span>

                  <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    {isBusy && <Loader2 size={14} className="text-[#00AF5C] animate-spin mr-1" />}
                    {isZip && (
                      <Tooltip content="Extract here" side="bottom" align="end">
                        <button onClick={() => act(e.path, () => req(`${base}/files/extract?path=${encodeURIComponent(e.path)}`, json({})))}
                          className="p-2 rounded-lg text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-base)] transition-colors">
                          <PackageOpen size={14} />
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip content={e.isDir ? 'Download as .zip' : 'Download'} side="bottom" align="end">
                      <a href={`${base}/files/download?path=${encodeURIComponent(e.path)}`} download
                        className="p-2 rounded-lg text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-base)] transition-colors block">
                        <Download size={14} />
                      </a>
                    </Tooltip>
                    <Tooltip content="Rename" side="bottom" align="end">
                      <button onClick={() => { setRenaming(e.path); setRenameValue(e.name); }}
                        className="p-2 rounded-lg text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-base)] transition-colors">
                        <Pencil size={14} />
                      </button>
                    </Tooltip>
                    <Tooltip content="Delete" side="bottom" align="end">
                      <button onClick={() => setPendingDelete(e)}
                        className="p-2 rounded-lg text-[var(--c-text-muted)] hover:text-[var(--c-danger)] hover:bg-[var(--c-base)] transition-colors">
                        <Trash2 size={14} />
                      </button>
                    </Tooltip>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>

      {/* Editor — an overlay rather than a route so the listing keeps its
          scroll position and the breadcrumb stays visible underneath. */}
      <AnimatePresence>
        {editor && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
            className="absolute inset-0 z-40 bg-[var(--c-base)] flex flex-col">
            <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-[var(--c-border)] bg-[var(--c-surface-1)]">
              <div className="flex items-center gap-3 min-w-0">
                <FileCode size={18} className="text-[var(--c-text-secondary)] flex-shrink-0" />
                <div className="min-w-0">
                  <p className="font-bold text-[var(--c-text-primary)] truncate">{editor.name}</p>
                  <p className="text-[11px] text-[var(--c-text-muted)] font-mono truncate">/{editor.path}</p>
                </div>
                {dirty && (
                  <span className="flex-shrink-0 text-[10px] uppercase tracking-wider font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2 py-0.5">
                    Unsaved
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <motion.button whileTap={{ scale: 0.97 }} onClick={saveEditor} disabled={!dirty || editor.saving}
                  className="flex items-center gap-2 px-4 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl font-bold text-sm transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed">
                  {editor.saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                  <span>{editor.saving ? 'Saving…' : 'Save'}</span>
                </motion.button>
                <button onClick={closeEditor}
                  className="p-2 rounded-xl text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)] transition-colors">
                  <X size={16} />
                </button>
              </div>
            </div>
            <textarea
              value={editor.content}
              onChange={(e) => setEditor(prev => ({ ...prev, content: e.target.value }))}
              onKeyDown={(e) => {
                // Tab indents instead of leaving the field — these are config
                // files and moving focus mid-edit is never what you wanted.
                if (e.key === 'Tab') {
                  e.preventDefault();
                  const el = e.target;
                  const { selectionStart: s, selectionEnd: en, value } = el;
                  const next = value.slice(0, s) + '  ' + value.slice(en);
                  setEditor(prev => ({ ...prev, content: next }));
                  requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 2; });
                }
              }}
              spellCheck={false}
              className="flex-1 w-full resize-none bg-[var(--c-base)] text-[var(--c-text-primary)] font-mono text-[13px] leading-relaxed p-6 outline-none custom-scrollbar" />
            <div className="px-6 py-2 border-t border-[var(--c-border)] bg-[var(--c-surface-1)] flex items-center justify-between">
              <span className="text-[11px] text-[var(--c-text-muted)]">
                {editor.content.split('\n').length} lines · {humanBytes(new Blob([editor.content]).size)}
              </span>
              <span className="text-[11px] text-[var(--c-text-muted)]">Ctrl+S to save · Esc to close</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default FilesViewer;
