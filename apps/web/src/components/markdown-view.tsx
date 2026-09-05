// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Scrollable code blocks and tables must be keyboard reachable.
import type { ComponentPropsWithoutRef } from 'react';
import ReactMarkdown, { type ExtraProps, type UrlTransform } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import 'github-markdown-css/github-markdown-dark.css';
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
  node: _node,
  ...props
}: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
  return <pre tabIndex={0} {...props} />;
}

function ScrollableTable({
  node: _node,
  ...props
}: ComponentPropsWithoutRef<'table'> & ExtraProps) {
  return <table tabIndex={0} {...props} />;
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
        remarkPlugins={[remarkGfm, remarkBreaks]}
        skipHtml={true}
        urlTransform={linkTransform}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
