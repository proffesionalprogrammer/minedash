import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Search, Download, Star, Loader2, Check, AlertCircle, ChevronLeft, ChevronRight, Package } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const HANGAR_CATEGORIES = [
  'admin-tools', 'chat', 'dev-tools', 'economy', 'farming',
  'game', 'misc', 'protection', 'roleplay', 'world-management',
];

function fmt(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtDate(d) {
  if (!d) return '';
  const days = Math.floor((Date.now() - new Date(d)) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return days + ' days ago';
  if (days < 365) return Math.floor(days / 30) + ' months ago';
  return Math.floor(days / 365) + ' years ago';
}

export default function PluginsViewer({ serverId, serverVersion }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);
  const [category, setCategory] = useState('');
  const [installing, setInstalling] = useState({});
  const [installed, setInstalled] = useState({});
  const [installedFiles, setInstalledFiles] = useState([]);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const searchTimeout = useRef(null);
  const LIMIT = 20;

  const fetchInstalledFiles = useCallback(async () => {
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${serverId}/plugins`);
      const data = await res.json();
      if (res.ok && Array.isArray(data)) {
        setInstalledFiles(data.map(m => (m.slug || m.name || '').toLowerCase()));
      }
    } catch {}
  }, [serverId]);

  const searchPlugins = useCallback(async (q, p = 0, cat = '') => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        query: q,
        limit: LIMIT.toString(),
        offset: String(p * LIMIT),
      });
      if (cat) params.set('category', cat);

      const res = await fetch(`http://localhost:3001/api/hangar/search?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');

      setResults(data.result || []);
      setTotalCount(data.pagination?.count || 0);
    } catch (err) {
      setError(err.message);
      setResults([]);
    }
    setLoading(false);
  }, [serverVersion]);

  useEffect(() => { fetchInstalledFiles(); }, [fetchInstalledFiles]);
  useEffect(() => { searchPlugins('', 0, ''); }, [searchPlugins]);

  // Cross-reference with installed files
  useEffect(() => {
    if (installedFiles.length > 0 && results.length > 0) {
      const map = {};
      results.forEach(plugin => {
        const slug = (plugin.namespace?.slug || plugin.name || '').toLowerCase();
        if (installedFiles.some(f => f === slug || f.includes(slug))) {
          map[plugin.namespace?.slug || plugin.name] = true;
        }
      });
      if (Object.keys(map).length > 0) {
        setInstalled(prev => ({ ...prev, ...map }));
      }
    }
  }, [installedFiles, results]);

  const handleQueryChange = (val) => {
    setQuery(val);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => { setPage(0); searchPlugins(val, 0, category); }, 400);
  };

  const handleCategoryChange = (cat) => {
    const c = cat === category ? '' : cat;
    setCategory(c);
    setPage(0);
    searchPlugins(query, 0, c);
  };

  const handlePageChange = (p) => { setPage(p); searchPlugins(query, p, category); };

  const showToast = (msg, isError = false) => {
    setToast({ msg, isError });
    setTimeout(() => setToast(null), 4000);
  };

  const handleInstall = async (plugin) => {
    const slug = plugin.namespace?.slug || plugin.name;
    setInstalling(prev => ({ ...prev, [slug]: true }));

    try {
      // Fetch the latest version for this plugin
      const params = new URLSearchParams({ limit: '1', offset: '0' });
      if (serverVersion) params.set('gameVersion', serverVersion);

      const vRes = await fetch(`http://localhost:3001/api/hangar/project/${encodeURIComponent(slug)}/versions?${params}`);
      const vData = await vRes.json();
      if (!vRes.ok) throw new Error(vData.error || 'Failed to get plugin versions');

      const versions = vData.result || vData;
      if (!Array.isArray(versions) || versions.length === 0) {
        throw new Error('No compatible version found for this server version');
      }

      const latest = versions[0];
      const versionName = latest.name;

      // Hangar download URL pattern
      const downloadUrl = `https://hangar.papermc.io/api/v1/projects/${encodeURIComponent(slug)}/versions/${encodeURIComponent(versionName)}/PAPER/download`;
      const filename = `${slug}-${versionName}.jar`;

      const iRes = await fetch(`http://localhost:3001/api/servers/${serverId}/plugins/install-hangar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          downloadUrl,
          filename,
          title: plugin.name,
          slug,
          iconUrl: plugin.iconUrl || null,
        }),
      });
      const iData = await iRes.json();
      if (!iRes.ok) throw new Error(iData.error || 'Install failed');

      setInstalled(prev => ({ ...prev, [slug]: true }));
      showToast(`${plugin.name} v${versionName} installed!`);
      fetchInstalledFiles();
    } catch (err) {
      showToast(err.message, true);
    }

    setInstalling(prev => ({ ...prev, [slug]: false }));
  };

  const totalPages = Math.ceil(totalCount / LIMIT);

  return (
    <div className="flex flex-col h-full relative">
      {/* Search bar */}
      <div className="flex items-center gap-3 mb-3">
        <div className="relative flex-1">
          <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--c-text-muted)]" />
          <input
            type="text"
            placeholder="Search plugins on Hangar..."
            value={query}
            onChange={e => handleQueryChange(e.target.value)}
            className="w-full pl-12 pr-4 py-2.5 bg-[var(--c-surface-2)] border border-[var(--c-border)] focus:border-[#00AF5C] rounded-xl text-sm text-[var(--c-text-primary)] outline-none transition-all placeholder-[var(--c-text-muted)] focus:ring-4 focus:ring-[#00AF5C]/10 font-medium"
          />
        </div>
        {serverVersion && (
          <span className="text-xs font-bold bg-[var(--c-surface-2)] text-[var(--c-text-secondary)] px-3 py-2 rounded-xl border border-[var(--c-border)] whitespace-nowrap flex-shrink-0">
            Paper {serverVersion}
          </span>
        )}
      </div>

      {/* Category filters */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {HANGAR_CATEGORIES.map(cat => (
          <button
            key={cat}
            onClick={() => handleCategoryChange(cat)}
            className={`px-2.5 py-1 text-xs font-bold rounded-lg capitalize transition-all ${
              category === cat
                ? 'bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/20'
                : 'text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)] border border-[var(--c-border)] hover:border-[var(--c-text-muted)] bg-[var(--c-surface-2)]'
            }`}
          >
            {cat.replace('-', ' ')}
          </button>
        ))}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto custom-scrollbar -mr-2 pr-2">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={24} className="text-[#00AF5C] animate-spin" />
            <span className="ml-3 text-[var(--c-text-secondary)] font-medium">Searching Hangar...</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center py-20 text-[var(--c-danger)]">
            <AlertCircle size={32} className="mb-3" />
            <p className="font-bold">Search failed</p>
            <p className="text-sm text-[var(--c-text-secondary)] mt-1">{error}</p>
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center py-20 text-[var(--c-text-muted)]">
            <Package size={48} className="mb-4 opacity-30" />
            <p className="font-bold">No plugins found</p>
            <p className="text-xs mt-1">Try a different search or remove the category filter</p>
          </div>
        ) : (
          <div className="space-y-2">
            {results.map((plugin, idx) => {
              const slug = plugin.namespace?.slug || plugin.name;
              const isInstalled = installed[slug];
              const isInstalling = installing[slug];

              return (
                <motion.div
                  key={slug}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.03, duration: 0.25 }}
                  className="flex gap-4 p-4 bg-[var(--c-surface-2)] border border-[var(--c-border)] rounded-2xl hover:border-[var(--c-text-muted)] transition-all group"
                >
                  {/* Icon */}
                  <div className="w-12 h-12 rounded-xl overflow-hidden bg-[var(--c-base)] border border-[var(--c-border)] flex-shrink-0 flex items-center justify-center">
                    {plugin.iconUrl ? (
                      <img src={plugin.iconUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full bg-gradient-to-br from-[#00AF5C]/20 to-[#00AF5C]/5 flex items-center justify-center text-[#00AF5C] text-lg font-black">
                        {plugin.name?.[0] || 'P'}
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <h4 className="font-bold text-[var(--c-text-primary)] text-sm truncate">{plugin.name}</h4>
                      <span className="text-xs text-[var(--c-text-muted)] flex-shrink-0">
                        by {plugin.namespace?.owner || 'Unknown'}
                      </span>
                    </div>
                    <p className="text-xs text-[var(--c-text-secondary)] line-clamp-1 mb-1.5">{plugin.description}</p>
                    <div className="flex items-center gap-3 text-xs text-[var(--c-text-muted)]">
                      <span className="flex items-center gap-1">
                        <Download size={11} />{fmt(plugin.stats?.downloads)}
                      </span>
                      <span className="flex items-center gap-1">
                        <Star size={11} />{fmt(plugin.stats?.watchers)}
                      </span>
                      <span>{fmtDate(plugin.lastUpdated)}</span>
                    </div>
                  </div>

                  {/* Install button */}
                  <div className="flex items-center flex-shrink-0">
                    {isInstalled ? (
                      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[#00AF5C]/10 text-[#00AF5C] rounded-xl text-xs font-bold border border-[#00AF5C]/20">
                        <Check size={14} /> Installed
                      </div>
                    ) : (
                      <motion.button
                        whileHover={{ scale: 1.03 }}
                        whileTap={{ scale: 0.97 }}
                        onClick={() => handleInstall(plugin)}
                        disabled={isInstalling}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-xs font-bold transition-all disabled:opacity-50 hover:shadow-[0_4px_15px_rgba(0,175,92,0.25)]"
                      >
                        {isInstalling ? (
                          <><Loader2 size={14} className="animate-spin" />Installing...</>
                        ) : (
                          <><Download size={14} />Install</>
                        )}
                      </motion.button>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-[var(--c-border)]">
          <span className="text-xs text-[var(--c-text-muted)]">
            {totalCount.toLocaleString()} plugins • Page {page + 1} of {totalPages}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => handlePageChange(page - 1)}
              disabled={page === 0}
              className="p-2 bg-[var(--c-surface-2)] border border-[var(--c-border)] rounded-xl text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] transition-all disabled:opacity-30"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => handlePageChange(page + 1)}
              disabled={page >= totalPages - 1}
              className="p-2 bg-[var(--c-surface-2)] border border-[var(--c-border)] rounded-xl text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] transition-all disabled:opacity-30"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-3 rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.5)] border ${
              toast.isError
                ? 'bg-[var(--c-surface-2)] border-[var(--c-danger)]/30 text-[var(--c-danger)]'
                : 'bg-[var(--c-surface-2)] border-[#00AF5C]/30 text-[var(--c-text-primary)]'
            }`}
          >
            {toast.isError
              ? <AlertCircle size={16} />
              : <div className="w-2 h-2 rounded-full bg-[#00AF5C] animate-pulse" />}
            <span className="text-sm font-medium">{toast.msg}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
