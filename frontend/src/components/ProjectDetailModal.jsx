import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  X, Download, Heart, ExternalLink, Loader2, Server as ServerIcon,
  ScrollText, Image as ImageIcon, ListTree, Boxes,
  Code2, Bug, MessageCircle, BookOpen, HeartHandshake, AlertTriangle,
  Calendar, ChevronLeft, ChevronRight, ChevronDown, Gamepad2, Wrench,
  ArrowLeft,
} from 'lucide-react';
import ModalPortal from './ModalPortal';
import ProfilePickerModal from './ProfilePickerModal';

// Detail modal opened when the user clicks a project title in Browse,
// LauncherContent, or ModrinthBrowser. Three responsibilities:
//   1. Surface the full Modrinth project page inside MineDash (description /
//      gallery / versions / dependencies + the sidebar of links).
//   2. Be the one place where a user can "install this specific version" or
//      "open this dependency's page" — the existing inline rows don't have
//      room for that.
//   3. Stay coherent across surfaces: the same modal opens from Browse (no
//      profile yet), LauncherContent (already inside a profile), and the
//      server-side ModrinthBrowser (server context, not a launcher install).
//      Install routing branches on `serverContext` for that last case.

const LOADER_LABELS = {
  fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt',
  paper: 'Paper', spigot: 'Spigot', bukkit: 'Bukkit',
  iris: 'Iris', optifine: 'OptiFine', canvas: 'Canvas',
  minecraft: 'Minecraft',
};

const TABS = [
  { key: 'description',  label: 'Description',  icon: ScrollText },
  { key: 'gallery',      label: 'Gallery',      icon: ImageIcon  },
  { key: 'versions',     label: 'Versions',     icon: ListTree   },
  { key: 'dependencies', label: 'Dependencies', icon: Boxes      },
];

