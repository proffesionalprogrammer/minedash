import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, X } from 'lucide-react';
import ChangelogMarkdown from './ChangelogMarkdown';
import { fetchChangelog, extractSection } from '../lib/changelog';

const LS_KEY = 'minedash:lastSeenChangelogVersion';

// One-time "What's new" popup shown the first time MineDash launches on a new
// version. The flow:
//
//   1. Resolve the running app version via electron preload.
//   2. Compare against localStorage's last-seen version.
//      - If they match, do nothing.
//      - If localStorage is empty (fresh install), record the current version
//        and don't show the modal — only updates trigger the popup, not first
//        runs.
//      - Otherwise, fetch /CHANGELOG.md (copied into the bundle at build time)
//        and extract the section for the running version, show it, and on
//        dismiss persist the running version so it won't show again.
//   3. If the changelog section isn't found, silently skip — we don't want a
//      "no notes available" popup, that's worse than nothing.
//
// Parsing and rendering live in ../lib/changelog.js and ChangelogMarkdown —
// shared with the full release-notes history in Settings → Updates.
// Resolve the current app version + its CHANGELOG section. Returns null in
// dev mode (no electronAPI) or when the section is missing — callers should
// treat null as "nothing to show".
async function loadCurrentChangelog() {
  const api = window.electronAPI;
  if (!api?.getAppVersion) return null;
  const v = await api.getAppVersion();
  if (!v) return null;
  const text = await fetchChangelog();
  if (!text) return null;
  const section = extractSection(text, v);
  if (!section) return null;
  return { version: v, body: section };
}

export default function WhatsNewModal() {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(null);
  const [body, setBody] = useState('');

  // Auto-show after an update.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getAppVersion) return; // dev mode

    let cancelled = false;
    (async () => {
      try {
        const v = await api.getAppVersion();
        if (cancelled || !v) return;
        const lastSeen = localStorage.getItem(LS_KEY);
        if (lastSeen === v) return;
        if (!lastSeen) {
          // Fresh install: silently record so a brand-new user doesn't see
          // a "you just updated!" popup before they've even used the app.
          localStorage.setItem(LS_KEY, v);
          return;
        }
        const data = await loadCurrentChangelog();
        if (cancelled || !data) return;
        setVersion(data.version);
        setBody(data.body);
        setOpen(true);
      } catch {
        // Don't surface errors from the popup — failing silently is fine.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // On-demand trigger from Settings → "What's new in this version".
  // Always opens (bypasses the lastSeen check) so the user can re-read the
  // notes any time.
  useEffect(() => {
    const handler = async () => {
      try {
        const data = await loadCurrentChangelog();
        if (!data) return;
        setVersion(data.version);
        setBody(data.body);
        setOpen(true);
      } catch {}
    };
    window.addEventListener('minedash-show-changelog', handler);
    return () => window.removeEventListener('minedash-show-changelog', handler);
  }, []);

  const dismiss = () => {
    if (version) localStorage.setItem(LS_KEY, version);
    setOpen(false);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] bg-[#000000]/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={dismiss}
        >
          <motion.div
            initial={{ scale: 0.92, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.92, opacity: 0, y: 12 }}
            transition={{ type: 'spring', duration: 0.45, bounce: 0.15 }}
            onClick={(e) => e.stopPropagation()}
            className="relative bg-[var(--c-surface-1)] border border-[var(--c-border)] rounded-3xl p-8 max-w-lg w-full max-h-[80vh] overflow-hidden flex flex-col"
          >
            <button
              onClick={dismiss}
              className="absolute top-5 right-5 p-1.5 rounded-lg text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)] transition-colors"
              aria-label="Close"
            >
              <X size={16} />
            </button>

            <div className="flex items-center gap-3 mb-5 flex-shrink-0">
              <div className="p-2.5 bg-[#00AF5C]/10 rounded-2xl">
                <Sparkles size={20} className="text-[#00AF5C]" />
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider font-bold text-[var(--c-text-muted)]">What's new</p>
                <h2 className="text-xl font-black text-[var(--c-text-primary)] tracking-tight">MineDash v{version}</h2>
              </div>
            </div>

            <div className="overflow-y-auto custom-scrollbar -mr-2 pr-2 flex-1">
              <ChangelogMarkdown text={body} />
            </div>

            <div className="flex justify-end pt-5 mt-5 border-t border-[var(--c-border)] flex-shrink-0">
              <motion.button
                onClick={dismiss}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                className="px-5 py-2.5 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-sm font-bold transition-colors"
              >
                Got it
              </motion.button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
