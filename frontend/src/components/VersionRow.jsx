import { useMemo, lazy, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Download, Loader2, Calendar, ChevronDown, Gamepad2, Wrench,
} from 'lucide-react';
import { LOADER_LABELS, fmt, fmtBytes, fmtRelative, fmtDateAbs } from './modrinthFormat';
import Tooltip from './Tooltip';

// The changelog body is markdown — lazy-loaded so react-markdown stays out of
// the main bundle (a row's changelog only renders once the row is expanded).
const MarkdownBlock = lazy(() => import('./Markdown'));

// One version in ProjectDetailModal's Versions tab + reused inline by
// LauncherContent's "Change version" picker (slice 2b). Lives in its own file
// so LauncherContent (eager, Play view) doesn't pull the whole detail modal
// into the main bundle.
export function VersionRow({
  version, loaderContext, versionContext, installable, installing, expanded,
  onToggle, onInstall,
}) {
  const isCompat = useMemo(() => {
    if (!loaderContext && !versionContext) return true;
    const verOk = !versionContext || (version.game_versions || []).includes(versionContext);
    const ldrOk = !loaderContext  || (version.loaders       || []).includes(loaderContext);
    return verOk && ldrOk;
  }, [version, loaderContext, versionContext]);

  const primaryFile = (version.files || []).find(f => f.primary) || (version.files || [])[0];
  const size = primaryFile?.size;
  const mcVers = version.game_versions || [];
  const loaders = (version.loaders || []).filter(l => l !== 'minecraft');
  const typeColor = version.version_type === 'release' ? 'bg-[#00AF5C]/10 text-[#00AF5C] border-[#00AF5C]/20'
    : version.version_type === 'beta' ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
    : 'bg-[var(--c-border)] text-[var(--c-text-secondary)] border-[var(--c-border)]';

  return (
    // Tooltip renders bare children when content is falsy, so compatible rows
    // carry no wrapper-induced tooltip.
    <Tooltip
      content={isCompat ? '' : `Not compatible with your selected ${loaderContext ? `${LOADER_LABELS[loaderContext] || loaderContext} ` : ''}${versionContext || 'profile'}`}
      className="w-full"
    >
    <div
      className={`w-full rounded-xl border transition-colors ${
        expanded
          ? 'border-[#00AF5C]/30 bg-[var(--c-surface-2)]'
          : 'border-[var(--c-border)] bg-[var(--c-surface-1)] hover:border-[var(--c-text-muted)]'
      } ${isCompat ? '' : 'opacity-50'}`}
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          onClick={onToggle}
          className="flex-1 min-w-0 text-left flex items-center gap-2"
        >
          <ChevronDown
            size={14}
            className={`text-[var(--c-text-muted)] flex-shrink-0 transition-transform ${expanded ? 'rotate-0' : '-rotate-90'}`}
          />
          <span className="text-sm font-bold text-[var(--c-text-primary)] truncate tabular-nums">{version.name || version.version_number}</span>
          <span className={`text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md border flex-shrink-0 ${typeColor}`}>
            {version.version_type || 'release'}
          </span>
        </button>
        <div className="flex items-center gap-3 text-[11px] text-[var(--c-text-secondary)] tabular-nums flex-shrink-0">
          {mcVers.length > 0 && (
            <Tooltip content={`MC: ${mcVers.join(', ')}`}>
              <span className="flex items-center gap-1">
                <Gamepad2 size={11} className="text-[var(--c-text-muted)]" />
                {mcVers.length === 1 ? mcVers[0] : `${mcVers[0]}+${mcVers.length - 1}`}
              </span>
            </Tooltip>
          )}
          {loaders.length > 0 && (
            <Tooltip content={`Loaders: ${loaders.join(', ')}`}>
              <span className="flex items-center gap-1">
                <Wrench size={11} className="text-[var(--c-text-muted)]" />
                {loaders.length === 1 ? (LOADER_LABELS[loaders[0]] || loaders[0]) : `${loaders.length} loaders`}
              </span>
            </Tooltip>
          )}
          {size > 0 && (
            <span className="text-[var(--c-text-muted)]">{fmtBytes(size)}</span>
          )}
          <Tooltip content={fmtDateAbs(version.date_published)}>
            <span className="flex items-center gap-1">
              <Calendar size={11} className="text-[var(--c-text-muted)]" />
              {fmtRelative(version.date_published)}
            </span>
          </Tooltip>
          {Number.isFinite(version.downloads) && (
            <span className="flex items-center gap-1">
              <Download size={11} className="text-[var(--c-text-muted)]" />
              {fmt(version.downloads)}
            </span>
          )}
        </div>
        {installable && (
          <motion.button
            onClick={() => onInstall?.(version)}
            disabled={installing}
            whileHover={installing ? {} : { scale: 1.03 }}
            whileTap={installing ? {} : { scale: 0.97 }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-lg text-[11px] font-bold disabled:opacity-50 flex-shrink-0"
          >
            {installing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            Install
          </motion.button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden border-t border-[var(--c-border)]"
          >
            <div className="px-3 py-2 text-xs text-[var(--c-text-secondary)] space-y-2">
              {version.changelog ? (
                <div className="prose-md max-h-48 overflow-y-auto custom-scrollbar pr-1">
                  <Suspense fallback={null}>
                    <MarkdownBlock compact>{version.changelog}</MarkdownBlock>
                  </Suspense>
                </div>
              ) : (
                <p className="text-[var(--c-text-muted)] italic">No changelog provided.</p>
              )}
              {mcVers.length > 1 && (
                <p className="text-[10px] text-[var(--c-text-muted)]">
                  <span className="font-bold text-[var(--c-text-secondary)]">MC versions:</span> {mcVers.join(', ')}
                </p>
              )}
              {loaders.length > 1 && (
                <p className="text-[10px] text-[var(--c-text-muted)]">
                  <span className="font-bold text-[var(--c-text-secondary)]">Loaders:</span> {loaders.map(l => LOADER_LABELS[l] || l).join(', ')}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </Tooltip>
  );
}
