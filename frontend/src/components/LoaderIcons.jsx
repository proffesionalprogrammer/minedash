import React, { useId } from 'react';

// Official-style mark for each mod loader, brand-coloured so they read the same
// across Light/Dark/OLED themes (these are theme-invariant brand accents, like
// the loader colours called out in the branding kit). Each accepts `size` so it
// drops straight into the existing `<Icon size={18} />` call sites.

// Minecraft — pixel-art grass block (same palette style as TitleBar's mark).
export function VanillaIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden="true">
      {/* grass top */}
      <rect x="0" y="0" width="8" height="3" fill="#5EA91E" />
      <rect x="0" y="2" width="8" height="1" fill="#4C8C18" />
      <rect x="1" y="0" width="1" height="1" fill="#79C23B" />
      <rect x="4" y="0" width="1" height="1" fill="#79C23B" />
      <rect x="6" y="1" width="1" height="1" fill="#79C23B" />
      {/* dirt */}
      <rect x="0" y="3" width="8" height="5" fill="#8B5A2B" />
      <rect x="1" y="4" width="1" height="1" fill="#A9743C" />
      <rect x="5" y="4" width="1" height="1" fill="#6E4621" />
      <rect x="3" y="6" width="1" height="1" fill="#6E4621" />
      <rect x="6" y="5" width="1" height="1" fill="#A9743C" />
    </svg>
  );
}

// Fabric — folded tan cloth swatch.
export function FabricIcon({ size = 18 }) {
  const clip = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <clipPath id={clip}>
          <rect x="3" y="3" width="18" height="18" rx="4.5" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect x="3" y="3" width="18" height="18" fill="#B5894B" />
        <path d="M3 3 H21 V13 L12 17.5 L3 13 Z" fill="#CBA263" />
        <path d="M3 3 H21 V8 L12 11.5 L3 8 Z" fill="#E3C485" />
      </g>
    </svg>
  );
}

// Forge — classic anvil, gunmetal steel-blue.
export function ForgeIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7 H21 L23 8.5 L20 10 H13.5 V13 H17 L18 16 H6 L7 13 H10.5 V10 H4 Z" fill="#3E5374" />
      <path d="M4 7 H21 L20.4 8 H4.5 Z" fill="#5C76A0" />
    </svg>
  );
}

// NeoForge — same anvil family, signature NeoForge orange.
export function NeoForgeIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7 H21 L23 8.5 L20 10 H13.5 V13 H17 L18 16 H6 L7 13 H10.5 V10 H4 Z" fill="#EC6A2C" />
      <path d="M4 7 H21 L20.4 8 H4.5 Z" fill="#FB9152" />
    </svg>
  );
}
