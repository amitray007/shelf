import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FileLoadingState } from '../src/components/file-view.js';
import { LazyMarkdownView } from '../src/components/lazy-views.js';
import { MarkdownView } from '../src/components/markdown-view.js';

describe('Markdown module loading', () => {
  it('renders the loading state without a Suspense retry boundary', () => {
    const html = renderToStaticMarkup(<LazyMarkdownView source="# Ready" />);
    expect(html).toBe(renderToStaticMarkup(<FileLoadingState />));
    expect(html).not.toContain('<template');
  });

  it('keeps fenced code plain and escaped in the final document', () => {
    const html = renderToStaticMarkup(
      <MarkdownView source={'# Ready\n\n```html\n<script>alert(1)</script>\n```'} />,
    );
    expect(html).toContain('<h1>Ready</h1>');
    expect(html).toContain(
      '<code class="language-html">&lt;script&gt;alert(1)&lt;/script&gt;\n</code>',
    );
    expect(html).not.toContain('<script>');
  });
});
