import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Image as ImageIcon, Loader2, Trash2, X, ChevronLeft, ChevronRight, RefreshCw, Copy, Check, Download, Upload } from 'lucide-react';
import Tooltip from '../Tooltip';
import ModalPortal from '../ModalPortal';
import { TITLEBAR_OFFSET } from '../../lib/titlebar';

// Screenshots grid + lightbox for a launcher instance. Lifted out of
// InstanceWorldsModal so it can live as its own rail panel.
export default function InstanceScreenshotsPanel({ inst, onError }) {
  const [shots, setShots] = useState(null); // null = loading
  const [busy, setBusy] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [copying, setCopying] = useState(null);  // filename with a copy in flight
  const [copied, setCopied] = useState(null);    // filename that just copied (tick state)
  const [uploading, setUploading] = useState(false);
  const [dragDepth, setDragDepth] = useState(0);
  const fileRef = useRef(null);
  const base = `http://localhost:3001/api/launcher/instances/${encodeURIComponent(inst.id)}`;

  const fetchShots = async () => {
    try {
      const r = await fetch(`${base}/screenshots`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load screenshots');
      setShots(Array.isArray(d) ? d : []);
    } catch (err) { onError?.(err.message); setShots([]); }
  };
  useEffect(() => { fetchShots(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [inst.id]);

  const handleDelete = async (filename) => {
    setBusy(filename);
    try {
      const r = await fetch(`${base}/screenshots/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Delete failed');
      if (lightbox === filename) setLightbox(null);
      await fetchShots();
    } catch (err) { onError?.(err.message); }
    setBusy(null);
  };

  // ── Copy a screenshot to the clipboard ──────────────────────────────────────
  // Puts the actual image on the clipboard, so it pastes straight into Discord,
  // a message or an image editor — not a file path or a localhost URL.
  //
  // Browsers only accept image/png in a ClipboardItem, so a JPEG is repainted
  // through a canvas first. Minecraft's own F2 screenshots are already PNG;
  // this is for images that arrived here some other way.
  const handleCopy = async (filename) => {
    setCopying(filename);
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('This browser can\'t copy images to the clipboard.');
      }
      const res = await fetch(`${base}/screenshots/${encodeURIComponent(filename)}/file`);
      if (!res.ok) throw new Error('Could not read the screenshot');
      let blob = await res.blob();

      if (blob.type !== 'image/png') {
        blob = await new Promise((resolve, reject) => {
          const img = new Image();
          const url = URL.createObjectURL(blob);
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext('2d').drawImage(img, 0, 0);
            URL.revokeObjectURL(url);
            canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Conversion failed'))), 'image/png');
          };
          img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode the image')); };
          img.src = url;
        });
      }

      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied(filename);
      setTimeout(() => setCopied(c => (c === filename ? null : c)), 1500);
    } catch (err) {
      onError?.(err.message || 'Copy failed');
    }
    setCopying(null);
  };

  const uploadFiles = async (list) => {
    const files = Array.from(list || []).filter(f => /\.(png|jpe?g)$/i.test(f.name));
    if (files.length === 0) { onError?.('Screenshots must be .png or .jpg files.'); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      for (const f of files) fd.append('file', f);
      const r = await fetch(`${base}/screenshots`, { method: 'POST', body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 207) throw new Error(d.error || 'Upload failed');
      if (d.failed?.length > 0) {
        const f = d.failed[0];
        onError?.(`${f.filename}: ${f.reason}${d.failed.length > 1 ? ` (+${d.failed.length - 1} more)` : ''}`);
      }
      await fetchShots();
    } catch (err) { onError?.(err.message); }
    setUploading(false);
  };

  // ── Drag-and-drop ───────────────────────────────────────────────────────────
  const handleDragEnter = (e) => {
    if (uploading || !e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault(); setDragDepth(d => d + 1);
  };
  const handleDragOver = (e) => {
    if (uploading || !e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  };
  const handleDragLeave = (e) => { e.preventDefault(); setDragDepth(d => Math.max(0, d - 1)); };
  const handleDrop = async (e) => {
    if (uploading) return;
    e.preventDefault(); setDragDepth(0);
    await uploadFiles(e.dataTransfer?.files);
  };

  const lightboxIndex = lightbox && shots ? shots.findIndex(s => s.filename === lightbox) : -1;
  const step = (delta) => {
    if (lightboxIndex === -1) return;
    const next = lightboxIndex + delta;
    if (next < 0 || next >= shots.length) return;
    setLightbox(shots[next].filename);
  };
  useEffect(() => {
    if (!lightbox) return;
    const handler = (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (e.key === 'Escape') { e.preventDefault(); setLightbox(null); }
      // Ctrl/Cmd-C with a shot open copies it — the shortcut anyone viewing an
      // image full-screen will reach for first.
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); handleCopy(lightbox); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightbox, lightboxIndex, shots]);

  return (
    <div className="flex-1 min-h-0 flex flex-col relative"
      onDragEnter={handleDragEnter} onDragOver={handleDragOver}
      onDragLeave={handleDragLeave} onDrop={handleDrop}>
      <AnimatePresence>
        {dragDepth > 0 && !uploading && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}
            className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-[#00AF5C]/10 backdrop-blur-sm border-2 border-dashed border-[#00AF5C] rounded-2xl pointer-events-none">
            <Upload size={36} className="text-[#00AF5C] mb-2" />
            <p className="text-sm font-bold text-white">Drop images to add</p>
            <p className="text-xs text-[var(--c-text-secondary)] mt-1">.png or .jpg — they'll sit beside your in-game shots</p>
          </motion.div>
        )}
      </AnimatePresence>

      <input type="file" ref={fileRef} accept=".png,.jpg,.jpeg" multiple className="hidden"
        onChange={(e) => { const f = e.target.files; e.target.value = ''; uploadFiles(f); }} />

      <div className="flex items-center justify-between px-5 pt-5 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-[#00AF5C]/10 rounded-xl"><ImageIcon size={16} className="text-[#00AF5C]" /></div>
          <div>
            <h3 className="text-base font-bold text-[var(--c-text-primary)]">Screenshots</h3>
            <p className="text-[11px] text-[var(--c-text-secondary)]">{shots === null ? 'Loading…' : `${shots.length} screenshot${shots.length === 1 ? '' : 's'}`}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Tooltip content="Refresh" side="bottom" align="end">
            <button onClick={fetchShots} className="p-2 rounded-lg text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)] transition-colors">
              <RefreshCw size={14} />
            </button>
          </Tooltip>
          <motion.button onClick={() => fileRef.current?.click()} disabled={uploading} whileTap={{ scale: 0.97 }}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold bg-[var(--c-surface-2)] hover:bg-[var(--c-border)] border border-[var(--c-border)] text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] transition-colors disabled:opacity-50">
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Add images
          </motion.button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 pb-5">
        {shots === null ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={18} className="text-[#00AF5C] animate-spin mr-2" />
            <span className="text-sm text-[var(--c-text-secondary)]">Loading screenshots…</span>
          </div>
        ) : shots.length === 0 ? (
          <div className="flex flex-col items-center py-14 text-[var(--c-text-muted)]">
            <ImageIcon size={32} className="mb-3 opacity-30" />
            <p className="text-sm font-bold text-[var(--c-text-secondary)]">No screenshots yet</p>
            <p className="text-xs mt-1 max-w-xs text-center">Press F2 in-game — they'll show up here. You can also drop images onto this panel.</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {shots.map((s, idx) => (
              <motion.div key={s.filename}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                transition={{ delay: Math.min(idx * 0.02, 0.3), duration: 0.18 }}
                className="group relative aspect-video bg-[var(--c-base)] border border-[var(--c-border)] hover:border-[var(--c-text-muted)] rounded-xl overflow-hidden transition-colors">
                <img src={`${base}/screenshots/${encodeURIComponent(s.filename)}/file`} alt={s.filename} loading="lazy"
                  className="w-full h-full object-cover cursor-pointer" onClick={() => setLightbox(s.filename)} draggable={false} />
                <div className="absolute inset-x-0 bottom-0 px-2 py-1 bg-gradient-to-t from-[#000000]/80 to-transparent pointer-events-none">
                  <p className="text-[9px] text-white/80 truncate font-mono">{s.filename}</p>
                </div>
                <div className="absolute top-1 right-1 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Tooltip content={copied === s.filename ? 'Copied!' : 'Copy image'} side="bottom" align="end">
                    <button onClick={() => handleCopy(s.filename)} disabled={copying === s.filename}
                      className="p-1.5 rounded-lg bg-[#000000]/70 text-white hover:text-[#00AF5C] transition-colors disabled:opacity-50">
                      {copying === s.filename
                        ? <Loader2 size={12} className="animate-spin" />
                        : copied === s.filename
                          ? <Check size={12} className="text-[#00AF5C]" />
                          : <Copy size={12} />}
                    </button>
                  </Tooltip>
                  <Tooltip content="Download" side="bottom" align="end">
                    <a href={`${base}/screenshots/${encodeURIComponent(s.filename)}/file`} download={s.filename}
                      className="p-1.5 rounded-lg bg-[#000000]/70 text-white hover:text-[#00AF5C] transition-colors block">
                      <Download size={12} />
                    </a>
                  </Tooltip>
                  <Tooltip content="Delete" side="bottom" align="end">
                    <button onClick={() => handleDelete(s.filename)} disabled={busy === s.filename}
                      className="p-1.5 rounded-lg bg-[#000000]/70 text-white hover:text-[var(--c-danger)] transition-colors disabled:opacity-50">
                      {busy === s.filename ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                    </button>
                  </Tooltip>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      <AnimatePresence>
        {lightbox && (
          <ModalPortal>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-x-0 bottom-0 z-[60] bg-[#000000]/90 backdrop-blur-sm flex items-center justify-center p-6"
              style={{ top: TITLEBAR_OFFSET }} onClick={() => setLightbox(null)}>
              <motion.img key={lightbox}
                initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.15 }}
                src={`${base}/screenshots/${encodeURIComponent(lightbox)}/file`} alt={lightbox}
                className="max-w-full max-h-full rounded-2xl border border-[var(--c-border)] shadow-2xl"
                onClick={e => e.stopPropagation()} draggable={false} />
              <div className="absolute top-4 right-4 flex items-center gap-2">
                <Tooltip content={copied === lightbox ? 'Copied!' : 'Copy image (Ctrl+C)'} side="bottom" align="end">
                  <button onClick={e => { e.stopPropagation(); handleCopy(lightbox); }} disabled={copying === lightbox}
                    className="p-2 rounded-xl bg-[var(--c-surface-1)] border border-[var(--c-border)] text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] transition-colors disabled:opacity-50">
                    {copying === lightbox
                      ? <Loader2 size={16} className="animate-spin" />
                      : copied === lightbox
                        ? <Check size={16} className="text-[#00AF5C]" />
                        : <Copy size={16} />}
                  </button>
                </Tooltip>
                <Tooltip content="Download" side="bottom" align="end">
                  <a href={`${base}/screenshots/${encodeURIComponent(lightbox)}/file`} download={lightbox}
                    onClick={e => e.stopPropagation()}
                    className="p-2 rounded-xl bg-[var(--c-surface-1)] border border-[var(--c-border)] text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] transition-colors block">
                    <Download size={16} />
                  </a>
                </Tooltip>
                <button onClick={e => { e.stopPropagation(); setLightbox(null); }}
                  className="p-2 rounded-xl bg-[var(--c-surface-1)] border border-[var(--c-border)] text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] transition-colors">
                  <X size={16} />
                </button>
              </div>
              {lightboxIndex > 0 && (
                <button aria-label="Previous" onClick={e => { e.stopPropagation(); step(-1); }}
                  className="absolute left-4 top-1/2 -translate-y-1/2 p-2.5 rounded-xl bg-[var(--c-surface-1)]/90 border border-[var(--c-border)] text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:border-[var(--c-text-muted)] transition-colors">
                  <ChevronLeft size={18} />
                </button>
              )}
              {lightboxIndex !== -1 && lightboxIndex < shots.length - 1 && (
                <button aria-label="Next" onClick={e => { e.stopPropagation(); step(1); }}
                  className="absolute right-4 top-1/2 -translate-y-1/2 p-2.5 rounded-xl bg-[var(--c-surface-1)]/90 border border-[var(--c-border)] text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:border-[var(--c-text-muted)] transition-colors">
                  <ChevronRight size={18} />
                </button>
              )}
              {lightboxIndex !== -1 && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[var(--c-surface-1)]/90 border border-[var(--c-border)] pointer-events-none max-w-[80%]">
                  <span className="text-[10px] text-[var(--c-text-secondary)] font-mono truncate">{lightbox}</span>
                  <span className="text-[10px] font-bold text-[var(--c-text-muted)] tabular-nums flex-shrink-0">{lightboxIndex + 1} / {shots.length}</span>
                </div>
              )}
            </motion.div>
          </ModalPortal>
        )}
      </AnimatePresence>
    </div>
  );
}
