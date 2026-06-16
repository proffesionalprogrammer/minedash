import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Download, Heart, ExternalLink, Loader2, Server as ServerIcon,
  ScrollText, Image as ImageIcon, ListTree, Boxes,
  Code2, Bug, MessageCircle, BookOpen, HeartHandshake, AlertTriangle,
  Calendar, ChevronLeft, ChevronRight,
  ArrowLeft,
} from 'lucide-react';
import ModalPortal from './ModalPortal';
import ProfilePickerModal from './ProfilePickerModal';
import MarkdownBlock from './Markdown';
import { VersionRow } from './VersionRow';
import { fmt, fmtRelative, fmtDateAbs } from './modrinthFormat';
import Tooltip from './Tooltip';

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

const TABS = [
  { key: 'description',  label: 'Description',  icon: ScrollText },
  { key: 'gallery',      label: 'Gallery',      icon: ImageIcon  },
  { key: 'versions',     label: 'Versions',     icon: ListTree   },
  { key: 'dependencies', label: 'Dependencies', icon: Boxes      },
];

// Modrinth licenses come as { id, name, url }. The id is what users recognise
// (MIT, GPL-3.0-only, ARR…) so we prefer it for the chip.
function licenseLabel(project) {
  if (!project?.license) return null;
  const { id, name } = project.license;
  return id || name || null;
}


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
          className="bg-[var(--c-base)] border border-[var(--c-border)] rounded-3xl w-full max-w-5xl flex flex-col max-h-[90vh] overflow-hidden shadow-2xl shadow-black/50"
        >
          {/* Header */}
          <div className="flex items-start gap-4 px-6 md:px-8 pt-6 pb-5 border-b border-[var(--c-border)] flex-shrink-0">
            {stack.length > 1 && (
              <Tooltip content="Back to previous project" side="bottom" align="start" className="flex-shrink-0">
                <button
                  onClick={drillBack}
                  className="p-2 rounded-xl text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)] transition-colors"
                >
                  <ArrowLeft size={16} />
                </button>
              </Tooltip>
            )}
            <div className="w-16 h-16 rounded-2xl overflow-hidden bg-[var(--c-surface-2)] border border-[var(--c-border)] flex-shrink-0 flex items-center justify-center">
              {headerIcon
                ? <img src={headerIcon} alt="" className="w-full h-full object-cover" />
                : <span className="text-[#00AF5C] font-black text-2xl">{headerTitle?.[0] || '?'}</span>}
            </div>
            <div className="flex-1 min-w-0 flex flex-col gap-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-2xl font-black text-[var(--c-text-primary)] truncate">{headerTitle}</h2>
                {license && (
                  <span className="text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md bg-[var(--c-surface-2)] text-[var(--c-text-secondary)] border border-[var(--c-border)] flex-shrink-0">
                    {license}
                  </span>
                )}
                <span className="text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/20 flex-shrink-0 capitalize">
                  {effectiveType}
                </span>
              </div>
              {headerAuthor && (
                <p className="text-xs text-[var(--c-text-secondary)]">by <span className="font-bold text-[var(--c-text-primary)]">{headerAuthor}</span></p>
              )}
              {project?.description && (
                <p className="text-sm text-[var(--c-text-secondary)] line-clamp-2">{project.description}</p>
              )}
              <div className="flex items-center gap-4 text-xs text-[var(--c-text-secondary)] tabular-nums pt-1">
                <Tooltip content={`${(headerDls || 0).toLocaleString()} downloads`} side="bottom" align="start">
                  <span className="flex items-center gap-1.5">
                    <Download size={13} className="text-[var(--c-text-muted)]" />
                    <span className="font-bold text-[var(--c-text-primary)]">{fmt(headerDls)}</span>
                  </span>
                </Tooltip>
                {headerFollows != null && (
                  <Tooltip content={`${(headerFollows || 0).toLocaleString()} followers`} side="bottom">
                    <span className="flex items-center gap-1.5">
                      <Heart size={13} className="text-[var(--c-text-muted)]" />
                      <span className="font-bold text-[var(--c-text-primary)]">{fmt(headerFollows)}</span>
                    </span>
                  </Tooltip>
                )}
                {project?.updated && (
                  <Tooltip content={`Updated ${fmtDateAbs(project.updated)}`} side="bottom">
                    <span className="flex items-center gap-1.5">
                      <Calendar size={13} className="text-[var(--c-text-muted)]" />
                      Updated {fmtRelative(project.updated)}
                    </span>
                  </Tooltip>
                )}
              </div>
            </div>
            <button
              onClick={() => !installingMain && onClose?.()}
              disabled={installingMain}
              className="p-2 rounded-xl text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)] transition-colors disabled:opacity-40 flex-shrink-0"
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
          <div className="px-6 md:px-8 py-3 border-b border-[var(--c-border)] flex items-center gap-2 flex-wrap flex-shrink-0">
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
                className="flex items-center gap-1.5 px-3 py-2 bg-[var(--c-surface-2)] hover:bg-[var(--c-border)] text-[var(--c-text-primary)] border border-[var(--c-border)] hover:border-[#00AF5C]/40 rounded-xl text-sm font-bold transition-colors"
              >
                <ServerIcon size={14} />
                Install as server
              </motion.button>
            )}
            <a
              href={`https://modrinth.com/${effectiveType}/${project?.slug || activeProjectId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3 py-2 text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-surface-2)] rounded-xl text-sm font-bold transition-colors"
            >
              <ExternalLink size={14} />
              Open on Modrinth
            </a>
          </div>

          {/* Tabs + content */}
          <div className="flex-1 min-h-0 flex overflow-hidden">
            <div className="flex-1 min-w-0 flex flex-col">
              {/* Tab strip */}
              <div className="px-6 md:px-8 pt-3 flex items-center gap-1 border-b border-[var(--c-border)] flex-shrink-0 relative">
                {TABS.map(({ key, label, icon: Icon }) => {
                  const active = activeTab === key;
                  return (
                    <button
                      key={key}
                      onClick={() => setActiveTab(key)}
                      className={`relative flex items-center gap-1.5 px-3 py-2 text-xs font-bold transition-colors ${
                        active ? 'text-[#00AF5C]' : 'text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)]'
                      }`}
                    >
                      <Icon size={13} />
                      {label}
                      {active && (
                        <motion.span
                          layoutId="projectDetailTabIndicator"
                          className="absolute left-2 right-2 -bottom-px h-0.5 bg-[#00AF5C] rounded-full"
                          transition={{ type: 'spring', stiffness: 500, damping: 35, mass: 0.8 }}
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
        <span className="text-sm text-[var(--c-text-secondary)]">Loading description…</span>
      </div>
    );
  }
  if (!body) {
    return (
      <p className="text-sm text-[var(--c-text-muted)] italic py-8 text-center">
        This project has no description.
      </p>
    );
  }
  return (
    <div className="max-w-3xl">
      <MarkdownBlock>{body}</MarkdownBlock>
    </div>
  );
}

function GalleryTab({ gallery, loading, onOpen }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={20} className="text-[#00AF5C] animate-spin mr-2" />
        <span className="text-sm text-[var(--c-text-secondary)]">Loading gallery…</span>
      </div>
    );
  }
  if (!gallery || gallery.length === 0) {
    return (
      <div className="flex flex-col items-center py-16 text-[var(--c-text-muted)]">
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
          className="group block text-left bg-[var(--c-surface-1)] border border-[var(--c-border)] hover:border-[#00AF5C]/40 rounded-2xl overflow-hidden transition-colors"
        >
          <div className="aspect-video bg-[var(--c-base)] overflow-hidden">
            <img src={g.url} alt={g.title || ''} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
          </div>
          {(g.title || g.description) && (
            <div className="p-3">
              {g.title && <p className="text-sm font-bold text-[var(--c-text-primary)] truncate">{g.title}</p>}
              {g.description && <p className="text-xs text-[var(--c-text-secondary)] line-clamp-2 mt-0.5">{g.description}</p>}
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
        <span className="text-sm text-[var(--c-text-secondary)]">Loading versions…</span>
      </div>
    );
  }
  if (versions.length === 0) {
    return (
      <p className="text-sm text-[var(--c-text-muted)] italic py-8 text-center">
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
        <span className="text-sm text-[var(--c-text-secondary)]">Loading dependencies…</span>
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
      <p className="text-sm text-[var(--c-text-muted)] italic py-8 text-center">
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
    optional:     'bg-[var(--c-surface-2)] text-[var(--c-text-secondary)] border-[var(--c-border)]',
    embedded:     'bg-violet-500/10 text-violet-400 border-violet-500/30',
    incompatible: 'bg-[var(--c-danger)]/10 text-[var(--c-danger)] border-[var(--c-danger)]/20',
  };

  return (
    <div className="space-y-2">
      {projects.map(p => {
        const t = typeByDepId[p.id] || typeByDepId[p.slug] || 'related';
        const color = TYPE_COLORS[t] || 'bg-[var(--c-surface-2)] text-[var(--c-text-secondary)] border-[var(--c-border)]';
        return (
          <motion.button
            key={p.id}
            whileHover={{ y: -2 }}
            onClick={() => onOpenSub(p.id, p.project_type, {
              title: p.title, author: p.team, icon_url: p.icon_url,
              downloads: p.downloads, follows: p.followers,
            })}
            className="w-full flex items-center gap-3 p-3 bg-[var(--c-surface-1)] border border-[var(--c-border)] hover:border-[#00AF5C]/40 rounded-2xl transition-colors text-left"
          >
            <div className="w-10 h-10 rounded-xl overflow-hidden bg-[var(--c-base)] border border-[var(--c-border)] flex-shrink-0 flex items-center justify-center">
              {p.icon_url
                ? <img src={p.icon_url} alt="" className="w-full h-full object-cover" />
                : <span className="text-[#00AF5C] font-black">{p.title?.[0] || '?'}</span>}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-bold text-[var(--c-text-primary)] truncate">{p.title}</p>
                <span className={`text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md border ${color} flex-shrink-0`}>
                  {t}
                </span>
                {p.project_type && (
                  <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-md bg-[var(--c-border)] text-[var(--c-text-secondary)] border border-[var(--c-border)] flex-shrink-0 capitalize">
                    {p.project_type}
                  </span>
                )}
              </div>
              {p.description && <p className="text-xs text-[var(--c-text-secondary)] line-clamp-1 mt-0.5">{p.description}</p>}
            </div>
            <ExternalLink size={14} className="text-[var(--c-text-muted)] flex-shrink-0" />
          </motion.button>
        );
      })}
    </div>
  );
}

function RightRail({ project, loading }) {
  if (loading) {
    return (
      <aside className="hidden lg:flex flex-col w-64 flex-shrink-0 border-l border-[var(--c-border)] bg-[var(--c-deep-1)] overflow-y-auto custom-scrollbar p-5">
        <div className="space-y-3">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="h-4 bg-[var(--c-surface-2)] rounded animate-pulse" style={{ width: `${60 + i * 10}%` }} />
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
    <aside className="hidden lg:flex flex-col w-64 flex-shrink-0 border-l border-[var(--c-border)] bg-[var(--c-deep-1)] overflow-y-auto custom-scrollbar p-5 space-y-5">
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
              <span key={c} className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-[var(--c-surface-2)] text-[var(--c-text-secondary)] border border-[var(--c-border)] capitalize">
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
                className="flex items-center gap-2 px-2 py-1.5 text-xs font-bold text-[var(--c-text-secondary)] hover:text-[#00AF5C] hover:bg-[var(--c-surface-2)] rounded-lg transition-colors">
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
                className="flex items-center gap-2 px-2 py-1.5 text-xs font-bold text-[var(--c-text-secondary)] hover:text-[#00AF5C] hover:bg-[var(--c-surface-2)] rounded-lg transition-colors">
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
      <h4 className="text-[10px] uppercase tracking-wider font-bold text-[var(--c-text-muted)] mb-2">{title}</h4>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
function RailRow({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-[var(--c-text-muted)]">{label}</span>
      <span className="text-[var(--c-text-primary)] font-bold truncate">{children}</span>
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
              className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-[var(--c-surface-1)]/80 hover:bg-[var(--c-surface-1)] text-[var(--c-text-primary)] backdrop-blur-sm transition-colors"
              aria-label="Previous image"
            >
              <ChevronLeft size={20} />
            </button>
          )}
          {index < items.length - 1 && (
            <button
              onClick={onNext}
              className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-[var(--c-surface-1)]/80 hover:bg-[var(--c-surface-1)] text-[var(--c-text-primary)] backdrop-blur-sm transition-colors"
              aria-label="Next image"
            >
              <ChevronRight size={20} />
            </button>
          )}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-2 rounded-xl bg-[var(--c-surface-1)]/80 hover:bg-[var(--c-surface-1)] text-[var(--c-text-primary)] backdrop-blur-sm transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="mt-4 max-w-2xl text-center" onClick={e => e.stopPropagation()}>
          {item.title && <p className="text-sm font-bold text-[var(--c-text-primary)]">{item.title}</p>}
          {item.description && <p className="text-xs text-[var(--c-text-secondary)] mt-1">{item.description}</p>}
          <p className="text-[10px] text-[var(--c-text-muted)] mt-2 tabular-nums">
            {index + 1} / {items.length}
          </p>
        </div>
      </motion.div>
    </ModalPortal>
  );
}
