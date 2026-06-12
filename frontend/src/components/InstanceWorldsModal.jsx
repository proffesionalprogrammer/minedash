import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Globe, Image as ImageIcon, Loader2, Trash2, Copy, FileDown, X, Check, Camera,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import Tooltip from './Tooltip';
import ModalPortal from './ModalPortal';

// In packaged Electron the custom TitleBar occupies the top 38px — overlays
// must start below it so the minimize/maximize/close buttons stay visible
// and clickable. In browser dev mode TitleBar renders nothing, so no offset.
const TITLEBAR_OFFSET = window.electronAPI?.isElectron ? 38 : 0;

function humanBytes(n) {
  if (!n && n !== 0) return '';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

function fmtDate(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return ''; }
}

// Trigger a browser download for a backend GET that responds with
// Content-Disposition: attachment.
function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Worlds + screenshots manager for a launcher instance. Worlds are the
// singleplayer saves in <profile>/saves/ (list / duplicate / download as zip /
// delete); screenshots are <profile>/screenshots/ (grid, lightbox, delete).
export default function InstanceWorldsModal({ inst, onClose, onError }) {
  const [tab, setTab] = useState('worlds'); // 'worlds' | 'screenshots'
  const [worlds, setWorlds] = useState(null);          // null = loading
  const [screenshots, setScreenshots] = useState(null);
  const [busy, setBusy] = useState(null);              // name/filename of row with an action in flight
  const [pendingDelete, setPendingDelete] = useState(null);
  const [lightbox, setLightbox] = useState(null);      // screenshot filename

  const base = `http://localhost:3001/api/launcher/instances/${encodeURIComponent(inst.id)}`;

  const fetchWorlds = async () => {
    try {
      const r = await fetch(`${base}/worlds`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load worlds');
      setWorlds(d);
    } catch (err) { onError?.(err.message); setWorlds([]); }
  };
  const fetchScreenshots = async () => {
    try {
      const r = await fetch(`${base}/screenshots`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load screenshots');
      setScreenshots(d);
    } catch (err) { onError?.(err.message); setScreenshots([]); }
  };

  useEffect(() => {
    fetchWorlds();
    fetchScreenshots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst.id]);

  const handleDuplicate = async (name) => {
    setBusy(name);
    try {
      const r = await fetch(`${base}/worlds/${encodeURIComponent(name)}/duplicate`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Duplicate failed');
      await fetchWorlds();
    } catch (err) { onError?.(err.message); }
    setBusy(null);
  };

  const handleDeleteWorld = async (name) => {
    setBusy(name);
    try {
      const r = await fetch(`${base}/worlds/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Delete failed');
      setPendingDelete(null);
      await fetchWorlds();
    } catch (err) { onError?.(err.message); }
    setBusy(null);
  };

  const handleDeleteScreenshot = async (filename) => {
    setBusy(filename);
    try {
      const r = await fetch(`${base}/screenshots/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Delete failed');
      setPendingDelete(null);
      if (lightbox === filename) setLightbox(null);
      await fetchScreenshots();
    } catch (err) { onError?.(err.message); }
    setBusy(null);
  };

  // Lightbox gallery navigation — clamped at the ends like a photos app.
  const lightboxIndex = lightbox && screenshots ? screenshots.findIndex(s => s.filename === lightbox) : -1;
  const stepLightbox = (delta) => {
    if (lightboxIndex === -1) return;
    const next = lightboxIndex + delta;
    if (next < 0 || next >= screenshots.length) return;
    setLightbox(screenshots[next].filename);
  };

  // Keyboard navigation while the lightbox is open: ← / → to move, Esc to close.
  useEffect(() => {
    if (!lightbox) return;
    const handler = (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); stepLightbox(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepLightbox(1); }
      else if (e.key === 'Escape') { e.preventDefault(); setLightbox(null); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightbox, lightboxIndex, screenshots]);

  return (
    <ModalPortal>
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-x-0 bottom-0 bg-[#000000]/80 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      style={{ top: TITLEBAR_OFFSET }}
      onClick={() => onClose?.()}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
        transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
        onClick={e => e.stopPropagation()}
        className="bg-[#1A1A1A] border border-[#2D2D2D] rounded-3xl p-6 max-w-2xl w-full flex flex-col max-h-[80vh]"
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-[#00AF5C]/10 rounded-xl">
            <Globe size={18} className="text-[#00AF5C]" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-bold text-[#FFFFFF]">Worlds & screenshots</h3>
            <p className="text-xs text-[#A0A0A0] truncate">{inst.displayName}</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#1E1E1E] transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1.5 mb-4 border-b border-[#2D2D2D] pb-3">
          {[
            { key: 'worlds', label: 'Worlds', icon: Globe, count: worlds?.length },
            { key: 'screenshots', label: 'Screenshots', icon: Camera, count: screenshots?.length },
          ].map(({ key, label, icon: Icon, count }) => (
            <motion.button
              key={key}
              onClick={() => setTab(key)}
              whileTap={{ scale: 0.97 }}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors duration-150 ${
                tab === key
                  ? 'bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/20'
                  : 'text-[#A0A0A0] hover:text-[#FFFFFF] border border-transparent hover:bg-[#1E1E1E]'
              }`}
            >
              <Icon size={14} /> {label}
              {typeof count === 'number' && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${tab === key ? 'bg-[#00AF5C]/10 text-[#00AF5C]' : 'bg-[#2D2D2D] text-[#555555]'}`}>
                  {count}
                </span>
              )}
            </motion.button>
          ))}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar -mr-2 pr-2">
          {tab === 'worlds' ? (
            worlds === null ? (
              <Spinner label="Loading worlds…" />
            ) : worlds.length === 0 ? (
              <Empty icon={Globe} title="No worlds yet" hint="Singleplayer worlds you create in this instance will show up here." />
            ) : (
              <div className="space-y-1.5">
                {worlds.map((w, idx) => (
                  <motion.div
                    key={w.name}
                    initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(idx * 0.03, 0.3), duration: 0.18 }}
                    className="group flex items-center gap-3 px-3 py-2 bg-[#1E1E1E] border border-[#2D2D2D] hover:border-[#555555] rounded-xl transition-colors"
                  >
                    <div className="w-10 h-10 rounded-lg overflow-hidden bg-[#111111] border border-[#2D2D2D] flex-shrink-0 flex items-center justify-center">
                      {w.hasIcon
                        ? <img src={`${base}/worlds/${encodeURIComponent(w.name)}/icon`} alt="" className="w-full h-full object-cover" draggable={false} />
                        : <Globe size={16} className="text-[#00AF5C]" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-[#FFFFFF] truncate">{w.name}</p>
                      <p className="text-[10px] text-[#555555] tabular-nums">
                        {humanBytes(w.sizeBytes)} · last played {fmtDate(w.lastPlayed)}
                      </p>
                    </div>
                    {pendingDelete === `world:${w.name}` ? (
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <span className="text-[10px] font-bold text-[#FF5555]">Delete forever?</span>
                        <button
                          onClick={() => handleDeleteWorld(w.name)}
                          disabled={busy === w.name}
                          className="p-1.5 rounded-lg bg-[#FF5555] hover:bg-[#FF4444] text-white disabled:opacity-50"
                        >
                          {busy === w.name ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                        </button>
                        <button onClick={() => setPendingDelete(null)} className="p-1.5 rounded-lg bg-[#1A1A1A] border border-[#2D2D2D] text-[#A0A0A0] hover:text-[#FFFFFF]">
                          <X size={12} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        <IconBtn title="Download as zip" onClick={() => triggerDownload(`${base}/worlds/${encodeURIComponent(w.name)}/export`)}>
                          <FileDown size={14} />
                        </IconBtn>
                        <IconBtn title="Duplicate" onClick={() => handleDuplicate(w.name)} disabled={busy === w.name}>
                          {busy === w.name ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
                        </IconBtn>
                        <IconBtn title="Delete" danger onClick={() => setPendingDelete(`world:${w.name}`)}>
                          <Trash2 size={14} />
                        </IconBtn>
                      </div>
                    )}
                  </motion.div>
                ))}
              </div>
            )
          ) : (
            screenshots === null ? (
              <Spinner label="Loading screenshots…" />
            ) : screenshots.length === 0 ? (
              <Empty icon={ImageIcon} title="No screenshots yet" hint="Press F2 in-game — they'll show up here." />
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {screenshots.map((s, idx) => (
                  <motion.div
                    key={s.filename}
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    transition={{ delay: Math.min(idx * 0.02, 0.3), duration: 0.18 }}
                    className="group relative aspect-video bg-[#111111] border border-[#2D2D2D] hover:border-[#555555] rounded-xl overflow-hidden transition-colors"
                  >
                    <img
                      src={`${base}/screenshots/${encodeURIComponent(s.filename)}/file`}
                      alt={s.filename}
                      loading="lazy"
                      className="w-full h-full object-cover cursor-pointer"
                      onClick={() => setLightbox(s.filename)}
                      draggable={false}
                    />
                    <div className="absolute inset-x-0 bottom-0 px-2 py-1 bg-gradient-to-t from-[#000000]/80 to-transparent pointer-events-none">
                      <p className="text-[9px] text-white/80 truncate font-mono">{s.filename}</p>
                    </div>
                    <div className="absolute top-1 right-1 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Tooltip content="Delete" side="bottom" align="end">
                        <button
                          onClick={() => handleDeleteScreenshot(s.filename)}
                          disabled={busy === s.filename}
                          className="p-1.5 rounded-lg bg-[#000000]/70 text-white hover:text-[#FF5555] transition-colors disabled:opacity-50"
                        >
                          {busy === s.filename ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                        </button>
                      </Tooltip>
                    </div>
                  </motion.div>
                ))}
              </div>
            )
          )}
        </div>

      </motion.div>

      {/* Screenshot lightbox — sibling of the card (not inside it) so the
          card's scale transform never becomes its containing block. */}
      <AnimatePresence>
        {lightbox && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-x-0 bottom-0 z-[60] bg-[#000000]/90 backdrop-blur-sm flex items-center justify-center p-6"
            style={{ top: TITLEBAR_OFFSET }}
            onClick={e => { e.stopPropagation(); setLightbox(null); }}
          >
            <motion.img
              key={lightbox}
              initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.15 }}
              src={`${base}/screenshots/${encodeURIComponent(lightbox)}/file`}
              alt={lightbox}
              className="max-w-full max-h-full rounded-2xl border border-[#2D2D2D] shadow-2xl"
              onClick={e => e.stopPropagation()}
              draggable={false}
            />
            <button
              onClick={e => { e.stopPropagation(); setLightbox(null); }}
              className="absolute top-4 right-4 p-2 rounded-xl bg-[#1A1A1A] border border-[#2D2D2D] text-[#A0A0A0] hover:text-[#FFFFFF] transition-colors"
            >
              <X size={16} />
            </button>
            {lightboxIndex > 0 && (
              <button
                aria-label="Previous screenshot"
                onClick={e => { e.stopPropagation(); stepLightbox(-1); }}
                className="absolute left-4 top-1/2 -translate-y-1/2 p-2.5 rounded-xl bg-[#1A1A1A]/90 border border-[#2D2D2D] text-[#A0A0A0] hover:text-[#FFFFFF] hover:border-[#555555] transition-colors"
              >
                <ChevronLeft size={18} />
              </button>
            )}
            {lightboxIndex !== -1 && lightboxIndex < screenshots.length - 1 && (
              <button
                aria-label="Next screenshot"
                onClick={e => { e.stopPropagation(); stepLightbox(1); }}
                className="absolute right-4 top-1/2 -translate-y-1/2 p-2.5 rounded-xl bg-[#1A1A1A]/90 border border-[#2D2D2D] text-[#A0A0A0] hover:text-[#FFFFFF] hover:border-[#555555] transition-colors"
              >
                <ChevronRight size={18} />
              </button>
            )}
            {lightboxIndex !== -1 && (
              <div
                className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[#1A1A1A]/90 border border-[#2D2D2D] pointer-events-none max-w-[80%]"
              >
                <span className="text-[10px] text-[#A0A0A0] font-mono truncate">{lightbox}</span>
                <span className="text-[10px] font-bold text-[#555555] tabular-nums flex-shrink-0">
                  {lightboxIndex + 1} / {screenshots.length}
                </span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
    </ModalPortal>
  );
}

function IconBtn({ title, onClick, disabled, danger, children }) {
  return (
    <Tooltip content={title}>
      <button
        onClick={onClick}
        disabled={disabled}
        className={`p-2 rounded-lg transition-all disabled:opacity-50 ${
          danger
            ? 'text-[#A0A0A0] hover:text-[#FF5555] hover:bg-[#FF5555]/10'
            : 'text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#2D2D2D]'
        }`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function Spinner({ label }) {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2 size={18} className="text-[#00AF5C] animate-spin mr-2" />
      <span className="text-sm text-[#A0A0A0]">{label}</span>
    </div>
  );
}

function Empty({ icon: Icon, title, hint }) {
  return (
    <div className="flex flex-col items-center py-14 text-[#555555]">
      <Icon size={32} className="mb-3 opacity-30" />
      <p className="text-sm font-bold text-[#A0A0A0]">{title}</p>
      <p className="text-xs mt-1 max-w-xs text-center">{hint}</p>
    </div>
  );
}
