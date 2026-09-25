// The MineDash mark: a pixel "M" on a brand-green tile. The same drawing lives
// in public/favicon.svg, electron/splash.html and electron/assets/icon.ico —
// change them together.
export default function MineDashLogo({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#00AF5C" />
      <path fill="#fff" shapeRendering="crispEdges" d="M6 6h4v20H6zM22 6h4v20h-4zM10 10h4v4h-4zM18 10h4v4h-4zM14 14h4v4h-4z" />
    </svg>
  );
}
