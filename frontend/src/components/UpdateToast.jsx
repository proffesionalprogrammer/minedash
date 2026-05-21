import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, X, RotateCw } from 'lucide-react';

// Bottom-right corner toast wired to electron-updater. Listens for the three
// renderer-facing updater events from preload (available / progress / downloaded)
// and shows a "Click to relaunch" call-to-action only after the new installer
// has been pulled down. Renders nothing in dev mode (no window.electronAPI).
//
// State machine:
//   idle        → no banner
//   downloading → small progress chip showing percent (passive, doesn't ask
//                 the user to do anything)
//   ready       → big toast: "Update ready vX.Y.Z — Click to relaunch"
//
// Dismissing only hides the UI — the update stays downloaded and the next
// time the user quits MineDash on their own, autoInstallOnAppQuit picks it
// up. (Currently we set autoInstallOnAppQuit=false; flip in main.js if you
// change your mind.)
export default function UpdateToast() {
  const [phase, setPhase] = useState('idle'); // 'idle' | 'downloading' | 'ready'
  const [version, setVersion] = useState(null);
  const [percent, setPercent] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const api = window.electronAPI?.updater;
    if (!api) return;

    api.onUpdateAvailable(({ version }) => {
      setVersion(version);
      setPhase('downloading');
      setPercent(0);
      setDismissed(false);
    });
    api.onDownloadProgress(({ percent }) => {
      setPercent(Math.round(percent || 0));
    });
    api.onUpdateDownloaded(({ version }) => {
      setVersion(version);
      setPhase('ready');
      setDismissed(false);
    });
  }, []);

  const relaunch = () => {
    window.electronAPI?.updater?.quitAndInstall();
  };

  if (dismissed || phase === 'idle') return null;

  return (
    <AnimatePresence>
      {phase === 'downloading' && (
        <motion.div
          key="downloading"
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.95 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-2.5 bg-[#1A1A1A] border border-[#2D2D2D] rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.5)]"
        >
          <div className="p-1.5 bg-[#00AF5C]/10 rounded-lg">
            <Download size={14} className="text-[#00AF5C]" />
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider font-bold text-[#555555]">Downloading update</span>
            <span className="text-xs font-bold text-[#FFFFFF] tabular-nums">
              {version ? `v${version}` : ''} · {percent}%
            </span>
          </div>
          <button
            onClick={() => setDismissed(true)}
            className="ml-2 text-[#555555] hover:text-[#A0A0A0] transition-colors"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </motion.div>
      )}

      {phase === 'ready' && (
        <motion.div
          key="ready"
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.95 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 bg-[#1A1A1A] border border-[#00AF5C]/40 rounded-2xl shadow-[0_8px_30px_rgba(0,175,92,0.25)]"
        >
          <div className="p-2 bg-[#00AF5C]/10 rounded-xl flex-shrink-0">
            <RotateCw size={16} className="text-[#00AF5C]" />
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-bold text-[#FFFFFF]">
              Update ready{version ? ` · v${version}` : ''}
            </span>
            <span className="text-[10px] text-[#A0A0A0]">Click to relaunch with the new version.</span>
          </div>
          <motion.button
            onClick={relaunch}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            className="ml-2 px-3 py-1.5 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-xs font-bold transition-colors"
          >
            Relaunch
          </motion.button>
          <button
            onClick={() => setDismissed(true)}
            className="text-[#555555] hover:text-[#A0A0A0] transition-colors"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
