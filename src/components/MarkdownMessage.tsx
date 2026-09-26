import { Fragment, memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { parseCitationMarkers } from '../citationMarker.ts';
import type { CitationSnapshot } from '../state/models.ts';

function safeHref(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (normalized.startsWith('//')) return null;
  if (/^(https?:|mailto:|tel:)/i.test(normalized)) return normalized;
  if (/^(\/|\.\/|\.\.\/|#|\?)/.test(normalized)) return normalized;
  return null;
}

export interface MarkdownMessageProps {
  content: string;
  /** Components this answer referred to, so its `({1})` markers can resolve. */
  citations?: readonly CitationSnapshot[];
  /** Re-selects the component in the inspected page. */
  onCite?: (selectionId: string) => void;
}

/**
 * A reference the model wrote, rendered as a chip.
 *
 * It is a button rather than a span because the whole point of a citation is
 * being able to follow it: clicking re-selects the component in the target, so
 * "the padding in ({1})" is one click from the element it names.
 */
function CiteButton({
  citation,
  number,
  onCite,
}: {
  citation: CitationSnapshot;
  number: number;
  onCite?: (selectionId: string) => void;
}) {
  const component = citation.component?.trim() || citation.elementKey || 'Component';
  const location = citation.file
    ? citation.line !== null
      ? `${citation.file}:${citation.line}`
      : citation.file
    : citation.mode;
  return (
    <button
      type="button"
      className="cite-inline cite-inline-btn"
      data-number={number}
      title={`${component} · ${location} — click to select it in the target`}
      disabled={!onCite}
      onClick={() => onCite?.(citation.selectionId)}
    >
      <span className="cite-inline-num">{number}</span>
      <span className="cite-inline-name">{component}</span>
    </button>
  );
}

/**
 * Replaces the markers in one run of rendered text with chips.
 *
 * A marker whose number is not among the answer's citations is left as the text
 * the model wrote: it may be quoting the user, and swallowing it would make the
 * transcript disagree with what was actually said.
 */
function withCiteChips(
  text: string,
  citations: ReadonlyMap<number, CitationSnapshot>,
  onCite: MarkdownMessageProps['onCite'],
): ReactNode {
  const segments = parseCitationMarkers(text);
  if (segments.length === 0) return text;
  if (segments.every((segment) => segment.kind === 'text')) return text;
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === 'text') return <Fragment key={index}>{segment.text}</Fragment>;
        const citation = citations.get(segment.number);
        if (!citation) return <Fragment key={index}>{segment.raw}</Fragment>;
        return (
          <CiteButton key={index} citation={citation} number={segment.number} onCite={onCite} />
        );
      })}
    </>
  );
}

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  citations = [],
  onCite,
}: MarkdownMessageProps) {
  const byNumber = new Map<number, CitationSnapshot>();
  for (const citation of citations) byNumber.set(citation.displayNumber, citation);

  const renderText = (node: unknown): ReactNode =>
    typeof node === 'string' ? withCiteChips(node, byNumber, onCite) : null;

  const components: Components = {
    img({ src, alt }) {
      const source = typeof src === 'string' ? src.trim() : '';
      if (!source.startsWith('/') || source.startsWith('//')) {
        return <span className="blocked-image">Image blocked: {alt || 'external source'}</span>;
      }
      return <img src={source} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" />;
    },
    a({ node: _node, href, children, ...props }) {
      const safe = safeHref(href);
      if (!safe) return <span>{children}</span>;
      return (
        <a {...props} href={safe} target="_blank" rel="noopener noreferrer nofollow">
          {children}
        </a>
      );
    },
    // Code and math are somebody else's text: a fenced block or an inline
    // snippet must come through byte for byte.
    code({ children, className }) {
      return <code className={className}>{children}</code>;
    },
    pre({ children }) {
      return <pre>{children}</pre>;
    },
    p({ children }) {
      return <p>{replaceText(children, renderText)}</p>;
    },
    li({ children }) {
      return <li>{replaceText(children, renderText)}</li>;
    },
    td({ children }) {
      return <td>{replaceText(children, renderText)}</td>;
    },
    th({ children }) {
      return <th>{replaceText(children, renderText)}</th>;
    },
    h1({ children }) { return <h1>{replaceText(children, renderText)}</h1>; },
    h2({ children }) { return <h2>{replaceText(children, renderText)}</h2>; },
    h3({ children }) { return <h3>{replaceText(children, renderText)}</h3>; },
    h4({ children }) { return <h4>{replaceText(children, renderText)}</h4>; },
  };

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components}
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

/**
 * Maps the direct string children of a rendered block.
 *
 * Only the immediate strings are touched: a nested `code`, `a` or already
 * transformed element owns its own children, and descending into them would put
 * a chip inside a code span.
 */
function replaceText(children: ReactNode, render: (node: unknown) => ReactNode): ReactNode {
  if (typeof children === 'string') return render(children);
  if (!Array.isArray(children)) return children;
  return children.map((child, index) => (
    typeof child === 'string' ? <Fragment key={index}>{render(child)}</Fragment> : child
  ));
}
