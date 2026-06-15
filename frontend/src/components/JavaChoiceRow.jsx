import { Check } from 'lucide-react';

// Selectable runtime row (radio-style), shared by the per-instance Java runtime
// modal and the launcher Settings → Java tab so the two pickers stay identical.
// Module-level so React doesn't remount the rows on every parent render.
export default function ChoiceRow({ active, onSelect, title, subtitle, badge, icon: Icon }) {
  return (
    <button
      onClick={onSelect}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-colors ${
        active
          ? 'bg-[#00AF5C]/10 border-[#00AF5C]/40'
          : 'bg-[#1E1E1E] border-[#2D2D2D] hover:border-[#555555]'
      }`}
    >
      <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 border ${
        active ? 'bg-[#00AF5C] border-[#00AF5C] text-white' : 'border-[#2D2D2D] bg-[#111111]'
      }`}>
        {active && <Check size={12} />}
      </div>
      {Icon && <Icon size={16} className={active ? 'text-[#00AF5C]' : 'text-[#555555]'} />}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-bold text-[#FFFFFF] truncate">{title}</p>
          {badge}
        </div>
        {subtitle && <p className="text-[10px] text-[#A0A0A0] truncate font-mono">{subtitle}</p>}
      </div>
    </button>
  );
}
