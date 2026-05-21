import { useState, useEffect } from 'react';
import { Minus, X } from 'lucide-react';

// Maximise / restore icon — two overlapping squares
function MaxRestoreIcon({ isMaximized }) {
  return isMaximized ? (
    // Restore: two overlapping squares
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <rect x="2.5" y="0.5" width="8" height="8" rx="0.5" stroke="currentColor" />
      <rect x="0.5" y="2.5" width="8" height="8" rx="0.5" stroke="currentColor" fill="#1A1A1A" />
    </svg>
  ) : (
    // Maximise: single square
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <rect x="0.5" y="0.5" width="10" height="10" rx="0.5" stroke="currentColor" />
    </svg>
  );
}

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const api = window.electronAPI?.windowControls;

  useEffect(() => {
    if (!api) return;
    api.isMaximized().then(setIsMaximized);
    api.onMaximizeChange(setIsMaximized);
  }, []);

  // In browser dev mode, render nothing
  if (!window.electronAPI?.isElectron) return null;

  return (
    <div
      className="flex items-center justify-between h-[38px] bg-[#111111] flex-shrink-0 select-none"
      style={{ WebkitAppRegion: 'drag' }}
    >
      {/* Branding */}
      <div className="flex items-center gap-2 px-4">
        <GrassBlockIcon />
        <span className="text-white font-bold text-sm tracking-wide">MineDash</span>
      </div>

      {/* Window controls — must not be draggable */}
      <div className="flex items-center h-full" style={{ WebkitAppRegion: 'no-drag' }}>
        <TitleBarButton onClick={() => api?.minimize()} label="Minimize">
          <Minus size={11} />
        </TitleBarButton>
        <TitleBarButton onClick={() => api?.maximize()} label="Maximize">
          <MaxRestoreIcon isMaximized={isMaximized} />
        </TitleBarButton>
        <TitleBarButton onClick={() => api?.close()} label="Close" close>
          <X size={12} />
        </TitleBarButton>
      </div>
    </div>
  );
}

function TitleBarButton({ onClick, children, label, close }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={`w-11 h-full flex items-center justify-center transition-colors
        text-[#888888]
        ${close
          ? 'hover:bg-[#FF5555] hover:text-white'
          : 'hover:bg-[#2D2D2D] hover:text-white'
        }`}
    >
      {children}
    </button>
  );
}

// Tiny pixel-art grass block for the title bar
function GrassBlockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 8 8" shape-rendering="crispEdges">
      {/* Grass top */}
      <rect x="0" y="0" width="8" height="3" fill="#5EA91E" />
      <rect x="1" y="0" width="1" height="1" fill="#7DB356" />
      <rect x="4" y="0" width="1" height="1" fill="#7DB356" />
      <rect x="6" y="1" width="1" height="1" fill="#7DB356" />
      <rect x="2" y="1" width="1" height="1" fill="#4CAF50" />
      {/* Dirt */}
      <rect x="0" y="3" width="8" height="5" fill="#96583E" />
      <rect x="1" y="4" width="1" height="1" fill="#C8A882" />
      <rect x="4" y="5" width="1" height="1" fill="#7A4E32" />
      <rect x="6" y="4" width="1" height="1" fill="#7A4E32" />
      <rect x="2" y="6" width="1" height="1" fill="#C8A882" />
      <rect x="5" y="6" width="1" height="1" fill="#8E8E8E" />
    </svg>
  );
}
