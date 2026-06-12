import React, { useState } from 'react';
import { Search, Plus, Server, Flame, Link as LinkIcon, Gamepad2, Settings, Trash2, Copy, X, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { staggerContainer, staggerItem, modalBackdrop, modalPanel } from '../lib/motion';
import Tooltip from './Tooltip';

export default function ServersList({ servers, onSelect, onCreateClick }) {
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [cloneTarget, setCloneTarget] = useState(null);
  const [cloneName, setCloneName] = useState('');
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState('');

  const openClone = (server) => {
    setCloneTarget(server);
    setCloneName(`${server.name} (Copy)`);
    setCloneError('');
  };

  const confirmClone = async () => {
    if (!cloneTarget) return;
    const name = cloneName.trim();
    if (!name) { setCloneError('Name cannot be empty.'); return; }
    if (servers.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      setCloneError('A server with this name already exists.');
      return;
    }
    setCloning(true);
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${cloneTarget.id}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to clone server');
      setCloneTarget(null);
    } catch (err) {
      setCloneError(err.message);
    }
    setCloning(false);
  };

  const filteredServers = servers.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    (s.customUrl && s.customUrl.toLowerCase().includes(search.toLowerCase()))
  );

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${deleteTarget.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete server');
    } catch (err) {
      console.error(err);
    }
    setDeleting(false);
    setDeleteTarget(null);
  };

  const hasNoServers = servers.length === 0;

  return (
    <div className="flex-1 flex flex-col h-full bg-[#111111] p-8 md:p-12 overflow-y-auto custom-scrollbar relative">
      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {deleteTarget && (
        <motion.div variants={modalBackdrop} initial="initial" animate="animate" exit="exit" className="fixed inset-0 bg-[#000000]/80 z-50 flex items-center justify-center backdrop-blur-sm">
          <motion.div variants={modalPanel} initial="initial" animate="animate" exit="exit" className="bg-[#1A1A1A] border border-[#2D2D2D] p-6 rounded-3xl w-full max-w-md shadow-2xl mx-4">
            <h3 className="text-xl font-bold text-[#FFFFFF] mb-2">Delete Server</h3>
            <p className="text-[#A0A0A0] text-sm mb-6 leading-relaxed">
              Are you sure you want to permanently delete <span className="text-white font-bold">{deleteTarget.name}</span>?
              This will destroy all files, mods, and worlds. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3 pt-4 border-t border-[#2D2D2D]">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="px-4 py-2 bg-[#111111] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#FFFFFF] rounded-xl text-sm font-bold transition-all"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="px-4 py-2 bg-[#FF5555] hover:bg-[#FF4444] text-white rounded-xl text-sm font-bold transition-all flex items-center gap-2 disabled:opacity-50"
              >
                <Trash2 size={16} /> Delete Permanently
              </button>
            </div>
          </motion.div>
        </motion.div>
        )}
      </AnimatePresence>

      {/* Clone Server Modal */}
      <AnimatePresence>
        {cloneTarget && (
          <motion.div
            variants={modalBackdrop} initial="initial" animate="animate" exit="exit"
            className="fixed inset-0 bg-[#000000]/80 z-50 flex items-center justify-center backdrop-blur-sm"
            onClick={() => !cloning && setCloneTarget(null)}
          >
            <motion.div
              variants={modalPanel} initial="initial" animate="animate" exit="exit"
              className="bg-[#1A1A1A] border border-[#2D2D2D] p-6 rounded-3xl w-full max-w-md shadow-2xl mx-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-[#00AF5C]/10 rounded-xl">
                    <Copy size={16} className="text-[#00AF5C]" />
                  </div>
                  <h3 className="text-lg font-bold text-[#FFFFFF]">Clone Server</h3>
                </div>
                <button
                  onClick={() => !cloning && setCloneTarget(null)}
                  className="p-1.5 text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#2D2D2D] rounded-lg transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
              <p className="text-sm text-[#A0A0A0] mb-4 leading-relaxed">
                Duplicate <span className="text-white font-bold">{cloneTarget.name}</span> — files, mods, world, config. The clone starts offline with a fresh address.
              </p>
              {cloneTarget.status === 'online' && (
                <div className="flex items-start gap-2 px-3 py-2 mb-4 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-400">
                  <span className="font-bold">⚠</span>
                  <span>This server is online. Stop it before cloning — the JVM holds file locks that would corrupt the copy.</span>
                </div>
              )}
              <label className="text-xs font-bold text-[#A0A0A0] block mb-1.5">New server name</label>
              <input
                autoFocus
                type="text"
                value={cloneName}
                onChange={(e) => { setCloneName(e.target.value); if (cloneError) setCloneError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') confirmClone(); if (e.key === 'Escape') setCloneTarget(null); }}
                placeholder="My Server (Copy)"
                disabled={cloning}
                className={`w-full bg-[#111111] border ${cloneError ? 'border-[#FF5555] focus:border-[#FF5555] focus:ring-[#FF5555]/10' : 'border-[#2D2D2D] focus:border-[#00AF5C] focus:ring-[#00AF5C]/10'} rounded-xl px-3 py-2.5 text-sm text-[#FFFFFF] outline-none transition-all focus:ring-4 font-medium placeholder-[#555555]`}
              />
              {cloneError && <p className="text-xs text-[#FF5555] font-medium mt-2">{cloneError}</p>}
              <div className="flex justify-end gap-3 pt-5 mt-5 border-t border-[#2D2D2D]">
                <button
                  onClick={() => setCloneTarget(null)}
                  disabled={cloning}
                  className="px-4 py-2 bg-[#111111] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#FFFFFF] rounded-xl text-sm font-bold transition-all duration-200 disabled:opacity-50 hover:scale-[1.02] active:scale-95"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmClone}
                  disabled={cloning || !cloneName.trim() || cloneTarget.status === 'online'}
                  className="px-4 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-sm font-bold transition-all duration-200 flex items-center gap-2 disabled:opacity-50 hover:scale-[1.02] active:scale-95"
                >
                  {cloning && <Loader2 size={14} className="animate-spin" />}
                  {cloning ? 'Cloning...' : 'Clone Server'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Empty state — no servers at all */}
      {hasNoServers ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-6 text-center">

          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
            className="flex flex-col items-center gap-6"
          >
            <div className="w-20 h-20 bg-[#1E1E1E] border border-[#2D2D2D] rounded-3xl flex items-center justify-center">
              <Server size={36} className="text-[#555555]" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-[#FFFFFF] mb-2">No servers yet</h2>
              <p className="text-[#555555] text-sm max-w-xs">Create your first Minecraft server to get started. It only takes a minute.</p>
            </div>
            <motion.button
              whileHover={{ scale: 1.03, boxShadow: '0 4px 20px rgba(0,175,92,0.3)' }}
              whileTap={{ scale: 0.97 }}
              onClick={onCreateClick}
              className="flex items-center gap-2 px-6 py-3 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl font-bold transition-all shadow-sm"
            >
              <Plus size={20} />
              Create New Server
            </motion.button>
          </motion.div>

          <div className="absolute bottom-8 flex items-center gap-2 text-[#333333] text-xs">
            <Flame size={14} /> Powered by MineDash
          </div>
        </div>
      ) : (
        /* Normal state — servers exist */
        <div className="max-w-5xl mx-auto w-full">
          <div className="flex flex-col md:flex-row items-center justify-between mb-8 gap-4">
            <div className="flex items-center gap-3 w-full md:w-auto md:ml-auto">
              <div className="relative flex-1 md:w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555555]" size={18} />
                <input
                  type="text"
                  placeholder="Search servers..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full bg-[#1E1E1E] border border-[#2D2D2D] rounded-xl pl-10 pr-4 py-2.5 text-[#FFFFFF] focus:outline-none focus:border-[#00AF5C] focus:ring-4 focus:ring-[#00AF5C]/10 transition-all duration-300 text-sm"
                />
              </div>

              <button
                onClick={onCreateClick}
                className="flex items-center gap-2 px-4 py-2.5 bg-[#1E1E1E] hover:bg-[#2D2D2D] border border-[#2D2D2D] text-[#FFFFFF] rounded-xl transition-all duration-200 shadow-sm font-bold text-sm whitespace-nowrap hover:scale-[1.02] active:scale-95"
              >
                <Plus size={18} />
                New server
              </button>

            </div>
          </div>

          <motion.div className="flex flex-col gap-4" variants={staggerContainer} initial="initial" animate="animate">
            {filteredServers.map((server) => (
              <motion.div
                key={server.id}
                variants={staggerItem}
                whileHover={{ scale: 1.01, borderColor: '#555555' }}
                className="bg-[#1E1E1E] border border-[#2D2D2D] rounded-2xl p-4 flex items-center gap-6 transition-colors group cursor-pointer"
              >
                <div
                  onClick={() => onSelect(server)}
                  className="flex items-center gap-6 flex-1 cursor-pointer"
                >
                  <div className="w-20 h-20 bg-[#111111] rounded-xl overflow-hidden border border-[#2D2D2D] flex-shrink-0 flex items-center justify-center">
                    <img
                      src={`http://localhost:3001/api/servers/${server.id}/icon.png`}
                      alt="Icon"
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        e.target.style.display = 'none';
                        e.target.nextSibling.style.display = 'block';
                      }}
                    />
                    <Server className="text-[#555555] hidden" size={32} />
                  </div>

                  <div className="flex-1 flex flex-col justify-center">
                    <div className="flex items-center gap-2 mb-2">
                      <h3 className="text-xl font-bold text-[#FFFFFF] group-hover:text-[#00AF5C] transition-colors">{server.name}</h3>
                      <span className="text-[#555555]">&gt;</span>
                    </div>

                    <div className="flex items-center gap-4 text-sm text-[#A0A0A0]">
                      <div className="flex items-center gap-1.5">
                        <Gamepad2 size={16} />
                        <span>Minecraft {server.version}</span>
                      </div>
                      <div className="w-px h-3 bg-[#2D2D2D]"></div>
                      <div className="flex items-center gap-1.5">
                        <Settings size={16} />
                        <span className="capitalize">{server.type} {server.version}</span>
                      </div>
                      {server.customUrl && (
                        <>
                          <div className="w-px h-3 bg-[#2D2D2D]"></div>
                          <div className="flex items-center gap-1.5">
                            <LinkIcon size={16} />
                            <span>{server.customUrl}</span>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 flex-shrink-0">
                  {server.status === 'online' && (
                    <div className="px-3 py-1 bg-[#00AF5C]/10 border border-[#00AF5C]/20 text-[#00AF5C] rounded-full text-xs font-bold flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-[#00AF5C] animate-pulse-glow"></span>
                      Online
                    </div>
                  )}
                  <Tooltip content="Clone Server">
                    <button
                      onClick={(e) => { e.stopPropagation(); openClone(server); }}
                      className="p-2 text-[#A0A0A0] hover:text-[#00AF5C] hover:bg-[#00AF5C]/10 rounded-xl transition-all opacity-0 group-hover:opacity-100 focus:opacity-100"
                    >
                      <Copy size={18} />
                    </button>
                  </Tooltip>
                  <Tooltip content="Delete Server" align="end">
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeleteTarget(server); }}
                      className="p-2 text-[#A0A0A0] hover:text-[#FF5555] hover:bg-[#FF5555]/10 rounded-xl transition-all opacity-0 group-hover:opacity-100 focus:opacity-100"
                    >
                      <Trash2 size={18} />
                    </button>
                  </Tooltip>
                </div>
              </motion.div>
            ))}

            {filteredServers.length === 0 && (
              <div className="text-center py-12 text-[#A0A0A0]">
                <Server size={48} className="mx-auto mb-4 opacity-40" />
                <p>No servers found.</p>
              </div>
            )}
          </motion.div>

          <div className="mt-12 text-center text-[#555555] text-sm flex items-center justify-center gap-2">
            <Flame size={16} /> Powered by MineDash
          </div>
        </div>
      )}
    </div>
  );
}
