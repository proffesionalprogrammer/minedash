import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, X } from 'lucide-react';

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
// Markdown rendering is intentionally minimal — we only need to support what
// our own CHANGELOG.md uses: ### subheadings, **bold**, paragraphs, hyphen
// bullet lists. No need to pull in a full markdown library.
export default function WhatsNewModal() {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(null);
  const [body, setBody] = useState('');

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
        // Real update. Fetch CHANGELOG.md and pull out the section for v.
        const r = await fetch('CHANGELOG.md', { cache: 'no-cache' });
        if (!r.ok) return;
        const text = await r.text();
        const section = extractSection(text, v);
        if (!section) return;
        setVersion(v);
        setBody(section);
        setOpen(true);
      } catch {
        // Don't surface errors from the popup — failing silently is fine.
      }
    })();
    return () => { cancelled = true; };
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
            className="relative bg-[#1A1A1A] border border-[#2D2D2D] rounded-3xl p-8 max-w-lg w-full max-h-[80vh] overflow-hidden flex flex-col"
          >
            <button
              onClick={dismiss}
              className="absolute top-5 right-5 p-1.5 rounded-lg text-[#555555] hover:text-[#FFFFFF] hover:bg-[#1E1E1E] transition-colors"
              aria-label="Close"
            >
              <X size={16} />
            </button>

            <div className="flex items-center gap-3 mb-5 flex-shrink-0">
              <div className="p-2.5 bg-[#00AF5C]/10 rounded-2xl">
                <Sparkles size={20} className="text-[#00AF5C]" />
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider font-bold text-[#555555]">What's new</p>
                <h2 className="text-xl font-black text-[#FFFFFF] tracking-tight">MineDash v{version}</h2>
              </div>
            </div>

            <div className="overflow-y-auto custom-scrollbar -mr-2 pr-2 flex-1">
              <MarkdownLite text={body} />
            </div>

            <div className="flex justify-end pt-5 mt-5 border-t border-[#2D2D2D] flex-shrink-0">
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

// Pull out the `## v1.0.2 — …` section from CHANGELOG.md text. Returns the
// raw markdown of that section's body (heading stripped) or null if missing.
// We escape `version` in the regex so dotted versions don't break the match.
function extractSection(text, version) {
  const v = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^##\\s+v${v}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s+v|\\Z)`, 'm');
  const m = text.match(re);
  if (!m) return null;
  // Drop horizontal-rule markers like `---` and trim.
  return m[1].replace(/^\s*---\s*$/gm, '').trim();
}

// Minimal markdown renderer. Supports our CHANGELOG style only:
//   ### Subheading        → bold green label
//   - bullet              → bullet list
//   **bold**              → strong
//   blank line            → paragraph break
//
// Deliberately ignores everything else (links, images, tables, code, nested
// lists) — our CHANGELOG.md doesn't use them. Keeping this tiny means no
// dependency on react-markdown / remark.
function MarkdownLite({ text }) {
  // Split into blocks separated by blank lines.
  const blocks = text.split(/\n\s*\n/);
  return (
    <div className="space-y-3 text-sm text-[#A0A0A0] leading-relaxed">
      {blocks.map((block, i) => {
        const trimmed = block.trim();
        if (!trimmed) return null;

        // ### Subheading
        if (trimmed.startsWith('### ')) {
          return (
            <h3 key={i} className="text-[10px] uppercase tracking-wider font-bold text-[#00AF5C] pt-2">
              {trimmed.slice(4)}
            </h3>
          );
        }

        // Bullet list — every non-empty line in the block starts with `- `.
        const lines = trimmed.split('\n');
        if (lines.every(l => l.trim().startsWith('- '))) {
          return (
            <ul key={i} className="space-y-2 list-disc pl-5 marker:text-[#00AF5C]">
              {lines.map((l, j) => (
                <li key={j} className="text-[#A0A0A0]">
                  {renderInline(l.replace(/^\s*-\s+/, ''))}
                </li>
              ))}
            </ul>
          );
        }

        // Default: paragraph (preserve line breaks inside as spaces).
        return (
          <p key={i} className="text-[#A0A0A0]">
            {renderInline(trimmed.replace(/\n/g, ' '))}
          </p>
        );
      })}
    </div>
  );
}

// **bold** → <strong>; everything else passes through as plain text. Returns
// an array of React children so React keys stay stable across re-renders.
function renderInline(text) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) {
      return <strong key={i} className="font-bold text-[#FFFFFF]">{p.slice(2, -2)}</strong>;
    }
    return <span key={i}>{p}</span>;
  });
}
