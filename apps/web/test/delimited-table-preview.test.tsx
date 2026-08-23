import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  DelimitedTablePreview,
  parseDelimitedSource,
} from '../src/components/preview/delimited-table-preview.js';

describe('delimited table preview', () => {
  it('parses CSV quotes, escaped quotes, and newlines inside cells', () => {
    const result = parseDelimitedSource(
      ['name,note', 'Ada,"line one', 'line two"', 'Bob,"He said ""hi"""'].join('\n'),
      { fileName: 'people.csv', mediaType: 'text/csv' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headers).toEqual(['name', 'note']);
    expect(result.rows).toEqual([
      ['Ada', 'line one\nline two'],
      ['Bob', 'He said "hi"'],
    ]);
  });

  it('uses TSV delimiters and treats formula-looking cells as inert text', () => {
    const result = parseDelimitedSource('name\tformula\nAda\t=SUM(A1:A2)', {
      fileName: 'people.tsv',
      mediaType: 'text/tab-separated-values',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0]).toEqual(['Ada', '=SUM(A1:A2)']);

    const markup = renderToStaticMarkup(
      <DelimitedTablePreview
        fileName="people.tsv"
        mediaType="text/tab-separated-values"
        source={'name\tformula\nAda\t=SUM(A1:A2)'}
      />,
    );
    expect(markup).toContain('=SUM(A1:A2)');
    expect(markup).not.toContain('type="number"');
    expect(markup).not.toContain('href=');
  });

  it('strips a UTF-8 BOM before reading the header', () => {
    const result = parseDelimitedSource('\uFEFFname\nShelf', { fileName: 'data.csv' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.headers).toEqual(['name']);
  });

  it('reports malformed quotes and oversized sources without hiding Source mode', () => {
    const malformed = parseDelimitedSource('name,note\nAda,"missing', { fileName: 'bad.csv' });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error).toContain('opening quote');

    const oversized = parseDelimitedSource('name\nAda', {
      fileName: 'large.csv',
      maxSourceLength: 4,
    });
    expect(oversized.ok).toBe(false);
    const markup = renderToStaticMarkup(
      <DelimitedTablePreview fileName="large.csv" maxSourceLength={4} source="name\nAda" />,
    );
    expect(markup).toContain('Preview unavailable');
    expect(markup).toContain('Source fallback');
    expect(markup).toContain('name');
  });

  it('bounds rendered rows while retaining original row numbers and sticky table structure', () => {
    const source = [
      'name,value',
      ...Array.from({ length: 10 }, (_, index) => `item-${index + 1},${index + 1}`),
    ].join('\n');
    const result = parseDelimitedSource(source, { fileName: 'large.csv', maxRows: 4 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows).toHaveLength(4);
      expect(result.truncated).toBe(true);
    }

    const markup = renderToStaticMarkup(
      <DelimitedTablePreview
        fileName="large.csv"
        maxRows={10}
        maxVisibleRows={3}
        source={source}
      />,
    );
    expect((markup.match(/class="delimited-table-row"/g) ?? []).length).toBe(3);
    expect(markup).toContain('Showing the first 3 matching rows');
    expect(markup).toContain('aria-label="large.csv horizontally scrollable table"');
    expect(markup).toContain('scope="col"');
    expect(markup).toContain('aria-label="Row 1, value: 1"');
  });

  it('exposes labeled tabs, row filter, and cell inspection affordances', () => {
    const markup = renderToStaticMarkup(
      <DelimitedTablePreview fileName="data.csv" source={'name\nShelf'} />,
    );
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-label="Filter table rows"');
    expect(markup).toContain('aria-label="data.csv horizontally scrollable table"');
    expect(markup).toContain('name');
  });

  it('can defer Preview and Source ownership to the outer file viewer', () => {
    const markup = renderToStaticMarkup(
      <DelimitedTablePreview fileName="data.csv" showModeTabs={false} source="name\nShelf" />,
    );

    expect(markup).not.toContain('role="tablist"');
    expect(markup).toContain('data table');
  });
});
