import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MarkdownView } from '../src/components/markdown-view.js';

describe('Markdown rendering', () => {
  it('drops raw HTML instead of executing or displaying it', () => {
    const html = renderToStaticMarkup(
      <MarkdownView source={'Before\n\n<script>alert(1)</script>\n\nAfter'} />,
    );

    expect(html).toContain('Before');
    expect(html).toContain('After');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });

  it('rejects unsafe link protocols and does not fetch remote Markdown images', () => {
    const html = renderToStaticMarkup(
      <MarkdownView
        source={
          '[unsafe](javascript:alert(1)) [safe](https://example.com) ![track](https://evil.test/x.png)'
        }
      />,
    );

    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).not.toContain('<img');
  });

  it('renders GitHub-flavored tables, task lists, and strikethrough', () => {
    const html = renderToStaticMarkup(
      <MarkdownView
        source={[
          '| State | Owner |',
          '| --- | --- |',
          '| Ready | agent |',
          '',
          '- [x] publish',
          '- [ ] share',
          '',
          '~~discarded~~',
        ].join('\n')}
      />,
    );

    expect(html).toContain('<table tabindex="0">');
    expect(html).not.toContain('node="[object Object]"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('<del>discarded</del>');
  });

  it('keeps unordered, ordered, and nested lists as semantic list markup', () => {
    const html = renderToStaticMarkup(
      <MarkdownView source={['- First', '  - Nested', '', '1. One', '2. Two'].join('\n')} />,
    );

    expect(html).toContain('<ul>');
    expect(html).toMatch(/<li>First\s*<ul>/u);
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>One</li>');
  });

  it('preserves authored line endings inside a paragraph', () => {
    const html = renderToStaticMarkup(
      <MarkdownView source={'**Date:** 2026-09-04\n**Scope:** Pricing research'} />,
    );

    expect(html).toContain('<strong>Date:</strong> 2026-09-04<br/>');
    expect(html).toContain('<strong>Scope:</strong> Pricing research');
  });
});
