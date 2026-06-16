import React from 'react';

// Player head avatar. Points at the backend skins route, which always resolves
// to *some* PNG (Steve placeholder on any failure / outage), so there's no
// broken-image state to guard against. Resolution order (MS → mc-heads,
// Ely.by/offline+toggle → ely.by cropped head, else Steve) is decided
// server-side from the (type, uuid, username) we pass through here.
//
// `size` is the rendered CSS size in px; we request 2× pixels so the head stays
// crisp on high-DPI displays. Minecraft heads are pixel art, so we keep
// image-rendering: pixelated rather than letting the browser smooth them.
export default function SkinHead({
  username,
  uuid,
  type,
  size = 24,
  className = '',
  rounded = 'rounded-md',
  elybySkins,   // optional: when provided, busts the cache so a per-account toggle re-fetches
  elybyUuid,    // optional: offline account's resolved Ely.by id; keys the URL to the skin's identity
  bust,         // optional: opaque value (e.g. a timestamp) that forces an immediate re-fetch when it changes
}) {
  if (!username) {
    return (
      <div
        className={`bg-[var(--c-border)] flex-shrink-0 ${rounded} ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }
  const qs = new URLSearchParams({ size: String(Math.round(size * 2)) });
  if (type) qs.set('type', type);
  if (uuid) qs.set('uuid', uuid);
  // The Ely.by id only changes the URL — the backend resolves the skin from disk.
  // Including it means a head first cached as Steve (before the id resolved)
  // re-fetches once the account gains an Ely.by id, instead of serving stale.
  if (elybyUuid) qs.set('eu', elybyUuid);
  // The backend resolves the per-account setting from disk; this param only
  // differentiates the URL so the browser re-fetches after a toggle.
  if (typeof elybySkins === 'boolean') qs.set('v', elybySkins ? '1' : '0');
  // Changes the URL after a "Refresh skin", so the already-mounted <img>
  // re-fetches instead of waiting for a remount.
  if (bust) qs.set('t', String(bust));
  const src = `http://localhost:3001/api/launcher/skins/${encodeURIComponent(username)}/head?${qs.toString()}`;
  return (
    <img
      src={src}
      alt={username}
      width={size}
      height={size}
      draggable={false}
      style={{ width: size, height: size, imageRendering: 'pixelated' }}
      className={`object-cover flex-shrink-0 ${rounded} ${className}`}
    />
  );
}
