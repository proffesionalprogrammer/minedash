import React from 'react';
import LoaderGlyph from './LoaderGlyph';

// Loader marks for the launcher Play tab + Create Server picker.
//
// All four delegate to the shared LoaderGlyph (same marks + tints as the Browse
// filter rail and instance cards), so the loader visual language is identical
// everywhere. Fabric/Forge/NeoForge are Modrinth's official logos; Vanilla is a
// line-art block drawn to match them.
export function VanillaIcon({ size = 18 })  { return <LoaderGlyph loader="vanilla" size={size} />; }
export function FabricIcon({ size = 18 })   { return <LoaderGlyph loader="fabric" size={size} />; }
export function ForgeIcon({ size = 18 })    { return <LoaderGlyph loader="forge" size={size} />; }
export function NeoForgeIcon({ size = 18 }) { return <LoaderGlyph loader="neoforge" size={size} />; }
