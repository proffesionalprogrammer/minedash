import React from 'react';
import { Server, Plus, Box, Activity } from 'lucide-react';
import { motion } from 'framer-motion';

function Sidebar({ servers, selectedServer, onSelect, onCreateClick }) {
  return (
    <div className="w-72 h-full bg-[var(--c-surface-2)] flex flex-col pt-6 pb-4 border-r border-[var(--c-border)] relative z-20">
      <div className="px-6 mb-8 flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-[#00AF5C] flex items-center justify-center shadow-[0_4px_12px_rgba(0,175,92,0.2)]">
          <Box className="text-white w-6 h-6" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-[var(--c-text-primary)]">
            MineDash
          </h1>
          <p className="text-[10px] text-[var(--c-text-secondary)] uppercase tracking-widest font-bold">Local Manager</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 space-y-2 custom-scrollbar">
        <h2 className="text-xs font-bold text-[var(--c-text-secondary)] uppercase tracking-wider mb-4 px-2">Servers</h2>
        {servers.map((server) => {
          const isSelected = selectedServer && selectedServer.id === server.id;
          const isOnline = server.status === 'online';

          return (
            <button
              key={server.id}
              onClick={() => onSelect(server)}
              className={`w-full text-left px-4 py-3 rounded-2xl flex items-center gap-3 transition-all duration-200 group relative overflow-hidden ${
                isSelected
                  ? 'bg-[#00AF5C]/10 text-[#00AF5C] ring-1 ring-[#00AF5C]/20'
                  : 'text-[var(--c-text-secondary)] hover:bg-[var(--c-border)] hover:text-[var(--c-text-primary)]'
              }`}
            >
              {isSelected && (
                <motion.div
                  layoutId="sidebar-active-bg"
                  className="absolute inset-0 bg-[#00AF5C]/5 z-0"
                  initial={false}
                  transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                />
              )}
              <div className="relative z-10 flex items-center gap-3 w-full">
                <div className="relative">
                  <Server size={18} className={isSelected ? 'text-[#00AF5C]' : 'text-[var(--c-text-secondary)] group-hover:text-[var(--c-text-primary)]'} />
                  <span
                    className={`absolute -bottom-1 -right-1 w-2.5 h-2.5 rounded-full border-2 border-[var(--c-surface-2)] ${
                      isOnline ? 'bg-[#00AF5C] shadow-[0_0_8px_rgba(0,175,92,0.5)]' : 'bg-[var(--c-text-muted)]'
                    }`}
                  ></span>
                </div>
                <div className="flex-1 truncate">
                  <p className="text-sm font-semibold truncate text-[var(--c-text-primary)]">{server.name}</p>
                  <p className="text-xs text-[var(--c-text-secondary)] font-medium flex items-center gap-1 mt-0.5">
                    {server.type ? server.type.charAt(0).toUpperCase() + server.type.slice(1) : 'Vanilla'} {server.version}
                  </p>
                </div>
                {isOnline && (
                  <Activity size={14} className="text-[#00AF5C] animate-pulse" />
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="px-4 mt-auto pt-4 border-t border-[var(--c-border)]">
        <button
          onClick={onCreateClick}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-[var(--c-surface-2)] border border-[var(--c-border)] hover:border-[var(--c-text-muted)] hover:bg-[var(--c-border)] text-[var(--c-text-primary)] rounded-2xl transition-all duration-200 font-semibold group active:scale-95"
        >
          <Plus size={18} className="text-[var(--c-text-secondary)] group-hover:text-[var(--c-text-primary)] transition-colors" />
          <span>New Server</span>
        </button>
      </div>
    </div>
  );
}

export default Sidebar;
