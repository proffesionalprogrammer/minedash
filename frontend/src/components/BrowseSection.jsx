import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Search, Download, Clock, Gamepad2, Wrench, Loader2, ChevronLeft, ChevronRight,
  Box, Image as ImageIcon, Sparkles, Layers, Database, Flame, Gem, Star,
  SlidersHorizontal, X as XIcon, Server as ServerIcon, Check, ChevronDown,
  // Category glyphs — Modrinth-style icon per filter row. Mapped in CATEGORY_ICONS.
  Compass, Skull, Palette, DollarSign, Swords, Apple, Cog, BookOpen,
  ClipboardList, Dices, PawPrint, Zap, MessageCircle, Archive, Cpu, Truck,
  Globe, Gauge, Boxes, Feather, Users, Scroll, Tag,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Select from './Select';
import ProfilePickerModal from './ProfilePickerModal';
import Tooltip from './Tooltip';
import LoaderGlyph from './LoaderGlyph';

// Same TYPES list as LauncherContent — modpacks lead here because the whole
// point of Browse is "I want to install a pack without picking a loader+version
// first," which is the modpack case.
const TYPES = [
  { key: 'modpack',      label: 'Modpacks',       icon: Layers     },
  { key: 'mod',          label: 'Mods',           icon: Box        },
  { key: 'resourcepack', label: 'Resource Packs', icon: ImageIcon  },
  { key: 'shader',       label: 'Shaders',        icon: Sparkles   },
  { key: 'datapack',     label: 'Data Packs',     icon: Database   },
];

const SORT_OPTIONS = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'downloads', label: 'Downloads' },
  { value: 'follows',   label: 'Followers' },
  { value: 'newest',    label: 'Newest'    },
  { value: 'updated',   label: 'Updated'   },
];

// Loaders Modrinth's search facets accept for the loader chip. Used only for
// display — derived from the search hit's `loaders` array so we can render a
// friendly label instead of "neoforge". Falls back to the raw value.
const LOADER_LABELS = {
  fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt',
  paper: 'Paper', spigot: 'Spigot', bukkit: 'Bukkit',
  iris: 'Iris', optifine: 'OptiFine', canvas: 'Canvas',
};

// The loaders the filter rail offers. Order mirrors PlaySection's loader tabs.
// Resource packs / shaders / data packs are loader-agnostic, so the rail
// section hides for those types.
const FILTERABLE_LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];

// Category name → lucide icon. Covers mod + modpack taxonomies (the two types
// that surface categories most); anything unmapped falls back to a generic Tag
// so a new Modrinth category never renders icon-less.
const CATEGORY_ICONS = {
  adventure: Compass, cursed: Skull, decoration: Palette, economy: DollarSign,
  equipment: Swords, food: Apple, 'game-mechanics': Cog, library: BookOpen,
  magic: Sparkles, management: ClipboardList, minigame: Dices, mobs: PawPrint,
  optimization: Zap, social: MessageCircle, storage: Archive, technology: Cpu,
  transportation: Truck, utility: Wrench, worldgen: Globe,
  // modpack-only categories
  challenging: Gauge, combat: Swords, 'kitchen-sink': Boxes, lightweight: Feather,
  multiplayer: Users, quests: Scroll,
};
const categoryIcon = (name) => CATEGORY_ICONS[name] || Tag;

const LIMIT = 20;

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n ?? 0);
}

// Compact relative-time string ("3d ago", "5mo ago"). Matches CurseForge's
// row info-bar density — we want "3 days ago" → "3d ago" so a long pack name
// has room to breathe.
function fmtRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const sec = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (sec < 60)            return sec + 's ago';
  const min = Math.round(sec / 60);
  if (min < 60)            return min + 'm ago';
  const hr = Math.round(min / 60);
  if (hr < 24)             return hr + 'h ago';
  const day = Math.round(hr / 24);
  if (day < 30)            return day + 'd ago';
  const mo = Math.round(day / 30);
  if (mo < 12)             return mo + 'mo ago';
  const yr = Math.round(mo / 12);
  return yr + 'y ago';
}

// Pick the "primary" loader for a search hit. A hit may list multiple loaders
// (e.g. a mod that supports Fabric + Forge + NeoForge); we surface the first
// recognised one for the chip and stop there — adding all three to every row
// is noise. Order mirrors the loader tabs in PlaySection.
//
// Modpacks: Modrinth populates `categories` with the loader name (and leaves
// `loaders` empty) because a modpack's loader is determined by its manifest,
// not by the project itself. So we fall through to `categories` if `loaders`
// has nothing useful.
function primaryLoader(loaders, categories) {
  const order = ['fabric', 'forge', 'neoforge', 'quilt', 'paper', 'spigot'];
  const sources = [loaders, categories];
  for (const src of sources) {
    if (!Array.isArray(src)) continue;
    for (const want of order) {
      if (src.includes(want)) return want;
    }
  }
  return (Array.isArray(loaders) && loaders[0]) || null;
}

