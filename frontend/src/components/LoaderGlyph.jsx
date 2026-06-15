import React from 'react';

// Official loader logos, taken verbatim from Modrinth's own asset set
// (modrinth/code · packages/assets/icons/tags/loaders). They're single-color
// line marks that inherit `currentColor`; we tint each with Modrinth's
// dark-theme platform color so they read the same in Browse and Instances.
//
// Shared by BrowseSection (filter rail) and InstancesSection (corner badge) so
// the loader visual language is identical across the launcher.
const LOADER_COLORS = {
  fabric:   '#dbb69b',
  forge:    '#959eef',
  neoforge: '#f99e6b',
  quilt:    '#c796f9',
};

// Returns null for loaders without a dedicated mark (e.g. vanilla) — callers
// fall back to a lucide glyph in that case.
export default function LoaderGlyph({ loader, size = 16 }) {
  const common = {
    width: size, height: size, viewBox: '0 0 24 24',
    style: { color: LOADER_COLORS[loader] || '#A0A0A0' }, 'aria-hidden': 'true',
  };
  switch (loader) {
    case 'fabric':
      return (
        <svg {...common} fill="none" fillRule="evenodd" strokeLinecap="round" strokeLinejoin="round" clipRule="evenodd">
          <path fill="none" stroke="currentColor" strokeWidth="23" d="m820 761-85.6-87.6c-4.6-4.7-10.4-9.6-25.9 1-19.9 13.6-8.4 21.9-5.2 25.4 8.2 9 84.1 89 97.2 104 2.5 2.8-20.3-22.5-6.5-39.7 5.4-7 18-12 26-3 6.5 7.3 10.7 18-3.4 29.7-24.7 20.4-102 82.4-127 103-12.5 10.3-28.5 2.3-35.8-6-7.5-8.9-30.6-34.6-51.3-58.2-5.5-6.3-4.1-19.6 2.3-25 35-30.3 91.9-73.8 111.9-90.8" transform="matrix(.08671 0 0 .0867 -49.8 -56)" />
        </svg>
      );
    case 'forge':
      return (
        <svg {...common} fill="none" fillRule="evenodd" strokeLinecap="round" strokeLinejoin="round" strokeMiterlimit="1.5" clipRule="evenodd">
          <path fill="none" stroke="currentColor" strokeWidth="2" d="M2 7.5h8v-2h12v2s-7 3.4-7 6 3.1 3.1 3.1 3.1l.9 3.9H5l1-4.1s3.8.1 4-2.9c.2-2.7-6.5-.7-8-6Z" />
        </svg>
      );
    case 'neoforge':
      return (
        <svg {...common}>
          <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
            <path d="m12 19.2v2m0-2v2" />
            <path d="m8.4 1.3c0.5 1.5 0.7 3 0.1 4.6-0.2 0.5-0.9 1.5-1.6 1.5m8.7-6.1c-0.5 1.5-0.7 3-0.1 4.6 0.2 0.6 0.9 1.5 1.6 1.5" />
            <path d="m3.6 15.8h-1.7m18.5 0h1.7" />
            <path d="m3.2 12.1h-1.7m19.3 0h1.8" />
            <path d="m8.1 12.7v1.6m7.8-1.6v1.6" />
            <path d="m10.8 18h1.2m0 1.2-1.2-1.2m2.4 0h-1.2m0 1.2 1.2-1.2" />
            <path d="m4 9.7c-0.5 1.2-0.8 2.4-0.8 3.7 0 3.1 2.9 6.3 5.3 8.2 0.9 0.7 2.2 1.1 3.4 1.1m0.1-17.8c-1.1 0-2.1 0.2-3.2 0.7m11.2 4.1c0.5 1.2 0.8 2.4 0.8 3.7 0 3.1-2.9 6.3-5.3 8.2-0.9 0.7-2.2 1.1-3.4 1.1m-0.1-17.8c1.1 0 2.1 0.2 3.2 0.7" />
            <path d="m4 9.7c-0.2-1.8-0.3-3.7 0.5-5.5s2.2-2.6 3.9-3m11.6 8.5c0.2-1.9 0.3-3.7-0.5-5.5s-2.2-2.6-3.9-3" />
            <path d="m12 21.2-2.4 0.4m2.4-0.4 2.4 0.4" />
          </g>
        </svg>
      );
    case 'quilt':
      return (
        <svg {...common} fill="none" fillRule="evenodd" strokeLinecap="round" strokeLinejoin="round" strokeMiterlimit="2" clipRule="evenodd">
          <path fill="none" stroke="currentColor" strokeWidth="65.6" d="M442.5 233.9c0-6.4-5.2-11.6-11.6-11.6h-197c-6.4 0-11.6 5.2-11.6 11.6v197c0 6.4 5.2 11.6 11.6 11.6h197c6.4 0 11.6-5.2 11.6-11.7v-197 .1Z" transform="matrix(.03053 0 0 .03046 -3.2 -3.2)" />
          <path fill="none" stroke="currentColor" strokeWidth="65.6" d="M442.5 233.9c0-6.4-5.2-11.6-11.6-11.6h-197c-6.4 0-11.6 5.2-11.6 11.6v197c0 6.4 5.2 11.6 11.6 11.6h197c6.4 0 11.6-5.2 11.6-11.7v-197 .1Z" transform="matrix(.03053 0 0 .03046 -3.2 7)" />
          <path fill="none" stroke="currentColor" strokeWidth="65.6" d="M442.5 233.9c0-6.4-5.2-11.6-11.6-11.6h-197c-6.4 0-11.6 5.2-11.6 11.6v197c0 6.4 5.2 11.6 11.6 11.6h197c6.4 0 11.6-5.2 11.6-11.7v-197 .1Z" transform="matrix(.03053 0 0 .03046 6.9 -3.2)" />
          <path fill="none" stroke="currentColor" strokeWidth="70.4" d="M442.5 234.8c0-7-5.6-12.5-12.5-12.5H234.7c-6.8 0-12.4 5.6-12.4 12.5V430c0 6.9 5.6 12.5 12.4 12.5H430c6.9 0 12.5-5.6 12.5-12.5V234.8Z" transform="rotate(45 3.5 24) scale(.02843 .02835)" />
        </svg>
      );
    default:
      return null;
  }
}
