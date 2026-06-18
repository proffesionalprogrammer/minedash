// Markdown render styles tuned for Modrinth body content — headings have
// muted top margin, lists use brand-green markers, links open in new tabs.
// Two variants: full (project descriptions) and compact (version changelogs).
//
// This module owns the react-markdown / remark-gfm imports, which are heavy.
// It lives in its own file so it can be code-split: VersionRow lazy-loads it
// only when a changelog is actually expanded, keeping the markdown ecosystem
// out of the main bundle entirely.
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

// Modrinth bodies are Markdown that frequently embed raw HTML (centered
// paragraphs, anchor links, image banners, sometimes <iframe> video embeds).
// react-markdown ignores raw HTML by default, so without rehype-raw the tags
// show up as literal text on screen. rehype-raw re-parses that HTML into the
// tree; rehype-sanitize then runs LAST to strip anything dangerous (scripts,
// iframes, event handlers, javascript: URLs) from this untrusted third-party
// content while keeping the formatting authors actually use.
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] || []), 'style', 'align', 'className', 'id'],
  },
};
const REHYPE_PLUGINS = [rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA]];

const linkComponent = (props) => (
  <a
    {...props}
    target="_blank"
    rel="noopener noreferrer"
    className="text-[#00AF5C] hover:text-[#00964F] underline decoration-[#00AF5C]/40 hover:decoration-[#00AF5C] transition-colors break-words"
  />
);
const imgComponent = (props) => (
  <img {...props} alt={props.alt || ''} loading="lazy" className="max-w-full h-auto rounded-xl border border-[var(--c-border)] my-3" />
);
const codeComponent = ({ inline, children, ...props }) => {
  if (inline) {
    return <code className="px-1 py-0.5 rounded bg-[var(--c-surface-2)] text-[#00AF5C] text-[0.9em] font-mono" {...props}>{children}</code>;
  }
  return (
    <pre className="bg-[var(--c-base)] border border-[var(--c-border)] rounded-xl p-3 overflow-x-auto custom-scrollbar text-xs my-3">
      <code className="font-mono text-[var(--c-text-secondary)]" {...props}>{children}</code>
    </pre>
  );
};

const MD_COMPONENTS = {
  h1: (p) => <h1 className="text-2xl font-black text-[var(--c-text-primary)] mt-5 mb-2 border-b border-[var(--c-border)] pb-1" {...p} />,
  h2: (p) => <h2 className="text-xl font-bold text-[var(--c-text-primary)] mt-5 mb-2" {...p} />,
  h3: (p) => <h3 className="text-lg font-bold text-[var(--c-text-primary)] mt-4 mb-1.5" {...p} />,
  h4: (p) => <h4 className="text-base font-bold text-[var(--c-text-primary)] mt-3 mb-1" {...p} />,
  p:  (p) => <p className="text-sm text-[var(--c-text-secondary)] my-2 leading-relaxed" {...p} />,
  ul: (p) => <ul className="list-disc pl-5 my-2 space-y-1 text-sm text-[var(--c-text-secondary)] marker:text-[#00AF5C]" {...p} />,
  ol: (p) => <ol className="list-decimal pl-5 my-2 space-y-1 text-sm text-[var(--c-text-secondary)] marker:text-[#00AF5C]" {...p} />,
  li: (p) => <li className="leading-relaxed" {...p} />,
  a:  linkComponent,
  img: imgComponent,
  code: codeComponent,
  blockquote: (p) => <blockquote className="border-l-2 border-[#00AF5C] pl-3 my-3 text-sm text-[var(--c-text-secondary)] italic" {...p} />,
  hr: () => <hr className="my-4 border-[var(--c-border)]" />,
  table: (p) => <div className="overflow-x-auto custom-scrollbar my-3"><table className="min-w-full text-xs border border-[var(--c-border)] rounded-lg overflow-hidden" {...p} /></div>,
  thead: (p) => <thead className="bg-[var(--c-surface-2)] text-[var(--c-text-primary)]" {...p} />,
  th: (p) => <th className="px-3 py-2 text-left font-bold border-b border-[var(--c-border)]" {...p} />,
  td: (p) => <td className="px-3 py-2 border-b border-[var(--c-border)]/50 text-[var(--c-text-secondary)]" {...p} />,
};
const MD_COMPONENTS_COMPACT = {
  ...MD_COMPONENTS,
  h1: (p) => <h1 className="text-base font-bold text-[var(--c-text-primary)] mt-2 mb-1" {...p} />,
  h2: (p) => <h2 className="text-sm font-bold text-[var(--c-text-primary)] mt-2 mb-1" {...p} />,
  h3: (p) => <h3 className="text-sm font-bold text-[var(--c-text-primary)] mt-1.5 mb-0.5" {...p} />,
  p:  (p) => <p className="text-xs text-[var(--c-text-secondary)] my-1 leading-relaxed" {...p} />,
  ul: (p) => <ul className="list-disc pl-4 my-1 space-y-0.5 text-xs text-[var(--c-text-secondary)] marker:text-[#00AF5C]" {...p} />,
  ol: (p) => <ol className="list-decimal pl-4 my-1 space-y-0.5 text-xs text-[var(--c-text-secondary)] marker:text-[#00AF5C]" {...p} />,
};

export default function MarkdownBlock({ compact = false, children }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={REHYPE_PLUGINS} components={compact ? MD_COMPONENTS_COMPACT : MD_COMPONENTS}>
      {children}
    </ReactMarkdown>
  );
}
