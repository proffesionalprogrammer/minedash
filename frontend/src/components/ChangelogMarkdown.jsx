// Minimal markdown renderer for CHANGELOG.md. Supports our changelog style
// only:
//   ### Subheading        → bold green label
//   - bullet              → bullet list
//   **bold**              → strong
//   blank line            → paragraph break
//
// Deliberately ignores everything else (links, images, tables, code, nested
// lists) — our CHANGELOG.md doesn't use them. Keeping this tiny means the
// popup doesn't pull in react-markdown / remark.

// **bold** → <strong>; everything else passes through as plain text. Returns
// an array of React children so React keys stay stable across re-renders.
function renderInline(text) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) {
      return <strong key={i} className="font-bold text-[var(--c-text-primary)]">{p.slice(2, -2)}</strong>;
    }
    return <span key={i}>{p}</span>;
  });
}

export default function ChangelogMarkdown({ text }) {
  // Split into blocks separated by blank lines.
  const blocks = String(text || '').split(/\n\s*\n/);
  return (
    <div className="space-y-3 text-sm text-[var(--c-text-secondary)] leading-relaxed">
      {blocks.map((block, i) => {
        const trimmed = block.trim();
        if (!trimmed) return null;

        // ### Subheading
        if (trimmed.startsWith('### ')) {
          return (
            <h3 key={i} className="text-[10px] uppercase tracking-wider font-bold text-[#00AF5C] pt-2">
              {trimmed.slice(4)}
            </h3>
          );
        }

        // Bullet list — every non-empty line in the block starts with `- `.
        const lines = trimmed.split('\n');
        if (lines.every(l => l.trim().startsWith('- '))) {
          return (
            <ul key={i} className="space-y-2 list-disc pl-5 marker:text-[#00AF5C]">
              {lines.map((l, j) => (
                <li key={j} className="text-[var(--c-text-secondary)]">
                  {renderInline(l.replace(/^\s*-\s+/, ''))}
                </li>
              ))}
            </ul>
          );
        }

        // Nested bullets (a `- ` block whose continuation lines are indented)
        // read fine as one list too — flatten rather than dropping them.
        if (lines[0].trim().startsWith('- ')) {
          return (
            <ul key={i} className="space-y-2 list-disc pl-5 marker:text-[#00AF5C]">
              {lines.filter(l => l.trim().startsWith('- ')).map((l, j) => (
                <li key={j} className="text-[var(--c-text-secondary)]">
                  {renderInline(l.replace(/^\s*-\s+/, ''))}
                </li>
              ))}
            </ul>
          );
        }

        // Default: paragraph (preserve line breaks inside as spaces).
        return (
          <p key={i} className="text-[var(--c-text-secondary)]">
            {renderInline(trimmed.replace(/\n/g, ' '))}
          </p>
        );
      })}
    </div>
  );
}
