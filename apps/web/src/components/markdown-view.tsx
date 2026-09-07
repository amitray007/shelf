// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Scrollable code blocks and tables must be keyboard reachable.
import { type ComponentPropsWithoutRef, isValidElement, type ReactNode } from 'react';
import ReactMarkdown, { type ExtraProps, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import './markdown-view.css';

function safeLink(value: string): string {
  if (value.startsWith('#') || /^(?:\.\.?\/|\/(?!\/))/.test(value)) return value;

  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:'
      ? value
      : '';
  } catch {
    return '';
  }
}

const linkTransform: UrlTransform = (url, key) => (key === 'href' ? safeLink(url) : '');

function SafeAnchor({
  children,
  href,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<'a'> & ExtraProps) {
  const safeHref = href === undefined ? '' : safeLink(href);
  if (safeHref.length === 0) return <span>{children}</span>;
  return (
    <a {...props} href={safeHref} rel="noreferrer noopener" target="_blank">
      {children}
    </a>
  );
}

function ImageDescription({ alt }: ComponentPropsWithoutRef<'img'> & ExtraProps) {
  return <span className="markdown-image-note">{alt ? `[image: ${alt}]` : '[image omitted]'}</span>;
}

function ScrollableCodeBlock({
  children,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
  const language = codeBlockLanguage(children);
  return (
    <div className="markdown-code-block">
      {language === null ? null : (
        <div aria-hidden="true" className="markdown-code-label">
          {language}
        </div>
      )}
      <pre tabIndex={0} {...props}>
        {children}
      </pre>
    </div>
  );
}

function ScrollableTable({
  children,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<'table'> & ExtraProps) {
  return (
    <section aria-label="Scrollable table" className="markdown-table-scroll" tabIndex={0}>
      <table {...props}>{children}</table>
    </section>
  );
}

function codeBlockLanguage(children: ReactNode): string | null {
  if (!isValidElement<{ className?: string }>(children)) return null;
  const match = /(?:^|\s)language-([^\s]+)/u.exec(children.props.className ?? '');
  return match?.[1] ?? null;
}

export function MarkdownView({ source }: { readonly source: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        components={{
          a: SafeAnchor,
          img: ImageDescription,
          pre: ScrollableCodeBlock,
          table: ScrollableTable,
        }}
        remarkPlugins={[remarkGfm]}
        skipHtml={true}
        urlTransform={linkTransform}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
