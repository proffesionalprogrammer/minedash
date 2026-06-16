import React from 'react';
import { motion } from 'framer-motion';
import Tooltip from '../Tooltip';

// ─── Sparkline helpers ────────────────────────────────────────────────────────
// Catmull-Rom spline → cubic bezier path. Produces a smooth curve through all points.
function smoothPath(pts, tension = 0.5) {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M${pts[0][0]},${pts[0][1]} L${pts[1][0]},${pts[1][1]}`;
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1[0] + (p2[0] - p0[0]) * tension / 3;
    const cp1y = p1[1] + (p2[1] - p0[1]) * tension / 3;
    const cp2x = p2[0] - (p3[0] - p1[0]) * tension / 3;
    const cp2y = p2[1] - (p3[1] - p1[1]) * tension / 3;
    d += ` C${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d;
}

// Centered moving average — smooths jittery samples so the curve reads as a calm wave
// rather than a literal trace of every spike.
function movingAverage(data, window = 7) {
  if (!data || data.length === 0) return data;
  const half = Math.floor(window / 2);
  const out = new Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(data.length, i + half + 1);
    let sum = 0;
    for (let j = start; j < end; j++) sum += data[j];
    out[i] = sum / (end - start);
  }
  return out;
}

// Full-width responsive sparkline. Uses viewBox + preserveAspectRatio="none" to
// stretch horizontally, and vectorEffect="non-scaling-stroke" to keep the line crisp.
export function Sparkline({ data, color = '#00AF5C', height = 56 }) {
  if (!data || data.length < 2) {
    return <div style={{ height }} className="w-full" />;
  }
  const smoothed = movingAverage(data, 9);
  const VIEW_W = 200;
  const topPad = 6;          // breathing room at top so the peak isn't flush against the card text
  const bottomPad = 0;       // line touches the card's bottom edge
  const usableH = height - topPad - bottomPad;
  const min = Math.min(...smoothed);
  const max = Math.max(...smoothed);
  const range = max - min;
  const stepX = VIEW_W / (smoothed.length - 1);
  const pts = smoothed.map((v, i) => {
    const x = i * stepX;
    // Anchor a flat series to the bottom if it's all zero (e.g. server offline),
    // otherwise centre flat series mid-card.
    const norm = range === 0
      ? (max === 0 ? 0 : 0.5)
      : (v - min) / range;
    const y = topPad + (1 - norm) * usableH;
    return [x, y];
  });
  const linePath = smoothPath(pts, 0.6);
  const areaPath = `${linePath} L${VIEW_W},${height} L0,${height} Z`;
  const gradientId = `sg-${color.replace('#', '')}`;
  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${height}`}
      preserveAspectRatio="none"
      className="w-full block"
      style={{ height }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.30" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <motion.g
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
      >
        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </motion.g>
    </svg>
  );
}

// ─── StatCard ─────────────────────────────────────────────────────────────────
// Modrinth-style hosting stat tile: big value top-left, icon top-right, optional
// sparkline anchored to the bottom edge. Pass `history={undefined}` to omit the
// sparkline entirely (used for the Players card where there's no time series).
export default function StatCard({ icon, label, detail, value, secondary, color, history, onDoubleClick, hint }) {
  const lineColor = color || '#00AF5C';
  const card = (
    <motion.div
      whileHover={{ y: -2 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      onDoubleClick={onDoubleClick}
      className={`w-full bg-[var(--c-surface-2)] border border-[var(--c-border)] hover:border-[var(--c-border-soft)] rounded-2xl overflow-hidden transition-colors flex flex-col ${onDoubleClick ? 'cursor-pointer' : 'cursor-default'}`}
    >
      <div className={`px-5 pt-5 flex-1 ${history === undefined ? 'pb-5' : 'pb-3'}`}>
        <div className="flex items-start justify-between mb-1">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-3xl font-bold tabular-nums text-[var(--c-text-primary)] truncate">{value}</span>
            {secondary && (
              <span className="text-sm font-medium text-[var(--c-text-muted)] tabular-nums flex-shrink-0">/ {secondary}</span>
            )}
          </div>
          <div className="text-[var(--c-text-muted)] flex-shrink-0 mt-1">
            {React.cloneElement(icon, { size: 18 })}
          </div>
        </div>
        <p className="text-sm font-medium text-[var(--c-text-secondary)]">
          {label}
          {detail && <span className="text-[var(--c-text-muted)]"> · <span className="tabular-nums">{detail}</span></span>}
        </p>
      </div>
      {history !== undefined && <Sparkline data={history} color={lineColor} height={56} />}
    </motion.div>
  );
  if (!hint) return card;
  return <Tooltip content={hint} side="bottom" className="w-full">{card}</Tooltip>;
}