function fmt(n) {
  if (n == null) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtBytes(b) {
  if (b == null || !Number.isFinite(b)) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const sec = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (sec < 60)  return sec + 's ago';
  const min = Math.round(sec / 60);
  if (min < 60)  return min + 'm ago';
  const hr = Math.round(min / 60);
  if (hr < 24)   return hr + 'h ago';
  const day = Math.round(hr / 24);
  if (day < 30)  return day + 'd ago';
  const mo = Math.round(day / 30);
  if (mo < 12)   return mo + 'mo ago';
  return Math.round(mo / 12) + 'y ago';
}

function fmtDateAbs(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Modrinth licenses come as { id, name, url }. The id is what users recognise
// (MIT, GPL-3.0-only, ARR…) so we prefer it for the chip.
function licenseLabel(project) {
  if (!project?.license) return null;
  const { id, name } = project.license;
  return id || name || null;
}

// One version in the Versions tab + reused inline by LauncherContent's
// "Change version" picker (slice 2b). Exported so both surfaces stay in sync.
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
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS_COMPACT}>
                    {version.changelog}
                  </ReactMarkdown>
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

// Markdown render styles tuned for Modrinth body content — headings have
// muted top margin, lists use brand-green markers, links open in new tabs.
// Two variants: full (body) and compact (changelogs in version rows).
const linkComponent = (props) => (
  <a
    {...props}
    target="_blank"
    rel="noopener noreferrer"
    className="text-[#00AF5C] hover:text-[#00964F] underline decoration-[#00AF5C]/40 hover:decoration-[#00AF5C] transition-colors break-words"
  />
);
const imgComponent = (props) => (
  <img {...props} alt={props.alt || ''} loading="lazy" className="max-w-full h-auto rounded-xl border border-[#2D2D2D] my-3" />
);
const codeComponent = ({ inline, children, ...props }) => {
  if (inline) {
    return <code className="px-1 py-0.5 rounded bg-[#1E1E1E] text-[#00AF5C] text-[0.9em] font-mono" {...props}>{children}</code>;
  }
  return (
    <pre className="bg-[#111111] border border-[#2D2D2D] rounded-xl p-3 overflow-x-auto custom-scrollbar text-xs my-3">
      <code className="font-mono text-[#A0A0A0]" {...props}>{children}</code>
    </pre>
  );
};

const MD_COMPONENTS = {
  h1: (p) => <h1 className="text-2xl font-black text-[#FFFFFF] mt-5 mb-2 border-b border-[#2D2D2D] pb-1" {...p} />,
  h2: (p) => <h2 className="text-xl font-bold text-[#FFFFFF] mt-5 mb-2" {...p} />,
  h3: (p) => <h3 className="text-lg font-bold text-[#FFFFFF] mt-4 mb-1.5" {...p} />,
  h4: (p) => <h4 className="text-base font-bold text-[#FFFFFF] mt-3 mb-1" {...p} />,
  p:  (p) => <p className="text-sm text-[#A0A0A0] my-2 leading-relaxed" {...p} />,
  ul: (p) => <ul className="list-disc pl-5 my-2 space-y-1 text-sm text-[#A0A0A0] marker:text-[#00AF5C]" {...p} />,
  ol: (p) => <ol className="list-decimal pl-5 my-2 space-y-1 text-sm text-[#A0A0A0] marker:text-[#00AF5C]" {...p} />,
  li: (p) => <li className="leading-relaxed" {...p} />,
  a:  linkComponent,
  img: imgComponent,
  code: codeComponent,
  blockquote: (p) => <blockquote className="border-l-2 border-[#00AF5C] pl-3 my-3 text-sm text-[#A0A0A0] italic" {...p} />,
  hr: () => <hr className="my-4 border-[#2D2D2D]" />,
  table: (p) => <div className="overflow-x-auto custom-scrollbar my-3"><table className="min-w-full text-xs border border-[#2D2D2D] rounded-lg overflow-hidden" {...p} /></div>,
  thead: (p) => <thead className="bg-[#1E1E1E] text-[#FFFFFF]" {...p} />,
  th: (p) => <th className="px-3 py-2 text-left font-bold border-b border-[#2D2D2D]" {...p} />,
  td: (p) => <td className="px-3 py-2 border-b border-[#2D2D2D]/50 text-[#A0A0A0]" {...p} />,
};
const MD_COMPONENTS_COMPACT = {
  ...MD_COMPONENTS,
  h1: (p) => <h1 className="text-base font-bold text-[#FFFFFF] mt-2 mb-1" {...p} />,
  h2: (p) => <h2 className="text-sm font-bold text-[#FFFFFF] mt-2 mb-1" {...p} />,
  h3: (p) => <h3 className="text-sm font-bold text-[#FFFFFF] mt-1.5 mb-0.5" {...p} />,
  p:  (p) => <p className="text-xs text-[#A0A0A0] my-1 leading-relaxed" {...p} />,
  ul: (p) => <ul className="list-disc pl-4 my-1 space-y-0.5 text-xs text-[#A0A0A0] marker:text-[#00AF5C]" {...p} />,
  ol: (p) => <ol className="list-decimal pl-4 my-1 space-y-0.5 text-xs text-[#A0A0A0] marker:text-[#00AF5C]" {...p} />,
};

export default function ProjectDetailModal({
  projectId,
  // Optional initial type — if the caller already knows the search hit's
  // project_type ('mod', 'modpack', 'resourcepack', 'shader', 'datapack')
  // we can render the action row correctly while the full project loads.
  type: seedType,
  // Search hit (or installed-record) the caller had on hand. Lets us render
  // title/author/icon/downloads instantly while /project/:id is in flight.
  seedHit,
  // When the modal is opened from inside LauncherContent we know exactly which
  // instance to install into. We pre-fill ProfilePickerModal with this so the
  // user doesn't have to pick again.
  defaultInstanceId,
  loaderContext,
  versionContext,
  // Server-side ModrinthBrowser calls this — for that surface we don't have a
  // launcher install endpoint, we have the per-server install endpoint. We
  // delegate the actual install back to the caller via onServerInstall.
  serverContext,
  onServerInstall,
  // Shared App-level helpers
  modpackInstalls,
  onInstallAsServer,
  onProfilesChanged,
  onError,
  onClose,
}) {
  // Drilldown stack — opening a dependency pushes a new projectId on; the
  // back arrow pops. We never unmount the modal between drills, just swap
  // the projectId and refetch.
  const [stack, setStack] = useState([{ projectId, type: seedType, seedHit }]);
  const top = stack[stack.length - 1];
  const activeProjectId = top.projectId;
  const activeSeedHit = top.seedHit;
  const activeSeedType = top.type;

  const [project, setProject] = useState(null);
  const [loadingProject, setLoadingProject] = useState(true);
  const [versions, setVersions] = useState(null);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [deps, setDeps] = useState(null);
  const [loadingDeps, setLoadingDeps] = useState(false);
  const [activeTab, setActiveTab] = useState('description');
  const [expandedVersion, setExpandedVersion] = useState(null);
  const [installingVersionId, setInstallingVersionId] = useState(null);
  const [installingMain, setInstallingMain] = useState(false);
  const [pickerVersion, setPickerVersion] = useState(null); // version object pending profile pick
  const [lightboxIndex, setLightboxIndex] = useState(null);

  // Effective project type. seedType wins until full project arrives —
  // /project/:id returns the same field as `project_type`, so we let it
  // overwrite on load.
  const effectiveType = project?.project_type || activeSeedType || 'mod';

  // ── Data fetches ───────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setProject(null);
    setVersions(null);
    setDeps(null);
    setActiveTab('description');
    setExpandedVersion(null);
    setLoadingProject(true);
    (async () => {
      try {
        const r = await fetch(`http://localhost:3001/api/modrinth/project/${activeProjectId}`);
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok) throw new Error(d.error || 'Failed to load project');
        setProject(d);
      } catch (err) {
        if (!cancelled) onError?.(err.message);
      }
      if (!cancelled) setLoadingProject(false);
    })();
    return () => { cancelled = true; };
  }, [activeProjectId, onError]);

  // Versions are slower than project metadata + dependencies, so we lazy-load
  // them when the user clicks the Versions tab. Same for deps — the Description
  // tab is the most common landing and we don't need either upfront.
  useEffect(() => {
    if (activeTab !== 'versions' || versions !== null) return;
    let cancelled = false;
    setLoadingVersions(true);
    (async () => {
      try {
        // Unfiltered — the tab shows EVERY version with compat dimming. The
        // backend proxy treats absent params as "no filter".
        const r = await fetch(`http://localhost:3001/api/modrinth/project/${activeProjectId}/versions`);
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok) throw new Error(d.error || 'Failed to load versions');
        // Newest first.
        const sorted = (Array.isArray(d) ? d : []).slice().sort((a, b) => {
          const ta = new Date(a.date_published || 0).getTime();
          const tb = new Date(b.date_published || 0).getTime();
          return tb - ta;
        });
        setVersions(sorted);
      } catch (err) {
        if (!cancelled) onError?.(err.message);
      }
      if (!cancelled) setLoadingVersions(false);
    })();
    return () => { cancelled = true; };
  }, [activeTab, activeProjectId, versions, onError]);

  useEffect(() => {
    if (activeTab !== 'dependencies' || deps !== null) return;
    let cancelled = false;
    setLoadingDeps(true);
    (async () => {
      try {
        const r = await fetch(`http://localhost:3001/api/modrinth/project/${activeProjectId}/dependencies`);
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok) throw new Error(d.error || 'Failed to load dependencies');
        setDeps(d);
      } catch (err) {
        if (!cancelled) onError?.(err.message);
      }
      if (!cancelled) setLoadingDeps(false);
    })();
    return () => { cancelled = true; };
  }, [activeTab, activeProjectId, deps, onError]);

  // ── Install routing ────────────────────────────────────────────────────
  // Modpack install: same flow as BrowseSection.handleInstall — POST to
  // /api/launcher/browse/install-modpack, then hook into modpackInstalls so
  // progress shows up in toasts + the Instances skeleton.
  const startModpackInstall = async (versionId) => {
    if (!modpackInstalls?.trackInstall) {
      onError?.('Modpack install tracker is not wired up — refresh the app and try again.');
      return;
    }
    setInstallingMain(true);
    try {
      const r = await fetch('http://localhost:3001/api/launcher/browse/install-modpack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: activeProjectId,
          versionId,
          title: project?.title || activeSeedHit?.title,
          iconUrl: project?.icon_url || activeSeedHit?.icon_url || null,
          displayName: project?.title || activeSeedHit?.title,
        }),
      });
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Backend returned non-JSON. If you upgraded, fully close MineDash and reopen it.');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Install failed');
      if (d.sessionId) {
        modpackInstalls.trackInstall(d.sessionId, `browse:${activeProjectId}`, {
          source: 'browse',
          loader: d.loader,
          version: d.version,
          instanceId: d.instanceId,
          title: project?.title || activeSeedHit?.title,
          iconUrl: project?.icon_url || activeSeedHit?.icon_url || null,
        });
      }
      onProfilesChanged?.();
      onClose?.();
    } catch (err) {
      onError?.(err.message);
    }
    setInstallingMain(false);
    setInstallingVersionId(null);
  };

  // Non-modpack install: open ProfilePickerModal — same path BrowseSection
  // takes for these types. ProfilePickerModal already handles the version
  // fetch + install, so we just hand off the seed hit.
  const handleMainInstall = () => {
    if (serverContext) {
      // Server-side surface — delegate to caller. They open the existing
      // ModrinthBrowser install flow (with deps + clientOnly confirm).
      onServerInstall?.({
        project_id: activeProjectId,
        title:    project?.title    || activeSeedHit?.title,
        author:   project?.team     || activeSeedHit?.author,
        icon_url: project?.icon_url || activeSeedHit?.icon_url,
        // Server installs need the loader/MC context which is the server's,
        // not ours — caller already has it.
      });
      onClose?.();
      return;
    }
    if (effectiveType === 'modpack') {
      startModpackInstall(null);
      return;
    }
    setPickerVersion('latest'); // sentinel — ProfilePickerModal handles "pick best"
  };

  const handleVersionInstall = async (version) => {
    if (serverContext) {
      onServerInstall?.({
        project_id: activeProjectId,
        title:    project?.title    || activeSeedHit?.title,
        author:   project?.team     || activeSeedHit?.author,
        icon_url: project?.icon_url || activeSeedHit?.icon_url,
        forcedVersion: version,
      });
      onClose?.();
      return;
    }
    if (effectiveType === 'modpack') {
      setInstallingVersionId(version.id);
      await startModpackInstall(version.id);
      return;
    }
    // Non-modpack: open ProfilePickerModal forced to this version.
    setPickerVersion(version);
  };

  const handleInstallAsServerClick = () => {
    onInstallAsServer?.({
      project_id: activeProjectId,
      title:    project?.title    || activeSeedHit?.title,
      icon_url: project?.icon_url || activeSeedHit?.icon_url,
    });
    onClose?.();
  };

  // ── Drilldown ──────────────────────────────────────────────────────────
  const drillInto = (subProjectId, subType, subSeed) => {
    setStack(s => [...s, { projectId: subProjectId, type: subType, seedHit: subSeed }]);
  };
  const drillBack = () => {
    setStack(s => s.length > 1 ? s.slice(0, -1) : s);
  };

  // ── Gallery lightbox keyboard nav ──────────────────────────────────────
  const gallery = project?.gallery || [];
  useEffect(() => {
    if (lightboxIndex == null) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setLightboxIndex(null);
      if (e.key === 'ArrowLeft')  setLightboxIndex(i => Math.max(0, (i ?? 0) - 1));
      if (e.key === 'ArrowRight') setLightboxIndex(i => Math.min(gallery.length - 1, (i ?? 0) + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxIndex, gallery.length]);

  // ── Header content (uses project if loaded, else seed hit) ─────────────
  const headerTitle   = project?.title    || activeSeedHit?.title || 'Loading…';
  const headerAuthor  = project?.team     || activeSeedHit?.author;
  const headerIcon    = project?.icon_url || activeSeedHit?.icon_url;
  const headerDls     = project?.downloads ?? activeSeedHit?.downloads;
  const headerFollows = project?.followers ?? activeSeedHit?.follows;
  const license = licenseLabel(project);
  const isMonetised = project?.monetization_status === 'monetized' || project?.monetization_status === 'force-demonetized';

  // ── Action row ─────────────────────────────────────────────────────────
  const installLabel = (() => {
    if (serverContext)                    return 'Install on server';
    if (effectiveType === 'modpack')      return 'Install';
    if (effectiveType === 'resourcepack') return 'Install resource pack';
    if (effectiveType === 'shader')       return 'Install shader';
    if (effectiveType === 'datapack')     return 'Install data pack';
    return 'Install';
  })();

  return (
    <ModalPortal>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-[#000000]/80 backdrop-blur-sm flex items-center justify-center p-4 md:p-8"
        onClick={() => !installingMain && onClose?.()}
      >
        <motion.div
          initial={{ scale: 0.94, opacity: 0, y: 16 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0 }}
          transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
          onClick={e => e.stopPropagation()}
          className="bg-[#111111] border border-[#2D2D2D] rounded-3xl w-full max-w-5xl flex flex-col max-h-[90vh] overflow-hidden shadow-2xl shadow-black/50"
        >
          {/* Header */}
          <div className="flex items-start gap-4 px-6 md:px-8 pt-6 pb-5 border-b border-[#2D2D2D] flex-shrink-0">
            {stack.length > 1 && (
              <button
                onClick={drillBack}
                title="Back to previous project"
                className="p-2 rounded-xl text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#1E1E1E] transition-colors flex-shrink-0"
              >
                <ArrowLeft size={16} />
              </button>
            )}
            <div className="w-16 h-16 rounded-2xl overflow-hidden bg-[#1E1E1E] border border-[#2D2D2D] flex-shrink-0 flex items-center justify-center">
              {headerIcon
                ? <img src={headerIcon} alt="" className="w-full h-full object-cover" />
                : <span className="text-[#00AF5C] font-black text-2xl">{headerTitle?.[0] || '?'}</span>}
            </div>
            <div className="flex-1 min-w-0 flex flex-col gap-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-2xl font-black text-[#FFFFFF] truncate">{headerTitle}</h2>
                {license && (
                  <span className="text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md bg-[#1E1E1E] text-[#A0A0A0] border border-[#2D2D2D] flex-shrink-0">
                    {license}
                  </span>
                )}
                <span className="text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/20 flex-shrink-0 capitalize">
                  {effectiveType}
                </span>
              </div>
              {headerAuthor && (
                <p className="text-xs text-[#A0A0A0]">by <span className="font-bold text-[#FFFFFF]">{headerAuthor}</span></p>
              )}
              {project?.description && (
                <p className="text-sm text-[#A0A0A0] line-clamp-2">{project.description}</p>
              )}
              <div className="flex items-center gap-4 text-xs text-[#A0A0A0] tabular-nums pt-1">
                <span className="flex items-center gap-1.5" title={`${(headerDls || 0).toLocaleString()} downloads`}>
                  <Download size={13} className="text-[#555555]" />
                  <span className="font-bold text-[#FFFFFF]">{fmt(headerDls)}</span>
                </span>
                {headerFollows != null && (
                  <span className="flex items-center gap-1.5" title={`${(headerFollows || 0).toLocaleString()} followers`}>
                    <Heart size={13} className="text-[#555555]" />
                    <span className="font-bold text-[#FFFFFF]">{fmt(headerFollows)}</span>
                  </span>
                )}
                {project?.updated && (
                  <span className="flex items-center gap-1.5" title={`Updated ${fmtDateAbs(project.updated)}`}>
                    <Calendar size={13} className="text-[#555555]" />
                    Updated {fmtRelative(project.updated)}
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={() => !installingMain && onClose?.()}
              disabled={installingMain}
              className="p-2 rounded-xl text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#1E1E1E] transition-colors disabled:opacity-40 flex-shrink-0"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>

          {/* Monetization banner */}
          {isMonetised && (
            <div className="px-6 md:px-8 py-2.5 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-2 text-xs text-amber-400 flex-shrink-0">
              <AlertTriangle size={14} />
              <span className="font-bold">
                The author has marked this project as monetized. Some links on Modrinth may be affiliate links.
              </span>
            </div>
          )}

          {/* Action row */}
          <div className="px-6 md:px-8 py-3 border-b border-[#2D2D2D] flex items-center gap-2 flex-wrap flex-shrink-0">
            <motion.button
              onClick={handleMainInstall}
              disabled={installingMain || loadingProject}
              whileHover={installingMain ? {} : { scale: 1.02 }}
              whileTap={installingMain ? {} : { scale: 0.98 }}
              className="flex items-center gap-2 px-4 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-sm font-bold transition-colors disabled:opacity-50"
            >
              {installingMain ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              {installingMain ? 'Starting…' : installLabel}
            </motion.button>
            {effectiveType === 'modpack' && !serverContext && (
              <motion.button
                onClick={handleInstallAsServerClick}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className="flex items-center gap-1.5 px-3 py-2 bg-[#1E1E1E] hover:bg-[#2D2D2D] text-[#FFFFFF] border border-[#2D2D2D] hover:border-[#00AF5C]/40 rounded-xl text-sm font-bold transition-colors"
              >
                <ServerIcon size={14} />
                Install as server
              </motion.button>
            )}
            <a
              href={`https://modrinth.com/${effectiveType}/${project?.slug || activeProjectId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3 py-2 text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#1E1E1E] rounded-xl text-sm font-bold transition-colors"
            >
              <ExternalLink size={14} />
              Open on Modrinth
            </a>
          </div>

          {/* Tabs + content */}
          <div className="flex-1 min-h-0 flex overflow-hidden">
            <div className="flex-1 min-w-0 flex flex-col">
              {/* Tab strip */}
              <div className="px-6 md:px-8 pt-3 flex items-center gap-1 border-b border-[#2D2D2D] flex-shrink-0 relative">
                {TABS.map(({ key, label, icon: Icon }) => {
                  const active = activeTab === key;
                  return (
                    <button
                      key={key}
                      onClick={() => setActiveTab(key)}
                      className={`relative flex items-center gap-1.5 px-3 py-2 text-xs font-bold transition-colors ${
                        active ? 'text-[#00AF5C]' : 'text-[#A0A0A0] hover:text-[#FFFFFF]'
                      }`}
                    >
                      <Icon size={13} />
                      {label}
                      {active && (
                        <motion.span
                          layoutId="projectDetailTabIndicator"
                          className="absolute left-2 right-2 -bottom-px h-0.5 bg-[#00AF5C] rounded-full"
                        />
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-6 md:px-8 py-5">
                {activeTab === 'description' && (
                  <DescriptionTab loading={loadingProject} body={project?.body} />
                )}
                {activeTab === 'gallery' && (
                  <GalleryTab gallery={gallery} onOpen={i => setLightboxIndex(i)} loading={loadingProject} />
                )}
                {activeTab === 'versions' && (
                  <VersionsTab
                    versions={versions}
                    loading={loadingVersions}
                    loaderContext={loaderContext}
                    versionContext={versionContext}
                    expandedVersion={expandedVersion}
                    onToggle={(id) => setExpandedVersion(p => p === id ? null : id)}
                    installingVersionId={installingVersionId}
                    onInstall={handleVersionInstall}
                  />
                )}
                {activeTab === 'dependencies' && (
                  <DependenciesTab
                    deps={deps}
                    loading={loadingDeps}
                    rootProjectId={activeProjectId}
                    onOpenSub={drillInto}
                  />
                )}
              </div>
            </div>

            {/* Right rail */}
            <RightRail project={project} loading={loadingProject} />
          </div>
        </motion.div>
      </motion.div>

      {/* Lightbox for gallery images */}
      <AnimatePresence>
        {lightboxIndex != null && gallery[lightboxIndex] && (
          <Lightbox
            items={gallery}
            index={lightboxIndex}
            onPrev={() => setLightboxIndex(i => Math.max(0, (i ?? 0) - 1))}
            onNext={() => setLightboxIndex(i => Math.min(gallery.length - 1, (i ?? 0) + 1))}
            onClose={() => setLightboxIndex(null)}
          />
        )}
      </AnimatePresence>

      {/* Profile picker for non-modpack version installs. `pickerVersion` is
          either 'latest' (let ProfilePickerModal pick best) or a specific
          version object — for the latter we set `forcedVersion` so the modal
          installs exactly that one instead of running its own version search. */}
      <AnimatePresence>
        {pickerVersion && (
          <ProfilePickerModal
            hit={{
              project_id: activeProjectId,
              title:    project?.title    || activeSeedHit?.title,
              icon_url: project?.icon_url || activeSeedHit?.icon_url,
              loaders:  project?.loaders  || activeSeedHit?.loaders  || [],
              versions: project?.versions || activeSeedHit?.versions || [],
            }}
            type={effectiveType}
            forcedVersion={pickerVersion === 'latest' ? null : pickerVersion}
            defaultInstanceId={defaultInstanceId}
            onError={onError}
            onClose={(result) => {
              setPickerVersion(null);
              if (result?.installedInto) {
                onProfilesChanged?.();
                onClose?.();
              }
            }}
          />
        )}
      </AnimatePresence>
    </ModalPortal>
  );
}

// ── Tabs ─────────────────────────────────────────────────────────────────
function DescriptionTab({ loading, body }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={20} className="text-[#00AF5C] animate-spin mr-2" />
        <span className="text-sm text-[#A0A0A0]">Loading description…</span>
      </div>
    );
  }
  if (!body) {
    return (
      <p className="text-sm text-[#555555] italic py-8 text-center">
        This project has no description.
      </p>
    );
  }
  return (
    <div className="max-w-3xl">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {body}
      </ReactMarkdown>
    </div>
  );
}

function GalleryTab({ gallery, loading, onOpen }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={20} className="text-[#00AF5C] animate-spin mr-2" />
        <span className="text-sm text-[#A0A0A0]">Loading gallery…</span>
      </div>
    );
  }
  if (!gallery || gallery.length === 0) {
    return (
      <div className="flex flex-col items-center py-16 text-[#555555]">
        <ImageIcon size={32} className="mb-3 opacity-30" />
        <p className="text-sm">No gallery images</p>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {gallery.map((g, i) => (
        <motion.button
          key={g.url + i}
          whileHover={{ y: -2 }}
          onClick={() => onOpen(i)}
          className="group block text-left bg-[#1A1A1A] border border-[#2D2D2D] hover:border-[#00AF5C]/40 rounded-2xl overflow-hidden transition-colors"
        >
          <div className="aspect-video bg-[#111111] overflow-hidden">
            <img src={g.url} alt={g.title || ''} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
          </div>
          {(g.title || g.description) && (
            <div className="p-3">
              {g.title && <p className="text-sm font-bold text-[#FFFFFF] truncate">{g.title}</p>}
              {g.description && <p className="text-xs text-[#A0A0A0] line-clamp-2 mt-0.5">{g.description}</p>}
            </div>
          )}
        </motion.button>
      ))}
    </div>
  );
}

function VersionsTab({
  versions, loading, loaderContext, versionContext, expandedVersion, onToggle, installingVersionId, onInstall,
}) {
  if (loading || versions == null) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={20} className="text-[#00AF5C] animate-spin mr-2" />
        <span className="text-sm text-[#A0A0A0]">Loading versions…</span>
      </div>
    );
  }
  if (versions.length === 0) {
    return (
      <p className="text-sm text-[#555555] italic py-8 text-center">
        No published versions.
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      {versions.map(v => (
        <VersionRow
          key={v.id}
          version={v}
          loaderContext={loaderContext}
          versionContext={versionContext}
          installable
          installing={installingVersionId === v.id}
          expanded={expandedVersion === v.id}
          onToggle={() => onToggle(v.id)}
          onInstall={onInstall}
        />
      ))}
    </div>
  );
}

function DependenciesTab({ deps, loading, rootProjectId, onOpenSub }) {
  if (loading || !deps) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={20} className="text-[#00AF5C] animate-spin mr-2" />
        <span className="text-sm text-[#A0A0A0]">Loading dependencies…</span>
      </div>
    );
  }

  // Modrinth's /dependencies returns { projects, versions }. We compute the
  // dep type for each project by scanning its sibling versions' dependencies
  // arrays — but the simpler approach is to fall back to "related" if no
  // type can be derived. The user mostly cares that the dep exists.
  const projects = deps.projects || [];
  if (projects.length === 0) {
    return (
      <p className="text-sm text-[#555555] italic py-8 text-center">
        This project lists no dependencies.
      </p>
    );
  }

  // Derive dep type by looking at the relationship from the root project's
  // versions to each dep project_id. Pick the strictest type observed
  // (required > optional > embedded > incompatible).
  const STRICTNESS = { required: 4, optional: 3, embedded: 2, incompatible: 1 };
  const typeByDepId = {};
  for (const v of deps.versions || []) {
    if (v.project_id !== rootProjectId) continue;
    for (const d of v.dependencies || []) {
      if (!d.project_id) continue;
      const existing = typeByDepId[d.project_id];
      if (!existing || (STRICTNESS[d.dependency_type] || 0) > (STRICTNESS[existing] || 0)) {
        typeByDepId[d.project_id] = d.dependency_type;
      }
    }
  }

  const TYPE_COLORS = {
    required:     'bg-[#00AF5C]/10 text-[#00AF5C] border-[#00AF5C]/20',
    optional:     'bg-[#1E1E1E] text-[#A0A0A0] border-[#2D2D2D]',
    embedded:     'bg-violet-500/10 text-violet-400 border-violet-500/30',
    incompatible: 'bg-[#FF5555]/10 text-[#FF5555] border-[#FF5555]/20',
  };

  return (
    <div className="space-y-2">
      {projects.map(p => {
        const t = typeByDepId[p.id] || typeByDepId[p.slug] || 'related';
        const color = TYPE_COLORS[t] || 'bg-[#1E1E1E] text-[#A0A0A0] border-[#2D2D2D]';
        return (
          <motion.button
            key={p.id}
            whileHover={{ y: -2 }}
            onClick={() => onOpenSub(p.id, p.project_type, {
              title: p.title, author: p.team, icon_url: p.icon_url,
              downloads: p.downloads, follows: p.followers,
            })}
            className="w-full flex items-center gap-3 p-3 bg-[#1A1A1A] border border-[#2D2D2D] hover:border-[#00AF5C]/40 rounded-2xl transition-colors text-left"
          >
            <div className="w-10 h-10 rounded-xl overflow-hidden bg-[#111111] border border-[#2D2D2D] flex-shrink-0 flex items-center justify-center">
              {p.icon_url
                ? <img src={p.icon_url} alt="" className="w-full h-full object-cover" />
                : <span className="text-[#00AF5C] font-black">{p.title?.[0] || '?'}</span>}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-bold text-[#FFFFFF] truncate">{p.title}</p>
                <span className={`text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md border ${color} flex-shrink-0`}>
                  {t}
                </span>
                {p.project_type && (
                  <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md bg-[#2D2D2D] text-[#A0A0A0] border border-[#2D2D2D] flex-shrink-0 capitalize">
                    {p.project_type}
                  </span>
                )}
              </div>
              {p.description && <p className="text-xs text-[#A0A0A0] line-clamp-1 mt-0.5">{p.description}</p>}
            </div>
            <ExternalLink size={14} className="text-[#555555] flex-shrink-0" />
          </motion.button>
        );
      })}
    </div>
  );
}

function RightRail({ project, loading }) {
  if (loading) {
    return (
      <aside className="hidden lg:flex flex-col w-64 flex-shrink-0 border-l border-[#2D2D2D] bg-[#0E0E0E] overflow-y-auto custom-scrollbar p-5">
        <div className="space-y-3">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="h-4 bg-[#1E1E1E] rounded animate-pulse" style={{ width: `${60 + i * 10}%` }} />
          ))}
        </div>
      </aside>
    );
  }
  if (!project) return null;
  const links = [
    { label: 'Source',    url: project.source_url,   icon: Code2        },
    { label: 'Wiki',      url: project.wiki_url,     icon: BookOpen     },
    { label: 'Issues',    url: project.issues_url,   icon: Bug          },
    { label: 'Discord',   url: project.discord_url,  icon: MessageCircle},
  ].filter(l => !!l.url);
  const donations = project.donation_urls || [];
  const categories = (project.categories || []).filter(c => !['fabric','forge','neoforge','quilt'].includes(c));

  return (
    <aside className="hidden lg:flex flex-col w-64 flex-shrink-0 border-l border-[#2D2D2D] bg-[#0E0E0E] overflow-y-auto custom-scrollbar p-5 space-y-5">
      {/* Stats */}
      <RailSection title="Project">
        <RailRow label="Published">{fmtDateAbs(project.published)}</RailRow>
        <RailRow label="Updated">{fmtDateAbs(project.updated)}</RailRow>
        {project.organization && (
          <RailRow label="Organization">{project.organization}</RailRow>
        )}
      </RailSection>

      {categories.length > 0 && (
        <RailSection title="Categories">
          <div className="flex flex-wrap gap-1">
            {categories.map(c => (
              <span key={c} className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-[#1E1E1E] text-[#A0A0A0] border border-[#2D2D2D] capitalize">
                {c.replace(/-/g, ' ')}
              </span>
            ))}
          </div>
        </RailSection>
      )}

      {links.length > 0 && (
        <RailSection title="Links">
          <div className="space-y-1">
            {links.map(l => (
              <a key={l.label} href={l.url} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 px-2 py-1.5 text-xs font-bold text-[#A0A0A0] hover:text-[#00AF5C] hover:bg-[#1E1E1E] rounded-lg transition-colors">
                <l.icon size={12} />
                {l.label}
                <ExternalLink size={10} className="ml-auto opacity-60" />
              </a>
            ))}
          </div>
        </RailSection>
      )}

      {donations.length > 0 && (
        <RailSection title="Donate">
          <div className="space-y-1">
            {donations.map(d => (
              <a key={d.id} href={d.url} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 px-2 py-1.5 text-xs font-bold text-[#A0A0A0] hover:text-[#00AF5C] hover:bg-[#1E1E1E] rounded-lg transition-colors">
                <HeartHandshake size={12} />
                {d.platform || d.id}
                <ExternalLink size={10} className="ml-auto opacity-60" />
              </a>
            ))}
          </div>
        </RailSection>
      )}
    </aside>
  );
}

function RailSection({ title, children }) {
  return (
    <div>
      <h4 className="text-[10px] uppercase tracking-wider font-bold text-[#555555] mb-2">{title}</h4>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
function RailRow({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-[#555555]">{label}</span>
      <span className="text-[#FFFFFF] font-bold truncate">{children}</span>
    </div>
  );
}

// ── Lightbox ─────────────────────────────────────────────────────────────
function Lightbox({ items, index, onPrev, onNext, onClose }) {
  const item = items[index];
  if (!item) return null;
  return (
    <ModalPortal>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-[60] bg-[#000000]/90 backdrop-blur-sm flex flex-col items-center justify-center p-4"
        onClick={onClose}
      >
        <div className="relative flex-1 w-full flex items-center justify-center min-h-0" onClick={e => e.stopPropagation()}>
          <img src={item.url} alt={item.title || ''} className="max-w-full max-h-full object-contain rounded-xl" />
          {index > 0 && (
            <button
              onClick={onPrev}
              className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-[#1A1A1A]/80 hover:bg-[#1A1A1A] text-[#FFFFFF] backdrop-blur-sm transition-colors"
              aria-label="Previous image"
            >
              <ChevronLeft size={20} />
            </button>
          )}
          {index < items.length - 1 && (
            <button
              onClick={onNext}
              className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-[#1A1A1A]/80 hover:bg-[#1A1A1A] text-[#FFFFFF] backdrop-blur-sm transition-colors"
              aria-label="Next image"
            >
              <ChevronRight size={20} />
            </button>
          )}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-2 rounded-xl bg-[#1A1A1A]/80 hover:bg-[#1A1A1A] text-[#FFFFFF] backdrop-blur-sm transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="mt-4 max-w-2xl text-center" onClick={e => e.stopPropagation()}>
          {item.title && <p className="text-sm font-bold text-[#FFFFFF]">{item.title}</p>}
          {item.description && <p className="text-xs text-[#A0A0A0] mt-1">{item.description}</p>}
          <p className="text-[10px] text-[#555555] mt-2 tabular-nums">
            {index + 1} / {items.length}
          </p>
        </div>
      </motion.div>
    </ModalPortal>
  );
}
