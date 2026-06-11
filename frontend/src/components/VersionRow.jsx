import { useMemo, lazy, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Download, Loader2, Calendar, ChevronDown, Gamepad2, Wrench,
} from 'lucide-react';
import { LOADER_LABELS, fmt, fmtBytes, fmtRelative, fmtDateAbs } from './modrinthFormat';

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
    : 'bg-[#2D2D2D] text-[#A0A0A0] border-[#2D2D2D]';

  return (
    <div
      className={`rounded-xl border transition-colors ${
        expanded
          ? 'border-[#00AF5C]/30 bg-[#1E1E1E]'
          : 'border-[#2D2D2D] bg-[#1A1A1A] hover:border-[#555555]'
      } ${isCompat ? '' : 'opacity-50'}`}
      title={isCompat ? undefined : `Not compatible with your selected ${loaderContext ? `${LOADER_LABELS[loaderContext] || loaderContext} ` : ''}${versionContext || 'profile'}`}
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          onClick={onToggle}
          className="flex-1 min-w-0 text-left flex items-center gap-2"
        >
          <ChevronDown
            size={14}
            className={`text-[#555555] flex-shrink-0 transition-transform ${expanded ? 'rotate-0' : '-rotate-90'}`}
          />
          <span className="text-sm font-bold text-[#FFFFFF] truncate tabular-nums">{version.name || version.version_number}</span>
          <span className={`text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md border flex-shrink-0 ${typeColor}`}>
            {version.version_type || 'release'}
          </span>
        </button>
        <div className="flex items-center gap-3 text-[11px] text-[#A0A0A0] tabular-nums flex-shrink-0">
          {mcVers.length > 0 && (
            <span className="flex items-center gap-1" title={`MC: ${mcVers.join(', ')}`}>
              <Gamepad2 size={11} className="text-[#555555]" />
              {mcVers.length === 1 ? mcVers[0] : `${mcVers[0]}+${mcVers.length - 1}`}
            </span>
          )}
          {loaders.length > 0 && (
            <span className="flex items-center gap-1" title={`Loaders: ${loaders.join(', ')}`}>
              <Wrench size={11} className="text-[#555555]" />
              {loaders.length === 1 ? (LOADER_LABELS[loaders[0]] || loaders[0]) : `${loaders.length} loaders`}
            </span>
          )}
          {size > 0 && (
            <span className="text-[#555555]">{fmtBytes(size)}</span>
          )}
          <span className="flex items-center gap-1" title={fmtDateAbs(version.date_published)}>
            <Calendar size={11} className="text-[#555555]" />
            {fmtRelative(version.date_published)}
          </span>
          {Number.isFinite(version.downloads) && (
            <span className="flex items-center gap-1">
              <Download size={11} className="text-[#555555]" />
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
            className="overflow-hidden border-t border-[#2D2D2D]"
          >
            <div className="px-3 py-2 text-xs text-[#A0A0A0] space-y-2">
              {version.changelog ? (
                <div className="prose-md max-h-48 overflow-y-auto custom-scrollbar pr-1">
                  <Suspense fallback={null}>
                    <MarkdownBlock compact>{version.changelog}</MarkdownBlock>
                  </Suspense>
                </div>
              ) : (
                <p className="text-[#555555] italic">No changelog provided.</p>
              )}
              {mcVers.length > 1 && (
                <p className="text-[10px] text-[#555555]">
                  <span className="font-bold text-[#A0A0A0]">MC versions:</span> {mcVers.join(', ')}
                </p>
              )}
              {loaders.length > 1 && (
                <p className="text-[10px] text-[#555555]">
                  <span className="font-bold text-[#A0A0A0]">Loaders:</span> {loaders.map(l => LOADER_LABELS[l] || l).join(', ')}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
