// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Scrollable code blocks must be keyboard reachable.
import type { ComponentPropsWithoutRef } from 'react';
import ReactMarkdown, { type UrlTransform } from 'react-markdown';

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

function SafeAnchor({ children, href, ...props }: ComponentPropsWithoutRef<'a'>) {
  const safeHref = href === undefined ? '' : safeLink(href);
  if (safeHref.length === 0) return <span>{children}</span>;
  return (
    <a {...props} href={safeHref} rel="noreferrer noopener" target="_blank">
      {children}
    </a>
  );
}

function ImageDescription({ alt }: ComponentPropsWithoutRef<'img'>) {
  return <span className="markdown-image-note">{alt ? `[image: ${alt}]` : '[image omitted]'}</span>;
}

function ScrollableCodeBlock(props: ComponentPropsWithoutRef<'pre'>) {
  return <pre tabIndex={0} {...props} />;
}

export function MarkdownView({ source }: { readonly source: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        components={{ a: SafeAnchor, img: ImageDescription, pre: ScrollableCodeBlock }}
        skipHtml={true}
        urlTransform={linkTransform}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
