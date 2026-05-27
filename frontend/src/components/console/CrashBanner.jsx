import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, ArrowRight, X, PowerOff, Loader2, Check } from 'lucide-react';

// Crash detection banner — appears above the log stream when the backend
// detects a server crash. Two flavours of action:
//
//   • culpritJars present → "Disable <ModName>" one-click button that toggles
//     each jar to .disabled state via the mods toggle endpoint.
//   • tab present         → "Fix it" button that dispatches a custom event
//     (`minedash-switch-tab`) which MainPanel listens for to swap tabs.
//
// `culpritDisabled` resets every time a new crashBanner prop comes in.
export default function CrashBanner({ crashBanner, serverId, onDismiss }) {
  const [disabling, setDisabling] = useState(false);
  const [culpritDisabled, setCulpritDisabled] = useState(false);

  // Reset the "disabled" check-mark whenever a new crash arrives (or the
  // banner clears). Without this, a second crash would render with a stale
  // "Disabled" pill from the previous incident.
  useEffect(() => {
    setCulpritDisabled(false);
    setDisabling(false);
  }, [crashBanner]);

  const disableCulpritMods = async () => {
    if (!crashBanner?.culpritJars?.length || disabling) return;
    setDisabling(true);
    try {
      // Skip jars already in .disabled state — calling toggle on a disabled jar
      // would re-enable it, defeating the purpose.
      const targets = crashBanner.culpritJars.filter(j => !j.endsWith('.disabled'));
      for (const jar of targets) {
        await fetch(`http://localhost:3001/api/servers/${serverId}/mods/${encodeURIComponent(jar)}/toggle`, { method: 'POST' });
      }
      setCulpritDisabled(true);
    } catch (_) { /* surfaced via the banner's "still failed" state */ }
    setDisabling(false);
  };

  return (
    <AnimatePresence>
      {crashBanner && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className="overflow-hidden"
        >
          <div className="flex items-start gap-3 px-4 py-3 bg-[#FF5555]/8 border-b border-[#FF5555]/20">
            <AlertTriangle size={18} className="text-[#FF5555] flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-[#FF5555]">Server Crash Detected</p>
              <p className="text-xs text-[#A0A0A0] mt-0.5 leading-relaxed">
                {culpritDisabled
                  ? `Disabled ${crashBanner.culpritShort || 'the mod'}. Click Start to retry the server.`
                  : crashBanner.message}
              </p>
            </div>
            {!culpritDisabled && crashBanner.culpritJars?.length > 0 && (
              <button
                onClick={disableCulpritMods}
                disabled={disabling}
                className="flex items-center gap-1 px-2.5 py-1.5 bg-[#FF5555]/10 hover:bg-[#FF5555]/20 text-[#FF5555] rounded-lg text-xs font-bold transition-all flex-shrink-0 border border-[#FF5555]/20 disabled:opacity-60"
              >
                {disabling
                  ? <Loader2 size={12} className="animate-spin" />
                  : <PowerOff size={12} />}
                Disable {crashBanner.culpritShort || 'mod'}
              </button>
            )}
            {culpritDisabled && (
              <div className="flex items-center gap-1 px-2.5 py-1.5 bg-[#00AF5C]/10 text-[#00AF5C] rounded-lg text-xs font-bold flex-shrink-0 border border-[#00AF5C]/20">
                <Check size={12} /> Disabled
              </div>
            )}
            {crashBanner.tab && (
              <button
                onClick={() => {
                  // Let parent (MainPanel) know to switch to the relevant tab.
                  window.dispatchEvent(new CustomEvent('minedash-switch-tab', { detail: { tab: crashBanner.tab } }));
                }}
                className="flex items-center gap-1 px-2.5 py-1.5 bg-[#FF5555]/10 hover:bg-[#FF5555]/20 text-[#FF5555] rounded-lg text-xs font-bold transition-all flex-shrink-0 border border-[#FF5555]/20"
              >
                Fix it <ArrowRight size={12} />
              </button>
            )}
            <button
              onClick={onDismiss}
              className="p-1 text-[#555555] hover:text-[#A0A0A0] transition-colors flex-shrink-0"
            >
              <X size={14} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
