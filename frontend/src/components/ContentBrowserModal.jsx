import React from 'react';
import { Download, X } from 'lucide-react';
import { motion } from 'framer-motion';
import LauncherContent from './LauncherContent';
import ModalPortal from './ModalPortal';

// Modal shell that hosts the LauncherContent browser. Opened from the
// "Content" button on the Profile card. Centered, large, with a backdrop.
export default function ContentBrowserModal({ loader, version, instanceId, instanceName, socket, onClose, onError, modpackInstalls, onOpenDetail }) {
  return (
    <ModalPortal>
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-[#000000]/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.92, opacity: 0, y: 8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.92, opacity: 0, y: 8 }}
        transition={{ type: 'spring', duration: 0.35, bounce: 0.15 }}
        className="bg-[#111111] border border-[#2D2D2D] rounded-3xl shadow-[0_20px_60px_rgba(0,0,0,0.7)] w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2D2D2D] flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 bg-[#00AF5C]/10 rounded-xl flex-shrink-0">
              <Download size={18} className="text-[#00AF5C]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-[#FFFFFF] truncate">Browse content</h2>
              <p className="text-xs text-[#A0A0A0] truncate capitalize">
                Installing into <span className="font-bold text-[#FFFFFF]">{loader} {version}</span>
                {instanceName && <span className="font-bold text-[#FFFFFF]"> · {instanceName}</span>}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-[#A0A0A0] hover:text-[#FFFFFF] hover:bg-[#2D2D2D] rounded-xl transition-all"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar p-5">
          <LauncherContent loader={loader} version={version} instanceId={instanceId} socket={socket} onError={onError} modpackInstalls={modpackInstalls} inModal onOpenDetail={onOpenDetail} />
        </div>
      </motion.div>
    </motion.div>
    </ModalPortal>
  );
}
