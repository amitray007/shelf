import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MarkdownView } from '../src/components/markdown-view.js';

describe('Markdown rendering', () => {
  it.each(['\n', '\r\n'])(
    'shows YAML front matter in a closed disclosure with %j line endings',
    (newline) => {
      const source = [
        '\uFEFF---',
        'title: Migration plan',
        'status: proposed',
        'submodules:',
        '  - backend',
        '---',
        '',
        '# Migration plan',
        '',
        'Document body.',
      ].join(newline);
      const html = renderToStaticMarkup(<MarkdownView source={source} />);

      expect(html).toContain('<h1>Migration plan</h1>');
      expect(html).toContain('<p>Document body.</p>');
      expect(html).toContain(
        '<details class="markdown-front-matter"><summary>Document details</summary>',
      );
      expect(html).not.toContain('open=""');
      expect(html).toContain('<dt>title</dt><dd>Migration plan</dd>');
      expect(html).toContain('<dt>status</dt><dd>proposed</dd>');
      expect(html).toContain('<dt>submodules</dt><dd>- backend</dd>');
      expect(html.indexOf('</details>')).toBeLessThan(html.indexOf('<h1>'));
      expect(html).not.toContain('<hr');
    },
  );

  it('shows TOML front matter as readable source in the disclosure', () => {
    const html = renderToStaticMarkup(
      <MarkdownView source={'+++\ntitle = "Metadata title"\n+++\n\n# Document'} />,
    );

    expect(html).toContain('<h1>Document</h1>');
    expect(html).toContain('<summary>Document details</summary>');
    expect(html).toContain('title = &quot;Metadata title&quot;');
    expect(html).not.toContain('+++');
  });

  it('retains malformed YAML without breaking the document', () => {
    const html = renderToStaticMarkup(
      <MarkdownView source={'---\ntitle: Access tokens: migration plan\n---\n\n# Document'} />,
    );

    expect(html).toContain(
      '<pre class="markdown-front-matter-source">title: Access tokens: migration plan</pre>',
    );
    expect(html).toContain('<h1>Document</h1>');
  });

  it('preserves nested values and aliases without expanding recursive aliases', () => {
    const html = renderToStaticMarkup(
      <MarkdownView
        source={
          '---\nconfig: &config\n  self: *config\n  enabled: false\ncount: 0\nempty: null\n---\n\n# Document'
        }
      />,
    );

    expect(html).toContain('self: *config');
    expect(html).toContain('enabled: false');
    expect(html).toContain('<dt>count</dt><dd>0</dd>');
    expect(html).toContain('<dt>empty</dt><dd>null</dd>');
    expect(html).toContain('<h1>Document</h1>');
  });

  it('escapes metadata rather than executing HTML or rendering Markdown links', () => {
    const html = renderToStaticMarkup(
      <MarkdownView
        source={
          '---\ntitle: <script>alert(1)</script>\nlink: "[unsafe](javascript:alert(1))"\n---\n\n# Document'
        }
      />,
    );

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<a');
  });

  it('does not add a disclosure when the document has no front matter', () => {
    const html = renderToStaticMarkup(<MarkdownView source={'# Document\n\nBody.'} />);

    expect(html).not.toContain('<details');
    expect(html).toContain('<h1>Document</h1>');
  });

  it('preserves dividers and metadata-like text after the document starts', () => {
    const html = renderToStaticMarkup(
      <MarkdownView source={'# Document\n\n---\n\nstatus: proposed\n\n---\n\nBody.'} />,
    );

    expect(html.match(/<hr\/>/g)).toHaveLength(2);
    expect(html).toContain('<p>status: proposed</p>');
    expect(html).toContain('<p>Body.</p>');
    expect(html).not.toContain('<details');
  });

  it('preserves content when the opening front matter fence is never closed', () => {
    const html = renderToStaticMarkup(
      <MarkdownView source={'---\ntitle: Still visible\n\n# Document\n\nBody.'} />,
    );

    expect(html).toContain('title: Still visible');
    expect(html).toContain('<h1>Document</h1>');
    expect(html).toContain('<p>Body.</p>');
    expect(html).not.toContain('<details');
  });

  it('preserves front matter examples inside fenced code blocks', () => {
    const html = renderToStaticMarkup(
      <MarkdownView source={'```yaml\n---\ntitle: Example\n---\n```'} />,
    );

    expect(html).toContain('<code class="language-yaml">---\ntitle: Example\n---\n</code>');
    expect(html).not.toContain('<details');
  });

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

    expect(html).toContain(
      '<section aria-label="Scrollable table" class="markdown-table-scroll" tabindex="0">',
    );
    expect(html).toContain('<table>');
    expect(html).not.toContain('node="[object Object]"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('<del>discarded</del>');
  });

  it('labels fenced code blocks with their Markdown language', () => {
    const html = renderToStaticMarkup(
      <MarkdownView source={['```ts', 'const ready = true;', '```'].join('\n')} />,
    );

    expect(html).toContain('class="markdown-code-block"');
    expect(html).toContain('class="markdown-code-label">ts</div>');
    expect(html).toContain('<pre tabindex="0">');
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

  it('lets ordinary source newlines reflow inside a paragraph', () => {
    const html = renderToStaticMarkup(
      <MarkdownView source={'**Date:** 2026-09-04\n**Scope:** Pricing research'} />,
    );

    expect(html).not.toContain('<br');
    expect(html).toContain('<strong>Date:</strong> 2026-09-04\n');
    expect(html).toContain('<strong>Scope:</strong> Pricing research');
  });

  it('preserves explicit Markdown line breaks and separate paragraphs', () => {
    const html = renderToStaticMarkup(
      <MarkdownView source={'First line  \nSecond line\\\nThird line\n\nNext paragraph'} />,
    );

    expect(html.match(/<br\/>/g)).toHaveLength(2);
    expect(html).toContain('<p>Next paragraph</p>');
  });
});
