import { useState } from 'react';
import { ChevronUp, ChevronDown, X, Plus, Trash2, Loader2 } from 'lucide-react';

// Small shared building blocks for the per-instance management panels. Kept in
// their own file (components-only export) so they can be reused across the
// Settings / Worlds / Java panels without tripping the react-refresh lint rule.

// Labelled block with an optional uppercase label, leading icon, and a
// right-aligned action slot.
export function Field({ label, icon: Icon, action, children }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs uppercase tracking-wider font-bold text-[var(--c-text-muted)] flex items-center gap-1.5">
          {Icon && <Icon size={13} />}
          {label}
        </label>
        {action}
      </div>
      {children}
    </div>
  );
}

// Pill toggle with an on/off label beside it.
export function ToggleChip({ on, onLabel, offLabel, onToggle, disabled }) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className="flex items-center gap-1.5 text-xs font-bold transition-colors disabled:opacity-50"
    >
      <span className={`relative w-9 h-5 rounded-full transition-colors ${on ? 'bg-[#00AF5C]' : 'bg-[var(--c-border)]'}`}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
      <span className={on ? 'text-[#00AF5C]' : 'text-[var(--c-text-secondary)]'}>{on ? onLabel : offLabel}</span>
    </button>
  );
}

export function SecondaryButton({ icon: Icon, label, onClick, busy, danger }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-sm font-bold border transition-colors disabled:opacity-50 ${
        danger
          ? 'text-[var(--c-danger)] border-[var(--c-danger)]/30 hover:bg-[var(--c-danger)]/10'
          : 'text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] bg-[var(--c-surface-2)] hover:bg-[var(--c-border)] border-[var(--c-border)]'
      }`}
    >
      {busy ? <Loader2 size={15} className="animate-spin" /> : Icon && <Icon size={15} />}
      {label}
    </button>
  );
}

// Number input without the light-grey OS spinner arrows (branded chevrons instead).
export function NumberInput({ value, onChange, min, step = 1, disabled }) {
  const clamp = (n) => (typeof min === 'number' && n < min ? min : n);
  const bump = (delta) => onChange(clamp(Number(value || 0) + delta));
  return (
    <div className={`relative w-full ${disabled ? 'opacity-40' : ''}`}>
      <input
        type="number" min={min} step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        className="branded-number w-full bg-[var(--c-base)] border border-[var(--c-border)] focus:border-[#00AF5C] rounded-xl pl-3 pr-8 py-2 text-sm text-[var(--c-text-primary)] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all tabular-nums"
      />
      <div className="absolute right-1 top-1 bottom-1 flex flex-col gap-0.5 pointer-events-none">
        <button type="button" tabIndex={-1} onClick={() => bump(step)} disabled={disabled}
          className="pointer-events-auto flex-1 px-1.5 flex items-center justify-center rounded-md text-[var(--c-text-muted)] hover:text-[#00AF5C] hover:bg-[#00AF5C]/10 transition-colors disabled:hover:bg-transparent">
          <ChevronUp size={10} strokeWidth={3} />
        </button>
        <button type="button" tabIndex={-1} onClick={() => bump(-step)} disabled={disabled}
          className="pointer-events-auto flex-1 px-1.5 flex items-center justify-center rounded-md text-[var(--c-text-muted)] hover:text-[#00AF5C] hover:bg-[#00AF5C]/10 transition-colors disabled:hover:bg-transparent">
          <ChevronDown size={10} strokeWidth={3} />
        </button>
      </div>
    </div>
  );
}

// Monospace command / path input.
export function MonoInput({ value, onChange, placeholder, disabled }) {
  return (
    <input
      type="text"
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      disabled={disabled}
      className="w-full bg-[var(--c-base)] border border-[var(--c-border)] focus:border-[#00AF5C] rounded-xl px-3 py-2.5 text-sm text-[var(--c-text-primary)] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[var(--c-text-muted)] font-mono disabled:opacity-40"
    />
  );
}

// Labelled checkbox row.
export function CheckRow({ checked, onChange, disabled, children }) {
  return (
    <label className={`flex items-center gap-2 text-sm text-[var(--c-text-secondary)] ${disabled ? 'opacity-40' : 'cursor-pointer hover:text-[var(--c-text-primary)]'}`}>
      <span className="custom-checkbox-wrapper">
        <input type="checkbox" className="custom-checkbox" checked={checked} onChange={onChange} disabled={disabled} />
        <span className="custom-checkbox-visual" />
      </span>
      {children}
    </label>
  );
}

// Name/value environment-variable editor. `value` is [{ name, value }]; calls
// onChange with the filtered (named-only) list on every edit.
export function EnvVarsEditor({ value, onChange, disabled }) {
  const [rows, setRows] = useState(() =>
    (Array.isArray(value) ? value : []).map(e => ({ name: e?.name || '', value: e?.value || '' }))
  );
  const persist = (next) =>
    onChange(next.filter(r => r.name.trim()).map(r => ({ name: r.name.trim(), value: r.value })));
  const update = (i, key, val) => { const next = rows.map((r, idx) => idx === i ? { ...r, [key]: val } : r); setRows(next); persist(next); };
  const add = () => setRows([...rows, { name: '', value: '' }]);
  const remove = (i) => { const next = rows.filter((_, idx) => idx !== i); setRows(next); persist(next); };

  return (
    <div className={disabled ? 'opacity-40 pointer-events-none' : ''}>
      {rows.length > 0 && (
        <div className="space-y-2 mb-3">
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2 px-1">
            <span className="text-[10px] uppercase tracking-wider font-bold text-[var(--c-text-muted)]">Name</span>
            <span className="text-[10px] uppercase tracking-wider font-bold text-[var(--c-text-muted)]">Value</span>
            <span className="w-8" />
          </div>
          {rows.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
              <input type="text" value={row.name} onChange={(e) => update(i, 'name', e.target.value)} placeholder="NAME" spellCheck={false}
                className="w-full bg-[var(--c-base)] border border-[var(--c-border)] focus:border-[#00AF5C] rounded-xl px-3 py-2 text-sm text-[var(--c-text-primary)] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[var(--c-text-muted)] font-mono" />
              <input type="text" value={row.value} onChange={(e) => update(i, 'value', e.target.value)} placeholder="value" spellCheck={false}
                className="w-full bg-[var(--c-base)] border border-[var(--c-border)] focus:border-[#00AF5C] rounded-xl px-3 py-2 text-sm text-[var(--c-text-primary)] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[var(--c-text-muted)] font-mono" />
              <button onClick={() => remove(i)} title="Remove"
                className="w-8 h-8 flex items-center justify-center rounded-xl text-[var(--c-text-muted)] hover:text-[var(--c-danger)] hover:bg-[var(--c-danger)]/10 transition-colors">
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
      {rows.length === 0 && (
        <p className="text-xs text-[var(--c-text-muted)] mb-3 italic">No environment variables set.</p>
      )}
      <div className="flex gap-2">
        <button onClick={add}
          className="flex items-center gap-1.5 px-3 py-2 bg-[#00AF5C]/10 hover:bg-[#00AF5C]/15 border border-[#00AF5C]/30 text-[#00AF5C] rounded-xl text-xs font-bold transition-colors">
          <Plus size={14} /> Add variable
        </button>
        {rows.length > 0 && (
          <button onClick={() => { setRows([]); persist([]); }}
            className="flex items-center gap-1.5 px-3 py-2 bg-[var(--c-base)] hover:bg-[var(--c-border)] border border-[var(--c-border)] hover:border-[var(--c-text-muted)] text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] rounded-xl text-xs font-bold transition-colors">
            <Trash2 size={14} /> Clear all
          </button>
        )}
      </div>
    </div>
  );
}

// An overridable settings section: a header row with title + "Custom / Global"
// toggle. When `on`, renders its editable controls; when off, a muted summary
// line explaining it inherits the global value.
export function OverrideSection({ icon: Icon, title, on, onToggle, summary, children }) {
  return (
    <div className="bg-[var(--c-surface-2)] border border-[var(--c-border)] rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="flex items-center gap-2 text-sm font-bold text-[var(--c-text-primary)]">
          {Icon && <Icon size={15} className="text-[var(--c-text-secondary)]" />}
          {title}
        </span>
        <ToggleChip on={on} onLabel="Custom" offLabel="Global" onToggle={onToggle} />
      </div>
      {on ? children : (
        <p className="text-xs text-[var(--c-text-secondary)] leading-relaxed">{summary}</p>
      )}
    </div>
  );
}
