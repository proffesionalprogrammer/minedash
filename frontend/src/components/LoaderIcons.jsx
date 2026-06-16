import React from 'react';
import LoaderGlyph from './LoaderGlyph';

// Loader marks for the launcher Play tab + Create Server picker.
//
// Fabric/Forge/NeoForge reuse the official Modrinth loader logos from the
// shared LoaderGlyph (same marks + platform tints as the Browse filter rail),
// so the loader visual language is identical everywhere. Vanilla has no
// official loader logo (LoaderGlyph returns null for it), so we keep a
// pixel-art grass block in the same palette style as TitleBar's mark.

// Minecraft — pixel-art grass block.
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

// Official Modrinth loader logos via the shared glyph.
export function FabricIcon({ size = 18 })   { return <LoaderGlyph loader="fabric" size={size} />; }
export function ForgeIcon({ size = 18 })    { return <LoaderGlyph loader="forge" size={size} />; }
export function NeoForgeIcon({ size = 18 }) { return <LoaderGlyph loader="neoforge" size={size} />; }
