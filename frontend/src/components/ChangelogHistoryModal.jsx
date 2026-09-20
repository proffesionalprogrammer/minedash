import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { History, X, Loader2 } from 'lucide-react';
import ModalPortal from './ModalPortal';
import ChangelogMarkdown from './ChangelogMarkdown';
import { fetchChangelog, parseChangelog } from '../lib/changelog';

// Every release MineDash has shipped, not just the one you're running.
// Opened from Settings → Updates → "All release notes"; the one-version
// "What's new" popup lives in WhatsNewModal.
//
// Left rail lists the versions newest-first (the running one badged), right
// pane shows that release's notes — same shape as the instance detail panel.
export default function ChangelogHistoryModal() {
  const [open, setOpen] = useState(false);
  const [releases, setReleases] = useState(null); // null = still loading
  const [selected, setSelected] = useState(null);
  const [current, setCurrent] = useState(null);

  useEffect(() => {
    const handler = async () => {
      setOpen(true);
      // Re-read every time: cheap (a local file) and avoids showing a stale
      // list after an update installs.
      setReleases(null);
      const text = await fetchChangelog();
      const parsed = parseChangelog(text);
      setReleases(parsed);
      setSelected(parsed[0]?.version || null);
      try {
        const v = await window.electronAPI?.getAppVersion?.();
        if (v) setCurrent(v);
      } catch { /* dev mode — no running app version to badge */ }
    };
    window.addEventListener('minedash-show-all-changelogs', handler);
    return () => window.removeEventListener('minedash-show-all-changelogs', handler);
  }, []);

  const close = () => setOpen(false);
  const active = releases?.find(r => r.version === selected) || null;

  return (
    <ModalPortal>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-[#000000]/80 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={close}
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0, y: 12 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.92, opacity: 0, y: 12 }}
              transition={{ type: 'spring', duration: 0.45, bounce: 0.15 }}
              onClick={(e) => e.stopPropagation()}
              className="relative bg-[var(--c-surface-1)] border border-[var(--c-border)] rounded-3xl max-w-3xl w-full h-[80vh] overflow-hidden flex flex-col"
            >
              <div className="flex items-center gap-3 px-6 py-5 border-b border-[var(--c-border)] flex-shrink-0">
                <div className="p-2.5 bg-[#00AF5C]/10 rounded-2xl">
                  <History size={20} className="text-[#00AF5C]" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wider font-bold text-[var(--c-text-muted)]">Release notes</p>
                  <h2 className="text-xl font-black text-[var(--c-text-primary)] tracking-tight truncate">
                    Every MineDash update
                  </h2>
                </div>
                <button
                  onClick={close}
                  className="ml-auto p-1.5 rounded-lg text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)] transition-colors"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>

              {releases === null ? (
                <div className="flex-1 flex items-center justify-center">
                  <Loader2 size={22} className="text-[#00AF5C] animate-spin" />
                </div>
              ) : releases.length === 0 ? (
                <div className="flex-1 flex items-center justify-center px-6 text-center">
                  <p className="text-sm text-[var(--c-text-secondary)]">
                    No release notes were found in this build.
                  </p>
                </div>
              ) : (
                <div className="flex-1 flex min-h-0 flex-col sm:flex-row">
                  {/* Version rail — horizontal strip on narrow windows. */}
                  <div className="sm:w-52 flex-shrink-0 sm:border-r border-b sm:border-b-0 border-[var(--c-border)] overflow-x-auto sm:overflow-y-auto custom-scrollbar p-2 flex sm:block gap-1.5">
                    {releases.map(r => {
                      const isActive = r.version === selected;
                      return (
                        <button
                          key={r.version}
                          onClick={() => setSelected(r.version)}
                          className={`w-auto sm:w-full text-left px-3 py-2 rounded-xl transition-colors flex-shrink-0 sm:mb-1 border ${
                            isActive
                              ? 'bg-[#00AF5C]/10 border-[#00AF5C]/30 text-[#00AF5C]'
                              : 'bg-transparent border-transparent text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)]'
                          }`}
                        >
                          <span className="flex items-center gap-2">
                            <span className="text-sm font-bold tabular-nums">v{r.version}</span>
                            {current === r.version && (
                              <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md bg-[#00AF5C]/15 text-[#00AF5C] border border-[#00AF5C]/30">
                                Current
                              </span>
                            )}
                          </span>
                          {r.date && (
                            <span className="block text-[10px] font-bold text-[var(--c-text-muted)] tabular-nums mt-0.5">
                              {r.date}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* Selected release */}
                  <div className="flex-1 overflow-y-auto custom-scrollbar p-6 min-w-0">
                    {active && (
                      <motion.div
                        key={active.version}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        <h3 className="text-lg font-black text-[var(--c-text-primary)] tracking-tight mb-1">
                          MineDash v{active.version}
                        </h3>
                        {active.date && (
                          <p className="text-xs font-bold text-[var(--c-text-muted)] tabular-nums mb-4">{active.date}</p>
                        )}
                        <ChangelogMarkdown text={active.body} />
                      </motion.div>
                    )}
                  </div>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </ModalPortal>
  );
}