// Pick the highest "real" Minecraft version from the hit's versions array.
// Modrinth lists every supported version including snapshots — for the chip
// we want the latest release ("1.21.1") rather than the highest entry overall
// which might be a "26.1.2" pre-release tag or a snapshot like "23w14a".
function primaryGameVersion(versions) {
  if (!Array.isArray(versions) || versions.length === 0) return null;
  for (let i = versions.length - 1; i >= 0; i--) {
    const v = versions[i];
    if (/^1\.\d+(\.\d+)?$/.test(v)) return v;
  }
  return versions[versions.length - 1];
}

// Numeric Minecraft version comparison ("1.20.1" < "1.21"). Non-numeric parts
// coerce to 0 so it never throws on a snapshot tag.
function compareMcVersion(a, b) {
  const pa = String(a).split('.').map(n => Number(n) || 0);
  const pb = String(b).split('.').map(n => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Version to show on a result row. When the user has filtered by one or more
// MC versions, show the highest filtered version the hit supports (the search
// already guaranteed it supports it) rather than the hit's latest overall —
// otherwise a row filtered to 1.20.1 would still read "1.21.4" and mislead.
function displayGameVersion(hit, selectedVersions) {
  const versions = Array.isArray(hit.versions) ? hit.versions : [];
  if (selectedVersions && selectedVersions.size > 0) {
    const matching = versions.filter(v => selectedVersions.has(v));
    if (matching.length > 0) {
      return matching.sort(compareMcVersion)[matching.length - 1];
    }
  }
  return primaryGameVersion(versions);
}

// Editorial badge slot. Modrinth doesn't ship a "Hidden Gem"/"Sponsored"
// taxonomy, so we derive one from the hit fields. Returns null when no badge
// applies — and most rows SHOULD return null. CurseForge's badges show on
// maybe 1-in-5 rows; if we slap a badge on every popular pack it's noise.
function editorialBadge(hit) {
  if (hit.featured) return { label: 'Featured',   icon: Star,  color: 'amber'  };
  // Hidden Gem: well-loved relative to its size. Higher follow:download ratio
  // than the average pack — these are the under-the-radar picks worth
  // surfacing. The download cap keeps already-popular packs out of this slot.
  if (hit.follows >= 500 && hit.downloads < 50_000) {
    return { label: 'Hidden Gem', icon: Gem, color: 'violet' };
  }
  // Popular: only the genuine viral hits. ATM10-tier (10M+ downloads). Below
  // this number "Popular" becomes meaningless because half of Modrinth's top
  // 100 modpacks have 1M+ downloads.
  if (hit.downloads >= 10_000_000) return { label: 'Popular', icon: Flame, color: 'orange' };
  return null;
}

const BADGE_COLORS = {
  amber:  { bg: 'bg-amber-500/15',   text: 'text-amber-400',   border: 'border-amber-500/30'   },
  orange: { bg: 'bg-orange-500/15',  text: 'text-orange-400',  border: 'border-orange-500/30'  },
  violet: { bg: 'bg-violet-500/15',  text: 'text-violet-400',  border: 'border-violet-500/30'  },
};

export default function BrowseSection({ onError, modpackInstalls, onProfilesChanged, onInstallAsServer, onOpenDetail }) {
  const [type, setType] = useState('modpack');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('relevance');
  const [page, setPage] = useState(0);

  const [results, setResults] = useState([]);
  const [totalHits, setTotalHits] = useState(0);
  const [loading, setLoading] = useState(false);

  // Filter rail state. Sets, not arrays — toggling a chip is O(1) and chip
  // strips render in insertion order regardless.
  const [selectedCategories, setSelectedCategories] = useState(() => new Set());
  const [selectedLoaders,    setSelectedLoaders]    = useState(() => new Set());
  const [selectedMcVersions, setSelectedMcVersions] = useState(() => new Set());
  // mcVersionFilter narrows the (long) game-version list in the rail.
  const [mcVersionFilter, setMcVersionFilter] = useState('');

  // Modrinth taxonomy + version lists, fetched once. We grab everything up
  // front so the rail renders instantly when the user opens Browse; both
  // endpoints are cached server-side so the request is cheap on warm boot.
  const [allCategories, setAllCategories] = useState([]);
  const [allMcVersions, setAllMcVersions] = useState([]);

  // Per-row install in-flight flag. Modpack installs are tracked through
  // modpackInstalls (App-level) so they survive remounts; this flag just
  // gates the local Install button while the create-instance request is in
  // flight (the brief window before sessionId comes back and the progress
  // bar takes over). The "install as server" flow is owned by App.jsx so
  // it can outlive a tab switch — see onInstallAsServer prop.
  const [installing, setInstalling] = useState({});
  // Mod / RP / shader / datapack installs need a target instance, so they
  // open a CurseForge-style picker modal. `pickerHit` is the row the user
  // clicked; the modal handles its own lifecycle until close.
  const [pickerHit, setPickerHit] = useState(null);

  const searchTimeout = useRef(null);
  // Track the in-flight search so a late response from a previous query can't
  // overwrite the current results.
  const requestSeq = useRef(0);
  // The results scroll container. We reset it to the top whenever a new search
  // runs (page change, type switch, sort, filter, query) — otherwise paging
  // forward from the bottom lands you at the bottom of the next page, and
  // switching type keeps the old scroll offset.
  const resultsScrollRef = useRef(null);

  // ── One-time taxonomy fetches ───────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [catRes, verRes] = await Promise.all([
          fetch('http://localhost:3001/api/modrinth/categories'),
          fetch('http://localhost:3001/api/versions/vanilla'),
        ]);
        const cats = catRes.ok ? await catRes.json() : [];
        const vers = verRes.ok ? await verRes.json() : [];
        if (cancelled) return;
        setAllCategories(Array.isArray(cats) ? cats : []);
        // Only show release-shaped versions in the rail — snapshots clutter
        // the list and almost no one filters by them.
        setAllMcVersions(Array.isArray(vers) ? vers.filter(v => /^1\.\d+(\.\d+)?$/.test(v)) : []);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  // Categories filtered to the active project type. Modrinth's /tag/category
  // endpoint groups every category with the project_type it belongs to;
  // surfacing the wrong ones (e.g. "shaders" on the Mods tab) would create
  // empty result sets and confuse the user.
  const visibleCategories = useMemo(() => {
    return allCategories
      .filter(c => c.project_type === type)
      .filter(c => !FILTERABLE_LOADERS.includes(c.name));
  }, [allCategories, type]);

  const filteredMcVersions = useMemo(() => {
    const q = mcVersionFilter.trim().toLowerCase();
    if (!q) return allMcVersions;
    return allMcVersions.filter(v => v.toLowerCase().includes(q));
  }, [allMcVersions, mcVersionFilter]);

  // Whenever the type changes, drop category filters (they're type-scoped) but
  // keep loader / MC version filters — those are equally meaningful for mods
  // and modpacks and the user probably wants them to persist while browsing.
  useEffect(() => {
    setSelectedCategories(new Set());
  }, [type]);

  // ── Search ─────────────────────────────────────────────────────────
  const runSearch = async (q, p, s, t, cats, lds, gvs) => {
    const seq = ++requestSeq.current;
    // Always start a fresh search at the top of the list.
    resultsScrollRef.current?.scrollTo({ top: 0 });
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('query', q);
      params.set('limit',  String(LIMIT));
      params.set('offset', String(p * LIMIT));
      params.set('projectType', t);
      params.set('sort', s);
      for (const c of cats) params.append('category',    c);
      for (const l of lds)  params.append('loader',      l);
      for (const v of gvs)  params.append('gameVersion', v);

      const r = await fetch(`http://localhost:3001/api/modrinth/search?${params}`);
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Backend returned non-JSON — is the dev backend up to date?');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Search failed');
      if (seq !== requestSeq.current) return;
      setResults(d.hits || []);
      setTotalHits(d.total_hits || 0);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      onError?.(err.message);
      setResults([]);
      setTotalHits(0);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  // Re-search whenever any input that affects the result set changes. Query
  // has its own debounced handler so this doesn't fire on every keystroke.
  useEffect(() => {
    setPage(0);
    runSearch(
      query, 0, sort, type,
      Array.from(selectedCategories),
      Array.from(selectedLoaders),
      Array.from(selectedMcVersions),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, sort, selectedCategories, selectedLoaders, selectedMcVersions]);

  const handleQuery = (v) => {
    setQuery(v);
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setPage(0);
      runSearch(
        v, 0, sort, type,
        Array.from(selectedCategories),
        Array.from(selectedLoaders),
        Array.from(selectedMcVersions),
      );
    }, 400);
  };

  const handlePage = (p) => {
    setPage(p);
    runSearch(
      query, p, sort, type,
      Array.from(selectedCategories),
      Array.from(selectedLoaders),
      Array.from(selectedMcVersions),
    );
  };

  const totalPages = Math.ceil(totalHits / LIMIT);

  // ── Filter toggles ─────────────────────────────────────────────────
  const toggleIn = (setter) => (val) => {
    setter(prev => {
      const next = new Set(prev);
      if (next.has(val)) next.delete(val); else next.add(val);
      return next;
    });
  };
  const clearAllFilters = () => {
    setSelectedCategories(new Set());
    setSelectedLoaders(new Set());
    setSelectedMcVersions(new Set());
  };
  const activeFilterCount = selectedCategories.size + selectedLoaders.size + selectedMcVersions.size;

  // ── Install handlers ────────────────────────────────────────────────
  const handleInstall = async (hit) => {
    // Non-modpack types need a target instance — open the picker rather than
    // silently picking one for the user (every wrong guess wastes a 100MB
    // download and dirties the wrong profile).
    if (type !== 'modpack') {
      setPickerHit(hit);
      return;
    }
    setInstalling(p => ({ ...p, [hit.project_id]: true }));
    try {
      const r = await fetch('http://localhost:3001/api/launcher/browse/install-modpack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: hit.project_id,
          title:     hit.title,
          iconUrl:   hit.icon_url || null,
          displayName: hit.title,
        }),
      });
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Backend returned non-JSON. If you upgraded, fully close MineDash and reopen it.');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Install failed');
      // Hook into the App-level install tracker so the progress survives the
      // user navigating away. Source + loader/version/instanceId go on the
      // meta so App can show the "Play now" toast on completion.
      if (d.sessionId && modpackInstalls?.trackInstall) {
        modpackInstalls.trackInstall(d.sessionId, `browse:${hit.project_id}`, {
          source: 'browse',
          loader: d.loader,
          version: d.version,
          instanceId: d.instanceId,
          title: hit.title,
          iconUrl: hit.icon_url || null,
        });
      }
      onProfilesChanged?.();
    } catch (err) {
      onError?.(err.message);
    }
    setInstalling(p => ({ ...p, [hit.project_id]: false }));
  };

  // Install-as-server is owned by App.jsx so its progress toast survives a
  // tab switch and the user can keep navigating while the .mrpack downloads
  // + the server is created in the background.
  const handleInstallAsServer = (hit) => onInstallAsServer?.(hit);

  // ── Render ─────────────────────────────────────────────────────────
  const installsMap = modpackInstalls?.installs || {};

  return (
    <div className="flex-1 flex h-full bg-[#111111] overflow-hidden">
      {/* Filter rail — collapsible on smaller widths. Fixed width on desktop
          so the result column stays a stable size as the user toggles. */}
      <FilterRail
        type={type}
        categories={visibleCategories}
        mcVersions={filteredMcVersions}
        mcVersionFilter={mcVersionFilter}
        onMcVersionFilterChange={setMcVersionFilter}
        selectedCategories={selectedCategories}
        selectedLoaders={selectedLoaders}
        selectedMcVersions={selectedMcVersions}
        onToggleCategory={toggleIn(setSelectedCategories)}
        onToggleLoader={toggleIn(setSelectedLoaders)}
        onToggleMcVersion={toggleIn(setSelectedMcVersions)}
        onClearAll={clearAllFilters}
        activeCount={activeFilterCount}
      />

      <div className="flex-1 flex flex-col h-full px-6 md:px-8 py-6 overflow-hidden min-w-0">
        <div className="max-w-5xl mx-auto w-full flex flex-col flex-1 min-h-0">
          {/* Type tabs */}
          <div className="flex flex-wrap items-center gap-1.5 mb-4">
            {TYPES.map(({ key, label, icon: Icon }) => {
              const active = type === key;
              return (
                <motion.button
                  key={key}
                  onClick={() => setType(key)}
                  whileTap={{ scale: 0.97 }}
                  className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold transition-colors duration-150 ${
                    active
                      ? 'bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/20'
                      : 'text-[#A0A0A0] hover:text-[#FFFFFF] border border-transparent hover:bg-[#1E1E1E]'
                  }`}
                >
                  <Icon size={14} />
                  {label}
                </motion.button>
              );
            })}
          </div>

          {/* Search + sort */}
          <div className="flex items-center gap-2 mb-3">
            <div className="relative flex-1 min-w-0">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555555]" />
              <input
                type="text"
                value={query}
                onChange={e => handleQuery(e.target.value)}
                placeholder={`Search ${TYPES.find(t => t.key === type).label.toLowerCase()}…`}
                className="w-full bg-[#1A1A1A] border border-[#2D2D2D] focus:border-[#00AF5C] rounded-xl pl-10 pr-3 py-2.5 text-sm text-[#FFFFFF] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[#555555] font-medium"
              />
            </div>
            <Select
              value={sort}
              onChange={setSort}
              options={SORT_OPTIONS}
              className="flex-shrink-0"
            />
          </div>

          {/* Active filter chip strip */}
          {activeFilterCount > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mb-3">
              {Array.from(selectedCategories).map(c => (
                <FilterChip key={`c-${c}`} label={c.replace(/-/g, ' ')} onClear={() => toggleIn(setSelectedCategories)(c)} />
              ))}
              {Array.from(selectedLoaders).map(l => (
                <FilterChip key={`l-${l}`} label={LOADER_LABELS[l] || l} onClear={() => toggleIn(setSelectedLoaders)(l)} />
              ))}
              {Array.from(selectedMcVersions).map(v => (
                <FilterChip key={`v-${v}`} label={v} onClear={() => toggleIn(setSelectedMcVersions)(v)} />
              ))}
              <button
                onClick={clearAllFilters}
                className="text-[10px] font-bold text-[#A0A0A0] hover:text-[#FF5555] px-2 py-1 transition-colors"
              >
                Clear all
              </button>
            </div>
          )}

          {/* Result count strip */}
          <div className="flex items-center justify-between px-1 mb-3">
            <p className="text-xs text-[#555555] tabular-nums">
              {loading && results.length === 0
                ? 'Searching…'
                : `${totalHits.toLocaleString()} ${TYPES.find(t => t.key === type).label.toLowerCase()} found`}
            </p>
            {totalPages > 1 && (
              <p className="text-xs text-[#555555] tabular-nums">
                Page {page + 1} of {totalPages.toLocaleString()}
              </p>
            )}
          </div>

          {/* Results */}
          <div ref={resultsScrollRef} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar -mr-2 pr-2">
            {loading && results.length === 0 ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 size={20} className="text-[#00AF5C] animate-spin mr-2" />
                <span className="text-sm text-[#A0A0A0]">Searching Modrinth…</span>
              </div>
            ) : results.length === 0 ? (
              <div className="flex flex-col items-center py-16 text-[#555555]">
                <Search size={32} className="mb-3 opacity-30" />
                <p className="text-sm">No results</p>
                {(query || activeFilterCount > 0) && (
                  <p className="text-xs mt-1 text-[#555555]">Try a different search or clear filters</p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {results.map((hit, idx) => (
                  <BrowseRow
                    key={hit.project_id}
                    hit={hit}
                    index={idx}
                    type={type}
                    installEntry={installsMap[`browse:${hit.project_id}`] || null}
                    installing={!!installing[hit.project_id]}
                    selectedVersions={selectedMcVersions}
                    onInstall={() => handleInstall(hit)}
                    onInstallAsServer={() => handleInstallAsServer(hit)}
                    onCancel={() => modpackInstalls?.cancelInstall?.(`browse:${hit.project_id}`)}
                    onOpenDetail={() => onOpenDetail?.({ projectId: hit.project_id, type, seedHit: hit })}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Pagination footer */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-[#2D2D2D]">
              <span className="text-xs text-[#555555] tabular-nums">
                {totalHits.toLocaleString()} results · Page {page + 1} of {totalPages.toLocaleString()}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => handlePage(page - 1)}
                  disabled={page === 0 || loading}
                  className="p-2 bg-[#1E1E1E] border border-[#2D2D2D] rounded-xl text-[#A0A0A0] hover:text-[#FFFFFF] transition-all disabled:opacity-30"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  onClick={() => handlePage(page + 1)}
                  disabled={page >= totalPages - 1 || loading}
                  className="p-2 bg-[#1E1E1E] border border-[#2D2D2D] rounded-xl text-[#A0A0A0] hover:text-[#FFFFFF] transition-all disabled:opacity-30"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Profile picker for non-modpack installs. Refetches installed list on
          a successful install so the chosen instance reflects the new mod. */}
      <AnimatePresence>
        {pickerHit && (
          <ProfilePickerModal
            hit={pickerHit}
            type={type}
            onError={onError}
            filterVersions={Array.from(selectedMcVersions)}
            filterLoaders={Array.from(selectedLoaders)}
            onClose={(result) => {
              setPickerHit(null);
              if (result?.installedInto) onProfilesChanged?.();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Filter rail ────────────────────────────────────────────────────────
// Sticky left column. Each filter group is its own collapsible card (Modrinth
// layout): Game version, Loader, Categories. The rail itself sits on the page
// base so the cards read as elevated surfaces.
//   - Game version (long list, has its own filter input)
//   - Loader (short fixed list — hidden for loader-agnostic types)
//   - Categories (Modrinth taxonomy for the active type)
// Each section is a vertical stack of toggleable rows. Multi-select within a
// section is OR; between sections it's AND (handled in runSearch).
function FilterRail({
  type, categories, mcVersions, mcVersionFilter, onMcVersionFilterChange,
  selectedCategories, selectedLoaders, selectedMcVersions,
  onToggleCategory, onToggleLoader, onToggleMcVersion,
  onClearAll, activeCount,
}) {
  const showLoaderSection = type === 'mod' || type === 'modpack';
  return (
    <aside className="hidden md:flex flex-col w-60 lg:w-64 flex-shrink-0 h-full bg-[#111111] border-r border-[#2D2D2D] overflow-y-auto custom-scrollbar">
      <div className="sticky top-0 z-10 bg-[#111111] px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SlidersHorizontal size={14} className="text-[#00AF5C]" />
          <span className="text-xs font-bold uppercase tracking-wider text-[#FFFFFF]">Filters</span>
          {activeCount > 0 && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/20 tabular-nums">
              {activeCount}
            </span>
          )}
        </div>
        {activeCount > 0 && (
          <button
            onClick={onClearAll}
            className="text-[10px] font-bold text-[#A0A0A0] hover:text-[#FF5555] transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      <div className="px-3 pb-4 space-y-3">
        {/* Game version */}
        <FilterCard title="Game version">
          <div className="relative mb-2">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#555555]" />
            <input
              type="text"
              value={mcVersionFilter}
              onChange={e => onMcVersionFilterChange(e.target.value)}
              placeholder="e.g. 1.21"
              className="w-full bg-[#111111] border border-[#2D2D2D] focus:border-[#00AF5C] rounded-lg pl-7 pr-2 py-1.5 text-xs text-[#FFFFFF] outline-none focus:ring-2 focus:ring-[#00AF5C]/10 transition-all placeholder-[#555555]"
            />
          </div>
          <div className="max-h-48 overflow-y-auto custom-scrollbar pr-1 space-y-0.5">
            {mcVersions.length === 0 && <p className="text-[10px] text-[#555555] px-1 py-1">No matches</p>}
            {mcVersions.slice(0, 60).map(v => {
              const on = selectedMcVersions.has(v);
              return (
                <FilterRow key={v} selected={on} onClick={() => onToggleMcVersion(v)}>
                  <span className="flex-1 text-left tabular-nums">{v}</span>
                </FilterRow>
              );
            })}
          </div>
        </FilterCard>

        {/* Loader */}
        {showLoaderSection && (
          <FilterCard title="Loader">
            <div className="space-y-0.5">
              {FILTERABLE_LOADERS.map(l => {
                const on = selectedLoaders.has(l);
                return (
                  <FilterRow key={l} selected={on} onClick={() => onToggleLoader(l)}>
                    <LoaderGlyph loader={l} />
                    <span className="flex-1 text-left">{LOADER_LABELS[l] || l}</span>
                  </FilterRow>
                );
              })}
            </div>
          </FilterCard>
        )}

        {/* Categories */}
        {categories.length > 0 && (
          <FilterCard title="Category">
            <div className="max-h-72 overflow-y-auto custom-scrollbar pr-1 space-y-0.5">
              {categories.map(c => {
                const on = selectedCategories.has(c.name);
                const Icon = categoryIcon(c.name);
                return (
                  <FilterRow key={c.name} selected={on} onClick={() => onToggleCategory(c.name)}>
                    <Icon size={14} className={on ? 'text-[#00AF5C]' : 'text-[#555555]'} />
                    <span className="flex-1 text-left capitalize">{c.name.replace(/-/g, ' ')}</span>
                  </FilterRow>
                );
              })}
            </div>
          </FilterCard>
        )}
      </div>
    </aside>
  );
}

// Collapsible filter group card. Header toggles open/closed with a rotating
// chevron; body height-animates. Defaults open so the rail looks full on load.
function FilterCard({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-[#1A1A1A] border border-[#2D2D2D] rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="group w-full flex items-center justify-between px-3.5 py-2.5"
      >
        <span className="text-xs font-bold text-[#FFFFFF]">{title}</span>
        <ChevronDown
          size={15}
          className={`text-[#555555] group-hover:text-[#A0A0A0] transition-transform duration-200 ${open ? '' : '-rotate-90'}`}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="px-3.5 pb-3">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// One toggleable filter row. Icon/label live in children; the check appears on
// the right when selected. Selected state uses the brand green accent.
function FilterRow({ selected, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-xs font-bold transition-colors ${
        selected
          ? 'bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/20'
          : 'text-[#A0A0A0] hover:bg-[#111111] hover:text-[#FFFFFF] border border-transparent'
      }`}
    >
      {children}
      {selected && <Check size={12} className="flex-shrink-0" />}
    </button>
  );
}

function FilterChip({ label, onClear }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/20 capitalize">
      {label}
      <button
        onClick={onClear}
        className="hover:text-[#FF5555] transition-colors"
        aria-label={`Remove ${label} filter`}
      >
        <XIcon size={10} />
      </button>
    </span>
  );
}

// One result row. Designed for density: editorial badge, 56px icon, title +
// author + description + category chips on the left, info bar (downloads /
// age / MC version / loader) and install buttons stacked on the right.
function BrowseRow({ hit, index, type, installEntry, installing, selectedVersions, onInstall, onInstallAsServer, onCancel, onOpenDetail }) {
  const badge = editorialBadge(hit);
  const cats = (hit.display_categories || hit.categories || [])
    .filter(c => !['fabric', 'forge', 'neoforge', 'quilt'].includes(c))
    .slice(0, 4);
  const filteringVersion = !!(selectedVersions && selectedVersions.size > 0);
  const mcVer = displayGameVersion(hit, selectedVersions);
  const ldr = primaryLoader(hit.loaders, hit.categories);
  const ldrLabel = ldr ? (LOADER_LABELS[ldr] || ldr) : null;

  // Modpack install button state. installEntry takes over once the backend
  // has handed back a sessionId — local `installing` covers the brief window
  // before that. We keep showing the progress bar at 100% during the brief
  // 'done' window before the listing refetches.
  const inProgress = !!installEntry && installEntry.status !== 'error';
  const cancelling = installEntry?.status === 'cancelling';
  const pct = installEntry
    ? (installEntry.status === 'done' ? 100
        : (installEntry.total > 0 ? Math.min(99, Math.round((installEntry.task / installEntry.total) * 100)) : 0))
    : 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.02, 0.2), duration: 0.2 }}
      whileHover={{ y: -2 }}
      className="bg-[#1A1A1A] border border-[#2D2D2D] hover:border-[#555555] rounded-2xl overflow-hidden transition-colors"
    >
      <div className="flex items-stretch gap-4 p-4">
        {/* Icon */}
        <div className="w-14 h-14 rounded-xl overflow-hidden bg-[#111111] border border-[#2D2D2D] flex-shrink-0 flex items-center justify-center">
          {hit.icon_url
            ? <img src={hit.icon_url} alt="" className="w-full h-full object-cover" />
            : <span className="text-[#00AF5C] font-black text-lg">{hit.title?.[0] || '?'}</span>}
        </div>

        {/* Middle column — text + chips */}
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            {badge && (() => {
              const c = BADGE_COLORS[badge.color];
              const Icon = badge.icon;
              return (
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-bold rounded-md border ${c.bg} ${c.text} ${c.border}`}>
                  <Icon size={10} /> {badge.label}
                </span>
              );
            })()}
            <Tooltip content="View project details" align="start" className="min-w-0">
              <button
                onClick={onOpenDetail}
                className="font-bold text-sm text-[#FFFFFF] hover:text-[#00AF5C] truncate text-left transition-colors"
              >
                {hit.title}
              </button>
            </Tooltip>
            <span className="text-[10px] text-[#555555] flex-shrink-0">by {hit.author}</span>
          </div>
          {inProgress ? (
            <p className="text-xs text-[#00AF5C] line-clamp-1 font-bold">
              {installEntry.statusText || 'Installing…'}
            </p>
          ) : (
            <p className="text-xs text-[#A0A0A0] line-clamp-1">{hit.description}</p>
          )}
          {cats.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 mt-0.5">
              {cats.map(c => (
                <span
                  key={c}
                  className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/20 capitalize"
                >
                  {c.replace(/-/g, ' ')}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Right column — info bar + action buttons */}
        <div className="flex flex-col items-end justify-between flex-shrink-0 gap-2">
          {inProgress ? (
            <div className="flex items-center gap-3 text-[11px] text-[#A0A0A0] tabular-nums">
              {installEntry.total > 0
                ? <span>File {installEntry.task.toLocaleString()} of {installEntry.total.toLocaleString()}</span>
                : <span>Preparing…</span>}
            </div>
          ) : (
            <div className="flex items-center gap-3 text-[11px] text-[#A0A0A0] tabular-nums">
              <Tooltip content={`${(hit.downloads || 0).toLocaleString()} downloads`}>
                <span className="flex items-center gap-1">
                  <Download size={11} className="text-[#555555]" />
                  {fmt(hit.downloads)}
                </span>
              </Tooltip>
              {hit.date_modified && (
                <Tooltip content={new Date(hit.date_modified).toLocaleString()}>
                  <span className="flex items-center gap-1">
                    <Clock size={11} className="text-[#555555]" />
                    {fmtRelative(hit.date_modified)}
                  </span>
                </Tooltip>
              )}
              {mcVer && (
                <Tooltip content={filteringVersion ? 'Minecraft version (matches your filter)' : 'Latest Minecraft version supported'}>
                  <span className="flex items-center gap-1">
                    <Gamepad2 size={11} className={filteringVersion ? 'text-[#00AF5C]' : 'text-[#555555]'} />
                    {mcVer}
                  </span>
                </Tooltip>
              )}
              {ldr && (
                <Tooltip content={ldrLabel}>
                  <span className="flex items-center" aria-label={ldrLabel}>
                    {FILTERABLE_LOADERS.includes(ldr)
                      ? <LoaderGlyph loader={ldr} size={14} />
                      : <Wrench size={11} className="text-[#555555]" />}
                  </span>
                </Tooltip>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            {/* Install-as-server icon (modpacks only). The accent matches the
                Servers tab's identity so the user understands which surface
                they're targeting. */}
            {type === 'modpack' && !inProgress && (
              <Tooltip content="Install this modpack as a local server" align="end">
                <motion.button
                  onClick={onInstallAsServer}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  className="flex items-center gap-1 px-2.5 py-2 bg-[#1E1E1E] hover:bg-[#2D2D2D] border border-[#2D2D2D] hover:border-[#00AF5C]/40 rounded-xl text-[#A0A0A0] hover:text-[#FFFFFF] transition-colors"
                >
                  <ServerIcon size={14} />
                </motion.button>
              </Tooltip>
            )}

            {/* Install button — while installing, the progress pill is paired
                with a Stop button so the user can abort a long modpack download. */}
            {inProgress ? (
              <>
                <Tooltip content={`${installEntry.statusText || 'Installing…'}${installEntry.total ? ` (${installEntry.task} / ${installEntry.total} files)` : ''}`} align="end">
                <div
                  className="relative overflow-hidden flex items-center gap-1.5 px-4 py-2 border border-[#00AF5C]/40 rounded-xl text-xs font-bold text-white min-w-[120px] justify-center"
                  style={{ background: '#1E1E1E' }}
                >
                  <motion.div
                    initial={false}
                    animate={{ width: `${pct}%` }}
                    transition={{ ease: [0.22, 1, 0.36, 1], duration: 0.4 }}
                    className="absolute inset-y-0 left-0 z-0"
                    style={{ background: '#00AF5C' }}
                  />
                  <span className="relative z-10 flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" />
                    <span className="tabular-nums">{cancelling ? 'Stopping…' : `${pct}%`}</span>
                  </span>
                </div>
                </Tooltip>
                <Tooltip content="Cancel download" align="end">
                  <motion.button
                    onClick={onCancel}
                    disabled={cancelling}
                    whileHover={cancelling ? {} : { scale: 1.05 }}
                    whileTap={cancelling ? {} : { scale: 0.95 }}
                    className="flex items-center justify-center p-2 bg-[#1E1E1E] hover:bg-[#2D2D2D] border border-[#2D2D2D] hover:border-[#FF5555]/40 rounded-xl text-[#A0A0A0] hover:text-[#FF5555] transition-colors disabled:opacity-50"
                  >
                    <XIcon size={14} />
                  </motion.button>
                </Tooltip>
              </>
            ) : type === 'modpack' ? (
              <motion.button
                onClick={onInstall}
                disabled={installing}
                whileHover={{ scale: installing ? 1 : 1.03 }}
                whileTap={{ scale: installing ? 1 : 0.97 }}
                className="flex items-center gap-1.5 px-4 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-xs font-bold transition-all disabled:opacity-50"
              >
                {installing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                {installing ? 'Starting…' : 'Install'}
              </motion.button>
            ) : (
              <Tooltip content="Pick a profile to install into" align="end">
                <motion.button
                  onClick={onInstall}
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  className="flex items-center gap-1.5 px-4 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-xs font-bold transition-all"
                >
                  <Download size={14} />
                  Install
                </motion.button>
              </Tooltip>
            )}
          </div>
        </div>
      </div>

      {/* Progress bar across the bottom edge while installing — gives the row
          a clear visual rhythm even when the right-column number is changing
          fast. */}
      <AnimatePresence>
        {inProgress && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="h-0.5 bg-[#2D2D2D]"
          >
            <motion.div
              initial={false}
              animate={{ width: `${pct}%` }}
              transition={{ ease: [0.22, 1, 0.36, 1], duration: 0.4 }}
              className="h-full bg-[#00AF5C]"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
